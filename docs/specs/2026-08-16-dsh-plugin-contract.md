# DSH 插件开发契约

本文档从 DeepSeek Harness（DSH）monorepo 源码核实「如何开发一个 DSH 插件」，为 `dsh-plugin-wechat`（微信接入插件）提供精确的 import 路径、签名与用法。所有结论都指向 DSH 仓库内的具体文件；引用的相对路径均相对 `deepseek-harness` 仓库根。

DSH 是「一切皆 Cordis 插件」的 monorepo。一个插件要么是 **function plugin**（具名导出 `name` / `inject` / `Config` / `apply`），要么是 **Service 类插件**（`extends Service`，default export）。微信插件属于前者。

---

## 1. 插件导出契约

### 1.1 精确形态

依据：`packages/AGENTS.md`（Plugin exports 规则）、`docs/postmortem/0001-acp-default-export-drops-inject.md`、`packages/hooks/hooks-claude-code/src/index.ts`。

- 具名导出 `name`（`string`）、`inject`（`string[]`，可选）、`Config`（interface + 同名 schemastery schema）、`apply`。
- **没有 default export**。function plugin 与 default export 混用会让 Loader 丢弃 function plugin 的命名空间（postmortem 0001）。Service 类插件才 default-export 服务类；不要混用两种形态。
- `name` 是插件身份字符串（日志/事件归属用），**不等于** cordis.yml 里的 `name`（那是模块 specifier，见第 4 节）。
- `inject` 声明「必需」的 service；插件在 `apply` 里可通过 `ctx.<key>` 直接访问它们。可选 service 用 `ctx.get('<key>')`（返回 `undefined`），不要把可选 service 写成 `inject`（`packages/AGENTS.md`：`ctx.get` 读全局 service store，`ctx.<name>` 属性代理是拓扑敏感的）。
- `Config` 是 interface + 同名 schemastery schema 两个导出：类型供调用方，schema 供 Cordis 在加载时校验并填默认值。**不能导出普通对象作为 `Config`**（不实现 Standard Schema 接口，`docs/user/develop/basic/config.md`）。

### 1.2 最小完整示例

```ts
// src/index.ts
import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'

export const name = 'im-weixin'

// 必需服务：agent 服务（ctx.agents），用于创建/驱动 agent。
export const inject = ['agents']

export interface Config {
  /** provider 路由，例如 'deepseek-official'。 */
  provider?: string
  /** 模型 id，例如 'deepseek-v4-flash'。 */
  model?: string
  /** 每请求输出 token 上限（正整数）。 */
  maxTokens?: number
}

export const Config: Schema<Config> = Schema.object({
  provider: Schema.string(),
  model: Schema.string(),
  maxTokens: Schema.number().step(1).min(1),
})

export function apply(ctx: Context, config: Config): void {
  // config 已经过 schema 校验并填入默认值。
  // 所有注册必须走 ctx.on / ctx.effect，卸载时自动回收。
}
```

`schemastery` 的 import 风格两种等价（默认导出既是值也是泛型类型 `Schema<T>`）：

- `import Schema from '@deepseek-ai/schemastery'`（官方教程 `docs/user/develop/basic/config.md` 用法）
- `import z from '@deepseek-ai/schemastery'`（`packages/hooks/hooks-claude-code/src/index.ts` 用法，`z<Config>` 作类型、`z.object(...)` 作值）

### 1.3 关键类型 import 位置

| 类型 | import |
|---|---|
| `Context` | `import type { Context } from '@deepseek-ai/cordis'` |
| schemastery schema | `import Schema from '@deepseek-ai/schemastery'` |

---

## 2. 创建 / 驱动 agent 的精确 API

### 2.1 `ctx.agents.create(...)`

服务：`AgentRegistry`（ctx key：`agents`），源码 `packages/core/agent/src/index.ts`，工厂实现在 `packages/core/agent-loop/src/index.ts`。

