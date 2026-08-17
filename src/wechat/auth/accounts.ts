/*
 * Copyright (C) 2026 Tencent. All rights reserved.
 * Licensed under the MIT License.
 *
 * Ported from Tencent/openclaw-weixin (https://github.com/Tencent/openclaw-weixin).
 *
 * NOTE: this is a *minimal* reimplementation of the original `src/auth/accounts.ts`,
 * which was excluded from the port because it depended on `openclaw/plugin-sdk`
 * (`normalizeAccountId`, `OpenClawConfig`, `config-runtime`). Account IDs here are
 * plain strings (the raw `ilink_bot_id` returned by QR login); OpenClaw's
 * `normalizeAccountId` transformation and `openclaw.json` channel section are gone.
 */
import fs from "node:fs";
import path from "node:path";

import { resolveWeixinStateDir } from "../storage/state-dir.js";

export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

// ---------------------------------------------------------------------------
// Account ID compatibility (legacy raw ID → normalized ID)
// ---------------------------------------------------------------------------

/**
 * Pattern-based reverse of normalizeWeixinAccountId for known weixin ID suffixes.
 * Kept for compatibility when loading accounts / sync bufs stored under an old
 * normalized ID (e.g. "b0f5860fdecb-im-bot" → "b0f5860fdecb@im.bot").
 */
export function deriveRawAccountId(normalizedId: string): string | undefined {
  if (normalizedId.endsWith("-im-bot")) {
    return `${normalizedId.slice(0, -7)}@im.bot`;
  }
  if (normalizedId.endsWith("-im-wechat")) {
    return `${normalizedId.slice(0, -10)}@im.wechat`;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Account index (persistent list of registered account IDs)
// ---------------------------------------------------------------------------

function resolveAccountIndexPath(): string {
  return path.join(resolveWeixinStateDir(), "accounts.json");
}

/** Returns all accountIds registered via QR login. */
export function listIndexedWeixinAccountIds(): string[] {
  const filePath = resolveAccountIndexPath();
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.trim() !== "");
  } catch {
    return [];
  }
}

/** Add accountId to the persistent index (no-op if already present). */
export function registerWeixinAccountId(accountId: string): void {
  const dir = resolveWeixinStateDir();
  fs.mkdirSync(dir, { recursive: true });

  const existing = listIndexedWeixinAccountIds();
  if (existing.includes(accountId)) return;

  const updated = [...existing, accountId];
  fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify(updated, null, 2), "utf-8");
}

/** Remove accountId from the persistent index. */
export function unregisterWeixinAccountId(accountId: string): void {
  const existing = listIndexedWeixinAccountIds();
  const updated = existing.filter((id) => id !== accountId);
  if (updated.length !== existing.length) {
    fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify(updated, null, 2), "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Account store (per-account credential files)
// ---------------------------------------------------------------------------

/** Unified per-account data: token + baseUrl in one file. */
export type WeixinAccountData = {
  token?: string;
  savedAt?: string;
  baseUrl?: string;
  /** Last linked Weixin user id from QR login (optional). */
  userId?: string;
};

function resolveAccountsDir(): string {
  return path.join(resolveWeixinStateDir(), "accounts");
}

function resolveAccountPath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.json`);
}

function readAccountFile(filePath: string): WeixinAccountData | null {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as WeixinAccountData;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Load account data by ID, with a raw-ID compatibility fallback. */
export function loadWeixinAccount(accountId: string): WeixinAccountData | null {
  // Primary: try given accountId.
  const primary = readAccountFile(resolveAccountPath(accountId));
  if (primary) return primary;

  // Compatibility: if the given ID is normalized, derive the old raw filename.
  const rawId = deriveRawAccountId(accountId);
  if (rawId) {
    const compat = readAccountFile(resolveAccountPath(rawId));
    if (compat) return compat;
  }

  return null;
}

/**
 * Persist account data after QR login (merges into existing file).
 * - token: overwritten when provided.
 * - baseUrl: stored when non-empty.
 * - userId: set when `update.userId` is provided; omitted when cleared to empty.
 */
export function saveWeixinAccount(
  accountId: string,
  update: { token?: string; baseUrl?: string; userId?: string },
): void {
  const dir = resolveAccountsDir();
  fs.mkdirSync(dir, { recursive: true });

  const existing = loadWeixinAccount(accountId) ?? {};

  const token = update.token?.trim() || existing.token;
  const baseUrl = update.baseUrl?.trim() || existing.baseUrl;
  const userId =
    update.userId !== undefined
      ? update.userId.trim() || undefined
      : existing.userId?.trim() || undefined;

  const data: WeixinAccountData = {
    ...(token ? { token, savedAt: new Date().toISOString() } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(userId ? { userId } : {}),
  };

  const filePath = resolveAccountPath(accountId);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

/**
 * Remove all files associated with an account:
 *   - accounts/{accountId}.json                (credentials)
 *   - accounts/{accountId}.sync.json           (getUpdates sync buf)
 *   - accounts/{accountId}.context-tokens.json (context tokens on disk)
 */
export function clearWeixinAccount(accountId: string): void {
  const dir = resolveAccountsDir();
  const accountFiles = [
    `${accountId}.json`,
    `${accountId}.sync.json`,
    `${accountId}.context-tokens.json`,
  ];
  for (const file of accountFiles) {
    try {
      fs.unlinkSync(path.join(dir, file));
    } catch {
      // ignore if not found
    }
  }
}

// ---------------------------------------------------------------------------
// Config shims (no openclaw.json in DSH)
// ---------------------------------------------------------------------------

/**
 * Read `routeTag` from the environment. The original read `routeTag` from
 * `openclaw.json` (`channels.openclaw-weixin.routeTag`); DSH has no such file,
 * so this returns undefined (the `SKRouteTag` header is simply omitted).
 */
export function loadConfigRouteTag(_accountId?: string): string | undefined {
  return undefined;
}

/**
 * Read `botAgent` from `DSH_WECHAT_BOT_AGENT` env var (optional override).
 * Callers are responsible for sanitization; returns undefined when unset.
 */
export function loadConfigBotAgent(): string | undefined {
  const value = process.env.DSH_WECHAT_BOT_AGENT?.trim();
  return value || undefined;
}
