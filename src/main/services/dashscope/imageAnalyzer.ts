/**
 * 百炼的 URL 理解服务。
 *
 * `analyzeImageUrl` 用的是百炼「直接吃一个图片链接」的能力：图片不下载到本机，
 * 链接原样交给端点。这是厂商自己的接口形态，所以这个函数绑在百炼的 Key 上。
 *
 * **缩略图取名（`generate3DModelName`）不在这个范围里。** 那是普通的图片理解：
 * 一张图进去、一个名字出来，任何看得懂图的模型都能做。它走
 * `analyzeImageWithConfiguredModel`，用用户自己在 设置 → 模型 里绑的模型 ——
 * 绑了智谱、OpenAI 视觉模型的用户同样能用，这个文件里不替他指定厂商。
 */

import https from 'https'
import http from 'http'
import { URL } from 'url'
import { net } from 'electron'
import { resolveProviderApiKey } from '../../ai/providerKey'
import {
  analyzeImageWithConfiguredModel,
  IMAGE_BASE64_LIMIT,
  NO_VISION_MODEL_HINT
} from '../configuredImageAnalysis'
import { NO_VISION_MODEL_ERROR_KEY, type AiNamingErrorKey } from '../../../shared/aiNamingErrorKey'

/** 内置目录里阿里云百炼的 provider id */
const ALIBABA_PROVIDER_ID = 'alibaba'

/**
 * 缺 Key 时回给调用方的错误。写明去哪申请、填到哪 —— 原先这里读的是
 * `process.env.QWEN_API_KEY`，打包版里 `.env` 不进 asar，用户在设置里填了 Key
 * 也取不到，AIGC 文件夹永远拿不到中文名。
 *
 * 同一条提示 `urlAnalyzer` 也要用（它那边导出名叫 `VISION_KEY_HINT`），
 * 正文只在这里写一份。
 */
export const BAILIAN_KEY_MISSING_ERROR =
  '未配置百炼 API Key。到 https://bailian.console.aliyun.com 申请，' +
  '在 设置 → 模型 里填进「阿里云百炼（通义千问）」这个服务商。'

/**
 * 取百炼 Key：调用方显式传入的优先，否则读用户在设置里配的服务商。
 * `DASHSCOPE_API_KEY` 只在开发环境兜底（见 `resolveProviderApiKey`）——
 * 名字必须和 `.env.example` 对得上，不然照文档配环境的开发者取不到。
 */
async function resolveBailianApiKey(explicitKey?: string): Promise<string | undefined> {
  if (explicitKey) return explicitKey
  return resolveProviderApiKey(ALIBABA_PROVIDER_ID, 'DASHSCOPE_API_KEY')
}

