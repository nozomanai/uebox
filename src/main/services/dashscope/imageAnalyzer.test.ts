import { describe, expect, it, beforeEach, vi } from 'vitest'
import { EventEmitter } from 'events'

/**
 * AI 智能命名到底用谁的模型、谁的 Key。
 *
 * 两条历史都在这个文件里：
 *
 * 1. 这几个函数原先读 `process.env.QWEN_API_KEY`。打包后 `.env` 不进 asar，
 *    那个变量不存在 —— 用户在 设置 → 模型 里填了阿里云百炼的 Key 也取不到。
 *    开发环境的兜底变量名同样错了：`.env.example` 里只有 `DASHSCOPE_API_KEY`。
 * 2. 缩略图取名（`generate3DModelName`）原先绑死在百炼的 Key 上。它做的是普通的
 *    图片理解，用户绑了智谱、OpenAI 的视觉模型照样该能用 —— 现在走
 *    `analyzeImageWithConfiguredModel`，这个文件里不替他指定厂商。
 *
 * 所以这里**不 mock `providerKey`** —— 把它连同 `app.isPackaged`、设置、密钥库一起
 * 真跑一遍。只 mock 最外层的三样：Electron、设置与密钥的存储、模型调用。
 * provider id 写错、env 变量名写错、`app.isPackaged` 门禁回归，都会在这里变红。
 */

/** `app.isPackaged` 要逐条用例改，所以给一个可变对象 */
const electronApp = { isPackaged: true }

/**
 * 缩略图直链那支下载走的是 Electron 的 `net.fetch`，不是 Node 的全局 `fetch`。
 *
 * 这两个不等价：`net` 读 Chromium 那套系统代理配置，Node 的 `fetch` 不读。
 * 同一张图是 `imagePollingService` 用 `net.fetch` 存下来的，取名这次下的是
 * 同一个直链 —— 走岔了，挂代理的用户就会碰到「图存下来了、取名那次下载失败」。
 */
const netFetch = vi.fn<(url: string, init?: RequestInit) => Promise<unknown>>()
vi.mock('electron', () => ({ app: electronApp, net: { fetch: netFetch } }))

/** 用户在 设置 → 模型 里配成什么样 */
const settings = {
  version: 1,
  providers: [] as Array<{ id: string; apiKey: { kind: string; id?: string } }>,
  roles: {} as Record<string, { providerId: string; modelId: string } | undefined>
}
vi.mock('../../ai/store', () => ({ readSettings: async () => settings }))

/** 主进程的密钥库。只有 secret 引用能解出东西，和真实实现一致 */
const secrets: Record<string, string> = {}
vi.mock('../../ai/credentials', () => ({
  resolveApiKey: async (ref: { kind: string; id?: string }) =>
    ref?.kind === 'secret' ? secrets[ref.id ?? ''] || '' : ''
}))

/** 用户配好的模型被怎么调的 */
interface Completion {
  providerId: string
  modelId: string
  system?: string
  image?: { type: string; data: string; mimeType: string }
}
const completions: Completion[] = []
const modelReply = { text: '青铜巨像', failure: null as Error | null }

vi.mock('../../ai/piCompletion', () => ({
  resolveBinding: async () => {
    // 真实实现在没绑模型时抛 ModelNotConfiguredError
    const binding = settings.roles.vision
    if (!binding) throw new Error('没有绑定视觉模型')
    return { provider: { id: binding.providerId }, modelId: binding.modelId, role: 'vision' }
  },
  complete: async (
    provider: { id: string },
    modelId: string,
    request: { system?: string; messages: Array<{ content: unknown[] }> }
  ) => {
    completions.push({
      providerId: provider.id,
      modelId,
      system: request.system,
      image: request.messages[0]?.content?.[0] as Completion['image']
    })
    if (modelReply.failure) throw modelReply.failure
    return { content: [{ type: 'text', text: modelReply.text }] }
  }
}))

interface FakeResponse extends EventEmitter {
  statusCode?: number
  statusMessage?: string
}

/** 打到百炼端点的请求。走到这里就说明用的是百炼那条路 */
const authorizations: Array<string | undefined> = []

