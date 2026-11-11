/**
 * Agent V3 IPC。
 *
 * V2 的 `agent:*` 契约及其兼容投影层已随界面改造一起删除。
 */

import { ipcMain, webContents, type WebContents } from 'electron'
import { randomUUID } from 'crypto'

import type { ImageContent } from '@earendil-works/pi-ai'
import { admitPromptImages } from '../agent-v3/core/admitPromptImages'
import {
  describePromptMedia,
  mediaRefText,
  preparePromptImages,
  preparePromptMedia,
  type PromptMediaFile
} from '../agent-v3/core/promptMedia'
import { formatAttachmentBlock, savePromptAttachments } from '../agent-v3/core/promptAttachments'
import { runAgentV3Smoke } from '../agent-v3/smoke'
import {
  adoptSessionBinding,
  forgetSessionBinding,
  getSessionBinding,
  setSessionBinding
} from '../agent-v3/core/sessionBinding'
import {
  getTargetConnectionId,
  runWithTargetConnectionId
} from '../agent-v3/core/projectTargetContext'
import { projectPathKey } from '../agent-v3/core/projectPathKey'
import {
  forceReleaseAll,
  listLocks,
  releaseAll,
  runWithLockOwner,
  setLockChangeListener,
  setLockConflictNotifier,
  setLockReleaseListener
} from '../agent-v3/core/assetLock'
import type { LockRecord } from '../agent-v3/core/assetLock'
import { createLockPusher } from '../agent-v3/core/assetLockPush'
import {
  listEnforced,
  releaseEnforcement,
  setEnforcementChangeListener,
  setLockRepublishTrigger
} from '../agent-v3/core/assetLockEnforcement'
import {
  resolveSessionScope,
  type ConnectedProjectRef,
  type LibraryProjectRef,
  type SessionProjectRef,
  type SessionProjectScope
} from '../agent-v3/core/sessionScope'
import { getPublicDatabase } from '../sqliteDataBase'
import { getAllProjects } from '../sqliteDataBase/models/project'
import { projectManager } from '../services/project/projectManager'
import { collectToolDiagnostics } from '../agent-v3/toolDiagnostics'
import { isShellAvailable } from '../agent-v3/tools/builtin/localShell'
import { effectiveRisk, type ToolMeta, type ToolRisk } from '../agent-v3/tools/defineTool'
import {
  currentStatuses,
  ensureConnected,
  mcpSettingsPath,
  readMcpSettings,
  reconnectMcp,
  writeMcpSettings,
  startMcpServer,
  disableMcpServer,
  mcpServerStatus,
  readHostSettings,
  rotateHostToken,
  applyMcpServerConfig,
  mcpSessionSource,
  type McpServerHostOptions,
  type McpServerHostStatus,
  type McpServerConfig,
  type McpSettings
} from '../agent-v3/capabilities/mcp'
import { clientConfigSnippet, hostUrl } from '../agent-v3/capabilities/mcp/hostStore'
import { installMcpClient, type McpClientId } from '../agent-v3/capabilities/mcp/clientInstall'
import { listToolCatalog, listToolRisks } from '../agent-v3/tools/registry'
import {
  restoreAssetSnapshot,
  snapshotAsset,
  type AssetSnapshotEntry
} from '../agent-v3/core/assetSnapshot'
import { openAssetInEditor } from '../agent-v3/core/openAsset'
import { reviewChanges } from '../agent-v3/core/reviewChanges'
import type { AgentReviewTarget } from '../../shared/agentReview'
import type {
  AgentStartRejectionCode,
  SteerRejectionCode,
  SteerRejectionErrorParams
} from '../../shared/agentRunRejection'
import {
  createUnrealAgent,
  NoConclusionError,
  runSubAgent,
  type EngineFacts,
  type SessionContext
} from '../agent-v3/core/createAgent'
import type { SessionProjectCandidate } from '../agent-v3/tools/builtin/setSessionProject'
import {
  captureEditorSnapshot,
  formatEditorSnapshotBlock,
  snapshotMatchesScope,
  type CaptureResult,
  type EditorSnapshot
} from '../agent-v3/core/editorSnapshot'
import {
  EDITOR_SCREENSHOT_DEFAULT,
  runWithEditorScreenshotScope
} from '../agent-v3/core/editorScreenshotScope'
import {
  AUDITOR_HARD_JUDGES,
  buildAuditPrompt,
  checkGoalPreconditions,
  createGoalLoop,
  parseGoalCommand
} from '../agent-v3/core/goalLoop'
import { billedTokens, teamBudgetFor } from '../agent-v3/core/team/teamBudget'
import { activeLoop, parseTeamCommand } from '../agent-v3/core/team/teamCommand'
import { runWithEditorKey } from '../agent-v3/core/team/editorKey'
import { createTeamStore } from '../agent-v3/core/team/teamStore'
import { runningHybridTeam } from '../agent-v3/core/team/hybridTeam'
import { createTeamLive, type TeamLive } from '../agent-v3/core/team/teamLive'
import { awaitTeamWork } from '../agent-v3/core/team/teamWait'
import { assignMemberModel, loadTeamModels, recordReopen } from '../agent-v3/core/team/teamModels'
import { createTrackRecord } from '../agent-v3/core/team/trackRecord'
import { loadModelDossiers, recheckModel } from '../agent-v3/core/team/modelDossier'
import { teamModelCandidates, type TeamStateView } from '../../shared/agentTeam'
import { readSettings as readAiSettings } from '../ai/store'
import { setProviderUsageProbe } from '../ai/providerUsage'
import { DEFAULT_GOAL_MAX_ROUNDS, normalizeGoalMaxRounds } from '../../shared/goalRounds'
import { buildCrashNotice, type EditorWatchEvent } from '../agent-v3/core/team/editorWatch'
import { startTeamEditorWatch } from './teamEditorWatch'
import {
  endExternalTeam,
  externalTeamExists,
  isExternalTeamId,
  isHybridTeam,
  listExternalTeams,
  readExternalTeamState
} from './externalTeams'
import { createTeamSnapshots } from './teamSnapshots'
import {
  applyVerdict,
  createTeamGate,
  newTeamState,
  noteWrite,
  startTeamRound,
  teamDirsFor,
  trackRecordFile,
  type TeamState
} from '../agent-v3/core/team/teamSession'
import {
  buildBoardNudge,
  carryOverTasks,
  changedSince,
  formatBoardCarryOver,
  reopenedJobTask,
  verdictIsStale
} from '../agent-v3/core/team/boardRecap'
import {
  DismissalError,
  dismissMember,
  formatUserDismissals
} from '../agent-v3/core/team/dismissal'
import {
  createRuntimeScopeId,
  formatLocalNow,
  lastRuntimeScopeId,
  runWithRuntimeScope,
  withRuntimeEnvelope,
  type RuntimeEnvelope
} from '../agent-v3/core/runtimeEnvelope'
import { deleteCheckpoint } from '../agent-v3/core/compactionCheckpoint'
import type { ApprovalMode } from '../agent-v3/core/approval'
import { createEventBridge } from '../agent-v3/host/eventBridge'
import { createAutoResume, type AutoResumeHooks } from '../agent-v3/core/autoResume'
import {
  cancelSteer,
  formatSteerContextBlock,
  markSteerDelivered,
  queueSteer,
  type PendingSteer
} from '../agent-v3/host/steerQueue'
import { ActiveRuns } from '../agent-v3/host/activeRuns'
import {
  copyExecutionOptions,
  deleteExecutionOptions,
  loadExecutionOptions,
  resumeExecutionOptions,
  saveExecutionOptions,
  type SessionExecutionOptions
} from '../agent-v3/core/sessionExecutionOptions'
import {
  pinnableSessionModel,
  resolveSessionModel,
  type SessionModel
} from '../agent-v3/core/sessionModel'
import {
  isUserAbort,
  planResume,
  repairPendingQuestions,
  trimForResume,
  trimDanglingToolCalls
} from '../agent-v3/core/resume'
import { currentTurnHasImages } from '../agent-v3/core/visionRouting'
import { compactMessages, measureCompaction } from '../agent-v3/core/compaction'
import { createApprovalRequester, resendPendingApprovals } from '../agent-v3/host/approvalChannel'
import { createQuestionRequester, resendPendingQuestions } from '../agent-v3/host/questionChannel'
import {
  invalidateProviderCache,
  listThinkingLevels,
  resolveAgentModel,
  type ThinkingLevelChoice
} from '../agent-v3/core/streamFn'
import {
  TranscriptStore,
  deleteTranscript,
  forkTranscript,
  listTranscripts,
  loadTranscript,
  truncateTranscript
} from '../agent-v3/core/transcriptStore'
import { restoreTranscript, withoutSystemMessages } from '../agent-v3/core/systemMessages'
import { notifyAgentRun } from '../agent-v3/host/runObserver'
import { isVoiceTaskSession } from './realtimeVoice'
import { serviceManager } from '../services'
import type { Agent, AgentMessage } from '@earendil-works/pi-agent-core'
import { estimateContextTokens } from '../agent-v3/vendor/pi-harness'
import {
  deleteUserSkills,
  discoverSkillsOnDisk,
  listSkillSummaries,
  readDisabledSkills,
  readSkillDocument,
  setSkillDisabled,
  writeSkillDocument,
  type SkillLearningMode
} from '../agent-v3/capabilities/skills'
import { readUserInstructions } from '../agent-v3/capabilities/userInstructions'
import {
  deleteExperience,
  listExperiences,
  parseExperienceRef,
  setExperiencePinned,
  undoLastCuration,
  type LibraryProject
} from '../agent-v3/experience/library'
import { experienceHome, experienceHomeContext } from '../agent-v3/experience/scheduler'
import { currentMainLanguage } from '../i18n'

/** 活跃会话。stop / steer 要能找到对应的 Agent 实例，停止还要能等它收尾 */
interface ActiveAgentRun {
  kind: 'agent' | 'history'
  agent?: Agent
  senderId: number
  store?: TranscriptStore
  controller: AbortController
  /**
   * 这一轮钉住的目标工程。跑起来之后写进去，插话抓闪存时读它。
   *
   * 插话不在 `runWithTargetConnectionId` 的执行流里，自己重新解析对话戳算出来的
   * 未必是**正在跑的那轮**的工程（没盖戳的对话跟着「最近连上的」走）。而插话说的
   * 是「改这个」，它必须和正在跑的那轮盯着同一个工程，否则「这个」根本不存在。
   */
  scope?: SessionProjectScope
  /**
   * 已经交给内核、但还没被读进上下文的插话。界面上那个「撤回」按钮读它。
   *
   * 挂在这一轮上而不是全局表里：它必须跟着这一轮一起消失，理由见 `steerQueue.ts`。
   */
  pendingSteers: PendingSteer[]
  /**
   * 这一轮跑的是哪个模型。插话带音视频时要据此判断能不能换成链接直接给它看 ——
   * 插话不换模型，所以只能按正在跑的这个判断。
   */
  selection?: { providerId: string; modelId: string }
  /**
   * 这一轮已经收尾（内核发了 `agent_end`）或被叫停，只是还没从表里摘掉。
   *
   * 内核最后一次读插话队列在 `agent_end` 之前；之后的收尾（落盘、复核）还要一阵，
   * 这时候进来的插话会排进一个再也没人读的队列 —— 回「成功」、话却永远丢了。
   * 所以一见到收尾就不再收插话，让调用方把这句留着当下一轮发。
   */
  ending?: boolean
  /**
   * 插话按到达的顺序进内核。带音视频的那条要等上传，后到的纯文字不能插到它前面 ——
   * 模型会先读到「把旧的删掉」，再读到它指的那段视频。
   */
  steerChain?: Promise<void>
}

/**
 * 自动续跑（`core/autoResume.ts`）的宿主一侧：告诉界面、记日志、续跑前落盘。
 *
 * 界面只拿结构化的几项，文案归渲染层（双语）。
 */
function autoResumeHooks(
  sessionId: string,
  run: ActiveAgentRun,
  store: TranscriptStore,
  emit: (channel: string, payload: unknown) => void
): Pick<AutoResumeHooks, 'onScheduled' | 'onResume'> {
  return {
    onScheduled: (notice) => {
      const line =
        `[AgentV3] 会话 ${sessionId} ${notice.persistent ? '模型请求失败（自动断点续传）' : '模型连接中断'}，` +
        `${notice.delayMs / 1000} 秒后自动续跑` +
        `（第 ${notice.attempt}/${notice.maxAttempts} 次）：${notice.reason.slice(0, 160)}`
      // 进本地日志文件：console 不进 `unreal-agent.log`
      void import('../services/electronLog')
        .then(({ logger }) => logger.warn(line))
        .catch(() => console.warn(line))
      emit('agent-v3:auto-resume', {
        sessionId,
        attempt: notice.attempt,
        maxAttempts: notice.maxAttempts,
        delayMs: notice.delayMs,
        persistent: notice.persistent
      })
    },
    onResume: async (plan) => {
      // 失败标记已经在 agent_end 时落盘了，这里整份重写掉 —— 不然下次恢复又读回来，
      // 而新的消息会接在它后面，盘上的上下文从此不自洽。同「从断点继续」
      await store.append(plan.messages, { strict: true })
      // 又要开始收插话了：`agent_end` 那一刻标的「收尾中」只对那次失败成立
      run.ending = false
    }
  }
}

/**
 * 设置里的「自动断点续传」开没开，每次开跑时读。
 *
 * 懒加载：`appSettingsManager` 会顺着 services 拉进一大串（见 AGENTS.md 第 7 节）。
 * 读不到按关着算 —— 开关只放宽重试，关着就是原来的行为。
 */
async function persistentAutoResumeEnabled(): Promise<boolean> {
  try {
    const { appSettingsManager } = await import('../appSettingsManager')
    return appSettingsManager.getSettings().agentPersistentAutoResume !== false
  } catch {
    return false
  }
}

/**
 * 设置里的「目标模式最多几轮」，每次开跑时读。读不到按默认 —— 和没改过设置一样。
 *
 * 在挂监听**之前**读好传进去，不把 `attachGoalLoop` 改成异步：那样订阅会晚于
 * 开跑，开头几个事件就漏了。
 */
async function goalMaxRounds(): Promise<number> {
  try {
    const { appSettingsManager } = await import('../appSettingsManager')
    return normalizeGoalMaxRounds(appSettingsManager.getSettings().agentGoalMaxRounds)
  } catch {
    return DEFAULT_GOAL_MAX_ROUNDS
  }
}

/** 这一轮还收不收插话：没收尾、没被叫停 */
function acceptsSteer(entry: ActiveAgentRun): boolean {
  return !entry.ending && !entry.controller.signal.aborted
}
const activeAgents = new ActiveRuns<ActiveAgentRun>()
const deletingSessions = new Set<string>()

/**
 * 正在跑的 agent 轮次，以及各自是哪个窗口发起的。
 *
 * 给独立对话窗口用（`chatWindowManager.ts`）：一条对话可能是主窗口发起、
 * 却显示在独立窗口里，那边的流式状态里没有这一轮，判忙和停止都得靠这张表。
 * 分叉、截断这类历史操作不算 —— 它们一闪而过，也不会让界面显示「在跑」。
 */
export function activeRunOwners(): Array<{ sessionId: string; senderId: number }> {
  return activeAgents
    .entries()
    .filter(([, entry]) => entry.kind === 'agent')
    .map(([sessionId, entry]) => ({ sessionId, senderId: entry.senderId }))
}

/** 这个窗口名下还有没收摊的操作（按内核 session 算）。独立窗口关窗时据此决定先藏起来等它跑完 */
export function hasActiveRunsOwnedBy(webContentsId: number): boolean {
  return activeAgents.entries().some(([, entry]) => entry.senderId === webContentsId)
}

export function onActiveRunsChanged(listener: () => void): () => void {
  return activeAgents.onChange(listener)
}

/**
 * 现在还有几项操作没收摊（按内核 session 算）：AI 轮次、分叉 / 截断 / 压缩这类历史操作都算
 * —— 表里的条目覆盖了从占位、进行中到收尾的整段。托盘「退出」拿它决定
 * 要不要先问一句 —— 直接退会把干到一半的活撂在引擎里。
 */
export function countActiveSessionOperations(): number {
  return activeAgents.entries().length
}

/**
 * 正在跑的对话里有几个用着这个服务商：制作人自己的模型，或团队名册里钉了它的队员。
 * 设置页删服务商前问这个（见 `ai/providerUsage.ts`）
 */
async function countRunsUsingProvider(providerId: string): Promise<number> {
  let count = 0
  for (const [sessionId, entry] of activeAgents.entries()) {
    if (entry.kind !== 'agent') continue
    if (entry.selection?.providerId === providerId) {
      count++
      continue
    }
    const roster = await createTeamStore(teamDirsFor(sessionId)).roster()
    if (roster.some((member) => member.model?.providerId === providerId)) count++
  }
  return count
}

/** 在任何异步准备之前占位，停止和重入检查从这一刻起生效。 */
function reserveRun(
  sessionId: string,
  senderId: number,
  kind: ActiveAgentRun['kind'] = 'agent'
): ActiveAgentRun | undefined {
  if (activeAgents.has(sessionId) || deletingSessions.has(sessionId)) return undefined
  const run: ActiveAgentRun = {
    kind,
    senderId,
    controller: new AbortController(),
    pendingSteers: []
  }
  activeAgents.track(sessionId, run)
  return run
}

/**
 * 跑着的对话能不能就地分支：能的话给出该拿去切的那份消息。
 *
 * 分支只读源会话（读一份历史、写一个新文件），本来就不必等它停 —— 挡住它的
 * 一直是「盘上落后于内存」。跑着的时候读内存那份就绕开了这件事。
 *
 * 三种情况仍然要拒：
 * - 整份复制（没给 `keepUserTurns`）：那正是还没落盘、还没说完的这一轮。
 * - 占着锁的不是模型而是压缩 / 截断 / 删除：它们在改写这份历史，中途读出来的
 *   既不是改前也不是改后。
 * - 切点落在正在输出的这一轮里：界面只复制到被点的那条气泡为止，内核这边却会
 *   把半截答案一起带走，两份历史当场对不上。能数出**更靠后**的用户消息，才
 *   证明第 `keepUserTurns` 轮已经收尾。
 *
 * 拿的是浅拷贝：主进程单线程，拷完这一下就和后续追加无关了。
 */
function liveForkSource(sessionId: string, keepUserTurns?: number): AgentMessage[] | undefined {
  if (typeof keepUserTurns !== 'number') return undefined
  if (deletingSessions.has(sessionId)) return undefined

  const running = activeAgents.get(sessionId)
  if (running?.kind !== 'agent' || !running.agent) return undefined

  const messages = withoutSystemMessages(running.agent.state.messages)
  const userTurns = messages.filter((m) => (m as { role?: string }).role === 'user').length
  return userTurns > keepUserTurns ? messages : undefined
}

/** 目标模式里「用户最新一句」最多带多长：它每轮复核、续跑都要再发一遍 */
const LATEST_REQUEST_MAX_CHARS = 2000

function tailOf(text: string, max: number): string {
  return text.length <= max ? text : `…${text.slice(text.length - max)}`
}

/** 按停止之后最多等它收尾多久，超时就如实说「没停干净」 */
const STOP_DRAIN_TIMEOUT_MS = 15_000

/**
 * 推锁状态给插件的超时。
 *
 * 给得短：这只是画个角标，插件没答上来就算了，下一次锁变动会再推一次全量
 * 把它拉回正确状态。等太久反而会让暂存池里堆一串没人关心的请求。
 */
const LOCK_PUSH_TIMEOUT_MS = 5_000

/**
 * 每条对话的审批档位。
 *
 * **一条对话一份**，不是全局一份。曾经是全局的：谁最后 execute 就把它覆盖成
 * 谁的档位 —— 用户在 A 对话上设了只读，去 B 对话开完全访问，回到 A 发一句话，
 * A 也在按完全访问跑。他在 A 上做的那个「别乱动」的决定，被另一条对话悄悄推翻了。
 *
 * 存成表而不是随 execute 参数写死进审批门，是为了「跑到一半改档位立刻生效」：
 * 审批门每次工具调用都现读这个值。用户被确认框拦住时才会去调档位，
 * 让他等到下一条消息才算数，等于这个开关在最需要它的那一刻是坏的。
 */
const approvalModeBySession = new Map<string, ApprovalMode>()
const readOnlyBySession = new Map<string, boolean>()

/** 没登记过就按最严的一档。宁可多问一次，也不能替用户默认放行 */
function approvalModeFor(sessionId: string): ApprovalMode {
  return approvalModeBySession.get(sessionId) ?? 'ask'
}

/**
 * 每个内核 session 里已被「始终允许」的工具。
 *
 * 必须挂在内核 session 上：审批门随 agent 创建，而 agent 每条消息重建一次 ——
 * 原来这个集合活在审批门闭包里，于是按钮上写着「本次会话都允许」，
 * 实际只管到这一轮结束，用户下一句话发出去它又开始问了。
 *
 * 不跨内核 session 共享：在 A 对话里放行过的工具，不该在 B 对话里也免问。
 */
const sessionAlwaysAllowed = new Map<string, Set<string>>()

/**
 * 切到只读（Ask）时连同「本对话内都允许」的名单一起清掉。
 *
 * 不能只在 `set-approval-mode` 里清：渲染层那一下同步送不到时会静默跳过，
 * 下一轮 execute / continue 带着 `mode: 'ask'` 进来只改了只读标记，名单还在，
 * 用户切回 Agent 后旧授权照样生效 —— 按钮上的承诺就落空了。
 */
function setReadOnly(sessionId: string, readOnly: boolean): void {
  readOnlyBySession.set(sessionId, readOnly)
  if (readOnly) sessionAlwaysAllowed.get(sessionId)?.clear()
}

function alwaysAllowedFor(sessionId: string): Set<string> {
  const existing = sessionAlwaysAllowed.get(sessionId)
  if (existing) return existing

  const created = new Set<string>()
  sessionAlwaysAllowed.set(sessionId, created)
  return created
}

/**
 * 按工具名 + 这次的参数算风险，给事件桥往 tool-call 上挂。
 * 不认识的工具返回 undefined，渲染层退回按工具名的静态表
 */
function callRiskOf(
  tools: Array<{ name: string; unrealBox: ToolMeta }>
): (toolName: string, args: unknown) => ToolRisk | undefined {
  const metas = new Map(tools.map((tool) => [tool.name, tool.unrealBox]))
  return (toolName, args) => {
    const meta = metas.get(toolName)
    return meta ? effectiveRisk(meta, args) : undefined
  }
}

