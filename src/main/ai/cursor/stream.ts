import { randomUUID } from 'crypto'
import { existsSync, readdirSync } from 'fs'
import type { ClientHttp2Stream } from 'http2'
import { homedir } from 'os'
import { join } from 'path'
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type AssistantMessageEventStream,
  type Model,
  type SimpleStreamOptions,
  type StopReason,
  type TextContent,
  type ThinkingContent,
  type ToolCall,
  type TranscriptContext
} from '@earendil-works/pi-ai'

import { cursorWireContext, cursorWireEffort } from './modelOptions'
import { renderCursorPrompt, trailingToolResults, type ToolFollowUp } from './prompt'
import { openCursorSession } from './transport'
import {
  connectEndError,
  decodeServerFrame,
  encodeBuiltinRejection,
  encodeHeartbeat,
  encodeKvGetResult,
  encodeKvSetResult,
  encodeMcpResult,
  encodeRequestContext,
  encodeRunFrames,
  frameConnect,
  isConnectEnd,
  splitConnectFrames,
  type CursorDelta,
  type CursorExec,
  type CursorKv,
  type CursorMcpCall,
  type CursorToolDef
} from './wire'

/**
 * Cursor 订阅的对话传输。
 *
 * 文本和思考按增量交给 pi，界面上的思考块走的就是 thinking_* 事件。
 * 模型要调工具时，把声明过的工具收成 toolCall 交给现有的任务循环去执行，
 * 不在这条流里自己跑命令。Cursor 自带的读文件和 shell 直接拒绝，
 * 避免绕过虚幻盒子的审批。
 */

/** 对话在这个主机。`api2.cursor.sh` 只负责登录和续期，拿去跑 AgentService 会空转 */
export const CURSOR_AGENT_URL = 'https://agentn.global.api5.cursor.sh'
/** 本机没有 CLI 时用的版本。装了 cursor-agent 就用它的目录名 */
export const CURSOR_CLIENT_VERSION_FALLBACK = 'cli-2026.11.05-86047df'

const VERSION_DIR = /^\d{4}\.\d{2}\.\d{2}-[0-9a-f]+$/

export function versionFromNames(names: readonly string[]): string {
  const matched = names.filter((name) => VERSION_DIR.test(name)).sort()
  const latest = matched[matched.length - 1]
  return latest ? `cli-${latest}` : CURSOR_CLIENT_VERSION_FALLBACK
}

export function cursorClientVersion(): string {
  const roots = [
    process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'cursor-agent', 'versions') : '',
    join(homedir(), '.local', 'share', 'cursor-agent', 'versions')
  ].filter(Boolean)
  const names: string[] = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    try {
      names.push(...readdirSync(root))
    } catch {
      // 读不到版本目录就用兜底，不让对话因此起不来
    }
  }
  return versionFromNames(names)
}

/** 已经存下来的旧配置还指着 api2。对话一律改去 agent 主机 */
export function cursorRunBase(baseUrl: string | undefined): string {
  if (baseUrl && baseUrl.includes('agentn.')) return baseUrl.replace(/\/+$/, '')
  return CURSOR_AGENT_URL
}
const RUN_PATH = '/agent.v1.AgentService/Run'
const TOOL_QUIET_MS = 400

interface Block {
  index: number
}

export interface CursorTurnState {
  output: AssistantMessage
  text: (TextContent & Block) | null
  thinking: (ThinkingContent & Block) | null
  tools: ToolCall[]
  sawTurnEnd: boolean
}

export function createTurnState(model: Model<string>): CursorTurnState {
  return {
    output: {
      role: 'assistant',
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 }
      },
      stopReason: 'stop',
      timestamp: Date.now()
    },
    text: null,
    thinking: null,
    tools: [],
    sawTurnEnd: false
  }
}

