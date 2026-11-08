/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'
import type { CreatorPlanManifest, CreatorPlanRoleChange } from '../../../shared/creatorPlan'
import { normalizeSettings } from '../store'
import type { AiProviderSettings, ProviderConfig } from '../types'
import {
  PLAN_ANTHROPIC_PROVIDER_ID,
  PLAN_KEY_ID,
  PLAN_PROVIDER_ID,
  PLAN_PROVIDER_IDS,
  applyPlan,
  isFreeOnFailureModel,
  managedRoles,
  planApiBaseUrl,
  planProviders,
  planRoleChanges,
  planSummary,
  recordOriginals,
  refreshPlanModels,
  releaseDroppedRoles,
  removePlan,
  syncPlanModels
} from './apply'
import { normalizePlanState } from './planState'

// planState 读写盘要 app.getPath；这里只用它的归一化（读盘那一步），不碰磁盘
vi.mock('electron', () => ({ app: { getPath: () => '' } }))

const chatSpec = (model: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  model,
  display_name: `Creator · ${model}`,
  context_window: 131072,
  max_output_tokens: 16384,
  supports_vision: false,
  supports_video: false,
  supports_tools: true,
  supports_reasoning: true,
  reasoning_efforts: ['none', 'low', 'medium', 'high'],
  structured_output: 'json-schema',
  ...extra
})

const manifest: CreatorPlanManifest = {
  schema: 1,
  etag: 'p-1',
  plan: {
    product: 'Box Plan',
    tier: 'pro',
    tier_name: 'Pro',
    status: 'active',
    interval: 'month',
    current_period_end: '2026-10-01T00:00:00Z',
    cancel_at_period_end: false,
    quota_resets_at: '2026-10-01T00:00:00Z',
    manage_url: 'https://plan.example/account/billing'
  },
  quotas: { text_tokens: { limit: 1000, used: 10 } },
  api: { base_url: 'https://plan.example/v1' },
  roles: {
    chat: chatSpec('uebox-chat'),
    agent: chatSpec('uebox-agent', { supports_vision: true, context_window: 262144 }),
    vision: chatSpec('uebox-vision', { supports_vision: true, supports_reasoning: false }),
    summary: chatSpec('uebox-fast'),
    judge: null
  }
}

/** 清单里所有角色都有的那份（协议 01-plan 的示例） */
const fullManifest: CreatorPlanManifest = {
  ...manifest,
  roles: {
    ...manifest.roles,
    embedding: { model: 'uebox-embed-v1', dimensions: 1024, max_batch: 64, max_input_tokens: 8192 },
    image: { model: 'uebox-image', max_images: 4, sizes: ['1K', '2K'] },
    video: { model: 'uebox-video', duration: { min: 4, max: 10 } },
    model3d: { model: 'uebox-3d', options: ['negative_prompt'] },
    music: { model: 'uebox-music', seconds: { min: 10, max: 240 }, vocals: false },
    realtime: { model: 'uebox-realtime', voices: ['uebox-voice-f1', 'uebox-voice-m1'] },
    tts: {
      model: 'uebox-tts',
      voices: ['uebox-voice-f1', 'uebox-voice-f2'],
      default_voice: 'uebox-voice-f2',
      max_input_chars: 2000
    },
    stt: { model: 'uebox-stt', languages: ['zh', 'en'], streaming: true },
    search: { model: 'uebox-search', max_results: 10 },
    judge: { model: 'uebox-judge' }
  }
}

const keyRef = { kind: 'literal', id: PLAN_KEY_ID } as const

const mine = {
  id: 'my-gateway',
  displayName: 'My Gateway',
  kind: 'chat',
  protocol: 'openai-completions',
  baseUrl: 'https://gw.example/v1',
  apiKey: { kind: 'none' },
  models: [{ id: 'gpt-x' }]
} as AiProviderSettings['providers'][number]

const base: AiProviderSettings = {
  version: 3,
  providers: [mine],
  roles: { chat: { providerId: 'my-gateway', modelId: 'gpt-x' } }
}

describe('planProviders', () => {
  it('对话模型装进一个来源，能力按清单写，共用套餐的 Key', () => {
    const [provider, ...rest] = planProviders(manifest, keyRef)
    expect(rest).toEqual([])
    expect(provider).toMatchObject({
      id: PLAN_PROVIDER_ID,
      kind: 'chat',
      protocol: 'openai-completions',
      baseUrl: 'https://plan.example/v1',
      apiKey: keyRef
    })
    expect(provider!.models.map((m) => m.id)).toEqual([
      'uebox-chat',
      'uebox-agent',
      'uebox-vision',
      'uebox-fast'
    ])
    const agent = provider!.models.find((m) => m.id === 'uebox-agent')!
    expect(agent).toMatchObject({
      supportsVision: true,
      contextWindow: 262144,
      maxOutputTokens: 16384,
      structuredOutputApi: 'json-schema'
    })
    expect(agent.thinkingLevelMap).toEqual({
      minimal: null,
      low: 'low',
      medium: 'medium',
      high: 'high',
      xhigh: null,
      max: null
    })
    // 不支持推理的模型不给档位表
    expect(provider!.models.find((m) => m.id === 'uebox-vision')!.thinkingLevelMap).toBeUndefined()
  })

  it('落盘归一化后字段不丢', () => {
    const settings = normalizeSettings({
      ...base,
      providers: [...base.providers, ...planProviders(manifest, keyRef)]
    })
    const plan = settings.providers.find((p) => p.id === PLAN_PROVIDER_ID)!
    expect(plan.apiKey).toEqual(keyRef)
    expect(plan.models).toHaveLength(4)
  })
})

