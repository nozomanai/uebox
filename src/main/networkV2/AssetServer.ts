/**
 * AssetServer — 嵌入式 HTTP + WebSocket 资产服务
 *
 * 资产机 Server 模式的核心，负责：
 * 1. HTTP REST API — 资产/文件夹/标签的 CRUD + 搜索 + 增量同步
 * 2. WebSocket — 实时变更推送给所有已连接的 Client
 * 3. 多 Vault 路由隔离
 * 4. 访问码鉴权（每 Vault 一对：readKey 只读 / writeKey 读写），IP 表只降不升
 */
import * as http from 'http'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { Duplex } from 'stream'
import { WebSocketServer, WebSocket } from 'ws'
import {
  AuthThrottle,
  VaultCredentials,
  isBrowserOriginated,
  isHostHeaderAllowed,
  normalizeAccessKey,
  readAccessKeyHeader,
  type AuthErrorCode,
  type VaultAccessKeys
} from './ServerAuth'
import Database from 'better-sqlite3'
import { ChangeTracker } from './ChangeTracker'
import {
  getAssetDataByFolderKey,
  getAssetDataByKey,
  createAssetData,
  updateAssetData,
  deleteAssetData,
  searchAssetDataByName
} from '../sqliteDataBase/models/assetData'
import type { AssetData } from '../sqliteDataBase/models/assetData'
import type { AssetFolder } from '../sqliteDataBase/models/assetFolder'
import {
  getAssetFoldersByFatherKey,
  createAssetFolder,
  getAssetFolderByKey,
  updateAssetFolder,
  deleteAssetFolder
} from '../sqliteDataBase/models/assetFolder'
import {
  isFolderActive,
  collectFolderSubtreeKeys,
  recordSubtreeDeletionChanges
} from './folderDeleteHelper'
import { ALL_FOLDER } from '../init/constants'
import type {
  SyncResponse,
  ServerConfig,
  WsServerMessage,
  WsChangeMessage,
  ChangeOp,
  TrackedTable,
  ChangeLogEntry,
  PermissionLevel
} from './SyncProtocol'
import { DEFAULT_SERVER_CONFIG } from './SyncProtocol'
import { readRowSnapshot } from './rowSnapshot'

// ─────────────────────────── 内部文件保护 ───────────────────────────

/** Vault 内部控制文件，禁止通过 /files 接口读写 */
const INTERNAL_BLOCKED_FILES = new Set([
  '.vault_id',
  '.vault',
  '.vault_backup.db',
  'vault-data.db',
  'vault-data.db-wal',
  'vault-data.db-shm'
])
// ─────────────────────────── 类型 ───────────────────────────

/** 已注册的 Vault */
export interface VaultEntry {
  vaultId: string
  name: string
  networkPath: string
  db: Database.Database
  tracker: ChangeTracker
  /** 每个 Vault 独立的访问码。凭据不跨 Vault 生效 */
  credentials: VaultCredentials
}

/** 文件系统扫描的实现 */
export type VaultScanHandler = (vault: VaultEntry) => Promise<Record<string, unknown>>

let sharedScanHandler: VaultScanHandler | null = null

/**
 * 注册文件系统扫描实现，由 IPC 层在注册 `networkVaultV2:*` 通道时调用一次。
 *
 * 扫描逻辑住在 IPC 层（它持有资产解析器、缩略图这些依赖），AssetServer 在收到
 * POST /scan 时才去取当前注册的那一个 —— **不能改成在 Server 启动处注入**：
 * 启动时 `initDatabase()` → `switchToVault()` 就把 Server 拉起来了，比
 * `registerAllIPC()` 早，按启动时点注入的话那台 Server 永远没有扫描实现，
 * 可写客户端点「刷新」只会收到 501「扫描功能未配置」。
 */
export function registerVaultScanHandler(handler: VaultScanHandler): void {
  sharedScanHandler = handler
}

/** 当前注册的扫描实现；没有注册过时为 null（POST /scan 回 501） */
export function getVaultScanHandler(): VaultScanHandler | null {
  return sharedScanHandler
}

/** 同一保管库已有扫描在跑时抛出；HTTP 层据此回 409 */
export class VaultScanBusyError extends Error {
  constructor() {
    super('上一次扫描尚未结束')
    this.name = 'VaultScanBusyError'
  }
}

const runningScans = new Set<string>()

/**
 * 同一保管库同时只跑一次扫描。
 *
 * 这把锁必须在扫描实现里取，不能只拦 HTTP 请求：本机主机用户走 IPC
 * `networkVaultV2:scan`，远程客户端走 POST /scan，两条路径进的是同一个
 * 扫描实现。只拦一边的话，两个用户同时点「刷新」会各自把同一个文件入一遍库
 * —— 去重快照在扫描开头一次读完，`assetKey` 每次新生成，同一文件留下两条
 * assetData，事后只能人工清。
 */
export async function withVaultScanLock<T>(vaultId: string, run: () => Promise<T>): Promise<T> {
  if (runningScans.has(vaultId)) throw new VaultScanBusyError()
  runningScans.add(vaultId)
  try {
    return await run()
  } finally {
    runningScans.delete(vaultId)
  }
}

const PERMISSION_RANK: Record<PermissionLevel, number> = {
  readonly: 0,
  readwrite: 1,
  admin: 2
}

/** 已连接的 WebSocket 客户端 */
interface WsClient {
  ws: WebSocket
  clientId: string
  vaultId: string
  ip: string
  hostname: string
}

// ─────────────────────────── Server ───────────────────────────

export class AssetServer {
  private httpServer: http.Server | null = null
  private wss: WebSocketServer | null = null
  private vaults: Map<string, VaultEntry> = new Map()
  private wsClients: Map<string, WsClient> = new Map()
  private config: ServerConfig
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private backupTimer: ReturnType<typeof setInterval> | null = null
  private _isRunning = false
  // WS 日志节流：per-client 在短时间内只输出一次，避免重连风暴时刷屏
  private wsLogThrottle: Map<string, number> = new Map()
  private static readonly WS_LOG_INTERVAL_MS = 5000
  private throttle = new AuthThrottle()
  private allowedHostnames: string[]

  constructor(config: Partial<ServerConfig> = {}) {
    this.config = { ...DEFAULT_SERVER_CONFIG, ...config }
    this.allowedHostnames = this.config.allowedHostnames ?? [os.hostname()]
  }

  get isRunning(): boolean {
    return this._isRunning
  }

  get port(): number {
    return this.config.port
  }

  get connectedClientCount(): number {
    return this.wsClients.size
  }

  // ─────────────────────────── 生命周期 ───────────────────────────

