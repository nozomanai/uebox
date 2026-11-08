/**
 * 录一个桌面窗口成 webm —— 给「录一段玩法视频」用。
 *
 * ## 为什么用 Chromium 录，不用 FFmpeg
 *
 * FFmpeg 不随包分发（见 `ffmpegPath.ts`），没装的用户什么都录不了；而 Electron 自带
 * 窗口采集（Windows 上走 Windows Graphics Capture，DirectX 游戏窗口、被挡住的窗口都录得到）
 * 和 MediaRecorder。所以录制本身不依赖任何外部程序，装了 FFmpeg 只是多一步转成 MP4。
 *
 * ## 隐藏窗口 + 隔离会话
 *
 * 录制跑在一个不显示的 BrowserWindow 里，会话单独开一个分区，只放行 `media` 权限，
 * 页面是本机临时目录里的一个空 HTML（`navigator.mediaDevices` 只在安全上下文里有，
 * `about:blank` / `data:` 不算）。录完整个窗口和会话一起丢掉。
 */

import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'

export interface WindowSource {
  id: string
  name: string
}

/** 当前所有顶层窗口。录制前后各取一次，就能认出刚启动的游戏窗口 */
export async function listWindowSources(): Promise<WindowSource[]> {
  const { desktopCapturer } = await import('electron')
  const sources = await desktopCapturer.getSources({
    types: ['window'],
    thumbnailSize: { width: 0, height: 0 },
    fetchWindowIcons: false
  })
  return sources.map((source) => ({ id: source.id, name: source.name }))
}

/**
 * 页面里跑的录制脚本。返回 data URL（base64）—— executeJavaScript 只能带回可序列化的值。
 * `window.__ueboxStop()` 让它提前收尾。
 */
export function recorderScript(sourceId: string, seconds: number, fps: number): string {
  return `(async () => {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: { mandatory: {
      chromeMediaSource: 'desktop',
      chromeMediaSourceId: ${JSON.stringify(sourceId)},
      maxWidth: 1920, maxHeight: 1080, maxFrameRate: ${fps}
    } }
  })
  const type = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm'
  const recorder = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 8000000 })
  const chunks = []
  recorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data) }
  const done = new Promise((resolve) => { recorder.onstop = resolve })
  recorder.start(1000)
  const timer = setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), ${Math.round(seconds * 1000)})
  window.__ueboxStop = () => { clearTimeout(timer); if (recorder.state !== 'inactive') recorder.stop() }
  // 被录的窗口关掉了：轨道结束，录到哪算哪
  stream.getVideoTracks()[0].onended = () => window.__ueboxStop()
  await done
  stream.getTracks().forEach((t) => t.stop())
  const blob = new Blob(chunks, { type: 'video/webm' })
  return await new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result)
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
})()`
}

export interface RecordOptions {
  sourceId: string
  seconds: number
  output: string
  fps?: number
  signal?: AbortSignal
}

/** 录 `seconds` 秒写到 `output`（.webm）。返回实际字节数 */
export async function recordWindow(options: RecordOptions): Promise<number> {
  const { BrowserWindow, session } = await import('electron')
  const partition = `window-recorder-${randomUUID()}`
  const isolated = session.fromPartition(partition, { cache: false })
  isolated.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(permission === 'media')
  )
  isolated.setPermissionCheckHandler((_wc, permission) => permission === 'media')
  isolated.webRequest.onBeforeRequest((details, callback) =>
    callback({ cancel: !/^(file:|blob:|data:)/.test(details.url) })
  )

  const dir = await fs.mkdtemp(join(tmpdir(), 'uebox-rec-'))
  const page = join(dir, 'index.html')
  await fs.writeFile(page, '<!doctype html><meta charset="utf-8"><title>rec</title>')

  const win = new BrowserWindow({
    show: false,
    width: 320,
    height: 240,
    webPreferences: {
      session: isolated,
      sandbox: true,
      nodeIntegration: false,
      contextIsolation: true,
      backgroundThrottling: false
    }
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const onAbort = (): void => {
    if (!win.isDestroyed())
      void win.webContents.executeJavaScript('window.__ueboxStop && window.__ueboxStop()')
  }
  try {
    await win.loadURL(pathToFileURL(page).href)
    options.signal?.addEventListener('abort', onAbort, { once: true })
    const dataUrl: unknown = await win.webContents.executeJavaScript(
      recorderScript(options.sourceId, options.seconds, options.fps ?? 30),
      true
    )
    if (typeof dataUrl !== 'string' || !dataUrl.includes(',')) throw new Error('录制没有产出数据')
    const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
    if (!bytes.length) throw new Error('录到的视频是空的：被录的窗口可能已经关了或最小化了')
    await fs.writeFile(options.output, bytes)
    return bytes.length
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    if (!win.isDestroyed()) win.destroy()
    await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}
