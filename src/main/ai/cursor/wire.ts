import { randomUUID } from 'crypto'

import { cursorMaxModeForContext } from './modelOptions'
import { gunzipSync } from 'zlib'

/**
 * Cursor AgentService 的一小段自写 protobuf。
 *
 * 订阅账号的对话不走 OpenAI 兼容接口，而是 HTTP/2 上的 Connect 帧：
 * `POST /agent.v1.AgentService/Run`。字段号来自 Cursor CLI 自带的
 * agent.v1 描述符（AgentRunRequest、InteractionUpdate、ExecServerMessage）。
 * 这里只编我们真正收发的那几条，不引入整份生成代码。
 *
 * 端点与字段号的公开整理：
 * - https://cursor.com/docs/cli/reference/authentication （登录，不是这条对话）
 * - AgentRunRequest：conversation_state=1，action=2，model_details=3，
 *   mcp_tools=4，conversation_id=5，requested_model=9，exclude_workspace_context=12
 */

const WT_VARINT = 0
const WT_FIXED64 = 1
const WT_LEN = 2

const CONNECT_GZIP = 0x01
const CONNECT_END = 0x02

export interface ProtoField {
  field: number
  wire: number
  varint?: bigint
  bytes?: Buffer
}

export interface CursorToolDef {
  name: string
  description: string
  /** JSON Schema，会编成 google.protobuf.Value 再放进工具定义 */
  schema: unknown
}

export interface CursorImage {
  uuid: string
  mimeType: string
  data: Buffer
}

export interface CursorRunInput {
  modelId: string
  userText: string
  systemPrompt?: string
  conversationId: string
  messageId: string
  tools: CursorToolDef[]
  images?: CursorImage[]
  blobStore: Map<string, Buffer>
  /** requested_model 参数：与 Cursor 客户端 Options → Fast 一致 */
  fast?: boolean
  /** requested_model 参数 reasoning_effort，与 Cursor 客户端 Effort 一致 */
  effort?: string
  /** requested_model 参数 context，如 256k / 500k */
  context?: string
}

export interface CursorModelResolveInput {
  modelId: string
  fast?: boolean
  effort?: string
  context?: string
}

export interface CursorModelResolved {
  modelId: string
  parameters: Array<{ id: string; value: string }>
  maxMode: boolean
}

export type CursorDelta =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'thinking_done' }
  | { kind: 'turn_ended' }
  | { kind: 'heartbeat' }
  | { kind: 'token'; tokens: number }

export interface CursorExecRequestContext {
  kind: 'request_context'
  id: number
  execId: string
}

export interface CursorMcpCall {
  kind: 'mcp'
  id: number
  execId: string
  name: string
  toolCallId: string
  args: Record<string, unknown>
}

export interface CursorBuiltinCall {
  kind: 'builtin'
  id: number
  execId: string
  /** ExecServerMessage 里那个变体的字段号，回包用同一个号 */
  variant: number
  detail: string
}

export type CursorExec = CursorExecRequestContext | CursorMcpCall | CursorBuiltinCall

export interface CursorKvGet {
  kind: 'get'
  id: number
  blobId: Buffer
  metadata: Buffer | null
}

export interface CursorKvSet {
  kind: 'set'
  id: number
  metadata: Buffer | null
}

export type CursorKv = CursorKvGet | CursorKvSet

export interface DecodedToolCall {
  name: string
  id: string
  args: Record<string, unknown>
}

export interface DecodedServerFrame {
  deltas: CursorDelta[]
  exec: CursorExec | null
  kv: CursorKv | null
  /** 交互更新里的工具调用。参数在 args 里，没有就是空对象 */
  toolCall: DecodedToolCall | null
}

export function frameConnect(payload: Uint8Array, flags = 0): Buffer {
  const frame = Buffer.alloc(5 + payload.length)
  frame[0] = flags
  frame.writeUInt32BE(payload.length, 1)
  frame.set(payload, 5)
  return frame
}

