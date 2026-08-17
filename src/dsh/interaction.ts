/**
 * 微信交互桥接：把 DSH 的阻塞式交互（权限授权、问用户）桥接到微信消息往返，
 * 并管理 pending 交互的路由。长轮询收到消息时先询问本桥接是否消费该消息。
 *
 * @module dsh-plugin-wechat/dsh/interaction
 */

import type { ApprovalOutcome, ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type {
  AskUserQuestionAnswer, AskUserQuestionItem, AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { logger } from '../wechat/util/logger.js'

/** 把一条文本发回微信的闭包（由 bridge 层按 peerId + context_token 注入）。 */
export type WechatSender = (text: string) => Promise<void>

interface PendingApproval {
  kind: 'approval'
  resolve: (outcome: ApprovalOutcome) => void
}

interface PendingQuestion {
  kind: 'question'
  resolve: (answer: AskUserQuestionAnswer) => void
  /** 每个问题的 id 与选项 label（答案解析时按序号回填）。 */
  questions: ReadonlyArray<{ id: string; options: string[] }>
}

type Pending = PendingApproval | PendingQuestion

/** 页面/其他来源的用户消息（只需 content 的 text 块即可转发）。 */
interface MessageLike {
  content?: ReadonlyArray<{ type: string; text?: string }>
}

/** 提取消息里的所有 text 块。 */
function collectMessageText(message: MessageLike): string {
  let out = ''
  for (const block of message.content ?? []) {
    if (block.type === 'text' && block.text !== undefined) out += block.text
  }
  return out
}

/** 授权批准关键词（回复「1」或「批准/同意/是/yes」等；其余 fail-closed 拒绝）。 */
const APPROVE_WORDS = new Set([
  '1', '批准', '同意', '允许', '是', '确认', 'yes', 'y', 'ok', 'okay', 'approve', 'allow',
])

/** 解析授权回复：命中批准关键词则允许，其余拒绝（fail-closed）。 */
function parseApprovalReply(text: string): ApprovalOutcome {
  return APPROVE_WORDS.has(text.trim().toLowerCase()) ? 'allowed-once' : 'rejected'
}

/** 把一个 pending question 解析为结构化答案（编号、选项 label 或自由文本）。 */
function parseQuestionReply(text: string, pending: PendingQuestion): AskUserQuestionAnswer {
  const trimmed = text.trim()
  const lower = trimmed.toLowerCase()
  const answers: AskUserQuestionAnswer['answers'] = pending.questions.map((question, index) => {
    if (index !== 0) return { id: question.id, selected: [] }
    // 1. 数字序号 → 对应选项 label
    if (/^\d+$/.test(trimmed)) {
      const optionIndex = Number(trimmed) - 1
      if (optionIndex >= 0 && optionIndex < question.options.length) {
        return { id: question.id, selected: [question.options[optionIndex] as string] }
      }
    }
    // 2. 选项 label 精确匹配（忽略大小写）
    const matched = question.options.find(option => option.toLowerCase() === lower)
    if (matched !== undefined) {
      return { id: question.id, selected: [matched] }
    }
    // 3. 其余当作自由文本作答
    return { id: question.id, selected: [], ...(trimmed !== '' ? { custom: trimmed } : {}) }
  })
  return { answers }
}

/** 把问题列表排版成微信可读的文本。 */
function formatQuestions(questions: readonly AskUserQuestionItem[]): string {
  const lines: string[] = ['🤔 需要你确认：']
  questions.forEach((question, index) => {
    if (questions.length > 1) lines.push(`[${index + 1}] ${question.question}`)
    else lines.push(question.question)
    for (const [optionIndex, option] of (question.options ?? []).entries()) {
      lines.push(`  ${optionIndex + 1}. ${option.label}`)
    }
  })
  lines.push('回复编号（如 1）或直接回复文字')
  return lines.join('\n')
}

/**
 * 管理微信渠道的阻塞式交互：每个 session 同一时刻最多一个 pending 交互
 * （AgentRuntime 对同一 session 串行，天然满足）。
 */
export class WechatInteraction {
  private readonly senders = new Map<string, WechatSender>()
  private readonly pending = new Map<string, Pending>()

  /** handleMessage 时登记该 session 的发消息闭包。 */
  setSender(sessionId: string, sender: WechatSender): void {
    this.senders.set(sessionId, sender)
  }

  /** 该 session 是否有待处理的交互回复。 */
  hasPending(sessionId: string): boolean {
    return this.pending.has(sessionId)
  }

  /**
   * 长轮询收到一条消息时优先询问本桥接：若存在 pending 交互则消费并返回 true。
   * @returns true 表示消息被交互消费，不应再路由给 agent。
   */
  routeInbound(sessionId: string, text: string): boolean {
    const entry = this.pending.get(sessionId)
    if (entry === undefined) return false
    this.pending.delete(sessionId)
    if (entry.kind === 'approval') {
      entry.resolve(parseApprovalReply(text))
    } else {
      entry.resolve(parseQuestionReply(text, entry))
    }
    return true
  }

  /** 工具调用反馈：把 tool/call 与 tool/result 的关键进展发到微信。 */
  onSessionEvent(sessionId: string, event: SessionEvent): void {
    const sender = this.senders.get(sessionId)
    if (sender === undefined) return
    if (event.type === 'tool/call') {
      void sender(`🔧 正在执行 ${event.data.name}`)
    } else if (event.type === 'tool/result' && event.data.error !== undefined) {
      void sender(`❌ 工具执行出错：${event.data.error.name}`)
    }
  }

  /**
   * 把页面（非微信来源）产生的用户消息转发到微信 App，实现页面→微信同步。
   * 使用最近一次微信消息建立的发送通道（sender 携带 peerId + context_token）。
   */
  forwardToWechat(sessionId: string, message: MessageLike): void {
    const sender = this.senders.get(sessionId)
    if (sender === undefined) return
    const text = collectMessageText(message)
    if (text === '') return
    void sender(text).catch((error) => {
      logger.warn(`weixin: forward to wechat failed for ${sessionId}: ${String(error)}`)
    })
  }

  /** approval answerer 回调：发授权请求到微信，等回复。 */
  async askApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    const sessionId = String(request.agent.id)
    const sender = this.senders.get(sessionId)
    if (sender === undefined) return 'unavailable'
    const reason = request.reason !== undefined ? `\n原因：${request.reason}` : ''
    try {
      await sender(`⚠️ 需要授权执行「${request.toolName}」${reason}\n回复「批准」或「1」同意，「拒绝」或「2」拒绝`)
    } catch (error) {
      logger.warn(`weixin: approval prompt send failed for ${sessionId}: ${String(error)}`)
      return 'unavailable'
    }
    return new Promise<ApprovalOutcome>((resolve) => {
      this.pending.set(sessionId, { kind: 'approval', resolve })
    })
  }

  /** userQuestions provider 回调：发问题到微信，等回答。 */
  async askQuestion(request: AskUserQuestionRequest): Promise<AskUserQuestionAnswer> {
    const agent = request.agent
    if (agent === undefined) {
      throw new Error('wechat user-questions provider requires the calling agent')
    }
    const sessionId = String(agent.id)
    const sender = this.senders.get(sessionId)
    if (sender === undefined) {
      throw new Error(`no wechat sender registered for session ${sessionId}`)
    }
    const questions = request.questions.map(question => ({
      id: question.id,
      options: (question.options ?? []).map(option => option.label),
    }))
    try {
      await sender(formatQuestions(request.questions))
    } catch (error) {
      logger.warn(`weixin: question prompt send failed for ${sessionId}: ${String(error)}`)
      throw error
    }
    return new Promise<AskUserQuestionAnswer>((resolve) => {
      this.pending.set(sessionId, { kind: 'question', resolve, questions })
    })
  }

  /** 清理所有 pending（插件卸载时调用）。 */
  dispose(): void {
    for (const entry of this.pending.values()) {
      if (entry.kind === 'approval') entry.resolve('cancelled')
      else entry.resolve({ answers: entry.questions.map(question => ({ id: question.id, selected: [] })) })
    }
    this.pending.clear()
    this.senders.clear()
  }
}
