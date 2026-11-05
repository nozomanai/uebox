import { resolveApiKey } from './credentials'
import { ModelNotConfiguredError } from './resolveModel'
import { readSettings } from './store'
import { prepareReferenceUpload } from './referenceImageUpload'
import type { ImageApi } from '../../shared/aiProvider'
import { isPlanProvider } from '../../shared/creatorPlan'
import { cachedPlanSpec, specLimit } from './creatorPlan/cachedSpec'
import { CreatorPlanCallError, isDailyLimitResponse, planCallError } from './creatorPlan/callError'
import { getGptImageRatioForSize, getGptImageSizeTier } from '../../shared/imageGenerationModels'
import type { ProviderConfig, ProviderProtocol } from './types'

/**
 * 本地直连的图片生成。
 *
 * 与 embedding.ts 是同一类东西：**产出的不是文本**，所以不走 resolveModelSelection
 * 那条 LanguageModel 的路，而是自己发请求。
 *
 * ## 为什么是「每家一个适配器」而不是一个 SDK
 *
 * 上一版走的是 AI SDK：它按 OpenAI 的形状拼一个请求，我们再在一层自定义 fetch 里
 * 把请求体改写成这家真正认的字段。两次加工中间那一步是**看不见的** —— 代码里写着
 * `n: 2`，线上发出去的是 `batch_size: 2`；代码里没有 `/images/edits` 这个词，
 * 请求却打在那个端点上。开源项目不该有这种暗箱：读代码的人看到的必须就是发出去的东西。
 *
 * 现在每家一个适配器，各自按**自己的官方文档**拼请求、按自己的文档解析响应，
 * 文档地址就写在适配器上。加一家新厂商 = 加一个适配器，不改别人的。
 *
 * ## 边界
 *
 * 只做「文字（+参考图）进、图片出」这一件事。端点形状不必相同 —— Nano Banana
 * 走的是 Google 自己的 Interactions API 而不是 `/images/generations`，
 * 适配器要解决的正是这种差异。
 *
 * **异步任务式的网关也在这里**，但不是第六个适配器：那一类（toapis 这样的中转站）
 * 的提交请求与 OpenAI 完全一样，只有 200 响应换成了一张任务单。所以它只是
 * 所有适配器共用的一段**后处理** —— 见 `awaitImageTask`。
 */

/**
 * 一次调用最多出几张图。
 *
 * 卡这个数是因为张数直接乘在账单上：调用方把 count 算错（或用户在输入框里
 * 多打一个 0）不该变成一次几十张的扣费。真要更多，多点几次。
 */
const MAX_IMAGES_PER_CALL = 8

/**
 * 单次生成的超时。
 *
 * 比对话宽得多：4K 图、带参考图的重绘在几家厂商上都是分钟级，按对话那套
 * 三十秒去掐，用户看到的会是「明明厂商那边画完了，这边说超时」。
 */
const REQUEST_TIMEOUT_MS = 300_000

/**
 * 异步任务式网关的轮询节奏：**每次等 5–6 秒**（5 秒定频 + 0–1 秒抖动）。
 *
 * 文档建议的是 5–10 秒，这里取下沿：typical 是 5–30 秒出图，等得越密用户
 * 看到图越早，而 429 有专门的退避分支兜着（见 awaitImageTask）。
 *
 * 抖动不是讲究 —— 一次出 4 张图就是 4 条并行的轮询，定频的话它们会永远撞在
 * 同一毫秒上，把自己打成 429。
 *
 * @see https://docs.toapis.com/docs/cn/api-reference/tasks/image-status
 */
const TASK_POLL_INTERVAL_MS = 5_000
const TASK_POLL_JITTER_MS = 1_000

/**
 * 单次查询的超时。
 *
 * 与整个任务的上限分开：网关把连接收下却再也不回话时，只有这一位能让我们
 * 回到循环顶上去重试。少了它，一条挂死的连接会一直占着，直到外面那个
 * 五分钟的信号开火 —— 那时候抛的是光秃秃的 AbortError，任务号也跟着没了。
 */
const TASK_POLL_TIMEOUT_MS = 30_000

/**
 * 轮询阶段能容忍连续几次失败。
 *
 * **提交之后钱已经扣了，任务也在厂商那边跑着。** 查询失败只是「这一次没查到」，
 * 不是「这张图没了」—— 一次 502、一次 DNS 抖动就把一张付过钱的图判死刑，
 * 是这条链路上最贵的错误。与 video.ts 的 POLL_FAILURE_TOLERANCE 同一条理由，
 * 只是这里的任务短得多，所以给 5 次（约半分钟）而不是 8 次。
 */
const TASK_POLL_FAILURE_TOLERANCE = 5

/**
 * 一个任务最多等多久。**从发出提交请求那一刻算起**，不是从开始轮询算起。
 *
 * 比文档建议的 120 秒长：文档说典型 5–30 秒，但 4K 加参考图那一档明显更久，
 * 而**提交那一刻钱就已经扣了** —— 在厂商还在画的时候先放弃，用户等于付了钱
 * 什么也没拿到。
 *
 * 起点必须是提交那一刻：带几张参考图的提交本身就要几十秒，从轮询才开始计时的话
 * 「240 秒」会连着提交的耗时一起顶穿外面那个 300 秒的信号，于是超时由**它**报出来 ——
 * 一句光秃秃的 AbortError，任务号丢了。留 60 秒的差正是为了让这一位先开火。
 */
const TASK_TIMEOUT_MS = 240_000

/**
 * Box Plan 的生图任务上限：协议写明「10 分钟内必定结束，超时为 failed」。
 * 时间交给服务端判，这边只比它多等一分钟，免得我们先放弃一张正在画、已经预占了额度的图。
 */
const PLAN_TASK_TIMEOUT_MS = 660_000

/**
 * 配置类错误共有的锚点短语。
 *
 * AI 创作那条链路上的 `getFriendlyErrorMessage` 会按关键词把厂商报错归类，
 * 并把超过 100 字的消息压成一句「生成失败，请稍后重试」。配置类错误恰恰是
 * 唯一**必须原样透出**的一类 —— 它本身就是「该怎么改」的说明，压掉了用户
 * 就只剩一句正确但无用的话。用一个共享短语让那边认出来，比在模块之间传
 * 错误类型可靠：错误经过 IPC 之后只剩字符串，instanceof 早就没了。
 */
export const IMAGE_CONFIG_ERROR_MARKER = '设置 → 模型'

export class ImageModelNotConfiguredError extends ModelNotConfiguredError {
  constructor() {
    super(
      `尚未配置「生图」模型。请在 ${IMAGE_CONFIG_ERROR_MARKER} 中添加 Provider，` +
        '在其模型清单中勾选「生图」，并将该模型绑定到「生图」角色。',
      'image'
    )
    this.name = 'ImageModelNotConfiguredError'
  }
}

export class ImageModelUnavailableError extends Error {
  constructor() {
    super(
      `本次信息图所选的生图模型已不可用。请在 ${IMAGE_CONFIG_ERROR_MARKER} 中` +
        '检查服务商、密钥和模型的「生图」能力，然后重新选择。'
    )
    this.name = 'ImageModelUnavailableError'
  }
}

/**
 * 协议本身就没有生图接口时抛这个。
 *
 * 不这么做的话，用户拿到的是一句来自厂商的 404 —— 那看上去像「模型 id 写错了」，
 * 于是他会去反复改模型名，而真正的问题是这家协议压根不提供这个能力。
 */
export class ImageProtocolUnsupportedError extends Error {
  constructor(readonly protocol: ProviderProtocol) {
    super(
      `«${protocol}» 这种协议不提供图片生成接口。请到 ${IMAGE_CONFIG_ERROR_MARKER} ` +
        `把它改成 openai-completions（绝大多数兼容网关与国产厂商）` +
        `或 openai-responses（OpenAI 官方）。`
    )
    this.name = 'ImageProtocolUnsupportedError'
  }
}

/**
 * 厂商把请求打回来了。
 *
 * 消息**必须短**：AI 创作那边的 getFriendlyErrorMessage 会把超过 100 字的整条
 * 压成「生成失败，请稍后重试」。所以只留三样能定位问题的东西 —— 状态码、
 * 打的哪个端点、厂商自己那句话（截断）。上一版没有这个类，SDK 在响应体为空时
 * 拿 statusText 当消息，用户看到的就是一句没头没尾的 `Not Found`。
 */
export class ImageRequestError extends Error {
  constructor(
    readonly status: number,
    readonly path: string,
    detail: string,
    /**
     * 完整地址。**不进 message** —— 加进去整条就超过 50 字，
     * AI 创作那边会把它压成「生成失败，请稍后重试」，等于把仅有的线索也丢了。
     * 挂在字段上，需要它的调用方（agent 工具）自己取。
     */
    readonly url = '',
    /**
     * 打这个端点用的方法。轮询任务状态走的是 GET —— 写死 POST 的话，
     * 用户照着这句话去查，查的是一个根本不存在的 `POST /images/generations/{id}`。
     */
    readonly method = 'POST'
  ) {
    super(
      `生图接口报错 HTTP ${status}（${method} ${path}）：${detail.slice(0, 40) || '厂商没有给出说明'}`
    )
    this.name = 'ImageRequestError'
  }
}

/**
 * HTTP 通了，但回来的不是 JSON。
 *
 * 典型是网关/反代把请求接住了，返回自己的 HTML 页面（登录页、404、限流页）。
 * 不单独处理的话，`response.json()` 抛的是一句 `Unexpected token '<'` ——
 * 那句话既不说是谁返回的，也不说打的是哪个地址，排查只能靠猜。
 */
export class ImageResponseNotJsonError extends Error {
  constructor(
    readonly path: string,
    readonly url = '',
    /** 同 ImageRequestError：轮询是 GET，写死 POST 会把人指到不存在的请求上 */
    readonly method = 'POST'
  ) {
    super(`生图接口返回的不是 JSON（${method} ${path}），多半是 Base URL 指到了网页而不是 API。`)
    this.name = 'ImageResponseNotJsonError'
  }
}

