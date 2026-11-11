/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TranscriptContext } from '@earendil-works/pi-ai'

/**
 * 输入框里那个「思考程度」最终只落到一个地方：streamFn 传给 pi 的
 * `reasoning`。这条线断在任何一节，界面上的表现都一样 —— 选了没反应，
 * 而且没有任何提示。所以在这里钉住。
 */

const streamSimple = vi.fn()
const getSupportedThinkingLevels = vi.fn()
const PI_MODEL = { id: 'm1', provider: 'p', api: 'openai-codex-responses' }
/** pi-ai 被下面整个 mock 掉了，拿不到 normalizeContext；空 transcript 直接按类型断言 */
const EMPTY_CONTEXT = { messages: [] } as unknown as TranscriptContext
/** 按模型 id 换掉 getModel 的返回，没登记的一律是 PI_MODEL */
const MODELS_BY_ID: Record<string, unknown> = {}

vi.mock('@earendil-works/pi-ai', async () => {
  const actual =
    await vi.importActual<typeof import('@earendil-works/pi-ai')>('@earendil-works/pi-ai')
  return {
    createAssistantMessageEventStream: actual.createAssistantMessageEventStream,
    createModels: () => ({
      setProvider: vi.fn(),
      getModel: (_provider: string, id: string) => MODELS_BY_ID[id] ?? PI_MODEL,
      streamSimple
    }),
    getSupportedThinkingLevels: (model: unknown) => getSupportedThinkingLevels(model)
  }
})

vi.mock('./piModel', async (importOriginal) => ({
  thinkingOffFields: (await importOriginal<typeof import('./piModel')>()).thinkingOffFields,
  toPiProvider: () => ({ getModels: () => [PI_MODEL] })
}))

const readSettings = vi.fn()
// requestBudget 订阅 onSettingsChanged 来忘掉学到的上限，桩里也得有
vi.mock('../../ai/store', () => ({
  readSettings: () => readSettings(),
  onSettingsChanged: () => () => {}
}))

const {
  resolveAgentModel,
  listThinkingLevels,
  invalidateProviderCache,
  resetImageRejectionsForTest,
  withTopLevelErrorMessage
} = await import('./streamFn')
const {
  DEFAULT_REQUEST_MAX_BYTES,
  budgetFor,
  __testing: __budgetTesting
} = await import('./requestBudget')
const { mediaRefText, parseMediaRef, __testing: __mediaTesting } = await import('./promptMedia')
const { createAssistantMessageEventStream } = await import('@earendil-works/pi-ai')

const SETTINGS = {
  version: 1 as const,
  providers: [
    {
      id: 'p',
      displayName: 'P',
      protocol: 'openai-codex-responses' as const,
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      apiKey: { kind: 'none' as const },
      models: [{ id: 'm1' }]
    }
  ],
  roles: { agent: { providerId: 'p', modelId: 'm1' } }
}

/** 跑一次 streamFn，把它实际传给 pi 的 options 还回来 */
async function optionsPassedToPi(
  thinkingLevel?: 'auto' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
): Promise<Record<string, unknown>> {
  const runtime = await resolveAgentModel({ role: 'agent' }, thinkingLevel)
  runtime.streamFn(PI_MODEL as never, EMPTY_CONTEXT, undefined as never)
  return streamSimple.mock.calls.at(-1)?.[2] as Record<string, unknown>
}

beforeEach(() => {
  streamSimple.mockReset()
  getSupportedThinkingLevels.mockReset().mockReturnValue(['off', 'high', 'max'])
  readSettings.mockReset().mockResolvedValue(SETTINGS)
  // 模型集合按「配置内容」缓存，测试之间要清掉才不会互相串
  invalidateProviderCache()
  resetImageRejectionsForTest()
  for (const id of Object.keys(MODELS_BY_ID)) delete MODELS_BY_ID[id]
})

/**
 * 界面上那个下拉列哪几档，取决于这里 —— 档位是模型自己声明的，
 * 我们只负责如实转达。写死一份清单会列出模型根本没有的档位。
 */
