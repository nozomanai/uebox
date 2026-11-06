/**
 * @vitest-environment node
 *
 * 命名规则配置的读写。
 *
 * 这里守六件在界面上完全看不出来、只能靠测试盯住的事：
 *
 * 1. 后续版本新增的条目要能到达老用户 —— 没被改过的键压根不进文件，所以读的时候
 *    拿到的是**当前**出厂表。
 * 2. 用户删掉的出厂键要真的删得掉 —— 落盘记一份删除列表，重新读盘不被垫回来。
 *    这两件事原来只能二选一（全量快照 + 出厂垫底），见 StoredNamingRules 的注释。
 * 3. **只有显式点过删除的键才进删除列表。** 表里缺了某个键不算删除 —— 设置页在
 *    用户清空输入框的那一刻交上来的表就缺那个键，而自动保存是 2 秒防抖，
 *    正好落在他打字的停顿里。按缺键倒推的话，「把 A_ 改成 SFX_」中途会把这一行永久删掉。
 * 4. 交出去的表**不能是模块级默认对象本身** —— 按引用交出去的话，谁改一下
 *    加载回来的 config 就污染了整个进程。
 * 5. 没写 `enabled` 的规则算**启用**。后端按 `!== false` 判，而设置页那个开关的
 *    checked 默认是 false —— 不在读的时候补齐，用户就会看到一条显示「关」、
 *    实际却在改他资产名字的规则。
 * 6. **覆盖是继承 + 叠加，不是整份替换。** 这次表里没有、也没报删除的键照搬上次存的值 ——
 *    否则「清空输入框 → 停顿两秒自动保存」会把他自己加的键和出厂键上的覆盖值
 *    永久抹掉，前者连「恢复默认」都救不回来。
 */

import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let userDataDir: string

vi.mock('electron', () => ({
  app: { getPath: () => userDataDir }
}))

import {
  loadNamingRulesConfig,
  resetNamingRulesConfig,
  saveNamingRulesConfig
} from './namingRulesConfig'
import type { NamingRulesSavePayload, RemovedNamingKeys } from './namingRulesConfig'
import { DEFAULT_NAMING_RULES_CONFIG } from '../../renderer/src/types/namingRules'
import type { NamingRulesConfig } from '../../renderer/src/types/namingRules'

const CONFIG_FILE = 'naming-rules.json'

type DeletableMap = 'assetPrefixes' | 'assetTypeToDirectory' | 'extensionToAssetType'

/**
 * 设置页点了删除之后交上来的那个形状：一张完整的表少了那一行，**外加**一份显式的删除列表。
 * 两样都有才算删除 —— 只少一行的那种见 `withoutKeys`。
 */
function afterRemoving(deleted: Partial<Record<DeletableMap, string>>): NamingRulesSavePayload {
  const removedKeys: RemovedNamingKeys = {}
  for (const [field, key] of Object.entries(deleted) as [DeletableMap, string][]) {
    removedKeys[field] = [key]
  }
  return { ...withoutKeys(deleted), removedKeys }
}

/** 一张完整的表少了几个键，但**没有**删除列表 —— 输入框被清空的那一刻就是这个形状 */
function withoutKeys(deleted: Partial<Record<DeletableMap, string>>): NamingRulesConfig {
  const config: NamingRulesConfig = { ...DEFAULT_NAMING_RULES_CONFIG }
  for (const [field, key] of Object.entries(deleted) as [DeletableMap, string][]) {
    const table = { ...DEFAULT_NAMING_RULES_CONFIG[field] }
    delete table[key]
    config[field] = table
  }
  return config
}

beforeEach(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'naming-rules-'))
})

afterEach(() => {
  rmSync(userDataDir, { recursive: true, force: true })
})

function writeConfig(partial: Record<string, unknown>): void {
  writeFileSync(join(userDataDir, CONFIG_FILE), JSON.stringify(partial), 'utf-8')
}

