/**
 * 把 Box Plan 的清单落成本地的来源（provider）和角色绑定。纯函数，不碰磁盘。
 *
 * 规则：
 * - 按角色类别（`ProviderKind`）一类一个来源，id 都以 `creator-plan` 开头，共用一把密钥
 *   （`PLAN_KEY_ID`）。界面上它们合成一张「Box Plan」卡片。
 * - 套餐绑定的角色带 `source: 'plan'`。用户之后手动改了哪个角色，那个角色就自动
 *   脱离套餐（渲染层改绑定时不带 source），重新导入也不会覆盖它。
 * - 导入时默认只接管「没绑的」和「本来就由套餐管着的」角色；用户手动配过的，
 *   要在预览里自己勾上才会被换掉。
 * - 被接管的角色原来绑的是什么，记在套餐自己的状态文件里（`planState.ts`），
 *   不往 models.json 里塞；断开时照着还原。
 */

import {
  MODEL_ROLES,
  ROLE_KIND,
  modelAllowsRole,
  modelLabelWithBadge,
  type ModelBinding,
  type ModelConfig,
  type ModelRole,
  type ProviderKind,
  type ProviderProtocol,
  type RoleBindings
} from '../../../shared/aiProvider'
import {
  CREATOR_PLAN_QUOTA_KEYS,
  PLAN_PROVIDER_ID,
  isPlanProvider,
  type CreatorPlanChatSpec,
  type CreatorPlanDeprecationHit,
  type CreatorPlanLimitedBy,
  type CreatorPlanManifest,
  type CreatorPlanManifestQuota,
  type CreatorPlanQuota,
  type CreatorPlanRoleChange,
  type CreatorPlanSummary
} from '../../../shared/creatorPlan'
import type { AiProviderSettings, ApiKeyRef, ProviderConfig } from '../types'

import {
  PLAN_PRICING_HEADER,
  parsePlanPricing,
  parseVideoPricing
} from '../../../shared/creatorPlanPricing'

export { PLAN_PROVIDER_ID, isPlanProvider }
export const PLAN_KEY_ID = 'creator-plan:key'
const PLAN_KEY_REF: ApiKeyRef = { kind: 'literal', id: PLAN_KEY_ID }

/**
 * 被套餐接管前的绑定。null = 那个角色原来没设置。
 * 主模型只记在 chat 上；合并之前记在 agent 上的老记录，读盘时并过去（planState.ts 的 foldMainModel）
 */
export type OriginalBindings = Partial<Record<ModelRole, ModelBinding | null>>
/** 套餐来源在界面上的名字。清单刷新时老用户的来源也跟着改过来（见 refreshPlanModels） */
export const PLAN_DISPLAY_NAME = 'Box Plan'

/** 清单里的角色全都接。某个角色为 null（套餐不含）时不出现在预览里 */
const SUPPORTED_ROLES: readonly ModelRole[] = MODEL_ROLES

/**
 * 每一类的来源 id。**这几个 id 不许改**：
 *
 * - 嵌入的向量是否过期按 `providerId:modelId` 判（`getEmbeddingModelTag`），
 *   改了 `creator-plan-embedding`，用户的知识库会被整库重建；
 * - 视频 / 3D 的任务令牌是 `providerId:任务号`，改了之前报出去的令牌就续不上。
 *
 * 对话类沿用最早的 `creator-plan`，老用户的绑定原样有效。显示名随便改，不影响这两件事。
 */
export const PLAN_PROVIDER_IDS: Readonly<Record<ProviderKind, string>> = Object.freeze({
  chat: PLAN_PROVIDER_ID,
  embedding: `${PLAN_PROVIDER_ID}-embedding`,
  image: `${PLAN_PROVIDER_ID}-image`,
  video: `${PLAN_PROVIDER_ID}-video`,
  model3d: `${PLAN_PROVIDER_ID}-model3d`,
  realtime: `${PLAN_PROVIDER_ID}-realtime`,
  tts: `${PLAN_PROVIDER_ID}-tts`,
  stt: `${PLAN_PROVIDER_ID}-stt`,
  music: `${PLAN_PROVIDER_ID}-music`,
  // 网关目前没有音效接口，清单里也不会有这个角色；占个 id 只为让表完整
  sfx: `${PLAN_PROVIDER_ID}-sfx`,
  search: `${PLAN_PROVIDER_ID}-search`,
  judge: `${PLAN_PROVIDER_ID}-judge`
})

/**
 * 对话类里走 Anthropic Messages 的来源。清单给模型标了 `protocol: 'anthropic-messages'`
 * （中转站按上游渠道判断：上游原生支持 Messages 的才标），这些模型放这里直连 `/v1/messages`：
 * 经 OpenAI 兼容格式转一道会丢提示缓存和带签名的思考块。
 * 一个来源 id 只对应一种协议，**这个 id 不许改**，也不许拿 `creator-plan` 换协议。
 */
export const PLAN_ANTHROPIC_PROVIDER_ID = `${PLAN_PROVIDER_ID}-anthropic`

/** 清单 `base_url` 是 `…/v1`；Anthropic SDK 自己拼 `/v1/messages`，那一路要去掉 `/v1`。不是这个形状回 null */
function anthropicBaseUrl(baseUrl: string): string | null {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return /\/v1$/.test(trimmed) ? trimmed.slice(0, -'/v1'.length) : null
}

