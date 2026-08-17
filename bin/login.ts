/**
 * 微信扫码登录 CLI：与 `dsh-plugin-wechat` 插件运行共享同一状态目录。
 *
 * 用法：`tsx bin/login.ts`（或编译后 `node lib-bin/login.js`）。
 * 成功后把 token/baseUrl/accountId 持久化到 `DSH_WECHAT_STATE_DIR`（默认
 * `~/.dsh-plugin-wechat`），插件运行期直接读取。
 */

import {
  displayQRCode,
  startWeixinLoginWithQr,
  waitForWeixinLogin,
} from '../src/wechat/auth/login-qr.js'
import { registerWeixinAccountId, saveWeixinAccount } from '../src/wechat/auth/accounts.js'
import { resolveWeixinStateDir } from '../src/wechat/storage/state-dir.js'
import { logger } from '../src/wechat/util/logger.js'

const FIXED_BASE_URL = 'https://ilinkai.weixin.qq.com'

async function main(): Promise<void> {
  const start = await startWeixinLoginWithQr({ apiBaseUrl: FIXED_BASE_URL })
  if (!start.qrcodeUrl) {
    logger.error(start.message)
    process.exitCode = 1
    return
  }
  process.stdout.write(start.message + '\n')
  await displayQRCode(start.qrcodeUrl)

  const result = await waitForWeixinLogin({
    sessionKey: start.sessionKey,
    apiBaseUrl: FIXED_BASE_URL,
    verbose: true,
  })

  if (result.alreadyConnected) {
    process.stdout.write(result.message + '\n')
    return
  }
  if (!result.connected) {
    logger.error(result.message)
    process.exitCode = 1
    return
  }

  const accountId = result.accountId
  const botToken = result.botToken
  if (!accountId || !botToken) {
    logger.error('登录成功但服务器未返回 accountId/botToken')
    process.exitCode = 1
    return
  }

  saveWeixinAccount(accountId, {
    token: botToken,
    baseUrl: result.baseUrl,
    userId: result.userId,
  })
  registerWeixinAccountId(accountId)

  process.stdout.write(`✅ 登录成功：accountId=${accountId}\n`)
  process.stdout.write(`状态目录：${resolveWeixinStateDir()}\n`)
}

main().catch((error: unknown) => {
  logger.error(`login failed: ${String(error)}`)
  process.exitCode = 1
})