describe('listThinkingLevels', () => {
  it('如实报出内核给的档位，不自己加工', async () => {
    const options = await listThinkingLevels({ role: 'agent' })

    expect(options?.levels).toEqual(['off', 'high', 'max'])
    expect(options?.modelId).toBe('m1')
  })

  // 画个下拉而已，没配模型不该升级成一次报错弹窗
  it('模型没配好时回 null 而不是抛错', async () => {
    readSettings.mockResolvedValue({ ...SETTINGS, roles: {} })
    invalidateProviderCache()

    await expect(listThinkingLevels({ role: 'agent' })).resolves.toBeNull()
  })
})

describe('思考程度 → pi 的 reasoning', () => {
  /**
   * 八档全都要原样传下去，由内核按模型夹。
   *
   * `off` 特别容易漏：pi 的 `reasoning` 参数类型里没有它（类型比运行时契约窄），
   * 一不小心就会在转换时被当成「没选」丢掉 —— 表现是「不思考」这一档点了没反应。
   * `max` 同理，早期只列到 high 的实现会把它整个吞掉。
   */
  it.each([
    ['off', 'off'],
    ['minimal', 'minimal'],
    ['low', 'low'],
    ['medium', 'medium'],
    ['high', 'high'],
    ['xhigh', 'xhigh'],
    ['max', 'max']
  ])('选了 %s 就原样传下去', async (choice, expected) => {
    const options = await optionsPassedToPi(choice as 'low')
    expect(options.reasoning).toBe(expected)
  })

  /**
   * `auto` 是**不指定**，不是「最低」——请求里干脆不带这个字段。
   * 传成某个具体档位会悄悄改掉所有没动过这个开关的用户的行为。
   */
  it.each([['auto'], [undefined]])('%s 时完全不带 reasoning 字段', async (choice) => {
    const options = await optionsPassedToPi(choice as undefined)
    expect(options).not.toHaveProperty('reasoning')
  })

  // MiMo 默认开思考，光传 off 它照想 —— 「不思考」要在请求体里补它家的字段
  it('选 off 时给 MiMo 补关思考的字段；auto 不补', async () => {
    const mimo = { ...PI_MODEL, baseUrl: 'https://token-plan-cn.xiaomimimo.com/v1' }
    const passed = async (level: 'auto' | 'off'): Promise<Record<string, unknown>> => {
      const runtime = await resolveAgentModel({ role: 'agent' }, level)
      runtime.streamFn(mimo as never, EMPTY_CONTEXT, undefined as never)
      return streamSimple.mock.calls.at(-1)?.[2] as Record<string, unknown>
    }

    expect((await passed('off')).samplingParams).toEqual({ thinking: { type: 'disabled' } })
    expect(await passed('auto')).not.toHaveProperty('samplingParams')
  })

  // pi 的 Agent 每轮会带自己的 options（signal 之类），不能被覆盖掉
  it('保留 pi 自己传进来的 options', async () => {
    const runtime = await resolveAgentModel({ role: 'agent' }, 'high')
    const signal = new AbortController().signal
    runtime.streamFn(PI_MODEL as never, EMPTY_CONTEXT, { signal } as never)

    const options = streamSimple.mock.calls.at(-1)?.[2] as Record<string, unknown>
    expect(options.signal).toBe(signal)
    expect(options.reasoning).toBe('high')
  })
})