  /**
   * 注册一个 Vault。
   *
   * keys 是必填的（类型层面 fail-closed）：没有访问码的库不该被暴露到网络上，
   * 忘了传就编译不过，而不是悄悄起一个谁都能读的服务。
   */
  registerVault(
    vaultId: string,
    name: string,
    networkPath: string,
    db: Database.Database,
    keys: VaultAccessKeys
  ): void {
    const tracker = new ChangeTracker(db, this.config.maxChangeLogEntries)
    this.vaults.set(vaultId, {
      vaultId,
      name,
      networkPath,
      db,
      tracker,
      credentials: new VaultCredentials(keys)
    })
    console.log(`[AssetServer] 注册 Vault: ${name} (${vaultId})`)
  }

  /**
   * 轮换访问码后热更新，不需要重启服务。
   *
   * 用旧码建立的 WS 连接必须踢掉 —— 否则「重新生成配对码」等于没生成，
   * 已经连上的机器照样继续收变更推送。
   */
  updateVaultKeys(vaultId: string, keys: VaultAccessKeys): void {
    const vault = this.vaults.get(vaultId)
    if (!vault) return
    vault.credentials = new VaultCredentials(keys)

    const stale: string[] = []
    this.wsClients.forEach((client, key) => {
      if (client.vaultId === vaultId) {
        try {
          client.ws.close(4401, 'credentials_rotated')
        } catch {
          // 连接已经断了，忽略
        }
        stale.push(key)
      }
    })
    stale.forEach((key) => this.wsClients.delete(key))
  }

  /** 获取指定 Vault Entry（供 IPC 层使用） */
  getVaultEntry(vaultId: string): VaultEntry | undefined {
    return this.vaults.get(vaultId)
  }

  unregisterVault(vaultId: string): void {
    this.vaults.delete(vaultId)
    const toRemove: string[] = []
    this.wsClients.forEach((client, key) => {
      if (client.vaultId === vaultId) {
        client.ws.close(1000, 'vault_unregistered')
        toRemove.push(key)
      }
    })
    toRemove.forEach((key) => this.wsClients.delete(key))
    console.log(`[AssetServer] 注销 Vault: ${vaultId}`)
  }

