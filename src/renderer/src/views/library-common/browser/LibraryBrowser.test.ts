/**
 * 外壳要证明的两件事：
 *
 *   1. **换个 scope 就是换一个库** —— 同一个组件，传 blueprint 的 scope 就是蓝图库，
 *      传 material 的就是材质库。做不到这条，「三个库合一个浏览器」就不成立。
 *   2. **模块只能通过插槽出现，而且崩了只崩自己** —— 做不到这条，
 *      把云盘那堆东西摘出去就是把耦合换个地方藏起来。
 *
 * 另外钉住一条交互回归：拖动的落点是**文件夹树**，不是另一张卡片。
 */
import { mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, nextTick } from 'vue'
import { createI18n } from 'vue-i18n'

import LibraryBrowser from './LibraryBrowser.vue'
import { registerBrowserModule, resetBrowserModules } from './moduleRegistry'
import type { BrowserFolder, BrowserItem, BrowserScope } from './types'

const i18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  messages: {
    'zh-CN': {
      libraryBrowser: {
        allFolders: '全部',
        folderSection: '文件夹',
        searchPlaceholder: '搜索',
        sort: '排序',
        sortRecent: '最近修改',
        sortName: '名称',
        sortCreated: '创建时间',
        viewGrid: '网格',
        viewList: '列表',
        colName: '名称',
        colType: '类型',
        colUpdated: '修改时间',
        colInfo: '信息',
        colTags: '标签',
        loading: '加载中',
        emptyTitle: '{library}为空',
        emptyFolderTitle: '这个文件夹是空的',
        filteredEmptyTitle: '没有符合条件的条目',
        clearSearch: '清除搜索',
        selectedCount: '已选择 {count} 项',
        clearSelection: '取消选择',
        resizeSidebar: '拖动调整文件夹栏宽度'
      },
      test: { upload: '上传到云盘', deps: '查看依赖' },
      blueprintTitle: '蓝图库',
      materialTitle: '材质库'
    }
  }
})

function makeItem(overrides: Partial<BrowserItem> & { id: string }): BrowserItem {
  return {
    name: overrides.id,
    kind: 'blueprint',
    folderKey: '',
    tags: [],
    isFavorite: false,
    createdAt: 0,
    updatedAt: 0,
    source: {},
    ...overrides
  }
}

const folders: BrowserFolder[] = [
  { key: 'chars', name: '角色', parentKey: null },
  { key: 'chars-move', name: '移动', parentKey: 'chars' }
]

const blueprintScope: BrowserScope = {
  id: 'blueprint',
  title: 'blueprintTitle',
  kinds: ['blueprint'],
  facets: []
}

const materialScope: BrowserScope = {
  id: 'material',
  title: 'materialTitle',
  kinds: ['material'],
  facets: []
}

const items: BrowserItem[] = [
  makeItem({ id: 'bp1', name: '跳跃逻辑', kind: 'blueprint', folderKey: 'chars', updatedAt: 30 }),
  makeItem({ id: 'bp2', name: '开门', kind: 'blueprint', updatedAt: 20 }),
  makeItem({ id: 'm1', name: '苔藓石头', kind: 'material', updatedAt: 10 })
]

function mountBrowser(scope = blueprintScope): VueWrapper {
  return mount(LibraryBrowser, {
    props: { scope, items, folders },
    global: { plugins: [i18n] }
  })
}

function cardNames(wrapper: VueWrapper): string[] {
  return wrapper.findAll('.card-name').map((node) => node.text())
}