// 模型菜单里的「快速」：Codex 订阅在请求体里带 service_tier=priority，别家不碰
describe('快速模式', () => {
  const payloadSent = async (
    model: Record<string, unknown>,
    fastMode: boolean,
    onPayload?: (payload: unknown) => unknown
  ): Promise<unknown> => {
    const runtime = await resolveAgentModel({ role: 'agent' }, 'auto', fastMode)
    runtime.streamFn(
      model as never,
      EMPTY_CONTEXT,
      (onPayload ? { onPayload } : undefined) as never
    )
    const options = streamSimple.mock.calls.at(-1)?.[2] as {
      onPayload?: (payload: unknown, model: unknown) => Promise<unknown>
    }
    const body = { model: 'm1' }
    return (await options.onPayload?.(body, model)) ?? body
  }

  it('Codex 订阅开了就带 priority，并保留 pi 自己的 onPayload', async () => {
    const upstream = (payload: unknown): unknown => ({ ...(payload as object), store: false })
    expect(await payloadSent(PI_MODEL, true, upstream)).toEqual({
      model: 'm1',
      store: false,
      service_tier: 'priority'
    })
  })

  it('没开、或者不是 Codex 订阅：请求体不动', async () => {
    expect(await payloadSent(PI_MODEL, false)).toEqual({ model: 'm1' })
    expect(await payloadSent({ ...PI_MODEL, api: 'openai-responses' }, true)).toEqual({
      model: 'm1'
    })
  })

  it('Cursor Grok 带上 cursorContext', async () => {
    const cursorModel = { id: 'grok-4.7', provider: 'cursor', api: 'cursor-agent' }
    MODELS_BY_ID['grok-4.7'] = cursorModel
    const runtime = await resolveAgentModel({ role: 'agent' }, 'auto', false, '500k')
    runtime.streamFn(cursorModel as never, EMPTY_CONTEXT, undefined as never)
    const options = streamSimple.mock.calls.at(-1)?.[2] as {
      samplingParams?: { cursorContext?: string }
    }
    expect(options?.samplingParams?.cursorContext).toBe('500k')
  })

  it('Cursor Grok 开了 Fast 走 samplingParams.cursorFast，不加 service_tier', async () => {
    const cursorModel = {
      id: 'grok-4.7',
      provider: 'cursor',
      api: 'cursor-agent'
    }
    MODELS_BY_ID['grok-4.7'] = cursorModel
    const runtime = await resolveAgentModel({ role: 'agent' }, 'auto', true)
    runtime.streamFn(cursorModel as never, EMPTY_CONTEXT, undefined as never)
    const options = streamSimple.mock.calls.at(-1)?.[2] as {
      samplingParams?: { cursorFast?: boolean }
      onPayload?: unknown
    }
    expect(options?.samplingParams?.cursorFast).toBe(true)
    expect(options?.onPayload).toBeUndefined()
  })

  it('档位清单里报出这个模型能不能开', async () => {
    expect((await listThinkingLevels({ role: 'agent' }))?.fastMode).toBe(true)
  })
})

/**
 * 出口闸挂在这条 streamFn 上，理由和 reasoning 一样：**这是全应用唯一一条
 * 把请求交给厂商的路**。工具那边压没压是各管各的，这里是最后一道。
 */
