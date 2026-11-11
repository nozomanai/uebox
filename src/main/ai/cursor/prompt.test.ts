import { describe, expect, it } from 'vitest'
import type { Message } from '@earendil-works/pi-ai'
import { renderCursorPrompt, trailingToolResults } from './prompt'

describe('Cursor 提示词', () => {
  it('单轮用户消息原样送出', () => {
    const prompt = renderCursorPrompt([
      { role: 'user', content: '做一个箱子', timestamp: 1 }
    ])
    expect(prompt.userText).toBe('做一个箱子')
    expect(prompt.systemPrompt).toBe('')
  })

  it('任务的工具结果和上一轮思考会回到下一轮', () => {
    const messages: Message[] = [
      { role: 'system', content: '你是虚幻盒子', timestamp: 1 },
      { role: 'user', content: '改一下材质', timestamp: 2 },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: '先看材质' },
          { type: 'text', text: '我来改' },
          { type: 'toolCall', id: 'c1', name: 'set_material', arguments: { name: 'M' } }
        ],
        api: 'cursor-agent',
        provider: 'cursor',
        model: 'auto',
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
        },
        stopReason: 'toolUse',
        timestamp: 3
      },
      {
        role: 'toolResult',
        toolCallId: 'c1',
        toolName: 'set_material',
        content: [{ type: 'text', text: '已改好' }],
        isError: false,
        timestamp: 4
      }
    ]
    const prompt = renderCursorPrompt(messages)
    expect(prompt.systemPrompt).toContain('你是虚幻盒子')
    expect(prompt.systemPrompt).not.toContain('high')
    expect(prompt.userText).toContain('先看材质')
    expect(prompt.userText).toContain('set_material')
    expect(prompt.userText).toContain('已改好')
    expect(trailingToolResults(messages)).toEqual([
      { id: 'c1', name: 'set_material', text: '已改好', isError: false }
    ])
  })
})
