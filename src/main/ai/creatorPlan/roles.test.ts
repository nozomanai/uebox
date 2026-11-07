/** @vitest-environment node */
/**
 * 非对话角色调套餐来源：每个角色的分支按协议说话（假 fetch）。
 *
 * 嵌入 03、生图 04、语音合成 06、检索 08、判定 09。任务类（05）见 tasks.test.ts，
 * 语音识别见 stt/ueboxStt.test.ts，实时语音见 realtime/openaiRealtime.test.ts。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '../types'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/uebox-plan-roles-test' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf-8')
  }
}))

const planState = vi.hoisted(() => ({
  manifest: null as null | { roles: Record<string, unknown> },
  unauthorized: false
}))
vi.mock('./planState', () => ({
  readPlanState: async () => ({
    originals: {},
    etag: null,
    manifest: planState.manifest,
    unauthorized: planState.unauthorized
  }),
  updatePlanState: async (patch: { unauthorized?: boolean }) => {
    if (patch.unauthorized !== undefined) planState.unauthorized = patch.unauthorized
  }
}))

const settings = vi.hoisted(() => ({
  version: 3,
  providers: [] as ProviderConfig[],
  roles: {} as Record<string, { providerId: string; modelId: string }>
}))
vi.mock('../store', () => ({ readSettings: async () => settings }))

const { requestEmbeddings } = await import('../embedding')
const { requestJudgement, fromPlanAnswers, toPlanQuestions, confidentScore } = await import(
  '../judge'
)
const { generateImages } = await import('../imageGeneration')
const { requestSpeech } = await import('../speech')
const { searchViaPlan } = await import('./search')
const { CreatorPlanCallError } = await import('./callError')

const KEY = 'ubx-sk-test'
const BASE = 'https://plan.example/v1'

function planProvider(id: string, kind: ProviderConfig['kind'], model: string): ProviderConfig {
  return {
    id,
    displayName: 'Box Plan',
    kind,
    protocol: 'openai-completions',
    baseUrl: BASE,
    apiKey: { kind: 'env', name: 'UEBOX_PLAN_TEST_KEY' },
    models: [{ id: model }]
  }
}

interface Call {
  url: string
  init: RequestInit
  body: Record<string, unknown> | null
}

function stubFetch(handler: (call: Call) => Response | Promise<Response>): Call[] {
  const calls: Call[] = []
  vi.stubGlobal('fetch', async (url: string, init: RequestInit = {}) => {
    const body =
      typeof init.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    const call = { url: String(url), init, body }
    calls.push(call)
    return handler(call)
  })
  return calls
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const planError = (status: number, code: string): Response =>
  json({ error: { type: 'x', code, message: code } }, status)

beforeEach(() => {
  process.env.UEBOX_PLAN_TEST_KEY = KEY
  planState.manifest = null
  planState.unauthorized = false
  settings.providers = []
  settings.roles = {}
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('嵌入（03-embeddings）', () => {
  const provider = {
    ...planProvider('creator-plan-embedding', 'embedding', 'uebox-embed-v1'),
    models: [
      { id: 'uebox-embed-v1', embeddingApi: 'jina-embeddings' as const, embeddingDimensions: 1024 }
    ]
  }

  it('POST /embeddings，查询发 retrieval.query，维度固定 1024；按 index 回填', async () => {
    const calls = stubFetch(() =>
      json({
        data: [
          { index: 1, embedding: [2] },
          { index: 0, embedding: [1] }
        ]
      })
    )
    const vectors = await requestEmbeddings(
      provider,
      'uebox-embed-v1',
      ['a', 'b'],
      'query',
      provider.models[0]
    )
    expect(vectors).toEqual([[1], [2]])
    expect(calls[0].url).toBe(`${BASE}/embeddings`)
    expect(calls[0].body).toEqual({
      model: 'uebox-embed-v1',
      input: ['a', 'b'],
      dimensions: 1024,
      task: 'retrieval.query'
    })
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`)
  })

  it('402 quota_exhausted 换成说清下一步的话；别的来源的 402 照旧', async () => {
    stubFetch(() => planError(402, 'quota_exhausted'))
    const error = await requestEmbeddings(provider, 'uebox-embed-v1', ['a'], 'document').catch(
      (e: unknown) => e
    )
    expect(error).toBeInstanceOf(CreatorPlanCallError)
    expect((error as Error).message).toContain('额度已用完')
    expect((error as Error).message).toContain('设置 → 模型')

    const other = { ...provider, id: 'jina' }
    await expect(requestEmbeddings(other, 'x', ['a'], 'document')).rejects.not.toBeInstanceOf(
      CreatorPlanCallError
    )
  })

  it('401 记成授权失效，卡片不用等下一次刷新清单', async () => {
    stubFetch(() => planError(401, 'unauthorized'))
    await expect(requestEmbeddings(provider, 'uebox-embed-v1', ['a'], 'document')).rejects.toThrow(
      '重新连接'
    )
    await vi.waitFor(() => expect(planState.unauthorized).toBe(true))
  })
})

describe('判定（09-judge）', () => {
  const provider = planProvider('creator-plan-judge', 'judge', 'uebox-judge')

  it('POST /judge：noul → boolean，结构化 state 序列化成文本；答案映射回我们的形状', async () => {
    const calls = stubFetch(() =>
      json({
        model: 'uebox-judge',
        answers: {
          destructive: { type: 'boolean', value: true, probability: 0.97 },
          intent: {
            type: 'choice',
            value: 'cleanup',
            probabilities: { cleanup: 0.88, other: 0.12 },
            confidence: 0.88
          },
          clarity: {
            type: 'score',
            value: 1,
            probabilities: [0.12, 0.71, 0.17],
            confidence: 0.71
          },
          unknown: null
        }
      })
    )
    const result = await requestJudgement(
      provider,
      'uebox-judge',
      { user: '清掉 Content/Old' },
      {
        destructive: { type: 'noul', instructions: 'Deletes data?' },
        intent: {
          type: 'choice',
          instructions: 'Intent?',
          criteria: { cleanup: null, other: null }
        },
        clarity: { type: 'score', instructions: 'Clear?', criteria: ['no', 'some', 'very'] },
        unknown: { type: 'noul', instructions: 'x' }
      }
    )
    expect(calls[0].url).toBe(`${BASE}/judge`)
    expect(calls[0].body?.state).toBe('{"user":"清掉 Content/Old"}')
    expect((calls[0].body?.questions as Record<string, { type: string }>).destructive.type).toBe(
      'boolean'
    )
    expect(result.answers.destructive).toEqual({ type: 'noul', noul: 0.97 })
    expect(result.answers.intent).toMatchObject({
      type: 'choice',
      choice: 'cleanup',
      confidence: 0.88
    })
    // 判不了的问题不出现
    expect(result.answers.unknown).toBeUndefined()
    const clarity = result.answers.clarity
    expect(clarity?.type).toBe('score')
    if (clarity?.type !== 'score') return
    // 协议的 value 是最可能档位的下标，放在 level；score 是由分布算出的期望档位
    expect(clarity.level).toBe(1)
    expect(clarity.score).toBeCloseTo(0.12 * 0 + 0.71 * 1 + 0.17 * 2)
    expect(confidentScore(clarity, 0.7)).toBe(1)
  })

  it('期望档位和最可能档位不一样的时候，两个都给对', () => {
    const answers = fromPlanAnswers({
      q: { type: 'score', value: 0, probabilities: [0.45, 0.1, 0.45], confidence: 0.2 }
    })
    expect(answers.q).toMatchObject({ type: 'score', level: 0, score: 1 })
  })

  it('instructions 只收字符串', () => {
    expect(
      toPlanQuestions({ q: { type: 'noul', instructions: { ask: 'x' } } }).q.instructions
    ).toBe('{"ask":"x"}')
  })

  it('403 role_not_in_plan 换成套餐文案', async () => {
    stubFetch(() => planError(403, 'role_not_in_plan'))
    await expect(
      requestJudgement(provider, 'uebox-judge', 'x', { q: { type: 'noul', instructions: 'y' } })
    ).rejects.toThrow('套餐不包含该角色')
  })
})

describe('生图（04-images）', () => {
  const provider = {
    ...planProvider('creator-plan-image', 'image', 'uebox-image'),
    models: [{ id: 'uebox-image', imageApi: 'uebox-images' as const }]
  }

  beforeEach(() => {
    settings.providers = [provider]
    settings.roles = { image: { providerId: 'creator-plan-image', modelId: 'uebox-image' } }
  })

  it('带参考图打 /images/edits（multipart，每张一个 image[]），档位按比例换成像素；按 mime_type 取图', async () => {
    const calls = stubFetch(() =>
      json({
        created: 1,
        data: [{ b64_json: 'AAAA', mime_type: 'image/webp' }],
        usage: { images: 1 }
      })
    )
    const images = await generateImages({
      prompt: '雨夜小巷',
      count: 1,
      size: '2k',
      aspectRatio: '16:9',
      seed: 7,
      referenceImages: ['data:image/jpeg;base64,/9j/', 'iVBORw0KGgo=']
    })
    expect(images).toEqual([{ base64: 'AAAA', mediaType: 'image/webp' }])
    expect(calls[0].url).toBe(`${BASE}/images/edits`)
    const form = calls[0].init.body as FormData
    expect(form.getAll('image[]')).toHaveLength(2)
    expect(form.get('model')).toBe('uebox-image')
    expect(form.get('n')).toBe('1')
    expect(form.get('size')).toBe('2736x1536')
    expect(form.has('image_urls')).toBe(false)
    expect(form.has('aspect_ratio')).toBe(false)
  })

  it('202 任务单：轮询 GET /images/generations/{id}，成功后从 result 取图', async () => {
    vi.useFakeTimers()
    try {
      const calls = stubFetch((call) =>
        call.init.method === 'POST'
          ? json({ id: 'img_1', status: 'queued', model: 'uebox-image' }, 202)
          : json({
              id: 'img_1',
              status: 'succeeded',
              model: 'uebox-image',
              result: { created: 1, data: [{ b64_json: 'BBBB', mime_type: 'image/png' }] }
            })
      )
      const pending = generateImages({ prompt: 'x' })
      await vi.advanceTimersByTimeAsync(7_000)
      expect(await pending).toEqual([{ base64: 'BBBB', mediaType: 'image/png' }])
      expect(calls[1].url).toBe(`${BASE}/images/generations/img_1`)
    } finally {
      vi.useRealTimers()
    }
  })

  it('张数按清单 max_images 截到上限', async () => {
    planState.manifest = { roles: { image: { model: 'uebox-image', max_images: 2 } } }
    const calls = stubFetch(() =>
      json({ created: 1, data: [{ b64_json: 'A', mime_type: 'image/png' }] })
    )
    await generateImages({ prompt: 'x', count: 6 })
    expect(calls[0].body?.n).toBe(2)
  })

  it('402 subscription_inactive：文案带「设置 → 模型」，AI 创作那边原样透出', async () => {
    stubFetch(() => planError(402, 'subscription_inactive'))
    await expect(generateImages({ prompt: 'x' })).rejects.toThrow(/订阅[\s\S]*设置 → 模型/)
  })

  it('429 daily_limit_reached：不再发一次，说今天的额度用完、几点恢复', async () => {
    const calls = stubFetch(
      () =>
        new Response(JSON.stringify({ error: { code: 'daily_limit_reached', message: 'x' } }), {
          status: 429,
          headers: { 'X-Uebox-Daily-Reset': new Date(Date.now() + 3_600_000).toISOString() }
        })
    )
    await expect(generateImages({ prompt: 'x' })).rejects.toThrow(
      /今日额度已用完，.+ 恢复[\s\S]*设置 → 模型/
    )
    expect(calls).toHaveLength(1)
  })
})

describe('语音合成（06-audio）', () => {
  const provider = {
    ...planProvider('creator-plan-tts', 'tts', 'uebox-tts'),
    models: [{ id: 'uebox-tts', ttsVoice: 'uebox-voice-f2' }]
  }

  function sse(events: unknown[]): Response {
    const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')
    return new Response(text, { headers: { 'Content-Type': 'text/event-stream' } })
  }

  it('POST /audio/speech SSE + pcm；半个采样留给下一片，输出 PCM 24k', async () => {
    const calls = stubFetch(() =>
      sse([
        { type: 'speech.audio.delta', audio: Buffer.from([1, 2, 3]).toString('base64') },
        { type: 'speech.audio.delta', audio: Buffer.from([4]).toString('base64') },
        { type: 'speech.audio.done', usage: { input_characters: 2 } }
      ])
    )
    const chunks: Buffer[] = []
    await requestSpeech(provider, 'uebox-tts', '你好', new AbortController().signal, (chunk) => {
      expect(chunk).toMatchObject({ format: 'pcm_s16le', sampleRate: 24000 })
      chunks.push(Buffer.from(chunk.base64, 'base64'))
    })
    expect(chunks.map((c) => [...c])).toEqual([
      [1, 2],
      [3, 4]
    ])
    expect(calls[0].url).toBe(`${BASE}/audio/speech`)
    expect(calls[0].body).toEqual({
      model: 'uebox-tts',
      input: '你好',
      voice: 'uebox-voice-f2',
      response_format: 'pcm',
      stream_format: 'sse'
    })
  })

  it('不是 uebox-voice-* 的音色不发（落盘归一化补的是豆包缺省音色），服务端用 default_voice', async () => {
    const calls = stubFetch(() =>
      sse([
        { type: 'speech.audio.delta', audio: Buffer.from([1, 2]).toString('base64') },
        { type: 'speech.audio.done' }
      ])
    )
    await requestSpeech(
      { ...provider, models: [{ id: 'uebox-tts', ttsVoice: 'zh_female_vv_uranus_bigtts' }] },
      'uebox-tts',
      'x',
      new AbortController().signal
    )
    expect(calls[0].body).not.toHaveProperty('voice')
  })

  it('单次上限取模型上的 ttsMaxInputChars（导入时来自清单 max_input_chars）', async () => {
    const limited = {
      ...provider,
      models: [{ id: 'uebox-tts', ttsVoice: 'uebox-voice-f2', ttsMaxInputChars: 2000 }]
    }
    stubFetch(() =>
      sse([
        { type: 'speech.audio.delta', audio: Buffer.from([1, 2]).toString('base64') },
        { type: 'speech.audio.done' }
      ])
    )
    await expect(
      requestSpeech(limited, 'uebox-tts', '字'.repeat(1500), new AbortController().signal)
    ).resolves.toBeUndefined()
    await expect(
      requestSpeech(limited, 'uebox-tts', '字'.repeat(2001), new AbortController().signal)
    ).rejects.toThrow('TTS_INVALID_TEXT')
    // 没写上限的按 600 字
    await expect(
      requestSpeech(provider, 'uebox-tts', '字'.repeat(601), new AbortController().signal)
    ).rejects.toThrow('TTS_INVALID_TEXT')
  })

  it('402 额度用完 → TTS_PLAN_QUOTA_EXHAUSTED，原话挂在 cause 上', async () => {
    stubFetch(() => planError(402, 'quota_exhausted'))
    const error = (await requestSpeech(
      provider,
      'uebox-tts',
      'x',
      new AbortController().signal
    ).catch((e: unknown) => e)) as Error
    expect(error.message).toBe('TTS_PLAN_QUOTA_EXHAUSTED')
    expect(error.cause).toBeInstanceOf(CreatorPlanCallError)
  })

  it('流里的 error 事件 → TTS_PROVIDER_<码>', async () => {
    stubFetch(() => sse([{ type: 'error', error: { code: 'content_blocked', message: 'no' } }]))
    await expect(
      requestSpeech(provider, 'uebox-tts', 'x', new AbortController().signal)
    ).rejects.toThrow('TTS_PROVIDER_CONTENT_BLOCKED')
  })
})

describe('网页检索（08-search）', () => {
  it('POST /search，snippet / published_at 对上；查询超过 400 字截断', async () => {
    const calls = stubFetch(() =>
      json({
        model: 'uebox-search',
        results: [
          {
            title: 'Nanite',
            url: 'https://a.example',
            snippet: 's',
            published_at: '2026-08-14T00:00:00Z',
            score: 0.9
          },
          { title: 'no url' }
        ],
        usage: { searches: 1 }
      })
    )
    const items = await searchViaPlan({
      baseUrl: `${BASE}/`,
      apiKey: KEY,
      model: 'uebox-search',
      query: 'q'.repeat(500),
      limit: 5,
      language: 'zh-CN'
    })
    expect(items).toEqual([
      {
        title: 'Nanite',
        url: 'https://a.example',
        snippet: 's',
        publishedAt: '2026-08-14T00:00:00Z'
      }
    ])
    expect(calls[0].url).toBe(`${BASE}/search`)
    expect(calls[0].body).toMatchObject({ model: 'uebox-search', limit: 5, language: 'zh-CN' })
    expect((calls[0].body?.query as string).length).toBe(400)
  })

  it('402 额度用完抛 CreatorPlanCallError；别的错误带上状态码', async () => {
    stubFetch(() => planError(402, 'quota_exhausted'))
    await expect(
      searchViaPlan({ baseUrl: BASE, apiKey: KEY, model: 'uebox-search', query: 'q', limit: 5 })
    ).rejects.toBeInstanceOf(CreatorPlanCallError)
    stubFetch(() => planError(503, 'upstream_unavailable'))
    await expect(
      searchViaPlan({ baseUrl: BASE, apiKey: KEY, model: 'uebox-search', query: 'q', limit: 5 })
    ).rejects.toThrow('HTTP 503')
  })
})