describe('出口闸', () => {
  const bigImage = (kb: number): unknown => ({
    role: 'user',
    content: [{ type: 'image', data: 'A'.repeat(kb * 1024), mimeType: 'image/jpeg' }],
    timestamp: 0
  })

  /** 让 streamSimple 返回一个带 result() 的流，模拟厂商这一轮的结局 */
  function respondWith(final: { stopReason?: string; errorMessage?: string }): void {
    streamSimple.mockReturnValue({ result: () => Promise.resolve(final) })
  }

  beforeEach(() => __budgetTesting.resetObservedLimits())

  it('预算之内的请求原样发出去', async () => {
    const runtime = await resolveAgentModel({ role: 'agent' })
    const context = { messages: [bigImage(100)] }
    runtime.streamFn(PI_MODEL as never, context as never, undefined as never)

    expect(streamSimple.mock.calls.at(-1)?.[1]).toBe(context)
  })

  // 超预算的那一轮不该整个失败：丢最老的图，正在问的那张留着
  it('超预算时把最老的图换掉再发', async () => {
    const runtime = await resolveAgentModel({ role: 'agent' })
    const context = {
      messages: [bigImage(1600), bigImage(1600), bigImage(1600)]
    }
    runtime.streamFn(PI_MODEL as never, context as never, undefined as never)

    const sent = streamSimple.mock.calls.at(-1)?.[1] as { messages: unknown[] }
    expect(sent).not.toBe(context)
    expect(JSON.stringify(sent).length).toBeLessThan(JSON.stringify(context).length)
    // 原来那份一个字节都没动 —— 换个上限更宽的模型，那些图还要回来
    expect((context.messages[0] as { content: Array<{ type: string }> }).content[0].type).toBe(
      'image'
    )
  })

  /**
   * 各家网关的上限不公开，猜不准，所以从 413 里学。
   * 这一轮救不回来，但用户点「继续尝试」时已经按新预算投影了。
   */
  it('厂商退 413 就把这家的预算调低', async () => {
    const runtime = await resolveAgentModel({ role: 'agent' })
    respondWith({
      stopReason: 'error',
      errorMessage: '413 <html><head><title>413 Request Entity Too Large</title></head></html>'
    })

    runtime.streamFn(PI_MODEL as never, { messages: [bigImage(500)] } as never, undefined as never)
    await vi.waitFor(() => expect(budgetFor('p')).toBeLessThan(DEFAULT_REQUEST_MAX_BYTES))
  })

  // 别的错误和这件事无关，学错了会平白开始丢图
  it('别的错误不影响预算', async () => {
    const runtime = await resolveAgentModel({ role: 'agent' })
    respondWith({ stopReason: 'error', errorMessage: '401: {"error":{"message":"bad key"}}' })

    runtime.streamFn(PI_MODEL as never, { messages: [bigImage(500)] } as never, undefined as never)
    await Promise.resolve()

    expect(budgetFor('p')).toBe(DEFAULT_REQUEST_MAX_BYTES)
  })

  // 旁听是可选的：拿到一个没有 result() 的流也不能让这一轮发不出去
  it('流上没有 result() 时照常返回', async () => {
    const runtime = await resolveAgentModel({ role: 'agent' })
    streamSimple.mockReturnValue({ notAStream: true })

    expect(() =>
      runtime.streamFn(PI_MODEL as never, EMPTY_CONTEXT as never, undefined as never)
    ).not.toThrow()
  })
})

/**
 * 厂商拉不下链接里的视频时，整轮不该失败：换成说明重发一次，
 * 之后这个对象不再给这家发链接 —— 否则工具循环每一步都要再撞一次 400。
 */
describe('厂商拉不下多媒体链接', () => {
  const VIDEO_SETTINGS = {
    ...SETTINGS,
    providers: [
      {
        ...SETTINGS.providers[0],
        protocol: 'openai-completions' as const,
        models: [{ id: 'm1', supportsVideo: true }]
      }
    ]
  }
  const REF = {
    kind: 'video' as const,
    key: 'uebox-media/v.avi',
    fileName: 'v.avi',
    filePath: 'C:\\v.avi'
  }
  const context = {
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: '看这段' },
          { type: 'text', text: mediaRefText(REF) }
        ],
        timestamp: 0
      }
    ]
  }
  const assistant = (stopReason: string, errorMessage?: string): Record<string, unknown> => ({
    role: 'assistant',
    content: [],
    stopReason,
    ...(errorMessage ? { errorMessage } : {})
  })
  /** 一个只推一个结局事件的流，模拟厂商这一次的回应 */
  function streamEnding(event: Record<string, unknown>): unknown {
    const stream = createAssistantMessageEventStream()
    stream.push(event as never)
    stream.end()
    return stream
  }
  const sentRefs = (call: number): unknown => {
    const sent = streamSimple.mock.calls[call][1] as typeof context
    return parseMediaRef(sent.messages[0].content[1].text)
  }

  beforeEach(() => {
    __mediaTesting.resetUnfetchable()
    readSettings.mockResolvedValue(VIDEO_SETTINGS)
  })

  it('换成说明重发，调用方拿到的是重发的结果', async () => {
    const MEDIA_400 =
      '400: {"code":"400","message":"Param Incorrect","param":"failed to download or process media content"}'
    streamSimple
      .mockReturnValueOnce(
        streamEnding({ type: 'error', reason: 'error', error: assistant('error', MEDIA_400) })
      )
      .mockReturnValueOnce(
        streamEnding({ type: 'done', reason: 'stop', message: assistant('stop') })
      )
    const runtime = await resolveAgentModel({ role: 'agent' })

    const stream = await runtime.streamFn(PI_MODEL as never, context as never, undefined as never)

    await expect(stream.result()).resolves.toMatchObject({ stopReason: 'stop' })
    expect(streamSimple).toHaveBeenCalledTimes(2)
    expect(sentRefs(0)).toEqual(REF)
    expect(sentRefs(1)).toBeNull()

    // 下一步不再先撞一次
    streamSimple.mockReturnValueOnce(
      streamEnding({ type: 'done', reason: 'stop', message: assistant('stop') })
    )
    await runtime.streamFn(PI_MODEL as never, context as never, undefined as never)
    expect(sentRefs(2)).toBeNull()
  })

  it('别的错误原样交回，不重发', async () => {
    streamSimple.mockReturnValueOnce(
      streamEnding({
        type: 'error',
        reason: 'error',
        error: assistant('error', '401: {"error":{"message":"bad key"}}')
      })
    )
    const runtime = await resolveAgentModel({ role: 'agent' })

    const stream = await runtime.streamFn(PI_MODEL as never, context as never, undefined as never)

    await expect(stream.result()).resolves.toMatchObject({ stopReason: 'error' })
    expect(streamSimple).toHaveBeenCalledTimes(1)
  })
})

