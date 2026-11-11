import { describe, expect, it } from 'vitest'
import type { AssistantMessageEvent, AssistantMessageEventStream } from '@earendil-works/pi-ai'
import { applyCursorDelta, applyMcpCall, createTurnState, parkKey, versionFromNames } from './stream'
import type { Model } from '@earendil-works/pi-ai'

const model = {
  id: 'grok-4.7',
  name: 'Grok 4.7',
  api: 'cursor-agent',
  provider: 'cursor',
  baseUrl: 'https://api2.cursor.sh',
  reasoning: true,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 32_000
} as Model<string>

function recorder(): { events: AssistantMessageEvent[]; stream: AssistantMessageEventStream } {
  const events: AssistantMessageEvent[] = []
  const stream = {
    push(event: AssistantMessageEvent) {
      events.push(event)
    }
  } as AssistantMessageEventStream
  return { events, stream }
}

describe('Cursor 事件流', () => {
  it('用本机 CLI 的最新版本号，没有就用兜底', () => {
    expect(versionFromNames(['2026.07.08-0c04a8a', '2026.11.05-86047df', 'promote-staged.cmd'])).toBe(
      'cli-2026.11.05-86047df'
    )
    expect(versionFromNames([])).toBe('cli-2026.11.05-86047df')
  })

  it('工具结果按调用 id 对齐，顺序无关', () => {
    expect(parkKey(['b', 'a'])).toBe(parkKey(['a', 'b']))
  })

  it('思考增量和正文分开，思考不会混进正文', () => {
    const state = createTurnState(model)
    const { events, stream } = recorder()
    applyCursorDelta(state, stream, { kind: 'thinking', text: '先看' })
    applyCursorDelta(state, stream, { kind: 'thinking', text: '工程' })
    applyCursorDelta(state, stream, { kind: 'thinking_done' })
    applyCursorDelta(state, stream, { kind: 'text', text: '改好了' })

    expect(events.map((event) => event.type)).toEqual([
      'thinking_start',
      'thinking_delta',
      'thinking_delta',
      'thinking_end',
      'text_start',
      'text_delta'
    ])
    expect(state.output.content).toEqual([
      { type: 'thinking', thinking: '先看工程' },
      expect.objectContaining({ type: 'text', text: '改好了' })
    ])
  })

  it('工具调用交给外层任务循环，而不是在流里执行', () => {
    const state = createTurnState(model)
    const { events, stream } = recorder()
    applyMcpCall(state, stream, {
      kind: 'mcp',
      id: 1,
      execId: 'e',
      name: 'set_material',
      toolCallId: 'c1',
      args: { name: 'M' }
    })
    expect(events.map((event) => event.type)).toEqual([
      'toolcall_start',
      'toolcall_delta',
      'toolcall_end'
    ])
    expect(state.tools).toEqual([
      expect.objectContaining({ name: 'set_material', id: 'c1', arguments: { name: 'M' } })
    ])
  })
})
