# openclaw-weixin 协议层移植分析

> 源仓库：https://github.com/Tencent/openclaw-weixin （`main` 分支，MIT 许可）
> 目标目录：`src/wechat/`
>
> 本文档按「逐文件」列出：源文件 → 目标文件映射、去掉了哪些 OpenClaw 依赖、用了什么替代，以及尚不能完全确定的地方（标注 TODO）。

## 1. 移植策略总览

openclaw-weixin 的代码分两层：

- **微信协议层**（纯 Node，几乎不依赖 OpenClaw 框架）：`src/api/`、`src/auth/login-qr.ts`、`src/cdn/`、`src/media/`、`src/messaging/`（除 `process-message.ts` / `outbound-hooks.ts` 外）、`src/storage/state-dir.ts` + `sync-buf.ts`、`src/util/`。这些整体移植，仅做依赖替换。
- **OpenClaw 适配层**（重度依赖 `openclaw/plugin-sdk/*`）：`index.ts`、`src/channel.ts`、`src/compat.ts`、`src/auth/accounts.ts`、`src/auth/pairing.ts`、`src/config/config-schema.ts`、`src/config/reply-progress.ts`、`src/messaging/process-message.ts`、`src/messaging/outbound-hooks.ts`、`src/monitor/monitor.ts`。这些**不移植**，由 DSH 侧适配 agent 重写。

移植结果在 `strict` + `noImplicitAny` + `noUnusedLocals` + `noUnusedParameters` 下 `tsc --noEmit` 通过（用本机 `tsc` 对 `src/wechat/**/*.ts` 做了独立校验，未安装任何依赖、未改动目标仓库其他文件）。

## 2. 逐文件映射清单

### 2.1 直接移植（保留行为，仅替换依赖）

