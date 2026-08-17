/*
 * Copyright (C) 2026 Tencent. All rights reserved.
 * Licensed under the MIT License.
 *
 * Ported from Tencent/openclaw-weixin (https://github.com/Tencent/openclaw-weixin).
 */
import os from "node:os";
import path from "node:path";

/**
 * Resolve the plugin state directory.
 *
 * Priority:
 *   1. `DSH_WECHAT_STATE_DIR` env var
 *   2. `~/.dsh-plugin-wechat`
 *
 * NOTE: the original resolved `OPENCLAW_STATE_DIR` / `CLAWDBOT_STATE_DIR` and
 * defaulted to `~/.openclaw`; those are replaced with the DSH env var above.
 */
export function resolveStateDir(): string {
  return (
    process.env.DSH_WECHAT_STATE_DIR?.trim() ||
    path.join(os.homedir(), ".dsh-plugin-wechat")
  );
}

/**
 * Weixin subdirectory under the state dir.
 * Holds the account index, per-account credentials, sync bufs, context tokens,
 * and debug-mode state.
 */
export function resolveWeixinStateDir(): string {
  return path.join(resolveStateDir(), "weixin");
}
