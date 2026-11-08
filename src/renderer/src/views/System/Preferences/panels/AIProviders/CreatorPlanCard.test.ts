/** @vitest-environment jsdom */
import { describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import CreatorPlanCard from './CreatorPlanCard.vue'
import type { CreatorPlanPreview, CreatorPlanState } from '@core/shared/creatorPlan'

/**
 * 卡片三种样子：没连接（一个「连接」按钮）、已连接（套餐摘要 + 管理 / 重新导入 / 断开）、
 * 导入预览（默认勾选规则来自主进程，这里只守「按默认勾、按勾的应用」）。
 * 替身打在 window.api.creatorPlan 上，API 封装和组件都走真的。
 */

const stubs = {
  // 只渲染打开的弹窗，并把「确定」做成一个可点的按钮
  AppModal: {
    props: ['open', 'okText', 'okDisabled'],
    emits: ['ok', 'cancel'],
    template:
      '<div v-if="open" class="modal"><slot /><button class="modal-ok" :disabled="okDisabled" @click="$emit(\'ok\')">{{ okText }}</button></div>'
  }
}

const notConnected: CreatorPlanState = {
  connected: false,
  summary: null,
  managedRoles: [],
  error: null,
  deprecations: []
}

const connected: CreatorPlanState = {
  connected: true,
  managedRoles: ['agent', 'summary'],
  error: null,
  deprecations: [],
  summary: {
    tierName: 'Pro',
    status: 'active',
    interval: 'month',
    currentPeriodEnd: '2026-10-01T00:00:00Z',
    cancelAtPeriodEnd: false,
    quotaResetsAt: '2026-10-01T00:00:00Z',
    cooldownEndsAt: null,
    manageUrl: 'https://plan.example/account/billing',
    quotas: [{ key: 'credits', limit: 3_000_000_000, used: 690_000_000 }]
  }
}

const preview: CreatorPlanPreview = {
  summary: connected.summary!,
  changes: [
    {
      role: 'chat',
      model: 'uebox-chat',
      modelDisplayName: 'Creator · Chat',
      current: { providerId: 'mine', modelId: 'gpt-x', providerName: 'Mine' },
      managed: false,
      defaultSelected: false
    },
    {
      role: 'agent',
      model: 'uebox-agent',
      modelDisplayName: 'Creator · Agent',
      current: null,
      managed: false,
      defaultSelected: true
    }
  ]
}

let openExternal: ReturnType<typeof vi.fn>

function stubApi(
  overrides: Record<string, unknown> = {}
): Record<string, ReturnType<typeof vi.fn>> {
  const api = {
    state: vi.fn(async () => ({ ok: true, data: notConnected })),
    connect: vi.fn(async () => ({ ok: true, data: preview })),
    preview: vi.fn(async () => ({ ok: true, data: preview })),
    apply: vi.fn(async () => ({ ok: true, data: connected })),
    disconnect: vi.fn(async () => ({
      ok: true,
      data: { revoked: true, keysUrl: 'https://plan.example/account/keys' }
    })),
    cancel: vi.fn(async () => {}),
    onDeviceCode: vi.fn(() => () => {}),
    ...overrides
  }
  openExternal = vi.fn()
  window.api = {
    creatorPlan: api,
    shell: { openExternal }
  } as unknown as typeof window.api
  return api
}

describe('CreatorPlanCard', () => {
  it('没连接：说明 + 「连接」按钮', async () => {
    stubApi()
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()
    expect(wrapper.text()).toContain('使用虚幻盒子订阅服务一键配置所有模型')
    expect(wrapper.text()).toContain('连接')
    expect(wrapper.text()).not.toContain('断开')
  })

  it('已连接：档位、已用百分比和重置日期（不写 Credits 数字），以及管理 / 重新导入 / 断开', async () => {
    stubApi({ state: vi.fn(async () => ({ ok: true, data: connected })) })
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()
    const text = wrapper.text()
    expect(text).toContain('Pro · 月付')
    expect(text).toContain('生效中')
    expect(wrapper.find('.plan-used').text()).toMatch(/^本月已用 23% · .*2026.*重置$/)
    expect(wrapper.find('[role="progressbar"]').attributes('aria-valuenow')).toBe('23')
    expect(text).not.toMatch(/690|3,000|Credits/)
    expect(wrapper.find('.plan-daily-done').exists()).toBe(false)
    for (const label of ['管理订阅', '重新导入', '断开']) expect(text).toContain(label)
  })

  it('连接完成：按默认勾选弹出预览；点应用只提交勾上的角色，并通知父组件重读', async () => {
    const api = stubApi()
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()

    await wrapper
      .findAll('button')
      .find((b) => b.text() === '连接')!
      .trigger('click')
    await flushPromises()

    expect(wrapper.find('.modal').exists()).toBe(true)
    expect(wrapper.text()).toContain('接管：gpt-x · Mine')
    expect(wrapper.text()).toContain('接管：未设置')

    await wrapper.find('.modal-ok').trigger('click')
    await flushPromises()

    expect(api.apply).toHaveBeenCalledWith(['agent'])
    expect(wrapper.emitted('changed')).toHaveLength(1)
    expect(wrapper.find('.modal').exists()).toBe(false)
  })

  it('预览里什么都没有（订阅失效、角色全空、也不带存储）：「应用」点不了，免得删光套餐来源', async () => {
    const api = stubApi({
      state: vi.fn(async () => ({ ok: true, data: connected })),
      preview: vi.fn(async () => ({ ok: true, data: { ...preview, changes: [], storage: null } }))
    })
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '重新导入')!
      .trigger('click')
    await flushPromises()
    const ok = wrapper.find('.modal-ok')
    expect(ok.attributes('disabled')).toBeDefined()
    await ok.trigger('click')
    expect(api.apply).not.toHaveBeenCalled()
  })

  it('用户在浏览器里取消：不弹错误，也不弹预览', async () => {
    stubApi({ connect: vi.fn(async () => ({ ok: false, code: 'cancelled', error: 'x' })) })
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '连接')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.find('.modal').exists()).toBe(false)
  })

  it('Key 失效（unauthorized）：给「连接」，也给「断开」—— 不用先重新授权才能移除套餐', async () => {
    stubApi({
      state: vi.fn(async () => ({ ok: true, data: { ...connected, error: 'unauthorized' } }))
    })
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()
    const labels = wrapper.findAll('button').map((b) => b.text())
    expect(labels).toContain('连接')
    expect(labels).toContain('断开')
  })

  it('续费失败（past_due）：常驻提醒，点了去管理订阅', async () => {
    const pastDue = { ...connected, summary: { ...connected.summary!, status: 'past_due' } }
    stubApi({ state: vi.fn(async () => ({ ok: true, data: pastDue })) })
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()
    const alert = wrapper.find('.plan-alert')
    expect(alert.exists()).toBe(true)
    expect(alert.text()).toContain('本期额度降为 20%')
    await alert.find('button').trigger('click')
    expect(openExternal).toHaveBeenCalledWith('https://plan.example/account/billing')
  })

  it('今天的每日上限用完了：补一句什么时候恢复（本机时间）', async () => {
    const tomorrow = new Date(Date.now() + 24 * 60 * 60_000).toISOString()
    const data: CreatorPlanState = {
      ...connected,
      summary: {
        ...connected.summary!,
        quotas: [
          {
            key: 'credits',
            limit: 1_000_000_000,
            used: 250_000_000,
            daily: { limit: 200_000_000, used: 200_000_000, resetsAt: tomorrow }
          }
        ]
      }
    }
    stubApi({ state: vi.fn(async () => ({ ok: true, data })) })
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()
    expect(wrapper.find('.plan-used').text()).toMatch(/^本月已用 25%/)
    expect(wrapper.find('.plan-daily-done').text()).toMatch(
      /^今日额度已用完，明天 \d{2}:\d{2} 恢复$/
    )
  })

  it('旧服务端还发分项额度：只显示一个总百分比，取用得最多的那项；用超了算 100%', async () => {
    const data: CreatorPlanState = {
      ...connected,
      summary: {
        ...connected.summary!,
        quotaResetsAt: null,
        quotas: [
          { key: 'text_tokens', limit: 1000, used: 100 },
          { key: 'images', limit: 10, used: 12 }
        ]
      }
    }
    stubApi({ state: vi.fn(async () => ({ ok: true, data })) })
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()
    expect(wrapper.find('.plan-used').text()).toBe('本月已用 100%')
    expect(wrapper.findAll('[role="progressbar"]')).toHaveLength(1)
  })

  it('生效中不显示续费提醒', async () => {
    stubApi({ state: vi.fn(async () => ({ ok: true, data: connected })) })
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()
    expect(wrapper.find('.plan-alert').exists()).toBe(false)
  })

  it('正在用的模型要下线：列出来；嵌入还提示重建索引', async () => {
    const data: CreatorPlanState = {
      ...connected,
      deprecations: [
        { role: 'agent', model: 'uebox-agent', replacedBy: 'uebox-agent-2', removedAt: null },
        {
          role: 'embedding',
          model: 'uebox-embed-v1',
          replacedBy: 'uebox-embed-v2',
          removedAt: null
        }
      ]
    }
    stubApi({ state: vi.fn(async () => ({ ok: true, data })) })
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()
    const items = wrapper.findAll('.plan-deprecations li').map((li) => li.text())
    expect(items).toHaveLength(2)
    expect(items[0]).toContain('uebox-agent 即将下线')
    expect(items[0]).toContain('uebox-agent-2')
    expect(items[0]).not.toContain('重建')
    expect(items[1]).toContain('重建知识库索引')
  })

  async function disconnectWith(result: unknown): Promise<ReturnType<typeof mount>> {
    let current: CreatorPlanState = connected
    stubApi({
      state: vi.fn(async () => ({ ok: true, data: current })),
      disconnect: vi.fn(async () => {
        current = notConnected
        return result
      })
    })
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '断开')!
      .trigger('click')
    await flushPromises()
    await wrapper.find('.modal-ok').trigger('click')
    await flushPromises()
    return wrapper
  }

  it('断开时服务端没吊销成功：提示一句，带去网页端的链接', async () => {
    const wrapper = await disconnectWith({
      ok: true,
      data: { revoked: false, keysUrl: 'https://plan.example/account/keys' }
    })
    expect(wrapper.text()).toContain('服务端吊销此 Key 失败')
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '前往网页端吊销')!
      .trigger('click')
    expect(openExternal).toHaveBeenCalledWith('https://plan.example/account/keys')
    expect(wrapper.emitted('changed')).toHaveLength(1)
  })

  it('吊销成功：不提示', async () => {
    const wrapper = await disconnectWith({
      ok: true,
      data: { revoked: true, keysUrl: 'https://plan.example/account/keys' }
    })
    expect(wrapper.text()).not.toContain('服务端吊销此 Key 失败')
    expect(wrapper.text()).toContain('连接')
  })
})

