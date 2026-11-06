import { net } from 'electron'
import { resolveProviderApiKey } from '../../ai/providerKey'

/**
 * YouTube 解析的本地实现（BYOK）。
 *
 * 服务端那条路做的事只有一件：拿平台 Key 转发给 Gemini，再加上计费。
 * 用户自己配了 Key，就没有理由再绕一圈。
 *
 * **只有 YouTube 需要单独一份**，因为 youtube.com 的链接只有 Gemini 能直接吃
 * （`fileData.fileUri`）。
 *
 * 其余远端视频一律由 `videoAnalysis/videoSourceAnalysis.ts` 下到本地再发，
 * 别把直链交给 `analyzeUrl`：B 站 CDN 靠 Referer 挡站外访问，模型厂商那边
 * 发不出这个头，拿到的一律是 403；Gemini 的 `fileData.fileUri` 也只收
 * Files API 的 URI 和 YouTube 链接，别的 https 地址会被 400 顶回来。
 */

/** 内置目录里的 provider id */
const GOOGLE_PROVIDER_ID = 'google'

/** Gemini 里能吃 YouTube 链接的模型 */
const YOUTUBE_MODEL = 'gemini-2.5-flash'

export interface LocalVideoAnalysisResult {
  success: boolean
  content?: string
  title?: string
  error?: string
}

/** 没配 Key 时给的提示。写明去哪配、配哪家，别只说「不可用」 */
export const YOUTUBE_KEY_HINT =
  'YouTube 解析需要 Google Gemini 的 API Key（只有 Gemini 能直接读 YouTube 链接）。' +
  '到 https://aistudio.google.com/apikey 申请，在 设置 → 模型 里填进 Google 这个服务商。'

/**
 * 默认提示词。
 *
 * 要 Markdown 且要一个 `# 标题` —— 下面 `extractTitle` 靠它给来源取名，
 * 知识库列表里显示的就是这个。不要求的话模型多半直接给一段散文，列表里就只剩
 * 「YouTube 视频」这种占位名。
 */
const DEFAULT_PROMPT =
  '请用中文总结这个视频的内容，输出 Markdown。第一行用 `# ` 给出视频标题，' +
  '之后按主题分段，保留关键数据与结论。'

/** 从 Markdown 正文里捞一个标题，捞不到就用兜底名 */
function extractTitle(content: string, fallback: string): string {
  const match = content.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : fallback
}

export async function analyzeYouTubeLocally(
  url: string,
  prompt?: string
): Promise<LocalVideoAnalysisResult | null> {
  const apiKey = await resolveProviderApiKey(GOOGLE_PROVIDER_ID, 'GEMINI_API_KEY')
  if (!apiKey) return null

  const body = JSON.stringify({
    contents: [{ parts: [{ text: prompt || DEFAULT_PROMPT }, { fileData: { fileUri: url } }] }],
    generationConfig: { temperature: 0.7, maxOutputTokens: 8192 }
  })

  return new Promise((resolve) => {
    const request = net.request({
      method: 'POST',
      url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(
        YOUTUBE_MODEL
      )}:generateContent`
    })
    request.setHeader('Content-Type', 'application/json')
    // Key 走 header 而不是 query：query 会进 access log、崩溃报告和进程列表
    request.setHeader('x-goog-api-key', apiKey)

    let raw = ''
    request.on('response', (response) => {
      response.on('data', (chunk) => {
        raw += chunk.toString()
      })
      response.on('end', () => {
        try {
          const data = JSON.parse(raw)
          const parts = data?.candidates?.[0]?.content?.parts || []
          const content = parts
            .filter((part: { text?: string }) => part.text)
            .map((part: { text: string }) => part.text)
            .join('')
          if (!content) {
            resolve({
              success: false,
              error: data?.error?.message || '分析结果为空，视频可能无法访问或内容受限'
            })
            return
          }
          resolve({ success: true, content, title: extractTitle(content, 'YouTube 视频') })
        } catch {
          resolve({ success: false, error: 'Gemini 响应解析失败' })
        }
      })
      response.on('error', (error: Error) => {
        resolve({ success: false, error: `网络错误：${error.message}` })
      })
    })
    request.on('error', (error) => {
      resolve({ success: false, error: `请求失败：${error.message}` })
    })

    request.write(body)
    request.end()
  })
}
