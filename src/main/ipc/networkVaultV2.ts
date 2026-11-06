/**
 * networkVaultV2.ts — V2 网络协作库 IPC 处理器
 *
 * 核心职责：
 *  - 前端调用 `networkVaultV2:*` 通道，后端自动分流到 Server / Client 模式
 *  - 读操作 → 本地 SQLite（Server = vault-data.db；Client = 本地缓存 db）
 *  - 写操作 → Server 模式直写 + ChangeTracker 记录；Client 模式代理到 HTTP API
 *  - WebSocket 变更 → `BrowserWindow.webContents.send('asset:changed')` 通知渲染进程
 *
 * 设计原则：
 *  - 前端不感知 Server / Client 差异，所有 IPC 接口保持一致
 *  - 与 v1 `networkVault.ts` 完全隔离，不存在交叉引用
 */
import { ipcMain } from 'electron'
import { getAppWindows } from '../appWindows'
import Database from 'better-sqlite3'
import { VaultServiceManager, serverUrlOfState } from '../networkV2/VaultServiceManager'
import type { NetworkVaultState } from '../networkV2/VaultServiceManager'
import { rememberVaultAccessKey, resolveVaultAccessKey } from '../networkV2/vaultAccessKeys'
import { authStatusOf } from '../networkV2/SyncClient'
import { recordAndBroadcast } from '../networkV2/rowSnapshot'
import { VaultManager, VaultType } from '../sqliteDataBase/VaultManager'
import type { ChangeOp, TrackedTable } from '../networkV2/SyncProtocol'
import { registerVaultScanHandler, withVaultScanLock } from '../networkV2/AssetServer'
import {
  isFolderActive,
  collectFolderSubtreeKeys,
  recordSubtreeDeletionChanges as recordSubtreeChanges
} from '../networkV2/folderDeleteHelper'
import { promises as fsPromises, existsSync, mkdirSync } from 'fs'
import { join, relative, extname, basename, isAbsolute, resolve, sep } from 'path'
import { SCAN_EXCLUDE_DIRS, SCAN_EXCLUDE_FILES, THUMBNAILS_DIR } from '../smb/NetworkVaultTypes'
import { ScannerFilter } from '../utils/vaultPathNormalize'
import {
  createAssetData,
  getAssetDataByKey,
  getDeletedAssetData,
  restoreAssetData
} from '../sqliteDataBase/models/assetData'
import type { AssetData } from '../sqliteDataBase/models/assetData'
import { withAssetReplaceGuard } from '../sqliteDataBase/models/assetSearchIndex'
import {
  createAssetFolder,
  getAssetFolderByNameAndParent,
  getAssetFolderByKey,
  deleteAssetFolder
} from '../sqliteDataBase/models/assetFolder'
import type { AssetFolder } from '../sqliteDataBase/models/assetFolder'
import { getAssetClassNameCn, getAssetClassColor } from '../utils/assetClassUtils'
import ThumbnailManager from '../utils/ThumbnailManager'

// ─────────────────────── 工具函数 ───────────────────────

/** 统一返回格式 */
function ok<T>(data?: T) {
  return { success: true as const, data }
}
function fail(error: string) {
  return { success: false as const, error }
}

/**
 * V2 变更同步：记录到 change_log 并通过 WebSocket 广播给已连接 Client
 * 此函数应在每次 Server 模式直写 SQLite 后调用
 */
function syncToV2ChangeLog(
  vsm: VaultServiceManager,
  vaultId: string,
  op: ChangeOp,
  tableName: TrackedTable,
  recordKey: string,
  payload: Record<string, unknown> | null
): void {
  try {
    const server = vsm.getServer()
    if (!server) return
    // payload 由 recordAndBroadcast **重读整行**产生 —— 调用方传的是局部
    // updates，直接当整行广播会让对端 upsert 把没带的列写成 NULL/''
    recordAndBroadcast({
      server,
      vaultId,
      op,
      tableName,
      recordKey,
      fallbackPayload: payload
    })
  } catch (err) {
    console.warn('[syncToV2ChangeLog] 变更同步失败:', err)
  }
}

/** 广播资产变更到盒子自己的渲染窗口（不含 Agent 浏览器） */
function broadcastToRenderer(channel: string, payload: unknown): void {
  for (const win of getAppWindows()) {
    if (!win.isDestroyed()) {
      win.webContents.send(channel, payload)
    }
  }
}

type DeletedAssetRow = {
  assetKey: string
  filePath?: string | null
  originPath?: string | null
  imgLocalPath?: string | null
}

/** 获取 VaultManager 指定 vault 的 DB */
function getVaultDatabase(vaultId: string): Database.Database | null {
  const vm = VaultManager.getInstance()
  const current = vm.getCurrentVault()
  if (current && current.id === vaultId) {
    return vm.getCurrentVaultDatabase()
  }
  return null
}

