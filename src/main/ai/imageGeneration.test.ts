import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp' },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString('utf-8')
  }
}))

type Protocol =
  | 'openai-completions'
  | 'openai-responses'
  | 'openai-codex-responses'
  | 'anthropic-messages'
  | 'google-generative-ai'

const settings = {
  version: 1 as const,
  providers: [
    {
      id: 'my-gateway',
      displayName: '我的网关',
      kind: 'image',
      protocol: 'openai-completions' as Protocol,
      baseUrl: 'https://gateway.example.com/v1',
      apiKey: { kind: 'none' } as { kind: 'none' } | { kind: 'env'; name: string },
      headers: { 'User-Agent': 'unreal-box' },
      imageUploadUrl: undefined as string | undefined,
      imageResolutionTiers: undefined as boolean | undefined,
      models: [{ id: 'flux-1-schnell' }] as Array<{
        id: string
        imageApi?: string
      }>
    }
  ],
  roles: {} as Record<string, { providerId: string; modelId: string }>
}

vi.mock('./store', () => ({
  readSettings: async () => settings
}))

const {
  CodexAccountMissingError,
  CodexImageError,
  generateImages,
  getImageModelStatus,
  ImageGenerationEmptyError,
  ImageModelUnavailableError,
  ImageProtocolUnsupportedError,
  ImageReferenceUnsupportedError,
  ImageRequestError,
  ImageResponseNotJsonError,
  ImageTaskCancelledError,
  ImageTaskFailedError,
  ImageTaskInterruptedError,
  ImageTaskTimeoutError,
  IMAGE_CONFIG_ERROR_MARKER
} = await import('./imageGeneration')

/** 一次被拦下来的请求：地址 + 方法 + 头 + 请求体（JSON 已解析） */
interface SentRequest {
  url: string
  headers: Record<string, string>
  json: Record<string, unknown>
  form: FormData | null
}

let sent: SentRequest[] = []

/**
 * 拦下 fetch。
 *
 * 与上一版最大的不同：这里断言的是**真正发出去的那个 HTTP 请求** ——
 * 上一版中间隔着 AI SDK，测试只能验「我们改写完的请求体」，改写之后 SDK
 * 还会再动一次，那一段没有测试覆盖。
 */
function stubFetch(
  respond: (url: string) => Response = () =>
    new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }), {
      headers: { 'content-type': 'application/json' }
    })
): void {
  vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
    const url = String(input)
    const body = init.body
    sent.push({
      url,
      headers: (init.headers as Record<string, string>) ?? {},
      json: typeof body === 'string' ? JSON.parse(body) : {},
      form: body instanceof FormData ? body : null
    })
    return respond(url)
  })
}

/** Interactions API 的响应：没有 data[]，单图直接挂在 interaction.output_image */
function geminiResponse(): Response {
  return new Response(
    JSON.stringify({ interaction: { output_image: { data: 'QUJD', mime_type: 'image/jpeg' } } }),
    { headers: { 'content-type': 'application/json' } }
  )
}

/** 把绑定换成指定的 imageApi 与模型 id */
function useModel(api: string | undefined, modelId = 'flux-1-schnell'): void {
  settings.providers[0].models = [{ id: modelId, ...(api ? { imageApi: api } : {}) }]
  settings.roles = { image: { providerId: 'my-gateway', modelId } }
}

/** 最近一次真正发出去的请求 */
function lastRequest(): SentRequest {
  expect(sent.length, '没有任何请求发出去').toBeGreaterThan(0)
  return sent[sent.length - 1]
}

beforeEach(() => {
  settings.providers.splice(1)
  // 用途在 Provider 上，改过它的用例要复位，否则会污染后面的
  settings.providers[0].kind = 'image'
  settings.providers[0].imageUploadUrl = undefined
  settings.providers[0].imageResolutionTiers = undefined
  settings.providers[0].protocol = 'openai-completions'
  settings.providers[0].baseUrl = 'https://gateway.example.com/v1'
  settings.providers[0].apiKey = { kind: 'none' }
  settings.providers[0].models = [{ id: 'flux-1-schnell' }]
  settings.roles = { image: { providerId: 'my-gateway', modelId: 'flux-1-schnell' } }
  sent = []
  vi.unstubAllGlobals()
  stubFetch()
})

describe('可选参考图上传', () => {
  it('真正上传的是自动压缩后的文件，并使用返回的 URL 生成', async () => {
    const append = vi.spyOn(FormData.prototype, 'append')
    const { getSharp } = await import('../utils/sharpLoader')
    const sharp = await getSharp()
    const original = await sharp({
      create: {
        width: 2400,
        height: 1200,
        channels: 4,
        background: { r: 80, g: 140, b: 200, alpha: 0.5 }
      }
    })
      .png({ compressionLevel: 0 })
      .toBuffer()
    expect(original.byteLength).toBeGreaterThan(10_000_000)
    settings.providers[0].imageUploadUrl = 'https://gateway.example.com/v1/uploads/images'
    stubFetch(
      (url) =>
        new Response(
          JSON.stringify(
            url.endsWith('/uploads/images')
              ? { data: { url: 'https://files.example.com/compressed.webp' } }
              : { data: [{ b64_json: 'AAAA' }] }
          )
        )
    )
    await generateImages({
      prompt: 'x',
      referenceImages: [`data:image/png;base64,${original.toString('base64')}`]
    })
    const file = sent[0].form?.get('file') as File
    expect(file.type).toBe('image/webp')
    // happy-dom does not retain the filename argument on Blob entries.
    expect(append).toHaveBeenCalledWith('file', expect.any(Blob), 'reference-0.webp')
    append.mockRestore()
    expect(file.size).toBeLessThanOrEqual(9_500_000)
    expect(lastRequest().json.image_urls).toEqual(['https://files.example.com/compressed.webp'])
  })

  it('上传复用 Provider 密钥', async () => {
    settings.providers[0].imageUploadUrl = 'https://gateway.example.com/v1/uploads/images'
    settings.providers[0].apiKey = { kind: 'env', name: 'IMAGE_UPLOAD_TEST_KEY' }
    vi.stubEnv('IMAGE_UPLOAD_TEST_KEY', 'test-upload-token')
    stubFetch(
      (url) =>
        new Response(
          JSON.stringify(
            url.endsWith('/uploads/images')
              ? { data: { url: 'https://files.example.com/reference.png' } }
              : { data: [{ b64_json: 'AAAA' }] }
          )
        )
    )
    try {
      await generateImages({ prompt: 'x', referenceImages: ['QUJD'] })
      expect(sent[0].headers.Authorization).toBe('Bearer test-upload-token')
      expect(sent[1].headers.Authorization).toBe('Bearer test-upload-token')
    } finally {
      vi.unstubAllEnvs()
    }
  })

  it('Gemini 配置上传后使用 URI，不重新下载为 Base64', async () => {
    useModel('gemini-images')
    settings.providers[0].imageUploadUrl = 'https://gateway.example.com/v1/uploads/images'
    stubFetch((url) =>
      url.endsWith('/uploads/images')
        ? new Response(JSON.stringify({ data: { url: 'https://files.example.com/reference.png' } }))
        : geminiResponse()
    )
    await generateImages({ prompt: 'x', referenceImages: ['QUJD'] })
    expect(sent).toHaveLength(2)
    expect(lastRequest().json.input).toEqual([
      { type: 'text', text: 'x' },
      { type: 'image', uri: 'https://files.example.com/reference.png' }
    ])
  })

  it('无效的上传地址在发请求前报错', async () => {
    settings.providers[0].imageUploadUrl = 'not-a-url'
    await expect(generateImages({ prompt: 'x', referenceImages: ['QUJD'] })).rejects.toThrow(
      '上传接口地址无效'
    )
    expect(sent).toHaveLength(0)
  })

  it('上传多张参考图后将 URL 按顺序带入生成请求，已有 URL 不重复上传', async () => {
    settings.providers[0].imageUploadUrl = 'https://gateway.example.com/v1/uploads/images'
    stubFetch(
      (url) =>
        new Response(
          JSON.stringify(
            url.endsWith('/uploads/images')
              ? { success: true, data: { url: `https://files.example.com/${sent.length}.png` } }
              : { data: [{ b64_json: 'AAAA' }] }
          )
        )
    )
    await generateImages({
      prompt: 'x',
      referenceImages: [
        'data:image/jpeg;base64,QUJD',
        'https://files.example.com/original.png',
        'REVG'
      ]
    })
    expect(sent).toHaveLength(3)
    expect(sent[0].form?.get('file')).toMatchObject({ type: 'image/jpeg', size: 3 })
    expect(sent[0].headers['User-Agent']).toBe('unreal-box')
    expect(sent[0].headers).not.toHaveProperty('Content-Type')
    expect(lastRequest().url).toBe('https://gateway.example.com/v1/images/generations')
    expect(lastRequest().json.image_urls).toEqual([
      'https://files.example.com/1.png',
      'https://files.example.com/original.png',
      'https://files.example.com/2.png'
    ])
  })

  it('没有参考图时不调用上传接口', async () => {
    settings.providers[0].imageUploadUrl = 'https://gateway.example.com/v1/uploads/images'
    await generateImages({ prompt: 'x' })
    expect(sent).toHaveLength(1)
    expect(lastRequest().json).not.toHaveProperty('image_urls')
  })

  it.each([
    [400, '{"message":"too large"}'],
    [200, '<html>error</html>'],
    [200, '{"success":false}'],
    [200, '{"data":{"url":"data:image/png;base64,AAAA"}}']
  ])('上传失败或无效响应时停止生成 (%s, %s)', async (status, body) => {
    settings.providers[0].imageUploadUrl = 'https://gateway.example.com/v1/uploads/images'
    stubFetch(() => new Response(body, { status }))
    await expect(generateImages({ prompt: 'x', referenceImages: ['QUJD'] })).rejects.toThrow(
      '参考图上传失败'
    )
    expect(sent).toHaveLength(1)
  })

  it('取消后不上传也不生成', async () => {
    settings.providers[0].imageUploadUrl = 'https://gateway.example.com/v1/uploads/images'
    const controller = new AbortController()
    controller.abort()
    await expect(
      generateImages({
        prompt: 'x',
        referenceImages: ['QUJD'],
        signal: controller.signal
      })
    ).rejects.toThrow()
    expect(sent).toHaveLength(0)
  })
})