/**
 * 请求通了，但一张图都没回。
 *
 * 大多数厂商在被安全策略挡下时**不报错**，而是回一个空的 data 数组。
 * 不在这里拦住的话，调用方拿到空数组，界面上表现为「转了半天，什么都没有，
 * 也没有报错」—— 最难排查的那一种。
 */
export class ImageGenerationEmptyError extends Error {
  constructor() {
    super('厂商没有返回图片。换个提示词或换一个生图模型再试。')
    this.name = 'ImageGenerationEmptyError'
  }
}

/**
 * 任务号进消息之前先截短。
 *
 * 下游的 getFriendlyErrorMessage 会把**超过 100 字**的整条压成一句
 * 「生成失败，请稍后重试」。任务号是这几个错误唯一的价值所在，一个五十多字的
 * 带前缀 UUID 就能把整条顶过线，于是连它一起没了 —— 正好丢掉要保住的那样东西。
 * 完整值永远挂在 `taskId` 字段上，需要它的调用方自己取。
 */
function shortTaskId(id: string): string {
  return id.length > 40 ? `${id.slice(0, 40)}…` : id
}

/**
 * 异步任务式的网关说这次任务失败了。
 *
 * 与 ImageRequestError 分开是因为出错的**时机**不同：HTTP 是 200，请求收下了，
 * 失败发生在提交之后 —— 也就是额度已经扣了。厂商那句话必须原样带出来，
 * 那是唯一能说明「为什么白花了这笔钱」的东西。
 */
export class ImageTaskFailedError extends Error {
  constructor(
    readonly taskId: string,
    detail: string
  ) {
    super(`生图任务失败：${detail.slice(0, 50) || '厂商没有给出原因'}`)
    this.name = 'ImageTaskFailedError'
  }
}

/**
 * 任务还在跑，但我们不等了。
 *
 * 任务号要带出来：图多半还是会画出来的，额度也确实扣了，用户拿着这个号
 * 能去厂商控制台把图取回来。
 */
export class ImageTaskTimeoutError extends Error {
  constructor(
    readonly taskId: string,
    timeoutMs: number = TASK_TIMEOUT_MS
  ) {
    super(
      `生图任务已等待 ${Math.round(timeoutMs / 1000)} 秒仍未完成，` +
        `可在服务商处使用任务号 ${shortTaskId(taskId)} 取回结果。`
    )
    this.name = 'ImageTaskTimeoutError'
  }
}

/**
 * 提交成功了，但**查询这一端**断了 —— 连着查不到，或者查回来的东西认不出来。
 *
 * 与「任务失败」分开，是因为这个区别决定了下一步该不该重来：任务多半还在厂商
 * 那边跑着，钱也已经扣了，重新提交是再付一次全款。与 ImageGenerationEmptyError
 * 更要分开 —— 那一句让用户「换个提示词再试」，而提示词在这里是清白的。
 */
export class ImageTaskInterruptedError extends Error {
  constructor(
    readonly taskId: string,
    detail: string
  ) {
    super(
      `生图任务已提交但查不到结果（任务号 ${shortTaskId(taskId)}）：` +
        `${detail.slice(0, 30) || '厂商没有给出说明'}`
    )
    this.name = 'ImageTaskInterruptedError'
  }
}

/**
 * 用户在**提交之后**按了停止。
 *
 * 取消的是我们这边的等待，不是厂商那边的任务 —— 那个还在画，钱也已经扣了。
 * 任务号必须救出来，否则这一次就是白付。与 video.ts 的 VideoCancelledError 同理。
 */
export class ImageTaskCancelledError extends Error {
  constructor(readonly taskId: string) {
    super(`已停止等待。厂商任务仍在运行，额度已扣除，可凭任务号 ${shortTaskId(taskId)} 取回结果。`)
    this.name = 'ImageTaskCancelledError'
  }
}

/** 这家的生图接口不接受参考图时抛这个，而不是把参考图悄悄丢掉 */
export class ImageReferenceUnsupportedError extends Error {
  constructor(readonly api: ImageApi) {
    super(`这个生图模型的接口不接受参考图。去掉参考图再生成，或换一个支持图生图的模型。`)
    this.name = 'ImageReferenceUnsupportedError'
  }
}

export interface GenerateImagesRequest {
  prompt: string
  /** 可选的已配置 Provider；与 modelId 同时传入时覆盖全局「生图」角色绑定 */
  providerId?: string
  /** 可选的已配置生图模型；与 providerId 同时传入时覆盖全局「生图」角色绑定 */
  modelId?: string
  /** 出几张。超出上限会被截到上限，而不是报错 */
  count?: number
  /** 像素尺寸（`1024x1024`）或界面上的档位（`1K`/`2K`/`4K`），由适配器各自决定怎么用 */
  size?: string
  /** 画面比例，形如 `16:9` */
  aspectRatio?: string
  /** 参考图（图生图 / 局部重绘）。data URI、裸 base64、http(s) 直链都收 */
  referenceImages?: string[]
  seed?: number
  /**
   * 调用方的取消信号。
   *
   * 与内部的超时是**并联**的：AI 创作那边点「取消」要能立刻停下，
   * 而没人取消时也不能永远挂着。
   */
  signal?: AbortSignal
}

export interface GeneratedImageData {
  /** 不带 data URI 前缀的图片数据 */
  base64: string
  /** 形如 `image/png`。调用方存盘时靠它决定扩展名 */
  mediaType: string
}

/** 取本次指定的模型；未指定时沿用全局「生图」角色绑定。 */
export async function resolveImageBinding(
  request: GenerateImagesRequest
): Promise<{ provider: ProviderConfig; modelId: string }> {
  const settings = await readSettings()
  const requestedProviderId = request.providerId?.trim()
  const requestedModelId = request.modelId?.trim()

  if (requestedProviderId || requestedModelId) {
    if (!requestedProviderId || !requestedModelId) throw new ImageModelUnavailableError()
    const requestedProvider = settings.providers.find((item) => item.id === requestedProviderId)
    const requestedModel = requestedProvider?.models.find((model) => model.id === requestedModelId)
    // 能力不再看模型上的位，看 Provider 的用途
    if (!requestedProvider || requestedProvider.kind !== 'image' || !requestedModel) {
      throw new ImageModelUnavailableError()
    }
    return { provider: requestedProvider, modelId: requestedModelId }
  }

  // 与嵌入一样**不参与回落**：把对话模型顶上来只会拿到一句厂商报错
  const binding = settings.roles.image
  if (!binding) throw new ImageModelNotConfiguredError()

  const provider = settings.providers.find((item) => item.id === binding.providerId)
  if (!provider) throw new ImageModelNotConfiguredError()

  return { provider, modelId: binding.modelId }
}

/**
 * 从厂商 URL 取回的单张图片的大小上限。
 *
 * 这个数据来自**厂商响应里的地址**，不是我们自己给的，所以要有个头。
 * 32MB 远大于任何一张 4K 出图，同时挡住「一个坏掉的地址把主进程内存吃干」。
 */
const MAX_REMOTE_IMAGE_BYTES = 32 * 1024 * 1024