describe('planProviders 非对话角色', () => {
  it('旧清单（没有 models）标了 beta 的角色，标签是「Beta」', () => {
    const beta: CreatorPlanManifest = {
      ...fullManifest,
      roles: {
        ...fullManifest.roles,
        music: { ...fullManifest.roles.music!, display_name: 'Creator · Music', beta: true }
      }
    }
    const music = planProviders(beta, keyRef).find((p) => p.id === 'creator-plan-music')!
    expect(music.models[0]).toMatchObject({ displayName: 'Creator · Music', badge: 'Beta' })
    const change = planRoleChanges({ version: 3, providers: [], roles: {} }, beta).find(
      (c) => c.role === 'music'
    )!
    expect(change.modelDisplayName).toBe('Creator · Music (Beta)')
    const video = planProviders(beta, keyRef).find((p) => p.id === 'creator-plan-video')!
    expect(video.models[0]!.displayName).not.toContain('Beta')
  })

  it('一类一个来源，id 固定、共用一把 Key，各类的调用形状写在模型或来源上', () => {
    const providers = planProviders(fullManifest, keyRef)
    expect(providers.map((p) => [p.kind, p.id])).toEqual([
      ['chat', 'creator-plan'],
      ['embedding', 'creator-plan-embedding'],
      ['image', 'creator-plan-image'],
      ['video', 'creator-plan-video'],
      ['model3d', 'creator-plan-model3d'],
      ['realtime', 'creator-plan-realtime'],
      ['tts', 'creator-plan-tts'],
      ['stt', 'creator-plan-stt'],
      ['music', 'creator-plan-music'],
      ['search', 'creator-plan-search'],
      ['judge', 'creator-plan-judge']
    ])
    for (const provider of providers) {
      expect(provider.apiKey).toEqual(keyRef)
      expect(provider.baseUrl).toBe('https://plan.example/v1')
    }
    const byKind = Object.fromEntries(providers.map((p) => [p.kind, p]))
    expect(byKind.embedding.models).toEqual([
      {
        id: 'uebox-embed-v1',
        displayName: 'uebox-embed-v1',
        embeddingApi: 'jina-embeddings',
        embeddingDimensions: 1024
      }
    ])
    expect(byKind.image.models[0].imageApi).toBe('uebox-images')
    expect(byKind.video.videoApi).toBe('uebox-tasks')
    expect(byKind.model3d.model3dApi).toBe('uebox-tasks')
    expect(byKind.music.musicApi).toBe('uebox-tasks')
    expect(byKind.realtime.models[0].realtimeVoice).toBe('uebox-voice-f1')
    expect(byKind.tts.models[0].ttsVoice).toBe('uebox-voice-f2')
    expect(byKind.tts.models[0].ttsMaxInputChars).toBe(2000)
    expect(byKind.judge.models).toEqual([{ id: 'uebox-judge', displayName: 'uebox-judge' }])
  })

  it('来源 id 不许改：嵌入的向量标识和任务令牌都靠它', () => {
    expect(PLAN_PROVIDER_IDS.embedding).toBe('creator-plan-embedding')
    expect(PLAN_PROVIDER_IDS.video).toBe('creator-plan-video')
    expect(PLAN_PROVIDER_IDS.model3d).toBe('creator-plan-model3d')
  })

  it('落盘归一化后各类字段不丢，清单刷新不会误判成有变化', () => {
    const settings = normalizeSettings({
      ...base,
      providers: [...base.providers, ...planProviders(fullManifest, keyRef)]
    })
    const find = (id: string): ProviderConfig => settings.providers.find((p) => p.id === id)!
    expect(find('creator-plan-embedding').models[0]).toMatchObject({
      embeddingApi: 'jina-embeddings',
      embeddingDimensions: 1024
    })
    expect(find('creator-plan-image').models[0].imageApi).toBe('uebox-images')
    expect(find('creator-plan-video').videoApi).toBe('uebox-tasks')
    expect(find('creator-plan-model3d').model3dApi).toBe('uebox-tasks')
    expect(find('creator-plan-music').musicApi).toBe('uebox-tasks')
    expect(find('creator-plan-tts').models[0]).toMatchObject({
      ttsVoice: 'uebox-voice-f2',
      ttsMaxInputChars: 2000
    })
    expect(find('creator-plan-realtime').models[0].realtimeVoice).toBe('uebox-voice-f1')
    // 同一份清单再刷新一次：什么都没变，原样返回（不白写盘）
    expect(refreshPlanModels(settings, fullManifest)).toBe(settings)
  })

  it('清单刷新只改能力：嵌入维度变了跟着改，不增删模型', () => {
    const settings = normalizeSettings({
      ...base,
      providers: [...base.providers, ...planProviders(fullManifest, keyRef)]
    })
    const next = refreshPlanModels(settings, {
      ...fullManifest,
      roles: {
        ...fullManifest.roles,
        embedding: { model: 'uebox-embed-v1', dimensions: 2048 },
        image: null
      }
    })
    const find = (id: string): ProviderConfig => next.providers.find((p) => p.id === id)!
    expect(find('creator-plan-embedding').models[0].embeddingDimensions).toBe(2048)
    // 清单里 image 为 null（订阅失效也是这样）：来源和模型都留着
    expect(find('creator-plan-image').models.map((m) => m.id)).toEqual(['uebox-image'])
  })
})

describe('applyPlan 非对话角色', () => {
  it('绑到各自类别的来源；断开时一起删掉、还原原绑定', () => {
    const settings: AiProviderSettings = {
      ...base,
      providers: [
        ...base.providers,
        {
          id: 'my-embed',
          displayName: 'My Embed',
          kind: 'embedding',
          protocol: 'openai-completions',
          baseUrl: 'https://embed.example/v1',
          apiKey: { kind: 'none' },
          models: [{ id: 'bge-m3' }]
        }
      ],
      roles: { ...base.roles, embedding: { providerId: 'my-embed', modelId: 'bge-m3' } }
    }
    const selected = ['embedding', 'image', 'video', 'tts', 'judge'] as const
    const originals = recordOriginals({}, settings, fullManifest, [...selected])
    expect(originals).toEqual({
      embedding: { providerId: 'my-embed', modelId: 'bge-m3' },
      image: null,
      video: null,
      tts: null,
      judge: null
    })
    const applied = applyPlan(settings, fullManifest, keyRef, [...selected])
    expect(applied.roles.embedding).toEqual({
      providerId: 'creator-plan-embedding',
      modelId: 'uebox-embed-v1',
      source: 'plan'
    })
    expect(applied.roles.video).toEqual({
      providerId: 'creator-plan-video',
      modelId: 'uebox-video',
      source: 'plan'
    })
    expect(applied.roles.judge?.providerId).toBe('creator-plan-judge')
    // 没勾的不动
    expect(applied.roles.search).toBeUndefined()
    // 落盘归一化后绑定都还在（来源的 kind 对得上）
    expect(normalizeSettings(applied).roles).toEqual(applied.roles)

    const removed = removePlan(applied, originals)
    expect(removed.providers.map((p) => p.id)).toEqual(['my-gateway', 'my-embed'])
    expect(removed.roles).toEqual({
      chat: { providerId: 'my-gateway', modelId: 'gpt-x' },
      embedding: { providerId: 'my-embed', modelId: 'bge-m3' }
    })
  })

  it('导入预览列出清单里有的全部角色，为 null 的不出现', () => {
    const changes = planRoleChanges(base, fullManifest)
    expect(changes.map((c) => c.role)).toEqual([
      'chat',
      'vision',
      'summary',
      'embedding',
      'image',
      'video',
      'model3d',
      'realtime',
      'tts',
      'stt',
      'music',
      'search',
      'judge'
    ])
    expect(planRoleChanges(base, manifest).map((c) => c.role)).not.toContain('judge')
  })
})

