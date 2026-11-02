import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { ExternalTeamSummary } from '@core/shared/agentTeam'
import ChatSessionList from './ChatSessionList.vue'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { useChatSidebarStore } from '@renderer/store/modules/chatSidebarStore'
import { externalTeamChats } from '../composables/externalTeamChats'
import { groupChatSessions } from '../composables/chatSessionGrouping'

vi.mock('@floating-ui/dom', () => ({
  computePosition: vi.fn().mockResolvedValue({ x: 0, y: 0 }),
  autoUpdate: vi.fn(() => vi.fn()),
  offset: vi.fn(),
  flip: vi.fn(),
  shift: vi.fn()
}))
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ push: vi.fn() })
}))

const teams: ExternalTeamSummary[] = [
  {
    id: 'ext-2',
    objective: '外部塔防',
    projectPath: 'd:\\games\\td\\',
    createdAt: 2000,
    ended: false,
    verdict: 'pass',
    passed: true,
    members: 3
  },
  {
    id: 'ext-1',
    objective: '无工程的团队',
    createdAt: 1000,
    ended: true,
    verdict: null,
    passed: false,
    members: 1
  }
]
const mounted: VueWrapper[] = []
const list = vi.fn()
const handlers = new Map<string, (...args: unknown[]) => void>()
const off = vi.fn()
function mountList(activeChatSid = ''): VueWrapper {
  const wrapper = mount(ChatSessionList, {
    props: { collapsed: false, activeChatSid },
    global: { stubs: { AInput: true } }
  })
  mounted.push(wrapper)
  return wrapper
}
beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  handlers.clear()
  list.mockResolvedValue({ success: true, teams })
  Object.assign(window, {
    api: {
      on: vi.fn((channel: string, handler: (...args: unknown[]) => void) => {
        const wrapped = (...args: unknown[]): void => handler(...args)
        handlers.set(channel, wrapped)
        return wrapped
      }),
      off,
      agentV3: { externalTeams: list },
      websocket: {
        getProjects: vi.fn().mockResolvedValue([]),
        onProjectsChanged: vi.fn(() => vi.fn())
      }
    }
  })
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
  document.body.innerHTML = ''
})

