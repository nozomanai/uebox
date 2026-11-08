/**
 * Box Plan（原「Creator Plan」，代码里仍叫 Creator Plan）—— 主进程与渲染层共用的形状。
 *
 * Box Plan 是一个**用户主动开通**的付费模型服务：一把 Key 覆盖多个角色。
 * 没连接时，应用里与它有关的代码一个请求都不发（见 `src/main/ai/creatorPlan/`）。
 *
 * 清单（manifest）只取这里用得到的字段；服务端多给的字段忽略。
 */

import type { ModelRole } from './aiProvider'
import type { CreatorPlanRoutePrice, CreatorPlanVideoPrice } from './creatorPlanPricing'

/**
 * 套餐生成的来源 id 固定以它开头。放在 shared 里是因为渲染层也要认：
 * 「模型来源」列表里这类来源只读，操作都走卡片。
 */
export const PLAN_PROVIDER_ID = 'creator-plan'

export function isPlanProvider(providerId: string): boolean {
  return providerId === PLAN_PROVIDER_ID || providerId.startsWith(`${PLAN_PROVIDER_ID}-`)
}

export type CreatorPlanStatusValue = 'active' | 'trialing' | 'past_due' | 'canceled' | 'none'

/** 对话类角色的能力下限（清单里 roles.chat / agent / vision / summary） */
export interface CreatorPlanChatSpec {
  model: string
  display_name?: string
  context_window: number
  max_output_tokens: number
  supports_vision: boolean
  supports_video: boolean
  supports_tools: boolean
  supports_reasoning: boolean
  reasoning_efforts?: string[]
  structured_output: 'json-schema' | 'json-object' | 'none'
}

export interface CreatorPlanManifest {
  schema: 1
  etag: string
  video_pricing?: CreatorPlanVideoPrice
  route_pricing?: Record<string, CreatorPlanRoutePrice>
  plan: {
    product: string
    tier: string | null
    tier_name: string | null
    status: CreatorPlanStatusValue
    interval: 'month' | 'year' | null
    current_period_end: string | null
    cancel_at_period_end: boolean
    quota_resets_at: string | null
    manage_url: string
    /** 新账户冷却的结束时间，只在冷却期内给 */
    cooldown_ends_at?: string | null
  }
  quotas: Partial<Record<string, CreatorPlanManifestQuota>>
  api: { base_url: string }
  /** 为 null 表示套餐不含这个角色（或服务端还没开放） */
  roles: Partial<Record<ModelRole, unknown>>
  /**
   * 这一档能用的全部模型（2026-10-15 新增）。有它时套餐来源的模型只按它生成，
   * 名字、标签、能接哪些角色都由服务端定；旧服务端没有这个字段，按 `roles` 生成。
   * 每项的形状见 `creatorPlan/apply.ts` 的 `planModelEntries`
   */
  models?: unknown[]
  /** 对象存储（10-storage.md）。`enabled` 为假时导入预览里不提供这一项 */
  storage?: CreatorPlanStorageSpec | null
  /** 要下线的虚拟模型。命中正在用的模型时提示用户 */
  deprecations?: Array<{
    model: string
    replaced_by?: string | null
    deprecated_at?: string | null
    removed_at?: string | null
  }>
}

/**
 * 本期上限为什么低于档位的月额度（01-plan「字段规则」）：
 * 中途升档按比例折算、扣款失败压低、新账户冷却。几条同时成立时服务端给最严的那条
 */
export type CreatorPlanLimitedBy = 'plan_change' | 'past_due' | 'new_account'

/**
 * 清单 quotas 里的一项。2026-09-24 起服务端只发 `credits`（整数）；
 * 更早的服务端发九个分项键，数值可以带小数
 */