/** 套餐来源按协议该填的地址 */
function planBaseUrl(protocol: ProviderProtocol, baseUrl: string): string {
  return protocol === 'anthropic-messages' ? (anthropicBaseUrl(baseUrl) ?? baseUrl) : baseUrl
}

/** 套餐来源对应的清单 `base_url`（`…/v1`）：连接、拉清单、领活动都用这个 */
export function planApiBaseUrl(provider: Pick<ProviderConfig, 'protocol' | 'baseUrl'>): string {
  const base = provider.baseUrl.replace(/\/+$/, '')
  return provider.protocol === 'anthropic-messages' ? `${base}/v1` : base
}

/** 一个模型落在哪个套餐来源。清单地址不是 `…/v1` 时拼不出 Messages 地址，照旧走 OpenAI 兼容 */
function slotOf(
  kind: ProviderKind,
  spec: PlanRoleSpec,
  manifest: CreatorPlanManifest
): { id: string; protocol: ProviderProtocol } {
  if (
    kind === 'chat' &&
    spec.protocol === 'anthropic-messages' &&
    anthropicBaseUrl(manifest.api?.base_url ?? '')
  ) {
    return { id: PLAN_ANTHROPIC_PROVIDER_ID, protocol: 'anthropic-messages' }
  }
  return { id: PLAN_PROVIDER_IDS[kind], protocol: 'openai-completions' }
}

const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

/** 清单里一个角色的规格。各类字段不同，公共的只有 model / display_name（见协议 01-plan） */
export type PlanRoleSpec = { model: string; display_name?: string } & Record<string, unknown>

function isChatSpec(value: unknown): value is CreatorPlanChatSpec {
  const spec = value as Partial<CreatorPlanChatSpec> | null
  return (
    !!spec &&
    typeof spec.model === 'string' &&
    typeof spec.context_window === 'number' &&
    typeof spec.max_output_tokens === 'number'
  )
}

function isRoleSpec(role: ModelRole, value: unknown): value is PlanRoleSpec {
  if (ROLE_KIND[role] === 'chat') return isChatSpec(value)
  const spec = value as { model?: unknown } | null
  return !!spec && typeof spec.model === 'string' && spec.model.length > 0
}

/** 清单里这次能接的角色 → 规格 */
export function planRoleSpecs(
  manifest: CreatorPlanManifest
): Partial<Record<ModelRole, PlanRoleSpec>> {
  const out: Partial<Record<ModelRole, PlanRoleSpec>> = {}
  for (const role of SUPPORTED_ROLES) {
    const spec = manifest.roles?.[role]
    if (isRoleSpec(role, spec)) out[role] = spec
  }
  return out
}

/**
 * 能绑的角色 → 规格。来源里列哪些模型照旧按 planRoleSpecs，这个只管绑定。
 *
 * 本地「对话」和「Agent」已合成一个主模型、存在 chat 那一格（`store.ts` 的 mergeMainModel），
 * 落盘后 roles.agent 永远是空的。清单里 agent 的那份就当主模型的规格（两份都给时听 agent 的，
 * 和 mergeMainModel 一致），预览里不再单列一行 Agent：不然那一行总显示「未设置」、默认勾上，
 * 一落盘就并进 chat，把用户自己的主模型盖掉，原绑定也没记，断开后主模型就没了。
 */
function bindableRoleSpecs(
  manifest: CreatorPlanManifest
): Partial<Record<ModelRole, PlanRoleSpec>> {
  const { agent, ...specs } = planRoleSpecs(manifest)
  return agent ? { ...specs, chat: agent } : specs
}

function chatModel(spec: CreatorPlanChatSpec): ModelConfig {
  const efforts = new Set(spec.reasoning_efforts ?? [])
  return {
    id: spec.model,
    displayName: spec.display_name ?? spec.model,
    supportsVision: spec.supports_vision,
    supportsVideo: spec.supports_video,
    supportsTools: spec.supports_tools,
    supportsReasoning: spec.supports_reasoning,
    contextWindow: spec.context_window,
    maxOutputTokens: spec.max_output_tokens,
    structuredOutputApi: spec.structured_output,
    ...(spec.supports_reasoning
      ? {
          thinkingLevelMap: Object.fromEntries(
            THINKING_LEVELS.map((level) => [level, efforts.has(level) ? level : null])
          )
        }
      : {})
  }
}

const str = (value: unknown): string | undefined =>
  typeof value === 'string' && value ? value : undefined

/**
 * 清单规格 → 各类的 `ModelConfig`（对话类见 chatModel）。
 *
 * 只写落盘归一化（`store.ts` 的 normalizeModel）会留下的字段，没值就不写键：
 * 清单刷新（`refreshPlanModels`）逐键比对，写一个会被归一化改掉的值，就会每 6 小时白写一次盘。
 *
 * 各类在调用时走哪条分支：
 * - embedding：`jina-embeddings` 发 `task`（协议 03 的字段同名同值），维度按清单固定发
 * - image：`uebox-images`（`imageGeneration.ts`）
 * - video / model3d / music：Provider 上的 `uebox-tasks`（见 PLAN_PROVIDER_EXTRA）
 * - realtime / tts：音色取清单（realtime 取第一个，tts 取 default_voice）；tts 的单次字数上限
 *   写进 ttsMaxInputChars，渲染层按它切段
 * - stt / search / judge：按来源 id（`isPlanProvider`）选分支，模型上不用额外字段
 */
