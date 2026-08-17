import { describe, expect, it } from 'vitest'

import { weixinSessionId } from '../src/dsh/agent-runtime.js'
import { Config } from '../src/config.js'

describe('weixinSessionId', () => {
  it('per-account-channel-peer 把 accountId + peerId 都编码进 sessionId', () => {
    const id = weixinSessionId('acct1', 'peer1', 'per-account-channel-peer')
    expect(String(id)).toBe('weixin:acct1:peer1')
  })

  it('per-peer 只编码 peerId（单账户可退化）', () => {
    const id = weixinSessionId('acct1', 'peer1', 'per-peer')
    expect(String(id)).toBe('weixin:peer1')
  })
})

describe('Config schema', () => {
  it('空配置填入默认值', () => {
    const config = Config({})
    expect(config.baseUrl).toBe('https://ilinkai.weixin.qq.com')
    expect(config.dmScope).toBe('per-account-channel-peer')
    expect(config.replyErrorAsText).toBe(true)
  })

  it('拒绝非法的 dmScope 取值', () => {
    expect(() => Config({ dmScope: 'bogus' })).toThrow()
  })

  it('透传显式 provider/model/maxTokens', () => {
    const config = Config({ provider: 'deepseek-official', model: 'deepseek-v4-flash', maxTokens: 8192 })
    expect(config.provider).toBe('deepseek-official')
    expect(config.model).toBe('deepseek-v4-flash')
    expect(config.maxTokens).toBe(8192)
  })
})