describe('生图的协议边界', () => {
  it('openai-completions 打在 Provider 的 Base URL 上，并带上附加请求头', async () => {
    await generateImages({ prompt: '一把中世纪的剑' })

    expect(lastRequest().url).toBe('https://gateway.example.com/v1/images/generations')
    expect(lastRequest().headers['User-Agent']).toBe('unreal-box')
  })

  it('本机推理不需要密钥时不发 Authorization，而不是硬塞一个占位值', async () => {
    await generateImages({ prompt: 'x' })

    expect(lastRequest().headers).not.toHaveProperty('Authorization')
  })

  it('openai-responses 同样走 /images/generations', async () => {
    settings.providers[0].protocol = 'openai-responses'
    await generateImages({ prompt: 'x' })

    expect(lastRequest().url).toBe('https://gateway.example.com/v1/images/generations')
  })

  /**
   * 这几种协议根本没有生图端点。直说，而不是让用户对着一句厂商的 404
   * 反复去改模型名 —— 真正的问题是这家协议不提供这个能力。
   *
   * `google-generative-ai` 现在也在这一列：Nano Banana 那条路（对话接口出图）
   * 已整体删除。Codex 后端不在：它没有生图端点，但有生图工具（见下面「Codex 订阅出图」）。
   */
  it.each<Protocol>(['anthropic-messages', 'google-generative-ai'])(
    '%s 没有生图接口，直说而不是发出去等 404',
    async (protocol) => {
      settings.providers[0].protocol = protocol

      await expect(generateImages({ prompt: 'x' })).rejects.toBeInstanceOf(
        ImageProtocolUnsupportedError
      )
      expect(sent, '不该有任何请求发出去').toHaveLength(0)
    }
  )
})

describe('generateImages 的逐次模型选择', () => {
  it('信息图指定的已配置模型覆盖全局生图绑定', async () => {
    settings.providers.push({
      id: 'infographic-provider',
      displayName: '信息图 Provider',
      kind: 'image',
      protocol: 'openai-completions',
      baseUrl: 'https://images.example.com/v1',
      apiKey: { kind: 'none' },
      headers: { 'User-Agent': 'unreal-box' },
      imageUploadUrl: undefined,
      imageResolutionTiers: undefined,
      models: [{ id: 'infographic-image' }]
    })

    await generateImages({
      prompt: '生成一张信息图',
      providerId: 'infographic-provider',
      modelId: 'infographic-image'
    })

    expect(lastRequest().url).toBe('https://images.example.com/v1/images/generations')
    expect(lastRequest().json.model).toBe('infographic-image')
  })

  it('指定的模型已被删除时拒绝静默换一个', async () => {
    settings.providers[0].models = [{ id: 'still-here' }]

    await expect(
      generateImages({ prompt: 'x', providerId: 'my-gateway', modelId: 'deleted-model' })
    ).rejects.toBeInstanceOf(ImageModelUnavailableError)
  })

  /** 用途上移之后，「不再具备生图能力」这件事发生在 Provider 上，不在模型上 */
  it('Provider 的用途被改成对话之后，原来的生图选择立刻失效', async () => {
    settings.providers[0].kind = 'chat'

    await expect(
      generateImages({ prompt: 'x', providerId: 'my-gateway', modelId: 'flux-1-schnell' })
    ).rejects.toBeInstanceOf(ImageModelUnavailableError)
  })
})

describe('generateImages 的参数', () => {
  it.each([undefined, false])('分辨率开关 %s 时仍发送官方像素尺寸', async (enabled) => {
    settings.providers[0].imageResolutionTiers = enabled
    useModel('gpt-images')
    await generateImages({ prompt: 'x', size: '2048x1152', aspectRatio: '16:9' })
    expect(lastRequest().json.size).toBe('2048x1152')
    expect(lastRequest().json).not.toHaveProperty('resolution')
  })

  it.each([
    ['1K', '1k'],
    ['2K', '2k'],
    ['4K', '4k'],
    ['1536x864', '1k'],
    ['2048x1152', '2k'],
    ['3840x2160', '4k']
  ])('档位模式将 %s 转成比例和 %s', async (size, resolution) => {
    settings.providers[0].imageResolutionTiers = true
    useModel('gpt-images')
    await generateImages({ prompt: 'x', size, aspectRatio: '16:9' })
    expect(lastRequest().json).toMatchObject({ size: '16:9', resolution })
    expect(lastRequest().json).not.toHaveProperty('response_format')
  })

  it('仅提供像素尺寸时推导比例，自动尺寸不擅自指定分辨率', async () => {
    settings.providers[0].imageResolutionTiers = true
    await generateImages({ prompt: 'x', size: '1024x1536' })
    expect(lastRequest().json).toMatchObject({ size: '2:3', resolution: '1k' })
    await generateImages({ prompt: 'x', size: 'auto', aspectRatio: '16:9' })
    expect(lastRequest().json.size).toBe('16:9')
    expect(lastRequest().json).not.toHaveProperty('resolution')
  })

  it('档位开关独立于上传开关，参考图文件请求也携带分辨率', async () => {
    settings.providers[0].imageResolutionTiers = true
    await generateImages({ prompt: 'x', size: '2K', aspectRatio: '3:2', referenceImages: ['QUJD'] })
    expect(lastRequest().url).toMatch(/images\/edits$/)
    expect(lastRequest().form?.get('size')).toBe('3:2')
    expect(lastRequest().form?.get('resolution')).toBe('2k')
    expect(lastRequest().form?.get('image[]')).toBeInstanceOf(Blob)
  })

  it('上传接口与档位模式同时开启时保留 URL 参考图', async () => {
    settings.providers[0].imageResolutionTiers = true
    settings.providers[0].imageUploadUrl = 'https://gateway.example.com/v1/uploads/images'
    await generateImages({
      prompt: 'x',
      size: '2K',
      aspectRatio: '16:9',
      referenceImages: ['https://files.example.com/image.png']
    })
    expect(lastRequest().json).toMatchObject({
      size: '16:9',
      resolution: '2k',
      image_urls: ['https://files.example.com/image.png']
    })
  })

  it('档位开关不改变厂商专用接口', async () => {
    settings.providers[0].imageResolutionTiers = true
    useModel('ark-images')
    await generateImages({ prompt: 'x', size: '2K', aspectRatio: '16:9' })
    expect(lastRequest().json.size).toMatch(/^\d+x\d+$/)
    expect(lastRequest().json).not.toHaveProperty('resolution')
  })
  it('张数卡在 1..8：算错的 count 不该变成一次几十张的扣费', async () => {
    await generateImages({ prompt: 'x', count: 100 })
    expect(lastRequest().json.n).toBe(8)

    await generateImages({ prompt: 'x', count: 0 })
    expect(lastRequest().json.n).toBe(1)
  })

  it('格式不对的尺寸当没填，交给厂商用它自己的默认值', async () => {
    await generateImages({ prompt: 'x', size: '很大' })

    expect(lastRequest().json).not.toHaveProperty('size')
  })

  it('调用方的取消信号与内部超时并联，点取消能立刻停下', async () => {
    const controller = new AbortController()
    let seen: AbortSignal | null = null
    vi.stubGlobal('fetch', async (_input: unknown, init: RequestInit) => {
      seen = init.signal as AbortSignal
      return new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }))
    })

    await generateImages({ prompt: 'x', signal: controller.signal })

    expect(seen!.aborted).toBe(false)
    controller.abort()
    expect(seen!.aborted).toBe(true)
  })

  it('厂商没报 mediaType 时按 png 处理，免得存盘落出个没有扩展名的文件', async () => {
    expect(await generateImages({ prompt: 'x' })).toEqual([
      { base64: 'AAAA', mediaType: 'image/png' }
    ])
  })
})