export function splitConnectFrames(buffer: Buffer): {
  frames: Array<{ flags: number; payload: Buffer }>
  rest: Buffer
} {
  const frames: Array<{ flags: number; payload: Buffer }> = []
  let pos = 0
  while (pos + 5 <= buffer.length) {
    const flags = buffer[pos]
    const length = buffer.readUInt32BE(pos + 1)
    if (pos + 5 + length > buffer.length) break
    const raw = buffer.subarray(pos + 5, pos + 5 + length)
    const payload = flags & CONNECT_GZIP ? gunzipSync(raw) : raw
    frames.push({ flags, payload })
    pos += 5 + length
  }
  return { frames, rest: buffer.subarray(pos) }
}

/** Connect 结束帧。失败时把对方的 message 取出来 */
export function connectEndError(payload: Buffer): string | undefined {
  try {
    const body = JSON.parse(payload.toString('utf8')) as {
      error?: { message?: string; code?: string }
    }
    const message = body.error?.message || body.error?.code
    return message ? String(message) : undefined
  } catch {
    return payload.length > 0 ? payload.toString('utf8').slice(0, 300) : undefined
  }
}

export function isConnectEnd(flags: number): boolean {
  return (flags & CONNECT_END) !== 0
}

function encodeVarint(value: number | bigint): Buffer {
  let v = typeof value === 'bigint' ? value : BigInt(value)
  if (v < 0n) v = 0n
  const bytes: number[] = []
  while (v > 0x7fn) {
    bytes.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  bytes.push(Number(v))
  return Buffer.from(bytes)
}

function tag(field: number, wire: number): Buffer {
  return encodeVarint((field << 3) | wire)
}

function fieldBytes(field: number, value: Uint8Array): Buffer {
  return Buffer.concat([tag(field, WT_LEN), encodeVarint(value.length), Buffer.from(value)])
}

function fieldString(field: number, value: string): Buffer {
  return fieldBytes(field, Buffer.from(value, 'utf8'))
}

function fieldVarint(field: number, value: number): Buffer {
  return Buffer.concat([tag(field, WT_VARINT), encodeVarint(value)])
}

function fieldMessage(field: number, parts: Buffer[]): Buffer {
  return fieldBytes(field, Buffer.concat(parts))
}

function readVarint(buf: Buffer, pos: number): [bigint, number] {
  let result = 0n
  let shift = 0n
  let cursor = pos
  while (cursor < buf.length) {
    const byte = buf[cursor]
    cursor += 1
    result |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return [result, cursor]
    shift += 7n
    if (shift > 70n) break
  }
  return [result, cursor]
}

export function decodeFields(buf: Buffer): ProtoField[] {
  const fields: ProtoField[] = []
  let pos = 0
  while (pos < buf.length) {
    const [header, next] = readVarint(buf, pos)
    if (next === pos) break
    pos = next
    const field = Number(header >> 3n)
    const wire = Number(header & 7n)
    if (field <= 0) break
    if (wire === WT_VARINT) {
      const [value, after] = readVarint(buf, pos)
      pos = after
      fields.push({ field, wire, varint: value })
    } else if (wire === WT_FIXED64) {
      if (pos + 8 > buf.length) break
      fields.push({ field, wire, bytes: buf.subarray(pos, pos + 8) })
      pos += 8
    } else if (wire === WT_LEN) {
      const [len, after] = readVarint(buf, pos)
      pos = after
      const size = Number(len)
      if (!Number.isFinite(size) || size < 0 || pos + size > buf.length) break
      fields.push({ field, wire, bytes: buf.subarray(pos, pos + size) })
      pos += size
    } else if (wire === 5) {
      pos += 4
    } else {
      break
    }
  }
  return fields
}

function stringField(buf: Buffer, field: number): string {
  const hit = decodeFields(buf).find((item) => item.field === field && item.wire === WT_LEN)
  return hit?.bytes ? hit.bytes.toString('utf8') : ''
}

function encodeValue(value: unknown): Buffer {
  if (value === null || value === undefined) return fieldVarint(1, 0)
  if (typeof value === 'number') {
    const body = Buffer.alloc(8)
    body.writeDoubleLE(Number.isFinite(value) ? value : 0)
    return Buffer.concat([tag(2, WT_FIXED64), body])
  }
  if (typeof value === 'string') return fieldString(3, value)
  if (typeof value === 'boolean') return fieldVarint(4, value ? 1 : 0)
  if (Array.isArray(value)) {
    return fieldMessage(
      6,
      value.map((item) => fieldMessage(1, [encodeValue(item)]))
    )
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) =>
      fieldMessage(1, [fieldString(1, key), fieldMessage(2, [encodeValue(item)])])
    )
    return fieldMessage(5, entries)
  }
  return fieldString(3, String(value))
}

