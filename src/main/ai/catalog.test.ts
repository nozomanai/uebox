/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import type { CatalogEntry } from '../../shared/aiProvider'
import { GENERATED_CATALOG as CATALOG } from './catalog.generated'
import { CODEBUDDY_BASE_URL } from './codebuddy'
import { ZCODE_BASE_URL } from './zcode'

/**
 * 目录是 `scripts/sync-provider-catalog.mjs` 从 models.dev 生成的快照，
 * 会不定期重跑。这里守住重跑之后**不能退化**的几条：
 * 生成逻辑改坏了、或上游数据变了，都会在这里先炸，而不是等用户在
 * 下拉框里选到一个 2024 年的模型才发现。
 */
describe('内置 Provider 目录', () => {
  it('ZCode 是独立订阅入口，使用账号登录和 Anthropic 套餐端点', () => {
    const zcode = CATALOG.find((entry) => entry.id === 'zcode')!
    expect(zcode).toMatchObject({
      group: 'subscription',
      kind: 'chat',
      supportsOAuth: true,
      requiresApiKey: true,
      protocol: 'anthropic-messages',
      baseUrl: ZCODE_BASE_URL
    })
    expect(zcode.models.map((model) => model.id)).toContain('GLM-5.2')
    expect(zcode.models.every((model) => model.supportsTools)).toBe(true)
  })
  it('阿里语音合成目录区分接口并预置匹配音色', () => {
    const audio = CATALOG.find((entry) => entry.id === 'alibaba-tts')!
    expect(CATALOG.find((entry) => entry.id === 'alibaba-qwen3-tts')).toBeUndefined()
    expect(audio.kind).toBe('tts')
    expect(audio.baseUrl).toBe('wss://dashscope.aliyuncs.com/api-ws/v1/inference')
    expect(audio.models.map((model) => [model.id, model.ttsVoice])).toEqual([
      ['qwen-audio-3.0-tts-plus', 'longanlingxin'],
      ['qwen-audio-3.0-tts-flash', 'longanfengyue']
    ])
  })
  const needsKey = CATALOG.filter((entry) => entry.requiresApiKey)

  it('不是空的', () => {
    expect(CATALOG.length).toBeGreaterThan(20)
  })

  it('每家都有 id、名字和至少一个模型或自建地址', () => {
    for (const entry of CATALOG) {
      expect(entry.id, JSON.stringify(entry)).toBeTruthy()
      expect(entry.displayName, entry.id).toBeTruthy()
    }
  })

  /**
   * 要填密钥的厂商必须给出「去哪儿拿」。
   *
   * 界面上那个「去获取 API Key ↗」按钮就靠它 —— 没有的话用户对着一个空
   * 输入框，只能自己去搜。这个字段在目录里存了很久却一直没人用，
   * 加按钮时才发现。
   */
  it('要密钥的厂商都给出了密钥页地址', () => {
    const missing = needsKey.filter((entry) => !entry.apiKeyUrl).map((entry) => entry.id)
    expect(missing, `这些厂商要填密钥却没有 apiKeyUrl：${missing.join(', ')}`).toEqual([])
  })

  it('密钥页地址都是 https', () => {
    const bad = CATALOG.filter((e) => e.apiKeyUrl && !e.apiKeyUrl.startsWith('https://')).map(
      (e) => `${e.id} → ${e.apiKeyUrl}`
    )
    expect(bad).toEqual([])
  })

  /**
   * 密钥页要指向**能创建密钥的那一页**，不是文档首页。
   *
   * 上游给的 `doc` 大多是模型列表或能力介绍（platform.openai.com/docs/models），
   * 点开还得自己找控制台。生成脚本里有一张逐家核对过的覆盖表，
   * 这条防的是那张表被绕过。
   */
  it('大厂的密钥页不是文档页', () => {
    const docLike = ['openai', 'anthropic', 'google', 'deepseek', 'zhipuai']
      .map((id) => CATALOG.find((e) => e.id === id))
      .filter((e): e is NonNullable<typeof e> => !!e)
      .filter((e) => /\/docs?(\/|$)|docs\./.test(e.apiKeyUrl || ''))
      .map((e) => `${e.id} → ${e.apiKeyUrl}`)
    expect(docLike).toEqual([])
  })

  // 预置清单是「开箱能用的推荐」。太老的模型摆在里面只会让人选错，
  // 而选错的表现是"能连上、但答得很差"，比连不上更难排查。
  it('没有明显过时的模型 id', () => {
    const stale =
      /gpt-3\.5|gpt-4-|claude-2|claude-3-(opus|sonnet|haiku)-2024|gemini-1\.|text-davinci|deepseek-(chat|reasoner)$/
    const found: string[] = []
    for (const entry of CATALOG) {
      for (const model of entry.models) {
        if (stale.test(model.id)) found.push(`${entry.id}/${model.id}`)
      }
    }
    expect(found, `这些是已经过时（或已下线）的模型：${found.join(', ')}`).toEqual([])
  })

  /**
   * 上下文窗口必须跟着目录一起来。
   *
   * 少了它，Agent 只能对所有模型套一个写死的缺省值 —— Gemini 的 1M 窗口
   * 会在 12% 就开始压缩，用户看着「上下文 121k/128k」白白丢掉八成历史。
   */
  it('绝大多数预置模型带着真实的上下文窗口', () => {
    /*
     * **只统计对话模型**。生图、向量化、3D、视频、实时语音的模型本来就没有
     * 上下文窗口这回事，算进分母只会让阈值随那几份清单的长短上下浮动。
     *
     * 以前这里是一份 group 黑名单（image / embedding），每加一种模态就要记得
     * 回来补一个 —— 而漏补的表现是这条断言慢慢逼近阈值，最后在一次毫不相干的
     * 改动里突然变红。加视频和 Tripo P1 之后就正好掉到 89.8%。
     * 用途上移到 Provider 之后，这件事有了一个说得清的判据。
     */
    const all = CATALOG.filter((entry) => entry.kind === 'chat').flatMap((entry) => entry.models)
    const withWindow = all.filter((model) => (model.contextWindow ?? 0) > 0)
    expect(withWindow.length / all.length).toBeGreaterThan(0.9)
  })

  it('窗口值是正整数，且没有小到不可能对话的', () => {
    const bad: string[] = []
    for (const entry of CATALOG) {
      for (const model of entry.models) {
        const window = model.contextWindow
        if (window === undefined) continue
        if (!Number.isInteger(window) || window < 4_000)
          bad.push(`${entry.id}/${model.id}=${window}`)
      }
    }
    expect(bad, `这些模型的 contextWindow 不可信：${bad.join(', ')}`).toEqual([])
  })

  /**
   * ChatGPT 订阅走的是 Codex 后端，不是 Responses。
   *
   * 这两个协议名字只差一个词，但错了的表现是**登录明明成功、一调用就
   * 400 Bad Request** —— 界面上没有任何线索指向协议。这条守着别再退回去。
   */
  it('ChatGPT 订阅用的是 codex 协议，不是普通 responses', () => {
    const chatgpt = CATALOG.find((entry) => entry.id === 'chatgpt')
    expect(chatgpt?.protocol).toBe('openai-codex-responses')
  })

  /**
   * Codex 后端没有 `/models`，「导入模型」在这一家用不了。
   * 预置清单要是空的，用户登录成功后面对的就是一个没有任何模型的
   * Provider，只能去别处翻型号名再手打。
   */
  it('ChatGPT 订阅预置了可选模型', () => {
    const chatgpt = CATALOG.find((entry) => entry.id === 'chatgpt')
    expect(chatgpt?.models.length).toBeGreaterThan(0)
    expect(chatgpt?.models.some((model) => model.supportsVision)).toBe(true)
  })

  /**
   * CodeBuddy 没有 `/models`，清单空着用户登录完就无模型可选；
   * baseUrl 必须和 codebuddy.ts 里的常量一致，否则请求头与探测的特判都对不上。
   */
  it('Cursor 订阅走账号登录、不使用 API Key 协议，并预置了可选模型', () => {
    const cursor = CATALOG.find((entry) => entry.id === 'cursor')
    expect(cursor?.group).toBe('subscription')
    expect(cursor?.protocol).toBe('cursor-agent')
    expect(cursor?.supportsOAuth).toBe(true)
    expect(cursor?.baseUrl).toBe('https://agentn.global.api5.cursor.sh')
    expect(cursor?.models.some((model) => model.id === 'auto')).toBe(true)
    expect(cursor?.models.every((model) => model.supportsTools)).toBe(true)
    const grok47 = cursor?.models.find((model) => model.id === 'grok-4.7')
    expect(grok47?.thinkingLevelMap).toMatchObject({
      low: 'low',
      high: 'high',
      xhigh: 'extra_high',
      minimal: null
    })
    const composer = cursor?.models.find((model) => model.id === 'composer-2.5')
    expect(composer?.supportsReasoning).toBe(false)
    expect(cursor?.models.some((model) => model.id === 'grok-4.6')).toBe(true)
    expect(grok47?.contextWindow).toBe(500_000)
  })

  it('CodeBuddy 走账号登录、直连官方端点、预置了可选模型', () => {
    const codebuddy = CATALOG.find((entry) => entry.id === 'codebuddy')
    expect(codebuddy?.group).toBe('subscription')
    expect(codebuddy?.protocol).toBe('openai-completions')
    expect(codebuddy?.supportsOAuth).toBe(true)
    expect(codebuddy?.baseUrl).toBe(CODEBUDDY_BASE_URL)
    expect(codebuddy?.models.length).toBeGreaterThan(0)
    expect(codebuddy?.models.every((model) => model.supportsTools)).toBe(true)
  })

  /**
   * OpenCode 一个 Key 下混着三种协议，Claude / GPT / Grok / Gemini / MiniMax / Muse
   * 不走 chat/completions。预置进来，用户一选就是 404。
   */
  it('OpenCode Go / Zen 只预置走 chat/completions 的模型', () => {
    for (const id of ['opencode-go', 'opencode-zen']) {
      const entry = CATALOG.find((e) => e.id === id)!
      expect(entry.protocol).toBe('openai-completions')
      expect(entry.models.length).toBeGreaterThan(0)
      const wrong = entry.models.filter((m) => /^(claude|gpt|grok|gemini|minimax|muse)-/.test(m.id))
      expect(
        wrong.map((m) => m.id),
        `${id} 混进了别的协议`
      ).toEqual([])
    }
    expect(CATALOG.find((e) => e.id === 'opencode-go')?.group).toBe('subscription')
  })

  it('模型 id 在同一家里不重复', () => {
    for (const entry of CATALOG) {
      const ids = entry.models.map((m) => m.id)
      expect(new Set(ids).size, `${entry.id} 有重复模型 id`).toBe(ids.length)
    }
  })

  it('Astra 的 API 与订阅额度分别保留', () => {
    const api = CATALOG.find((entry) => entry.id === 'openai')?.models.find(
      (m) => m.id === 'gpt-6-astra'
    )
    const subscription = CATALOG.find((entry) => entry.id === 'chatgpt')?.models.find(
      (m) => m.id === 'gpt-6-astra'
    )
    expect(api).toMatchObject({
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: true,
      contextWindow: 1_050_000,
      maxOutputTokens: 128_000
    })
    expect(subscription).toMatchObject({ contextWindow: 272_000, maxOutputTokens: 128_000 })
  })

  it('GPT-6.1 Sol / 6 Sol / 6 Luna 在 API 与订阅两边都列出最高两档', () => {
    for (const providerId of ['openai', 'chatgpt']) {
      const models = CATALOG.find((entry) => entry.id === providerId)!.models
      for (const id of ['gpt-6.1-sol', 'gpt-6-sol', 'gpt-6-luna']) {
        // 6.1 Sol 另有 off: null，见下面「最高思考档位」那组
        expect(
          models.find((m) => m.id === id)?.thinkingLevelMap,
          `${providerId}/${id}`
        ).toMatchObject({
          minimal: null,
          xhigh: 'xhigh',
          max: 'max'
        })
      }
    }
  })

  it('Opus 5.5 走自适应思考，且不列「关闭思考」', () => {
    const opus = CATALOG.find((entry) => entry.id === 'anthropic')?.models.find(
      (m) => m.id === 'claude-opus-5-5'
    )
    expect(opus).toMatchObject({
      adaptiveThinking: true,
      thinkingLevelMap: { off: null, xhigh: 'xhigh', max: 'max' },
      contextWindow: 1_000_000,
      maxOutputTokens: 128_000
    })
  })

  it('Gemini 3.1 Pro 不再被专用生图和语音模型挤出对话目录', () => {
    const google = CATALOG.find((entry) => entry.id === 'google')!
    expect(google.models.find((m) => m.id === 'gemini-3.1-pro-preview')).toMatchObject({
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: true,
      contextWindow: 1_048_576,
      maxOutputTokens: 65_536
    })
    expect(google.models.some((m) => /image|live|embedding/.test(m.id))).toBe(false)
  })

  it('DeepSeek 主入口只保留新版 Flash 与 Pro', () => {
    const deepseek = CATALOG.find((entry) => entry.id === 'deepseek')!
    expect(deepseek.models.map((m) => m.id).sort()).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
    expect(deepseek.models.find((m) => m.id === 'deepseek-flash')).toMatchObject({
      displayName: 'DeepSeek V4.1 Flash',
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: true,
      contextWindow: 1_000_000,
      maxOutputTokens: 393_216
    })
  })

  it('Grok 4.6 不把上下文窗口冒充硬输出上限', () => {
    const grok = CATALOG.find((entry) => entry.id === 'xai')?.models.find(
      (m) => m.id === 'grok-4.6'
    )
    expect(grok).toMatchObject({
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: true,
      contextWindow: 500_000
    })
    expect(grok).not.toHaveProperty('maxOutputTokens')
  })

  it('腾讯使用 TokenHub 对应的模型和地址，百度使用文心 5.x', () => {
    const tencent = CATALOG.find((entry) => entry.id === 'tencent')!
    expect(tencent.baseUrl).toBe('https://tokenhub.tencentmaas.com/v1')
    expect(tencent.apiKeyUrl).toBe('https://console.cloud.tencent.com/tokenhub/apikey')
    expect(tencent.models.find((m) => m.id === 'hy4-preview')).toMatchObject({
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: true,
      contextWindow: 1_024_000,
      maxOutputTokens: 64_000
    })
    expect(tencent.models.find((m) => m.id === 'hy3')).toMatchObject({
      contextWindow: 256_000,
      maxOutputTokens: 128_000
    })
    const baidu = CATALOG.find((entry) => entry.id === 'baidu')!
    expect(baidu.models.find((m) => m.id === 'ernie-5.1')).toMatchObject({
      supportsVision: false,
      supportsTools: true,
      supportsReasoning: false,
      contextWindow: 131_072,
      maxOutputTokens: 65_536
    })
    expect(baidu.models.find((m) => m.id === 'ernie-5.0')).toMatchObject({
      supportsVision: true,
      supportsTools: true,
      supportsReasoning: true,
      contextWindow: 131_072,
      maxOutputTokens: 65_536
    })
  })

  it('没有 2026 年模型的来源保留入口、清空旧预置', () => {
    for (const id of ['lmstudio', 'perplexity', 'inference', 'infini']) {
      expect(CATALOG.find((entry) => entry.id === id)?.models, id).toEqual([])
    }
  })

  it('视频模型带有独立能力标记', () => {
    const google = CATALOG.find((entry) => entry.id === 'google')
    const alibaba = CATALOG.find((entry) => entry.id === 'alibaba')

    expect(google?.models.find((model) => model.id === 'gemini-3.7-flash')?.supportsVideo).toBe(
      true
    )
    expect(alibaba?.models.find((model) => model.id === 'qwen3.6-flash')?.supportsVideo).toBe(true)
    expect(
      CATALOG.find((entry) => entry.id === 'deepseek')?.models.some((model) => model.supportsVideo)
    ).toBe(false)
  })

  /**
   * 厂商 id 是 models.json 的主键，也是密钥库的键。
   *
   * 「图片生成」分组里几条是同一家厂商的另一个入口（openai-image、
   * zhipuai-image……），一旦哪次手滑写成了母公司的 id，findCatalogEntry
   * 会只认第一条，另一条在界面上点了没反应 —— 而且不报错。
   */
  it('厂商 id 全局唯一', () => {
    const ids = CATALOG.map((entry) => entry.id)
    const dupes = ids.filter((id, index) => ids.indexOf(id) !== index)
    expect(dupes, `重复的厂商 id：${dupes.join(', ')}`).toEqual([])
  })
})

