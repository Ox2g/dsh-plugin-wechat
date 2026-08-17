/**
 * 插件配置：微信通道 + DSH agent 路由的部署相关选项。
 *
 * 遵循 DSH 约定：部署可变的取值全部作为校验过的 Config 字段，可从 cordis.yml
 * 注入，不写死在 `apply` 里。运行时不依赖任何 OpenClaw 组件。
 *
 * @module dsh-plugin-wechat/config
 */

import z from '@deepseek-ai/schemastery'

/** 会话隔离维度：多账户按「账户 + 好友」，单账户可退化为按「好友」。 */
export type DmScope = 'per-peer' | 'per-account-channel-peer'

/** 插件配置。字段均为可选，缺省走默认值或运行时推断。 */
export interface Config {
  /** 账号/token 与 context-token 的持久化目录，默认 ~/.dsh-plugin-wechat。 */
  stateDir?: string
  /** ilink 微信后端地址，默认 https://ilinkai.weixin.qq.com。 */
  baseUrl?: string
  /** 新建会话的 provider 路由（agent 运行必需）。 */
  provider?: string
  /** 新建会话的模型 id（agent 运行必需）。 */
  model?: string
  /** 每次会话模型请求的输出 token 上限。 */
  maxTokens?: number
  /** 会话隔离维度。 */
  dmScope?: DmScope
  /** agent 运行出错时，是否给微信回一条可读的错误提示。 */
  replyErrorAsText?: boolean
  /** 新建会话的工作目录（绝对路径），persona 的 `{{cwd}}` 与 fs/bash 工具在此展开。默认 `process.cwd()`。 */
  cwd?: string
  /** 新建会话的标题（通过 `sessionTitle.rename` 写入，默认「微信」）。 */
  sessionTitle?: string
}

export const DEFAULT_BASE_URL = 'https://ilinkai.weixin.qq.com'

/** cordis Loader 用这个运行时 schema 校验 cordis.yml 里的 `config`。 */
export const Config: z<Config> = z.object({
  stateDir: z.string(),
  baseUrl: z.string().default(DEFAULT_BASE_URL),
  provider: z.string(),
  model: z.string(),
  maxTokens: z.number().step(1).min(1),
  dmScope: z.union(['per-peer', 'per-account-channel-peer']).default('per-account-channel-peer'),
  replyErrorAsText: z.boolean().default(true),
  cwd: z.string(),
  sessionTitle: z.string().default('微信'),
})