async function downloadAsBase64(url: string, signal?: AbortSignal): Promise<string> {
  const response = await fetch(url, signal ? { signal } : {})
  if (!response.ok) {
    throw new Error(`取回生成的图片失败：HTTP ${response.status}`)
  }

  const declaredSize = Number(response.headers.get('content-length') || 0)
  if (declaredSize > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error(`生成的图片超过 ${MAX_REMOTE_IMAGE_BYTES} 字节上限`)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  // content-length 可以缺失或撒谎，落地之后再量一次
  if (buffer.byteLength > MAX_REMOTE_IMAGE_BYTES) {
    throw new Error(`生成的图片超过 ${MAX_REMOTE_IMAGE_BYTES} 字节上限`)
  }
  return buffer.toString('base64')
}

/** 剥掉 `data:image/png;base64,` 这类前缀，只留数据本身 */
function stripDataUri(value: string): string {
  return String(value || '')
    .trim()
    .replace(/^data:[^;,]*;base64,/i, '')
}

/** 从 data URI 里取回媒体类型；裸 base64 认不出来，按 png 处理 */
function mediaTypeOfDataUri(value: string): string {
  return String(value || '').match(/^data:([^;,]+);base64,/i)?.[1] || 'image/png'
}

/** 参考图整理成 `data:image/png;base64,...`；http(s) 直链原样放行 */
function toDataUri(value: string): string {
  const trimmed = String(value || '').trim()
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  return `data:${mediaTypeOfDataUri(trimmed)};base64,${stripDataUri(trimmed)}`
}

/** `1024x1024`。对不上格式就当没填，交给厂商用它自己的默认值 */
function asSize(value?: string): `${number}x${number}` | undefined {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
  return /^\d+x\d+$/.test(normalized) ? (normalized as `${number}x${number}`) : undefined
}

/** `16:9`。同上 */
function asAspectRatio(value?: string): `${number}:${number}` | undefined {
  const normalized = String(value || '').trim()
  return /^\d+:\d+$/.test(normalized) ? (normalized as `${number}:${number}`) : undefined
}

/** 调用方的取消信号与内部超时并联；没人给信号时就只有超时 */
function withTimeout(signal?: AbortSignal, timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

// ── 方舟的尺寸换算 ──────────────────────────────────────────────────────────

/**
 * 界面上的档位对应多少像素。
 *
 * 方舟自己也收 `2K` 这种档位字符串，但**每一代认的档位不一样**：4.0 是
 * 1K/2K/4K，4.5 是 2K/4K，5.0 lite 是 2K/3K。照着界面把 `1K` 发给 5.0
 * 就是一次 400。所以档位不直接发，只当**总像素预算**用，再连着比例一起
 * 换算成 `宽x高` —— 像素尺寸那条路三代都收，档位名的差异就不存在了。
 */
const ARK_TIER_PIXELS: Record<string, number> = {
  '1K': 1024 * 1024,
  '2K': 2048 * 2048,
  '3K': 3072 * 3072,
  '4K': 4096 * 4096
}

/**
 * 方舟对 `宽x高` 的总像素区间。
 *
 * 下限取的是 4.5 / 5.0 那一档（2560x1440）而不是 4.0 的 1280x720：取严的那个，
 * 三代都能过。代价是界面上的「1K」在方舟这边实际是 ~1.9K —— 厂商压根不给更小的，
 * 而超出区间换来的是一次彻底失败。
 */
const ARK_MIN_PIXELS = 2560 * 1440
const ARK_MAX_PIXELS = 4096 * 4096

/** 边长取 16 的整数倍：方舟推荐的那几个尺寸（2048/2304/1728/2560/1440/3024/1296）全是 */
function roundEdge(value: number): number {
  return Math.max(16, Math.round(value / 16) * 16)
}

/** `16:9` → [16, 9]。认不出来就当正方形 —— 方舟自己的默认也是方的 */
function sidesOfRatio(ratio?: string): [number, number] {
  const normalized = asAspectRatio(ratio)
  if (!normalized) return [1, 1]
  const [width, height] = normalized.split(':').map(Number)
  return width > 0 && height > 0 ? [width, height] : [1, 1]
}

/**
 * 档位 + 比例 → 方舟认识的 `宽x高`。
 *
 * 给的本来就是像素尺寸时**也要过一遍**：信息图那条路会传 `1024x1024`，
 * 那个值在 4.5 / 5.0 上低于总像素下限，直接发过去是 400。这里按原比例
 * 把它拉进合法区间，比让整次生成失败强。
 */
function arkSize(size?: string, ratio?: string): `${number}x${number}` | undefined {
  const explicit = asSize(size)
  const shape = explicit
    ? (explicit.split('x').map(Number) as [number, number])
    : sidesOfRatio(ratio)
  const tierKey = String(size || '')
    .trim()
    .toUpperCase()
  const tier = ARK_TIER_PIXELS[tierKey]
  // 只给了比例、没给档位时按 2K 算：那正是方舟自己的默认大小，于是「只改形状」
  // 这个唯一说出口的要求能生效，而不是连它一起丢掉
  const budget = explicit
    ? shape[0] * shape[1]
    : (tier ?? (asAspectRatio(ratio) ? ARK_TIER_PIXELS['2K'] : undefined))
  if (!budget) return undefined

  const target = Math.min(Math.max(budget, ARK_MIN_PIXELS), ARK_MAX_PIXELS)
  const scale = Math.sqrt(target / (shape[0] * shape[1]))
  let width = roundEdge(shape[0] * scale)
  let height = roundEdge(shape[1] * scale)

  // 取整那一步会把总像素挪动一点，贴着上下限时正好挤出区间。把长边挪回来 ——
  // 比例因此差不到 1%，而超区间是一次 400
  for (let guard = 0; guard < 64 && width * height > ARK_MAX_PIXELS; guard += 1) {
    if (width >= height) width -= 16
    else height -= 16
  }
  for (let guard = 0; guard < 64 && width * height < ARK_MIN_PIXELS; guard += 1) {
    if (width >= height) width += 16
    else height += 16
  }

  return `${width}x${height}`
}

// ── Gemini 的尺寸换算 ──────────────────────────────────────────────────────

/**
 * Gemini 只认这四档，`1024x1024` 这种像素尺寸发过去是一次 400。
 *
 * 界面既可能给档位（`2K`）也可能给像素尺寸（信息图那条路传的是 `1024x1024`），
 * 后者按**长边**就近归档 —— 归档比整次失败强，也比默默丢掉尺寸强。
 */
function geminiImageSize(size?: string): '512px' | '1K' | '2K' | '4K' | undefined {
  const tier = String(size || '')
    .trim()
    .toUpperCase()
  if (tier === '1K' || tier === '2K' || tier === '4K') return tier
  const pixels = asSize(size)
  if (!pixels) return undefined
  const edge = Math.max(...pixels.split('x').map(Number))
  if (edge <= 512) return '512px'
  if (edge <= 1536) return '1K'
  if (edge <= 3072) return '2K'
  return '4K'
}

/**
 * Gemini 认的比例是一份**固定清单**，不是任意 `宽:高`。
 *
 * 清单外的值（`7:3`）是一次 400。不在清单里就不发这一位，让它用默认的 1:1 ——
 * 比例不如预期是一张能用的图，400 是什么都没有。
 */
const GEMINI_ASPECT_RATIOS: ReadonlySet<string> = new Set([
  '1:1',
  '1:4',
  '1:8',
  '2:3',
  '3:2',
  '3:4',
  '4:1',
  '4:3',
  '4:5',
  '5:4',
  '8:1',
  '9:16',
  '16:9',
  '21:9'
])

// ── MiniMax 的尺寸换算 ─────────────────────────────────────────────────────

/**
 * MiniMax 认的比例是一份**固定清单**，每一档还对应一个固定像素尺寸
 * （`16:9` 就是 1280x720）。清单外的值是一次 2013 invalid parameters。
 *
 * @see https://platform.minimax.io/docs/api-reference/image-generation-t2i
 */
const MINIMAX_ASPECT_RATIOS: ReadonlySet<string> = new Set([
  '1:1',
  '16:9',
  '4:3',
  '3:2',
  '2:3',
  '3:4',
  '9:16',
  '21:9'
])

/** `width`/`height` 的硬区间：512–2048、8 的倍数，官方文档写明 */
const MINIMAX_MIN_EDGE = 512
const MINIMAX_MAX_EDGE = 2048

/** 界面档位在 MiniMax 这边能换到多少像素。4K 够不到 —— 长边封顶 2048，只能给到 2K */
const MINIMAX_TIER_PIXELS: Record<string, number> = {
  '1K': 1024 * 1024,
  '2K': 2048 * 2048,
  '4K': 2048 * 2048
}

function minimaxEdge(value: number): number {
  return Math.min(MINIMAX_MAX_EDGE, Math.max(MINIMAX_MIN_EDGE, Math.round(value / 8) * 8))
}

/**
 * 按总像素预算把形状换算成 MiniMax 认的 `width`/`height`。
 *
 * 先把缩放系数顶进区间再取整，而不是取整之后再裁：直接裁长边会把比例改掉，
 * 而这一位是用户唯一明确说出口的要求。
 */
function minimaxPixels(shape: [number, number], budget: number): { width: number; height: number } {
  const [shapeWidth, shapeHeight] = shape
  let scale = Math.sqrt(budget / (shapeWidth * shapeHeight))
  scale = Math.min(scale, MINIMAX_MAX_EDGE / Math.max(shapeWidth, shapeHeight))
  scale = Math.max(scale, MINIMAX_MIN_EDGE / Math.min(shapeWidth, shapeHeight))
  return { width: minimaxEdge(shapeWidth * scale), height: minimaxEdge(shapeHeight * scale) }
}

/**
 * 这次请求的尺寸怎么发：要么 `aspect_ratio` 一档，要么 `width`/`height` 一对。
 *
 * **两者不能同时发** —— 官方写明 `aspect_ratio` 优先，于是同时发等于界面上选的
 * 分辨率一声不响地失效（`16:9` 永远出 1280x720，选 2K 也一样）。所以能算出
 * 像素尺寸时就只发像素尺寸，让档位真的生效。
 *
 * `image-01-live` 例外：官方说 `width`/`height` 只对 `image-01` 生效，
 * 这一档只能走比例档。
 */
function minimaxSize(
  input: AdapterInput
): { aspect_ratio: string } | { width: number; height: number } | undefined {
  const ratio = asAspectRatio(input.aspectRatio)
  const ratioParam = ratio && MINIMAX_ASPECT_RATIOS.has(ratio) ? { aspect_ratio: ratio } : undefined
  if (/-live$/i.test(input.modelId)) return ratioParam

  const pixels = asSize(input.size)
  if (pixels) {
    const [width, height] = pixels.split('x').map(Number)
    if (width > 0 && height > 0) return minimaxPixels([width, height], width * height)
  }

  const tier =
    MINIMAX_TIER_PIXELS[
      String(input.size || '')
        .trim()
        .toUpperCase()
    ]
  if (tier && ratio) return minimaxPixels(sidesOfRatio(ratio), tier)
  if (tier) return minimaxPixels([1, 1], tier)
  return ratioParam
}

/**
 * MiniMax 把失败也回成 HTTP 200，错在 `base_resp` 里。
 *
 * 不单独认这一位的话，密钥错（1004）、余额不足（1008）、提示词被审核拦下（1026）
 * 全都表现为「厂商没有返回图片」—— 那一句让用户去改提示词，而前两种改一万遍
 * 也不会通。状态码一起带出来，用户照着官方文档一查就知道是哪一类。
 *
 * @see https://platform.minimax.io/docs/api-reference/image-generation-t2i
 */
export class MiniMaxImageError extends Error {
  constructor(
    readonly statusCode: number,
    detail: string
  ) {
    super(`MiniMax 生图失败（base_resp ${statusCode}）：${detail.slice(0, 30) || '没有给出说明'}`)
    this.name = 'MiniMaxImageError'
  }
}

// ── 适配器 ─────────────────────────────────────────────────────────────────

/** 已经归一化过的一次请求。适配器只管把它翻成自家文档里的那个形状 */
interface AdapterInput {
  modelId: string
  prompt: string
  /** 已经卡在 1..MAX_IMAGES_PER_CALL */
  count: number
  /** 界面给的原值：像素尺寸或 `1K`/`2K`/`4K` 档位 */
  size?: string
  aspectRatio?: string
  seed?: number
  /** data URI 或 http(s) 直链，已剔除空值 */
  references: string[]
  useReferenceUrls?: boolean
  useResolutionTiers?: boolean
}

/** 适配器拼出来的 HTTP 请求。路径相对 Provider 的 Base URL */
interface HttpRequest {
  path: string
  body: string | FormData
  /** FormData 不填：交给 fetch 自己带 boundary */
  contentType?: string
}

/** 响应里的一张图。两种形态：直接给 base64，或给一个要去取的地址 */
interface RawImage {
  base64?: string
  url?: string
  mediaType?: string
}

interface ImageAdapter {
  /** 这家的官方文档。要改下面的字段，先去看它 */
  doc: string
  /**
   * 密钥放在哪个请求头里，值是**裸密钥**。
   *
   * 不填就是 `Authorization: Bearer <key>` —— 除 Google 外每一家都是这个。
   * Google 的 API key 只认 `x-goog-api-key`（`Bearer` 那条路是给 OAuth 令牌的），
   * 发错了拿到的是 401，而 401 看上去像「密钥填错了」，会让人去反复换密钥。
   */
  apiKeyHeader?: string
  request(input: AdapterInput, signal: AbortSignal): Promise<HttpRequest>
  /** 按这家文档的响应形状取图。认不出来就回空数组，由上层报「一张都没回」 */
  images(payload: unknown): RawImage[]
  /**
   * 转成异步任务后最多等多久（从提交那一刻算）。不填按 TASK_TIMEOUT_MS。
   * 外面那个整次请求的信号会跟着放宽一分钟，见 generateImages。
   */
  taskTimeoutMs?: number
  /** 鉴权头之外每次都要带的头。Codex 后端要从令牌里解出来的账号 id，没法写死在配置里 */
  extraHeaders?(apiKey: string | undefined): Record<string, string>
  /** 响应体怎么读。不填就是 JSON；Codex 后端只回事件流 */
  parse?(raw: string): unknown
  /** 一次请求只出一张。要几张就并发几次，见 generateImages */
  onePerRequest?: boolean
}

// ── Codex 后端 ─────────────────────────────────────────────────────────────

/**
 * Codex 后端说这次没出图：事件流里报了错，或者模型只回了一段话。
 *
 * 后者多半是内容审核拦下了 —— 那段话就是原因，原样带出来（截短，理由同 ImageRequestError）。
 */
export class CodexImageError extends Error {
  constructor(detail: string) {
    super(`Codex 没有出图：${detail.trim().slice(0, 50) || '后端没有给出原因'}`)
    this.name = 'CodexImageError'
  }
}

/** 令牌里解不出账号 id。只可能是登录信息坏了，重新登录就好 */
export class CodexAccountMissingError extends Error {
  constructor() {
    super(`Codex 登录信息里没有账号 id，请到 ${IMAGE_CONFIG_ERROR_MARKER} 重新登录 Codex。`)
    this.name = 'CodexAccountMissingError'
  }
}

/** 令牌（JWT）里放账号信息的那一段。与 pi-ai 的 openai-codex 实现取的是同一处 */
const CODEX_AUTH_CLAIM = 'https://api.openai.com/auth'

function codexAccountId(token: string | undefined): string {
  try {
    const payload = JSON.parse(
      Buffer.from(String(token).split('.')[1] ?? '', 'base64url').toString('utf-8')
    ) as Record<string, { chatgpt_account_id?: unknown } | undefined>
    const id = payload[CODEX_AUTH_CLAIM]?.chatgpt_account_id
    if (typeof id === 'string' && id) return id
  } catch {
    // 不是 JWT：落到下面那句「重新登录」
  }
  throw new CodexAccountMissingError()
}

function gcd(a: number, b: number): number {
  return b === 0 ? a : gcd(b, a % b)
}

/**
 * 画面比例。Codex 的生图工具**不听 `size`**（实测发 2048x1152 回的是 1374x1145），
 * 但听提示词里写明的比例 —— 所以比例写进提示词，像素尺寸只用来推比例。
 */
function codexAspectRatio(input: AdapterInput): string | undefined {
  const ratio = asAspectRatio(input.aspectRatio)
  if (ratio) return ratio
  const pixels = asSize(input.size)
  if (!pixels) return undefined
  const [width, height] = pixels.split('x').map(Number)
  if (!width || !height) return undefined
  const divisor = gcd(width, height)
  return `${width / divisor}:${height / divisor}`
}

/**
 * 从事件流里取图。
 *
 * 图在 `response.output_item.done` 那一项（`type: image_generation_call`），`result` 是 base64。
 * 一张都没有时，模型回的那段话就是原因（多半是被审核拦了），连同 `response.failed` 一起抛出去 ——
 * 否则用户看到的是一句「厂商没有返回图片」，不知道该改提示词还是该换模型。
 */
function parseCodexImageStream(raw: string): { images: RawImage[] } {
  const images: RawImage[] = []
  let text = ''
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith('data:')) continue
    let event: {
      type?: unknown
      item?: { type?: unknown; result?: unknown; output_format?: unknown; content?: unknown }
      response?: { error?: { message?: unknown } }
      error?: { message?: unknown }
      message?: unknown
    }
    try {
      event = JSON.parse(line.slice(5))
    } catch {
      continue
    }
    if (event.type === 'response.failed' || event.type === 'error') {
      const detail = event.response?.error?.message ?? event.error?.message ?? event.message ?? ''
      throw new CodexImageError(String(detail))
    }
    if (event.type !== 'response.output_item.done') continue
    const item = event.item
    if (item?.type === 'image_generation_call' && typeof item.result === 'string' && item.result) {
      const format = typeof item.output_format === 'string' ? item.output_format : 'png'
      images.push({ base64: item.result, mediaType: `image/${format}` })
    } else if (item?.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content as { type?: unknown; text?: unknown }[]) {
        if (part?.type === 'output_text' && typeof part.text === 'string') text += part.text
      }
    }
  }
  if (images.length === 0 && text.trim()) throw new CodexImageError(text)
  return { images }
}

