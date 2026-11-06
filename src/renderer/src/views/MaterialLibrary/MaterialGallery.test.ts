import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { useMaterialLibraryStore } from '@renderer/store/modules/materialLibraryStore'
import { createStoredEntry } from '../../../../../tests/material-library/fixtures'
import MaterialGallery from './MaterialGallery.vue'

function createTestRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/material-library', name: 'MaterialGallery', component: MaterialGallery },
      { path: '/material-library/:id', name: 'MaterialEditor', component: { template: '<div />' } }
    ]
  })
}

async function mountGallery() {
  const router = createTestRouter()
  router.push('/material-library')
  await router.isReady()

  const wrapper = mount(MaterialGallery, {
    global: {
      plugins: [router],
      // 新建 / 编辑弹窗走 LibraryFormModal，它 Teleport 到 body；
      // 打桩后内容留在 wrapper 里，断言才够得着
      stubs: { teleport: true }
    }
  })

  return { wrapper, router }
}

describe('MaterialGallery', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
  })

  it('renders material cards with material metrics', async () => {
    const store = useMaterialLibraryStore()
    store.upsertEntries([
      createStoredEntry({
        id: 'material-rock',
        name: 'M_Rock',
        compileStatus: 'warning',
        scalarParameters: [{ name: 'Roughness', type: 'scalar', overrideValue: 0.4 }],
        textureDependencies: [
          { path: '/Game/Textures/T_Rock', name: 'T_Rock', kind: 'texture', isResolved: true }
        ]
      })
    ])

    const { wrapper } = await mountGallery()

    expect(wrapper.text()).toContain('M_Rock')
    expect(wrapper.text()).toContain('警告')
    expect(wrapper.text()).toContain('参数 1')
    expect(wrapper.text()).toContain('依赖 1')
  })

  it('去掉重复标题，并把导入和新建操作放进浏览器工具栏', async () => {
    const { wrapper } = await mountGallery()

    expect(wrapper.find('.gallery-header').exists()).toBe(false)
    expect(wrapper.text()).not.toContain('离线材质节点资产')
    // 「材质库」这个词只准出现在空态标题（「材质库为空」）里，页面上不再有第二处标题
    const emptyState = wrapper.find('.library-empty-state')
    const outsideEmptyState = wrapper
      .text()
      .replace(emptyState.exists() ? emptyState.text() : '', '')
    expect(outsideEmptyState).not.toContain('材质库')

    const toolbar = wrapper.get('.browser-toolbar')
    expect(toolbar.find('.btn-import').exists()).toBe(true)
    expect(toolbar.find('.btn-primary-create').exists()).toBe(true)
  })

  it('creates a local material draft with a blueprint-style default name', async () => {
    const store = useMaterialLibraryStore()
    const { wrapper, router } = await mountGallery()

    await wrapper.find('button.btn-primary-create').trigger('click')
    expect(
      (wrapper.find('input[placeholder="默认：新建材质节点"]').element as HTMLInputElement).value
    ).toBe('')

    await wrapper.find('.size-wide .btn-confirm').trigger('click')
    await flushPromises()

    expect(store.entries[0]).toEqual(
      expect.objectContaining({
        name: '新建材质节点',
        assetPath: '/MaterialLibrary/新建材质节点',
        sourceOrigin: 'local'
      })
    )
    expect(router.currentRoute.value.name).toBe('MaterialEditor')
    expect(router.currentRoute.value.query._tab_id).toEqual(expect.stringMatching(/^material-tab-/))
  })

  it('edits an existing material description from the info modal', async () => {
    const store = useMaterialLibraryStore()
    store.upsertEntries([
      createStoredEntry({
        id: 'material-door',
        name: 'M_Door',
        description: '旧材质备注'
      })
    ])

    const { wrapper } = await mountGallery()
    const editInfoItem = wrapper
      .findAll('.menu-item')
      .find((item) => item.text().includes('编辑信息'))
    expect(editInfoItem).toBeDefined()

    await editInfoItem!.trigger('click')

    const nameInput = wrapper.get('.modal-box input.form-input')
    const descriptionInput = wrapper.get<HTMLTextAreaElement>('.modal-box textarea.form-textarea')
    expect(descriptionInput.element.value).toBe('旧材质备注')

    await nameInput.setValue('M_Door_Updated')
    await descriptionInput.setValue('更新后的材质备注')
    await wrapper.get('.modal-box .btn-confirm').trigger('click')

    const updated = store.entries.find((entry) => entry.id === 'material-door')
    expect(updated?.name).toBe('M_Door_Updated')
    expect(updated?.description).toBe('更新后的材质备注')
  })

  // 原来这里测的是「拖一张卡到另一张卡上合并成集合」。那个交互已经删掉了 ——
  // 它抢了排序手势、产出叫「新建文件夹」还得改名、而且一个材质只能进一个集合。
  // 现在拖动的落点是左边的文件夹树，卡片不再是落点。
  it('把材质拖到文件夹树上会移动它，拖到另一张卡片上什么也不会发生', async () => {
    const store = useMaterialLibraryStore()
    store.upsertEntries([
      // assetPath 必须各不相同：upsertEntries 按它去重
      createStoredEntry({
        id: 'material-source',
        name: 'M_Source',
        assetPath: '/Game/Materials/M_Source'
      }),
      createStoredEntry({
        id: 'material-target',
        name: 'M_Target',
        assetPath: '/Game/Materials/M_Target'
      })
    ])
    const folder = store.createFolder('金属')

    const { wrapper } = await mountGallery()

    const cards = wrapper.findAll('.library-card')
    const source = cards.find((card) => card.text().includes('M_Source'))!
    const target = cards.find((card) => card.text().includes('M_Target'))!

    await source.trigger('dragstart')

    // 落到另一张卡片上：不该有任何变化
    await target.trigger('drop')
    expect(store.entries.find((e) => e.id === 'material-source')?.collectionId).toBeUndefined()

    // 落到文件夹树上：移动过去
    const folderRow = wrapper.findAll('.tree-row').find((row) => row.text().includes('金属'))!
    await folderRow.trigger('drop')

    expect(store.entries.find((e) => e.id === 'material-source')?.collectionId).toBe(folder!.id)
    expect(store.collections.find((c) => c.id === folder!.id)?.entryIds).toEqual([
      'material-source'
    ])
  })

  it('拿走最后一个成员，文件夹留着 —— 这是跟旧集合最大的区别', async () => {
    const store = useMaterialLibraryStore()
    store.upsertEntries([
      createStoredEntry({ id: 'material-only', name: 'M_Only', assetPath: '/Game/M_Only' })
    ])
    const folder = store.createFolder('金属')
    store.moveEntriesToFolder(['material-only'], folder!.id)

    const { wrapper } = await mountGallery()

    const card = wrapper.findAll('.library-card').find((c) => c.text().includes('M_Only'))!
    await card.trigger('dragstart')

    const rootRow = wrapper.findAll('.tree-row')[0]
    await rootRow.trigger('drop')

    expect(store.entries.find((e) => e.id === 'material-only')?.collectionId).toBeUndefined()
    expect(store.collections.some((c) => c.id === folder!.id)).toBe(true)
  })

  it('网格 / 列表的选择存进 store，重启后还在', async () => {
    const store = useMaterialLibraryStore()
    store.setViewMode('list')

    const { wrapper } = await mountGallery()

    const [gridButton, listButton] = wrapper.findAll('.view-toggle .toggle-btn')
    expect(listButton.attributes('aria-pressed')).toBe('true')

    await gridButton.trigger('click')
    expect(store.viewMode).toBe('grid')
  })
})
