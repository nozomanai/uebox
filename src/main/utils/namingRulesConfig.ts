/**
 * 命名规则配置文件管理（主进程）
 */
import { app } from 'electron'
import { dirname, join } from 'path'
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import type {
  CustomRule,
  CustomRuleMatch,
  NamingConvention,
  NamingRulesConfig,
  TextureSuffixPattern
} from '../../renderer/src/types/namingRules'
import { DEFAULT_NAMING_RULES_CONFIG } from '../../renderer/src/types/namingRules'

const CONFIG_FILE_NAME = 'naming-rules.json'

/**
 * 以出厂表垫底的那四张映射表。
 *
 * `libraryAssetTypeToDirectory` 在列表里，但设置页**没有**它的编辑入口
 * （理由见 ProfileNamingRules.vue 里那段注释），所以现在不可能产生它的删除。
 * 以后给它加编辑器的话注意：`projectImport.ts` 查这张表的兜底是空串
 * （`libraryAssetTypeToDirectory[assetType] || ''`），删掉一行会让 `destinationPath`
 * 变成空路径。加编辑器的同时要先把那个兜底补成一个合理目录。
 */
const MAP_FIELDS = [
  'assetPrefixes',
  'assetTypeToDirectory',
  'libraryAssetTypeToDirectory',
  'extensionToAssetType'
] as const

type MapField = (typeof MAP_FIELDS)[number]

/** 用户在设置页点了删除的出厂键，按表分组 */
export type RemovedNamingKeys = Partial<Record<MapField, string[]>>

/**
 * 保存时交上来的东西：完整配置 + 这一次点掉了哪些键。
 *
 * **删除是显式报上来的，不是从表里缺了哪个键倒推出来的。** 倒推分不出
 * 「他点了删除」和「他正在把 `A_` 改成 `SFX_`、这一刻输入框是空的」——
 * 后者在自动保存下会被当成删除永久落盘，而那是取不回来的（只能「恢复默认」，
 * 代价是抹掉他其他所有自定义）。
 *
 * `removedKeys` 顺着配置对象一起过 IPC，不另加一个参数：preload 的桥
 * （`window.api.namingRules.saveConfig`）只收一个值。
 */
export type NamingRulesSavePayload = NamingRulesConfig & { removedKeys?: RemovedNamingKeys }

/**
 * 配置文件的格式版本。**没有这个字段的是 2026-11 以前的全量快照**，
 * 读的时候由 `migrateFullSnapshot` 翻成稀疏形状，见那个函数上面那段。
 */
const STORED_SCHEMA = 2

/**
 * 落盘的形状 —— 和交给调用方的 `NamingRulesConfig` **不是同一个东西**。
 *
 * 四张映射表存的是**稀疏覆盖**：只有用户改过的键（值和出厂不同）和他自己加的键在里面。
 * 他删掉的出厂键记进 `removed`。读取时 `mergeWithDefaults` 按
 * 「铺出厂默认 → 剔掉 removed → 叠上覆盖」把它还原成一张完整的表，
 * 所以消费方（导入落盘、整理审计）拿到的仍旧是原来那个完整结构。
 *
 * 这么分开有两件事同时成立，而原来的全量快照只能二选一：
 *
 *   - **删得掉。** 用户在设置页删掉 `SoundWave` 那一行，下次读盘它不会被出厂值垫回来，
 *     导入时 `assetPrefixes['SoundWave']` 真的查不到，文件就不带前缀落盘。
 *   - **后续版本新增的条目仍然到得了老用户。** 没被改过、没被删掉的键压根不在文件里，
 *     所以我们之后新增 `usdz → StaticMesh`、改掉某个出厂前缀，他下次启动就拿到了。
 */
interface StoredNamingRules extends Partial<Record<MapField, Record<string, string>>> {
  schema?: number
  version?: string
  /** 用户删掉的出厂键，按表分组 */
  removed?: RemovedNamingKeys
  textureSuffixPatterns?: TextureSuffixPattern[]
  namingConvention?: NamingConvention
  autoAddPrefix?: boolean
  autoDetectTextureType?: boolean
  customRules?: CustomRule[]
}

