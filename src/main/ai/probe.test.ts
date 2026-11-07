/** @vitest-environment node */
import { afterEach, describe, expect, it } from 'vitest'

import { describeProbeError, listRemoteModels, testProvider } from './probe'
import type { ProviderConfig } from './types'

/**
 * 「测试连接」失败时用户只看得到这一句话，它直接决定他下一步去改什么。
 * 说错方向的代价很实在：明明是对方服务端挂了，用户会一遍遍改 Base URL、
 * 换密钥、重新登录，全都没用。
 *
 * 这里断的是**归类**，不是措辞 —— 措辞归渲染层（`AIProviders/probeCopy.ts`），
 * 主进程只说「是哪一种」。改成回码正是为了让英文用户也读得懂这一句。
 */
describe('describeProbeError', () => {
  it.each([
    ['401 Unauthorized', 'unauthorized'],
    ['Request failed with status 403 forbidden', 'forbidden'],
    ['404 model not found', 'modelNotFound'],
    ['429 rate limit exceeded', 'rateLimited'],
    ['ECONNREFUSED 127.0.0.1:11434', 'unreachable'],
    ['The operation was aborted due to timeout', 'timeout']
  ])('%s → 归到正确的那一类', (raw, expected) => {
    expect(describeProbeError(new Error(raw)).code).toBe(expected)
  })

  it('403 带上原话：中转站的「客户端异常」也回 403，不能只说没权限', () => {
    const failure = describeProbeError(new Error('403 我们检测到您的客户端存在异常'))
    expect(failure.code).toBe('forbidden')
    expect(failure.raw).toContain('客户端存在异常')
  })

  /**
   * 5xx 必须明说是对方的问题。真实案例：Kimi 的 coding 端点对任何请求
   * （含 GET /models）都回 500，而界面只是把原文透出来，用户完全看不出
   * 这不是自己配错了。
   */
  describe('厂商服务端错误', () => {
    it.each([
      'AI_APICallError: 500 Internal Server Error',
      '{"error":{"message":"The server had an error while processing your request","type":"server_error"}}',
      'Failed after 3 attempts. Last error: The server had an error while processing your request'
    ])('%s → 归成「对方的问题」而不是限流', (raw) => {
      expect(describeProbeError(new Error(raw)).code).toBe('providerServerError')
    })

    // 原文要留着，否则没法据此去问厂商
    it('保留厂商原文', () => {
      expect(describeProbeError(new Error('500 server_error: quota pool missing')).raw).toContain(
        'quota pool missing'
      )
    })
  })

  /**
   * 400 的正文常常是空的，界面上就剩「Bad Request」四个字母。
   * 真实案例：ChatGPT 订阅被配成了 openai-responses —— 登录明明成功，
   * 一测连接就是这一句，而它一个字都没指向「协议选错了」。
   */
  describe('400 Bad Request', () => {
    it.each(['AI_APICallError: Bad Request', 'Request failed with status 400'])(
      '%s → 单独一类（文案里才指出模型 ID 与接口协议两个方向）',
      (raw) => {
        expect(describeProbeError(new Error(raw)).code).toBe('badRequest')
      }
    )

    it('不把 400 说成服务端故障', () => {
      expect(describeProbeError(new Error('400 Bad Request')).code).not.toBe('providerServerError')
    })
  })

  // 认不出来的原样透出，猜错方向比不猜更糟
  it('认不出的错误原样透出', () => {
    const failure = describeProbeError(new Error('某种没见过的错误'))
    expect(failure.code).toBe('unknown')
    expect(failure.raw).toBe('某种没见过的错误')
  })
})

/**
 * 向量化模型走的是 /embeddings，对话 ping 对它必然被厂商拒绝 ——
 * 拿百炼的 text-embedding 去打对话端点，回的就是一句
 * "Unsupported model ... for OpenAI compatibility mode"，
 * 配置明明是对的却永远测不过。这一组守住「按模型选探测方式」。
 */