function getCurrentVaultNetworkRoot(vaultId: string): string | null {
  const vm = VaultManager.getInstance()
  const current = vm.getCurrentVault()
  if (!current || current.id !== vaultId) return null

  const root = typeof current.networkPath === 'string' ? current.networkPath.trim() : ''
  if (!root || /^https?:\/\//i.test(root)) return null
  return resolve(root)
}

function isPathInsideRoot(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`)
}

function resolveDeletedAssetFilePath(
  vaultRoot: string | null,
  row: DeletedAssetRow
): string | null {
  if (!vaultRoot) return null

  for (const rawCandidate of [row.originPath, row.filePath]) {
    const candidate = String(rawCandidate || '').trim()
    if (!candidate) continue

    const absolutePath = isAbsolute(candidate) ? resolve(candidate) : resolve(vaultRoot, candidate)
    if (isPathInsideRoot(vaultRoot, absolutePath)) {
      return absolutePath
    }
  }

  return null
}

async function deleteDeletedAssetArtifacts(
  vaultRoot: string | null,
  row: DeletedAssetRow
): Promise<{ deletedFile: boolean }> {
  let deletedFile = false

  const absoluteAssetPath = resolveDeletedAssetFilePath(vaultRoot, row)
  if (absoluteAssetPath) {
    try {
      await fsPromises.unlink(absoluteAssetPath)
      deletedFile = true
    } catch (err: any) {
      if (!err || (err.code !== 'ENOENT' && err.code !== 'ENOTDIR')) {
        throw err
      }
    }
  }

  const thumbnailName =
    ThumbnailManager.extractFilenameFromFileUrl(row.imgLocalPath || undefined) ||
    row.imgLocalPath ||
    null
  if (thumbnailName) {
    await ThumbnailManager.deleteVaultThumbnailByFilename(thumbnailName)
  }

  return { deletedFile }
}

/**
 * IPC 专用：为文件夹子树删除记录 change log 并通过 WebSocket 广播
 * 委托 folderDeleteHelper 完成 recordBatch，然后用 AssetServer 广播
 */
function recordSubtreeDeletionChanges(
  vsm: VaultServiceManager,
  vaultId: string,
  folderKeys: string[],
  assetKeys: string[]
): void {
  try {
    const server = vsm.getServer()
    if (!server) return
    const entry = server.getVaultEntry(vaultId)
    if (!entry) return

    const totalEntries = folderKeys.length + assetKeys.length
    if (totalEntries === 0) return

    // 委托共享 helper 批量写入 change log
    const lastSeq = recordSubtreeChanges(entry.tracker, folderKeys, assetKeys)
    if (lastSeq === 0) return

    // 广播每条变更给 WebSocket 连接的 peer
    const firstSeq = lastSeq - totalEntries + 1
    const changes = entry.tracker.getChangesSince(firstSeq - 1, totalEntries)
    for (const change of changes) {
      server.broadcastChange(
        vaultId,
        change.seq,
        change.op as ChangeOp,
        change.tableName as TrackedTable,
        change.recordKey,
        null
      )
    }
  } catch (err) {
    console.warn('[recordSubtreeDeletionChanges] 变更记录失败:', err)
  }
}

// ─────────────────────── 共享扫描逻辑 ───────────────────────

/**
 * Server 模式文件扫描的唯一入口 —— 由 IPC `networkVaultV2:scan`（本机主机）和
 * HTTP `POST /scan`（远程可写客户端）共用。
 *
 * 可达性检查和互斥锁都放在这里，不放在各自的调用处：
 *  - 共享盘掉线时 `collectFiles` 把 readdir 失败吞成 `failedDirs++`，扫不到文件
 *    就按「没有新文件」正常返回，远程客户端读到的是「扫描完成」—— 假成功。
 *  - 两条路径各管一把锁等于没锁：同时点「刷新」会把同一个文件入两遍库。
 *
 * 失败一律抛异常：IPC 那条由外层 catch 转成 `fail(message)`，HTTP 那条由
 * AssetServer 转成 500（扫描已在跑时是 409）。
 */
async function performServerScan(
  vsm: VaultServiceManager,
  vaultId: string,
  db: Database.Database,
  networkPath: string
): Promise<Record<string, unknown>> {
  if (!networkPath || !existsSync(networkPath)) {
    throw new Error('网络路径不可访问')
  }
  return withVaultScanLock(vaultId, () => runServerScan(vsm, vaultId, db, networkPath))
}

async function runServerScan(
  vsm: VaultServiceManager,
  vaultId: string,
  db: Database.Database,
  networkPath: string
): Promise<Record<string, unknown>> {
  console.log(`[V2-Scan] 开始扫描: ${networkPath}`)
  const scanStart = Date.now()

  // ─── 阶段 1：快速目录遍历 ───
  const scannedFiles: { fullPath: string; relativePath: string; dirPath: string }[] = []
  let failedDirs = 0

  const collectFiles = async (dir: string, relDir: string): Promise<void> => {
    try {
      const entries = await fsPromises.readdir(dir, { withFileTypes: true })
      for (const entry of entries) {
        const fullPath = join(dir, entry.name)
        if (entry.isDirectory()) {
          if (!SCAN_EXCLUDE_DIRS.includes(entry.name) && !entry.name.startsWith('.vault')) {
            const childRelDir = relDir ? `${relDir}/${entry.name}` : entry.name
            await collectFiles(fullPath, childRelDir)
          }
        } else if (entry.isFile()) {
          if (!SCAN_EXCLUDE_FILES.includes(entry.name) && !entry.name.startsWith('.')) {
            scannedFiles.push({
              fullPath,
              relativePath: relative(networkPath, fullPath).replace(/\\/g, '/'),
              dirPath: relDir || 'ALL'
            })
          }
        }
      }
    } catch {
      failedDirs++
    }
  }
  await collectFiles(networkPath, '')
  console.log(`[V2-Scan] 阶段1: 扫描到 ${scannedFiles.length} 个文件, ${failedDirs} 个目录失败`)

  // --- 阶段 2：去重（按 Option B 语义隔离） ---
  const allRows = db.prepare(`SELECT filePath, originPath, isDelete FROM assetData`).all() as {
    filePath: string | null
    originPath: string | null
    isDelete: number
  }[]

  const filter = new ScannerFilter(allRows, networkPath)
  const newFiles = filter.filterNewFiles(scannedFiles)

  console.log(
    `[V2-Scan] 阶段2: 已知路径 ${filter.getKnownCount()} (防复活: ${filter.getSoftDeletedCount()}), 新文件需要入库: ${newFiles.length} 个`
  )
  console.log(`[V2-Scan] 阶段2: ${newFiles.length} 个新文件需要入库`)

  if (newFiles.length === 0) {
    return {
      newAssets: 0,
      newFolders: 0,
      totalScanned: scannedFiles.length,
      failedDirs,
      // 有目录读失败就不是一次完整的扫描：调用方据此告诉用户「部分目录未读取」，
      // 不能一律报「扫描完成」
      partial: failedDirs > 0,
      durationMs: Date.now() - scanStart
    }
  }

  // ─── 阶段 3：文件夹层级同步 ───
  const folderCache = new Map<string, string>()
  folderCache.set('ALL', 'ALL')
  let newFoldersCount = 0

  const ensureFolderHierarchy = (relDirPath: string): string => {
    if (!relDirPath || relDirPath === 'ALL') return 'ALL'

    const cached = folderCache.get(relDirPath)
    if (cached) return cached

    const parts = relDirPath.split('/')
    let parentKey = 'ALL'
    let currentRelPath = ''

    for (const part of parts) {
      currentRelPath = currentRelPath ? `${currentRelPath}/${part}` : part

      const cachedKey = folderCache.get(currentRelPath)
      if (cachedKey) {
        parentKey = cachedKey
        continue
      }

      const parentForQuery = parentKey === 'ALL' ? null : parentKey
      const existing = getAssetFolderByNameAndParent(db, part, parentForQuery)
      if (existing) {
        folderCache.set(currentRelPath, existing.folderKey)
        parentKey = existing.folderKey
        continue
      }

      const folderKey = `folder_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`
      const folderData: AssetFolder = {
        folderKey,
        fatherKey: parentKey === 'ALL' ? 'ALL' : parentKey,
        type: 'folder',
        folderName: part,
        img: ''
      }
      createAssetFolder(db, folderData)

      const created = getAssetFolderByKey(db, folderKey)
      syncToV2ChangeLog(
        vsm,
        vaultId,
        'insert',
        'assetFolder',
        folderKey,
        (created || folderData) as unknown as Record<string, unknown>
      )

      folderCache.set(currentRelPath, folderKey)
      parentKey = folderKey
      newFoldersCount++
    }

    return parentKey
  }

  // ─── 阶段 4：资产入库 ───
  const thumbDir = join(networkPath, THUMBNAILS_DIR)
  if (!existsSync(thumbDir)) {
    mkdirSync(thumbDir, { recursive: true })
  }

  let newAssetsCount = 0
  let parseErrors = 0

  let unrealProcessor: any = null
  const getUnrealProcessor = async () => {
    if (!unrealProcessor) {
      const { UnrealAssetProcessor } = await import('../utils/fileProcessor/UnrealAssetProcessor')
      unrealProcessor = new UnrealAssetProcessor()
    }
    return unrealProcessor
  }

  const changeLogEntries: Array<{
    op: ChangeOp
    tableName: TrackedTable
    recordKey: string
    payload: Record<string, unknown> | null
    clientId?: string
  }> = []

  for (const file of newFiles) {
    try {
      // 纵深防御：检查该文件是否对应已被用户按照 Option B 语义软删除的老资产。
      if (filter.isSoftDeleted(file.relativePath)) {
        continue // 用户已删除，拦截它变作新的复活实体
      }

      const ext = extname(file.fullPath).slice(1).toLowerCase()
      const fileName = basename(file.fullPath)
      const nameWithoutExt = basename(file.fullPath, extname(file.fullPath))
      const folderKey = ensureFolderHierarchy(file.dirPath)
      const assetKey = `scan_${Date.now()}_${Math.random().toString(36).substr(2, 8)}`

      let fileSize = 0
      try {
        const stat = await fsPromises.stat(file.fullPath)
        fileSize = stat.size
      } catch {
        /* 忽略 stat 失败 */
      }

      const assetData: AssetData = {
        assetKey,
        folderKey,
        assetName: fileName,
        filePath: file.relativePath,
        originPath: file.fullPath,
        fileSize,
        fileExtension: ext,
        modifiedTime: new Date().toISOString(),
        processorType: 'scan',
        isDelete: 0,
        isDependency: 0,
        name: nameWithoutExt,
        ext,
        classKey: ext
      }

      if (ext === 'uasset' || ext === 'umap') {
        try {
          const processor = await getUnrealProcessor()
          const metadata = await processor.processFile(file.fullPath)

          if (metadata && metadata.assetType !== 'InvalidAsset') {
            const normalized = metadata.metadata || {}
            assetData.className = normalized.className || metadata.assetType
            assetData.classNameCn = getAssetClassNameCn(assetData.className)
            assetData.classColor = getAssetClassColor(assetData.className)
            assetData.engineVersion = normalized.engineVersion || metadata.engineVersion
            assetData.softPath = normalized.softPath
            assetData.assetClass = normalized.assetClass
            assetData.classKey = ext === 'umap' ? 'umap' : 'uasset'
            assetData.assetType = metadata.assetType

            if (normalized.imports) {
              assetData.imports =
                typeof normalized.imports === 'string'
                  ? normalized.imports
                  : JSON.stringify(normalized.imports)
            }

            if (normalized.imgLocalPath) {
              const thumbFileName = normalized.imgLocalPath as string
              const { PathManager } = await import('../utils/PathManager')
              const pm = PathManager.getInstance()
              const srcThumbPath = pm.getThumbnailFilePath(thumbFileName)
              const dstThumbPath = join(thumbDir, thumbFileName)

              try {
                if (existsSync(srcThumbPath) && srcThumbPath !== dstThumbPath) {
                  await fsPromises.copyFile(srcThumbPath, dstThumbPath)
                }
              } catch {
                /* 缩略图复制失败不影响入库 */
              }
              assetData.imgLocalPath = thumbFileName
            }
          }
        } catch (parseErr) {
          console.warn(`[V2-Scan] 解析失败 ${file.fullPath}:`, parseErr)
          parseErrors++
          assetData.className = 'Asset'
          assetData.classNameCn = getAssetClassNameCn('Asset')
          assetData.classColor = getAssetClassColor('Asset')
        }
      } else {
        const imageExts = ['png', 'jpg', 'jpeg', 'bmp', 'tga', 'hdr', 'exr', 'webp', 'gif']
        const audioExts = ['wav', 'mp3', 'ogg', 'flac', 'aac']
        if (imageExts.includes(ext)) {
          assetData.className = 'Texture2D'
          assetData.classNameCn = getAssetClassNameCn('Texture2D')
          assetData.classColor = getAssetClassColor('Texture2D')
        } else if (audioExts.includes(ext)) {
          assetData.className = 'SoundWave'
          assetData.classNameCn = getAssetClassNameCn('SoundWave')
          assetData.classColor = getAssetClassColor('SoundWave')
        } else if (ext === 'uplugin') {
          assetData.className = 'Plugin'
          assetData.classNameCn = '插件'
        } else if (ext === 'uproject') {
          assetData.className = 'Project'
          assetData.classNameCn = '项目'
        } else {
          assetData.className = ext.toUpperCase()
          assetData.classNameCn = getAssetClassNameCn(ext)
        }
      }

      createAssetData(db, assetData)
      newAssetsCount++

      changeLogEntries.push({
        op: 'insert',
        tableName: 'assetData',
        recordKey: assetKey,
        payload: assetData as unknown as Record<string, unknown>
      })
    } catch (err) {
      console.warn(`[V2-Scan] 入库失败 ${file.fullPath}:`, err)
      parseErrors++
    }
  }

  // ─── 阶段 5：逐条记录 ChangeLog + 广播 ───
  if (changeLogEntries.length > 0) {
    try {
      const server = vsm.getServer()
      if (server) {
        const vaultEntry = server.getVaultEntry(vaultId)
        if (vaultEntry) {
          for (const cle of changeLogEntries) {
            const seq = vaultEntry.tracker.record(
              cle.op,
              cle.tableName,
              cle.recordKey,
              cle.payload,
              cle.clientId || 'server'
            )
            server.broadcastChange(vaultId, seq, cle.op, cle.tableName, cle.recordKey, cle.payload)
          }
        }
      }
    } catch (err) {
      console.warn('[V2-Scan] ChangeLog 记录/广播失败:', err)
    }
  }

  broadcastToRenderer('asset:changed', {
    source: 'networkV2',
    vaultId,
    op: 'scan',
    newAssets: newAssetsCount,
    newFolders: newFoldersCount
  })

  const result = {
    newAssets: newAssetsCount,
    newFolders: newFoldersCount,
    totalScanned: scannedFiles.length,
    parseErrors,
    failedDirs,
    partial: failedDirs > 0,
    durationMs: Date.now() - scanStart
  }
  console.log(`[V2-Scan] 扫描完成:`, result)
  return result
}

// ─────────────────────── 注册 IPC ───────────────────────

export function registerNetworkVaultV2Handlers(): void {
  const vsm = VaultServiceManager.getInstance()

  // 远程 Client 调 POST /scan 时复用这里的扫描逻辑。
  // 注册而不是在 Server 启动处注入：Server 由 VaultManager 在数据库初始化阶段拉起，
  // 比 IPC 注册早（见 AssetServer.registerVaultScanHandler 的说明）。
  // 必须使用 vault 参数的 db/vaultId，不可捕获外层 vaultId（多 Vault 下会错位）
  registerVaultScanHandler(async (vault) => {
    return performServerScan(vsm, vault.vaultId, vault.db, vault.networkPath)
  })

  // ========== 生命周期 ==========

  /**
   * 停止 Server 模式
   */
  ipcMain.handle('networkVaultV2:stopServer', async (_event, vaultId: string) => {
    try {
      await vsm.stopServer(vaultId)
      return ok()
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  })

  /**
   * 以 Client 模式连接到远端 Server
   * @param vaultId      本地保管库 ID
   * @param networkPath  网络共享路径（包含 .vault 发现文件）
   */
  ipcMain.handle(
    'networkVaultV2:startClient',
    async (_event, vaultId: string, networkPath: string) => {
      try {
        const db = getVaultDatabase(vaultId)
        if (!db) return fail('保管库数据库未打开')

        const state = await vsm.startClient(networkPath, db)

        // 监听 SyncClient 的实时变更事件 → 转发到渲染进程
        const client = vsm.getClient(state.vaultId)
        if (client) {
          client.on('change', (entry) => {
            broadcastToRenderer('asset:changed', {
              source: 'networkV2',
              vaultId: state.vaultId,
              ...entry
            })
          })
          client.on('sync-progress', (stats) => {
            broadcastToRenderer('networkVaultV2:syncProgress', {
              vaultId: state.vaultId,
              ...stats
            })
          })
          client.on('full-sync-done', (stats) => {
            broadcastToRenderer('networkVaultV2:syncComplete', {
              vaultId: state.vaultId,
              type: 'full',
              ...stats
            })
          })
          client.on('incremental-sync-done', (stats) => {
            broadcastToRenderer('networkVaultV2:syncComplete', {
              vaultId: state.vaultId,
              type: 'incremental',
              ...stats
            })
          })
          client.on('status', (status) => {
            broadcastToRenderer('networkVaultV2:statusChange', {
              vaultId: state.vaultId,
              status
            })
          })
          client.on('auth-required', (info) => {
            broadcastToRenderer('networkVaultV2:statusChange', {
              vaultId: state.vaultId,
              status: authStatusOf(info)
            })
          })
        }

        console.log(`[IPC-V2] Client 已连接: ${state.name} → ${state.serverHost}:${state.port}`)
        return ok(stateToDto(state))
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  /**
   * 停止 Client 模式
   */
  ipcMain.handle('networkVaultV2:stopClient', async (_event, vaultId: string) => {
    try {
      vsm.stopClient(vaultId)
      return ok()
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  })

  /**
   * 手动触发 Client 拉取同步（用于"拉取同步"按钮）
   */
  ipcMain.handle('networkVaultV2:pullSync', async (_event, vaultId: string) => {
    try {
      const client = vsm.getClient(vaultId)
      if (!client) return fail('当前 Vault 不是 Client 模式或未连接')
      // pullChanges() 是 HTTP 请求，不依赖 WebSocket 连接状态
      await client.pullChanges()
      return ok()
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  })

  ipcMain.handle('networkVaultV2:getThumbnailBackupStatus', async (_event, vaultId: string) => {
    try {
      if (vsm.getRole(vaultId) !== 'client') {
        return fail('缩略图备份恢复仅支持已连接的 HTTP 资产服务器')
      }
      const client = vsm.getClient(vaultId)
      if (!client) return fail('HTTP 资产服务器未连接')
      return ok(await client.getThumbnailBackupStatus())
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  })

  ipcMain.handle('networkVaultV2:syncThumbnailBackup', async (_event, vaultId: string) => {
    try {
      if (vsm.getRole(vaultId) !== 'client') {
        return fail('缩略图备份同步仅支持已连接的 HTTP 资产服务器')
      }
      const client = vsm.getClient(vaultId)
      if (!client) return fail('HTTP 资产服务器未连接')
      return ok(await client.syncThumbnailBackup())
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  })

  ipcMain.handle(
    'networkVaultV2:restoreThumbnailBackup',
    async (_event, vaultId: string, options?: { overwrite?: boolean }) => {
      try {
        if (vsm.getRole(vaultId) !== 'client') {
          return fail('缩略图恢复仅支持已连接的 HTTP 资产服务器')
        }
        const client = vsm.getClient(vaultId)
        if (!client) return fail('HTTP 资产服务器未连接')
        return ok(await client.restoreThumbnailBackup({ overwrite: Boolean(options?.overwrite) }))
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  /**
   * 获取所有 V2 网络保管库状态
   */
  ipcMain.handle('networkVaultV2:getAllStates', async () => {
    return ok(vsm.getAllStates().map(stateToDto))
  })

  /**
   * 获取指定 vault 的角色
   */
  ipcMain.handle('networkVaultV2:getRole', async (_event, vaultId: string) => {
    return ok(vsm.getRole(vaultId))
  })

  // ========== 主机访问码（配对码） ==========

  /**
   * 读出本机作为 Server 时该库的配对码，供界面显示 / 复制给同事。
   */
  ipcMain.handle('networkVaultV2:getServerAccess', async (_event, vaultId: string) => {
    try {
      if (vsm.getRole(vaultId) !== 'server') {
        return fail('当前保管库不是主机模式，没有配对码')
      }
      const vaultManager = VaultManager.getInstance()
      const keys = vaultManager.getOrCreateNetworkVaultServerKeys(vaultId)
      return ok({
        readKey: keys.readKey,
        writeKey: keys.writeKey,
        shareWriteEnabled: vaultManager.isNetworkVaultShareWriteEnabled(vaultId)
      })
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  })

  /**
   * 轮换配对码 —— 这就是「把某台机器踢下线」的实现方式：
   * 换掉码之后旧码再也连不上，服务端还会主动断掉用旧码建立的 WS 连接。
   */
  ipcMain.handle(
    'networkVaultV2:rotateServerAccess',
    async (_event, vaultId: string, which: 'read' | 'write' | 'both') => {
      try {
        const vaultManager = VaultManager.getInstance()
        const keys = vaultManager.rotateNetworkVaultServerKeys(vaultId, which)
        vsm.getServer()?.updateVaultKeys(vaultId, keys)
        await vsm.refreshDiscoveryFile(vaultId, {
          keys,
          publishWriteKeyToShare: vaultManager.isNetworkVaultShareWriteEnabled(vaultId)
        })
        return ok(keys)
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  /**
   * 是否把写码也分发到共享目录。
   *
   * 勾上之后，能访问这个共享文件夹的同事自动获得写权限，不用手动填码 ——
   * 这就是替代那张「没有任何界面能填」的 IP 权限表的东西。
   */
  ipcMain.handle(
    'networkVaultV2:setShareWritePublish',
    async (_event, vaultId: string, enabled: boolean) => {
      try {
        const vaultManager = VaultManager.getInstance()
        vaultManager.setNetworkVaultShareWriteEnabled(vaultId, enabled)
        await vsm.refreshDiscoveryFile(vaultId, {
          keys: vaultManager.getOrCreateNetworkVaultServerKeys(vaultId),
          publishWriteKeyToShare: enabled
        })
        return ok(true)
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  /**
   * 关闭所有 V2 网络服务
   */
  ipcMain.handle('networkVaultV2:shutdown', async () => {
    try {
      await vsm.shutdown()
      return ok()
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  })

  // ========== 读操作（本地 SQLite） ==========

  /**
   * 获取资产列表（按文件夹）
   * 无论 Server/Client，都读本地 SQLite 缓存
   */
  ipcMain.handle(
    'networkVaultV2:getAssetsByFolder',
    async (_event, vaultId: string, folderKey: string, sort?: string, order?: string) => {
      try {
        const db = getVaultDatabase(vaultId)
        if (!db) return fail('保管库数据库未打开')

        let sql = `SELECT * FROM assetData WHERE isDelete = 0`
        const params: unknown[] = []

        if (folderKey && folderKey !== 'ALL') {
          sql += ` AND folderKey = ?`
          params.push(folderKey)
        }

        const sortCol = sort || 'updated_at'
        const sortOrder = (order || 'DESC').toUpperCase() === 'ASC' ? 'ASC' : 'DESC'
        sql += ` ORDER BY ${sortCol} ${sortOrder}`

        const rows = db.prepare(sql).all(...params)
        return ok(rows)
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  /**
   * 获取文件夹列表
   */
  ipcMain.handle(
    'networkVaultV2:getFolders',
    async (_event, vaultId: string, parentKey?: string) => {
      try {
        const db = getVaultDatabase(vaultId)
        if (!db) return fail('保管库数据库未打开')

        let sql = `SELECT * FROM assetFolder WHERE isDelete = 0`
        const params: unknown[] = []

        if (parentKey) {
          sql += ` AND fatherKey = ?`
          params.push(parentKey)
        }

        sql += ` ORDER BY folderName ASC`
        const rows = db.prepare(sql).all(...params)
        return ok(rows)
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  /**
   * 搜索资产
   */
  ipcMain.handle(
    'networkVaultV2:searchAssets',
    async (_event, vaultId: string, keyword: string) => {
      try {
        const db = getVaultDatabase(vaultId)
        if (!db) return fail('保管库数据库未打开')

        const likePattern = `%${keyword}%`
        const rows = db
          .prepare(
            `SELECT * FROM assetData WHERE isDelete = 0
             AND (assetName LIKE ? OR className LIKE ? OR classNameCn LIKE ? OR tags LIKE ? OR note LIKE ?)
             ORDER BY updated_at DESC LIMIT 200`
          )
          .all(likePattern, likePattern, likePattern, likePattern, likePattern)

        return ok(rows)
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  /**
   * 获取单个资产详情
   */
  ipcMain.handle('networkVaultV2:getAsset', async (_event, vaultId: string, assetKey: string) => {
    try {
      const db = getVaultDatabase(vaultId)
      if (!db) return fail('保管库数据库未打开')

      const row = db.prepare(`SELECT * FROM assetData WHERE assetKey = ?`).get(assetKey)
      return ok(row || null)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  })

  /**
   * 获取资产统计
   */
  ipcMain.handle('networkVaultV2:getStats', async (_event, vaultId: string) => {
    try {
      const db = getVaultDatabase(vaultId)
      if (!db) return fail('保管库数据库未打开')

      const assetCount = (
        db.prepare('SELECT COUNT(*) AS c FROM assetData WHERE isDelete = 0').get() as { c: number }
      ).c
      const folderCount = (
        db.prepare('SELECT COUNT(*) AS c FROM assetFolder WHERE isDelete = 0').get() as {
          c: number
        }
      ).c
      const totalSize = (
        db
          .prepare('SELECT COALESCE(SUM(fileSize), 0) AS s FROM assetData WHERE isDelete = 0')
          .get() as { s: number }
      ).s

      return ok({ assetCount, folderCount, totalSize })
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  })

  // ========== 写操作（Server 直写 / Client 代理） ==========

  /**
   * 创建资产
   * - Server 模式: 直写 SQLite + ChangeTracker 记录
   * - Client 模式: 代理到 Server HTTP API
   */
  ipcMain.handle(
    'networkVaultV2:createAsset',
    async (_event, vaultId: string, assetData: Record<string, unknown>) => {
      try {
        const role = vsm.getRole(vaultId)

        if (role === 'client') {
          // Client → 代理到 Server
          const client = vsm.getClient(vaultId)
          if (!client) return fail('Client 未连接')
          const resp = await client.createAsset(assetData)
          return ok(resp)
        }

        if (role === 'server') {
          // Server → 直写本地 + 记录变更
          const db = getVaultDatabase(vaultId)
          if (!db) return fail('保管库数据库未打开')

          const assetKey =
            (assetData.assetKey as string) ||
            `asset_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
          assetData.assetKey = assetKey
          assetData.folderKey = assetData.folderKey || 'ALL'

          const columns = Object.keys(assetData)
          const placeholders = columns.map((c) => `@${c}`).join(', ')
          const sql = `INSERT OR REPLACE INTO assetData (${columns.join(', ')}) VALUES (${placeholders})`
          withAssetReplaceGuard(db, assetKey, () => db.prepare(sql).run(assetData))

          // 记录到 change_log 并广播给已连接的 Client
          syncToV2ChangeLog(
            vsm,
            vaultId,
            'insert',
            'assetData',
            assetKey,
            assetData as Record<string, unknown>
          )

          broadcastToRenderer('asset:changed', {
            source: 'networkV2',
            vaultId,
            op: 'insert',
            tableName: 'assetData',
            recordKey: assetKey
          })

          return ok({ assetKey })
        }

        return fail('保管库未激活网络模式')
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  /**
   * 更新资产
   */
  ipcMain.handle(
    'networkVaultV2:updateAsset',
    async (_event, vaultId: string, assetKey: string, updates: Record<string, unknown>) => {
      try {
        const role = vsm.getRole(vaultId)

        if (role === 'client') {
          const client = vsm.getClient(vaultId)
          if (!client) return fail('Client 未连接')
          const resp = await client.updateAsset(assetKey, updates)
          return ok(resp)
        }

        if (role === 'server') {
          const db = getVaultDatabase(vaultId)
          if (!db) return fail('保管库数据库未打开')

          const setClauses = Object.keys(updates)
            .map((k) => `${k} = @${k}`)
            .join(', ')
          const sql = `UPDATE assetData SET ${setClauses}, updated_at = datetime('now','localtime') WHERE assetKey = @assetKey`
          db.prepare(sql).run({ ...updates, assetKey })

          syncToV2ChangeLog(
            vsm,
            vaultId,
            'update',
            'assetData',
            assetKey,
            updates as Record<string, unknown>
          )

          broadcastToRenderer('asset:changed', {
            source: 'networkV2',
            vaultId,
            op: 'update',
            tableName: 'assetData',
            recordKey: assetKey
          })

          return ok({ assetKey })
        }

        return fail('保管库未激活网络模式')
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  /**
   * 删除资产（软删除）
   */
  ipcMain.handle(
    'networkVaultV2:deleteAsset',
    async (_event, vaultId: string, assetKey: string) => {
      try {
        const role = vsm.getRole(vaultId)

        if (role === 'client') {
          const client = vsm.getClient(vaultId)
          if (!client) return fail('Client 未连接')
          const resp = await client.deleteAsset(assetKey)
          return ok(resp || { assetKey })
        }

        if (role === 'server') {
          const db = getVaultDatabase(vaultId)
          if (!db) return fail('保管库数据库未打开')

          db.prepare(
            `UPDATE assetData
              SET isDelete = 1, deletedAt = datetime('now','localtime'),
                  updated_at = datetime('now','localtime')
              WHERE assetKey = ?`
          ).run(assetKey)

          syncToV2ChangeLog(vsm, vaultId, 'delete', 'assetData', assetKey, null)

          broadcastToRenderer('asset:changed', {
            source: 'networkV2',
            vaultId,
            op: 'delete',
            tableName: 'assetData',
            recordKey: assetKey
          })

          return ok({ assetKey })
        }

        return fail('保管库未激活网络模式')
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  ipcMain.handle(
    'networkVaultV2:getDeletedAssets',
    async (_event, vaultId: string, page = 1, pageSize = 100) => {
      try {
        const role = vsm.getRole(vaultId)

        if (role === 'server') {
          const db = getVaultDatabase(vaultId)
          if (!db) return fail('保管库数据库未打开')

          return ok(getDeletedAssetData(db, page, pageSize))
        }

        if (role !== 'client') {
          return fail('当前网络资产库暂不支持远程回收站')
        }

        const client = vsm.getClient(vaultId)
        if (!client) return fail('Client 未连接')

        const resp = await client.getDeletedAssets(page, pageSize)
        return ok(resp || { list: [], total: 0 })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  ipcMain.handle(
    'networkVaultV2:restoreAsset',
    async (_event, vaultId: string, assetKey: string) => {
      try {
        const role = vsm.getRole(vaultId)

        if (role === 'server') {
          const db = getVaultDatabase(vaultId)
          if (!db) return fail('保管库数据库未打开')

          const restored = restoreAssetData(db, assetKey)
          if (!restored) return fail('资产不在最近删除中，或已恢复')

          const payload = (getAssetDataByKey(db, assetKey) || {}) as Record<string, unknown>
          syncToV2ChangeLog(vsm, vaultId, 'update', 'assetData', assetKey, payload)

          broadcastToRenderer('asset:changed', {
            source: 'networkV2',
            vaultId,
            op: 'update',
            tableName: 'assetData',
            recordKey: assetKey,
            data: payload
          })

          return ok({ assetKey, restoredFile: false })
        }

        if (role !== 'client') {
          return fail('当前网络资产库暂不支持远程恢复')
        }

        const client = vsm.getClient(vaultId)
        if (!client) return fail('Client 未连接')

        const resp = await client.restoreAsset(assetKey)
        return ok(resp || { assetKey })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  ipcMain.handle('networkVaultV2:purgeAsset', async (_event, vaultId: string, assetKey: string) => {
    try {
      const role = vsm.getRole(vaultId)

      if (role === 'server') {
        const db = getVaultDatabase(vaultId)
        if (!db) return fail('保管库数据库未打开')

        const row = db
          .prepare(
            `SELECT assetKey, filePath, originPath, imgLocalPath FROM assetData WHERE assetKey = ? AND isDelete = 1`
          )
          .get(assetKey) as DeletedAssetRow | undefined
        if (!row) return fail('资产不在最近删除中，无法彻底删除')

        const purgeTx = db.transaction(() => {
          db.prepare(`DELETE FROM asset_tags WHERE assetKey = ?`).run(assetKey)
          db.prepare(`DELETE FROM asset_favorites WHERE assetKey = ?`).run(assetKey)
          const result = db
            .prepare(`DELETE FROM assetData WHERE assetKey = ? AND isDelete = 1`)
            .run(assetKey)
          return result.changes > 0
        })

        const purged = purgeTx()
        if (!purged) return fail('彻底删除网络资产失败')

        const vaultRoot = getCurrentVaultNetworkRoot(vaultId)
        let cleanupResult = { deletedFile: false }
        try {
          cleanupResult = await deleteDeletedAssetArtifacts(vaultRoot, row)
        } catch (cleanupErr) {
          console.warn('[IPC-V2] purge asset cleanup failed:', cleanupErr)
        }

        return ok({ assetKey, deletedFile: cleanupResult.deletedFile })
      }

      if (role !== 'client') {
        return fail('当前网络资产库暂不支持远程彻底删除')
      }

      const client = vsm.getClient(vaultId)
      if (!client) return fail('Client 未连接')

      const resp = await client.purgeAsset(assetKey)
      return ok(resp || { assetKey })
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  })

  /**
   * 创建文件夹
   */
  ipcMain.handle(
    'networkVaultV2:createFolder',
    async (_event, vaultId: string, folderData: Record<string, unknown>) => {
      try {
        const role = vsm.getRole(vaultId)

        if (role === 'client') {
          const client = vsm.getClient(vaultId)
          if (!client) return fail('Client 未连接')
          const resp = await client.createFolder(folderData)
          return ok(resp)
        }

        if (role === 'server') {
          const db = getVaultDatabase(vaultId)
          if (!db) return fail('保管库数据库未打开')

          const folderKey =
            (folderData.folderKey as string) ||
            `folder_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`
          folderData.folderKey = folderKey
          folderData.fatherKey = folderData.fatherKey || 'ALL'
          folderData.type = folderData.type || 'folder'
          folderData.isDelete = 0

          const columns = Object.keys(folderData)
          const placeholders = columns.map((c) => `@${c}`).join(', ')
          db.prepare(
            `INSERT OR REPLACE INTO assetFolder (${columns.join(', ')}) VALUES (${placeholders})`
          ).run(folderData)

          syncToV2ChangeLog(
            vsm,
            vaultId,
            'insert',
            'assetFolder',
            folderKey,
            folderData as Record<string, unknown>
          )

          broadcastToRenderer('asset:changed', {
            source: 'networkV2',
            vaultId,
            op: 'insert',
            tableName: 'assetFolder',
            recordKey: folderKey
          })

          return ok({ folderKey })
        }

        return fail('保管库未激活网络模式')
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  /**
   * 更新文件夹
   */
  ipcMain.handle(
    'networkVaultV2:updateFolder',
    async (_event, vaultId: string, folderKey: string, updates: Record<string, unknown>) => {
      try {
        const role = vsm.getRole(vaultId)

        if (role === 'client') {
          const client = vsm.getClient(vaultId)
          if (!client) return fail('Client 未连接')
          const resp = await client.updateFolder(folderKey, updates)
          return ok(resp)
        }

        if (role === 'server') {
          const db = getVaultDatabase(vaultId)
          if (!db) return fail('保管库数据库未打开')

          const setClauses = Object.keys(updates)
            .map((k) => `${k} = @${k}`)
            .join(', ')
          db.prepare(
            `UPDATE assetFolder SET ${setClauses}, updated_at = datetime('now','localtime') WHERE folderKey = @folderKey`
          ).run({ ...updates, folderKey })

          syncToV2ChangeLog(
            vsm,
            vaultId,
            'update',
            'assetFolder',
            folderKey,
            updates as Record<string, unknown>
          )

          broadcastToRenderer('asset:changed', {
            source: 'networkV2',
            vaultId,
            op: 'update',
            tableName: 'assetFolder',
            recordKey: folderKey
          })

          return ok({ folderKey })
        }

        return fail('保管库未激活网络模式')
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  /**
   * 删除文件夹（软删除）
   */
  ipcMain.handle(
    'networkVaultV2:deleteFolder',
    async (_event, vaultId: string, folderKey: string, options?: { syncAfter?: boolean }) => {
      try {
        const role = vsm.getRole(vaultId)

        if (role === 'client') {
          const client = vsm.getClient(vaultId)
          if (!client) return fail('Client 未连接')
          const resp = await client.deleteFolder(folderKey, options)
          return ok(resp)
        }

        if (role === 'server') {
          const db = getVaultDatabase(vaultId)
          if (!db) return fail('保管库数据库未打开')

          // 前置检查：根节点必须存在且未删除
          if (!isFolderActive(db, folderKey)) {
            return fail('文件夹不存在或已删除')
          }

          // 收集活动子树 key（仅 isDelete=0），然后递归软删
          const subtree = collectFolderSubtreeKeys(db, folderKey)
          deleteAssetFolder(db, folderKey)

          // 为每个受影响的 folder/asset 记录 delete change
          recordSubtreeDeletionChanges(vsm, vaultId, subtree.folderKeys, subtree.assetKeys)

          broadcastToRenderer('asset:changed', {
            source: 'networkV2',
            vaultId,
            op: 'delete',
            tableName: 'assetFolder',
            recordKey: folderKey
          })

          return ok({ folderKey })
        }

        return fail('保管库未激活网络模式')
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  /**
   * 批量操作
   */
  ipcMain.handle(
    'networkVaultV2:batch',
    async (
      _event,
      vaultId: string,
      operations: Array<{ type: string; table: string; data: Record<string, unknown> }>
    ) => {
      try {
        const role = vsm.getRole(vaultId)

        if (role === 'client') {
          const client = vsm.getClient(vaultId)
          if (!client) return fail('Client 未连接')
          const resp = await client.batch(operations)
          return ok(resp)
        }

        if (role === 'server') {
          const db = getVaultDatabase(vaultId)
          if (!db) return fail('保管库数据库未打开')

          let applied = 0
          const batchFolderSubtrees: Array<{ folderKeys: string[]; assetKeys: string[] }> = []
          const tx = db.transaction(() => {
            for (const op of operations) {
              try {
                if (op.type === 'insert' && op.table === 'assetData') {
                  const cols = Object.keys(op.data)
                  withAssetReplaceGuard(db, op.data.assetKey, () =>
                    db
                      .prepare(
                        `INSERT OR REPLACE INTO assetData (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`
                      )
                      .run(op.data)
                  )
                  applied++
                } else if (op.type === 'insert' && op.table === 'assetFolder') {
                  const cols = Object.keys(op.data)
                  db.prepare(
                    `INSERT OR REPLACE INTO assetFolder (${cols.join(', ')}) VALUES (${cols.map((c) => `@${c}`).join(', ')})`
                  ).run(op.data)
                  applied++
                } else if (op.type === 'delete') {
                  const key = (
                    op.table === 'assetData'
                      ? (op.data.assetKey ?? op.data.key)
                      : (op.data.folderKey ?? op.data.key)
                  ) as string | undefined
                  if (!key) {
                    console.warn(
                      `[IPC-V2] batch delete: 缺少 key 字段 (table=${op.table}, data keys=[${Object.keys(op.data).join(',')}])，跳过`
                    )
                    // 不 applied++，但也不再静默丢失——至少有日志
                  } else if (op.table === 'assetData') {
                    const runResult = db
                      .prepare(
                        `UPDATE assetData SET isDelete = 1 WHERE assetKey = ? AND isDelete = 0`
                      )
                      .run(key)
                    if (runResult.changes > 0) applied++
                  } else if (op.table === 'assetFolder') {
                    // 前置检查：跳过不存在或已删除的 folder
                    if (!isFolderActive(db, key)) {
                      console.warn(`[IPC-V2] batch folder delete: key=${key} 不存在或已删除，跳过`)
                    } else {
                      // 收集活动子树 key（仅 isDelete=0）
                      const subtree = collectFolderSubtreeKeys(db, key)
                      deleteAssetFolder(db, key)
                      batchFolderSubtrees.push(subtree)
                      applied++
                    }
                  }
                }
              } catch (opErr) {
                console.warn(`[IPC-V2] 批量操作失败:`, opErr)
              }
            }
          })
          tx()

          // 记录每个操作到 change_log 并广播
          for (const op of operations) {
            try {
              const table = op.table as TrackedTable
              if (op.type === 'insert') {
                const key = (op.data.assetKey || op.data.folderKey) as string
                if (key) syncToV2ChangeLog(vsm, vaultId, 'insert', table, key, op.data)
              } else if (op.type === 'delete' && op.table === 'assetData') {
                const key = (op.data.assetKey ?? op.data.key) as string
                if (key) syncToV2ChangeLog(vsm, vaultId, 'delete', table, key, null)
              }
              // folder delete 的 change log 由 batchFolderSubtrees 处理
            } catch {
              /* 忽略单条操作的同步失败 */
            }
          }

          // 为所有递归删除的文件夹子树记录 change log
          if (batchFolderSubtrees.length > 0) {
            for (const subtree of batchFolderSubtrees) {
              recordSubtreeDeletionChanges(vsm, vaultId, subtree.folderKeys, subtree.assetKeys)
            }
          }

          broadcastToRenderer('asset:changed', {
            source: 'networkV2',
            vaultId,
            op: 'batch',
            applied
          })

          return ok({ applied })
        }

        return fail('保管库未激活网络模式')
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  // ========== 扫描 ==========

  /**
   * 触发手动扫描（仅 Server 模式）
   * 直接在进程内执行文件扫描，不走 HTTP 接口：
   *  1. 递归扫描 networkPath 下所有文件（轻量 readdir I/O）
   *  2. 与 SQLite 已有资产对比去重（originPath 匹配）
   *  3. 按物理目录结构自动创建文件夹层级
   *  4. 新增文件解析元数据 + 生成缩略图
   *  5. 批量写入 SQLite + ChangeTracker 广播给 Client
   */
  ipcMain.handle('networkVaultV2:scan', async (_event, vaultId: string) => {
    try {
      const role = vsm.getRole(vaultId)

      // 客户端模式：通过 HTTP API 远程触发服务器扫描
      if (role === 'client') {
        const client = vsm.getClient(vaultId)
        if (!client) return fail('同步客户端未连接')

        console.log(`[V2-Scan] 远程触发扫描...`)
        try {
          // 获取远程 vault 的信息
          const state = vsm.getAllStates().find((s) => s.vaultId === vaultId)
          if (!state || !state.serverHost) return fail('未找到服务器信息')

          const serverUrl = `${state.serverScheme || 'http'}://${state.serverHost}:${state.port}`
          // 从 SyncClient 获取远端 vaultId（兼容 SMB 和 HTTP 两种模式）
          const remoteVaultId = client.remoteVaultId
          if (!remoteVaultId) return fail('未找到远程 vault 信息')
          // SMB 发现模式的码只在运行期表里，只读 app_settings 会一律 401
          const apiKey = resolveVaultAccessKey({
            storedKey: VaultManager.getInstance().getNetworkVaultApiKey(vaultId),
            serverUrl,
            remoteVaultId
          })

          const formatRemoteScanError = (err: unknown): string => {
            if (!(err instanceof Error)) return String(err)
            const cause = (err as Error & { cause?: unknown }).cause
            if (cause instanceof Error && cause.message && cause.message !== err.message) {
              return `${err.message}: ${cause.message}`
            }
            if (
              cause &&
              typeof cause === 'object' &&
              'message' in cause &&
              typeof (cause as { message?: unknown }).message === 'string'
            ) {
              const causeMessage = (cause as { message: string }).message
              if (causeMessage && causeMessage !== err.message) {
                return `${err.message}: ${causeMessage}`
              }
            }
            return err.message
          }

          const isRetryableRemoteScanError = (err: unknown): boolean => {
            const message = formatRemoteScanError(err).toLowerCase()
            return (
              message.includes('socket hang up') ||
              message.includes('econnreset') ||
              message.includes('fetch failed') ||
              message.includes('other side closed') ||
              message.includes('terminated')
            )
          }

          const invokeRemoteScan = async (): Promise<Record<string, unknown>> => {
            const controller = new AbortController()
            const timeout = setTimeout(() => controller.abort(), 120_000)
            try {
              const resp = await fetch(
                `${serverUrl}/api/vaults/${encodeURIComponent(remoteVaultId)}/scan`,
                {
                  method: 'POST',
                  headers: apiKey ? { 'X-API-Key': apiKey } : {},
                  signal: controller.signal
                }
              )

              const raw = await resp.text()
              let result: { success?: boolean; error?: string; data?: Record<string, unknown> }
              try {
                result = raw
                  ? (JSON.parse(raw) as {
                      success?: boolean
                      error?: string
                      data?: Record<string, unknown>
                    })
                  : {}
              } catch {
                throw new Error(`远程扫描返回无效响应 (HTTP ${resp.status})`)
              }

              if (!resp.ok || !result.success) {
                throw new Error(result.error || `远程扫描失败 (HTTP ${resp.status})`)
              }

              return result.data || { message: '远程扫描完成' }
            } finally {
              clearTimeout(timeout)
            }
          }

          /**
           * 拉取同步与扫描解耦：扫描失败也要把主机上已有的变更拉下来。
           *
           * 原来 `pullChanges()` 写在扫描的 try 里，扫描一抛异常就整条跳过 ——
           * 用户点一次「刷新」，既没扫描也没同步，而别人提交的改动明明已经在主机上。
           *
           * 瞬时网络错误在这一步自己重试一次，不再整轮重跑扫描：大库扫一遍要几分钟，
           * 为一次 `fetch failed` 重扫一遍太贵，而重复扫描本身不产生新资产。
           */
          const pullChangesWithRetry = async (stage: string): Promise<boolean> => {
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                await client.pullChanges()
                return true
              } catch (pullErr) {
                console.warn(`[V2-Scan] ${stage}拉取同步失败: ${formatRemoteScanError(pullErr)}`)
                if (attempt > 0 || !isRetryableRemoteScanError(pullErr)) return false
                await new Promise((resolve) => setTimeout(resolve, 800))
              }
            }
            return false
          }

          let lastError: unknown = null
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const scanResult = await invokeRemoteScan()
              console.log(`[V2-Scan] 远程扫描完成, 拉取变更...`)
              if (!(await pullChangesWithRetry('扫描后'))) return fail('同步拉取失败')
              return ok(scanResult)
            } catch (err) {
              lastError = err
              const shouldRetry = attempt === 0 && isRetryableRemoteScanError(err)
              console.warn(
                `[V2-Scan] 远程扫描请求失败 (attempt ${attempt + 1}/2): ${formatRemoteScanError(err)}`
              )
              if (!shouldRetry) break
              await new Promise((resolve) => setTimeout(resolve, 800))
            }
          }

          // 扫描这一步没成，同步照做
          await pullChangesWithRetry('扫描失败后')
          return fail(`远程扫描失败: ${formatRemoteScanError(lastError)}`)
        } catch (err) {
          return fail(`远程扫描失败: ${err instanceof Error ? err.message : String(err)}`)
        }
      }

      if (role !== 'server') return fail('扫描功能仅限主机或远程连接使用')

      const db = getVaultDatabase(vaultId)
      if (!db) return fail('保管库数据库未打开')

      const state = vsm.getAllStates().find((s) => s.vaultId === vaultId)
      if (!state) return fail('Vault 未注册')

      // 可达性检查在 performServerScan 里，和远程那条路径共用
      const result = await performServerScan(vsm, vaultId, db, state.networkPath)
      return ok(result)
    } catch (err) {
      return fail(err instanceof Error ? err.message : String(err))
    }
  })

  // ========== 连接状态查询 ==========

  /**
   * 获取 Client 连接状态
   */
  ipcMain.handle('networkVaultV2:getConnectionStatus', async (_event, vaultId: string) => {
    const role = vsm.getRole(vaultId)
    if (role === 'client') {
      const client = vsm.getClient(vaultId)
      // API-only 模式没有 WebSocket，client.isConnected 永远为 false
      // 使用 activeVaults 的状态来判断连接情况（startClientDirect 中会更新）
      const state = vsm.getAllStates().find((s) => s.vaultId === vaultId)
      const connected = client?.isConnected || state?.connected || false
      const hasStoredApiKey = !!VaultManager.getInstance().getNetworkVaultApiKey(vaultId)

      // Fix #4: 从服务器获取真实权限（而非一律视为只读）
      let permission: string = hasStoredApiKey ? 'admin' : 'readonly'
      const base = serverUrlOfState(state)
      if (!hasStoredApiKey && connected && base) {
        try {
          // 码按「远端 vaultId」索引，拿本地 vaultId 去查一律查不到：
          // 探测就会 401，主机明明开了共享写，界面却把写操作锁死成只读。
          const probeKey = resolveVaultAccessKey({
            serverUrl: base,
            remoteVaultId: state?.remoteVaultId
          })
          const resp = await fetch(`${base}/api/vaults`, {
            headers: probeKey ? { 'X-API-Key': probeKey } : {},
            signal: AbortSignal.timeout(3000)
          })
          const body = (await resp.json()) as {
            success: boolean
            data?: Array<{ vaultId?: string; permission?: string }>
          }
          if (body.success && Array.isArray(body.data) && body.data.length > 0) {
            // 一把码可能打开多个库，取第一个会读到别的库的权限
            const mine =
              body.data.find((entry) => entry.vaultId === state?.remoteVaultId) || body.data[0]
            permission = mine.permission || 'readonly'
          }
        } catch {
          // 获取权限失败时保持默认只读（安全降级）
        }
      }

      return ok({
        role,
        connected,
        permission
      })
    }
    if (role === 'server') {
      const server = vsm.getServer()
      return ok({
        role,
        connected: true,
        connectedClients: server?.connectedClientCount ?? 0,
        permission: 'admin'
      })
    }
    return ok({ role: 'none', connected: false, permission: 'readonly' })
  })

  /**
   * Server 模式：检测 .vault 发现文件是否存在
   */
  ipcMain.handle('networkVaultV2:checkDiscovery', async (_event, networkPath: string) => {
    try {
      const fs = await import('fs')
      const path = await import('path')
      const filePath = path.join(networkPath, '.vault')
      if (fs.existsSync(filePath)) {
        const raw = fs.readFileSync(filePath, 'utf-8')
        return ok(JSON.parse(raw))
      }
      return ok(null)
    } catch {
      return ok(null)
    }
  })

  // ========== 远程资产服务器 Vault 管理 ==========

  /**
   * 列出资产服务器上的所有 Vault
   * @param serverUrl  资产服务器地址，如 "192.168.1.100:18900"
   * @param apiKey     访问码。v3 起列库接口也要鉴权，不带码会 401，
   *                   而且返回的列表只包含这把码能打开的库
   */
  ipcMain.handle(
    'networkVaultV2:listRemoteVaults',
    async (_event, serverUrl: string, apiKey?: string) => {
      try {
        const url = serverUrl.startsWith('http') ? serverUrl : `http://${serverUrl}`
        const key = apiKey?.trim()
        const resp = await fetch(`${url}/api/vaults`, {
          headers: key ? { 'X-API-Key': key } : {}
        })
        const data = await resp.json()
        return ok(data.data || [])
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  /**
   * 列出资产服务器上的资产根路径（服务器 → 资产路径 → 资产库 中间层）
   * 旧版服务端没有该接口，返回空数组，调用方按平铺模式回退。
   */
  ipcMain.handle('networkVaultV2:listRemoteRoots', async (_event, serverUrl: string) => {
    try {
      const url = serverUrl.startsWith('http') ? serverUrl : `http://${serverUrl}`
      const resp = await fetch(`${url}/api/roots`)
      const data = await resp.json()
      if (!data.success || !Array.isArray(data.data)) return ok([])
      return ok(data.data)
    } catch {
      return ok([])
    }
  })

  /**
   * 在资产服务器上远程创建 Vault
   * @param serverUrl  资产服务器地址，如 "192.168.1.100:18900"
   * @param name       Vault 名称
   * @param apiKey     可选 API Key
   * @param vaultPath  可选，服务器上的路径（留空则使用服务器的 vaultBasePath + name）
   * @param rootPath   可选，所属资产根路径（服务端校验必须是已配置的根）
   */
  ipcMain.handle(
    'networkVaultV2:createRemoteVault',
    async (
      _event,
      serverUrl: string,
      name: string,
      apiKey?: string,
      vaultPath?: string,
      rootPath?: string
    ) => {
      try {
        const url = serverUrl.startsWith('http') ? serverUrl : `http://${serverUrl}`
        const body: Record<string, string> = { name }
        if (vaultPath) body.path = vaultPath
        if (rootPath) body.rootPath = rootPath

        const resp = await fetch(`${url}/api/system/vaults`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'X-API-Key': apiKey } : {})
          },
          body: JSON.stringify(body)
        })
        const data = await resp.json()

        if (data.success) {
          return ok(data.data)
        } else {
          return fail(data.error || '创建失败')
        }
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  /**
   * 删除资产服务器上的 Vault
   * @param serverUrl  资产服务器地址
   * @param vaultId    要删除的 vaultId
   * @param apiKey     可选 API Key
   */
  ipcMain.handle(
    'networkVaultV2:deleteRemoteVault',
    async (_event, serverUrl: string, vaultId: string, apiKey?: string) => {
      try {
        const url = serverUrl.startsWith('http') ? serverUrl : `http://${serverUrl}`
        const resp = await fetch(`${url}/api/system/vaults/${encodeURIComponent(vaultId)}`, {
          method: 'DELETE',
          headers: apiKey ? { 'X-API-Key': apiKey } : {}
        })
        const data = await resp.json()
        if (data.success) {
          return ok(data.data)
        } else {
          return fail(data.error || '删除失败')
        }
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  /**
   * 连接到远端资产服务器上的 Vault（一键操作）
   * 流程：创建本地 network vault → 切换到该 vault → 启动 SyncClient 直连
   *
   * @param serverUrl     资产服务器地址，如 "192.168.1.100:18900"
   * @param remoteVault   远端 vault 信息 { vaultId, name, networkPath }
   * @param apiKey        可选 API Key（用于后续操作鉴权）
   */
  ipcMain.handle(
    'networkVaultV2:connectRemoteVault',
    async (
      _event,
      serverUrl: string,
      remoteVault: { vaultId: string; name: string; networkPath: string },
      apiKey?: string,
      localName?: string,
      browsePath?: string
    ) => {
      try {
        const normalizedUrl = serverUrl.startsWith('http') ? serverUrl : `http://${serverUrl}`
        const vm = VaultManager.getInstance()

        // 1. 创建本地 network vault 记录
        //    networkPath 存储为标准 HTTP URL: "http://host:port/remoteVaultId"
        //    无论是 NAS、Mac 还是其他设备，都只是运行了一个 HTTP 资产服务器
        const serverIdentifier = `${normalizedUrl}/${remoteVault.vaultId}`

        // 使用前端用户自定义名称（如果提供），否则使用远程 vault 名称
        const vaultDisplayName = localName || remoteVault.name

        const newVault = await vm.createVault({
          name: vaultDisplayName,
          vaultType: VaultType.NETWORK,
          networkPath: serverIdentifier,
          browsePath
        })
        try {
          vm.setNetworkVaultApiKey(newVault.id, apiKey)
        } catch (keyErr) {
          try {
            await vm.deleteVault(newVault.id)
          } catch {
            /* 清理失败不额外报错 */
          }
          return fail(
            `保存管理员 KEY 失败: ${keyErr instanceof Error ? keyErr.message : String(keyErr)}`
          )
        }

        console.log(`[IPC-V2] 本地 vault 已创建: ${newVault.id} → ${serverIdentifier}`)

        // 2. 切换到新 vault
        const switchResult = await vm.switchToVault(newVault.id)
        if (!switchResult.success) {
          // 切换本身失败，清理刚创建的 vault
          try {
            await vm.deleteVault(newVault.id)
          } catch {
            /* 清理失败不额外报错 */
          }
          return fail(`切换到新 vault 失败: ${switchResult.error}`)
        }

        // 3. 检查网络服务是否成功启动
        //    switchToVault 内部通过 startV2NetworkService 启动 SyncClient，
        //    如果健康检查失败，会在 networkError 中返回具体原因
        if (switchResult.networkError) {
          // 网络连接失败，清理刚创建的 vault
          console.warn(`[IPC-V2] 远程连接失败，清理本地 vault: ${switchResult.networkError}`)
          try {
            await vm.deleteVault(newVault.id)
          } catch {
            /* 清理失败不额外报错 */
          }
          return fail(`连接远程资产服务器失败: ${switchResult.networkError}`)
        }

        // 4. 确认 SyncClient 已启动
        const state = vsm.getAllStates().find((s) => s.vaultId === newVault.id)
        const client = vsm.getClient(newVault.id)

        if (!client && !state) {
          // 不应该走到这里，但防御性检查
          console.warn(`[IPC-V2] SyncClient 未启动且无状态，清理本地 vault`)
          try {
            await vm.deleteVault(newVault.id)
          } catch {
            /* 清理失败不额外报错 */
          }
          return fail('连接远程资产服务器失败: SyncClient 未能启动')
        }

        // 5. 注册事件监听 → 转发到渲染进程
        if (client) {
          client.on('change', (entry) => {
            broadcastToRenderer('asset:changed', {
              source: 'networkV2',
              vaultId: newVault.id,
              ...entry
            })
          })
          client.on('sync-progress', (stats) => {
            broadcastToRenderer('networkVaultV2:syncProgress', {
              vaultId: newVault.id,
              ...stats
            })
          })
          client.on('full-sync-done', (stats) => {
            broadcastToRenderer('networkVaultV2:syncComplete', {
              vaultId: newVault.id,
              type: 'full',
              ...stats
            })
          })
          client.on('incremental-sync-done', (stats) => {
            broadcastToRenderer('networkVaultV2:syncComplete', {
              vaultId: newVault.id,
              type: 'incremental',
              ...stats
            })
          })
          client.on('status', (status) => {
            broadcastToRenderer('networkVaultV2:statusChange', {
              vaultId: newVault.id,
              status
            })
          })
          client.on('auth-required', (info) => {
            broadcastToRenderer('networkVaultV2:statusChange', {
              vaultId: newVault.id,
              status: authStatusOf(info)
            })
          })
        }

        console.log(
          `[IPC-V2] 资产服务器直连已启动: ${remoteVault.name} → ${normalizedUrl} (localId: ${newVault.id})`
        )

        return ok({
          localVaultId: newVault.id,
          remoteVaultId: remoteVault.vaultId,
          serverUrl: normalizedUrl,
          ...(state ? stateToDto(state) : { role: 'client', connected: true }),
          apiKey: apiKey || undefined
        })
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )

  ipcMain.handle(
    'networkVaultV2:setRemoteVaultApiKey',
    async (_event, localVaultId: string, apiKey?: string) => {
      try {
        const vm = VaultManager.getInstance()
        vm.setNetworkVaultApiKey(localVaultId, apiKey)
        const client = vsm.getClient(localVaultId)
        client?.setStandaloneApiKey(apiKey)

        // 运行期码表也要跟着换。缩略图上传/探测、uebox-asset 协议代理、
        // 导入下载全都从这张表取头 —— 不刷新的话，用户填了新码，同步恢复了，
        // 而缩略图和预览继续 401，直到下次切库或重启。
        const state = vsm.getAllStates().find((s) => s.vaultId === localVaultId)
        const serverUrl = serverUrlOfState(state)
        const remoteVaultId = state?.remoteVaultId || client?.remoteVaultId
        if (serverUrl && remoteVaultId) {
          rememberVaultAccessKey(serverUrl, remoteVaultId, apiKey)
        }

        broadcastToRenderer('networkVaultV2:statusChange', {
          vaultId: localVaultId,
          status: 'permissionChanged'
        })
        return ok(true)
      } catch (err) {
        return fail(err instanceof Error ? err.message : String(err))
      }
    }
  )
} // end registerNetworkVaultV2Handlers

// ─────────────────────── DTO 转换 ───────────────────────

function stateToDto(state: NetworkVaultState) {
  return {
    role: state.role,
    vaultId: state.vaultId,
    name: state.name,
    networkPath: state.networkPath,
    port: state.port,
    serverHost: state.serverHost,
    connected: state.connected
  }
}
