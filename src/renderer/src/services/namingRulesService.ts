/**
 * 命名规则配置管理服务（渲染进程）
 */
import type { CustomRuleMatch, NamingRulesConfig } from '../types/namingRules'
import { DEFAULT_NAMING_RULES_CONFIG } from '../types/namingRules'

/** 四张「出厂表垫底」的映射表 —— 主进程按同一组键名拆稀疏覆盖 */
const MAP_FIELDS = [
  'assetPrefixes',
  'assetTypeToDirectory',
  'libraryAssetTypeToDirectory',
  'extensionToAssetType'
] as const

type MapField = (typeof MAP_FIELDS)[number]

/**
 * 用户在设置页点了删除的出厂键，按表分组。
 *
 * 保存时跟着配置一起交给主进程。**删除必须这么显式报上来**：主进程不能靠
 * 「出厂有、这张表里没有」倒推，那样分不出「他点了删除」和「他正在改这一行、
 * 输入框此刻是空的」，后者会被自动保存当成删除永久落盘。
 */
export type RemovedNamingKeys = Partial<Record<MapField, string[]>>

/**
 * 保存前清理过的配置：四张映射表**可能缺字段**。
 *
 * 缺字段和「整张表被删空」是两件事，所以这里缺就不写这个键 —— 主进程那道
 * 「这次没给这张表」的守卫才接得上，照搬盘上那份。原来统一补 `{}` 等于把
 * 「没给」翻译成了一张空表，守卫形同虚设。
 */
type SanitizedNamingRulesConfig = Omit<NamingRulesConfig, MapField> &
  Partial<Record<MapField, Record<string, string>>>

// 配置缓存
let cachedConfig: NamingRulesConfig | null = null
let loadingPromise: Promise<NamingRulesConfig> | null = null

/**
 * 出厂配置的深拷贝。
 *
 * 展开一层不行：`textureSuffixPatterns` 和四张映射表会**按引用**交出去，
 * 调用方往里 push 一条（设置页的「添加纹理后缀」就是 push）就改到了模块级的
 * `DEFAULT_NAMING_RULES_CONFIG`，连带污染后面每一次回落。
 */
function factoryConfig(): NamingRulesConfig {
  return structuredClone(DEFAULT_NAMING_RULES_CONFIG)
}

/**
 * 加载命名规则配置
 */
export async function loadNamingRulesConfig(): Promise<NamingRulesConfig> {
  // 如果已有缓存，直接返回
  if (cachedConfig) {
    return cachedConfig
  }

  // 如果正在加载，等待加载完成
  if (loadingPromise) {
    return loadingPromise
  }

  // 开始加载
  loadingPromise = (async () => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const config = await (window as any).api.namingRules.loadConfig()
      cachedConfig = config
      return config
    } catch (error) {
      console.error('[NamingRulesService] 加载配置失败:', error)
      // 失败时使用默认配置
      cachedConfig = factoryConfig()
      return cachedConfig
    } finally {
      loadingPromise = null
    }
  })()

  return loadingPromise
}

/**
 * 清理配置对象，确保只包含可序列化的数据
 * 使用 JSON 序列化/反序列化来移除 Vue 响应式代理和不可序列化的内容
 */
function sanitizeConfig(config: NamingRulesConfig): SanitizedNamingRulesConfig {
  try {
    // 使用 JSON 序列化/反序列化来创建纯 JavaScript 对象
    // 这会移除 Vue 的响应式代理和任何不可序列化的内容
    const jsonString = JSON.stringify(config)
    const parsed = JSON.parse(jsonString) as Partial<NamingRulesConfig>

    // 确保所有必需字段都存在，使用默认值填充
    const sanitized: SanitizedNamingRulesConfig = {
      version: String(parsed.version || '1.0.0'),
      textureSuffixPatterns: (parsed.textureSuffixPatterns || []).map((pattern) => ({
        pattern: String(pattern.pattern || ''),
        suffix: String(pattern.suffix || ''),
        type: String(pattern.type || ''),
        enabled: pattern.enabled !== false // 默认为 true
      })),
      namingConvention: (parsed.namingConvention ||
        'pascalCase') as NamingRulesConfig['namingConvention'],
      autoAddPrefix: parsed.autoAddPrefix !== undefined ? Boolean(parsed.autoAddPrefix) : true,
      autoDetectTextureType:
        parsed.autoDetectTextureType !== undefined ? Boolean(parsed.autoDetectTextureType) : true,
      customRules: (parsed.customRules || []).map((rule) => ({
        name: String(rule.name || ''),
        // 只认这三个位置，别的一律回落到「包含」—— 这份 sanitize 是存盘前的最后一道，
        // 放一个不认识的值进去，整理那边 switch 会走 default，跟用户看到的选项不是一件事
        match: (['startsWith', 'endsWith', 'contains'] as const).includes(
          rule.match as CustomRuleMatch
        )
          ? rule.match
          : 'contains',
        text: String(rule.text || ''),
        replacement: String(rule.replacement || ''),
        enabled: rule.enabled !== false,
        description: rule.description ? String(rule.description) : undefined
      }))
    }

    // 四张映射表：给了才写，没给就不写这个键（见 SanitizedNamingRulesConfig）
    for (const field of MAP_FIELDS) {
      const table = parsed[field]
      if (table && typeof table === 'object') sanitized[field] = { ...table }
    }

    return sanitized
  } catch (error) {
    console.error('[NamingRulesService] 清理配置对象失败:', error)
    // 如果序列化失败，返回默认配置
    return factoryConfig()
  }
}

