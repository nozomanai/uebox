/**
 * Box Plan 的 IPC。
 *
 *   creator-plan:state       卡片状态。没连接时直接回，**不发请求**
 *   creator-plan:connect     设备授权 → 存 Key → 拉清单 → 回导入预览
 *                            （码通过 creator-plan:device-code 事件推给渲染层）
 *   creator-plan:cancel      取消正在进行的授权
 *   creator-plan:preview     已连接时重新拉清单，回导入预览
 *   creator-plan:apply       按用户勾选的角色落盘，先记下被接管角色的原绑定；
 *                            勾了「对象存储」就换成套餐的存储（storage.ts）
 *   creator-plan:disconnect  在服务端吊销 Key → 删来源、还原绑定、删本机 Key
 *   creator-plan:open-manage 打开清单里的 manage_url（对话里的套餐错误提示用）
 *   creator-plan:campaign    活动状态（campaign.ts）；没连接时回 open:false，不发请求
 *   creator-plan:campaign-claim 领取活动套餐，成功后刷新清单
 *
 * 没连接时，这里没有任何代码会发请求：连接这件事只能由用户点按钮发起。
 */

import { hostname } from 'node:os'
import { app, ipcMain, shell } from 'electron'
import type { ModelRole } from '../../../shared/aiProvider'
import type {
  CreatorPlanApplyOptions,
  CreatorPlanCampaign,
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

function fail(error: unknown): { ok: false; code: CreatorPlanError['code']; error: string } {
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

export function registerCreatorPlanIPC(): void {
  ipcMain.handle('creator-plan:state', async (): Promise<CreatorPlanResult<CreatorPlanState>> => {
    try {
      invalidateSettingsCache()
      // 没连接时 refreshPlan 不发请求，直接回 null
      const outcome = await refreshPlan()
      const settings = await readSettings()
      if (!outcome) {
        return {
          ok: true,
          data: {
            connected: false,
            summary: null,
            managedRoles: [],
            error: null,
            deprecations: []
          }
        }
      }
      return {
        ok: true,
        data: {
          connected: true,
          summary: outcome.manifest ? planSummary(outcome.manifest) : null,
          managedRoles: managedRoles(settings),
          error: outcome.error,
          pricingNeedsAcceptance: planPricingNeedsAcceptance(settings, outcome.manifest),
          deprecations: planDeprecationHits(settings, outcome.manifest)
        }
      }
    } catch (error) {
      return fail(error)
    }
  })

  ipcMain.handle(
    'creator-plan:connect',
    async (event): Promise<CreatorPlanResult<CreatorPlanPreview>> => {
      pending?.abort()
      const controller = new AbortController()
      pending = controller
      try {
        const start = await startDeviceAuthorization(CREATOR_PLAN_ORIGIN, {
          deviceName: hostname(),
          clientVersion: app.getVersion(),
          deviceId: await readOrCreateDeviceId(app.getPath('userData'))
        })
        if (!event.sender.isDestroyed()) event.sender.send('creator-plan:device-code', start.prompt)
        if (start.prompt.verificationUri) void shell.openExternal(start.prompt.verificationUri)

        const issued = await pollForKey(CREATOR_PLAN_ORIGIN, start, controller.signal)
        const manifest = await fetchFresh(issued.baseUrl, issued.apiKey)
        // Key 先存进安全存储；来源和绑定等用户在预览里确认后才落盘
        await saveLiteralKey(PLAN_KEY_ID, issued.apiKey)
        pendingManifest = manifest
        return { ok: true, data: await preview(manifest) }
      } catch (error) {
        return fail(error)
      } finally {
        if (pending === controller) pending = null
      }
    }
  )

  ipcMain.handle('creator-plan:cancel', () => {
    pending?.abort()
    pending = null
  })

  ipcMain.handle(
    'creator-plan:preview',
    async (): Promise<CreatorPlanResult<CreatorPlanPreview>> => {
      try {
        const conn = await planConnection()
        if (!conn) return { ok: false, code: 'not_connected', error: 'Not connected' }
        if (!conn.apiKey) return { ok: false, code: 'unauthorized', error: 'Key missing' }
        const manifest = await fetchFresh(conn.baseUrl, conn.apiKey)
        pendingManifest = manifest
        return { ok: true, data: await preview(manifest) }
      } catch (error) {
        return fail(error)
      }
    }
  )

  ipcMain.handle(
    'creator-plan:apply',
    async (
      _event,
      roles: ModelRole[],
      options?: CreatorPlanApplyOptions
    ): Promise<CreatorPlanResult<CreatorPlanState>> => {
      try {
        const manifest = pendingManifest
        if (!manifest) return { ok: false, code: 'not_connected', error: 'Connect first' }
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
          ok: true,
          data: {
            connected: true,
            summary: planSummary(manifest),
            managedRoles: managedRoles(written),
            error: null,
            deprecations: planDeprecationHits(written, manifest)
          }
        }
      } catch (error) {
        return fail(error)
      }
    }
  )

  /**
   * 断开：先在服务端吊销这把 Key，再删本机的。
   *
   * 吊销失败（断网、服务不可用）照常断开，回 `revoked: false`，卡片提示去网页端手动吊销。
   * 还在套餐手里的角色还原成接管前的绑定。
   */
  ipcMain.handle(
    'creator-plan:disconnect',
    async (): Promise<CreatorPlanResult<CreatorPlanDisconnectResult>> => {
      try {
        pendingManifest = null
        const conn = await planConnection()
        // 本机连 Key 都没有了，服务端那把也吊销不了，同样提示去网页端
        const revoked = conn?.apiKey ? await revokeKey(conn.baseUrl, conn.apiKey) : false
        const planState = await readPlanState()
        await updateSettings((latest) => removePlan(latest, planState.originals))
        await restorePlanStorage()
        await deleteLiteralKey(PLAN_KEY_ID)
        await clearPlanState()
        return { ok: true, data: { revoked, keysUrl: CREATOR_PLAN_KEYS_URL } }
      } catch (error) {
        return fail(error)
      }
    }
  )

  /**
   * 对话里套餐错误提示上的「管理订阅」。地址取缓存的清单，不为这一下发请求；
   * 没有缓存（从没拉成功过）就退到网页端首页。
   */
  ipcMain.handle(
    'creator-plan:campaign',
    async (): Promise<CreatorPlanResult<CreatorPlanCampaign>> => {
      const conn = await planConnection()
      if (!conn?.apiKey) {
        return {
          ok: true,
          data: { open: false, claimed: false, planTitle: null, claimUntil: null, expiresAt: null }
        }
      }
      return fetchCampaign(conn.baseUrl, conn.apiKey)
    }
  )

  ipcMain.handle(
    'creator-plan:campaign-claim',
    async (_event, itchUrl: string): Promise<CreatorPlanResult<{ expiresAt: string | null }>> => {
      const conn = await planConnection()
      if (!conn) return { ok: false, code: 'not_connected', error: 'Not connected' }
      if (!conn.apiKey) return { ok: false, code: 'unauthorized', error: 'Key missing' }
      const result = await claimCampaign(conn.baseUrl, conn.apiKey, String(itchUrl ?? ''))
      // 套餐变了，清单（额度、到期时间）跟着刷新；刷新失败不影响领取结果
      if (result.ok) await refreshPlan().catch(() => undefined)
      return result
    }
  )

  ipcMain.handle('creator-plan:open-manage', async (): Promise<void> => {
    const { manifest } = await readPlanState()
    const url = manifest?.plan.manage_url
    await shell.openExternal(url && /^https?:\/\//.test(url) ? url : CREATOR_PLAN_ORIGIN)
  })
}