describe('planRoleChanges', () => {
  it('没绑的默认勾；用户自己配的默认不勾，并写明现在是什么', () => {
    const changes = planRoleChanges(base, manifest)
    // Agent 已并进主模型（chat 那一格），不单列一行
    expect(changes.map((c) => c.role)).toEqual(['chat', 'vision', 'summary'])
    const chat = changes.find((c) => c.role === 'chat')!
    expect(chat).toMatchObject({
      model: 'uebox-agent',
      defaultSelected: false,
      managed: false,
      current: { providerId: 'my-gateway', modelId: 'gpt-x', providerName: 'My Gateway' }
    })
    expect(changes.find((c) => c.role === 'vision')).toMatchObject({
      defaultSelected: true,
      current: null
    })
  })

  it('套餐管着的角色默认勾，标成「套餐管理中」', () => {
    const applied = normalizeSettings(applyPlan(base, manifest, keyRef, ['chat']))
    const chat = planRoleChanges(applied, manifest).find((c) => c.role === 'chat')!
    expect(chat).toMatchObject({ managed: true, defaultSelected: true })
  })
})

describe('applyPlan', () => {
  it('只换选中的角色，带上 source；用户自己的来源和绑定不动', () => {
    const next = applyPlan(base, manifest, keyRef, ['vision', 'summary'])
    expect(next.roles).toEqual({
      chat: { providerId: 'my-gateway', modelId: 'gpt-x' },
      vision: { providerId: PLAN_PROVIDER_ID, modelId: 'uebox-vision', source: 'plan' },
      summary: { providerId: PLAN_PROVIDER_ID, modelId: 'uebox-fast', source: 'plan' }
    })
    expect(next.providers.map((p) => p.id)).toEqual(['my-gateway', PLAN_PROVIDER_ID])
    expect(managedRoles(next)).toEqual(['vision', 'summary'])
  })

  it('勾选了用户配过的主模型：换成套餐，用清单里 agent 那份（和 mergeMainModel 一致）', () => {
    const next = applyPlan(base, manifest, keyRef, ['chat'])
    expect(next.roles.chat).toEqual({
      providerId: PLAN_PROVIDER_ID,
      modelId: 'uebox-agent',
      source: 'plan'
    })
    expect(next.roles.agent).toBeUndefined()
  })

  it('重新导入时取消勾选：套餐不再管它，解绑', () => {
    const first = applyPlan(base, manifest, keyRef, ['vision', 'summary'])
    const second = applyPlan(first, manifest, keyRef, ['vision'])
    expect(second.roles.summary).toBeUndefined()
    expect(second.roles.vision?.source).toBe('plan')
  })

  it('清单里某个角色没了：套餐管着的那条解绑，用户手动改过的不动', () => {
    const first = applyPlan(base, manifest, keyRef, ['summary', 'vision'])
    // 用户后来手动把 vision 改到自己的来源（渲染层改绑定不带 source）
    first.roles.vision = { providerId: 'my-gateway', modelId: 'gpt-x' }
    const shrunk = { ...manifest, roles: { ...manifest.roles, summary: null, vision: null } }
    const second = applyPlan(first, shrunk, keyRef, ['summary', 'vision'])
    expect(second.roles.summary).toBeUndefined()
    expect(second.roles.vision).toEqual({ providerId: 'my-gateway', modelId: 'gpt-x' })
  })

  it('取消勾选、或清单里没了的角色有原绑定：还原成原绑定，不是清空', () => {
    const originals = { chat: { providerId: 'my-gateway', modelId: 'gpt-x' } }
    const first = applyPlan(base, manifest, keyRef, ['chat'], originals)
    const unticked = applyPlan(first, manifest, keyRef, [], originals)
    expect(unticked.roles.chat).toEqual({ providerId: 'my-gateway', modelId: 'gpt-x' })
    const shrunk = { ...manifest, roles: { ...manifest.roles, chat: null, agent: null } }
    const dropped = applyPlan(first, shrunk, keyRef, ['chat'], originals)
    expect(dropped.roles.chat).toEqual({ providerId: 'my-gateway', modelId: 'gpt-x' })
  })

  it('重复导入不会叠出两个套餐来源', () => {
    const twice = applyPlan(applyPlan(base, manifest, keyRef, ['chat']), manifest, keyRef, ['chat'])
    expect(twice.providers.filter((p) => p.id === PLAN_PROVIDER_ID)).toHaveLength(1)
  })
})

describe('removePlan', () => {
  it('删掉套餐来源和它管着的角色，用户自己的留着', () => {
    const applied = applyPlan(base, manifest, keyRef, ['summary', 'vision'])
    const removed = removePlan(applied)
    expect(removed.providers.map((p) => p.id)).toEqual(['my-gateway'])
    expect(removed.roles).toEqual({ chat: { providerId: 'my-gateway', modelId: 'gpt-x' } })
  })
})

describe('recordOriginals', () => {
  it('只记这次勾上、清单里有的角色；已经记过的不覆盖', () => {
    // 清单里没有 image（这份 manifest 只有对话四个）：不记
    const first = recordOriginals({}, base, manifest, ['chat', 'image'])
    expect(first).toEqual({ chat: { providerId: 'my-gateway', modelId: 'gpt-x' } })
    const applied = applyPlan(base, manifest, keyRef, ['chat'])
    // 重新导入时 chat 的「现在」已经是套餐，最初那条才是用户自己的
    expect(recordOriginals(first, applied, manifest, ['chat', 'vision'])).toEqual({
      chat: { providerId: 'my-gateway', modelId: 'gpt-x' },
      vision: null
    })
  })

  it('用户后来自己改过（已脱离套餐）再重新导入：按现在的记，不留最早那条', () => {
    const first = recordOriginals({}, base, manifest, ['chat'])
    const applied = applyPlan(base, manifest, keyRef, ['chat'], first)
    const other = { ...mine, id: 'openai', models: [{ id: 'gpt-y' }] }
    const moved: AiProviderSettings = {
      ...applied,
      providers: [...applied.providers, other],
      roles: { ...applied.roles, chat: { providerId: 'openai', modelId: 'gpt-y' } }
    }
    expect(recordOriginals(first, moved, manifest, ['chat'])).toEqual({
      chat: { providerId: 'openai', modelId: 'gpt-y' }
    })
  })

  it('原来就由套餐管着、又没有记录的：按「原来没设置」记', () => {
    const managed = applyPlan(base, manifest, keyRef, ['vision'])
    expect(recordOriginals({}, managed, manifest, ['vision'])).toEqual({ vision: null })
  })
})

