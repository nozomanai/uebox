import type { AgentMessage, StreamFn } from '@earendil-works/pi-agent-core'
import {
  createAssistantMessageEventStream,
  createModels,
  getSupportedThinkingLevels,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type AssistantMessageEventStream,
  type Context,
  type Model,
  type ModelThinkingLevel,
  type MutableModels,
  type ThinkingLevel
} from '@earendil-works/pi-ai'

import { cursorModelContextTiers, cursorModelSupportsFast } from '../../ai/cursor/modelOptions'
import { isOpenCodeEndpoint, openCodeHeaders } from '../../ai/opencode'
import { isFreeOnFailureModel } from '../../ai/creatorPlan/apply'
import { readSettings } from '../../ai/store'
import {
  ModelNotConfiguredError,
  describeMissingRole,
  findBinding,
  resolveRole,
  resolveRoleForRequest
} from '../../ai/resolveModel'
import type { AiProviderSettings, ModelRequest, ModelRole } from '../../ai/types'
import { classifyProviderError } from '../host/providerError'
import { thinkingOffFields, toPiProvider } from './piModel'
import { isTransientBadRequest } from './team/requestGate'
import { labelToolResultImages } from './toolImageLabels'
import { currentTurnHasImages } from './visionRouting'
import {
  contextHasMediaRefs,
  isMediaFetchError,
  mediaRefKeys,
  mediaUrlKinds,
  noteUnfetchableMedia,
  replaceMediaRefs,
  rewriteMediaInPayload,
  unfetchableMediaKeys
} from './promptMedia'
import { isObjectRemoved, mediaUrlFor } from '../../services/objectStorage/objectStorageService'
import {
  budgetFor,
  noteOversizedRequest,
  projectWithinBudget,
  type ProjectedContext
} from './requestBudget'

/**
 * 输入框里那个「思考程度」。
 *
 * 档位**不是我们定的**，是每个模型自己声明的：GPT-5 系有
 * minimal/low/medium/high，某些模型只有 off/high/max，本地小模型一个都没有。
 * 所以界面上的清单必须按当前模型现问（见 `listThinkingLevels`），不能写死 ——
 * 写死的结果是列出一堆这个模型根本没有的档位，选了跟没选一样。
 *
 * `auto` 是我们额外加的一档，表示**不指定**：请求里干脆不带思考预算这个字段，
 * 模型按自己的默认来。它是缺省值，所以加上这个开关不会悄悄改掉所有人的行为。
 */
export type ThinkingLevelChoice = 'auto' | ModelThinkingLevel

/** 界面上要显示的全部档位，顺序即强度。`auto` 永远在最前 */
export const THINKING_LEVEL_LADDER: readonly ThinkingLevelChoice[] = Object.freeze([
  'auto',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])

function toPiReasoning(choice: ThinkingLevelChoice | undefined): ThinkingLevel | undefined {
  if (!choice || choice === 'auto') return undefined
  // pi 的 `reasoning` 参数类型里没有 "off"，但运行时是认的：它会走
  // clampThinkingLevel 再按各家 API 决定怎么表达「别思考」。类型比实际契约窄，
  // 这里如实转换而不是把 off 悄悄丢掉 —— 丢掉的话这一档点了没反应。
  return choice as ThinkingLevel
}

/**
 * 模型菜单里的「快速」开关。
 *
 * - Codex 订阅：请求里带 `service_tier: "priority"`（pi 不转 serviceTier，在 onPayload 里补）。
 * - Cursor 订阅：Composer / Grok 走 requested_model 的 `fast=true`（见 `cursor/modelOptions.ts`）。
 */
export function supportsFastMode(model: { api: string; id?: string }): boolean {
  if (model.api === 'openai-codex-responses') return true
  if (model.api === 'cursor-agent') return cursorModelSupportsFast(model.id ?? '')
  return false
}

export interface PiModelSelection {
  model: Model<string>
  providerId: string
  modelId: string
  /** 回落之后实际命中的角色，用于日志 */
  role: ModelRole
}

