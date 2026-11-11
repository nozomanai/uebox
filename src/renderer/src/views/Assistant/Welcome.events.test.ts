import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import Welcome from './Welcome.vue'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import {
  installObserverStubs,
  installWindowApiStub
} from '../../../../../tests/utils/componentMount'

/**
 * Welcome 的事件 / prop 连线断言：挂起来看编译后的监听器和 props，不再读源码。
 *
 * `tsconfig.web.json` 没开 `strictTemplates`，监听一个子组件没声明的事件、prop
 * 改名漏一边，类型检查都看不见 —— 这里断言的是解析后的函数和值，脚本里把处理
 * 函数改名、模板忘了跟着改，当场红。
 */

vi.mock('vue-router', () => ({
  useRoute: () => ({ query: {}, params: {}, path: '/', fullPath: '/', name: undefined, meta: {} }),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    back: vi.fn(),
    currentRoute: { value: { path: '/', query: {} } }
  })
}))

const stubs = {
  // Welcome 的 watcher / onMounted 会调 chatLogRef 上的这四个方法，桩必须 expose，
  // 缺一个挂在挂载期就抛「xxx is not a function」
  ChatLog: {
    name: 'ChatLog',
    setup(_props: unknown, { expose }: { expose: (exposed: object) => void }) {
      expose({
        getScrollElement: () => null,
        scrollToBottom: () => {},
        stopAutoScroll: () => {},
        isNearBottom: () => true
      })
      return () => null
    }
  },
  TopNav: {
    name: 'TopNav',
    props: { chatSid: String },
    template: '<div />'
  },
  SessionProjectChip: {
    name: 'SessionProjectChip',
    props: { chatSid: String },
    template: '<div />'
  },
  AgentBrowserPane: {
    name: 'AgentBrowserPane',
    props: { sessionId: String },
    template: '<div />'
  },
  BrandSphere: true,
  VoiceOrb: true,
  InputComposer: true,
  SuggestionCards: true,
  FileReviewPane: true,
  TeamBoardPanel: true,
  AppButton: true
}

function mountWelcome(props: { forceChatView?: boolean } = {}): ReturnType<typeof mount> {
  return mount(Welcome, {
    props: { chatSid: 'chat-1', ...props },
    global: { stubs }
  })
}

beforeEach(() => {
  installWindowApiStub()
  installObserverStubs()
})

describe('Welcome 事件连线', () => {
  it('<ChatLog> 的 branch 接到处理函数', () => {
    // ChatLog 只在对话态渲染
    const chatLog = mountWelcome({ forceChatView: true }).findComponent({ name: 'ChatLog' })
    expect(chatLog.exists()).toBe(true)
    expect(typeof chatLog.vm.$attrs.onBranch).toBe('function')
  })

  it('<TopNav> 的 side-question 接到处理函数', () => {
    const topNav = mountWelcome().findComponent({ name: 'TopNav' })
    expect(topNav.exists()).toBe(true)
    expect(typeof topNav.vm.$attrs.onSideQuestion).toBe('function')
  })
})

describe('Welcome 建议卡片里的 MegaJam', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  function suggestionPrompts(now: Date): string[] {
    // 只接管 Date，定时器和 rAF 照常走
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(now)
    const cards = mountWelcome().findComponent({ name: 'SuggestionCards' })
    expect(cards.exists()).toBe(true)
    return (cards.props('items') as Array<{ prompt?: string }>).map((item) => item.prompt ?? '')
  }

  it('2026-11-30 23:59 排在第一张', () => {
    const prompts = suggestionPrompts(new Date(2026, 10, 30, 23, 59))
    expect(prompts).toHaveLength(4)
    expect(prompts[0]).toContain('MegaJam')
  })

  it('2026-12-01 00:00 起不含这张', () => {
    const prompts = suggestionPrompts(new Date(2026, 11, 1, 0, 0))
    expect(prompts).toHaveLength(3)
    expect(prompts.some((prompt) => prompt.includes('MegaJam'))).toBe(false)
  })
})

describe('Welcome prop 连线', () => {
  it('<TopNav> 与 <SessionProjectChip> 的对话 id 走 chatSid', () => {
    // SessionProjectChip 在 hero 区（v-if="!conversationMode"），这次不压 forceChatView
    const wrapper = mountWelcome()
    const topNav = wrapper.findComponent({ name: 'TopNav' })
    const chip = wrapper.findComponent({ name: 'SessionProjectChip' })

    expect(topNav.props('chatSid')).toBe('chat-1')
    expect(chip.exists()).toBe(true)
    expect(chip.props('chatSid')).toBe('chat-1')
    expect(topNav.vm.$attrs.sessionId).toBeUndefined()
    expect(chip.vm.$attrs.sessionId).toBeUndefined()
  })

  it('<AgentBrowserPane> 的 sessionId 指内核会话，保持原名', () => {
    // AgentBrowserPane 只在有浏览器/审查上下文时渲染：browserSessionId 来自
    // chatStore.getAgentSessionId(sid)，播种一条挂了内核会话的对话
    const chatStore = useChatSessionsStore()
    chatStore.sessions = [
      {
        id: 'chat-1',
        title: '对话',
        createdAt: 1,
        updatedAt: 1,
        agentSessionId: 'engine-9'
      }
    ]

    const pane = mountWelcome().findComponent({ name: 'AgentBrowserPane' })
    expect(pane.exists()).toBe(true)
    expect(pane.props('sessionId')).toBe('engine-9')
  })
})