/** execute / continue 共用装配，复核状态与任务一起恢复。 */
function attachGoalLoop(
  agent: Agent,
  ctx: SessionContext,
  tools: Array<{ name: string; unrealBox: ToolMeta }>,
  options: SessionExecutionOptions,
  emit: (channel: string, payload: unknown) => void,
  maxRounds: number
): ReturnType<typeof createGoalLoop> | undefined {
  const goal = options.goal
  if (!goal || goal.settled) return undefined
  const report = (message: string, level: 'info' | 'warning' | 'success'): void =>
    emit('agent-v3:goal', { sessionId: ctx.sessionId, message, level })
  const precondition = checkGoalPreconditions({ mode: options.mode })
  if (!precondition.ok) {
    // 只在这一轮刚定目标时提醒；沿用下来的目标（带 latestRequest）在只读轮里静默跳过，
    // 不然切到只读问一句就句句报「目标不可能达成」
    if (!goal.latestRequest) report(precondition.reason!, 'warning')
    return undefined
  }
  const loop = createGoalLoop({
    objective: goal.objective,
    ...(goal.latestRequest ? { latestRequest: goal.latestRequest } : {}),
    maxRounds,
    initialState: goal,
    onStateChange: async (state) => {
      options.goal = { ...goal, ...state }
      await saveExecutionOptions(ctx.sessionId, options)
      // 收齐了界面上那行目标要跟着变
      emit('agent-v3:goal-state', { sessionId: ctx.sessionId })
    },
    mutatingTools: new Set(
      tools.filter((tool) => tool.unrealBox.risk !== 'safe').map((tool) => tool.name)
    ),
    // dry_run 预演不算这一轮改过东西
    isReadOnlyCall: (toolName, args) =>
      effectiveRisk(tools.find((tool) => tool.name === toolName)?.unrealBox, args) === 'safe',
    runAudit: async (input) => {
      try {
        const result = await runSubAgent(ctx, {
          prompt: buildAuditPrompt(input),
          auditorJudges: AUDITOR_HARD_JUDGES,
          withoutApproval: true,
          seedMessages: [],
          ...(input.signal ? { signal: input.signal } : {}),
          ...(input.onProgress ? { onProgress: input.onProgress } : {})
        })
        return result.text
      } catch (error) {
        // 审计员被截断或没写字：没有裁决，交给目标循环按「复核未给出裁决」收住，
        // 别让它变成主对话这一轮的报错
        if (error instanceof NoConclusionError) return error.message
        throw error
      }
    },
    followUp: (text) => agent.followUp({ role: 'user', content: text, timestamp: 0 }),
    report
  })
  agent.subscribe(loop)
  return loop
}

/**
 * 工作室模式（`/team`）挂到这一轮的 ctx 上。必须在 `createUnrealAgent` 之前：
 * 团队工具和制作人的那段提示词是装配时就定下来的。
 *
 * 只读模式不进工作室：理由同 `/goal`（`checkGoalPreconditions`）—— 什么都改不了的
 * 团队做不出游戏，这一轮按普通对话跑。
 */
async function prepareTeam(
  ctx: SessionContext,
  options: SessionExecutionOptions,
  emit: (channel: string, payload: unknown) => void
): Promise<void> {
  const team = options.team
  if (!team || options.mode === 'ask') return
  // 名册、任务板、留言一变就告诉界面去重读 —— 任务板面板靠它跟上，不用轮询
  const changed = (): void => emit('agent-v3:team-board', { sessionId: ctx.sessionId })
  const store = createTeamStore(teamDirsFor(ctx.sessionId), Date.now, changed)
  await store.ensure()
  // 上次运行没交回的活（盒子关了、崩了）不会再交回来了；不收掉，界面上会一直挂着「正在写」
  await store.closeOpenJobs('上次运行中断，这件活没有交回').catch(() => undefined)
  ctx.pacedRequests = true
  // 一局的 token 封顶（`core/team/teamBudget.ts`）。已用量拿盘上的总账对一次：盒子重启后内存里是 0。
  // 走到这里的都是人的动作（发了一条消息、点了「接着跑」；自动续跑不经过这里）：
  // 已经到顶就抬一档并落盘，不然这一轮第一个请求就会被挡回去
  const budget = teamBudgetFor(ctx.sessionId)
  budget.setLimit(team.tokenLimit)
  const ledger = await store.usage().catch(() => null)
  if (ledger) budget.seed(billedTokens(ledger.total))
  if (budget.exhausted()) {
    options.team = { ...team, tokenLimit: budget.raise() }
    await saveExecutionOptions(ctx.sessionId, options)
  }
  ctx.teamBudget = budget
  // 团队模式统一全放行：队员（和制作人那几个建工程、开工程的动作）不弹确认框，由模型自己判断。
  // 队员经 `...parent` 继承这一档。和混合团队的默认一致，三种跑法同一个规矩
  ctx.approvalMode = 'yolo'
  // 谁开始跑、谁在等也告诉界面（任务板上的办公室）。派活时几个人同时开工，合并成一次
  let liveTimer: ReturnType<typeof setTimeout> | null = null
  const live = createTeamLive(
    store,
    () => {
      if (liveTimer) return
      liveTimer = setTimeout(() => {
        liveTimer = null
        changed()
      }, TEAM_LIVE_COALESCE_MS)
    },
    // 队员的动态当场推，不让界面为一行字重读整份任务板
    (activity) => emit('agent-v3:team-activity', { sessionId: ctx.sessionId, ...activity })
  )
  liveTeams.set(ctx.sessionId, live)
  ctx.team = {
    objective: team.objective,
    ...(team.latestRequest ? { latestRequest: team.latestRequest } : {}),
    store,
    live,
    snapshots: createTeamSnapshots(),
    onVerdict: async (verdict) => {
      options.team = applyVerdict(options.team ?? team, verdict)
      await saveExecutionOptions(ctx.sessionId, options)
      // 执行记录只留最近一次；每次的结论进团队事件，往来记录里一条一条看得到（落盘失败不影响交付闸）
      await store
        .recordEvent({ kind: 'verdict', verdict: options.team.verdict ?? 'fail' })
        .catch(() => undefined)
      changed()
    }
  }
}

/** 面板上最多显示多少条留言。它是近况，不是档案 —— 全量在 `<会话>.team/mail.json` */
const TEAM_PANEL_MAIL = 30
/** 面板上最多显示多少件活、多少条团队事件。同上，是近况 */
const TEAM_PANEL_JOBS = 60
const TEAM_PANEL_EVENTS = 20

/** 动静通知合并的窗口。人眼看不出这一点延迟，几个人同时开工只重读一次 */
const TEAM_LIVE_COALESCE_MS = 120

/**
 * 每条工作室对话最近一次运行的 `TeamLive`。面板读「谁在跑」要它，而它只挂在这一轮的
 * ctx 上。下一轮 `prepareTeam` 换成新的；结束团队模式时删掉
 */
const liveTeams = new Map<string, TeamLive>()

/** 任务板面板要的一整份。不是工作室的会话返回 null */
async function readTeamState(sessionId: string): Promise<TeamStateView | null> {
  // 外部团队（Claude Code 当大脑）没有盒子侧的对话，账在 external.json 里
  if (isExternalTeamId(sessionId)) return readExternalTeamState(sessionId)
  const team = (await loadExecutionOptions(sessionId))?.team
  if (!team) return null
  const store = createTeamStore(teamDirsFor(sessionId))
  const [members, dismissals, board, mail, activity, jobs, events, usage] = await Promise.all([
    store.roster(),
    store.dismissals(),
    store.board(),
    store.mail(),
    store.activity(TEAM_ACTIVITY_LOOKBACK),
    store.jobs(TEAM_PANEL_JOBS),
    store.events(TEAM_PANEL_EVENTS),
    store.usage()
  ])
  return {
    objective: team.objective,
    ...(team.latestRequest ? { latestRequest: team.latestRequest } : {}),
    verdict: team.verdict,
    ...(team.verdictAt !== undefined ? { verdictAt: team.verdictAt } : {}),
    verdictStale: verdictIsStale(team.verdictAt, team.lastWriteAt, activity),
    deliveries: team.deliveries,
    ...(team.roundStartedAt !== undefined ? { roundStartedAt: team.roundStartedAt } : {}),
    members,
    ...(dismissals.length ? { dismissals } : {}),
    board,
    mail: mail.slice(-TEAM_PANEL_MAIL),
    jobs,
    events,
    ...(usage.total.total > 0 || usage.total.cost > 0 ? { usage } : {}),
    ...(liveTeams.has(sessionId) ? { live: liveTeams.get(sessionId)!.view() } : {})
  }
}

/**
 * 模型请求卡住重发时说一声。同一次请求只说第一次重发：
 * 重发间隔一两分钟，每次都说的话时间线上全是同一句话。
 * 自动续跑出去的那几次也不说（`resumed > 0`）：自动断点续传每分钟续一次，
 * 那一串已经由 `agent-v3:auto-resume` 说过一声了。
 *
 * 界面只拿结构化的几项，文案归渲染层（双语），同 `agent-v3:auto-resume`。
 */
function notifyModelRetry(
  sender: WebContents,
  sessionId: string,
  info: { attempt: number; reason: string; model: string },
  resumed: number
): void {
  if (info.attempt !== 1 || resumed > 0 || sender.isDestroyed()) return
  sender.send('agent-v3:model-retry', {
    sessionId,
    model: info.model,
    reason: info.reason.slice(0, 120)
  })
}

/**
 * 任务板上「重开」那两个入口认的「这是一个团队」：盒子里的看执行记录，外部团队看 external.json。
 * 换模型不走这里 —— 外部团队的队员在 Claude Code 里，盒子换不了它的模型
 */
async function isTeamSession(sessionId: string): Promise<boolean> {
  if (isExternalTeamId(sessionId)) return externalTeamExists(sessionId)
  return Boolean((await loadExecutionOptions(sessionId))?.team)
}

/** 判「这一轮改没改过工程」「验收后改没改过」时，往回看多少条队员交活记录 */
const TEAM_ACTIVITY_LOOKBACK = 50

/**
 * 交付闸：没过验收就收尾时，替制作人补一句（见 `core/team/teamSession.ts`）。
 *
 * 顺带记下制作人自己改工程的时刻（队员的改动 `team_send` 已经记在 activity 里），
 * 收尾时拿它对任务板：这一轮改了工程、旧账却没人动，补一句（见 `core/team/boardRecap.ts`）。
 */
function attachTeamGate(
  agent: Agent,
  ctx: SessionContext,
  options: SessionExecutionOptions,
  allTools: Array<{ name: string; unrealBox: ToolMeta }>,
  emit: (channel: string, payload: unknown) => void
): void {
  const team = ctx.team
  if (!team || !options.team) return
  const riskOf = callRiskOf(allTools)
  const setState = async (next: TeamState): Promise<void> => {
    options.team = next
    await saveExecutionOptions(ctx.sessionId, options)
  }
  // 开始事件上才有参数（按参数算风险，dry_run 不算写），结束事件上才知道成没成
  const writing = new Set<string>()
  agent.subscribe(async (event) => {
    if (event.type === 'tool_execution_start') {
      // 不认识的工具按写算，同审批门：不认识的一律从严
      if ((riskOf(event.toolName, event.args) ?? 'destructive') !== 'safe') {
        writing.add(event.toolCallId)
      }
      return
    }
    if (event.type !== 'tool_execution_end' || !writing.delete(event.toolCallId)) return
    if (event.isError || !options.team) return
    const next = noteWrite(options.team)
    if (next) {
      await setState(next)
      // 验收标签要从「未过」变成「改动后未重验」
      emit('agent-v3:team-board', { sessionId: ctx.sessionId })
    }
  })
  agent.subscribe(
    createTeamGate({
      getState: () => options.team!,
      setState,
      followUp: (text) => agent.followUp({ role: 'user', content: text, timestamp: 0 }),
      report: (message) =>
        emit('agent-v3:notice', { sessionId: ctx.sessionId, message, level: 'info' }),
      awaitTeam: (signal) => awaitTeamWork(ctx.team, signal),
      checkBoard: async (state) => {
        const since = state.roundStartedAt
        if (since === undefined) return null
        const activity = await team.store.activity(TEAM_ACTIVITY_LOOKBACK)
        if (!changedSince(since, state.lastWriteAt, activity)) return null
        const stale = carryOverTasks(await team.store.board(), since)
        return stale.length > 0 ? buildBoardNudge(stale, Date.now()) : null
      }
    })
  )
}

/**
 * 开局摆给制作人看的任务板旧账（见 `core/team/boardRecap.ts`）。
 * 不是工作室、没有旧账、读不到任务板都给空串 —— 它是提醒，不能挡住这一轮。
 */
async function teamCarryOverBlock(
  ctx: SessionContext,
  options: SessionExecutionOptions
): Promise<string> {
  const since = options.team?.roundStartedAt
  if (!ctx.team) return ''
  // 用户在任务板上辞了人：告诉制作人一声（只说一次），免得它接着给这个人派活
  const dismissed = await ctx.team.store
    .takeUnnotifiedDismissals()
    .then(formatUserDismissals)
    .catch(() => '')
  if (since === undefined) return dismissed
  try {
    const board = formatBoardCarryOver(
      carryOverTasks(await ctx.team.store.board(), since),
      Date.now()
    )
    return [dismissed, board].filter(Boolean).join('\n\n')
  } catch {
    return dismissed
  }
}

/** 正在看护的编辑器，按会话记。一轮结束（`finally` 里）就停 */
const editorWatchBySession = new Map<string, () => void>()

function stopEditorWatch(sessionId: string): void {
  editorWatchBySession.get(sessionId)?.()
  editorWatchBySession.delete(sessionId)
}

/** 给用户看的那一句（界面提示）。给制作人看的在 `buildCrashNotice` */
function watchNotice(event: EditorWatchEvent): string {
  if (event.kind === 'crashed') {
    return `编辑器已崩溃${event.reason ? `（${event.reason.slice(0, 120)}）` : ''}，正在自动重新打开工程…`
  }
  if (event.kind === 'recovered') {
    return `编辑器已重新打开并连接（用时 ${Math.round(event.waitedMs / 1000)} 秒），已通知制作人。`
  }
  return `编辑器自动恢复失败：${event.why}`
}

/**
 * 工作室模式下看护这一局的编辑器：崩了自动重开，并把经过告诉制作人
 * （见 `core/team/editorWatch.ts`）。只管这一局此刻在干的那个工程。
 */
function attachEditorWatch(
  agent: Agent,
  ctx: SessionContext,
  run: ActiveAgentRun,
  emit: (channel: string, payload: unknown) => void
): void {
  if (!ctx.team) return
  stopEditorWatch(ctx.sessionId)
  const isOurs = (projectDir: string): boolean => {
    const current = run.scope?.connectedProject?.projectPath
    return Boolean(current) && projectPathKey(current!) === projectPathKey(projectDir)
  }
  const stop = startTeamEditorWatch(isOurs, {
    onEvent: (event) => {
      // 记进团队的账：任务板上画成一条贯穿所有人的线（落盘失败不影响看护）
      void ctx.team?.store
        .recordEvent(
          event.kind === 'crashed'
            ? { kind: 'crashed', ...(event.reason ? { detail: event.reason.slice(0, 200) } : {}) }
            : event.kind === 'recovered'
              ? { kind: 'recovered' }
              : { kind: 'recoverFailed', detail: event.why.slice(0, 200) }
        )
        .catch(() => undefined)
      emit('agent-v3:notice', {
        sessionId: ctx.sessionId,
        message: watchNotice(event),
        level: event.kind === 'recovered' ? 'info' : 'warning'
      })
      agent.steer({ role: 'user', content: buildCrashNotice(event), timestamp: Date.now() })
    }
  })
  editorWatchBySession.set(ctx.sessionId, stop)
}

/**
 * 工作室模式下整轮跑在编辑器钥匙的作用域里：制作人和它派出去的每个队员，
 * 改编辑器都要排队（见 `core/team/editorKey.ts`）。普通会话原样执行。
 */
function withTeamScope<T>(options: SessionExecutionOptions, fn: () => Promise<T>): Promise<T> {
  return options.team && options.mode !== 'ask' ? runWithEditorKey(fn) : fn()
}

export interface AgentV3ExecuteArgs {
  sessionId: string
  prompt: string
  mode?: 'agent' | 'ask'
  approvalMode?: ApprovalMode
  /** 思考程度。不传等同 auto —— 不指定，随模型自己的默认 */
  thinkingLevel?: ThinkingLevelChoice
  /** 模型菜单里的「快速」。和思考程度一样住在渲染层，每轮带过来 */
  fastMode?: boolean
  /**
   * 技能沉淀档位。不传等同 ask。
   *
   * 和思考程度同一条路：设置存在渲染层（aiConfig），主进程手上没有，
   * 每轮随请求带过来。
   */
  skillLearning?: SkillLearningMode
  /**
   * 用户允不允许 agent 拍编辑器画面（「设置 → AI 助手 → 隐私」那一档）。
   *
   * 和思考程度、技能沉淀同一条路：设置住在渲染层（`aiConfig`），主进程手上没有，
   * 每轮随请求带过来。不传等同**允许** —— 那是这一档的默认状态，
   * 「没人说过话」不能当成「用户关过」，见 `core/editorScreenshotScope.ts`。
   */
  editorScreenshotEnabled?: boolean
  /**
   * 随这轮一起发的图片。
   *
   * pi 的 `prompt(input, images?)` 原生支持，不接的话用户在聊天框里贴的图
   * 会被静默丢掉 —— 界面显示图发出去了，模型却什么也没看到。
   */
  images?: ImageContent[]
  /**
   * 随这轮一起带的音视频（本地路径）。
   *
   * 配了对象存储、当前模型又能直接看视频，就传上去换成链接随消息发；
   * 否则只给路径，agent 需要时自己用 `analyze_video` 去看。见 `core/promptMedia.ts`。
   */
  mediaFiles?: PromptMediaFile[]
  /**
   * 这条对话归属的工程（侧边栏分组用的那个戳）。
   *
   * 只有渲染层知道它 —— 戳存在对话列表里，主进程手上只有「谁连着」。
   * 不传就退回老行为：一切以当前连接为准。
   */
  sessionProject?: SessionProjectRef | null
  /**
   * 这条对话绑着的知识库。知识库页面里提问时由渲染层带上。
   *
   * 主进程无从得知用户此刻开着哪个知识库 —— 那是界面状态。不带的话
   * 模型就没有检索工具，只能凭记忆答用户自己传的资料。
   */
  notebook?: { id: string; title?: string } | null
  /**
   * 用户**按下发送那一刻**的编辑器状态，由渲染层抓好随消息带下来。
   *
   * 主进程不自己抓：到这里才抓就晚了（排队的消息可能已经等了几分钟），而且
   * 气泡上显示的必须就是模型收到的那一份 —— 同一个对象一路传下来，靠构造保证，
   * 不靠事后回传对齐。
   *
   * `null` 是用户明确去掉了，`undefined` 是这个入口还没接闪存。对主进程来说
   * 两者一样：都不拼块。
   */
  editorSnapshot?: EditorSnapshot | null
  /**
   * 这条对话绑定的模型，渲染层记在对话上随消息带下来。
   *
   * 不传（后台任务、Spotlight）就用执行记录里那份；那份也没有（第一轮）
   * 就按全局默认绑定，见 `core/sessionModel.ts`。
   */
  sessionModel?: SessionModel
}

/**
 * Spotlight 按下回车那一刻抓一份闪存。
 *
 * 走这条独立入口而不是那个 IPC：Spotlight 的提交发生在**主进程**里
 * （`spotlight:execute`），小窗口那时还没起来，没有渲染层能替它调 IPC。
 * 而等窗口起来再抓就晚了半秒多 —— 那半秒足够用户切回引擎换一次选区。
 *
 * Spotlight 开的是一条全新对话，没有工程归属，所以按当前连接算。
 */
export async function captureEditorSnapshotForSpotlight(): Promise<{
  editorSnapshot?: EditorSnapshot | null
  sessionProject?: { projectName: string; projectPath?: string } | null
}> {
  const scope = resolveTargetProject(null)
  const result = await captureEditorSnapshot({
    scope,
    anyConnected: projectManager.getInteractiveProjects().length > 0
  })
  if (!result.ok) {
    console.log(`[Spotlight] 闪存没抓到：${result.reason}`)
    return { editorSnapshot: null }
  }
  return {
    editorSnapshot: result.snapshot,
    // 快照来自哪个工程，这条消息就钉在哪个工程上 —— 抓的和执行的必须是同一个
    sessionProject: {
      projectName: result.snapshot.project.projectName,
      ...(result.snapshot.project.projectPath
        ? { projectPath: result.snapshot.project.projectPath }
        : {})
    }
  }
}

export interface AgentV3ContinueArgs {
  sessionId: string
  mode?: 'agent' | 'ask'
  /** 同 execute：续跑也要知道这条对话挂在哪个工程下 */
  sessionProject?: SessionProjectRef | null
  /**
   * 同 execute：续跑也得带上审批档位。
   *
   * 不带的话档位会退回默认的「每步都问」—— 用户设的是「帮我批准」，
   * 一点「从断点继续」却开始每一步写操作都弹框，而他什么都没改过。
   */
  approvalMode?: ApprovalMode
  /**
   * 同 execute：对话此刻绑的模型。上一轮在 A 上报错、用户在输入框里换成 B 再点
   * 「从断点继续」，续跑得用 B —— 执行记录里那份还是出错的 A
   */
  sessionModel?: SessionModel
}

/**
 * 项目库里登记过的工程（首页导入/新建时写进 SQLite 的那张 `projects` 表）。
 *
 * 对话上的工程戳只有名字，路径只有「盖戳那一刻正连着」才会记下来。
 * 但盒子其实是知道路径的 —— 用户自己在首页登记过。以前没人把这两边接上：
 * 一条归入 test222 的对话，模型为了找它的 `.uproject` 从 C:/ 开始整盘扫，
 * 而答案就躺在库里。
 */
function projectLibrary(): LibraryProjectRef[] {
  try {
    return getAllProjects(getPublicDatabase()).map((record) => ({
      projectName: record.projectName,
      projectPath: record.projectPath,
      engineVersion: record.EngineAssociation
    }))
  } catch (error) {
    // 数据库没起来 / 表还没建时按「库里没有」处理。补路径是锦上添花，
    // 不该让整轮对话起不来
    console.warn('[AgentV3] 读取项目库失败，跳过路径补全:', error)
    return []
  }
}

