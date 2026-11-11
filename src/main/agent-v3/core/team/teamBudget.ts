/**
 * 工作室一局的 token 封顶：制作人、队员、验收员、`task` 子任务累计用到上限就不再发模型请求。
 *
 * ## 为什么要有它
 *
 * 团队模式是自己转的：制作人派活、队员并行干、交付闸往回推，没人在屏幕前也能连跑几小时。
 * 按量计费的套餐上，一局可以把额度烧光。这里设一个停靠点 —— 到顶就停，由人决定要不要接着跑。
 *
 * ## 口径
 *
 * 只数 token，不换算成钱：各家价格不同，套餐和第三方网关多半没有价目表（见 `TeamUsage.unpriced`）。
 *
 * 计入 input + output + cacheWrite，cacheRead 按 0.1 折算。主流厂商的缓存读取价是普通输入的
 * 一折左右；长对话里绝大部分输入是缓存读取，全额计会让开了缓存的模型几件活就到顶，
 * 完全不计又等于对这部分花费不设防。
 *
 * ## 检查放在哪
 *
 * 模型请求的统一关口 `requestGate.ts` 的 `pacedStreamFn`：发请求前问 `refusal()`，
 * 回话结束时 `charge()`。子 agent 经 `...parent` 继承 `SessionContext.teamBudget`，
 * 所以一局里所有人对着同一个数。已经在途的请求不掐，实际用量会比上限多出在途的那几个。
 *
 * ## 续跑
 *
 * 到顶后用户再发一条消息或点「接着跑」，宿主（`ipc/agentV3.ts` 的 `prepareTeam`）调 `raise()`
 * 把上限抬到「已用 + 一档」。自动续跑不经过那里，不会自己抬。
 */

import type { PiUsageLike } from '../../../../shared/agentUsage'

/**
 * 默认一局 2000 万。队员一个请求两三万到六七万 token，一件活几十个请求，
 * 折下来一件活一两百万；2000 万约十来件活加制作人自己的开销，够做完一个小游戏的一轮。
 */
export const DEFAULT_TEAM_TOKEN_LIMIT = 20_000_000

/** 覆盖默认上限的环境变量，正整数 */
export const TEAM_TOKEN_LIMIT_ENV = 'UEBOX_TEAM_TOKEN_LIMIT'

export const CACHE_READ_WEIGHT = 0.1

/** 只看这四项；`TeamUsage`（cost 是数字）和 pi 的 usage（cost 是对象）都能直接传 */
export type TokenCounts = Pick<PiUsageLike, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>

function num(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}

/** 一笔用量按封顶口径折成多少 token */
export function billedTokens(usage: TokenCounts | undefined | null): number {
  return (
    num(usage?.input) +
    num(usage?.output) +
    num(usage?.cacheWrite) +
    num(usage?.cacheRead) * CACHE_READ_WEIGHT
  )
}

/** 一档是多少：环境变量给了正整数就用它，否则用默认值 */
export function teamTokenStep(env: Record<string, string | undefined> = process.env): number {
  const value = Number(env[TEAM_TOKEN_LIMIT_ENV])
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_TEAM_TOKEN_LIMIT
}

/** 2000 万、350 万、9000 —— 给人看的 token 数 */
export function formatTokens(tokens: number): string {
  const rounded = Math.round(tokens)
  return rounded >= 10_000 ? `${Math.round(rounded / 10_000)} 万` : String(rounded)
}

export interface TeamBudget {
  /** 按封顶口径已经用掉多少 */
  spent(): number
  limit(): number
  /** 记一次模型请求的用量 */
  charge(usage: TokenCounts | undefined | null): void
  /** 拿盘上的总账对一次：只往大的方向改，内存里比账上多（在途的活还没入账）就留着 */
  seed(spent: number): void
  /** 沿用落盘的上限。不给就用一档 */
  setLimit(limit: number | undefined): void
  exhausted(): boolean
  /** 到顶了给出拒绝的原因，没到顶给 null */
  refusal(): string | null
  /** 把上限抬到「已用 + 一档」，返回新上限 */
  raise(): number
}

export function createTeamBudget(
  init: { spent?: number; limit?: number; step?: number } = {}
): TeamBudget {
  const step = init.step ?? teamTokenStep()
  let spent = num(init.spent)
  let limit = num(init.limit) || step
  const exhausted = (): boolean => spent >= limit
  return {
    spent: () => spent,
    limit: () => limit,
    charge(usage) {
      spent += billedTokens(usage)
    },
    seed(value) {
      spent = Math.max(spent, num(value))
    },
    setLimit(value) {
      limit = num(value) || step
    },
    exhausted,
    refusal: () =>
      exhausted()
        ? `本局团队已用 ${formatTokens(spent)} token，达到上限 ${formatTokens(limit)}，已停止。` +
          `回复「继续」可再运行 ${formatTokens(step)}。`
        : null,
    raise() {
      limit = Math.ceil(spent) + step
      return limit
    }
  }
}

const budgets = new Map<string, TeamBudget>()

/**
 * 一条工作室会话一份，跨轮共用同一个对象：上一轮派出去还没交回的队员手里拿的就是它，
 * 换一个新的它们的用量就记到旧的那个上去了
 */
export function teamBudgetFor(sessionId: string): TeamBudget {
  let budget = budgets.get(sessionId)
  if (!budget) {
    budget = createTeamBudget()
    budgets.set(sessionId, budget)
  }
  return budget
}