describe('removePlan 还原', () => {
  it('还原成原绑定；原绑定的模型已经不在了 → 未设置', () => {
    const applied = applyPlan(base, manifest, keyRef, ['chat', 'vision'])
    const removed = removePlan(applied, {
      chat: { providerId: 'my-gateway', modelId: 'gpt-x' },
      vision: { providerId: 'my-gateway', modelId: 'gone' }
    })
    expect(removed.roles).toEqual({ chat: { providerId: 'my-gateway', modelId: 'gpt-x' } })
  })
})

/**
 * 主模型：「对话」和「Agent」落盘时合成 chat 一格（store.ts 的 mergeMainModel）。
 * 这里每一步都过真实的落盘归一化，和 ipc 里「读配置 → 记原绑定 → 应用 → 写盘 → 断开」同一条路
 */
describe('主模型（对话 + Agent 合并）', () => {
  const user = normalizeSettings(base)
  /** 照 ipc：先记原绑定，再应用、落盘 */
  const importWith = (
    settings: AiProviderSettings,
    selected: CreatorPlanRoleChange['role'][]
  ): { written: AiProviderSettings; originals: ReturnType<typeof recordOriginals> } => {
    const originals = recordOriginals({}, settings, manifest, selected)
    const written = normalizeSettings(applyPlan(settings, manifest, keyRef, selected, originals))
    return { written, originals }
  }

  it('用户有自己的主模型：预览里主模型默认不勾，也没有单独一行 Agent', () => {
    const changes = planRoleChanges(user, manifest)
    expect(changes.some((c) => c.role === 'agent')).toBe(false)
    expect(changes.find((c) => c.role === 'chat')).toMatchObject({
      defaultSelected: false,
      current: { providerId: 'my-gateway', modelId: 'gpt-x' }
    })
  })

  it('按默认勾选导入：用户自己的主模型留着，断开后也还是它', () => {
    const selected = planRoleChanges(user, manifest)
      .filter((c) => c.defaultSelected)
      .map((c) => c.role)
    const { written, originals } = importWith(user, selected)
    expect(written.roles.chat).toEqual({ providerId: 'my-gateway', modelId: 'gpt-x' })
    expect(written.roles.vision).toMatchObject({ providerId: PLAN_PROVIDER_ID, source: 'plan' })
    expect(normalizeSettings(removePlan(written, originals)).roles).toEqual({
      chat: { providerId: 'my-gateway', modelId: 'gpt-x' }
    })
  })

  it('用户自己勾上主模型：换成套餐；断开后还原成用户原来的', () => {
    const { written, originals } = importWith(user, ['chat'])
    expect(originals).toEqual({ chat: { providerId: 'my-gateway', modelId: 'gpt-x' } })
    expect(written.roles).toEqual({
      chat: { providerId: PLAN_PROVIDER_ID, modelId: 'uebox-agent', source: 'plan' }
    })
    // 重新导入：主模型那一格的「现在」是套餐，最初那条不被覆盖，预览里标成套餐管着
    expect(planRoleChanges(written, manifest).find((c) => c.role === 'chat')).toMatchObject({
      managed: true,
      defaultSelected: true
    })
    expect(recordOriginals(originals, written, manifest, ['chat'])).toEqual(originals)
    expect(normalizeSettings(removePlan(written, originals)).roles).toEqual({
      chat: { providerId: 'my-gateway', modelId: 'gpt-x' }
    })
  })

  it('没有主模型：默认勾上，断开后回到未设置', () => {
    const empty = normalizeSettings({ ...base, roles: {} })
    expect(planRoleChanges(empty, manifest).find((c) => c.role === 'chat')).toMatchObject({
      defaultSelected: true,
      current: null
    })
    const { written, originals } = importWith(empty, ['chat'])
    expect(written.roles.chat?.source).toBe('plan')
    expect(normalizeSettings(removePlan(written, originals)).roles).toEqual({})
  })

  /** 老记录照 ipc 的路子先过一遍读盘归一化（planState.ts），合并只在那一处做 */
  const legacyOriginals = (
    originals: Record<string, unknown>
  ): ReturnType<typeof recordOriginals> => normalizePlanState({ originals }).originals

  it('合并之前导入的老记录（原绑定记在 agent 上）：断开时还原到主模型', () => {
    const { written } = importWith(user, ['chat'])
    const legacy = legacyOriginals({ agent: { providerId: 'my-gateway', modelId: 'gpt-x' } })
    expect(removePlan(written, legacy).roles).toEqual({
      chat: { providerId: 'my-gateway', modelId: 'gpt-x' }
    })
    expect(recordOriginals(legacy, written, manifest, ['chat'])).toEqual({
      chat: { providerId: 'my-gateway', modelId: 'gpt-x' }
    })
  })

  it('老记录两条都有：听 agent 的（和 mergeMainModel 一致），重新导入也不丢', () => {
    const { written } = importWith(user, ['chat'])
    const gpt = { providerId: 'my-gateway', modelId: 'gpt-x' }
    // 1.0.8：对话原来没设置、Agent 原来是 gpt-x
    const unsetChat = legacyOriginals({ chat: null, agent: gpt })
    expect(removePlan(written, unsetChat).roles).toEqual({ chat: gpt })
    expect(recordOriginals(unsetChat, written, manifest, ['chat'])).toEqual({ chat: gpt })
    // 两条都有值：断开后主模型是 Agent 原来那个（1.0.8 断开后合并读出来的也是它）
    const both = legacyOriginals({
      chat: { providerId: 'my-gateway', modelId: 'gpt-old' },
      agent: gpt
    })
    const providers = written.providers.map((p) =>
      p.id === mine.id ? { ...p, models: [...p.models, { id: 'gpt-old' }] } : p
    )
    expect(removePlan({ ...written, providers }, both).roles).toEqual({ chat: gpt })
  })

  /**
   * 1.0.8 按默认勾选导入：对话是用户自己的，Agent「未设置」被套餐接管，原绑定只记了 agent: null。
   * 升级后用户自己的主模型留着，套餐不再管主模型；断开、刷新都不动它
   */
  it('1.0.8 默认勾选导入的老用户：主模型留用户自己的，断开、刷新后也是它', () => {
    const gpt = { providerId: 'my-gateway', modelId: 'gpt-x' }
    const old = normalizeSettings({
      ...base,
      providers: [mine, ...planProviders(manifest, keyRef)],
      roles: {
        chat: gpt,
        agent: { providerId: PLAN_PROVIDER_ID, modelId: 'uebox-agent', source: 'plan' }
      }
    })
    const originals = legacyOriginals({ agent: null })
    expect(old.roles.chat).toEqual(gpt)
    expect(managedRoles(old)).toEqual([])
    expect(planRoleChanges(old, manifest).find((c) => c.role === 'chat')).toMatchObject({
      managed: false,
      defaultSelected: false
    })
    expect(removePlan(old, originals).roles).toEqual({ chat: gpt })
    const noMain = { ...manifest, roles: { ...manifest.roles, chat: null, agent: null } }
    expect(releaseDroppedRoles(old, noMain, originals).roles.chat).toEqual(gpt)
    // 之后自己勾上主模型重新导入：记下的是用户自己的那个，断开照着还原
    const reOriginals = recordOriginals(originals, old, manifest, ['chat'])
    expect(reOriginals.chat).toEqual(gpt)
    const reWritten = normalizeSettings(applyPlan(old, manifest, keyRef, ['chat'], reOriginals))
    expect(reWritten.roles.chat?.source).toBe('plan')
    expect(removePlan(reWritten, reOriginals).roles).toEqual({ chat: gpt })
  })
})