/**
 * 算出这一轮该操作哪个 UE 项目。
 *
 * **项目对项目**：对话归属哪个工程，指令就发给哪个工程；它没开着，
 * 这条对话就没有引擎能力（`engineAvailable: false`），而不是顺手操作旁边那个。
 * 没有归属的纯对话才跟着当前活跃项目走（projectManager 取最近连接的那个）。
 *
 * 算出来的 `targetConnectionId` 由调用方用 `runWithTargetConnectionId()`
 * 绑到本次执行流上 —— 不再写进模块级变量。两个会话并发时，模块级变量会被
 * 后来者覆盖，指令就静默发到别的工程上了（V2 时代出过一次，换个形式又会再出）。
 */
function resolveTargetProject(sessionProject?: SessionProjectRef | null): SessionProjectScope {
  try {
    return resolveSessionScope(
      sessionProject,
      projectManager.getInteractiveProjects(),
      currentProjectForFlow(),
      projectLibrary()
    )
  } catch {
    // 项目服务没起来时按「不指定」处理，别让整个请求失败
    return { engineAvailable: true, outOfScopeProjects: [] }
  }
}

/**
 * 纯对话该跟着哪个工程走。
 *
 * 默认是 `getCurrentProject()`（最近连上的那个）。但**执行流上已经绑了目标时
 * 以那个为准** —— `open_project` 打开新工程之后会把这一轮切过去
 * （见 `tools/adapted/project/awaitProjectLive.ts`），此时命令实际的去处是那个
 * 新工程，而「最近连上的」可能是同一时刻用户手动开的另一个。跑到一半重新体检
 * 引擎（`refreshEngine`）时如果按后者算，工具清单和环境块会指向一个和命令去处
 * 不同的工程 —— 那正是这套上下文机制要消灭的矛盾。
 *
 * 一轮**开始**时调用则拿不到目标（还没进 `runWithTargetConnectionId`），
 * 自然退回原来的行为。
 *
 * ## 绑着的编辑器中途没了就退回「最近连上的那个」，**但不动执行流**
 *
 * 这里一度会顺手把死目标摘掉，想让「环境块说 B、命令发往死掉的 A」这个矛盾
 * 消失。那样更糟：摘掉之后底层在恰好一个连接时会回退，命令**悄悄**落进 B；
 * 留着死 id 则会当场报「客户端不存在或已断开」，是能看见的失败。
 * 而且 `projectPath` 是崩溃重启自愈唯一的锚，删了就再也认不回那个工程。
 * 详见 `core/projectTargetContext.ts` 里那段说明。
 */
export function currentProjectForFlow(): ConnectedProjectRef | undefined {
  const targetId = getTargetConnectionId()
  const bound = targetId ? projectManager.getProject(targetId) : undefined
  if (bound?.isConnected && bound.interactive !== false) return bound

  return projectManager.getCurrentProject()
}

/**
 * 盒子知道的所有工程，给 `set_session_project` 挑。
 *
 * 两份合起来：项目库里登记过的（用户在首页导入/新建的，工程关着也查得到）
 * 加上此刻连着的（可能是用户手动打开、还没登记进库的）。少了任何一半，
 * 模型点名一个明明存在的工程会被回「盒子里没有这个工程」。
 */
export function sessionProjectCandidates(): SessionProjectCandidate[] {
  const connected = (() => {
    try {
      return projectManager.getInteractiveProjects()
    } catch {
      return []
    }
  })()
  const isLive = (projectPath?: string | null): boolean =>
    connected.some(
      (item) => projectPathKey(item.projectPath) === projectPathKey(projectPath ?? undefined)
    )

  const library = projectLibrary().map((record) => ({
    projectName: record.projectName ?? '',
    ...(record.projectPath ? { projectPath: record.projectPath } : {}),
    ...(record.engineVersion ? { engineVersion: record.engineVersion } : {}),
    connected: isLive(record.projectPath)
  }))

  const known = new Set(library.map((item) => projectPathKey(item.projectPath)))
  const extras = connected
    .filter((item) => !known.has(projectPathKey(item.projectPath)))
    .map((item) => ({
      projectName: item.projectName,
      ...(item.projectPath ? { projectPath: item.projectPath } : {}),
      ...(item.engineVersion ? { engineVersion: item.engineVersion } : {}),
      connected: true
    }))

  return [...library, ...extras].filter((item) => item.projectName)
}

/**
 * 把新归属写回执行记录，让「从断点继续」认同一个工程。
 *
 * ## 写的是 `sessionProject`，不是 `project`
 *
 * 那两个字段是两件事：`project` 是**这一轮打到了哪个工程**（`execute` 开局写的），
 * `sessionProject` 是**这条对话属于谁**（只有模型改归属时才写）。挤在一个字段里
 * 会出两种错：从没绑过、只是恰好在某个工程上跑过的对话，续跑时看起来像被钉住了；
 * 而模型明确「解除归属」之后那个字段被删掉，续跑的 `??` 就顺着掉到渲染层
 * 传下来的旧戳上，把刚解除的归属原样复活 —— 而工具刚跟用户说过「已解除」。
 * 所以解除要落成一个**显式的 `null`**，它和「从来没写过」必须分得开。
 *
 * ## 直接存调用方手上那一份，不再读一遍盘
 *
 * 以前这里是 load-modify-save。`await` 那一下留出一个窗口：`/goal` 的状态机
 * 在窗口里把轮次和改动台账写进了同一个文件，而这边拿着窗口**之前**读到的快照
 * 覆盖回去 —— 复核轮次回退，台账清空，续跑重跑一遍已经做完的复核。
 * 调用方给的 `live` 本来就是那个正在用、已经校验过的对象，直接存它，窗口就没了。
 *
 * 失败只记日志不抛：归属在执行流上和渲染层上都已经改过了，为了一次落盘失败
 * 让工具调用报错，会让模型以为换归属没成功而去重试。
 */
export async function persistSessionProject(
  sessionId: string,
  project: SessionProjectCandidate | null,
  live: SessionExecutionOptions,
  /**
   * 盘上那份 `mode`，续跑那条路要给。
   *
   * `resumeExecutionOptions` 把档位单向夹到 `ask`，那是**这一次运行**的约束，
   * 不是会话的属性。连着夹子一起落盘的话，一次只读续跑就把会话永久钉成只读。
   */
  modeOnDisk?: SessionExecutionOptions['mode']
): Promise<void> {
  /*
   * 只落盘，**不写表** —— 表（`core/sessionBinding.ts`）已经由调用方写过了，
   * 那是唯一的写入口。这里写的是它的影子，供盒子重启后重新灌回来。
   */
  live.sessionProject = project
    ? {
        projectName: project.projectName,
        ...(project.projectPath ? { projectPath: project.projectPath } : {}),
        // 引擎版本一起存：表里有、界面上渲得出来，这儿丢掉就是冷启动之后
        // 环境块里没有版本而胶囊上写着 5.5
        ...(project.engineVersion ? { engineVersion: project.engineVersion } : {})
      }
    : null

  try {
    await saveExecutionOptions(sessionId, modeOnDisk ? { ...live, mode: modeOnDisk } : live)
  } catch (error) {
    console.warn(
      `[AgentV3] 会话 ${sessionId} 的新工程归属没写进执行记录:`,
      (error as Error).message
    )
  }
}

/**
 * 跑到一半再体检一次引擎，状态没变就回 undefined。
 *
 * ## 为什么需要它
 *
 * 工具清单是一轮开始时按当时的连接状态定的。而这一轮里模型完全可能**自己把
 * 工程打开**：`project_manage` 的 `open_project` 会等编辑器连上、并把这一轮的
 * 目标切过去。不重新体检的话，模型手上仍然一个 `ue.*` 都没有，只能请用户
 * 再发一条消息 —— 而盒子该做的全做完了，就差把工具递给它。
 *
 * ## 归属以执行流上那份为准，不是随消息带下来的那份
 *
 * `sessionProject` 是渲染层在**收到消息那一刻**的快照。模型这一轮里调
 * `set_session_project` 换了归属之后它就过期了 —— 继续按它算的话，作用域会一直
 * 停在旧工程：旧工程没开着就永远是 `engineAvailable: false`（模型换完归属还是
 * 一个引擎工具都拿不到），旧工程开着更糟（环境块一直写着旧工程名，而命令已经
 * 发往新工程，提示词还告诉模型环境块比对话可信）。所以每次先问执行流。
 *
 * ## 判重分两层，先便宜的
 *
 * 换工具清单和系统提示词会改掉请求前缀，厂商的 Prompt Cache 要重算一次，
 * 所以只有真的变了才换。但**判重本身也不能贵**：完整的
 * `resolveTargetProject()` 里带一次 `SELECT * FROM projects`（连 `projectData`
 * 那几个大字段一起拉出来），一轮几十步就是几十次全表读，全压在主进程那条
 * 既跑 IPC 又跑 UE WebSocket 的事件循环上。
 *
 * 所以先算一个纯内存的粗签名（有没有连接、连着哪些、目标是谁、归属是谁）——
 * 它没变就直接回 undefined，一次库都不读。只有粗签名动了才去做完整解析，
 * 再用细签名确认这次变化确实影响到了模型看得见的东西。
 */
export function createEngineRefresher(
  sessionId: string,
  initial: SessionProjectScope,
  /** 作用域变了就通知一声。宿主拿它把 `run.scope` 更到最新，插话那条路才不会看错工程 */
  onScope?: (scope: SessionProjectScope) => void
): () => EngineFacts | undefined {
  /** 这一轮此刻真正的归属：模型改过就用改过的，没改过才用消息带下来的 */
  // 归属只有一个来源：那张表。以前这里要在「渲染层的戳」和「这一轮改过的值」
  // 之间挑一个，挑错就是工具清单和环境块停在旧工程上
  const currentStamp = (): SessionProjectRef | null | undefined => getSessionBinding(sessionId)

  /** 纯内存的粗签名。读它一次的代价是几个数组访问，不碰数据库 */
  const cheapSignature = (): string => {
    const stamp = currentStamp()
    const connected = (() => {
      try {
        return projectManager
          .getInteractiveProjects()
          .map((project) => project.connectionId)
          .sort()
          .join(',')
      } catch {
        return ''
      }
    })()
    return [
      isUeConnected(),
      connected,
      getTargetConnectionId() ?? '',
      stamp === null ? '(none)' : (stamp?.projectPath ?? stamp?.projectName ?? '')
    ].join('|')
  }

  /*
   * 细签名把**模型看得见的每一样**都算进去。
   *
   * 只看「有没有引擎工具」和「目标是谁」是不够的：对话钉在一个没开着的工程上、
   * 用户中途开了另一个工程时，这两样都没变（还是没工具、还是没目标），
   * 变的是 `outOfScopeProjects` —— 而环境块正是靠它才不会去劝一个明明连着引擎
   * 的人装插件。漏掉它，那句话就一直挂在那儿。
   *
   * **工程路径同理，而且更隐蔽。** 环境块会印出路径，还会在缺路径时专门说一句
   * 「盒子不知道 X 在哪，去问用户，别满盘找 .uproject」。老对话的戳只有名字，
   * 模型用 `set_session_project` 给它补上路径之后，名字、连接、越界清单一样都
   * 没变 —— 漏掉路径的话这次刷新会被判成「没变化」，那句「去问用户」就一直
   * 挂在提示词里，问的是一个盒子刚刚记下来的路径。
   */
  const signature = (scope: SessionProjectScope): string =>
    [
      engineToolsAvailable(scope),
      scope.targetConnectionId ?? '',
      scope.connectedProject?.projectName ?? '',
      scope.connectedProject?.projectPath ?? '',
      scope.sessionProject?.name ?? '',
      scope.sessionProject?.path ?? '',
      scope.sessionProject?.engineVersion ?? '',
      scope.sessionProject?.connected ?? '',
      [...(scope.outOfScopeProjects ?? [])].sort().join(',')
    ].join('|')

  let lastCheap = cheapSignature()
  let last = signature(initial)

  return () => {
    const cheap = cheapSignature()
    if (cheap === lastCheap) return undefined
    lastCheap = cheap

    // 这里不用 try/catch：`resolveTargetProject` 自己整段兜住了，回的是
    // 「不指定」那份默认值，抛不出来
    const scope = resolveTargetProject(currentStamp())

    const next = signature(scope)
    if (next === last) return undefined
    last = next

    /*
     * 把新作用域交还给这一轮的运行记录。
     *
     * `run.scope` 是插话那条路唯一的判据：抓闪存时按它决定去问哪个编辑器，
     * 注入前又拿它核对「这张快照是不是这一轮盯着的工程」。它以前只在开跑那一刻
     * 写一次，于是 `open_project` 把这一轮切到新工程之后，用户对着**新**编辑器
     * 选中一个 Actor 插一句话，会被一句「这条插话是在「新工程」上抓的，而正在跑的
     * 这一轮盯着「旧工程」」整条拒掉 —— 用户插不进 agent 刚替他打开的那个工程。
     * 反向更糟：闪存照旧从旧工程抓，抓来的选区被拼进一轮正在写新工程的对话里。
     *
     * **只在新作用域真有工程时才换。** 插话那条路分两次 IPC 读它（先抓闪存、
     * 后核对），中间这一下要是把它换成一个没有工程的作用域（模型刚把归属改到
     * 一个没开着的工程），核对必然失败，而且连拒绝信息里都写不出工程名 ——
     * 用户只会看到一句自相矛盾的话。没工程可换时留着上一份，至少还说得出人话。
     */
    if (scope.connectedProject) onScope?.(scope)

    console.log(`[AgentV3] 会话 ${sessionId} 轮内引擎状态变了：${last}`)
    return {
      ueConnected: engineToolsAvailable(scope),
      project: connectedProjectSummary(scope),
      sessionProject: scope.sessionProject,
      outOfScopeProjects: scope.outOfScopeProjects
    }
  }
}

/**
 * 绑到执行流上的目标：连接 id **加上工程路径**。
 *
 * 路径不是可有可无的补充说明 —— 它是编辑器重启后认回新连接的唯一依据。
 * connectionId 只代表一次连接，编辑器崩一次回来就换一个，旧的那条在断开时
 * 已经被 `deleteProject()` 删了。只绑 id 的话，这一轮剩下的命令会一直发往
 * 那个死 id，而盒子界面上明明写着已连接（见 `core/projectTargetContext.ts`）。
 *
 * `sessionScoped` 是 `project_manage` 打开新工程后能不能把这一轮切过去的闸：
 * 用户给对话盖过工程戳时不许切（那是「项目对项目」要挡的越界），纯对话
 * 则跟着新打开的工程走 —— 否则工具刚把工程启动起来，这一轮剩下的命令还全
 * 发往旧工程，用户得自己去界面上切一次。
 */
/**
 * 冷启动续跑时，用执行记录给归属表播一颗种子。
 *
 * 三态照 `sessionProject` 的定义走：**缺省**（模型从没动过归属）才退回
 * `project` —— 那是上一轮实际打到的工程，续跑照它走比重新按「最近连上的」
 * 猜安全；**`null`** 是模型明确解除过，必须原样传下去，`?? project` 会把
 * 刚解除的归属复活。
 */
export function savedBindingSeed(
  saved: SessionExecutionOptions | undefined
): SessionProjectRef | null | undefined {
  return saved?.sessionProject !== undefined ? saved.sessionProject : saved?.project
}

function targetRef(
  sessionId: string,
  scope: SessionProjectScope
): {
  connectionId?: string
  projectPath?: string
  sessionId?: string
} {
  return {
    ...(scope.targetConnectionId ? { connectionId: scope.targetConnectionId } : {}),
    ...(scope.connectedProject?.projectPath
      ? { projectPath: scope.connectedProject.projectPath }
      : {}),
    // 归属不往这儿抄第二份 —— 只带 sessionId，要用的时候去 `sessionBinding` 查
    sessionId
  }
}

/**
 * 闪存块 —— 拼在用户这句话前面的那段「你说话时编辑器长什么样」。
 *
 * **主进程从不自己抓快照。** 它只把渲染层在**提交那一刻**抓好的那份拼进去。
 * 抓取必须发生在用户按下发送的瞬间：排队的消息要等上一轮跑完（可能几分钟），
 * 普通消息前面还隔着一次知识库检索，到 `execute` 才抓就已经不是「那一刻」了。
 *
 * 这里只做一件额外的事：核对工程。核不上就不拼，宁可让模型少一份上下文，
 * 也不能让它拿着 A 工程的选区在 B 工程上动手。
 */
function editorSnapshotBlock(
  snapshot: EditorSnapshot | null | undefined,
  scope: SessionProjectScope,
  sessionId: string
): string {
  if (!snapshot) return ''
  if (!snapshotMatchesScope(snapshot, scope)) {
    console.warn(
      `[AgentV3] 会话 ${sessionId} 的闪存快照来自 ${snapshot.project.projectName || '(未知工程)'}，` +
        `而这一轮的目标是 ${scope.connectedProject?.projectName || '(无)'} —— snapshot-scope-mismatch，不拼块`
    )
    return ''
  }

  const block = formatEditorSnapshotBlock(snapshot)
  /*
   * 成功也打一行 —— 这是**唯一**能从外面看出「闪存到底进没进去」的地方。
   *
   * 闪存本身在界面上完全不显示，模型又不会自报它看到了什么。没有这一行的话，
   * 验收和排查只能靠模型的回答反推「它大概是看见了吧」，那是猜。
   *
   * 只打摘要不打全文：块里带着用户的资产路径和节点名，几十行一条消息，
   * 刷屏之外还等于把工程内容抄进日志文件。要看全文去翻 transcript 的 JSONL。
   */
  const focus = snapshot.focus
  console.log(
    `[AgentV3] 会话 ${sessionId} 带上闪存：工程=${snapshot.project.projectName || '(未知)'} ` +
      `抓于=${snapshot.capturedAt} ` +
      `焦点=${focus.focusedEditor?.type ?? 'none'}/${focus.focusedEditor?.name ?? '-'} ` +
      `图=${focus.focusedGraph?.name ?? '-'} ` +
      `节点=${focus.selectedNodeCount ?? 0} Actor=${focus.selectedActorCount ?? 0} ` +
      `资产=${focus.contentBrowser?.selectedAssetCount ?? 0} 块长=${block.length}`
  )
  return block
}

/**
 * 工具实际会操作的那个工程的摘要，进系统提示词的 `<environment>` 块。
 *
 * 以前提示词只在**没连引擎**时说一句话，连上了反而什么都不告诉模型 ——
 * 它不知道现在开的是哪个工程、什么引擎版本，只能靠工具一轮轮去问。
 *
 * 只取 projectManager 内存里现成的三样。当前关卡、Nanite/Lumen 开关、
 * 插件列表这些要发 RPC，大部分对话用不上，让模型需要时自己调
 * `editor_get_project_info` 更划算。
 */
function connectedProjectSummary(
  scope: SessionProjectScope
): { name: string; engineVersion?: string; path?: string } | undefined {
  const project = scope.connectedProject
  if (!project) return undefined
  return {
    name: project.projectName,
    ...(project.engineVersion ? { engineVersion: project.engineVersion } : {}),
    ...(project.projectPath ? { path: project.projectPath } : {})
  }
}

/**
 * 展开进 SessionContext 字面量。没有工程时展开成空，不塞一个 undefined 进去。
 *
 * 两个字段分开给：`project` 是工具够得着的那个（连着的），`sessionProject` 是
 * 这条对话挂在哪个工程下的。两者可能不是同一个，见 `core/sessionScope.ts`。
 */
function withProject(scope: SessionProjectScope): {
  project?: { name: string; engineVersion?: string; path?: string }
  sessionProject?: SessionProjectScope['sessionProject']
  outOfScopeProjects?: string[]
} {
  const project = connectedProjectSummary(scope)
  return {
    ...(project ? { project } : {}),
    ...(scope.sessionProject ? { sessionProject: scope.sessionProject } : {}),
    ...(scope.outOfScopeProjects?.length ? { outOfScopeProjects: scope.outOfScopeProjects } : {})
  }
}

/**
 * 这一轮到底给不给引擎工具。
 *
 * 两个条件都要：机器上真有连接（`isUeConnected`，看的是 WebSocket 连接数），
 * 且这条对话的工程就是连着的那个（`engineAvailable`）。后者是「项目对项目」的
 * 落点 —— 对话挂在 test222 下、开着的却是别的工程时，这里返回 false，
 * ue.* 工具整个不注册，模型想越界也没有手。
 */
function engineToolsAvailable(scope: SessionProjectScope): boolean {
  return isUeConnected() && scope.engineAvailable
}

/**
 * 这一轮的运行时信封。
 *
 * 每条用户消息带一份，写进 transcript 之后就再也不动 —— 模型据此分辨
 * 「哪条状态是现在的」。修的是那条隔夜 `not_running` 被当成当前状态的 bug，
 * 完整来龙去脉见 `agent-v3/core/runtimeEnvelope.ts` 的文件头。
 *
 * `engineLink` 是**一个字段三个状态**，不是两个布尔。以前是
 * `connectedAtRunStart` + `engineToolsAvailable`，真正有意义的是它们的组合 ——
 * (false, true) 才表示「用户连着，只是没连这条对话的工程」。模型得先做一次合取
 * 推导，于是提示词里要写一句话教它怎么推。三个状态直接说出来就没有那句话了。
 */
function buildRuntimeEnvelope(scope: SessionProjectScope, scopeId: string): RuntimeEnvelope {
  const target = connectedProjectSummary(scope)

  return {
    runtimeScopeId: scopeId,
    observedAt: formatLocalNow(),
    engineLink: engineToolsAvailable(scope)
      ? 'target'
      : // 连着、但不是这条对话的工程。和「一个都没连」分开说，否则模型会去劝
        // 一个明明连着引擎的人装插件
        isUeConnected()
        ? 'other_project'
        : 'none',
    // `path` → `path_on_record`：信封里那个键名自己带着「这是登记值，不是刚查过」
    ...(target
      ? {
          targetProject: {
            name: target.name,
            ...(target.engineVersion ? { engineVersion: target.engineVersion } : {}),
            ...(target.path ? { pathOnRecord: target.path } : {})
          }
        }
      : {}),
    ...(scope.sessionProject
      ? {
          sessionProject: {
            name: scope.sessionProject.name,
            ...(scope.sessionProject.engineVersion
              ? { engineVersion: scope.sessionProject.engineVersion }
              : {}),
            ...(scope.sessionProject.path ? { pathOnRecord: scope.sessionProject.path } : {})
          }
        }
      : {}),
    ...(scope.outOfScopeProjects?.length ? { outOfScopeProjects: scope.outOfScopeProjects } : {})
  }
}