/**
 * 获取配置文件路径。
 *
 * 拿不到就返回 null 而不是抛：`app.getPath` 在 electron 的 app 还没 ready、
 * 或者根本不在 electron 里（单元测试）的时候不可用。那不是错误，只是「这次没有
 * 用户配置可读」，调用方回落到默认值就行 —— 不该在日志里刷一条像故障的红字。
 */
function getConfigPath(): string | null {
  const userDataPath = app?.getPath?.('userData')
  return userDataPath ? join(userDataPath, CONFIG_FILE_NAME) : null
}

/**
 * 读盘并翻成稀疏形状。
 *
 * 三条回落路径都交出 `{}`（= 纯出厂值）：拿不到 userData、文件还不存在、文件坏了。
 * 前两条恰恰是最容易被忽略的，而 agent 侧每次 resolveUserNamingPolicy
 * 在 app ready 之前都走这里。
 */
function readStoredConfig(): StoredNamingRules {
  const configPath = getConfigPath()
  if (!configPath) return {}

  try {
    if (existsSync(configPath)) {
      const parsed = JSON.parse(readFileSync(configPath, 'utf-8')) as StoredNamingRules | null
      if (!parsed || typeof parsed !== 'object') return {}
      return parsed.schema === STORED_SCHEMA ? parsed : migrateFullSnapshot(parsed)
    }
  } catch (error) {
    console.error('[NamingRulesConfig] 读取配置文件失败:', error)
  }

  return {}
}

/**
 * 老格式（全量快照）翻成稀疏覆盖。
 *
 * 快照里和出厂值不同的键、以及出厂表里没有的键，都是用户自己的东西，原样搬进覆盖 ——
 * **升级不丢他的自定义规则**。
 *
 * `removed` 留空是故意的：老格式里「某个出厂键不在快照里」有两种可能 ——
 * 他删过（老代码当场垫回来了，他看到的也是垫回来的样子），或者那个键是我们后来才加的、
 * 他那份快照拍得早。分不出来的东西不猜，所以迁移这一刻**一条删除都不记**，
 * 他看到的表和升级前完全一样。想删的那一行再点一次删除，这回是真的。
 */
function migrateFullSnapshot(legacy: StoredNamingRules): StoredNamingRules {
  const migrated: StoredNamingRules = { ...legacy, schema: STORED_SCHEMA, removed: {} }

  for (const field of MAP_FIELDS) {
    const snapshot = legacy[field]
    if (!snapshot || typeof snapshot !== 'object') {
      delete migrated[field]
      continue
    }
    migrated[field] = overlayOf(field, snapshot)
  }

  return migrated
}

/** 一张完整的表里，哪些键是用户改过或自己加的 */
function overlayOf(field: MapField, table: Record<string, string>): Record<string, string> {
  const factory: Record<string, string> = DEFAULT_NAMING_RULES_CONFIG[field]
  const overlay: Record<string, string> = {}
  for (const [key, value] of Object.entries(table)) {
    if (factory[key] !== value) overlay[key] = value
  }
  return overlay
}

/**
 * 上次存的覆盖里，这次该继续往下带的那些键。
 *
 * **覆盖是「继承 + 叠加」，不是整份替换。** 这次交上来的表里没有的键分两种，
 * 语义和出厂键那边完全对称：
 *
 * - **显式报了删除**：不往下继承。出厂键另外记进 `removed`；用户自己加的键
 *   不进覆盖就等于没了，不需要删除列表。
 * - **只是这一刻没值**（输入框清空了、这一行还没填完）：照搬上次存的那个值。
 *
 * 不继承的后果是真的丢数据：用户自己加的 `SkeletalMeshLOD → SKM_` 想改成 `LOD_`，
 * 全选删除之后停顿两秒就自动保存了一次，这一行不在表里 —— 覆盖整份重算，这个键
 * 落盘之后再也回不来，连「恢复默认」都救不回（出厂表里压根没有它）。出厂键上的
 * 覆盖值同理：`SoundWave: SFX_` 清空一下就静默退回出厂的 `A_`。
 */
