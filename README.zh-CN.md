# dsh-plugin-wechat

[English](./README.md) · 中文

DeepSeek Harness（DSH）的微信接入插件：用户通过微信与 DSH agent 对话。插件作为 DSH 的 Cordis **function plugin** 运行在 runtime 进程内，复用 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（MIT）的微信协议层（腾讯 ilink 微信 bot 网关，扫码登录），把 OpenClaw 适配层替换为 DSH 侧适配，通过 `ctx.agents` 创建/驱动 agent 收发消息。

## 定位

- 遵循 DSH 插件规范：具名导出 `name` / `inject` / `Config` / `apply`，**无 default export**；注册与清理走 `ctx.effect()`。
- 纯 ESM（`"type": "module"`），Node `>=22`，TypeScript `NodeNext`。
- 微信协议层在 `src/wechat/`（保留腾讯 MIT 版权头）；DSH 适配在 `src/bridge/`、`src/dsh/`、`src/index.ts`。

## 前置条件

1. 一个可用的 **ilink 微信 bot 网关**账号（扫码配对拿 token；默认后端 `https://ilinkai.weixin.qq.com`）。这不是企业微信开放 API / 公众号 API。
2. 一个已安装的 **DeepSeek Harness**（`dsh` CLI，或本地 checkout）。

## 安装与启用

```sh
# 在 dsh 里新建/复用 profile 并安装本插件（link 本地仓库，或 npm/git 包名）
dsh plugin --profile wechat add link:/path/to/dsh-plugin-wechat

# 运行（首次会初始化 profile，默认含 @deepseek-ai/dsh-base）
dsh --profile wechat
```

本包 `package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`，`dsh plugin add` 后安装即启用；`@deepseek-ai/*` 声明为 `peerDependencies`，运行时由 dsh 的 `healProfilesModuleFallback` 解析到运行中 dsh 的一致副本（不依赖 npm 上陈旧的 rc 包）。

## 扫码登录

```sh
# 先构建，再扫码（终端出二维码；token 落盘到 DSH_WECHAT_STATE_DIR，默认 ~/.dsh-plugin-wechat）
pnpm build
pnpm login
```

登录与插件运行共享同一状态目录（`DSH_WECHAT_STATE_DIR` 或 `~/.dsh-plugin-wechat`）。

## 配置（cordis.yml / cordis.patch.yml）

| 键 | 默认 | 说明 |
|---|---|---|
| `provider` | — | 新会话的 provider 路由（如 `deepseek-official`） |
| `model` | — | 新会话的模型 id（如 `deepseek-v4-flash`） |
| `maxTokens` | — | 每次会话模型请求输出 token 上限 |
| `baseUrl` | `https://ilinkai.weixin.qq.com` | ilink 后端 |
| `stateDir` | `~/.dsh-plugin-wechat` | 账号/token/日志目录 |
| `dmScope` | `per-account-channel-peer` | 会话隔离维度：`per-peer` / `per-account-channel-peer` |
| `replyErrorAsText` | `true` | agent 出错时是否回一条可读错误 |
| `cwd` | `<stateDir>/workspace` | 新建会话的工作目录（绝对路径，自动创建）；persona 的 `{{cwd}}` 与 fs/bash 在此展开 |
| `sessionTitle` | `微信` | 新建会话的标题（通过 `sessionTitle.rename` 在同一进程内写入，无跨进程并发写风险） |

环境变量：`DSH_WECHAT_STATE_DIR`、`DSH_WECHAT_LOG_DIR`、`DSH_WECHAT_LOG_LEVEL`、`DSH_WECHAT_BOT_AGENT`。

## 开发

```sh
pnpm install      # 装 dev/optional 依赖；@deepseek-ai/* peer 由 link: 本地包满足
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm build        # tsc → lib/
pnpm login        # tsx bin/login.ts 扫码登录
```

`@deepseek-ai/*` 是 `peerDependencies`，运行时由 DSH 宿主进程解析，不从 registry 安装（`.npmrc` 关闭 `auto-install-peers`）。本地 typecheck/test/build 需要它们可解析：`package.json` 的 `devDependencies` 用 `link:../deepseek-harness/...` 指向本地 checkout 的产物，pnpm 在 `node_modules/@deepseek-ai` 下生成同构 symlink；传递依赖沿真实路径落到 deepseek-harness 自己的 node_modules 解析。前提：