export function decodeProtobufValue(buf: Buffer): unknown {
  for (const field of decodeFields(buf)) {
    if (field.field === 1) return null
    if (field.field === 2 && field.bytes && field.bytes.length >= 8) return field.bytes.readDoubleLE(0)
    if (field.field === 3 && field.bytes) return field.bytes.toString('utf8')
    if (field.field === 4) return field.varint === 1n
    if (field.field === 5 && field.bytes) {
      const object: Record<string, unknown> = {}
      for (const entry of decodeFields(field.bytes)) {
        if (entry.field !== 1 || !entry.bytes) continue
        let key = ''
        let item: unknown = undefined
        for (const part of decodeFields(entry.bytes)) {
          if (part.field === 1 && part.bytes) key = part.bytes.toString('utf8')
          if (part.field === 2 && part.bytes) item = decodeProtobufValue(part.bytes)
        }
        if (key) object[key] = item
      }
      return object
    }
    if (field.field === 6 && field.bytes) {
      return decodeFields(field.bytes)
        .filter((item) => item.field === 1 && item.bytes)
        .map((item) => decodeProtobufValue(item.bytes as Buffer))
    }
  }
  return undefined
}

function schemaBytes(schema: unknown): Buffer {
  const plain = JSON.parse(JSON.stringify(schema ?? { type: 'object', properties: {} })) as unknown
  return encodeValue(plain)
}

function toolBody(tool: CursorToolDef): Buffer {
  // 不写 provider_identifier。写了「uebox」之后，模型会把它当成还要再发现一次的
  // MCP 命名空间，先去 GetDynamicTools，参数是空的，任务就停在那里。
  return Buffer.concat([
    fieldString(1, tool.name),
    fieldString(2, tool.description),
    fieldBytes(3, schemaBytes(tool.schema)),
    fieldString(5, tool.name)
  ])
}

function parameterField(id: string, value: string): Buffer {
  return fieldMessage(3, [fieldString(1, id), fieldString(2, value)])
}

function requestedModelFields(
  modelId: string,
  parameters: Array<{ id: string; value: string }>,
  maxMode: boolean
): Buffer[] {
  const fast = parameters.some((item) => item.id === 'fast' && item.value === 'true')
  const extras = parameters.filter((item) => item.id !== 'fast')
  return [
    fieldString(1, modelId),
    ...(maxMode ? [fieldVarint(2, 1)] : []),
    parameterField('fast', fast ? 'true' : 'false'),
    ...extras.map((item) => parameterField(item.id, item.value))
  ]
}

/**
 * `auto` 在线上叫 `default`。Composer 的快速档是模型 id 去掉 `-fast`，
 * 再带一个 `fast=true` 参数；界面上的 Fast 开关走同一参数。Effort 走 `reasoning_effort`。
 */
export function resolveCursorModel(input: string | CursorModelResolveInput): CursorModelResolved {
  const opts = typeof input === 'string' ? { modelId: input } : input
  let id = opts.modelId.trim()
  if (id === '' || id === 'auto') return { modelId: 'default', parameters: [], maxMode: false }

  let fast = opts.fast === true
  if (id.startsWith('composer-') && id.endsWith('-fast')) {
    id = id.slice(0, -'-fast'.length)
    fast = true
  }

  const parameters: Array<{ id: string; value: string }> = []
  if (fast) parameters.push({ id: 'fast', value: 'true' })
  const effort = opts.effort?.trim()
  if (effort) parameters.push({ id: 'reasoning_effort', value: effort })
  const context = opts.context?.trim()
  let maxMode = false
  if (context) {
    parameters.push({ id: 'context', value: context })
    maxMode = cursorMaxModeForContext(context)
  }
  return { modelId: id, parameters, maxMode }
}