| 源文件 | 目标文件 | 状态 | 去掉的 OpenClaw 依赖 / 修改点 |
|---|---|---|---|
| `src/api/types.ts` | `api/types.ts` | 移植 | 无框架依赖。仅更新 `bot_agent` 字段注释（默认值改为 `dsh-plugin-wechat`、覆盖来源改为 `DSH_WECHAT_BOT_AGENT`） |
| `src/api/api.ts` | `api/api.ts` | 移植 | 依赖 `auth/accounts.js` 的 `loadConfigBotAgent`/`loadConfigRouteTag`（→ 本地 accounts 模块）。`DEFAULT_BOT_AGENT` 改为 `dsh-plugin-wechat`；`ILINK_APP_ID` 增加 `"bot"` 兜底；`isOwnPackageJson` 增加识别 `dsh-plugin-wechat` |
| `src/api/config-cache.ts` | `api/config-cache.ts` | 移植 | 无框架依赖（仅依赖 `api.js` 的 `getConfig`） |
| `src/api/session-guard.ts` | `api/session-guard.ts` | 移植 | 无框架依赖 |
| `src/auth/login-qr.ts` | `auth/login-qr.ts` | 移植 | 依赖 `auth/accounts.js`（→ 本地 accounts 模块）。`qrcode-terminal` 动态 import（→ `vendor.d.ts` 声明）。用户可见文案中 "OpenClaw" 改为 "本实例" |
| `src/cdn/aes-ecb.ts` | `cdn/aes-ecb.ts` | 移植 | 无框架依赖 |
| `src/cdn/cdn-url.ts` | `cdn/cdn-url.ts` | 移植 | 无框架依赖 |
| `src/cdn/cdn-upload.ts` | `cdn/cdn-upload.ts` | 移植 | 无框架依赖 |
| `src/cdn/pic-decrypt.ts` | `cdn/pic-decrypt.ts` | 移植 | 无框架依赖 |
| `src/cdn/upload.ts` | `cdn/upload.ts` | 移植 | 无框架依赖（依赖 `api.js`/`mime.js`/`random.js`） |
| `src/media/mime.ts` | `media/mime.ts` | 移植 | 无框架依赖 |
| `src/media/silk-transcode.ts` | `media/silk-transcode.ts` | 移植 | `silk-wasm` 动态 import（→ `vendor.d.ts` 声明，保留不安装） |
| `src/media/media-download.ts` | `media/media-download.ts` | 移植 | 原本通过 `channelRuntime.media.saveMediaBuffer` 保存媒体，改为注入的 `SaveMediaFn` 回调（无框架依赖）。移除未使用的 `log` 解构 |
| `src/messaging/inbound.ts` | `messaging/inbound.ts` | 移植 | 内含 context-token store（原 `context-token-store` 逻辑已并入此文件）。`resolveStateDir()` → `resolveWeixinStateDir()`；`OriginatingChannel`/`Provider`/messageSid 前缀 `"openclaw-weixin"` → `"weixin"`（新增 `CHANNEL_ID` 常量） |
| `src/messaging/markdown-filter.ts` | `messaging/markdown-filter.ts` | 移植 | 无框架依赖 |
| `src/messaging/debug-mode.ts` | `messaging/debug-mode.ts` | 移植 | 状态文件路径 `stateDir/openclaw-weixin/debug-mode.json` → `stateDir/weixin/debug-mode.json` |
| `src/messaging/error-notice.ts` | `messaging/error-notice.ts` | 移植 | 无框架依赖 |
| `src/messaging/send.ts` | `messaging/send.ts` | 移植 | `import type { ReplyPayload } from "openclaw/plugin-sdk/reply-runtime"` → 本地 `type ReplyPayload = { text?: string }`。clientId 前缀 `"openclaw-weixin"` → `"weixin"` |
| `src/messaging/send-media.ts` | `messaging/send-media.ts` | 移植 | 无框架依赖 |
| `src/messaging/slash-commands.ts` | `messaging/slash-commands.ts` | 移植 | 无框架依赖。移除原未使用的 `isDebugMode` import |
| `src/messaging/reply-progress-sender.ts` | `messaging/reply-progress-sender.ts` | 移植 | 无框架依赖 |
| `src/storage/state-dir.ts` | `storage/state-dir.ts` | 移植（重写） | `OPENCLAW_STATE_DIR`/`CLAWDBOT_STATE_DIR`/`~/.openclaw` → `DSH_WECHAT_STATE_DIR`/`~/.dsh-plugin-wechat`；新增 `resolveWeixinStateDir()` |
| `src/storage/sync-buf.ts` | `storage/sync-buf.ts` | 移植 | 依赖 `auth/accounts.js` 的 `deriveRawAccountId`（→ 本地 accounts 模块）。去掉 OpenClaw 专属的 legacy 单账号路径（`stateDir/agents/...`） |
| `src/util/logger.ts` | `util/logger.ts` | 移植（重写） | `resolvePreferredOpenClawTmpDir()` → `DSH_WECHAT_LOG_DIR` 或 `<stateDir>/logs`；日志文件名/子系统/父名改为 `dsh-plugin-wechat`/`wechat`；日志级别 env 改为 `DSH_WECHAT_LOG_LEVEL` |
| `src/util/random.ts` | `util/random.ts` | 移植 | 无框架依赖 |
| `src/util/redact.ts` | `util/redact.ts` | 移植 | 无框架依赖。删除原未使用的 `SENSITIVE_FIELDS` 常量 |

### 2.2 最小化重写（原文件被列为「不移植」，但协议层需要其函数）

| 源文件 | 目标文件 | 状态 | 说明 |
|---|---|---|---|
| `src/auth/accounts.ts` | `auth/accounts.ts` | **最小化重写** | 原文件依赖 `openclaw/plugin-sdk/account-id`（`normalizeAccountId`）与 `core`（`OpenClawConfig`）。重写为纯 Node：`DEFAULT_BASE_URL`/`CDN_BASE_URL`、`deriveRawAccountId`（纯字符串）、账号索引/凭据存储（JSON + 原子写 + `chmod 600`）、`loadConfigBotAgent`（读 `DSH_WECHAT_BOT_AGENT`）、`loadConfigRouteTag`（恒返回 undefined）。删除了 `normalizeAccountId`、`resolveWeixinAccount`、`triggerWeixinChannelReload`、`loadLegacyToken`、`clearStaleAccountsForUserId` 等 OpenClaw 耦合逻辑 |

### 2.3 新增文件

| 目标文件 | 说明 |
|---|---|
| `vendor.d.ts` | 为动态 import 的 `qrcode-terminal` 与 `silk-wasm` 提供 ambient 类型（对应原 `src/vendor.d.ts` 只声明了 `qrcode-terminal`；此处补充 `silk-wasm`，见 TODO-3） |

