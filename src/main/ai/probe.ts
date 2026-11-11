import type { Tool } from '@earendil-works/pi-ai'
import type { TSchema } from 'typebox'

import type { ModelCheckup } from '../../shared/agentTeam'
import {
  looksLikeEmbeddingModelId,
  type ProbeCaveat,
  type ProbeFailure,
  type ProbeSkipCode,
  type ProviderProtocol
} from '../../shared/aiProvider'
import { CODEBUDDY_ORIGIN } from './codebuddy'
import { resolveApiKey } from './credentials'
import { requestEmbeddings } from './embedding'
import { requestJudgement } from './judge'
import { requestSpeech } from './speech'
import { probeStt } from './stt'
import { complete, completeText, resolveModel, userMessage } from './piCompletion'
import type { ModelConfig, ProviderConfig } from './types'

/**
 * Provider 探测：连通性测试与模型列表拉取。
 *
 * 与 resolveModel 分开是因为职责不同 —— 这里处理的是**用户还没保存**的草稿
 * 配置（在设置界面点「测试」时），拿到的是一份临时 ProviderConfig，
 * 不经过 models.json。
 */

/** 探测是用户盯着界面等结果的事，不能像正式调用那样给 120 秒 */
const PROBE_TIMEOUT_MS = 30_000

/**
 * 这个模型该按向量化探测吗。
 *
 * Provider 的用途说了算。只有 chat 用途的自建网关才按 id 特征词兜底 ——
 * 那种情况下用户可能把一个向量化模型挂在了通用网关下，而拿对话 ping 去测它
 * 会被厂商原样拒绝（配置明明是对的，却永远「测不过」）。
 */
function isEmbeddingModel(provider: ProviderConfig, modelId: string): boolean {
  if (provider.kind === 'embedding') return true
  // 自建网关可能被建成 chat 用途却绑了个向量化模型，仍按 id 特征词兜底
  return provider.kind === 'chat' && looksLikeEmbeddingModelId(modelId)
}

export interface ProbeResult {
  ok: boolean
  /** 失败原因。渲染层查文案，见 `describeProbeFailure` */
  error?: ProbeFailure
  /**
   * 这次没有真的发请求，上面的 `ok` 只表示「配置形状没问题」。
   *
   * 界面要把这一位显示出来，否则用户会把「跳过了」当成「测通了」。
   */
  skipped?: ProbeSkipCode
  /** 通了，但有一项用不了。见 ProbeCaveat */
  caveat?: ProbeCaveat
}

/**
 * 发一个最小请求验证配置可用。
 *
 * 用真实请求而不是打 /models，是因为能列模型不代表能用 ——
 * 额度、权限、模型名拼错都只会在真正调用时才暴露。
 * 请求长什么样跟着模型走：对话模型发一条 ping 的对话请求，
 * 向量化模型发一条 /embeddings —— 它走的是完全不同的端点，拿对话 ping
 * 去测它会被厂商原样拒绝（配置明明是对的，却永远「测不过」）。
 *
 * **不设输出上限**是有意的。这里原来卡 4 个 token 省钱，但推理模型（GPT-5 系、
 * ChatGPT 订阅那一批全是）会先把预算花在思考上 —— 4 个 token 连想都想不完，
 * 请求会以「输出被截断」收场，于是一个配得好好的 Provider 永远测不过。
 * 一句 ping 的开销远小于这个误报的代价，超时由 PROBE_TIMEOUT_MS 兜着。
 */
