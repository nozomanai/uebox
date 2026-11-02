import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import type { TeamStateView } from '@core/shared/agentTeam'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'

const api = vi.hoisted(() => ({
  teamState: vi.fn(),
  teamEnd: vi.fn(),
  teamTaskReopen: vi.fn(),
  teamJobReopen: vi.fn()
}))
vi.mock('@renderer/api/agentV3', () => ({ agentV3API: api }))
vi.mock('@renderer/api/aiProvider', () => ({
  aiProviderAPI: { getSettings: vi.fn(async () => ({ providers: [] })) }
}))
const updateTabTitle = vi.hoisted(() => vi.fn())
vi.mock('@renderer/store/modules/tabs', () => ({
  useTabsStore: () => ({ updateTabTitleByPath: updateTabTitle })
}))
vi.mock('vue-router', () => ({
  useRoute: () => ({ fullPath: '/dev-assistant?sid=ext-2' })
}))
const messages = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }))
vi.mock('@renderer/utils/messageManager', () => ({ message: messages }))

import ExternalTeamChat from './ExternalTeamChat.vue'

function state(objective: string): TeamStateView {
  return {
    objective,
    verdict: null,
    verdictStale: false,
    deliveries: 0,
    members: [],
    board: [],
    mail: [],
    external: true
  }
}
const BoardStub = {
  name: 'TeamBoardPanel',
  props: ['team', 'sessionId', 'modelChoices'],
  emits: ['end', 'reopen', 'reopen-job', 'open-models', 'set-model', 'dismiss'],
  template: '<div class="board-stub">{{ team.objective }}</div>'
}
const mounted: VueWrapper[] = []
function mountChat(): VueWrapper {
  const wrapper = mount(ExternalTeamChat, {
    props: { teamId: 'ext-2' },
    global: { stubs: { TeamBoardPanel: BoardStub } }
  })
  mounted.push(wrapper)
  return wrapper
}
beforeEach(() => {
  setActivePinia(createPinia())
  vi.clearAllMocks()
  api.teamState.mockImplementation(async (id: string) =>
    state(id === 'ext-2' ? '做一个塔防' : '做一个跑酷')
  )
  api.teamEnd.mockResolvedValue({ success: true })
})
afterEach(() => {
  mounted.splice(0).forEach((wrapper) => wrapper.unmount())
})

describe('外部驱动的对话', () => {
  it('直接打开选中团队，没有第二份列表，也不创建普通对话；标签使用目标标题', async () => {
    const wrapper = mountChat()
    await flushPromises()
    expect(wrapper.find('.board-stub').text()).toBe('做一个塔防')
    expect(api.teamState).toHaveBeenCalledWith('ext-2')
    expect(wrapper.find('aside').exists()).toBe(false)
    expect(useChatSessionsStore().sessions).toEqual([])
    expect(updateTabTitle).toHaveBeenCalledWith('/dev-assistant?sid=ext-2', '做一个塔防')
  })

  it('换团队后不显示旧任务板，旧请求晚到也不能覆盖新团队', async () => {
    let resolveOld!: (value: TeamStateView) => void
    api.teamState.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveOld = resolve
        })
    )
    const wrapper = mountChat()
    await wrapper.setProps({ teamId: 'ext-1' })
    await flushPromises()
    expect(wrapper.find('.board-stub').text()).toBe('做一个跑酷')
    resolveOld(state('旧团队'))
    await flushPromises()
    expect(wrapper.find('.board-stub').text()).toBe('做一个跑酷')
    api.teamState.mockRejectedValueOnce(new Error('offline'))
    await wrapper.setProps({ teamId: 'ext-missing' })
    await flushPromises()
    expect(wrapper.find('.board-stub').exists()).toBe(false)
    expect(wrapper.text()).toContain('暂时无法读取')
  })

  it('结束仍使用团队 id，成功后重读任务板；失败有反馈', async () => {
    const wrapper = mountChat()
    await flushPromises()
    wrapper.findComponent(BoardStub).vm.$emit('end')
    await flushPromises()
    expect(api.teamEnd).toHaveBeenCalledWith('ext-2')
    expect(api.teamState).toHaveBeenCalledTimes(2)
    expect(messages.info).toHaveBeenCalled()
    api.teamEnd.mockRejectedValueOnce(new Error('offline'))
    wrapper.findComponent(BoardStub).vm.$emit('end')
    await flushPromises()
    expect(messages.error).toHaveBeenCalled()
    expect(api.teamState).toHaveBeenCalledTimes(2)
  })

  it('任务和活的重开继续传给当前团队', async () => {
    api.teamTaskReopen.mockResolvedValue({ success: true })
    api.teamJobReopen.mockResolvedValue({ success: true })
    const wrapper = mountChat()
    await flushPromises()
    wrapper.findComponent(BoardStub).vm.$emit('reopen', 'task-a')
    wrapper.findComponent(BoardStub).vm.$emit('reopen-job', 'job-a')
    await flushPromises()
    expect(api.teamTaskReopen).toHaveBeenCalledWith('ext-2', 'task-a')
    expect(api.teamJobReopen).toHaveBeenCalledWith('ext-2', 'job-a')
  })

  it('不存在或首次读取失败时提供重试，不自动切到另一个团队', async () => {
    api.teamState.mockResolvedValueOnce(null)
    const wrapper = mountChat()
    await flushPromises()
    expect(wrapper.text()).toContain('暂时无法读取')
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(wrapper.find('.board-stub').text()).toBe('做一个塔防')
    expect(api.teamState).toHaveBeenLastCalledWith('ext-2')
  })
})
