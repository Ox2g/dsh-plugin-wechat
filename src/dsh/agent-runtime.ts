/**
 * DSH agent 驱动层：把「一条微信文本」映射成「一个 DSH agent 的一轮对话」，
 * 并把该轮产生的 assistant 文本收集回来。
 *
 * 只依赖 DSH 的公共接口（`ctx.agents` / `Agent` / session 日志），不依赖任何
 * 微信协议细节；微信收发由 bridge 层负责。
 *
 * @module dsh-plugin-wechat/dsh/agent-runtime
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, AgentOptions } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
// 仅加载声明合并，让 `ctx.get('sessionPersistence')` 有类型（服务可选）。
import type {} from '@deepseek-ai/dsh-session-persistence'
import { rename } from 'node:fs/promises'
import { logger } from '../wechat/util/logger.js'

/** 会话隔离维度：多账户时按「账户 + 好友」隔离，单账户可退化为按「好友」。 */
export type DmScope = 'per-peer' | 'per-account-channel-peer'

/** 把「微信账号 + 好友」稳定映射成一个 DSH sessionId（多轮连续的关键）。 */
export function weixinSessionId(accountId: string, peerId: string, scope: DmScope): SessionId {
  const key = scope === 'per-account-channel-peer' ? `${accountId}:${peerId}` : peerId
  return SessionId(`weixin:${key}`)
}

/** 判断错误是否由 session 日志损坏引起（多为并发写导致的 seq 乱序 / zstd 帧损坏）。 */
function isCorruptSessionError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('corrupt') || message.includes('seq gap') || message.includes('first frame')
}

/** 从会话日志里收集 `afterSeq` 之后产生的 assistant 纯文本。 */
function collectAssistantText(events: readonly SessionEvent[], afterSeq: number): string {
  let out = ''
  for (const event of events) {
    if (event.seq <= afterSeq) continue
    if (event.type !== 'assistant/message') continue
    for (const block of event.data.message.content) {
      if (block.type === 'text') out += block.text
    }
  }
  return out
}

/**
 * 管理「sessionId → AgentHandle」的存活映射，并驱动单轮对话。
 *
 * 同一 sessionId 的请求由调用方串行化（见 bridge 层的 per-session 队列）；
 * 这里只保证：复用已有 agent、空闲时取回本轮回复、dispose 时统一回收。
 */
export class AgentRuntime {
  private readonly handles = new Map<string, AgentHandle>()
  /** 每个 session 的串行队列尾：同一 session 的消息严格按序执行，避免交错。 */
  private readonly queues = new Map<string, Promise<unknown>>()
  /** 本运行时注入的微信消息 id（source 为 user，但来自微信 App，页面转发时需排除）。 */
  private readonly wechatMessageIds = new Set<string>()

  constructor(
    private readonly ctx: Context,
    private readonly agentOptions: AgentOptions,
    private readonly cwd: string,
    private readonly title: string,
  ) {}

  /**
   * 取（或首次创建/恢复）一个 sessionId 对应的 live agent。
   *
   * 稳定 sessionId + 持久化后端并存时，跨进程重启会撞到磁盘上已存在的同 id
   * 日志（`create` 是「新建」语义）。这里遵循 DSH 的 restore-or-create 模式：
   * 有持久化时先 `resume` 加载历史，resume 对「该 id 无 artifact」会失败，此时
   * 确认 `list()` 里确实没有该 id 才回退 `create`；损坏/后端失败保持 loud。
   */
  async agentFor(sessionId: SessionId): Promise<Agent> {
    const key = String(sessionId)
    const held = this.handles.get(key)
    if (held) return held.agent
    const live = this.ctx.agents.get(sessionId)
    if (live) return live

    // agent scope 内注册：persona 等只对微信 agent 生效，不影响同进程的 Web agent。
    const setup = (agentCtx: Context): void => {
      this.installAgentScope(agentCtx)
    }

    const persistence = this.ctx.get('sessionPersistence')
    if (persistence) {
      try {
        const handle = await this.ctx.agents.resume({
          resumeSessionId: sessionId,
          agentOptions: this.agentOptions,
          setup,
        })
        this.handles.set(key, handle)
        return handle.agent
      } catch (error) {
        // SessionId 是 branded string；跨包边界比较用底层 string，避免不同解析副本的 nominal 类型不匹配。
        const exists = (await persistence.list()).some((header) => String(header.id) === String(sessionId))
        if (!exists) {
          // 无该 id 的持久化 artifact：首次创建，落到下面的 create。
        } else if (isCorruptSessionError(error)) {
          // session 文件存在但损坏（多为并发写导致 seq 乱序）：移走损坏日志，重建。
          logger.warn(`weixin: session ${String(sessionId)} corrupt, resetting log: ${String(error)}`)
          await this.resetCorruptLog(sessionId)
        } else {
          throw error
        }
      }
    }

    const handle = await this.ctx.agents.create({
      sessionId,
      agentOptions: this.agentOptions,
      meta: { cwd: this.cwd },
      setup,
    })
    this.handles.set(key, handle)
    this.ensureTitle(handle.agent)
    return handle.agent
  }

