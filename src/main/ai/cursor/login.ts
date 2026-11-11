import { createHash, randomBytes, randomUUID } from 'crypto'
import type { OAuthTokens } from '../oauth'

/**
 * Cursor 订阅登录。
 *
 * 和 Codex 一样不收 API Key：浏览器打开 cursor.com 的登录页，我们拿
 * PKCE 的 verifier 去 `api2.cursor.sh/auth/poll` 等令牌。这是 Cursor CLI
 * `agent login` 用的同一条路（`loginDeepControl` + poll），不是控制台里
 * 那个按量的 API Key。
 *
 * 令牌会过期。续期打 `POST /auth/exchange_user_api_key`，失败就要求重新登录。
 */

export const CURSOR_LOGIN_URL = 'https://cursor.com/loginDeepControl'
export const CURSOR_POLL_URL = 'https://api2.cursor.sh/auth/poll'
export const CURSOR_REFRESH_URL = 'https://api2.cursor.sh/auth/exchange_user_api_key'

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000
const POLL_BASE_MS = 1000
const POLL_MAX_MS = 10_000

export interface CursorLoginDeps {
  fetch?: typeof fetch
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  now?: () => number
  openUrl?: (url: string) => Promise<void>
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function cursorLoginUrl(challenge: string, uuid: string): string {
  const params = new URLSearchParams({
    challenge,
    uuid,
    mode: 'login',
    redirectTarget: 'cli'
  })
  return `${CURSOR_LOGIN_URL}?${params.toString()}`
}

/** JWT 的 exp。解不开就不当作已过期，交给下一次请求的 401 去触发重新登录 */
export function expiryFromAccessToken(token: string): number | undefined {
  const payload = token.split('.')[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      exp?: unknown
    }
    return typeof claims.exp === 'number' ? claims.exp * 1000 : undefined
  } catch {
    return undefined
  }
}

function tokensFrom(accessToken: string, refreshToken: string | undefined): OAuthTokens {
  return {
    accessToken,
    refreshToken,
    expiresAt: expiryFromAccessToken(accessToken)
  }
}

async function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw aborted()
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(aborted())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function aborted(): Error {
  const error = new Error('授权已取消')
  error.name = 'AbortError'
  return error
}

/**
 * 轮询到令牌为止。404 是「用户还没点完」，继续等。
 * 连续网络错误才停，避免登录页还开着时一次抖动就把流程掐掉。
 */
export async function pollCursorLogin(
  uuid: string,
  verifier: string,
  signal?: AbortSignal,
  deps: CursorLoginDeps = {}
): Promise<OAuthTokens> {
  const fetchImpl = deps.fetch ?? fetch
  const sleep = deps.sleep ?? defaultSleep
  const now = deps.now ?? Date.now
  const deadline = now() + LOGIN_TIMEOUT_MS
  let delay = POLL_BASE_MS
  let consecutiveErrors = 0

  while (now() < deadline) {
    if (signal?.aborted) throw aborted()
    await sleep(delay, signal)
    try {
      const response = await fetchImpl(
        `${CURSOR_POLL_URL}?uuid=${encodeURIComponent(uuid)}&verifier=${encodeURIComponent(verifier)}`,
        { signal }
      )
      if (response.status === 404) {
        consecutiveErrors = 0
        delay = Math.min(Math.round(delay * 1.2), POLL_MAX_MS)
        continue
      }
      const body = (await response.json().catch(() => ({}))) as {
        accessToken?: string
        refreshToken?: string
      }
      if (!response.ok || !body.accessToken) {
        throw new Error(`Cursor 登录失败（HTTP ${response.status}）`)
      }
      return tokensFrom(body.accessToken, body.refreshToken)
    } catch (error) {
      if (signal?.aborted) throw aborted()
      consecutiveErrors += 1
      if (consecutiveErrors >= 3) {
        throw error instanceof Error ? error : new Error(String(error))
      }
    }
  }
  throw new Error('授权超时，请重试')
}

export async function runCursorLogin(
  deps: CursorLoginDeps = {},
  signal?: AbortSignal
): Promise<OAuthTokens> {
  const { verifier, challenge } = pkce()
  const uuid = randomUUID()
  const url = cursorLoginUrl(challenge, uuid)
  await deps.openUrl?.(url)
  return pollCursorLogin(uuid, verifier, signal, deps)
}

export async function refreshCursorTokens(
  tokens: OAuthTokens,
  fetchImpl: typeof fetch = fetch
): Promise<OAuthTokens> {
  const bearer = tokens.refreshToken || tokens.accessToken
  if (!bearer) throw new Error('没有 refresh_token，需要重新登录')
  const response = await fetchImpl(CURSOR_REFRESH_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${bearer}`,
      'Content-Type': 'application/json'
    },
    body: '{}'
  })
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200)
    throw new Error(`续期失败（HTTP ${response.status}）${detail}，请重新登录`)
  }
  const body = (await response.json()) as { accessToken?: string; refreshToken?: string }
  if (!body.accessToken) throw new Error('续期没有返回 accessToken，请重新登录')
  return tokensFrom(body.accessToken, body.refreshToken || tokens.refreshToken)
}