/** 模型回的名字直接当文件名用，先把引号、换行和非法字符清掉 */
function sanitizeGeneratedName(raw: string): string {
  let name = raw
    .replace(/["""'']/g, '')
    .replace(/\n/g, '')
    .trim()
  if (name.length > 20) name = name.substring(0, 20)
  return name.replace(/[\\/:*?"<>|]/g, '_')
}

/**
 * 图片分析结果接口
 */
export interface ImageAnalysisResult {
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
  type: 'text' | 'image_url'
  text?: string
  image_url?: {
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
 * 默认图片分析提示词
 */
const DEFAULT_IMAGE_PROMPT = `你是一个图片内容分析助手。请分析这张图片并提供以下信息：

1. **图片主题**：用一句话概括图片的主要内容
2. **内容描述**：详细描述图片中展示的内容（100-300字）
3. **关键元素**：列出图片中的重要元素（人物、物体、场景等）
4. **关键词**：提取5-10个关键词用于检索

请使用 Markdown 格式输出，结构清晰易读。`

/**
 * 从 URL 提取标题
 * @param url - 图片 URL
 * @returns 提取的标题
 */
function extractTitleFromUrl(url: string): string {
  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname
    const filename = pathname.split('/').pop() || ''
    if (filename) {
      return decodeURIComponent(filename).replace(/\.[^.]+$/, '') || urlObj.hostname
    }
    return urlObj.hostname
  } catch {
    return 'Untitled Image'
  }
}

/**
 * 从 Markdown 内容中提取标题和描述
 * @param markdown - Markdown 格式的内容
 * @returns 标题和描述
 */
function extractTitleAndDescription(markdown: string): { title: string; description: string } {
  const topicMatch = markdown.match(/\*\*图片主题\*\*[：:]\s*(.+?)(?:\n|$)/i)
  const h1Match = markdown.match(/^#\s+(.+)$/m)

  let title = ''
  if (topicMatch) {
    title = topicMatch[1].trim()
  } else if (h1Match) {
    title = h1Match[1].trim()
  }

  const cleanContent = markdown
    .replace(/^#+\s+.+$/gm, '')
    .replace(/\*\*[^*]+\*\*/g, '')
    .trim()

  const description = cleanContent.slice(0, 200).trim()

  return { title, description }
}

/**
 * 分析图片 URL 内容
 *
 * @param imageUrl - 图片的 HTTP/HTTPS URL
 * @param options - 可选配置
 * @returns 分析结果
 */
export async function analyzeImageUrl(
  imageUrl: string,
  options?: {
    apiKey?: string
    modelName?: string
    prompt?: string
  }
): Promise<ImageAnalysisResult> {
  const apiKey = await resolveBailianApiKey(options?.apiKey)
  const modelName = options?.modelName || DEFAULT_VL_MODEL
  const prompt = options?.prompt || DEFAULT_IMAGE_PROMPT

  if (!apiKey) {
    return {
      success: false,
      error: BAILIAN_KEY_MISSING_ERROR
    }
  }

  // 验证 URL 格式。data: 也放行 —— 百炼兼容模式的 image_url 收 Base64 Data URL，
  // 本地文件与 PDF 页面就是这样送进来的（上限 10MB，见调用方注释）。
  try {
    const url = new URL(imageUrl)
    if (!['http:', 'https:', 'data:'].includes(url.protocol)) {
      return {
        success: false,
        error: '图片 URL 必须是 HTTP / HTTPS 或 Base64 Data URL'
      }
    }
  } catch {
    return {
      success: false,
      error: '无效的图片 URL 格式'
    }
  }

  console.log(`[ImageAnalyzer] 开始分析图片: ${imageUrl}`)
  console.log(`[ImageAnalyzer] 使用模型: ${modelName}`)

  // 构建请求消息
  const messages: ChatMessage[] = [
    {
      role: 'user',
      content: [
        {
          type: 'image_url',
          image_url: { url: imageUrl }
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
      timeout: 120000 // 2 分钟超时
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

            console.log(`[ImageAnalyzer] 分析成功，内容长度: ${content.length}`)

            resolve({
              success: true,
              title: title || extractTitleFromUrl(imageUrl),
              content: content,
              description: description,
              url: imageUrl
            })
          } catch (parseError) {
            console.error('[ImageAnalyzer] JSON 解析失败:', parseError)
            resolve({
              success: false,
              error: `响应解析失败: ${responseData.slice(0, 200)}`
            })
          }
        } else {
          console.error(
            `[ImageAnalyzer] API 返回错误: ${response.statusCode} - ${responseData.slice(0, 500)}`
          )
          resolve({
            success: false,
            error: `API 请求失败: HTTP ${response.statusCode} - ${response.statusMessage}`
          })
        }
      })

      response.on('error', (err: Error) => {
        console.error('[ImageAnalyzer] 响应错误:', err)
        resolve({
          success: false,
          error: `网络响应错误: ${err.message}`
        })
      })
    })

    request.on('error', (err: Error) => {
      console.error('[ImageAnalyzer] 请求错误:', err)
      resolve({
        success: false,
        error: `网络请求失败: ${err.message}`
      })
    })

    request.on('timeout', () => {
      request.destroy()
      console.error('[ImageAnalyzer] 请求超时')
      resolve({
        success: false,
        error: '图片分析请求超时（2分钟）'
      })
    })

    request.write(requestBody)
    request.end()
  })
}

/**
 * 检查 URL 是否为图片链接
 * @param url - 要检查的 URL
 * @returns 是否为图片 URL
 */
export function isImageUrl(url: string): boolean {
  const imageExtensions = [
    '.jpg',
    '.jpeg',
    '.jpe',
    '.png',
    '.gif',
    '.bmp',
    '.webp',
    '.ico',
    '.jp2',
    '.tif',
    '.tiff',
    '.heic',
    '.heif',
    '.svg'
  ]

  try {
    const urlObj = new URL(url)
    const pathname = urlObj.pathname.toLowerCase()
    return imageExtensions.some((ext) => pathname.endsWith(ext))
  } catch {
    return false
  }
}

/** 给模型的取名要求。一次只要一个名字，别的都不要 */
const NAME_PROMPT = '为这个3D模型取一个具有辨识度的名字，3-8个字，直接输出名字不要任何其他内容'

/**
 * 缩略图下载的超时。
 *
 * 不给超时的后果不是慢，是**不结束**：链接半死（TCP 连上了、响应体一直不来）时
 * `fetch` 的 Promise 永远不 settle，于是 `generate3DModelName` 挂住 ——
 * 界面那边 `await` 不返回（既不弹提示也不回落到原名），AIGC 轮询那边这张图的
 * 落库命名步骤就停在这里。旧的 `https.request` 实现带的是 30 秒；
 * 这里只下一张缩略图，15 秒够了。
 */
const THUMBNAIL_DOWNLOAD_TIMEOUT_MS = 15000

/**
 * 把缩略图取成不带 `data:` 前缀的 base64 —— 配好的模型收的是这个形状。
 *
 * 三种入参都得吃：AIGC 轮询那条路（`imagePollingService`）给的是远端直链，
 * 渲染层给的是纯 base64，截图那条给的是 Data URL。
 */
async function readThumbnailForModel(
  imageBase64OrUrl: string
): Promise<{ imageData: string; mimeType: string }> {
  if (imageBase64OrUrl.startsWith('data:')) {
    const match = imageBase64OrUrl.match(/^data:([^;]+);base64,(.*)$/)
    if (!match) throw new Error('无效的 Data URL 格式')
    return { imageData: match[2], mimeType: match[1] }
  }

  if (/^https?:/i.test(imageBase64OrUrl)) {
    /*
      链接那支得先把字节取下来：用户配的模型收 base64，不是所有厂商都认链接。

      用 Electron 的 `net.fetch` 而不是 Node 的全局 `fetch`：这些图片正是
      `imagePollingService` 用 `net.fetch` 存下来的，取名这次下的是同一个远端直链。
      `net` 读 Chromium 那套系统代理配置（系统代理、PAC、绕过列表），Node 的
      `fetch` 不读 —— 两边不一致时，挂代理的用户会碰到「图能存下来、取名那次
      下载失败」。
    */
    const response = await net.fetch(imageBase64OrUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(THUMBNAIL_DOWNLOAD_TIMEOUT_MS)
    })
    if (!response.ok) throw new Error(`缩略图下载失败: HTTP ${response.status}`)
    const buffer = Buffer.from(await response.arrayBuffer())
    const mimeType = (response.headers.get('content-type') || 'image/png').split(';')[0].trim()
    return { imageData: buffer.toString('base64'), mimeType }
  }

  return { imageData: imageBase64OrUrl, mimeType: 'image/png' }
}

/**
 * 看着缩略图给 3D 模型取个名字。
 *
 * 用的是**用户自己绑的**图片理解模型，不点名任何厂商：主模型看得懂图就用主模型，
 * 看不懂才轮到他绑的「视觉」角色。原先这里绑死在百炼的 Key 上 ——
 * 用户在设置里绑好了智谱或 OpenAI 的视觉模型，只要没顺手申请百炼，命名一律失败。
 *
 * @param imageBase64OrUrl - 缩略图的 Base64、Data URL 或 HTTP 直链
 * @returns 成功时给名字；没绑模型时 `errorKey` 为 {@link NO_VISION_MODEL_ERROR_KEY}
 */
export async function generate3DModelName(
  imageBase64OrUrl: string
): Promise<{ success: boolean; name?: string; error?: string; errorKey?: AiNamingErrorKey }> {
  let image: { imageData: string; mimeType: string }
  try {
    image = await readThumbnailForModel(imageBase64OrUrl)
  } catch (error) {
    // 下载超时（{@link THUMBNAIL_DOWNLOAD_TIMEOUT_MS} 到点 abort）也落在这里，
    // 和下载 404、Data URL 解不开一样**不带** errorKey：用户的模型配置没毛病，
    // 把他送去一个已经填好的设置页等于冤枉他
    return { success: false, error: error instanceof Error ? error.message : String(error) }
  }

  if (!image.imageData) return { success: false, error: '缩略图数据为空' }
  if (image.imageData.length > IMAGE_BASE64_LIMIT) {
    return { success: false, error: '缩略图过大，模型收不下' }
  }

  const analyzed = await analyzeImageWithConfiguredModel({
    imageData: image.imageData,
    mimeType: image.mimeType,
    prompt: NAME_PROMPT
  })

  /*
    过大已经在上面拦掉了，所以 null 只剩一种可能：一个看得懂图的模型都没绑。
    这一种才带 errorKey，界面据此弹「去绑一个」。

    密钥解不开（safeStorage 换了机器、取密命令失败）、余额不够、网络断了
    都走下面的 error 分支、不带 errorKey —— 用户明明绑了模型，不能反过来
    说他「没配置」然后把他送去一个已经填好的页面。
  */
  if (!analyzed) {
    return { success: false, error: NO_VISION_MODEL_HINT, errorKey: NO_VISION_MODEL_ERROR_KEY }
  }
  if (!analyzed.success) return { success: false, error: analyzed.error }

  const name = sanitizeGeneratedName(analyzed.description || analyzed.markdown || '')
  if (!name) return { success: false, error: '模型返回空名称' }

  console.log(`[ImageAnalyzer] 3D模型命名成功: ${name}`)
  return { success: true, name }
}

/**
 * 使用LLM从Prompt生成语义化名称（用于文生模型）
 *
 * @param prompt - 用户输入的生成Prompt
 * @param options - 可选配置
 * @returns 生成的名称（3-8字）
 */
export async function generateNameFromPrompt(
  prompt: string,
  options?: {
    apiKey?: string
    modelName?: string
  }
): Promise<{ success: boolean; name?: string; error?: string }> {
  const apiKey = await resolveBailianApiKey(options?.apiKey)
  // 使用轻量快速的 qwen-flash 模型
  const modelName = options?.modelName || 'qwen-flash'

  if (!apiKey) {
    return {
      success: false,
      error: BAILIAN_KEY_MISSING_ERROR
    }
  }

  if (!prompt || prompt.trim().length === 0) {
    return {
      success: false,
      error: 'Prompt不能为空'
    }
  }

  console.log(`[ImageAnalyzer] 使用LLM从Prompt生成名称，模型: ${modelName}`)

  // 构建请求
  const messages = [
    {
      role: 'user',
      content: `请从以下3D模型生成描述中提取一个简洁的名称，3-8个中文字，直接输出名称不要任何其他内容：

${prompt}`
    }
  ]

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
      timeout: 15000 // 15秒超时（文本处理较快）
    }

    let responseData = ''

    const request = https.request(requestOptions, (response) => {
      response.on('data', (chunk: Buffer) => {
        responseData += chunk.toString()
      })

      response.on('end', () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) {
          try {
            const jsonResponse: ChatCompletionResponse = JSON.parse(responseData)
            const name = sanitizeGeneratedName(jsonResponse.choices?.[0]?.message?.content || '')

            if (!name) {
              resolve({ success: false, error: '模型返回空名称' })
              return
            }

            console.log(`[ImageAnalyzer] Prompt命名成功: ${name}`)
            resolve({ success: true, name })
          } catch (parseError) {
            console.error('[ImageAnalyzer] JSON 解析失败:', parseError)
            resolve({ success: false, error: '响应解析失败' })
          }
        } else {
          console.error(
            `[ImageAnalyzer] API 错误: ${response.statusCode} - ${responseData.slice(0, 200)}`
          )
          resolve({ success: false, error: `API 请求失败: HTTP ${response.statusCode}` })
        }
      })

      response.on('error', (err: Error) => {
        resolve({ success: false, error: `网络错误: ${err.message}` })
      })
    })

    request.on('error', (err: Error) => {
      resolve({ success: false, error: `请求失败: ${err.message}` })
    })

    request.on('timeout', () => {
      request.destroy()
      resolve({ success: false, error: '请求超时' })
    })

    request.write(requestBody)
    request.end()
  })
}

export default {
  analyzeImageUrl,
  isImageUrl,
  generate3DModelName,
  generateNameFromPrompt
}