/**
 * 每家一个适配器，各自按自己的官方文档拼请求。
 *
 * 上一版是「AI SDK 按 OpenAI 的形状拼一个，我们再在自定义 fetch 里改写字段」——
 * 代码里写着 `n: 2`、线上发出去的是 `batch_size: 2`，中间那一步在源码里看不见。
 * 这一整块守的就是「读代码看到的就是发出去的东西」。
 */
describe('各家的官方适配器', () => {
  it('openai-images：/images/generations，要 b64_json', async () => {
    useModel('openai-images')
    await generateImages({ prompt: 'x', count: 2, size: '1024x1024' })

    expect(lastRequest().url).toMatch(/\/images\/generations$/)
    expect(lastRequest().json).toEqual({
      model: 'flux-1-schnell',
      prompt: 'x',
      n: 2,
      size: '1024x1024',
      response_format: 'b64_json'
    })
  })

  /**
   * gpt-image 全家永远回 base64，给了 response_format 就是 400 Unknown parameter。
   * 这一条挂了的表现是**整个 OpenAI 生图用不了**，而报错看上去像模型名写错了。
   */
  it('gpt-images：不发 response_format', async () => {
    useModel('gpt-images', 'gpt-image-2')
    await generateImages({ prompt: 'x' })

    expect(lastRequest().json).not.toHaveProperty('response_format')
    expect(lastRequest().json).toMatchObject({ model: 'gpt-image-2', prompt: 'x', n: 1 })
  })

  /** OpenAI 的参考图是**换端点**：multipart 的 /images/edits，多张用重复的 image[] */
  it('openai-images：带参考图改打 /images/edits，多张用重复的 image[]', async () => {
    useModel('openai-images')
    await generateImages({
      prompt: '改成雨夜',
      referenceImages: ['data:image/png;base64,QUJD', 'REVG']
    })

    const request = lastRequest()
    expect(request.url).toMatch(/\/images\/edits$/)
    expect(request.form?.getAll('image[]')).toHaveLength(2)
    expect(request.form?.get('prompt')).toBe('改成雨夜')
    // multipart 的 boundary 由 fetch 自己带，我们不能硬写 content-type
    expect(request.headers).not.toHaveProperty('Content-Type')
  })

  /** xAI 官方文档明说不支持 size，也没有 edits 端点 */
  it('grok-images：不发 size', async () => {
    useModel('grok-images', 'grok-imagine-image-2.0')
    await generateImages({ prompt: 'x', size: '1024x1024' })

    expect(lastRequest().json).not.toHaveProperty('size')
    expect(lastRequest().json.response_format).toBe('b64_json')
  })

  /** 参考图在这一家是直接说不行，而不是发过去等一个 404 */
  it('grok-images：给了参考图就直说不支持，不发请求', async () => {
    useModel('grok-images', 'grok-imagine-image-2.0')

    await expect(generateImages({ prompt: 'x', referenceImages: ['QUJD'] })).rejects.toBeInstanceOf(
      ImageReferenceUnsupportedError
    )
    expect(sent).toHaveLength(0)
  })

  it('siliconflow-images：多张参考图在上传和生成前拒绝，不能静默只用第一张', async () => {
    useModel('siliconflow-images', 'Kwai-Kolors/Kolors')
    settings.providers[0]!.imageUploadUrl = 'https://upload.example.com/images'

    await expect(
      generateImages({ prompt: '图一人物穿图二衣服', referenceImages: ['QUJD', 'REVG'] })
    ).rejects.toThrow('尚未提交生成')
    expect(sent).toHaveLength(0)
  })

  it('siliconflow-images：batch_size / image_size，参考图内联在 image', async () => {
    useModel('siliconflow-images', 'Kwai-Kolors/Kolors')
    stubFetch(
      () =>
        new Response(JSON.stringify({ images: [{ url: 'https://cdn.example.com/a.png' }] }), {
          headers: { 'content-type': 'application/json' }
        })
    )
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: unknown, init: RequestInit = {}) => {
        const url = String(input)
        if (url.startsWith('https://cdn.example.com/')) {
          return new Response(Buffer.from([1, 2, 3]))
        }
        sent.push({
          url,
          headers: (init.headers as Record<string, string>) ?? {},
          json: typeof init.body === 'string' ? JSON.parse(init.body) : {},
          form: null
        })
        return new Response(
          JSON.stringify({ images: [{ url: 'https://cdn.example.com/a.png' }] }),
          {
            headers: { 'content-type': 'application/json' }
          }
        )
      })
    )

    const images = await generateImages({
      prompt: 'x',
      count: 2,
      size: '1024x1024',
      seed: 7,
      referenceImages: ['QUJD']
    })

    expect(lastRequest().json).toEqual({
      model: 'Kwai-Kolors/Kolors',
      prompt: 'x',
      batch_size: 2,
      image_size: '1024x1024',
      seed: 7,
      image: 'data:image/png;base64,QUJD'
    })
    // 硅基流动只回地址，且一小时后失效 —— 必须当场取回来存成 base64
    expect(images).toEqual([
      { base64: Buffer.from([1, 2, 3]).toString('base64'), mediaType: 'image/png' }
    ])
  })

  /**
   * 方舟只有 `/images/generations` 一个端点。
   *
   * 参考图交给 OpenAI 那套会打到 `/images/edits`，方舟回的是**空 body 的 404**，
   * 用户看到的是一句没头没尾的 `Not Found`：既不提模型，也不提参考图。
   */
  it('ark-images：参考图内联在 image，不换端点', async () => {
    useModel('ark-images', 'doubao-seedream-5-0-260128')
    await generateImages({ prompt: '改成雨夜', referenceImages: ['data:image/jpeg;base64,QUJD'] })

    expect(lastRequest().url).toMatch(/\/images\/generations$/)
    expect(lastRequest().json.image).toBe('data:image/jpeg;base64,QUJD')
  })

  it('ark-images：裸 base64 补回 data URI 前缀，多张传数组', async () => {
    useModel('ark-images', 'doubao-seedream-5-0-260128')
    await generateImages({
      prompt: 'x',
      referenceImages: ['QUJD', 'https://cdn.example.com/b.png']
    })

    expect(lastRequest().json.image).toEqual([
      'data:image/png;base64,QUJD',
      'https://cdn.example.com/b.png'
    ])
  })

  /** 方舟的张数不是 n，是 sequential_image_generation 那一对；单张要显式 disabled */
  it('ark-images：张数走 sequential_image_generation，不发 n', async () => {
    useModel('ark-images', 'doubao-seedream-5-0-260128')

    await generateImages({ prompt: 'x' })
    expect(lastRequest().json).not.toHaveProperty('n')
    expect(lastRequest().json.sequential_image_generation).toBe('disabled')

    await generateImages({ prompt: 'x', count: 3 })
    expect(lastRequest().json.sequential_image_generation).toBe('auto')
    expect(lastRequest().json.sequential_image_generation_options).toEqual({ max_images: 3 })
  })

  /** 不传 watermark 时方舟给图盖 AI 生成水印，出来的素材直接没法用 */
  it('ark-images：显式关掉水印', async () => {
    useModel('ark-images', 'doubao-seedream-5-0-260128')
    await generateImages({ prompt: 'x' })

    expect(lastRequest().json.watermark).toBe(false)
  })

  /**
   * 方舟每一代认的档位不一样（4.0 是 1K/2K/4K，5.0 lite 是 2K/3K），
   * 所以档位只当总像素预算，连着比例一起换算成像素尺寸再发。
   */
  it('ark-images：界面的档位 + 比例换算成像素尺寸', async () => {
    useModel('ark-images', 'doubao-seedream-5-0-260128')
    await generateImages({ prompt: 'x', size: '4K', aspectRatio: '16:9' })

    const size = String(lastRequest().json.size)
    const [width, height] = size.split('x').map(Number)
    expect(size).toMatch(/^\d+x\d+$/)
    // 16:9 的形状（取整误差 1% 以内），且落在方舟的总像素区间里
    expect(width / height).toBeCloseTo(16 / 9, 1)
    expect(width * height).toBeLessThanOrEqual(4096 * 4096)
    expect(width * height).toBeGreaterThanOrEqual(2560 * 1440)
  })

  /**
   * Nano Banana 是这里唯一不走 `/images/generations` 的一家：Interactions API
   * 没有 prompt 字段，提示词和参考图同在一个 input 数组里。
   */
  it('gemini-images：打 /interactions，提示词是 input 里的一项', async () => {
    useModel('gemini-images', 'gemini-3.1-flash-image')
    stubFetch(geminiResponse)
    await generateImages({ prompt: '一把中世纪的剑' })

    expect(lastRequest().url).toBe('https://gateway.example.com/v1/interactions')
    expect(lastRequest().json).not.toHaveProperty('prompt')
    expect(lastRequest().json.input).toEqual([{ type: 'text', text: '一把中世纪的剑' }])
  })

  /**
   * 密钥发错头是 401，而 401 看上去像「密钥填错了」——
   * 用户会去反复换密钥，而真正的问题是 Google 不认 Bearer。
   */
  it('gemini-images：密钥走 x-goog-api-key，不发 Authorization', async () => {
    useModel('gemini-images', 'gemini-3.1-flash-image')
    process.env.GEMINI_TEST_KEY = 'AIza-test'
    settings.providers[0].apiKey = { kind: 'env', name: 'GEMINI_TEST_KEY' }
    stubFetch(geminiResponse)
    await generateImages({ prompt: 'x' })

    expect(lastRequest().headers['x-goog-api-key']).toBe('AIza-test')
    expect(lastRequest().headers).not.toHaveProperty('Authorization')
  })

  /** 参考图要裸 base64：带着 data URI 前缀发过去，Google 当成图片数据去解，直接失败 */
  it('gemini-images：参考图剥掉 data URI 前缀，跟提示词并列在 input 里', async () => {
    useModel('gemini-images', 'gemini-3.1-flash-image')
    stubFetch(geminiResponse)
    await generateImages({ prompt: '改成雨夜', referenceImages: ['data:image/jpeg;base64,QUJD'] })

    expect(lastRequest().json.input).toEqual([
      { type: 'text', text: '改成雨夜' },
      { type: 'image', mime_type: 'image/jpeg', data: 'QUJD' }
    ])
  })

  /** Gemini 只认 512px/1K/2K/4K 四档，`1024x1024` 发过去是 400，按长边归档 */
  it('gemini-images：像素尺寸归到档位，清单外的比例干脆不发', async () => {
    useModel('gemini-images', 'gemini-3.1-flash-image')
    stubFetch(geminiResponse)

    await generateImages({ prompt: 'x', size: '1024x1024', aspectRatio: '16:9' })
    expect(lastRequest().json.response_format).toEqual({
      type: 'image',
      image_size: '1K',
      aspect_ratio: '16:9'
    })

    await generateImages({ prompt: 'x', size: '2K', aspectRatio: '7:3' })
    expect(lastRequest().json.response_format).toEqual({ type: 'image', image_size: '2K' })
  })

  /** 响应里没有 data[]：单图在 output_image，先说话再出图时在 steps[].content[] */
  it('gemini-images：两种响应形状都取得到图', async () => {
    useModel('gemini-images', 'gemini-3.1-flash-image')

    stubFetch(geminiResponse)
    expect(await generateImages({ prompt: 'x' })).toEqual([
      { base64: 'QUJD', mediaType: 'image/jpeg' }
    ])

    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            interaction: {
              steps: [
                {
                  content: [
                    { type: 'text', text: '给你画了两版' },
                    { type: 'image', data: 'AAAA', mime_type: 'image/png' },
                    { type: 'image', data: 'BBBB', mime_type: 'image/png' }
                  ]
                }
              ],
              output_image: { data: 'BBBB', mime_type: 'image/png' }
            }
          }),
          { headers: { 'content-type': 'application/json' } }
        )
    )
    expect(await generateImages({ prompt: 'x' })).toEqual([
      { base64: 'AAAA', mediaType: 'image/png' },
      { base64: 'BBBB', mediaType: 'image/png' }
    ])
  })

  /**
   * 官方 REST 回的就是 Interaction 本身，不包 `{ interaction }`，也没有 output_image
   * （照 https://ai.google.dev/api/interactions-api 的示例）。图可能给 data，也可能给 uri
   */
  it('gemini-images：官方 REST 形状——顶层就是 Interaction，uri 也认', async () => {
    useModel('gemini-images', 'gemini-3.1-flash-image')
    const official = (image: Record<string, unknown>) => (): Response =>
      new Response(
        JSON.stringify({
          object: 'interaction',
          status: 'completed',
          steps: [
            {
              type: 'model_output',
              content: [{ type: 'image', mime_type: 'image/png', ...image }]
            }
          ]
        }),
        { headers: { 'content-type': 'application/json' } }
      )

    stubFetch(official({ data: 'QUJD' }))
    expect(await generateImages({ prompt: 'x' })).toEqual([
      { base64: 'QUJD', mediaType: 'image/png' }
    ])

    const respond = official({ uri: 'https://files.example/a.png' })
    stubFetch((url) =>
      url === 'https://files.example/a.png' ? new Response(Buffer.from('ABC')) : respond()
    )
    expect(await generateImages({ prompt: 'x' })).toEqual([
      { base64: 'QUJD', mediaType: 'image/png' }
    ])
    expect(sent.map((request) => request.url)).toContain('https://files.example/a.png')
  })

  /** 思考时画的草稿不是成品：要 1 张就该回 1 张 */
  it('gemini-images：thought 步里的草稿图不算出图', async () => {
    useModel('gemini-images', 'gemini-3.1-flash-image')
    stubFetch(
      () =>
        new Response(
          JSON.stringify({
            interaction: {
              steps: [
                {
                  type: 'thought',
                  content: [{ type: 'image', data: 'DRAFT', mime_type: 'image/png' }]
                },
                {
                  type: 'model_output',
                  content: [{ type: 'image', data: 'FINAL', mime_type: 'image/png' }]
                }
              ],
              output_image: { data: 'FINAL', mime_type: 'image/png' }
            }
          }),
          { headers: { 'content-type': 'application/json' } }
        )
    )
    expect(await generateImages({ prompt: 'x' })).toEqual([
      { base64: 'FINAL', mediaType: 'image/png' }
    ])
  })

  function minimaxResponse(): Response {
    return new Response(
      JSON.stringify({
        id: 'trace-1',
        data: { image_base64: ['QUJD'] },
        metadata: { success_count: 1, failed_count: 0 },
        base_resp: { status_code: 0, status_msg: 'success' }
      }),
      { headers: { 'content-type': 'application/json' } }
    )
  }

  it('minimax-images：打 /image_generation，比例档单独给 aspect_ratio', async () => {
    useModel('minimax-images', 'image-01')
    stubFetch(minimaxResponse)

    const images = await generateImages({ prompt: 'x', count: 2, aspectRatio: '16:9' })

    expect(lastRequest().url).toBe('https://gateway.example.com/v1/image_generation')
    expect(lastRequest().json).toEqual({
      model: 'image-01',
      prompt: 'x',
      n: 2,
      response_format: 'base64',
      aspect_ratio: '16:9'
    })
    // 官方示例把回来的数据写成 .jpeg
    expect(images).toEqual([{ base64: 'QUJD', mediaType: 'image/jpeg' }])
  })

  /**
   * 两者同时发时官方写明 `aspect_ratio` 优先，于是界面上选的档位会一声不响地失效。
   * 所以能算出像素尺寸时只发像素尺寸。
   */
  it('minimax-images：档位 + 比例换算成 width/height，不同时发 aspect_ratio', async () => {
    useModel('minimax-images', 'image-01')
    stubFetch(minimaxResponse)

    await generateImages({ prompt: 'x', size: '2K', aspectRatio: '16:9' })

    const json = lastRequest().json
    expect(json.aspect_ratio).toBeUndefined()
    // 长边封顶 2048，比例照原样保住
    expect(json.width).toBe(2048)
    expect(json.height).toBe(1152)
  })

  it('minimax-images：像素尺寸顶进 512–2048 且取 8 的倍数', async () => {
    useModel('minimax-images', 'image-01')
    stubFetch(minimaxResponse)

    await generateImages({ prompt: 'x', size: '4000x300' })

    const { width, height } = lastRequest().json as { width: number; height: number }
    expect(width).toBeLessThanOrEqual(2048)
    expect(height).toBeGreaterThanOrEqual(512)
    expect(width % 8).toBe(0)
    expect(height % 8).toBe(0)
  })

  it('minimax-images：live 那一档不认 width/height，只发比例', async () => {
    useModel('minimax-images', 'image-01-live')
    stubFetch(minimaxResponse)

    await generateImages({ prompt: 'x', size: '2K', aspectRatio: '3:2' })

    expect(lastRequest().json).toEqual({
      model: 'image-01-live',
      prompt: 'x',
      n: 1,
      response_format: 'base64',
      aspect_ratio: '3:2'
    })
  })

  it('minimax-images：清单外的比例干脆不发，而不是换来一次 2013', async () => {
    useModel('minimax-images', 'image-01-live')
    stubFetch(minimaxResponse)

    await generateImages({ prompt: 'x', aspectRatio: '7:3' })

    expect(lastRequest().json.aspect_ratio).toBeUndefined()
  })

  it('minimax-images：参考图走 subject_reference，只收一张', async () => {
    useModel('minimax-images', 'image-01')
    stubFetch(minimaxResponse)

    await generateImages({ prompt: 'x', referenceImages: ['QUJD'] })

    expect(lastRequest().json.subject_reference).toEqual([
      { type: 'character', image_file: 'data:image/png;base64,QUJD' }
    ])

    sent = []
    await expect(
      generateImages({ prompt: 'x', referenceImages: ['QUJD', 'REVG'] })
    ).rejects.toThrow('尚未提交生成')
    expect(sent).toHaveLength(0)
  })

  /**
   * 密钥错 / 余额不足也是 HTTP 200。不认 base_resp 的话用户看到的是
   * 「换个提示词再试」—— 而提示词在这两种里是清白的。
   */
  it('minimax-images：HTTP 200 但 base_resp 报错时带着状态码抛出来', async () => {
    useModel('minimax-images', 'image-01')
    stubFetch(
      () =>
        new Response(
          JSON.stringify({ base_resp: { status_code: 1008, status_msg: 'insufficient balance' } }),
          { headers: { 'content-type': 'application/json' } }
        )
    )

    await expect(generateImages({ prompt: 'x' })).rejects.toThrow(
      /base_resp 1008.*insufficient balance/
    )
  })

  /**
   * 官方域名下压根没有 /images/generations。手填地址的用户少了这一级会一路打到 404。
   */
  it('MiniMax 官方域名下没写 imageApi 也走 minimax-images', async () => {
    settings.providers[0].baseUrl = 'https://api.minimaxi.com/v1'
    useModel(undefined, 'image-01')
    stubFetch(minimaxResponse)

    await generateImages({ prompt: 'x' })

    expect(lastRequest().url).toBe('https://api.minimaxi.com/v1/image_generation')
  })

  it('聚合网关转发的 MiniMax 模型仍走通用形状', async () => {
    useModel(undefined, 'minimax/image-01')
    await generateImages({ prompt: 'x' })

    expect(lastRequest().url).toMatch(/\/images\/generations$/)
  })

  /**
   * 聚合平台上 `google/gemini-3.1-flash-image` 这种名字很常见，
   * 但它们转发的是 OpenAI 形状。按名字猜会把这批用户打死在 401 + 404 上。
   */
  it('没写 imageApi 时不按模型名猜 Nano Banana，走通用形状', async () => {
    useModel(undefined, 'google/gemini-3.1-flash-image')
    await generateImages({ prompt: 'x' })

    expect(lastRequest().url).toMatch(/\/images\/generations$/)
  })

  it('认不出名字又没写 imageApi 时按通用的 OpenAI 形状发', async () => {
    useModel(undefined, 'some-unknown-model')
    await generateImages({ prompt: 'x' })

    expect(lastRequest().json).toMatchObject({ n: 1, response_format: 'b64_json' })
  })

  it('models.json 里写了个不认识的值时同样回落，而不是崩在适配器表上', async () => {
    useModel('nonsense-api')
    await generateImages({ prompt: 'x' })

    expect(lastRequest().url).toMatch(/\/images\/generations$/)
  })

  /**
   * **存量配置里没有 imageApi 这一位。**
   *
   * 这一位是后加的：用户在那之前添加的 Provider、手填的模型、「导入模型」
   * 从厂商拉回来的，通通没有。只认声明的话，这些人升级之后会原地退化。
   */
  it.each([
    [
      'gpt-image-2',
      (json: Record<string, unknown>) => expect(json).not.toHaveProperty('response_format')
    ],
    [
      'openai/gpt-image-2',
      (json: Record<string, unknown>) => expect(json).not.toHaveProperty('response_format')
    ],
    [
      'grok-imagine-image-2.0',
      (json: Record<string, unknown>) => expect(json).not.toHaveProperty('size')
    ],
    [
      'doubao-seedream-4-0-250828',
      (json: Record<string, unknown>) => expect(json.sequential_image_generation).toBe('disabled')
    ]
  ])('存量配置里的 %s 没写 imageApi，也走对的那家适配器', async (modelId, assert) => {
    useModel(undefined, modelId)
    await generateImages({ prompt: 'x', size: '1024x1024' })

    assert(lastRequest().json)
  })

  /** 声明优先：写了什么就按什么发，别让猜的那一层盖掉用户/目录的明确指定 */
  it('声明了 imageApi 时不再看模型名', async () => {
    useModel('openai-images', 'gpt-image-2')
    await generateImages({ prompt: 'x' })

    expect(lastRequest().json.response_format).toBe('b64_json')
  })
})

