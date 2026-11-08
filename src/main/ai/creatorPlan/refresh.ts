/**
 * 清单刷新：应用启动后一次，之后每 6 小时一次，打开设置页时也走这里。
 *
 * 带上次的 ETag 发 If-None-Match，没变服务端回 304，用缓存的那份；变了就把新清单缓存下来。
 * 不管 200 还是 304，都拿这份清单和配置对一遍账：更新套餐来源里各模型的能力
 * （`refreshPlanModels`），停用的对话模型换成接替者（`migrateRetiredModels`），模型列表跟清单
 * `models` 对齐（`syncPlanModels`：新加的可选模型出现、下线的拿掉），把套餐不再给的
 * 角色还给用户（`releaseDroppedRoles`：还原成导入前的绑定），不再带的存储也还原
 * （`releaseDroppedStorage`）。配置已经一致时一次盘都不写。
 * 401 记成「授权失效」，卡片据此让用户重新连接。
 *
 * **没连接时一个请求都不发**：是否连接只看本机配置里有没有套餐来源，不问网络。
 * 离线启动门禁（verify:offline-boot）守的就是这一条。
 */

import type { CreatorPlanErrorCode, CreatorPlanManifest } from '../../../shared/creatorPlan'
import { resolveApiKey } from '../credentials'
import { readSettings, updateSettings } from '../store'
import {
  isPlanProvider,
  planApiBaseUrl,
  migrateRetiredModels,
  refreshPlanModels,
  releaseDroppedRoles,
  syncPlanModels
} from './apply'
import { CreatorPlanError, fetchManifestIfChanged } from './client'
import { readPlanState, updatePlanState } from './planState'
import { releaseDroppedStorage } from './storage'

export const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000
/** 启动后等一会儿再拉：别和启动时的一堆读盘抢 */
const STARTUP_DELAY_MS = 15_000

/**
 * 已连接时：套餐来源的地址和 Key。没连接回 null。
 * 来源在、Key 却取不出来（密钥库被清、换了机器）时 apiKey 为 null，按「授权失效」处理。
 */
export async function planConnection(): Promise<{
  baseUrl: string
  apiKey: string | null
} | null> {
  const settings = await readSettings()
  const provider = settings.providers.find((p) => isPlanProvider(p.id))
  if (!provider) return null
  const apiKey = await resolveApiKey(provider.apiKey).catch(() => null)
  return { baseUrl: planApiBaseUrl(provider), apiKey: apiKey || null }
}

export interface RefreshOutcome {
  /** 这次拉到的，或者 304 时缓存的那份；出错时为 null */
  manifest: CreatorPlanManifest | null
  error: CreatorPlanErrorCode | null
}

/** 没连接回 null（没发请求） */
export async function refreshPlan(fetchImpl: typeof fetch = fetch): Promise<RefreshOutcome | null> {
  const conn = await planConnection()
  if (!conn) return null
  if (!conn.apiKey) return { manifest: null, error: 'unauthorized' }

  const state = await readPlanState()
  try {
    // 没有缓存的清单时不带 etag：带了会拿到一个 304，却没有东西可用
    const result = await fetchManifestIfChanged(
      conn.baseUrl,
      conn.apiKey,
      state.manifest ? state.etag : null,
      fetchImpl
    )
    // 联网这段时间里用户可能断开了（状态文件已清）：不再把清单写回去、也不再对账
    if (!(await planConnection())) return null
    let manifest: CreatorPlanManifest | null
    if (result.status === 'not_modified') {
      if (state.unauthorized) await updatePlanState({ unauthorized: false })
      manifest = (await readPlanState()).manifest
    } else {
      await updatePlanState({ etag: result.etag, manifest: result.manifest, unauthorized: false })
      manifest = result.manifest
    }
    if (!manifest) return { manifest: null, error: null }
    // 原绑定也按联网之后的来：这期间重新导入可能刚记下新的
    const { originals } = await readPlanState()

    // 304 也要对一遍账：清单可能是连接 / 重新导入预览时缓存的（没落到配置上），
    // 或者上次写配置失败了，或者是老版本缓存的、它还不会迁移。没变化时三个函数原样返回，不写盘。
    // 和用户改角色排在同一队里读改写（updateSettings），不拿旧快照盖掉用户刚改的。
    // 写失败不影响这次的结论：清单照样回给卡片，下一轮（304 也算）再对
    try {
      const cached = manifest
      await updateSettings((settings) =>
        releaseDroppedRoles(
          syncPlanModels(migrateRetiredModels(refreshPlanModels(settings, cached), cached), cached),
          cached,
          originals
        )
      )
      await releaseDroppedStorage(manifest)
    } catch (error) {
      console.warn('[Box Plan] 清单对账没写成，下一轮再试:', error)
    }
    return { manifest, error: null }
  } catch (error) {
    const code = error instanceof CreatorPlanError ? error.code : 'unknown'
    if (code === 'unauthorized' && !state.unauthorized)
      await updatePlanState({ unauthorized: true })
    return { manifest: null, error: code }
  }
}

let timers: { startup: NodeJS.Timeout; interval: NodeJS.Timeout } | null = null

async function tick(): Promise<void> {
  try {
    await refreshPlan()
  } catch (error) {
    // 读盘、写盘出错也不该变成未处理的拒绝；下一轮再试
    console.warn('[Box Plan] 清单刷新失败:', error)
  }
}

/** 启动后一次、之后每 6 小时一次。每一轮都先看有没有连接，没连接不发请求 */
export function startCreatorPlanRefresh(): void {
  if (timers) return
  const startup = setTimeout(() => void tick(), STARTUP_DELAY_MS)
  const interval = setInterval(() => void tick(), REFRESH_INTERVAL_MS)
  // 不因为这两个定时器拖住进程退出
  startup.unref?.()
  interval.unref?.()
  timers = { startup, interval }
}

export function stopCreatorPlanRefresh(): void {
  if (!timers) return
  clearTimeout(timers.startup)
  clearInterval(timers.interval)
  timers = null
}