beforeEach(() => {
  resetBrowserModules()
  localStorage.clear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('同一个组件，换 scope 就是换一个库', () => {
  it('蓝图 scope 只显示蓝图', () => {
    expect(cardNames(mountBrowser(blueprintScope)).sort()).toEqual(['开门', '跳跃逻辑'])
  })

  it('材质 scope 只显示材质 —— 组件是同一个', () => {
    expect(cardNames(mountBrowser(materialScope))).toEqual(['苔藓石头'])
  })

  it('kinds 为空表示不限，这就是资产库', () => {
    const wrapper = mountBrowser({ id: 'assets', title: 'x', kinds: [], facets: [] })
    expect(cardNames(wrapper)).toHaveLength(3)
  })

  it('换库时把上一个库的筛选清掉 —— 留着会让人以为「东西怎么少了」', async () => {
    const wrapper = mountBrowser(blueprintScope)
    await wrapper.find('input[type="search"]').setValue('跳跃')
    expect(cardNames(wrapper)).toEqual(['跳跃逻辑'])

    await wrapper.setProps({ scope: materialScope })
    expect((wrapper.find('input[type="search"]').element as HTMLInputElement).value).toBe('')
    expect(cardNames(wrapper)).toEqual(['苔藓石头'])
  })
})

describe('文件夹与筛选', () => {
  it('选中文件夹只看这个文件夹里的东西', async () => {
    const wrapper = mountBrowser()
    const rows = wrapper.findAll('.tree-row')
    // 第 0 行是「全部」，后面是 角色 / 移动
    await rows[1].trigger('click')
    expect(cardNames(wrapper)).toEqual(['跳跃逻辑'])
  })

  it('树上显示每个文件夹的条目数', () => {
    const wrapper = mountBrowser()
    expect(wrapper.findAll('.tree-row')[1].text()).toContain('1')
  })

  it('搜索会一起搜标签', async () => {
    const wrapper = mount(LibraryBrowser, {
      props: {
        scope: blueprintScope,
        folders,
        items: [makeItem({ id: 'a', name: '无关名字', tags: ['待重构'] })]
      },
      global: { plugins: [i18n] }
    })
    await wrapper.find('input[type="search"]').setValue('待重构')
    expect(cardNames(wrapper)).toEqual(['无关名字'])
  })

  it('facet 从领域对象上取值，壳层不认识具体字段', async () => {
    const wrapper = mount(LibraryBrowser, {
      props: {
        folders,
        scope: {
          id: 'material',
          title: 'x',
          kinds: ['material'],
          facets: [
            {
              key: 'blendMode',
              label: 'test.upload',
              options: [{ value: 'Masked', label: 'Masked' }]
            }
          ]
        },
        items: [
          makeItem({ id: 'a', name: '不透明', kind: 'material', source: { blendMode: 'Opaque' } }),
          makeItem({ id: 'b', name: '遮罩', kind: 'material', source: { blendMode: 'Masked' } })
        ]
      },
      global: { plugins: [i18n] }
    })

    await wrapper.findAll('select')[0].setValue('Masked')
    expect(cardNames(wrapper)).toEqual(['遮罩'])
  })
})

describe('拖动的落点是文件夹树，不是另一张卡片', () => {
  it('拖到树上发出 move', async () => {
    const wrapper = mountBrowser()
    await wrapper.findAll('.library-card')[0].trigger('dragstart')
    await wrapper.findAll('.tree-row')[2].trigger('drop')

    const moved = wrapper.emitted('move')
    expect(moved).toHaveLength(1)
    expect((moved![0][0] as BrowserItem[]).map((i) => i.id)).toEqual(['bp1'])
    expect(moved![0][1]).toBe('chars-move')
  })

  it('拖到卡片上什么也不会发生 —— 原来那套「合并成集合」被去掉了', async () => {
    const wrapper = mountBrowser()
    const cards = wrapper.findAll('.library-card')
    await cards[0].trigger('dragstart')

    // 卡片不是落点：往它身上放，不该产生任何移动
    await cards[1].trigger('drop')
    expect(wrapper.emitted('move')).toBeUndefined()
  })

  it('拖选中的其中一个 = 拖整批', async () => {
    const wrapper = mountBrowser()
    const cards = wrapper.findAll('.library-card')
    await cards[0].trigger('click')
    await cards[1].trigger('click', { ctrlKey: true })
    await cards[0].trigger('dragstart')
    await wrapper.findAll('.tree-row')[1].trigger('drop')

    expect((wrapper.emitted('move')![0][0] as BrowserItem[]).map((i) => i.id).sort()).toEqual([
      'bp1',
      'bp2'
    ])
  })
})

describe('模块（DLC）', () => {
  const Panel = defineComponent({ name: 'Panel', template: '<div class="mod-panel">同步中</div>' })

  it('没启用的模块，按钮不出现', () => {
    registerBrowserModule({
      id: 'baidu',
      title: 'x',
      description: 'x',
      enabledByDefault: false,
      toolbarActions: [{ id: 'upload', label: 'test.upload', run: () => {} }]
    })
    expect(mountBrowser().text()).not.toContain('上传到云盘')
  })

  it('默认启用的模块，按钮挂到工具栏上', () => {
    registerBrowserModule({
      id: 'baidu',
      title: 'x',
      description: 'x',
      enabledByDefault: true,
      toolbarActions: [{ id: 'upload', label: 'test.upload', run: () => {} }]
    })
    expect(mountBrowser().text()).toContain('上传到云盘')
  })

  it('侧栏区块能挂上来', () => {
    registerBrowserModule({
      id: 'netsync',
      title: 'x',
      description: 'x',
      enabledByDefault: true,
      sidebarPanels: [{ id: 'status', component: Panel }]
    })
    expect(mountBrowser().find('.mod-panel').exists()).toBe(true)
  })

  it('当前场景不适用的模块不出现 —— 跟「用户关掉了」是两回事', () => {
    registerBrowserModule({
      id: 'netsync',
      title: 'x',
      description: 'x',
      enabledByDefault: true,
      isAvailable: (ctx) => ctx.scope.id === 'assets',
      sidebarPanels: [{ id: 'status', component: Panel }]
    })
    expect(mountBrowser(blueprintScope).find('.mod-panel').exists()).toBe(false)
  })

  it('模块动作抛异常时只记日志，不把浏览器带崩', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    registerBrowserModule({
      id: 'baidu',
      title: 'x',
      description: 'x',
      enabledByDefault: true,
      toolbarActions: [
        {
          id: 'upload',
          label: 'test.upload',
          run: () => {
            throw new Error('云盘挂了')
          }
        }
      ]
    })

    const wrapper = mountBrowser()
    const button = wrapper.findAll('.toolbar-button').find((b) => b.text() === '上传到云盘')!
    await button.trigger('click')

    expect(error).toHaveBeenCalled()
    // 界面还在
    expect(cardNames(wrapper)).toHaveLength(2)
  })

  it('批量操作只在选中之后出现', async () => {
    registerBrowserModule({
      id: 'dep',
      title: 'x',
      description: 'x',
      enabledByDefault: true,
      bulkActions: [{ id: 'deps', label: 'test.deps', run: () => {} }]
    })

    const wrapper = mountBrowser()
    expect(wrapper.find('.browser-bulkbar').exists()).toBe(false)

    await wrapper.findAll('.library-card')[0].trigger('click')
    expect(wrapper.find('.browser-bulkbar').text()).toContain('查看依赖')
    expect(wrapper.find('.browser-bulkbar').text()).toContain('已选择 1 项')
  })
})

describe('界面重量由 scope 声明，不按数量推断', () => {
  const withDetail = (scope: BrowserScope): VueWrapper =>
    mount(LibraryBrowser, {
      props: { scope, items, folders },
      slots: { detail: '<div class="detail-panel" />' },
      global: { plugins: [i18n] }
    })

  it('full：分组栏摊开，详情面板在', () => {
    const wrapper = withDetail({ ...blueprintScope, density: 'full' })
    expect(wrapper.findAll('.tree-row').length).toBeGreaterThan(0)
    expect(wrapper.find('.detail-panel').exists()).toBe(true)
  })

  it('light：文件夹常驻显示，但详情面板不出现', () => {
    const wrapper = withDetail({ ...blueprintScope, density: 'light' })
    expect(wrapper.findAll('.tree-row').length).toBeGreaterThan(0)
    expect(wrapper.find('.detail-panel').exists()).toBe(false)
  })

  it('文件夹区块不是折叠按钮 —— 打开页面就能直接选目录', () => {
    const wrapper = withDetail({ ...blueprintScope, density: 'light' })
    expect(wrapper.find('.section-toggle').exists()).toBe(false)
    expect(wrapper.find('.tree-section-label').exists()).toBe(true)
  })

  it('不填 density 按 full —— 新库先给完整的，觉得重再显式降级', () => {
    expect(withDetail(blueprintScope).find('.detail-panel').exists()).toBe(true)
  })

  // 老周那条：工具自己变形比多点一下更糟
  it('条目变多不会让轻量库自己变重', async () => {
    const many = Array.from({ length: 500 }, (_, i) => makeItem({ id: `bp${i}`, name: `蓝图${i}` }))
    const wrapper = mount(LibraryBrowser, {
      props: { scope: { ...blueprintScope, density: 'light' }, items: many, folders },
      slots: { detail: '<div class="detail-panel" />' },
      global: { plugins: [i18n] }
    })
    expect(wrapper.find('.detail-panel').exists()).toBe(false)
    expect(wrapper.findAll('.tree-row').length).toBeGreaterThan(0)
  })
})

describe('列表模式是真表格，不是把网格压成一列', () => {
  async function switchToList(wrapper: VueWrapper): Promise<void> {
    // 视图切换的第二个按钮是列表
    await wrapper.findAll('.toggle-btn')[1].trigger('click')
  }

  it('切到列表后出现表头，卡片消失', async () => {
    const wrapper = mountBrowser()
    await switchToList(wrapper)

    expect(wrapper.find('.list-header-row').exists()).toBe(true)
    expect(wrapper.findAll('.library-card')).toHaveLength(0)
    expect(wrapper.findAll('.list-row')).toHaveLength(2)
  })

  it('表头用的是通用列名 —— 同一张表要同时装下蓝图和材质', async () => {
    const wrapper = mountBrowser()
    await switchToList(wrapper)

    expect(wrapper.find('.list-header-row').text()).toContain('信息')
    expect(wrapper.find('.list-header-row').text()).not.toContain('引擎')
  })

  it('列表行照样能双击打开、能拖到文件夹上', async () => {
    const open = vi.fn()
    const wrapper = mount(LibraryBrowser, {
      props: { scope: { ...blueprintScope, open }, items, folders },
      global: { plugins: [i18n] }
    })
    await switchToList(wrapper)

    await wrapper.findAll('.list-row')[0].trigger('dblclick')
    expect(open).toHaveBeenCalledOnce()

    await wrapper.findAll('.list-row')[0].trigger('dragstart')
    await wrapper.findAll('.tree-row')[2].trigger('drop')
    expect(wrapper.emitted('move')).toHaveLength(1)
  })

  it('列表行复用 card-menu 插槽，调用方不用为列表再写一份', async () => {
    const wrapper = mount(LibraryBrowser, {
      props: { scope: blueprintScope, items, folders },
      slots: { 'card-menu': '<div class="menu-item">删除</div>' },
      global: { plugins: [i18n] }
    })
    await switchToList(wrapper)

    expect(wrapper.findAll('.row-menu')).toHaveLength(2)
    expect(wrapper.find('.row-menu-dropdown').text()).toBe('删除')
  })
})

describe('空状态', () => {
  it('库是空的时说库名，筛没了时说筛选 —— 两种原因不共用一句话', async () => {
    const wrapper = mount(LibraryBrowser, {
      props: { scope: blueprintScope, items: [], folders },
      global: { plugins: [i18n] }
    })
    expect(wrapper.find('.library-empty-state').text()).toBe('蓝图库为空')

    await wrapper.setProps({ items })
    await wrapper.find('input[type="search"]').setValue('不存在的名字')
    expect(wrapper.find('.library-empty-state').text()).toBe('没有符合条件的条目')
  })

  it('换成材质库，空状态就说材质库 —— 一个壳不为两个库各写一套文案', () => {
    const wrapper = mount(LibraryBrowser, {
      props: { scope: materialScope, items: [], folders },
      global: { plugins: [i18n] }
    })
    expect(wrapper.find('.library-empty-state').text()).toBe('材质库为空')
  })

  /**
   * 点一个空文件夹不是「筛选没结果」：用户一个条件都没设，
   * 跟他说「没有符合条件的条目」他只会去找自己设了什么条件。
   */
  it('只是点了个空文件夹，说的是文件夹空了，不是筛选没结果', async () => {
    const wrapper = mount(LibraryBrowser, {
      props: {
        scope: blueprintScope,
        folders,
        items: [makeItem({ id: 'bp1', name: '跳跃逻辑', folderKey: 'chars' })]
      },
      global: { plugins: [i18n] }
    })
    // 第 0 行是「全部」，第 2 行是空文件夹「移动」
    await wrapper.findAll('.tree-row')[2].trigger('click')
    expect(wrapper.find('.library-empty-state').text()).toBe('这个文件夹是空的')
  })

  it('空文件夹里再搜一下，才回到筛选没结果', async () => {
    const wrapper = mount(LibraryBrowser, {
      props: {
        scope: blueprintScope,
        folders,
        items: [makeItem({ id: 'bp1', name: '跳跃逻辑', folderKey: 'chars' })]
      },
      global: { plugins: [i18n] }
    })
    await wrapper.findAll('.tree-row')[2].trigger('click')
    await wrapper.find('input[type="search"]').setValue('跳跃')
    expect(wrapper.find('.library-empty-state').text()).toBe('没有符合条件的条目')
  })

  it('空状态不挂说明性小字 —— 「新建」就在工具栏上', () => {
    const wrapper = mount(LibraryBrowser, {
      props: { scope: blueprintScope, items: [], folders },
      global: { plugins: [i18n] }
    })
    expect(wrapper.findAll('.library-empty-state p')).toHaveLength(0)
  })
})

describe('加载态', () => {
  it('keeps cards during filtering and never restores skeletons after an empty result', async () => {
    const wrapper = mountBrowser()
    await wrapper.setProps({ loading: true })
    expect(cardNames(wrapper).sort()).toEqual(['开门', '跳跃逻辑'])
    expect(wrapper.findAll('.skeleton-card')).toHaveLength(0)
    await wrapper.setProps({ loading: false, items: [] })
    await wrapper.setProps({ loading: true })
    expect(wrapper.findAll('.skeleton-card')).toHaveLength(0)
  })
  it('铺骨架而不是一行「加载中」—— 出内容时页面不会整个跳一下', () => {
    const wrapper = mount(LibraryBrowser, {
      props: { scope: blueprintScope, items: [], folders, loading: true },
      global: { plugins: [i18n] }
    })

    expect(wrapper.findAll('.skeleton-card').length).toBeGreaterThan(0)
    // 加载中不该同时显示空状态，否则用户以为库是空的
    expect(wrapper.find('.library-empty-state').exists()).toBe(false)
  })
})

describe('文件夹树的可达性', () => {
  it('每一行是真的 button —— 用 div + @click 的话键盘根本走不到', () => {
    const wrapper = mountBrowser()
    const rows = wrapper.findAll('.tree-row')
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.every((row) => row.element.tagName === 'BUTTON')).toBe(true)
  })

  it('选中的行带 aria-current，读屏才知道现在在哪', async () => {
    const wrapper = mountBrowser()
    const rows = wrapper.findAll('.tree-row')
    await rows[1].trigger('click')
    expect(wrapper.findAll('.tree-row')[1].attributes('aria-current')).toBe('true')
  })

  it('改名/删除是常驻的按钮，不是只在 hover 时才存在的元素', () => {
    const wrapper = mountBrowser()
    // 只靠 hover 显示的话触屏和键盘用户永远够不到；这里靠 CSS visibility 收起，
    // 元素一直在 DOM 里，focus-within 时露出来
    const actions = wrapper.findAll('.tree-actions button')
    expect(actions.length).toBeGreaterThan(0)
    expect(actions.every((button) => !!button.attributes('aria-label'))).toBe(true)
  })

  it('展开箭头不嵌在行按钮里 —— 嵌套 button 是非法 HTML', () => {
    const wrapper = mountBrowser()
    expect(wrapper.findAll('.tree-row button')).toHaveLength(0)
  })

  it('根目录和每个文件夹都有一致的矢量图标', () => {
    const wrapper = mountBrowser()
    expect(wrapper.findAll('.tree-item-icon')).toHaveLength(wrapper.findAll('.tree-row').length)
    expect(wrapper.findAll('.tree-item-icon').every((icon) => icon.element.tagName === 'svg')).toBe(
      true
    )
  })
})

