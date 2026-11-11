import { createServer } from 'http'
import type { AddressInfo } from 'net'
import { createHash, randomBytes } from 'crypto'
import { shell } from 'electron'
import { refreshCodeBuddyTokens, runCodeBuddyLogin } from './codebuddy'
import { refreshCursorTokens, runCursorLogin } from './cursor/login'
import { runZCodeLogin } from './zcode'

/**
 * Provider 的账号登录。
 *
 * 授权方式取决于各家提供哪一种：
 * - `pkce`：授权码 + PKCE，浏览器回调到本机（OpenRouter、ChatGPT）
 * - `device`：设备码，用户在浏览器里输一串码（Kimi）
 * - `codebuddy`：腾讯自家的 state 轮询登录，细节在 codebuddy.ts
 * - `zcode`：ZCode 自家的 CLI 授权轮询，订阅令牌失效后需重新登录
 *
 * 换回来的东西也分两类，直接决定了怎么存：
 * - OpenRouter 给的是**永久 API Key**，当成普通密钥加密存起来就行
 * - ChatGPT / Kimi 给的是**会过期的令牌**，得连 refreshToken 一起存，按需续期
 *
 * ## 关于合规
 *
 * 用订阅账号（ChatGPT Plus/Pro、Kimi 会员）驱动第三方客户端，是否符合各家
 * 服务条款需要使用者自行判断 —— 通常订阅面向官方客户端，API 才是给程序用的。
 * 这里如实记下每一条的来源与性质：
 *
 * - OpenRouter：官方文档明确写给第三方应用的 PKCE 流程，无争议
 * - Kimi：`@moonshot-ai/kimi-code-oauth` 是 MoonshotAI 自己发布的 **MIT**
 *   开源包，client_id 与端点都是公开常量；官方文档也说明第三方工具与
 *   CLI 共享同一份会员额度
 * - ChatGPT：参数取自 openai/codex（Apache-2.0）。client_id 是 Codex CLI 的
 *   公开客户端 id，回调端口 1455 是它注册死的，**不能改**
 * - CodeBuddy：腾讯**没有**开放 API，是照着官方 CLI 的登录与请求头直连，
 *   协议来源与风险见 codebuddy.ts 顶部。这几条里最可能失效、也最可能引来
 *   账号限制的一条
 * - Cursor：浏览器登录与 `agent login` 相同（loginDeepControl + poll），
 *   对话走订阅的 AgentService，不是控制台 API Key。见 cursor/login.ts
 */

/** 授权窗口。用户要去浏览器点同意，给足时间但不能无限等 */
const AUTH_TIMEOUT_MS = 5 * 60 * 1000

/** 令牌提前多久算过期。避免"刚好在请求发出时失效" */
const EXPIRY_SKEW_MS = 60 * 1000

export interface OAuthTokens {
  accessToken: string
  refreshToken?: string
  /** 绝对过期时间戳（毫秒）。没有则视为不过期 */
  expiresAt?: number
  /** 部分厂商要求请求时带上账号 id */
  accountId?: string
  /** CodeBuddy：请求头 X-Domain */
  domain?: string
  /** CodeBuddy：企业版账号的 X-Enterprise-Id */
  enterpriseId?: string
}

interface PkceProviderSpec {
  grant: 'pkce'
  authorizeUrl: string
  tokenUrl: string
  clientId?: string
  scope?: string
  /**
   * 固定回调端口。
   *
   * 只有在对方把 redirect_uri 注册死了的时候才填（ChatGPT 就是 1455）。
   * 留空表示端口交给系统分配 —— 那样更健壮，不会被占用。
   */
  fixedPort?: number
  /** 固定回调路径。留空则随机生成 */
  fixedPath?: string
  /** 附加到授权地址上的参数 */
  extraAuthParams?: Record<string, string>
  /**
   * 换回来的是不是永久 API Key。
   *
   * 为真时直接当普通密钥存；为假则连 refreshToken 一起存并按需续期。
   */
  yieldsApiKey?: boolean
}

interface DeviceProviderSpec {
  grant: 'device'
  deviceAuthorizationUrl: string
  tokenUrl: string
  clientId: string
  scope?: string
}

interface CodeBuddyProviderSpec {
  grant: 'codebuddy'
}