```ts
// CreateAgentOptions（packages/core/agent/src/index.ts）
ctx.agents.create(options: CreateAgentOptions): Promise<AgentHandle>
```

```ts
export interface CreateAgentOptions {
  readonly sessionId: SessionId          // 必填：agent 与 session 共享的 id
  readonly meta?: {                      // 会话创建元数据（持久化、校验并快照）
    readonly cwd?: string
    readonly parentSession?: SessionId
    readonly seedLength?: number
    readonly origin?: 'subagent'
    readonly delegationDepth?: number
    readonly agentPreset?: string
  }
  readonly seed?: readonly SessionEvent[] // 初始 replay/fork 历史（可选）
  readonly agentOptions?: AgentOptions    // provider/model/maxTokens
  readonly signal?: AbortSignal           // 仅创建期生效的取消信号
  readonly setup?: AgentSetup             // 发布前的作用域组合回调（可选）
}
```

返回 `AgentHandle`：

```ts
// packages/core/agent/src/index.ts
export interface AgentHandle {
  agent: Agent
  dispose(): Promise<void>   // 唯一面向消费者的 teardown 能力
}
```

要点：

- `create()` 要求已注册 agent factory —— 即组合里必须加载了 `@deepseek-ai/dsh-agent-loop`（`@deepseek-ai/dsh-base` bundle 已包含它，见 `packages/bundle/base/cordis.patch.yml` 第 436 行 `- id: agent-loop`）。否则 reject `no agent factory registered (load an agent-loop plugin)`。
- `agentOptions` 里 `provider` / `model` / `maxTokens` 通过 `AgentOptions` 传入：

```ts
// packages/core/agent/src/runtime-types.ts
export interface AgentOptions {
  provider?: string   // 必须有已注册 adapter
  model?: string      // 由所选 provider adapter 解释
  maxTokens?: number  // 每次会话模型请求的输出 token 上限
}
```

- `SessionId` 是 branded 类型（`string & { readonly [BRAND]: 'SessionId' }`），从 `@deepseek-ai/dsh-session` 导入同名的构造工厂（编译期 cast，运行时零成本）：

```ts
import { SessionId } from '@deepseek-ai/dsh-session'
const id = SessionId(`weixin:${accountId}:${peerId}`)
```

  （定义见 `packages/core/session/src/types.ts`：`export type SessionId` 与 `export function SessionId(id: string): SessionId` 同名共存，均可从包根导入。）

- `dispose()` 是**能力（capability）**：只有持有 handle 的消费者能拆掉 agent。配置型 agent（`ctx.agentLoop.create` 路径）由 loop fiber 拥有，无需 handle；程序化创建的 agent 必须自己持有并负责 `dispose()`。`ctx.agents.get(id)` 返回裸 `Agent`（无 teardown 能力）。

### 2.2 `Agent` 接口

源码：`packages/core/agent/src/runtime-types.ts`。

```ts
export interface Agent {
  readonly id: SessionId
  readonly options: AgentOptions
  readonly session: Session         // 该 agent 驱动的 live session（持久化真相源）
  readonly inbox: Inbox             // pending 消息投影
  readonly status: AgentStatus      // 'idle' | 'running'
  readonly ctx: Context             // agent 作用域上下文
  cancel(cause: AgentCancelCause, options?: CancelOptions): void
  whenIdle(): Promise<void>
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
  send(message: UserMessage, target: InboxTarget, wakeup: boolean): void
  followup(message: UserMessage): void
  steer(message: UserMessage): void
  inject(message: UserMessage): void
}
```

### 2.3 `agent.followup(message)`

```ts
followup(message: UserMessage): void
```

- 把一条**普通下一轮（next-turn）**消息入队并唤醒 driver。返回 **无完成句柄**（不返回任何 promise 或 id）；消息 id 只标识 inbox 的 insert/claim/discard，不代表后续输出或 `turn/end`。
- 语义（`packages/core/agent/README.md`）：`followup()` 追加到 next-turn FIFO 并唤醒；`steer()` 追加到 next-step 并唤醒；`inject()` 追加到 next-step 但**不**唤醒。等待本轮完成用 `whenIdle()`。

