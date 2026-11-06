/**
 * 视频 URL 分析服务
 * 使用 qwen3-vl-flash 模型分析视频 URL 内容
 *
 * 支持直接分析 HTTP/HTTPS 视频 URL，无需先下载视频
 * 参考文档: https://help.aliyun.com/zh/model-studio/developer-reference/qwen-vl-api
 */

import https from 'https'
import http from 'http'
import { URL } from 'url'
import { resolveProviderApiKey } from '../../ai/providerKey'
import { BAILIAN_KEY_MISSING_ERROR } from './imageAnalyzer'

/** 内置目录里阿里云百炼的 provider id */
const ALIBABA_PROVIDER_ID = 'alibaba'

/**
 * 视频分析结果接口
 */
export interface VideoAnalysisResult {
  success: boolean
  title?: string
  content?: string
  description?: string
  url?: string
  error?: string
}

/**
 * OpenAI 兼容格式消息内容类型
 */
interface MessageContent {
  type: 'text' | 'video_url'
  text?: string
  video_url?: {
    url: string
  }
}

/**
 * OpenAI 兼容格式消息类型
 */
interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | MessageContent[]
}

/**
 * API 响应类型
 */
interface ChatCompletionResponse {
  id: string
  object: string
  created: number
  model: string
  choices: Array<{
    index: number
    message: {
      role: string
      content: string
    }
    finish_reason: string
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
    total_tokens: number
  }
}

/**
 * 默认视觉模型
 */
const DEFAULT_VL_MODEL = 'qwen3-vl-flash'

/**
 * 默认视频分析提示词
 */
const DEFAULT_VIDEO_PROMPT = `你是一个视频内容分析助手。请分析这个视频并提供以下信息：

1. **视频主题**：用一句话概括视频的主要内容
2. **内容摘要**：详细描述视频中展示的内容（200-500字）
3. **关键时刻**：列出视频中的重要时间点和对应内容
4. **关键词**：提取5-10个关键词用于检索

请使用结构清晰易读的格式输出。`

/**
 * 从 URL 提取标题
 * @param url - 视频 URL
 * @returns 提取的标题
 */
function extractTitleFromUrl(url: string): string {
  try {
    const urlObj = new URL(url)
    // 尝试从路径中提取文件名
    const pathname = urlObj.pathname
    const filename = pathname.split('/').pop() || ''
    if (filename) {
      // 移除扩展名
      return filename.replace(/\.[^.]+$/, '') || urlObj.hostname
    }
    return urlObj.hostname
  } catch {
    return 'Untitled Video'
  }
}

/**
 * 从 Markdown 内容中提取标题和描述
 * @param markdown - Markdown 格式的内容
 * @returns 标题和描述
 */
