/**
 * 工作室模式挂到一条会话上要的东西：落盘位置、跨轮状态、交付闸。
 *
 * ## 交付闸
 *
 * 设计稿唯一的一条硬规则（§5）：没过独立验收不算交付。制作人收尾时要是还没过，
 * 这里替它补一句「还没过验收」，最多补两次 —— 真卡住需要用户拍板的时候，
 * 它得有机会停下来把话说完，而不是被无限推着转。
 *
 * 判「收尾」的口径和 `/goal` 一样（见 `goalLoop.ts`）：这一轮没再调工具、
 * 正常结束（`stopReason === 'stop'`）。报错、被停下、超长都不算。
 *
 * 收尾时还要对一次任务板：这一轮改了工程，上一轮的「进行中 / 卡住」却一项没动，
 * 补一句让它更新（每轮一次，也算在上面那两次里）。见 `boardRecap.ts`。
 */

import type { AgentEvent } from '@earendil-works/pi-agent-core'
import { app } from 'electron'
import { join } from 'path'

import { safeSessionFileBase, sessionsDir } from '../transcriptStore'
import type { GoalVerdict } from '../goalLoop'
import type { TeamDirs } from './teamStore'

export interface TeamState {
  objective: string
  /**
   * 开团之后用户最近说的那句话（`/team` 那一轮没有）。验收员看不到对话，
   * 要靠它知道用户中途改了什么；任务板也把它显示在委托下面。同 `/goal` 的 `latestRequest`
   */
  latestRequest?: string
  /** 最近一次验收的结论。null = 还没交过，或者结论读不出来 */
  verdict: GoalVerdict['kind'] | null
  deliveries: number
  /** 这一轮已经被交付闸推了几次。每条真人消息清零 */
  nudges: number
  /** 最近一次验收的时刻 */
  verdictAt?: number
  /** 这一轮（最近一条真人消息）开始的时刻 */
  roundStartedAt?: number
  /**
   * 制作人自己最近一次改工程的时刻（队员的改动记在 `activity.json`）。
   * 判「验收之后改没改过」「这一轮改没改过」用，不是每次写都落盘 —— 见 `noteWrite`
   */
  lastWriteAt?: number
  /** 这一轮已经为任务板提醒过了。每条真人消息清零 */
  boardNudged?: boolean
}

export const MAX_TEAM_NUDGES = 2

export function newTeamState(objective: string): TeamState {
  return { objective, verdict: null, deliveries: 0, nudges: 0 }
}

/**
 * 跟着用户走、不跟着某个团队走的那两份账：入职体检、履历（见 `teamModels.ts`）。
 * 不放在 `team/` 下面：那里一个会话一个目录，目录名是会话 id
 */
export function teamModelsDir(): string {
  return join(app.getPath('userData'), 'team-models')
}

/** 履历（`trackRecord.ts`） */
export function trackRecordFile(): string {
  return join(teamModelsDir(), 'track-record.jsonl')
}

export function teamDirsFor(sessionId: string): TeamDirs {
  const base = safeSessionFileBase(sessionId)
  return {
    stateDir: join(sessionsDir(), `${base}.team`),
    workspaceDir: join(app.getPath('userData'), 'team', base)
  }
}

/** 验收结论落进状态。读不出结论按 fail 算：交付闸不能被一句含糊话放过去 */
export function applyVerdict(
  state: TeamState,
  verdict: GoalVerdict | null,
  now: number = Date.now()
): TeamState {
  return {
    ...state,
    verdict: verdict?.kind ?? 'fail',
    verdictAt: now,
    deliveries: state.deliveries + 1
  }
}

/** 一条新的真人消息：新的一轮。提醒次数清零，记下这一轮从什么时候开始 */
export function startTeamRound(state: TeamState, now: number = Date.now()): TeamState {
  return { ...state, nudges: 0, boardNudged: false, roundStartedAt: now }
}

/**
 * 制作人改了一次工程。要不要落盘：只有它跨过了「这一轮开始」或「上次验收」
 * 这两条线才要 —— 那两个判断只关心「之后有没有改过」，不关心改了几次。
 * 返回 null = 不用落盘。
 */
export function noteWrite(state: TeamState, now: number = Date.now()): TeamState | null {
  const last = state.lastWriteAt
  const line = Math.max(state.roundStartedAt ?? 0, state.verdictAt ?? 0)
  if (last !== undefined && last > line) return null
  return { ...state, lastWriteAt: now }
}

/**
 * 交付闸提醒。以 `role: 'user'` 进上下文，所以开头必须说清「这不是用户在说话」，
 * 不然模型会回一句「好的，按你说的继续」。
 */
export function buildTeamNudge(state: TeamState): string {
  const why =
    state.verdict === 'fail'
      ? 'The last acceptance run failed.'
      : 'The game has not been through acceptance yet.'
  return [
    '[team mode · automatic check] This is not the user speaking.',
    `${why} Delivery only counts once \`team_deliver\` returns PASS.`,
    'Keep working toward it. If you genuinely cannot go on without the user, say exactly what you need from them and stop.'
  ].join('\n')
}

export interface TeamGateDeps {
  getState: () => TeamState
  setState: (next: TeamState) => Promise<void>
  followUp: (text: string) => void
  report: (message: string) => void
  /**
   * 制作人想收尾时，还有后台的活没交回来、或者信箱里有没看的留言：先把这些处理掉。
   * `continued` = 等到了一件活交回来，结论已经插进制作人的下一步，循环会自己接着跑；
   * `followUp` = 要补一句话让它接着干。都没有就给 null。
   */
  awaitTeam?: (signal?: AbortSignal) => Promise<{ continued?: boolean; followUp?: string } | null>
  /**
   * 任务板对账：这一轮改了工程、旧账却没动的话，给出要补的那句提醒；不用提醒给 null。
   * 见 `boardRecap.ts` 的 `buildBoardNudge`
   */
  checkBoard?: (state: TeamState) => Promise<string | null>
}

export function createTeamGate(
  deps: TeamGateDeps
): (event: AgentEvent, signal?: AbortSignal) => Promise<void> {
  return async (event, signal) => {
    if (event.type !== 'turn_end') return
    // 还在调工具 = 没打算收尾
    if (event.toolResults.length > 0) return
    const { stopReason } = event.message as { stopReason?: string }
    if (stopReason !== 'stop') return

    // 后台还有队员在干活：团队没收工，制作人不能先走
    const team = await deps.awaitTeam?.(signal)
    if (team?.continued) return
    if (team?.followUp) {
      deps.followUp(team.followUp)
      return
    }

    const state = deps.getState()
    if (!state.boardNudged && state.nudges < MAX_TEAM_NUDGES && deps.checkBoard) {
      const nudge = await deps.checkBoard(state)
      if (nudge) {
        await deps.setState({ ...state, nudges: state.nudges + 1, boardNudged: true })
        deps.report('任务板还是上一轮的说法，已提醒制作人更新。')
        deps.followUp(nudge)
        return
      }
    }

    // 过了就放行；BLOCKED 是验收员说「这得用户来」，也放行让制作人把话说完
    if (state.verdict === 'pass' || state.verdict === 'blocked') return
    if (state.nudges >= MAX_TEAM_NUDGES) return

    await deps.setState({ ...state, nudges: state.nudges + 1 })
    deps.report(
      state.verdict === 'fail'
        ? '上次验收没过，已提醒制作人接着修。'
        : '还没过独立验收，已提醒制作人继续。'
    )
    deps.followUp(buildTeamNudge(state))
  }
}