  async start(): Promise<number> {
    if (this._isRunning) return this.config.port

    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer((req, res) => this.handleHttpRequest(req, res))

      // 不再让 ws 自动接管 upgrade —— 必须在握手完成**之前**拦下未授权连接。
      // 用 wss.on('connection') 是来不及的：那时 101 已经发出去，
      // 客户端已经进了广播列表，事后 close 也已经泄露过。
      this.wss = new WebSocketServer({ noServer: true })
      this.httpServer.on('upgrade', (req, socket, head) =>
        this.handleWsUpgrade(req, socket as Duplex, head)
      )

      const tryBind = (port: number, attempt = 0): void => {
        this.httpServer!.listen(port, '0.0.0.0', () => {
          // 取实际绑定端口：传 0 时原来会把 0 记成端口，导致 .vault 里写出 "port": 0
          const address = this.httpServer!.address()
          this.config.port = address && typeof address === 'object' ? address.port : port
          this._isRunning = true
          this.startTimers()
          console.log(
            `[AssetServer] 已启动 — 端口 ${this.config.port}, ${this.vaults.size} 个 Vault（已启用访问码鉴权）`
          )
          resolve(this.config.port)
        })

        this.httpServer!.once('error', (err: NodeJS.ErrnoException) => {
          if (err.code === 'EADDRINUSE' && attempt < 10) {
            console.warn(`[AssetServer] 端口 ${port} 被占用，尝试 ${port + 1}`)
            this.httpServer!.removeAllListeners('error')
            tryBind(port + 1, attempt + 1)
          } else {
            reject(err)
          }
        })
      }

      tryBind(this.config.port)
    })
  }

  async stop(): Promise<void> {
    this._isRunning = false
    this.stopTimers()

    this.wsClients.forEach((client) => {
      client.ws.close(1000, 'server_shutdown')
    })
    this.wsClients.clear()

    if (this.wss) {
      this.wss.close()
      this.wss = null
    }

    return new Promise((resolve) => {
      if (this.httpServer) {
        this.httpServer.close(() => {
          this.httpServer = null
          console.log('[AssetServer] 已停止')
          resolve()
        })
      } else {
        resolve()
      }
    })
  }

  private startTimers(): void {
    this.cleanupTimer = setInterval(() => {
      this.vaults.forEach((vault) => {
        vault.tracker.cleanup()
        vault.tracker.cleanupStaleClients()
      })
    }, 3600_000)

    if (this.config.autoBackupIntervalMs > 0) {
      this.backupTimer = setInterval(() => {
        this.backupAllVaults()
      }, this.config.autoBackupIntervalMs)
    }
  }

  private stopTimers(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
    if (this.backupTimer) {
      clearInterval(this.backupTimer)
      this.backupTimer = null
    }
  }

  private backupAllVaults(): void {
    this.vaults.forEach((vault) => {
      try {
        const backupPath = vault.networkPath ? `${vault.networkPath}/.vault_backup.db` : null
        if (backupPath) {
          vault.db
            .backup(backupPath)
            .then(() => {
              console.log(`[AssetServer] Vault ${vault.name} 备份完成`)
            })
            .catch((err: unknown) => {
              console.warn(`[AssetServer] Vault ${vault.name} 备份失败:`, err)
            })
        }
      } catch (err) {
        console.warn(`[AssetServer] 备份异常:`, err)
      }
    })
  }

  // ─────────────────────────── 权限 ───────────────────────────

  private resolveGrants(rawKey: string | undefined): Map<string, PermissionLevel> {
    const grants = new Map<string, PermissionLevel>()
    const normalized = normalizeAccessKey(rawKey)
    if (!normalized) return grants
    this.vaults.forEach((vault, vaultId) => {
      const level = vault.credentials.match(normalized)
      if (level) grants.set(vaultId, level)
    })
    return grants
  }

  /**
   * IP 表只降不升。
   *
   * v3 起权限由「出示了哪把访问码」决定，这张表退化成额外的收紧手段：
   * 空表 = 不生效（向后兼容旧配置），有条目 = 对该 IP 封顶。
   */
  private clampByIp(ip: string, granted: PermissionLevel): PermissionLevel {
    const table = this.config.permissions
    let explicit = table[ip]
    if (!explicit) {
      for (const pattern of Object.keys(table)) {
        if (!pattern.includes('*')) continue
        const regex = new RegExp('^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '.*') + '$')
        if (regex.test(ip)) {
          explicit = table[pattern]
          break
        }
      }
    }
    if (!explicit) return granted
    return PERMISSION_RANK[explicit] < PERMISSION_RANK[granted] ? explicit : granted
  }

  private canWrite(level: PermissionLevel): boolean {
    return level === 'readwrite' || level === 'admin'
  }

  /** 兼容窗口是否仍开着。只对私网来源生效，且只给只读 */
  private legacyWindowOpen(ip: string, now = Date.now()): boolean {
    const until = this.config.legacyUnauthReadUntil ?? 0
    if (until <= now) return false
    return (
      ip === '127.0.0.1' ||
      ip === '::1' ||
      /^10\./.test(ip) ||
      /^192\.168\./.test(ip) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(ip)
    )
  }

  // ─────────────────────────── HTTP ───────────────────────────

  private handleHttpRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const clientIp = req.socket.remoteAddress?.replace('::ffff:', '') || 'unknown'

    // ── 1. 不再输出任何 CORS 头 ────────────────────────────────────
    // 合法客户端是 Electron 主进程的 Node http 客户端，Node 不解析
    // Access-Control-*。原来那个 `Access-Control-Allow-Origin: *` 对功能的
    // 贡献精确为零，唯一效果是让任意浏览器页面跨域读走整个资产库。
    // 删掉它 + 要求非 safelist 头 X-API-Key ⇒ 浏览器跨域必须预检
    // ⇒ 预检 405 ⇒ 请求根本发不出去。
    res.setHeader('X-Content-Type-Options', 'nosniff')
    res.setHeader('Cache-Control', 'no-store')

    // ── 2. DNS rebinding ──────────────────────────────────────────
    if (!isHostHeaderAllowed(req.headers.host, this.allowedHostnames)) {
      this.sendJson(res, 403, {
        success: false,
        error: 'Host not allowed',
        errorCode: 'HOST_NOT_ALLOWED'
      })
      return
    }

    // ── 3. 浏览器来源一律拒 ────────────────────────────────────────
    if (isBrowserOriginated(req)) {
      this.sendJson(res, 403, {
        success: false,
        error: 'Browser-originated request rejected',
        errorCode: 'BROWSER_ORIGIN_REJECTED'
      })
      return
    }

    // ── 4. 没有 CORS 就不需要预检 ──────────────────────────────────
    if (req.method === 'OPTIONS') {
      res.writeHead(405, { Allow: 'GET, POST, PUT, DELETE' })
      res.end()
      return
    }

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const path = url.pathname
    const method = req.method || 'GET'

    // ── 5. 鉴权。必须早于 vault 查找 ────────────────────────────────
    //
    // 刻意**不留任何免鉴权探测路由**：客户端想知道「这台服务器要不要码」，
    // 拿 401 响应体里的 errorCode: AUTH_REQUIRED 就够了，不必额外开一个口子。
    // 否则「库不存在 404」和「无权限 403」的差异会变成 vaultId 探测器。
    if (this.throttle.isLocked(clientIp)) {
      this.sendJson(res, 429, {
        success: false,
        error: '认证失败次数过多，请稍后再试',
        errorCode: 'AUTH_RATE_LIMITED'
      })
      return
    }

    const rawKey = readAccessKeyHeader(req)
    let grants = this.resolveGrants(rawKey)
    if (grants.size === 0) {
      if (!normalizeAccessKey(rawKey)) {
        if (this.legacyWindowOpen(clientIp)) {
          console.warn(`[AssetServer] ⚠️ 兼容窗口内的无凭据访问: ${clientIp} ${method} ${path}`)
          grants = new Map(
            Array.from(this.vaults.keys()).map((id) => [id, 'readonly' as PermissionLevel])
          )
        } else {
          res.setHeader('WWW-Authenticate', 'ApiKey realm="unreal-box-vault"')
          this.sendJson(res, 401, {
            success: false,
            error: '需要资产库访问码：请在资产库设置里填写主机显示的配对码',
            errorCode: 'AUTH_REQUIRED'
          })
          return
        }
      } else {
        this.throttle.recordFailure(clientIp)
        res.setHeader('WWW-Authenticate', 'ApiKey realm="unreal-box-vault"')
        this.sendJson(res, 401, {
          success: false,
          error: '资产库访问码不正确',
          errorCode: 'AUTH_INVALID'
        })
        return
      }
    } else {
      this.throttle.reset(clientIp)
    }

    try {
      // GET /api/vaults —— 只列出这把码能打开的库
      if (method === 'GET' && path === '/api/vaults') {
        const vaultList = Array.from(this.vaults.values())
          .filter((v) => grants.has(v.vaultId))
          .map((v) => ({
            vaultId: v.vaultId,
            name: v.name,
            networkPath: v.networkPath,
            permission: this.clampByIp(clientIp, grants.get(v.vaultId) as PermissionLevel)
          }))
        this.sendJson(res, 200, { success: true, data: vaultList })
        return
      }

      // /api/vaults/:vaultId/...
      const vaultMatch = path.match(/^\/api\/vaults\/([^/]+)(.*)$/)
      if (!vaultMatch) {
        this.sendJson(res, 404, { success: false, error: 'Not found' })
        return
      }

      const vaultId = decodeURIComponent(vaultMatch[1])
      const subPath = vaultMatch[2] || ''
      const vault = this.vaults.get(vaultId)
      const granted = grants.get(vaultId)

      // 凭据打不开这个库 ⇒ 与「库不存在」返回同一个响应，不做存在性泄露
      if (!vault || !granted) {
        this.sendJson(res, 404, { success: false, error: `Vault not found: ${vaultId}` })
        return
      }

      const permission = this.clampByIp(clientIp, granted)

      // 写操作权限检查
      if (['POST', 'PUT', 'DELETE'].includes(method) && !this.canWrite(permission)) {
        this.sendJson(res, 403, {
          success: false,
          error: '只读权限，无法执行写操作（需要管理码）',
          errorCode: 'PERMISSION_DENIED'
        })
        return
      }

      this.routeVaultRequest(method, subPath, url, req, res, vault, clientIp)
    } catch (err) {
      console.error('[AssetServer] HTTP 错误:', err)
      this.sendJson(res, 500, {
        success: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  /** Vault 子路由 */
  private routeVaultRequest(
    method: string,
    subPath: string,
    url: URL,
    req: http.IncomingMessage,
    res: http.ServerResponse,
    vault: VaultEntry,
    clientIp: string
  ): void {
    const db = vault.db
    const tracker = vault.tracker

    // ─── 同步相关（只读） ───

    if (method === 'GET' && subPath === '/sync') {
      const sinceSeq = parseInt(url.searchParams.get('since') || '0', 10)
      const limit = parseInt(url.searchParams.get('limit') || '5000', 10)
      const fullSyncRequired = tracker.isFullSyncRequired(sinceSeq)

      let changes: ChangeLogEntry[]
      if (fullSyncRequired && sinceSeq > 0) {
        changes = []
      } else {
        changes = tracker.getChangesSince(sinceSeq, Math.min(limit, 10000))
      }

      const response: SyncResponse = {
        changes,
        latestSeq: tracker.getLatestSeq(),
        fullSyncRequired
      }
      this.sendJson(res, 200, { success: true, data: response })
      return
    }

    if (method === 'GET' && subPath === '/checksum') {
      this.sendJson(res, 200, { success: true, data: tracker.getChecksum() })
      return
    }

    // ─── 文件夹 CRUD ───

    if (method === 'GET' && subPath === '/folders') {
      const parentKey = url.searchParams.get('parent') || null
      const sortBy =
        (url.searchParams.get('sortBy') as
          | 'assetName'
          | 'modifiedTime'
          | 'fileSize'
          | 'assetType') || 'assetName'
      const sortOrder = (url.searchParams.get('sortOrder') as 'asc' | 'desc') || 'asc'
      const folders = getAssetFoldersByFatherKey(db, parentKey, sortBy, sortOrder)
      this.sendJson(res, 200, { success: true, data: folders })
      return
    }

    if (method === 'POST' && subPath === '/folders') {
      this.readBody(req)
        .then((body) => {
          try {
            const id = createAssetFolder(db, body as AssetFolder)
            // 不能用 getAssetFolderByKey：它带 isDelete = 0，软删/恢复会读不到
            // 而退回局部 payload，对端 upsert 就会把没带的列抹成 NULL
            const created = readRowSnapshot(db, 'assetFolder', body.folderKey as string)
            const seq = tracker.record(
              'insert',
              'assetFolder',
              body.folderKey as string,
              created || body,
              clientIp
            )
            this.broadcastChange(
              vault.vaultId,
              seq,
              'insert',
              'assetFolder',
              body.folderKey as string,
              created || body
            )
            this.sendJson(res, 201, { success: true, data: { id, folderKey: body.folderKey } })
          } catch (err: unknown) {
            this.sendJson(res, 400, {
              success: false,
              error: err instanceof Error ? err.message : String(err)
            })
          }
        })
        .catch((err) => {
          this.sendJson(res, 400, {
            success: false,
            error: `请求解析失败: ${err instanceof Error ? err.message : String(err)}`
          })
        })
      return
    }

    // PUT /folders/:key
    const folderPutMatch = subPath.match(/^\/folders\/(.+)$/)
    if (method === 'PUT' && folderPutMatch) {
      const folderKey = decodeURIComponent(folderPutMatch[1])
      this.readBody(req)
        .then((updates) => {
          const oldFolder = getAssetFolderByKey(db, folderKey)
          const ok = updateAssetFolder(db, folderKey, updates)
          if (ok) {
            if (typeof updates.folderName === 'string' && oldFolder?.folderName) {
              try {
                const buildFolderPath = (currentFolderKey: string): string => {
                  const folder = getAssetFolderByKey(db, currentFolderKey)
                  if (!folder) return ''
                  if (!folder.fatherKey || folder.fatherKey === ALL_FOLDER) {
                    return folder.folderName
                  }
                  const parentPath = buildFolderPath(folder.fatherKey)
                  return parentPath ? `${parentPath}/${folder.folderName}` : folder.folderName
                }

                const oldFolderName = oldFolder.folderName
                const oldNetworkRelPath =
                  !oldFolder.fatherKey || oldFolder.fatherKey === ALL_FOLDER
                    ? oldFolderName
                    : `${buildFolderPath(oldFolder.fatherKey)}/${oldFolderName}`
                const oldNetworkPath = path.join(vault.networkPath, oldNetworkRelPath)
                const newNetworkRelPath = oldNetworkRelPath.includes('/')
                  ? oldNetworkRelPath.slice(0, oldNetworkRelPath.lastIndexOf('/') + 1) +
                    updates.folderName
                  : String(updates.folderName)
                const newNetworkPath = path.join(vault.networkPath, newNetworkRelPath)

                if (fs.existsSync(oldNetworkPath) && oldNetworkPath !== newNetworkPath) {
                  fs.renameSync(oldNetworkPath, newNetworkPath)
                }

                const folderRows = db
                  .prepare(
                    `
                  WITH RECURSIVE folder_tree AS (
                    SELECT folderKey FROM assetFolder WHERE folderKey = ?
                    UNION ALL
                    SELECT af.folderKey FROM assetFolder af
                    JOIN folder_tree ft ON af.fatherKey = ft.folderKey
                  )
                  SELECT folderKey FROM folder_tree
                `
                  )
                  .all(folderKey) as { folderKey: string }[]
                const allFolderKeys = folderRows.map((row) => row.folderKey)

                if (allFolderKeys.length > 0) {
                  const oldPathSlash = oldNetworkRelPath.replace(/\\/g, '/')
                  const newPathSlash = newNetworkRelPath.replace(/\\/g, '/')
                  const oldPathBackslash = oldNetworkRelPath.replace(/\//g, '\\')
                  const newPathBackslash = newNetworkRelPath.replace(/\//g, '\\')
                  const placeholders = allFolderKeys.map(() => '?').join(',')

                  db.prepare(
                    `UPDATE assetData SET filePath = REPLACE(filePath, ?, ?)
                   WHERE folderKey IN (${placeholders}) AND filePath LIKE ?`
                  ).run(
                    oldPathSlash + '/',
                    newPathSlash + '/',
                    ...allFolderKeys,
                    `%${oldPathSlash}/%`
                  )
                  db.prepare(
                    `UPDATE assetData SET filePath = REPLACE(filePath, ?, ?)
                   WHERE folderKey IN (${placeholders}) AND filePath LIKE ?`
                  ).run(
                    oldPathBackslash + '\\',
                    newPathBackslash + '\\',
                    ...allFolderKeys,
                    `%${oldPathBackslash}\\%`
                  )
                  db.prepare(
                    `UPDATE assetData SET originPath = REPLACE(originPath, ?, ?)
                   WHERE folderKey IN (${placeholders}) AND originPath LIKE ?`
                  ).run(
                    oldPathSlash + '/',
                    newPathSlash + '/',
                    ...allFolderKeys,
                    `%${oldPathSlash}/%`
                  )
                  db.prepare(
                    `UPDATE assetData SET originPath = REPLACE(originPath, ?, ?)
                   WHERE folderKey IN (${placeholders}) AND originPath LIKE ?`
                  ).run(
                    oldPathBackslash + '\\',
                    newPathBackslash + '\\',
                    ...allFolderKeys,
                    `%${oldPathBackslash}\\%`
                  )
                }
              } catch (renameErr) {
                console.warn('[AssetServer] folder rename sync failed:', renameErr)
              }
            }

            // 同上：整行重读必须不过滤 isDelete
            const updated = readRowSnapshot(db, 'assetFolder', folderKey)
            const seq = tracker.record(
              'update',
              'assetFolder',
              folderKey,
              updated || updates,
              clientIp
            )
            this.broadcastChange(
              vault.vaultId,
              seq,
              'update',
              'assetFolder',
              folderKey,
              updated || updates
            )
          }
          this.sendJson(res, 200, { success: ok })
        })
        .catch((err) => {
          this.sendJson(res, 400, {
            success: false,
            error: `请求解析失败: ${err instanceof Error ? err.message : String(err)}`
          })
        })
      return
    }

    // DELETE /folders/:key
    const folderDelMatch = subPath.match(/^\/folders\/(.+)$/)
    if (method === 'DELETE' && folderDelMatch) {
      const folderKey = decodeURIComponent(folderDelMatch[1])

      // 前置检查：跟节点必须存在且未删除，否则直接返回失败，不产生 change-log
      if (!isFolderActive(db, folderKey)) {
        this.sendJson(res, 200, { success: false })
        return
      }

      // 收集活动子树（仅 isDelete=0）
      const subtree = collectFolderSubtreeKeys(db, folderKey)

      // 递归软删
      deleteAssetFolder(db, folderKey)

      // 为子树中每个 folder/asset 写入 delete change 并广播
      const lastSeq = recordSubtreeDeletionChanges(
        tracker,
        subtree.folderKeys,
        subtree.assetKeys,
        clientIp
      )
      if (lastSeq > 0) {
        const totalEntries = subtree.folderKeys.length + subtree.assetKeys.length
        const firstSeq = lastSeq - totalEntries + 1
        const changes = tracker.getChangesSince(firstSeq - 1, totalEntries)
        for (const change of changes) {
          this.broadcastChange(
            vault.vaultId,
            change.seq,
            change.op as ChangeOp,
            change.tableName as TrackedTable,
            change.recordKey,
            null
          )
        }
      }
      this.sendJson(res, 200, { success: true })
      return
    }

    // ─── 资产 CRUD ───

    if (method === 'GET' && subPath === '/assets') {
      const folderKey = url.searchParams.get('folder') || 'ALL'
      const sortBy =
        (url.searchParams.get('sortBy') as
          | 'assetName'
          | 'modifiedTime'
          | 'fileSize'
          | 'assetType') || 'assetName'
      const sortOrder = (url.searchParams.get('sortOrder') as 'asc' | 'desc') || 'asc'
      const assets = getAssetDataByFolderKey(db, folderKey, sortBy, sortOrder)
      this.sendJson(res, 200, { success: true, data: assets })
      return
    }

    // GET /assets/:key
    const assetGetMatch = subPath.match(/^\/assets\/([^/]+)$/)
    if (method === 'GET' && assetGetMatch) {
      const assetKey = decodeURIComponent(assetGetMatch[1])
      const asset = getAssetDataByKey(db, assetKey)
      if (asset) {
        this.sendJson(res, 200, { success: true, data: asset })
      } else {
        this.sendJson(res, 404, { success: false, error: 'Asset not found' })
      }
      return
    }

    if (method === 'POST' && subPath === '/assets') {
      this.readBody(req)
        .then((body) => {
          try {
            createAssetData(db, body as AssetData)
            // 同上：整行重读必须不过滤 isDelete
            const created = readRowSnapshot(db, 'assetData', body.assetKey as string)
            const seq = tracker.record(
              'insert',
              'assetData',
              body.assetKey as string,
              created || body,
              clientIp
            )
            this.broadcastChange(
              vault.vaultId,
              seq,
              'insert',
              'assetData',
              body.assetKey as string,
              created || body
            )
            this.sendJson(res, 201, { success: true, data: { assetKey: body.assetKey } })
          } catch (err: unknown) {
            this.sendJson(res, 400, {
              success: false,
              error: err instanceof Error ? err.message : String(err)
            })
          }
        })
        .catch((err) => {
          this.sendJson(res, 400, {
            success: false,
            error: `请求解析失败: ${err instanceof Error ? err.message : String(err)}`
          })
        })
      return
    }

    // PUT /assets/:key
    const assetPutMatch = subPath.match(/^\/assets\/([^/]+)$/)
    if (method === 'PUT' && assetPutMatch) {
      const assetKey = decodeURIComponent(assetPutMatch[1])
      this.readBody(req)
        .then((updates) => {
          const ok = updateAssetData(db, assetKey, updates)
          if (ok) {
            // 同上：整行重读必须不过滤 isDelete —— 这正是原实现的漏洞所在，
            // 「把资产删进回收站」这种 update 会读不到行而退回局部 payload
            const updated = readRowSnapshot(db, 'assetData', assetKey)
            const seq = tracker.record(
              'update',
              'assetData',
              assetKey,
              updated || updates,
              clientIp
            )
            this.broadcastChange(
              vault.vaultId,
              seq,
              'update',
              'assetData',
              assetKey,
              updated || updates
            )
          }
          this.sendJson(res, 200, { success: ok })
        })
        .catch((err) => {
          this.sendJson(res, 400, {
            success: false,
            error: `请求解析失败: ${err instanceof Error ? err.message : String(err)}`
          })
        })
      return
    }

    // DELETE /assets/:key
    const assetDelMatch = subPath.match(/^\/assets\/([^/]+)$/)
    if (method === 'DELETE' && assetDelMatch) {
      const assetKey = decodeURIComponent(assetDelMatch[1])

      const ok = deleteAssetData(db, assetKey)
      if (ok) {
        const seq = tracker.record('delete', 'assetData', assetKey, null, clientIp)
        this.broadcastChange(vault.vaultId, seq, 'delete', 'assetData', assetKey, null)
      }
      this.sendJson(res, 200, { success: ok })
      return
    }

    // ─── 搜索 ───

    if (method === 'GET' && subPath === '/search') {
      const q = url.searchParams.get('q') || ''

      // searchAssetDataByName 现在会把「索引不存在」以外的错误抛出来（SQLITE_BUSY、
      // 中断、索引损坏），而这里是 HTTP 边界：抛上去 LAN 客户端拿到的是 500。
      // 本地正忙不该让远端整个搜不了，捞回来当空结果返回。
      let results: AssetData[] = []
      try {
        results = searchAssetDataByName(db, q, 200)
      } catch (err) {
        console.warn('[AssetServer] /search 查询失败，返回空结果:', err)
      }
      this.sendJson(res, 200, { success: true, data: results })
      return
    }

    // ─── 批量操作 ───

    if (method === 'POST' && subPath === '/batch') {
      this.readBody(req, 16 * 1024 * 1024)
        .then((body) => {
          this.handleBatchOperation(vault, body as any, clientIp, res)
        })
        .catch((err) => {
          this.sendJson(res, 400, {
            success: false,
            error: `请求解析失败: ${err instanceof Error ? err.message : String(err)}`
          })
        })
      return
    }

    // ─── 全量数据拉取（keyset cursor 分页） ───

    if (method === 'GET' && subPath === '/full-data') {
      const type = url.searchParams.get('type') as 'folders' | 'assets' | null
      const cursor = parseInt(url.searchParams.get('cursor') || '0', 10)
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '2000', 10), 5000)

      if (!type) {
        this.sendJson(res, 400, {
          success: false,
          error: '缺少 type 参数，请使用: /full-data?type=folders&cursor=0'
        })
        return
      }

      try {
        const tableName = type === 'folders' ? 'assetFolder' : 'assetData'

        let snapshotMaxRowid: number
        let snapshotSeq: number
        if (cursor === 0) {
          snapshotMaxRowid = (
            db
              .prepare(`SELECT COALESCE(MAX(rowid), 0) AS m FROM ${tableName} WHERE isDelete = 0`)
              .get() as { m: number }
          ).m
          snapshotSeq = tracker.getLatestSeq()
        } else {
          snapshotMaxRowid = parseInt(url.searchParams.get('maxRowid') || '0', 10)
          snapshotSeq = parseInt(url.searchParams.get('snapshotSeq') || '0', 10)
        }

        const rows = db
          .prepare(
            `SELECT rowid AS _rowid, * FROM ${tableName} WHERE rowid > ? AND rowid <= ? AND isDelete = 0 ORDER BY rowid LIMIT ?`
          )
          .all(cursor, snapshotMaxRowid, limit) as Record<string, unknown>[]

        const nextCursor = rows.length > 0 ? (rows[rows.length - 1] as any)._rowid : cursor
        const hasMore = rows.length === limit

        const total = (
          db
            .prepare(`SELECT COUNT(*) AS c FROM ${tableName} WHERE isDelete = 0 AND rowid <= ?`)
            .get(snapshotMaxRowid) as { c: number }
        ).c

        this.sendJson(res, 200, {
          success: true,
          data: {
            rows,
            type,
            cursor: nextCursor,
            hasMore,
            total,
            snapshotMaxRowid,
            snapshotSeq
          }
        })
      } catch (err) {
        this.sendJson(res, 500, {
          success: false,
          error: `全量查询失败: ${err instanceof Error ? err.message : String(err)}`
        })
      }
      return
    }

    // ─── 文件系统扫描 ───

    if (method === 'POST' && subPath === '/scan') {
      // 每次请求现取：Server 可能比 IPC 注册更早起来（见 registerVaultScanHandler）
      const scanHandler = getVaultScanHandler()
      if (!scanHandler) {
        this.sendJson(res, 501, { success: false, error: '扫描功能未配置' })
        return
      }

      // 互斥锁在扫描实现里（withVaultScanLock），本机 IPC 那条路径共用同一把；
      // 这里只负责把「已有扫描在跑」翻成 409
      scanHandler(vault)
        .then((result) => {
          this.sendJson(res, 200, { success: true, data: result })
        })
        .catch((err) => {
          if (err instanceof VaultScanBusyError) {
            this.sendJson(res, 409, { success: false, error: err.message })
            return
          }
          this.sendJson(res, 500, {
            success: false,
            error: `扫描失败: ${err instanceof Error ? err.message : String(err)}`
          })
        })
      return
    }

    const filesMatch = subPath.match(/^\/files\/(.+)$/)
    if (filesMatch) {
      const relativePath = decodeURIComponent(filesMatch[1])

      // Fix #2: 检查是否为内部控制文件
      if (this.isInternalFile(relativePath)) {
        this.sendJson(res, 403, { success: false, error: 'Access to internal file denied' })
        return
      }

      const absolutePath = this.resolveVaultFilePath(vault, relativePath)

      if (!absolutePath) {
        this.sendJson(res, 403, { success: false, error: 'Path traversal denied' })
        return
      }

      if (method === 'PUT') {
        // 流式接收 + 原子写入（tmp + rename），与 standalone 保持一致
        const targetDir = path.dirname(absolutePath)
        fs.mkdirSync(targetDir, { recursive: true })

        const tmpPath = absolutePath + '.tmp.' + Date.now()
        const writeStream = fs.createWriteStream(tmpPath)

        // 🔧 服务端上传超时：5分钟无数据传入则中止，防止僵死连接
        const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000
        const resetTimer = (): ReturnType<typeof setTimeout> =>
          setTimeout(() => {
            console.warn(`[AssetServer] ⏰ 文件上传超时: ${relativePath}`)
            writeStream.destroy()
            req.destroy()
            try {
              fs.unlinkSync(tmpPath)
            } catch {
              /* ignore */
            }
            this.sendJson(res, 408, { success: false, error: 'Upload timeout' })
          }, UPLOAD_TIMEOUT_MS)
        let uploadTimer: ReturnType<typeof setTimeout> | null = resetTimer()

        // 每次收到数据时重置超时计时器
        req.on('data', () => {
          if (uploadTimer) {
            clearTimeout(uploadTimer)
            uploadTimer = resetTimer()
          }
        })

        writeStream.on('error', (err) => {
          if (uploadTimer) {
            clearTimeout(uploadTimer)
            uploadTimer = null
          }
          try {
            fs.unlinkSync(tmpPath)
          } catch {
            /* ignore */
          }
          this.sendJson(res, 500, {
            success: false,
            error: `Write failed: ${err.message}`
          })
        })

        req.on('error', (err) => {
          if (uploadTimer) {
            clearTimeout(uploadTimer)
            uploadTimer = null
          }
          writeStream.destroy()
          try {
            fs.unlinkSync(tmpPath)
          } catch {
            /* ignore */
          }
          this.sendJson(res, 500, {
            success: false,
            error: `Upload stream error: ${err.message}`
          })
        })

        req.pipe(writeStream)

        writeStream.on('finish', () => {
          if (uploadTimer) {
            clearTimeout(uploadTimer)
            uploadTimer = null
          }
          try {
            fs.renameSync(tmpPath, absolutePath)
            this.sendJson(res, 200, {
              success: true,
              data: { path: relativePath }
            })
          } catch (renameErr) {
            try {
              fs.unlinkSync(tmpPath)
            } catch {
              /* ignore */
            }
            this.sendJson(res, 500, {
              success: false,
              error: `Rename failed: ${renameErr instanceof Error ? renameErr.message : String(renameErr)}`
            })
          }
        })
        return
      }

      if (method === 'GET') {
        if (!fs.existsSync(absolutePath)) {
          this.sendJson(res, 404, { success: false, error: 'File not found' })
          return
        }

        try {
          const stat = fs.statSync(absolutePath)
          res.writeHead(200, {
            'Content-Type': this.getMimeType(absolutePath),
            'Content-Length': stat.size,
            'Cache-Control': 'public, max-age=86400'
          })
          const stream = fs.createReadStream(absolutePath)
          stream.pipe(res)
          stream.on('error', () => {
            if (!res.headersSent) {
              this.sendJson(res, 500, { success: false, error: 'Failed to read file' })
            }
          })
        } catch (err) {
          this.sendJson(res, 500, {
            success: false,
            error: err instanceof Error ? err.message : String(err)
          })
        }
        return
      }
    }

    // 404
    this.sendJson(res, 404, { success: false, error: `Unknown route: ${subPath}` })
  }

  /** 批量操作 */
  private handleBatchOperation(
    vault: VaultEntry,
    body: {
      operations: Array<{ type: string; table: TrackedTable; data: Record<string, unknown> }>
    },
    clientIp: string,
    res: http.ServerResponse
  ): void {
    if (!body.operations || !Array.isArray(body.operations)) {
      this.sendJson(res, 400, { success: false, error: 'Missing operations array' })
      return
    }

    const db = vault.db
    const tracker = vault.tracker
    const results: Array<{ success: boolean; seq?: number }> = []
    // 收集待广播数据，事务提交后再执行 WS 广播（避免 IO 持有 SQLite 锁）
    const pendingBroadcasts: Array<{
      seq: number
      op: ChangeOp
      table: TrackedTable
      key: string
      payload: Record<string, unknown> | null
    }> = []

    const tx = db.transaction(() => {
      for (const op of body.operations) {
        try {
          let recordKey = ''
          let changeOp: ChangeOp = 'insert'

          if (op.type === 'insert' && op.table === 'assetData') {
            createAssetData(db, op.data as AssetData)
            recordKey = op.data.assetKey as string
            changeOp = 'insert'
          } else if (op.type === 'insert' && op.table === 'assetFolder') {
            createAssetFolder(db, op.data as AssetFolder)
            recordKey = op.data.folderKey as string
            changeOp = 'insert'
          } else if (op.type === 'update' && op.table === 'assetData') {
            updateAssetData(db, op.data.assetKey as string, op.data)
            recordKey = op.data.assetKey as string
            changeOp = 'update'
          } else if (op.type === 'delete' && op.table === 'assetData') {
            deleteAssetData(db, op.data.assetKey as string)
            recordKey = op.data.assetKey as string
            changeOp = 'delete'
          }

          if (recordKey) {
            // 原来直接回声 op.data —— 那是调用方发来的**局部**字段，
            // 对端 upsert 会把没带的列抹成 NULL。改成重读整行。
            const payload =
              changeOp === 'delete' ? null : (readRowSnapshot(db, op.table, recordKey) ?? op.data)
            const seq = tracker.record(changeOp, op.table, recordKey, payload, clientIp)
            pendingBroadcasts.push({
              seq,
              op: changeOp,
              table: op.table,
              key: recordKey,
              payload
            })
            results.push({ success: true, seq })
          }
        } catch {
          results.push({ success: false })
        }
      }
    })

    try {
      tx()
      // 事务已提交，安全地执行 WS 广播
      for (const pb of pendingBroadcasts) {
        this.broadcastChange(vault.vaultId, pb.seq, pb.op, pb.table, pb.key, pb.payload)
      }
      this.sendJson(res, 200, { success: true, data: { results, count: results.length } })
    } catch (err) {
      this.sendJson(res, 500, {
        success: false,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  // ─────────────────────────── WebSocket ───────────────────────────

  /**
   * WS 握手准入。
   *
   * ⚠️ WS 握手**完全不受 CORS 约束** —— 原来那个 Access-Control-Allow-Origin
   * 对这条路径从来没起过任何作用，任何网页都能直接连上订阅全部变更推送。
   * 所以这里必须自己把三道门都检一遍，而且要在 handleUpgrade 之前。
   */
  private handleWsUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer): void {
    const clientIp = req.socket.remoteAddress?.replace('::ffff:', '') || 'unknown'

    const refuse = (status: number, reason: string): void => {
      try {
        socket.write(
          `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
        )
      } catch {
        // socket 已断开
      }
      socket.destroy()
    }

    if (!isHostHeaderAllowed(req.headers.host, this.allowedHostnames)) {
      return refuse(403, 'Forbidden')
    }
    // 浏览器发起的 WS 一定带 Origin；我们的 Node ws 客户端不带
    if (isBrowserOriginated(req)) {
      return refuse(403, 'Forbidden')
    }
    if (this.throttle.isLocked(clientIp)) {
      return refuse(429, 'Too Many Requests')
    }

    const rawKey = readAccessKeyHeader(req)
    const grants = this.resolveGrants(rawKey)

    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const vaultId = url.searchParams.get('vaultId') || ''

    let permitted = grants.has(vaultId)
    if (!permitted && !normalizeAccessKey(rawKey) && this.legacyWindowOpen(clientIp)) {
      permitted = this.vaults.has(vaultId)
      if (permitted) console.warn(`[AssetServer] ⚠️ 兼容窗口内的无凭据 WS: ${clientIp}`)
    }

    if (!permitted) {
      if (normalizeAccessKey(rawKey)) this.throttle.recordFailure(clientIp)
      return refuse(401, 'Unauthorized')
    }
    this.throttle.reset(clientIp)

    if (!this.vaults.has(vaultId)) {
      return refuse(404, 'Not Found')
    }

    this.wss!.handleUpgrade(req, socket, head, (ws) => {
      this.handleWsConnection(ws, req)
    })
  }

  private handleWsConnection(ws: WebSocket, req: http.IncomingMessage): void {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
    const vaultId = url.searchParams.get('vaultId') || ''
    const clientId = url.searchParams.get('clientId') || `anon_${Date.now()}`
    const hostname = url.searchParams.get('hostname') || 'unknown'
    const ip = req.socket.remoteAddress?.replace('::ffff:', '') || 'unknown'

    if (!this.vaults.has(vaultId)) {
      ws.close(4004, 'vault_not_found')
      return
    }

    // 复合 key：同一客户端可以同时连接多个 Vault
    const wsKey = `${clientId}:${vaultId}`

    // 若同一 clientId 对同一 Vault 已有连接，先关闭旧连接
    const existing = this.wsClients.get(wsKey)
    if (existing) {
      if (this.shouldLogWs(wsKey, 'dup')) {
        console.log(`[AssetServer] WS 重复 ${wsKey}，关闭旧连接`)
      }
      existing.ws.close(4000, 'replaced_by_new_connection')
    }

    const wsClient: WsClient = { ws, clientId, vaultId, ip, hostname }
    this.wsClients.set(wsKey, wsClient)

    const vault = this.vaults.get(vaultId)!
    vault.tracker.upsertClient(clientId, hostname, ip, 0)

    if (this.shouldLogWs(wsKey, 'conn')) {
      console.log(`[AssetServer] WS 连接: ${clientId} (${hostname}@${ip}) → Vault ${vaultId}`)
    }

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'ping') {
          vault.tracker.updateClientSeq(clientId, msg.lastSeq || 0)
          const pong: WsServerMessage = { type: 'pong', latestSeq: vault.tracker.getLatestSeq() }
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(pong))
          }
        }
      } catch {
        // 忽略无效消息
      }
    })

    ws.on('close', () => {
      const current = this.wsClients.get(wsKey)
      if (current && current.ws === ws) {
        this.wsClients.delete(wsKey)
      }
      if (this.shouldLogWs(wsKey, 'close')) {
        console.log(`[AssetServer] WS 断开: ${clientId}`)
      }
    })

    ws.on('error', (err) => {
      console.warn(`[AssetServer] WS 错误 (${clientId}):`, err.message)
    })
  }

  /** 广播变更给订阅了指定 Vault 的所有 WS Client */
  broadcastChange(
    vaultId: string,
    seq: number,
    op: ChangeOp,
    tableName: TrackedTable,
    recordKey: string,
    payload: Record<string, unknown> | null
  ): void {
    const msg: WsChangeMessage = {
      type: 'change',
      seq,
      op,
      tableName,
      recordKey,
      payload: payload ? JSON.stringify(payload) : null,
      clientId: 'server'
    }
    const msgStr = JSON.stringify(msg)

    this.wsClients.forEach((client) => {
      if (client.vaultId === vaultId && client.ws.readyState === WebSocket.OPEN) {
        client.ws.send(msgStr, (err) => {
          if (err) {
            console.warn(`[AssetServer] WS 发送失败 (${client.clientId}):`, err.message)
          }
        })
      }
    })
  }

  /**
   * WS 日志节流：同一 wsKey+event 在 WS_LOG_INTERVAL_MS 内只输出一次
   */
  private shouldLogWs(wsKey: string, event: string): boolean {
    const throttleKey = `${wsKey}:${event}`
    const now = Date.now()
    const last = this.wsLogThrottle.get(throttleKey) || 0
    if (now - last < AssetServer.WS_LOG_INTERVAL_MS) return false
    this.wsLogThrottle.set(throttleKey, now)
    if (this.wsLogThrottle.size > 500) {
      for (const [k, t] of this.wsLogThrottle) {
        if (now - t > 60_000) this.wsLogThrottle.delete(k)
      }
    }
    return true
  }

  // ─────────────────────────── 工具 ───────────────────────────

  private sendJson(
    res: http.ServerResponse,
    status: number,
    body: { success: boolean; data?: unknown; error?: string; errorCode?: AuthErrorCode | string }
  ): void {
    if (res.headersSent) return
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end(JSON.stringify(body))
  }

  private readBody(
    req: http.IncomingMessage,
    maxBytes = 4 * 1024 * 1024
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      let totalSize = 0
      let settled = false
      req.on('data', (chunk: Buffer) => {
        if (settled) return
        totalSize += chunk.length
        if (totalSize > maxBytes) {
          settled = true
          req.destroy()
          reject(new Error(`Request body too large (limit: ${maxBytes} bytes)`))
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        if (settled) return
        settled = true
        try {
          const raw = Buffer.concat(chunks).toString('utf-8')
          resolve(raw ? JSON.parse(raw) : {})
        } catch (err) {
          reject(err)
        }
      })
      req.on('error', (err) => {
        if (settled) return
        settled = true
        reject(err)
      })
    })
  }

  /** 检查文件路径是否涉及内部控制文件或目录 */
  private isInternalFile(relativePath: string): boolean {
    // 检查路径中每个 segment，拦截 .vault* 目录及其内部文件
    const segments = relativePath.replace(/\\/g, '/').split('/').filter(Boolean)
    return segments.some((seg) => {
      const lower = seg.toLowerCase()
      return INTERNAL_BLOCKED_FILES.has(lower) || lower.startsWith('.vault')
    })
  }

  /**
   * 安全路径解析：将 vault-relative 路径解析为绝对路径
   * 使用 realpath walk-up 支持 PUT 新文件（文件本身不存在，但父目录必须存在且在 vault 内）
   */
  private resolveVaultFilePath(vault: VaultEntry, relativePath: string): string | null {
    const absolutePath = path.resolve(vault.networkPath, relativePath)
    const vaultRoot = path.resolve(vault.networkPath)

    // 快速路径：文件已存在 → 用 realpath 验证不是符号链接逃逸
    if (fs.existsSync(absolutePath)) {
      try {
        const realPath = fs.realpathSync(absolutePath)
        const realRoot = fs.realpathSync(vaultRoot)
        if (!realPath.startsWith(realRoot + path.sep) && realPath !== realRoot) {
          return null
        }
        return realPath
      } catch {
        return null
      }
    }

    // Walk-up：文件不存在（PUT 新文件）→ 找到最近的已存在祖先目录并验证
    let checkPath = path.dirname(absolutePath)
    while (checkPath !== path.dirname(checkPath)) {
      if (fs.existsSync(checkPath)) {
        try {
          const realDir = fs.realpathSync(checkPath)
          const realRoot = fs.realpathSync(vaultRoot)
          if (!realDir.startsWith(realRoot + path.sep) && realDir !== realRoot) {
            return null
          }
          return absolutePath
        } catch {
          return null
        }
      }
      checkPath = path.dirname(checkPath)
    }
    return null
  }

  private getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase()
    const mimeTypes: Record<string, string> = {
      '.png': 'image/png',
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
      '.bmp': 'image/bmp',
      '.svg': 'image/svg+xml',
      '.pdf': 'application/pdf',
      '.mp4': 'video/mp4',
      '.webm': 'video/webm',
      '.mp3': 'audio/mpeg',
      '.wav': 'audio/wav',
      '.ogg': 'video/ogg',
      '.flac': 'audio/flac',
      '.aac': 'audio/aac',
      '.m4a': 'audio/mp4',
      '.glb': 'model/gltf-binary',
      '.gltf': 'model/gltf+json',
      '.obj': 'text/plain',
      '.fbx': 'application/octet-stream',
      '.json': 'application/json',
      '.uworkflow': 'application/json',
      '.md': 'text/markdown; charset=utf-8',
      '.xml': 'application/xml',
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.ts': 'text/plain; charset=utf-8',
      '.txt': 'text/plain'
    }
    return mimeTypes[ext] || 'application/octet-stream'
  }
}