### 2.4 构造 `UserMessage`

`createUserMessage` 来自 **`@deepseek-ai/dsh-llm`**（已确认），源码 `packages/llm/llm/src/message.ts`：

```ts
import { createUserMessage } from '@deepseek-ai/dsh-llm'

const message = createUserMessage({
  content: [{ type: 'text', text: '你好' }],
  source: { kind: 'plugin', plugin: 'im-weixin' },
})
// message: UserMessage = { id: MessageId, role: 'user', content: ContentBlock[], source: MessageSource }
```

- `ContentBlock` 文本块：`{ type: 'text', text: string }`（也有 tool 等类型）。
- `MessageSource` 是 merge-extensible 的 sum type；插件注入用 `{ kind: 'plugin', plugin: string }`（`plugin` 填插件名，见 `packages/llm/llm/src/message.ts` 的 `MessageSourceMap`）。
- `createUserMessage` 自动生成 `id`（`crypto.randomUUID()` 的 branded `MessageId`）并 deep-freeze，`role` 固定为 `'user'`。

### 2.5 `agent.whenIdle()`

```ts
whenIdle(): Promise<void>
```

- 观察**整个 agent 的静默**（包括当前 driver 退休前已排程的替换工作）；**不** settle 任何特定消息。
- 用途：`agent.followup(msg)` 后 `await agent.whenIdle()`，再读 `agent.session` 收集本轮回复。一个 agent 上并发多轮需要调用方串行化（本插件 bridge 层用 per-session 队列保证）。

### 2.6 读 assistant 回复：session 事件订阅

session 服务 `SessionStore`（ctx key：`sessions`），源码 `packages/core/session/src/index.ts`。

**订阅方式**（`SessionStore` 声明的 live 事件，`packages/core/session/src/index.ts` 第 54–85 行）：

```ts
ctx.on('session/event', (session: Session, event: SessionEvent) => {
  // 每条 append 后同步触发（post-commit, fire-and-forget）。
})
```

- 事件签名 `(this: Scoped<Session>, session, event)`，`@mode emit`，是作用域过滤的（agent 作用域内注册的 listener 只收到该 agent 的 session 事件）。
- 对应 lifecycle：`session/created` / `session/disposed`（emit），`session/flush`（parallel，持久化落盘屏障）。

**读回复推荐做法**（与现有 `src/dsh/agent-runtime.ts` 一致，无需订阅事件流）：

```ts
const afterSeq = agent.session.seq               // 当前序号
agent.followup(createUserMessage({ ... }))
await agent.whenIdle()                           // 本轮完成后
for (const event of agent.session.events) {      // 冻结快照，append 后失效并重建
  if (event.seq <= afterSeq) continue
  if (event.type !== 'assistant/message') continue
  // event.data.message.content: ContentBlock[]，取 type==='text' 的 .text 拼接
}
```

`Session` 关键字段（`packages/core/session/README.md`）：

- `session.events` —— 缓存的冻结事件快照（append 后失效）。
- `session.seq` —— 当前序号。
- `session.id` —— 只读 typed 身份（`SessionId`）。
- `session.header` —— 创建元数据（`version` / `id` / `createdAt` / 可选 `cwd` / `parentSession` / `seedLength` / `delegationDepth`）。

`SessionEvent` 是**按 `type` 判别的联合类型**（`packages/core/session/src/types.ts` 第 404 行）：

```ts
export type SessionEvent<T = SessionEventType> = {
  type: T
  seq: number          // 会话内单调递增序号
  time: number         // Unix 毫秒时间戳
  data: SessionEventMap[T]
  ignorable?: true     // 未知 type 时可跳过；缺省=必须识别
} & (/* surface 类型额外带 sourceEventSeqs / surfaceOp */)
```

关键 `type`（`SessionEventMap`，同文件第 236 行）：