const MODEL_OF_KIND: Readonly<
  Record<ProviderKind, (spec: PlanRoleSpec) => Omit<ModelConfig, 'id' | 'displayName'>>
> = Object.freeze({
  chat: () => ({}),
  embedding: (spec: PlanRoleSpec) => ({
    embeddingApi: 'jina-embeddings' as const,
    ...(typeof spec.dimensions === 'number' ? { embeddingDimensions: spec.dimensions } : {})
  }),
  image: () => ({ imageApi: 'uebox-images' as const }),
  video: () => ({}),
  model3d: () => ({}),
  music: () => ({}),
  sfx: () => ({}),
  realtime: (spec: PlanRoleSpec) => {
    const voice = Array.isArray(spec.voices) ? str(spec.voices[0]) : undefined
    return voice ? { realtimeVoice: voice } : {}
  },
  tts: (spec: PlanRoleSpec) => {
    const voice =
      str(spec.default_voice) ?? (Array.isArray(spec.voices) ? str(spec.voices[0]) : undefined)
    return {
      ...(voice ? { ttsVoice: voice } : {}),
      ...(typeof spec.max_input_chars === 'number' && spec.max_input_chars > 0
        ? { ttsMaxInputChars: Math.floor(spec.max_input_chars) }
        : {})
    }
  },
  stt: () => ({}),
  search: () => ({}),
  judge: () => ({})
})

/** Provider 级的接口形状：三类异步任务共用一个 `uebox-tasks` 客户端 */
const PLAN_PROVIDER_EXTRA: Partial<Record<ProviderKind, Partial<ProviderConfig>>> = {
  video: { videoApi: 'uebox-tasks' },
  model3d: { model3dApi: 'uebox-tasks' },
  music: { musicApi: 'uebox-tasks' }
}

/**
 * 一个角色的规格 → `ModelConfig`。旧服务端（清单没有 `models`）走的就是这一条：
 * 名字用 `display_name`，`beta: true`（目前是音乐）标「Beta」。
 *
 * `models` 管的那四位（badge / description / allowedRoles / freeOnFailure）没有也写成 undefined：
 * 清单刷新逐键比对，服务端撤掉了哪一位，这边才跟着撤。
 */
function toModelConfig(role: ModelRole, spec: PlanRoleSpec): ModelConfig {
  const kind = ROLE_KIND[role]
  const model: ModelConfig =
    kind === 'chat'
      ? chatModel(spec as unknown as CreatorPlanChatSpec)
      : {
          id: spec.model,
          displayName: spec.display_name ?? spec.model,
          ...MODEL_OF_KIND[kind](spec)
        }
  return {
    ...model,
    badge: spec.beta === true ? 'Beta' : undefined,
    description: undefined,
    allowedRoles: undefined,
    freeOnFailure: undefined
  }
}

/** 清单 `models` 的一项，认过的（协议 01-plan，2026-10-15） */
export interface PlanModelEntry {
  /** 主角色（`roles[0]`）：其余字段是它的规格，按它转成模型配置 */
  primary: ModelRole
  /** 整项原样：主角色的规格，外加 display_name / badge / description / free_on_failure */
  spec: PlanRoleSpec
  /** 能绑的角色，按 MODEL_ROLES 排（和落盘归一化一致，刷新时不会因为顺序白写盘） */
  roles: ModelRole[]
}

/**
 * 清单里的 `models`。旧服务端没有这个字段时回 null，调用方照旧按 `roles` 生成。
 *
 * 认不出的项跳过：主角色这个客户端不认识（服务端以后加的新角色）、规格形状不对。
 * 能绑的角色只留和主角色同一类的：来源一类一个，跨类的绑上去也调不通。
 */
export function planModelEntries(manifest: CreatorPlanManifest): PlanModelEntry[] | null {
  if (!Array.isArray(manifest.models)) return null
  return manifest.models.flatMap((raw): PlanModelEntry[] => {
    const listed: unknown[] = Array.isArray((raw as { roles?: unknown } | null)?.roles)
      ? (raw as { roles: unknown[] }).roles
      : []
    const primary = MODEL_ROLES.find((role) => role === listed[0])
    if (!primary || !isRoleSpec(primary, raw)) return []
    const kind = ROLE_KIND[primary]
    const roles = MODEL_ROLES.filter((role) => ROLE_KIND[role] === kind && listed.includes(role))
    return [{ primary, spec: raw, roles }]
  })
}

/** `models` 的一项 → `ModelConfig`：规格按主角色转，名字、标签、说明、能绑的角色原样用服务端的 */
function entryModel(entry: PlanModelEntry): ModelConfig {
  const { spec } = entry
  return {
    ...toModelConfig(entry.primary, spec),
    displayName: str(spec.display_name) ?? spec.model,
    badge: str(spec.badge),
    description: str(spec.description),
    allowedRoles: entry.roles,
    freeOnFailure: spec.free_on_failure === true ? true : undefined
  }
}