describe('打开条目', () => {
  for (const scope of [blueprintScope, materialScope]) {
    for (const view of ['grid', 'list']) {
      it(`${scope.id} ${view} 单击打开，不选中；双击不重复打开，菜单不打开详情`, async () => {
        const open = vi.fn()
        const wrapper = mount(LibraryBrowser, {
          props: { scope: { ...scope, openOnClick: true, open }, items, folders },
          slots: { 'card-menu': '<button class="test-menu-action">操作</button>' },
          global: { plugins: [i18n] }
        })
        if (view === 'list') await wrapper.findAll('.toggle-btn')[1].trigger('click')
        const entry = wrapper.find(view === 'list' ? '.list-row' : '.library-card')

        await entry.find('.test-menu-action').trigger('click')
        expect(open).not.toHaveBeenCalled()
        await entry.trigger('click', { detail: 1 })
        await entry.trigger('click', { detail: 2 })
        await entry.trigger('dblclick')
        expect(open).toHaveBeenCalledOnce()
        expect(open).toHaveBeenCalledWith(items.find((item) => item.kind === scope.id))
        expect(wrapper.emitted('open')).toHaveLength(1)
        expect(wrapper.emitted('selection-change')).toBeUndefined()
        expect(wrapper.find('.browser-bulkbar').exists()).toBe(false)
        expect(entry.classes()).not.toContain('is-selected')
        wrapper.unmount()
      })
    }
  }

  it('双击走 scope 自己的 open —— 各库在这里跳自己的编辑器', async () => {
    const open = vi.fn()
    const wrapper = mount(LibraryBrowser, {
      props: { scope: { ...blueprintScope, open }, items, folders },
      global: { plugins: [i18n] }
    })

    await wrapper.findAll('.library-card')[0].trigger('dblclick')
    expect(open).toHaveBeenCalledOnce()
    expect(wrapper.emitted('open')).toHaveLength(1)
  })
})