describe('项目列表里的外部驱动对话', () => {
  it('按规范化路径复用已有项目名，与普通对话排在同一组；没有工程的落到对话区', async () => {
    const chat = useChatSessionsStore()
    chat.ensureSession('normal', '普通塔防')
    chat.setProject('normal', { projectName: '塔防工程', projectPath: 'D:/Games/TD/TD.uproject' })
    const wrapper = mountList('ext-2')
    await flushPromises()
    expect(wrapper.findAll('.chat-group-title').map((item) => item.text())).toEqual(['塔防工程'])
    const rows = wrapper.findAll('.chat-item')
    expect(rows.map((item) => item.text())).toEqual(['普通塔防', '外部塔防', '无工程的团队'])
    expect(rows[0].classes()).toContain('indent')
    expect(rows[1].classes()).toContain('indent')
    expect(rows[1].classes()).toContain('active')
    expect(rows[1].attributes('title')).toContain('已过验收')
    expect(rows[2].classes()).not.toContain('indent')
    await rows[1].trigger('click')
    expect(wrapper.emitted('open')).toEqual([['ext-2']])
    expect(chat.sessions.map((item) => item.id)).toEqual(['normal'])
  })

  it('同名不同路径不串组，目录与 uproject 写法相同；未登记工程用路径推导名称', () => {
    const projected = externalTeamChats(
      [
        teams[0],
        { ...teams[0], id: 'ext-3', projectPath: 'E:/Games/TD' },
        { ...teams[0], id: 'ext-4', projectPath: '/Games/Other/Other.uproject' }
      ],
      [{ projectName: 'TD', projectPath: 'D:/Games/TD/TD.uproject' }]
    )
    const groups = groupChatSessions(projected, { mode: 'project', sortMode: 'recent' })
    expect(groups).toHaveLength(3)
    expect(groups.filter((group) => group.projectName === 'TD').every((group) => group.split)).toBe(
      true
    )
    expect(groups.map((group) => group.sessions.length)).toEqual([1, 1, 1])
    expect(projected[2].project?.projectName).toBe('Other')
  })

  it('首次加载完成后展开当前团队所在项目，超过默认五个项目时也能找到；更新不强行展开', async () => {
    const sidebar = useChatSidebarStore()
    for (let i = 0; i < 6; i++) {
      sidebar.addManualProject({ projectName: `置顶${i}` })
      sidebar.toggleProjectPinned(`置顶${i}`)
    }
    sidebar.toggleGroup('project:td')
    const wrapper = mountList('ext-2')
    await flushPromises()
    expect(wrapper.find('.chat-item-external.active').exists()).toBe(true)
    expect(sidebar.isGroupCollapsed('project:td')).toBe(false)
    sidebar.toggleGroup('project:td')
    handlers.get('agent-v3:team-board')?.({ sessionId: 'ext-2' })
    await flushPromises()
    expect(sidebar.isGroupCollapsed('project:td')).toBe(true)
  })

  it('新团队和验收变化自动出现，平铺与折叠模式也保留外部对话', async () => {
    list.mockResolvedValueOnce({ success: true, teams: [] })
    const wrapper = mountList()
    await flushPromises()
    expect(wrapper.find('.chat-item-external').exists()).toBe(false)
    handlers.get('agent-v3:team-board')?.({ sessionId: 'ext-2' })
    await flushPromises()
    expect(wrapper.findAll('.chat-item-external')).toHaveLength(2)
    useChatSidebarStore().setGroupMode('flat')
    await flushPromises()
    expect(wrapper.find('.chat-group-row').exists()).toBe(false)
    expect(wrapper.findAll('.chat-item-external')).toHaveLength(2)
    await wrapper.setProps({ collapsed: true })
    expect(wrapper.findAll('.chat-collapsed-item')).toHaveLength(2)
    await wrapper.find('.chat-collapsed-item').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['ext-2']])
  })

  it('读取失败保留上一份列表，晚到的旧请求不覆盖新结果；卸载清理原订阅', async () => {
    let resolveOld!: (value: unknown) => void
    list.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    const wrapper = mountList()
    handlers.get('agent-v3:team-board')?.({ sessionId: 'ext-2' })
    await flushPromises()
    resolveOld({ success: true, teams: [] })
    await flushPromises()
    expect(wrapper.findAll('.chat-item-external')).toHaveLength(2)
    list.mockResolvedValueOnce({ success: false, teams: [] })
    handlers.get('agent-v3:team-board')?.({ sessionId: 'ext-2' })
    await flushPromises()
    expect(wrapper.findAll('.chat-item-external')).toHaveLength(2)
    wrapper.unmount()
    expect(off).toHaveBeenCalledWith('agent-v3:team-board', handlers.get('agent-v3:team-board'))
  })

  it('普通对话的多选不会包含外部记录，避免把团队送进普通对话的删除和归档接口', async () => {
    const chat = useChatSessionsStore()
    chat.ensureSession('first', '普通一')
    chat.ensureSession('last', '普通二')
    chat.sessions[0].createdAt = chat.sessions[0].updatedAt = 3000
    chat.sessions[1].createdAt = chat.sessions[1].updatedAt = 500
    useChatSidebarStore().setGroupMode('flat')
    const wrapper = mountList()
    await flushPromises()
    const rows = wrapper.findAll('.chat-item')
    await rows[0].trigger('click', { ctrlKey: true })
    await rows[3].trigger('click', { shiftKey: true })
    expect(wrapper.findAll('.chat-item.selected')).toHaveLength(2)
    expect(wrapper.findAll('.chat-item-external .chat-icon-btn')).toHaveLength(0)
  })
})
