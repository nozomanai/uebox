import { describe, expect, it } from 'vitest'
import { isBilibiliVideoUrl } from './bilibiliUrl'

describe('isBilibiliVideoUrl', () => {
  it('认 BV 号和 av 号的视频页，带不带参数、哪个域名都认', () => {
    expect(isBilibiliVideoUrl('https://www.bilibili.com/video/BV1rnBKB2EME')).toBe(true)
    expect(isBilibiliVideoUrl('https://www.bilibili.com/video/BV1rnBKB2EME/?p=18')).toBe(true)
    expect(isBilibiliVideoUrl('https://bilibili.com/video/av170001')).toBe(true)
    expect(isBilibiliVideoUrl('https://m.bilibili.com/video/BV1rnBKB2EME')).toBe(true)
    expect(isBilibiliVideoUrl('http://WWW.BiliBili.com/video/BV1rnBKB2EME')).toBe(true)
  })

  it('同域名下的非视频页不算，留给网页阅读', () => {
    expect(isBilibiliVideoUrl('https://www.bilibili.com/read/cv12345')).toBe(false)
    expect(isBilibiliVideoUrl('https://www.bilibili.com/bangumi/play/ep123')).toBe(false)
    expect(isBilibiliVideoUrl('https://www.bilibili.com/opus/123456')).toBe(false)
    expect(isBilibiliVideoUrl('https://space.bilibili.com/123')).toBe(false)
    expect(isBilibiliVideoUrl('https://b23.tv/abc')).toBe(false)
  })

  /**
   * 渲染层原先的正则带 `i`，主进程的不带。这三种拼法正好落在缝里：
   * 渲染层判成 bilibili → 主进程说「请提供有效的 Bilibili 视频 URL」→
   * 用户既分析不了、也没法把它当网页读。两边同用这一份之后它们一律是网页。
   */
  it('大小写拼错的前缀不算视频页 —— 这是两边判定漂开时的那条死路', () => {
    expect(isBilibiliVideoUrl('https://www.bilibili.com/video/bv1rnBKB2EME')).toBe(false)
    expect(isBilibiliVideoUrl('https://www.bilibili.com/video/AV170001')).toBe(false)
    expect(isBilibiliVideoUrl('https://www.bilibili.com/video/Av170001')).toBe(false)
  })

  it('av 号后面必须是数字，BV 号后面必须有东西', () => {
    expect(isBilibiliVideoUrl('https://www.bilibili.com/video/avxxxx')).toBe(false)
    expect(isBilibiliVideoUrl('https://www.bilibili.com/video/BV')).toBe(false)
    expect(isBilibiliVideoUrl('https://www.bilibili.com/video/')).toBe(false)
  })

  it('不是 http(s) 的、不成形的、空的都不算', () => {
    expect(isBilibiliVideoUrl('ftp://www.bilibili.com/video/BV1rnBKB2EME')).toBe(false)
    expect(isBilibiliVideoUrl('www.bilibili.com/video/BV1rnBKB2EME')).toBe(false)
    expect(isBilibiliVideoUrl('')).toBe(false)
    expect(isBilibiliVideoUrl(undefined as unknown as string)).toBe(false)
  })
})
