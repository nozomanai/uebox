/**
 * Agent V3 渲染层 API。
 *
 * 渲染层不直接碰 `ipcRenderer`（AGENTS.md 硬规则 4），一律走这里。
 * 事件订阅也收在这一层：通道名散落在各个组件里，将来改名要满仓库找。
 */

import type { AgentTurnUsage } from '@core/shared/agentUsage'
import type { AgentReviewResult, AgentReviewTarget } from '@core/shared/agentReview'
import type {
  DismissalErrorCode,
  ExternalTeamSummary,
  ModelCheckup,
  ModelDossier,
  TeamStateView
} from '@core/shared/agentTeam'
import type { AgentQuestion, AgentQuestionAction } from '@core/shared/agentQuestion'
import type { EditorSnapshotCaptureResult } from '@core/shared/editorSnapshot'
import type { SharedSkillOrigin } from '@core/shared/share'
import { unwrapResult } from '@renderer/common/utils'
import { toSessionProjectPayload } from '@renderer/views/Assistant/composables/sessionProjectBinding'

/** agent 运行过程中推给界面的事件。与主进程 host/eventBridge.ts 的投影一一对应 */
export type AgentV3Event =
  | { type: 'start' }
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      args: unknown
      /** 主进程按这次参数算的风险（预演、只读查询是 safe）。老主进程不带 */
      risk?: 'safe' | 'mutating' | 'destructive'
    }
  | { type: 'tool-progress'; toolCallId: string; toolName: string; partial: unknown }
  | {
      type: 'tool-result'
      toolCallId: string
      toolName: string
      isError: boolean
      text: string
      details: unknown
    }
  | { type: 'step' }
  | { type: 'done' }
  | { type: 'error'; message: string }
  | { type: 'context-usage'; tokens: number; contextWindow: number }
  /** 一次模型往返的计费用量。界面按轮累加后显示在回复下方 */
  | ({ type: 'turn-usage' } & AgentTurnUsage)
  | { type: 'compacting'; tokensBefore: number }
  | {
      type: 'approval-required'
      toolCallId: string
      toolName: string
      namespace: string
      risk: string
      args: unknown
      /** false 时不给「本对话内都允许」——每次都要用户当场看参数再点头 */
      allowAlways?: boolean
    }
  /** agent 反问用户。界面在时间线上长一张选项卡片，答完经 replyQuestion 回传 */
  | { type: 'question-required'; toolCallId: string; questions: AgentQuestion[] }
  /**
   * 这条内核 session **真的**空出来了 —— 主进程把它从登记表摘掉、资产锁也放了。
   *
   * 和 `done` 不是一回事：`done` 是事件流里的最后一条，但它发出来时
   * `prompt()` 还没返回、`finally` 里的 release 还没跑。要接着往同一条内核 session
   * 派下一轮的（排队的跟进消息就是），等这条。
   */
  | { type: 'released' }

/** 通道后缀 → 事件类型。两者同名，这里只是把清单集中一处 */
const EVENT_TYPES = [
  'start',
  'text',
  'thinking',
  'tool-call',
  'tool-progress',
  'tool-result',
  'step',
  'done',
  'error',
  'context-usage',
  'turn-usage',
  'compacting',
  'approval-required',
  'question-required',
  'released'
] as const

interface EventPayload {
  sessionId?: string
  [key: string]: unknown
}

/** 手动压缩的结果。字段与主进程 `agent-v3:compact` 的返回一一对应 */
export type AgentV3CompactResult =
  | {
      success: true
      tokensBefore: number
      tokensAfter: number
      messagesBefore: number
      messagesAfter: number
      contextWindow: number
    }
  | {
      success: false
      /** 见 `agentV3API.compact` 的注释 */
      reason: 'busy' | 'empty' | 'already-compact' | 'too-short' | 'summary-failed' | 'error'
      error?: string
    }

export interface AgentV3SkillSummary {
  name: string
  description: string
  source: 'user' | 'plugin' | 'builtin'
  /** 用户有没有把它关掉。关掉的仍然在清单里 —— 否则「技能」页没法再打开它 */
  enabled: boolean
  /** 从官网共享库装的 */
  shared?: SharedSkillOrigin
}