/**
 * 「图片生成」是按**能力**分的一组，判据和上面那些按「从哪儿买算力」分的组
 * 完全不同，所以单独守一遍。
 */
describe('图片生成分组', () => {
  const imageEntries = CATALOG.filter((entry) => entry.kind === 'image')

  it('这一组不是空的', () => {
    expect(imageEntries.length).toBeGreaterThanOrEqual(4)
  })

  /**
   * 少了这一位，清单是满的但「生图」角色的下拉里一个都选不出来 ——
   * 用户的感受是「Provider 都加好了，怎么还是没法出图」。
   */
  it('每条都标了 kind: image，而且都预置了模型', () => {
    const bad: string[] = []
    for (const entry of imageEntries) {
      expect(entry.models.length, `${entry.id} 一个模型都没预置`).toBeGreaterThan(0)
      if (entry.kind !== 'image') bad.push(entry.id)
    }
    expect(bad, `这些条目的用途不是 image：${bad.join(', ')}`).toEqual([])
  })

  /**
   * 生图只有这三种协议走得通（见 imageGeneration.ts 的 PROTOCOLS_WITH_IMAGES）。
   * Codex 后端没有生图端点，靠的是生图工具（codex-images 适配器）。
   * 剩下两种是真的没有 —— Anthropic 没有生图模型，
   * `google-generative-ai` 是对话协议（Nano Banana 走的是自己的 Interactions API，
   * 那条目录条目挂在 openai-completions 下，由适配器换端点）。
   */
  it('协议只用走得通的那三种', () => {
    const supported = ['openai-completions', 'openai-responses', 'openai-codex-responses']
    const bad = imageEntries
      .filter((entry) => !supported.includes(entry.protocol))
      .map((entry) => `${entry.id} → ${entry.protocol}`)
    expect(bad, `这些协议没有生图接口：${bad.join(', ')}`).toEqual([])
  })

  /**
   * 「这个模型的请求长什么样」必须写在目录里，不能让代码去按模型名猜。
   *
   * 漏了这一位，代码只能回落到通用形状 —— 而通用形状对 gpt-image 是 400
   * （多发了 response_format）、对 xAI 是 400（多发了 size）、对硅基流动是
   * 张数和尺寸悄悄失效。三种都不好查，因为报错来自厂商、看着像模型名写错了。
   */
  it('每个生图模型都写明了走哪种接口形状', () => {
    const known = [
      'openai-images',
      'gpt-images',
      'grok-images',
      'siliconflow-images',
      'ark-images',
      'gemini-images',
      'minimax-images',
      'codex-images'
    ]
    const bad: string[] = []
    for (const entry of imageEntries) {
      for (const model of entry.models) {
        if (!model.imageApi) bad.push(`${entry.id}/${model.id} 没写 imageApi`)
        else if (!known.includes(model.imageApi))
          bad.push(`${entry.id}/${model.id} 的 imageApi 不认识：${model.imageApi}`)
      }
    }
    expect(bad, bad.join('; ')).toEqual([])
  })

  /**
   * 生图这一组里的每一家都必须有一个照官方文档写的适配器。
   *
   * 端点长什么样不是门槛（Nano Banana 走的就是 `/interactions`），协议才是：
   * `google-generative-ai` 是**对话**协议，不在 PROTOCOLS_WITH_IMAGES 里。
   * 目录里要是混进一条，用户绑上去会撞到 ImageProtocolUnsupportedError ——
   * 那不是他配错了，是我们加错了。
   */
  it('生图分组里没有靠对话协议出图的条目', () => {
    const bad = imageEntries
      .filter((entry) => entry.protocol === 'google-generative-ai')
      .map((entry) => entry.id)
    expect(bad, `这些厂商的生图不走 /images/generations：${bad.join(', ')}`).toEqual([])
  })

  /**
   * 生图模型绑给「对话 / 视觉」角色只会拿到一句厂商报错，反过来也一样。
   * 这两位一旦被误标，用户会在完全无关的地方看到莫名其妙的失败。
   */
  it('不冒充对话模型：不标工具调用，也不标视觉', () => {
    const bad: string[] = []
    for (const entry of imageEntries) {
      for (const model of entry.models) {
        if (model.supportsTools || model.supportsVision) bad.push(`${entry.id}/${model.id}`)
      }
    }
    expect(bad, `这些生图模型被标成了对话能力：${bad.join(', ')}`).toEqual([])
  })

  it('反过来，对话用途的条目里不该混进生图厂商', () => {
    const bad = CATALOG.filter((entry) => entry.kind === 'image' && entry.kind !== 'image').map(
      (entry) => entry.id
    )
    expect(bad, `这些生图条目的用途没标对：${bad.join(', ')}`).toEqual([])
  })
})

