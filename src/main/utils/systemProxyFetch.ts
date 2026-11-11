/**
 * 让主进程的 `fetch` 跟系统代理走。
 *
 * Node 自带的 `fetch` 不读系统代理：用户开着 Clash 之类的「系统代理」模式时，
 * 浏览器、Codex CLI 都走代理，只有主进程直连出去。国内直连 OpenAI 的授权和
 * 接口会被按地区拒掉（HTTP 403），表现就是「浏览器里登录成功，回到盒子换取
 * 令牌失败」。开 TUN 模式的人碰不到，所以这个洞一直没人发现。
 *
 * 做法：每个请求先问 Chromium 这个地址该不该走代理 —— 它读的就是浏览器用的
 * 那一套（系统代理、PAC、绕过列表）。
 * - 直连：原样交给 Node 的 `fetch`，没开代理的人行为和以前完全一样
 * - 走代理：交给 Electron 的网络栈去发，代理由它按系统设置处理
 *
 * 不用 Node 24 的 `http.setGlobalProxyFromEnv`：它的 NO_PROXY 不认网段，
 * 局域网里的 ComfyUI、Ollama 会被一起塞进代理；全局模式下直接连不上。
 */

/** 同一个源的判断缓存多久。代理开关随时可能变，但不值得每个请求都问一遍 */
const DECISION_TTL_MS = 30 * 1000

export interface ProxyAwareFetchDeps {
  /** Node 原生 fetch，直连用 */
  directFetch: typeof fetch
  /** 走 Chromium 网络栈的 fetch，由它按系统设置套代理 */
  proxiedFetch: typeof fetch
  /** Chromium 的代理判断，返回 PAC 格式，如 `PROXY 127.0.0.1:7890; DIRECT` */
  resolveProxy: (url: string) => Promise<string>
  now?: () => number
}

/** PAC 结果里第一项不是 DIRECT，就说明系统要求这个地址走代理 */
export function pacWantsProxy(pac: string): boolean {
  const first = pac.split(';')[0]?.trim().toUpperCase() || 'DIRECT'
  return first !== 'DIRECT'
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname === '[::1]' ||
    hostname.startsWith('127.')
  )
}

function requestUrl(input: Parameters<typeof fetch>[0]): URL | null {
  try {
    if (typeof input === 'string') return new URL(input)
    if (input instanceof URL) return input
    return new URL(input.url)
  } catch {
    return null
  }
}

export function createProxyAwareFetch(deps: ProxyAwareFetchDeps): typeof fetch {
  const now = deps.now ?? Date.now
  const decisions = new Map<string, { proxied: boolean; at: number }>()

  const shouldProxy = async (url: URL): Promise<boolean> => {
    const cached = decisions.get(url.origin)
    if (cached && now() - cached.at < DECISION_TTL_MS) return cached.proxied

    // 问不出来就当直连 —— 也就是修这个问题之前的行为，不会更糟
    const proxied = await deps
      .resolveProxy(url.href)
      .then(pacWantsProxy)
      .catch(() => false)
    decisions.set(url.origin, { proxied, at: now() })
    return proxied
  }

  const proxyAwareFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: RequestInit
  ): Promise<Response> => {
    const url = requestUrl(input)
    if (
      !url ||
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      isLoopback(url.hostname)
    ) {
      return deps.directFetch(input, init)
    }
    return (await shouldProxy(url)) ? deps.proxiedFetch(input, init) : deps.directFetch(input, init)
  }
  return proxyAwareFetch as typeof fetch
}

/** 装好之后才有：诊断日志问「这个地址这会儿走哪条路」时用 */
let routeResolver: ((url: string) => Promise<string>) | undefined

/**
 * 系统代理要求这个地址走 HTTP 代理时，返回代理的 host 和端口。
 *
 * 给不能用 `fetch` 的传输用（Cursor 的 HTTP/2）。没装代理钩子、或判定为直连，
 * 就回 undefined，调用方自己直连。
 */
export async function resolveHttpProxy(
  url: string
): Promise<{ host: string; port: number } | undefined> {
  if (!routeResolver) return undefined
  const pac = await routeResolver(url).catch(() => 'DIRECT')
  return parsePacProxy(pac)
}

/** `PROXY host:port` 的第一跳。DIRECT、SOCKS、解析不了的都不猜 */
export function parsePacProxy(pac: string): { host: string; port: number } | undefined {
  const first = pac.split(';')[0]?.trim() ?? ''
  const match = /^PROXY\s+(\[[^\]]+\]|[^:\s]+):(\d+)\s*$/i.exec(first)
  if (!match) return undefined
  const port = Number(match[2])
  if (!Number.isInteger(port) || port < 1 || port > 65535) return undefined
  return { host: match[1], port }
}

/**
 * 这个地址这会儿走直连还是系统代理。给诊断日志用，不影响请求本身。
 *
 * 连接被掐时这是第一个要分清的问题：走代理的请求由 Chromium 发，报错带 `net::`
 * 前缀；中间多了一个本机代理，断开的可能是它而不是厂商。没装（测试、启动早期）
 * 就回 undefined。
 */
export async function describeFetchRoute(url: string): Promise<string | undefined> {
  if (!routeResolver) return undefined
  const pac = await routeResolver(url)
  return pacWantsProxy(pac) ? `proxy (${pac.split(';')[0].trim()})` : 'direct'
}

/**
 * 在 app ready 之后调用一次。
 *
 * 走代理的请求用一个独立的内存会话发：不带默认会话里渲染进程留下的 Cookie，
 * 也不落盘。
 */
export async function installSystemProxyFetch(): Promise<void> {
  const { session } = await import('electron')
  const ses = session.fromPartition('uebox-main-fetch')
  routeResolver = (url) => ses.resolveProxy(url)
  globalThis.fetch = createProxyAwareFetch({
    directFetch: globalThis.fetch.bind(globalThis),
    proxiedFetch: ((input, init) =>
      ses.fetch(input as Parameters<typeof ses.fetch>[0], init)) as typeof fetch,
    resolveProxy: (url) => ses.resolveProxy(url)
  })
}
