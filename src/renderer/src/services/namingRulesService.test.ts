/**
 * 命名规则配置服务（渲染侧）。
 *
 * 这一层守三件在界面上看不出来的事：
 *
 * 1. **交出去的配置是深拷贝。** 设置页的「添加纹理后缀」直接往数组里 push，
 *    浅拷贝的话这一下改到的是模块级 `DEFAULT_NAMING_RULES_CONFIG`，
 *    之后每一次回落都带着他那条。
 * 2. **缺字段就不写这个键。** 缺字段和「这张表被删空了」是两件事，主进程那道
 *    「这次没给这张表」的守卫靠它才接得上；统一补 `{}` 等于把「没给」翻译成一张空表。
 * 3. **删除列表过一遍再交。** 去重、去空串，空列表压根不写 —— 每次自动保存都重报
 *    一遍同样的键只会让文件越来越长。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_NAMING_RULES_CONFIG } from '../types/namingRules'
import type { NamingRulesConfig } from '../types/namingRules'

type SavedPayload = Partial<NamingRulesConfig> & { removedKeys?: Record<string, string[]> }

const originalApi = window.api

let saveConfig: ReturnType<typeof vi.fn>
let service: typeof import('./namingRulesService')

beforeEach(async () => {
  // 模块级缓存要跟着每条用例重来，否则上一条存进去的配置会被下一条读到
  vi.resetModules()
  saveConfig = vi.fn(async () => true)
  window.api = {
    namingRules: {
      loadConfig: vi.fn(async () => DEFAULT_NAMING_RULES_CONFIG),
      saveConfig,
      resetConfig: vi.fn(async () => true)
    }
  } as unknown as typeof window.api
  service = await import('./namingRulesService')
})

afterEach(() => {
  window.api = originalApi
})

/** 这次交给 preload 桥的那一份 */
function lastPayload(): SavedPayload {
  expect(saveConfig).toHaveBeenCalled()
  return saveConfig.mock.calls[saveConfig.mock.calls.length - 1][0] as SavedPayload
}

describe('getNamingRulesConfig', () => {
  it('没有缓存时交出来的是深拷贝，调用方往里 push 不污染下一次', () => {
    // 长度和前缀先按值记下来：真被污染了的话，拿 DEFAULT 去比两边会一起变，断言永远绿
    const factoryPatternCount = DEFAULT_NAMING_RULES_CONFIG.textureSuffixPatterns.length

    const cfg = service.getNamingRulesConfig()
    cfg.textureSuffixPatterns.push({ pattern: '_ao', suffix: '_AO', type: 'AO', enabled: true })
    cfg.assetPrefixes.StaticMesh = 'POLLUTED_'

    const again = service.getNamingRulesConfig()
    expect(again.textureSuffixPatterns).toHaveLength(factoryPatternCount)
    expect(again.assetPrefixes.StaticMesh).toBe('SM_')
    // 模块级出厂表本身也没被改
    expect(DEFAULT_NAMING_RULES_CONFIG.textureSuffixPatterns).toHaveLength(factoryPatternCount)
    expect(DEFAULT_NAMING_RULES_CONFIG.assetPrefixes.StaticMesh).toBe('SM_')
  })
})

describe('saveNamingRulesConfig', () => {
  it('缺了映射表的那个键就不写，不补成空表', async () => {
    const partial = { ...DEFAULT_NAMING_RULES_CONFIG } as Record<string, unknown>
    delete partial.extensionToAssetType

    await service.saveNamingRulesConfig(partial as unknown as NamingRulesConfig)

    const payload = lastPayload()
    expect('extensionToAssetType' in payload).toBe(false)
    expect(payload.assetPrefixes).toEqual(DEFAULT_NAMING_RULES_CONFIG.assetPrefixes)
  })

  it('缺了映射表的那一份不进缓存：下一次读到的是出厂值，不是半张表', async () => {
    const partial = { ...DEFAULT_NAMING_RULES_CONFIG } as Record<string, unknown>
    delete partial.extensionToAssetType

    await service.saveNamingRulesConfig(partial as unknown as NamingRulesConfig)

    expect(service.getNamingRulesConfig().extensionToAssetType).toEqual(
      DEFAULT_NAMING_RULES_CONFIG.extensionToAssetType
    )
  })

  it('删除列表去重、去空串', async () => {
    await service.saveNamingRulesConfig(DEFAULT_NAMING_RULES_CONFIG, {
      assetPrefixes: ['SoundWave', 'SoundWave', '', 'Texture'],
      extensionToAssetType: []
    })

    expect(lastPayload().removedKeys).toEqual({ assetPrefixes: ['SoundWave', 'Texture'] })
  })

  it('一条删除都没有时压根不带 removedKeys', async () => {
    await service.saveNamingRulesConfig(DEFAULT_NAMING_RULES_CONFIG, { assetPrefixes: [] })

    expect('removedKeys' in lastPayload()).toBe(false)
  })

  it('不传删除列表也不带 removedKeys —— 盘上已经记着的由主进程保留', async () => {
    await service.saveNamingRulesConfig(DEFAULT_NAMING_RULES_CONFIG)

    expect('removedKeys' in lastPayload()).toBe(false)
  })
})
