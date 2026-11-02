/**
 * 外部团队：大脑在外部客户端（Claude Code 等），盒子只当工作室。
 *
 * 设计稿：docs/外部大脑跑团队设计-2026-10-17.md。
 *
 * ## 和盒子里的团队怎么分开
 *
 * 落盘格式完全一样（`teamDirsFor` 那两个目录、`TeamStore` 那几本账），只是团队 id
 * 以 `ext-` 开头，并且多一份 `external.json` 记目标、工程和交付闸状态。
 * 盒子里的团队把这些存在会话的执行记录里（`options.team`）—— 外部团队没有盒子侧的会话，
 * 所以单独存一份。盒子里那条路上的代码一行都不读这份文件，两边互不影响。
 */

import { randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { join } from 'path'
import { sendToAppWindows } from '../../../appWindows'

import type { ApprovalMode } from '../approval'
import type { GoalVerdict } from '../goalLoop'
import type { ThinkingLevelChoice } from '../streamFn'
import { sessionsDir } from '../transcriptStore'
import { applyVerdict, newTeamState, noteWrite, teamDirsFor, type TeamState } from './teamSession'
import type { TeamDirs } from './teamStore'

export const EXTERNAL_TEAM_PREFIX = 'ext-'

const RECORD_FILE = 'external.json'

export interface ExternalTeamRecord {
  id: string
  objective: string
  /** 团队在哪个工程里干。立项时可能还没有，建好工程后用 `team_open` 补上 */
  projectPath?: string
  createdAt: number
  /** 用户或制作人宣布结束的时刻。结束的团队交付闸一律放行 */
  endedAt?: number
  /**
   * 验收员进门的时刻，记下结论时清掉。结论按这个时刻算：验收员开始玩之后才落下的改动，
   * 它没看到，PASS 不能盖过去
   */
  acceptanceStartedAt?: number
  /** 发出去的通行证：谁拿着、是什么角色、手上哪件活。见 `ExternalSeat` */
  seats?: Record<string, ExternalSeat>
  /** 交付闸状态：验收结论、最近一次写工程的时刻。和盒子里的团队同一个形状 */
  state: TeamState
  /**
   * 队员在哪跑。`box` = 混合团队：制作人在外部客户端，队员是盒子里的子 Agent（`hybridTeam.ts`）。
   * 没有 = 队员也是外部客户端里的子 Agent，进门靠 `team_join`
   */
  members?: 'box'
  /**
   * 混合团队：队员的审批档位。`producer`（没有时也是它）= 要问的那几步交给制作人用 team_approve 答，
   * 盒子不弹框；其余三档同盒子输入框里那一档，要问的弹在盒子主窗口上
   */
  approvalMode?: ApprovalMode | 'producer'
  /** 混合团队：队员的思考档位，和另外几队对齐用。没有 = auto */
  thinkingLevel?: ThinkingLevelChoice
  /** 混合团队：开团之后用户最近那句话（制作人带着 team_id 再开时给的 objective）。只带给验收员 */
  latestRequest?: string
}

/**
 * 一张通行证（team_seat）：`team_open` / `team_join` 发给调用方，之后每次调用都带上，
 * 盒子凭它认出「这次是谁」。
 *
 * 角色跟着通行证走，不跟着 MCP 连接走：有的客户端（Kimi Code、Codex、Cursor）的子 Agent 和主会话
 * 共用一条连接，按连接认人就分不清；记在这里，盒子重启、连接重连之后也还认得。
 * 角色发出去就不再变：干过队员的通行证当不了验收员。
 */
export interface ExternalSeat {
  role: 'producer' | 'member' | 'acceptor'
  /** 队员：名册上的名字 */
  member?: string
  /** 队员：手上这件活。交回后清掉，同一张通行证可以再进门接下一件 */
  jobId?: string
  brief?: string
  /** 队员：这件活写过工程。写操作明细只在内存里，盒子重启后靠它决定交回时存不存快照 */
  wrote?: boolean
  /** 验收员：记过结论了，这张通行证用完了 */
  closed?: boolean
  createdAt: number
}

/** 通行证是 `团队id.随机串`：拿到通行证就知道去哪个团队的记录里查，不用扫全部团队 */
export function newSeatId(teamId: string): string {
  return `${teamId}.${randomUUID()}`
}

export function seatTeamId(seat: string): string | undefined {
  const at = seat.lastIndexOf('.')
  const teamId = at > 0 ? seat.slice(0, at) : ''
  return isExternalTeamId(teamId) ? teamId : undefined
}

export function isExternalTeamId(id: string): boolean {
  return id.startsWith(EXTERNAL_TEAM_PREFIX) && /^[a-zA-Z0-9_-]+$/.test(id)
}

/**
 * 交付闸要的事实，给 `team_gate` 和 CLI 用。
 *
 * `passed` 的口径：验收 PASS，并且之后没人再写过工程。PASS 之后又改了，改动没人验过。
 */
export interface ExternalGateFacts {
  teamId: string
  objective: string
  verdict: TeamState['verdict']
  verdictAt: number | null
  lastWriteAt: number | null
  deliveries: number
  passed: boolean
  ended: boolean
  /** 混合团队：还在后台跑的活。有的话制作人该 `team_wait`，不是收工 */
  pendingJobs: number
  /** 混合团队：队员发给制作人、它还没看的话 */
  unreadForProducer: number
}

export function gateFacts(record: ExternalTeamRecord): ExternalGateFacts {
  const { state } = record
  const changedSince =
    state.lastWriteAt !== undefined &&
    state.verdictAt !== undefined &&
    state.lastWriteAt > state.verdictAt
  return {
    teamId: record.id,
    objective: record.objective,
    verdict: state.verdict,
    verdictAt: state.verdictAt ?? null,
    lastWriteAt: state.lastWriteAt ?? null,
    deliveries: state.deliveries,
    passed: state.verdict === 'pass' && !changedSince,
    ended: record.endedAt !== undefined,
    pendingJobs: 0,
    unreadForProducer: 0
  }
}

export interface ExternalTeamRegistry {
  dirsFor(id: string): TeamDirs
  create(
    input: { objective: string; projectPath?: string } & Pick<
      ExternalTeamRecord,
      'members' | 'approvalMode' | 'thinkingLevel'
    >
  ): Promise<ExternalTeamRecord>
  get(id: string): Promise<ExternalTeamRecord | undefined>
  /** 改一份记录。`change` 回 null = 不用改（不落盘） */
  update(
    id: string,
    change: (record: ExternalTeamRecord) => ExternalTeamRecord | null
  ): Promise<ExternalTeamRecord>
  /** 有队员写了工程。只在跨过「上次验收」那条线时落盘，见 `noteWrite` */
  noteWrite(id: string): Promise<void>
  /** 验收员进门。之后记下的结论按这一刻算，见 `acceptanceStartedAt` */
  startAcceptance(id: string): Promise<ExternalTeamRecord>
  recordVerdict(id: string, verdict: GoalVerdict | null): Promise<ExternalTeamRecord>
  /** 按通行证找回团队和那张通行证。认不出来回 undefined */
  getSeat(seat: string): Promise<{ record: ExternalTeamRecord; seat: ExternalSeat } | undefined>
  /** 记下（或改写）一张通行证 */
  putSeat(teamId: string, seat: string, value: ExternalSeat): Promise<void>
  /** 最近的在前 */
  list(): Promise<ExternalTeamRecord[]>
}

export interface ExternalTeamRegistryDeps {
  dirsFor: (id: string) => TeamDirs
  /** 所有团队状态目录的上一级（会话目录）。列团队时扫它 */
  stateRoot: () => string
  now?: () => number
  newId?: () => string
  /** 记录完成落盘后通知项目对话列表；创建团队、补工程路径和验收都不一定改任务板。 */
  onChange?: (id: string) => void
}

export function createExternalTeamRegistry(deps: ExternalTeamRegistryDeps): ExternalTeamRegistry {
  const now = deps.now ?? Date.now
  const newId = deps.newId ?? (() => `${EXTERNAL_TEAM_PREFIX}${randomUUID()}`)
  // 同一个团队的读改写排成一条：几个队员同时写工程时，`noteWrite` 不能互相覆盖
  const chains = new Map<string, Promise<unknown>>()
  // 写工程成功了、但 external.json 没写上的那些时刻。读的时候叠上去，交付闸宁可多拦不放过；
  // 下次写成功就落进文件
  const unsaved = new Map<string, number>()

  const fileFor = (id: string): string => join(deps.dirsFor(id).stateDir, RECORD_FILE)

  async function read(id: string): Promise<ExternalTeamRecord | undefined> {
    if (!isExternalTeamId(id)) return undefined
    try {
      const raw = JSON.parse(await fs.readFile(fileFor(id), 'utf8')) as ExternalTeamRecord
      if (!raw || raw.id !== id || !raw.state) return undefined
      const extra = unsaved.get(id)
      return extra !== undefined && (raw.state.lastWriteAt ?? -Infinity) < extra
        ? { ...raw, state: { ...raw.state, lastWriteAt: extra } }
        : raw
    } catch {
      return undefined
    }
  }

  async function write(record: ExternalTeamRecord): Promise<void> {
    const file = fileFor(record.id)
    await fs.mkdir(deps.dirsFor(record.id).stateDir, { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, JSON.stringify(record, null, 2), 'utf8')
    await fs.rename(tmp, file)
    const extra = unsaved.get(record.id)
    if (extra !== undefined && (record.state.lastWriteAt ?? -Infinity) >= extra) {
      unsaved.delete(record.id)
    }
    try {
      deps.onChange?.(record.id)
    } catch (error) {
      // 文件已经保存，窗口关闭导致通知失败不能把这次写入报成失败。
      console.warn('[AgentV3][ExternalTeam] 通知界面刷新失败:', error)
    }
  }

  function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = chains.get(id) ?? Promise.resolve()
    const next = previous.then(fn, fn)
    chains.set(
      id,
      next.catch(() => undefined)
    )
    return next
  }

  const registry: ExternalTeamRegistry = {
    dirsFor: deps.dirsFor,

    async create({ objective, projectPath, members, approvalMode, thinkingLevel }) {
      const record: ExternalTeamRecord = {
        id: newId(),
        objective,
        ...(projectPath ? { projectPath } : {}),
        ...(members ? { members } : {}),
        ...(approvalMode ? { approvalMode } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
        createdAt: now(),
        state: newTeamState(objective)
      }
      await write(record)
      return record
    },

    get: read,

    update(id, change) {
      return serial(id, async () => {
        const record = await read(id)
        if (!record) throw new Error(`没有这个外部团队：${id}`)
        const next = change(record)
        if (!next) return record
        await write(next)
        return next
      })
    },

    async noteWrite(id) {
      const t = now()
      await registry
        .update(id, (record) => {
          // 验收进行中：「上次验收」那条线其实是验收员进门那一刻，跨过它也要落盘
          const pending = record.acceptanceStartedAt
          if (pending !== undefined && (record.state.lastWriteAt ?? -Infinity) <= pending) {
            return { ...record, state: { ...record.state, lastWriteAt: t } }
          }
          const state = noteWrite(record.state, t)
          return state ? { ...record, state } : null
        })
        .catch((error: unknown) => {
          unsaved.set(id, Math.max(unsaved.get(id) ?? -Infinity, t))
          console.warn('[AgentV3][ExternalTeam] 写工程的时刻没记进 external.json:', error)
        })
    },

    startAcceptance(id) {
      return registry.update(id, (record) => ({ ...record, acceptanceStartedAt: now() }))
    },

    recordVerdict(id, verdict) {
      return registry.update(id, ({ acceptanceStartedAt, ...record }) => ({
        ...record,
        state: applyVerdict(record.state, verdict, acceptanceStartedAt ?? now())
      }))
    },

    async getSeat(seat) {
      const teamId = seatTeamId(seat)
      const record = teamId ? await read(teamId) : undefined
      const value = record?.seats?.[seat]
      return record && value ? { record, seat: value } : undefined
    },

    async putSeat(teamId, seat, value) {
      await registry.update(teamId, (record) => ({
        ...record,
        seats: { ...record.seats, [seat]: value }
      }))
    },

    async list() {
      let names: string[]
      try {
        names = await fs.readdir(deps.stateRoot())
      } catch {
        return []
      }
      const ids = names
        .filter((name) => name.startsWith(EXTERNAL_TEAM_PREFIX) && name.endsWith('.team'))
        .map((name) => name.slice(0, -'.team'.length))
      const records = await Promise.all(ids.map((id) => read(id)))
      return records
        .filter((record): record is ExternalTeamRecord => record !== undefined)
        .sort((a, b) => b.createdAt - a.createdAt)
    }
  }
  return registry
}

let shared: ExternalTeamRegistry | undefined

/**
 * 盒子里只用这一份：MCP 那头（队员写工程、记验收）和界面这头（结束团队）改的是同一个文件，
 * 共用一份才共用同一条读改写的串行链
 */
export function sharedExternalTeamRegistry(): ExternalTeamRegistry {
  shared ??= createExternalTeamRegistry({
    dirsFor: teamDirsFor,
    stateRoot: sessionsDir,
    onChange: (id) => sendToAppWindows('agent-v3:team-board', { sessionId: id })
  })
  return shared
}
