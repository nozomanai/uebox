/**
 * 旧版材质导入。
 *
 * 旧版 uebox-app 把蓝图节点和材质节点混在同一张表里，靠 T3D 代码的特征区分。
 * 蓝图库那边导 `蓝图节点 / 蓝图函数 / 脚本代码`，这里导 `材质节点 / 材质函数` ——
 * 正是蓝图那边统计在「跳过 N 个」里的那批。
 *
 * 所以读表必须走不筛类型的 `readAllLegacyNodes`：蓝图那条通道在主进程里就把
 * 材质行滤掉了，从它读永远是 0 条。
 */
import { useMaterialLibraryStore } from '@renderer/store/modules/materialLibraryStore'
import {
  createEmptyGraphSummary,
  getMaterialCoverStyle,
  type MaterialCollection,
  type MaterialEntry,
  type MaterialEntryType
} from '@renderer/views/MaterialLibrary/types/material'
import {
  buildDependencyRecords,
  createMaterialEntryId,
  extractLegacyMaterialDependencies,
  extractLegacyMaterialParameters,
  summarizeLegacyGraph
} from './materialLibraryTransformers'
import {
  buildFolderMap,
  buildPreviewFolders,
  detectLegacyNodeType,
  getFolderPath,
  matchesSelectedFolders,
  readAllLegacyNodes,
  type LegacyImportPreview,
  type LegacyImportReport,
  type LegacyNodeRow
} from '@renderer/views/library-common/services/legacyImport'

/** 归材质库的旧版节点类型 */
const MATERIAL_TYPES = new Set(['材质节点', '材质函数'])

const UNKNOWN_FOLDER = '未知文件夹'
const LEGACY_TAG = '旧版导入'

function toEntryType(legacyType: string): MaterialEntryType {
  return legacyType === '材质函数' ? 'function' : 'material'
}

/** 旧版没有资产路径，用一个稳定的伪路径占位，去重也靠它 */
function buildAssetPath(entryType: MaterialEntryType, row: LegacyNodeRow): string {
  const folder = entryType === 'function' ? 'Functions' : 'Materials'
  return `/LegacyImport/${folder}/${row.name || row.bluePrintKey}`
}

function transformEntry(row: LegacyNodeRow, legacyType: string): MaterialEntry {
  const entryType = toEntryType(legacyType)
  const code = row.code || ''
  const updatedAt = row.updateTime ? Number(row.updateTime) * 1000 : Date.now()

  const parameters = extractLegacyMaterialParameters(code)
  const dependencies = extractLegacyMaterialDependencies(code)
  const graphSummary = code ? summarizeLegacyGraph(code) : createEmptyGraphSummary()

  return {
    id: createMaterialEntryId(entryType, row.bluePrintKey),
    name: row.name || '未命名材质',
    entryType,
    assetPath: buildAssetPath(entryType, row),
    engineVersion: row.AvaVersion || '5.3',
    description: row.note || '',
    tags: [LEGACY_TAG],
    thumbnail: undefined,
    coverStyle: getMaterialCoverStyle(entryType),
    createdAt: updatedAt,
    updatedAt,
    isFavorite: false,
    status: 'draft',
    materialDomain: entryType === 'function' ? 'Function' : 'Surface',
    blendMode: entryType === 'function' ? 'Function' : 'Opaque',
    shadingModel: entryType === 'function' ? 'Function' : 'DefaultLit',
    twoSided: false,
    usageFlags: [],
    // 旧库里只有图代码，没有编译结果，所以是 unknown 而不是 success
    compileStatus: 'unknown',
    compileDiagnostics: [],
    lastHealthCheckAt: undefined,
    nodeCount: graphSummary.nodeCount,
    connectionCount: graphSummary.connectionCount,
    graphSummary,
    graphBlueprintCode: code,
    scalarParameters: parameters.scalarParameters,
    vectorParameters: parameters.vectorParameters,
    textureParameters: parameters.textureParameters,
    staticSwitchParameters: parameters.staticSwitchParameters,
    textureDependencies: buildDependencyRecords('texture', dependencies.texturePaths),
    functionDependencies: buildDependencyRecords('function', dependencies.functionPaths),
    parameterCollectionDependencies: buildDependencyRecords(
      'parameterCollection',
      dependencies.parameterCollectionPaths
    ),
    missingDependencies: [],
    parentMaterialPath: undefined,
    childInstancePaths: [],
    referencedByPaths: [],
    collectionId: undefined,
    sourceOrigin: 'legacy',
    liveDataState: 'unavailable',
    syncIssues: [],
    lastSyncedAt: undefined,
    lastSyncAttemptAt: undefined,
    liveRefreshAvailable: false,
    legacyKey: row.bluePrintKey
  } as MaterialEntry
}