describe('testProvider 的探测方式', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  /** 造一个记录请求地址的 /embeddings 桩，返回合法向量响应 */
  function stubEmbeddings(urls: string[]): void {
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url))
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ index: 0, embedding: [0.1, 0.2] }] })
      }
    }) as unknown as typeof fetch
  }

  function providerWith(
    models: ProviderConfig['models'],
    kind: ProviderConfig['kind'] = 'embedding'
  ): ProviderConfig {
    return {
      id: 'bailian',
      displayName: '阿里云百炼（向量化）',
      kind,
      protocol: 'openai-completions',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1/',
      apiKey: { kind: 'none' },
      models
    }
  }

  /**
   * 3D 这一档没有便宜的请求 —— 只有「提交一次生成」这一个入口，而提交就扣钱。
   * 拿对话 ping 去测必然 404，而 404 会被翻译成「模型不存在，请确认模型 ID」，
   * 于是用户去反复改一个本来就对的模型名。
   */
  it('3D / 视频用途一个请求都不发，并明说没测，而不是报一句误导的「模型不存在」', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) }
    }) as unknown as typeof fetch

    const result = await testProvider(
      providerWith([{ id: 'v3.1-20260211' }], 'model3d'),
      'v3.1-20260211'
    )

    expect(called, '不该发出任何请求').toBe(false)
    expect(result.ok).toBe(true)
    // ok 但带 skipped：界面据此显示成提示而不是绿勾
    expect(result.skipped).toBe('generativeNoCheapCall')
  })

  // 中转站上的生图模型只挂在 /images/generations，对话 ping 打过去 404，
  // 用户会被「模型不存在」指去反复改一个本来就对的模型名
  it('生图用途不拿对话 ping 去测', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) }
    }) as unknown as typeof fetch

    const result = await testProvider(
      providerWith([{ id: 'gemini-3.1-flash-image-preview' }], 'image'),
      'gemini-3.1-flash-image-preview'
    )

    expect(called, '不该发出任何请求').toBe(false)
    expect(result).toEqual({ ok: true, skipped: 'generativeNoCheapCall' })
  })

  // 实时语音、网页检索都没有 /chat/completions，对话 ping 的 404 会被说成「模型不存在」
  it('实时语音和网页检索不拿对话 ping 去测，也不去拉 /models', async () => {
    let called = false
    globalThis.fetch = (async () => {
      called = true
      return { ok: false, status: 404, text: async () => '', json: async () => ({}) }
    }) as unknown as typeof fetch

    for (const kind of ['realtime', 'search'] as const) {
      const provider = providerWith([{ id: 'gpt-realtime' }], kind)
      expect(await testProvider(provider, 'gpt-realtime')).toEqual({
        ok: true,
        skipped: 'noChatEndpoint'
      })
      expect(await listRemoteModels(provider)).toEqual({
        ok: false,
        error: { code: 'listUnsupportedGenerative' }
      })
    }
    expect(called, '不该发出任何请求').toBe(false)
  })

  it('anthropic-messages 协议从 /v1/models 拉模型列表', async () => {
    const urls: string[] = []
    globalThis.fetch = (async (url: string | URL | Request) => {
      urls.push(String(url))
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: [{ id: 'claude-b' }, { id: 'claude-a' }] })
      }
    }) as unknown as typeof fetch

    for (const baseUrl of ['https://token.uebox.ai', 'https://token.uebox.ai/v1/']) {
      const result = await listRemoteModels({
        ...providerWith([], 'chat'),
        protocol: 'anthropic-messages',
        baseUrl
      })
      expect(result).toEqual({
        ok: true,
        models: [
          { id: 'claude-a', supportsTools: true },
          { id: 'claude-b', supportsTools: true }
        ]
      })
    }
    expect(urls).toEqual([
      'https://token.uebox.ai/v1/models?limit=1000',
      'https://token.uebox.ai/v1/models?limit=1000'
    ])
  })

  it('anthropic-messages 两种鉴权都拉不到时让用户手填', async () => {
    let calls = 0
    globalThis.fetch = (async () => {
      calls++
      return { ok: false, status: 404, json: async () => ({}) }
    }) as unknown as typeof fetch

    const result = await listRemoteModels({
      ...providerWith([], 'chat'),
      protocol: 'anthropic-messages',
      baseUrl: 'https://example.com'
    })
    expect(result).toEqual({ ok: false, error: { code: 'listUnsupportedProtocol' } })
    expect(calls).toBe(2)
  })

  it('用途是向量化的 Provider 打 /embeddings，不带末尾双斜杠', async () => {
    const urls: string[] = []
    stubEmbeddings(urls)

    const result = await testProvider(
      providerWith([{ id: 'text-embedding-v4' }]),
      'text-embedding-v4'
    )

    expect(result.ok).toBe(true)
    expect(urls[0]).toBe('https://dashscope.aliyuncs.com/compatible-mode/v1/embeddings')
  })

  it('挂在通用网关（对话用途）下、但 id 长得像向量化模型的，仍打 /embeddings', async () => {
    const urls: string[] = []
    stubEmbeddings(urls)

    const result = await testProvider(
      providerWith([{ id: 'qwen3.7-text-embedding' }], 'chat'),
      'qwen3.7-text-embedding'
    )

    expect(result.ok).toBe(true)
    expect(urls[0]).toContain('/embeddings')
  })

  it('对话用途下 id 认不出向量化特征的，按对话模型探测', async () => {
    const urls: string[] = []
    stubEmbeddings(urls)

    // 用一个 id 里完全没有向量化特征词的模型：jina-chat 会被 'jina' 命中。
    // 对话 ping 会打到 /chat/completions —— 桩回的是向量形状，对话请求必然失败，
    // 但这条用例只关心「请求去了哪个端点」
    await testProvider(providerWith([{ id: 'glm-4-plus' }], 'chat'), 'glm-4-plus')

    expect(urls[0]).toContain('/chat/completions')
  })

  /*
   * 对话探测要和对话里同一种形状：带工具，会思考的模型带思考档位。只发光秃秃的 ping 时，
   * 「工具 + reasoning_effort」被拒的配置照样显示「连接成功」，一开工就 400。
   */
  describe('对话探测的请求形状', () => {
    function captureChatBody(bodies: Record<string, unknown>[]): void {
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body ?? '{}')))
        return new Response(
          JSON.stringify({
            id: 'x',
            object: 'chat.completion',
            created: 0,
            model: 'm',
            choices: [
              { index: 0, message: { role: 'assistant', content: 'pong' }, finish_reason: 'stop' }
            ]
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
      }) as unknown as typeof fetch
    }

    it('会思考、能调工具的模型：请求里带工具和思考档位', async () => {
      const bodies: Record<string, unknown>[] = []
      captureChatBody(bodies)

      await testProvider(
        providerWith([{ id: 'thinker', supportsTools: true, supportsReasoning: true }], 'chat'),
        'thinker'
      )

      expect(bodies[0]?.tools).toBeDefined()
      expect(bodies[0]?.reasoning_effort).toBeDefined()
    })

    it('不会思考、标明不能调工具的模型：两样都不带，免得误报', async () => {
      const bodies: Record<string, unknown>[] = []
      captureChatBody(bodies)

      await testProvider(
        providerWith([{ id: 'plain', supportsTools: false, supportsReasoning: false }], 'chat'),
        'plain'
      )

      expect(bodies[0]?.tools).toBeUndefined()
      expect(bodies[0]?.reasoning_effort).toBeUndefined()
    })
  })

  it('向量化探测的失败走同一套错误翻译', async () => {
    globalThis.fetch = (async () =>
      ({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'Invalid API key' } })
      }) as unknown as Response) as unknown as typeof fetch

    const result = await testProvider(
      providerWith([{ id: 'text-embedding-v4' }]),
      'text-embedding-v4'
    )

    expect(result.ok).toBe(false)
    expect(result.error?.code).toBe('unauthorized')
  })
})
