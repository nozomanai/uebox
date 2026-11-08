/**
 * Box Plan 的活动（目前只有 2026 Epic AI MegaJam）：参赛登记和交卷。
 *
 * 登记送的试用套餐直接开在盒子连着的那个账户上：选手不用另注册账户，也不用抄兑换码。
 * 交卷只登记作品页；赛后服务端按比赛期间盒子 Key 的用量返到账户余额。
 * 服务端的入口只对盒子开放（用连接时拿到的 Key 认证），网页上没有。
 * 活动开没开、发的是哪个套餐、发没发完都由服务端决定，盒子只照着显示 ——
 * 比赛期间盒子冻结发版，活动要调整只能改服务端。
 *
 * 没连接时不发任何请求（调用方先确认有连接）。
 */

import type {
  CreatorPlanCampaign,
  CreatorPlanErrorCode,
  CreatorPlanResult
} from '../../../shared/creatorPlan'

type Fetch = typeof fetch

const CAMPAIGN_PATH = '/campaigns/megajam'

/** 服务端回的错误码里，盒子认得、能给出具体文案的那几个 */
const CLAIM_CODES = new Set<CreatorPlanErrorCode>([
  'invalid_itch_url',
  'itch_not_found',
  'itch_taken',
  'already_claimed',
  'sold_out',
  'campaign_closed',
  'invalid_entry_url',
  'entry_not_found',
  'unauthorized'
])

const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)

async function errorCodeOf(res: Response): Promise<CreatorPlanErrorCode> {
  if (res.status === 401) return 'unauthorized'
  const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null
  const code = body?.error?.code as CreatorPlanErrorCode | undefined
  return code && CLAIM_CODES.has(code) ? code : 'bad_response'
}

function networkFailure(error: unknown): { ok: false; code: 'network'; error: string } {
  return {
    ok: false,
    code: 'network',
    error: error instanceof Error ? error.message : String(error)
  }
}

/** 活动状态。服务端没有这个接口（老版本）时当作没有活动 */
export async function fetchCampaign(
  baseUrl: string,
  apiKey: string,
  fetchImpl: Fetch = fetch
): Promise<CreatorPlanResult<CreatorPlanCampaign>> {
  let res: Response
  try {
    res = await fetchImpl(`${baseUrl}${CAMPAIGN_PATH}`, {
      headers: { authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(10_000)
    })
  } catch (error) {
    return networkFailure(error)
  }
  if (res.status === 404) {
    return {
      ok: true,
      data: {
        open: false,
        claimed: false,
        planTitle: null,
        claimUntil: null,
        expiresAt: null,
        submitOpen: false,
        submitUntil: null,
        entryUrl: null
      }
    }
  }
  if (!res.ok) return { ok: false, code: await errorCodeOf(res), error: `HTTP ${res.status}` }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  if (!body) return { ok: false, code: 'bad_response', error: 'Invalid JSON' }
  return {
    ok: true,
    data: {
      open: body.open === true,
      claimed: body.claimed === true,
      planTitle: str(body.plan_title),
      claimUntil: str(body.claim_until),
      expiresAt: str(body.expires_at),
      submitOpen: body.submit_open === true,
      submitUntil: str(body.submit_until),
      entryUrl: str(body.entry_url)
    }
  }
}

/** 参赛登记。成功回试用套餐到期时间 */
export async function claimCampaign(
  baseUrl: string,
  apiKey: string,
  itchUrl: string,
  fetchImpl: Fetch = fetch
): Promise<CreatorPlanResult<{ expiresAt: string | null }>> {
  let res: Response
  try {
    res = await fetchImpl(`${baseUrl}${CAMPAIGN_PATH}/claim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ itch_url: itchUrl.trim() }),
      signal: AbortSignal.timeout(15_000)
    })
  } catch (error) {
    return networkFailure(error)
  }
  if (!res.ok) return { ok: false, code: await errorCodeOf(res), error: `HTTP ${res.status}` }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return { ok: true, data: { expiresAt: str(body?.expires_at) } }
}

/** 交卷：itch 上的作品页。可以重交，以最后一次为准。成功回规范化后的作品页地址 */
export async function submitCampaignEntry(
  baseUrl: string,
  apiKey: string,
  entryUrl: string,
  fetchImpl: Fetch = fetch
): Promise<CreatorPlanResult<{ entryUrl: string | null }>> {
  let res: Response
  try {
    res = await fetchImpl(`${baseUrl}${CAMPAIGN_PATH}/submit`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ entry_url: entryUrl.trim() }),
      signal: AbortSignal.timeout(15_000)
    })
  } catch (error) {
    return networkFailure(error)
  }
  if (!res.ok) return { ok: false, code: await errorCodeOf(res), error: `HTTP ${res.status}` }
  const body = (await res.json().catch(() => null)) as Record<string, unknown> | null
  return { ok: true, data: { entryUrl: str(body?.entry_url) } }
}
