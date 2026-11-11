/**
 * 模型请求的自适应调度：按网关的实际反应决定同时放几个请求出去。
 *
 * ## 为什么要有它
 *
 * 真机塔防题：三个队员并行，各自一个六七万 token 的请求同时打到小米 MiMo Token Plan，
 * 网关不回 429，而是把三个请求挂住，5 分钟后一起断开（`ERR_CONNECTION_CLOSED`）。
 * 编程套餐普遍按账号限并发，数字不公布、还随负载变（社区实测 3 路就可能被限，
 * 有时 9 路才限）—— 写死一个上限，不是浪费就是撞墙。
 *
 * 所以不猜，量：把网关当成一条会拥塞的链路，用 TCP 拥塞控制那一套（AIMD）。
 *
 * - **加性增**：请求顺利、首包时间正常，名额慢慢涨（每成功一次 +1/名额数，
 *   约等于「每一轮全部成功就 +1」）。
 * - **乘性减**：出现过载信号 —— 429 / 5xx、连接被掐、长时间没有首包 —— 名额砍半，
 *   并且整体冷却一小段（指数退避），给网关喘口气。
 * - **延迟梯度**：首包时间明显高于这家网关的基线（近期最小值的 3 倍）时，
 *   说明它在排队了，还没报错也先轻轻收一点（×0.9）。思路同 Netflix
 *   concurrency-limits 的 Gradient 算法：拿延迟当拥塞的早期信号。
 *
 * 请求级调度而不是按队员限人数：队员在编辑器里干活、等工具的时候不占名额，
 * 只有真正在等模型回话的那一刻才算。
 *
 * ## 卡死检测
 *
 * 那一次的 5 分钟全是白等：请求发出去就没有回音。这里给首包和包间隔各设一个超时，
 * 到点就当过载处理 —— 放弃这一次、退避后重发。只在**还没往下游推过任何内容**时重发，
 * 推过半截再重来会让调用方看到重复的开头。
 *
 * 工作室模式（`SessionContext.pacedRequests`）用整套：名额 + 卡死检测 + 重发。
 * 普通会话只用卡死检测和重发（`stallGuardStreamFn`），不排队 —— 见那里的注释。
 */

import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type TranscriptContext,
  type Model
} from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'

import { CODEBUDDY_ORIGIN } from '../../../ai/codebuddy'
import { isPlanUpstreamUnavailable } from '../../../../shared/creatorPlan'
import { classifyProviderError } from '../../host/providerError'

export interface GateConfig {
  initialLimit: number
  minLimit: number
  maxLimit: number
  /** 基线还没量出来时，等首包最多多久 */
  firstEventTimeoutMs: number
  /** 首包超时的上下限：量出基线后取「基线 × 6」夹在这两者之间 */
  firstEventTimeoutFloorMs: number
  firstEventTimeoutCeilMs: number
  /** 开始推内容之后，两个事件之间最多隔多久 */
  idleTimeoutMs: number
  /** 过载时最多重发几次 */
  maxRetries: number
  /** 退避：第 n 次连续过载冷却 min(cap, base × 2^n)，再乘一个 [0.5, 1) 的抖动 */
  backoffBaseMs: number
  backoffCapMs: number
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  initialLimit: 4,
  minLimit: 1,
  maxLimit: 16,
  firstEventTimeoutMs: 120_000,
  firstEventTimeoutFloorMs: 60_000,
  firstEventTimeoutCeilMs: 180_000,
  idleTimeoutMs: 180_000,
  maxRetries: 4,
  backoffBaseMs: 2_000,
  backoffCapMs: 30_000
}

/**
 * 普通会话的配置：不排队，只防「发出去就没回音」。
 *
 * - 名额钉死在一个用不满的数上：一个人一条会话，排队只会平白加延迟。
 * - 首包超时和工作室一样。pi 在**收到响应头**时就推 `start`，所以这里等的是
 *   「网关接没接这个请求」—— 真机那次 5 分钟白等就是卡在这一步。
 * - 包间隔放宽到 10 分钟：推理模型在 `start` 之后可能好几分钟一个字不吐
 *   （有的接口不流式吐思考），按工作室的 3 分钟掐会把正常的长思考当成卡死。
 *   这一段超时本来也不重发（推过内容了），掐了只是把白等换成报错。
 * - 少重发两次：有人在屏幕前等着，失败要早点说出来。
 */
export const STALL_GUARD_CONFIG: GateConfig = {
  ...DEFAULT_GATE_CONFIG,
  initialLimit: 64,
  minLimit: 64,
  maxLimit: 64,
  idleTimeoutMs: 600_000,
  maxRetries: 2
}

