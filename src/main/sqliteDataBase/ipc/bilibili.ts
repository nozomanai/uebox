/**
 * Bilibili 视频分析 IPC 处理器
 * 用于在主进程中分析 Bilibili 视频内容
 * 供知识库添加 Bilibili 来源使用
 */
import { ipcMain } from 'electron'
import {
  isValidBilibiliUrl,
  resolveBilibiliVideoUrl
} from '../../services/videoAnalysis/bilibiliVideoSource'
export { resolveBilibiliVideoUrl } from '../../services/videoAnalysis/bilibiliVideoSource'
import { analyzeVideoSource } from '../../services/videoAnalysis/videoSourceAnalysis'

/**
 * 正在分析中的任务 Map（按 URL 去重）
 * key: 视频 URL, value: 分析任务的 Promise
 * 如果同一个 URL 正在分析中，新请求会复用已有的 Promise
 */
const pendingAnalysisTasks = new Map<string, Promise<BilibiliAnalyzeResult>>()

/**
 * 分析进度推给发起那个窗口的通道。整条链要解析链接、下载、可能压一遍、再等模型，
 * 最坏好几分钟，不报一句界面上就只有一行转圈的
 */
const ANALYZE_PROGRESS_CHANNEL = 'bilibili:analyzeProgress'

/**
 * URL 不是 B 站视频页时给的话。
 * TODO: 和 `videoAnalysis/bilibiliVideoSource.ts` 里那句是同一句，等那个文件
 * 导出常量之后两边共用，免得两处字面量各自漂移。
 */
const INVALID_URL_ERROR = '请提供有效的 Bilibili 视频 URL'

/**
 * Bilibili 分析请求参数接口
 */
interface BilibiliAnalyzeParams {
  /** Bilibili 视频 URL */
  url: string
  /** 自定义分析提示词（可选） */
  prompt?: string
}

/**
 * Bilibili 分析结果接口
 */
interface BilibiliAnalyzeResult {
  success: boolean
  /** 分析结果（Markdown 格式） */
  content?: string
  /** Bilibili 视频 ID (BV号) */
  videoId?: string
  /** 错误信息 */
  error?: string
}

/**
 * Bilibili 视频元信息接口（快速获取，无需分析）
 */
interface BilibiliVideoInfo {
  success: boolean
  /** 视频标题 */
  title?: string
  /** 封面图 URL */
  pic?: string
  /** 视频描述 */
  desc?: string
  /** UP主信息 */
  owner?: {
    name: string
    face: string
    mid: number
  }
  /** 视频时长（秒） */
  duration?: number
  /** 视频 BV 号 */
  bvid?: string
  /** 错误信息 */
  error?: string
}

/**
 * 通过 B站 API 快速获取视频元信息
 * API: https://api.bilibili.com/x/web-interface/view?bvid=BVxxx
 * @param bvid - 视频 BV 号
 */
async function fetchVideoInfo(bvid: string): Promise<BilibiliVideoInfo> {
  if (!bvid || typeof bvid !== 'string') {
    return { success: false, error: '无效的 BV 号' }
  }

  // 确保 bvid 格式正确
  const cleanBvid = bvid.startsWith('BV') ? bvid : `BV${bvid}`

  try {
    console.log('[BilibiliIPC] 正在获取视频元信息:', cleanBvid)

    const apiUrl = `https://api.bilibili.com/x/web-interface/view?bvid=${cleanBvid}`
    const headers = {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      Accept: 'application/json',
      Referer: 'https://www.bilibili.com'
    }

    const res = await fetch(apiUrl, { headers })
    const json = await res.json()

    if (json.code !== 0) {
      console.log('[BilibiliIPC] B站 API 返回错误:', json.message)
      return { success: false, error: json.message || '获取视频信息失败' }
    }

    const data = json.data
    console.log('[BilibiliIPC] 成功获取视频信息:', data.title)

    return {
      success: true,
      title: data.title,
      pic: data.pic,
      desc: data.desc,
      owner: data.owner
        ? {
            name: data.owner.name,
            face: data.owner.face,
            mid: data.owner.mid
          }
        : undefined,
      duration: data.duration,
      bvid: data.bvid
    }
  } catch (error) {
    console.error('[BilibiliIPC] 获取视频信息失败:', error)
    return {
      success: false,
      error: error instanceof Error ? error.message : '网络请求失败'
    }
  }
}

/**
 * 从 URL 提取 BV 号
 */
function extractBvid(url: string): string | null {
  const match = url.match(/BV[a-zA-Z0-9]+/)
  return match ? match[0] : null
}

/**
 * 分析 Bilibili 视频（同一个 URL 并发时复用同一次分析）
 */