function inheritedOverlay(
  previousOverlay: Record<string, string> | undefined,
  incoming: Record<string, string>,
  justRemoved: string[] | undefined
): Record<string, string> {
  if (!previousOverlay) return {}
  const removed = new Set((justRemoved ?? []).filter((key) => typeof key === 'string'))
  const kept: Record<string, string> = {}
  for (const [key, value] of Object.entries(previousOverlay)) {
    // 「这张表里还在的键一定没被删掉」—— 和 removedFor 第二道过滤同一条规则，
    // 所以「删掉又填回来」在两条路上都自己解开
    if (key in incoming || removed.has(key)) continue
    kept[key] = value
  }
  return kept
}

/**
 * 这张表的删除列表：盘上已经记着的，加上这次点掉的。
 *
 * 两道过滤：
 *
 * - **只记出厂键。** 用户自己加的键不进覆盖就等于没了，不需要删除列表。
 * - **这张表里还在的键一定没被删掉。** 「删掉又填回来」靠这一条自己解开 ——
 *   哪怕他填回去的值和出厂一样（于是覆盖里没有这个键），行也会回来。
 */
function removedFor(
  field: MapField,
  stored: string[] | undefined,
  justRemoved: string[] | undefined,
  table: Record<string, string>
): string[] {
  const factory: Record<string, string> = DEFAULT_NAMING_RULES_CONFIG[field]
  const keys = new Set<string>()
  for (const list of [stored, justRemoved]) {
    if (!Array.isArray(list)) continue
    for (const key of list) {
      if (typeof key !== 'string') continue
      if (key in factory && !(key in table)) keys.add(key)
    }
  }
  return [...keys]
}

/**
 * 读取配置
 */
export function loadNamingRulesConfig(): NamingRulesConfig {
  return mergeWithDefaults(readStoredConfig())
}

/**
 * 保存配置文件
 */
export function saveNamingRulesConfig(config: NamingRulesSavePayload): boolean {
  return writeStored(toStored(config))
}

/** 落盘。目录不存在就建出来 */
function writeStored(stored: StoredNamingRules): boolean {
  const configPath = getConfigPath()
  if (!configPath) {
    console.error('[NamingRulesConfig] 拿不到用户数据目录，这次没保存')
    return false
  }

  try {
    const dir = dirname(configPath)
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    writeFileSync(configPath, JSON.stringify(stored, null, 2), 'utf-8')
    return true
  } catch (error) {
    console.error('[NamingRulesConfig] 保存配置文件失败:', error)
    return false
  }
}

/**
 * 完整配置拆成落盘的稀疏形状。
 *
 * 表里缺了某个键只说明「这一刻没值」（输入框清空了、这一行还没填完），不说明他删了它。
 * 所以缺键在两处都按「没碰过」处理：
 *
 * - 覆盖 = 上次存的覆盖里**这次表中没有、也没被报删除**的键，叠上这次算出来的
 *   覆盖（见 `inheritedOverlay`）。整份重算会把清空那一刻的空白永久写进文件。
 * - 删除只认调用方显式报上来的 `removedKeys`，外加盘上已经记着的那些
 *   （见 `NamingRulesSavePayload`）。
 */