interface ZCodeProviderSpec {
  grant: 'zcode'
}

interface CursorProviderSpec {
  grant: 'cursor'
}

export type OAuthProviderSpec =
  | PkceProviderSpec
  | DeviceProviderSpec
  | CodeBuddyProviderSpec
  | ZCodeProviderSpec
  | CursorProviderSpec

export const OAUTH_PROVIDERS: Readonly<Record<string, OAuthProviderSpec>> = Object.freeze({
  openrouter: {
    grant: 'pkce',
    authorizeUrl: 'https://openrouter.ai/auth',
    tokenUrl: 'https://openrouter.ai/api/v1/auth/keys',
    yieldsApiKey: true
  },
  chatgpt: {
    grant: 'pkce',
    authorizeUrl: 'https://auth.openai.com/oauth/authorize',
    tokenUrl: 'https://auth.openai.com/oauth/token',
    // Codex CLI 的公开客户端 id。它把 redirect_uri 注册成了固定的
    // http://localhost:1455/auth/callback，所以端口和路径都不能改。
    clientId: process.env.CODEX_CLIENT_ID || 'app_EMoamEEZ73f0CkXaXp7hrann',
    // 与 pi-ai 的 openai-codex 流程逐字对齐。这里曾经多要了
    // `api.connectors.read` / `api.connectors.invoke` 两个范围 —— 多要范围
    // 不会让授权页报错，但换回来的令牌可能不是订阅接口认的那一份，
    // 于是「登录成功、一调用就失败」。不多要。
    scope: 'openid profile email offline_access',
    fixedPort: 1455,
    fixedPath: '/auth/callback',
    extraAuthParams: {
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      // 如实标明请求方。pi 填 'pi'，Codex CLI 填 'codex_cli_rs'。
      originator: 'unreal-box'
    }
  },
  'kimi-code': {
    grant: 'device',
    deviceAuthorizationUrl: 'https://auth.kimi.com/api/oauth/device_authorization',
    tokenUrl: 'https://auth.kimi.com/api/oauth/token',
    // @moonshot-ai/kimi-code-oauth（MIT）里的公开常量
    clientId: '17e5f671-d194-4dfb-9706-5516cb48c098'
  },
  codebuddy: { grant: 'codebuddy' },
  zcode: { grant: 'zcode' },
  cursor: { grant: 'cursor' }
})

export function getOAuthSpec(providerId: string): OAuthProviderSpec | undefined {
  return OAUTH_PROVIDERS[providerId]
}

/** 换回来的是永久 Key 还是会过期的令牌 —— 决定上层怎么存 */
export function yieldsPermanentKey(providerId: string): boolean {
  const spec = OAUTH_PROVIDERS[providerId]
  return spec?.grant === 'pkce' && spec.yieldsApiKey === true
}

export class OAuthCancelledError extends Error {
  constructor(detail?: string) {
    super(detail ? `授权已取消：${detail}` : '授权已取消')
    this.name = 'OAuthCancelledError'
  }
}

/** PKCE：verifier 是随机串，challenge 是它的 SHA256，只有 challenge 会过网络 */
function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = randomBytes(48).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