describe('loadNamingRulesConfig', () => {
  it('没有配置文件时回落到出厂值', () => {
    expect(loadNamingRulesConfig().assetPrefixes).toEqual(DEFAULT_NAMING_RULES_CONFIG.assetPrefixes)
  })

  it('逐条合并：文件里没有的条目由出厂值补上，后续版本新增的才到得了老用户', () => {
    writeConfig({ assetPrefixes: { StaticMesh: 'MESH_' } })

    const prefixes = loadNamingRulesConfig().assetPrefixes
    expect(prefixes.StaticMesh).toBe('MESH_') // 用户改的赢
    expect(prefixes.Texture).toBe(DEFAULT_NAMING_RULES_CONFIG.assetPrefixes.Texture) // 出厂垫底
  })

  it('交出来的表是新对象，不是模块级默认值本身', () => {
    writeConfig({ version: '1.0.0' })

    const cfg = loadNamingRulesConfig()
    expect(cfg.assetPrefixes).not.toBe(DEFAULT_NAMING_RULES_CONFIG.assetPrefixes)
    expect(cfg.assetTypeToDirectory).not.toBe(DEFAULT_NAMING_RULES_CONFIG.assetTypeToDirectory)
    expect(cfg.libraryAssetTypeToDirectory).not.toBe(
      DEFAULT_NAMING_RULES_CONFIG.libraryAssetTypeToDirectory
    )
    expect(cfg.extensionToAssetType).not.toBe(DEFAULT_NAMING_RULES_CONFIG.extensionToAssetType)
    // 这一张装的是**可变对象**，数组本身是新的还不够，里面每一条也得是新的
    expect(cfg.textureSuffixPatterns).not.toBe(DEFAULT_NAMING_RULES_CONFIG.textureSuffixPatterns)
    expect(cfg.textureSuffixPatterns[0]).not.toBe(
      DEFAULT_NAMING_RULES_CONFIG.textureSuffixPatterns[0]
    )

    // 改一下加载回来的配置，不该污染下一次读取。
    // 右边写死 'SM_'：拿 DEFAULT_NAMING_RULES_CONFIG.assetPrefixes.StaticMesh 去比的话，
    // 真的污染了两边会一起变成 'POLLUTED_'，这条断言永远绿
    cfg.assetPrefixes.StaticMesh = 'POLLUTED_'
    cfg.textureSuffixPatterns[0].suffix = '_POLLUTED'
    expect(loadNamingRulesConfig().assetPrefixes.StaticMesh).toBe('SM_')
    expect(loadNamingRulesConfig().textureSuffixPatterns[0].suffix).toBe('_D')
  })

  /**
   * 配置文件还不存在（全新安装）和拿不到 userData（app 还没 ready、单元测试）这两条
   * 回落路径最容易被漏掉，而 agent 侧每次 resolveUserNamingPolicy 都可能走后者。
   * 以前这两条 `return { ...DEFAULT }` —— 展开是浅拷贝，四张嵌套表照样按引用交出去。
   */
  it('没有配置文件时交出来的也是深拷贝', () => {
    const cfg = loadNamingRulesConfig()
    expect(cfg.assetPrefixes).not.toBe(DEFAULT_NAMING_RULES_CONFIG.assetPrefixes)
    expect(cfg.textureSuffixPatterns[0]).not.toBe(
      DEFAULT_NAMING_RULES_CONFIG.textureSuffixPatterns[0]
    )

    cfg.assetPrefixes.StaticMesh = 'POLLUTED_'
    expect(loadNamingRulesConfig().assetPrefixes.StaticMesh).toBe('SM_')
  })

  it('读盘失败（文件是坏 JSON）时也不交出默认对象本身', () => {
    writeFileSync(join(userDataDir, CONFIG_FILE), '{ 这不是 JSON', 'utf-8')

    const cfg = loadNamingRulesConfig()
    expect(cfg.assetPrefixes).not.toBe(DEFAULT_NAMING_RULES_CONFIG.assetPrefixes)
    expect(cfg.assetPrefixes.StaticMesh).toBe('SM_')
  })

  it('整个字段缺失（老版本配置）仍然回落到出厂值', () => {
    writeConfig({ version: '1.0.0' })

    const cfg = loadNamingRulesConfig()
    expect(cfg.assetPrefixes).toEqual(DEFAULT_NAMING_RULES_CONFIG.assetPrefixes)
    expect(cfg.assetTypeToDirectory).toEqual(DEFAULT_NAMING_RULES_CONFIG.assetTypeToDirectory)
  })

  it('没写 enabled 的自定义规则按启用算，补成真正的布尔值', () => {
    writeConfig({
      customRules: [{ name: '去掉 FINAL', match: 'endsWith', text: '_FINAL', replacement: '' }]
    })

    expect(loadNamingRulesConfig().customRules?.[0].enabled).toBe(true)
  })

  it('显式 enabled:false 原样保留', () => {
    writeConfig({
      customRules: [
        { name: '停用的', match: 'contains', text: 'x', replacement: 'y', enabled: false }
      ]
    })

    expect(loadNamingRulesConfig().customRules?.[0].enabled).toBe(false)
  })

  /**
   * 老配置里那个 `pattern`（正则）2026-09-11 下线了（理由见 CustomRuleMatch）。
   * 能确定等价的锚定字面量翻过来，翻不了的把 text 留空 —— 让 compileCustomRules
   * 报成 empty、摘要照实告诉用户重填一次，而不是猜一个语义不同的规则去改他的资产。
   */
  it('老的正则规则翻成新形状：锚定字面量翻得过来', () => {
    writeConfig({
      customRules: [
        { name: '结尾', pattern: '_FINAL$', replacement: '' },
        { name: '开头', pattern: '^Temp_', replacement: 'WIP_' },
        { name: '中间', pattern: 'copy', replacement: '' }
      ]
    })

    const rules = loadNamingRulesConfig().customRules ?? []
    expect(rules.map((r) => [r.match, r.text])).toEqual([
      ['endsWith', '_FINAL'],
      ['startsWith', 'Temp_'],
      ['contains', 'copy']
    ])
    // pattern 不往下传，否则下次读盘还会再走一遍迁移
    expect(rules.every((r) => !('pattern' in r))).toBe(true)
  })

  it('翻不了的正则把 text 留空，不猜一个语义不同的规则', () => {
    writeConfig({
      customRules: [{ name: '真正的正则', pattern: '(\\w+_)+FINAL', replacement: '' }]
    })

    expect(loadNamingRulesConfig().customRules?.[0].text).toBe('')
  })

  /**
   * 迁移的判据是「有没有老的 pattern」，不是「text 填了没有」。
   *
   * 拿 text 当判据的话，一条刚在设置页加出来、名字填了原文还没填的新规则会被当成老配置
   * 走迁移，而那个 `plain` 正则是 `*`（空串也匹配），于是 match 被算成 contains，
   * 盖掉用户刚在下拉里选的「开头是」—— 他这时关掉页面，回来看到的就是「包含」。
   */
  it('新规则原文还空着时，不把用户选的匹配位置改掉', () => {
    writeConfig({
      customRules: [{ name: '还没填完', match: 'startsWith', text: '', replacement: '' }]
    })

    const rule = loadNamingRulesConfig().customRules?.[0]
    expect(rule?.match).toBe('startsWith')
    expect(rule?.text).toBe('')
  })

  it('存盘再读回来也不会把匹配位置改掉', () => {
    saveNamingRulesConfig({
      ...DEFAULT_NAMING_RULES_CONFIG,
      customRules: [{ name: '还没填完', match: 'endsWith', text: '', replacement: '' }]
    })

    expect(loadNamingRulesConfig().customRules?.[0].match).toBe('endsWith')
  })
})