/** OpenAI 系的响应：`data[]` 里要么 b64_json 要么 url */
function openAiImages(payload: unknown): RawImage[] {
  const list = (payload as { data?: unknown })?.data
  if (!Array.isArray(list)) return []
  return list
    .map((item) => item as { b64_json?: unknown; url?: unknown })
    .map((item) => ({
      base64: typeof item.b64_json === 'string' ? item.b64_json : undefined,
      url: typeof item.url === 'string' ? item.url : undefined
    }))
    .filter((image) => image.base64 || image.url)
}

/** 参考图 → multipart 里的一个文件。http(s) 直链先取回来：edits 是文件字段，不收地址 */
async function toBlob(reference: string, signal: AbortSignal): Promise<Blob> {
  const isRemote = /^https?:\/\//i.test(reference)
  const base64 = isRemote ? await downloadAsBase64(reference, signal) : stripDataUri(reference)
  const mediaType = isRemote ? 'image/png' : mediaTypeOfDataUri(reference)
  return new Blob([Buffer.from(base64, 'base64')], { type: mediaType })
}

/**
 * OpenAI 官方 Images API，以及照着它实现的绝大多数兼容网关。
 *
 * 两个端点是**分开的**：纯文生图打 `/images/generations`，带参考图打
 * `/images/edits`（multipart，多张参考图用重复的 `image[]` 字段，最多 16 张）。
 *
 * @see https://platform.openai.com/docs/api-reference/images
 */
function openAiAdapter(options: { responseFormat: boolean }): ImageAdapter {
  return {
    doc: 'https://platform.openai.com/docs/api-reference/images',
    async request(input, signal) {
      const pixels = asSize(input.size)
      const size = input.useResolutionTiers
        ? (asAspectRatio(input.aspectRatio) ??
          (pixels ? getGptImageRatioForSize(pixels) : undefined))
        : pixels
      const tier = input.size?.trim().toUpperCase()
      const resolution = input.useResolutionTiers
        ? tier && ['1K', '2K', '4K'].includes(tier)
          ? tier.toLowerCase()
          : pixels
            ? getGptImageSizeTier(pixels).toLowerCase()
            : undefined
        : undefined

      if (input.references.length > 0 && !input.useReferenceUrls) {
        const form = new FormData()
        form.append('model', input.modelId)
        form.append('prompt', input.prompt)
        form.append('n', String(input.count))
        if (size) form.append('size', size)
        if (resolution) form.append('resolution', resolution)
        if (options.responseFormat) form.append('response_format', 'b64_json')
        for (const [index, reference] of input.references.entries()) {
          form.append('image[]', await toBlob(reference, signal), `reference-${index}.png`)
        }
        return { path: '/images/edits', body: form }
      }

      return {
        path: '/images/generations',
        contentType: 'application/json',
        body: JSON.stringify({
          model: input.modelId,
          prompt: input.prompt,
          n: input.count,
          ...(input.useReferenceUrls && input.references.length
            ? { image_urls: input.references }
            : {}),
          ...(size ? { size } : {}),
          ...(resolution ? { resolution } : {}),
          // gpt-image 全家永远回 base64，给了 response_format 就是 400 Unknown parameter
          ...(options.responseFormat ? { response_format: 'b64_json' } : {})
        })
      }
    },
    images: openAiImages
  }
}

