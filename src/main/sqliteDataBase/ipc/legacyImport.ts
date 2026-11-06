/**
 * 旧版蓝图迁移 IPC 处理函数
 * 只读方式打开旧版 uebox-app 的 SQLite 数据库，
 * 读取 bluePrint 表和 folderData 表数据供渲染进程转换导入。
 */
import { ipcMain, app, dialog } from 'electron'
import { join } from 'path'
import { existsSync, readdirSync, statSync } from 'fs'
import Database from 'better-sqlite3'
import { mt } from '../../i18n'

// ==================== 类型 ====================

/** 旧版蓝图行记录 */
export interface LegacyBlueprintRow {
  id: number
  folderKey: string
  bluePrintKey: string
  name: string
  code: string
  type: string
  note: string
  color: string
  img: string
  AvaVersion: string
  shareId: string
  isOpen: string
  shareLink: string
  folderFatherKeys: string
  conversationId: string
  updateTime: string
}

/** 旧版文件夹行记录 */
export interface LegacyFolderRow {
  id: number
  title: string
  key: string
  folderKey: string
  isLeaf: string
  noaction: string
  type: string
  folderName: string
  deractFatherKey: string
  isProjectFolder: string
  isUpluginFolder: string
  path: string
  isCollect: string
  img: string
  updateTime: string
}

/** 扫描结果 */
export interface ScanResult {
  found: boolean
  dbPaths: { path: string; userId: string; sizeKB: number }[]
}

/** 导入结果 */
export interface ImportResult {
  blueprints: LegacyBlueprintRow[]
  folders: LegacyFolderRow[]
}

// ==================== 工具函数 ====================

/**
 * 获取旧版 uebox-app 可能的数据库路径
 * 旧版 package.json name 为 "ue-box"，Electron userData 路径为 %APPDATA%/ue-box/
 * DB 路径规则: %APPDATA%/ue-box/Data/<userId>/data.db
 */
function scanLegacyDbPaths(): ScanResult {
  const result: ScanResult = { found: false, dbPaths: [] }
  const appDataDir = app.getPath('appData')

  // 旧版 app 可能使用的目录名（package.json name = "ue-box"）
  const possibleAppNames = ['ue-box', 'uebox-app', 'ue-box-app']

  for (const appName of possibleAppNames) {
    try {
      const dataDir = join(appDataDir, appName, 'Data')
      if (!existsSync(dataDir)) continue

      const entries = readdirSync(dataDir, { withFileTypes: true })

      for (const entry of entries) {
        if (entry.isDirectory()) {
          const dbPath = join(dataDir, entry.name, 'data.db')
          if (existsSync(dbPath)) {
            const stats = statSync(dbPath)
            // 避免重复添加
            if (!result.dbPaths.some((d) => d.path === dbPath)) {
              result.dbPaths.push({
                path: dbPath,
                userId: entry.name,
                sizeKB: Math.round(stats.size / 1024)
              })
            }
          }
        }
      }

      // 也检查 Data/data.db (无 userId 子目录的旧格式)
      const legacyDbPath = join(dataDir, 'data.db')
      if (existsSync(legacyDbPath) && !result.dbPaths.some((d) => d.path === legacyDbPath)) {
        const stats = statSync(legacyDbPath)
        result.dbPaths.push({
          path: legacyDbPath,
          userId: 'default',
          sizeKB: Math.round(stats.size / 1024)
        })
      }
    } catch (err) {
      console.warn(`[LegacyImport] 扫描 ${appName} 路径失败:`, err)
    }
  }

  result.found = result.dbPaths.length > 0
  return result
}

/**
 * 从 T3D code 解析蓝图类型（复刻旧版 getBPType 逻辑）
 */
function getBPType(code = ''): string {
  if (code.trim().startsWith('BPGraph(')) return '蓝图函数'
  if (code.includes('MaterialExpressionFunctionOutput')) return '材质函数'
  if (code.includes('MaterialGraph')) return '材质节点'
  if (code.includes('/Script/PCG')) return 'PCG图表'
  if (code.includes('AnimGraph')) return '动画蓝图'
  if (code.includes('/Script/UMG')) return '控件蓝图'
  if (code.includes('BehaviorTreeEditor')) return 'AI 行为树'
  if (code.includes('MetasoundEditor')) return 'Metasound'
  if (code.includes('NiagaraEditor')) return 'Niagara'
  if (code.includes('BlueprintGraph')) return '蓝图节点'
  return '脚本代码'
}

/** 只保留蓝图节点相关类型 */
const BLUEPRINT_TYPES = new Set(['蓝图节点', '事件节点', '蓝图函数', '脚本代码'])

function isBlueprintType(code: string): boolean {
  return BLUEPRINT_TYPES.has(getBPType(code))
}