/** 假的 https.request：记下 Authorization 头，回一条固定的成功响应 */
function fakeRequest(
  options: { headers?: Record<string, unknown> },
  onResponse: (response: FakeResponse) => void
): EventEmitter {
  authorizations.push(options.headers?.Authorization as string | undefined)

  const response = new EventEmitter() as FakeResponse
  response.statusCode = 200

  return Object.assign(new EventEmitter(), {
    write: () => {},
    destroy: () => {},
    end: () => {
      onResponse(response)
      response.emit(
        'data',
        Buffer.from(JSON.stringify({ choices: [{ message: { content: '青铜巨像' } }] }))
      )
      response.emit('end')
    }
  })
}

vi.mock('https', () => ({ default: { request: fakeRequest }, request: fakeRequest }))
vi.mock('http', () => ({ default: { request: fakeRequest }, request: fakeRequest }))

const { analyzeImageUrl, generate3DModelName, generateNameFromPrompt, BAILIAN_KEY_MISSING_ERROR } =
  await import('./imageAnalyzer')

/** 错误码由两个进程共用的这一份定义，界面那边 import 的是同一个常量 */
const { NO_VISION_MODEL_ERROR_KEY } = await import('../../../shared/aiNamingErrorKey')

/** 把用户的配置写成「绑了某家的视觉模型」 */
function bindVisionModel(providerId: string): void {
  settings.providers.push({ id: providerId, apiKey: { kind: 'secret', id: `${providerId}-key` } })
  secrets[`${providerId}-key`] = `sk-${providerId}`
  settings.roles.vision = { providerId, modelId: `${providerId}-vl` }
}

/** 把用户的配置写成「只填了百炼的 Key，没绑任何角色」 */
function fillBailianKey(key: string): void {
  settings.providers.push({ id: 'alibaba', apiKey: { kind: 'secret', id: 'alibaba-key' } })
  secrets['alibaba-key'] = key
}

beforeEach(() => {
  electronApp.isPackaged = true
  settings.providers = []
  settings.roles = {}
  for (const id of Object.keys(secrets)) delete secrets[id]
  completions.length = 0
  authorizations.length = 0
  modelReply.text = '青铜巨像'
  modelReply.failure = null
  netFetch.mockReset()
  delete process.env.QWEN_BASE_URL
  delete process.env.QWEN_API_KEY
  delete process.env.DASHSCOPE_API_KEY
  vi.unstubAllGlobals()
})

describe('百炼 URL 理解的 Key 来源', () => {
  it('打包环境下从设置里那个 provider 读 Key', async () => {
    fillBailianKey('sk-from-settings')

    const result = await analyzeImageUrl('https://example.com/a.png')
    const fromPrompt = await generateNameFromPrompt('一尊青铜巨像，站在废墟里')

    expect(result.success).toBe(true)
    expect(fromPrompt.success).toBe(true)
    expect(authorizations).toEqual(['Bearer sk-from-settings', 'Bearer sk-from-settings'])
  })

  it('设置里是别家的 provider 时取不到百炼 Key', async () => {
    // provider id 写错（比如把 'alibaba' 改成别的）就会退化成这种情形
    bindVisionModel('zhipu')

    const result = await analyzeImageUrl('https://example.com/a.png')

    expect(result.success).toBe(false)
    expect(result.error).toBe(BAILIAN_KEY_MISSING_ERROR)
    expect(authorizations).toEqual([])
  })

  it('显式传入的 Key 优先于设置', async () => {
    fillBailianKey('sk-from-settings')

    await analyzeImageUrl('https://example.com/a.png', { apiKey: 'sk-explicit' })

    expect(authorizations).toEqual(['Bearer sk-explicit'])
  })

  it('开发环境兜底读 DASHSCOPE_API_KEY，不认 QWEN_API_KEY', async () => {
    electronApp.isPackaged = false
    process.env.QWEN_API_KEY = 'sk-wrong-env-name'
    process.env.DASHSCOPE_API_KEY = 'sk-from-env'

    const result = await analyzeImageUrl('https://example.com/a.png')

    expect(result.success).toBe(true)
    expect(authorizations).toEqual(['Bearer sk-from-env'])
  })

  it('打包环境不认环境变量', async () => {
    process.env.DASHSCOPE_API_KEY = 'sk-from-env'

    const result = await analyzeImageUrl('https://example.com/a.png')

    expect(result.success).toBe(false)
    expect(result.error).toBe(BAILIAN_KEY_MISSING_ERROR)
    expect(authorizations).toEqual([])
  })

  it('缺 Key 时不发请求，错误写明去哪填而不是改 .env', async () => {
    const results = [
      await analyzeImageUrl('https://example.com/a.png'),
      await generateNameFromPrompt('一尊青铜巨像')
    ]

    for (const result of results) {
      expect(result.success).toBe(false)
      expect(result.error).toBe(BAILIAN_KEY_MISSING_ERROR)
      expect(result.error).not.toContain('.env')
    }
    expect(authorizations).toEqual([])
  })
})