function toStored(config: NamingRulesSavePayload): StoredNamingRules {
  const previous = readStoredConfig()
  const stored: StoredNamingRules = {
    schema: STORED_SCHEMA,
    version: config.version || DEFAULT_NAMING_RULES_CONFIG.version,
    // 这几项本来就是整份覆盖（数组型的删除一直是真能删掉的），原样存
    textureSuffixPatterns: Array.isArray(config.textureSuffixPatterns)
      ? config.textureSuffixPatterns.map((p) => ({ ...p }))
      : previous.textureSuffixPatterns,
    namingConvention: config.namingConvention || DEFAULT_NAMING_RULES_CONFIG.namingConvention,
    autoAddPrefix:
      config.autoAddPrefix !== undefined
        ? config.autoAddPrefix
        : DEFAULT_NAMING_RULES_CONFIG.autoAddPrefix,
    autoDetectTextureType:
      config.autoDetectTextureType !== undefined
        ? config.autoDetectTextureType
        : DEFAULT_NAMING_RULES_CONFIG.autoDetectTextureType,
    // 存盘前也规整一遍：老的 pattern 翻成 match + text，enabled 补成布尔值。
    // 读写两侧用同一套规则，存进去的东西和下次读出来的东西才一致
    customRules: (Array.isArray(config.customRules)
      ? config.customRules
      : (previous.customRules ?? [])
    ).map(normalizeCustomRule)
  }

  const removed: RemovedNamingKeys = {}
  for (const field of MAP_FIELDS) {
    const incoming = config[field]
    // 这次没给这张表（类型上不该发生，但 IPC 那头是任意 JSON）：
    // 覆盖和删除列表都照搬上次存的，这次当没碰过它
    if (!incoming || typeof incoming !== 'object') {
      const keptOverlay = previous[field]
      if (keptOverlay) stored[field] = keptOverlay
      const keptRemoved = previous.removed?.[field]
      // 有实际内容才写，免得文件里多出一个 "removed": {} 或者 undefined
      if (keptRemoved?.length) removed[field] = keptRemoved
      continue
    }

    const overlay = {
      ...inheritedOverlay(previous[field], incoming, config.removedKeys?.[field]),
      ...overlayOf(field, incoming)
    }
    if (Object.keys(overlay).length > 0) stored[field] = overlay
    const gone = removedFor(field, previous.removed?.[field], config.removedKeys?.[field], incoming)
    if (gone.length > 0) removed[field] = gone
  }
  if (Object.keys(removed).length > 0) stored.removed = removed

  return stored
}

/**
 * 还原成完整配置：铺出厂默认 → 剔掉用户删掉的键 → 叠上他改过的值。
 *
 * 顺序上覆盖在删除之后，所以一个「删掉又重新加回来」的键按他现在填的值算。
 *
 * 另外每张表都重新建一个对象 —— `??` 那种写法会把模块级的
 * `DEFAULT_NAMING_RULES_CONFIG.xxx` **按引用**交出去，谁改一下加载回来的 config
 * 就污染了整个进程的默认值。
 */
function applyMap(field: MapField, stored: StoredNamingRules): Record<string, string> {
  const merged: Record<string, string> = { ...DEFAULT_NAMING_RULES_CONFIG[field] }
  for (const key of stored.removed?.[field] ?? []) {
    delete merged[key]
  }
  return Object.assign(merged, stored[field] ?? {})
}

function mergeWithDefaults(stored: StoredNamingRules): NamingRulesConfig {
  return {
    version: stored.version || DEFAULT_NAMING_RULES_CONFIG.version,
    assetPrefixes: applyMap('assetPrefixes', stored),
    // 逐条重建，不把出厂那个数组本身交出去 —— 它装的是可变对象，
    // 按引用交出去等于把进程级默认值摊开给每个调用方随手改
    textureSuffixPatterns: (Array.isArray(stored.textureSuffixPatterns)
      ? stored.textureSuffixPatterns
      : DEFAULT_NAMING_RULES_CONFIG.textureSuffixPatterns
    ).map((p) => ({ ...p })),
    assetTypeToDirectory: applyMap('assetTypeToDirectory', stored),
    libraryAssetTypeToDirectory: applyMap('libraryAssetTypeToDirectory', stored),
    extensionToAssetType: applyMap('extensionToAssetType', stored),
    namingConvention: stored.namingConvention || DEFAULT_NAMING_RULES_CONFIG.namingConvention,
    autoAddPrefix:
      stored.autoAddPrefix !== undefined
        ? stored.autoAddPrefix
        : DEFAULT_NAMING_RULES_CONFIG.autoAddPrefix,
    autoDetectTextureType:
      stored.autoDetectTextureType !== undefined
        ? stored.autoDetectTextureType
        : DEFAULT_NAMING_RULES_CONFIG.autoDetectTextureType,
    customRules: (Array.isArray(stored.customRules)
      ? stored.customRules
      : (DEFAULT_NAMING_RULES_CONFIG.customRules ?? [])
    ).map(normalizeCustomRule)
  }
}