export interface CreatorPlanManifestQuota {
  limit: number
  used: number
  /** 不压低时的上限。只在 limit 被压低时给 */
  monthly_limit?: number
  limited_by?: string
  /** 每日上限（按 UTC 日）。没有这个字段的项不设每日上限 */
  daily?: { limit: number; used: number; resets_at?: string | null }
}

/** 统一额度（00-conventions「额度」）。有它就只看它 */
export const CREATOR_PLAN_CREDITS_KEY = 'credits'

/**
 * 额度键的排序：`credits` 在前，后面是旧服务端的九个分项键（00-conventions 旧额度表的顺序）。
 * 清单里出现不认识的键也照样留着，排在这些后面。
 */
export const CREATOR_PLAN_QUOTA_KEYS = [
  CREATOR_PLAN_CREDITS_KEY,
  'text_tokens',
  'images',
  'video_seconds',
  'model3d_tasks',
  'music_tasks',
  'realtime_minutes',
  'tts_characters',
  'stt_minutes',
  'searches'
] as const

export interface CreatorPlanQuota {
  key: string
  limit: number
  used: number
  /** limit 被压低时才有：不压低时的上限，和压低的原因 */
  monthlyLimit?: number
  limitedBy?: CreatorPlanLimitedBy
  /** 设了每日上限的项才有 */
  daily?: { limit: number; used: number; resetsAt: string | null }
}

/** 卡片上那一行：本期已用百分比，和今天的每日上限是不是已经用完 */
export interface CreatorPlanUsage {
  /** 0–100 的整数，向下取整：没真用完不显示 100 */
  usedPercent: number
  /** 今天的每日上限用完了：什么时候恢复（ISO）。没用完为 null */
  dailyExhaustedUntil: string | null
}

const usedRatio = (quota: CreatorPlanQuota): number =>
  quota.limit > 0 ? quota.used / quota.limit : 1

/**
 * 卡片只显示一个百分比（不显示 Credits 数字，也不显示单价）。
 *
 * - 有 `credits` 就只看它。
 * - 旧服务端（还发分项额度、没有 `credits`）：取用得最多的那一项 —— 最先卡住用户的是它。
 *   上限为 0 的项跳过（旧的 past_due 把对话以外的项压成 0，那是「暂停」不是「用完」），
 *   全是 0 才算 100%。
 * - 每日上限只看选中的那一项；没给重置时间按下一个 00:00 UTC（协议的日界）。
 */
export function planUsage(
  quotas: readonly CreatorPlanQuota[],
  now: number = Date.now()
): CreatorPlanUsage | null {
  const credits = quotas.find((quota) => quota.key === CREATOR_PLAN_CREDITS_KEY)
  const open = quotas.filter((quota) => quota.limit > 0)
  const pick =
    credits ??
    (open.length > 0 ? open : quotas).reduce<CreatorPlanQuota | null>(
      (top, quota) => (!top || usedRatio(quota) > usedRatio(top) ? quota : top),
      null
    )
  if (!pick) return null
  const ratio = Math.min(1, Math.max(0, usedRatio(pick)))
  const daily = pick.daily
  return {
    usedPercent: Math.floor(ratio * 100),
    dailyExhaustedUntil:
      daily && daily.limit > 0 && daily.used >= daily.limit
        ? (daily.resetsAt ?? nextUtcMidnight(now))
        : null
  }
}

/** 卡片上显示的套餐摘要 */
export interface CreatorPlanSummary {
  tierName: string | null
  status: CreatorPlanStatusValue
  interval: 'month' | 'year' | null
  currentPeriodEnd: string | null
  cancelAtPeriodEnd: boolean
  quotaResetsAt: string | null
  manageUrl: string
  /** 新账户冷却的结束时间，只在冷却期内有 */
  cooldownEndsAt: string | null
  /** 清单 quotas 逐项，按 CREATOR_PLAN_QUOTA_KEYS 排序 */
  quotas: CreatorPlanQuota[]
  videoPricing?: CreatorPlanVideoPrice
  routePricing?: Record<string, CreatorPlanRoutePrice>
}