describe('saveNamingRulesConfig', () => {
  it('用户改过的值存得住，读回来还是他那个', () => {
    saveNamingRulesConfig({
      ...DEFAULT_NAMING_RULES_CONFIG,
      assetPrefixes: { ...DEFAULT_NAMING_RULES_CONFIG.assetPrefixes, StaticMesh: 'MESH_' }
    })

    expect(existsSync(join(userDataDir, CONFIG_FILE))).toBe(true)
    expect(loadNamingRulesConfig().assetPrefixes.StaticMesh).toBe('MESH_')
  })

  /**
   * 设置页上删掉一行，导入那边就真的查不到了 —— 这是这套格式存在的理由。
   * 三张映射表都走同一条路径，所以三张一起断言。
   */
  it('删掉出厂那一行，重新读盘它不再回来', () => {
    saveNamingRulesConfig(afterRemoving({ assetPrefixes: 'SoundWave' }))

    expect(loadNamingRulesConfig().assetPrefixes).not.toHaveProperty('SoundWave')
  })

  it('三张映射表的删除都存得住', () => {
    saveNamingRulesConfig(
      afterRemoving({
        assetPrefixes: 'SoundWave',
        assetTypeToDirectory: 'Blueprint',
        extensionToAssetType: 'tga'
      })
    )

    const cfg = loadNamingRulesConfig()
    expect(cfg.assetPrefixes).not.toHaveProperty('SoundWave')
    expect(cfg.assetTypeToDirectory).not.toHaveProperty('Blueprint')
    expect(cfg.extensionToAssetType).not.toHaveProperty('tga')
    // 同一张表里没被动过的条目一个都不能少
    expect(cfg.assetPrefixes.StaticMesh).toBe('SM_')
    expect(Object.keys(cfg.extensionToAssetType)).toHaveLength(
      Object.keys(DEFAULT_NAMING_RULES_CONFIG.extensionToAssetType).length - 1
    )
  })

  /**
   * 删掉的那条在导入落盘路径上真的不见了。
   * `projectImport.ts` 就是这么查的：`config.assetPrefixes[assetType] || ''`、
   * `config.assetTypeToDirectory[assetType] || '/Game/Imported'`、
   * `config.extensionToAssetType[ext] || 'Unknown'`。
   */
  it('删掉之后导入那边查不到，回落到各自的兜底值', () => {
    saveNamingRulesConfig(
      afterRemoving({
        assetPrefixes: 'SoundWave',
        assetTypeToDirectory: 'Blueprint',
        extensionToAssetType: 'tga'
      })
    )

    const cfg = loadNamingRulesConfig()
    expect(cfg.assetPrefixes['SoundWave'] || '').toBe('')
    expect(cfg.assetTypeToDirectory['Blueprint'] || '/Game/Imported').toBe('/Game/Imported')
    expect(cfg.extensionToAssetType['tga'] || 'Unknown').toBe('Unknown')
  })

  it('删除只记这一个键，不把整张表钉死在这一版的快照上', () => {
    saveNamingRulesConfig(afterRemoving({ extensionToAssetType: 'tga' }))

    // 文件里只有删除列表，没有那 22 个扩展名的全量快照 ——
    // 所以下个版本新增的扩展名照样到得了这个用户
    const stored = JSON.parse(readFileSync(join(userDataDir, CONFIG_FILE), 'utf-8'))
    expect(stored.removed.extensionToAssetType).toEqual(['tga'])
    expect(stored.extensionToAssetType).toBeUndefined()
  })

  it('改过的键存覆盖值，删掉的键记删除列表，两者互不影响', () => {
    const prefixes = { ...DEFAULT_NAMING_RULES_CONFIG.assetPrefixes, StaticMesh: 'MESH_' }
    delete (prefixes as Record<string, string>).SoundWave

    saveNamingRulesConfig({
      ...DEFAULT_NAMING_RULES_CONFIG,
      assetPrefixes: prefixes,
      removedKeys: { assetPrefixes: ['SoundWave'] }
    })

    const cfg = loadNamingRulesConfig()
    expect(cfg.assetPrefixes.StaticMesh).toBe('MESH_')
    expect(cfg.assetPrefixes).not.toHaveProperty('SoundWave')
  })

  it('删掉又自己加回来的键按他现在填的值算', () => {
    saveNamingRulesConfig(afterRemoving({ assetPrefixes: 'SoundWave' }))

    const cfg = loadNamingRulesConfig()
    cfg.assetPrefixes.SoundWave = 'SFX_'
    saveNamingRulesConfig(cfg)

    expect(loadNamingRulesConfig().assetPrefixes.SoundWave).toBe('SFX_')
  })

  it('「恢复默认」把删掉的出厂条目一并带回来', () => {
    saveNamingRulesConfig(afterRemoving({ assetPrefixes: 'SoundWave' }))
    expect(loadNamingRulesConfig().assetPrefixes).not.toHaveProperty('SoundWave')

    resetNamingRulesConfig()

    expect(loadNamingRulesConfig().assetPrefixes).toEqual(DEFAULT_NAMING_RULES_CONFIG.assetPrefixes)
  })

  it('存盘再读回来，用户自己加的键也在', () => {
    saveNamingRulesConfig({
      ...DEFAULT_NAMING_RULES_CONFIG,
      extensionToAssetType: {
        ...DEFAULT_NAMING_RULES_CONFIG.extensionToAssetType,
        usdz: 'StaticMesh'
      }
    })

    expect(loadNamingRulesConfig().extensionToAssetType.usdz).toBe('StaticMesh')
  })
})

