/**
 * DSH 微信通道插件：把 ilink 微信 bot 网关接入 DeepSeek Harness。
 *
 * 遵循 DSH function-plugin 契约（具名导出 `name` / `inject` / `Config` / `apply`，
 * 无 default export）。插件在 DSH runtime 进程内长轮询微信消息，用
 * `ctx.agents` 创建/驱动 agent，并把回复发回微信。
 *
 * 除普通对话外，本插件还桥接 DSH 的阻塞式交互到微信：权限授权走
 * `approval/request` answerer，问用户走 `userQuestions` provider，工具调用
 * 反馈走 `session/event` 订阅。
 *
 * @module dsh-plugin-wechat
 */

import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

import type { Context } from '@deepseek-ai/cordis'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'

import { AgentRuntime } from './dsh/agent-runtime.js'
import { WechatInteraction } from './dsh/interaction.js'
import { startWeixinBridge } from './bridge/weixin-bridge.js'
import { resolveStateDir } from './wechat/storage/state-dir.js'
import type { Config } from './config.js'

export { Config } from './config.js'

export const name = 'im-weixin'
// `agents` 是创建/驱动 agent 所必需的服务；其余按需用 ctx.get 读取。
export const inject = ['agents']

export function apply(ctx: Context, config: Config): void {
  // 协议层（移植自 openclaw）通过 DSH_WECHAT_STATE_DIR 解析状态目录；
  // 把 Config.stateDir 对齐到同一入口，保证登录 CLI 与插件运行读写同一目录。
  if (config.stateDir) {
    process.env.DSH_WECHAT_STATE_DIR = config.stateDir
  }

  // agent 工作目录默认落在 stateDir 下的独立 workspace（不碰 DSH 进程 cwd /
  // 源码目录），并确保存在，否则 persona 的 `{{cwd}}` 无值会令组装失败。
  const cwd = config.cwd ?? join(resolveStateDir(), 'workspace')
  mkdirSync(cwd, { recursive: true })

  const runtime = new AgentRuntime(
    ctx,
    {
      provider: config.provider,
      model: config.model,
      maxTokens: config.maxTokens,
    },
    cwd,
    config.sessionTitle ?? '微信',
  )
  const interaction = new WechatInteraction()

  // 权限授权：全局 answerer，prepend 抢在 Web 的 answerer 之前；只处理微信 agent
  //（授权请求发到微信），其余委托 next()（Web agent 的授权仍由页面 answerer 处理）。
  ctx.on('approval/request', (req, next): Promise<ApprovalOutcome> => {
    if (!runtime.owns(req.agent.id)) return next()
    return interaction.askApproval(req)
  }, { prepend: true })

  // 订阅 session 事件：工具反馈 + 页面→微信转发（只处理微信 agent 的会话）。
  ctx.on('session/event', (session, event) => {
    if (!runtime.owns(session.id)) return
    if (event.type === 'user/message') {
      // 微信 App 消息（本运行时注入，id 已登记）不转发；页面发的消息转发到微信 App。
      const fromWechat = runtime.isWechatMessage(String(event.data.id))
      if (!fromWechat) {
        interaction.forwardToWechat(String(session.id), event.data as never)
      }
    }
    interaction.onSessionEvent(String(session.id), event)
  })

  // 问用户：不注册 provider。userQuestions 的 provider 全局唯一，web 进程由
  // api-proxy 注册（微信 agent 的 ask_user_question 显示在页面）；独立 wechat
  // profile 无 provider 时该能力缺省失败，不影响对话收发。

  // 注册为 effect：HMR/卸载时 cordis 会 await 返回的 async disposer，先把在途
  // 长轮询全部 abort、再把持有的 agent 全部 dispose、最后清理 pending 交互。
  ctx.effect(
    () => {
      const stop = startWeixinBridge(ctx, config, runtime, interaction)
      return async () => {
        stop()
        interaction.dispose()
        await runtime.dispose()
      }
    },
    'im-weixin: weixin bridge',
  )
}