/** 基线取最近这么多次首包时间里的最小值 */
const BASELINE_WINDOW = 20
/** 至少这么多个样本才开始按延迟梯度收名额 */
const MIN_SAMPLES_FOR_GRADIENT = 5
/** 首包时间超过基线的这个倍数，算网关在排队 */
const LATENCY_TOLERANCE = 3

export type Outcome =
  | { kind: 'ok'; firstEventMs: number }
  | { kind: 'overload' }
  /** 和负载无关的失败（参数错、鉴权错、用户停下）：不动名额 */
  | { kind: 'neutral' }

export interface LimiterSnapshot {
  limit: number
  inFlight: number
  queued: number
  baselineMs: number | null
  coolingDownMs: number
}

/**
 * AIMD 名额。一家网关一个，所有工作室会话共用 —— 套餐的并发是按账号算的。
 */
export class AdaptiveLimiter {
  private limit: number
  private inFlight = 0
  private readonly queue: Array<{ grant: () => void; signal?: AbortSignal }> = []
  private samples: number[] = []
  private consecutiveOverloads = 0
  private coolUntil = 0
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    readonly config: GateConfig = DEFAULT_GATE_CONFIG,
    private readonly now: () => number = Date.now,
    private readonly random: () => number = Math.random
  ) {
    this.limit = config.initialLimit
  }

  snapshot(): LimiterSnapshot {
    return {
      limit: this.limit,
      inFlight: this.inFlight,
      queued: this.queue.length,
      baselineMs: this.baseline(),
      coolingDownMs: Math.max(0, this.coolUntil - this.now())
    }
  }

  /** 这一次该等首包多久：量出基线后按基线放宽，量不出来用默认值 */
  firstEventTimeout(): number {
    const base = this.baseline()
    const c = this.config
    if (base === null) return c.firstEventTimeoutMs
    return Math.min(c.firstEventTimeoutCeilMs, Math.max(c.firstEventTimeoutFloorMs, base * 6))
  }

  /** 拿一个名额。排队中被停下就退出队列，不占名额 */
  acquire(signal?: AbortSignal): Promise<(outcome: Outcome) => void> {
    signal?.throwIfAborted()
    return new Promise((resolve, reject) => {
      const entry = {
        signal,
        grant: (): void => {
          signal?.removeEventListener('abort', onAbort)
          this.inFlight++
          let done = false
          resolve((outcome) => {
            if (done) return
            done = true
            this.inFlight--
            this.record(outcome)
            this.pump()
          })
        }
      }
      const onAbort = (): void => {
        const index = this.queue.indexOf(entry)
        if (index >= 0) this.queue.splice(index, 1)
        reject(signal?.reason ?? new Error('Operation aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.queue.push(entry)
      this.pump()
    })
  }

  private baseline(): number | null {
    return this.samples.length ? Math.min(...this.samples) : null
  }

  private record(outcome: Outcome): void {
    const c = this.config
    if (outcome.kind === 'overload') {
      this.limit = Math.max(c.minLimit, this.limit / 2)
      this.consecutiveOverloads++
      const backoff = Math.min(
        c.backoffCapMs,
        c.backoffBaseMs * 2 ** (this.consecutiveOverloads - 1)
      )
      // 抖动：几个同时被掐的请求别在同一刻一起重来，那正是把网关再次打满的方式
      this.coolUntil = this.now() + backoff * (0.5 + this.random() / 2)
      return
    }
    if (outcome.kind !== 'ok') return

    this.consecutiveOverloads = 0
    const base = this.baseline()
    this.samples.push(outcome.firstEventMs)
    if (this.samples.length > BASELINE_WINDOW) this.samples.shift()
    if (
      base !== null &&
      this.samples.length >= MIN_SAMPLES_FOR_GRADIENT &&
      outcome.firstEventMs > base * LATENCY_TOLERANCE
    ) {
      this.limit = Math.max(c.minLimit, this.limit * 0.9)
      return
    }
    this.limit = Math.min(c.maxLimit, this.limit + 1 / this.limit)
  }

  private pump(): void {
    const wait = this.coolUntil - this.now()
    if (wait > 0) {
      // 冷却中：到点再放。只挂一个定时器
      if (!this.timer && this.queue.length) {
        this.timer = setTimeout(() => {
          this.timer = undefined
          this.pump()
        }, wait)
      }
      return
    }
    while (this.queue.length && this.inFlight < Math.max(1, Math.floor(this.limit))) {
      this.queue.shift()!.grant()
    }
  }
}

// ── 过载判断 ────────────────────────────────────────────────────────────

const OVERLOAD_STATUS = new Set([408, 429, 500, 502, 503, 504, 529])
const OVERLOAD_TEXT =
  /rate.?limit|too many requests|overload|capacity|concurrency|ERR_CONNECTION_(CLOSED|RESET|ABORTED)|ERR_EMPTY_RESPONSE|ERR_TIMED_OUT|ECONNRESET|ETIMEDOUT|socket hang up|timed? ?out|限流|并发|繁忙|过载/i

/** 这个报错是不是「网关扛不住了」。鉴权、参数、上下文超长这类不算 */
export function isOverloadError(errorMessage: string): boolean {
  const { statusCode } = classifyProviderError(errorMessage)
  if (statusCode !== undefined) return OVERLOAD_STATUS.has(statusCode)
  return OVERLOAD_TEXT.test(errorMessage)
}

/**
 * CodeBuddy 偶发的空 400：不带响应体，几秒后原样重发就过。
 *
 * 真机：hy4-preview 一个 573851 字节的请求回 `400 status code (no body)`，
 * 23 秒后同一个请求体再发是 200。400 本该是「请求写错了」，但这家不给响应体，
 * 分不清真错还是上游抽风 —— 那就按过载退避重发几次。真是请求的错，几秒内
 * 照样失败，最后报原文（不报「扛不住」，免得持续续跑把它当中转不稳再转半小时）。
 */
const BODYLESS_400 = /^\s*400 status code \(no body\)/i

export function isTransientBadRequest(model: Model<Api>, errorMessage: string): boolean {
  return !!model.baseUrl?.startsWith(CODEBUDDY_ORIGIN) && BODYLESS_400.test(errorMessage)
}

// ── 流包装 ──────────────────────────────────────────────────────────────

const limiters = new Map<string, AdaptiveLimiter>()

/** 一家网关一个名额池。按 provider 分：套餐并发按账号算，同一家的几个模型共用 */
export function limiterFor(model: Model<Api>): AdaptiveLimiter {
  const key = model.provider
  let limiter = limiters.get(key)
  if (!limiter) {
    limiter = new AdaptiveLimiter()
    limiters.set(key, limiter)
  }
  return limiter
}

/** 一条「这次没说成话」的失败回话。包装层把自己发现的失败交给下游时用 */
export function failedAssistantMessage(model: Model<Api>, errorMessage: string): AssistantMessage {
  return {
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
    stopReason: 'error',
    errorMessage,
    timestamp: Date.now()
  }
}

type Next = IteratorResult<AssistantMessageEvent> | 'timeout'

function nextWithin(iterator: AsyncIterator<AssistantMessageEvent>, ms: number): Promise<Next> {
  let timer: ReturnType<typeof setTimeout> | undefined
  return Promise.race([
    iterator.next().finally(() => clearTimeout(timer)),
    new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), ms)
    })
  ])
}