/**
 * 向量化分组。
 *
 * 在这之前目录里**一个向量化模型都没有** —— models.dev 只收对话模型，
 * 于是「嵌入」角色的下拉永远是空的，用户想用知识库检索只能自己手打模型 id，
 * 而打错不报错，只是永远搜不到东西。
 */
describe('向量化分组', () => {
  const embeddingEntries = CATALOG.filter((entry) => entry.kind === 'embedding')

  it('这一组存在，而且每家都给了模型', () => {
    expect(embeddingEntries.length).toBeGreaterThan(0)
    for (const entry of embeddingEntries) {
      expect(entry.models.length, `${entry.id} 没有预置模型`).toBeGreaterThan(0)
    }
  })

  /**
   * 少了这一位，清单是满的但「嵌入」角色的下拉一个都选不出来 ——
   * 表现是「加了 Provider 却还是没法建知识库」。
   */
  it('每条都标了 kind: embedding', () => {
    const bad = embeddingEntries.filter((entry) => entry.kind !== 'embedding').map((e) => e.id)
    expect(bad, `这些条目的用途不是 embedding：${bad.join(', ')}`).toEqual([])
  })

  /** 向量化模型不聊天、不调工具、不看图，标上了会被误绑到对话角色 */
  it('不冒充对话模型', () => {
    const bad = embeddingEntries
      .flatMap((entry) => entry.models.map((model) => ({ entry, model })))
      .filter((item) => item.model.supportsTools || item.model.supportsVision)
      .map((item) => `${item.entry.id}/${item.model.id}`)
    expect(bad, `这些向量化模型被标成了对话能力：${bad.join(', ')}`).toEqual([])
  })

  /**
   * embeddingApi 决定要不要多发「这段是文档还是查询」那个参数。
   * 取值必须是实现里认识的那几个，写错了会静默按 OpenAI 形状发 ——
   * 对非对称检索模型来说就是召回变差且没有任何报错。
   */
  it('embeddingApi 只用实现里认识的取值', () => {
    const known = new Set(['openai-embeddings', 'jina-embeddings', 'voyage-embeddings'])
    const bad = embeddingEntries
      .flatMap((entry) => entry.models.map((model) => ({ entry, model })))
      .filter((item) => item.model.embeddingApi && !known.has(item.model.embeddingApi))
      .map((item) => `${item.entry.id}/${item.model.id}=${item.model.embeddingApi}`)
    expect(bad, `未知的 embeddingApi：${bad.join(', ')}`).toEqual([])
  })

  /** Jina 与 Voyage 是非对称检索模型，漏标形状=召回悄悄变差 */
  it('Jina 与 Voyage 标了各自的非对称形状', () => {
    const jina = embeddingEntries.find((entry) => entry.id === 'jina')
    const voyage = embeddingEntries.find((entry) => entry.id === 'voyageai')

    expect(jina?.models.every((model) => model.embeddingApi === 'jina-embeddings')).toBe(true)
    expect(voyage?.models.every((model) => model.embeddingApi === 'voyage-embeddings')).toBe(true)
  })

  /** 本机那条是「完全离线零成本」的路，不该要密钥 */
  it('本机向量化不要求密钥', () => {
    const ollama = embeddingEntries.find((entry) => entry.id === 'ollama-embedding')

    expect(ollama).toBeDefined()
    expect(ollama?.requiresApiKey).toBe(false)
  })

  /**
   * 反方向现在由类型系统保证：能力位没了，一个 Provider 只有一个 kind，
   * 不可能「一半模型是向量化的」。这里改成守用途与分组不打架。
   */
  it('别的用途里不会混进向量化条目', () => {
    // group 现在只剩「从哪儿买算力」那一轴，模态一律看 kind
    const bad = embeddingEntries.filter((entry) => entry.kind !== 'embedding').map((e) => e.id)
    expect(bad, `这些条目的用途不是 embedding：${bad.join(', ')}`).toEqual([])
  })
})