/** 一个套餐来源该有的模型。来源按类别分，对话类再按协议分（见 PLAN_ANTHROPIC_PROVIDER_ID） */
interface PlanSlot {
  kind: ProviderKind
  protocol: ProviderProtocol
  models: Map<string, ModelConfig>
}

/**
 * 清单 → 各套餐来源（键是来源 id）该有的模型。
 *
 * 有 `models` 就按它（服务端定有哪些、叫什么、标什么），客户端不写死任何模型。
 * 各角色的默认模型按协议都在 `models` 里；万一漏了、或者旧服务端根本没有 `models`，按 `roles` 补上。
 * 同一类里一个模型只落一个来源，以先出现的为准。
 */
function planSlots(manifest: CreatorPlanManifest): Map<string, PlanSlot> {
  const slots = new Map<string, PlanSlot>()
  const seen = new Set<string>()
  const add = (kind: ProviderKind, spec: PlanRoleSpec, model: ModelConfig): void => {
    if (seen.has(`${kind}\n${model.id}`)) return
    seen.add(`${kind}\n${model.id}`)
    const { id, protocol } = slotOf(kind, spec, manifest)
    const slot = slots.get(id) ?? { kind, protocol, models: new Map<string, ModelConfig>() }
    slot.models.set(model.id, model)
    slots.set(id, slot)
  }
  for (const entry of planModelEntries(manifest) ?? []) {
    add(ROLE_KIND[entry.primary], entry.spec, entryModel(entry))
  }
  for (const [role, spec] of Object.entries(planRoleSpecs(manifest)) as [
    ModelRole,
    PlanRoleSpec
  ][]) {
    add(ROLE_KIND[role], spec, toModelConfig(role, spec))
  }
  return slots
}

/** 同上，按模型 id 摊平 */
function planModelsById(manifest: CreatorPlanManifest): Map<string, ModelConfig> {
  return new Map([...planSlots(manifest).values()].flatMap((slot) => [...slot.models.entries()]))
}

/** 这一类里放着这个模型的套餐来源；清单里没有这个模型时回这一类的默认来源 */
function slotIdOf(slots: Map<string, PlanSlot>, kind: ProviderKind, modelId: string): string {
  for (const [id, slot] of slots) {
    if (slot.kind === kind && slot.models.has(modelId)) return id
  }
  return PLAN_PROVIDER_IDS[kind]
}

/** 清单 → 套餐的来源。一类一个，没有模型的类不生成；`models` 里的可选模型一并列上 */
export function planProviders(manifest: CreatorPlanManifest, apiKey: ApiKeyRef): ProviderConfig[] {
  const slots = planSlots(manifest)
  const pricing: Record<string, { version: string }> = parsePlanPricing(manifest.route_pricing)
  const video = parseVideoPricing(manifest.video_pricing)
  if (video) pricing['uebox-video'] = video
  const headersFor = (models: Map<string, ModelConfig>): Record<string, string> | undefined => {
    const versions = [
      ...new Set([...models.keys()].flatMap((id) => (pricing[id] ? [pricing[id].version] : [])))
    ]
    if (versions.length > 1)
      throw new Error('This client requires a shared pricing version per provider')
    return versions[0] ? { [PLAN_PRICING_HEADER]: versions[0] } : undefined
  }
  return [...slots.entries()].map(([id, { kind, protocol, models }]) => ({
    id,
    displayName: PLAN_DISPLAY_NAME,
    kind,
    protocol,
    baseUrl: planBaseUrl(protocol, manifest.api.base_url),
    apiKey,
    ...PLAN_PROVIDER_EXTRA[kind],
    ...(headersFor(models) ? { headers: headersFor(models) } : {}),
    models: [...models.values()]
  }))
}

const LIMITED_BY: readonly CreatorPlanLimitedBy[] = ['plan_change', 'past_due', 'new_account']

const isNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value)

/**
 * 清单一项 → 卡片一项。每日上限、压低的原因只在字段齐全时带上：
 * 服务端以后加的原因代码这边不认识，就不写原因（数字照样显示）
 */
function planQuota(key: string, quota: CreatorPlanManifestQuota): CreatorPlanQuota {
  const limitedBy = LIMITED_BY.find((reason) => reason === quota.limited_by)
  const daily = quota.daily
  return {
    key,
    limit: quota.limit,
    used: quota.used,
    ...(isNumber(quota.monthly_limit) && quota.monthly_limit > quota.limit
      ? { monthlyLimit: quota.monthly_limit, ...(limitedBy ? { limitedBy } : {}) }
      : {}),
    ...(daily && isNumber(daily.limit) && isNumber(daily.used)
      ? {
          daily: {
            limit: daily.limit,
            used: daily.used,
            resetsAt: typeof daily.resets_at === 'string' ? daily.resets_at : null
          }
        }
      : {})
  }
}

/** 清单 quotas 逐项。认识的键按额度表的顺序在前，不认识的也照样列出来 */
function planQuotas(manifest: CreatorPlanManifest): CreatorPlanQuota[] {
  const known: readonly string[] = CREATOR_PLAN_QUOTA_KEYS
  const rank = (key: string): number => {
    const index = known.indexOf(key)
    return index === -1 ? known.length : index
  }
  return Object.entries(manifest.quotas ?? {})
    .filter(
      (entry): entry is [string, CreatorPlanManifestQuota] =>
        isNumber(entry[1]?.limit) && isNumber(entry[1]?.used)
    )
    .map(([key, quota]) => planQuota(key, quota))
    .sort((a, b) => rank(a.key) - rank(b.key))
}