/**
 * Models 集合缓存。
 *
 * `createProvider` 每次都要重新构造 lazy api 包装，而 `Agent` 的每一轮都要
 * 解析一次模型。按「配置内容」缓存而不是按 id —— 用户在设置页改了 Base URL
 * 或密钥来源之后必须立刻生效，不能等重启。
 */
let cached: { key: string; models: MutableModels } | undefined

function settingsKey(settings: AiProviderSettings): string {
  return JSON.stringify(
    settings.providers.map((p) => [p.id, p.protocol, p.baseUrl, p.headers, p.apiKey, p.models])
  )
}

function getModels(settings: AiProviderSettings): MutableModels {
  const key = settingsKey(settings)
  if (cached?.key === key) return cached.models

  // 不注册 pi-ai 的 builtinProviders：目录层是我们自己的
  // （对本地推理 / 国产云 / 自建网关的覆盖优于 pi 内建目录，见设计文档 §3.2）。
  const models = createModels()
  for (const provider of settings.providers) {
    models.setProvider(toPiProvider(provider))
  }

  cached = { key, models }
  return models
}

/** 设置变更后强制重建（IPC 保存配置时调用） */
export function invalidateProviderCache(): void {
  cached = undefined
}

/** 解析某个角色对应的模型。找不到绑定时返回 undefined，由调用方决定是报错还是回落。 */
function selectModel(
  settings: AiProviderSettings,
  models: MutableModels,
  role: ModelRole
): PiModelSelection | undefined {
  const found = findBinding(settings, role)
  if (!found) return undefined

  const config = settings.providers.find((item) => item.id === found.binding.providerId)
  if (!config) return undefined

  const model =
    models.getModel(config.id, found.binding.modelId) ??
    // 绑定的模型不在列表里 —— 用户在设置页删了它，或手改 models.json 改坏了。
    // 按绑定现场造一个，让调用仍然能打出去：厂商若不认这个 id 会返回明确的报错，
    // 比在这里拦下更有诊断价值。
    toPiProvider({ ...config, models: [{ id: found.binding.modelId }] }).getModels()[0]

  return {
    model,
    providerId: config.id,
    modelId: found.binding.modelId,
    role: found.usedRole
  }
}

/**
 * 投影，但绝不因此抛异常。
 *
 * StreamFn 的契约是**不能抛**（失败要编码进事件流里）。而投影要
 * `JSON.stringify` 整个 context，里面包含工具自己塞的 `details` —— 那是任意值，
 * 循环引用或者一个 BigInt 就会让它抛 TypeError。这些值以前从不参与序列化
 * （厂商只发 content），所以以前无所谓；现在一抛就会穿过 pi 的
 * `streamAssistantResponse`，那条路上没有 catch，整个 run 会被判失败。
 *
 * 量不出来就当没超：少一道保险，好过把一次能跑的对话变成一次崩溃。
 */
function projectSafely(context: Context, providerId: string): ProjectedContext {
  try {
    return projectWithinBudget(context, budgetFor(providerId))
  } catch (error) {
    // `bytes: -1` 而不是 0：下游要能分辨「这一轮没量出来」和「量出来是 0」。
    // 给 0 的话 `noteOversizedRequest` 的 `attemptedBytes <= 0` 会把它悄悄吃掉，
    // 于是出口闸和 413 学习**同时**失效，而日志里只有这一行。
    console.warn('[streamFn] 请求体量不出来，跳过出口闸:', error)
    return { context, bytes: -1, droppedImages: 0 }
  }
}

/**
 * 盯着这一轮的结果，厂商退 413 就把「这么大不行」记到这家名下。
 *
 * 只旁听不干预：`stream.result()` 和事件队列是两条路，读它不会影响正在
 * 消费事件流的调用方（见 pi-ai 的 `EventStream`）。pi 的契约是失败编码进
 * 消息里而不是抛出来，所以这里看的是 `stopReason`，不是异常。
 *
 * 这一轮已经失败了，救不回来 —— 但下一次（包括用户点「继续尝试」）会按学到
 * 的新预算投影，于是同一家的 413 只会发生一次。
 */
