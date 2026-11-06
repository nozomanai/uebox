/**
 * URL 分析路由服务
 * 根据 URL 类型（网页、图片、视频、音频、文档等）选择合适的处理方式
 *
 * - 网页 URL: 使用 Jina Reader
 * - 图片 URL: 使用 qwen-vl 视觉模型
 * - 视频 URL: 使用 qwen3-vl-flash 视觉模型
 * - 音频 URL: 暂不支持，返回错误提示
 * - 文档 URL: 暂不支持远程文档，建议下载后上传
 */

import { URL } from 'url'
import { analyzeVideoUrl } from './videoAnalyzer'
import { analyzeImageUrl, BAILIAN_KEY_MISSING_ERROR } from './imageAnalyzer'
import { resolveProviderApiKey } from '../../ai/providerKey'

/** 内置目录里阿里云百炼的 provider id */
const ALIBABA_PROVIDER_ID = 'alibaba'

/**
 * URL 类型枚举
 */
export type UrlType = 'webpage' | 'image' | 'video' | 'audio' | 'document' | 'text' | 'unknown'

/**
 * 文件扩展名到类型的映射
 */
const EXTENSION_TYPE_MAP: Record<string, UrlType> = {
  // 图片类型
  jpg: 'image',
  jpeg: 'image',
  jpe: 'image',
  png: 'image',
  gif: 'image',
  bmp: 'image',
  webp: 'image',
  ico: 'image',
  jp2: 'image',
  tif: 'image',
  tiff: 'image',
  heic: 'image',
  heif: 'image',
  svg: 'image',

  // 视频类型
  mp4: 'video',
  avi: 'video',
  mov: 'video',
  wmv: 'video',
  mkv: 'video',
  webm: 'video',
  flv: 'video',
  m4v: 'video',
  '3gp': 'video',

  // 音频类型
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  flac: 'audio',
  aac: 'audio',
  m4a: 'audio',
  wma: 'audio',

  // 文档类型
  pdf: 'document',
  doc: 'document',
  docx: 'document',
  xls: 'document',
  xlsx: 'document',
  ppt: 'document',
  pptx: 'document',

  // 纯文本类型
  txt: 'text',
  md: 'text',
  markdown: 'text',
  json: 'text',
  xml: 'text',
  csv: 'text'
}

/**
 * URL 分析结果接口
 */
export interface UrlAnalysisResult {
  success: boolean
  title?: string
  content?: string
  description?: string
  url?: string
  error?: string
  /** URL 类型 */
  urlType?: UrlType
}

/**
 * 从 URL 中提取文件扩展名
 * @param url - 要分析的 URL
 * @returns 小写的扩展名（不含点），如果没有则返回空字符串
 */
export function getUrlExtension(url: string): string {
  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname

    // 移除查询参数和片段标识符后的路径
    const cleanPath = pathname.split('?')[0].split('#')[0]
    const lastDot = cleanPath.lastIndexOf('.')
    const lastSlash = cleanPath.lastIndexOf('/')

    // 确保点在最后一个斜杠之后（即在文件名中）
    if (lastDot === -1 || lastDot < lastSlash || lastDot === cleanPath.length - 1) {
      return ''
    }

    return cleanPath.slice(lastDot + 1).toLowerCase()
  } catch {
    return ''
  }
}

/**
 * 检测 URL 的类型
 * @param url - 要检测的 URL
 * @returns URL 类型
 */
export function detectUrlType(url: string): UrlType {
  const ext = getUrlExtension(url)

  if (!ext) {
    // 没有扩展名，认为是网页
    return 'webpage'
  }

  return EXTENSION_TYPE_MAP[ext] || 'webpage'
}

/**
 * 检查 URL 是否为文件类型（非网页）
 * @param url - 要检查的 URL
 * @returns 是否为文件 URL
 */
export function isFileUrl(url: string): boolean {
  const type = detectUrlType(url)
  return type !== 'webpage' && type !== 'unknown'
}

/**
 * 视觉理解缺 Key 时的提示。
 *
 * 和 `imageAnalyzer` 说的是同一件事（同一个目录、同一个条件），原先两处各写了一套
 * 措辞。正文现在只有一份，在 `imageAnalyzer.BAILIAN_KEY_MISSING_ERROR`。
 */
export const VISION_KEY_HINT = BAILIAN_KEY_MISSING_ERROR

/**
 * 分析 URL 内容（根据类型路由到不同的处理器）。
 *
 * **远端视频一律由 `videoAnalysis/videoSourceAnalysis.ts` 下到本地再发，别把直链
 * 交给 `analyzeUrl`。** B 站 CDN 靠 Referer 挡站外访问，模型厂商那边发不出这个头，
 * 拿到的一律是 403。这里只收本来就能直接给出去的地址。
 *
 * @param url - 要分析的 URL
 * @param prompt - 自定义提示词，不给就用分析器各自的默认值
 */
export async function analyzeUrl(url: string, prompt?: string): Promise<UrlAnalysisResult> {
  const urlType = detectUrlType(url)

  console.log(`[UrlAnalyzer] URL 类型检测: ${urlType} - ${url}`)

  switch (urlType) {
    case 'image':
    case 'video': {
      // 图片与视频打的是百炼同一个端点，Key 在这里解析一次往下传。
      //
      // 不让两个分析器各自去读：它们原先各读一次 `process.env.QWEN_API_KEY`，
      // 打包版里那个变量不存在，于是视觉理解永远缺 Key。开发环境的兜底变量名
      // 跟着 `.env.example` 走，是 `DASHSCOPE_API_KEY` —— `QWEN_API_KEY`
      // 本仓库任何文档里都没有。
      const apiKey = await resolveProviderApiKey(ALIBABA_PROVIDER_ID, 'DASHSCOPE_API_KEY')
      if (!apiKey) {
        return { success: false, error: VISION_KEY_HINT, url, urlType }
      }

      if (urlType === 'image') {
        console.log('[UrlAnalyzer] 使用图片分析器')
        const imageResult = await analyzeImageUrl(url, { apiKey, prompt })
        return { ...imageResult, urlType }
      }

      console.log('[UrlAnalyzer] 使用视频分析器')
      const videoResult = await analyzeVideoUrl(url, { apiKey, prompt })
      return { ...videoResult, urlType }
    }

    case 'audio':
      console.log('[UrlAnalyzer] 音频 URL 暂不支持')
      return {
        success: false,
        error: '暂不支持远程音频 URL 分析，请下载后上传音频文件',
        url,
        urlType
      }

    case 'document':
      console.log('[UrlAnalyzer] 文档 URL 暂不支持')
      return {
        success: false,
        error: '暂不支持远程文档 URL 分析，请下载后上传文档文件',
        url,
        urlType
      }

    case 'text':
      console.log('[UrlAnalyzer] 纯文本 URL 暂不支持')
      return {
        success: false,
        error: '暂不支持远程文本文件 URL，请下载后上传或复制内容',
        url,
        urlType
      }

    case 'webpage':
    default:
      // 网页类型返回 null，让调用者使用 Jina Reader
      console.log('[UrlAnalyzer] 网页类型，需使用 Jina Reader')
      return {
        success: false,
        error: '__USE_JINA__', // 特殊标记，表示应该使用 Jina Reader
        url,
        urlType
      }
  }
}

export default {
  detectUrlType,
  isFileUrl,
  getUrlExtension,
  analyzeUrl
}