describe('releaseDroppedRoles', () => {
  const mySearch = {
    id: 'my-search',
    displayName: 'My Search',
    kind: 'search',
    protocol: 'openai-completions',
    baseUrl: 'https://search.example',
    apiKey: { kind: 'none' },
    models: [{ id: 'tavily' }]
  } as AiProviderSettings['providers'][number]
  const before: AiProviderSettings = {
    ...base,
    providers: [mine, mySearch],
    roles: { ...base.roles, search: { providerId: 'my-search', modelId: 'tavily' } }
  }
  const selected = ['chat', 'search', 'stt'] as const
  const originals = recordOriginals({}, before, fullManifest, selected)
  const applied = applyPlan(before, fullManifest, keyRef, selected)
  const dropped: CreatorPlanManifest = {
    ...fullManifest,
    roles: { ...fullManifest.roles, search: null, stt: null }
  }

  it('套餐不再给的角色还原成导入前的绑定，没有原绑定的置空；那一类的套餐来源删掉', () => {
    const released = releaseDroppedRoles(applied, dropped, originals)
    expect(released.roles.search).toEqual({ providerId: 'my-search', modelId: 'tavily' })
    expect(released.roles.stt).toBeUndefined()
    expect(released.roles.chat).toMatchObject({ providerId: PLAN_PROVIDER_ID, source: 'plan' })
    const ids = released.providers.map((p) => p.id)
    expect(ids).not.toContain(PLAN_PROVIDER_IDS.search)
    expect(ids).not.toContain(PLAN_PROVIDER_IDS.stt)
    expect(ids).toContain(PLAN_PROVIDER_ID)
    expect(ids).toContain('my-search')
  })

  it('原来源已经删了：置空', () => {
    const gone = { ...applied, providers: applied.providers.filter((p) => p.id !== 'my-search') }
    expect(releaseDroppedRoles(gone, dropped, originals).roles.search).toBeUndefined()
  })

  it('订阅失效（roles 全 null）、或字段缺失而不是 null：什么都不动', () => {
    const allNull = Object.fromEntries(Object.keys(fullManifest.roles).map((role) => [role, null]))
    for (const status of ['active', 'canceled'] as const) {
      const off = { ...dropped, plan: { ...dropped.plan, status }, roles: allNull }
      expect(releaseDroppedRoles(applied, off, originals)).toBe(applied)
    }
    const canceled = { ...dropped, plan: { ...dropped.plan, status: 'canceled' as const } }
    expect(releaseDroppedRoles(applied, canceled, originals)).toBe(applied)
    const rest = { ...fullManifest.roles }
    delete rest.search
    delete rest.stt
    expect(releaseDroppedRoles(applied, { ...fullManifest, roles: rest }, originals)).toBe(applied)
    expect(releaseDroppedRoles(applied, fullManifest, originals)).toBe(applied)
  })
})

describe('planSummary 额度', () => {
  it('统一 Credits 排在最前', () => {
    const summary = planSummary({
      ...manifest,
      quotas: {
        text_tokens: { limit: 1000, used: 10 },
        credits: { limit: 3_000_000_000, used: 418_805_100 }
      }
    })
    expect(summary.quotas.map((q) => q.key)).toEqual(['credits', 'text_tokens'])
  })

  it('逐项列出，按额度表排序，不认识的键排后面；形状不对的丢掉', () => {
    const summary = planSummary({
      ...manifest,
      quotas: {
        future_units: { limit: 5, used: 1 },
        images: { limit: 100, used: 3 },
        text_tokens: { limit: 1000, used: 10 },
        broken: { limit: 'x' } as unknown as { limit: number; used: number }
      }
    })
    expect(summary.quotas.map((q) => q.key)).toEqual(['text_tokens', 'images', 'future_units'])
    expect(summary.quotas[1]).toEqual({ key: 'images', limit: 100, used: 3 })
    expect(summary.cooldownEndsAt).toBeNull()
  })

  it('带上小数、每日上限、压低的原因和冷却结束时间', () => {
    const summary = planSummary({
      ...manifest,
      plan: { ...manifest.plan, cooldown_ends_at: '2026-09-26T08:00:00Z' },
      quotas: {
        text_tokens: {
          limit: 20_000_000,
          used: 1_204_400,
          monthly_limit: 40_000_000,
          limited_by: 'new_account',
          daily: { limit: 8_000_000, used: 1_204_400, resets_at: '2026-09-24T00:00:00Z' }
        },
        video_seconds: { limit: 45, used: 25.5, daily: { limit: 25, used: 2.5 } },
        // 原因代码不认识：数字照给，不写原因
        images: { limit: 10, used: 0, monthly_limit: 90, limited_by: 'something_new' },
        // monthly_limit 不比 limit 大：没被压低
        music_tasks: { limit: 8, used: 1, monthly_limit: 8, limited_by: 'plan_change' }
      }
    })
    expect(summary.cooldownEndsAt).toBe('2026-09-26T08:00:00Z')
    expect(summary.quotas).toEqual([
      {
        key: 'text_tokens',
        limit: 20_000_000,
        used: 1_204_400,
        monthlyLimit: 40_000_000,
        limitedBy: 'new_account',
        daily: { limit: 8_000_000, used: 1_204_400, resetsAt: '2026-09-24T00:00:00Z' }
      },
      { key: 'images', limit: 10, used: 0, monthlyLimit: 90 },
      {
        key: 'video_seconds',
        limit: 45,
        used: 25.5,
        daily: { limit: 25, used: 2.5, resetsAt: null }
      },
      { key: 'music_tasks', limit: 8, used: 1 }
    ])
  })
})