/** 这个旧库里有多少材质可以导，其中哪些已经在库中 */
export async function previewMigration(dbPath: string): Promise<LegacyImportPreview> {
  const { blueprints: rows, folders } = await readAllLegacyNodes(dbPath)
  const folderMap = buildFolderMap(folders)
  const existingIds = new Set(useMaterialLibraryStore().entries.map((entry) => entry.id))

  const eligible: { row: LegacyNodeRow; legacyType: string }[] = []
  let totalSkipped = 0

  for (const row of rows) {
    const legacyType = detectLegacyNodeType(row.code)
    if (!MATERIAL_TYPES.has(legacyType)) {
      totalSkipped++
      continue
    }
    eligible.push({ row, legacyType })
  }

  const entries = eligible.map(({ row, legacyType }) => ({
    id: createMaterialEntryId(toEntryType(legacyType), row.bluePrintKey),
    name: row.name || '未命名材质',
    type: legacyType,
    folderKey: row.folderKey || '',
    exists: existingIds.has(createMaterialEntryId(toEntryType(legacyType), row.bluePrintKey))
  }))

  return {
    entries,
    folders: buildPreviewFolders(entries, folderMap, UNKNOWN_FOLDER),
    totalSkipped
  }
}

/**
 * 把选中的文件夹里的材质写进库。
 *
 * 已经在库里的按 id 跳过 —— 旧版的 bluePrintKey 是稳定的，所以重复导入同一个库
 * 不会产生副本，也不会覆盖用户后来改过的内容。
 */
export async function executeMigration(
  dbPath: string,
  selectedFolderKeys: Set<string>,
  onProgress?: (current: number, total: number) => void
): Promise<LegacyImportReport> {
  const store = useMaterialLibraryStore()
  const { blueprints: rows, folders } = await readAllLegacyNodes(dbPath)
  const folderMap = buildFolderMap(folders)

  const eligible: { row: LegacyNodeRow; legacyType: string }[] = []
  for (const row of rows) {
    const legacyType = detectLegacyNodeType(row.code)
    if (!MATERIAL_TYPES.has(legacyType)) continue
    if (!matchesSelectedFolders(row.folderKey || '', selectedFolderKeys)) continue
    eligible.push({ row, legacyType })
  }

  const total = eligible.length
  const existingIds = new Set(store.entries.map((entry) => entry.id))
  const imported: MaterialEntry[] = []
  const folderGroups = new Map<string, string[]>()
  let skipped = 0

  for (let i = 0; i < eligible.length; i++) {
    const { row, legacyType } = eligible[i]
    const entry = transformEntry(row, legacyType)

    if (existingIds.has(entry.id)) {
      skipped++
      onProgress?.(i + 1, total)
      continue
    }

    imported.push(entry)
    existingIds.add(entry.id)

    if (row.folderKey) {
      const group = folderGroups.get(row.folderKey) || []
      group.push(entry.id)
      folderGroups.set(row.folderKey, group)
    }

    onProgress?.(i + 1, total)
  }

  // 只有 ≥2 个成员的文件夹才值得变成集合，一个的单独摆着就行
  const titleCounts = new Map<string, number>()
  for (const folderKey of folderGroups.keys()) {
    const title = folderMap.get(folderKey)?.title
    if (title) titleCounts.set(title, (titleCounts.get(title) || 0) + 1)
  }

  const collections: MaterialCollection[] = []
  for (const [folderKey, entryIds] of folderGroups) {
    if (entryIds.length < 2) continue
    const folder = folderMap.get(folderKey)
    if (!folder) continue
    // 同名文件夹用完整路径消歧，否则两个「材质」集合分不清
    const name =
      (titleCounts.get(folder.title) || 0) > 1 ? getFolderPath(folderKey, folderMap) : folder.title
    collections.push({
      id: `legacy-collection-${folderKey}`,
      name,
      entryIds,
      createdAt: Date.now()
    })
  }

  store.importLegacyEntries(imported, collections)

  return {
    total,
    imported: imported.length,
    skipped,
    collections: collections.length
  }
}