async function analyzeBilibiliVideo(
  params: BilibiliAnalyzeParams,
  onProgress?: (note: string) => void
): Promise<BilibiliAnalyzeResult> {
  const { url, prompt } = params

  if (!url || typeof url !== 'string') {
    return {
      success: false,
      error: INVALID_URL_ERROR
    }
  }

  // 检查是否已有相同 URL 正在分析中，如果有则复用已有的 Promise
  const existingTask = pendingAnalysisTasks.get(url)
  if (existingTask) {
    console.log('[BilibiliIPC] 复用已有分析任务:', url)
    return existingTask
  }

  // 创建新的分析任务
  const analysisTask = doAnalyzeBilibiliVideo(url, prompt, onProgress)

  // 加入 pending map
  pendingAnalysisTasks.set(url, analysisTask)

  // 任务完成后从 map 中移除
  analysisTask.finally(() => {
    pendingAnalysisTasks.delete(url)
  })

  return analysisTask
}

/**
 * 实际执行 Bilibili 视频分析
 */
async function doAnalyzeBilibiliVideo(
  url: string,
  prompt?: string,
  onProgress?: (note: string) => void
): Promise<BilibiliAnalyzeResult> {
  console.log('[BilibiliIPC] 开始分析视频:', url)

  if (!isValidBilibiliUrl(url)) {
    return {
      success: false,
      error: INVALID_URL_ERROR
    }
  }

  // 整条链交给统一入口：它解析直链、带 Referer 下到临时文件、送模型、读完删文件。
  // 直链**不能**转手给模型厂商去 fetch —— B 站 CDN 靠 Referer 挡站外访问，
  // 厂商那边发不出这个头，拿到的一律是 403。
  const analyzed = await analyzeVideoSource({
    source: url,
    ...(prompt ? { prompt } : {}),
    ...(onProgress ? { onProgress } : {})
  })

  if (!analyzed.success || !analyzed.markdown) {
    return {
      success: false,
      // 模型答了但没写出东西时 `error` 是空的。至少说清是谁看的，
      // 否则用户连该换哪个模型都不知道
      error:
        analyzed.error || (analyzed.model ? `${analyzed.model} 没有写出视频内容` : '视频分析失败')
    }
  }

  return {
    success: true,
    videoId: extractBvid(url) || undefined,
    content: analyzed.markdown
  }
}

/**
 * 从 Bilibili URL 中提取视频 ID
 */
function extractVideoId(url: string): string | null {
  try {
    const urlObj = new URL(url)

    // 匹配 BV 号
    const bvMatch = urlObj.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/)
    if (bvMatch && bvMatch[1]) {
      return bvMatch[1]
    }

    // 匹配 av 号
    const avMatch = urlObj.pathname.match(/\/video\/(av\d+)/)
    if (avMatch && avMatch[1]) {
      return avMatch[1]
    }

    return null
  } catch {
    return null
  }
}

/**
 * 注册 Bilibili 分析 IPC 处理器
 */
export function registerBilibiliIPC(): void {
  console.log('[BilibiliIPC] 注册 Bilibili 分析 IPC 处理器')

  /**
   * 分析 Bilibili 视频
   * @param params - 分析参数（url, prompt?）
   */
  ipcMain.handle(
    'bilibili:analyze',
    async (event, params: BilibiliAnalyzeParams): Promise<BilibiliAnalyzeResult> => {
      console.log('[BilibiliIPC] 收到分析请求:', params?.url)

      if (!params || typeof params !== 'object') {
        return {
          success: false,
          error: '无效的请求参数'
        }
      }

      // 进度只推给发起这次分析的那个窗口。同一个 URL 被复用时后来的调用方收不到
      // 进度（`pendingAnalysisTasks` 复用的是第一次那条链），但结果照样等得到
      const sender = event.sender
      return await analyzeBilibiliVideo(params, (note) => {
        if (sender.isDestroyed()) return
        sender.send(ANALYZE_PROGRESS_CHANNEL, { url: params.url, note })
      })
    }
  )

  /**
   * 验证 Bilibili URL 格式
   * @param url - 待验证的 URL
   */
  ipcMain.handle('bilibili:validate', async (_event, url: string): Promise<boolean> => {
    return isValidBilibiliUrl(url)
  })

  /**
   * 提取 Bilibili 视频 ID
   * @param url - Bilibili 视频 URL
   */
  ipcMain.handle('bilibili:extractId', async (_event, url: string): Promise<string | null> => {
    return extractVideoId(url)
  })

  /** 只获取用于播放/展示的临时视频直链，不执行内容分析 */
  ipcMain.handle('bilibili:resolveVideoUrl', async (_event, url: string) => {
    return await resolveBilibiliVideoUrl(url)
  })

  /**
   * 快速获取视频元信息（标题、封面、描述等）
   * @param bvid - 视频 BV 号
   */
  ipcMain.handle('bilibili:fetchInfo', async (_event, bvid: string): Promise<BilibiliVideoInfo> => {
    console.log('[BilibiliIPC] 收到获取视频信息请求:', bvid)
    return await fetchVideoInfo(bvid)
  })
}