/**
 * 老用户的配置文件是 2026-11 以前的**全量快照**（没有 `schema` 字段）。
 * 升级这一刻只做一件事：把他改过和自己加的东西搬进覆盖，一条都不能丢。
 *
 * 删除列表迁移时留空是故意的 —— 老格式里「出厂某个键不在快照里」分不出是
 * 「他删过」还是「那个键是我们后来才加的」，分不出来的东西不猜，
 * 所以他看到的表和升级前一模一样。
 */
describe('老格式（全量快照）迁移', () => {
  it('用户改过的值和自己加的键都不丢', () => {
    writeConfig({
      version: '1.0.0',
      assetPrefixes: { ...DEFAULT_NAMING_RULES_CONFIG.assetPrefixes, StaticMesh: 'MESH_' },
      extensionToAssetType: {
        ...DEFAULT_NAMING_RULES_CONFIG.extensionToAssetType,
        usdz: 'StaticMesh'
      },
      customRules: [{ name: '去掉 FINAL', match: 'endsWith', text: '_FINAL', replacement: '' }],
      namingConvention: 'snake_case',
      autoAddPrefix: false
    })

    const cfg = loadNamingRulesConfig()
    expect(cfg.assetPrefixes.StaticMesh).toBe('MESH_')
    expect(cfg.extensionToAssetType.usdz).toBe('StaticMesh')
    expect(cfg.customRules?.[0].name).toBe('去掉 FINAL')
    expect(cfg.namingConvention).toBe('snake_case')
    expect(cfg.autoAddPrefix).toBe(false)
  })

  it('迁移不替老用户记删除：老快照里缺的键还是出厂值', () => {
    const prefixes = { ...DEFAULT_NAMING_RULES_CONFIG.assetPrefixes }
    delete (prefixes as Record<string, string>).SoundWave
    writeConfig({ version: '1.0.0', assetPrefixes: prefixes })

    expect(loadNamingRulesConfig().assetPrefixes.SoundWave).toBe('A_')
  })

  it('迁移之后再删一次就是真删了', () => {
    writeConfig({
      version: '1.0.0',
      assetPrefixes: { ...DEFAULT_NAMING_RULES_CONFIG.assetPrefixes, StaticMesh: 'MESH_' }
    })

    // 设置页读上来、用户删掉一行、自动保存 —— 和界面上的那条链路一致
    const cfg = loadNamingRulesConfig()
    delete (cfg.assetPrefixes as Record<string, string>).SoundWave
    saveNamingRulesConfig({ ...cfg, removedKeys: { assetPrefixes: ['SoundWave'] } })

    const reloaded = loadNamingRulesConfig()
    expect(reloaded.assetPrefixes).not.toHaveProperty('SoundWave')
    expect(reloaded.assetPrefixes.StaticMesh).toBe('MESH_') // 他原来改的还在
  })
})

