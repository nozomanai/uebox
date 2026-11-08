/**
 * Box Plan 的业务逻辑：连接、预览、导入、断开、活动领取。
 *
 * 设置页（ipc.ts）和 agent 工具（tools/builtin/boxPlan.ts）走同一套，
 * 两边不会一边改了、另一边还按旧规则落盘。
 *
 * 没连接时，这里没有任何代码会发请求：连接这件事只能由用户发起
 * （设置页的按钮，或用户让 agent 去连 —— 浏览器里的登录和「允许」仍然是用户自己点）。
 */

import { hostname } from 'node:os'
import { app, shell } from 'electron'
import type { ModelRole } from '../../../shared/aiProvider'
import type {
  CreatorPlanApplyOptions,
  CreatorPlanCampaign,
  CreatorPlanDevicePrompt,
  CreatorPlanDisconnectResult,
  CreatorPlanManifest,
  CreatorPlanPreview,
  CreatorPlanResult,
  CreatorPlanState
} from '../../../shared/creatorPlan'
import { EncryptionUnavailableError, deleteLiteralKey, saveLiteralKey } from '../credentials'
import { invalidateSettingsCache, readSettings, updateSettings } from '../store'
import {
  PLAN_KEY_ID,
  applyPlan,
  managedRoles,
  planDeprecationHits,
  planPricingNeedsAcceptance,
  planRoleChanges,
  planSummary,
  recordOriginals,
  removePlan
} from './apply'
import {
  CreatorPlanError,
  fetchManifestIfChanged,
  pollForKey,
  revokeKey,
  startDeviceAuthorization
} from './client'
import { readOrCreateDeviceId } from './deviceId'
import { CREATOR_PLAN_KEYS_URL, CREATOR_PLAN_ORIGIN } from './endpoint'
import { clearPlanState, readPlanState, updatePlanState, writePlanState } from './planState'
import { planConnection, refreshPlan } from './refresh'
import { claimCampaign, fetchCampaign } from './campaign'
import { applyPlanStorage, planStoragePreview, restorePlanStorage } from './storage'

/** 正在进行的设备授权，用来取消 */
let pending: AbortController | null = null
/** 预览时拉到的清单，确认导入时直接用，不再拉一次 */
let pendingManifest: CreatorPlanManifest | null = null

export function failResult(error: unknown): {
  ok: false
  code: CreatorPlanError['code']
  error: string
} {
  if (error instanceof CreatorPlanError)
    return { ok: false, code: error.code, error: error.message }
  if (error instanceof EncryptionUnavailableError) {
    return { ok: false, code: 'encryption_unavailable', error: error.message }
  }
  return {
    ok: false,
    code: 'unknown',
    error: error instanceof Error ? error.message : String(error)
  }
}

/** 拉一份新清单（不带 etag），顺手更新缓存：连接、预览时用 */
async function fetchFresh(baseUrl: string, apiKey: string): Promise<CreatorPlanManifest> {
  const result = await fetchManifestIfChanged(baseUrl, apiKey, null)
  if (result.status !== 'ok') throw new CreatorPlanError('bad_response', 'Unexpected 304')
  await updatePlanState({ etag: result.etag, manifest: result.manifest, unauthorized: false })
  return result.manifest
}

async function preview(manifest: CreatorPlanManifest): Promise<CreatorPlanPreview> {
  return {
    summary: planSummary(manifest),
    changes: planRoleChanges(await readSettings(), manifest),
    storage: await planStoragePreview(manifest)
  }
}

/** 卡片状态。没连接时直接回，不发请求 */
export async function planStateNow(): Promise<CreatorPlanState> {
  invalidateSettingsCache()
  // 没连接时 refreshPlan 不发请求，直接回 null
  const outcome = await refreshPlan()
  const settings = await readSettings()
  if (!outcome) {
    return { connected: false, summary: null, managedRoles: [], error: null, deprecations: [] }
  }
  return {
    connected: true,
    summary: outcome.manifest ? planSummary(outcome.manifest) : null,
    managedRoles: managedRoles(settings),
    error: outcome.error,
    pricingNeedsAcceptance: planPricingNeedsAcceptance(settings, outcome.manifest),
    deprecations: planDeprecationHits(settings, outcome.manifest)
  }
}

/**
 * 设备授权：打开浏览器让用户登录并允许，拿到 Key 存进安全存储，回导入预览。
 * 来源和绑定要等 `applyPlanRoles` 才落盘。`signal` 中止时抛 cancelled。
 */