### 2.4 不移植（OpenClaw 适配层，由 DSH 适配 agent 重写）

| 源文件 | 未移植原因 |
|---|---|
| `index.ts` | 插件入口，依赖 `openclaw/plugin-sdk/plugin-entry` 与 `channel-config-schema` |
| `src/channel.ts` | 渠道生命周期，依赖 `plugin-sdk` |
| `src/compat.ts` | 主机版本断言 `assertHostCompatibility` |
| `src/auth/pairing.ts` | `withFileLock`（`openclaw/plugin-sdk/infra-runtime`）+ 框架 allowFrom 文件 |
| `src/config/config-schema.ts` | Zod schema（依赖 `zod` + accounts 常量）；DSH 插件用自己的 Config schema |
| `src/config/reply-progress.ts` | 依赖 `OpenClawConfig`，读 `channels.openclaw-weixin.replyProgressMessages` |
| `src/messaging/outbound-hooks.ts` | `openclaw/plugin-sdk/hook-runtime` + `plugin-runtime`（message_sending/sent 钩子） |
| `src/messaging/process-message.ts` | 核心编排：`channel-runtime`（routing/session/reply dispatcher/typing）、`command-auth`、`infra-runtime`。这是 DSH 适配的核心重写点（映射到 `ctx.agents`/`ctx.sessions` 驱动） |
| `src/monitor/monitor.ts` | 长轮询循环，依赖 `channel-contract`/`core`/`process-message` |

> 注意：`src/messaging/context-token-store.ts` 在上游已不存在（其逻辑并入 `src/messaging/inbound.ts`，仅存测试文件 `context-token-store.test.ts`）。移植时 context-token store 随 `inbound.ts` 一起落地。

## 3. OpenClaw 依赖替换清单

| 原 OpenClaw 依赖 | 替代方案 | 涉及文件 |
|---|---|---|
| `resolveStateDir()`（读 `OPENCLAW_STATE_DIR`/`CLAWDBOT_STATE_DIR`，默认 `~/.openclaw`） | `resolveStateDir()` 读 `DSH_WECHAT_STATE_DIR`，默认 `~/.dsh-plugin-wechat`（`node:os.homedir()` + `node:path`） | `storage/state-dir.ts`、`auth/accounts.ts`、`storage/sync-buf.ts`、`messaging/inbound.ts`、`messaging/debug-mode.ts`、`util/logger.ts` |
| `resolvePreferredOpenClawTmpDir()`（日志/临时目录） | `DSH_WECHAT_LOG_DIR` 或 `<stateDir>/logs` | `util/logger.ts` |
| `withFileLock()`（`infra-runtime`） | **无需实现**：仅 `auth/pairing.ts`（已排除）用到。移植后的账号/context-token 写入均用 `fs.writeFileSync` 原子写 + `chmod 600`，无并发锁需求（单进程内按账号串行） | — |
| `normalizeAccountId` / account 元数据 | accountId 视为纯字符串（`ilink_bot_id` 原样存储）；`deriveRawAccountId` 保留作纯字符串兼容 | `auth/accounts.ts` |
| `OpenClawConfig` / `openclaw.json` 渠道段 | 删除；`loadConfigBotAgent()` 读 `DSH_WECHAT_BOT_AGENT`，`loadConfigRouteTag()` 恒返回 undefined（`SKRouteTag` 头省略） | `auth/accounts.ts`、`api/api.ts` |
| `ReplyPayload`（`reply-runtime`） | 本地 `type ReplyPayload = { text?: string }` | `messaging/send.ts` |
| `channelRuntime.media.saveMediaBuffer` | 注入的 `SaveMediaFn` 回调 | `media/media-download.ts` |
| logger（框架日志） | 自实现 JSON-lines 文件 logger（`util/logger.ts`），env `DSH_WECHAT_LOG_LEVEL` | 全局 |
| `createTypingCallbacks` / `command-auth` / `channelRuntime.reply/routing/session` / hook runtime | **未移植**，随 `process-message.ts` / `outbound-hooks.ts` 一起留给 DSH 适配层重写 | — |