/**
 * 把这一轮的缓存表现打进日志。
 *
 * 没有这一条就没资格说「缓存改善了」—— 改完前后唯一能比的数就在这里。
 * 取最后一条 assistant 消息上厂商回报的 usage：`cacheRead` 是这次命中的缓存量，
 * `cacheWrite` 是新写进去的，两个都是 0 通常意味着前缀被改动打掉了。
 *
 * 只打日志不发事件：这是给排查用的，不是给用户看的指标。界面上那条用量条
 * 走的是另一条路（`emitContextUsage`）。
 */
function logCacheUsage(sessionId: string, agent: Agent): void {
  try {
    const messages = agent.state.messages as { role?: string; usage?: Record<string, number> }[]
    for (let i = messages.length - 1; i >= 0; i--) {
      const usage = messages[i].role === 'assistant' ? messages[i].usage : undefined
      if (!usage) continue
      console.log(
        `[AgentV3] 会话 ${sessionId} 缓存：cacheRead=${usage.cacheRead ?? 0} ` +
          `cacheWrite=${usage.cacheWrite ?? 0} input=${usage.input ?? 0} output=${usage.output ?? 0}`
      )
      return
    }
  } catch (error) {
    // 观测失败不该影响这一轮对话
    console.warn(`[AgentV3] 会话 ${sessionId} 统计缓存用量失败:`, error)
  }
}

/**
 * 每轮结束后把**真实**的上下文用量报给界面。
 *
 * 光靠 compaction 的 `onUsage` 不够：那个钩子跑在 `transformContext` 里，
 * 也就是**发请求之前**。这一轮的第一次调用时，messages 里还没有任何
 * assistant 消息，`estimateContextTokens` 取不到 provider 报的真实用量，
 * 只能按字符估算用户那一句话 —— 于是界面显示「4 tokens / 1M」，永远是 0%。
 *
 * turn_end 之后 assistant 消息已经在 state 里，它带着厂商回的 input token 数，
 * 那个数**包含系统提示词和全部工具定义**，才是用户想看的「我用掉了多少」。
 */
function emitContextUsage(
  emit: (channel: string, payload: unknown) => void,
  sessionId: string,
  agent: Agent,
  contextWindow: number
): void {
  try {
    const { tokens } = estimateContextTokens(agent.state.messages)
    if (tokens > 0) emit('agent-v3:context-usage', { sessionId, tokens, contextWindow })
  } catch (error) {
    // 用量只是个指示器，算不出来不该影响这一轮对话
    console.warn(`[AgentV3] 会话 ${sessionId} 统计上下文用量失败:`, error)
  }
}

/**
 * 这台机器上有没有「用户视角的」UE 连接。
 *
 * 底数还是 WebSocket 连接数，而不是 projectManager 的工程数 —— 插件连上到
 * 发出 project.info 之间有几秒空窗，那几秒里连接是真的、工程信息还没到，
 * 按连接数算才不会把它误判成没连。
 *
 * 但要减掉**已经认出来**的无头连接：commandlet、`-unattended`、`-nullrhi`
 * 那些跑批进程也走同一个端口连进来（见 `services/project/types.ts` 的
 * `interactive`）。真机上就栽在这里：用户把编辑器关了，一个跑完没退的验证
 * 进程还占着连接，模型照着连接数对用户说「现在连着 MetaHumanDoubaoFullDuplex」，
 * 而那个工程用户十分钟前就关了。
 *
 * 没认出来的（还在空窗期的）仍然算连着，所以这个减法只会让判断更准，
 * 不会把真编辑器判掉。
 */
function isUeConnected(): boolean {
  try {
    const sockets = serviceManager.getWebSocketService().getConnectionCount()
    return sockets - projectManager.getNonInteractiveProjects().length > 0
  } catch {
    // 服务还没起来时按未连接处理，而不是让整个请求失败
    return false
  }
}

/**
 * 给运行时状态补上持久化配置和现成的客户端配置片段。
 *
 * 界面在**服务没启动时**也要能显示地址和令牌 —— 用户的典型顺序是
 * 「先把配置粘进 Claude Code，再回来开服务」。只回 `status()` 的话
 * 停止状态下 url/token 都是 undefined，那一步就做不了。
 */
async function withHostSettings(status: McpServerHostStatus): Promise<
  McpServerHostStatus & {
    settings: { enabled: boolean; port: number; token: string; includeMutating: boolean }
    url: string
    clientConfig: string
  }
> {
  const settings = await readHostSettings()
  return {
    ...status,
    settings,
    // 停止时 status.url 是 undefined，用配置里的端口算一个出来
    url: status.url ?? hostUrl(settings),
    clientConfig: clientConfigSnippet(settings)
  }
}

