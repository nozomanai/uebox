import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'

import ChatSessionList from './ChatSessionList.vue'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'

vi.mock('@floating-ui/dom', () => ({
  computePosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
  autoUpdate: vi.fn(() => vi.fn()),
  offset: vi.fn(),
  flip: vi.fn(),
  shift: vi.fn()
}))

const mounted: VueWrapper[] = []

function mountList(): VueWrapper {
  const wrapper = mount(ChatSessionList, {
    props: { collapsed: false, activeChatSid: '' },
    global: {
      stubs: { SidebarSectionHeader: { template: '<div><slot /><slot name="actions" /></div>' } }
    }
  }) as VueWrapper
  mounted.push(wrapper)
  return wrapper
}

beforeEach(() => {
  setActivePinia(createPinia())
  ;(window as unknown as { api: unknown }).api = {
    on: vi.fn(),
    off: vi.fn(),
    agentV3: { externalTeams: vi.fn().mockResolvedValue({ success: true, teams: [] }) },
    websocket: { getProjects: vi.fn().mockResolvedValue([]), onProjectsChanged: vi.fn() }
  }
})

afterEach(() => {
  while (mounted.length) mounted.pop()?.unmount()
  document.body.innerHTML = ''
})

const dropdownCount = (): number => document.querySelectorAll('.app-dropdown').length