/**
 * 厂商把请求打回来时，用户至少要看得出「是谁、在哪一步、说了什么」。
 *
 * 上一版这里是 AI SDK：响应体为空时它拿 statusText 当消息，于是界面上是
 * 一句 `Failed after 2 attempts with non-retryable error: 'Not Found'` ——
 * 既没有端点也没有厂商那句话。
 */
describe('厂商报错', () => {
  it('带上状态码、端点和厂商那句话', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { message: '模型不存在或没有权限' } }), {
          status: 404,
          statusText: 'Not Found'
        })
    )

    await expect(generateImages({ prompt: 'x' })).rejects.toBeInstanceOf(ImageRequestError)
    await expect(generateImages({ prompt: 'x' })).rejects.toThrow(
      /HTTP 404.*images\/generations.*模型不存在或没有权限/
    )
  })

  it('响应体是空的时候也说清楚打的是哪个端点', async () => {
    stubFetch(() => new Response('', { status: 404, statusText: 'Not Found' }))

    await expect(generateImages({ prompt: 'x' })).rejects.toThrow(/POST \/images\/generations/)
  })

  /**
   * 消息必须短：AI 创作那边的 getFriendlyErrorMessage 会把超过 100 字的
   * 整条压成「生成失败，请稍后重试」—— 那时候端点和状态码也一起没了。
   */
  it('厂商回一长串时截断，别让整条消息被下游压掉', async () => {
    stubFetch(
      () =>
        new Response(JSON.stringify({ error: { message: '很长'.repeat(200) } }), { status: 400 })
    )

    await expect(generateImages({ prompt: 'x' })).rejects.toThrow(
      expect.objectContaining({ message: expect.stringMatching(/^.{0,100}$/) })
    )
  })

  /** 限流与 5xx 再试一次；4xx 再试也是同一个结果，不该让用户多等一倍 */
  it('限流会重试一次，4xx 不重试', async () => {
    let calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      return calls === 1
        ? new Response('', { status: 429 })
        : new Response(JSON.stringify({ data: [{ b64_json: 'AAAA' }] }))
    })
    expect(await generateImages({ prompt: 'x' })).toHaveLength(1)
    expect(calls).toBe(2)

    calls = 0
    vi.stubGlobal('fetch', async () => {
      calls += 1
      return new Response(JSON.stringify({ error: { message: '参数不对' } }), { status: 400 })
    })
    await expect(generateImages({ prompt: 'x' })).rejects.toBeInstanceOf(ImageRequestError)
    expect(calls).toBe(1)
  })

  /**
   * 请求通了但一张图都没回：多数厂商被安全策略挡下时不报错，只回一个空数组。
   * 不拦住的话界面上是「转了半天什么都没有，也没有报错」。
   */
  it('一张图都没回时抛错，而不是回一个空数组', async () => {
    stubFetch(() => new Response(JSON.stringify({ data: [] })))

    await expect(generateImages({ prompt: 'x' })).rejects.toBeInstanceOf(ImageGenerationEmptyError)
  })

  /**
   * 网关的错误页。截断到 40 字的 `<!DOCTYPE html><html><head><ti` 对谁都没意义，
   * 而「回的是网页不是 JSON」本身就指向了原因：地址指错了，或者这个端点
   * 在这家网关上不存在。
   */
  it('网关回 HTML 错误页时说「这是网页不是 JSON」，而不是甩一段标签', async () => {
    stubFetch(
      () =>
        new Response('<!DOCTYPE html><html><head><title>404 Not Found</title></head></html>', {
          status: 404
        })
    )

    await expect(generateImages({ prompt: 'x' })).rejects.toThrow(/HTML 网页而不是 JSON/)
    await expect(generateImages({ prompt: 'x' })).rejects.not.toThrow(/DOCTYPE/)
  })

  /** 完整地址挂在字段上而不是消息里 —— 进消息会把整条撑过下游的 50 字上限 */
  it('错误对象上带着完整请求地址', async () => {
    stubFetch(() => new Response('', { status: 500 }))

    await expect(generateImages({ prompt: 'x' })).rejects.toMatchObject({
      url: 'https://gateway.example.com/v1/images/generations'
    })
  })

  /**
   * 200 但回的是网页：网关把请求接住了，回了自己的登录页/限流页。
   * 不单独处理的话，`response.json()` 抛的是一句 `Unexpected token '<'` ——
   * 既不说是谁返回的，也不说打的哪个地址。
   */
  it('200 却不是 JSON 时说清是哪个端点，而不是抛一句 JSON 解析失败', async () => {
    stubFetch(() => new Response('<html><body>请先登录</body></html>', { status: 200 }))

    await expect(generateImages({ prompt: 'x' })).rejects.toBeInstanceOf(ImageResponseNotJsonError)
    await expect(generateImages({ prompt: 'x' })).rejects.toThrow(/不是 JSON.*images\/generations/)
  })
})

