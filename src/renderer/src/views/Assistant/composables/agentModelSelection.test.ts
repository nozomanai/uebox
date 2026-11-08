import { describe, expect, it } from 'vitest'
import type { ProviderView, SettingsView } from '@core/shared/aiProvider'
import { agentModelOptionKey, buildAgentModelCatalog } from './agentModelSelection'

function provider(overrides: Partial<ProviderView> = {}): ProviderView {
  return {
    id: 'openai',
    displayName: 'OpenAI',
    kind: 'chat',
    protocol: 'openai-responses',
    baseUrl: 'https://example.test/v1',
    models: [{ id: 'gpt-5.4', displayName: 'GPT 5.4' }],
    apiKey: { kind: 'none' },
    ...overrides
  }
}

function settings(overrides: Partial<SettingsView> = {}): SettingsView {
  return {
    providers: [provider()],
    roles: { agent: { providerId: 'openai', modelId: 'gpt-5.4' } },
    path: 'C:\\models.json',
    encryptionAvailable: true,
    configured: true,
    ...overrides
  }
}

describe('buildAgentModelCatalog', () => {
  it('套餐按协议分出的两个对话来源合成一组，选项各带各的来源', () => {
    const plan = { displayName: 'Box Plan', kind: 'chat' as const }
    const catalog = buildAgentModelCatalog(
      settings({
        providers: [
          provider({ ...plan, id: 'creator-plan', models: [{ id: 'uebox-chat' }] }),
          provider({
            ...plan,
            id: 'creator-plan-anthropic',
            protocol: 'anthropic-messages',
            models: [{ id: 'claude-sonnet-5-5' }]
          }),
          provider()
        ]
      })
    )
    expect(catalog.groups.map((group) => group.providerName)).toEqual(['Box Plan', 'OpenAI'])
    expect(catalog.groups[0]!.options.map((o) => o.providerId)).toEqual([
      'creator-plan',
      'creator-plan-anthropic'
    ])
  })

  it('只列对话 Provider，并按 Provider 分组保留模型身份', () => {
    const value = settings({
      providers: [
        provider({
          models: [{ id: 'gpt-5.4', displayName: 'GPT 5.4' }, { id: 'openai::gpt-next' }]
        }),
        provider({
          id: 'image',
          displayName: 'Image Provider',
          kind: 'image',
          models: [{ id: 'gpt-image-1' }]
        })
      ]
    })

    const catalog = buildAgentModelCatalog(value)

    expect(catalog.groups).toHaveLength(1)
    expect(catalog.options.map((option) => option.modelId)).toEqual(['gpt-5.4', 'openai::gpt-next'])
    expect(catalog.options[0]).toMatchObject({
      modelName: 'GPT 5.4',
      fullLabel: 'GPT 5.4 · OpenAI'
    })
  })

  it('Agent 未单独绑定时显示内核实际回落使用的 chat 模型', () => {
    const value = settings({
      roles: { chat: { providerId: 'openai', modelId: 'gpt-5.4' } }
    })

    const catalog = buildAgentModelCatalog(value)

    expect(catalog.binding).toEqual({ providerId: 'openai', modelId: 'gpt-5.4' })
    expect(catalog.selected?.modelName).toBe('GPT 5.4')
  })

  it('Agent 专用绑定优先于 chat 回落', () => {
    const value = settings({
      providers: [
        provider({
          models: [{ id: 'gpt-5.4' }, { id: 'gpt-5.4-mini' }]
        })
      ],
      roles: {
        chat: { providerId: 'openai', modelId: 'gpt-5.4-mini' },
        agent: { providerId: 'openai', modelId: 'gpt-5.4' }
      }
    })

    expect(buildAgentModelCatalog(value).selected?.modelId).toBe('gpt-5.4')
  })

  it('选项键不会被 Provider 或模型 id 自带的分隔符碰撞', () => {
    expect(agentModelOptionKey('gateway::one', 'vendor::model')).toBe(
      '["gateway::one","vendor::model"]'
    )
  })

  it('会话绑定的模型优先于全局绑定', () => {
    const value = settings({
      providers: [provider({ models: [{ id: 'gpt-5.4' }, { id: 'gpt-5.5' }] })]
    })

    const catalog = buildAgentModelCatalog(value, { providerId: 'openai', modelId: 'gpt-5.5' })

    expect(catalog.selected?.modelId).toBe('gpt-5.5')
    expect(catalog.binding).toEqual({ providerId: 'openai', modelId: 'gpt-5.5' })
  })

  it('会话绑定的模型被删了就显示全局默认 —— 主进程这一轮用的也是它', () => {
    const catalog = buildAgentModelCatalog(settings(), { providerId: 'gone', modelId: 'x' })

    expect(catalog.selected?.modelId).toBe('gpt-5.4')
    expect(catalog.binding).toEqual({ providerId: 'openai', modelId: 'gpt-5.4' })
  })

  // 套餐的模型名、标签、能接的角色都是清单给的，这里只照着画
  it('套餐来源：可选模型带服务端的标签和说明；不许接对话的模型不列', () => {
    const value = settings({
      providers: [
        provider({
          id: 'creator-plan',
          displayName: 'Box Plan',
          models: [
            { id: 'uebox-chat', displayName: 'Box-Chat', allowedRoles: ['chat', 'agent'] },
            {
              id: 'uebox-chat-beta',
              displayName: 'Box-Chat Beta',
              badge: 'Beta',
              description: '更便宜的对话线路',
              allowedRoles: ['chat', 'agent', 'vision', 'summary']
            },
            { id: 'uebox-summary-only', displayName: 'Box-Lite', allowedRoles: ['summary'] }
          ]
        })
      ],
      roles: { chat: { providerId: 'creator-plan', modelId: 'uebox-chat' } }
    })

    const catalog = buildAgentModelCatalog(value)

    expect(catalog.options.map((option) => option.modelId)).toEqual([
      'uebox-chat',
      'uebox-chat-beta'
    ])
    expect(catalog.options[0]!.badge).toBeUndefined()
    expect(catalog.options[1]).toMatchObject({
      modelName: 'Box-Chat Beta',
      badge: 'Beta',
      description: '更便宜的对话线路',
      fullLabel: 'Box-Chat Beta (Beta) · Box Plan'
    })
  })
})