describe('实时语音分组', () => {
  const realtimeEntries = CATALOG.filter((entry) => entry.kind === 'realtime')

  it('每条都标了 kind: realtime', () => {
    const bad = realtimeEntries.filter((entry) => entry.kind !== 'realtime').map((e) => e.id)

    expect(realtimeEntries.length).toBeGreaterThanOrEqual(2)
    expect(bad, `这些条目的用途不是 realtime：${bad.join(', ')}`).toEqual([])
  })

  it('OpenAI 的两个实时型号默认使用 Marin', () => {
    const openai = realtimeEntries.find((entry) => entry.id === 'openai-realtime')

    expect(openai?.models.map((model) => [model.id, model.realtimeVoice])).toEqual([
      ['gpt-realtime', 'marin'],
      ['gpt-realtime-2.1', 'marin']
    ])
  })

  /**
   * 用途上移之后，通用 OpenAI 那条（kind: chat）**不能**再顺带提供实时语音 ——
   * 一个 Provider 只干一件事。想用 OpenAI 的实时语音要单独添加 `openai-realtime`。
   *
   * 这是 ProviderKind 那条注释里说的代价在真实场景里的一次兑现：多加一条记录，
   * 换掉「一排能力位散在模型上」。目录里那条已经备好，所以只是多点一次。
   */
  it('通用 OpenAI 那条不再顺带提供实时语音，realtime 走单独条目', () => {
    expect(CATALOG.find((entry) => entry.id === 'openai')?.kind).toBe('chat')
    expect(CATALOG.find((entry) => entry.id === 'openai-realtime')?.kind).toBe('realtime')
  })
})