const ADAPTERS: Record<ImageApi, ImageAdapter> = {
  'openai-images': openAiAdapter({ responseFormat: true }),
  'gpt-images': openAiAdapter({ responseFormat: false }),

  /**
   * xAI 的 grok-imagine。官方文档明说不支持 size / quality / style，
   * 也没有 edits 端点 —— 参考图在这一家是直接说不行，而不是发过去等 404。
   *
   * @see https://docs.x.ai/docs/guides/image-generations
   */
  'grok-images': {
    doc: 'https://docs.x.ai/docs/guides/image-generations',
    async request(input) {
      if (input.references.length > 0) throw new ImageReferenceUnsupportedError('grok-images')
      return {
        path: '/images/generations',
        contentType: 'application/json',
        body: JSON.stringify({
          model: input.modelId,
          prompt: input.prompt,
          n: input.count,
          response_format: 'b64_json'
        })
      }
    },
    images: openAiImages
  },

  /**
   * 硅基流动。自成一套字段名：张数是 `batch_size`、尺寸是 `image_size`，
   * 参考图是同一个端点里的 `image`（data URI），响应回的是 `images[].url`
   * 且**一小时后失效** —— 所以这一家必须当场取回来存成 base64。
   *
   * @see https://docs.siliconflow.cn/cn/api-reference/images/images-generations
   */
  'siliconflow-images': {
    doc: 'https://docs.siliconflow.cn/cn/api-reference/images/images-generations',
    async request(input) {
      const imageSize = asSize(input.size)
      return {
        path: '/images/generations',
        contentType: 'application/json',
        body: JSON.stringify({
          model: input.modelId,
          prompt: input.prompt,
          batch_size: input.count,
          ...(imageSize ? { image_size: imageSize } : {}),
          ...(typeof input.seed === 'number' ? { seed: input.seed } : {}),
          // 只有部分模型（Kolors 图生图、Qwen-Image-Edit 等）认这一位，
          // 不认的模型收到它是忽略，不是报错
          ...(input.references.length > 0 ? { image: toDataUri(input.references[0]) } : {})
        })
      }
    },
    images(payload) {
      const list = (payload as { images?: unknown })?.images
      if (!Array.isArray(list)) return []
      return list
        .map((item) => (item as { url?: unknown })?.url)
        .filter((url): url is string => typeof url === 'string')
        .map((url) => ({ url }))
    }
  },

  /**
   * 火山方舟 Seedream。
   *
   * 三处与 OpenAI 不一样，每一处踩错都是一次彻底失败：
   *
   * 1. **只有 `/images/generations` 一个端点**，参考图内联在 `image` 里
   *    （单张给字符串、多张给数组，最多 14 张）。按 OpenAI 那套打 `/images/edits`
   *    回的是一个空 body 的 404
   * 2. 张数不是 `n`，是 `sequential_image_generation` 那一对；单张要显式 `disabled`
   * 3. `size` 每一代认的档位不一样，所以换算成像素尺寸再发（见 arkSize）
   *
   * 另外 `watermark` 不传就是带水印，见下。
   *
   * @see https://docs.volcengine.com/docs/82379/1541523
   */
  'ark-images': {
    doc: 'https://docs.volcengine.com/docs/82379/1541523',
    async request(input) {
      const size = arkSize(input.size, input.aspectRatio)
      const references = input.references.map(toDataUri)
      return {
        path: '/images/generations',
        contentType: 'application/json',
        body: JSON.stringify({
          model: input.modelId,
          prompt: input.prompt,
          ...(size ? { size } : {}),
          response_format: 'b64_json',
          // 方舟默认给图右下角盖 AI 生成水印，且默认值每一代都可能不一样，
          // 所以每次都显式发 false —— 少发这一位，出来的素材直接没法用
          watermark: false,
          ...(typeof input.seed === 'number' ? { seed: input.seed } : {}),
          ...(references.length > 0
            ? { image: references.length === 1 ? references[0] : references }
            : {}),
          ...(input.count > 1
            ? {
                sequential_image_generation: 'auto',
                sequential_image_generation_options: { max_images: input.count }
              }
            : { sequential_image_generation: 'disabled' })
        })
      }
    },
    images: openAiImages
  },

  /**
   * Box Plan。形状贴近 OpenAI，三处不同：
   *
   * 1. 参考图放 JSON 的 `image_urls`，只收 **https 链接或 data URI** —— 不走 multipart、
   *    不先上传；http 直链先取回来转成 data URI
   * 2. `size` 收 `1K` / `2K` / `4K` 档位或 `宽x高`（服务端就近取档），比例单给 `aspect_ratio`
   * 3. 预计超过 60 秒的请求回 **202 任务单**（`{ id, status }`），轮询
   *    `GET /images/generations/{id}` —— 这正是上面那段异步任务后处理，状态词对得上；
   *    10 分钟内必定结束，所以任务上限放宽到 PLAN_TASK_TIMEOUT_MS
   *
   * 不带 `Idempotency-Key`：带了一律按任务处理，每张图都要多等至少一轮轮询；
   * 提交只对 429 重试（「没收下」），不存在重复扣费。
   *
   * 协议见 Box Plan 仓库 docs/protocol/04-images.md。
   */
  'uebox-images': {
    doc: 'docs/protocol/04-images.md（Box Plan）',
    taskTimeoutMs: PLAN_TASK_TIMEOUT_MS,
    async request(input, signal) {
      const references = await Promise.all(
        input.references.map(async (reference) => {
          const trimmed = reference.trim()
          if (/^https:\/\//i.test(trimmed)) return trimmed
          if (/^http:\/\//i.test(trimmed)) {
            return `data:image/png;base64,${await downloadAsBase64(trimmed, signal)}`
          }
          return toDataUri(trimmed)
        })
      )
      const tier = input.size?.trim().toUpperCase()
      const size = tier && ['1K', '2K', '4K'].includes(tier) ? tier : asSize(input.size)
      const aspectRatio = asAspectRatio(input.aspectRatio)
      return {
        path: '/images/generations',
        contentType: 'application/json',
        body: JSON.stringify({
          model: input.modelId,
          prompt: input.prompt,
          n: input.count,
          ...(size ? { size } : {}),
          ...(aspectRatio ? { aspect_ratio: aspectRatio } : {}),
          ...(references.length > 0 ? { image_urls: references } : {}),
          ...(typeof input.seed === 'number' ? { seed: input.seed } : {}),
          response_format: 'b64_json'
        })
      }
    },
    images(payload) {
      const list = (payload as { data?: unknown })?.data
      if (!Array.isArray(list)) return []
      return list
        .map((item) => item as { b64_json?: unknown; url?: unknown; mime_type?: unknown })
        .map((item) => ({
          base64: typeof item.b64_json === 'string' ? item.b64_json : undefined,
          url: typeof item.url === 'string' ? item.url : undefined,
          mediaType: typeof item.mime_type === 'string' ? item.mime_type : undefined
        }))
        .filter((image) => image.base64 || image.url)
    }
  },

  /**
   * Google 的 Nano Banana，走 Interactions API。
   *
   * 四处与这里其余每一家都不同：
   *
   * 1. 密钥在 `x-goog-api-key` 里，裸值（见 apiKeyHeader）
   * 2. **没有 prompt 字段**：提示词和参考图同在一个 `input` 数组里，各是一项。
   *    参考图要裸 base64，data URI 前缀和 http 直链都不收 —— 直链得自己先取回来
   * 3. 尺寸不是 `宽x高`，是 `image_size` 档位 + `aspect_ratio`，两者都只认固定值
   * 4. 响应里没有 `data[]`：官方 REST 直接回 Interaction 本身（顶层 `object: "interaction"`），
   *    图在 `steps[].content[]`，每项给 `data` 或 `uri`。有的网关外面再包一层
   *    `{ interaction }`、另给 `output_image`（SDK 的便利字段，REST 文档里没有），两种都认
   *
   * 不走 Google 那层 OpenAI 兼容地址（`/v1beta/openai/images/generations`）的原因：
   * 官方明说它只认 prompt / model / n / size / response_format，**参考图没有位置放**，
   * 其余参数「静默忽略」。而「拿一张图接着改」正是这个模型的主要用法 ——
   * 走兼容层的话，用户放的参考图会一声不响地消失。
   *
   * 一次只出一张：Interactions API 没有 `n` 这一位，界面上选的张数在这一家不生效。
   *
   * @see https://ai.google.dev/gemini-api/docs/image-generation
   */
  'gemini-images': {
    doc: 'https://ai.google.dev/gemini-api/docs/image-generation',
    apiKeyHeader: 'x-goog-api-key',
    async request(input, signal) {
      const references = await Promise.all(
        input.references.map(async (reference) => {
          const isRemote = /^https?:\/\//i.test(reference)
          if (input.useReferenceUrls && isRemote) return { type: 'image', uri: reference }
          return {
            type: 'image',
            mime_type: isRemote ? 'image/png' : mediaTypeOfDataUri(reference),
            data: isRemote ? await downloadAsBase64(reference, signal) : stripDataUri(reference)
          }
        })
      )
      const imageSize = geminiImageSize(input.size)
      const aspectRatio = asAspectRatio(input.aspectRatio)
      return {
        path: '/interactions',
        contentType: 'application/json',
        body: JSON.stringify({
          model: input.modelId,
          input: [{ type: 'text', text: input.prompt }, ...references],
          response_format: {
            type: 'image',
            ...(imageSize ? { image_size: imageSize } : {}),
            ...(aspectRatio && GEMINI_ASPECT_RATIOS.has(aspectRatio)
              ? { aspect_ratio: aspectRatio }
              : {})
          }
        })
      }
    },
    images(payload) {
      // 官方 REST 不包这一层（https://ai.google.dev/api/interactions-api），有的网关包
      const interaction =
        (payload as { interaction?: Record<string, unknown> } | null)?.interaction ??
        (payload as Record<string, unknown> | null)
      if (!interaction || typeof interaction !== 'object') return []

      const pick = (item: unknown): RawImage | null => {
        const part = item as { data?: unknown; uri?: unknown; mime_type?: unknown } | null
        const mediaType = typeof part?.mime_type === 'string' ? part.mime_type : undefined
        if (typeof part?.data === 'string' && part.data) return { base64: part.data, mediaType }
        if (typeof part?.uri === 'string' && part.uri) return { url: part.uri, mediaType }
        return null
      }

      // steps 里是「说一句、出一张」的完整序列，output_image 只有最后一张。
      // 先取 steps，两处都空才算一张都没回。
      //
      // `thought` 那一步跳过：模型思考时会先画至多两张草稿试构图（官方说不计费），
      // 那不是成品。混进来就是「要 1 张回 2 张」，用户以为多扣了一张（2026-10-09 反馈）
      const fromSteps = (Array.isArray(interaction.steps) ? interaction.steps : [])
        .filter((step) => (step as { type?: unknown })?.type !== 'thought')
        .flatMap((step) => {
          const content = (step as { content?: unknown })?.content
          return Array.isArray(content) ? content : []
        })
        .filter((part) => (part as { type?: unknown })?.type === 'image')
        .map(pick)
        .filter((image): image is RawImage => image !== null)
      if (fromSteps.length > 0) return fromSteps

      const single = pick(interaction.output_image)
      return single ? [single] : []
    }
  },

  /**
   * MiniMax（海螺）。与这里其余每一家的 `/images/generations` 有四处不同：
   *
   * 1. **端点是 `/image_generation`**，文生图和图生图同一个，没有 `/images/edits`
   * 2. 尺寸要么 `aspect_ratio` 八档、要么 `width`/`height` 一对，两者同时发时
   *    比例优先 —— 所以只发一种，见 minimaxSize
   * 3. 参考图放 `subject_reference`，**一次只收一张**，且只认 `type: "character"`：
   *    它做的是「保住这个人物的长相」，不是通用的图生图重绘
   * 4. 失败是 **HTTP 200 + `base_resp.status_code`**，所以响应里要先验这一位，
   *    否则密钥错和余额不足都会表现成「厂商没有返回图片」
   *
   * `response_format` 显式发 `base64`：默认是 `url`，而那个地址 24 小时后失效 ——
   * 落进资产库的图不能指着一个会过期的地址。
   *
   * `prompt_optimizer` 不发（默认 false）：它会背着用户改写提示词，出的图
   * 和他写的那句话不是一件事。
   *
   * @see https://platform.minimax.io/docs/api-reference/image-generation-t2i
   * @see https://platform.minimax.io/docs/api-reference/image-generation-i2i
   */
  'minimax-images': {
    doc: 'https://platform.minimax.io/docs/api-reference/image-generation-t2i',
    async request(input) {
      const size = minimaxSize(input)
      return {
        path: '/image_generation',
        contentType: 'application/json',
        body: JSON.stringify({
          model: input.modelId,
          prompt: input.prompt,
          n: input.count,
          response_format: 'base64',
          ...(size ?? {}),
          ...(typeof input.seed === 'number' ? { seed: input.seed } : {}),
          ...(input.references.length > 0
            ? {
                subject_reference: [
                  { type: 'character', image_file: toDataUri(input.references[0]) }
                ]
              }
            : {})
        })
      }
    },
    images(payload) {
      const status = (payload as { base_resp?: { status_code?: unknown; status_msg?: unknown } })
        ?.base_resp
      if (typeof status?.status_code === 'number' && status.status_code !== 0) {
        throw new MiniMaxImageError(status.status_code, String(status.status_msg ?? ''))
      }

      const data = (payload as { data?: { image_base64?: unknown; image_urls?: unknown } })?.data
      const base64 = Array.isArray(data?.image_base64) ? data.image_base64 : []
      const urls = Array.isArray(data?.image_urls) ? data.image_urls : []
      return [
        ...base64
          .filter((item): item is string => typeof item === 'string' && item.length > 0)
          // 官方示例把回来的数据写成 .jpeg，不是 png
          .map((item) => ({ base64: item, mediaType: 'image/jpeg' })),
        ...urls
          .filter((item): item is string => typeof item === 'string' && item.length > 0)
          .map((item) => ({ url: item, mediaType: 'image/jpeg' }))
      ]
    }
  },

  /**
   * ChatGPT 订阅的 Codex 后端，也就是 Codex CLI 出图走的那条路。
   *
   * 这里没有 `/images/*` 端点，出图是 Responses 的 `image_generation` 工具：
   * 用 `tool_choice` 强制它调一次，从事件流里把图取出来。额度算在用户的 ChatGPT
   * 订阅里，不另外按张计费。
   *
   * 与 Responses API 文档对不上的几处，都是这个后端自己的规矩（见 aiProvider.ts 的协议注释）：
   * 必须带 `chatgpt-account-id`、只收 `stream: true`、只收 `store: false`。
   *
   * 能控制的只有比例（写进提示词，见 codexAspectRatio）；像素尺寸和画质由后端定，
   * 发了也不听。一次请求只出一张图。
   *
   * @see https://platform.openai.com/docs/guides/tools-image-generation
   */
  'codex-images': {
    doc: 'https://platform.openai.com/docs/guides/tools-image-generation',
    onePerRequest: true,
    extraHeaders: (apiKey) => ({
      'chatgpt-account-id': codexAccountId(apiKey),
      'OpenAI-Beta': 'responses=experimental',
      // 与登录时报的请求方一致（oauth.ts）
      originator: 'unreal-box',
      Accept: 'text/event-stream'
    }),
    async request(input, signal) {
      const references = await Promise.all(
        input.references.map(async (reference) => {
          const trimmed = reference.trim()
          const url = /^https?:\/\//i.test(trimmed)
            ? `data:image/png;base64,${await downloadAsBase64(trimmed, signal)}`
            : toDataUri(trimmed)
          return { type: 'input_image', image_url: url }
        })
      )
      const ratio = codexAspectRatio(input)
      const text = ratio ? `${input.prompt}\n\nAspect ratio: ${ratio}.` : input.prompt
      return {
        path: '/responses',
        contentType: 'application/json',
        body: JSON.stringify({
          model: input.modelId,
          instructions:
            'Generate exactly one image with the image_generation tool, following the user prompt ' +
            'and any attached reference images. Do not reply with text.',
          input: [{ role: 'user', content: [{ type: 'input_text', text }, ...references] }],
          tools: [{ type: 'image_generation', output_format: 'png' }],
          tool_choice: { type: 'image_generation' },
          store: false,
          stream: true
        })
      }
    },
    parse: parseCodexImageStream,
    images: (payload) => (payload as { images?: RawImage[] })?.images ?? []
  }
}

/**
 * 这个模型走哪个适配器。
 *
 * 两级：模型自己声明的 `imageApi`（内置目录里每条生图模型都写了）优先，
 * 没有声明时按模型名兜一次 —— 用户手填的、「导入模型」拉回来的、以及
 * `imageApi` 这一位加进来**之前**就存在 models.json 里的那些都没有这一位，
 * 少了这级兜底，存量用户升级之后会原地退化。
 */
function resolveImageApi(provider: ProviderConfig, modelId: string): ImageApi {
  // Codex 后端只有这一种出图方式，手填的模型没写 imageApi 也不该去打 /images/generations
  if (provider.protocol === 'openai-codex-responses') return 'codex-images'
  const declared = provider.models.find((model) => model.id === modelId)?.imageApi
  if (declared) return declared
  // MiniMax 官方域名下压根没有 /images/generations，只有 /image_generation ——
  // 这是 Provider 级的事实（按模型名猜不出来，见 guessImageApi 的注释），
  // 手填地址的用户少了这一级会一路打到 404
  if (isMiniMaxHost(provider.baseUrl)) return 'minimax-images'
  return guessImageApi(modelId)
}

/**
 * 这个地址是不是 MiniMax 官方站。
 *
 * 只认官方的三个域名，不认聚合网关：OpenRouter 这类转发 MiniMax 时用的是
 * OpenAI 形状，按 MiniMax 的端点打过去是 404。国内站 minimaxi.com / minimax.cn
 * 与国际站 minimax.io 的 Key 不通用，但端点形状一样。
 */
function isMiniMaxHost(baseUrl: string): boolean {
  let host: string
  try {
    host = new URL(baseUrl).hostname.toLowerCase()
  } catch {
    return false
  }
  return /(^|\.)minimaxi?\.(com|cn|io|chat)$/.test(host)
}

/**
 * 没有声明时按模型名猜。
 *
 * 只猜**厂商的硬规则**，不猜可选行为：gpt-image 全家不接受 `response_format`、
 * xAI 的 grok-imagine 不接受 `size`、方舟没有 `/images/edits`，都写在各自
 * 文档里，猜错的代价是整次生成失败，猜对几乎没有成本。
 *
 * **Nano Banana 故意不在这里猜。** 上面三条猜错只是参数不对，这一条猜错是端点
 * 和鉴权头一起换，401 叠 404。而 `gemini-*-image` 这个名字在聚合平台上同样常见
 * （OpenRouter 的 `google/gemini-3.1-flash-image`），那些转发的是 OpenAI 形状，
 * 不是 Interactions API —— 按名字猜会把这批用户直接打死。内置目录里的 Google
 * 条目已经显式写了 `imageApi`，用不着猜；手填的一律按通用形状走，那也正是
 * 代理真正提供的东西。
 *
 * 前缀带斜杠是因为网关会给模型名加厂商前缀（`openai/gpt-image-2`）。
 */
function guessImageApi(modelId: string): ImageApi {
  if (/(^|\/)gpt-image/i.test(modelId)) return 'gpt-images'
  if (/(^|\/)grok-imagine/i.test(modelId)) return 'grok-images'
  if (/seedream|seededit/i.test(modelId)) return 'ark-images'
  return 'openai-images'
}

/**
 * 取这个接口的适配器。
 *
 * models.json 是用户可以直接编辑的：写了个表里没有的值就按通用形状走，
 * 而不是拿着 undefined 去查字段名然后在半路崩掉。
 */
function adapterOf(api: ImageApi): ImageAdapter {
  return ADAPTERS[api] ?? ADAPTERS['openai-images']
}

/**
 * 能出图的协议。不在这里的那几种根本没有生图能力，打过去只会得到一句厂商的 404。
 * Codex 后端没有生图端点，但有生图工具，走的是 codex-images 适配器
 */
const PROTOCOLS_WITH_IMAGES: readonly ProviderProtocol[] = [
  'openai-completions',
  'openai-responses',
  'openai-codex-responses'
]

/** 响应体像不像一个网页。网关的错误页、登录页、404 页都是这个形状 */
function looksLikeHtml(body: string): boolean {
  return /^\s*(?:<!doctype\s+html|<html|<\?xml|<head|<body)/i.test(body)
}

/**
 * 从厂商的错误响应里挖出那句人话。挖不到就用原文（上层会截断）。
 *
 * HTML 单独认一下：截断到 40 字的 `<!DOCTYPE html><html><head><ti` 对谁都没有意义，
 * 而「返回的是网页不是 JSON」本身就指向了原因 —— 地址指错了，或者这个端点在
 * 这家网关上不存在。
 */
function describeError(body: string): string {
  if (looksLikeHtml(body)) return '返回的是 HTML 网页而不是 JSON'
  try {
    const payload = JSON.parse(body) as {
      error?: { message?: unknown; code?: unknown }
      message?: unknown
    }
    const message = payload.error?.message ?? payload.message ?? payload.error?.code
    if (typeof message === 'string' && message.trim()) return message.trim()
  } catch {
    // 不是 JSON 也不是 HTML：空 body、纯文本错误都会走到这
  }
  return body.trim().slice(0, 200)
}

/** Multipart file upload contract: https://docs.toapis.com/docs/cn/api-reference/uploads/images */
async function uploadReferences(
  provider: ProviderConfig,
  references: string[],
  apiKey: string | undefined,
  signal: AbortSignal
): Promise<string[]> {
  const endpoint = provider.imageUploadUrl!.trim()
  let url: URL
  try {
    url = new URL(endpoint)
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('Invalid URL')
    }
  } catch {
    throw new Error('上传接口地址无效，请在设置 → 模型填写完整的 HTTP(S) 地址。')
  }
  const headers: Record<string, string> = {
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...provider.headers
  }
  // fetch must supply the multipart boundary, even if custom headers specify JSON.
  for (const key of Object.keys(headers)) {
    if (['content-type', 'content-length'].includes(key.toLowerCase())) delete headers[key]
  }
  const uploaded: string[] = []
  for (const reference of references) {
    signal.throwIfAborted()
    const trimmed = reference.trim()
    if (/^https?:\/\//i.test(trimmed)) {
      uploaded.push(trimmed)
      continue
    }
    const blob = await prepareReferenceUpload(await toBlob(trimmed, signal), signal)
    const extension = blob.type.split('/')[1]?.replace(/[^a-z0-9]/gi, '') || 'png'
    const form = new FormData()
    form.append('file', blob, `reference-${uploaded.length}.${extension}`)
    const response = await fetch(url.href, {
      method: 'POST',
      headers,
      body: form,
      signal
    })
    if (!response.ok) {
      throw new Error(
        `参考图上传失败 HTTP ${response.status}：${describeError(await response.text()).slice(0, 40)}`
      )
    }
    let payload: { success?: boolean; data?: { url?: unknown } }
    try {
      payload = await response.json()
    } catch {
      throw new Error('参考图上传失败：上传接口返回的不是 JSON。')
    }
    const imageUrl = payload?.data?.url
    if (payload?.success === false || typeof imageUrl !== 'string') {
      throw new Error('参考图上传失败：上传接口没有返回有效的 data.url。')
    }
    try {
      const parsed = new URL(imageUrl)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Invalid URL')
    } catch {
      throw new Error('参考图上传失败：返回的图片 URL 无效。')
    }
    uploaded.push(imageUrl)
  }
  return uploaded
}