/**
 * 这两条错误会经过 imagePollingService 的 getFriendlyErrorMessage，
 * 那套规则会按关键词归类、并把超过 100 字的消息压成一句「生成失败，请稍后重试」。
 * 它靠这个共享短语认出「别动这条」—— 短语一旦被改没了，用户看到的就只剩
 * 那句正确但完全没法照做的话，而且没有任何测试会红。
 */
describe('配置类错误的锚点短语', () => {
  it('未配置生图模型的提示里带着锚点', async () => {
    settings.roles = {}

    await expect(generateImages({ prompt: 'x' })).rejects.toThrow(IMAGE_CONFIG_ERROR_MARKER)
  })

  it('协议不支持的提示里也带着锚点', async () => {
    settings.providers[0].protocol = 'anthropic-messages'

    await expect(generateImages({ prompt: 'x' })).rejects.toThrow(IMAGE_CONFIG_ERROR_MARKER)
  })
})

/**
 * 一大半厂商不回 base64：硅基流动回 `images[].url`（顶层键都不一样），
 * 智谱回 `data[].url`。地址还会过期，所以要当场取回来。
 */
describe('图片地址的取回', () => {
  function stubWithDownload(payload: unknown, bytes = Buffer.from([1, 2, 3])): string[] {
    const calls: string[] = []
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input)
      calls.push(url)
      if (url.startsWith('https://cdn.example.com/')) {
        return new Response(bytes, { headers: { 'content-length': String(bytes.byteLength) } })
      }
      return new Response(JSON.stringify(payload), {
        headers: { 'content-type': 'application/json' }
      })
    })
    return calls
  }

  it('智谱的 data[].url 被取回来存成 base64', async () => {
    stubWithDownload({
      data: [{ url: 'https://cdn.example.com/a.png' }, { url: 'https://cdn.example.com/b.png' }]
    })

    expect(await generateImages({ prompt: 'x' })).toHaveLength(2)
  })

  it('已经是 base64 的不多打一趟下载', async () => {
    const calls = stubWithDownload({ data: [{ b64_json: 'QUJD' }] })

    expect(await generateImages({ prompt: 'x' })).toEqual([
      { base64: 'QUJD', mediaType: 'image/png' }
    ])
    expect(calls).toHaveLength(1)
  })

  it('超大的图片被挡下，而不是把主进程内存吃干', async () => {
    stubWithDownload(
      { data: [{ url: 'https://cdn.example.com/huge.png' }] },
      Buffer.alloc(33 * 1024 * 1024)
    )

    await expect(generateImages({ prompt: 'x' })).rejects.toThrow(/上限/)
  })
})