function closeText(state: CursorTurnState, stream: AssistantMessageEventStream): void {
  if (!state.text) return
  const index = state.text.index
  const content = state.text.text
  delete (state.text as { index?: number }).index
  state.text = null
  stream.push({ type: 'text_end', contentIndex: index, content, partial: state.output })
}

function closeThinking(state: CursorTurnState, stream: AssistantMessageEventStream): void {
  if (!state.thinking) return
  const index = state.thinking.index
  const content = state.thinking.thinking
  delete (state.thinking as { index?: number }).index
  state.thinking = null
  stream.push({ type: 'thinking_end', contentIndex: index, content, partial: state.output })
}

/** 把一条增量写进 pi 的事件流。思考和正文分块，不会混在一起 */
export function applyCursorDelta(
  state: CursorTurnState,
  stream: AssistantMessageEventStream,
  delta: CursorDelta
): void {
  if (delta.kind === 'turn_ended') {
    state.sawTurnEnd = true
    return
  }
  if (delta.kind === 'token') {
    state.output.usage.output += delta.tokens
    state.output.usage.totalTokens = state.output.usage.input + state.output.usage.output
    return
  }
  if (delta.kind === 'heartbeat' || delta.kind === 'thinking_done') {
    if (delta.kind === 'thinking_done') closeThinking(state, stream)
    return
  }
  if (delta.kind === 'thinking') {
    closeText(state, stream)
    if (!state.thinking) {
      const block: ThinkingContent & Block = {
        type: 'thinking',
        thinking: '',
        index: state.output.content.length
      }
      state.output.content.push(block)
      state.thinking = block
      stream.push({
        type: 'thinking_start',
        contentIndex: block.index,
        partial: state.output
      })
    }
    state.thinking.thinking += delta.text
    stream.push({
      type: 'thinking_delta',
      contentIndex: state.thinking.index,
      delta: delta.text,
      partial: state.output
    })
    return
  }
  closeThinking(state, stream)
  if (!state.text) {
    const block: TextContent & Block = {
      type: 'text',
      text: '',
      index: state.output.content.length
    }
    state.output.content.push(block)
    state.text = block
    stream.push({ type: 'text_start', contentIndex: block.index, partial: state.output })
  }
  state.text.text += delta.text
  stream.push({
    type: 'text_delta',
    contentIndex: state.text.index,
    delta: delta.text,
    partial: state.output
  })
}

export function applyMcpCall(
  state: CursorTurnState,
  stream: AssistantMessageEventStream,
  call: CursorMcpCall
): void {
  closeText(state, stream)
  closeThinking(state, stream)
  const args = jsonObject(call.args)
  const toolCall: ToolCall = {
    type: 'toolCall',
    id: call.toolCallId,
    name: call.name,
    arguments: args
  }
  const index = state.output.content.length
  state.output.content.push(toolCall)
  state.tools.push(toolCall)
  stream.push({ type: 'toolcall_start', contentIndex: index, partial: state.output })
  const encoded = JSON.stringify(args)
  stream.push({ type: 'toolcall_delta', contentIndex: index, delta: encoded, partial: state.output })
  stream.push({ type: 'toolcall_end', contentIndex: index, toolCall, partial: state.output })
}

function jsonObject(value: Record<string, unknown>): ToolCall['arguments'] {
  const object: ToolCall['arguments'] = {}
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    object[key] = item as ToolCall['arguments'][string]
  }
  return object
}

function finishTurn(state: CursorTurnState, stream: AssistantMessageEventStream): void {
  closeText(state, stream)
  closeThinking(state, stream)
  if (state.output.content.length === 0) {
    failTurn(state, stream, 'error', 'Cursor 没有返回内容')
    return
  }
  const reason: Extract<StopReason, 'stop' | 'toolUse'> = state.tools.length > 0 ? 'toolUse' : 'stop'
  state.output.stopReason = reason
  state.output.usage.totalTokens = state.output.usage.input + state.output.usage.output
  stream.push({ type: 'done', reason, message: state.output })
  stream.end()
}