describe('source 字段落盘', () => {
  it('归一化保留 source: plan，丢弃别的值', () => {
    const settings = normalizeSettings({
      version: 3,
      providers: [mine],
      roles: {
        chat: { providerId: 'my-gateway', modelId: 'gpt-x', source: 'plan' },
        summary: { providerId: 'my-gateway', modelId: 'gpt-x', source: 'whatever' }
      }
    })
    expect(settings.roles.chat).toEqual({
      providerId: 'my-gateway',
      modelId: 'gpt-x',
      source: 'plan'
    })
    expect(settings.roles.summary).toEqual({ providerId: 'my-gateway', modelId: 'gpt-x' })
  })
})

describe('accepted route prices', () => {
  it('video prices need explicit acceptance; refresh keeps the accepted version', async () => {
    const { PLAN_PRICING_HEADER } = await import('../../../shared/creatorPlanPricing')
    const { planPricingNeedsAcceptance } = await import('./apply')
    const video = {
      version: 'vp-one',
      unit: 'second' as const,
      settlement: 'actual' as const,
      variants: { '720p': { minimum: 2, maximum: 4 } }
    }
    const manifest = { ...fullManifest, video_pricing: video }
    const legacy = applyPlan(base, fullManifest, keyRef, ['video'])
    expect(planPricingNeedsAcceptance(legacy, manifest)).toBe(true)
    const accepted = normalizeSettings(applyPlan(legacy, manifest, keyRef, ['video']))
    expect(
      accepted.providers.find((p) => p.id === PLAN_PROVIDER_IDS.video)?.headers?.[
        PLAN_PRICING_HEADER
      ]
    ).toBe('vp-one')
    expect(planPricingNeedsAcceptance(accepted, manifest)).toBe(false)
    const changed = { ...manifest, video_pricing: { ...video, version: 'vp-two' } }
    const refreshed = refreshPlanModels(accepted, changed)
    expect(
      refreshed.providers.find((p) => p.id === PLAN_PROVIDER_IDS.video)?.headers?.[
        PLAN_PRICING_HEADER
      ]
    ).toBe('vp-one')
    expect(planPricingNeedsAcceptance(refreshed, changed)).toBe(true)
    expect(planSummary(changed).videoPricing).toEqual(changed.video_pricing)
    expect(
      planPricingNeedsAcceptance(applyPlan(refreshed, changed, keyRef, ['video']), changed)
    ).toBe(false)
  })
  const price = {
    version: 'rp-one',
    unit: 'token' as const,
    minimum: { input: 2, cached_input: 0.5, output: 4 },
    maximum: { input: 20, cached_input: 5, output: 40 }
  }
  const priced: CreatorPlanManifest = { ...manifest, route_pricing: { 'uebox-chat': price } }
  it('acceptance survives settings normalization and automatic price refresh', async () => {
    const { PLAN_PRICING_HEADER } = await import('../../../shared/creatorPlanPricing')
    const { planPricingNeedsAcceptance } = await import('./apply')
    const accepted = normalizeSettings(applyPlan(base, priced, keyRef, ['chat']))
    const provider = accepted.providers.find((p) => p.id === PLAN_PROVIDER_ID)!
    expect(provider.headers?.[PLAN_PRICING_HEADER]).toBe('rp-one')
    expect(planPricingNeedsAcceptance(accepted, priced)).toBe(false)
    const changed = { ...priced, route_pricing: { 'uebox-chat': { ...price, version: 'rp-two' } } }
    const refreshed = refreshPlanModels(accepted, changed)
    expect(
      refreshed.providers.find((p) => p.id === PLAN_PROVIDER_ID)?.headers?.[PLAN_PRICING_HEADER]
    ).toBe('rp-one')
    expect(planPricingNeedsAcceptance(refreshed, changed)).toBe(true)
    const confirmed = applyPlan(refreshed, changed, keyRef, ['chat'])
    expect(planPricingNeedsAcceptance(confirmed, changed)).toBe(false)
    expect(planSummary(changed).routePricing).toEqual(changed.route_pricing)
  })
  it('new pricing requires acceptance for a legacy connected provider', async () => {
    const { planPricingNeedsAcceptance } = await import('./apply')
    const legacy = applyPlan(base, manifest, keyRef, ['chat'])
    expect(planPricingNeedsAcceptance(legacy, priced)).toBe(true)
    expect(planPricingNeedsAcceptance(legacy, manifest)).toBe(false)
  })
  it('the accepted version reaches the actual chat model configuration', async () => {
    const { toPiModel } = await import('../../agent-v3/core/piModel')
    const provider = planProviders(priced, keyRef)[0]!
    const model = toPiModel(provider, provider.models.find((m) => m.id === 'uebox-chat')!)
    expect(model.headers).toMatchObject({ 'X-UEBox-Pricing-Version': 'rp-one' })
  })
})

/**
 * 清单 `models`（2026-10-15）：模型列表、名字、标签、能接的角色都由服务端定。
 * 形状照服务端 capabilities.test.ts：默认模型合成一项，可选模型 default_for 为空
 */