const guards = new Map<string, AdaptiveLimiter>()

/** 普通会话一家网关一个：不和工作室的名额池混用，退避冷却也各算各的 */
function stallGuardFor(model: Model<Api>): AdaptiveLimiter {
  let guard = guards.get(model.provider)
  if (!guard) {
    guard = new AdaptiveLimiter(STALL_GUARD_CONFIG)
    guards.set(model.provider, guard)
  }
  return guard
}

/** 普通会话的包装：卡死检测 + 还没推内容时退避重发，不排队 */
export function stallGuardStreamFn(
  inner: StreamFn,
  deps: Omit<PacedStreamDeps, 'limiterFor'> = {}
): StreamFn {
  return pacedStreamFn(inner, { ...deps, limiterFor: stallGuardFor })
}

export interface PacedStreamDeps {
  limiterFor?: (model: Model<Api>) => AdaptiveLimiter
  /** 每次重发前告诉宿主一声（写日志、给界面一条提示） */
  onRetry?: (info: { attempt: number; reason: string; model: Model<Api> }) => void
  /**
   * 「失败不扣费」的套餐模型（清单 `models[].free_on_failure`）。它回 503 `upstream_unavailable`
   * 是线路池全挂了，不是网关在挤：只重发一次，再失败把原文交给调用方（界面提示稍后重试或换回默认模型），
   * 不包成「连续 N 次扛不住」—— 那句会被持续续跑当成中转不稳，再转半小时
   */
  freeOnFailure?: (model: Model<Api>) => boolean
}

/** 失败不扣费的模型线路全挂了（见 PacedStreamDeps.freeOnFailure） */
function isLineBusy(deps: PacedStreamDeps, model: Model<Api>, errorMessage: string): boolean {
  if (!deps.freeOnFailure?.(model)) return false
  const { statusCode, code } = classifyProviderError(errorMessage)
  return isPlanUpstreamUnavailable(statusCode, code)
}

/**
 * 给一个 streamFn 套上调度：排队拿名额、盯首包和包间隔、过载就退避重发。
 */