export async function testProvider(
  provider: ProviderConfig,
  modelId: string
): Promise<ProbeResult> {
  try {
    const model = provider.models.find((item) => item.id === modelId)

    /*
     * 3D 生成不探测。
     *
     * 两个理由，缺一不可：
     * 1. **它没有便宜的请求**。这一类只有「提交一次生成」这一个入口，而提交就
     *    扣额度（Rodin 0.5 credit 起，Tripo 按积分）。点一下「测试连接」花掉
     *    用户的钱，是探测这件事不该干的。
     * 2. **拿对话 ping 去测它必然失败**。3D 厂商压根没有 /chat/completions，
     *    打过去是 404，而下面 describeProbeError 会把 404 翻译成「模型不存在，
     *    请确认模型 ID」—— 于是用户会去反复改 `v3.1-20260211` 这个本来就对的
     *    模型名。配置完全正确却永远测不过，还被指向错误的方向。
     *
     * 这与文件顶部那条「向量化不能用对话 ping 测」是同一个教训，只是这一档
     * 连替代请求都没有，所以只能明说「测不了」。
     */
    // 生图同理：正式调用打的是 /images/generations，对话 ping 测的是另一个端点。
    // 中转站上只挂了生图渠道的模型（gemini-3.1-flash-image-preview 这类）对话那边
    // 一律 404，被说成「模型不存在」；就算对话通了也证明不了生图能用
    if (
      provider.kind === 'image' ||
      provider.kind === 'music' ||
      provider.kind === 'sfx' ||
      provider.kind === 'model3d' ||
      provider.kind === 'video'
    ) {
      return { ok: true, skipped: 'generativeNoCheapCall' }
    }

    // 实时语音是常驻 WebSocket，网页检索的「模型」是去哪儿搜 —— 两家都没有
    // /chat/completions。落到下面那句对话 ping 上，404 会被翻成「模型不存在」，
    // 用户去改一个本来就对的模型名
    if (provider.kind === 'realtime' || provider.kind === 'search') {
      return { ok: true, skipped: 'noChatEndpoint' }
    }

    if (provider.kind === 'tts') {
      await requestSpeech(provider, modelId, '你好', AbortSignal.timeout(PROBE_TIMEOUT_MS))
      return { ok: true }
    }

    /*
     * 语音识别这一档探得**比谁都便宜**：握手、等一句「就绪」、挂断，
     * 一个字节的音频都不送 —— 两家都是按识别时长计费，没有音频就没有账单。
     *
     * 而它验的恰恰是这一档最容易配错的两样：密钥对不对，以及那个既不是模型名
     * 也不像模型名的字符串（豆包那边是资源 ID `volc.seedasr.sauc.duration`）
     * 填对了没有。填错的表现是握手就被拒，错误码里没有一个字提到「资源 ID」。
     */
    if (provider.kind === 'stt') {
      await probeStt(provider, modelId)
      return { ok: true }
    }

    /*
     * 判定这一档有**真正便宜的 ping**，所以它不走上面那条「测不了」的路：
     * 一个最短的是非题，输入十几个 token（$0.042/M），输出不计费。
     * 探测一次的成本实际为零，而且走的就是正式调用那条路（requestJudgement）。
     *
     * 探测时把超时放宽到 PROBE_TIMEOUT_MS：热路径上那个 4 秒是为了「宁可
     * 回落也别拖住 agent」，而用户盯着界面等结果时，一次慢请求的正确结论是
     * 「通了，只是慢」，不是「超时」。
     */
    if (provider.kind === 'judge') {
      await requestJudgement(
        provider,
        modelId,
        'ping',
        { reachable: { type: 'noul', instructions: 'Is this text in English?' } },
        PROBE_TIMEOUT_MS
      )
      return { ok: true }
    }

    if (isEmbeddingModel(provider, modelId)) {
      // 向量本身用不上，探测只关心通不通；单条就够。
      // 'query' 对非对称检索模型（Jina / Voyage）意味着走查询侧的向量空间，
      // 对 OpenAI 形状的模型则没有任何区别。
      await requestEmbeddings(provider, modelId, ['ping'], 'query', model, PROBE_TIMEOUT_MS)
      return { ok: true }
    }

    return await probeChat(provider, modelId, {
      tools: model?.supportsTools !== false,
      thinking: resolveModel(provider, modelId).model.reasoning
    })
  } catch (error) {
    return { ok: false, error: describeProbeError(error) }
  }
}

/** 对话探测这一次带哪几样。和对话里每一轮带的一致 */
interface ChatShape {
  tools: boolean
  thinking: boolean
}

/** 按这个形状发一句 ping。工具只放着不执行，模型调不调都算通 */
async function pingChat(
  provider: ProviderConfig,
  modelId: string,
  shape: ChatShape
): Promise<void> {
  await complete(provider, modelId, {
    messages: [userMessage('ping')],
    ...(shape.tools ? { tools: [CHECKUP_TOOL] } : {}),
    ...(shape.thinking ? { reasoning: 'low' as const } : {}),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS)
  })
}