describe('清单 models：模型列表由服务端定', () => {
  const CHAT_ROLES = ['chat', 'agent', 'vision', 'summary']
  const chat = chatSpec('uebox-chat', {
    display_name: 'Box-Chat',
    supports_vision: true,
    supports_video: true,
    context_window: 262144,
    max_output_tokens: 65536
  })
  const chatBeta = {
    ...chatSpec('uebox-chat-beta', {
      display_name: 'Box-Chat Beta',
      supports_vision: true,
      supports_video: false,
      context_window: 200000,
      max_output_tokens: 32000
    }),
    roles: CHAT_ROLES,
    default_for: [],
    badge: 'Beta',
    description: '更便宜的对话线路，测试阶段，偶尔会失败；失败不扣 Credits',
    free_on_failure: true
  }
  const image = { model: 'uebox-image', display_name: 'Box-Image', sizes: ['1K', '2K'] }
  const music = { model: 'uebox-music', display_name: 'Box-Music', seconds: { min: 10, max: 240 } }
  /** 客户端从没见过的未来可选模型，换个角色类别：不改代码也该出现 */
  const imagePro = {
    model: 'uebox-image-pro',
    display_name: 'Box-Image Pro',
    sizes: ['2K', '4K'],
    roles: ['image'],
    default_for: [],
    badge: 'New'
  }
  const modelsManifest: CreatorPlanManifest = {
    ...manifest,
    roles: { chat, agent: chat, vision: chat, summary: chat, image, music, judge: null },
    models: [
      { ...chat, roles: CHAT_ROLES, default_for: CHAT_ROLES },
      { ...image, roles: ['image'], default_for: ['image'] },
      { ...music, roles: ['music'], default_for: ['music'], badge: 'Beta' },
      chatBeta,
      imagePro
    ]
  }
  const withoutBeta: CreatorPlanManifest = {
    ...modelsManifest,
    models: modelsManifest.models!.filter((m) => m !== chatBeta)
  }
  const imported = (): AiProviderSettings =>
    normalizeSettings(
      applyPlan(base, modelsManifest, keyRef, ['chat', 'summary', 'vision', 'image', 'music'])
    )
  const choose = (
    settings: AiProviderSettings,
    roles: AiProviderSettings['roles']
  ): AiProviderSettings => ({ ...settings, roles: { ...settings.roles, ...roles } })
  const betaBinding = { providerId: PLAN_PROVIDER_ID, modelId: 'uebox-chat-beta' }
  const defaultBinding = { providerId: PLAN_PROVIDER_ID, modelId: 'uebox-chat', source: 'plan' }
  const plan = (settings: AiProviderSettings, id = PLAN_PROVIDER_ID): ProviderConfig =>
    settings.providers.find((p) => p.id === id)!

  it('可选模型出现在它主角色那一类的来源里，名字、标签、说明、能力都照它自己那一项', () => {
    const providers = planProviders(modelsManifest, keyRef)
    const chatProvider = providers.find((p) => p.id === PLAN_PROVIDER_ID)!
    expect(chatProvider.models.map((m) => m.id)).toEqual(['uebox-chat', 'uebox-chat-beta'])
    expect(chatProvider.models[0]).toMatchObject({
      displayName: 'Box-Chat',
      supportsVideo: true,
      contextWindow: 262144,
      allowedRoles: CHAT_ROLES
    })
    expect(chatProvider.models[0]!.badge).toBeUndefined()
    expect(chatProvider.models[1]).toMatchObject({
      displayName: 'Box-Chat Beta',
      badge: 'Beta',
      description: chatBeta.description,
      supportsVision: true,
      supportsVideo: false,
      contextWindow: 200000,
      maxOutputTokens: 32000,
      allowedRoles: CHAT_ROLES,
      freeOnFailure: true
    })

    const imageProvider = providers.find((p) => p.id === 'creator-plan-image')!
    expect(imageProvider.models.map((m) => m.id)).toEqual(['uebox-image', 'uebox-image-pro'])
    expect(imageProvider.models[1]).toMatchObject({
      displayName: 'Box-Image Pro',
      badge: 'New',
      imageApi: 'uebox-images',
      allowedRoles: ['image']
    })
    // 音乐的「Beta」来自服务端的 badge，名字里不再拼
    expect(providers.find((p) => p.id === 'creator-plan-music')!.models[0]).toMatchObject({
      displayName: 'Box-Music',
      badge: 'Beta'
    })
    const musicChange = planRoleChanges({ version: 3, providers: [], roles: {} }, modelsManifest)
    expect(musicChange.find((c) => c.role === 'music')!.modelDisplayName).toBe('Box-Music (Beta)')
  })

  it('默认绑定照旧按 roles：可选模型不会被自动绑上', () => {
    const settings = imported()
    expect(settings.roles.chat).toEqual(defaultBinding)
    expect(settings.roles.image?.modelId).toBe('uebox-image')
  })

  it('落盘归一化后新字段不丢；同一份清单再刷新、再对齐都原样返回（不白写盘）', () => {
    const settings = imported()
    expect(plan(settings).models[1]).toMatchObject({
      badge: 'Beta',
      allowedRoles: CHAT_ROLES,
      freeOnFailure: true
    })
    expect(refreshPlanModels(settings, modelsManifest)).toBe(settings)
    expect(syncPlanModels(settings, modelsManifest)).toBe(settings)
  })

  it('旧服务端导入的老用户：清单带上 models 后，可选模型不用重新导入就出现；没导入的类不新建来源', () => {
    const old = normalizeSettings(applyPlan(base, manifest, keyRef, ['chat']))
    const next = syncPlanModels(refreshPlanModels(old, modelsManifest), modelsManifest)
    expect(plan(next).models.map((m) => m.id)).toContain('uebox-chat-beta')
    expect(next.providers.some((p) => p.id === 'creator-plan-image')).toBe(false)
  })

  it('用户手动绑的可选模型下线了：那个角色退回默认模型，模型从列表里拿掉', () => {
    const chosen = choose(imported(), { chat: betaBinding })
    // 还在：什么都不动，不替用户换
    expect(syncPlanModels(chosen, modelsManifest)).toBe(chosen)

    const next = syncPlanModels(chosen, withoutBeta)
    expect(next.roles.chat).toEqual(defaultBinding)
    expect(plan(next).models.map((m) => m.id)).toEqual(['uebox-chat'])
    expect(next.roles.summary).toEqual(chosen.roles.summary)
  })

  it('可选模型不再允许接某个角色（换档）：只把那个角色退回默认', () => {
    const chosen = choose(imported(), { chat: betaBinding, summary: betaBinding })
    const narrowed: CreatorPlanManifest = {
      ...modelsManifest,
      models: modelsManifest.models!.map((m) =>
        m === chatBeta ? { ...chatBeta, roles: ['chat'] } : m
      )
    }
    const next = syncPlanModels(chosen, narrowed)
    expect(next.roles.chat).toEqual(betaBinding)
    expect(next.roles.summary).toEqual(defaultBinding)
  })

  it('重新导入时没勾的角色绑着已下线的可选模型：同样退回默认', () => {
    const chosen = choose(imported(), { chat: betaBinding })
    expect(applyPlan(chosen, withoutBeta, keyRef, []).roles.chat).toEqual(defaultBinding)
  })

  it('旧清单（没有 models）、订阅失效：一概不增不删、不换绑定', () => {
    const chosen = choose(imported(), { chat: betaBinding })
    expect(syncPlanModels(chosen, { ...withoutBeta, models: undefined })).toBe(chosen)
    const canceled = { ...withoutBeta, plan: { ...withoutBeta.plan, status: 'canceled' as const } }
    expect(syncPlanModels(chosen, canceled)).toBe(chosen)
  })

  it('认不出的项跳过：主角色不认识、规格形状不对', () => {
    const odd: CreatorPlanManifest = {
      ...modelsManifest,
      models: [
        ...modelsManifest.models!,
        { model: 'uebox-holo', display_name: 'Box-Holo', roles: ['hologram'], default_for: [] },
        { model: 'uebox-chat-broken', display_name: 'Broken', roles: ['chat'], default_for: [] }
      ]
    }
    const ids = planProviders(odd, keyRef).flatMap((p) => p.models.map((m) => m.id))
    expect(ids).not.toContain('uebox-holo')
    expect(ids).not.toContain('uebox-chat-broken')
  })

  it('哪个模型失败不扣费，按它自己那一项', () => {
    const settings = imported()
    expect(isFreeOnFailureModel(settings, PLAN_PROVIDER_ID, 'uebox-chat-beta')).toBe(true)
    expect(isFreeOnFailureModel(settings, PLAN_PROVIDER_ID, 'uebox-chat')).toBe(false)
    expect(isFreeOnFailureModel(settings, 'my-gateway', 'gpt-x')).toBe(false)
  })

  describe('清单标了 anthropic-messages 的对话模型', () => {
    const claude = {
      ...chatSpec('claude-sonnet-5-5', { context_window: 1000000, max_output_tokens: 128000 }),
      model: 'claude-sonnet-5-5',
      roles: CHAT_ROLES,
      default_for: [],
      protocol: 'anthropic-messages'
    }
    const withClaude: CreatorPlanManifest = {
      ...modelsManifest,
      models: [...modelsManifest.models!, claude]
    }
    const claudeBinding = { providerId: PLAN_ANTHROPIC_PROVIDER_ID, modelId: claude.model }

    it('单独放进 Anthropic 来源，地址去掉 /v1；其余对话模型留在原来源', () => {
      const providers = planProviders(withClaude, keyRef)
      const anthropic = providers.find((p) => p.id === PLAN_ANTHROPIC_PROVIDER_ID)!
      expect(anthropic).toMatchObject({
        kind: 'chat',
        protocol: 'anthropic-messages',
        baseUrl: 'https://plan.example',
        displayName: 'Box Plan'
      })
      expect(anthropic.models.map((m) => m.id)).toEqual([claude.model])
      expect(planApiBaseUrl(anthropic)).toBe('https://plan.example/v1')
      const openai = providers.find((p) => p.id === PLAN_PROVIDER_ID)!
      expect(openai.protocol).toBe('openai-completions')
      expect(openai.models.map((m) => m.id)).toEqual(['uebox-chat', 'uebox-chat-beta'])
    })

    it('默认模型是它时，角色绑到 Anthropic 来源', () => {
      const claudeDefault: CreatorPlanManifest = {
        ...withClaude,
        roles: { ...withClaude.roles, chat: claude, agent: claude, summary: claude }
      }
      const settings = applyPlan(base, claudeDefault, keyRef, ['chat', 'summary'])
      expect(settings.roles.chat).toEqual({ ...claudeBinding, source: 'plan' })
      expect(settings.roles.summary).toEqual({ ...claudeBinding, source: 'plan' })
    })

    it('老用户绑在 OpenAI 兼容来源上的 Claude：刷新时搬到 Anthropic 来源，模型不换', () => {
      const unmarked: CreatorPlanManifest = {
        ...withClaude,
        models: [...modelsManifest.models!, { ...claude, protocol: undefined }]
      }
      const old = choose(normalizeSettings(applyPlan(base, unmarked, keyRef, ['chat', 'summary'])), {
        chat: { providerId: PLAN_PROVIDER_ID, modelId: claude.model }
      })
      expect(plan(old).models.map((m) => m.id)).toContain(claude.model)

      const next = normalizeSettings(
        syncPlanModels(refreshPlanModels(old, withClaude), withClaude)
      )
      expect(next.roles.chat).toEqual(claudeBinding)
      expect(next.roles.summary).toEqual(old.roles.summary)
      expect(plan(next).models.map((m) => m.id)).toEqual(['uebox-chat', 'uebox-chat-beta'])
      const anthropic = plan(next, PLAN_ANTHROPIC_PROVIDER_ID)
      expect(anthropic).toMatchObject({ baseUrl: 'https://plan.example', apiKey: keyRef })
      expect(next.providers.map((p) => p.id).indexOf(PLAN_ANTHROPIC_PROVIDER_ID)).toBe(
        next.providers.map((p) => p.id).indexOf(PLAN_PROVIDER_ID) + 1
      )
      // 再刷一次原样返回，不白写盘
      expect(refreshPlanModels(next, withClaude)).toBe(next)
      expect(syncPlanModels(next, withClaude)).toBe(next)

      // 服务端撤掉标记：搬回去，空了的 Anthropic 来源删掉
      const back = syncPlanModels(next, unmarked)
      expect(back.roles.chat).toEqual({ providerId: PLAN_PROVIDER_ID, modelId: claude.model })
      expect(back.providers.some((p) => p.id === PLAN_ANTHROPIC_PROVIDER_ID)).toBe(false)
    })

    it('清单地址不是 …/v1 时拼不出 Messages 地址，照旧走 OpenAI 兼容', () => {
      const odd = { ...withClaude, api: { base_url: 'https://plan.example/api' } }
      const ids = planProviders(odd, keyRef).map((p) => p.id)
      expect(ids).not.toContain(PLAN_ANTHROPIC_PROVIDER_ID)
    })
  })
})
