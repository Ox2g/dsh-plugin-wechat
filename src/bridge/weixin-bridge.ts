/**
 * 微信 ↔ DSH 桥接：长轮询 ilink 网关、把文本消息路由给 DSH agent、把回复发回微信。
 *
 * 只依赖协议层（`src/wechat`）+ 驱动层（`src/dsh`），不依赖任何 OpenClaw 组件。
 * 生命周期由 `ctx.effect` 管理：启动时对每个已登录账号开一条轮询循环，卸载时
 * 通过 AbortController 取消在途长轮询。
 *
 * 长轮询不阻塞在单条消息上：每条消息 `void` 异步处理，这样 agent 因授权/问询
 * 而停下等待时，轮询循环仍能继续收到用户的回复并路由给 pending 交互。
 *
 * @module dsh-plugin-wechat/bridge/weixin-bridge
 */

import type { Context } from '@deepseek-ai/cordis'

import { getUpdates } from '../wechat/api/api.js'
import { sendMessageWeixin } from '../wechat/messaging/send.js'
import { getContextToken } from '../wechat/messaging/inbound.js'
import { listIndexedWeixinAccountIds, loadWeixinAccount } from '../wechat/auth/accounts.js'
import { MessageItemType, MessageType, type WeixinMessage } from '../wechat/api/types.js'
import { logger } from '../wechat/util/logger.js'
import type { Config } from '../config.js'
import { AgentRuntime, weixinSessionId, type DmScope } from '../dsh/agent-runtime.js'
import type { WechatInteraction, WechatSender } from '../dsh/interaction.js'

/** 一轮轮询失败后的退避间隔（毫秒）。 */
const RETRY_DELAY_MS = 1000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 从一条微信消息里拼接所有文本块；无文本返回空串。 */
function extractText(msg: WeixinMessage): string {
  let out = ''
  for (const item of msg.item_list ?? []) {
    if (item.type === MessageItemType.TEXT && item.text_item?.text) {
      out += item.text_item.text
    }
  }
  return out
}

/**
 * 启动所有已登录账号的桥接。返回 disposer：中止所有在途长轮询。
 * 没有可用的登录账号时仅记录警告，返回一个空 disposer。
 */
export function startWeixinBridge(
  ctx: Context,
  config: Config,
  runtime: AgentRuntime,
  interaction: WechatInteraction,
): () => void {
  const scope: DmScope = config.dmScope ?? 'per-account-channel-peer'
  const controllers = new Set<AbortController>()

  for (const accountId of listIndexedWeixinAccountIds()) {
    const account = loadWeixinAccount(accountId)
    if (!account?.token) {
      logger.warn(`weixin: account ${accountId} has no token — run the login CLI first`)
      continue
    }
    const baseUrl = account.baseUrl || config.baseUrl || 'https://ilinkai.weixin.qq.com'

    // 持久 sender：从账号文件的 userId 解析 peerId，让页面→微信转发无需等微信先来消息。
    // 用 context-token 缓存（若有）提升投递成功率；sendMessageWeixin 补齐 client_id/message_state。
    if (account.userId) {
      const peerId = account.userId
      const sessionId = weixinSessionId(accountId, peerId, scope)
      const token = account.token
      interaction.setSender(String(sessionId), async (text: string) => {
        try {
          await sendMessageWeixin({
            to: peerId,
            text,
            opts: { baseUrl, token, contextToken: getContextToken(accountId, peerId) },
          })
          logger.info(`weixin: forward sent to ${peerId} (${text.length} chars)`)
        } catch (error) {
          logger.error(`weixin: forward send FAILED to ${peerId}: ${String(error)}`)
        }
      })
      logger.info(`weixin: persistent sender registered for ${String(sessionId)}`)
    }

    const controller = new AbortController()
    controllers.add(controller)
    logger.info(`weixin: bridge started for account ${accountId} (baseUrl=${baseUrl})`)
    void pollLoop(accountId, account.token, baseUrl, scope, config, runtime, interaction, controller.signal)
  }

  if (controllers.size === 0) {
    logger.warn('weixin: no logged-in accounts — nothing to poll (run `dsh-weixin login`)')
  }

  return () => {
    for (const controller of controllers) controller.abort()
  }
}

async function pollLoop(
  accountId: string,
  token: string,
  baseUrl: string,
  scope: DmScope,
  config: Config,
  runtime: AgentRuntime,
  interaction: WechatInteraction,
  signal: AbortSignal,
): Promise<void> {
  let buf = ''
  while (!signal.aborted) {
    try {
      const resp = await getUpdates({
        baseUrl,
        token,
        get_updates_buf: buf,
        abortSignal: signal,
      })
      if (resp.get_updates_buf) buf = resp.get_updates_buf
      for (const msg of resp.msgs ?? []) {
        // 不 await：让轮询循环在 agent 阻塞等待授权/问询时继续接收回复。
        void handleMessage(accountId, baseUrl, token, scope, config, runtime, interaction, msg)
      }
    } catch (error) {
      if (signal.aborted) return
      logger.warn(`weixin: poll failed for account ${accountId}: ${String(error)} — retrying`)
      await sleep(RETRY_DELAY_MS)
    }
  }
}

async function handleMessage(
  accountId: string,
  baseUrl: string,
  token: string,
  scope: DmScope,
  config: Config,
  runtime: AgentRuntime,
  interaction: WechatInteraction,
  msg: WeixinMessage,
): Promise<void> {
  // 只处理用户发来的文本；忽略 bot 自己的回显与无文本消息（媒体首版不处理）。
  if (msg.message_type !== MessageType.USER) return
  const peerId = msg.from_user_id
  if (!peerId) return
  const text = extractText(msg)
  if (!text) return

  logger.info(`weixin: received from ${peerId}: ${text.slice(0, 120)}`)

  const sessionId = weixinSessionId(accountId, peerId, scope)
  const key = String(sessionId)

  // 该 session 的发消息闭包（用 sendMessageWeixin：完整设置 client_id + message_state=FINISH，
  // 与 openclaw-weixin 的发送方式一致，避免微信网关不投递）。
  const sender: WechatSender = async (outText: string): Promise<void> => {
    try {
      await sendMessageWeixin({
        to: peerId,
        text: outText,
        opts: { baseUrl, token, contextToken: msg.context_token },
      })
      logger.info(`weixin: reply sent to ${peerId} (${outText.length} chars)`)
    } catch (error) {
      logger.error(`weixin: reply send FAILED to ${peerId}: ${String(error)}`)
    }
  }
  interaction.setSender(key, sender)

  // 若存在 pending 交互（授权/问询），这条消息是它的回复，消费后不再路由给 agent。
  if (interaction.routeInbound(key, text)) {
    logger.info(`weixin: routed ${key} to pending interaction`)
    return
  }

  // 否则作为新对话路由给 agent。
  let reply: string
  try {
    const agent = await runtime.agentFor(sessionId)
    reply = await runtime.run(agent, text)
  } catch (error) {
    logger.error(`weixin: agent run failed for ${peerId}: ${String(error)}`)
    reply = config.replyErrorAsText === false ? '' : `处理消息时出错：${String(error)}`
  }
  if (!reply) {
    logger.warn(`weixin: empty reply to ${peerId} (nothing sent)`)
    return
  }

  logger.info(`weixin: replying to ${peerId}: ${reply.slice(0, 120)}`)
  await sender(reply)
}