async function passes(
  provider: ProviderConfig,
  modelId: string,
  shape: ChatShape
): Promise<boolean> {
  return pingChat(provider, modelId, shape).then(
    () => true,
    () => false
  )
}

/** 能互换着试的两种协议：同一个 /v1 底下常常两个端点都在，用户只是选错了 */
const SWAPPABLE_PROTOCOL: Partial<Record<ProviderProtocol, ProviderProtocol>> = {
  'openai-completions': 'openai-responses',
  'openai-responses': 'openai-completions'
}

/**
 * 对话模型的探测。
 *
 * 走的必须是**正式调用同一条路**（pi），否则测得过的配置未必用得了：
 * 上一版这里是另一套 HTTP 实现，ChatGPT 订阅在那边一调就 400。
 *
 * 请求的**形状**也得和对话里一样：带工具，会思考的模型带上思考档位。只发一句光秃秃
 * 的 ping 时，测试连接显示「连接成功」，一开工就 400 —— 真实案例：中转上的
 * gpt-6.1-sol 配成 openai-completions，chat/completions 不收「工具 + 思考」。
 *
 * 被拒（400）时**换着发几次看哪种能通**，而不是读报错原文猜原因：各家措辞不一样，
 * 背一家的台词换一家就失灵。试法与厂商无关，顺序按「对用户最省事的改法」排：
 * 1. 换协议、形状不变 —— 通了就让用户改协议，什么能力都不丢
 * 2. 去掉思考 —— 通了算「能用」，只是开思考会被拒
 * 3. 去掉工具 —— 通了说明它接不了工具，当不了智能体
 * 都不通就原样报第一次的错。只有失败时才多发这几次，成功的路径还是一个请求。
 */
async function probeChat(
  provider: ProviderConfig,
  modelId: string,
  shape: ChatShape
): Promise<ProbeResult> {
  let failure: ProbeFailure
  try {
    await pingChat(provider, modelId, shape)
    return { ok: true }
  } catch (error) {
    failure = describeProbeError(error)
  }
  // 只有「请求本身被拒」才值得换着试。密钥错、超时、限流换什么都一样，多发只是白等
  if (failure.code !== 'badRequest') return { ok: false, error: failure }

  const swapped = SWAPPABLE_PROTOCOL[provider.protocol]
  if (swapped && (await passes({ ...provider, protocol: swapped }, modelId, shape))) {
    return { ok: false, error: { code: 'protocolMismatch', suggestedProtocol: swapped } }
  }
  if (shape.thinking && (await passes(provider, modelId, { ...shape, thinking: false }))) {
    return { ok: true, caveat: 'thinkingRejected' }
  }
  if (shape.tools && (await passes(provider, modelId, { tools: false, thinking: false }))) {
    return { ok: false, error: { code: 'toolsRejected', raw: failure.raw } }
  }
  return { ok: false, error: failure }
}

/**
 * 把厂商的原始错误归到一类。
 *
 * 只判「是哪一种」，不组织语言 —— 文案归渲染层（`describeProbeFailure`）。
 * 判断顺序是有讲究的，别随手调：注释写在各分支上。
 *
 * 导出仅为可测：这几条判断错了，用户会被指向完全错误的方向。
 */
export function describeProbeError(error: unknown): ProbeFailure {
  const raw = error instanceof Error ? error.message : String(error)

  if (/timeout|aborted/i.test(raw)) return { code: 'timeout' }
  if (/\b401\b|unauthorized|invalid api key/i.test(raw)) return { code: 'unauthorized' }
  // 403 不一定是密钥没权限：中转站的客户端校验、地区限制也回 403，理由只在原话里
  if (/\b403\b|forbidden/i.test(raw)) return { code: 'forbidden', raw: raw.slice(0, 300) }

  // 5xx 是**对方服务端**出错，不是配置问题。不说清楚的话用户会一直回来
  // 改 Base URL、换密钥、重新登录 —— 全都没用，因为问题根本不在这边。
  //
  // 必须排在 429/quota 前面：5xx 的响应体里出现「quota」之类的字眼是常事，
  // 按关键词先命中限流分支，就会把一次服务端故障说成「你额度不够」。
  if (/\b5\d\d\b|server_error|internal server error|server had an error/i.test(raw))
    return { code: 'providerServerError', raw: raw.slice(0, 160) }

  if (/\b404\b|model.*not found|no such model/i.test(raw)) return { code: 'modelNotFound' }
  if (/\b429\b|rate limit|quota/i.test(raw)) return { code: 'rateLimited' }

  // 400 的正文常常是空的 —— 界面上就剩「Bad Request」四个字母，用户完全
  // 无从下手。真实案例：ChatGPT 订阅被配成了 openai-responses，登录明明成功，
  // 一测连接就是这一句。至少要把「该往哪几个方向看」说出来。
  if (/\b400\b|bad request/i.test(raw)) return { code: 'badRequest', raw: raw.slice(0, 160) }

  if (/ENOTFOUND|ECONNREFUSED|fetch failed/i.test(raw)) return { code: 'unreachable' }

  // 归不上类就原样透出（截断），不做过度包装 —— 猜错了反而掩盖真实原因
  return { code: 'unknown', raw: raw.slice(0, 300) }
}

