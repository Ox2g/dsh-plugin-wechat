import { describe, expect, it } from 'vitest'

import { WechatInteraction } from '../src/dsh/interaction.js'
import type { ApprovalRequest } from '@deepseek-ai/dsh-user-approval'
import type { AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'

/** 让 sender 的异步发送与 pending promise 注册落定。 */
const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function approvalRequest(toolName: string, id = 's1'): ApprovalRequest {
  return { agent: { id } as never, toolName }
}

function questionRequest(id = 's1'): AskUserQuestionRequest {
  return {
    agent: { id } as never,
    questions: [
      { id: 'q1', question: '选哪个？', options: [{ label: '甲' }, { label: '乙' }] },
    ],
  }
}

describe('WechatInteraction 授权往返', () => {
  it('批准关键词（批准/1/yes）→ allowed-once', async () => {
    const interaction = new WechatInteraction()
    const sent: string[] = []
    interaction.setSender('s1', async (text) => { sent.push(text) })

    const outcome = interaction.askApproval(approvalRequest('bash'))
    await settle()
    expect(sent).toHaveLength(1)
    expect(interaction.hasPending('s1')).toBe(true)

    expect(interaction.routeInbound('s1', '批准')).toBe(true)
    await expect(outcome).resolves.toBe('allowed-once')
    expect(interaction.hasPending('s1')).toBe(false)
  })

  it('非批准关键词 → rejected（fail-closed）', async () => {
    const interaction = new WechatInteraction()
    interaction.setSender('s1', async () => {})

    const outcome = interaction.askApproval(approvalRequest('bash'))
    await settle()
    expect(interaction.routeInbound('s1', '拒绝')).toBe(true)
    await expect(outcome).resolves.toBe('rejected')
  })

  it('无 sender → unavailable', async () => {
    const interaction = new WechatInteraction()
    await expect(interaction.askApproval(approvalRequest('bash', 's9')))
      .resolves.toBe('unavailable')
  })
})

describe('WechatInteraction 问询往返', () => {
  it('编号选择 → 对应选项 label', async () => {
    const interaction = new WechatInteraction()
    interaction.setSender('s1', async () => {})

    const answer = interaction.askQuestion(questionRequest())
    await settle()
    expect(interaction.routeInbound('s1', '2')).toBe(true)
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['乙'] }] })
  })

  it('直接回复选项 label → 该 label', async () => {
    const interaction = new WechatInteraction()
    interaction.setSender('s1', async () => {})

    const answer = interaction.askQuestion(questionRequest())
    await settle()
    interaction.routeInbound('s1', '甲')
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: ['甲'] }] })
  })

  it('自由文本 → custom', async () => {
    const interaction = new WechatInteraction()
    interaction.setSender('s1', async () => {})

    const answer = interaction.askQuestion({
      agent: { id: 's1' } as never,
      questions: [{ id: 'q1', question: '说点什么？' }],
    })
    await settle()
    interaction.routeInbound('s1', '随便说说')
    await expect(answer).resolves.toEqual({ answers: [{ id: 'q1', selected: [], custom: '随便说说' }] })
  })
})

describe('WechatInteraction 页面→微信转发', () => {
  it('有 sender 时转发页面消息的 text 块', async () => {
    const interaction = new WechatInteraction()
    const sent: string[] = []
    interaction.setSender('s1', async (text) => { sent.push(text) })

    interaction.forwardToWechat('s1', { content: [{ type: 'text', text: '页面发的消息' }] })
    await settle()
    expect(sent).toEqual(['页面发的消息'])
  })

  it('无 sender 时静默跳过（不抛错）', async () => {
    const interaction = new WechatInteraction()
    expect(() => {
      interaction.forwardToWechat('s9', { content: [{ type: 'text', text: 'hi' }] })
    }).not.toThrow()
  })

  it('空文本不发送', async () => {
    const interaction = new WechatInteraction()
    const sent: string[] = []
    interaction.setSender('s1', async (text) => { sent.push(text) })

    interaction.forwardToWechat('s1', { content: [] })
    await settle()
    expect(sent).toEqual([])
  })
})