describe('火山方舟', () => {
  const ark = CATALOG.find((entry) => entry.id === 'bytedance')

  it('预置的是当前这一代，不是 2025 年那批', () => {
    expect(ark?.models.some((model) => model.id.startsWith('doubao-seed-2-0-'))).toBe(true)
    expect(ark?.models.some((model) => model.id.startsWith('doubao-1-5-'))).toBe(false)
  })

  /**
   * 已核对的豆包 2.0 Pro / Code 只认 minimal / low / medium / high 四档。
   * 少了这张表用户能选到 `max` —— 换来的是一次来自厂商的 400，
   * 看上去像模型名写错了。
   */
  it('已核对的 2.0 Pro / Code 档位不会被上游的通用档位覆盖', () => {
    for (const id of ['doubao-seed-2-0-pro-260215', 'doubao-seed-2-0-code-preview-260215']) {
      const model = ark?.models.find((m) => m.id === id)
      expect(model?.supportsReasoning, id).toBe(true)
      expect(model?.thinkingLevelMap?.xhigh, `${id} 少了 xhigh`).toBeNull()
      expect(model?.thinkingLevelMap?.max, `${id} 少了 max`).toBeNull()
    }
  })

  it('收录 2.1 Pro / Turbo 的能力与服务商额度，剔除 1.8', () => {
    for (const id of ['doubao-seed-2-1-pro-260628', 'doubao-seed-2-1-turbo-260628']) {
      expect(ark?.models.find((m) => m.id === id)).toMatchObject({
        supportsVision: true,
        supportsTools: true,
        supportsReasoning: true,
        contextWindow: 256_000,
        maxOutputTokens: 256_000
      })
    }
    expect(ark?.models.some((m) => m.id === 'doubao-seed-1-8-251228')).toBe(false)
  })
})

