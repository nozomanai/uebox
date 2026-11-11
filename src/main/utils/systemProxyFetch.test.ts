import { describe, expect, it, vi } from 'vitest'
import {
  createProxyAwareFetch,
  describeFetchRoute,
  pacWantsProxy,
  parsePacProxy
} from './systemProxyFetch'

type Mocked = ReturnType<typeof vi.fn>

function setup(pac: string | Error): {
  fetchFn: typeof fetch
  directFetch: Mocked
  proxiedFetch: Mocked
  resolveProxy: Mocked
  tick: (ms: number) => number
} {
  const directFetch = vi.fn(async () => new Response('direct'))
  const proxiedFetch = vi.fn(async () => new Response('proxied'))
  const resolveProxy = vi.fn(async () => {
    if (pac instanceof Error) throw pac
    return pac
  })
  let clock = 0
  const fetchFn = createProxyAwareFetch({
    directFetch: directFetch as unknown as typeof fetch,
    proxiedFetch: proxiedFetch as unknown as typeof fetch,
    resolveProxy,
    now: () => clock
  })
  return { fetchFn, directFetch, proxiedFetch, resolveProxy, tick: (ms: number) => (clock += ms) }
}

describe('pacWantsProxy', () => {
  it('only the first entry decides', () => {
    expect(pacWantsProxy('DIRECT')).toBe(false)
    expect(pacWantsProxy(' direct ; PROXY a:1')).toBe(false)
    expect(pacWantsProxy('PROXY 127.0.0.1:7890; DIRECT')).toBe(true)
    expect(pacWantsProxy('SOCKS5 127.0.0.1:7891')).toBe(true)
    expect(pacWantsProxy('')).toBe(false)
  })
})

describe('createProxyAwareFetch', () => {
  it('sends to the Chromium stack when the system proxy covers the host', async () => {
    const { fetchFn, proxiedFetch, directFetch } = setup('PROXY 127.0.0.1:7890')
    const res = await fetchFn('https://auth.openai.com/oauth/token', { method: 'POST' })
    expect(await res.text()).toBe('proxied')
    expect(proxiedFetch).toHaveBeenCalledWith('https://auth.openai.com/oauth/token', {
      method: 'POST'
    })
    expect(directFetch).not.toHaveBeenCalled()
  })

  it('keeps the old direct path when there is no proxy', async () => {
    const { fetchFn, directFetch, proxiedFetch } = setup('DIRECT')
    await fetchFn(new URL('https://api.deepseek.com/v1/chat'))
    expect(directFetch).toHaveBeenCalledOnce()
    expect(proxiedFetch).not.toHaveBeenCalled()
  })

  it('never asks about loopback — OAuth callbacks and local models stay direct', async () => {
    const { fetchFn, resolveProxy, directFetch } = setup('PROXY 127.0.0.1:7890')
    await fetchFn('http://localhost:11434/api/tags')
    await fetchFn('http://127.0.0.1:1455/auth/callback')
    await fetchFn('http://[::1]:8080/')
    expect(resolveProxy).not.toHaveBeenCalled()
    expect(directFetch).toHaveBeenCalledTimes(3)
  })

  it('falls back to direct when the proxy lookup fails', async () => {
    const { fetchFn, directFetch } = setup(new Error('boom'))
    await fetchFn('https://api.openai.com/v1/models')
    expect(directFetch).toHaveBeenCalledOnce()
  })

  it('caches per origin and re-asks after the TTL so toggling the proxy takes effect', async () => {
    const { fetchFn, resolveProxy, tick } = setup('DIRECT')
    await fetchFn('https://api.openai.com/a')
    await fetchFn('https://api.openai.com/b')
    expect(resolveProxy).toHaveBeenCalledOnce()
    tick(31_000)
    await fetchFn('https://api.openai.com/c')
    expect(resolveProxy).toHaveBeenCalledTimes(2)
  })

  it('reads the URL off a Request object', async () => {
    const { fetchFn, resolveProxy } = setup('DIRECT')
    await fetchFn(new Request('https://chatgpt.com/backend-api/codex/responses'))
    expect(resolveProxy).toHaveBeenCalledWith('https://chatgpt.com/backend-api/codex/responses')
  })
})

describe('parsePacProxy', () => {
  it('只认 PROXY host:port 的第一跳', () => {
    expect(parsePacProxy('PROXY 127.0.0.1:7890; DIRECT')).toEqual({
      host: '127.0.0.1',
      port: 7890
    })
    expect(parsePacProxy('DIRECT')).toBeUndefined()
    expect(parsePacProxy('SOCKS 127.0.0.1:1080')).toBeUndefined()
  })
})

describe('describeFetchRoute', () => {
  it('还没装（测试、启动早期）就答不上来，而不是瞎猜直连', async () => {
    await expect(describeFetchRoute('https://api.example.com')).resolves.toBeUndefined()
  })
})