| type | data | 说明 |
|---|---|---|
| `user/message` | `UserMessage` | 进入 surface 的用户角色消息 |
| `assistant/message` | `{ turn, step, message: AssistantMessage, usage? }` | 每步组装的 assistant 消息，派生历史用这个 |
| `assistant/chunk` | `{ turn, step, chunk }` | 原始流 chunk（token 级回放） |
| `tool/call` | `{ turn, step, callId, name, arguments }` | 模型请求了一次工具调用 |
| `tool/result` | `{ turn, step, message, error?, meta? }` | 工具结果 |
| `turn/start` / `turn/end` / `step/start` / `step/end` | `{ turn }` / `{ turn, reason }` / `{ turn, step }` | 轮/步边界 |

取 assistant 文本：`event.type === 'assistant/message'` 时读 `event.data.message.content`（`AssistantMessage.content: ContentBlock[]`），过滤 `block.type === 'text'` 拼接 `block.text`。工具调用内容也在 assistant message 的 content 里（`tool_use` 块），不要当作纯文本回发。

---

## 3. 第三方包如何依赖并运行

### 3.1 包是否 private / 是否已发布

- DSH 产品包（`packages/*/*`）**均非 `private`**，`publishConfig.access: public`，本地源码 version `0.1.0-rc.5`。
- 已在 npm 发布，但**版本陈旧且不一致**（实测 `npm view`）：

| 包 | npm 最新版 | 本地源码版 | 结论 |
|---|---|---|---|
| `@deepseek-ai/dsh-agent` | `0.1.0-rc.6` | `0.1.0-rc.5` | 接近但不同步 |
| `@deepseek-ai/dsh-agent-loop` | `0.1.0-rc.6` | `0.1.0-rc.5` | 接近但不同步 |
| `@deepseek-ai/dsh-llm` | `0.0.1-rc.1` | `0.1.0-rc.5` | **严重过时** |
| `@deepseek-ai/dsh-session` | `0.0.1-rc.1` | `0.1.0-rc.5` | **严重过时** |
| `@deepseek-ai/dsh-brand` / `-scope` / `-session-persistence` / `-base` | `0.0.1-rc.1` | `0.1.0-rc.5` | **严重过时** |
| `@deepseek-ai/cordis` | `4.0.1` | `4.0.1` | ✅ 一致（vendored） |
| `@deepseek-ai/schemastery` | `3.18.1` | `3.18.1` | ✅ 一致（vendored） |
| `@deepseek-ai/cordis-plugin-loader` / `-include` | `1.0.2` / `1.0.6` | 同 | ✅ 一致（vendored） |
| `@deepseek-ai/dsh`（CLI） | `0.1.0-rc.6` | `0.1.0-rc.5` | 接近但不同步 |

**结论：不能依赖 npm 上的 `@deepseek-ai/dsh-*` 产品包。** `dsh-llm` / `dsh-session` 等发布在 `0.0.1-rc.1`，远早于本文档描述的 API（`createUserMessage`、`SessionEvent` 词汇表、`ctx.agents.create`、`AgentHandle` 等都可能不存在或不兼容）。vendored 框架包（cordis/schemastery/loader/include）版本一致，是可用的。

### 3.2 运行时如何解析插件与依赖

