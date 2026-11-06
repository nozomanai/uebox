import { describe, expect, it, beforeEach, vi } from 'vitest'

/**
 * URL 内容分析的通道选择。
 *
 * 视频理解这条链路以前有两份实现：`urlAnalyzer` 里一条走 qwen-vl 的本地路径，
 * 以及 `sqliteDataBase/ipc/jina.ts` 里一段把视频 URL 截下来发给官方服务端的代码 ——
 * 那段的注释写着「不回退到本地，确保计费」，目的就是计费本身。已整体删除。
 *
 * 这些用例守住三件事：
 *
 * 1. 图片与视频都只走用户自己的百炼 Key，**一个官方端点都不碰**
 * 2. Key 在 `analyzeUrl` 里解析一次往下传 —— 两个分析器不再各自读
 *    `process.env.QWEN_API_KEY`（打包版里那个变量不存在，于是永远缺 Key）
 * 3. 缺 Key 时给的是「去申请一个」而不是「请在 .env 文件中设置」——
 *    打包版用户没有 .env 可改，那是条走不通的路
 */

const qwenKey = { value: undefined as string | undefined }
const calls: Array<{ kind: 'image' | 'video'; url: string; apiKey?: string }> = []

vi.mock('../../ai/providerKey', () => ({
  resolveProviderApiKey: async () => qwenKey.value
}))

/**
 * `urlAnalyzer` 在模块求值期就读 `BAILIAN_KEY_MISSING_ERROR`（它的
 * `VISION_KEY_HINT` 就是这个值），factory mock 不给的话整个文件加载不起来：
 * 「No "BAILIAN_KEY_MISSING_ERROR" export is defined on the mock」，
 * 下面 8 条用例一条都不跑 —— 包括「没有 Key 时不调用任何分析器」那条底线。
 *
 * 正文照抄 `imageAnalyzer.ts` 里那一份。这里抄一遍是为了让下面的断言有东西可比，
 * **真正那句话长什么样由 `imageAnalyzer.test.ts` 守着**；这个文件守的是
 * 「提示从 imageAnalyzer 来，不是 urlAnalyzer 自己又写一句 .env」。
 */
const BAILIAN_KEY_MISSING_ERROR =
  '未配置百炼 API Key。到 https://bailian.console.aliyun.com 申请，' +
  '在 设置 → 模型 里填进「阿里云百炼（通义千问）」这个服务商。'

vi.mock('./imageAnalyzer', () => ({
  BAILIAN_KEY_MISSING_ERROR,
  analyzeImageUrl: async (url: string, options?: { apiKey?: string }) => {
    calls.push({ kind: 'image', url, apiKey: options?.apiKey })
    return { success: true, content: '一张图', url }
  }
}))

vi.mock('./videoAnalyzer', () => ({
  analyzeVideoUrl: async (url: string, options?: { apiKey?: string }) => {
    calls.push({ kind: 'video', url, apiKey: options?.apiKey })
    return { success: true, content: '一段视频', url }
  }
}))

const { analyzeUrl, detectUrlType, VISION_KEY_HINT } = await import('./urlAnalyzer')

beforeEach(() => {
  qwenKey.value = undefined
  calls.length = 0
})

describe('URL 分析的通道选择', () => {
  it('视频走本地分析器，并拿到解析好的 Key', async () => {
    qwenKey.value = 'sk-user-bailian'

    const result = await analyzeUrl('https://example.com/clip.mp4')

    expect(result.success).toBe(true)
    expect(result.urlType).toBe('video')
    expect(calls).toEqual([
      { kind: 'video', url: 'https://example.com/clip.mp4', apiKey: 'sk-user-bailian' }
    ])
  })

  it('图片与视频共用同一把 Key', async () => {
    qwenKey.value = 'sk-user-bailian'

    await analyzeUrl('https://example.com/a.png')
    await analyzeUrl('https://example.com/b.mp4')

    expect(calls.map((c) => c.apiKey)).toEqual(['sk-user-bailian', 'sk-user-bailian'])
  })

  /**
   * 这条是社区版的底线：视觉理解只用用户自己的额度，没有任何理由经过官方服务端。
   * 分析器压根不该被调到 —— 缺 Key 时在路由层就该拦下。
   */
  it('没有 Key 时不调用任何分析器，提示去申请而不是去改 .env', async () => {
    const result = await analyzeUrl('https://example.com/clip.mp4')

    expect(result.success).toBe(false)
    expect(calls).toEqual([])
    expect(result.error).toBe(VISION_KEY_HINT)
    expect(result.error).toContain('bailian.console.aliyun.com')
    expect(result.error).not.toContain('.env')
    expect(result.error).not.toContain('登录')
  })

  it('网页仍然回退给 Jina Reader，不受 Key 影响', async () => {
    const result = await analyzeUrl('https://example.com/article')

    expect(result.urlType).toBe('webpage')
    expect(result.error).toBe('__USE_JINA__')
    expect(calls).toEqual([])
  })

  it('音频与文档仍然是「下载后上传」，不占用 Key', async () => {
    qwenKey.value = 'sk-user-bailian'

    const audio = await analyzeUrl('https://example.com/voice.mp3')
    const doc = await analyzeUrl('https://example.com/spec.pdf')

    expect(audio.success).toBe(false)
    expect(doc.success).toBe(false)
    expect(calls).toEqual([])
  })

  it('扩展名识别覆盖常见的图片与视频', () => {
    expect(detectUrlType('https://example.com/a.MP4')).toBe('video')
    expect(detectUrlType('https://example.com/a.jpeg?x=1')).toBe('image')
    expect(detectUrlType('https://example.com/no-extension')).toBe('webpage')
  })
})