/** 回调页面。用户看到的是这一页，所以要能自解释 */
function resultPage(title: string, detail: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>${title}</title><style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0f172a;color:#e2e8f0;
display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{text-align:center;max-width:32rem;padding:2rem}
h1{font-size:1.25rem;font-weight:600;margin:0 0 .5rem}
p{color:#94a3b8;font-size:.875rem;line-height:1.6;margin:0}
</style></head><body><div class="box"><h1>${title}</h1><p>${detail}</p></div></body></html>`
}

/** 统一解析令牌响应。各家字段名一致（OAuth 2.0 标准），差别在有没有 refresh */
function parseTokenResponse(payload: Record<string, unknown>): OAuthTokens {
  const accessToken = String(payload.access_token || '')
  if (!accessToken) throw new Error('授权服务没有返回 access_token')

  const expiresIn = Number(payload.expires_in)
  return {
    accessToken,
    refreshToken: payload.refresh_token ? String(payload.refresh_token) : undefined,
    expiresAt: Number.isFinite(expiresIn) ? Date.now() + expiresIn * 1000 : undefined
  }
}

/** 令牌是不是快过期了。没有 expiresAt 视为不过期 */
export function isExpired(tokens: OAuthTokens): boolean {
  if (!tokens.expiresAt) return false
  return Date.now() >= tokens.expiresAt - EXPIRY_SKEW_MS
}

/**
 * 用 refreshToken 换一份新令牌。
 *
 * 失败时抛错而不是返回旧令牌 —— 让调用方明确知道要重新登录，
 * 而不是拿着一个已经失效的 token 去打厂商接口收获一串 401。
 */
export async function refreshOAuthTokens(
  providerId: string,
  tokens: OAuthTokens
): Promise<OAuthTokens> {
  const spec = OAUTH_PROVIDERS[providerId]
  if (!spec) throw new Error(`${providerId} 不支持账号登录`)
  if (spec.grant === 'zcode') throw new Error('ZCode token expired. Sign in to ZCode again.')
  if (spec.grant === 'cursor') return refreshCursorTokens(tokens)
  if (!tokens.refreshToken) throw new Error('没有 refresh_token，需要重新登录')
  if (spec.grant === 'codebuddy') return refreshCodeBuddyTokens(tokens)

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: tokens.refreshToken
  })
  if (spec.clientId) body.set('client_id', spec.clientId)

  const response = await fetch(spec.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })

  if (!response.ok) {
    throw new Error(`续期失败（HTTP ${response.status}），请重新登录`)
  }

  const next = parseTokenResponse((await response.json()) as Record<string, unknown>)
  return {
    ...next,
    // 有些厂商续期时不回 refresh_token，表示继续用旧的
    refreshToken: next.refreshToken || tokens.refreshToken,
    accountId: tokens.accountId
  }
}

/**
 * 授权码 + PKCE。
 *
 * 用**系统浏览器**而不是内嵌窗口：用户能看见真实地址栏，确认自己是在给
 * 对方站点授权，而不是给我们伪造的页面。
 */
async function runPkceLogin(
  providerId: string,
  spec: PkceProviderSpec,
  signal?: AbortSignal
): Promise<OAuthTokens> {
  const { verifier, challenge } = createPkcePair()
  const state = randomBytes(32).toString('base64url')
  // 没有固定路径要求时随机化：本机上别的程序猜不到该往哪儿发伪造的授权码
  const callbackPath = spec.fixedPath || `/${randomBytes(16).toString('hex')}`

  return new Promise<OAuthTokens>((resolvePromise, rejectPromise) => {
    let settled = false
    const server = createServer()

    const finish = (error: Error | null, tokens?: OAuthTokens): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      server.close()
      if (error) rejectPromise(error)
      else resolvePromise(tokens as OAuthTokens)
    }

    const timer = setTimeout(() => finish(new Error('授权超时，请重试')), AUTH_TIMEOUT_MS)
    const onAbort = (): void => finish(new OAuthCancelledError())
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort)

    server.on('request', (req, res) => {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (url.pathname !== callbackPath) {
        res.writeHead(404).end()
        return
      }

      const code = url.searchParams.get('code')
      const returnedState = url.searchParams.get('state')

      if (!code) {
        const denied = url.searchParams.get('error') || '未收到授权码'
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(resultPage('授权未完成', `可以关掉这个页面回到虚幻盒子重试。（${denied}）`))
        finish(new OAuthCancelledError(denied))
        return
      }

      // state 对不上说明这次回调不是我们发起的那一次，按攻击处理
      if (returnedState && returnedState !== state) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(resultPage('授权校验失败', 'state 不匹配，本次授权已作废。'))
        finish(new Error('state 校验失败，授权已丢弃'))
        return
      }

      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end(resultPage('授权成功', '可以关掉这个页面回到虚幻盒子了。'))

      // 换令牌放在响应之后：先让用户看到结果，别把浏览器晾在那儿转圈
      void (async () => {
        try {
          const redirectUri = `http://localhost:${(server.address() as AddressInfo).port}${callbackPath}`
          const tokens = await exchangeAuthCode(spec, code, verifier, redirectUri)
          finish(null, tokens)
        } catch (error) {
          finish(error instanceof Error ? error : new Error(String(error)))
        }
      })()
    })

    // 浏览器解析 localhost 时 IPv4、IPv6 都可能先试。固定端口在某个地址上
    // 被拒（Windows 上常见 EACCES：被别的程序独占或落在系统保留段）时换另一个地址再绑
    const hosts = spec.fixedPort ? ['127.0.0.1', '::1'] : ['127.0.0.1']
    let hostIndex = 0
    let listening = false

    server.on('error', (error) => {
      const code = (error as NodeJS.ErrnoException).code
      if (
        !listening &&
        (code === 'EACCES' || code === 'EADDRINUSE') &&
        hostIndex < hosts.length - 1
      ) {
        hostIndex += 1
        listen()
        return
      }
      let message = error.message
      if (spec.fixedPort && code === 'EADDRINUSE') {
        message =
          `本机 ${spec.fixedPort} 端口被占用。${providerId} 要求回调必须走这个端口，` +
          '请关掉占用它的程序（常见是官方 CLI 的登录流程）后重试。'
      } else if (spec.fixedPort && code === 'EACCES') {
        message =
          `没有权限监听本机 ${spec.fixedPort} 端口。${providerId} 要求回调必须走这个端口，` +
          '它可能被系统保留或被安全软件拦截。可以用管理员权限运行 ' +
          `netsh interface ipv4 show excludedportrange protocol=tcp 查看保留段，或暂时关闭拦截端口的安全软件后重试。`
      }
      finish(new Error(message))
    })

    // 固定端口是对方注册死的，只能用它；其余情况交给系统分配
    const listen = (): void => {
      server.listen(spec.fixedPort ?? 0, hosts[hostIndex], onListening)
    }
    const onListening = (): void => {
      listening = true
      const { port } = server.address() as AddressInfo
      const authorizeUrl = new URL(spec.authorizeUrl)
      // 回调用 localhost 而不是 127.0.0.1：ChatGPT 注册的就是 localhost 字面量
      authorizeUrl.searchParams.set('callback_url', `http://localhost:${port}${callbackPath}`)

      if (spec.clientId) {
        // 标准 OAuth 用 redirect_uri；OpenRouter 用的是 callback_url
        authorizeUrl.searchParams.delete('callback_url')
        authorizeUrl.searchParams.set('response_type', 'code')
        authorizeUrl.searchParams.set('client_id', spec.clientId)
        authorizeUrl.searchParams.set('redirect_uri', `http://localhost:${port}${callbackPath}`)
        authorizeUrl.searchParams.set('state', state)
        if (spec.scope) authorizeUrl.searchParams.set('scope', spec.scope)
      }

      authorizeUrl.searchParams.set('code_challenge', challenge)
      authorizeUrl.searchParams.set('code_challenge_method', 'S256')
      for (const [key, value] of Object.entries(spec.extraAuthParams || {})) {
        authorizeUrl.searchParams.set(key, value)
      }

      void shell.openExternal(authorizeUrl.toString()).catch((error) => finish(error))
    }
    listen()
  })
}