/** 老配置里那个正则字段。留着只为把它翻成新形状，别在别处用 */
type LegacyCustomRule = CustomRule & { pattern?: string }

/**
 * 一条自定义规则读上来之后的规整。
 *
 * 两件事：
 *
 * 1. **enabled 补成真正的布尔值。** 类型上它是可选的，后端按 `!== false` 判
 *    （缺省=启用），而设置页那个开关的 checked 默认是 false —— 一条没写 enabled 的规则
 *    会显示成「关」，用户以为它没生效，整理时却照样按它改名。补一次，两边就说的是同一件事。
 * 2. **老的 `pattern`（正则）翻成 `match` + `text`。** 那个字段 2026-09-11 下线了，
 *    理由见 `CustomRuleMatch`。只翻译能确定等价的两种写法（`^字面量` 和 `字面量$`，
 *    外加整条都是普通字符的），剩下的翻不了 —— 与其猜一个语义不同的规则去改用户的资产，
 *    不如把 text 留空，让 compileCustomRules 报成 `empty`、摘要照实告诉用户重填一次。
 */
function normalizeCustomRule(rule: LegacyCustomRule): CustomRule {
  // pattern 不往下传：它已经不是配置的一部分了，跟着写回文件只会让下次读盘再走一遍迁移
  const { pattern = '', ...rest } = rule
  const enabled = rule.enabled !== false
  // **没有老的 pattern 就没什么要迁移的。** 光拿 text 当判据不行：一条刚加出来、
  // 还没填原文的新规则会被当成老配置去迁移，而 `plain` 那个正则是 `*`（空串也匹配），
  // 于是下面 `match` 被算成 'contains' 并盖掉用户刚在下拉里选的「开头是」——
  // 他填完名字还没填原文就关掉页面，回来看到的就是「包含」。
  // text 已经填了的照旧优先，免得手改过的文件里残留一个 pattern 把它顶掉
  if (rule.text || !pattern) return { ...rest, match: rule.match ?? 'contains', enabled }

  const plain = /^[A-Za-z0-9_-]*$/
  let match: CustomRuleMatch = 'contains'
  let text = ''
  if (pattern.startsWith('^') && plain.test(pattern.slice(1))) {
    match = 'startsWith'
    text = pattern.slice(1)
  } else if (pattern.endsWith('$') && plain.test(pattern.slice(0, -1))) {
    match = 'endsWith'
    text = pattern.slice(0, -1)
  } else if (plain.test(pattern)) {
    text = pattern
  }

  return { ...rest, match, text, enabled }
}

/**
 * 重置为默认配置：直接写一份**空的稀疏文件**，不走 `saveNamingRulesConfig`。
 *
 * 四张映射表一个覆盖键都不留、一条删除都不记，于是读回来就是纯出厂值 ——
 * 他删掉的出厂条目回来了，他自己加的键也一并没了，这正是「恢复默认」该有的样子。
 *
 * 不能交出厂表给 `saveNamingRulesConfig`：那条路的覆盖是继承 + 叠加的
 * （见 `inheritedOverlay`），出厂表里没有的自定义键会被继续带下去，
 * 重置完还留着半份旧配置。
 */
export function resetNamingRulesConfig(): boolean {
  return writeStored({
    schema: STORED_SCHEMA,
    version: DEFAULT_NAMING_RULES_CONFIG.version,
    textureSuffixPatterns: DEFAULT_NAMING_RULES_CONFIG.textureSuffixPatterns.map((p) => ({ ...p })),
    namingConvention: DEFAULT_NAMING_RULES_CONFIG.namingConvention,
    autoAddPrefix: DEFAULT_NAMING_RULES_CONFIG.autoAddPrefix,
    autoDetectTextureType: DEFAULT_NAMING_RULES_CONFIG.autoDetectTextureType,
    customRules: (DEFAULT_NAMING_RULES_CONFIG.customRules ?? []).map(normalizeCustomRule)
  })
}
