import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { RouteRecordRaw } from 'vue-router'
import type { MenuItem } from '@renderer/common/routeUtils'
import { generateMenuFromRoutes } from '@renderer/common/routeUtils'

// mainRoutes 直接 import MainLayout，而它经 store 又回头 import router/index.ts，
// 形成循环依赖。这里只关心路由表本身，把布局组件打桩断开这条链
// （做法与 mainRoutes.communityEdition.test.ts 一致）。
vi.mock('@renderer/layout/MainLayout.vue', () => ({
  default: { name: 'MainLayoutStub', template: '<div />' }
}))

import mainRoutes from '@renderer/router/modules/mainRoutes'
import {
  DEFAULT_PINNED_TOOLS,
  DEFAULT_SIDEBAR_TOOLS_PREFS,
  loadSidebarToolsPrefs,
  resolveSidebarTools,
  sanitizePinnedTools,
  sanitizeToolOrder,
  saveSidebarToolsPrefs
} from './sidebarTools'

function makeItem(key: string): MenuItem {
  return { key, icon: null, label: key, path: `/${key.toLowerCase()}` }
}

// 侧边栏工具的全集：路由 isShowInMenu = true 的那六个，
// 顺序模拟 generateMenuFromRoutes 按 meta.sort 排出的样子
const KNOWN_KEYS = [
  'Home',
  'AssetManagement',
  'BlueprintLibrary',
  'MaterialLibrary',
  'Notebooks',
  'AIGCStudio'
]

const ITEMS = KNOWN_KEYS.map(makeItem)

describe('sidebarTools', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('默认偏好：四个库常驻，知识库与 AI 创作收进「更多」', () => {
    const { pinned, more } = resolveSidebarTools(ITEMS, DEFAULT_SIDEBAR_TOOLS_PREFS)

    expect(pinned.map((i) => i.key)).toEqual([
      'Home',
      'AssetManagement',
      'BlueprintLibrary',
      'MaterialLibrary'
    ])
    expect(more.map((i) => i.key)).toEqual(['Notebooks', 'AIGCStudio'])
  })

  it('真实路由默认也满足这条产品规则（isShowInMenu 守卫）', () => {
    const children = (mainRoutes as RouteRecordRaw).children ?? []
    const menu = generateMenuFromRoutes([{ path: '/', children } as RouteRecordRaw], (key) => key)
    const keys = menu.map((i) => i.key)

    // 3D 查看器 / 笔记 / 服务器管理不出现，也不提供入口
    expect(keys).not.toContain('Model3DViewer')
    expect(keys).not.toContain('NoteEditor')
    expect(keys).not.toContain('ServerManagement')
    expect(keys).not.toContain('ExternalTeams')

    // 偏好设置的 isShowInMenu 是 true，但 SideMenu 按 key 把它剔出工具列表 ——
    // 这里镜像同一层排除后再验证拆分
    const excluded = new Set(['Profile', 'Preferences'])
    const featureItems = menu.filter((i) => !excluded.has(i.key))
    // 外部驱动的对话属于项目列表，不再单列成工具。
    expect(featureItems.map((i) => i.key).sort()).toEqual([...KNOWN_KEYS].sort())

    const { pinned, more } = resolveSidebarTools(featureItems, DEFAULT_SIDEBAR_TOOLS_PREFS)
    expect(more.map((i) => i.key)).toEqual(['Notebooks', 'AIGCStudio'])
    expect(pinned.map((i) => i.key)).toContain('Home')
  })

  it('旧外部团队链接回到统一对话入口，并保留明确的对话 id', () => {
    const legacy = mainRoutes.children?.find((route) => route.name === 'ExternalTeams')
    expect(legacy).toBeDefined()
    expect(legacy?.component).toBeUndefined()
    expect(typeof legacy?.redirect).toBe('function')
    if (typeof legacy?.redirect !== 'function') throw new Error('Missing legacy redirect')
    expect(
      legacy.redirect({
        query: { sid: 'ext-2' },
        path: '/external-teams',
        fullPath: '/external-teams?sid=ext-2',
        name: 'ExternalTeams',
        params: {},
        hash: '',
        matched: [],
        meta: {},
        redirectedFrom: undefined
      })
    ).toEqual({
      name: 'AssistantWelcome',
      query: { sid: 'ext-2' }
    })
  })

  it('顺序清洗：剔除已不存在的工具、去重，新工具按默认顺序补齐', () => {
    expect(
      sanitizeToolOrder(
        ['AIGCStudio', 'Gone', 'Home', 'AIGCStudio', 42, null],
        ['Home', 'AssetManagement', 'AIGCStudio']
      )
    ).toEqual(['AIGCStudio', 'Home', 'AssetManagement'])

    // 非数组整体作废，落回默认顺序
    expect(sanitizeToolOrder(undefined, ['Home', 'AssetManagement'])).toEqual([
      'Home',
      'AssetManagement'
    ])
  })

  it('常驻清洗：存过数组就尊重（含全空），没存过才用默认名单', () => {
    expect(sanitizePinnedTools(['Home', 'Gone', 'Home'], KNOWN_KEYS)).toEqual(['Home'])
    expect(sanitizePinnedTools([], KNOWN_KEYS)).toEqual([])
    expect(sanitizePinnedTools(undefined, KNOWN_KEYS)).toEqual([...DEFAULT_PINNED_TOOLS])
    // 默认名单里若有工具已下线，落地时剔除
    expect(sanitizePinnedTools(undefined, ['Home', 'AIGCStudio'])).toEqual(['Home'])
  })

  it('自定义顺序对常驻和「更多」两组同时生效', () => {
    const prefs = {
      order: ['Notebooks', 'AIGCStudio', 'Home', 'AssetManagement', 'BlueprintLibrary'],
      pinned: ['AIGCStudio', 'Home']
    }
    const { pinned, more } = resolveSidebarTools(ITEMS, prefs)

    expect(pinned.map((i) => i.key)).toEqual(['AIGCStudio', 'Home'])
    expect(more.map((i) => i.key)).toEqual([
      'Notebooks',
      'AssetManagement',
      'BlueprintLibrary',
      'MaterialLibrary'
    ])
  })

  it('偏好读写走 localStorage 往返，损坏数据落回默认', () => {
    saveSidebarToolsPrefs({ order: ['Home', 'AIGCStudio'], pinned: ['AIGCStudio'] })
    expect(loadSidebarToolsPrefs()).toEqual({
      order: ['Home', 'AIGCStudio'],
      pinned: ['AIGCStudio']
    })

    localStorage.setItem('sidebar-tools-prefs', '{not json')
    expect(loadSidebarToolsPrefs()).toEqual(DEFAULT_SIDEBAR_TOOLS_PREFS)

    // 存量数据缺 pinned 字段（老版本写的）：常驻名单落默认，顺序保留
    localStorage.setItem('sidebar-tools-prefs', JSON.stringify({ order: ['Home'] }))
    expect(loadSidebarToolsPrefs()).toEqual({ order: ['Home'], pinned: [...DEFAULT_PINNED_TOOLS] })
  })
})