function failTurn(
  state: CursorTurnState,
  stream: AssistantMessageEventStream,
  reason: Extract<StopReason, 'aborted' | 'error'>,
  message: string
): void {
  state.output.stopReason = reason
  state.output.errorMessage = message
  stream.push({ type: 'error', reason, error: state.output })
  stream.end()
}

export function parkKey(ids: readonly string[]): string {
  return [...ids].filter(Boolean).sort().join('\n')
}

const PARK_MS = 10 * 60 * 1000

interface LiveSink {
  state: CursorTurnState
  stream: AssistantMessageEventStream
  paused: boolean
  buffer: Buffer[]
  piDone: boolean
  calls: CursorMcpCall[]
}

interface ParkedRun {
  at: number
  calls: CursorMcpCall[]
  continueWith: (
    results: ToolFollowUp[],
    stream: AssistantMessageEventStream,
    state: CursorTurnState,
    signal?: AbortSignal
  ) => void
  close: () => void
}

const parkedRuns = new Map<string, ParkedRun>()

function sweepParked(): void {
  const now = Date.now()
  for (const [key, run] of parkedRuns) {
    if (now - run.at <= PARK_MS) continue
    parkedRuns.delete(key)
    run.close()
  }
}

export function streamCursor(
  model: Model<string>,
  context: TranscriptContext,
  options?: SimpleStreamOptions
): AssistantMessageEventStream {
  const stream = createAssistantMessageEventStream()
  const state = createTurnState(model)
  sweepParked()
  const followUp = trailingToolResults(context.messages)
  const key = followUp ? parkKey(followUp.map((item) => item.id)) : ''
  const parked = key ? parkedRuns.get(key) : undefined
  if (parked && followUp) {
    parkedRuns.delete(key)
    parked.continueWith(followUp, stream, state, options?.signal)
    return stream
  }
  void runTurn(model, context, options, stream, state)
  return stream
}