/** 值得再试一次的：限流和厂商侧的临时故障。其余（4xx）再试也是同一个结果 */
function isRetryable(status: number): boolean {
  return status === 429 || status >= 500
}

/**
 * Provider 的根地址，去掉末尾斜杠。
 *
 * 「https://api.example.com/v1/」是粘贴时最自然的写法，而适配器给的路径一律
 * 以 `/` 开头 —— 直接拼出来是 `/v1//images/generations`。宽容的网关会忽略它，
 * 按精确路径路由的那些直接 404，而那个 404 看上去像「模型名写错了」。
 */
function baseUrlOf(provider: ProviderConfig): string {
  return provider.baseUrl.replace(/\/+$/, '')
}

// ── 异步任务式的网关 ───────────────────────────────────────────────────────

/**
 * 鉴权头。提交和轮询要发的是同一份，所以抽出来 —— 两边各写一遍，
 * 漏掉 `provider.headers` 的那一边会在做了 bot 检测的网关上莫名其妙地 403。
 */
function authHeaders(
  provider: ProviderConfig,
  adapter: ImageAdapter,
  apiKey: string | undefined
): Record<string, string> {
  return {
    // 本机推理与自建网关通常不校验密钥，没有就不发这个头
    ...(apiKey
      ? adapter.apiKeyHeader
        ? { [adapter.apiKeyHeader]: apiKey }
        : { Authorization: `Bearer ${apiKey}` }
      : {}),
    ...adapter.extraHeaders?.(apiKey),
    ...provider.headers
  }
}