describe('侧栏分界线可以拖', () => {
  const sidebarStyle = (wrapper: VueWrapper): string =>
    wrapper.find('.browser-sidebar').attributes('style') ?? ''

  async function fireMove(clientX: number): Promise<void> {
    document.dispatchEvent(new MouseEvent('mousemove', { clientX }))
    // 宽度走响应式更新，等一拍再断言 DOM
    await nextTick()
  }
  function fireUp(): void {
    document.dispatchEvent(new MouseEvent('mouseup'))
  }

  it('没拖过时按库的密度给默认宽度：full 240，light 200', () => {
    expect(sidebarStyle(mountBrowser())).toContain('width: 240px')
    expect(sidebarStyle(mountBrowser({ ...blueprintScope, density: 'light' }))).toContain(
      'width: 200px'
    )
  })

  it('按住分界线拖动，侧栏跟着变宽', async () => {
    const wrapper = mountBrowser()
    await wrapper.find('.sidebar-resize-handle').trigger('mousedown', { clientX: 240 })
    await fireMove(320)
    expect(sidebarStyle(wrapper)).toContain('width: 320px')
    fireUp()
  })

  it('拖过头被夹在 180–480 之间，不把画廊挤没', async () => {
    const wrapper = mountBrowser()
    await wrapper.find('.sidebar-resize-handle').trigger('mousedown', { clientX: 240 })
    await fireMove(2400)
    expect(sidebarStyle(wrapper)).toContain('width: 480px')
    await fireMove(-2400)
    expect(sidebarStyle(wrapper)).toContain('width: 180px')
    fireUp()
  })

  it('松手后宽度落盘，下次打开还在', async () => {
    const first = mountBrowser()
    await first.find('.sidebar-resize-handle').trigger('mousedown', { clientX: 240 })
    await fireMove(360)
    fireUp()
    first.unmount()

    expect(sidebarStyle(mountBrowser())).toContain('width: 360px')
  })

  it('松手之后再动鼠标，宽度不再跟', async () => {
    const wrapper = mountBrowser()
    await wrapper.find('.sidebar-resize-handle').trigger('mousedown', { clientX: 240 })
    fireUp()
    await fireMove(400)
    expect(sidebarStyle(wrapper)).toContain('width: 240px')
  })

  it('手柄带 role=separator 和读屏文案 —— 光拖得动不够，还得知道能拖', () => {
    const wrapper = mountBrowser()
    const handle = wrapper.find('.sidebar-resize-handle')
    expect(handle.attributes('role')).toBe('separator')
    expect(handle.attributes('aria-label')).toBe('拖动调整文件夹栏宽度')
  })
})

describe('网格 / 列表', () => {
  const pressed = (wrapper: VueWrapper, label: string): string | undefined =>
    wrapper.find(`.view-toggle [aria-label="${label}"]`).attributes('aria-pressed')

  it('不传 viewMode 时组件自己记', async () => {
    const wrapper = mountBrowser()
    await wrapper.find('.view-toggle [aria-label="列表"]').trigger('click')
    expect(pressed(wrapper, '列表')).toBe('true')
  })

  it('传了 viewMode 就按它显示，切换时发给库去存盘', async () => {
    const wrapper = mount(LibraryBrowser, {
      props: { scope: blueprintScope, items, folders, viewMode: 'list' },
      global: { plugins: [i18n] }
    })
    expect(pressed(wrapper, '列表')).toBe('true')

    await wrapper.find('.view-toggle [aria-label="网格"]').trigger('click')
    expect(wrapper.emitted('update:viewMode')).toEqual([['grid']])
  })
})