/** AgentClientMessage { run_request }，还没套 Connect 帧 */
export function encodeRunRequest(input: CursorRunInput): Buffer {
  const resolved = resolveCursorModel({
    modelId: input.modelId,
    fast: input.fast,
    effort: input.effort,
    context: input.context
  })
  const imageParts = (input.images ?? []).map((image) =>
    fieldMessage(1, [
      fieldString(2, image.uuid),
      fieldString(7, image.mimeType),
      fieldBytes(8, image.data)
    ])
  )
  const system = input.systemPrompt?.trim()
  const userText = system ? `${system}\n\n${input.userText}` : input.userText
  const userMessage = fieldMessage(1, [
    fieldString(1, userText),
    fieldString(2, input.messageId),
    imageParts.length > 0 ? fieldMessage(3, imageParts) : fieldString(3, ''),
    fieldVarint(4, 1)
  ])
  const action = fieldMessage(2, [fieldMessage(1, [userMessage])])

  const modelDetails = fieldMessage(3, [
    fieldString(1, resolved.modelId),
    fieldString(3, resolved.modelId),
    fieldString(4, resolved.modelId)
  ])
  const tools = fieldMessage(
    4,
    input.tools.map((tool) => fieldMessage(1, [toolBody(tool)]))
  )
  const modelMeta = fieldMessage(
    9,
    requestedModelFields(resolved.modelId, resolved.parameters, resolved.maxMode)
  )

  return fieldMessage(1, [
    // 空的 conversation_state。系统提示词由调用方折进用户文本。
    // 塞 blob 会多一轮 KV，而当前线上客户端发的就是空串。
    fieldString(1, ''),
    action,
    modelDetails,
    tools,
    fieldString(5, input.conversationId),
    modelMeta,
    // 1 会被拒：「workspace context exclusion is not allowed」。
    fieldVarint(12, 0),
    fieldMessage(14, [fieldString(1, 'default')]),
    fieldMessage(14, [fieldString(1, resolved.modelId)]),
    fieldString(16, input.conversationId)
  ])
}

/**
 * 一轮运行要按顺序写多帧，写完不能马上半关闭。
 *
 * 只发 RunRequest 再关掉，服务端回 `No exec result`，对话是空的。
 * 帧序与能跑通的 CLI 一致：RunRequest、环境、然后一组占位帧。
 */
export function encodeRunFrames(input: CursorRunInput, cwd: string): Buffer[] {
  const env = Buffer.concat([
    fieldString(1, 'linux'),
    fieldString(2, cwd),
    fieldString(3, 'bash'),
    fieldString(10, 'UTC'),
    fieldString(11, cwd),
    fieldVarint(14, 1),
    fieldVarint(16, 1),
    fieldVarint(19, 0),
    fieldVarint(20, 0),
    fieldString(21, cwd),
    fieldVarint(22, 0)
  ])
  const context = fieldMessage(2, [
    fieldMessage(10, [fieldMessage(1, [fieldMessage(1, [fieldMessage(4, [env])])])])
  ])
  const markers: Buffer[] = [
    fieldMessage(5, [fieldString(1, '')]),
    fieldMessage(3, [fieldString(3, '')])
  ]
  for (let n = 1; n <= 8; n += 1) {
    markers.push(fieldMessage(3, [fieldVarint(1, n), fieldString(3, '')]))
  }
  return [encodeRunRequest(input), context, ...markers]
}

/** 保活。停掉的话服务端会把还开着的工具调用连接掐掉 */
export function encodeHeartbeat(): Buffer {
  return fieldMessage(7, [])
}