/** 异步任务式网关的一次任务快照 */
interface ImageTask {
  id: string
  /** 已归一化成小写。`queued` / `in_progress` / `completed` / `failed` */
  status: string
  /** 完成时图在这下面，形状与同步响应的顶层一样（`data[]`） */
  result?: unknown
  /** 失败时厂商给的那句话。没有就是空串 */
  error: string
}

const TASK_DONE = new Set(['completed', 'succeeded', 'success'])
const TASK_FAILED = new Set(['failed', 'error', 'cancelled', 'canceled'])

/**
 * 这个 200 响应是不是一张「任务单」而不是图。
 *
 * 判据就两条：**有任务号、有状态**。不额外要求 `object === 'generation.task'` ——
 * 中转站之间互相抄得并不齐，而这个函数只在「一张图都没解析出来」之后才被调用：
 * 认错的代价是多打一次 404（而且报错里写着打的是哪个地址），认不出的代价是
 * 用户明明已经付过钱，却收到一句「厂商没有返回图片」。
 */
function asImageTask(payload: unknown): ImageTask | null {
  const data = payload as { id?: unknown; status?: unknown; result?: unknown; error?: unknown }
  if (typeof data?.id !== 'string' || !data.id) return null
  if (typeof data?.status !== 'string' || !data.status) return null
  const message = (data.error as { message?: unknown } | undefined)?.message
  return {
    id: data.id,
    status: data.status.toLowerCase(),
    result: data.result,
    error: typeof message === 'string' ? message : typeof data.error === 'string' ? data.error : ''
  }
}

/** 等一会儿。用户按停止时立刻醒过来，而不是把这 5 秒走完 */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 提交只拿到一个任务号时，把图轮询回来。
 *
 * toapis 这一类中转站的 `/images/generations` **请求体与 OpenAI 一模一样**，
 * 只有 200 响应换成了 `{ id, object: 'generation.task', status: 'queued' }` ——
 * 里面一张图都没有。不认这个形状的话，用户看到的是「厂商没有返回图片」，
 * 而真相是图正在画，并且钱已经扣了。
 *
 * **为什么不做成高级设置里的一个开关**：这件事写在响应里 —— 有任务号、有状态、
 * 没有图，三者同时成立就只可能是这一类。让用户去勾一个他无从判断的开关，
 * 等于把「读懂厂商文档」这件事转嫁给他；而勾错的那一半人会拿到一句同样难懂的
 * 报错。同一个 Provider 下的另外两位（`imageResolutionTiers` / `imageUploadUrl`）
 * 之所以必须是设置，是因为那两件事**在发请求之前**就要知道，响应里看不出来。
 *
 * 轮询端点是全站通用的一个，与提交用的是哪个端点无关（`/images/edits` 提交的
 * 任务同样在这里查），所以路径写死而不是从提交路径拼。
 *
 * @see https://docs.toapis.com/docs/cn/api-reference/tasks/image-status
 */
async function awaitImageTask(
  provider: ProviderConfig,
  adapter: ImageAdapter,
  task: ImageTask,
  apiKey: string | undefined,
  signal: AbortSignal,
  /** 从**提交那一刻**算起的截止时刻，不是从这里算起，见 TASK_TIMEOUT_MS */
  deadline: number
): Promise<RawImage[]> {
  const path = `/images/generations/${encodeURIComponent(task.id)}`
  const url = `${baseUrlOf(provider)}${path}`
  const headers = authHeaders(provider, adapter, apiKey)

  let current = task
  let delay = TASK_POLL_INTERVAL_MS
  let consecutiveFailures = 0
  for (;;) {
    if (TASK_FAILED.has(current.status)) throw new ImageTaskFailedError(task.id, current.error)
    // 完成时图在 `result` 下面，但那一层的形状与同步响应的顶层一样，
    // 所以交给这家自己的解析器，不为它另写一份取图逻辑
    if (TASK_DONE.has(current.status)) return adapter.images(current.result)

    /*
     * 剩余时间既是「还等不等」的判据，也是这一觉的**上限**。
     *
     * 少了这个上限，一句 `Retry-After: 3600` 就能让我们睡过整个 deadline ——
     * 最后开火的是外面那个五分钟的信号，抛出来的是光秃秃的 AbortError，
     * 任务号也跟着没了。睡满剩余时间之后还会再查最后一次才放弃。
     */
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new ImageTaskTimeoutError(task.id, adapter.taskTimeoutMs ?? TASK_TIMEOUT_MS)
    }

    try {
      await sleep(Math.min(delay + Math.random() * TASK_POLL_JITTER_MS, remaining), signal)
      delay = TASK_POLL_INTERVAL_MS

      // 单次查询自己的超时。网关把连接收下却不回话时，只有它能让我们回到
      // 循环顶上去重试，而不是挂到外面那个五分钟的信号开火
      const response = await fetch(url, {
        headers,
        signal: withTimeout(signal, TASK_POLL_TIMEOUT_MS)
      })
      if (response.status === 429) {
        // 限流。厂商说了等多久就等多久 —— 照原节奏问下去只会被越限越死。
        // body 要读掉：不读的话这条连接要等 GC 才释放，越限越死的正是它
        await response.text().catch(() => '')
        const seconds = Number(response.headers.get('retry-after'))
        delay = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : TASK_POLL_INTERVAL_MS * 2
        continue
      }
      if (!response.ok) {
        const text = await response.text()
        const planError = isPlanProvider(provider.id)
          ? planCallError(response.status, text, response.headers)
          : null
        if (planError) throw planError
        throw new ImageRequestError(response.status, path, describeError(text), url, 'GET')
      }

      let payload: unknown
      try {
        payload = JSON.parse(await response.text())
      } catch {
        throw new ImageResponseNotJsonError(path, url, 'GET')
      }
      const next = asImageTask(payload)
      /*
       * 查询端点回了一个不带任务号的东西：厂商改了响应结构，再问下去也是同一份。
       *
       * 这里**不能**抛 ImageGenerationEmptyError —— 那一句让用户「换个提示词再试」，
       * 而提示词在这里是清白的，照做就是再付一次钱。
       */
      if (!next) throw new ImageTaskInterruptedError(task.id, '查询响应里没有任务号')
      current = next
      consecutiveFailures = 0
    } catch (error) {
      // 用户按了停止：任务还在跑、钱已经扣了，任务号必须活着出来
      if (signal.aborted) throw new ImageTaskCancelledError(task.id)
      // 这几种是「问清楚了，就是这个结果」，再问一次还是同一份
      if (
        error instanceof CreatorPlanCallError ||
        error instanceof ImageTaskInterruptedError ||
        error instanceof ImageResponseNotJsonError ||
        (error instanceof ImageRequestError && !isRetryable(error.status))
      ) {
        throw error
      }
      /*
       * 剩下的都是「这一次没查到」：单次超时、5xx、连接抖动。
       * 提交之后钱已经扣了、任务也在厂商那边跑着，为这个把图判死刑最不划算 ——
       * 熬着，熬不过 TASK_POLL_FAILURE_TOLERANCE 次再说查询这端断了。
       */
      consecutiveFailures += 1
      if (consecutiveFailures >= TASK_POLL_FAILURE_TOLERANCE) {
        throw new ImageTaskInterruptedError(
          task.id,
          error instanceof Error ? error.message : String(error)
        )
      }
    }
  }
}

