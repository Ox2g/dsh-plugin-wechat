/*
 * Copyright (C) 2026 Tencent. All rights reserved.
 * Licensed under the MIT License.
 *
 * Ported from Tencent/openclaw-weixin (https://github.com/Tencent/openclaw-weixin).
 */
import fs from "node:fs";
import path from "node:path";

import { deriveRawAccountId } from "../auth/accounts.js";

import { resolveWeixinStateDir } from "./state-dir.js";

function resolveAccountsDir(): string {
  return path.join(resolveWeixinStateDir(), "accounts");
}

/**
 * Path to the persistent get_updates_buf file for an account.
 * Stored alongside account data: <stateDir>/weixin/accounts/{accountId}.sync.json
 */
export function getSyncBufFilePath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.sync.json`);
}

export type SyncBufData = {
  get_updates_buf: string;
};

function readSyncBufFile(filePath: string): string | undefined {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(raw) as { get_updates_buf?: string };
    if (typeof data.get_updates_buf === "string") {
      return data.get_updates_buf;
    }
  } catch {
    // file not found or invalid
  }
  return undefined;
}

/**
 * Load persisted get_updates_buf.
 * Falls back in order:
 *   1. Primary path (normalized accountId, new installs)
 *   2. Compat path (raw accountId derived from pattern, old installs)
 *
 * NOTE: the original also had a third "legacy single-account" fallback that read
 * an OpenClaw session directory (`stateDir/agents/default/sessions/...`); that
 * path is OpenClaw-specific and was dropped for the DSH port.
 */
export function loadGetUpdatesBuf(filePath: string): string | undefined {
  const value = readSyncBufFile(filePath);
  if (value !== undefined) return value;

  // Compat: if given path uses a normalized accountId (e.g. "b0f5860fdecb-im-bot.sync.json"),
  // also try the old raw-ID filename (e.g. "b0f5860fdecb@im.bot.sync.json").
  const accountId = path.basename(filePath, ".sync.json");
  const rawId = deriveRawAccountId(accountId);
  if (rawId) {
    const compatPath = path.join(resolveAccountsDir(), `${rawId}.sync.json`);
    const compatValue = readSyncBufFile(compatPath);
    if (compatValue !== undefined) return compatValue;
  }

  return undefined;
}

/**
 * Persist get_updates_buf. Creates parent dir if needed.
 */
export function saveGetUpdatesBuf(filePath: string, getUpdatesBuf: string): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({ get_updates_buf: getUpdatesBuf }, null, 0), "utf-8");
}