/**
 * 删除只认显式报上来的键。
 *
 * 这一组盯的是上一版的那条不可逆路径：删除列表由「出厂有、交上来的表里没有」倒推。
 * 设置页在输入框空着的那一刻交上来的就是这个形状 —— 用户把 `SoundWave` 的前缀
 * 从 `A_` 改成 `SFX_`，全选删除、停顿两秒（AUTO_SAVE_DELAY），自动保存就把这一行
 * 永久记成已删除，他打完字也救不回来。
 */
describe('删除只认显式报上来的键', () => {
  it('表里缺了某个键但没报删除 —— 当成「这一刻没值」，出厂值还在', () => {
    saveNamingRulesConfig(withoutKeys({ assetPrefixes: 'SoundWave' }))

    expect(loadNamingRulesConfig().assetPrefixes.SoundWave).toBe('A_')
  })

  it('清空输入框那一刻自动保存了一次，改完名字存第二次，前缀是他填的那个', () => {
    // 第一次：输入框空着（这一行没进表），没点删除
    saveNamingRulesConfig(withoutKeys({ assetPrefixes: 'SoundWave' }))
    // 第二次：名字打完了
    saveNamingRulesConfig({
      ...DEFAULT_NAMING_RULES_CONFIG,
      assetPrefixes: { ...DEFAULT_NAMING_RULES_CONFIG.assetPrefixes, SoundWave: 'SFX_' }
    })

    expect(loadNamingRulesConfig().assetPrefixes.SoundWave).toBe('SFX_')
  })

  it('点了删除才进 removed，文件里也只记这一个键', () => {
    saveNamingRulesConfig(afterRemoving({ assetPrefixes: 'SoundWave' }))

    const stored = JSON.parse(readFileSync(join(userDataDir, CONFIG_FILE), 'utf-8'))
    expect(stored.removed).toEqual({ assetPrefixes: ['SoundWave'] })
    expect(loadNamingRulesConfig().assetPrefixes).not.toHaveProperty('SoundWave')
  })

  it('下一次保存不再报同一个键，之前的删除照样算', () => {
    saveNamingRulesConfig(afterRemoving({ assetPrefixes: 'SoundWave' }))
    // 之后每一次自动保存都只带这一轮点掉的键（界面上重开一次页面就是空的）
    saveNamingRulesConfig(withoutKeys({ assetPrefixes: 'SoundWave' }))

    expect(loadNamingRulesConfig().assetPrefixes).not.toHaveProperty('SoundWave')
  })

  it('删掉之后把出厂那个值原样填回来，这一行回来', () => {
    saveNamingRulesConfig(afterRemoving({ assetPrefixes: 'SoundWave' }))
    // 覆盖里不会有这个键（值和出厂一样），靠「表里还在就不算删」把它解开
    saveNamingRulesConfig({
      ...DEFAULT_NAMING_RULES_CONFIG,
      removedKeys: { assetPrefixes: ['SoundWave'] }
    })

    expect(loadNamingRulesConfig().assetPrefixes.SoundWave).toBe('A_')
  })

  it('什么都没删的时候文件里不出现空的 removed', () => {
    saveNamingRulesConfig({
      ...DEFAULT_NAMING_RULES_CONFIG,
      assetPrefixes: { ...DEFAULT_NAMING_RULES_CONFIG.assetPrefixes, StaticMesh: 'MESH_' }
    })

    const stored = JSON.parse(readFileSync(join(userDataDir, CONFIG_FILE), 'utf-8'))
    expect('removed' in stored).toBe(false)
  })
})