  /** 移走损坏的 session 日志（重命名为 .corrupt-<时间戳>，保留现场便于排查）。 */
  private async resetCorruptLog(sessionId: SessionId): Promise<void> {
    const persistence = this.ctx.get('sessionPersistence')
    if (persistence === undefined) return
    try {
      const location = persistence.locate({ id: sessionId, cwd: this.cwd } as never)
      if (location === undefined || location.kind !== 'jsonl' || location.path === '') return
      const backup = `${location.path}.corrupt-${Date.now()}`
      await rename(location.path, backup)
      logger.warn(`weixin: moved corrupt session log to ${backup}`)
    } catch (error) {
      logger.warn(`weixin: failed to reset corrupt session log for ${String(sessionId)}: ${String(error)}`)
    }
  }

  /** 在微信 agent 的 scope 内注册「纯文本回复」的 persona section（微信 App 不渲染 Markdown）。 */
  private installAgentScope(agentCtx: Context): void {
    const systemPrompt = agentCtx.get('systemPrompt') as
      | { section(section: { name: string; order: number; text: string }): () => void }
      | undefined
    if (systemPrompt === undefined) return
    systemPrompt.section({
      name: 'im-weixin:plain-text',
      order: 50,
      text: 'You are communicating over WeChat, which does not render Markdown. Reply in plain text only — no headings, bold, italics, bullet lists, numbered lists, tables, or code fences. Keep answers concise and conversational.',
    })
  }

  /** 新建会话时写入标题（通过 sessionTitle.rename，在同一进程内，无并发写风险）。 */
  private ensureTitle(agent: Agent): void {
    const sessionTitle = this.ctx.get('sessionTitle') as
      | { rename(session: unknown, title: string): unknown }
      | undefined
    if (sessionTitle === undefined) return
    try {
      sessionTitle.rename(agent.session, this.title)
    } catch (error) {
      // 标题失败不阻断对话。
      logger.warn(`weixin: failed to set session title for ${String(agent.id)}: ${String(error)}`)
    }
  }

  /**
   * 判断一个 sessionId 是否属于微信通道（answerer / 工具反馈 / 转发的归属过滤）。
   * 合并进程（web + wechat 同进程）时不能只看 live agent（Web agent 也 live），
   * 用稳定的 `weixin:` 前缀区分。
   */
  owns(sessionId: SessionId): boolean {
    const id = String(sessionId)
    return id.startsWith('weixin:') || this.handles.has(id)
  }

  /** 该消息 id 是否由本运行时从微信 App 注入（页面转发时需排除）。 */
  isWechatMessage(messageId: string): boolean {
    return this.wechatMessageIds.has(messageId)
  }

  /**
   * 把一条文本送入 agent 作为一轮 follow-up，等待其空闲后收集本轮 assistant 文本。
   * 同一 session 的调用按到达顺序串行执行（DSH 无 per-prompt 结果/取消语义）。
   * 返回空串表示这一轮没有产生可见文本（例如被拒绝/中止）。
   */
  run(agent: Agent, text: string): Promise<string> {
    const key = String(agent.id)
    const prev = this.queues.get(key) ?? Promise.resolve()
    const next = prev.then(() => this.runOnce(agent, text))
    // 吞掉前序错误，保证队列不断链；调用方拿到的 `next` 仍携带本轮的失败。
    this.queues.set(key, next.catch(() => {}))
    return next
  }

  private async runOnce(agent: Agent, text: string): Promise<string> {
    const afterSeq = agent.session.seq
    // source 用 { kind: 'user' }：让 Web 页面把微信消息渲染成普通用户气泡（plugin source 会被前端当 context）。
    const message = createUserMessage({
      content: [{ type: 'text', text }],
      source: { kind: 'user' },
    })
    this.wechatMessageIds.add(String(message.id))
    agent.followup(message)
    await agent.whenIdle()
    const reply = collectAssistantText(agent.session.events, afterSeq)
    if (!reply) {
      // 诊断：打出这一轮的事件（含 turn/end 结束原因），定位「没跑/路由失败/回复为空」。
      const detail = agent.session.events
        .filter((event) => event.seq > afterSeq)
        .map((event) => {
          if (event.type === 'turn/end') {
            const reason = event.data.reason
            return reason.kind === 'error'
              ? `turn/end(error:${JSON.stringify(reason.error)})`
              : `turn/end(${reason.kind})`
          }
          return event.type
        })
      logger.warn(`weixin: no assistant text after seq ${afterSeq}; events=[${detail.join(', ')}]`)
    }
    return reply
  }

  /** 释放所有由本运行时持有的 agent（进程卸载时调用）。 */
  async dispose(): Promise<void> {
    const pending = [...this.handles.values()].map((handle) => handle.dispose())
    this.handles.clear()
    await Promise.all(pending)
  }
}
