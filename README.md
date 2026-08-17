# dsh-plugin-wechat

_English (default) · [中文](./README.zh-CN.md)_

WeChat access plugin for DeepSeek Harness (DSH): users converse with DSH agents through WeChat. The plugin runs in-process as a Cordis **function plugin** of DSH, reusing the WeChat protocol layer from [Tencent/openclaw-weixin](https://github.com/Tencent/openclaw-weixin) (MIT) — the Tencent ilink WeChat bot gateway with QR-code login — replacing the OpenClaw adapter with a DSH-side adapter that creates and drives agents via `ctx.agents` to send and receive messages.

## Positioning

- Follows the DSH plugin spec: named exports `name` / `inject` / `Config` / `apply`, **no default export**; registration and cleanup go through `ctx.effect()`.
- Pure ESM (`"type": "module"`), Node `>=22`, TypeScript `NodeNext`.
- WeChat protocol layer lives in `src/wechat/` (keeps the Tencent MIT license header); DSH adaptation lives in `src/bridge/`, `src/dsh/`, and `src/index.ts`.

## Prerequisites

1. A usable **ilink WeChat bot gateway** account (QR-code pairing to obtain a token; default backend `https://ilinkai.weixin.qq.com`). This is not the WeCom / Official Account API.
2. An installed **DeepSeek Harness** (the `dsh` CLI, or a local checkout).

## Installation & enabling

```sh
# Create/reuse a profile in dsh and install this plugin (link the local repo, or use an npm/git package name)
dsh plugin --profile wechat add link:/path/to/dsh-plugin-wechat

# Run (initializes the profile on first run; includes @deepseek-ai/dsh-base by default)
dsh --profile wechat
```

`dsh.bundle.patch` in this package's `package.json` points to `cordis.patch.yml`; it takes effect on install after `dsh plugin add`. The `@deepseek-ai/*` packages are declared as `peerDependencies` and resolved at runtime by dsh's `healProfilesModuleFallback` to the same copy as the running dsh (no reliance on stale rc packages on npm).

## QR-code login

```sh
# Build first, then scan the QR code (a QR code is shown in the terminal; the token is written to DSH_WECHAT_STATE_DIR, default ~/.dsh-plugin-wechat)
pnpm build
pnpm login
```

Login and the plugin's runtime share the same state directory (`DSH_WECHAT_STATE_DIR` or `~/.dsh-plugin-wechat`).

## Configuration (cordis.yml / cordis.patch.yml)

| Key | Default | Description |
|---|---|---|
| `provider` | — | Provider routing for new sessions (e.g. `deepseek-official`) |
| `model` | — | Model id for new sessions (e.g. `deepseek-v4-flash`) |
| `maxTokens` | — | Output token cap per session model request |
| `baseUrl` | `https://ilinkai.weixin.qq.com` | ilink backend |
| `stateDir` | `~/.dsh-plugin-wechat` | Account/token/log directory |
| `dmScope` | `per-account-channel-peer` | Session isolation dimension: `per-peer` / `per-account-channel-peer` |
| `replyErrorAsText` | `true` | Whether to reply with a readable error text when an agent fails |
| `cwd` | `<stateDir>/workspace` | Working directory for new sessions (absolute path, auto-created); persona's `{{cwd}}` and fs/bash expand here |
| `sessionTitle` | `微信` | Title for new sessions (written via `sessionTitle.rename` in the same process; no cross-process concurrent-write risk) |

Environment variables: `DSH_WECHAT_STATE_DIR`, `DSH_WECHAT_LOG_DIR`, `DSH_WECHAT_LOG_LEVEL`, `DSH_WECHAT_BOT_AGENT`.

## Development

```sh
pnpm install      # install dev/optional dependencies; @deepseek-ai/* peers satisfied by link: local packages
pnpm typecheck    # tsc --noEmit
pnpm test         # vitest run
pnpm build        # tsc → lib/
pnpm login        # tsx bin/login.ts QR-code login
```

The `@deepseek-ai/*` packages are `peerDependencies`, resolved from the DSH host process at runtime and not installed from the registry (`.npmrc` disables `auto-install-peers`). Local typecheck/test/build need them resolvable: `devDependencies` in `package.json` use `link:../deepseek-harness/...` to point at the local checkout's build output, and pnpm generates isomorphic symlinks under `node_modules/@deepseek-ai`; transitive dependencies resolve along the real paths into deepseek-harness's own `node_modules`. Requirements:

- [`pnpm`](https://pnpm.io) ≥ 11 (`pnpm install` validates dependency install scripts; `allowBuilds` in `pnpm-workspace.yaml` whitelists esbuild);
- `deepseek-harness` sits alongside this repo (`../deepseek-harness`); if the path differs, change the `link:` paths in `package.json`;
- deepseek-harness packages are built (`lib/` exists).

## Directory layout

- `src/wechat/` — ported WeChat protocol layer (api/auth/cdn/media/messaging/storage/util)
- `src/bridge/weixin-bridge.ts` — long polling → agent routing → reply dispatch
- `src/dsh/agent-runtime.ts` — `ctx.agents` driver layer
- `src/index.ts` — plugin entry (`name`/`inject`/`Config`/`apply`)
- `src/config.ts` — config schema (schemastery)
- `bin/login.ts` — QR-code login CLI
- `cordis.patch.yml` — bundle patch layer (enabled on install)
- `docs/` — doc conventions and contract research; structure per [CLAUDE.md](./CLAUDE.md) "文档规约" (features / specs / roadmap / wiki / research + issues.md)

## Documentation

- [CLAUDE.md](./CLAUDE.md) — project conventions (boundaries, contracts, development & verification, doc conventions)
- [docs/roadmap/2026-08-16-plan.md](./docs/roadmap/2026-08-16-plan.md) — feasible approach and phased plan
- [docs/research/2026-08-16-openclaw-weixin-port-analysis.md](./docs/research/2026-08-16-openclaw-weixin-port-analysis.md) — analysis of porting the openclaw-weixin protocol layer
- [docs/specs/2026-08-16-dsh-plugin-contract.md](./docs/specs/2026-08-16-dsh-plugin-contract.md) — DSH plugin contract

## WeChat interactions

Beyond plain conversations, the plugin bridges DSH's blocking interactions to the WeChat message round-trip:

- **Permission approval**: when an agent needs authorization (e.g. bash elevation), the plugin sends "⚠️ Authorization needed to run X, reply 1 to approve / 2 to deny" to WeChat and returns the outcome after the user replies.
- **Ask the user**: when an agent calls `ask_user_question`, the plugin sends the question + options to WeChat and waits for the user to reply with a number or free text.
- **Tool feedback**: when an agent runs a tool, the plugin sends "🔧 Running X" and failure notices to WeChat.

## Co-process with the Web GUI (two-way sync)

The plugin can join a web profile (add `@ox2g/dsh-plugin-wechat` to `dsh.profile.bundles` of `profiles/web`), enabling two-way sync between WeChat and the Web page:

- **WeChat → page**: WeChat messages enter the session log, which the Web page shows when the session is opened; agent replies go through WeChat and are also written to the log.
- **Page → WeChat**: messages sent from the page to a WeChat session are forwarded by the plugin to the WeChat app (using the send channel of the most recent WeChat message).

Within the same process the plugin adapts automatically:

- **persona only affects WeChat agents** (registers a "plain-text reply" section within the WeChat agent's scope), not Web agents.
- **user-questions provider is not re-registered** (skipped when `apiProxy` is detected; the WeChat agent's ask-the-user is presented by the page).
- **approval answerer takes precedence** (`prepend` + only handles `weixin:`-prefixed sessions); WeChat agent authorization goes through WeChat, while Web agent authorization is still handled by the page answerer.

Implementation relies on two peer dependencies, `@deepseek-ai/dsh-user-approval` / `@deepseek-ai/dsh-user-questions`; the approval/question answerers and providers are registered within the WeChat profile process, in separate processes from the Web GUI's counterparts, so they don't conflict.

## Known limitations

- The first version handles **text** only; images/voice/files/videos go through `src/wechat/cdn` + `messaging/send-media`, not yet wired into the agent round-trip (inbound media could be extended beyond `extractText`).
- Cross-restart session continuity requires `sessionPersistence` (`ctx.agents.resume`); currently multi-turn continuity runs within the process via a stable `sessionId`.
- No wall-clock timeout / side-effect rollback; same-session messages are serialized inside `AgentRuntime`.