export function planSummary(manifest: CreatorPlanManifest): CreatorPlanSummary {
  return {
    tierName: manifest.plan.tier_name,
    status: manifest.plan.status,
    interval: manifest.plan.interval,
    currentPeriodEnd: manifest.plan.current_period_end,
    cancelAtPeriodEnd: manifest.plan.cancel_at_period_end,
    quotaResetsAt: manifest.plan.quota_resets_at,
    manageUrl: manifest.plan.manage_url,
    cooldownEndsAt:
      typeof manifest.plan.cooldown_ends_at === 'string' ? manifest.plan.cooldown_ends_at : null,
    quotas: planQuotas(manifest),
    ...(manifest.video_pricing ? { videoPricing: parseVideoPricing(manifest.video_pricing) } : {}),
    ...(manifest.route_pricing ? { routePricing: parsePlanPricing(manifest.route_pricing) } : {})
  }
}

/** 比较已保存的接受版本；后台刷新只更新能力，绝不更新这个请求头。 */
export function planPricingNeedsAcceptance(
  settings: AiProviderSettings,
  manifest: CreatorPlanManifest | null
): boolean {
  if (!manifest) return false
  const pricing: Record<string, { version: string }> = parsePlanPricing(manifest.route_pricing)
  const video = parseVideoPricing(manifest.video_pricing)
  if (video) pricing['uebox-video'] = video
  return settings.providers
    .filter((provider) => isPlanProvider(provider.id))
    .some((provider) =>
      provider.models.some(
        (model) =>
          pricing[model.id] && provider.headers?.[PLAN_PRICING_HEADER] !== pricing[model.id].version
      )
    )
}

/** 导入预览：套餐能接的每个角色，现在是什么、默认勾不勾 */
export function planRoleChanges(
  settings: AiProviderSettings,
  manifest: CreatorPlanManifest
): CreatorPlanRoleChange[] {
  const specs = bindableRoleSpecs(manifest)
  const models = planModelsById(manifest)
  return SUPPORTED_ROLES.flatMap((role) => {
    const spec = specs[role]
    if (!spec) return []
    const model = models.get(spec.model)
    const binding = settings.roles[role]
    const provider = binding && settings.providers.find((p) => p.id === binding.providerId)
    const managed = binding?.source === 'plan'
    return [
      {
        role,
        model: spec.model,
        modelDisplayName: modelLabelWithBadge(model?.displayName ?? spec.model, model?.badge),
        current:
          binding && provider
            ? {
                providerId: binding.providerId,
                modelId: binding.modelId,
                providerName: provider.displayName
              }
            : null,
        managed,
        defaultSelected: !binding || managed
      }
    ]
  })
}

/**
 * 应用清单：换上套餐的来源，把选中的角色绑过去。
 *
 * 选中的角色 → 绑到套餐（source: 'plan'）。
 * 本来由套餐管着、这次没选中的 → 还给用户（用户取消勾选，就是不要套餐管它了）。
 * 本来由套餐管着、但清单里已经没有的 → 还给用户（协议 01-plan：保持原来的配置，不要清空）。
 * 「还给用户」和断开同一套：还原成接管前的原绑定，没有或原来源已删才置为未设置。
 */
export function applyPlan(
  settings: AiProviderSettings,
  manifest: CreatorPlanManifest,
  apiKey: ApiKeyRef,
  selected: readonly ModelRole[],
  originals: OriginalBindings = {}
): AiProviderSettings {
  const specs = bindableRoleSpecs(manifest)
  const slots = planSlots(manifest)
  const providers = [
    ...settings.providers.filter((p) => !isPlanProvider(p.id)),
    ...planProviders(manifest, apiKey)
  ]

  const roles: RoleBindings = { ...settings.roles }
  for (const role of SUPPORTED_ROLES) {
    const spec = specs[role]
    if (spec && selected.includes(role)) {
      roles[role] = {
        providerId: slotIdOf(slots, ROLE_KIND[role], spec.model),
        modelId: spec.model,
        source: 'plan'
      }
    } else if (roles[role]?.source === 'plan') {
      const restored = restoredBinding(providers, originals[role])
      if (restored) roles[role] = restored
      else delete roles[role]
    }
  }
  // 没勾、用户手动绑着套餐可选模型的角色：新清单里不给了就退回默认，不留一个调不通的绑定
  const kept = planModelEntries(manifest) ? fallBackUnoffered(roles, slots, specs) : roles
  return { ...settings, providers, roles: kept }
}

/**
 * 绑在套餐来源上、清单里已经不给（或不再允许绑这个角色）的模型：那个角色退回套餐的默认模型。
 * 模型还在、只是换了来源（清单给它标上或撤掉了 Anthropic 协议）的，跟着搬过去，模型不换。
 *
 * 例：用户手动选了可选模型 Box-Chat Beta，后来它下线了、或者换到了不含它的档位。
 * 只在这种时候换，别的情况一律不替用户换模型。嵌入不退（换模型要重建知识库，走 deprecation 提示）；
 * 清单里这个角色没有默认模型的不动（那是套餐不再给这个角色，见 releaseDroppedRoles）。
 * 没变化时原样返回同一个对象。
 */