/**
 * 从厂商拉取可用模型列表。
 *
 * OpenAI 系协议拉 `/models`，Anthropic 拉 `/v1/models`；Google 走内置目录，
 * 这里明确返回「不支持」而不是假装拉了个空列表。
 */
export async function listRemoteModels(
  provider: ProviderConfig
): Promise<{ ok: true; models: ModelConfig[] } | { ok: false; error: ProbeFailure }> {
  // 3D 与视频厂商没有「列出我有哪些模型」这回事。不说清楚的话用户拿到的是
  // 一句 `拉取失败：HTTP 404`，看上去像 Base URL 填错了 —— 而地址完全正确。
  //
  // 判定这一档同理，只是理由不同：它的可用模型是**账号上的常量**（SDK 里
  // `client.models` 是个只读属性，不是一次请求），没有 `/models` 这个端点。
  // 复用这个 code 是因为它对用户说的那句话恰好就是对的 ——「此服务商不支持
  // 获取模型列表，请按其文档填写模型 ID」。名字里的 Generative 是历史，不是行为。
  if (
    provider.kind === 'music' ||
    provider.kind === 'sfx' ||
    provider.kind === 'model3d' ||
    provider.kind === 'video' ||
    provider.kind === 'tts' ||
    provider.kind === 'stt' ||
    provider.kind === 'judge' ||
    provider.kind === 'realtime' ||
    provider.kind === 'search'
  ) {
    return { ok: false, error: { code: 'listUnsupportedGenerative' } }
  }

  if (provider.protocol === 'google-generative-ai') {
    return { ok: false, error: { code: 'listUnsupportedProtocol' } }
  }

  // Anthropic 官方和多数中转网关都有 `/v1/models`，返回形状与 OpenAI 相同。
  // 官方认 x-api-key，网关多半认 Bearer，两种都试；都拉不到再让用户手填
  if (provider.protocol === 'anthropic-messages') {
    const base = provider.baseUrl.replace(/\/+$/, '')
    const url = `${/\/v1$/.test(base) ? base : `${base}/v1`}/models?limit=1000`
    const apiKey = await resolveApiKey(provider.apiKey).catch(() => '')
    const attempts: Array<Record<string, string>> = [
      { 'x-api-key': apiKey || '', 'anthropic-version': '2023-06-01' },
      apiKey ? { Authorization: `Bearer ${apiKey}` } : {}
    ]
    for (const auth of attempts) {
      const result = await fetchModelList(url, { ...(provider.headers || {}), ...auth })
      if (result.ok) return result
    }
    return { ok: false, error: { code: 'listUnsupportedProtocol' } }
  }

  // Codex 后端只有 /responses 一个端点，`/models` 会回一句 404。
  // 说清楚该去哪儿拿，比让用户对着一句 HTTP 404 猜要好。
  if (provider.protocol === 'openai-codex-responses') {
    return { ok: false, error: { code: 'listUnsupportedCodex' } }
  }

  // Cursor 订阅的模型列表不在 /models。内置清单就是可选项，手填 wire id 也行
  if (provider.protocol === 'cursor-agent') {
    return { ok: false, error: { code: 'listUnsupportedCursor' } }
  }

  // CodeBuddy 同理：只有对话端点，没有 /models。目录里预置了官方 CLI 列出的型号
  if (provider.baseUrl.startsWith(CODEBUDDY_ORIGIN)) {
    return { ok: false, error: { code: 'listUnsupportedProtocol' } }
  }

  let headers: Record<string, string>
  try {
    const apiKey = await resolveApiKey(provider.apiKey)
    headers = { ...(provider.headers || {}) }
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  } catch (error) {
    return { ok: false, error: describeProbeError(error) }
  }
  return fetchModelList(`${provider.baseUrl}/models`, headers)
}