export const agentV3API = {
  execute(args: {
    sessionId: string
    prompt: string
    mode?: 'agent' | 'ask'
    approvalMode?: AgentV3ApprovalMode
    /** 思考程度。不传等同 auto —— 不指定，随模型自己的默认 */
    thinkingLevel?: AgentV3ThinkingLevel
    /** 「快速」：Codex 订阅走 priority 档，别的模型忽略 */
    fastMode?: boolean
    /** Cursor Context 档 */
    cursorContext?: 'auto' | '256k' | '500k'
    /** 对话归属的 UE 工程；不传主进程就只能拿当前连接当「这个工程」 */
    sessionProject?: AgentV3SessionProject | null
  }) {
    return window.api.agentV3.execute(args)
  },

  /**
   * 抓一份此刻的编辑器状态（闪存）—— 在用户**按下发送那一刻**调。
   *
   * 抓到的东西随消息一起提交，执行时原样用。之所以不能等到主进程收到 `execute`
   * 再抓：排队的消息要等上一轮跑完（可能几分钟），普通消息前面还隔着一次知识库
   * 检索。那时抓到的已经不是用户说话时看的东西了。
   *
   * **永远不抛。** 闪存是发送路上顺带的一步，抓不到就是这条消息不带快照，
   * 绝不能因此让消息发不出去 —— 所以 IPC 层的异常也在这里兜成 `ok: false`。
   *
   * @param runningSessionId 这条对话正在跑时必须传：排队的、插的话最终都落在
   *   那一轮上，得跟着它盯的那个工程抓，不能自己按对话戳重算（没盖戳的对话
   *   会跟着「最近连上的」走，等待期间新连一个工程就抓错了）。
   */
  async captureEditorSnapshot(args: {
    sessionProject?: AgentV3SessionProject | null
    runningSessionId?: string
  }): Promise<EditorSnapshotCaptureResult> {
    try {
      return unwrapResult(
        await window.api.agentV3.captureEditorSnapshot({
          // **必须先拍平。** 调用方多半直接把 store 里那份工程戳递进来，而它是
          // Vue 的响应式代理 —— 结构化克隆搬不动 Proxy，Electron 会抛
          // `An object could not be cloned.`，然后被下面的 catch 吞掉，
          // 表现成「莫名其妙就是没有快照」。同 `toSessionProjectPayload` 的注释。
          sessionProject: toSessionProjectPayload(args.sessionProject),
          ...(args.runningSessionId ? { runningSessionId: args.runningSessionId } : {})
        })
      )
    } catch (error) {
      console.warn('[AgentV3] 闪存抓取失败，这条消息不带快照:', error)
      return { ok: false, reason: 'error' }
    }
  },

  /**
   * 用户在界面上改了这条对话归属哪个工程（顶栏胶囊、侧边栏「归入工程 / 移出项目」）。
   *
   * 归属真正的主人是主进程那张表；随消息捎带的那份戳只在表里还空着时用来初始化。
   * 所以对话发过第一条消息之后，**只改 store 是改不动归属的** —— 胶囊上写着新
   * 工程，引擎命令还发往旧的那个。
   *
   * 失败要抛：主进程把 `{ success: false }` 当正常返回值 resolve，不过
   * `unwrapResult()` 的话 `.catch()` 永远不触发，写失败和写成功在调用方看起来
   * 一模一样 —— 而这里写失败的后果正是界面和引擎对不上。
   *
   * `project: null` = 移出项目。`sessionId` 是**内核** session id。
   */
  async setSessionProject(args: {
    sessionId: string
    project?: AgentV3SessionProject | null
  }): Promise<void> {
    unwrapResult(
      await window.api.agentV3.setSessionProject({
        sessionId: args.sessionId,
        // 同上：store 里那份是响应式代理，不拍平过不了结构化克隆
        project: toSessionProjectPayload(args.project)
      })
    )
  },

  /** 当前绑定的模型支持哪几档思考 —— 档位各家不同，界面据此列清单 */
  thinkingLevels(model?: { providerId: string; modelId: string } | null) {
    return window.api.agentV3.thinkingLevels(
      model ? { model: { providerId: model.providerId, modelId: model.modelId } } : undefined
    )
  },

  /** 这条对话绑定的模型（主进程执行记录里那份）。没绑过为 null */
  sessionModel(sessionId: string) {
    return window.api.agentV3.sessionModel({ sessionId })
  },

  /**
   * 在编辑器里打开「本轮改动」列出的资产。
   *
   * 改动清单只能说「M_GlowBreath 是新建的」，说不清它长什么样 —— 一行字
   * 描述不了一个材质。剩下那一半交给编辑器本身，用户点一下自己看。
   */
  openAsset(contentPath: string) {
    return window.api.agentV3.openAsset({ contentPath })
  },

  continue(
    sessionId: string,
    sessionProject?: AgentV3SessionProject | null,
    approvalMode?: AgentV3ApprovalMode,
    mode?: 'agent' | 'ask'
  ) {
    return window.api.agentV3.continue({
      sessionId,
      mode,
      sessionProject: sessionProject ?? null,
      ...(approvalMode ? { approvalMode } : {})
    })
  },

  /**
   * 改**某条对话**的审批档位。
   *
   * 跑着的时候也要喊一声：主进程的审批门每次工具调用现读档位，喊了就立刻
   * 生效。不喊的话用户在被确认框拦住时调松档位，本轮一个框都不会少弹。
   *
   * `sessionId` 是内核 session id（`chatStore.getAgentSessionId`），不是对话 id。
   */
  setApprovalMode(sessionId: string, approvalMode: AgentV3ApprovalMode, mode?: 'agent' | 'ask') {
    return window.api.agentV3.setApprovalMode({ sessionId, approvalMode, mode })
  },

  steer(sessionId: string, message: string) {
    return window.api.agentV3.steer({ sessionId, message })
  },

  /**
   * 撤回一条还排着的插话。
   *
   * 会 false 是常态而不是故障：「排队中」只是界面上的说法，话早就交给内核了，
   * 用户点下去的那一刻它可能刚好已经被读进上下文 —— 那就撤不回来了。
   * 调用方要把这种情况如实说给用户听，不能画一个撤回成功的样子。
   */
  cancelSteer(sessionId: string, steerId: string) {
    return window.api.agentV3.cancelSteer({ sessionId, steerId })
  },

  stop(sessionId: string) {
    return window.api.agentV3.stop({ sessionId })
  },

  /**
   * 手动压缩这条对话的上下文。
   *
   * 主进程的处理器（`ipc/agentV3.ts` 的 `agent-v3:compact`）和 preload 的透传
   * 一直都在，缺的只是这一层 —— 于是界面上没有任何东西能调它。
   *
   * 会拒绝的几种情况都带 `reason`：`busy`（正跑着，会和自动压缩抢同一份
   * transcript）、`empty`（没有历史）、`already-compact`（压完没变小，
   * 再压是拿摘要生成摘要）、`too-short` / `summary-failed` / `error`。
   * 调用方要把这些如实说给用户听，不能一律报「失败」。
   */
  compact(sessionId: string): Promise<AgentV3CompactResult> {
    return window.api.agentV3.compact({ sessionId }) as Promise<AgentV3CompactResult>
  },

  replyApproval(toolCallId: string, verdict: AgentV3ApprovalVerdict): void {
    window.api.agentV3.replyApproval({ toolCallId, verdict })
  },

  /**
   * 回复 agent 的反问。
   *
   * `answers` 与提问同序，空串表示这一问没选。三态的语义见
   * `shared/agentQuestion.ts` —— `decline` 让模型带着假设继续，
   * `cancel` 让它停下来等人，两者不能混。
   */
  replyQuestion(toolCallId: string, action: AgentQuestionAction, answers?: string[]): void {
    window.api.agentV3.replyQuestion({ toolCallId, action, ...(answers ? { answers } : {}) })
  },

  /**
   * 刷新页面后问主进程：这几条内核 session 里，哪些还在跑？
   *
   * 界面刷新只重启了「显示器」，主进程那台「主机」没停 —— 不问一声就一律
   * 当作中断，是在猜，而且猜错的那一半后台还在改用户的工程。
   */
  reattach(sessionIds: string[]): Promise<{ sessionIds: string[]; pendingApprovals: number }> {
    return window.api.agentV3.reattach({ sessionIds })
  },

  listSessions(): Promise<AgentV3SessionMeta[]> {
    return window.api.agentV3.listSessions()
  },

  /**
   * 盘上全部技能，含来源和开关状态。
   *
   * **关掉的也在里面** —— 设置页要把它们列出来才有得打开。输入框的 `/` 菜单
   * 得自己滤掉 `enabled === false` 的：菜单里摆着一条选了也不会加载的技能，
   * 比不摆更糟。
   */
  listSkills(): Promise<{ skills: AgentV3SkillSummary[] }> {
    return window.api.agentV3.listSkills()
  },

  /**
   * 「设置 → 工具」那一页的清单，含当前接着的第三方 MCP。
   *
   * 开关状态**不在这份清单里**：它存在应用设置的两份名单里（见
   * `appSettingsAPI.getToolPreferences`）。分开是因为清单随引擎/MCP 连接变化，
   * 而用户点过的开关不该跟着变 —— 合成一份的话，MCP 掉线那一刻用户的选择就丢了。
   */
  listTools(): Promise<{ tools: AgentV3ToolSummary[] }> {
    return window.api.agentV3.listTools()
  },

  /** 读一个技能的 SKILL.md 全文（含 frontmatter）。找不到返回 null */
  async readSkill(name: string): Promise<AgentV3SkillDocument | null> {
    return (await window.api.agentV3.readSkill(name)).document
  },

  /**
   * 写回技能正文。内置和插件带的会另存成用户副本。
   *
   * 不吞错：frontmatter 写坏了要让用户当场看见，存下去的话那条技能会
   * 从清单上无声消失。
   */
  async writeSkill(name: string, content: string): Promise<void> {
    const result = await window.api.agentV3.writeSkill({ name, content })
    if (!result.success) throw new Error(result.error)
  },

  /** 关掉 / 打开一个技能。下一轮开始生效 */
  async setSkillDisabled(name: string, disabled: boolean): Promise<void> {
    const result = await window.api.agentV3.setSkillDisabled({ name, disabled })
    if (!result.success) throw new Error(result.error || '切换失败')
  },

  /**
   * 技能页「经验」分组：通用层 + 项目库里各工程的经验，附上次整理的摘要。
   *
   * 读失败抛错：界面要说「读取失败」，不能显示成「还没有经验」。
   */
  async listExperiences(): Promise<{
    entries: AgentV3Experience[]
    lastCuration?: AgentV3CurationSummary
  }> {
    const result = await window.api.agentV3.listExperiences()
    if (!result.success) throw new Error(result.error || '读取失败')
    return {
      entries: result.entries,
      ...(result.lastCuration ? { lastCuration: result.lastCuration } : {})
    }
  },

  async setExperiencePinned(ref: AgentV3ExperienceRef, pinned: boolean): Promise<void> {
    const result = await window.api.agentV3.setExperiencePinned({ ref, pinned })
    if (!result.success) throw new Error(result.error || '操作失败')
  },

  async deleteExperience(ref: AgentV3ExperienceRef): Promise<void> {
    const result = await window.api.agentV3.deleteExperience(ref)
    if (!result.success) throw new Error(result.error || '删除失败')
  },

  async undoLastCuration(): Promise<AgentV3CurationSummary> {
    const result = await window.api.agentV3.undoLastCuration()
    if (!result.success || !result.undone) throw new Error(result.error || '撤销失败')
    return result.undone
  },

  loadSession(sessionId: string): Promise<{ messages: unknown[] }> {
    return window.api.agentV3.loadSession({ sessionId })
  },

  deleteSession(sessionId: string) {
    return window.api.agentV3.deleteSession({ sessionId })
  },

  /**
   * 分支：把内核 transcript 复制成一个新 sessionId。
   *
   * 返回的新 id 由调用方挂到新对话上 —— 内核按 sessionId 恢复历史，
   * 新对话下一轮自然带着分支点之前的上下文。
   *
   * `keepUserTurns` 是分支点：只复制前这么多个用户轮次，后面的丢掉。
   * 不给就整份复制（从最后一条回复分支时就是这样）。
   *
   * 对话跑着的时候也能从**更早的一轮**分支，源对话继续输出；整份复制和
   * 「切点就落在这一轮里」仍然回 `busy`，那时该等它收尾。
   */
  forkSession(
    sessionId: string,
    keepUserTurns?: number
  ): Promise<{
    success: boolean
    sessionId?: string
    messageCount?: number
    reason?: 'busy' | 'missing'
    error?: string
  }> {
    return window.api.agentV3.forkSession({ sessionId, keepUserTurns })
  },

  /**
   * 把内核 transcript 截回前 `keepUserTurns` 轮。
   *
   * 「重新生成」「编辑消息」用：界面删掉的是气泡，内核那份历史每轮都从盘上
   * 恢复，不截的话模型看着刚被丢掉的答案再答一遍。
   */
  truncateSession(
    sessionId: string,
    keepUserTurns: number
  ): Promise<{
    success: boolean
    messageCount?: number
    dropped?: number
    reason?: 'busy' | 'missing'
    error?: string
  }> {
    return window.api.agentV3.truncateSession({ sessionId, keepUserTurns })
  },

  /**
   * 侧边问一句：复制一份上下文出去给小窗口。
   *
   * 和 `forkSession` 的区别是**连正在输出的这一轮也一起带走**：那边跑着的时候
   * 只肯从更早的一轮分（切点必须已经收尾），这边要的恰恰是此刻的现场 ——
   * 「它现在在干嘛」这个问题只在跑着的时候才有人问。
   */
  forkForSideQuestion(sessionId: string): Promise<{
    success: boolean
    sessionId?: string
    messageCount?: number
    live?: boolean
    reason?: 'empty' | 'error'
    error?: string
  }> {
    return window.api.agentV3.forkForSideQuestion({ sessionId })
  },

  /**
   * 审查本轮改动。
   *
   * 问的是引擎的当前状态（资产在不在、落盘没有、蓝图编译过不过、引用断没断），
   * 不是让模型回忆自己做过什么 —— 它记得自己调用成功了，所以永远回答「都好了」。
   */
  reviewChanges(targets: AgentReviewTarget[]): Promise<AgentReviewResult> {
    return window.api.agentV3.reviewChanges({ targets })
  },

  /** 这条内核 session 的目标。没有、或者查不到时给 null */
  async goalState(sessionId: string): Promise<{ objective: string; settled: boolean } | null> {
    const result = await window.api.agentV3.goalState({ sessionId })
    return result?.goal ?? null
  },

  /** 取消目标。不走 `unwrapResult()`，理由同 `teamEnd`：失败要在那一行就地说 */
  goalEnd(sessionId: string): Promise<{ success: boolean; error?: string; errorKey?: 'running' }> {
    return window.api.agentV3.goalEnd({ sessionId })
  },

  /** 工作室模式的任务板。不是工作室的内核 session、或者查不到时给 null */
  async teamState(sessionId: string): Promise<TeamStateView | null> {
    const result = await window.api.agentV3.teamState({ sessionId })
    return result?.team ?? null
  },

  /** 外部驱动的对话，最近的在前。读取失败抛出，由列表保留上一次快照。 */
  async externalTeams(): Promise<ExternalTeamSummary[]> {
    const result = await window.api.agentV3.externalTeams()
    return unwrapResult({ ...result, data: result?.teams ?? [] })
  },

  onTeamBoardChanged(callback: (sessionId: string) => void): () => void {
    const handler = window.api.on('agent-v3:team-board', (...args: unknown[]) => {
      const payload = args[0] as { sessionId?: string } | undefined
      if (payload?.sessionId) callback(payload.sessionId)
    })
    return () => window.api.off('agent-v3:team-board', handler)
  },

  /**
   * 任务板上的两个出口：重开一项、结束团队模式。
   *
   * 不走 `unwrapResult()`：两个都是用户点出来的动作，失败要在面板上就地说一句
   * （「正在跑，等这一轮结束再结束」），不是抛到全局去（见 AGENTS.md 第 5 节第 5 条）。
   */
  teamTaskReopen(sessionId: string, taskId: string): Promise<{ success: boolean; error?: string }> {
    return window.api.agentV3.teamTaskReopen({ sessionId, taskId })
  },

  teamJobReopen(sessionId: string, jobId: string): Promise<{ success: boolean; error?: string }> {
    return window.api.agentV3.teamJobReopen({ sessionId, jobId })
  },

  /** 任务板上给队员换模型。同上，不走 `unwrapResult()`：失败在面板上就地说 */
  teamMemberModel(
    sessionId: string,
    name: string,
    model: { providerId: string; modelId: string }
  ): Promise<{ success: boolean; error?: string; checkup?: ModelCheckup }> {
    return window.api.agentV3.teamMemberModel({ sessionId, name, ...model })
  },

  /** 任务板上辞退队员。同上，不走 `unwrapResult()`：失败按 errorKey 在面板上就地说 */
  teamMemberDismiss(
    sessionId: string,
    name: string,
    reason: string
  ): Promise<{ success: boolean; error?: string; errorKey?: DismissalErrorCode }> {
    return window.api.agentV3.teamMemberDismiss({ sessionId, name, reason })
  },

  teamEnd(sessionId: string): Promise<{ success: boolean; error?: string; errorKey?: 'running' }> {
    return window.api.agentV3.teamEnd({ sessionId })
  },

  /** 设置「团队」页的模型档案 */
  async teamModels(): Promise<ModelDossier[]> {
    const result = await window.api.agentV3.teamModels()
    return result?.models ?? []
  },

  /** 「重新检测」。不走 `unwrapResult()`：结论要显示在那一行上，不抛到全局 */
  teamModelCheckup(model: {
    providerId: string
    modelId: string
  }): Promise<{ success: boolean; error?: string; checkup?: ModelCheckup }> {
    return window.api.agentV3.teamModelCheckup(model)
  },

  invalidateProviders() {
    return window.api.agentV3.invalidateProviders()
  },

  /**
   * 删掉用户自己那几条技能，返回真的删掉了几条。
   *
   * 名字对不上的静默跳过 —— 用户要的结果（那条不在了）已经成立。
   * 内置和插件带的删不掉：主进程只在用户技能目录里找。
   */
  async deleteSkills(names: string[]): Promise<number> {
    const result = await window.api.agentV3.deleteSkills(names)
    if (!result.success) throw new Error(result.error || '删除技能失败')
    return result.deleted
  },

  smoke(): Promise<AgentV3SmokeReport> {
    return window.api.agentV3.smoke()
  },

  /**
   * 订阅某条内核 session 的全部事件。返回取消订阅函数。
   *
   * 按 sessionId 过滤：多窗口 / 多标签同时开着不同对话时，
   * 不过滤会把别人的消息渲染到自己的对话里。
   */
  subscribe(sessionId: string, handler: (event: AgentV3Event) => void): () => void {
    const disposers = EVENT_TYPES.map((type) => {
      const listener = (...args: unknown[]): void => {
        // preload 的 on() 把 IpcRendererEvent 剥掉了，第一个参数就是 payload
        const payload = args[0] as EventPayload | undefined
        if (!payload || payload.sessionId !== sessionId) return
        // sessionId 只用于路由，不进事件对象 —— 订阅方已经知道自己订的是哪条内核 session
        const rest = { ...payload }
        delete rest.sessionId
        handler({ type, ...rest } as AgentV3Event)
      }
      // preload 的 on() 包了一层再挂上去，返回的是那一层；off() 要的是它，不是 listener ——
      // 传 listener 的话一个都摘不掉，同一条 session 再订一次就会收到两份事件
      const handle = window.api.on(`agent-v3:${type}`, listener)
      return () => window.api.off(`agent-v3:${type}`, handle)
    })

    return () => disposers.forEach((dispose) => dispose())
  }
}