describe('CreatorPlanCard 非对话角色', () => {
  const embeddingRow = (defaultSelected: boolean): CreatorPlanPreview => ({
    ...preview,
    changes: [
      {
        role: 'embedding',
        model: 'uebox-embed-v1',
        modelDisplayName: 'uebox-embed-v1',
        current: { providerId: 'ollama', modelId: 'bge-m3', providerName: 'Ollama' },
        managed: false,
        defaultSelected
      }
    ]
  })

  it('嵌入从别的来源换过来且勾上了：提示知识库会按新模型重建', async () => {
    stubApi({ connect: vi.fn(async () => ({ ok: true, data: embeddingRow(true) })) })
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '连接')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.text()).toContain('嵌入')
    expect(wrapper.text()).toContain('知识库将按新模型重建向量')
  })

  it('没勾上就不提示', async () => {
    stubApi({ connect: vi.fn(async () => ({ ok: true, data: embeddingRow(false) })) })
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '连接')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.text()).not.toContain('知识库将按新模型重建向量')
  })
})

describe('route price acceptance', () => {
  it('video-only pricing explains over-balance settlement before acceptance', async () => {
    const videoPricing = {
      version: 'vp-one',
      unit: 'second' as const,
      settlement: 'actual' as const,
      variants: { '720p': { minimum: 2, maximum: 4 } }
    }
    const data = { ...preview, summary: { ...preview.summary, videoPricing } }
    const api = stubApi({ connect: vi.fn(async () => ({ ok: true, data })) })
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '连接')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.find('.plan-prices').text()).toContain('2–4 Credits/s')
    expect(wrapper.find('.plan-prices').text()).toContain('超过余额')
    expect(wrapper.find('.modal-ok').text()).toBe('接受价格并应用')
    expect(api.apply).not.toHaveBeenCalled()
    await wrapper.find('.modal-ok').trigger('click')
    await flushPromises()
    expect(api.apply).toHaveBeenCalledTimes(1)
  })
  const routePricing = {
    'uebox-chat': {
      version: 'rp-one',
      unit: 'token' as const,
      minimum: { input: 2, cached_input: 0.5, output: 4 },
      maximum: { input: 20, cached_input: 5, output: 40 }
    }
  }
  it('shows the full range and waits for user acceptance before applying', async () => {
    const data = { ...preview, summary: { ...preview.summary, routePricing } }
    const api = stubApi({ connect: vi.fn(async () => ({ ok: true, data })) })
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '连接')!
      .trigger('click')
    await flushPromises()
    expect(wrapper.find('.plan-prices').text()).toContain('2–20 Credits/token')
    expect(wrapper.find('.plan-prices').text()).toContain('0.5–5 Credits/token')
    expect(wrapper.find('.plan-prices').text()).toContain('4–40 Credits/token')
    expect(api.apply).not.toHaveBeenCalled()
    expect(wrapper.find('.modal-ok').text()).toBe('接受价格并应用')
    await wrapper.find('.modal-ok').trigger('click')
    await flushPromises()
    expect(api.apply).toHaveBeenCalledTimes(1)
  })
  it('shows a reimport reminder for changed prices without accepting them', async () => {
    const api = stubApi({
      state: vi.fn(async () => ({
        ok: true,
        data: {
          ...connected,
          pricingNeedsAcceptance: true,
          summary: { ...connected.summary!, routePricing }
        }
      }))
    })
    const wrapper = mount(CreatorPlanCard, { global: { stubs } })
    await flushPromises()
    expect(wrapper.text()).toContain('当前价格尚未确认')
    expect(api.apply).not.toHaveBeenCalled()
  })
})

