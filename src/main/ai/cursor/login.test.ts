import { describe, expect, it } from 'vitest'
import { pollCursorLogin, refreshCursorTokens } from './login'

function jwt(expSeconds: number): string {
  const payload = Buffer.from(JSON.stringify({ exp: expSeconds })).toString('base64url')
  return `header.${payload}.sig`
}

describe('Cursor 登录', () => {
  it('404 表示还没批准，下一次拿到令牌', async () => {
    const seen: string[] = []
    const fetchImpl = (async (url: string) => {
      seen.push(url)
      if (seen.length === 1) return new Response('', { status: 404 })
      return new Response(
        JSON.stringify({ accessToken: jwt(2_000_000_000), refreshToken: 'refresh-1' }),
        { status: 200 }
      )
    }) as typeof fetch

    const tokens = await pollCursorLogin('uuid-1', 'verifier-1', undefined, {
      fetch: fetchImpl,
      sleep: async () => {}
    })

    expect(seen[0]).toContain('uuid=uuid-1')
    expect(seen[0]).toContain('verifier=verifier-1')
    expect(tokens.refreshToken).toBe('refresh-1')
    expect(tokens.expiresAt).toBe(2_000_000_000_000)
    expect(tokens.accessToken.startsWith('header.')).toBe(true)
  })

  it('续期把 refresh token 放进 Authorization，不走 API Key', async () => {
    let authorization = ''
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      authorization = new Headers(init?.headers).get('authorization') ?? ''
      return new Response(
        JSON.stringify({ accessToken: jwt(2_100_000_000), refreshToken: 'refresh-2' }),
        { status: 200 }
      )
    }) as typeof fetch

    const tokens = await refreshCursorTokens(
      { accessToken: 'old', refreshToken: 'refresh-1' },
      fetchImpl
    )
    expect(authorization).toBe('Bearer refresh-1')
    expect(tokens.refreshToken).toBe('refresh-2')
  })
})