/**
 * CodeBuddy 的 hy4：带图的请求过了约 14 万 token 多半回空 400，不带图照收。
 * 被拒就去掉图片重发一次，这一轮照样有回答。
 */
describe('CodeBuddy 带图的请求被拒', () => {
  const CODEBUDDY = {
    ...PI_MODEL,
    baseUrl: 'https://copilot.tencent.com/v2',
    input: ['text', 'image']
  }
  const withImage = {
    messages: [
      {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'ue_screenshot',
        content: [
          { type: 'text', text: '截好了' },
          { type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }
        ],
        isError: false,
        timestamp: 0
      }
    ]
  }
  function streamEnding(event: Record<string, unknown>): unknown {
    const stream = createAssistantMessageEventStream()
    stream.push(event as never)
    stream.end()
    return stream
  }
  const rejected = (): unknown =>
    streamEnding({
      type: 'error',
      reason: 'error',
      error: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: '400 status code (no body)'
      }
    })
  const ok = (): unknown =>
    streamEnding({
      type: 'done',
      reason: 'stop',
      message: { role: 'assistant', content: [], stopReason: 'stop' }
    })

  it('去掉图片重发（模型按只收文字发），调用方拿到的是重发的结果', async () => {
    streamSimple.mockReturnValueOnce(rejected()).mockReturnValueOnce(ok())
    const runtime = await resolveAgentModel({ role: 'agent' })

    const stream = await runtime.streamFn(
      CODEBUDDY as never,
      withImage as never,
      undefined as never
    )

    await expect(stream.result()).resolves.toMatchObject({ stopReason: 'stop' })
    expect(streamSimple).toHaveBeenCalledTimes(2)
    expect(streamSimple.mock.calls[0][0]).toMatchObject({ input: ['text', 'image'] })
    expect(streamSimple.mock.calls[1][0]).toMatchObject({ input: ['text'] })
  })

  it('没有图、或者不是 CodeBuddy：原样交回，不重发', async () => {
    streamSimple.mockReturnValueOnce(rejected())
    const runtime = await resolveAgentModel({ role: 'agent' })
    const noImage = await runtime.streamFn(
      CODEBUDDY as never,
      EMPTY_CONTEXT as never,
      undefined as never
    )
    await expect(noImage.result()).resolves.toMatchObject({ stopReason: 'error' })

    streamSimple.mockReturnValueOnce(rejected())
    const other = await runtime.streamFn(PI_MODEL as never, withImage as never, undefined as never)
    await expect(other.result()).resolves.toMatchObject({ stopReason: 'error' })

    expect(streamSimple).toHaveBeenCalledTimes(2)
  })
})

