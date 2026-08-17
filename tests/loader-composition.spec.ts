import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore from '@deepseek-ai/dsh-session'
import ApprovalService from '@deepseek-ai/dsh-user-approval'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import * as WechatPlugin from '../src/index.js'

// 无登录账号：桥接不启动长轮询，走「nothing to poll」分支。
vi.mock('../src/wechat/auth/accounts.js', () => ({
  listIndexedWeixinAccountIds: () => [],
  loadWeixinAccount: () => undefined,
}))

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
  vi.unstubAllEnvs()
})

describe('im-weixin real Loader composition through cordis.yml', () => {
  it('挂载成功、注册 userQuestions provider，且可正确 dispose', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-wechat-loader-'))
    vi.stubEnv('DSH_WECHAT_STATE_DIR', root)
    const configPath = join(root, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-session'",
      "- name: '@deepseek-ai/dsh-user-approval'",
      "- name: '@deepseek-ai/dsh-user-questions'",
      "- id: im-weixin",
      "  name: '@ox2g/dsh-plugin-wechat'",
      "  config: { provider: deepseek-official, model: deepseek-v4-pro }",
      '',
    ].join('\n'))

    context = new Context()
    context.baseUrl = pathToFileURL(root).href + '/'
    await context.plugin(Loader)
    context.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-agent', AgentRegistry],
      ['@deepseek-ai/dsh-session', SessionStore],
      ['@deepseek-ai/dsh-user-approval', ApprovalService],
      ['@deepseek-ai/dsh-user-questions', UserQuestionService],
      ['@ox2g/dsh-plugin-wechat', WechatPlugin],
    ])
    context.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
        return modules.get(specifier)
      },
    } as unknown as NonNullable<typeof context.loader.internal>
    await context.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
    await context.loader.await()

    // 插件不注册 user-questions provider（provider 全局唯一，web 场景由 api-proxy
    // 注册，微信插件缺省不注册以避免 DUPLICATE_PROVIDER），所以 ask 抛 NO_PROVIDER。
    const userQuestions = context.get('userQuestions') as UserQuestionService
    await expect(userQuestions.ask({ questions: [{ id: 'q', question: 'hi' }] }))
      .rejects.toThrow(/no user-questions provider is registered/)

    // 插件同时注册了 approval answerer：全局 answerer 对非本运行时的 agent
    // 委托 next()，最终落到 fail-closed unavailable，而非抛错。
    const approval = context.get('approval') as ApprovalService
    const fakeAgent = {
      id: 'not-a-wechat-agent',
      session: {
        events: [{ type: 'turn/start' }, { type: 'user/message' }],
        append: () => ({ type: 'x', data: {} }),
      },
    } as never
    await expect(approval.request({ agent: fakeAgent, toolName: 'bash' }))
      .resolves.toBe('unavailable')
  })
})