function watchForOversized(stream: unknown, providerId: string, bytes: number): void {
  // 旁听是可选的：拿到一个没有 result() 的流（假 provider、将来换实现）也只是
  // 学不到东西，绝不能因此让这一轮发不出去
  const result = (stream as { result?: () => Promise<unknown> })?.result
  if (typeof result !== 'function') return

  void Promise.resolve(result.call(stream))
    .then((value) => value as { stopReason?: string; errorMessage?: string })
    .then((message) => {
      if (message?.stopReason !== 'error') return
      if (classifyProviderError(message.errorMessage ?? '').statusCode === 413) {
        noteOversizedRequest(providerId, bytes)
      }
    })
    // 旁听失败绝不能影响这一轮：它只是为了让下一轮更聪明
    .catch(() => {})
}

/** 流里出了意外时补的那条失败消息 —— 调用方要等到一个结局，不能让它永远挂着 */
function failedMessage(model: Model<Api>, errorMessage: string): AssistantMessage {
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

/** 对话里有没有内嵌图片（工具截图、用户贴的图） */
function contextHasImages(context: Context): boolean {
  return context.messages.some(
    (message) =>
      Array.isArray(message.content) && message.content.some((block) => block.type === 'image')
  )
}

/**
 * 声明能看图、一带图就被拒的模型。这个进程里再带图就当它是纯文本模型：
 * 截图交给视觉模型看，历史里的旧图换成占位文字。
 *
 * 真机（2026-10-09 硅基流动）：用户给 DeepSeek-V4-Pro 勾了「视觉」，Blender 截图一回来
 * 就是 400「not a VLM」。图留在 transcript 里，之后每一轮、每次「继续尝试」都原样重发，
 * 整条会话就此卡死。只记「去掉图之后真过了」的那种 —— 没过说明拒的不是图。
 */
const imageRejecting = new Set<string>()

function modelKey(model: Model<Api>): string {
  return `${model.provider}/${model.id}`
}

/** 模型声明收图。pi 的模型都带 `input`，没带的（手造的、测试桩）按不收算 */
function acceptsImages(model: Model<Api>): boolean {
  return model.input?.includes('image') ?? false
}

function seesImages(model: Model<Api>): boolean {
  return acceptsImages(model) && !imageRejecting.has(modelKey(model))
}

/** 仅供测试 */
export function resetImageRejectionsForTest(): void {
  imageRejecting.clear()
}

/** 重发那一条真成功了，才把「这个模型收不了图」记下 */
function learnImageRejection(retry: AssistantMessageEventStream, model: Model<Api>): void {
  const result = (retry as { result?: () => Promise<unknown> })?.result
  if (typeof result !== 'function') return
  void Promise.resolve(result.call(retry))
    .then((value) => value as { stopReason?: string })
    .then((message) => {
      if (message?.stopReason === 'error' || message?.stopReason === 'aborted') return
      imageRejecting.add(modelKey(model))
      console.warn(`[streamFn] ${modelKey(model)} 收不了图，这次运行里不再给它发图`)
    })
    .catch(() => {})
}

/**
 * 有的厂商把错误原因放在响应体顶层（硅基流动：`{"code":20041,"message":"…not a VLM…"}`），
 * OpenAI SDK 只认 `{"error":{…}}`，于是报错只剩一句 `400 status code (no body)`，
 * 用户和我们都看不出是哪里被拒。失败响应体是这个形状时，补一层 `error` 让原因透出来。
 * 成功的响应原样放过。
 */
export function withTopLevelErrorMessage(base: typeof fetch): typeof fetch {
  return async (input, init) => {
    const response = await base(input, init)
    if (response.ok) return response
    const text = await response
      .clone()
      .text()
      .catch(() => '')
    let body: unknown
    try {
      body = JSON.parse(text)
    } catch {
      return response
    }
    if (!body || typeof body !== 'object' || 'error' in body) return response
    const { message, code } = body as { message?: unknown; code?: unknown }
    if (typeof message !== 'string' || !message) return response
    const headers = new Headers(response.headers)
    headers.delete('content-length')
    headers.delete('content-encoding')
    return new Response(
      JSON.stringify({ ...body, error: { message, ...(code !== undefined ? { code } : {}) } }),
      { status: response.status, statusText: response.statusText, headers }
    )
  }
}

/**
 * 第一下就被拒、而且拒的原因换个请求能绕开时，换一条流重发一次，这一轮照样有回答
 * —— 见 AGENTS.md 第 5 节第 13 条「退的每一步都不许打断这一轮」。眼下两种：
 *
 * - 厂商说拉不下链接里的多媒体（对象存储在墙外、链接过期、格式它不认）：引用换成说明
 * - 带图的请求回 400：交给视觉模型，或者去掉图片（见 `contextHasImages` 那里）
 *
 * 只看第一个事件：pi 在 HTTP 失败时只推一个 `error`、不推 `start`，
 * 这时调用方还什么都没收到，换一条流接上不会留下半截内容。
 */
function retryOnFirstError(
  first: AssistantMessageEventStream,
  model: Model<Api>,
  shouldRetry: (errorMessage: string) => boolean,
  retry: (errorMessage: string) => AssistantMessageEventStream
): AssistantMessageEventStream {
  const out = createAssistantMessageEventStream()
  const forward = async (iterator: AsyncIterator<AssistantMessageEvent>): Promise<void> => {
    for (let next = await iterator.next(); !next.done; next = await iterator.next()) {
      out.push(next.value)
    }
  }
  void (async () => {
    const iterator = first[Symbol.asyncIterator]()
    const head = await iterator.next()
    if (
      !head.done &&
      head.value.type === 'error' &&
      head.value.reason === 'error' &&
      shouldRetry(head.value.error.errorMessage ?? '')
    ) {
      await forward(retry(head.value.error.errorMessage ?? '')[Symbol.asyncIterator]())
    } else {
      if (!head.done) out.push(head.value)
      await forward(iterator)
    }
    out.end()
  })().catch((error: unknown) => {
    // 已经推过结局的话这一条会被忽略（EventStream 结束后不再收）
    out.push({
      type: 'error',
      reason: 'error',
      error: failedMessage(model, error instanceof Error ? error.message : String(error))
    })
    out.end()
  })
  return out
}

export interface AgentModelRuntime {
  selection: PiModelSelection
  streamFn: StreamFn
  /** compaction 用。摘要模型可能与主模型不同 provider，所以要整个集合 */
  models: MutableModels
  /**
   * 生成摘要用的模型。
   *
   * 优先用 summary 角色 —— 压缩上下文不需要最贵的模型。没绑 summary 时回落到
   * 主模型，压缩仍然可用，只是贵一点。
   */
  summaryModel: Model<string>
  /**
   * 工具回的截图有没有模型看得到：主模型自己能看，或者配了能接手的视觉模型。
   * 系统提示词按它说「你看得到」还是「你看不到」
   */
  toolImagesVisible: boolean
  /**
   * 这个模型是不是「失败不扣费」的套餐模型（清单 `models[].free_on_failure`）。
   * 卡死重发、自动续跑、报错提示据此对它的 `upstream_unavailable` 只重试一次（见 requestGate.ts）
   */
  freeOnFailure: (model: { provider: string; id: string }) => boolean
}

/**
 * 解析本次调用要用的模型，连同 StreamFn 和 compaction 需要的集合。
 *
 * @throws {ModelNotConfiguredError} 没有任何可用绑定
 * @throws {MissingApiKeyError} 绑定存在但密钥取不到
 */
/** 当前绑定的模型支持哪些思考档位，供输入框那个下拉按模型列清单 */
export interface ThinkingLevelOptions {
  /** 该模型实际支持的档位，已按强度排序。`auto` 由界面自己补在最前 */
  levels: ModelThinkingLevel[]
  /**
   * 厂商给这些档位起的名字（pi 的 `thinkingLevelMap`）。
   *
   * 有的模型把 `high` 叫成别的词。界面显示厂商的说法、把标准名放在括号里，
   * 用户在别处（厂商文档、官方客户端）看到的就对得上。
   */
  levelMap: Record<string, string | null>
  /** 这次的档位清单是按哪个模型问出来的，界面上要说清楚 */
  modelId: string
  /** 这个模型能不能开「快速」，见 `supportsFastMode` */
  fastMode: boolean
  /** Cursor 订阅可选的 Context 档（如 256k / 500k），没有就不显示 */
  contextTiers?: string[]
}

/**
 * 问内核：**这个模型**能调哪几档思考。
 *
 * 不同模型的档位天差地别 —— 有的是 minimal/low/medium/high，有的只有
 * off/high/max，不会思考的模型只有 off。界面写死一份清单的话，用户会看到
 * 一堆当前模型根本没有的档位，选了内核会悄悄夹到最近的一档，表现就是
 * 「选了没反应」。所以清单必须现问。
 *
 * 模型没配好时返回 null 而不是抛错：这只是为了画一个下拉，
 * 不该把「还没配模型」升级成一次报错弹窗。
 */
export async function listThinkingLevels(
  request: ModelRequest = {}
): Promise<ThinkingLevelOptions | null> {
  const settings = withPin(await readSettings(), request)
  const models = getModels(settings)
  const selection = selectModel(settings, models, resolveRoleForRequest(settings, request))
  if (!selection) return null

  const contextTiers =
    selection.model.api === 'cursor-agent'
      ? cursorModelContextTiers(selection.modelId)
      : undefined

  return {
    levels: getSupportedThinkingLevels(selection.model),
    levelMap: (selection.model.thinkingLevelMap ?? {}) as Record<string, string | null>,
    modelId: selection.modelId,
    fastMode: supportsFastMode(selection.model),
    ...(contextTiers ? { contextTiers: [...contextTiers] } : {})
  }
}

/** 钉死模型：把这一角色的绑定临时换成钉死的那对，其余（密钥、provider 表）照旧 */
function withPin(stored: AiProviderSettings, request: ModelRequest): AiProviderSettings {
  return request.pin
    ? { ...stored, roles: { ...stored.roles, [resolveRole(request)]: request.pin } }
    : stored
}

export async function resolveAgentModel(
  request: ModelRequest = {},
  thinkingLevel?: ThinkingLevelChoice,
  fastMode = false,
  cursorContext?: string
): Promise<AgentModelRuntime> {
  const settings = withPin(await readSettings(), request)
  const models = getModels(settings)
  const role = resolveRoleForRequest(settings, request)

  const selection = selectModel(settings, models, role)
  if (!selection) {
    throw new ModelNotConfiguredError(describeMissingRole(role), role)
  }

  const reasoning = toPiReasoning(thinkingLevel)

  /** 这次请求实际发给谁。平时就是 selection；这一轮带图而它看不了，换成视觉模型 */
  interface Target {
    model: Model<Api>
    providerId: string
    modelId: string
  }
  const primary: Target = {
    model: selection.model as Model<Api>,
    providerId: selection.providerId,
    modelId: selection.modelId
  }

  /**
   * 这一轮的图交给谁看：主模型看不了时，按「视觉」角色的回落链找一个看得了、还能调工具的。
   *
   * 进来的时候模型已经定了（`hasImages` 只看用户贴的图），而截图是**跑到一半**
   * 由工具回来的 —— 不在这里换，纯文本模型就只能拿着一句「(image omitted)」去
   * 判断改得对不对。只换带图的这一轮（同 `visionRouting.ts` 的取舍），下一轮回到主模型。
   * 视觉模型调不了工具的不换：这一轮它要接着干活，不是只描述一张图。
   */
  const visionStandIn = (exclude: Target): Target | undefined => {
    for (const candidateRole of [
      resolveRoleForRequest(settings, { ...request, hasImages: true }),
      'vision' as const
    ]) {
      const candidate = selectModel(settings, models, candidateRole)
      if (!candidate) continue
      if (candidate.providerId === exclude.providerId && candidate.modelId === exclude.modelId) {
        continue
      }
      const model = candidate.model as Model<Api>
      if (!seesImages(model)) continue
      const config = settings.providers
        .find((provider) => provider.id === candidate.providerId)
        ?.models.find((item) => item.id === candidate.modelId)
      if (config?.supportsTools === false) continue
      return { model, providerId: candidate.providerId, modelId: candidate.modelId }
    }
    return undefined
  }

  const send = (
    target: Target,
    context: Context,
    options: Parameters<StreamFn>[2],
    imageFallback: boolean
  ): AssistantMessageEventStream => {
    // 记下来收不了图的，按纯文本模型发：pi 会把图换成占位文字
    const model: Model<Api> =
      acceptsImages(target.model) && !seesImages(target.model)
        ? { ...target.model, input: ['text'] }
        : target.model
    // 对话里的多媒体引用，这个模型能直接收哪几类链接，见 promptMedia.ts
    const urlKinds = mediaUrlKinds(settings, target.providerId, target.modelId)
    const projected = projectSafely(context, target.providerId)
    if (projected.droppedImages > 0) {
      console.warn(
        `[streamFn] 本轮请求超出 ${target.providerId} 的预算，` +
          `已丢掉 ${projected.droppedImages} 张图（最大的优先），换成占位文字`
      )
    }
    // 发不出去的那几类先换成说明，剩下的（如果还有）在 onPayload 里换成链接
    const replaced = replaceMediaRefs(
      projected.context,
      urlKinds,
      unfetchableMediaKeys(target.providerId)
    )
    // 放在出口闸之后：被预算丢掉的图已换成文字，序号才和真正发出去的附图对得上
    const labeled = labelToolResultImages(replaced.messages)
    const outgoing = labeled === replaced.messages ? replaced : { ...replaced, messages: labeled }
    const hasMedia = contextHasMediaRefs(outgoing)
    const codexPriority = fastMode && model.api === 'openai-codex-responses'
    const cursorFast =
      fastMode && model.api === 'cursor-agent' && supportsFastMode(model)
    const wireContext =
      model.api === 'cursor-agent' && cursorContext && cursorContext !== 'auto'
        ? cursorContext
        : undefined
    const previousOnPayload = codexPriority
      ? async (payload: unknown, payloadModel: Model<Api>) => {
          const upstream = await options?.onPayload?.(payload, payloadModel)
          const current = (upstream === undefined ? payload : upstream) as object
          return { ...current, service_tier: 'priority' }
        }
      : options?.onPayload
    // 「不思考」在有几家端点上光传 off 不管用，要补自家字段（见 thinkingOffFields）
    const offFields = thinkingLevel === 'off' ? thinkingOffFields(model.baseUrl) : undefined
    // OpenCode 要一段对话一个稳定的会话 id；pi 给的缓存键正好是这个粒度，
    // 压缩后换键时前缀缓存本来也失效了。凭据层那个随机 id 只给一次性请求兜底
    const sessionHeaders =
      options?.sessionId && isOpenCodeEndpoint(model.baseUrl)
        ? { headers: { ...options.headers, ...openCodeHeaders(options.sessionId) } }
        : {}
    const baseOptions = {
      ...options,
      ...sessionHeaders,
      // Google 两个适配器见到非全局 fetch 直接抛错（同 requestDiagnostics），只给 OpenAI 系
      ...(String(model.api).startsWith('openai-')
        ? {
            fetch: withTopLevelErrorMessage(
              options?.fetch ?? ((input, init) => globalThis.fetch(input, init))
            )
          }
        : {}),
      ...(reasoning ? { reasoning } : {}),
      ...(() => {
        const samplingParams = {
          ...options?.samplingParams,
          ...(offFields ?? {}),
          ...(cursorFast ? { cursorFast: true } : {}),
          ...(wireContext ? { cursorContext: wireContext } : {})
        }
        return Object.keys(samplingParams).length > 0 ? { samplingParams } : {}
      })(),
      ...(codexPriority ? { onPayload: previousOnPayload } : {})
    }
    const firstTry = models.streamSimple(model, outgoing, {
      ...baseOptions,
      ...(hasMedia
        ? {
            onPayload: async (payload: unknown, payloadModel: Model<Api>) => {
              const upstream = await previousOnPayload?.(payload, payloadModel)
              const current = upstream === undefined ? payload : upstream
              const rewritten = await rewriteMediaInPayload(current, {
                urlFor: mediaUrlFor,
                isRemoved: isObjectRemoved
              })
              return rewritten === undefined ? upstream : rewritten
            }
          }
        : {})
    })
    const stream = hasMedia
      ? retryOnFirstError(firstTry, model, isMediaFetchError, () => {
          const keys = mediaRefKeys(outgoing)
          console.warn(
            `[streamFn] ${target.providerId} 拉不下对话里的多媒体链接，换成说明重发：`,
            keys
          )
          noteUnfetchableMedia(target.providerId, keys)
          return models.streamSimple(
            model,
            replaceMediaRefs(outgoing, urlKinds, new Set(keys)),
            baseOptions
          )
        })
      : firstTry
    // 带图的请求回 400，重发一次，这一轮照样有回答：
    //
    // - CodeBuddy 的 hy4：带图的请求过了约 14 万 token 就多半被拒（不带图 23 万也照收），
    //   回的是空 400。2026-10-08 拿真机被拒的请求体逐项对照量出来的：同一请求去掉图片
    //   5/5 能过，原样 5 次挂 4 次。它平时看得了图，所以只去掉图、不记账
    // - 别家：多半是这个模型根本收不了图（被勾了「视觉」、目录标错）。有视觉模型就交给它，
    //   没有就去掉图；重发真过了就记下来，这次运行里不再给它发图
    const imagesGoOut = imageFallback && acceptsImages(model) && contextHasImages(outgoing)
    const final = imagesGoOut
      ? retryOnFirstError(
          stream,
          model,
          (message) =>
            isTransientBadRequest(model, message) ||
            classifyProviderError(message).statusCode === 400,
          (message) => {
            if (isTransientBadRequest(model, message)) {
              console.warn(
                `[streamFn] ${target.providerId}/${model.id} 带图的请求被拒，去掉图片重发一次`
              )
              return models.streamSimple({ ...model, input: ['text'] }, outgoing, baseOptions)
            }
            const standIn = visionStandIn(target)
            console.warn(
              `[streamFn] ${target.providerId}/${model.id} 带图的请求被拒（${message.slice(0, 120)}），` +
                (standIn ? `交给 ${standIn.providerId}/${standIn.modelId} 重发` : '去掉图片重发')
            )
            const retry = standIn
              ? send(standIn, context, options, false)
              : send({ ...target, model: { ...model, input: ['text'] } }, context, options, false)
            learnImageRejection(retry, model)
            return retry
          }
        )
      : stream
    // 没量出来（bytes < 0）就没有可学的数 —— 别拿一个假数去调这家的预算
    if (projected.bytes >= 0) {
      watchForOversized(stream, target.providerId, projected.bytes)
    }
    return final
  }

  return {
    selection,
    // 契约：StreamFn **不能抛异常**，失败要编码进返回的事件流里（见 pi 的 StreamFn 文档）。
    // 这里只做分派，模型解析的失败在上面已经抛掉了。
    //
    // 思考档位放在最后覆盖：这条 streamFn 是全应用唯一给 pi 传 reasoning 的地方，
    // 用户在输入框里选了什么就是什么。
    //
    // 出口闸也挂在这里，理由同上 —— 这是**发起 agent 请求**唯一的一条路，
    // 而请求有多大不由任何一个工具说了算（见 `requestBudget.ts` 文件头）。
    // 注意压缩用的摘要请求走的是 pi 的 `models.completeSimple`，不经过这里；
    // 那条路上 `serializeConversation` 会把图片全部丢成文本，所以不需要闸。
    streamFn: (model, context, options) => {
      const target: Target = { ...primary, model: model as Model<Api> }
      if (!seesImages(target.model) && currentTurnHasImages(context.messages as AgentMessage[])) {
        const standIn = visionStandIn(target)
        if (standIn) {
          console.warn(
            `[streamFn] 这一轮带图，${target.providerId}/${target.modelId} 看不了，` +
              `交给 ${standIn.providerId}/${standIn.modelId}`
          )
          return send(standIn, context, options, true)
        }
      }
      return send(target, context, options, true)
    },
    models,
    summaryModel: selectModel(settings, models, 'summary')?.model ?? selection.model,
    toolImagesVisible: seesImages(primary.model) || visionStandIn(primary) !== undefined,
    freeOnFailure: (model) => isFreeOnFailureModel(settings, model.provider, model.id)
  }
}