describe('整张表给成空表 / 整个没给', () => {
  /**
   * 渲染层 `sanitizeConfig` 以前把「字段缺失」统一补成 `{}`，而 `{}` 是对象、
   * 穿得过主进程那道 `typeof !== 'object'` 的守卫 —— 倒推删除的话这一下
   * 把整张表的出厂键全记成已删除。现在删除只认显式列表，空表不再有歧义。
   *
   * 断言要落在**这张表上有覆盖**的情况：没有覆盖的表空着也不会变，
   * 这条断言走哪条路都绿（上一版就是这么写的，等于什么都没守住）。
   */
  it('空表不当成「他把这张表删空了」', () => {
    // 盘上先有一条他自己加的扩展名
    saveNamingRulesConfig({
      ...DEFAULT_NAMING_RULES_CONFIG,
      extensionToAssetType: {
        ...DEFAULT_NAMING_RULES_CONFIG.extensionToAssetType,
        usdz: 'StaticMesh'
      }
    })

    saveNamingRulesConfig({ ...DEFAULT_NAMING_RULES_CONFIG, extensionToAssetType: {} })

    const cfg = loadNamingRulesConfig()
    expect(cfg.extensionToAssetType.usdz).toBe('StaticMesh') // 他加的那条还在
    expect(cfg.extensionToAssetType.tga).toBe(DEFAULT_NAMING_RULES_CONFIG.extensionToAssetType.tga)
  })

  it('空表也不把上一次的删除抹掉', () => {
    saveNamingRulesConfig(afterRemoving({ assetPrefixes: 'SoundWave' }))
    saveNamingRulesConfig({
      ...withoutKeys({ assetPrefixes: 'SoundWave' }),
      extensionToAssetType: {}
    })

    expect(loadNamingRulesConfig().assetPrefixes).not.toHaveProperty('SoundWave')
  })

  it('整张表没给（IPC 那头是任意 JSON），覆盖和删除都照搬上次存的', () => {
    saveNamingRulesConfig(
      afterRemoving({ assetPrefixes: 'SoundWave', extensionToAssetType: 'tga' })
    )

    const partial = loadNamingRulesConfig() as unknown as Record<string, unknown>
    delete partial.extensionToAssetType
    saveNamingRulesConfig(partial as unknown as NamingRulesConfig)

    const cfg = loadNamingRulesConfig()
    expect(cfg.extensionToAssetType).not.toHaveProperty('tga') // 那张表上次的删除还在
    expect(cfg.assetPrefixes).not.toHaveProperty('SoundWave')
  })
})