export function cursorAgentApi(): {
  stream: typeof streamCursor
  streamSimple: typeof streamCursor
} {
  return { stream: streamCursor, streamSimple: streamCursor }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      resolve()
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

async function runTurn(
  model: Model<string>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  stream: AssistantMessageEventStream,
  state: CursorTurnState
): Promise<void> {
  let request: ClientHttp2Stream | null = null
  let quiet: ReturnType<typeof setTimeout> | undefined
  let idle: ReturnType<typeof setTimeout> | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let transportClosed = false
  let holding = false

  const sink: LiveSink = {
    state,
    stream,
    paused: false,
    buffer: [],
    piDone: false,
    calls: []
  }

  let closeTransport = (): void => {
    if (transportClosed) return
    transportClosed = true
    if (quiet) clearTimeout(quiet)
    if (idle) clearTimeout(idle)
    if (heartbeat) clearInterval(heartbeat)
    request?.close()
  }

  const finishPi = (error?: Error): void => {
    if (sink.piDone) return
    sink.piDone = true
    if (quiet) clearTimeout(quiet)
    if (idle) clearTimeout(idle)
    if (error) {
      const reason = options?.signal?.aborted ? 'aborted' : 'error'
      failTurn(sink.state, sink.stream, reason, error.message)
    } else {
      finishTurn(sink.state, sink.stream)
    }
  }

  const failAndClose = (error: Error): void => {
    finishPi(error)
    closeTransport()
  }

  try {
    const apiKey = options?.apiKey
    if (!apiKey) throw new Error('尚未登录 Cursor。请在模型设置里用 Cursor 账号登录。')

    const prompt = renderCursorPrompt(context.messages)
    if (!prompt.userText.trim() && prompt.images.length === 0) {
      throw new Error('没有可发送的内容')
    }
    const levelMap = model.thinkingLevelMap as Record<string, string | null> | undefined
    const effort = cursorWireEffort(
      options?.reasoning as string | undefined,
      levelMap
    )
    const sampling = options?.samplingParams as {
      cursorFast?: boolean
      cursorContext?: string
    } | undefined
    const blobStore = new Map<string, Buffer>()
    const conversationId = randomUUID()
    const frames = encodeRunFrames(
      {
        modelId: model.id,
        userText: prompt.userText,
        systemPrompt: prompt.systemPrompt,
        conversationId,
        messageId: randomUUID(),
        tools: prompt.tools,
        images: prompt.images,
        blobStore,
        fast: sampling?.cursorFast === true,
        effort,
        context: cursorWireContext(sampling?.cursorContext)
      },
      homedir()
    )

    stream.push({ type: 'start', partial: sink.state.output })
    const client = await openCursorSession(cursorRunBase(model.baseUrl))
    const write = (payload: Uint8Array): void => {
      if (!request || request.closed || transportClosed) return
      request.write(frameConnect(payload))
    }
    const closeSession = closeTransport
    closeTransport = () => {
      closeSession()
      client.close()
    }

    const park = (): void => {
      if (sink.piDone || sink.calls.length === 0 || transportClosed) return
      holding = true
      const key = parkKey(sink.calls.map((call) => call.toolCallId))
      const calls = sink.calls.slice()
      sink.paused = true
      parkedRuns.set(key, {
        at: Date.now(),
        calls,
        close: () => closeTransport(),
        continueWith: (results, nextStream, nextState, signal) => {
          if (transportClosed || request?.closed) {
            failTurn(nextState, nextStream, 'error', 'Cursor 连接已断开，请再发一次')
            return
          }
          sink.state = nextState
          sink.stream = nextStream
          sink.piDone = false
          sink.calls = []
          nextStream.push({ type: 'start', partial: nextState.output })
          sink.paused = false
          const buffered = sink.buffer.splice(0)
          for (const chunk of buffered) handleData(chunk)
          if (sink.piDone || transportClosed) return
          for (const call of calls) {
            const result = results.find((item) => item.id === call.toolCallId)
            write(
              encodeMcpResult(
                call.id,
                call.execId,
                result?.text ?? '工具没有返回结果',
                result?.isError ?? !result
              )
            )
          }
          signal?.addEventListener('abort', () => failAndClose(new Error('已取消')), { once: true })
        }
      })
      finishPi()
    }

    const armIdle = (): void => {
      if (idle) clearTimeout(idle)
      idle = setTimeout(() => {
        if (sink.piDone || transportClosed) return
        if (sink.calls.length > 0) park()
        else finishPi()
        if (!holding) closeTransport()
      }, 8000)
    }

    const armQuiet = (): void => {
      if (quiet) clearTimeout(quiet)
      quiet = setTimeout(() => {
        if (sink.piDone) return
        if (sink.calls.length > 0) park()
      }, TOOL_QUIET_MS)
    }

    let pending = Buffer.alloc(0)
    const handleData = (chunk: Buffer): void => {
      if (transportClosed) return
      if (sink.paused) {
        sink.buffer.push(chunk)
        return
      }
      pending = Buffer.concat([pending, chunk])
      const split = splitConnectFrames(pending)
      pending = Buffer.from(split.rest)
      for (const frame of split.frames) {
        if (isConnectEnd(frame.flags)) {
          const message = connectEndError(frame.payload)
          if (message) failAndClose(new Error(message))
          else if (sink.calls.length > 0) park()
          else finishPi()
          if (!sink.calls.length) closeTransport()
          return
        }
        let decoded: ReturnType<typeof decodeServerFrame>
        try {
          decoded = decodeServerFrame(frame.payload)
        } catch {
          continue
        }
        if (decoded.toolCall) {
          const call: CursorMcpCall = {
            kind: 'mcp',
            id: 0,
            execId: '',
            name: decoded.toolCall.name,
            toolCallId: decoded.toolCall.id,
            args: decoded.toolCall.args
          }
          sink.calls.push(call)
          applyMcpCall(sink.state, sink.stream, call)
          if (idle) clearTimeout(idle)
          armQuiet()
        }
        for (const delta of decoded.deltas) {
          applyCursorDelta(sink.state, sink.stream, delta)
          if (delta.kind === 'text' || delta.kind === 'thinking' || delta.kind === 'thinking_done') {
            armIdle()
          }
        }
        if (decoded.kv) write(replyKv(decoded.kv, blobStore))
        if (decoded.exec) {
          if (decoded.exec.kind === 'mcp' && decoded.exec.name) sink.calls.push(decoded.exec)
          const reply = replyExec(decoded.exec, prompt.tools, sink.state, sink.stream)
          if (reply) write(reply)
          if (decoded.exec.kind === 'mcp' && decoded.exec.name) armQuiet()
        }
        if (sink.state.sawTurnEnd) {
          if (sink.calls.length > 0) park()
          else {
            finishPi()
            closeTransport()
          }
        }
      }
    }

    request = client.request(RUN_PATH, {
      'content-type': 'application/connect+proto',
      'connect-protocol-version': '1',
      'connect-accept-encoding': 'gzip',
      'user-agent': 'connect-es/1.6.1',
      authorization: `Bearer ${apiKey}`,
      'x-ghost-mode': 'true',
      'x-cursor-client-version': cursorClientVersion(),
      'x-cursor-client-type': 'cli',
      'x-request-id': conversationId,
      'x-original-request-id': conversationId
    })

    request.on('data', handleData)
    request.on('response', (headers) => {
      const status = Number(headers[':status'] ?? 0)
      if (status && status !== 200) failAndClose(new Error(`Cursor 接口 HTTP ${status}`))
    })
    request.on('trailers', (trailers) => {
      const status = trailers['grpc-status']
      if (status && status !== '0') {
        const message = decodeURIComponent(String(trailers['grpc-message'] || ''))
        failAndClose(new Error(message || `Cursor 接口错误（${status}）`))
      }
    })
    request.on('end', () => {
      transportClosed = true
      if (!sink.piDone) {
        finishPi(holding ? new Error('Cursor 连接在工具返回前断开了') : undefined)
      }
      if (heartbeat) clearInterval(heartbeat)
      client.close()
    })
    request.on('error', (error) =>
      failAndClose(error instanceof Error ? error : new Error(String(error)))
    )
    options?.signal?.addEventListener('abort', () => failAndClose(new Error('已取消')), {
      once: true
    })

    write(frames[0])
    heartbeat = setInterval(() => write(encodeHeartbeat()), 5000)
    for (let index = 1; index < frames.length; index += 1) {
      const wait = index === 1 ? 1500 : index === 2 ? 800 : 400
      await delay(wait, options?.signal)
      if (transportClosed) return
      write(frames[index])
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const reason = options?.signal?.aborted ? 'aborted' : 'error'
    if (!sink.piDone) failTurn(sink.state, sink.stream, reason, message)
    closeTransport()
  }
}

function replyKv(event: CursorKv, blobStore: Map<string, Buffer>): Buffer {
  if (event.kind === 'set') return frameMessage(encodeKvSetResult(event))
  const data = blobStore.get(event.blobId.toString('hex')) ?? Buffer.alloc(0)
  return frameMessage(encodeKvGetResult(event, data))
}

function frameMessage(payload: Buffer): Buffer {
  return payload
}

function replyExec(
  exec: CursorExec,
  _tools: CursorToolDef[],
  state: CursorTurnState,
  stream: AssistantMessageEventStream
): Buffer | null {
  if (exec.kind === 'request_context') return encodeRequestContext(exec.id, exec.execId)
  if (exec.kind === 'builtin') return encodeBuiltinRejection(exec)
  if (!exec.name) return null
  applyMcpCall(state, stream, exec)
  return null
}