describe('右键菜单幽灵浮层', () => {
  it('归入工程：点选工程后不留浮层', async () => {
    const store = useChatSessionsStore()
    store.ensureSession('s1', '要归入的会话')
    // 让 knownProjects 非空：另一条会话身上带个工程戳
    const other = store.ensureSession('s2', '别的会话')
    store.setProject(other.id, { projectName: '项目A' })

    const wrapper = mountList()
    await wrapper.vm.$nextTick()

    const row = wrapper.findAll('.chat-item').find((item) => item.text().includes('要归入的会话'))
    expect(row).toBeTruthy()

    await row!.trigger('contextmenu', { clientX: 200, clientY: 120 })
    await wrapper.vm.$nextTick()
    await Promise.resolve()

    expect(dropdownCount()).toBe(1)

    // 悬停/点开「归入工程」子菜单
    const submenuLi = document.querySelector<HTMLElement>('.app-menu-submenu')
    expect(submenuLi).not.toBeNull()
    submenuLi?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
    await wrapper.vm.$nextTick()
    await Promise.resolve()

    const popup = document.querySelector<HTMLElement>('.app-menu-submenu__popup')
    expect(popup, '子菜单应该弹出来').not.toBeNull()

    const projectItem = [
      ...document.querySelectorAll<HTMLElement>('.app-menu-submenu__popup .app-menu-item')
    ].find((el) => el.textContent?.includes('项目A'))
    expect(projectItem, '子菜单里应该列出项目A').toBeTruthy()
    projectItem!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    projectItem!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()
    await Promise.resolve()

    expect(store.sessionById('s1')?.project?.projectName).toBe('项目A')
    expect(dropdownCount(), '归属后不应残留浮层').toBe(0)
  })

  it('点「归入工程」标题本身（.stop 拦截），浮层保持打开可正常关闭', async () => {
    const store = useChatSessionsStore()
    store.ensureSession('s1', '要归入的会话')
    const other = store.ensureSession('s2', '别的会话')
    store.setProject(other.id, { projectName: '项目A' })

    const wrapper = mountList()
    await wrapper.vm.$nextTick()

    const row = wrapper.findAll('.chat-item').find((item) => item.text().includes('要归入的会话'))
    await row!.trigger('contextmenu', { clientX: 200, clientY: 120 })
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    expect(dropdownCount()).toBe(1)

    const trigger = document.querySelector<HTMLElement>('.app-menu-submenu__trigger')
    expect(trigger).not.toBeNull()
    trigger!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    trigger!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()
    await Promise.resolve()

    // 子菜单标题点击不该关掉主菜单
    expect(dropdownCount()).toBe(1)
    // 而且依然能响应外部点击
    document.documentElement.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    expect(dropdownCount()).toBe(0)
  })

  it('菜单开着时行被跨区挪走，不留关不掉的浮层', async () => {
    const store = useChatSessionsStore()
    store.ensureSession('s1', '要置顶的会话')

    const wrapper = mountList()
    await wrapper.vm.$nextTick()

    const row = wrapper.findAll('.chat-item').find((item) => item.text().includes('要置顶的会话'))
    expect(row).toBeTruthy()

    await row!.trigger('contextmenu', { clientX: 200, clientY: 120 })
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    expect(dropdownCount()).toBe(1)

    // 菜单还开着时，会话被外部因素挪到别的区（置顶/归档/外部归属推送等都行）
    store.togglePinned('s1')
    await wrapper.vm.$nextTick()
    await Promise.resolve()

    const ghosts = document.querySelectorAll('.app-dropdown')
    expect(ghosts.length, '挪区后不应有残留的浮层实例').toBeLessThanOrEqual(1)

    if (ghosts.length === 1) {
      // 如果还有一个开着，点外面必须能关掉 —— 不能是没注册监听器的幽灵
      document.documentElement.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
      await wrapper.vm.$nextTick()
      await Promise.resolve()
      expect(dropdownCount(), '点外面必须能把浮层关掉').toBe(0)
    }
  })

  it('键盘 Enter 触发归入工程，不产生幽灵菜单', async () => {
    const store = useChatSessionsStore()
    store.ensureSession('s1', '要归入的会话')
    const other = store.ensureSession('s2', '别的会话')
    store.setProject(other.id, { projectName: '项目A' })

    const wrapper = mountList()
    await wrapper.vm.$nextTick()

    const row = wrapper.findAll('.chat-item').find((item) => item.text().includes('要归入的会话'))
    await row!.trigger('contextmenu', { clientX: 200, clientY: 120 })
    await wrapper.vm.$nextTick()
    await Promise.resolve()

    const submenuLi = document.querySelector<HTMLElement>('.app-menu-submenu')
    submenuLi?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: false }))
    await wrapper.vm.$nextTick()
    await Promise.resolve()

    const projectItem = [
      ...document.querySelectorAll<HTMLElement>('.app-menu-submenu__popup .app-menu-item')
    ].find((el) => el.textContent?.includes('项目A'))
    expect(projectItem).toBeTruthy()

    // 键盘激活：activate() 走 emit('click')，但没有原生 click 冒泡到 .app-dropdown
    projectItem!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    await wrapper.vm.$nextTick()
    await Promise.resolve()

    expect(store.sessionById('s1')?.project?.projectName).toBe('项目A')
    // 键盘激活不产生原生 click，菜单只能靠 app-menu-item-activate 当场关掉
    expect(dropdownCount(), '键盘激活后菜单应当场关掉').toBe(0)
  })

  it('菜单开着时点行内置顶按钮，不产生幽灵菜单', async () => {
    const store = useChatSessionsStore()
    store.ensureSession('s1', '要置顶的会话')

    const wrapper = mountList()
    await wrapper.vm.$nextTick()

    const row = wrapper.findAll('.chat-item').find((item) => item.text().includes('要置顶的会话'))
    expect(row).toBeTruthy()

    await row!.trigger('contextmenu', { clientX: 200, clientY: 120 })
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    expect(dropdownCount()).toBe(1)

    // 行内置顶按钮：在 triggerRef 内部 + @click.stop —— 菜单不会被关掉，但会话被挪到了「置顶」
    const pinBtn = row!.findAll('.chat-icon-btn')[0]
    pinBtn.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    pinBtn.element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()
    await Promise.resolve()

    expect(store.sessionById('s1')?.pinned).toBe(true)

    // 点外面必须能关掉所有浮层
    document.documentElement.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    expect(dropdownCount(), '点外面必须能把浮层关掉').toBe(0)
  })

  it('菜单开着时点行内归档，会话恢复后不再弹出旧菜单', async () => {
    const store = useChatSessionsStore()
    store.ensureSession('s1', '要归档的会话')

    const wrapper = mountList()
    await wrapper.vm.$nextTick()

    const row = wrapper.findAll('.chat-item').find((item) => item.text().includes('要归档的会话'))
    expect(row).toBeTruthy()

    await row!.trigger('contextmenu', { clientX: 200, clientY: 120 })
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    expect(dropdownCount()).toBe(1)

    const archiveBtn = row!.findAll('.chat-icon-btn')[1]
    archiveBtn.element.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
    archiveBtn.element.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    expect(store.sessionById('s1')?.archived).toBe(true)
    expect(dropdownCount()).toBe(0)

    store.setArchived('s1', false)
    await wrapper.vm.$nextTick()
    await Promise.resolve()
    expect(dropdownCount(), '恢复后不应重新弹出旧菜单').toBe(0)
  })
})