describe('未配置时的表现', () => {
  it('没绑定生图模型时给出可操作的提示，而不是回落到对话模型', async () => {
    settings.roles = {}

    await expect(generateImages({ prompt: 'x' })).rejects.toThrow(/生图/)
  })

  it('绑定指向已删除的 Provider 时同样按未配置处理', async () => {
    settings.roles = { image: { providerId: 'gone', modelId: 'x' } }

    expect(await getImageModelStatus()).toEqual({ configured: false, model: null })
    await expect(generateImages({ prompt: 'x' })).rejects.toThrow(/生图/)
  })

  it('没有绑定时也不给模型名', async () => {
    settings.roles = {}

    expect(await getImageModelStatus()).toEqual({ configured: false, model: null })
  })

  /**
   * 用 displayName 而不是 provider id：界面上要显示给人看，
   * 「我的网关:flux-1-schnell」比「my-gateway:flux-1-schnell」认得出来。
   */
  it('配好时回「Provider 显示名:模型 id」，供界面说明现在是谁在画', async () => {
    expect(await getImageModelStatus()).toEqual({
      configured: true,
      model: '我的网关:flux-1-schnell'
    })
  })
})

/**
 * 异步任务式的中转站（toapis 这一类）。
 *
 * 它们的 `/images/generations` **请求体与 OpenAI 一模一样**，只有 200 响应换成了
 * 一张任务单：`{ id, object: 'generation.task', status: 'queued' }`，里面一张图
 * 都没有。不认这个形状的话，用户看到的是「厂商没有返回图片」—— 而真相是图正在
 * 画，并且提交那一刻钱就已经扣了。
 *
 * @see https://docs.toapis.com/docs/cn/api-reference/tasks/image-status
 */