export function registerAgentV3IPC(): void {
  setProviderUsageProbe(countRunsUsingProvider)

  /**
   * 两条对话抢同一个资产时，用户必须看得见。
   *
   * 他可能开着两个窗口，以为两边在干不同的活；静默失败的话他只会看到
   * 一条对话莫名其妙地绕开了任务，而真正的原因一个字都没露出来。
   *
   * 广播给所有窗口而不是只发给发起方：被挡住的是这条会话，但**该知道**
   * 的是人，而人此刻很可能正看着另一个窗口。
   */
  setLockConflictNotifier((conflict) => {
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.isDestroyed()) contents.send('agent-v3:lock-conflict', conflict)
    }
  })

  /**
   * 锁状态同时推到虚幻编辑器里，让内容浏览器把角标画出来
   * （资产锁 C 阶段，）。
   *
   * 发**不出去也不报错**：编辑器可能还没连上、可能刚被用户关掉。角标是增强
   * 显示，为它抛错会污染 agent 的执行链路，而那条链路上真正要紧的是锁本身。
   */
  const pushLocks = createLockPusher((connectionId, paths, enforced, levelLocked) => {
    void serviceManager
      .getWebSocketService()
      .callRequest(
        'locks.set',
        { paths, enforced, level_locked: levelLocked },
        connectionId,
        LOCK_PUSH_TIMEOUT_MS
      )
      .catch(() => {
        /* 编辑器没连上 / 插件是旧版没有这个命令，都不该影响锁 */
      })
  })
  // 变更回调已经把当前锁表算好传进来了，直接用 —— 自己再 listLocks() 一遍
  // 不但多一次全表拷贝，还会让「回调拿到的」和「推出去的」变成两次独立读取
  const publishLocks = (locks: LockRecord[] = listLocks()): void => {
    pushLocks(locks, listEnforced(locks))
  }
  setLockChangeListener(publishLocks)
  // 只读位翻上去 / 撤下来同样要重推：锁表没变，但文案从「会互相覆盖」
  // 变成了「保存会被拦下」
  setEnforcementChangeListener(publishLocks)

  /**
   * 工程连上来时强制重推一次（由 `restoreOnConnect` 在还原完之后触发）。
   *
   * 去重是按内容比的，而发失败的那次同样被记成「已推」。用户先在盒子里发起任务、
   * 再打开 UE 的话，只要这一轮锁表内容不再变化就一个角标都不会出现。
   *
   * 忘的是**全部**分组而不是这条连接：锁可能记在 `connectionId: undefined` 上
   * （对话没绑定目标工程时就是这样，单工程下最常见），拿真实 id 去忘碰不到它们。
   *
   * 由 ipc 层往下注册，而不是让消息层反过来 import 这个文件 —— 方向和上面
   * 那两个回调一致，理由见 `setLockRepublishTrigger` 的注释。
   */
  setLockRepublishTrigger(() => {
    pushLocks.forgetAll()
    publishLocks()
  })

  /**
   * 锁放掉的同时把只读位解掉（资产锁 B 阶段）。
   *
   * 接在锁模块内部的释放回调上，而不是三个 `releaseAll` 调用点上 ——
   * 那三处分散在两个文件里，将来加第四个入口时一定会有人忘。
   */
  setLockReleaseListener((released) => {
    void releaseEnforcement(released)
  })

  ipcMain.handle('agent-v3:locks', async () => ({ success: true, locks: listLocks() }))

  /** 输入框上方那行「当前目标」。这条会话没有目标给 null */
  ipcMain.handle('agent-v3:goal-state', async (_event, args: { sessionId?: string }) => {
    if (typeof args?.sessionId !== 'string' || !args.sessionId) return { success: true, goal: null }
    const goal = (await loadExecutionOptions(args.sessionId).catch(() => undefined))?.goal
    return {
      success: true,
      goal: goal ? { objective: goal.objective, settled: goal.settled } : null
    }
  })

  /**
   * 用户在那一行点掉目标。之后普通消息不再复核。
   * 正在跑的时候不让取消：这一轮手上拿着目标状态，复核每走一步都会把它写回去，等于没取消。
   */
  ipcMain.handle('agent-v3:goal-end', async (event, args: { sessionId?: string }) => {
    const sessionId = args?.sessionId
    if (typeof sessionId !== 'string' || !sessionId)
      return { success: false, error: '缺 sessionId' }
    if (activeAgents.has(sessionId)) return { success: false, errorKey: 'running' }
    const options = await loadExecutionOptions(sessionId)
    if (!options?.goal) return { success: true }
    delete options.goal
    await saveExecutionOptions(sessionId, options)
    event.sender.send('agent-v3:goal-state', { sessionId })
    return { success: true }
  })

  /** 工作室模式的任务板面板：名册、任务、留言、验收结论。不是工作室的会话给 null */
  /** 「外部团队」页：Claude Code 当大脑的那些团队（`ext-*`），最近的在前 */
  ipcMain.handle('agent-v3:external-teams', async () => ({
    success: true,
    teams: await listExternalTeams()
  }))

  ipcMain.handle('agent-v3:team-state', async (_event, args: { sessionId?: string }) => {
    if (typeof args?.sessionId !== 'string' || !args.sessionId) return { success: true, team: null }
    return { success: true, team: await readTeamState(args.sessionId) }
  })

  /**
   * 用户在任务板上点「重开」：卡住的那件改回待办，下一轮开局制作人会看到
   * （`boardRecap.ts` 的旧账里带「用户重开」）。
   *
   * 这一轮正跑着也允许：任务板是一份文件，这里只改一项。制作人下一轮开局一定看得到；
   * 这一轮要是改过工程，收尾对账会重读任务板，当场就能看到 —— 这是好事，不用拦。
   */
  ipcMain.handle(
    'agent-v3:team-task-reopen',
    async (event, args: { sessionId?: string; taskId?: string }) => {
      const sessionId = args?.sessionId
      const taskId = args?.taskId
      if (typeof sessionId !== 'string' || !sessionId || typeof taskId !== 'string' || !taskId) {
        return { success: false, error: 'sessionId 和 taskId 都要给' }
      }
      if (!(await isTeamSession(sessionId))) {
        return { success: false, error: '这条 session 不是团队模式' }
      }
      const store = createTeamStore(teamDirsFor(sessionId))
      const before = (await store.board()).find((task) => task.id === taskId)
      if (!before) {
        return { success: false, error: `任务板上没有 ${taskId}` }
      }
      await store.patchBoard([{ id: taskId, status: 'todo', reopenedAt: Date.now() }])
      // 打回是履历里分量最重的一条：记到干这件活的那个模型头上。记不上不影响重开本身。
      // 只有交过货（done）的才算「被用户打回」：卡住（blocked）重开多半是环境问题，
      // 而且活动记录分不清是哪件活，记下去只会冤枉上一件交货的模型
      if (before.status === 'done') {
        await recordReopen(store, taskId, createTrackRecord(trackRecordFile()).add).catch(
          (error: unknown) => console.warn('[team] 打回没记进履历:', error)
        )
      }
      event.sender.send('agent-v3:team-board', { sessionId })
      return { success: true }
    }
  )

  /**
   * 用户在成果架上「重开」一件停下的活：任务板上加一项挂着「用户重开」的待办，
   * 下一轮开局制作人在旧账里看到它，派不派、派给谁它定（见 `reopenedJobTask`）。
   *
   * 和上面的任务重开一样，这一轮正跑着也允许：改的只是两本账。
   */
  ipcMain.handle(
    'agent-v3:team-job-reopen',
    async (event, args: { sessionId?: string; jobId?: string }) => {
      const sessionId = args?.sessionId
      const jobId = args?.jobId
      if (typeof sessionId !== 'string' || !sessionId || typeof jobId !== 'string' || !jobId) {
        return { success: false, error: 'sessionId 和 jobId 都要给' }
      }
      if (!(await isTeamSession(sessionId))) {
        return { success: false, error: '这条 session 不是团队模式' }
      }
      const store = createTeamStore(teamDirsFor(sessionId))
      const job = await store.reopenJob(jobId)
      if (!job) {
        return { success: false, error: `${jobId} 不是一件停下的活` }
      }
      await store.patchBoard([reopenedJobTask(job, job.reopenedAt ?? Date.now())])
      event.sender.send('agent-v3:team-board', { sessionId })
      return { success: true }
    }
  )

  /**
   * 用户在任务板上给一个队员换模型。
   *
   * 这一轮正跑着也允许：派活在轮到它开工那一刻才读名册定模型，所以正在干的那件不受影响，
   * 下一件就用新的。记成「用户定的」，制作人改设定时会看到、除非用户开口不再改。
   */
  ipcMain.handle(
    'agent-v3:team-member-model',
    async (
      event,
      args: { sessionId?: string; name?: string; providerId?: string; modelId?: string }
    ) => {
      const { sessionId, name, providerId, modelId } = args ?? {}
      if (!sessionId || !name || !providerId || !modelId) {
        return { success: false, error: 'sessionId、name、providerId、modelId 都要给' }
      }
      if (!(await loadExecutionOptions(sessionId))?.team && !(await isHybridTeam(sessionId))) {
        return { success: false, error: '这条 session 不是团队模式' }
      }
      // 先过入职体检：不会调工具的模型换上去也干不了活，当场说清卡在哪比派活时才出错好
      const models = await loadTeamModels()
      const result = await assignMemberModel(
        createTeamStore(teamDirsFor(sessionId)),
        models?.candidates ?? teamModelCandidates((await readAiSettings()).providers),
        name,
        { providerId, modelId },
        models?.checkup
      )
      if (!result.success) return result
      event.sender.send('agent-v3:team-board', { sessionId })
      return { success: true }
    }
  )

  /**
   * 用户在任务板上辞退一个队员。规矩和制作人的 `team_dismiss` 同一份（`dismissal.ts`）：
   * 理由必填，手上有活的不能辞，没做完的任务清掉负责人，档案留底。
   *
   * 这一轮正跑着也允许，只要这个人手上没活：派活在轮到它开工时才读名册，
   * 排着队的那件会因为它不在名册上而不开工。下一轮开局制作人会被告知（`teamCarryOverBlock`）。
   */
  ipcMain.handle(
    'agent-v3:team-member-dismiss',
    async (event, args: { sessionId?: string; name?: string; reason?: string }) => {
      const { sessionId, name, reason } = args ?? {}
      if (!sessionId || !name || typeof reason !== 'string') {
        return { success: false, error: 'sessionId、name、reason 都要给' }
      }
      const hybrid = await isHybridTeam(sessionId)
      if (!hybrid && !(await loadExecutionOptions(sessionId))?.team) {
        return { success: false, error: '这条 session 不是团队模式' }
      }
      const store = createTeamStore(teamDirsFor(sessionId))
      // 混合团队的队员跑在宿主上（`core/team/hybridTeam.ts`），谁在跑问它
      const live = hybrid ? runningHybridTeam(sessionId)?.live : liveTeams.get(sessionId)
      // 没在跑的时候，账上挂着的「在干」是上次被打断留下的，下一轮开局会收掉，不算手上有活
      const running = hybrid ? live !== undefined : activeAgents.has(sessionId)
      const openJobs = running
        ? (await store.jobs()).filter((job) => job.endedAt === undefined)
        : []
      try {
        await dismissMember(store, {
          name,
          by: 'user',
          grounds: 'user',
          reason: reason.slice(0, 500),
          isBusy: (who) =>
            running &&
            (!!live?.isRunning(who) ||
              openJobs.some((job) => job.member.toLowerCase() === who.toLowerCase()))
        })
      } catch (error) {
        if (error instanceof DismissalError) {
          return { success: false, error: error.message, errorKey: error.code }
        }
        throw error
      }
      event.sender.send('agent-v3:team-board', { sessionId })
      return { success: true }
    }
  )

  /** 设置「团队」页：每个模型的体检结论和履历汇总（`modelDossier.ts`） */
  ipcMain.handle('agent-v3:team-models', async () => ({
    success: true,
    models: await loadModelDossiers()
  }))

  /** 设置「团队」页的「重新检测」 */
  ipcMain.handle(
    'agent-v3:team-model-checkup',
    async (_event, args: { providerId?: string; modelId?: string }) => {
      const { providerId, modelId } = args ?? {}
      if (!providerId || !modelId) return { success: false, error: 'providerId、modelId 都要给' }
      return recheckModel({ providerId, modelId })
    }
  )

  /**
   * 结束团队模式：之后这条对话回到普通对话，交付闸不再催。
   *
   * 任务板、队员和他们的记忆都留在盘上 —— 下次在这条对话里 `/team` 还接得上。
   * 正在跑的时候不让结束：这一轮手上拿着团队状态，收尾时会把它写回去，等于没结束。
   */
  ipcMain.handle('agent-v3:team-end', async (event, args: { sessionId?: string }) => {
    const sessionId = args?.sessionId
    if (typeof sessionId !== 'string' || !sessionId)
      return { success: false, error: '缺 sessionId' }
    // 外部团队只是标记结束：它的循环在 Claude Code 里，盒子停不了
    if (isExternalTeamId(sessionId)) {
      const found = await endExternalTeam(sessionId)
      if (found) event.sender.send('agent-v3:team-board', { sessionId })
      return found ? { success: true } : { success: false, error: '没有这个外部团队' }
    }
    if (activeAgents.has(sessionId)) return { success: false, errorKey: 'running' }
    const options = await loadExecutionOptions(sessionId)
    if (!options?.team) return { success: true }
    delete options.team
    liveTeams.delete(sessionId)
    await saveExecutionOptions(sessionId, options)
    event.sender.send('agent-v3:team-board', { sessionId })
    return { success: true }
  })

  /**
   * 强制全部解锁 —— 界面上那个逃生口。
   *
   * 任何锁一旦出 bug 卡死，用户的感受是「盒子把我工程搞坏了」而不是
   * 「有个 bug」。必须永远留一个看得见、点得到的出口。
   */
  ipcMain.handle('agent-v3:locks-release-all', async () => ({
    success: true,
    released: forceReleaseAll()
  }))

  /**
   * 抓一份「此刻」的编辑器状态 —— 闪存的唯一入口。
   *
   * 渲染层在**用户按下发送那一刻**调它（含入队、插话、Spotlight 回车），
   * 拿到的东西随消息一路带到 `execute` / `steer`。主进程自己从不在执行时补抓：
   * 那时早已不是「那一刻」，而且气泡上显示的就对不上模型收到的了。
   *
   * 外层永远回 `{ success: true, data }` —— 渲染层要过 `unwrapResult`，它只认这个
   * 形状。抓取本身的成败在 `data.ok` 里，发送流程照它降级，**绝不因为闪存抛错**。
   */
  ipcMain.handle(
    'agent-v3:editor-snapshot:capture',
    async (
      _event,
      args: { sessionProject?: SessionProjectRef | null; runningSessionId?: string }
    ): Promise<{ success: true; data: CaptureResult }> => {
      try {
        /*
         * 对话正在跑的时候提交的东西（排队的、插的），一律按**那一轮钉住的工程**抓。
         *
         * 它们最终都落在这一轮或紧接着的下一轮上，必须和正在跑的那个工程一致。
         * 自己重新解析对话戳是不够的：没盖过戳的对话跟着「最近连上的」走，
         * 等待期间新连上一个工程，抓到的就是别人的编辑器了。
         */
        const running = args?.runningSessionId
          ? activeAgents.get(args.runningSessionId)?.scope
          : undefined
        const scope = running ?? resolveTargetProject(args?.sessionProject)

        const data = await captureEditorSnapshot({
          scope,
          anyConnected: projectManager.getInteractiveProjects().length > 0
        })
        if (!data.ok) console.log(`[AgentV3] 闪存没抓到：${data.reason}`)
        return { success: true, data }
      } catch (error) {
        // 这里兜的是「解析作用域时出了意料之外的错」。抓取本身已经不抛了
        console.warn('[AgentV3] 闪存抓取入口异常:', (error as Error).message)
        return { success: true, data: { ok: false, reason: 'error' } }
      }
    }
  )

  /**
   * 用户在界面上改了这条对话的工程归属（顶栏胶囊、侧边栏「归入工程 / 移出项目」）。
   *
   * ## 为什么必须有这条通道
   *
   * 归属有两个写入方：模型（`set_session_project`）和用户（界面）。模型那边
   * 一直写的是主进程的归属表，用户这边却只写渲染层的 store —— 主进程要等到
   * 下一条消息、从消息里捎带的那份「戳」才知道。而那份戳现在只在表里还空着时
   * 用来初始化（否则模型改完归属，用户下一条消息带着旧戳上来又把它盖回去），
   * 于是对话发过第一条消息之后，用户自己改的归属主进程再也收不到：
   * 胶囊上写着 GameB，引擎命令仍然发往 GameA。
   *
   * 这不是给单一主人再加一个同步点，恰恰相反 —— 是把**本来就存在的第二个写入方**
   * 接到那个唯一的写入口上。用户点一下就是一次明确的写，和模型调工具是同一件事，
   * 该走同一条路。
   *
   * 不回发 `agent-v3:session-project`：那条事件是主进程通知渲染层，而这里的
   * 起点就是渲染层，回发只会绕一圈回到它自己。
   */
  ipcMain.handle(
    'agent-v3:set-session-project',
    async (_event, args: { sessionId?: string; project?: SessionProjectRef | null }) => {
      const sessionId = args?.sessionId?.trim()
      // 带上 `data`：渲染层走 `unwrapResult()`，它只认 `{ success, data, error? }`
      if (!sessionId) return { success: false, data: null, error: '缺少 sessionId' }

      /*
       * 值没变就到此为止 —— **在写表之前判**。
       *
       * 模型改归属时主进程会通知渲染层，渲染层把值写回自己的 store，而那一下
       * 又会走回这个 handler —— 绕回来的是同一个值。不拦的话模型每改一次归属
       * 就多一次无用的落盘。
       *
       * 判在写之后是个坑：`setSessionBinding` 已经把值（含 `engineVersion`）
       * 落进表里了，随后的早退只跳过落盘 —— 于是一次「只多了 engineVersion」的
       * 回声会把表改掉而永远不写盘，表和盘当场分叉，而这个函数的全部职责就是
       * 让两边一致。
       *
       * 路径用 `projectPathKey` 比，不比生字符串：项目库有意保留两种斜杠写法
       * （见 `utils/projectPath.ts`），生比会让 `I:\Dev\X` 和 `I:/Dev/X` 判成
       * 两个工程，每次回声白付一整轮读盘加写盘。
       */
      const before = getSessionBinding(sessionId)
      const incoming = args?.project ?? null
      if (
        before !== undefined &&
        before?.projectName === incoming?.projectName &&
        projectPathKey(before?.projectPath) === projectPathKey(incoming?.projectPath) &&
        before?.engineVersion === incoming?.engineVersion
      ) {
        return { success: true, data: null }
      }

      const next = setSessionBinding(sessionId, incoming)

      /*
       * 顺手落盘。不落的话，用户改完归属直接关掉盒子，下次冷启动时
       * `execute` 会从执行记录里灌种子 —— 灌回来的是他改之前那个。
       *
       * 只更新**已有**的记录：没跑过的对话压根没有执行记录，那种对话冷启动时
       * 本来就该听渲染层那份戳，不用在这儿凭空造一份出来。
       */
      try {
        const saved = await loadExecutionOptions(sessionId)
        if (saved) await persistSessionProject(sessionId, next, saved)
      } catch (error) {
        console.warn(
          `[AgentV3] 会话 ${sessionId} 的新工程归属没写进执行记录:`,
          (error as Error).message
        )
      }
      return { success: true, data: null }
    }
  )

  ipcMain.handle('agent-v3:execute', async (event, args: AgentV3ExecuteArgs) => {
    /*
     * 占位先抢下来，再干别的。
     *
     * 下面读执行记录要 `await`，而占位原先在 `executeAgent` 里面。顺序反过来的话，
     * 两条消息挨着发就都能越过那次 `await` 走到占位那一步，谁先谁后看调度 ——
     * 「同一会话只许一个任务」这条就成了运气。抢在最前面则和改动之前完全一致：
     * 这个 handler 从进来到占位之间一个 `await` 都没有。
     */
    const reserved = reserveRun(args.sessionId, event.sender.id)
    if (!reserved) {
      /*
       * 这句话原来是直接写给用户的：「会话 3f2a-… 正在执行中。要改方向请用
       * agent-v3:steer。」—— 一个他看不懂的 uuid，和一个 IPC 通道名。而界面上
       * 「改方向」就是在输入框里直接打字，他根本不需要知道底下叫什么。
       *
       * 只回码，文案归渲染层（`agentControlHandlers.getErrorInfo`）。`error`
       * 留着原文给日志用 —— 排查并发问题时那个 sessionId 是唯一的线索。
       */
      return {
        success: false,
        code: 'SESSION_BUSY' satisfies AgentStartRejectionCode,
        error: `session ${args.sessionId} 正在执行中`
      }
    }

    /*
     * 档位也必须在第一个 `await` 之前落下，和占位同理。
     *
     * 这两行原先在 `executeAgent` 的开头 —— 那时整个 handler 到那里没有 `await`，
     * 所以「这一轮的初始档位」总是先写、用户中途的切换后写。中间插进一次读盘的话
     * 顺序就反了：用户在模型准备期间把只读打开，那一下先落，随后这两行拿 args 里
     * 的初始值把它盖回去 —— 他明明已经切过了，工具还在照可写跑。
     */
    approvalModeBySession.set(args.sessionId, args.approvalMode ?? 'ask')
    setReadOnly(args.sessionId, (args.mode ?? 'agent') === 'ask')

    /*
     * 先认领归属，再算这一轮的作用域。
     *
     * 渲染层随消息带下来的那份戳只在**表里还什么都没有**时用来初始化；
     * 之后表说了算。以前这里每一轮都拿新戳重算，于是模型改完归属、
     * 用户下一条消息一发，旧戳又把它盖回去 —— 而工具刚跟用户说过已经改好了。
     *
     * 表还空着（盒子刚起来，这条对话第一次说话）时从执行记录里灌一颗种子，
     * 但**只认 `sessionProject`**，也就是只认「有人明确定过归属」这一件事。
     *
     * 不能用 `savedBindingSeed()`：它在 `sessionProject` 缺省时退回 `project`，
     * 而 `project` 记的是「上一轮打到了哪个工程」—— 每条对话只要有工程连着就会
     * 被写上。退回它等于把「在 GameA 上跑过一次」读成「归属 GameA」：一条用户
     * 从没归类过的普通对话，重启之后就被钉死在 GameA 上，GameA 没开着就一个
     * 引擎工具都没有，而侧边栏和顶栏胶囊一片空白 —— 这个归属没有任何投影显示
     * 得出来，用户不知道有东西该清。
     *
     * 那条退路只对「从断点继续」成立：半途的任务必须回原工程，哪怕归属没定过。
     * 新消息不是续跑，没有「半途」可言。
     *
     * 读盘只发生在这一次 —— 表里有记录就直接跳过，正常每一轮一次 IO 都不多。
     */
    const known = getSessionBinding(args.sessionId)
    let recordSeed: SessionProjectRef | null | undefined
    if (known === undefined) {
      try {
        recordSeed = (await loadExecutionOptions(args.sessionId))?.sessionProject
      } catch {
        // 记录读坏了在这里不作处理：下面 `executeAgent` 还会读一次，那次在
        // try/finally 里面，抛出来能把占位放掉。这里先按「没有记录」往下走
        recordSeed = undefined
      }
    }
    const scope = resolveTargetProject(
      adoptSessionBinding(args.sessionId, args.sessionProject, recordSeed)
    )
    // 算出来就钉在这一轮上：插话要抓闪存时读的是它，而不是自己重新解析一遍
    // 对话戳（那算出来的可能是另一个工程）
    reserved.scope = scope
    // 这一轮的运行时作用域。工具（`ue_session_health`）在自己的执行流里读到的
    // 必须是**发起它那一轮**的 id，所以和目标工程、锁主一样绑在执行流上而不是
    // 模块级变量上 —— 两条会话并发时后来者会把前一个覆盖掉。
    const runtimeScopeId = createRuntimeScopeId()
    const envelope = buildRuntimeEnvelope(scope, runtimeScopeId)

    // 整个执行流跑在这四层上下文里：里面所有 UE 工具（含并发的、含子 Agent 的）
    // 读到的目标工程、加锁时用的锁主、观测作用域、以及「这一轮准不准拍编辑器」，
    // 都是这一条会话自己的。
    return runWithRuntimeScope(runtimeScopeId, () =>
      runWithTargetConnectionId(targetRef(args.sessionId, scope), () =>
        runWithLockOwner(args.sessionId, () =>
          runWithEditorScreenshotScope(
            args.editorScreenshotEnabled ?? EDITOR_SCREENSHOT_DEFAULT,
            () => executeAgent(event, args, scope, envelope, reserved)
          )
        )
      )
    )
  })

  async function executeAgent(
    event: Electron.IpcMainInvokeEvent,
    args: AgentV3ExecuteArgs,
    scope: SessionProjectScope,
    envelope: RuntimeEnvelope,
    /** 占位在 handler 里就抢下来了（见那边的注释），这里只管用 */
    run: ActiveAgentRun
  ): Promise<unknown> {
    const {
      sessionId,
      prompt,
      mode = 'agent',
      approvalMode = 'ask',
      thinkingLevel = 'auto',
      fastMode = false,
      skillLearning = 'ask',
      // 兜底值只有 `EDITOR_SCREENSHOT_DEFAULT` 这一份，渲染层和 zod 校验读的是
      // 同一个语义 —— 三层各写各的默认，用户一个开关都没动过就会看到两种行为
      editorScreenshotEnabled = EDITOR_SCREENSHOT_DEFAULT
    } = args
    const sender = event.sender
    // `/goal <目标>`：命令词在这里吃掉，模型收到的是目标本身。
    // 认在主进程而不是让渲染层多带一个字段，见 `parseGoalCommand` 的注释。
    const goalObjective = parseGoalCommand(prompt)
    // `/team <一句话>`：开启工作室模式。和 `/goal` 并列，同样只吃掉命令词
    const teamObjective = goalObjective ? null : parseTeamCommand(prompt)
    const promptText = goalObjective ?? teamObjective ?? prompt

    const emit = (channel: string, payload: unknown): void => {
      if (!sender.isDestroyed()) sender.send(channel, payload)
    }

    // 占位、档位、`run.scope` 都在 handler 里落过了（见那边的注释）—— 它们必须
    // 排在读执行记录那次 `await` 之前，不然用户中途的切换会被初始值盖回去

    // MCP 连接是进程级的，不随会话重建。首次调用会拉起子进程并握手，
    // 之后直接复用。连不上时返回一个没有工具的 manager，不阻塞对话。
    try {
      const mcp = await ensureConnected()
      run.controller.signal.throwIfAborted()

      const ctx: SessionContext = {
        sessionId,
        // **取信封那一份，不要再算一次。** `isUeConnected()` 读的是此刻的连接数，
        // 两次调用之间插件断开的话，信封会说 available 而工具清单里一个 ue.* 都没有 ——
        // 那正好是这次改动要消灭的那类矛盾（模型手上没有工具，却被告知有）。
        // 同一个值用两处，就没有对不上的可能。
        ueConnected: envelope.engineLink === 'target',
        shellAvailable: await isShellAvailable(),
        ...withProject(scope),
        // 轮内再体检：模型自己 open_project 把工程打开之后，工具清单和环境块
        // 跟着换过去，而不是停下来请用户再发一条消息
        refreshEngine: createEngineRefresher(sessionId, scope, (next) => {
          run.scope = next
        }),
        /*
         * 换对话归属。归属住在渲染层（侧边栏按它分组），所以只能由这里接出去。
         *
         * 事件在**改完之后**发，不等渲染层回执：归属表里已经改过了，界面只是跟上。反过来等回执的话，
         * 用户切走了页面（助手路由没 keepAlive）这次调用就会挂住 —— 而
         * 监听方在常驻布局上，页面在不在都收得到。
         */
        sessionProjectControl: {
          listProjects: sessionProjectCandidates,
          onChange: (project) => {
            emit('agent-v3:session-project', {
              sessionId,
              project: project
                ? {
                    projectName: project.projectName,
                    ...(project.projectPath ? { projectPath: project.projectPath } : {}),
                    ...(project.engineVersion ? { engineVersion: project.engineVersion } : {})
                  }
                : null
            })
            /*
             * 执行记录里那份也得改。
             *
             * 「从断点继续」**优先信执行记录**，不信渲染层传下来的戳（见下面
             * `savedProject` 那段注释：任务在 A 上跑一半失败、用户顺手连上 B 时，
             * 不能顺着当前连接换工程）。所以不同步这一份的话，模型换完归属、
             * 用户一点「从断点继续」，整条任务又悄悄回到旧工程上 ——
             * 正是这次改动要消灭的那类「静默换错工程」。
             *
             * 连内存里那份 `options` 一起改（它在下面声明，这个闭包要到模型调
             * 工具时才跑）：`/goal` 的状态机每换一步就把它整份写回同一个文件，
             * 只改盘上那份的话下一次复核就把新工程盖回去了。
             */
            void persistSessionProject(sessionId, project, options)
          }
        },
        mode,
        isReadOnly: () => readOnlyBySession.get(sessionId) === true,
        // 传函数而不是定值：中途改档位立刻生效，见 approvalModeBySession
        approvalMode: () => approvalModeFor(sessionId),
        alwaysAllowed: alwaysAllowedFor(sessionId),
        thinkingLevel,
        fastMode,
        skillLearning,
        // 关着的话 `ue_screenshot` 不进这一轮的工具池，系统提示词里那句
        // 「拍一张确认一下」也跟着换掉（见 `createAgent.ts`）
        editorScreenshotEnabled,
        // 用户在「偏好设置 → 个性化」里写的常驻说明。每轮现读：用户改完设置
        // 立刻算数，而不是等他重开一次盒子 —— 读的是一个几 KB 的本地文件
        userInstructions: await readUserInstructions(),
        // 经验系统的原始账（见 agent-v3/experience/）。给了才记，会话结束后整理员才有东西看
        ...experienceHomeContext(),
        // 界面语言。同样每轮现取，用户切完语言这一轮就算数。
        // 只做兜底，不决定回复语言，见 `buildSystemPrompt` 里那条语言准则
        uiLanguage: currentMainLanguage(),
        // hasImages 决定这一轮要不要换个看得懂图的模型（Agent 模型自己支持图片输入
        // 就继续用它，见 resolveRoleForRequest）。不传的话贴进来的图会被 pi 换成
        // "(image omitted: model does not support images)"，模型照着这句话回一句
        // 「我看不到你发的图片」—— 而界面上图明明发出去了。
        modelRequest: {
          role: 'agent',
          agentType: 'agent-v3',
          hasImages: (args.images?.length ?? 0) > 0
        },
        ...(args.notebook ? { notebook: args.notebook } : {}),
        requestApproval: createApprovalRequester(sender),
        requestQuestion: createQuestionRequester(sender),
        // 语音派的活才给 voice_report：用户在界面上打字跑的没人在听，给了模型只会白调。
        // 任务表在 execute 之前就登记了（见 ipc/realtimeVoice.ts 的派发顺序），所以这里查得到
        ...(isVoiceTaskSession(sessionId)
          ? { onVoiceReport: (report) => notifyAgentRun({ type: 'report', sessionId, ...report }) }
          : {}),
        sender,
        mcp,
        runtime: envelope,
        onUsage: (info) => emit('agent-v3:context-usage', { sessionId, ...info }),
        onCompacting: (info) => emit('agent-v3:compacting', { sessionId, ...info })
      }

      /*
       * 归属是**跨轮**的，每轮重建的 options 不许把它抹掉。
       *
       * 这个字面量整份写回同一个文件。模型上一轮调 `set_session_project` 写进去的
       * `sessionProject`（尤其是「明确解除」那个 `null`）不在字面量里，于是用户
       * 随便再发一条消息就把它冲掉了 —— 下次「从断点继续」又顺着渲染层那份旧戳
       * 把归属复活，而工具当时已经跟用户说过「已解除」。
       */
      const previousOptions = await loadExecutionOptions(sessionId)
      const carried = previousOptions?.sessionProject
      // 模型跟着对话走：别的对话里切了模型，这条对话还用自己绑的那个
      const sessionModel = await resolveSessionModel(
        sessionId,
        args.sessionModel,
        previousOptions?.model
      )
      if (sessionModel.pin) ctx.modelRequest = { ...ctx.modelRequest, pin: sessionModel.pin }
      /*
       * 工作室是**跨轮**的：`/team` 开过之后，用户后面随口插的每一句都还在团队里。
       * 交付闸的提醒次数按真人消息清零 —— 用户说了新话，就该重新给制作人两次机会。
       */
      /*
       * 目标也是**跨轮**的：`/goal` 定下之后一直挂在这条会话上，直到用户在输入框上方
       * 那一行点掉（`agent-v3:goal-end`）。用户再说一句就是新的一轮，复核重新武装 ——
       * 上一轮「停下来交给你」也好、复核通过也好，用户开口了就该按目标再验一遍。
       *
       * 两套只挂一套（`activeLoop`）：新敲的命令替掉旧的。
       */
      const loop = activeLoop(
        goalObjective ? 'goal' : teamObjective ? 'team' : null,
        previousOptions
      )
      const goalSource =
        loop === 'goal' ? (goalObjective ?? previousOptions?.goal?.objective) : undefined
      const goal = goalSource
        ? {
            objective: goalSource,
            // 沿用老目标的这一轮，用户刚说的话要压过目标原文，见 `GoalLoopDeps.latestRequest`
            // promptText 是渲染层拼好的整段（知识库命中、资产库 / 工程上下文、附件正文排在前面），
            // 用户自己的话在最后。每一轮复核和续跑都要再带一遍，只留末尾一段
            ...(goalObjective
              ? {}
              : { latestRequest: tailOf(promptText, LATEST_REQUEST_MAX_CHARS) }),
            rounds: 0,
            // 用户说了新话，目标可能变了 —— 清单清空，下一轮复核按新话重拆
            checklist: [],
            mutations: [],
            settled: false
          }
        : undefined
      const team =
        loop !== 'team'
          ? undefined
          : teamObjective
            ? startTeamRound(newTeamState(teamObjective))
            : previousOptions?.team
              ? // 沿用老团队的这一轮，记下用户刚说的话：验收员看不到对话，靠它知道目标改过什么。
                // 截取的口径同上面的 `goal.latestRequest`
                startTeamRound({
                  ...previousOptions.team,
                  latestRequest: tailOf(promptText, LATEST_REQUEST_MAX_CHARS)
                })
              : undefined

      /*
       * 落盘的是**归属表**里那份，不是文件里那份。
       *
       * 表才是主人（`core/sessionBinding.ts` 的头注释：「执行记录持久化它」），
       * 可这里原先只是把文件里已有的值原样抄回去 —— 于是这一轮 `adoptSessionBinding`
       * 给老对话补上的路径**只活在内存里**：盒子一重启表就空了，`fromRecord` 读回来
       * 的还是那份只有名字的旧戳，补全白做一次；后台跑的活（定时任务、
       * `appAgentRunner`）没有渲染层送戳下来，更是一次都拿不到路径。
       *
       * 真机上的表现就是模型说「这条对话挂在 steam-taikong-diablo 名下，但我这边
       * 从来没记过它对应硬盘上哪个文件夹」—— 而用户明明在侧栏登记过。
       *
       * `null`（明确解除过）必须原样落盘，所以判的是 `!== undefined` 而不是真值。
       * 表里没有记录（还没走到 `adoptSessionBinding`）才退回文件里那份。
       */
      const bound = getSessionBinding(sessionId)
      const sessionProject = bound !== undefined ? bound : carried

      const options: SessionExecutionOptions = {
        mode,
        ...(sessionProject !== undefined ? { sessionProject } : {}),
        thinkingLevel,
        fastMode,
        skillLearning,
        ...(sessionModel.record ? { model: sessionModel.record } : {}),
        // 落盘是为了「从断点继续」—— 那条路不经过渲染层，读不到这一档的话，
        // 用户点一下「接着跑」，半程就重新长出了截图能力
        editorScreenshotEnabled,
        notebook: args.notebook,
        // 这一轮钉住的工程随执行记录落盘 —— 「从断点继续」靠它认回同一个工程，
        // 而不是重新按「最近连上的」猜一遍。见 sessionExecutionOptions 的 project
        ...(scope.connectedProject
          ? {
              project: {
                projectName: scope.connectedProject.projectName,
                ...(scope.connectedProject.projectPath
                  ? { projectPath: scope.connectedProject.projectPath }
                  : {})
              }
            }
          : {}),
        ...(goal ? { goal } : {}),
        ...(team ? { team } : {})
      }
      await saveExecutionOptions(sessionId, options)
      // 新的一轮换了 roundStartedAt：界面据它把上一轮的「卡住 / 进行中」灰掉，
      // 不推一下的话要等制作人改任务板、或者这一轮结束才刷新（2026-09-30 真机）
      if (team) emit('agent-v3:team-board', { sessionId })
      // 输入框上方那行「当前目标」：新对话第一轮时渲染层还查不到，落盘后推一下
      emit('agent-v3:goal-state', { sessionId })
      // 被新命令替掉的那一套：面板跟着收起，说一声为什么不见了。任务板、队员留在盘上，同 `agent-v3:team-end`
      if (previousOptions?.team && !team) {
        liveTeams.delete(sessionId)
        emit('agent-v3:team-board', { sessionId })
        emit('agent-v3:notice', {
          sessionId,
          message: '已结束团队模式，这一轮按目标执行。',
          level: 'info'
        })
      } else if (previousOptions?.goal && !goal) {
        emit('agent-v3:notice', {
          sessionId,
          message: '已结束当前目标，这一轮按团队模式执行。',
          level: 'info'
        })
      }
      await prepareTeam(ctx, options, emit)
      run.controller.signal.throwIfAborted()
      const { agent, selection, tools, allTools, runtime } = await createUnrealAgent(ctx)
      run.agent = agent
      run.selection = selection
      run.controller.signal.throwIfAborted()
      console.log(
        `[AgentV3] 会话 ${sessionId} 启动：model=${selection.providerId}/${selection.modelId} ` +
          `role=${selection.role} tools=${tools.length} ueConnected=${ctx.ueConnected} ` +
          `approval=${approvalMode} mcp=${mcp.getStatuses().filter((s) => s.connected).length}`
      )

      // 恢复此前的 transcript —— 应用重启后对话能接着聊，而不是从零开始
      const store = new TranscriptStore(sessionId)
      run.store = store
      const loaded = await loadTranscript(sessionId)
      run.controller.signal.throwIfAborted()
      // 崩在「等用户回答」那一刻的会话，盘上留着一个没有结果的 ask_user 调用。
      // 不补上这一条，整份上下文会被厂商以「toolCall 没有配对的 toolResult」拒掉，
      // 也就是这条对话从此再也发不出消息 —— 见 `core/resume.ts`。
      const previous = repairPendingQuestions(loaded)
      if (previous.length > 0) {
        restoreTranscript(agent, previous)
        // 只标「盘上本来就有的」。补出来的那条不在文件里，
        // 留给第一次 append 写进去，否则它每次重启都要重新补一遍。
        store.markPersisted(loaded.length)
        console.log(
          `[AgentV3] 会话 ${sessionId} 恢复了 ${loaded.length} 条历史消息` +
            `${previous.length > loaded.length ? `，补了 ${previous.length - loaded.length} 条未回答的提问结果` : ''}`
        )
      }

      // 插话回执顺手给影子队列销号：读进上下文的那条就撤不回来了
      const bridge = createEventBridge(sender, sessionId, {
        onUserMessage: (text) => markSteerDelivered(run.pendingSteers, text),
        riskOf: callRiskOf(allTools),
        freeOnFailure: runtime.freeOnFailure
      })
      // 连接中途被掐断时自动「继续尝试」，见 `core/autoResume.ts`。
      // 失败事件经它转交事件桥：决定续跑的那次，界面不会先看到一张失败卡片
      const autoResume = createAutoResume({
        signal: run.controller.signal,
        persistent: await persistentAutoResumeEnabled(),
        freeOnFailure: runtime.freeOnFailure
      })
      ctx.autoResumeAttempt = () => autoResume.attempts
      ctx.onModelRetry = (info) => notifyModelRetry(sender, sessionId, info, autoResume.attempts)
      const deliver = autoResume.wrap(bridge)
      agent.subscribe(async (event) => {
        // 同步标记，赶在下面那次落盘的 await 之前：见 `ActiveAgentRun.ending`
        if (event.type === 'agent_end') run.ending = true
        deliver(event)
        // 每轮结束落一次盘。不是每个事件都落 —— 流式 delta 期间反复写盘
        // 会拖慢主进程，而 turn_end 已经足够细：崩溃最多丢当前这一轮。
        if (event.type === 'turn_end' || event.type === 'agent_end') {
          await store.append(agent.state.messages)
          emitContextUsage(emit, sessionId, agent, selection.model.contextWindow)
          logCacheUsage(sessionId, agent)
        }
      })

      /*
       * 先落盘再复核；继续任务时也使用同一套装配。
       *
       * 给的是 `allTools` 而不是这一轮开局的 `tools`：改动台账按**工具名**判断
       * 「这一步算不算改了东西」，而起手没连引擎的那一轮里 `tools` 一个 `ue_*`
       * 都没有。模型中途把工程打开、拿到引擎工具、开始改蓝图和关卡之后，
       * 按 `tools` 记的话那些改动一条都不入账 —— 审计员会对着一张空台账签字。
       */
      attachGoalLoop(agent, ctx, allTools, options, emit, await goalMaxRounds())
      attachTeamGate(agent, ctx, options, allTools, emit)
      attachEditorWatch(agent, ctx, run, emit)

      // 信封拼在用户这句话前面一起发出去，于是它跟着这条消息一起落进 JSONL，
      // 之后再也不会被改写 —— 这正是「只追加、不回头改前缀」的落点。
      // 界面显示的是渲染层自己那份聊天记录，不受影响。
      /*
       * 贴的图落一份到盘上，把路径写进这轮的提示词。
       *
       * 模型本来就看得见这些图（它们照常进上下文），缺的是**一个能交给工具的
       * 句柄** —— 真机上用户贴了图说「照着这张生成 3D」，模型只能回一句
       * 「拿不到本地文件路径」，然后退回文生硬凑。见 promptAttachments.ts。
       */
      const attachments = await savePromptAttachments(args.images)
      run.controller.signal.throwIfAborted()
      const attachmentBlock = formatAttachmentBlock(attachments)
      // 闪存块排在附件块前面、信封后面：三块都是「机器核对过的事实」，
      // 按「这一轮的环境 → 用户带来的东西 → 用户说的话」由外向内排
      const snapshotBlock = editorSnapshotBlock(args.editorSnapshot, scope, sessionId)
      // 任务板旧账同样是「这一轮的环境」：上一轮留下的「卡住 / 进行中」摆到制作人面前
      const teamBlock = await teamCarryOverBlock(ctx, options)
      /*
       * 多媒体先走对象存储，走不通再退（AGENTS.md 第 5 节，见 promptMedia.ts）。
       *
       * 图片：传得上去的变成引用，发请求时换成 image_url 链接；传不上去的交回
       * base64 那条路 —— 进上下文前要过关口，渲染层压过但那是尽力而为，见 admitPromptImages。
       * 音视频：传得上去的变成引用，传不上去的只给路径。
       * 引用都是独立的文本块，发请求时才在 streamFn 里换成厂商认的多媒体块。
       */
      const pictures = await preparePromptImages(args.images ?? [], selection)
      const admitted = await admitPromptImages(pictures.inline)
      const media = await preparePromptMedia(args.mediaFiles ?? [], selection, (note) =>
        emit('agent-v3:notice', { sessionId, message: note, level: 'info' })
      )
      run.controller.signal.throwIfAborted()
      const userText = [
        teamBlock,
        snapshotBlock,
        attachmentBlock,
        ...admitted.notices,
        media.note,
        promptText
      ]
        .filter(Boolean)
        .join('\n\n')
      const promptWithEnvelope = withRuntimeEnvelope(userText, envelope)

      const mediaRefs = [...pictures.refs, ...media.refs]
      await autoResume.run(
        () =>
          mediaRefs.length === 0
            ? withTeamScope(options, () => agent.prompt(promptWithEnvelope, admitted.images))
            : withTeamScope(options, () =>
                agent.prompt({
                  role: 'user',
                  content: [
                    { type: 'text', text: promptWithEnvelope },
                    ...mediaRefs.map((ref) => ({ type: 'text' as const, text: mediaRefText(ref) })),
                    ...admitted.images
                  ],
                  timestamp: Date.now()
                })
              ),
        agent,
        {
          ...autoResumeHooks(sessionId, run, store, emit),
          resume: () => withTeamScope(options, () => agent.continue())
        }
      )

      // pi 把 provider 失败编码进事件流而不是抛异常，所以 prompt() 正常返回
      // 也可能什么都没发生。agent.state.errorMessage 是权威判据 ——
      // 不看它的话调用方会拿到 success 却一个字都没收到。
      if (agent.state.errorMessage) {
        if (isUserAbort(agent.state.errorMessage)) return { success: true, stopped: true }
        return { success: false, error: agent.state.errorMessage }
      }

      return {
        success: true,
        modelId: selection.modelId,
        providerId: selection.providerId,
        // 未连接引擎时 ue.* 整个不注册，工具池从 77 掉到 14。
        // 调用方（调试台、验证脚手架）判断「模型为什么没选那个工具」时，
        // 第一件要确认的就是它到底看没看见这个工具。
        //
        // **数量答不了这个问题**：两份同样大小的工具池内容可以完全不同。
        // 评测要判「模型是不是本来就有直接动手的选项」，只能逐个名字核对，
        // 所以这里连名字一起回传（约 1.5KB，一轮一次）。
        toolCount: tools.length,
        toolNames: tools.map((tool) => tool.name),
        ueConnected: ctx.ueConnected,
        restoredMessages: previous.length
      }
    } catch (error) {
      // 用户按停止、或者直接把对话删了：中止是**意图达成**，不是故障。
      // 不在这里拦掉的话，一次删除会弹一条英文红字 "This operation was aborted"。
      if (isUserAbort(error)) {
        // 补一条 stopped：异常从工具里抛出来时，pi 未必来得及发那条
        // stopReason='aborted' 的消息，界面就会一直转圈等一个不会来的结束事件。
        // 重复发是安全的 —— 第一条已经把处理器摘掉了，第二条找不到人。
        emit('agent-v3:stopped', { sessionId })
        // 旁路也补一条。`emit` 只发给界面，不走 eventBridge 那条旁路广播 ——
        // 语音的任务表靠旁路才知道这件活是「停下了」而不是「还在跑」
        notifyAgentRun({ type: 'stopped', sessionId })
        return { success: true, stopped: true }
      }

      const message = (error as Error).message
      console.error(`[AgentV3] 会话 ${sessionId} 失败:`, error)
      // 只通过返回值报错：调用方仍在 await 这个 invoke，再发一条事件的话
      // 界面会出现两条一模一样的红字。
      // （这里曾经还往 V2 的 `agent:error` 发一份，说是「存量界面靠它收尾」——
      // 那条通道连 preload 白名单都没进，渲染层想订阅都会被挡下，发了等于扔进真空。）
      notifyAgentRun({ type: 'error', sessionId, message })
      return { success: false, error: message }
    } finally {
      stopEditorWatch(sessionId)
      activeAgents.release(sessionId)
      // 资产锁的**唯一**释放点。用户按停止、模型报错、异常抛穿都走这里；
      // 进程崩了则整张锁表跟着消失 —— 所以不需要 TTL 和心跳。
      releaseAll(sessionId)
      // 会话**真的**空出来了。语音任务表排队的下一件要等这一条，不能等 `done`：
      // `done` 是事件流里的最后一条，但它发出来时 prompt() 还没返回、上面的
      // release 还没跑 —— 那会儿派下一件，收到的就是开头那个 `SESSION_BUSY`
      notifyAgentRun({ type: 'released', sessionId })
      // 界面上排队的跟进消息要等的也是这一条，理由同上。旁路（notifyAgentRun）
      // 只发给主进程内部的订户，渲染层收不到，所以这里要单独发一份
      emit('agent-v3:released', { sessionId })
    }
  }

  /**
   * 从断点续跑 —— 上一轮因为报错或网络中断停下时用。
   *
   * 与重新 execute 的区别：保留全部上下文，不重开一轮，模型接着上次的位置继续，
   * 而不是从头理解一遍任务。
   */
  ipcMain.handle('agent-v3:continue', async (event, args: AgentV3ContinueArgs) => {
    const run = reserveRun(args.sessionId, event.sender.id)
    if (!run) {
      return {
        success: false,
        code: 'SESSION_BUSY' satisfies AgentStartRejectionCode,
        error: `session ${args.sessionId} 正在执行中`
      }
    }
    if (args.approvalMode) approvalModeBySession.set(args.sessionId, args.approvalMode)
    if (args.mode) setReadOnly(args.sessionId, args.mode === 'ask')
    try {
      /*
       * 工程**沿用上一轮钉住的那个**，不重新解析。
       *
       * 渲染层传来的对话戳只在没有执行记录时（存量对话）才用。原因：没盖过戳的
       * 对话，重新解析算出来的是「当前工程」= 最近连上的那个。于是任务在 A 上跑到
       * 一半失败、用户顺手连上 B、点「从断点继续」—— 半途的任务就跑到 B 上去了，
       * 而且一个字都不会说。半途换工程比停下来危险得多。
       *
       * 原工程此刻没连着的话，作用域自然给出 engineAvailable: false，模型被告知
       * 引擎不可用 —— 这正是我们要的，而不是顺手换一个能用的。
       */
      const saved = await loadExecutionOptions(args.sessionId)
      // 同 execute：归属从表里来，执行记录只在表还空着时用来初始化
      const scope = resolveTargetProject(
        adoptSessionBinding(args.sessionId, args.sessionProject, savedBindingSeed(saved))
      )
      /**
       * 续跑**沿用上一轮信封的作用域**，不新开一个。
       *
       * 这条路不产生新的用户消息（`agent.continue()` 要求最后一条是 user 或
       * toolResult），所以没有新信封可发。硬造一个新 id 的话，续跑里那次健康检查
       * 会盖上一个和任何信封都对不上的戳，模型按规则把一份刚拿到的新鲜观测
       * 当成历史 —— 比不盖还糟。找不回来（存量对话）就现开一个，
       * 那些对话本来就没有信封，整套机制对它们静默失效。
       */
      // 读一次就够：作用域和下面的续跑计划都用这一份
      const loaded = await loadTranscript(args.sessionId)
      run.controller.signal.throwIfAborted()
      const runtimeScopeId = lastRuntimeScopeId(loaded) ?? createRuntimeScopeId()

      // 续跑是同一条会话，锁主自然还是它 —— 上一轮的锁已经在它的 finally 里放掉了。
      // 截图那一档同样沿用执行记录：续跑不经过渲染层，args 里没有这个字段，
      // 按默认档走的话「接着跑」那半程会重新长出用户关掉的能力
      return await runWithRuntimeScope(runtimeScopeId, () =>
        runWithTargetConnectionId(targetRef(args.sessionId, scope), () =>
          runWithLockOwner(args.sessionId, () =>
            runWithEditorScreenshotScope(
              saved?.editorScreenshotEnabled ?? EDITOR_SCREENSHOT_DEFAULT,
              () => continueAgent(event, args, scope, loaded, run)
            )
          )
        )
      )
    } catch (error) {
      if (isUserAbort(error)) {
        if (!event.sender.isDestroyed())
          event.sender.send('agent-v3:stopped', { sessionId: args.sessionId })
        notifyAgentRun({ type: 'stopped', sessionId: args.sessionId })
        return { success: true, stopped: true }
      }
      return { success: false, error: (error as Error).message }
    } finally {
      stopEditorWatch(args.sessionId)
      activeAgents.release(args.sessionId)
      releaseAll(args.sessionId)
      notifyAgentRun({ type: 'released', sessionId: args.sessionId })
      // 续跑也要发：界面排着的跟进消息不该因为这一轮走的是「接着跑」而卡住
      if (!event.sender.isDestroyed())
        event.sender.send('agent-v3:released', { sessionId: args.sessionId })
    }
  })

  async function continueAgent(
    event: Electron.IpcMainInvokeEvent,
    args: AgentV3ContinueArgs,
    scope: SessionProjectScope,
    loaded: AgentMessage[],
    run: ActiveAgentRun
  ): Promise<unknown> {
    const { sessionId } = args
    const sender = event.sender

    // 先补掉半路挂着的提问。不补的话 `planResume` 会看见末尾是一条 assistant，
    // 回一句「上一轮已正常结束，没有可续跑的断点」—— 而它明明停在等人回答上。
    const previous = repairPendingQuestions(loaded)
    const repaired = previous.length - loaded.length
    const onDisk = await loadExecutionOptions(sessionId)
    const options = resumeExecutionOptions(onDisk, args.mode)
    run.controller.signal.throwIfAborted()

    /*
     * 续跑同样要把工程钉在这一轮上。
     *
     * 这里以前一直没写，于是插话那条路读到的 `entry.scope` 是 `undefined`：
     * 「快照和这一轮盯的工程对不对得上」那道闸整个被跳过，而闪存块也被
     * 一句 `scope ? … : ''` 直接丢掉 —— 用户选中一个 Actor 说「改这个」，
     * 模型收到的是一句没有指代对象的「改这个」，只能按名字去猜。
     */
    run.scope = scope

    // 提前到这里声明：下面 ctx 里的 `sessionProjectControl` 要用它给渲染层发事件，
    // 而那个闭包在 `createUnrealAgent` 之前就得组装好
    const emit = (channel: string, payload: unknown): void => {
      if (!sender.isDestroyed()) sender.send(channel, payload)
    }

    // 续跑最主要的场景就是「上一轮报错了」，而 pi 会把失败也记成一条 assistant
    // 消息 —— 不先摘掉它，continue() 必然抛 "Cannot continue from role: assistant"，
    // 也就是说这个功能对它存在的理由完全失效。判定和摘除都在 planResume 里。
    let plan = planResume(previous)
    const withoutFailure = trimForResume(previous)
    const last = withoutFailure.at(-1)
    const resumeAudit =
      !plan.ok &&
      options.goal &&
      !options.goal.settled &&
      last?.role === 'assistant' &&
      last.stopReason === 'stop'
    if (resumeAudit) {
      plan = {
        ok: true,
        messages: withoutFailure,
        trimmed: previous.length - withoutFailure.length
      }
    }
    if (!plan.ok) {
      return { success: false, error: plan.reason }
    }

    // 续跑认回这条对话绑定的模型：渲染层带下来的优先（用户可能刚换过），
    // 其次执行记录里那份。都没有的存量对话照旧走全局默认
    const resumeModel =
      args.sessionModel || options.model
        ? await resolveSessionModel(sessionId, args.sessionModel, options.model)
        : {}

    // 应用刚重启、用户第一件事就是点「从断点继续」时，主进程这边还没有档位
    // 可言（默认是最严的一档）—— 渲染层带下来的那份才是用户设的。
    const ctx: SessionContext = {
      mode: options.mode,
      isReadOnly: () => readOnlyBySession.get(sessionId) === true,
      thinkingLevel: options.thinkingLevel,
      fastMode: options.fastMode,
      skillLearning: options.skillLearning,
      // 同上：这一档也从执行记录里来，不然续跑那半程 `ue_screenshot` 会重新出现
      editorScreenshotEnabled: options.editorScreenshotEnabled,
      // 续跑也要带上：漏掉的话「接着跑」那半程会按默认习惯干活，
      // 用户看到的是同一条对话前后两种脾气
      userInstructions: await readUserInstructions(),
      uiLanguage: currentMainLanguage(),
      ...experienceHomeContext(),
      ...(options.notebook ? { notebook: options.notebook } : {}),
      sessionId,
      ueConnected: engineToolsAvailable(scope),
      shellAvailable: await isShellAvailable(),
      ...withProject(scope),
      /*
       * 续跑和正常一轮拿同样的两样东西，**不是可选项**。
       *
       * 这条路照样走 `runWithTargetConnectionId`，所以 `open_project` 在这里照样
       * 会等编辑器、照样会切目标。少了 `refreshEngine`，切完之后工具清单和
       * `<environment>` 就停在续跑开始时那个工程上 —— 命令去了新工程，提示词
       * 说的是旧工程，正是 `runtimeEnvelope.ts` 花大力气消灭的那种自相矛盾。
       *
       * 而系统提示词里那几条规则是**无条件**发的：它告诉模型「工具清单每步都会
       * 重算」「要换工程就调 set_session_project」。不把这两样接上，那两句话
       * 在续跑里就是假的，模型会去调一个不在清单里的工具。
       */
      // 归属和上面算 scope 时同源 —— 都问那张表，没有第二个判据
      refreshEngine: createEngineRefresher(sessionId, scope, (next) => {
        run.scope = next
      }),
      sessionProjectControl: {
        listProjects: sessionProjectCandidates,
        onChange: (project) => {
          emit('agent-v3:session-project', {
            sessionId,
            project: project
              ? {
                  projectName: project.projectName,
                  ...(project.projectPath ? { projectPath: project.projectPath } : {}),
                  ...(project.engineVersion ? { engineVersion: project.engineVersion } : {})
                }
              : null
          })
          /*
           * 带上盘上那份 `mode`。
           *
           * `resumeExecutionOptions` 会把档位**单向**夹到 `ask`（这一次以只读续跑
           * 就永远只读）。那个夹子是给这一次运行用的，不该落盘 —— 落了的话，
           * 一次只读续跑 + 一次换归属，就把这条会话永久钉死在只读上，
           * 而且没有任何入口能改回来。
           */
          void persistSessionProject(sessionId, project, options, onDisk?.mode)
        }
      },
      // 续跑同样跟着实时档位走，而且沿用这条会话已经「始终允许」过的工具 ——
      // 断点续跑对用户就是「接着刚才那件事」，凭什么重新问一遍
      approvalMode: () => approvalModeFor(sessionId),
      alwaysAllowed: alwaysAllowedFor(sessionId),
      // 续跑的那一轮如果带着图（用户贴的图那轮报错了），同样要走视觉模型，
      // 否则「接着跑」等于把图丢掉重来一遍。
      modelRequest: {
        role: 'agent',
        agentType: 'agent-v3',
        hasImages: currentTurnHasImages(plan.messages),
        ...(resumeModel.pin ? { pin: resumeModel.pin } : {})
      },
      requestApproval: createApprovalRequester(sender),
      requestQuestion: createQuestionRequester(sender),
      ...(isVoiceTaskSession(sessionId)
        ? { onVoiceReport: (report) => notifyAgentRun({ type: 'report', sessionId, ...report }) }
        : {}),
      sender,
      mcp: await ensureConnected()
    }

    try {
      run.controller.signal.throwIfAborted()
      // 续跑照样是工作室：团队、任务板、队员的记忆都在盘上，接着用
      await prepareTeam(ctx, options, emit)
      const { agent, selection, allTools, runtime } = await createUnrealAgent(ctx)
      run.agent = agent
      run.selection = selection
      run.controller.signal.throwIfAborted()
      const store = new TranscriptStore(sessionId)
      run.store = store
      restoreTranscript(agent, plan.messages)
      // 只标「盘上本来就有的」—— 补出来的提问结果还没落盘，得让下面那次 append 写进去
      store.markPersisted(loaded.length)

      // 摘掉的失败标记也要从盘上去掉，否则下次恢复又把它读回来。
      // append 在长度变短时会整文件重写（见 TranscriptStore.append）。
      if (plan.trimmed > 0 || repaired > 0) {
        await store.append(plan.messages, { strict: true })
        console.log(
          `[AgentV3] 会话 ${sessionId} 续跑前摘掉 ${plan.trimmed} 条失败标记` +
            `${repaired > 0 ? `，补了 ${repaired} 条未回答的提问结果` : ''}`
        )
      }

      // 插话回执顺手给影子队列销号：读进上下文的那条就撤不回来了
      const bridge = createEventBridge(sender, sessionId, {
        onUserMessage: (text) => markSteerDelivered(run.pendingSteers, text),
        riskOf: callRiskOf(allTools),
        freeOnFailure: runtime.freeOnFailure
      })
      // 同 execute：手动「继续尝试」这一轮里再断，同样自动接着跑
      const autoResume = createAutoResume({
        signal: run.controller.signal,
        persistent: await persistentAutoResumeEnabled(),
        freeOnFailure: runtime.freeOnFailure
      })
      ctx.autoResumeAttempt = () => autoResume.attempts
      ctx.onModelRetry = (info) => notifyModelRetry(sender, sessionId, info, autoResume.attempts)
      const deliver = autoResume.wrap(bridge)
      agent.subscribe(async (e) => {
        // 同步标记，赶在下面那次落盘的 await 之前：见 `ActiveAgentRun.ending`
        if (e.type === 'agent_end') run.ending = true
        deliver(e)
        if (e.type === 'turn_end' || e.type === 'agent_end') {
          await store.append(agent.state.messages)
          emitContextUsage(
            (channel, payload) => {
              if (!sender.isDestroyed()) sender.send(channel, payload)
            },
            sessionId,
            agent,
            selection.model.contextWindow
          )
          logCacheUsage(sessionId, agent)
        }
      })
      // 同 execute：改动台账要看**全量**工具名，不能只看这一轮开局那份 ——
      // 续跑里模型照样可能中途把工程打开、拿到引擎工具再开始改东西
      const goalLoop = attachGoalLoop(agent, ctx, allTools, options, emit, await goalMaxRounds())
      attachTeamGate(agent, ctx, options, allTools, emit)
      attachEditorWatch(agent, ctx, run, emit)
      if (goalLoop) {
        emit('agent-v3:goal', {
          sessionId,
          message: `继续原目标：${options.goal!.objective}（已复核 ${options.goal!.rounds} 轮）`,
          level: 'info'
        })
      }
      run.controller.signal.throwIfAborted()
      // 干活已结束、只在复核期间中断：先补复核，避免重复执行已经完成的改动。
      if (resumeAudit) {
        if (!goalLoop)
          return { success: false, error: checkGoalPreconditions({ mode: options.mode }).reason }
        await goalLoop({ type: 'turn_end', message: last!, toolResults: [] }, run.controller.signal)
        run.controller.signal.throwIfAborted()
        if (options.goal?.settled) {
          bridge({ type: 'agent_end', messages: agent.state.messages })
          return { success: true, restoredMessages: plan.messages.length }
        }
      }
      const resume = (): Promise<void> => withTeamScope(options, () => agent.continue())
      await autoResume.run(resume, agent, {
        ...autoResumeHooks(sessionId, run, store, emit),
        resume
      })

      // 同 execute：provider 失败编码在 state 里，不抛异常
      if (agent.state.errorMessage) {
        if (isUserAbort(agent.state.errorMessage)) return { success: true, stopped: true }
        return { success: false, error: agent.state.errorMessage }
      }
      return { success: true, restoredMessages: plan.messages.length }
    } catch (error) {
      // 同 execute：中止是用户的意图，不该报成续跑失败
      if (isUserAbort(error)) {
        if (!sender.isDestroyed()) sender.send('agent-v3:stopped', { sessionId })
        notifyAgentRun({ type: 'stopped', sessionId })
        return { success: true, stopped: true }
      }

      const message = (error as Error).message
      console.error(`[AgentV3] 会话 ${sessionId} 续跑失败:`, error)
      // 同 execute：一次失败只报一次，走返回值
      notifyAgentRun({ type: 'error', sessionId, message })
      return { success: false, error: message }
    }
  }

  /**
   * 刷新页面之后，把界面重新接回还在跑的会话。
   *
   * agent 活在**主进程**，`window.location.reload()` 只是把界面重启了一遍 ——
   * 模型还在推理，工具还在执行，transcript 还在往盘上写。但渲染层丢了三样东西：
   * invoke 的返回 Promise、「哪条消息正在打字」、以及 sessionId ↔ 对话的对应关系。
   * 于是界面按「一律当作中断」处理，给每条残留的回复贴上「会话已中断（页面刷新）」,
   * 而它其实还在跑，甚至还在改用户的工程。更糟的是 `activeAgents` 里那个位置
   * 还占着，用户刷新后立刻再说一句，会被顶回来一个 `SESSION_BUSY`。
   *
   * 这个通道就是那次缺失的询问：界面报上它记得的会话，主进程回哪些真的活着。
   *
   * **按 senderId 过滤**。事件是往当初那个 webContents 发的（刷新不换 id，
   * 所以自己刷新自己能认领回来）；换成别的窗口来认领，它只会得到一个永远
   * 转圈的气泡 —— 事件根本不会送到它那里。
   */
  ipcMain.handle('agent-v3:reattach', async (event, args?: { sessionIds?: string[] }) => {
    const sender = event.sender
    const requested = args?.sessionIds
    const candidates = Array.isArray(requested) ? new Set(requested) : null

    const sessionIds = [...activeAgents.entries()]
      .filter(
        ([sessionId, entry]) =>
          entry.kind === 'agent' &&
          entry.senderId === sender.id &&
          (!candidates || candidates.has(sessionId))
      )
      .map(([sessionId]) => sessionId)

    // 卡在审批框上刷新的那种情况：弹窗没了，主进程还阻塞在 beforeToolCall 里，
    // 不补发一遍它就一直等到超时然后按拒绝处理
    const pendingApprovals = resendPendingApprovals(sender, sessionIds)
    // 同理，卡在提问卡片上刷新：卡片没了，主进程还阻塞在 ask_user 里等回复
    const pendingQuestions = resendPendingQuestions(sender, sessionIds)

    if (sessionIds.length > 0) {
      console.log(
        `[AgentV3] 窗口 ${sender.id} 重新接管 ${sessionIds.length} 条运行中的会话` +
          `${pendingApprovals > 0 ? `，补发 ${pendingApprovals} 条待审批` : ''}` +
          `${pendingQuestions > 0 ? `，补发 ${pendingQuestions} 条待回答` : ''}`
      )
    }

    return { sessionIds, pendingApprovals, pendingQuestions }
  })

  ipcMain.handle('agent-v3:list-sessions', async () => listTranscripts())

  /**
   * 技能清单。输入框的 `/` 菜单和「技能」设置页共用这一条。
   *
   * 只返回展示字段，不把本机技能目录暴露给渲染层。另外两个字段各有用处：
   * `source` 决定详情弹窗里保存是原地改还是另存副本，`enabled` 让设置页
   * 能把关掉的也列出来（不列就没法再打开），而 `/` 菜单据此把关掉的滤掉 ——
   * 菜单里摆着一条选了也不会加载的技能，比不摆更糟。
   *
   * **列的是盘上全部**，不是 agent 实际拿到的那份：过滤在
   * `discoverEnabledSkills()` 里，两边不能混用（见那个函数的注释）。
   */
  ipcMain.handle('agent-v3:list-skills', async () => {
    const skills = await discoverSkillsOnDisk()
    const { sharedSkillOrigins } = await import('../services/share/sharedSkills')
    return {
      skills: listSkillSummaries(
        skills,
        await readDisabledSkills(),
        await sharedSkillOrigins(skills)
      )
    }
  })

  /** 详情弹窗：读 SKILL.md 全文（含 frontmatter）。名字对不上返回 null */
  ipcMain.handle('agent-v3:read-skill', async (_event, name: unknown) => {
    if (typeof name !== 'string') return { document: null }
    return { document: await readSkillDocument(name) }
  })

  /**
   * 详情弹窗：写回正文。
   *
   * 内置和插件带的会在用户目录里另存一份覆盖它，不原地改 —— 理由见
   * `writeSkillDocument`。frontmatter 的校验也在那儿：写坏了会被静默跳过，
   * 保存完技能就从清单上消失，这种失败必须在保存这一步挡住。
   */
  ipcMain.handle(
    'agent-v3:write-skill',
    async (_event, args: { name?: unknown; content?: unknown }) => {
      if (typeof args?.name !== 'string' || typeof args?.content !== 'string') {
        return { success: false, error: '技能名和正文都必须是文本' }
      }
      return writeSkillDocument(args.name, args.content)
    }
  )

  /*
   * 技能页的「经验」分组（见 agent-v3/experience/library.ts）。
   *
   * 工程名单取项目库：界面回传的工程路径要拼进写文件的路径，只认库里登记过的。
   */
  const experienceProjects = (): LibraryProject[] =>
    projectLibrary().flatMap((p) =>
      p.projectPath ? [{ name: p.projectName || p.projectPath, path: p.projectPath }] : []
    )

  ipcMain.handle('agent-v3:list-experiences', async () => {
    try {
      return { success: true, ...(await listExperiences(experienceHome(), experienceProjects())) }
    } catch (error) {
      return {
        success: false,
        entries: [],
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  ipcMain.handle(
    'agent-v3:set-experience-pinned',
    async (_event, args: { ref?: unknown; pinned?: unknown }) => {
      const ref = parseExperienceRef(args?.ref)
      if (!ref || typeof args?.pinned !== 'boolean') {
        return { success: false, error: '参数不对：需要经验的位置和固定状态' }
      }
      const found = await setExperiencePinned(
        experienceHome(),
        experienceProjects(),
        ref,
        args.pinned
      )
      return found ? { success: true } : { success: false, error: '该经验不存在' }
    }
  )

  ipcMain.handle('agent-v3:delete-experience', async (_event, rawRef: unknown) => {
    const ref = parseExperienceRef(rawRef)
    if (!ref) return { success: false, error: '参数不对：需要经验的位置' }
    const found = await deleteExperience(experienceHome(), experienceProjects(), ref)
    return found ? { success: true } : { success: false, error: '该经验不存在' }
  })

  ipcMain.handle('agent-v3:undo-last-curation', async () => {
    try {
      const undone = await undoLastCuration(experienceHome(), experienceProjects())
      return undone ? { success: true, undone } : { success: false, error: '没有可以撤销的整理' }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /** 关掉 / 打开一个技能。下一轮开始生效（清单在 agent 装配时读一次） */
  ipcMain.handle(
    'agent-v3:set-skill-disabled',
    async (_event, args: { name?: unknown; disabled?: unknown }) => {
      if (typeof args?.name !== 'string' || typeof args?.disabled !== 'boolean') {
        return { success: false, error: '参数不对：需要技能名和开关状态' }
      }
      try {
        await setSkillDisabled(args.name, args.disabled)
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /**
   * 删掉用户自己那几条技能。
   *
   * 和清单同处一个文件，是因为它们是同一件事的两半 —— 上一版把「列」放在
   * agent-v3、「删」放在 personalization，界面上于是也跟着裂成两页。
   *
   * 名字进来，拼路径和越界校验都在 `deleteUserSkills` 里做：渲染层给的名字
   * 不能直接拼进路径，同一层目录下放着凭据文件。内置和插件带的删不掉 ——
   * 那不是「它学会的」，是随包发的。
   */
  ipcMain.handle('agent-v3:delete-skills', async (_event, names: unknown) => {
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
      return { success: false, deleted: 0, error: '技能名必须是字符串数组' }
    }
    try {
      return { success: true, deleted: await deleteUserSkills(names as string[]) }
    } catch (error) {
      return {
        success: false,
        deleted: 0,
        error: error instanceof Error ? error.message : String(error)
      }
    }
  })

  /**
   * 「本轮改动」按风险筛工具，风险声明来这里取。
   *
   * **必须把 MCP 工具也算进来。** 原来只回注册表那一份静态声明，于是
   * `mcp_*` 开头的工具在表里查不到 —— 渲染层 `summarizeChanges()` 的规则是
   * 「查不到风险就跳过」，结果 agent 明明用引擎工具集改了东西，
   * 「本轮改动」里一条都不显示。**改动清单漏报比没有清单更糟**：
   * 用户会以为那一步什么也没干。
   *
   * 每次现算而不是缓存：MCP 连接是会变的（用户加 server、开引擎工具集）。
   */
  ipcMain.handle('agent-v3:tool-risks', async () => {
    const table = listToolRisks()
    try {
      for (const tool of (await ensureConnected()).getTools()) {
        table[tool.name] = tool.unrealBox.risk
      }
    } catch (error) {
      // 拿不到 MCP 工具时退回静态表：少几行总比整个清单不显示强
      console.warn('[AgentV3] 合并 MCP 工具风险失败:', (error as Error).message)
    }
    return table
  })

  /**
   * 「设置 → 工具」那一页的清单。
   *
   * **只有盒子自带的工具，不含第三方 MCP。** 那些归「MCP」设置页管（接哪台
   * 服务器、开不开放写操作）—— 同一批工具两个页面各有一个开关，用户关了一个
   * 发现还在，只会以为开关坏了。
   *
   * 传 `event.sender` 是为了把需要通知渲染层的那几个工具也造出来
   * （见 `Registration.needsSender`）：设置页比后端窄，用户就会在清单里找不到
   * 一个正在跑的工具。
   */
  ipcMain.handle('agent-v3:list-tools', async (event) => ({
    tools: listToolCatalog({ sender: event.sender })
  }))

  /**
   * 当前绑定的模型能调哪几档思考。
   *
   * 输入框那个下拉必须按模型现问 —— 档位是各家模型自己声明的，写死一份
   * 清单会列出这个模型根本没有的档位，选了内核会悄悄夹到最近的一档。
   */
  ipcMain.handle('agent-v3:thinking-levels', async (_event, args?: { model?: SessionModel }) => {
    // 按对话绑定的模型问；那个模型用不了时和发消息一样退回全局默认
    const pin = await pinnableSessionModel(args?.model)
    return listThinkingLevels({ role: 'agent', agentType: 'agent-v3', ...(pin ? { pin } : {}) })
  })

  /**
   * 这条对话绑定的模型（执行记录里那份）。
   *
   * 渲染层的对话上没记模型时（存量对话、分支出来的小窗口）用它认回来，
   * 而不是按此刻的全局默认绑上 —— 那可能已经被别的对话改过了。
   */
  ipcMain.handle('agent-v3:session-model', async (_event, args: { sessionId: string }) => {
    try {
      return (await loadExecutionOptions(args.sessionId))?.model ?? null
    } catch {
      return null
    }
  })

  /**
   * 在编辑器里打开「本轮改动」里的某个资产。
   *
   * 清单只能告诉用户「M_GlowBreath 是新建的」，说不清它长什么样 ——
   * 那一步交给编辑器本身，一键打开，眼见为实。见 openAsset.ts 的文件头。
   */
  ipcMain.handle('agent-v3:open-asset', async (_event, args: { contentPath: string }) =>
    openAssetInEditor(args.contentPath)
  )

  /**
   * 审查这一轮改过的资产 —— 「它说做完了，到底做成了没有」。
   *
   * 问的是引擎的当前状态，不是模型的记忆：资产在不在、改动落盘没有、蓝图编译
   * 过不过、引用有没有指向不存在的东西。见 `core/reviewChanges.ts` 的文件头。
   */
  ipcMain.handle(
    'agent-v3:review-changes',
    async (_event, args: { targets: AgentReviewTarget[] }) => reviewChanges(args?.targets ?? [])
  )

  /**
   * 资产快照 —— **原型**，只给真机验证脚本用（tests/manual/verify-asset-snapshot.mjs）。
   *
   * 这条链（保存 → 拷贝 → 还原 → 重载）在真机上能不能站住还没有定论，
   * 界面不要接它；结论出来之前它随时可能改形状或被整个换掉。
   */
  ipcMain.handle(
    'agent-v3:snapshot:capture',
    async (
      _event,
      args: { projectDir: string; sessionId: string; contentPath: string; maxBytes?: number }
    ) => snapshotAsset(args)
  )

  ipcMain.handle('agent-v3:snapshot:restore', async (_event, args: { entry: AssetSnapshotEntry }) =>
    restoreAssetSnapshot(args.entry)
  )

  ipcMain.handle('agent-v3:load-session', async (_event, args: { sessionId: string }) => ({
    messages: await loadTranscript(args.sessionId)
  }))

  /**
   * 删掉一条对话的内核 session。
   *
   * 正在跑也照删 —— 原来这里直接返回「请先停止」，但界面的删除按钮只把对话
   * 从侧边栏划掉，不看这个返回值：用户看到对话消失了，盘上的 JSONL 还在。
   * 用户点了删除就是要它没了，让他先去停一下再回来删不是个交代。
   *
   * 顺序不能反：先 abort 停下模型，再 discard 作废写入句柄并等在途的写落完，
   * 最后才删文件。少了 discard，abort 收尾时的那次 append 会把文件重新建出来。
   */
  ipcMain.handle('agent-v3:delete-session', async (_event, args: { sessionId: string }) => {
    if (deletingSessions.has(args.sessionId)) return { success: false, reason: 'busy' }
    deletingSessions.add(args.sessionId)
    try {
      const entry = activeAgents.get(args.sessionId)
      if (entry) {
        entry.controller.abort()
        entry.agent?.abort()
        await entry.store?.discard()
        if (!(await activeAgents.drain(args.sessionId, STOP_DRAIN_TIMEOUT_MS))) {
          return {
            success: false,
            error: 'Session is still stopping; retry deletion when it finishes.'
          }
        }
      }
      await deleteTranscript(args.sessionId)
      // 摘要检查点是这条会话的附属物，跟着一起删。`sourceHash` 本来也能挡住
      // （指纹对不上就作废），但那要等到下一轮才发现，而这里能当场清掉
      await deleteCheckpoint(args.sessionId)
      await deleteExecutionOptions(args.sessionId)
      const { deleteSessionBrowser } = await import('../services/agentBrowser')
      await deleteSessionBrowser(args.sessionId)
      // 对话没了，它的「始终允许」名单也不该留着 —— 何况 sessionId 是新生成的，
      // 留着只是让这张表随用户开对话一直长
      sessionAlwaysAllowed.delete(args.sessionId)
      // 同理，档位也别留着 —— 对话都删了，这条记录只会让表一直长
      approvalModeBySession.delete(args.sessionId)
      readOnlyBySession.delete(args.sessionId)
      // 归属那张表同理。它还多一层：记录留着的话，`adoptSessionBinding` 会认为
      // 这条对话「已经定过归属」，永远不再听渲染层的戳
      forgetSessionBinding(args.sessionId)
      return { success: true, wasRunning: Boolean(entry) }
    } finally {
      deletingSessions.delete(args.sessionId)
    }
  })

  /**
   * 分支：把 transcript 复制成一个新 sessionId，之后两边各聊各的。
   *
   * `keepUserTurns` 是「从这条往后砍掉」—— 界面数出被点的那条气泡前面有几轮，
   * 内核照着截。不给就整份复制（从最后一条分支时就是这样）。
   *
   * ## 跑着的时候也能从更早的一轮分支
   *
   * 原来一律拒绝，理由是盘上的 transcript 落后于内存（turn_end 才落盘），
   * 分支出去会缺最后一轮而用户看到的是「成功了」。这个理由只对**整份复制**
   * 成立：给了 `keepUserTurns` 就是要把后面的砍掉，落后的那段恰恰是不要的。
   * 而「聊到第六轮发现第三轮就走错了」正是分支最该用的时刻 —— 让用户先把
   * 这一轮等完，等于这个功能在最需要它的那一刻是关的。
   *
   * 所以跑着的时候按内存那份切（和「侧边问一句」同一个做法），不再受落盘
   * 时机影响，见 `liveForkSource`。复制对源会话只读，它继续输出。
   */
  ipcMain.handle(
    'agent-v3:fork-session',
    async (_event, args: { sessionId: string; keepUserTurns?: number }) => {
      const { sessionId, keepUserTurns } = args

      const run = reserveRun(sessionId, _event.sender.id, 'history')
      // 抢不到锁时只剩一条路：从更早的一轮分支，且占着锁的是正在输出的模型
      const live = run ? undefined : liveForkSource(sessionId, keepUserTurns)
      if (!run && !live) return { success: false, reason: 'busy' as const }

      try {
        const result = await forkTranscript(sessionId, randomUUID(), {
          keepUserTurns,
          sourceMessages: live
        })
        if (!result.ok) {
          return { success: false, reason: result.reason }
        }
        await copyExecutionOptions(sessionId, result.sessionId)
        console.log(
          `[AgentV3] 会话 ${sessionId} 分支出 ${result.sessionId}（${result.messageCount} 条消息，` +
            `来源=${live ? '内存' : '盘'}）`
        )
        return { success: true, sessionId: result.sessionId, messageCount: result.messageCount }
      } catch (error) {
        console.error(`[AgentV3] 分支会话 ${sessionId} 失败:`, error)
        return { success: false, error: (error as Error).message }
      } finally {
        // 没占到锁就别去释放：那把锁是正在输出的那一轮的，放掉等于把它踢出登记表
        if (run) activeAgents.release(sessionId)
      }
    }
  )

  /**
   * 把 transcript 截回第 `keepUserTurns` 轮 —— 「重新生成」「编辑消息」用。
   *
   * 界面删掉的是气泡，内核这份是另一本账，execute 每轮都从盘上重新恢复它。
   * 不截的话模型看着自己刚被丢掉的答案再答一遍，用户以为重来、实际是追问。
   *
   * 跑着的时候拒绝：内存里那份比盘上新，截了也会被这一轮结束时的 append 盖回去。
   * 界面本来也不该让用户在跑着的时候点重新生成。
   */
  ipcMain.handle(
    'agent-v3:truncate-session',
    async (_event, args: { sessionId: string; keepUserTurns: number }) => {
      const { sessionId, keepUserTurns } = args

      const run = reserveRun(sessionId, _event.sender.id, 'history')
      if (!run) return { success: false, reason: 'busy' as const }

      try {
        const result = await truncateTranscript(sessionId, keepUserTurns)
        if (!result.ok) {
          return { success: false, reason: result.reason }
        }
        if (result.dropped > 0) {
          // 历史被砍掉一段，摘要描述的就是一段不存在的对话了。作废掉重压一次，
          // 比拿一份说着「我们已经建好了 M_X」而 M_X 其实已被丢弃的摘要去喂模型强
          await deleteCheckpoint(sessionId)
          console.log(
            `[AgentV3] 会话 ${sessionId} 截回 ${keepUserTurns} 个用户回合（丢弃 ${result.dropped} 条消息）`
          )
        }
        return { success: true, messageCount: result.messageCount, dropped: result.dropped }
      } catch (error) {
        console.error(`[AgentV3] 截断会话 ${sessionId} 失败:`, error)
        return { success: false, error: (error as Error).message }
      } finally {
        activeAgents.release(sessionId)
      }
    }
  )

  /**
   * 侧边问一句：复制一份上下文出去，给旁边那个小窗口用。
   *
   * ## 和 `fork-session` 的区别，以及为什么不能复用它
   *
   * 两边跑着的时候都读**内存里**那份，但要的东西正好相反：那条要的是一段
   * **已经收尾**的历史（切点必须能数出更靠后的用户消息，否则回 `busy`），
   * 因为分支出去还要接着聊，带半截答案进去等于开局就错；侧边要的恰恰是
   * 此刻的现场 —— 用户看着满屏工具调用，想问一句「它现在在干嘛」，
   * 把正在跑的这一轮剔掉，问的就不是他看见的那件事了。
   *
   * 所以这里整份带走，尾部可能停在半截工具调用上，`trimDanglingToolCalls`
   * 负责截齐；没跑的对话读盘。
   *
   * 复制出去之后两边再无关系。主对话继续跑它的，侧边那份是死的快照 ——
   * 用户在侧边聊什么都不会回流到主对话里。
   */
  ipcMain.handle('agent-v3:fork-for-side-question', async (_event, args: { sessionId: string }) => {
    const { sessionId } = args
    const running = activeAgents.get(sessionId)

    try {
      const source = running?.agent
        ? withoutSystemMessages(running.agent.state.messages)
        : await loadTranscript(sessionId)
      const messages = trimDanglingToolCalls(source)

      // 一轮都还没跑完的对话没有上下文可借。这时候开侧边窗口，模型手上和
      // 新开一个对话没有区别，不如直说
      if (messages.length === 0) return { success: false, reason: 'empty' as const }

      const forkedId = randomUUID()
      const store = new TranscriptStore(forkedId)
      await store.append(messages, { strict: true })
      await copyExecutionOptions(sessionId, forkedId)

      console.log(
        `[AgentV3] 会话 ${sessionId} 侧边分出 ${forkedId}（${messages.length} 条消息，` +
          `截掉 ${source.length - messages.length} 条半截调用，来源=${running ? '内存' : '盘'}）`
      )
      return {
        success: true,
        sessionId: forkedId,
        messageCount: messages.length,
        /** 主对话此刻正在跑 —— 界面据此提示「这是一份快照」 */
        live: Boolean(running)
      }
    } catch (error) {
      console.error(`[AgentV3] 会话 ${sessionId} 侧边分支失败:`, error)
      return { success: false, reason: 'error' as const, error: (error as Error).message }
    }
  })

  /**
   * 手动压缩上下文。
   *
   * 自动压缩只在快撑满时才触发（`shouldCompact`）。但用户会**主动**想压：
   * 一段探索跑完了、接下来要换个方向，早期那堆试错留着只是占地方还让模型
   * 分心。界面上的用量指示器点开就有这个按钮。
   *
   * 走的是和自动压缩同一个 `compactMessages` —— 两条各写一遍的话，摘要质量
   * 会慢慢分叉，而那种差异只在用户抱怨「压完它就忘事了」时才被发现。
   *
   * **失败只回 `reason`，不回文案。** 主进程写出来的是实现语言
   * （「最近这几轮本来就要完整保留，没有可以换成摘要的早期内容」——
   * 那是在解释 keepRecentTokens，不是在告诉用户该怎么办），而且绕过了 i18n，
   * 英文界面会蹦出中文。措辞归渲染层，这里只说发生了哪一种情况。
   */
  ipcMain.handle('agent-v3:compact', async (_event, args: { sessionId: string }) => {
    const { sessionId } = args

    // 跑着的时候压会和 transformContext 抢同一份 transcript
    const run = reserveRun(sessionId, _event.sender.id, 'history')
    if (!run) return { success: false, reason: 'busy' }

    try {
      const previous = await loadTranscript(sessionId)
      run.controller.signal.throwIfAborted()
      if (previous.length === 0) return { success: false, reason: 'empty' }
      const { models, summaryModel, selection } = await resolveAgentModel({
        role: 'agent',
        agentType: 'agent-v3'
      })
      run.controller.signal.throwIfAborted()
      const outcome = await compactMessages(
        previous,
        { models, summaryModel },
        { signal: run.controller.signal }
      )
      run.controller.signal.throwIfAborted()
      if (!outcome.ok) return { success: false, reason: outcome.reason }

      // 量尺见 measureCompaction —— estimateContextTokens 量不出头部被砍掉
      const {
        tokensBefore: before,
        tokensAfter: after,
        saved
      } = measureCompaction(previous, outcome.messages)

      /**
       * 压完没变小就别写回去。
       *
       * 已经压过一次的对话再压，是拿摘要去生成摘要 —— 消息条数一条不减，
       * 换来的只是摘要被二次概括、细节又丢一层。那时报「成功」，用户点完
       * 看着数字纹丝不动（甚至变大），只会以为按钮坏了。
       *
       * 两个条件是「或」：条数没减说明只有那条旧摘要被重写了一遍，
       * 体积没减说明这趟白跑 —— 任一成立都不值得写回去。
       */
      if (outcome.messages.length >= previous.length || saved <= 0) {
        return { success: false, reason: 'already-compact' }
      }

      // 整个重写：压缩之后消息变少了，追加写会把摘要接在旧历史后面
      const store = new TranscriptStore(sessionId)
      store.markPersisted(previous.length)
      await store.append(outcome.messages, { strict: true })
      // 手动压缩是**真的**改写了盘上的历史（和自动压缩的检查点不一样，那个不动盘）。
      // 旧检查点的切点和指纹从这一刻起全部对不上，留着只会在下一轮被判无效，
      // 不如当场清掉
      await deleteCheckpoint(sessionId)
      console.log(
        `[AgentV3] 会话 ${sessionId} 手动压缩：${previous.length} 条 → ${outcome.messages.length} 条，` +
          `${before} → ${after} tokens`
      )
      return {
        success: true,
        tokensBefore: before,
        tokensAfter: after,
        messagesBefore: previous.length,
        messagesAfter: outcome.messages.length,
        contextWindow: selection.model.contextWindow
      }
    } catch (error) {
      if (isUserAbort(error)) return { success: false, reason: 'cancelled' }
      console.error(`[AgentV3] 会话 ${sessionId} 手动压缩失败:`, error)
      // 意料之外的失败才把原文带上去 —— 那种情况没有合适的说法可选，
      // 厂商的原始报错至少能拿去排查
      return { success: false, reason: 'error', error: (error as Error).message }
    } finally {
      stopEditorWatch(sessionId)
      activeAgents.release(sessionId)
    }
  })

  /**
   * 运行中插话改方向 —— V2 完全没有的能力。
   *
   * 消息在当前这一轮结束后注入，agent 会看到它再决定下一步，
   * 不需要打断重来。
   *
   * 插话可以带图，和普通发送一样：贴一张参考图说「照着这个改」是真机上最常见的
   * 说法之一。**但不换模型** —— 这一轮用哪个模型在跑起来那一刻就定了，
   * 中途换会把整段 prompt cache 作废。当前模型看不了图时，pi 会把图换成
   * 「(image omitted: model does not support images)」，模型照实说自己看不到，
   * 这比背着用户换一个模型、让这一轮的上下文全部重算要诚实。
   */
  ipcMain.handle(
    'agent-v3:steer',
    async (
      event,
      args: {
        sessionId: string
        message: string
        editorSnapshot?: EditorSnapshot | null
        images?: ImageContent[]
        /** 随插话带的音视频路径。和普通发送同一条路：能换链接就换，换不了只给路径 */
        mediaFiles?: PromptMediaFile[]
        /** 渲染层已经解析好的文档 / 表格正文 */
        contextText?: string
      }
    ) => {
      const entry = activeAgents.get(args.sessionId)
      if (!entry?.agent || !acceptsSteer(entry)) {
        return {
          success: false,
          code: 'NOT_RUNNING' satisfies SteerRejectionCode,
          error: '没有正在执行的 session'
        }
      }

      /*
       * 工程对不上就**整条拒绝**，不是丢掉快照照发。
       *
       * 插话说的是「把这个也改了」。把快照丢掉、只把「改这个」送进去，模型会在
       * 正在跑的那个工程里找一个根本不存在的「这个」—— 而界面上还挂着另一个工程
       * 的摘要，用户看不出哪里错了。宁可让这次插话失败：调用方（排队转插话那条路）
       * 本来就会把它留在队列里，等这一轮结束后按它自己钉住的工程发出去。
       */
      const scope = entry.scope
      if (args.editorSnapshot && scope && !snapshotMatchesScope(args.editorSnapshot, scope)) {
        return {
          success: false,
          code: 'PROJECT_MISMATCH' satisfies SteerRejectionCode,
          error:
            `这条插话是在「${args.editorSnapshot.project.projectName || '另一个工程'}」上抓的，` +
            `而正在跑的这一轮盯着「${scope.connectedProject?.projectName || '另一个工程'}」。` +
            `先让它跑完，这条会按原来的工程发出去。`,
          errorParams: {
            // 原值，可能为空串 —— 「另一个工程」的措辞是渲染层的事
            snapshotProject: args.editorSnapshot.project.projectName,
            runProject: scope.connectedProject?.projectName ?? ''
          } satisfies SteerRejectionErrorParams
        }
      }

      const block = scope ? editorSnapshotBlock(args.editorSnapshot, scope, args.sessionId) : ''

      // 排号：下面的准备（落盘、上传）各自并行，进内核那一步按到达顺序来
      const previous = entry.steerChain ?? Promise.resolve()
      let releaseTurn: () => void = () => {}
      entry.steerChain = new Promise<void>((resolve) => {
        releaseTurn = resolve
      })
      try {
        /*
         * 带来的图同样落一份到盘上、把路径写进去 —— 理由和普通发送那条路一模一样：
         * 模型看得见图，但没有句柄能把它交给工具（见 promptAttachments.ts）。
         * 落盘失败不影响这次插话，图照样进上下文。
         */
        const attachments = await savePromptAttachments(args.images)
        const attachmentBlock = formatAttachmentBlock(attachments)
        // 插话带的图走同一道关口，理由同普通发送
        const admittedSteer = await admitPromptImages(args.images)
        /*
         * 音视频和普通发送同一条路（见 promptMedia.ts），模型按**正在跑的这一轮**判断：
         * 插话不换模型。没记下模型就当换不了链接，只给路径。
         */
        const mediaFiles = args.mediaFiles ?? []
        const media = entry.selection
          ? await preparePromptMedia(mediaFiles, entry.selection, (note) => {
              if (!event.sender.isDestroyed()) {
                event.sender.send('agent-v3:notice', {
                  sessionId: args.sessionId,
                  message: note,
                  level: 'info'
                })
              }
            })
          : { refs: [], note: describePromptMedia(mediaFiles, new Set()) }
        // 前面那条（多半在等上传）先进去，这条跟在它后面
        await previous
        // 上传要等一阵，这期间这一轮可能已经跑完了、或者正在收尾
        if (activeAgents.get(args.sessionId) !== entry || !acceptsSteer(entry)) {
          return {
            success: false,
            code: 'NOT_RUNNING' satisfies SteerRejectionCode,
            error: '没有正在执行的 session'
          }
        }
        /*
         * 图片关口的提示、音视频说明、文档正文都包进插话附件块：回执要按原话销号，
         * 这些字得能整块剥掉（见 `formatSteerContextBlock`）。
         */
        const contextBlock = formatSteerContextBlock([
          ...admittedSteer.notices,
          media.note,
          args.contextText ?? ''
        ])
        const text = [block, attachmentBlock, contextBlock, args.message]
          .filter(Boolean)
          .join('\n\n')

        /*
         * 什么都没带就还是一条纯字符串，和以前一个字节都不差 —— 内容块数组只在
         * 真的有图或音视频引用时才用，免得给每一条插话都换一种形状。
         */
        const content =
          admittedSteer.images.length || media.refs.length
            ? [
                { type: 'text', text },
                ...media.refs.map((ref) => ({ type: 'text' as const, text: mediaRefText(ref) })),
                ...admittedSteer.images
              ]
            : text

        /*
         * 留底用的是 `args.message`（用户的原话），不是拼了闪存块和附件块的 `content`。
         * 内核回执投出来的也是剥掉这两块的原话，两边要对得上才销得了号。
         */
        const steerId = queueSteer(entry.pendingSteers, entry.agent, args.message, {
          role: 'user',
          content,
          timestamp: 0
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any)
        return { success: true, steerId }
      } finally {
        releaseTurn()
      }
    }
  )

  /**
   * 撤回一条还排着的插话。
   *
   * 「排队中」只是界面上的说法 —— 话早就交给内核了，什么时候读进上下文由它自己
   * 决定。所以这里可能晚一步：读走了就撤不回来（它已经在 transcript 里，
   * 抽掉等于篡改历史），如实回 `already-sent`，让界面告诉用户「晚了一步」，
   * 而不是画一个撤回成功的样子。做法和边界条件见 `host/steerQueue.ts`。
   */
  ipcMain.handle(
    'agent-v3:cancel-steer',
    async (_event, args: { sessionId: string; steerId: string }) => {
      const entry = activeAgents.get(args.sessionId)
      // 会话已经收尾 = 排着的那条要么进去了要么随这一轮一起没了，
      // 无论哪种，界面上那句话都不该显示成「撤回成功」
      if (!entry?.agent) return { success: false, reason: 'already-sent' as const }

      const outcome = cancelSteer(entry.pendingSteers, entry.agent, args.steerId)
      return outcome === 'cancelled'
        ? { success: true }
        : { success: false, reason: 'already-sent' as const }
    }
  )

  /**
   * 改**某条对话**的审批档位，运行中也算数。
   *
   * 审批门每次工具调用都现读这个值，所以下一个工具就按新档位走 ——
   * 不用等这一轮跑完，也不用重发一遍消息。
   *
   * `sessionId` 是必填的：档位属于对话，不带的话这次改动会落到哪条对话上
   * 全凭运气，而「凭运气放开权限」正是这个参数要消灭的东西。
   *
   * **已经弹出来的那个确认框不受影响**，仍然要用户自己点。把它自动放行
   * 意味着「改了个下拉」就等于「批准了一次删除」，那是拿设置项当确认按钮用。
   */
  ipcMain.handle(
    'agent-v3:set-approval-mode',
    async (
      _event,
      args: { sessionId: string; approvalMode: ApprovalMode; mode?: 'agent' | 'ask' }
    ) => {
      if (!args.sessionId) {
        return { success: false, error: '缺少 sessionId：审批档位是每条会话一份的' }
      }
      approvalModeBySession.set(args.sessionId, args.approvalMode)
      if (args.mode) {
        setReadOnly(args.sessionId, args.mode === 'ask')
      }
      return { success: true }
    }
  )

  /**
   * 停止一条会话，并**等它真的停下来**再回话。
   *
   * 不等的话会出现这个现象：用户在跑的过程中改了自己那句话重新发送，界面
   * 先停旧的再发新的，但 `abort()` 只是递了个意图 —— 新的 execute 到达时
   * 旧的还占着 `activeAgents`，于是用户看到一个 `SESSION_BUSY`，
   * 而他刚敲的那段话已经没了。
   */
  ipcMain.handle('agent-v3:stop', async (_event, args: { sessionId: string }) => {
    const entry = activeAgents.get(args.sessionId)
    if (!entry) return { success: true, drained: true }
    entry.ending = true
    entry.controller.abort()
    entry.agent?.abort()
    return {
      success: true,
      drained: await activeAgents.drain(args.sessionId, STOP_DRAIN_TIMEOUT_MS)
    }
  })

  /** AI 设置变更后调用，强制下次执行重建 Provider（改了 Base URL / 密钥要立刻生效） */
  ipcMain.handle('agent-v3:invalidate-providers', async () => {
    invalidateProviderCache()
    return { success: true }
  })

  // ── MCP 管理 ──────────────────────────────────────────────────────────
  ipcMain.handle('agent-v3:mcp:get-settings', async () => ({
    settings: await readMcpSettings(),
    path: mcpSettingsPath(),
    statuses: currentStatuses()
  }))

  ipcMain.handle('agent-v3:mcp:save-settings', async (_event, args: { settings: McpSettings }) => {
    try {
      await writeMcpSettings(args.settings)
      // 立刻重连，用户在设置界面就能看到每个 server 通没通，
      // 而不是等下一次对话才发现配错了
      const statuses = await reconnectMcp()
      return { success: true, statuses }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 删一条 server，当场落盘。
   *
   * 不走 `save-settings`：那个是「把表单整张写下去」，会把用户在别的行里
   * 还没保存的编辑一起提交。删一条就只删一条，别的原样留在盘上。
   */
  ipcMain.handle('agent-v3:mcp:remove-server', async (_event, args: { id: string }) => {
    try {
      const { removeMcpServer } = await import('../agent-v3/capabilities/mcp/store')
      await removeMcpServer(args.id)
      // 删完立刻重连：那条 server 的工具要当场从会话里消失，
      // 而不是留一个已经不存在的「已连接」胶囊挂在界面上
      return { success: true, settings: await readMcpSettings(), statuses: await reconnectMcp() }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 存一条 server，当场落盘并重连。
   *
   * 同 `remove-server`，不走 `save-settings`：那个是「把表单整张写下去」，
   * 会把用户在别的行里还没保存的编辑一起提交。
   *
   * `renamedFrom` 是改过名的那一条在盘上的旧名字。不删的话盘上会多出一条
   * 旧的，下次打开面板它又冒出来。
   */
  ipcMain.handle(
    'agent-v3:mcp:save-server',
    async (_event, args: { id: string; config: McpServerConfig; renamedFrom?: string }) => {
      try {
        const { removeMcpServer, upsertMcpServer } = await import(
          '../agent-v3/capabilities/mcp/store'
        )
        // 先删旧名字再写新的：反过来的话，id 没变时会把刚写的又删掉
        if (args.renamedFrom && args.renamedFrom !== args.id) {
          await removeMcpServer(args.renamedFrom)
        }
        await upsertMcpServer(args.id, args.config)
        return { success: true, settings: await readMcpSettings(), statuses: await reconnectMcp() }
      } catch (error) {
        return { success: false, error: (error as Error).message }
      }
    }
  )

  ipcMain.handle('agent-v3:mcp:reconnect', async () => {
    try {
      return { success: true, statuses: await reconnectMcp() }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  // ── 一键开启 UE 5.8 官方 MCP ──────────────────────────────────────────
  // 手工流程要在两个设置面板里点四步，大部分用户走不完。见 epicSetup.ts
  ipcMain.handle('agent-v3:mcp:epic-status', async () => {
    try {
      const { inspectAllProjects } = await import('../agent-v3/capabilities/mcp/epicSetupRuntime')
      return { success: true, projects: await inspectAllProjects() }
    } catch (error) {
      return { success: false, error: (error as Error).message, projects: [] }
    }
  })

  ipcMain.handle('agent-v3:mcp:epic-setup', async (_event, args: { connectionId: string }) => {
    try {
      const { setupProject } = await import('../agent-v3/capabilities/mcp/epicSetupRuntime')
      const result = await setupProject(args.connectionId)
      // 真起来了就立刻重连，用户在设置页当场看到「已连接」，
      // 而不是被告知「去点一下重新连接」
      const statuses = result.running ? await reconnectMcp() : currentStatuses()
      return { ...result, statuses }
    } catch (error) {
      return { success: false, error: (error as Error).message, statuses: currentStatuses() }
    }
  })

  // ── 一键接入官方 Blender Lab MCP ──────────────────────────────────────
  // 手工流程有四道关（装 git/Python、跑安装脚本、手填命令行、手填三行环境
  // 变量），走完的用户几乎没有。后三道盒子代劳，见 blenderSetup.ts
  //
  // 探之前先从注册表刷新 PATH：用户照着提示装好 Git / Python 回来，
  // 不用重启盒子就能被认出来（见 services/systemPath.ts）
  ipcMain.handle('agent-v3:mcp:blender-status', async () => {
    try {
      const { inspectBlenderSetup } = await import(
        '../agent-v3/capabilities/mcp/blenderSetupRuntime'
      )
      const { refreshProcessPath } = await import('../services/systemPath')
      await refreshProcessPath()
      return { success: true, status: await inspectBlenderSetup() }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle(
    'agent-v3:mcp:blender-setup',
    async (_event, args: { blenderPath?: string } = {}) => {
      try {
        const { runBlenderSetup } = await import('../agent-v3/capabilities/mcp/blenderSetupRuntime')
        const { refreshProcessPath } = await import('../services/systemPath')
        await refreshProcessPath()
        const result = await runBlenderSetup(args)
        // 装完立刻重连，用户在设置页当场看到「已连接」和工具数，
        // 而不是被告知「去点一下重新连接」
        const statuses = result.success ? await reconnectMcp() : currentStatuses()
        return { ...result, statuses }
      } catch (error) {
        return {
          success: false,
          message: '安装过程本身出错了。',
          error: (error as Error).message,
          statuses: currentStatuses()
        }
      }
    }
  )

  // 缺 Git / Python 时用 winget 替用户装。失败的原话交还界面，由用户决定要不要交给 AI
  ipcMain.handle(
    'agent-v3:mcp:blender-install-prereqs',
    async (_event, args: { ids?: Array<'git' | 'python'> } = {}) => {
      try {
        const { installBlenderPrerequisites } = await import(
          '../agent-v3/capabilities/mcp/blenderSetupRuntime'
        )
        const ids = (args.ids ?? []).filter((id) => id === 'git' || id === 'python')
        const result = await installBlenderPrerequisites(ids)
        // 装 Git 就带来了 bash。成没成都重探一次：Python 失败时 Git 可能已经装上，
        // 不重探的话 Agent 的 shell 工具要等重启盒子才出现
        if (ids.includes('git')) {
          const { forgetShellProbe } = await import('../agent-v3/tools/builtin/localShell')
          forgetShellProbe()
        }
        return result
      } catch (error) {
        return {
          success: false,
          message: '安装过程本身出错了。',
          error: (error as Error).message
        }
      }
    }
  )

  // ── 对外暴露 UE 能力（MCP Server）──────────────────────────────────────
  // 按持久化配置运行。开启后 Claude Code / Cursor 等外部客户端能直接操作虚幻引擎。
  ipcMain.handle('agent-v3:mcp-server:start', async (_event, args: McpServerHostOptions = {}) => {
    try {
      // 每条外部会话按盒子助手的装配路现造工具，再按用户保存的权限档位收窄
      const status = await startMcpServer(mcpSessionSource, args)
      return { success: true, status: await withHostSettings(status) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('agent-v3:mcp-server:stop', async () => ({
    success: true,
    status: await withHostSettings(await disableMcpServer())
  }))

  ipcMain.handle('agent-v3:mcp-server:status', async () => withHostSettings(mcpServerStatus()))

  /**
   * 把对外 MCP 写进 Claude Code / Codex 的用户级配置。服务没开就顺手开起来 ——
   * 写好了配置、服务却没跑，用户在客户端里看到的只是一条「连接失败」。
   */
  ipcMain.handle('agent-v3:mcp-server:install-client', async (_event, client: McpClientId) => {
    try {
      const { path } = await installMcpClient(client)
      let status = mcpServerStatus()
      if (!status.running) status = await startMcpServer(mcpSessionSource, {})
      return { success: true, path, status: await withHostSettings(status) }
    } catch (error) {
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 保存端口 / 暴露范围。运行中有变化时自动重启服务，让新权限立即生效。
   *
   * 界面上改完就调这里。原来这两项只有 start 会写盘，用户改完不点开启
   * 就切走，下次回来全变回默认值。
   */
  ipcMain.handle(
    'agent-v3:mcp-server:save-config',
    async (_event, args: { port?: number; includeMutating?: boolean } = {}) => {
      const wasRunning = mcpServerStatus().running
      const status = await applyMcpServerConfig(args, () => mcpSessionSource)
      const success = !wasRunning || status.running
      return {
        success,
        ...(!success ? { error: status.error ?? 'MCP 服务重启失败' } : {}),
        status: await withHostSettings(status)
      }
    }
  )

  /**
   * 换一把新令牌。
   *
   * 旧的客户端配置随即失效 —— 这正是它的用途（令牌抄给别人了、
   * 提交进 git 了）。服务在跑就顺手用新令牌重启，否则用户还得手动停再开。
   */
  ipcMain.handle('agent-v3:mcp-server:rotate-token', async () => {
    const wasRunning = mcpServerStatus().running
    const settings = await rotateHostToken()
    if (!wasRunning) return { success: true, status: await withHostSettings(mcpServerStatus()) }

    const status = await startMcpServer(mcpSessionSource, {
      port: settings.port,
      includeMutating: settings.includeMutating
    })
    return { success: true, status: await withHostSettings(status) }
  })

  /** P0 构建验证诊断通道。V3 稳定后移除。 */
  ipcMain.handle('agent-v3:smoke', async () => {
    // 内核自检与工具诊断分开采集（smoke 不能碰工具树，见 smoke.ts 文件头），
    // 在这里合并成界面要的一份报告。
    const kernel = await runAgentV3Smoke()
    const tools = await collectToolDiagnostics()
    const report = {
      ...kernel,
      ...tools,
      ok: kernel.ok && tools.ok,
      errors: tools.error ? [...kernel.errors, `tool registry: ${tools.error}`] : kernel.errors
    }
    console.log('[AgentV3] 自检:', JSON.stringify(report))
    return report
  })
}