/**
 * 只读打开旧版 DB，读取蓝图和文件夹数据
 */
function readLegacyDatabase(dbPath: string): ImportResult {
  let db: Database.Database | null = null

  try {
    // 只读模式打开
    db = new Database(dbPath, { readonly: true })

    // 检查 bluePrint 表是否存在
    const tableCheck = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bluePrint'")
      .get()
    if (!tableCheck) {
      throw new Error('数据库中未找到 bluePrint 表')
    }

    // 读取所有蓝图
    const allBlueprints = db.prepare('SELECT * FROM bluePrint').all() as LegacyBlueprintRow[]

    // 只筛选蓝图节点类型
    const blueprints = allBlueprints.filter((bp) => bp.code && isBlueprintType(bp.code))

    // 读取蓝图相关的文件夹
    let folders: LegacyFolderRow[] = []
    try {
      const folderTableCheck = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='folderData'")
        .get()
      if (folderTableCheck) {
        folders = db
          .prepare("SELECT * FROM folderData WHERE folderName = 'bluePrint'")
          .all() as LegacyFolderRow[]
      }
    } catch {
      console.warn('[LegacyImport] 读取 folderData 表失败，跳过文件夹数据')
    }

    console.log(
      `[LegacyImport] 读取完成: ${allBlueprints.length} 总蓝图, ${blueprints.length} 蓝图节点, ${folders.length} 文件夹`
    )

    return { blueprints, folders }
  } finally {
    if (db) {
      try {
        db.close()
      } catch {
        /* ignore */
      }
    }
  }
}

/**
 * Read the raw legacy rows so different libraries can apply their own classification rules.
 */
function readLegacyDatabaseRaw(dbPath: string): ImportResult {
  let db: Database.Database | null = null

  try {
    db = new Database(dbPath, { readonly: true })

    const tableCheck = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='bluePrint'")
      .get()
    if (!tableCheck) {
      throw new Error('数据库中未找到 bluePrint 表')
    }

    const allBlueprints = db.prepare('SELECT * FROM bluePrint').all() as LegacyBlueprintRow[]

    let folders: LegacyFolderRow[] = []
    try {
      const folderTableCheck = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='folderData'")
        .get()
      if (folderTableCheck) {
        folders = db
          .prepare("SELECT * FROM folderData WHERE folderName = 'bluePrint'")
          .all() as LegacyFolderRow[]
      }
    } catch {
      console.warn('[LegacyImport] 读取 folderData 表失败，跳过文件夹数据')
    }

    console.log(
      `[LegacyImport] 读取原始数据完成: ${allBlueprints.length} rows, ${folders.length} folders`
    )

    return {
      blueprints: allBlueprints,
      folders
    }
  } finally {
    if (db) {
      try {
        db.close()
      } catch {
        /* ignore */
      }
    }
  }
}

// ==================== IPC 注册 ====================

export function registerLegacyImportIPC(): void {
  // 扫描旧版数据库路径
  ipcMain.handle('legacy:scan-db', async () => {
    try {
      return scanLegacyDbPaths()
    } catch (err) {
      console.error('[LegacyImport] scan-db 失败:', err)
      return { found: false, dbPaths: [] } as ScanResult
    }
  })

  // 手动选择数据库文件
  ipcMain.handle('legacy:select-db', async () => {
    const result = await dialog.showOpenDialog({
      title: mt('dialog.pickLegacyDb'),
      filters: [{ name: 'SQLite Database', extensions: ['db'] }],
      properties: ['openFile']
    })

    if (result.canceled || result.filePaths.length === 0) {
      return null
    }
    return result.filePaths[0]
  })

  // 读取旧版蓝图数据
  ipcMain.handle('legacy:import-blueprints', async (_event, dbPath: string) => {
    try {
      if (!dbPath || !existsSync(dbPath)) {
        throw new Error(`数据库文件不存在: ${dbPath}`)
      }
      return readLegacyDatabase(dbPath)
    } catch (err) {
      console.error('[LegacyImport] import-blueprints 失败:', err)
      throw err
    }
  })

  // 读旧版 bluePrint 表的全部行，不按类型过滤。
  // 旧版把蓝图节点和材质节点混在这一张表里，材质库要的那批正好是
  // legacy:import-blueprints 过滤掉的那批，所以材质侧走这条、自己分类。
  ipcMain.handle('legacy:read-all-nodes', async (_event, dbPath: string) => {
    try {
      if (!dbPath || !existsSync(dbPath)) {
        throw new Error(`数据库文件不存在: ${dbPath}`)
      }
      return readLegacyDatabaseRaw(dbPath)
    } catch (err) {
      console.error('[LegacyImport] read-all-nodes 失败:', err)
      throw err
    }
  })
}