describe('异步任务式的中转站', () => {
  const TASK_ID = 'task_img_abc123'
  const POLL_URL = `https://gateway.example.com/v1/images/generations/${TASK_ID}`

  interface PollReply {
    body: unknown
    status?: number
    headers?: Record<string, string>
  }

  /** 提交一律回任务单；之后每次轮询按 `polls` 顺序回一条，用完停在最后一条 */
  function stubTaskGateway(polls: PollReply[]): void {
    let polled = 0
    vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
      const url = String(input)
      if (url.startsWith('https://cdn.example.com/')) return new Response(Buffer.from([1, 2, 3]))
      sent.push({
        url,
        headers: (init.headers as Record<string, string>) ?? {},
        json: typeof init.body === 'string' ? JSON.parse(init.body) : {},
        form: init.body instanceof FormData ? init.body : null
      })
      if (init.body) {
        return new Response(
          JSON.stringify({ id: TASK_ID, object: 'generation.task', status: 'queued', progress: 0 })
        )
      }
      const reply = polls[Math.min(polled, polls.length - 1)]
      polled += 1
      return new Response(JSON.stringify(reply.body), {
        status: reply.status ?? 200,
        headers: reply.headers
      })
    })
  }

  /** 跑到底，中途把假时钟推完 —— 轮询之间要等 5 秒，真等就是一个几分钟的测试 */
  async function settle<T>(pending: Promise<T>, ms = 60_000): Promise<T> {
    await vi.advanceTimersByTimeAsync(ms)
    return pending
  }

  /**
   * 同上，但拿回抛出来的那个错。
   *
   * 捕获必须在推时钟**之前**挂上：拒绝发生在 `advanceTimersByTimeAsync` 里面，
   * 等推完再 `rejects` 就晚了一步，vitest 会把它记成一条 unhandled rejection。
   */
  async function settleError(pending: Promise<unknown>, ms = 60_000): Promise<unknown> {
    const captured = pending.then(
      () => new Error('本该失败，却成功了'),
      (error) => error
    )
    await vi.advanceTimersByTimeAsync(ms)
    return captured
  }

  beforeEach(() => {
    // 外面那个 beforeEach 不复位 baseUrl，改过它的用例会污染后面的
    settings.providers[0].baseUrl = 'https://gateway.example.com/v1'
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('提交只拿到任务号时接着轮询，完成后把图取回来', async () => {
    stubTaskGateway([
      { body: { id: TASK_ID, status: 'in_progress', progress: 50 } },
      {
        body: {
          id: TASK_ID,
          status: 'completed',
          progress: 100,
          result: { type: 'image', data: [{ url: 'https://cdn.example.com/a.png' }] }
        }
      }
    ])

    expect(await settle(generateImages({ prompt: 'x' }))).toEqual([
      { base64: Buffer.from([1, 2, 3]).toString('base64'), mediaType: 'image/png' }
    ])
    // 提交 1 次 + 轮询 2 次。查询端点是全站通用的那一个，与提交端点无关
    expect(sent).toHaveLength(3)
    expect(sent[1].url).toBe(POLL_URL)
    expect(sent[2].url).toBe(POLL_URL)
  })

  /** 提交与轮询要带同一份头。漏掉自定义头的那一边会在做了 bot 检测的网关上莫名 403 */
  it('轮询带上和提交同一份鉴权头', async () => {
    settings.providers[0].apiKey = { kind: 'env', name: 'TASK_GATEWAY_KEY' }
    vi.stubEnv('TASK_GATEWAY_KEY', 'sk-relay')
    stubTaskGateway([
      { body: { id: TASK_ID, status: 'completed', result: { data: [{ b64_json: 'QUJD' }] } } }
    ])

    try {
      await settle(generateImages({ prompt: 'x' }))
    } finally {
      vi.unstubAllEnvs()
    }
    expect(sent[1].headers).toMatchObject({
      Authorization: 'Bearer sk-relay',
      'User-Agent': 'unreal-box'
    })
  })

  /**
   * 任务失败时钱已经扣了。厂商那句话是唯一能说明「为什么白花了这笔钱」的东西，
   * 必须原样带出来，而不是压成一句「厂商没有返回图片」。
   */
  it('任务失败时把厂商那句话带出来，而不是报「没有返回图片」', async () => {
    stubTaskGateway([
      {
        body: {
          id: TASK_ID,
          status: 'failed',
          error: { code: 'generation_failed', message: 'upstream returned status 422' }
        }
      }
    ])

    const error = await settleError(generateImages({ prompt: 'x' }))
    expect(error).toBeInstanceOf(ImageTaskFailedError)
    expect(error).not.toBeInstanceOf(ImageGenerationEmptyError)
    expect((error as Error).message).toMatch(/upstream returned status 422/)
    expect(error).toMatchObject({ taskId: TASK_ID })
  })

  /** 限流时照原节奏问下去只会被越限越死。厂商说等多久就等多久 */
  it('429 时按 Retry-After 退避后继续轮询', async () => {
    stubTaskGateway([
      { body: {}, status: 429, headers: { 'retry-after': '30' } },
      { body: { id: TASK_ID, status: 'completed', result: { data: [{ b64_json: 'QUJD' }] } } }
    ])

    const pending = generateImages({ prompt: 'x' })
    // 第一次轮询吃了 429，说好等 30 秒 —— 这时候还不该有第三次请求
    await vi.advanceTimersByTimeAsync(20_000)
    expect(sent).toHaveLength(2)

    await vi.advanceTimersByTimeAsync(40_000)
    expect(await pending).toHaveLength(1)
    expect(sent).toHaveLength(3)
  })

  /**
   * 一直排队时要带着任务号退出：图多半还是会画出来，额度也确实扣了，
   * 用户拿这个号能去厂商控制台把图取回来。
   */
  it('一直排队时超时并带出任务号', async () => {
    stubTaskGateway([{ body: { id: TASK_ID, status: 'queued', progress: 0 } }])

    const error = await settleError(generateImages({ prompt: 'x' }), 250_000)
    expect(error).toBeInstanceOf(ImageTaskTimeoutError)
    expect((error as Error).message).toContain(TASK_ID)
  })

  /** 点了取消要立刻停下，而不是把这一轮的 5 秒等待走完 */
  it('取消后立刻停下，不再发下一次轮询', async () => {
    stubTaskGateway([{ body: { id: TASK_ID, status: 'queued' } }])

    const controller = new AbortController()
    const pending = generateImages({ prompt: 'x', signal: controller.signal })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(sent, '这时候只该发出去提交那一次').toHaveLength(1)

    controller.abort()
    // 取消的是我们这边的等待，不是厂商那边的任务 —— 那个还在画，钱也扣了，
    // 所以任务号必须活着出来，否则这一次就是白付
    const error = await pending.catch((reason) => reason)
    expect(error).toBeInstanceOf(ImageTaskCancelledError)
    expect(error).toMatchObject({ taskId: TASK_ID })
    await vi.advanceTimersByTimeAsync(30_000)
    expect(sent).toHaveLength(1)
  })

  /**
   * 查询端点回了个不带任务号的东西 = 厂商改了响应结构，再问下去也是同一份。
   *
   * 这里**不能**是 ImageGenerationEmptyError：那一句让用户「换个提示词再试」，
   * 而提示词在这里是清白的，照做就是再付一次钱。
   */
  it('查询响应认不出来时停下，并说清任务还在跑', async () => {
    stubTaskGateway([{ body: { unexpected: true } }])

    const error = await settleError(generateImages({ prompt: 'x' }))
    expect(error).toBeInstanceOf(ImageTaskInterruptedError)
    expect(error).not.toBeInstanceOf(ImageGenerationEmptyError)
    expect(error).toMatchObject({ taskId: TASK_ID })
    expect(sent).toHaveLength(2)
  })

  /**
   * 提交之后钱已经扣了、任务也在厂商那边跑着。一次 502 或一次连接抖动只是
   * 「这一次没查到」—— 为它把一张付过钱的图判死刑，是这条链路上最贵的错误。
   */
  it('查询偶发失败时熬着继续查，不把已付费的任务判死刑', async () => {
    stubTaskGateway([
      { body: { error: 'bad gateway' }, status: 502 },
      { body: {}, status: 500 },
      { body: { id: TASK_ID, status: 'completed', result: { data: [{ b64_json: 'QUJD' }] } } }
    ])

    expect(await settle(generateImages({ prompt: 'x' }))).toEqual([
      { base64: 'QUJD', mediaType: 'image/png' }
    ])
    expect(sent).toHaveLength(4)
  })

  /** 但一直查不到就不能无限熬：说明查询这一端真的断了，把任务号交出来 */
  it('连续查不到超过容忍次数后停下，带出任务号', async () => {
    stubTaskGateway([{ body: {}, status: 503 }])

    const error = await settleError(generateImages({ prompt: 'x' }))
    expect(error).toBeInstanceOf(ImageTaskInterruptedError)
    expect(error).toMatchObject({ taskId: TASK_ID })
    // 提交 1 次 + 容忍 5 次查询
    expect(sent).toHaveLength(6)
  })

  /** 4xx 是「问清楚了，就是这个结果」，熬下去也是同一份 —— 立刻停 */
  it('查询挨了 404 不熬，直接报错', async () => {
    stubTaskGateway([{ body: { error: { message: '任务不存在' } }, status: 404 }])

    const error = await settleError(generateImages({ prompt: 'x' }))
    expect(error).toBeInstanceOf(ImageRequestError)
    expect(sent).toHaveLength(2)
  })

  /**
   * 轮询是 GET。报错里写死 POST 的话，用户照着去查的是一个根本不存在的请求 ——
   * 而这句话是他唯一拿得到的线索。
   */
  it('查询出错时报的是 GET，不是 POST', async () => {
    stubTaskGateway([{ body: { error: { message: '任务不存在' } }, status: 404 }])

    const error = await settleError(generateImages({ prompt: 'x' }))
    expect((error as Error).message).toContain(`GET /images/generations/${TASK_ID}`)
    expect((error as Error).message).not.toContain('POST')
  })

  /**
   * `Retry-After: 3600` 不能真睡一小时：睡过 deadline 之后开火的是外面那个
   * 五分钟的信号，抛出来的是光秃秃的 AbortError，任务号跟着没了。
   */
  it('超长的 Retry-After 被剪到剩余时间内，超时仍由这里报出', async () => {
    stubTaskGateway([{ body: {}, status: 429, headers: { 'retry-after': '3600' } }])

    const error = await settleError(generateImages({ prompt: 'x' }), 260_000)
    expect(error).toBeInstanceOf(ImageTaskTimeoutError)
    expect((error as Error).message).toContain(TASK_ID)
  })

  /** 用户粘 Base URL 常带一个末尾斜杠。拼出 `//images/...` 在精确路由的网关上是 404 */
  it('Base URL 带末尾斜杠时提交和查询都不出现双斜杠', async () => {
    settings.providers[0].baseUrl = 'https://gateway.example.com/v1/'
    stubTaskGateway([
      { body: { id: TASK_ID, status: 'completed', result: { data: [{ b64_json: 'QUJD' }] } } }
    ])

    await settle(generateImages({ prompt: 'x' }))
    expect(sent[0].url).toBe('https://gateway.example.com/v1/images/generations')
    expect(sent[1].url).toBe(POLL_URL)
  })

  /**
   * toapis 的真实配置：参考图必须先传成 URL（imageUploadUrl），生成又是异步的。
   * 三段要一起走通 —— 上传的响应不能被当成任务单，上传回来的 URL 也不能在
   * 轮询接手时丢掉。
   */
  it('上传接口 + 异步任务一起工作：上传 → 提交 → 轮询', async () => {
    settings.providers[0].imageUploadUrl = 'https://gateway.example.com/v1/uploads/images'
    let polled = false
    vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
      const url = String(input)
      sent.push({
        url,
        headers: (init.headers as Record<string, string>) ?? {},
        json: typeof init.body === 'string' ? JSON.parse(init.body) : {},
        form: init.body instanceof FormData ? init.body : null
      })
      if (url.endsWith('/uploads/images')) {
        return new Response(JSON.stringify({ data: { url: 'https://files.example.com/r.png' } }))
      }
      if (url === POLL_URL) {
        polled = true
        return new Response(
          JSON.stringify({
            id: TASK_ID,
            status: 'completed',
            result: { data: [{ b64_json: 'QUJD' }] }
          })
        )
      }
      return new Response(
        JSON.stringify({ id: TASK_ID, object: 'generation.task', status: 'queued' })
      )
    })

    expect(await settle(generateImages({ prompt: 'x', referenceImages: ['QUJD'] }))).toEqual([
      { base64: 'QUJD', mediaType: 'image/png' }
    ])
    expect(polled).toBe(true)
    expect(sent.map((request) => request.url)).toEqual([
      'https://gateway.example.com/v1/uploads/images',
      'https://gateway.example.com/v1/images/generations',
      POLL_URL
    ])
    // 上传回来的 URL 不能在轮询接手时丢掉
    expect(sent[1].json.image_urls).toEqual(['https://files.example.com/r.png'])
  })

  /**
   * 查询端点是全站通用的那一个，与提交打的是哪个端点无关。
   * 没有上传接口时参考图走 multipart 的 `/images/edits`，任务照样在
   * `/images/generations/{id}` 查。
   */
  it('走 /images/edits 提交的任务同样在 /images/generations 查', async () => {
    stubTaskGateway([
      { body: { id: TASK_ID, status: 'completed', result: { data: [{ b64_json: 'QUJD' }] } } }
    ])

    await settle(generateImages({ prompt: 'x', referenceImages: ['QUJD'] }))
    expect(sent[0].url).toBe('https://gateway.example.com/v1/images/edits')
    expect(sent[1].url).toBe(POLL_URL)
  })

  /** 同步返回图片的厂商一个字都不该变：任务单那条路只在「一张图都没有」时才走 */
  it('同步回图的厂商不受影响，不会多打一次查询', async () => {
    vi.stubGlobal('fetch', async (input: unknown, init: RequestInit = {}) => {
      sent.push({
        url: String(input),
        headers: (init.headers as Record<string, string>) ?? {},
        json: typeof init.body === 'string' ? JSON.parse(init.body) : {},
        form: null
      })
      // 任务号和状态都在，但图也在 —— 有图就该直接用图
      return new Response(
        JSON.stringify({ id: TASK_ID, status: 'completed', data: [{ b64_json: 'QUJD' }] })
      )
    })

    expect(await settle(generateImages({ prompt: 'x' }), 0)).toEqual([
      { base64: 'QUJD', mediaType: 'image/png' }
    ])
    expect(sent).toHaveLength(1)
  })
})

