/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

import { claimCampaign, fetchCampaign, submitCampaignEntry } from './campaign'

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('Box Plan 活动', () => {
  it('状态：带 Key 请求，字段转成驼峰', async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, {
        open: true,
        claimed: true,
        plan_title: 'MegaJam 参赛试用',
        claim_until: null,
        expires_at: '2026-11-19T05:00:00Z',
        submit_open: true,
        submit_until: '2026-11-17T15:59:59Z',
        entry_url: 'https://neon.itch.io/star-fort'
      })
    )
    const result = await fetchCampaign('https://token.example/v1', 'sk-k', fetchImpl)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://token.example/v1/campaigns/megajam',
      expect.objectContaining({ headers: { authorization: 'Bearer sk-k' } })
    )
    expect(result).toEqual({
      ok: true,
      data: {
        open: true,
        claimed: true,
        planTitle: 'MegaJam 参赛试用',
        claimUntil: null,
        expiresAt: '2026-11-19T05:00:00Z',
        submitOpen: true,
        submitUntil: '2026-11-17T15:59:59Z',
        entryUrl: 'https://neon.itch.io/star-fort'
      }
    })
  })

  it('服务端没有这个接口（404）：当作没有活动', async () => {
    const result = await fetchCampaign(
      'https://t/v1',
      'k',
      vi.fn(async () => json(404, {}))
    )
    expect(result).toEqual({
      ok: true,
      data: {
        open: false,
        claimed: false,
        planTitle: null,
        claimUntil: null,
        expiresAt: null,
        submitOpen: false,
        submitUntil: null,
        entryUrl: null
      }
    })
  })

  it('领取：提交去掉首尾空白的 itch 链接，成功回到期时间', async () => {
    const fetchImpl = vi.fn(async () => json(200, { expires_at: '2026-11-19T05:00:00Z' }))
    const result = await claimCampaign('https://t/v1', 'k', '  neon.itch.io ', fetchImpl)
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://t/v1/campaigns/megajam/claim')
    expect(JSON.parse(String(init.body))).toEqual({ itch_url: 'neon.itch.io' })
    expect(result).toEqual({ ok: true, data: { expiresAt: '2026-11-19T05:00:00Z' } })
  })

  it('领取失败：认得的错误码原样回，认不得的当作服务端响应异常，断网回 network', async () => {
    const codeOf = async (res: Response): Promise<string> => {
      const r = await claimCampaign(
        'https://t/v1',
        'k',
        'x.itch.io',
        vi.fn(async () => res)
      )
      return r.ok ? 'ok' : r.code
    }
    expect(await codeOf(json(409, { error: { code: 'already_claimed' } }))).toBe('already_claimed')
    expect(await codeOf(json(410, { error: { code: 'sold_out' } }))).toBe('sold_out')
    expect(await codeOf(json(422, { error: { code: 'invalid_itch_url' } }))).toBe(
      'invalid_itch_url'
    )
    expect(await codeOf(json(401, {}))).toBe('unauthorized')
    expect(await codeOf(json(500, { error: { code: 'server_error' } }))).toBe('bad_response')
    const offline = await claimCampaign(
      'https://t/v1',
      'k',
      'x.itch.io',
      vi.fn(async () => {
        throw new Error('ECONNRESET')
      })
    )
    expect(offline).toMatchObject({ ok: false, code: 'network' })
  })

  it('交卷：提交去掉首尾空白的作品页，回服务端规范化的地址；作品页错误码原样回', async () => {
    const fetchImpl = vi.fn(async () => json(200, { entry_url: 'https://neon.itch.io/star-fort' }))
    const result = await submitCampaignEntry(
      'https://t/v1',
      'k',
      ' https://Neon.itch.io/Star-Fort ',
      fetchImpl
    )
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://t/v1/campaigns/megajam/submit')
    expect(JSON.parse(String(init.body))).toEqual({ entry_url: 'https://Neon.itch.io/Star-Fort' })
    expect(result).toEqual({ ok: true, data: { entryUrl: 'https://neon.itch.io/star-fort' } })

    const failed = await submitCampaignEntry(
      'https://t/v1',
      'k',
      'neon.itch.io/draft',
      vi.fn(async () => json(422, { error: { code: 'entry_not_found' } }))
    )
    expect(failed).toMatchObject({ ok: false, code: 'entry_not_found' })
  })
})