/** 拿授权码换令牌。OpenRouter 用 JSON 且回的是永久 Key，其余走标准表单 */
async function exchangeAuthCode(
  spec: PkceProviderSpec,
  code: string,
  verifier: string,
  redirectUri: string
): Promise<OAuthTokens> {
  if (spec.yieldsApiKey) {
    const response = await fetch(spec.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code,
        code_verifier: verifier,
        code_challenge_method: 'S256'
      })
    })
    if (!response.ok) throw new Error(`换取密钥失败：HTTP ${response.status}`)
    const data = (await response.json()) as { key?: string }
    if (!data.key) throw new Error('授权服务没有返回密钥')
    return { accessToken: data.key }
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    code_verifier: verifier,
    redirect_uri: redirectUri
  })
  if (spec.clientId) body.set('client_id', spec.clientId)

  const response = await fetch(spec.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  })
  if (!response.ok) {
    const detail = (await response.text().catch(() => '')).slice(0, 200)
    throw new Error(`换取令牌失败：HTTP ${response.status} ${detail}`)
  }
  return parseTokenResponse((await response.json()) as Record<string, unknown>)
}

/** 设备码流程要把这串码显示给用户，所以得能回调出去 */
export interface DeviceCodePrompt {
  userCode: string
  verificationUri: string
  /** 已经带上 userCode 的地址，能直接打开的话就不用手输 */
  verificationUriComplete?: string
}