/**
 * ChatGPT 订阅出图：Codex 后端没有 `/images/*`，出图是 Responses 的 image_generation 工具，
 * 响应是事件流。这里钉住三件做错就一张图都拿不到的事：后端要的那几个头、
 * 强制调用工具的请求体、从事件流里取图。
 */
describe('Codex 订阅出图', () => {
  const CODEX_URL = 'https://chatgpt.com/backend-api/codex'
  const ACCOUNT = 'acct-123'
  const jwt = (claims: Record<string, unknown>): string =>
    `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`

  /** 一段事件流：每个事件一行 `data:`，与后端的形状一致 */
  function sse(...events: Record<string, unknown>[]): Response {
    return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''), {
      headers: { 'content-type': 'text/event-stream' }
    })
  }

  const imageDone = (result = 'QUJD', format = 'png'): Record<string, unknown> => ({
    type: 'response.output_item.done',
    item: { type: 'image_generation_call', result, output_format: format }
  })

  let originalBaseUrl = ''
  beforeEach(() => {
    originalBaseUrl = settings.providers[0].baseUrl
    process.env.CODEX_TEST_TOKEN = jwt({
      'https://api.openai.com/auth': { chatgpt_account_id: ACCOUNT }
    })
    settings.providers[0].protocol = 'openai-codex-responses'
    settings.providers[0].baseUrl = CODEX_URL
    settings.providers[0].apiKey = { kind: 'env', name: 'CODEX_TEST_TOKEN' }
    useModel('codex-images', 'gpt-5.6-luna')
    stubFetch(() => sse({ type: 'response.created' }, imageDone(), { type: 'response.completed' }))
  })
  afterEach(() => {
    settings.providers[0].baseUrl = originalBaseUrl
    delete process.env.CODEX_TEST_TOKEN
  })

  it('打 /responses，带上账号 id，强制调用生图工具、只要流、不落库', async () => {
    await generateImages({ prompt: '一只木箱', aspectRatio: '16:9' })

    const request = lastRequest()
    expect(request.url).toBe(`${CODEX_URL}/responses`)
    expect(request.headers).toMatchObject({
      Authorization: `Bearer ${process.env.CODEX_TEST_TOKEN}`,
      'chatgpt-account-id': ACCOUNT,
      'OpenAI-Beta': 'responses=experimental',
      Accept: 'text/event-stream'
    })
    expect(request.json).toMatchObject({
      model: 'gpt-5.6-luna',
      stream: true,
      store: false,
      tools: [{ type: 'image_generation', output_format: 'png' }],
      tool_choice: { type: 'image_generation' }
    })
    // 后端不听 size，比例要写进提示词才生效
    const content = (request.json.input as { content: { type: string; text?: string }[] }[])[0]
      .content
    expect(content[0]).toEqual({ type: 'input_text', text: '一只木箱\n\nAspect ratio: 16:9.' })
  })

  it('只给了像素尺寸时按尺寸推出比例', async () => {
    await generateImages({ prompt: 'x', size: '1536x1024' })
    const content = (lastRequest().json.input as { content: { text?: string }[] }[])[0].content
    expect(content[0].text).toBe('x\n\nAspect ratio: 3:2.')
  })

  it('从事件流里取图，媒体类型跟着输出格式走', async () => {
    stubFetch(() => sse({ type: 'response.created' }, imageDone('V0VCUA', 'webp')))
    expect(await generateImages({ prompt: 'x' })).toEqual([
      { base64: 'V0VCUA', mediaType: 'image/webp' }
    ])
  })

  it('参考图作为 input_image 跟在提示词后面', async () => {
    await generateImages({ prompt: 'x', referenceImages: ['data:image/jpeg;base64,QUJD'] })
    const content = (lastRequest().json.input as { content: unknown[] }[])[0].content
    expect(content[1]).toEqual({ type: 'input_image', image_url: 'data:image/jpeg;base64,QUJD' })
  })

  /** 后端一次只出一张：要三张就是三次请求，而不是发一个它不认的 n */
  it('要几张就并发几次，每次一张', async () => {
    const images = await generateImages({ prompt: 'x', count: 3 })
    expect(sent).toHaveLength(3)
    expect(images).toHaveLength(3)
    expect(sent.every((request) => !('n' in request.json))).toBe(true)
  })

  /** 挂了一张不能把已经出好的几张一起扔掉：那几张的额度已经花了 */
  it('部分失败时留下出好的那几张', async () => {
    let calls = 0
    stubFetch(() =>
      ++calls === 2
        ? new Response('{"error":{"message":"busy"}}', { status: 500 })
        : sse(imageDone())
    )
    expect(await generateImages({ prompt: 'x', count: 3 })).toHaveLength(2)
  })

  it('全部失败时报第一个原因', async () => {
    stubFetch(
      () => new Response('{"error":{"message":"You have hit your usage limit"}}', { status: 429 })
    )
    await expect(generateImages({ prompt: 'x', count: 2 })).rejects.toBeInstanceOf(
      ImageRequestError
    )
  })

  /** 被审核拦下时后端不报错，只回一段话 —— 那段话就是原因，不能换成「没有返回图片」 */
  it('只回了一段话时把那段话带出来', async () => {
    stubFetch(() =>
      sse({
        type: 'response.output_item.done',
        item: { type: 'message', content: [{ type: 'output_text', text: '这个请求我不能画。' }] }
      })
    )
    await expect(generateImages({ prompt: 'x' })).rejects.toThrow('这个请求我不能画。')
  })

  it('事件流里报错时带出后端那句话', async () => {
    stubFetch(() =>
      sse({ type: 'response.failed', response: { error: { message: 'image tool failed' } } })
    )
    await expect(generateImages({ prompt: 'x' })).rejects.toBeInstanceOf(CodexImageError)
    await expect(generateImages({ prompt: 'x' })).rejects.toThrow('image tool failed')
  })

  /** 手填的模型没写 imageApi：Codex 后端只有这一种出图方式，不能按名字猜去打 /images/generations */
  it('手填的模型没写接口形状也走生图工具', async () => {
    useModel(undefined, 'gpt-6-luna')
    await generateImages({ prompt: 'x' })
    expect(lastRequest().url).toBe(`${CODEX_URL}/responses`)
  })

  it('令牌里解不出账号 id 时直说重新登录，不发请求', async () => {
    process.env.CODEX_TEST_TOKEN = 'not-a-jwt'
    await expect(generateImages({ prompt: 'x' })).rejects.toBeInstanceOf(CodexAccountMissingError)
    expect(sent).toHaveLength(0)
  })
})
