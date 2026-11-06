import { isBilibiliVideoUrl } from '../../../shared/bilibiliUrl'

export interface BilibiliVideoUrlResult {
  success: boolean
  data: string
  error?: string
}

const MOBILE_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/70.0.3538.25 Mobile Safari/537.36'

/**
 * 取直链内容时必须带的头。
 *
 * B 站 CDN 用 Referer 挡站外播放，少了这一条一律 403 —— 所以这些直链**不能**
 * 甩给模型厂商去 fetch，它们发不出这个头。只有本进程下下来再发才走得通。
 */
export const BILIBILI_PLAYBACK_HEADERS: Record<string, string> = {
  'User-Agent': MOBILE_USER_AGENT,
  Referer: 'https://www.bilibili.com/',
  Origin: 'https://www.bilibili.com'
}

/**
 * 从 HTML 页面提取 playUrlInfo 中的真实视频地址
 */
export async function extractRealVideoUrl(url: string): Promise<string | null> {
  try {
    const headers = {
      'User-Agent': MOBILE_USER_AGENT,
      Accept:
        'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Cache-Control': 'max-age=0',
      'Upgrade-Insecure-Requests': '1'
    }

    console.log('[BilibiliIPC] 正在获取视频页面 HTML...')
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
    if (res.ok === false) return null
    const html = await res.text()

    // 使用正则提取 playUrlInfo
    const pattern = /"playUrlInfo"\s*:\s*\[\s*\{.*?\}\s*\]/s
    const match = html.match(pattern)

    if (match) {
      const jsonStr = '{' + match[0] + '}'
      // 处理 unicode 转义
      const corrected = jsonStr.replace(/\\u002F/g, '/')
      const data = JSON.parse(corrected)
      let realUrl = data.playUrlInfo?.[0]?.url
      if (realUrl) {
        // 解码 HTML 实体：&amp; -> &, &lt; -> <, &gt; -> >, 等
        realUrl = realUrl
          .replace(/&amp;/g, '&')
          .replace(/&lt;/g, '<')
          .replace(/&gt;/g, '>')
          .replace(/&quot;/g, '"')
        if (!/^https?:\/\//i.test(realUrl)) return null
        return realUrl
      }
    }
    console.log('[BilibiliIPC] 未找到 playUrlInfo')
    return null
  } catch (error) {
    console.error('[BilibiliIPC] 提取视频地址失败:', error)
    return null
  }
}

/** 只解析 B 站页面对应的临时播放直链，不触发模型分析。 */
export async function resolveBilibiliVideoUrl(url: string): Promise<BilibiliVideoUrlResult> {
  if (!isValidBilibiliUrl(url)) {
    return { success: false, data: '', error: '请提供有效的 Bilibili 视频 URL' }
  }

  const realUrl = await extractRealVideoUrl(url)
  return realUrl
    ? { success: true, data: realUrl }
    : { success: false, data: '', error: '无法获取视频真实地址，可能视频不存在或受限' }
}

/**
 * 验证 Bilibili URL 格式。
 *
 * 判定本身在 `shared/bilibiliUrl.ts`，渲染层用的是同一份：这里放宽或收紧一侧，
 * 另一侧就会出现「渲染层当视频、主进程不认」的那条死路。
 */
export function isValidBilibiliUrl(url: string): boolean {
  return isBilibiliVideoUrl(url)
}