/**
 * 覆盖是继承 + 叠加。
 *
 * 这一组盯的是「整份替换」那条不可逆路径：覆盖按这次交上来的表整份重算，于是
 * **清空输入框 + 2 秒防抖的自动保存**会把他自己加的键直接从文件里抹掉 ——
 * 那个键不在出厂表里，连「恢复默认」都救不回来。出厂键上的覆盖值同理，
 * 清空一下就静默退回出厂值，他改完名字还得再改一次前缀。
 *
 * 界面上这一刻什么都看不出来：行还在、字还在编辑框里，坏的只有盘上那份。
 */
describe('覆盖继承：这次没给的键照搬上次存的', () => {
  /** 用户自己加的那条规则：出厂表里没有 `SkeletalMeshLOD` */
  function withCustomPrefix(prefix: string): NamingRulesSavePayload {
    return {
      ...DEFAULT_NAMING_RULES_CONFIG,
      assetPrefixes: { ...DEFAULT_NAMING_RULES_CONFIG.assetPrefixes, SkeletalMeshLOD: prefix }
    }
  }

  it('清空自己加的那一行的值，自动保存一次，这个键不会丢', () => {
    saveNamingRulesConfig(withCustomPrefix('SKM_'))
    // 全选删除之后停顿两秒：这一行填了一半，不进交上来的表，也没点删除
    saveNamingRulesConfig(DEFAULT_NAMING_RULES_CONFIG)

    expect(loadNamingRulesConfig().assetPrefixes.SkeletalMeshLOD).toBe('SKM_')
  })

  it('清空之后打完新前缀，存的是新的那个', () => {
    saveNamingRulesConfig(withCustomPrefix('SKM_'))
    saveNamingRulesConfig(DEFAULT_NAMING_RULES_CONFIG)
    saveNamingRulesConfig(withCustomPrefix('LOD_'))

    expect(loadNamingRulesConfig().assetPrefixes.SkeletalMeshLOD).toBe('LOD_')
  })

  it('出厂键上的覆盖值清空一下也不退回出厂值', () => {
    saveNamingRulesConfig({
      ...DEFAULT_NAMING_RULES_CONFIG,
      assetPrefixes: { ...DEFAULT_NAMING_RULES_CONFIG.assetPrefixes, SoundWave: 'SFX_' }
    })
    saveNamingRulesConfig(withoutKeys({ assetPrefixes: 'SoundWave' }))

    expect(loadNamingRulesConfig().assetPrefixes.SoundWave).toBe('SFX_')
  })

  it('点了删除的自定义键真的消失（不进覆盖就等于没了，不必记进 removed）', () => {
    saveNamingRulesConfig(withCustomPrefix('SKM_'))
    saveNamingRulesConfig({
      ...DEFAULT_NAMING_RULES_CONFIG,
      removedKeys: { assetPrefixes: ['SkeletalMeshLOD'] }
    })

    const stored = JSON.parse(readFileSync(join(userDataDir, CONFIG_FILE), 'utf-8'))
    expect(loadNamingRulesConfig().assetPrefixes).not.toHaveProperty('SkeletalMeshLOD')
    expect(stored.removed?.assetPrefixes ?? []).not.toContain('SkeletalMeshLOD')
  })

  it('删掉又手打回来的自定义键按他现在填的值算', () => {
    saveNamingRulesConfig(withCustomPrefix('SKM_'))
    // 同一次保存里：列表里报着删除，表里他又把这一行填回来了
    saveNamingRulesConfig({
      ...withCustomPrefix('LOD_'),
      removedKeys: { assetPrefixes: ['SkeletalMeshLOD'] }
    })

    expect(loadNamingRulesConfig().assetPrefixes.SkeletalMeshLOD).toBe('LOD_')
  })

  /**
   * 就地把 `SoundWave` 这一行的类型改成 `SoundWaveSFX`：新键进覆盖，老键进删除列表。
   * 老键不报的话下次读盘被出厂值垫回来，用户看到两行。
   */
  it('就地改键名：老键报进删除，重开页面不多出一个幽灵行', () => {
    const prefixes = { ...DEFAULT_NAMING_RULES_CONFIG.assetPrefixes }
    delete (prefixes as Record<string, string>).SoundWave
    prefixes.SoundWaveSFX = 'A_'

    saveNamingRulesConfig({
      ...DEFAULT_NAMING_RULES_CONFIG,
      assetPrefixes: prefixes,
      removedKeys: { assetPrefixes: ['SoundWave'] }
    })

    const reloaded = loadNamingRulesConfig().assetPrefixes
    expect(reloaded).not.toHaveProperty('SoundWave')
    expect(reloaded.SoundWaveSFX).toBe('A_')
  })

  /**
   * 「恢复默认」= 一份空的稀疏文件。他自己加的键也得清掉 ——
   * 走 saveNamingRulesConfig 交出厂表的话，出厂表里没有的键会被继承下去，
   * 重置完还留着半份旧配置。
   */
  it('「恢复默认」把他自己加的键也清掉', () => {
    saveNamingRulesConfig(withCustomPrefix('SKM_'))

    resetNamingRulesConfig()

    const cfg = loadNamingRulesConfig()
    expect(cfg.assetPrefixes).not.toHaveProperty('SkeletalMeshLOD')
    expect(cfg.assetPrefixes).toEqual(DEFAULT_NAMING_RULES_CONFIG.assetPrefixes)
    const stored = JSON.parse(readFileSync(join(userDataDir, CONFIG_FILE), 'utf-8'))
    expect(stored.assetPrefixes).toBeUndefined()
    expect(stored.removed).toBeUndefined()
  })
})
