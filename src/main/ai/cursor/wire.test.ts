import { describe, expect, it } from 'vitest'
import {
  decodeFields,
  decodeServerFrame,
  encodeRunFrames,
  encodeRunRequest,
  extractToolCall,
  resolveCursorModel
} from './wire'

function fieldBytes(field: number, value: Buffer): Buffer {
  const tag = Buffer.from([field << 3 | 2])
  const len = Buffer.from([value.length])
  return Buffer.concat([tag, len, value])
}

function fieldString(field: number, value: string): Buffer {
  return fieldBytes(field, Buffer.from(value, 'utf8'))
}

function fieldVarint(field: number, value: number): Buffer {
  return Buffer.from([field << 3, value])
}

function stringsIn(buf: Buffer): string[] {
  const found: string[] = []
  for (const field of decodeFields(buf)) {
    if (!field.bytes) continue
    const text = field.bytes.toString('utf8')
    if (text && /^[\x20-\x7e]+$/.test(text)) found.push(text)
    found.push(...stringsIn(field.bytes))
  }
  return found
}

describe('Cursor 协议', () => {
  it('auto 送到线上叫 default，composer 的快速档拆成参数', () => {
    expect(resolveCursorModel('auto')).toEqual({
      modelId: 'default',
      parameters: [],
      maxMode: false
    })
    expect(resolveCursorModel('composer-2.5-fast')).toEqual({
      modelId: 'composer-2.5',
      parameters: [{ id: 'fast', value: 'true' }],
      maxMode: false
    })
    expect(resolveCursorModel({ modelId: 'grok-4.7', fast: true, effort: 'high' })).toEqual({
      modelId: 'grok-4.7',
      parameters: [
        { id: 'fast', value: 'true' },
        { id: 'reasoning_effort', value: 'high' }
      ],
      maxMode: false
    })
    expect(resolveCursorModel('grok-4.7').modelId).toBe('grok-4.7')
  })

  it('运行请求里带上 effort 与 fast 参数', () => {
    const bytes = encodeRunRequest({
      modelId: 'grok-4.7',
      userText: '测一下',
      conversationId: 'c',
      messageId: 'm',
      tools: [],
      blobStore: new Map(),
      fast: true,
      effort: 'extra_high',
      context: '500k'
    })
    const text = stringsIn(bytes)
    expect(text).toContain('reasoning_effort')
    expect(text).toContain('extra_high')
    expect(text).toContain('context')
    expect(text).toContain('500k')
    expect(text).toContain('fast')
    expect(text).toContain('true')
  })

  it('运行请求里带用户原文和解析后的模型 id', () => {
    const bytes = encodeRunRequest({
      modelId: 'auto',
      userText: '你好，盒子',
      systemPrompt: 'be brief',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      tools: [{ name: 'read_file', description: 'Read', schema: { type: 'object' } }],
      blobStore: new Map()
    })
    expect(bytes.includes(Buffer.from('你好，盒子'))).toBe(true)
    const text = stringsIn(bytes)
    expect(text).toContain('default')
    expect(text).toContain('read_file')
    expect(text).not.toContain('auto')
    const run = decodeFields(decodeFields(bytes)[0]?.bytes ?? Buffer.alloc(0))
    const excluded = run.find((field) => field.field === 12)
    expect(excluded?.varint).toBe(0n)
  })

  it('一轮运行分成多帧，避免服务端回 No exec result', () => {
    const frames = encodeRunFrames(
      {
        modelId: 'grok-4.7',
        userText: 'hi',
        conversationId: 'c',
        messageId: 'm',
        tools: [],
        blobStore: new Map()
      },
      'C:\\Users\\me'
    )
    expect(frames.length).toBeGreaterThan(4)
  })

  it('从增量帧里拆出正文和思考', () => {
    const text = fieldBytes(1, fieldString(1, '正文'))
    const thinking = fieldBytes(4, fieldString(1, '先想一下'))
    const payload = fieldBytes(1, Buffer.concat([text, thinking]))
    expect(decodeServerFrame(payload).deltas).toEqual([
      { kind: 'text', text: '正文' },
      { kind: 'thinking', text: '先想一下' }
    ])
  })

  it('从交互更新里读出工具名和调用 id', () => {
    const varint = (value: number): Buffer => {
      const bytes: number[] = []
      let rest = value
      while (rest > 0x7f) {
        bytes.push((rest & 0x7f) | 0x80)
        rest >>= 7
      }
      bytes.push(rest)
      return Buffer.from(bytes)
    }
    const msg = (field: number, body: Buffer): Buffer =>
      Buffer.concat([varint((field << 3) | 2), varint(body.length), body])
    const str = (field: number, text: string): Buffer => msg(field, Buffer.from(text))
    const payload = Buffer.concat([
      msg(44, msg(1, str(2, 'echo_tool'))),
      str(3, 'call-abc-12345678'),
      str(9, '{"text":"hello"}')
    ])
    expect(extractToolCall(payload)).toEqual({
      name: 'echo_tool',
      id: 'call-abc-12345678',
      args: { text: 'hello' }
    })
  })

  it('把声明过的工具调用拆出来，不把它当成内置命令', () => {
    const entry = fieldBytes(
      2,
      Buffer.concat([fieldString(1, 'path'), fieldBytes(2, fieldString(3, 'a.txt'))])
    )
    const mcp = fieldBytes(
      11,
      Buffer.concat([fieldString(5, 'read_file'), fieldString(3, 'call-1'), entry])
    )
    const exec = fieldBytes(2, Buffer.concat([fieldVarint(1, 4), fieldString(15, 'exec-1'), mcp]))
    const decoded = decodeServerFrame(exec)
    expect(decoded.exec).toMatchObject({
      kind: 'mcp',
      name: 'read_file',
      toolCallId: 'call-1',
      args: { path: 'a.txt' }
    })
  })
})