- [`pnpm`](https://pnpm.io) ≥ 11（`pnpm install` 会校验依赖安装脚本，`pnpm-workspace.yaml` 的 `allowBuilds` 已放行 esbuild）；
- `deepseek-harness` 与仓库同级（`../deepseek-harness`）；路径不同则改 `package.json` 里的 `link:` 路径；
- deepseek-harness 各包已构建（`lib/` 存在）。

## 目录

- `src/wechat/` — 移植的微信协议层（api/auth/cdn/media/messaging/storage/util）
- `src/bridge/weixin-bridge.ts` — 长轮询 → agent 路由 → 回传
- `src/dsh/agent-runtime.ts` — `ctx.agents` 驱动层
- `src/index.ts` — 插件入口（`name`/`inject`/`Config`/`apply`）
- `src/config.ts` — 配置 schema（schemastery）
- `bin/login.ts` — 扫码登录 CLI
- `cordis.patch.yml` — bundle patch 层（安装即启用）
- `docs/` — 文档规约与契约研究，结构见 [CLAUDE.md](./CLAUDE.md)「文档规约」（features / specs / roadmap / wiki / research + issues.md）

## 文档

- [CLAUDE.md](./CLAUDE.md) — 项目规约（边界、契约、开发验证、文档规约）
- [docs/roadmap/2026-08-16-plan.md](./docs/roadmap/2026-08-16-plan.md) — 可行方案与分阶段计划
- [docs/research/2026-08-16-openclaw-weixin-port-analysis.md](./docs/research/2026-08-16-openclaw-weixin-port-analysis.md) — openclaw-weixin 协议层移植分析
- [docs/specs/2026-08-16-dsh-plugin-contract.md](./docs/specs/2026-08-16-dsh-plugin-contract.md) — DSH 插件契约

## 微信交互

除普通对话外，插件把 DSH 的阻塞式交互桥接到微信消息往返：

- **权限授权**：agent 需要授权时（如 bash 提权），插件把「⚠️ 需要授权执行 X，回复 1 批准 / 2 拒绝」发到微信，等用户回复后返回 outcome。
- **问用户**：agent 调用 `ask_user_question` 时，插件把问题 + 选项发到微信，等用户回复编号或文字作答。
- **工具反馈**：agent 执行工具时，插件把「🔧 正在执行 X」与失败提示发到微信。

## 与 Web GUI 同进程（双向同步）

插件可以并入 web profile（`profiles/web` 的 `dsh.profile.bundles` 加入 `@ox2g/dsh-plugin-wechat`），让微信与 Web 页面双向同步：

- **微信 → 页面**：微信消息进 session 日志，Web 页面打开该会话即可看到；agent 回复走微信并同时写入日志。
- **页面 → 微信**：页面发给微信会话的消息会被插件转发到微信 App（使用最近一次微信消息的发送通道）。

同进程时插件自动适应：

- **persona 只影响微信 agent**（在微信 agent 的 scope 内注册「纯文本回复」section），不影响 Web agent。
- **user-questions provider 不重复注册**（检测到 `apiProxy` 存在则跳过，微信 agent 的问用户由页面呈现）。
- **approval answerer 优先**（`prepend` + 仅处理 `weixin:` 前缀的会话），微信 agent 的授权走微信，Web agent 的授权仍由页面 answerer 处理。

实现上依赖 `@deepseek-ai/dsh-user-approval` / `@deepseek-ai/dsh-user-questions` 两个 peer dependency；授权/问询的 answerer 与 provider 注册在微信 profile 进程内，与 Web GUI 的对应实现分属不同进程，因此互不冲突。

## 已知限制

- 首版只处理**文本**收发；图片/语音/文件/视频走 `src/wechat/cdn` + `messaging/send-media`，尚未接线到 agent 往返（媒体入站可经 `extractText` 之外扩展）。
- 会话跨重启续聊需接入 `sessionPersistence`（`ctx.agents.resume`），当前为进程内稳定 `sessionId` 多轮连续。
- 无 wall-clock 超时 / 副作用回滚；同 session 消息在 `AgentRuntime` 内串行化。