## 4. 状态目录布局（迁移后）

```
<DSH_WECHAT_STATE_DIR or ~/.dsh-plugin-wechat>/
└─ weixin/
   ├─ accounts.json                              # 账号索引
   ├─ accounts/<accountId>.json                  # 凭据（token/baseUrl/userId，chmod 600）
   ├─ accounts/<accountId>.sync.json             # get_updates_buf
   ├─ accounts/<accountId>.context-tokens.json   # context token
   ├─ debug-mode.json                            # /toggle-debug 状态
   └─ logs/… (仅当未设置 DSH_WECHAT_LOG_DIR 时)
```

> 原上游使用 `~/.openclaw/openclaw-weixin/...`；DSH 侧统一改为 `weixin/` 子目录（通过 `resolveWeixinStateDir()` 收敛，所有模块一致）。

## 5. TODO / 尚不能完全确定的点

- **TODO-1（协议常量 `ilink_appid`）**：`iLink-App-Id` 请求头来源。上游从 `package.json` 顶层 `ilink_appid: "bot"` 读取；本移植在 `api.ts` 里兜底为 `"bot"`，但 DSH 插件的 `package.json`（由脚手架 agent 负责）最好也写入 `ilink_appid: "bot"`，否则 `isOwnPackageJson` 走 `name.includes("dsh-plugin-wechat")` 分支、`ILINK_APP_ID` 走兜底值（行为等价，但显式声明更稳）。
- **TODO-2（进程内串行化）**：`docs/roadmap/2026-08-16-plan.md §4.4` 要求同 session 串行化；协议层本身不负责，DSH 适配层需自行实现消息队列。
- **TODO-3（silk-wasm 类型）**：`silk-wasm` 未安装；`vendor.d.ts` 提供了 ambient 声明。若后续安装的 `silk-wasm` 自带类型，可能与 `vendor.d.ts` 冲突（届时删除 `vendor.d.ts` 中的 `silk-wasm` 段即可）。`qrcode-terminal@0.12.0` 不自带类型，`vendor.d.ts` 声明必需。
- **TODO-4（`WeixinMsgContext` 形态）**：`messaging/inbound.ts` 的 `WeixinMsgContext` 仍镜像 OpenClaw 的 `MsgContext` 形状（`Body/From/To/AccountId/...` 及 `SessionKey/CommandBody/CommandAuthorized`）。DSH 适配层需将其映射到 DSH 的 session 事件 / `ctx.agents` 驱动，不能直接照搬字段。
- **TODO-5（编排层最大重写点）**：`process-message.ts` 的鉴权（command-auth/allowFrom）、路由（`resolveAgentRoute`）、会话记录（`recordInboundSession`）、回复派发（`dispatchReplyFromConfig`）、typing 回调均未移植，DSH 适配层需按 `docs/roadmap/2026-08-16-plan.md §4.3` 用 `ctx.agents.create`/`agent.followup`/`agent.whenIdle` + session 事件流重写；可复用的只剩本目录内的 `inbound.ts`（解码）、`send.ts`/`send-media.ts`（发送）、`markdown-filter.ts`（过滤）、`slash-commands.ts`、`reply-progress-sender.ts`（tool 进度）。
- **TODO-6（登录落盘）**：`login-qr.ts` 返回 `{ botToken, accountId, baseUrl, userId }`，但**不负责落盘**（上游由 `pairing.ts`/`channel.ts` 调用 `saveWeixinAccount`+`registerWeixinAccountId` 完成）。DSH 侧 CLI 需在 `waitForWeixinLogin` 成功后调用 `saveWeixinAccount` / `registerWeixinAccountId` 持久化 token。
- **TODO-7（媒体保存实现）**：`media/media-download.ts` 的 `SaveMediaFn` 与出站临时目录 `MEDIA_OUTBOUND_TEMP_DIR` 的落盘策略由 DSH 适配层决定（原上游用框架统一媒体 store / `resolvePreferredOpenClawTmpDir`）。

## 6. 许可证

每个移植文件顶部保留 `Copyright (C) 2026 Tencent. All rights reserved. Licensed under the MIT License.` 声明，并附 `Ported from Tencent/openclaw-weixin (https://github.com/Tencent/openclaw-weixin)` 一行注释。