- cordis.yml 里每行的 `name` 是**模块 specifier**，由 Loader 解析（`vendor/loader/src/config/tree.ts` 的 `import(name)`）：`cordis:` 前缀 → 内建；`.` 前缀 → 相对 `baseUrl`（profile 目录）解析；否则裸 `import(name)`（走 Node 标准解析，从 Loader 模块位置向上找 `node_modules`）。
- `@deepseek-ai/cordis-plugin-loader` 内部还走 Node internal module loader（`vendor/loader/src/internal.ts`），但最终都落在 profile 目录的 `node_modules`。
- **模块 fallback 机制**（关键）：`healProfilesModuleFallback`（`packages/boot/app-boot/src/profile.ts` 第 223 行）在 `$DSH_HOME/profiles/node_modules` 下为「dsh app 的可解析依赖闭包（BFS 遍历 `dependencies` + `peerDependencies`，**不含 devDependencies**）」的每个包建一个 symlink，指向 dsh 安装自身的那份。因此任何 profile 内安装的插件，其 `@deepseek-ai/*` import 都通过 Node 父目录向上查找命中这个 fallback，**解析到与运行中的 dsh 完全一致的副本**，而不是 npm 上的陈旧副本。
- `@deepseek-ai/dsh-base` 直接依赖 `@deepseek-ai/dsh-agent` / `dsh-agent-loop` / `dsh-llm` / `dsh-session` / `dsh-tools` 等（`packages/bundle/base/package.json`），所以这些包**都在** fallback 闭包里。
- profile 的 `pnpm-workspace.yaml` 用 `nodeLinker: hoisted` + `autoInstallPeers: false`（`packages/boot/app-boot/src/profile.ts` 第 138–143 行），因此**插件声明为 `peerDependencies` 的 `@deepseek-ai/*` 不会被 pnpm 从 npm 自动安装**，而是在运行时落到 healed fallback —— 这正是设计意图（共享安装里唯一一份 cordis 实例，避免重复）。

### 3.3 「resolver manifest dependencies」规则（verify-cordis-config）

`scripts/verify-cordis-config.ts` 强制：**仓库内** raw/Web `cordis.yml`（以及 bundle 的 `cordis.patch.yml`、示例 leaf）中出现的**裸插件 specifier**，必须出现在「拥有该配置文件的 workspace manifest」的 `dependencies` 里（`missingPluginDependencies`）。这是对 **monorepo 内**配置文件的可解析性门禁，针对的 manifest 是 `examples/package.json`、`apps/cli/package.json`、`packages/bundle/*/package.json`。

**对独立仓库的插件不直接适用**：树外插件由 profile 的 `package.json` `dependencies`（pnpm 管理）+ healed fallback 解决，不经过这个门禁。但含义仍然成立——**插件自己 package.json 里的 `@deepseek-ai/*` 依赖必须是 `peerDependencies`**（运行时由 fallback 满足），而插件自身的 `name` 需要被 profile 的 dependencies 引用（通过 `dsh plugin add` 自动写入）。

### 3.4 推荐路径（最可行的一条）

把插件做成**树外 bundle 包**，通过 `dsh` CLI 的 profile 机制安装并运行：

1. **插件包结构**（独立仓库 `dsh-plugin-wechat`）：

   ```jsonc
   // package.json
   {
     "name": "@ox2g/dsh-plugin-wechat",
     "version": "0.0.0",
     "private": true,
     "type": "module",
     "main": "lib/index.js",
     "types": "lib/index.d.ts",
     "files": ["lib", "cordis.patch.yml"],
     // 关键：DSH 依赖全部是 peerDependencies，运行时由 healed fallback 满足
     "peerDependencies": {
       "@deepseek-ai/cordis": "*",
       "@deepseek-ai/schemastery": "*",
       "@deepseek-ai/dsh-agent": "*",
       "@deepseek-ai/dsh-llm": "*",
       "@deepseek-ai/dsh-session": "*"
     },
     "devDependencies": { /* 本地开发用 tsc/vitest 等 */ }
   }
   ```

   可选 `dsh.bundle` 声明（把插件行打包成 patch 层，安装即启用）：

   ```jsonc
   "dsh": { "bundle": { "patch": "./cordis.patch.yml" } }
   ```

2. **构建产物**：TypeScript 编译到 `lib/`（`tsc` 输出 `lib/index.js` + `lib/index.d.ts`）。发布 npm / git 时，git 安装跑的是 `prepare` 脚本而不是 `build`，需自带 `prepare`（见 `docs/user/develop/basic/publish.md` 第 153–178 行的 git 安装说明与 pnpm `allowBuilds` 要求）。本地开发用 `file:`/`link:` 直接指到仓库目录，免构建发布。

