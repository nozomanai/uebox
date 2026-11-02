import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { reactive } from 'vue'
import ChatEntry from './ChatEntry.vue'

const route = reactive({ query: { sid: '' } })
vi.mock('vue-router', () => ({ useRoute: () => route }))
vi.mock('./Welcome.vue', () => ({
  __esModule: true,
  default: { template: '<div class="normal-chat" />' }
}))
vi.mock('./components/ExternalTeamChat.vue', () => ({
  __esModule: true,
  default: { props: ['teamId'], template: '<div class="external-chat">{{ teamId }}</div>' }
}))

describe('统一对话入口', () => {
  it('普通对话与外部对话按 sid 打开各自内容，互相切换不会残留普通输入区', async () => {
    const wrapper = mount(ChatEntry)
    await flushPromises()
    expect(wrapper.find('.normal-chat').exists()).toBe(true)
    route.query.sid = 'ext-2'
    await flushPromises()
    expect(wrapper.find('.external-chat').text()).toBe('ext-2')
    expect(wrapper.find('.normal-chat').exists()).toBe(false)
    route.query.sid = 'normal-1'
    await flushPromises()
    expect(wrapper.find('.normal-chat').exists()).toBe(true)
    expect(wrapper.find('.external-chat').exists()).toBe(false)
    wrapper.unmount()
  })
})
