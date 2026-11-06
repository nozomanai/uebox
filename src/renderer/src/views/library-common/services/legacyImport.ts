/**
 * 旧版导入的共用部分。
 *
 * 蓝图库和材质库导的是**同一个**旧版数据库 —— 老版本把蓝图节点和材质节点
 * 混在一张表里，靠 T3D 代码的特征区分。所以扫库、选文件、读表这三件事只有
 * 一份，两边各自决定「哪些行归我」以及怎么转成自己的数据模型。
 */

/** 扫到的一个候选数据库 */
export interface LegacyDbCandidate {
  path: string
  userId: string
  sizeKB: number
}

export interface LegacyScanResult {
  found: boolean
  dbPaths: LegacyDbCandidate[]
}

/** IPC 返回的旧版节点行 */
export interface LegacyNodeRow {
  id: number
  folderKey: string
  bluePrintKey: string
  name: string
  /** 旧库里这一列允许为空，不筛类型的通道会把 NULL 原样交过来 */
  code: string | null
  type: string
  note: string
  color: string
  img: string
  AvaVersion: string
  folderFatherKeys: string
  updateTime: string
}

/** IPC 返回的旧版文件夹行 */
export interface LegacyFolderRow {
  id: number
  title: string
  key: string
  folderKey: string
  folderName: string
  deractFatherKey: string
}

export interface LegacyReadResult {
  blueprints: LegacyNodeRow[]
  folders: LegacyFolderRow[]
}

/** 预览里的一条：够画摘要就行，不需要把整条数据带上来 */
export interface LegacyPreviewEntry {
  id: string
  name: string
  type: string
  folderKey: string
  /** 库里已经有了，导入时会跳过 */
  exists?: boolean
}

export interface LegacyPreviewFolder {
  folderKey: string
  title: string
  entryCount: number
}

export interface LegacyImportPreview {
  entries: LegacyPreviewEntry[]
  folders: LegacyPreviewFolder[]
  /** 这个库里不归本模块管的行数（蓝图侧数材质节点，材质侧数蓝图节点） */
  totalSkipped: number
}

export interface LegacyImportReport {
  total: number
  imported: number
  skipped: number
  collections: number
}

/**
 * 一个库的旧版导入实现。
 *
 * 向导只认这个接口，不知道自己导的是蓝图还是材质。
 */
export interface LegacyImportService {
  preview(dbPath: string): Promise<LegacyImportPreview>
  execute(
    dbPath: string,
    selectedFolderKeys: Set<string>,
    onProgress?: (current: number, total: number) => void
  ): Promise<LegacyImportReport>
}

// ==================== 共用 IPC ====================

export async function scanLegacyDb(): Promise<LegacyScanResult> {
  return window.electron.ipcRenderer.invoke('legacy:scan-db')
}

export async function selectLegacyDb(): Promise<string | null> {
  return window.electron.ipcRenderer.invoke('legacy:select-db')
}

/**
 * 主进程已经按蓝图类型筛过一遍的行。蓝图库用这一条。
 */
export async function readLegacyNodes(dbPath: string): Promise<LegacyReadResult> {
  return window.electron.ipcRenderer.invoke('legacy:import-blueprints', dbPath)
}

/**
 * 旧版表里的全部行，主进程不做类型筛选，由调用方自己分类。
 *
 * 材质库用这一条：`legacy:import-blueprints` 筛掉的正是材质节点和材质函数，
 * 从那条通道读永远拿不到材质。
 */
export async function readAllLegacyNodes(dbPath: string): Promise<LegacyReadResult> {
  return window.electron.ipcRenderer.invoke('legacy:read-all-nodes', dbPath)
}

// ==================== 共用工具 ====================

/**
 * 旧版没有「这是蓝图还是材质」的字段，只能从 T3D 代码里认。
 * 两个库共用这一份判断，免得各认各的、同一行被两边都收下或都漏掉。
 *
 * `code` 收 `null`：旧库里确实有 code 为空的行（旧的蓝图通道在主进程里就
 * 用 `bp.code && ...` 把它们滤掉了），而不筛类型的 `readAllLegacyNodes`
 * 会原样带上来。默认参数只挡 `undefined`，`null.trim()` 当场抛 TypeError，
 * 一条这样的行就让整个导入预览报错。
 */
export function detectLegacyNodeType(code?: string | null): string {
  if (!code) return '脚本代码'
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

/** 文件夹 key → 行 */
export function buildFolderMap(folders: LegacyFolderRow[]): Map<string, LegacyFolderRow> {
  return new Map(folders.map((f) => [f.folderKey, f]))
}

/** 文件夹的完整路径名，用于重名消歧 */
export function getFolderPath(
  folderKey: string,
  folderMap: Map<string, LegacyFolderRow>,
  maxDepth = 3
): string {
  const parts: string[] = []
  let current = folderMap.get(folderKey)
  let depth = 0

  while (current && depth < maxDepth) {
    parts.unshift(current.title)
    if (!current.deractFatherKey || current.deractFatherKey === current.folderKey) break
    current = folderMap.get(current.deractFatherKey)
    depth++
  }

  return parts.join(' / ')
}

/**
 * 按选中的文件夹过滤。
 *
 * 不属于任何文件夹的行始终保留 —— 它们在界面上没有对应的复选框，
 * 排除掉的话用户没有任何办法把它们导进来。
 */
export function matchesSelectedFolders(
  folderKey: string,
  selectedFolderKeys: Set<string>
): boolean {
  if (!folderKey) return true
  return selectedFolderKeys.has(folderKey)
}

/** 把「按文件夹分组的条目」整理成预览用的文件夹列表，多的排前面 */
export function buildPreviewFolders(
  entries: readonly { folderKey: string }[],
  folderMap: Map<string, LegacyFolderRow>,
  unknownTitle: string
): LegacyPreviewFolder[] {
  const counts = new Map<string, number>()
  for (const entry of entries) {
    if (!entry.folderKey) continue
    counts.set(entry.folderKey, (counts.get(entry.folderKey) || 0) + 1)
  }

  return Array.from(counts.entries())
    .map(([folderKey, entryCount]) => ({
      folderKey,
      title: folderMap.get(folderKey)?.title || unknownTitle,
      entryCount
    }))
    .sort((a, b) => b.entryCount - a.entryCount)
}