/**
 * 收不了图的模型拿到了图（被勾了「视觉」、目录标错）：硅基流动回 400「not a VLM」。
 * 图留在 transcript 里，不处理的话之后每一轮都原样重发、原样被拒，整条会话卡死。
 */
describe('别家带图的请求被拒', () => {
  const VISION_CLAIMED = {
    ...PI_MODEL,
    api: 'openai-completions',
    baseUrl: 'https://api.siliconflow.cn/v1',
    input: ['text', 'image']
  }
  const withImage = {
    messages: [
      {
        role: 'toolResult',
        toolCallId: 't1',
        toolName: 'mcp_blender_screenshot',
        content: [{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }],
        isError: false,
        timestamp: 0
      }
    ]
  }
  function streamEnding(event: Record<string, unknown>): unknown {
    const stream = createAssistantMessageEventStream()
    stream.push(event as never)
    stream.end()
    return stream
  }
  const notVlm = (): unknown =>
    streamEnding({
      type: 'error',
      reason: 'error',
      error: {
        role: 'assistant',
        content: [],
        stopReason: 'error',
        errorMessage: '400 The model is not a VLM (Vision Language Model).'
      }
    })
  const ok = (): unknown =>
    streamEnding({
      type: 'done',
      reason: 'stop',
      message: { role: 'assistant', content: [], stopReason: 'stop' }
    })
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

  it('没有视觉模型：去掉图重发；过了就记下，之后带图直接按纯文本发', async () => {
    streamSimple.mockReturnValueOnce(notVlm()).mockReturnValueOnce(ok())
    const runtime = await resolveAgentModel({ role: 'agent' })

    const first = await runtime.streamFn(
      VISION_CLAIMED as never,
      withImage as never,
      undefined as never
    )
    await expect(first.result()).resolves.toMatchObject({ stopReason: 'stop' })
    expect(streamSimple.mock.calls[1][0]).toMatchObject({ input: ['text'] })
    await settle()

    streamSimple.mockReturnValueOnce(ok())
    const next = await runtime.streamFn(
      VISION_CLAIMED as never,
      withImage as never,
      undefined as never
    )
    await expect(next.result()).resolves.toMatchObject({ stopReason: 'stop' })
    expect(streamSimple).toHaveBeenCalledTimes(3)
    expect(streamSimple.mock.calls[2][0]).toMatchObject({ input: ['text'] })
  })

  it('去掉图也没过：拒的不是图，不记账', async () => {
    streamSimple.mockReturnValueOnce(notVlm()).mockReturnValueOnce(notVlm())
    const runtime = await resolveAgentModel({ role: 'agent' })
    const first = await runtime.streamFn(
      VISION_CLAIMED as never,
      withImage as never,
      undefined as never
    )
    await expect(first.result()).resolves.toMatchObject({ stopReason: 'error' })
    await settle()

    streamSimple.mockReturnValueOnce(ok())
    await runtime.streamFn(VISION_CLAIMED as never, withImage as never, undefined as never)
    expect(streamSimple.mock.calls[2][0]).toMatchObject({ input: ['text', 'image'] })
  })

  it('配了视觉模型：被拒的这一轮交给它重发', async () => {
    MODELS_BY_ID.v1 = {
      id: 'v1',
      provider: 'p',
      api: 'openai-completions',
      input: ['text', 'image']
    }
    readSettings.mockResolvedValue({
      ...SETTINGS,
      providers: [
        { ...SETTINGS.providers[0], models: [{ id: 'm1' }, { id: 'v1', supportsVision: true }] }
      ],
      roles: { ...SETTINGS.roles, vision: { providerId: 'p', modelId: 'v1' } }
    })
    streamSimple.mockReturnValueOnce(notVlm()).mockReturnValueOnce(ok())
    const runtime = await resolveAgentModel({ role: 'agent' })

    const stream = await runtime.streamFn(
      VISION_CLAIMED as never,
      withImage as never,
      undefined as never
    )
    await expect(stream.result()).resolves.toMatchObject({ stopReason: 'stop' })
    expect(streamSimple.mock.calls[1][0]).toMatchObject({ id: 'v1', input: ['text', 'image'] })
  })
})

