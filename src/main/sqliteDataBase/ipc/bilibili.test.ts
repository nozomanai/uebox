/** @vitest-environment node */
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ ipcMain: { handle: vi.fn() } }))
vi.mock('../../services/videoAnalysis/videoSourceAnalysis', () => ({
  analyzeVideoSource: vi.fn()
}))

import { ipcMain } from 'electron'

import { analyzeVideoSource } from '../../services/videoAnalysis/videoSourceAnalysis'
import { registerBilibiliIPC, resolveBilibiliVideoUrl } from './bilibili'

describe('resolveBilibiliVideoUrl', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('从 B 站页面解析并解码临时播放直链', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        text: async () =>
          '<script>window.__INITIAL_STATE__={"playUrlInfo":[{"url":"https:\\u002F\\u002Fcdn.example\\u002Fvideo.mp4?a=1&amp;b=2"}]}</script>'
      })
    )

    await expect(
      resolveBilibiliVideoUrl('https://www.bilibili.com/video/BV1example')
    ).resolves.toEqual({ success: true, data: 'https://cdn.example/video.mp4?a=1&b=2' })
  })

  it('拒绝非 B 站地址且不发起网络请求', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(resolveBilibiliVideoUrl('https://example.com/video/BV1example')).resolves.toEqual({
      success: false,
      data: '',
      error: '请提供有效的 Bilibili 视频 URL'
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('页面没有播放信息时返回明确失败', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ text: async () => '<html></html>' }))

    await expect(
      resolveBilibiliVideoUrl('https://www.bilibili.com/video/BV1example')
    ).resolves.toEqual({
      success: false,
      data: '',
      error: '无法获取视频真实地址，可能视频不存在或受限'
    })
  })
})

interface AnalyzeResult {
  success: boolean
  content?: string
  videoId?: string
  error?: string
}

/** 假的 `event.sender`，用来收主进程往界面推的进度 */
function fakeSender(): { send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean } {
  return { send: vi.fn(), isDestroyed: () => false }
}

/** 取 `bilibili:analyze` 注册进去的那个处理器，按 IPC 入口调用 */
function analyzeHandler(): (
  event: unknown,
  params: { url: string; prompt?: string }
) => Promise<AnalyzeResult> {
  const handle = vi.mocked(ipcMain.handle)
  handle.mockClear()
  registerBilibiliIPC()
  const entry = handle.mock.calls.find(([channel]) => channel === 'bilibili:analyze')
  if (!entry) throw new Error('bilibili:analyze 没有注册')
  return entry[1] as unknown as (
    event: unknown,
    params: { url: string; prompt?: string }
  ) => Promise<AnalyzeResult>
}

describe('bilibili:analyze', () => {
  afterEach(() => {
    vi.mocked(analyzeVideoSource).mockReset()
  })

  it('把 B 站页面地址交给统一入口，而不是把直链转手给模型厂商', async () => {
    vi.mocked(analyzeVideoSource).mockResolvedValue({ success: true, markdown: '# 视频内容' })

    await expect(
      analyzeHandler()(
        { sender: fakeSender() },
        { url: 'https://www.bilibili.com/video/BV1aaaa', prompt: '讲了什么' }
      )
    ).resolves.toEqual({ success: true, videoId: 'BV1aaaa', content: '# 视频内容' })

    expect(analyzeVideoSource).toHaveBeenCalledWith({
      source: 'https://www.bilibili.com/video/BV1aaaa',
      prompt: '讲了什么',
      onProgress: expect.any(Function)
    })
  })

  it('把统一入口报的进度推回发起分析的那个窗口', async () => {
    vi.mocked(analyzeVideoSource).mockImplementation(async (args) => {
      args.onProgress?.('正在下载视频…')
      return { success: true, markdown: '# 视频内容' }
    })

    const sender = fakeSender()
    await analyzeHandler()({ sender }, { url: 'https://www.bilibili.com/video/BV1eeee' })

    expect(sender.send).toHaveBeenCalledWith('bilibili:analyzeProgress', {
      url: 'https://www.bilibili.com/video/BV1eeee',
      note: '正在下载视频…'
    })
  })

  it('失败时原样给出统一入口的可读原因，不出现内部标记', async () => {
    vi.mocked(analyzeVideoSource).mockResolvedValue({
      success: false,
      error: '没有能看视频的模型。'
    })

    const result = await analyzeHandler()(
      { sender: fakeSender() },
      {
        url: 'https://www.bilibili.com/video/BV1bbbb'
      }
    )

    expect(result).toEqual({ success: false, error: '没有能看视频的模型。' })
    expect(result.error).not.toContain('__USE_JINA__')
  })

  it('模型没写出内容时，失败原因里带上是谁看的', async () => {
    vi.mocked(analyzeVideoSource).mockResolvedValue({ success: true, model: '阿里云百炼:qwen-vl' })

    await expect(
      analyzeHandler()({ sender: fakeSender() }, { url: 'https://www.bilibili.com/video/BV1cccc' })
    ).resolves.toEqual({ success: false, error: '阿里云百炼:qwen-vl 没有写出视频内容' })
  })

  it('连模型都不知道是谁时退回通用失败原因', async () => {
    vi.mocked(analyzeVideoSource).mockResolvedValue({ success: true })

    await expect(
      analyzeHandler()({ sender: fakeSender() }, { url: 'https://www.bilibili.com/video/BV1ffff' })
    ).resolves.toEqual({ success: false, error: '视频分析失败' })
  })

  it('非 B 站地址直接拒绝，不触发下载与分析', async () => {
    await expect(
      analyzeHandler()({ sender: fakeSender() }, { url: 'https://example.com/video/BV1dddd' })
    ).resolves.toEqual({ success: false, error: '请提供有效的 Bilibili 视频 URL' })

    expect(analyzeVideoSource).not.toHaveBeenCalled()
  })
})