3. **安装进 profile**：

   ```sh
   dsh plugin --profile wechat add link:/path/to/dsh-plugin-wechat
   # 或 file:、相对路径 ./dsh-plugin-wechat、npm 包名、git 地址、.tgz
   ```

4. **运行**：

   ```sh
   dsh --profile wechat          # 首次会初始化 profile（默认含 @deepseek-ai/dsh-base）
   # 源码启动（在 deepseek-harness checkout 内）：pnpm dsh --profile wechat
   ```

5. **开发期快速验证（不安装）**：用 `--patch` overlay 直接插入插件行（`docs/user/develop/basic/config.md` 第 34–43 行）。overlay 里 `name` 用相对/绝对路径指向编译产物：

   ```sh
   dsh --profile web --patch ./overlay.yml
   ```

   但注意：这条路径下插件对 `@deepseek-ai/*` 的解析依赖插件自身目录能向上找到这些包（即插件必须先有 peerDependencies 被满足——最稳的是走第 3 步的 `link:` 安装，让 fallback 生效）。

**为什么这是最可行的路径**：

- 它绕开了 npm 上陈旧的产品包：`@deepseek-ai/*` 一律经 healed fallback 解析到「运行中的 dsh」那份一致副本。
- 它是 DSH 官方文档明确支持的发布/安装模型（`docs/user/develop/basic/publish.md` 的 bundle + profile 两概念）。
- `dsh plugin` 命令自动管理 profile 的 `dependencies` 与 `dsh.profile.bundles`，无需手写。

**不推荐**：把插件放进 monorepo 内 `packages/` 作为 workspace（违反本仓库只读约束，且等价于改 DSH 源码树）；或直接依赖 npm 的 `@deepseek-ai/dsh-*`（版本陈旧、API 不一致）。

---

## 4. cordis.yml 挂载写法

每个 entry 是一个对象：`id`（树内稳定 id，供 patch 定位）、`name`（模块 specifier）、`config`（插件配置）、`disabled`、`inject`、`group`。

```yaml
# 最小可运行示例：把微信插件插进组合
- id: im-weixin
  name: '@ox2g/dsh-plugin-wechat'     # 模块 specifier（package name），不是插件导出的 name
  inject: [agents]                     # 可选：Loader 层的额外注入/拦截
  config:
    provider: deepseek-official        # 传给 AgentOptions.provider
    model: deepseek-v4-flash
    maxTokens: 8192
```

作为 bundle patch 层（`cordis.patch.yml`）插入：

```yaml
# cordis.patch.yml（数组）
- insert:
    - id: im-weixin
      name: '@ox2g/dsh-plugin-wechat'
      config:
        model: deepseek-v4-flash
```

**`!!js` 表达式**（`docs/cordis-primer.md` 第 36–38 行、`AGENTS.md`、`scripts/verify-cordis-config.ts` 注册的 `tag:yaml.org,2002:js`）：

- **`!!js`，不是 `!js`**。
- 只在 `config`（插件注入的 service 就绪后，对该插件上下文求值）与 `disabled`（每次挂载决策时对 loader 上下文求值）两个字段会被插值；其他 entry 元数据（`id` / `name` / `group` / `inject` / `intercept` / `isolate`）保持字面量，表达式在那里面是「真值数据」而非求值。

```yaml
- id: im-weixin
  name: '@ox2g/dsh-plugin-wechat'
  config:
    cwd: !!js process.cwd()
    apiToken: !!js process.env.WECHAT_BOT_TOKEN ?? ''
- id: optional-row
  name: '@example/optional'
  disabled: !!js process.env.ENABLE_OPTIONAL === undefined
```

求值作用域是 `with(ctx){ eval(expr) }`（`vendor/loader/src/config/utils.ts`），因此注入的 service 可作为 `ctx.<key>` 属性访问，全局（如 `process`）也可用。

---

## 5. Config 字段约定