function extractTitleAndDescription(markdown: string): { title: string; description: string } {
  // 尝试从 **视频主题** 或 # 标题中提取
  const topicMatch = markdown.match(/\*\*视频主题\*\*[：:]\s*(.+?)(?:\n|$)/i)
  const h1Match = markdown.match(/^#\s+(.+)$/m)

  let title = ''
  if (topicMatch) {
    title = topicMatch[1].trim()
  } else if (h1Match) {
    title = h1Match[1].trim()
  }

  // 尝试提取描述（取前200个字符）
  const cleanContent = markdown
    .replace(/^#+\s+.+$/gm, '') // 移除标题
    .replace(/\*\*[^*]+\*\*/g, '') // 移除粗体标记
    .trim()

  const description = cleanContent.slice(0, 200).trim()

  return { title, description }
}

/**
 * 分析视频 URL 内容
 *
 * @param videoUrl - 视频的 HTTP/HTTPS URL
 * @param options - 可选配置
 * @returns 分析结果
 */
export async function analyzeVideoUrl(
  videoUrl: string,
  options?: {
    apiKey?: string
    modelName?: string
    prompt?: string
  }
): Promise<VideoAnalysisResult> {
  /*
    Key 正常由 `urlAnalyzer` 解析好传进来。这里的兜底读的是用户在 设置 → 模型 里
    配的百炼服务商（开发环境再兜底到 `DASHSCOPE_API_KEY`，名字跟着 `.env.example`）——
    原先兜底读的是 `process.env.QWEN_API_KEY`：打包版里 `.env` 不进 asar，那个变量
    不存在，于是只会得到一句「请在 .env 文件中设置」，而用户手上没有 .env 可改。
  */
  const apiKey =
    options?.apiKey || (await resolveProviderApiKey(ALIBABA_PROVIDER_ID, 'DASHSCOPE_API_KEY'))
  const modelName = options?.modelName || DEFAULT_VL_MODEL
  const prompt = options?.prompt || DEFAULT_VIDEO_PROMPT

  if (!apiKey) {
    return {
      success: false,
      error: BAILIAN_KEY_MISSING_ERROR
    }
  }

  // 验证 URL 格式
  try {
    const url = new URL(videoUrl)
    if (!['http:', 'https:'].includes(url.protocol)) {
      return {
        success: false,
        error: '视频 URL 必须是 HTTP 或 HTTPS 协议'
      }
    }
  } catch {
    return {
      success: false,
      error: '无效的视频 URL 格式'
    }
  }

  console.log(`[VideoAnalyzer] 开始分析视频: ${videoUrl}`)
  console.log(`[VideoAnalyzer] 使用模型: ${modelName}`)

  // 构建请求消息
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'video_url',
          video_url: { url: videoUrl }
        },
        {
          type: 'text',
          text: prompt
        }
      ]
    }
  ]

  // 调用 Qwen API
  return new Promise((resolve) => {
    const baseUrl = process.env.QWEN_BASE_URL
      ? `${process.env.QWEN_BASE_URL.replace(/\/$/, '')}/chat/completions`
      : 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
    const parsedUrl = new URL(baseUrl)

    const requestBody = JSON.stringify({
      model: modelName,
      messages: messages
    })

    const requestOptions: https.RequestOptions = {
      hostname: parsedUrl.hostname,
      port: parsedUrl.port || 443,
      path: parsedUrl.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Content-Length': Buffer.byteLength(requestBody)
      },
      timeout: 300000 // 5 分钟超时，视频分析需要较长时间
    }

    const httpModule = parsedUrl.protocol === 'https:' ? https : http
    let responseData = ''

    const request = httpModule.request(requestOptions, (response) => {
      response.on('data', (chunk: Buffer) => {
        responseData += chunk.toString()
      })

      response.on('end', () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          try {
            const jsonResponse: ChatCompletionResponse = JSON.parse(responseData)
            const content = jsonResponse.choices?.[0]?.message?.content || ''

            if (!content) {
              resolve({
                success: false,
                error: '模型返回了空内容'
              })
              return
            }

            const { title, description } = extractTitleAndDescription(content)

            console.log(`[VideoAnalyzer] 分析成功，内容长度: ${content.length}`)

            resolve({
              success: true,
              title: title || extractTitleFromUrl(videoUrl),
              content: content,
              description: description,
              url: videoUrl
            })
          } catch (parseError) {
            console.error('[VideoAnalyzer] JSON 解析失败:', parseError)
            resolve({
              success: false,
              error: `响应解析失败: ${responseData.slice(0, 200)}`
            })
          }
        } else {
          console.error(
            `[VideoAnalyzer] API 返回错误: ${response.statusCode} - ${responseData.slice(0, 500)}`
          )
          resolve({
            success: false,
            error: `API 请求失败: HTTP ${response.statusCode} - ${response.statusMessage}`
          })
        }
      })

      response.on('error', (err: Error) => {
        console.error('[VideoAnalyzer] 响应错误:', err)
        resolve({
          success: false,
          error: `网络响应错误: ${err.message}`
        })
      })
    })

    request.on('error', (err: Error) => {
      console.error('[VideoAnalyzer] 请求错误:', err)
      resolve({
        success: false,
        error: `网络请求失败: ${err.message}`
      })
    })

    request.on('timeout', () => {
      request.destroy()
      console.error('[VideoAnalyzer] 请求超时')
      resolve({
        success: false,
        error: '视频分析请求超时（5分钟）'
      })
    })

    request.write(requestBody)
    request.end()
  })
}

/**
 * 检查 URL 是否为视频链接
 * @param url - 要检查的 URL
 * @returns 是否为视频 URL
 */
export function isVideoUrl(url: string): boolean {
  const videoExtensions = ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.3gp']

  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname.toLowerCase()
    return videoExtensions.some((ext) => pathname.endsWith(ext))
  } catch {
    return false
  }
}

export default {
  analyzeVideoUrl,
  isVideoUrl
}