async function fetchModelList(
  url: string,
  headers: Record<string, string>
): Promise<{ ok: true; models: ModelConfig[] } | { ok: false; error: ProbeFailure }> {
  try {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) })
    if (!response.ok) {
      return { ok: false, error: { code: 'listHttpError', raw: String(response.status) } }
    }

    const payload = (await response.json()) as { data?: Array<{ id?: unknown }> }
    const models = (payload.data || [])
      .map((item) => String(item?.id || '').trim())
      .filter(Boolean)
      .sort()
      .map<ModelConfig>((id) => ({ id, supportsTools: true }))

    if (models.length === 0) {
      return { ok: false, error: { code: 'listEmpty' } }
    }
    return { ok: true, models }
  } catch (error) {
    return { ok: false, error: describeProbeError(error) }
  }
}

/** 64×64 的纯红图。看图体检问它是什么颜色：答案是确定的，不靠猜 */
const CHECKUP_RED_PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAeUlEQVR4nO3PQQkAMAzAwCqpf1ETMxF7HINABFzm7H7dcEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFDWhBA1rQgBY0oAUNaEEDWtCAFjSgBQ1oQQNa0IAWNKAFj13PLIEAOXyUUwAAAABJRU5ErkJggg=='

const CHECKUP_TOOL: Tool = {
  name: 'ping',
  description: 'Health check. Call it whenever you are asked to.',
  parameters: { type: 'object', properties: {}, additionalProperties: false } as unknown as TSchema
}

/**
 * 入职体检：这个对话模型在用户这里能不能当队员。
 *
 * 只查「能不能用」，不评能力（设计稿 5.2 节）：
 * - **工具调用**：让它调一个 `ping`。有些中转网关会把工具调用吞掉，配置看着全对、
 *   一干活就只会说话 —— 这是最常见的坑，所以必查。答错的偶尔是模型自己没听话，
 *   所以不调的话再问一次，两次都不调才算没过。
 * - **看图**：只在它声称能看图时查。给一张纯红图问颜色 —— 答案是确定的，
 *   查的是图到底有没有送到它眼前（有的网关会把图悄悄丢掉）。
 *
 * 每项一个最短的请求，花费可以忽略；由调用方缓存结果，不会每次都测。
 */
export async function checkupChatModel(
  provider: ProviderConfig,
  modelId: string,
  now: () => number = Date.now
): Promise<ModelCheckup> {
  const at = now()
  const signal = (): AbortSignal => AbortSignal.timeout(PROBE_TIMEOUT_MS)
  const callsTool = async (): Promise<boolean> => {
    const message = await complete(provider, modelId, {
      messages: [userMessage('Call the `ping` tool now. Do not answer with text.')],
      tools: [CHECKUP_TOOL],
      signal: signal()
    })
    return message.content.some((part) => part.type === 'toolCall')
  }
  let tools: ModelCheckup['tools']
  try {
    tools = (await callsTool()) || (await callsTool()) ? 'ok' : 'fail'
  } catch (error) {
    return { at, reachable: false, tools: 'fail', failure: describeProbeError(error) }
  }

  const model = provider.models.find((item) => item.id === modelId)
  if (model?.supportsVision !== true) return { at, reachable: true, tools }
  try {
    const answer = await completeText(provider, modelId, {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', data: CHECKUP_RED_PNG, mimeType: 'image/png' },
            { type: 'text', text: 'What colour is this image? Answer with one English word.' }
          ],
          timestamp: 0
        }
      ],
      signal: signal()
    })
    return { at, reachable: true, tools, vision: /red|红/i.test(answer) ? 'ok' : 'fail' }
  } catch {
    // 带图的请求被拒（400 之类），就是看不了图
    return { at, reachable: true, tools, vision: 'fail' }
  }
}