/**
 * 设备码授权（RFC 8628）。
 *
 * 先跟对方要一串 userCode 显示给用户，用户在浏览器里输完之后，
 * 我们这边轮询到令牌为止。
 */
async function runDeviceLogin(
  spec: DeviceProviderSpec,
  onPrompt: (prompt: DeviceCodePrompt) => void,
  signal?: AbortSignal
): Promise<OAuthTokens> {
  const initBody = new URLSearchParams({ client_id: spec.clientId })
  if (spec.scope) initBody.set('scope', spec.scope)

  const initResponse = await fetch(spec.deviceAuthorizationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: initBody,
    signal
  })
  if (!initResponse.ok) {
    throw new Error(`发起设备授权失败：HTTP ${initResponse.status}`)
  }

  const init = (await initResponse.json()) as Record<string, unknown>
  const deviceCode = String(init.device_code || '')
  const userCode = String(init.user_code || '')
  const verificationUri = String(init.verification_uri || init.verification_url || '')
  if (!deviceCode || !userCode) throw new Error('设备授权响应缺少必要字段')

  const verificationUriComplete = init.verification_uri_complete
    ? String(init.verification_uri_complete)
    : undefined

  onPrompt({ userCode, verificationUri, verificationUriComplete })
  // 能直接带码打开就直接打开，省掉用户手输
  void shell.openExternal(verificationUriComplete || verificationUri).catch(() => {})

  // 对方指定的轮询间隔，缺省 5 秒；太快会被回 slow_down
  let intervalMs = (Number(init.interval) || 5) * 1000
  const deadline = Date.now() + (Number(init.expires_in) || 600) * 1000

  while (Date.now() < deadline) {
    await sleep(intervalMs, signal)

    const pollBody = new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
      client_id: spec.clientId
    })
    const response = await fetch(spec.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: pollBody,
      signal
    })
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>

    if (response.ok && payload.access_token) {
      return parseTokenResponse(payload)
    }

    const errorCode = String(payload.error || '')
    // 这两个不是失败，是"还没轮到"
    if (errorCode === 'authorization_pending') continue
    if (errorCode === 'slow_down') {
      intervalMs += 5000
      continue
    }
    if (errorCode === 'access_denied') throw new OAuthCancelledError('用户拒绝了授权')
    if (errorCode === 'expired_token') throw new Error('设备码已过期，请重试')
    throw new Error(`授权失败：${errorCode || `HTTP ${response.status}`}`)
  }

  throw new Error('授权超时，请重试')
}

/**
 * 跑一次账号登录。
 *
 * `onPrompt` 只有设备码流程会用到 —— 那种方式必须把一串码显示给用户。
 */
export async function runOAuthLogin(
  providerId: string,
  onPrompt: (prompt: DeviceCodePrompt) => void = () => {},
  signal?: AbortSignal
): Promise<OAuthTokens> {
  const spec = OAUTH_PROVIDERS[providerId]
  if (!spec) throw new Error(`${providerId} 不支持 OAuth 登录`)

  try {
    if (spec.grant === 'zcode') {
      return await runZCodeLogin({ openUrl: (url) => shell.openExternal(url), signal })
    }
    if (spec.grant === 'codebuddy') {
      return await runCodeBuddyLogin({ openUrl: (url) => shell.openExternal(url), signal })
    }
    if (spec.grant === 'cursor') {
      return await runCursorLogin({ openUrl: (url) => shell.openExternal(url) }, signal)
    }
    return spec.grant === 'device'
      ? await runDeviceLogin(spec, onPrompt, signal)
      : await runPkceLogin(providerId, spec, signal)
  } catch (error) {
    // fetch 被中止时抛的是 AbortError，统一成"已取消"，上层不当失败处理
    if (signal?.aborted) throw new OAuthCancelledError()
    throw error
  }
}

/** 可被中止的等待：设备码轮询间隔里用户点了取消，要立刻停，不能再睡 5 秒 */
function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new OAuthCancelledError())
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new OAuthCancelledError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