/**
 * 截图是跑到一半由工具回来的，进来时定的模型可能是纯文本的。
 * 这一轮交给视觉模型看，下一轮（图已经答过）回到主模型。
 */
describe('这一轮带图、主模型看不了', () => {
  const TEXT_ONLY = { ...PI_MODEL, input: ['text'] }
  const VISION = { id: 'v1', provider: 'p', api: 'openai-completions', input: ['text', 'image'] }
  const screenshot = {
    role: 'toolResult',
    toolCallId: 't1',
    toolName: 'mcp_blender_screenshot',
    content: [{ type: 'image', data: 'AAAA', mimeType: 'image/jpeg' }],
    isError: false,
    timestamp: 0
  }
  function withVision(visionConfig: Record<string, unknown> = { supportsVision: true }): void {
    MODELS_BY_ID.m1 = TEXT_ONLY
    MODELS_BY_ID.v1 = VISION
    readSettings.mockResolvedValue({
      ...SETTINGS,
      providers: [
        { ...SETTINGS.providers[0], models: [{ id: 'm1' }, { id: 'v1', ...visionConfig }] }
      ],
      roles: { ...SETTINGS.roles, vision: { providerId: 'p', modelId: 'v1' } }
    })
  }

  it('交给视觉模型；图答过之后回到主模型', async () => {
    withVision()
    const runtime = await resolveAgentModel({ role: 'agent' })
    expect(runtime.toolImagesVisible).toBe(true)

    runtime.streamFn(TEXT_ONLY as never, { messages: [screenshot] } as never, undefined as never)
    expect(streamSimple.mock.calls[0][0]).toMatchObject({ id: 'v1' })

    const answered = { role: 'assistant', content: [{ type: 'text', text: '看到了' }] }
    runtime.streamFn(
      TEXT_ONLY as never,
      { messages: [screenshot, answered] } as never,
      undefined as never
    )
    expect(streamSimple.mock.calls[1][0]).toMatchObject({ id: 'm1' })
  })

  it('视觉模型调不了工具就不换，提示词照实说看不到', async () => {
    withVision({ supportsVision: true, supportsTools: false })
    const runtime = await resolveAgentModel({ role: 'agent' })
    expect(runtime.toolImagesVisible).toBe(false)
    runtime.streamFn(TEXT_ONLY as never, { messages: [screenshot] } as never, undefined as never)
    expect(streamSimple.mock.calls[0][0]).toMatchObject({ id: 'm1' })
  })
})

/** 硅基流动把原因放在响应体顶层，OpenAI SDK 只认 `error`，报错只剩「no body」 */
describe('withTopLevelErrorMessage', () => {
  const respond =
    (body: string, status: number): typeof fetch =>
    async () =>
      new Response(body, { status, headers: { 'content-type': 'application/json' } })

  it('顶层的 message 补进 error，状态码不变', async () => {
    const fetchFn = withTopLevelErrorMessage(
      respond(JSON.stringify({ code: 20041, message: 'not a VLM', data: null }), 400)
    )
    const response = await fetchFn('https://x/v1/chat/completions')
    expect(response.status).toBe(400)
    expect(await response.json()).toMatchObject({ error: { message: 'not a VLM', code: 20041 } })
  })

  it('已经有 error、不是 JSON、成功的响应：原样放过', async () => {
    const pass = async (body: string, status: number): Promise<string> =>
      (await withTopLevelErrorMessage(respond(body, status))('u')).text()
    const standard = JSON.stringify({ error: { message: 'bad' } })
    expect(await pass(standard, 400)).toBe(standard)
    expect(await pass('oops', 400)).toBe('oops')
    const success = JSON.stringify({ message: 'hi' })
    expect(await pass(success, 200)).toBe(success)
  })
})