function fallBackUnoffered(
  roles: RoleBindings,
  slots: Map<string, PlanSlot>,
  specs: Partial<Record<ModelRole, PlanRoleSpec>>
): RoleBindings {
  let next = roles
  for (const role of MODEL_ROLES) {
    const binding = roles[role]
    const spec = specs[role]
    if (!binding || !spec || role === 'embedding' || !isPlanBinding(binding)) continue
    const kind = ROLE_KIND[role]
    const home = slotIdOf(slots, kind, binding.modelId)
    const model = slots.get(home)?.models.get(binding.modelId)
    if (model && modelAllowsRole(model, role)) {
      if (home === binding.providerId) continue
      if (next === roles) next = { ...roles }
      next[role] = { ...binding, providerId: home }
      continue
    }
    if (next === roles) next = { ...roles }
    next[role] = {
      providerId: slotIdOf(slots, kind, spec.model),
      modelId: spec.model,
      source: 'plan'
    }
  }
  return next
}

/**
 * 清单刷新时，套餐来源的模型列表跟清单 `models` 对齐：服务端新加的模型（比如可选的经济线）
 * 不用重新导入就出现在选择列表里，下线的从列表里拿掉；绑着下线模型的角色先退回默认（fallBackUnoffered）。
 *
 * 只动已经导入了的那几类来源：哪一类交给套餐是用户在导入预览里定的。
 * 只在清单有 `models`、订阅生效时做：旧服务端没有这个字段（照旧不增不删，见 refreshPlanModels），
 * 订阅失效时清单什么都不给，那不是「下线了」。退不回去、还有角色绑着的（嵌入）留着，不断开那个角色。
 * 没变化时原样返回同一个对象。
 */
export function syncPlanModels(
  settings: AiProviderSettings,
  manifest: CreatorPlanManifest
): AiProviderSettings {
  if (!planModelEntries(manifest) || !isLivePlan(manifest)) return settings
  const slots = planSlots(manifest)
  const roles = fallBackUnoffered(settings.roles, slots, bindableRoleSpecs(manifest))
  const bound = new Set(
    Object.values(roles).map((binding) => binding && `${binding.providerId}\n${binding.modelId}`)
  )
  let changed = roles !== settings.roles
  // 已经导入了的类别，清单里新分出来的来源（比如头一回标了 Anthropic 协议）补上：
  // 用同类来源的那把密钥，排在它后面
  const imported = settings.providers.filter((p) => isPlanProvider(p.id))
  const firstOfKind = new Map<ProviderKind, ProviderConfig>()
  for (const provider of imported) {
    if (!firstOfKind.has(provider.kind)) firstOfKind.set(provider.kind, provider)
  }
  const added = new Map<ProviderKind, ProviderConfig[]>()
  for (const provider of planProviders(manifest, PLAN_KEY_REF)) {
    const sibling = firstOfKind.get(provider.kind)
    if (!sibling || imported.some((p) => p.id === provider.id)) continue
    const list = added.get(provider.kind) ?? []
    list.push({ ...provider, apiKey: sibling.apiKey })
    added.set(provider.kind, list)
  }
  const kindsInManifest = new Set([...slots.values()].map((slot) => slot.kind))
  const providers = settings.providers.flatMap((provider): ProviderConfig[] => {
    if (!isPlanProvider(provider.id)) return [provider]
    const extra =
      firstOfKind.get(provider.kind)?.id === provider.id ? (added.get(provider.kind) ?? []) : []
    if (extra.length > 0) changed = true
    const offered = slots.get(provider.id)?.models
    if (!offered) {
      // 这一类在清单里还有，只是不在这个来源了：只留还有角色绑着的模型，一个不剩就删
      if (!kindsInManifest.has(provider.kind)) return [provider, ...extra]
      const models = provider.models.filter((model) => bound.has(`${provider.id}\n${model.id}`))
      if (models.length === provider.models.length) return [provider, ...extra]
      changed = true
      return models.length > 0 ? [{ ...provider, models }, ...extra] : extra
    }
    const current = new Map(provider.models.map((model) => [model.id, model]))
    const models = [
      ...[...offered.values()].map((model) => current.get(model.id) ?? model),
      ...provider.models.filter(
        (model) => !offered.has(model.id) && bound.has(`${provider.id}\n${model.id}`)
      )
    ]
    const same =
      models.length === provider.models.length &&
      models.every((model, index) => model === provider.models[index])
    if (same) return [provider, ...extra]
    changed = true
    return [{ ...provider, models }, ...extra]
  })
  return changed ? { ...settings, providers, roles } : settings
}

/**
 * 这个套餐模型是不是「失败不扣费」的（清单 `models[].free_on_failure`）。
 * 对话那一路据此在 `upstream_unavailable` 时自动重试一次，再失败提示换回默认模型
 */
export function isFreeOnFailureModel(
  settings: Pick<AiProviderSettings, 'providers'>,
  providerId: string,
  modelId: string
): boolean {
  if (!isPlanProvider(providerId)) return false
  const provider = settings.providers.find((item) => item.id === providerId)
  return provider?.models.find((model) => model.id === modelId)?.freeOnFailure === true
}