/**
 * 上下文确认必须是空的。
 *
 * 工具已经在 RunRequest.mcp_tools 里。确认帧再带一遍，服务端会一直心跳、
 * 不再出字。notes_session_id 也不是 exec_id，不要回写。
 */
export function encodeRequestContext(id: number, execId: string): Buffer {
  const success = fieldMessage(1, [fieldMessage(1, [])])
  const parts: Buffer[] = []
  if (id) parts.push(fieldVarint(1, id))
  if (execId) parts.push(fieldString(15, execId))
  parts.push(fieldMessage(10, [success]))
  return fieldMessage(2, parts)
}

/** 把工具结果写回还开着的那条运行。id / execId 必须是服务端这次调用带下来的 */
export function encodeMcpResult(id: number, execId: string, content: string, isError: boolean): Buffer {
  const textItem = fieldMessage(1, [fieldString(1, content)])
  const successParts = [fieldMessage(1, [textItem])]
  if (isError) successParts.push(fieldVarint(2, 1))
  return fieldMessage(2, [
    fieldVarint(1, id),
    fieldString(15, execId),
    fieldMessage(11, [fieldMessage(1, successParts)])
  ])
}

const NATIVE_REASON = 'This built-in tool is unavailable. Call one of the declared session tools.'

export function encodeBuiltinRejection(call: CursorBuiltinCall): Buffer {
  const rejected = fieldMessage(2, [fieldString(1, call.detail), fieldString(2, NATIVE_REASON)])
  return fieldMessage(2, [
    fieldVarint(1, call.id),
    fieldString(15, call.execId),
    fieldMessage(call.variant, [rejected])
  ])
}

export function encodeKvGetResult(event: CursorKvGet, data: Buffer): Buffer {
  const parts = [fieldVarint(1, event.id), fieldMessage(2, [fieldBytes(1, data)])]
  if (event.metadata && event.metadata.length > 0) parts.push(fieldBytes(4, event.metadata))
  return fieldMessage(3, parts)
}

export function encodeKvSetResult(event: CursorKvSet): Buffer {
  const parts = [fieldVarint(1, event.id), fieldMessage(3, [])]
  if (event.metadata && event.metadata.length > 0) parts.push(fieldBytes(4, event.metadata))
  return fieldMessage(3, parts)
}

function varintOf(fields: ProtoField[], field: number): number {
  const hit = fields.find((item) => item.field === field && item.wire === WT_VARINT)
  return hit?.varint === undefined ? 0 : Number(hit.varint)
}

function bytesOf(fields: ProtoField[], field: number): Buffer | null {
  const hit = fields.find((item) => item.field === field && item.wire === WT_LEN)
  return hit?.bytes ?? null
}

function decodeMcp(buf: Buffer): Pick<CursorMcpCall, 'name' | 'toolCallId' | 'args'> {
  let name = ''
  let toolCallId = ''
  const args: Record<string, unknown> = {}
  for (const field of decodeFields(buf)) {
    if (!field.bytes) continue
    if (field.field === 5) name = field.bytes.toString('utf8')
    else if (field.field === 1 && !name) name = field.bytes.toString('utf8')
    else if (field.field === 3) toolCallId = field.bytes.toString('utf8')
    else if (field.field === 2) {
      let key = ''
      let value: unknown = undefined
      for (const entry of decodeFields(field.bytes)) {
        if (entry.field === 1 && entry.bytes) key = entry.bytes.toString('utf8')
        if (entry.field === 2 && entry.bytes) {
          const decoded = decodeProtobufValue(entry.bytes)
          value = decoded === undefined ? entry.bytes.toString('utf8') : decoded
        }
      }
      if (key) args[key] = value
    }
  }
  return { name, toolCallId: toolCallId || randomUUID(), args }
}

const BUILTIN_VARIANTS = new Set([2, 3, 4, 5, 7, 8, 9, 14, 16, 20, 23])