- DSH 规定「**不硬编码 tunable，全部是 Config 字段**」（`AGENTS.md` 与 `docs/user/develop/basic/config.md` 第 76–92 行）：凡两个部署可能取值不同的东西都必须是 `cordis.yml` 可改的 Config 字段，`DEFAULT_*` 常量/测试钩子不算可配置。协议常量、外部规范、安全不变式保持固定。
- **必须**用 schemastery 的 `Schema` 定义（导出 interface + 同名 schema），**不能**导出普通对象。校验在插件加载时进行，非法配置 fail loud。
- 默认值直接写在 schema 字段上；自包含约束（如正整数）用 `Schema.number().step(1).min(1)` 表达。

最小 Config + apply（比 hooks-claude-code 更简的版本见 1.2 节）。多行/联合类型参考：

```ts
import Schema from '@deepseek-ai/schemastery'

export interface Config {
  model: string
  timeoutMs: number
  mode?: 'poll' | 'webhook'
}

export const Config = Schema.object({
  model: Schema.string().required(),
  timeoutMs: Schema.number().step(1).min(1).default(30_000),
  mode: Schema.union(['poll', 'webhook']).default('poll'),
})
```

---

## 6. 微信插件落地要点（对照现有 `src/dsh/agent-runtime.ts`）

现有 `src/dsh/agent-runtime.ts` 的骨架正确（复用 live agent、`followup` + `whenIdle` + 读 `session.events` 收集 assistant 文本）。落地时注意：

- 插件 `inject: ['agents']`，`apply` 里把 `ctx` 交给 `AgentRuntime`；`ctx.agents` 属性访问依赖 `agents` 已注入。
- `createUserMessage` 的 `source.plugin` 建议用稳定字符串（与插件 `name` 一致，如 `'im-weixin'`），当前硬编码 `'im-weixin'` 可保留但应作为常量。
- 多账户/多 peer 串行化：同一 `sessionId` 的 `followup` 必须串行（`whenIdle()` 不区分消息）；bridge 层 per-session 队列是正确的做法。
- 复用语义：`ctx.agents.get(sessionId)` 返回裸 `Agent`（无 dispose 能力）；插件自己 `create()` 的 agent 要 `dispose()`（进程退出时统一回收，现有 `dispose()` 已做）。
- 若需要跨重启续聊，应改用 `ctx.agents.resume({ resumeSessionId })`（需要加载 session-persistence 后端，如 `@deepseek-ai/dsh-session-persistence-jsonl`），或用稳定 `sessionId` + persistence 让 `create` 首次创建、后续 remount 恢复。

---

## 7. TODO / 待验证

- **TODO**：`dsh.plugin` 的 bundle 声明（`dsh.bundle.patch`）只是「安装即自动加入层」的便捷方式；若插件只做 side-effect（轮询驱动 agent），也可以不做 bundle、改由 profile 的 `cordis.patch.yml` 手动 insert。二选一即可，需按最终分发方式定。
- **TODO**：`agent.whenIdle()` 只保证 quiescence，不保证 `session/flush` 落盘；微信场景只读内存回复（`session.events`）足够，若将来要求崩溃后可恢复，需在发回微信前 `await ctx.sessions.flush(agent.session)`。
- **待验证**：`createUserMessage` 的 `source` 是否要携带 `form`（`ContextFormed`）以在 UI/转录里更友好；当前 `{ kind: 'plugin', plugin }` 是合法的默认（`form` 缺省）。
- **待验证**：`@deepseek-ai/dsh-agent` 的 `./invariant` companion 是否需要本插件加载（纯消费者插件通常不需要；invariant 是诊断用，由部署选择）。
- **已确认**：DeepSeek 官方 adapter 的 provider 路由名是 `deepseek-official`（`packages/llm/llm-deepseek/src/index.ts` 第 47 行 `const PROVIDER = 'deepseek-official'`）；model id（如 `deepseek-v4-pro` / `deepseek-v4-flash`）见 `examples/headless-agent/cordis.yml`。微信插件不应硬编码，而应作为 Config 字段透传。