/**
 * 导入前记下这次要被接管的角色原来绑的是什么。
 *
 * 还在套餐手里的角色，已经记过的不再覆盖：重新导入时它的「现在」是套餐，最初那条才是用户自己的配置。
 * 已经脱离套餐的（用户后来自己改过、清空过）按现在的记：那才是用户最新的选择。
 * 原来就由套餐管着、又没记录的（这个功能之前导入的），按「原来没设置」记。
 */
export function recordOriginals(
  originals: OriginalBindings,
  settings: AiProviderSettings,
  manifest: CreatorPlanManifest,
  selected: readonly ModelRole[]
): OriginalBindings {
  const specs = bindableRoleSpecs(manifest)
  const next: OriginalBindings = { ...originals }
  for (const role of SUPPORTED_ROLES) {
    if (!specs[role] || !selected.includes(role)) continue
    const binding = settings.roles[role]
    const managed = !!binding && isPlanBinding(binding)
    if (managed && Object.hasOwn(next, role)) continue
    next[role] =
      binding && !managed ? { providerId: binding.providerId, modelId: binding.modelId } : null
  }
  return next
}

/**
 * 断开：删掉套餐的来源；还在套餐手里的角色还原成接管前的绑定。
 *
 * 原绑定指向的来源（或那个模型）已经被删掉了，就置为未设置。
 * 用户手动改过的角色早已脱离套餐，不动。
 */
export function removePlan(
  settings: AiProviderSettings,
  originals: OriginalBindings = {}
): AiProviderSettings {
  const providers = settings.providers.filter((p) => !isPlanProvider(p.id))
  const roles: RoleBindings = {}
  for (const [role, binding] of Object.entries(settings.roles) as [
    ModelRole,
    NonNullable<RoleBindings[ModelRole]>
  ][]) {
    if (!isPlanBinding(binding)) {
      roles[role] = binding
      continue
    }
    const restored = restoredBinding(providers, originals[role])
    if (restored) roles[role] = restored
  }
  return { ...settings, providers, roles }
}

/** 接管前的原绑定；它指向的来源或模型已经没了就回 null（置为未设置） */
function restoredBinding(
  providers: readonly ProviderConfig[],
  original: ModelBinding | null | undefined
): ModelBinding | null {
  const provider = original && providers.find((p) => p.id === original.providerId)
  return original && provider?.models.some((m) => m.id === original.modelId)
    ? { providerId: original.providerId, modelId: original.modelId }
    : null
}

const isPlanBinding = (binding: ModelBinding): boolean =>
  binding.source === 'plan' || isPlanProvider(binding.providerId)

/** 订阅还在（没取消、没失效）：这时某个角色为 null，才说明是套餐不再给它 */
const LIVE_STATUSES: readonly string[] = ['active', 'trialing', 'past_due']

/** 订阅还在：这时清单里的 null 才是「套餐不再给」，而不是订阅失效把什么都清空了 */
export function isLivePlan(manifest: CreatorPlanManifest): boolean {
  return LIVE_STATUSES.includes(manifest.plan?.status)
}

/**
 * 清单刷新时，套餐明确不再给的角色（`roles.<角色>` 为 null）还给用户：
 * 还原成导入前的原绑定（和断开同一套），没有原绑定或原来源已删就置为未设置；
 * 这一类角色全没了的套餐来源一并删掉，不留一个一调就 403 的来源。
 *
 * 例：网页检索不再对外提供（四档都是 null）、Lite 不含语音识别。
 *
 * 只在订阅生效、清单里还有别的角色时做：订阅失效时 roles 全是 null，那不是「不给这个角色」，
 * 跟着删的话连接也就没了（见 refreshPlanModels）。字段缺失（不是 null）不算，按服务端没说处理。
 * 没变化时原样返回同一个对象。
 */
export function releaseDroppedRoles(
  settings: AiProviderSettings,
  manifest: CreatorPlanManifest,
  originals: OriginalBindings = {}
): AiProviderSettings {
  if (!isLivePlan(manifest)) return settings
  const specs = bindableRoleSpecs(manifest)
  if (Object.keys(specs).length === 0) return settings
  // 主模型（chat 那一格）清单里 chat、agent 两份都不给了才算不再给
  const dropped = (role: ModelRole): boolean =>
    !specs[role] &&
    (manifest.roles?.[role] === null || (role === 'chat' && manifest.roles?.agent === null))

  const roles: RoleBindings = { ...settings.roles }
  for (const role of MODEL_ROLES) {
    const binding = roles[role]
    if (!binding || !isPlanBinding(binding) || !dropped(role)) continue
    const restored = restoredBinding(settings.providers, originals[role])
    if (restored) roles[role] = restored
    else delete roles[role]
  }
  // 这一类清单里一个角色都没有、也没有角色还绑着它的套餐来源，才删
  const liveKinds = new Set((Object.keys(specs) as ModelRole[]).map((role) => ROLE_KIND[role]))
  const bound = new Set(Object.values(roles).map((binding) => binding?.providerId))
  const providers = settings.providers.filter(
    (p) => !isPlanProvider(p.id) || liveKinds.has(p.kind) || bound.has(p.id)
  )
  const changed =
    providers.length !== settings.providers.length ||
    MODEL_ROLES.some((role) => roles[role] !== settings.roles[role])
  return changed ? { ...settings, providers, roles } : settings
}