export function pacedStreamFn(inner: StreamFn, deps: PacedStreamDeps = {}): StreamFn {
  const pick = deps.limiterFor ?? limiterFor

  return (model: Model<Api>, context: TranscriptContext, options) => {
    const out = createAssistantMessageEventStream()
    const outer = options?.signal
    const limiter = pick(model)

    void (async () => {
      let lastReason = ''
      let lastTransient = false
      for (let attempt = 0; attempt <= limiter.config.maxRetries; attempt++) {
        if (outer?.aborted) break
        let release: (outcome: Outcome) => void
        try {
          release = await limiter.acquire(outer)
        } catch {
          break
        }

        // 自己的中止器接在外面那个后面：超时要能单独掐掉这一次，而不连带整轮
        const controller = new AbortController()
        const forwardAbort = (): void => controller.abort(outer?.reason)
        outer?.addEventListener('abort', forwardAbort, { once: true })
        const started = Date.now()
        let forwarded = 0
        let firstEventMs: number | undefined

        try {
          const stream = await inner(model, context, { ...options, signal: controller.signal })
          const iterator = stream[Symbol.asyncIterator]()
          for (;;) {
            const next = await nextWithin(
              iterator,
              forwarded === 0 ? limiter.firstEventTimeout() : limiter.config.idleTimeoutMs
            )
            if (next === 'timeout') {
              controller.abort(new Error('stalled'))
              lastReason =
                forwarded === 0
                  ? `等了 ${Math.round((Date.now() - started) / 1000)} 秒没有首包`
                  : '回话中途断流'
              release({ kind: 'overload' })
              break
            }
            if (next.done) {
              // 流结束却没给结局：当普通失败交给调用方，不重发
              release({ kind: 'neutral' })
              out.push({
                type: 'error',
                reason: 'error',
                error: failedAssistantMessage(model, '模型流意外结束')
              })
              out.end()
              return
            }
            const event = next.value
            if (event.type === 'error') {
              const message = event.error.errorMessage ?? ''
              const failed = event.reason === 'error' && !outer?.aborted
              const overload = failed && isOverloadError(message)
              const transient = failed && isTransientBadRequest(model, message)
              const busy = failed && isLineBusy(deps, model, message)
              if ((overload || transient) && forwarded === 0 && !(busy && attempt >= 1)) {
                lastReason = message
                lastTransient = transient
                release({ kind: 'overload' })
                break
              }
              release(overload ? { kind: 'overload' } : { kind: 'neutral' })
              out.push(event)
              out.end()
              return
            }
            firstEventMs ??= Date.now() - started
            out.push(event)
            forwarded++
            if (event.type === 'done') {
              release({ kind: 'ok', firstEventMs })
              out.end()
              return
            }
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error)
          if (forwarded === 0 && !outer?.aborted && isOverloadError(message)) {
            lastReason = message
            lastTransient = false
            release!({ kind: 'overload' })
          } else {
            release!({ kind: 'neutral' })
            // 用户点了停止、内层流随之抛 AbortError：报成中止，不是模型出错
            out.push(
              outer?.aborted
                ? {
                    type: 'error',
                    reason: 'aborted',
                    error: failedAssistantMessage(model, 'Operation aborted')
                  }
                : { type: 'error', reason: 'error', error: failedAssistantMessage(model, message) }
            )
            out.end()
            return
          }
        } finally {
          outer?.removeEventListener('abort', forwardAbort)
        }

        // 推过半截内容就不能重来了：调用方会看到重复的开头
        if (forwarded > 0) {
          out.push({
            type: 'error',
            reason: 'error',
            error: failedAssistantMessage(model, `模型网关${lastReason}，这一次的回话没收完`)
          })
          out.end()
          return
        }
        if (attempt < limiter.config.maxRetries) {
          deps.onRetry?.({ attempt: attempt + 1, reason: lastReason, model })
        }
      }

      if (outer?.aborted) {
        out.push({
          type: 'error',
          reason: 'aborted',
          error: failedAssistantMessage(model, 'Operation aborted')
        })
      } else if (lastTransient) {
        out.push({
          type: 'error',
          reason: 'error',
          error: failedAssistantMessage(model, lastReason)
        })
      } else {
        out.push({
          type: 'error',
          reason: 'error',
          error: failedAssistantMessage(
            model,
            `模型网关连续 ${limiter.config.maxRetries + 1} 次扛不住（最后一次：${lastReason}）。` +
              '可能是套餐的并发或频率上限，稍后再试，或换一个并发更高的模型服务。'
          )
        })
      }
      out.end()
    })()

    return out as AssistantMessageEventStream
  }
}