function decodeExec(buf: Buffer): CursorExec | null {
  const fields = decodeFields(buf)
  const id = varintOf(fields, 1)
  const execId = bytesOf(fields, 15)?.toString('utf8') ?? ''
  const variant = fields.find(
    (item) => item.wire === WT_LEN && item.field !== 15 && item.bytes
  )
  if (!variant?.bytes) return null
  if (variant.field === 10) return { kind: 'request_context', id, execId }
  if (variant.field === 11) {
    return { kind: 'mcp', id, execId, ...decodeMcp(variant.bytes) }
  }
  if (BUILTIN_VARIANTS.has(variant.field)) {
    return {
      kind: 'builtin',
      id,
      execId,
      variant: variant.field,
      detail: stringField(variant.bytes, 1)
    }
  }
  return null
}

function decodeKv(buf: Buffer): CursorKv | null {
  const fields = decodeFields(buf)
  const id = varintOf(fields, 1)
  const metadata = bytesOf(fields, 4)
  const getArgs = bytesOf(fields, 2)
  if (getArgs) {
    return { kind: 'get', id, blobId: bytesOf(decodeFields(getArgs), 1) ?? Buffer.alloc(0), metadata }
  }
  if (bytesOf(fields, 3)) return { kind: 'set', id, metadata }
  return null
}

function decodeUpdate(field: number, bytes: Buffer | undefined): CursorDelta | null {
  if (field === 1 && bytes) return { kind: 'text', text: stringField(bytes, 1) }
  if (field === 4 && bytes) return { kind: 'thinking', text: stringField(bytes, 1) }
  if (field === 5) return { kind: 'thinking_done' }
  if (field === 8 && bytes) {
    const tokens = decodeFields(bytes).find((item) => item.field === 1 && item.wire === WT_VARINT)
    return { kind: 'token', tokens: tokens?.varint === undefined ? 0 : Number(tokens.varint) }
  }
  if (field === 13) return { kind: 'heartbeat' }
  if (field === 14) return { kind: 'turn_ended' }
  return null
}

/**
 * 从交互更新里取出工具名和调用 id。
 *
 * 工具名在 `.44.1.2`，调用 id 在 field 3。参数若是一段 JSON 对象就收下。
 */
export function extractToolCall(buf: Buffer): DecodedToolCall | null {
  let name = ''
  let id = ''
  const args: Record<string, unknown> = {}
  const walk = (inner: Buffer, path: string): void => {
    for (const field of decodeFields(inner)) {
      if (field.wire !== 2 || !field.bytes) continue
      const text = field.bytes.toString('utf8')
      const here = `${path}.${field.field}`
      if (/^[\x20-\x7e]+$/.test(text)) {
        if (path.endsWith('.44.1') && field.field === 2 && text) name = text
        if (field.field === 3 && text.length > 8) id = text
        if (text.startsWith('{') && text.endsWith('}')) {
          try {
            const parsed = JSON.parse(text) as unknown
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
              Object.assign(args, parsed)
            }
          } catch {
            // 不是参数 JSON
          }
        }
      } else {
        walk(field.bytes, here)
      }
    }
  }
  walk(buf, 'u')
  if (!name) return null
  return { name, id: id || randomUUID(), args }
}

/** 一帧 AgentServerMessage。控制消息和文本增量可以出现在同一帧里 */
export function decodeServerFrame(payload: Buffer): DecodedServerFrame {
  const deltas: CursorDelta[] = []
  let exec: CursorExec | null = null
  let kv: CursorKv | null = null
  let toolCall: DecodedToolCall | null = null
  for (const top of decodeFields(payload)) {
    if (!top.bytes) continue
    if (top.field === 1) {
      for (const update of decodeFields(top.bytes)) {
        if (update.field === 2 && update.bytes) toolCall = extractToolCall(update.bytes) ?? toolCall
        const delta = decodeUpdate(update.field, update.bytes)
        if (!delta) continue
        if ((delta.kind === 'text' || delta.kind === 'thinking') && delta.text.length === 0) continue
        deltas.push(delta)
      }
    } else if (top.field === 2) {
      exec = decodeExec(top.bytes)
    } else if (top.field === 4) {
      kv = decodeKv(top.bytes)
    }
  }
  return { deltas, exec, kv, toolCall }
}
