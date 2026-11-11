import http2 from 'http2'
import net from 'net'
import tls from 'tls'
import { resolveHttpProxy } from '../../utils/systemProxyFetch'

/**
 * 连上 Cursor 的 HTTP/2。
 *
 * 这个接口拒绝 HTTP/1.1。系统代理开着时先 CONNECT 再升到 h2，
 * 否则国内直连 api2.cursor.sh 会和登录轮询走两条路。
 */

export interface CursorSession {
  request(path: string, headers: Record<string, string>): http2.ClientHttp2Stream
  close(): void
}

function connectTunnel(
  proxy: { host: string; port: number },
  targetHost: string,
  targetPort: number
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(proxy.port, proxy.host)
    const fail = (error: Error): void => {
      socket.destroy()
      reject(error)
    }
    socket.once('error', fail)
    socket.once('connect', () => {
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\nHost: ${targetHost}:${targetPort}\r\n\r\n`
      )
    })
    let pending = Buffer.alloc(0)
    const onData = (chunk: Buffer): void => {
      pending = Buffer.concat([pending, chunk])
      const end = pending.indexOf('\r\n\r\n')
      if (end < 0) return
      socket.off('data', onData)
      const status = Number(pending.subarray(0, end).toString('utf8').split(' ')[1])
      if (status !== 200) {
        fail(new Error(`代理 CONNECT 失败：HTTP ${status || 'unknown'}`))
        return
      }
      const secure = tls.connect({
        socket,
        servername: targetHost,
        ALPNProtocols: ['h2']
      })
      secure.once('secureConnect', () => resolve(secure))
      secure.once('error', reject)
    }
    socket.on('data', onData)
  })
}

export async function openCursorSession(baseUrl: string): Promise<CursorSession> {
  const url = new URL(baseUrl)
  const proxy = await resolveHttpProxy(url.href)
  if (!proxy) return wrap(http2.connect(url.origin))
  const socket = await connectTunnel(proxy, url.hostname, Number(url.port || 443))
  // 隧道已经是 TLS。createConnection 返回的流会被直接拿去跑 h2，不会再包一层。
  return wrap(http2.connect(url.origin, { createConnection: () => socket }))
}

function wrap(client: http2.ClientHttp2Session): CursorSession {
  return {
    request(path, headers) {
      return client.request({
        ':method': 'POST',
        ':path': path,
        ...headers
      })
    },
    close() {
      client.close()
    }
  }
}