describe('缩略图取名用用户自己绑的模型', () => {
  it('绑的是非阿里云的视觉模型也能命名，且一个百炼请求都不发', async () => {
    bindVisionModel('zhipu')

    const result = await generate3DModelName('AAAA')

    expect(result).toEqual({ success: true, name: '青铜巨像' })
    expect(completions).toEqual([
      {
        providerId: 'zhipu',
        modelId: 'zhipu-vl',
        system: expect.stringContaining('取一个具有辨识度的名字'),
        image: { type: 'image', data: 'AAAA', mimeType: 'image/png' }
      }
    ])
    // 百炼那条路在这个函数上整个消失了
    expect(authorizations).toEqual([])
  })

  it('Data URL 的前缀剥掉再交给模型，类型按前缀走', async () => {
    bindVisionModel('zhipu')

    await generate3DModelName('data:image/webp;base64,BBBB')

    expect(completions[0].image).toEqual({ type: 'image', data: 'BBBB', mimeType: 'image/webp' })
  })

  it('HTTP 直链用 net.fetch 取字节，并带上超时的 signal', async () => {
    // AIGC 轮询那条路（imagePollingService）传的就是直链
    bindVisionModel('zhipu')
    netFetch.mockResolvedValue({
      ok: true,
      headers: { get: () => 'image/jpeg; charset=binary' },
      arrayBuffer: async () => Uint8Array.from([1, 2, 3]).buffer
    })
    // 全局 fetch 这条路必须一次都走不到，走到就说明代理行为又岔开了
    const globalFetch = vi.fn()
    vi.stubGlobal('fetch', globalFetch)

    const result = await generate3DModelName('https://example.com/thumb.jpg')

    expect(result.success).toBe(true)
    expect(globalFetch).not.toHaveBeenCalled()
    expect(netFetch).toHaveBeenCalledTimes(1)
    expect(completions[0].image).toEqual({
      type: 'image',
      data: Buffer.from([1, 2, 3]).toString('base64'),
      mimeType: 'image/jpeg'
    })

    /*
      没有 signal 的那一版会永远挂着：链接半死（连上了、响应体不来）时
      Promise 不 settle，界面的 await 不返回、轮询那条路的落库命名停在这一步。
      所以这里盯死「下载请求带着一个会自己到点的 signal」。
    */
    const [url, init] = netFetch.mock.calls[0]
    expect(url).toBe('https://example.com/thumb.jpg')
    expect(init?.signal).toBeInstanceOf(AbortSignal)
  })

  it('下载挂掉（含超时）时回普通失败，不说用户没配置', async () => {
    bindVisionModel('zhipu')
    // AbortSignal.timeout 到点时 fetch 就是这么抛的
    netFetch.mockRejectedValue(
      Object.assign(new Error('The operation was aborted due to timeout'), {
        name: 'TimeoutError'
      })
    )

    const result = await generate3DModelName('https://example.com/half-dead.jpg')

    expect(result.success).toBe(false)
    expect(result.errorKey).toBeUndefined()
    expect(result.error).toContain('timeout')
    // 下不下来就别打扰模型
    expect(completions).toEqual([])
  })

  it('一个看得懂图的模型都没绑时，回可识别的 errorKey', async () => {
    const result = await generate3DModelName('AAAA')

    expect(result.success).toBe(false)
    expect(result.errorKey).toBe(NO_VISION_MODEL_ERROR_KEY)
    expect(completions).toEqual([])
  })

  it('绑了模型但调用失败时不带 errorKey —— 不许说用户没配置', async () => {
    // 密钥解不开、余额不够、网络断了都是这一类。弹「去配置」等于冤枉他
    bindVisionModel('zhipu')
    modelReply.failure = new Error('余额不足')

    const result = await generate3DModelName('AAAA')

    expect(result.success).toBe(false)
    expect(result.errorKey).toBeUndefined()
    expect(result.error).toBe('余额不足')
  })

  it('模型回空内容时不当成没配置', async () => {
    bindVisionModel('zhipu')
    modelReply.text = '   '

    const result = await generate3DModelName('AAAA')

    expect(result.success).toBe(false)
    expect(result.errorKey).toBeUndefined()
  })
})