/**
 * 清单刷新后更新套餐来源里各模型的能力（能力只升不降，服务端后台换模型时会变）。
 *
 * 只改已有的模型，不增不删：增删角色是用户在「重新导入」里做的决定；
 * 订阅失效时清单的 roles 全是 null，这里要是跟着删，来源一没，连接也就没了。
 * 口子有两个，都只在订阅生效时开：套餐明确不再给某个角色（releaseDroppedRoles），
 * 清单 `models` 增删了模型（syncPlanModels）。
 * 没变化时原样返回同一个对象，调用方据此跳过写盘。
 */
export function refreshPlanModels(
  settings: AiProviderSettings,
  manifest: CreatorPlanManifest
): AiProviderSettings {
  const bySpec = planModelsById(manifest)
  let changed = false
  const providers = settings.providers.map((provider) => {
    if (!isPlanProvider(provider.id)) return provider
    const models = provider.models.map((model) => {
      const next = bySpec.get(model.id)
      // 只比清单管的那几项：落盘归一化会给模型补别的字段，整个对象比永远不等
      const differs =
        next &&
        (Object.keys(next) as (keyof ModelConfig)[]).some(
          (key) => JSON.stringify(next[key]) !== JSON.stringify(model[key])
        )
      if (!differs) return model
      changed = true
      return { ...model, ...next }
    })
    const baseUrl = manifest.api?.base_url
      ? planBaseUrl(provider.protocol, manifest.api.base_url)
      : provider.baseUrl
    if (baseUrl !== provider.baseUrl || provider.displayName !== PLAN_DISPLAY_NAME) changed = true
    return { ...provider, displayName: PLAN_DISPLAY_NAME, baseUrl, models }
  })
  return changed ? { ...settings, providers } : settings
}

/**
 * 清单刷新时，把停用的**对话**模型换成它的接替者（协议 01-plan：对话模型直接换，不用问用户）。
 *
 * 例：2026-09-24 服务端把对话四个角色并成一个 `uebox-chat`，原来的 `uebox-agent`、`uebox-vision`、
 * `uebox-fast` 列进 `deprecations`。之前导入的用户，这三个角色还绑着旧 ID，这里改绑到 `uebox-chat`，
 * 套餐的对话来源补上新模型、删掉没人用了的旧模型。
 *
 * 只换「还在套餐手里、清单里这个角色给的正好是 replaced_by」的角色。嵌入不在这里换：
 * 换了要重建知识库，得让用户知道（卡片上的 deprecation 提示）。没变化时原样返回同一个对象。
 */
export function migrateRetiredModels(
  settings: AiProviderSettings,
  manifest: CreatorPlanManifest
): AiProviderSettings {
  const deprecations = manifest.deprecations ?? []
  if (deprecations.length === 0) return settings
  const specs = bindableRoleSpecs(manifest)

  const roles: RoleBindings = { ...settings.roles }
  const added = new Map<string, ModelConfig>()
  for (const role of MODEL_ROLES) {
    const binding = roles[role]
    const spec = specs[role]
    if (!binding || !spec || ROLE_KIND[role] !== 'chat' || !isPlanBinding(binding)) continue
    const hit = deprecations.find((d) => d.model === binding.modelId)
    if (!hit || hit.replaced_by !== spec.model) continue
    roles[role] = { ...binding, modelId: spec.model }
    added.set(spec.model, planModelsById(manifest).get(spec.model) ?? toModelConfig(role, spec))
  }
  if (added.size === 0) return settings

  const bound = new Set(Object.values(roles).map((binding) => binding?.modelId))
  const retired = new Set(deprecations.map((d) => d.model))
  const providers = settings.providers.map((provider) => {
    if (provider.id !== PLAN_PROVIDER_IDS.chat) return provider
    const kept = provider.models.filter((m) => !retired.has(m.id) || bound.has(m.id))
    const missing = [...added.values()].filter((m) => !kept.some((k) => k.id === m.id))
    return { ...provider, models: [...kept, ...missing] }
  })
  return { ...settings, providers, roles }
}

/** 清单 deprecations 里，有哪些是正在用的（绑在套餐来源上的角色） */
export function planDeprecationHits(
  settings: AiProviderSettings,
  manifest: CreatorPlanManifest | null
): CreatorPlanDeprecationHit[] {
  const deprecations = manifest?.deprecations ?? []
  if (deprecations.length === 0) return []
  return MODEL_ROLES.flatMap((role) => {
    const binding = settings.roles[role]
    if (!binding || !isPlanProvider(binding.providerId)) return []
    const hit = deprecations.find((d) => d.model === binding.modelId)
    return hit
      ? [
          {
            role,
            model: hit.model,
            replacedBy: hit.replaced_by ?? null,
            removedAt: hit.removed_at ?? null
          }
        ]
      : []
  })
}

export function managedRoles(settings: AiProviderSettings): ModelRole[] {
  return (Object.entries(settings.roles) as [ModelRole, RoleBindings[ModelRole]][])
    .filter(([, binding]) => binding?.source === 'plan')
    .map(([role]) => role)
}