/** 清单 deprecations 命中了正在用的模型：哪个角色、哪个模型、换成什么、哪天下线 */
export interface CreatorPlanDeprecationHit {
  role: ModelRole
  model: string
  replacedBy: string | null
  removedAt: string | null
}

/** 导入前给用户看的一行：这个角色会从什么换成什么 */
export interface CreatorPlanRoleChange {
  role: ModelRole
  /** 套餐里对应的虚拟模型名 */
  model: string
  modelDisplayName: string
  /** 现在绑的是什么；没绑为 null */
  current: { providerId: string; modelId: string; providerName: string } | null
  /** 现在这个绑定是不是本来就由套餐管着 */
  managed: boolean
  /** 默认勾不勾：没绑的、套餐管着的勾；用户手动配过的不勾 */
  defaultSelected: boolean
}

export interface CreatorPlanPreview {
  summary: CreatorPlanSummary
  changes: CreatorPlanRoleChange[]
  /** 套餐带对象存储时才有 */
  storage?: CreatorPlanStoragePreview | null
}

/** 清单里的 storage 一项 */
export interface CreatorPlanStorageSpec {
  enabled: boolean
  quota_bytes: number
  used_bytes: number
  max_object_bytes: number
  retention_days: number
}

/** 导入预览里「对象存储」那一行 */
export interface CreatorPlanStoragePreview {
  quotaBytes: number
  maxObjectBytes: number
  retentionDays: number
  /**
   * 现在用的是什么：套餐的（plan）、自己配好的桶（own，带服务商预设和桶名）、没开（none）
   */
  current: { kind: 'plan' } | { kind: 'none' } | { kind: 'own'; preset: string; bucket: string }
  /** 没开或本来就是套餐的勾；自己配好了桶的不勾 */
  defaultSelected: boolean
}

/** creator-plan:apply 的第二个参数。不传 storage = 不动对象存储 */
export interface CreatorPlanApplyOptions {
  storage?: boolean
}

export interface CreatorPlanState {
  connected: boolean
  pricingNeedsAcceptance?: boolean
  /** 连接了才有；拉清单失败时为 null，看 error */
  summary: CreatorPlanSummary | null
  /** 当前由套餐管着的角色 */
  managedRoles: ModelRole[]
  error: CreatorPlanErrorCode | null
  /** 正在用、但清单说要下线的模型 */
  deprecations: CreatorPlanDeprecationHit[]
}

/** 断开的结果。`revoked` 为 false：服务端没吊销成功，本机 Key 已删，提示去网页端手动吊销 */
export interface CreatorPlanDisconnectResult {
  revoked: boolean
  /** 网页端 API Key 列表，手动吊销用 */
  keysUrl: string
}

/**
 * 调套餐来源时，服务端回的这几种错误在对话里给专门的提示（见 00-conventions.md「错误」）。
 * 除 unauthorized 外都跳清单里的 manage_url；unauthorized 引导去「设置 → 模型」重新连接。
 *
 * `daily_limit_reached`（429）是每日上限：明天 00:00 UTC 就能接着用，**不重试** ——
 * 别的 429 是限流、等几秒就好，这一个等到的是明天。
 */
export type CreatorPlanChatErrorCode =
  | 'subscription_inactive'
  | 'quota_exhausted'
  | 'daily_limit_reached'
  | 'role_not_in_plan'
  | 'unauthorized'

const CHAT_ERRORS: Readonly<Record<string, [number, CreatorPlanChatErrorCode]>> = {
  subscription_inactive: [402, 'subscription_inactive'],
  quota_exhausted: [402, 'quota_exhausted'],
  daily_limit_reached: [429, 'daily_limit_reached'],
  role_not_in_plan: [403, 'role_not_in_plan']
}