export async function connectPlan(options: {
  onPrompt?: (prompt: CreatorPlanDevicePrompt) => void
  signal?: AbortSignal
}): Promise<CreatorPlanPreview> {
  pending?.abort()
  const controller = new AbortController()
  pending = controller
  const onAbort = (): void => controller.abort()
  options.signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const start = await startDeviceAuthorization(CREATOR_PLAN_ORIGIN, {
      deviceName: hostname(),
      clientVersion: app.getVersion(),
      deviceId: await readOrCreateDeviceId(app.getPath('userData'))
    })
    options.onPrompt?.(start.prompt)
    if (start.prompt.verificationUri) void shell.openExternal(start.prompt.verificationUri)

    const issued = await pollForKey(CREATOR_PLAN_ORIGIN, start, controller.signal)
    const manifest = await fetchFresh(issued.baseUrl, issued.apiKey)
    // Key 先存进安全存储；来源和绑定等用户在预览里确认后才落盘
    await saveLiteralKey(PLAN_KEY_ID, issued.apiKey)
    pendingManifest = manifest
    return await preview(manifest)
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    if (pending === controller) pending = null
  }
}

export function cancelConnect(): void {
  pending?.abort()
  pending = null
}

/** 已连接时重新拉清单，回导入预览 */
export async function previewPlan(): Promise<CreatorPlanPreview> {
  const conn = await planConnection()
  if (!conn) throw new CreatorPlanError('not_connected', 'Not connected')
  if (!conn.apiKey) throw new CreatorPlanError('unauthorized', 'Key missing')
  const manifest = await fetchFresh(conn.baseUrl, conn.apiKey)
  pendingManifest = manifest
  return preview(manifest)
}

/** 按勾选的角色落盘，先记下被接管角色的原绑定；`storage` 不传 = 不动对象存储 */
export async function applyPlanRoles(
  roles: ModelRole[],
  options?: CreatorPlanApplyOptions
): Promise<CreatorPlanState> {
  const manifest = pendingManifest
  if (!manifest) throw new CreatorPlanError('not_connected', 'Connect first')
  const selected = Array.isArray(roles) ? roles : []
  const current = await readSettings()
  // 先记原绑定再落盘：反过来的话，写完配置、记录没写成，断开时就还原不回去了
  const planState = await readPlanState()
  const originals = recordOriginals(planState.originals, current, manifest, selected)
  await writePlanState({ ...planState, originals, unauthorized: false })
  // 落盘排进队里、在最新的配置上应用：和后台清单对账同时发生时，谁都不拿旧快照盖掉对方
  const written = await updateSettings((latest) =>
    applyPlan(latest, manifest, { kind: 'literal', id: PLAN_KEY_ID }, selected, originals)
  )
  await applyPlanStorage(manifest, options?.storage)
  pendingManifest = null
  return {
    connected: true,
    summary: planSummary(manifest),
    managedRoles: managedRoles(written),
    error: null,
    deprecations: planDeprecationHits(written, manifest)
  }
}

/**
 * 断开：先在服务端吊销这把 Key，再删本机的。
 *
 * 吊销失败（断网、服务不可用）照常断开，回 `revoked: false`，卡片提示去网页端手动吊销。
 * 还在套餐手里的角色还原成接管前的绑定。
 */
export async function disconnectPlan(): Promise<CreatorPlanDisconnectResult> {
  pendingManifest = null
  const conn = await planConnection()
  // 本机连 Key 都没有了，服务端那把也吊销不了，同样提示去网页端
  const revoked = conn?.apiKey ? await revokeKey(conn.baseUrl, conn.apiKey) : false
  const planState = await readPlanState()
  await updateSettings((latest) => removePlan(latest, planState.originals))
  await restorePlanStorage()
  await deleteLiteralKey(PLAN_KEY_ID)
  await clearPlanState()
  return { revoked, keysUrl: CREATOR_PLAN_KEYS_URL }
}

const NO_CAMPAIGN: CreatorPlanCampaign = {
  open: false,
  claimed: false,
  planTitle: null,
  claimUntil: null,
  expiresAt: null
}

/** 活动状态（MegaJam）。没连接时回「没有活动」，不发请求 */
export async function campaignStatus(): Promise<CreatorPlanResult<CreatorPlanCampaign>> {
  const conn = await planConnection()
  if (!conn?.apiKey) return { ok: true, data: NO_CAMPAIGN }
  return fetchCampaign(conn.baseUrl, conn.apiKey)
}

/** 领取活动套餐，成功后刷新清单（额度、到期时间）；刷新失败不影响领取结果 */
export async function claimPlanCampaign(
  itchUrl: string
): Promise<CreatorPlanResult<{ expiresAt: string | null }>> {
  const conn = await planConnection()
  if (!conn) return { ok: false, code: 'not_connected', error: 'Not connected' }
  if (!conn.apiKey) return { ok: false, code: 'unauthorized', error: 'Key missing' }
  const result = await claimCampaign(conn.baseUrl, conn.apiKey, String(itchUrl ?? ''))
  if (result.ok) await refreshPlan().catch(() => undefined)
  return result
}

/**
 * 对话里套餐错误提示上的「管理订阅」。地址取缓存的清单，不为这一下发请求；
 * 没有缓存（从没拉成功过）就退到网页端首页。
 */
export async function openPlanManage(): Promise<void> {
  const { manifest } = await readPlanState()
  const url = manifest?.plan.manage_url
  await shell.openExternal(url && /^https?:\/\//.test(url) ? url : CREATOR_PLAN_ORIGIN)
}