/** 删除列表也过一遍：去掉响应式代理、空列表和重复键，省得每次保存都重报一遍 */
function sanitizeRemovedKeys(removedKeys: RemovedNamingKeys): RemovedNamingKeys {
  const sanitized: RemovedNamingKeys = {}
  for (const field of MAP_FIELDS) {
    const keys = removedKeys[field]
    if (!Array.isArray(keys)) continue
    const unique = [...new Set(keys.filter((key) => typeof key === 'string' && key.length > 0))]
    if (unique.length > 0) sanitized[field] = unique
  }
  return sanitized
}

/**
 * 保存命名规则配置。
 *
 * `removedKeys` 是调用方点掉的出厂键。**不给的话这次就一条删除都不记**，
 * 盘上已经记着的那些由主进程保留 —— 所以调用方不需要攒全历史，只报自己这一轮点掉的。
 */
export async function saveNamingRulesConfig(
  config: NamingRulesConfig,
  removedKeys?: RemovedNamingKeys
): Promise<boolean> {
  try {
    // 清理配置对象，确保可序列化
    const sanitized = sanitizeConfig(config)
    const removed = removedKeys ? sanitizeRemovedKeys(removedKeys) : {}
    const payload =
      Object.keys(removed).length > 0 ? { ...sanitized, removedKeys: removed } : sanitized
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const success = await (window as any).api.namingRules.saveConfig(payload)
    if (success) {
      // 更新缓存（使用清理后的配置）。缺了映射表的那种不进缓存：那张表以盘上的为准，
      // 补一张出厂表进来等于拿假数据糊住下一次 getNamingRulesConfig
      //
      // 注意这份缓存是**设置页此刻的视图**，不是盘上那份：清空了输入框的那一行不在
      // 这里面，而主进程把它当「这一刻没值」照旧保留（见 inheritedOverlay）。
      // 目前只有设置页读它、重开页面就会被 refreshNamingRulesConfig 刷掉，所以无害；
      // 再加一个消费者（导入、整理之类按它决定前缀）之前，先改成回读主进程那份。
      const complete = MAP_FIELDS.every((field) => sanitized[field])
      cachedConfig = complete ? (sanitized as NamingRulesConfig) : null
      // 触发配置更新事件
      window.dispatchEvent(
        new CustomEvent('naming-rules-config-changed', {
          detail: sanitized
        })
      )
    }
    return success
  } catch (error) {
    console.error('[NamingRulesService] 保存配置失败:', error)
    console.error('[NamingRulesService] 配置对象:', config)
    return false
  }
}

/**
 * 获取当前配置（同步，从缓存读取）
 */
export function getNamingRulesConfig(): NamingRulesConfig {
  if (cachedConfig) {
    return cachedConfig
  }
  // 如果没有缓存，返回默认配置（异步加载会在后台进行）
  return factoryConfig()
}

/**
 * 重置为默认配置
 */
export async function resetNamingRulesConfig(): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const success = await (window as any).api.namingRules.resetConfig()
  if (success) {
    cachedConfig = factoryConfig()
    window.dispatchEvent(
      new CustomEvent('naming-rules-config-changed', {
        detail: cachedConfig
      })
    )
  }
  return success
}

/**
 * 强制刷新配置
 */
export async function refreshNamingRulesConfig(): Promise<NamingRulesConfig> {
  cachedConfig = null
  loadingPromise = null
  return loadNamingRulesConfig()
}
