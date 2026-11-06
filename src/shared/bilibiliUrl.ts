/**
 * 「这条链接是不是 B 站视频页」的唯一判定。
 *
 * 渲染层（`NotebookDetail` 决定一条来源算 bilibili 还是普通网页）和主进程
 * （`videoAnalysis/bilibiliVideoSource` 决定要不要去解析播放直链）必须给出同一个答案。
 * 两边各写一份的时候渲染层多带了一个 `i`：`/video/bv1xx`、`/video/AV170001`
 * 在渲染层算 bilibili、在主进程不算，于是走进视频分析再被一句「请提供有效的
 * Bilibili 视频 URL」顶回来 —— 用户连「当普通网页读一遍」这条退路都没有。
 * 判定只留这一份，改它两边一起改。
 */

/** B 站视频页的域名 */
const BILIBILI_VIDEO_HOSTS = ['bilibili.com', 'www.bilibili.com', 'm.bilibili.com']

/**
 * 视频页的路径：`/video/BVxxx` 或 `/video/av<数字>`。
 *
 * **大小写敏感是故意的。** B 站自己只认大写 `BV` 和小写 `av` 这两个前缀，
 * 别的大小写拼法在站上就是 404；判宽了只是把打不开的链接塞进视频分析。
 * 同一个域名下的专栏（`/read/cv…`）、番剧（`/bangumi/play/…`）、图文（`/opus/…`）
 * 都不是视频页，交给网页阅读。
 */
const BILIBILI_VIDEO_PATH = /^\/video\/(BV[a-zA-Z0-9]+|av\d+)/

/** 是不是一条能解析出播放地址的 B 站视频页链接 */
export function isBilibiliVideoUrl(url: string): boolean {
  if (!url || typeof url !== 'string') return false

  try {
    const urlObj = new URL(url)
    if (!['http:', 'https:'].includes(urlObj.protocol)) return false
    if (!BILIBILI_VIDEO_HOSTS.includes(urlObj.hostname.toLowerCase())) return false
    return BILIBILI_VIDEO_PATH.test(urlObj.pathname)
  } catch {
    return false
  }
}