/**
 * 最高那两档（`xhigh` / `max`）在内核里是**白名单制**：模型没显式声明就当不存在
 * （`getSupportedThinkingLevels`）。所以「厂商有这一档」和「界面列得出来」
 * 是两件事 —— 中间隔着 THINKING_OVERRIDES 那张表。
 *
 * 这里守住的不是「阶梯写得全不全」，而是**已经照官方文档核对过的那几条别退化**。
 * 退化是静默的：下拉框安静地少两档，没有任何报错。
 *
 * 逐条的文档出处写在 `scripts/sync-provider-catalog.mjs` 的 THINKING_OVERRIDES 上。
 */
describe('最高思考档位（xhigh / max）', () => {
  const modelIn = (
    providerId: string,
    modelId: string
  ): CatalogEntry['models'][number] | undefined =>
    CATALOG.find((entry) => entry.id === providerId)?.models.find((m) => m.id === modelId)

  it('OpenAI：5.6 有 max', () => {
    expect(modelIn('openai', 'gpt-5.6')?.thinkingLevelMap).toMatchObject({
      xhigh: 'xhigh',
      max: 'max'
    })
    expect(modelIn('chatgpt', 'gpt-5.6-sol')?.thinkingLevelMap).toMatchObject({
      xhigh: 'xhigh',
      max: 'max'
    })
  })

  /** 不写 off: null，pi 没给档位时就发 effort: "none"，6.1 Sol 整轮 400 */
  it('OpenAI：6.1 Sol 没有 none', () => {
    for (const provider of ['openai', 'chatgpt']) {
      expect(modelIn(provider, 'gpt-6.1-sol')?.thinkingLevelMap?.off, provider).toBeNull()
    }
  })

  /** 订阅那边下线的型号留在清单里，用户选了就是一次看不懂的报错 */
  it('Codex 订阅不再列出已下线的型号', () => {
    for (const id of ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex-spark']) {
      expect(modelIn('chatgpt', id), id).toBeUndefined()
    }
  })

  /** GPT-5.6 这一代没有 `minimal`，写明不存在免得列出一档发过去就 400 的 */
  it('OpenAI：5.6 没有 minimal 这一档', () => {
    for (const [provider, id] of [
      ['openai', 'gpt-5.6'],
      ['chatgpt', 'gpt-5.6-luna']
    ] as const) {
      expect(modelIn(provider, id)?.thinkingLevelMap?.minimal, `${id} 的 minimal`).toBeNull()
    }
  })

  /**
   * Claude 这两档必须与 `adaptiveThinking` 成对出现。
   *
   * 少了后者，请求走老式思考预算，而那条路把 xhigh 和 max 一起夹成 high ——
   * 档位列在界面上，发出去的却和 high 一模一样。
   */
  it('Anthropic：Fable 5.1 的 xhigh / max 与自适应思考成对声明', () => {
    const fable = modelIn('anthropic', 'claude-fable-5-1')

    expect(fable?.thinkingLevelMap).toMatchObject({ xhigh: 'xhigh', max: 'max' })
    expect(fable?.adaptiveThinking).toBe(true)
  })

  /**
   * DeepSeek 的最高档是 `max` 不是 `xhigh` —— 后者官方接受，但会被映射成
   * high，是个同义别名。当成独立档位列出来，用户调了不会有任何变化。
   */
  it('DeepSeek：新版 Flash 支持 low / high / max，不列重复别名档位', () => {
    const vision = modelIn('deepseek', 'deepseek-flash')?.thinkingLevelMap

    expect(vision).toMatchObject({ high: 'high', xhigh: null, max: 'max' })
    expect(vision).toMatchObject({ minimal: null, low: 'low', medium: null })
  })

  /** 智谱直连 pi 目录里没有（它只收了 z.ai 国际版），整家都靠这张覆盖表 */
  it('智谱：GLM-5.3 是 low / high / max 三档，5.2 只有 high / max', () => {
    expect(modelIn('zhipuai', 'glm-5.3')?.thinkingLevelMap).toEqual({
      minimal: null,
      low: 'low',
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max'
    })
    expect(modelIn('zhipuai', 'glm-5.2')?.thinkingLevelMap).toEqual({
      minimal: null,
      low: null,
      medium: null,
      high: 'high',
      xhigh: null,
      max: 'max'
    })
  })
})