/**
 * 只对套餐来源的调用用它，别的来源的错误不经过这里。
 *
 * 402 / 403 要状态码和错误码都对得上；401 只看状态码 —— Key 被吊销时错误体
 * 万一没解析出来，也该引导重新连接，而不是落到通用的「密钥不对」。
 */
export function creatorPlanChatError(
  statusCode: number | undefined,
  code: string | undefined
): CreatorPlanChatErrorCode | null {
  if (statusCode === 401) return 'unauthorized'
  const hit = code && Object.hasOwn(CHAT_ERRORS, code) ? CHAT_ERRORS[code] : undefined
  return hit && hit[0] === statusCode ? hit[1] : null
}

/**
 * 「失败不扣费」的套餐模型（清单 `models[].free_on_failure`，如 Box-Chat Beta）线路全不可用。
 *
 * 不归进 `CreatorPlanChatErrorCode`：那几种是不改配置就一定再失败的，挂「管理订阅」；
 * 这一种稍后再试可能就好，主进程已经自动重试过一次，界面提示稍后重试或换回默认模型，
 * 照常留「继续尝试」。服务端不会替用户改走默认模型（协议 02-chat），这边也不自动换。
 */
export const PLAN_LINE_BUSY = 'line_busy'

/** 服务端回的是不是「线路都不可用」（00-conventions：503 `upstream_unavailable`） */
export function isPlanUpstreamUnavailable(
  statusCode: number | undefined,
  code: string | undefined
): boolean {
  return statusCode === 503 && code === 'upstream_unavailable'
}

/**
 * 每日上限的重置时刻：下一个 00:00 UTC（00-conventions「每日上限」）。
 * 响应头 `X-Uebox-Daily-Reset` 拿不到时（对话那一路只剩一行错误文本）按它算，结果一样。
 */
export function nextUtcMidnight(now: number = Date.now()): string {
  const at = new Date(now)
  return new Date(
    Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate() + 1)
  ).toISOString()
}

/** 本地时区里的第几天，用来判「今天 / 明天」 */
function localDay(at: Date): number {
  return Math.floor((at.getTime() - at.getTimezoneOffset() * 60_000) / 86_400_000)
}

/**
 * 重置时刻说给人听：「今天 17:00」「明天 08:00」，再远的带日期。按本机时区。
 * `words` 把钟点拼成「今天 …」「明天 …」，由调用方给（渲染层走 i18n，主进程给中文）。
 * `locale` 不给就用运行环境的默认值：每日上限的重置点离现在不到 24 小时，只会落在今天或明天，
 * 用不上带日期的那一支。
 */
export function formatPlanResetTime(
  iso: string,
  locale: string | undefined,
  words: { today: (time: string) => string; tomorrow: (time: string) => string },
  now: Date = new Date()
): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  const time = new Intl.DateTimeFormat(locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(at)
  const days = localDay(at) - localDay(now)
  if (days === 0) return words.today(time)
  if (days === 1) return words.tomorrow(time)
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  }).format(at)
}

export interface CreatorPlanDevicePrompt {
  userCode: string
  verificationUri: string
}

export type CreatorPlanErrorCode =
  | 'cancelled'
  | 'denied'
  | 'expired'
  | 'unauthorized'
  | 'network'
  | 'bad_response'
  | 'not_connected'
  | 'encryption_unavailable'
  | 'invalid_itch_url'
  | 'already_claimed'
  | 'sold_out'
  | 'campaign_closed'
  | 'unknown'

/** Box Plan 的活动（2026 Epic AI MegaJam）。开没开、发什么都由服务端决定 */
export interface CreatorPlanCampaign {
  open: boolean
  /** 这个账户领过了（之前买过同一套餐也算） */
  claimed: boolean
  planTitle: string | null
  claimUntil: string | null
  /** 领到的那份套餐的到期时间 */
  expiresAt: string | null
}

export type CreatorPlanResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: CreatorPlanErrorCode; error: string }
