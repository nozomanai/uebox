import { mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import ChatWindow from './ChatWindow.vue'
import {
  installObserverStubs,
  installWindowApiStub
} from '../../../../../tests/utils/componentMount'

/**
 * ChatWindow → Welcome 的 prop 连线断言。
 *
 * `tsconfig.web.json` 没开 `strictTemplates`，prop 改名类型检查看不见 —— 所以
 * 挂起来断言编译后的 props。Welcome 用桩替掉：它三千行、不在被测面上。
 */

const routeQuery = vi.hoisted(() => ({ sid: 'chat-42' as string }))

vi.mock('vue-router', () => ({
  useRoute: () => ({
    query: routeQuery,
    params: {},
    path: '/',
    fullPath: '/',
    name: 'ChatWindow',
    meta: {}
  }),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    currentRoute: { value: { path: '/', query: {} } }
  })
}))

const stubs = {
  ExternalTeamChat: {
    name: 'ExternalTeamChat',
    props: { teamId: String },
    template: '<div />'
  },
  Welcome: {
    name: 'Welcome',
    props: { chatSid: String, forceChatView: Boolean },
    template: '<div />'
  },
  SensitiveActionConfirm: true
}

function mountChatWindow(): ReturnType<typeof mount> {
  return mount(ChatWindow, { global: { stubs } })
}

beforeEach(() => {
  installWindowApiStub()
  installObserverStubs()
  routeQuery.sid = 'chat-42'
})

describe('ChatWindow prop 连线', () => {
  it('外部对话拖到独立窗口后仍是团队任务板，不挂载普通输入区', () => {
    routeQuery.sid = 'ext-2'
    const wrapper = mountChatWindow()
    expect(wrapper.findComponent({ name: 'ExternalTeamChat' }).props('teamId')).toBe('ext-2')
    expect(wrapper.findComponent({ name: 'Welcome' }).exists()).toBe(false)
    wrapper.unmount()
  })

  it('路由上的 sid 以 chatSid 传给 <Welcome>', () => {
    const welcome = mountChatWindow().findComponent({ name: 'Welcome' })
    expect(welcome.exists()).toBe(true)
    expect(welcome.props('chatSid')).toBe('chat-42')
    // 旧名一个都不能回来：sessionId 是内核那一层，agentSessionId 上游已经摘掉
    expect(welcome.vm.$attrs.sessionId).toBeUndefined()
    expect(welcome.vm.$attrs.agentSessionId).toBeUndefined()
  })

  it('路由上没有 sid 时不渲染 <Welcome>', () => {
    routeQuery.sid = ''
    expect(mountChatWindow().findComponent({ name: 'Welcome' }).exists()).toBe(false)
  })
})
