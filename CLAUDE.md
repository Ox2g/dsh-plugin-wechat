# dsh-plugin-wechat 项目规约

## 项目定位

DeepSeek Harness（DSH）的微信接入插件：用户通过微信与 DSH agent 对话。插件以 DSH 的 Cordis **function plugin**（具名导出 `name` / `inject` / `Config` / `apply`，无 default export）跑在 runtime 进程内，复用 [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin)（**MIT**）的微信协议层（腾讯 ilink 微信 bot 网关，扫码登录），把 OpenClaw 适配层替换为 DSH 侧适配：长轮询 `getupdates` 收消息 → `ctx.agents` 创建/驱动 agent → 回复经 `sendmessage` 回传。

- 纯 ESM（`"type": "module"`），Node `>=22`，TypeScript `NodeNext`，包管理器固定 pnpm（`packageManager: pnpm@11.21.0`，`.npmrc` 严格校验）。
- 方案与分阶段计划见 `docs/roadmap/2026-08-16-plan.md`；协议层移植分析见 `docs/research/2026-08-16-openclaw-weixin-port-analysis.md`。

## 职责结构

```text
dsh-plugin-wechat/
├── src/
│   ├── index.ts                   # 插件入口：装配 ctx.on/ctx.effect、跨服务编排
│   ├── config.ts                  # Config schema（schemastery），部署可变取值全在此
│   ├── wechat/                    # 移植的微信协议层（api/auth/cdn/media/messaging/storage/util）
│   ├── bridge/weixin-bridge.ts    # 长轮询 → session 路由 → 回复回传（每条消息 void 异步处理）
│   └── dsh/                       # DSH 适配层
│       ├── agent-runtime.ts       # ctx.agents 驱动：restore-or-create、单轮对话、串行队列
│       └── interaction.ts         # 交互桥接：授权/问询 pending 路由、工具反馈、页面→微信转发
├── bin/login.ts                   # 扫码登录 CLI（一次性交互，token 落盘；运行期只读）
├── tests/                         # vitest：单元 + Config schema + Loader REAL-composition
├── docs/                          # 规约与研究（见「文档规约」）
├── examples/                      # 部署 overlay 示例
├── cordis.patch.yml               # bundle patch 层（`dsh plugin add` 后安装即启用）
└── package.json / pnpm-workspace.yaml / .npmrc
```

### 目录边界

- `src/wechat/` 是移植层，保留腾讯 MIT 版权头；**不直接驱动 agent**，只提供协议原语（收发/编解码/CDN/状态目录）。改动需对照上游 diff，不复刻 OpenClaw 框架依赖。
- `src/bridge/` + `src/dsh/` 是 DSH 适配层，只依赖协议层公共接口；`index.ts` 只做装配，业务逻辑在 bridge/dsh。
- `bin/` 只处理登录交互，不包含运行期逻辑。
- `tests/` 不依赖真实微信网关；协议层外部依赖（ilink 网关、登录二维码）一律 stub/mock，Loader 组合测试只 mock 外部服务。

## 插件契约

- DSH function plugin：具名导出 `name`/`inject`/`Config`/`apply`，**无 default export**；所有注册走 `ctx.on`/`ctx.effect`，卸载自动回收。精确 API 见 `docs/specs/2026-08-16-dsh-plugin-contract.md`。
- 依赖：`@deepseek-ai/*` 全部是 `peerDependencies`，运行时由 DSH 的 healed-fallback 解析到「运行中的 dsh」一致副本；本地开发由 `devDependencies` 的 `link:../deepseek-harness/...` 满足。
- 配置约定：部署可变的取值全部是 `Config` 字段（schemastery 校验 + 默认值显式），不写死在 `apply` 里。字段见 `src/config.ts`：`stateDir`/`baseUrl`/`provider`/`model`/`maxTokens`/`dmScope`/`replyErrorAsText`/`cwd`/`sessionTitle`；环境变量 `DSH_WECHAT_STATE_DIR`/`DSH_WECHAT_LOG_DIR`/`DSH_WECHAT_LOG_LEVEL`/`DSH_WECHAT_BOT_AGENT`。

## 会话与交互契约