/**
 * 发请求、按适配器解析、把图片地址取回来。
 *
 * 重试只做一次，且只对限流与 5xx —— 生图一次几秒到几分钟，盲目重试等于
 * 让用户多等一倍时间再看到同一句报错。
 */
async function send(
  provider: ProviderConfig,
  adapter: ImageAdapter,
  input: AdapterInput,
  signal: AbortSignal
): Promise<GeneratedImageData[]> {
  const apiKey = await resolveApiKey(provider.apiKey)
  if (provider.imageUploadUrl?.trim() && input.references.length) {
    input = {
      ...input,
      references: await uploadReferences(provider, input.references, apiKey, signal),
      useReferenceUrls: true
    }
  }
  const request = await adapter.request(input, signal)
  const url = `${baseUrlOf(provider)}${request.path}`

  /*
   * 异步任务的截止时刻从**这里**起算，也就是第一次提交发出去之前的一瞬。
   *
   * 不能放在函数开头：传四张 8MB 参考图时 `uploadReferences` 要压缩再逐张上传，
   * 几十秒是常事，而那段时间厂商还没开始画。从函数开头算的话，这笔时间是从
   * 任务预算里扣的 —— 一次本来 180 秒能画完的 4K 图会被我们提前判超时，
   * 而钱在提交那一刻就已经扣了。留给外面那个 300 秒信号的 60 秒余量也会一起没掉。
   */
  const deadline = Date.now() + (adapter.taskTimeoutMs ?? TASK_TIMEOUT_MS)

  let response: Response | null = null
  for (let attempt = 0; attempt < 2; attempt += 1) {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        ...(request.contentType ? { 'Content-Type': request.contentType } : {}),
        ...authHeaders(provider, adapter, apiKey)
      },
      body: request.body,
      signal
    })
    /*
     * 只对 **429** 重试，不对 5xx 重试。
     *
     * 429 是「没收下」，重试是安全的。5xx 不是：异步任务式网关的边缘代理完全
     * 可能在**后端已经建好任务并扣了钱之后**才回 502。这时重试就是再付一次全款，
     * 而第一个任务号我们从头到尾没见过 —— 它既不在界面上，也进不了
     * `ImageTaskTimeoutError` 那条「拿任务号去厂商取回」的补救路径，是笔纯废钱。
     *
     * 代价是同步厂商偶发 5xx 时少一次自动重试：那种情况用户重来一次就行，
     * 而且他知道自己重来了。
     */
    if (response.ok || response.status !== 429 || attempt === 1) break
    // 套餐的每日上限也是 429，但要等到明天：再发一次只是白挨一次拒
    if (isPlanProvider(provider.id) && (await isDailyLimitResponse(response))) break
    await sleep(1000, signal)
  }

  if (!response) throw new ImageGenerationEmptyError()
  if (!response.ok) {
    const text = await response.text()
    // 套餐来源的 402 / 403 / 401：说清去哪儿处理，别只报一句 HTTP 402
    const planError = isPlanProvider(provider.id)
      ? planCallError(response.status, text, response.headers)
      : null
    if (planError) throw planError
    throw new ImageRequestError(response.status, request.path, describeError(text), url)
  }

  // 200 但不是 JSON：网关把请求接住了、回了自己的页面。直接 `response.json()`
  // 抛的是一句 `Unexpected token '<'`，看不出是谁、也看不出打的哪个地址
  const raw = await response.text()
  let payload: unknown
  if (adapter.parse) {
    payload = adapter.parse(raw)
  } else {
    try {
      payload = JSON.parse(raw)
    } catch {
      throw new ImageResponseNotJsonError(request.path, url)
    }
  }

  let images = adapter.images(payload)
  // 一张图都没有，但响应里有任务号：这是异步任务式的网关，图还在画
  if (images.length === 0) {
    const task = asImageTask(payload)
    if (task) images = await awaitImageTask(provider, adapter, task, apiKey, signal, deadline)
  }
  if (images.length === 0) throw new ImageGenerationEmptyError()

  return Promise.all(
    images.map(async (image) => ({
      base64: image.base64 ?? (await downloadAsBase64(image.url!, signal)),
      mediaType: image.mediaType || 'image/png'
    }))
  )
}

/**
 * 按当前绑定的生图模型出图。
 *
 * @throws {ImageModelNotConfiguredError} 没有绑定生图模型
 * @throws {ImageProtocolUnsupportedError} 绑定的 Provider 用的协议没有生图接口
 * @throws {ImageRequestError} 厂商把请求打回来了
 * @throws {MissingApiKeyError} 绑定存在但密钥取不到
 */
export async function generateImages(
  request: GenerateImagesRequest
): Promise<GeneratedImageData[]> {
  const { provider, modelId } = await resolveImageBinding(request)
  if (!PROTOCOLS_WITH_IMAGES.includes(provider.protocol)) {
    throw new ImageProtocolUnsupportedError(provider.protocol)
  }

  const imageApi = resolveImageApi(provider, modelId)
  const adapter = adapterOf(imageApi)
  const references = (request.referenceImages ?? []).filter(Boolean)
  if (
    (imageApi === 'siliconflow-images' || imageApi === 'minimax-images') &&
    references.length > 1
  ) {
    throw new Error(
      `当前 ${imageApi} 接入只会发送一张参考图，但本次提供了多张。尚未提交生成；` +
        '请改用支持多图的接入，或由用户明确选择一张。不要自行丢弃其余参考图。'
    )
  }
  // 套餐的张数上限在清单里（max_images），超了服务端回 400；按惯例截到上限而不是报错
  const planMax =
    imageApi === 'uebox-images' ? specLimit(await cachedPlanSpec('image'), 'max_images') : undefined
  const input: AdapterInput = {
    modelId,
    prompt: request.prompt,
    count: Math.min(
      Math.max(1, Math.floor(request.count ?? 1)),
      planMax ?? MAX_IMAGES_PER_CALL,
      MAX_IMAGES_PER_CALL
    ),
    size: request.size,
    aspectRatio: request.aspectRatio,
    seed: request.seed,
    references,
    useResolutionTiers: provider.imageResolutionTiers === true
  }

  const signal = withTimeout(
    request.signal,
    adapter.taskTimeoutMs ? adapter.taskTimeoutMs + 60_000 : REQUEST_TIMEOUT_MS
  )
  if (!adapter.onePerRequest || input.count === 1) return send(provider, adapter, input, signal)

  /*
   * 一次只出一张的后端：要几张就并发几次。
   *
   * 用 allSettled 而不是 all：四张里挂了一张，另外三张的额度已经花了，
   * 不能因为那一张把它们一起扔掉。全挂了才报错，报第一个原因。
   */
  const results = await Promise.allSettled(
    Array.from({ length: input.count }, () =>
      send(provider, adapter, { ...input, count: 1 }, signal)
    )
  )
  const images = results.flatMap((result) => (result.status === 'fulfilled' ? result.value : []))
  if (images.length > 0) return images
  throw (results[0] as PromiseRejectedResult).reason
}

export interface ImageModelStatus {
  /** 有没有可用的生图绑定 */
  configured: boolean
  /**
   * 形如 `ollama:flux-1-schnell`。
   *
   * 界面拿它回答「这张图到底是谁画的」—— AI 创作里那个模型下拉列的是官方的
   * 模型，社区版实际用的却是用户自己绑的那个，不显示出来的话，
   * 界面等于在说一件不存在的事。
   */
  model: string | null
}

/**
 * 当前的生图配置。界面据此决定显示生成按钮还是显示引导。
 *
 * 与 isEmbeddingConfigured 一样只看绑定、**不发请求** —— 它会被每次打开
 * AI 创作时调用，真去 ping 一次厂商就成了一个隐形的流量与延迟问题。
 */
export async function getImageModelStatus(): Promise<ImageModelStatus> {
  try {
    const settings = await readSettings()
    const binding = settings.roles.image
    if (!binding) return { configured: false, model: null }

    const provider = settings.providers.find((item) => item.id === binding.providerId)
    if (!provider) return { configured: false, model: null }

    return { configured: true, model: `${provider.displayName}:${binding.modelId}` }
  } catch {
    return { configured: false, model: null }
  }
}