describe('CreatorPlanCard · MegaJam 活动', () => {
  const inputStub = {
    'a-input': {
      props: ['value'],
      emits: ['update:value'],
      template:
        '<input class="itch-input" :value="value" @input="$emit(\'update:value\', $event.target.value)" />'
    }
  }
  const campaignOpen = {
    open: true,
    claimed: false,
    planTitle: 'MegaJam 激励套餐',
    claimUntil: null,
    expiresAt: null
  }

  it('活动开着、没领过：显示套餐名和领取；领取成功后显示到期时间并通知父组件', async () => {
    const campaign = vi
      .fn()
      .mockResolvedValueOnce({ ok: true, data: campaignOpen })
      .mockResolvedValue({
        ok: true,
        data: { ...campaignOpen, claimed: true, expiresAt: '2026-11-19T05:00:00Z' }
      })
    const claimCampaign = vi.fn(async () => ({
      ok: true,
      data: { expiresAt: '2026-11-19T05:00:00Z' }
    }))
    stubApi({ state: vi.fn(async () => ({ ok: true, data: connected })), campaign, claimCampaign })
    const wrapper = mount(CreatorPlanCard, { global: { stubs: { ...stubs, ...inputStub } } })
    await flushPromises()

    expect(wrapper.find('.plan-campaign').text()).toContain('MegaJam 激励套餐')
    await wrapper.find('.itch-input').setValue('https://neon.itch.io')
    await wrapper
      .findAll('button')
      .find((b) => b.text() === '领取')!
      .trigger('click')
    await flushPromises()

    expect(claimCampaign).toHaveBeenCalledWith('https://neon.itch.io')
    expect(wrapper.find('.plan-campaign').text()).toContain('到期')
    expect(wrapper.find('.itch-input').exists()).toBe(false)
    expect(wrapper.emitted('changed')).toBeTruthy()
  })

  it('领取失败：按错误码显示原因，输入框保留', async () => {
    stubApi({
      state: vi.fn(async () => ({ ok: true, data: connected })),
      campaign: vi.fn(async () => ({ ok: true, data: campaignOpen })),
      claimCampaign: vi.fn(async () => ({ ok: false, code: 'sold_out', error: 'HTTP 410' }))
    })
    const wrapper = mount(CreatorPlanCard, { global: { stubs: { ...stubs, ...inputStub } } })
    await flushPromises()
    await wrapper.find('.itch-input').setValue('neon.itch.io')
    await wrapper.find('form').trigger('submit')
    await flushPromises()
    expect(wrapper.find('[role="alert"]').text()).toBe('名额已发完')
    expect(wrapper.find('.itch-input').exists()).toBe(true)
  })

  it('活动没开、没连接、服务端不支持：都不显示', async () => {
    stubApi({
      state: vi.fn(async () => ({ ok: true, data: connected })),
      campaign: vi.fn(async () => ({ ok: true, data: { ...campaignOpen, open: false } }))
    })
    const closed = mount(CreatorPlanCard, { global: { stubs: { ...stubs, ...inputStub } } })
    await flushPromises()
    expect(closed.find('.plan-campaign').exists()).toBe(false)

    const api = stubApi({ campaign: vi.fn(async () => ({ ok: true, data: campaignOpen })) })
    const offline = mount(CreatorPlanCard, { global: { stubs: { ...stubs, ...inputStub } } })
    await flushPromises()
    expect(offline.find('.plan-campaign').exists()).toBe(false)
    expect(api.campaign).not.toHaveBeenCalled()
  })
})