- **sessionId 映射**：`weixin:${accountId}:${peerId}`（默认 `per-account-channel-peer`）或 `weixin:${peerId}`（`per-peer`）；稳定复用即多轮连续。
- **回复归因**：`agent.followup()` 只入队、不返回对应输出；`whenIdle()` 与下一次 followup 之间构成活动区间，该区间新增的 `assistant/message` 文本归纳为本轮回复（DSH 无 per-prompt 结果/取消）。
- **同 session 串行化**：同一 sessionId 的消息按到达顺序串行执行（per-session 队列）；不同 session 并发。
- **交互桥接**：权限授权走 `approval/request` answerer（`prepend`，只处理 `weixin:` 前缀会话）；问用户走 userQuestions provider（**不注册**——provider 全局唯一，web 场景由 api-proxy 注册，微信 agent 的问用户由页面呈现）；工具反馈走 `session/event` 订阅；页面→微信转发复用最近一次微信消息的发送通道。
- **错误语义**：agent 出错按 `replyErrorAsText` 回一条可读提示；微信侧 session 超时（`errcode -14`）/token 失效 → 告警并提示重新 `pnpm login`；无已登录账号 → 桥接不启动轮询，仅告警。

## 范围外 / 已知限制

- **媒体**：首版只处理文本收发；`src/wechat/cdn` + `media/` 协议原语已就绪，但未接线到 agent 往返。
- **跨重启续聊**：会话跨进程重启恢复需接入 `sessionPersistence`（`ctx.agents.resume`）；当前为进程内稳定 sessionId 多轮连续（损坏日志自愈：重命名 `.corrupt-<ts>` 后重建）。
- **无 wall-clock 超时 / 副作用回滚**：同 session 消息在 `AgentRuntime` 内串行化兜底。

## 开发与验证

```sh
pnpm install      # @deepseek-ai/* peer 由 link:../deepseek-harness 本地包满足
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm build        # tsc → lib/
pnpm login        # tsx bin/login.ts 扫码登录
```

- **TDD**：先写失败测试再实现（red → green → refactor）。测试类型：单元（sessionId 映射、Config schema、交互桥接往返）+ Loader REAL-composition（真实 `cordis.yml` 加载，只 mock 外部服务）。
- **Tidy First**：结构性修改（重命名/移动/重构）与内容/行为修改分 commit，前者 `tidy:`，后者 `feat:`/`fix:`，严禁混在一笔。
- **commit 前缀**：`feat:` / `fix:` / `tidy:` / `test:` / `docs:` / `chore:`。
- 本地开发依赖 `../deepseek-harness`（同级目录，已构建）——结构见 `package.json` `devDependencies` 的 `link:` 路径；路径不同则改之。
- 运行时行为改动必须走通实测（扫码已登录账号收发消息）；typecheck/build 不能替代实际验收。

## 文档规约

### 结构

- `docs/features/` — 设计稿/方案/记录，命名 `<YYYY-MM-DD>-<topic>-<kind>.md`（`kind` ∈ `design`/`plan`/`notes`/`retro` 等）。
- `docs/specs/` — 规约 SOO（如 DSH 插件契约）。
- `docs/roadmap/` — 分阶段计划。
- `docs/wiki/` — 沉淀速查（引用源码，不复述 schema）。
- `docs/research/` — 调研/移植分析。
- `docs/issues.md` — 缺陷与实现问题登记（打开/已修复两节）。

### 内容

- 禁止以 `superpowers`/`skills`/`templates` 等泛词命名文档目录；具体类目落到 `docs/<topic>/`。
- 篇幅以「核心信息 + 引用」为主：决策、影响面、关键锚点（file:line）写进正文；实现细节、配置项、运行步骤通过相对路径引用源码/`package.json`/`cordis.yml`，不在文档里复述。
- 一段一意图；不写铺垫，结论后不补尾巴；不为可默认的事写说明。

## Worktree 规约

- feature/fix/experiment 任务在 git worktree 进行，主工作区只做阅读、规约与设计稿落地；进入 worktree 前确认主分支干净。
- 规约、计划、设计稿先落主分支再开 worktree；`.claude/` 不提交。