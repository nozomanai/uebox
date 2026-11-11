import { computed, onMounted, onUnmounted, ref, type ComputedRef, type Ref, watch } from 'vue'
import { message } from '@renderer/utils/messageManager'
import { useI18n } from 'vue-i18n'
import type {
  ChatMessage,
  ChatMessageContent,
  ExcelFileInfo
} from '../../../store/modules/chatMessages'
import { aiAPI, toAgentV3Images, type AgentRunController } from '../../../api/ai'
import { buildMultimodalContent } from './chatSendPrimitives'
import { useAIConfigStore } from '../../../store/modules/aiConfig'
import type { AgentProcessItem } from '../components/AgentProcessLog.types'
import type { AgentRunOutcome, NotifyUsersEvent } from './agentHandlerShared'
import {
  registerAgentHandler,
  unregisterAgentHandler,
  findActiveSessionByChatSid,
  hasActiveHandler
} from './agentEventDispatcher'
import { onAgentReattached } from './agentReattach'
import { rememberSteerDraft } from './steerDrafts'
import { isDuplicateNotify, NOTIFY_DEDUP_WINDOW_MS } from './notifyDedup'
import { describeStartupError, describeSteerRejection } from './agentControlHandlers'
import { createAgentModeHandlers } from './useAgentModeHandlers'
import { useAgentStreamStore } from '@renderer/store/modules/agentStream'
import { useNotebookStore } from '@renderer/store/modules/notebookStore'
import {
  buildNotebookRagContext,
  extractTextForNotebookRag,
  resolveNotebookRagTarget,
  type NotebookRagCitation,
  type NotebookRagContextResult
} from './notebookRagContext'
import { buildLibraryContextMessage, type LibraryChatContext } from './libraryChatContext'
import { buildCurrentUEProjectContext } from './ueProjectContext'
import {
  attachmentsOnlySteerText,
  mergeTurnContext,
  type ChatMediaFile,
  type SteerAttachments
} from './turnAttachments'
import { toSessionProjectPayload } from './sessionProjectBinding'
import { resolvePermissionMode, toApprovalMode } from './sessionPermissionMode'
import { ensureSessionModel } from './sessionModel'
import { agentV3API } from '@renderer/api/agentV3'
import { aiProviderAPI } from '@renderer/api/aiProvider'
import {
  AGENT_EMPTY_RESPONSE_ECHO_TEXT,
  isEchoedAgentFallbackInput
} from '../../../../../shared/agentFastPath'
import { toPlainEditorSnapshot, type EditorSnapshot } from '../../../../../shared/editorSnapshot'

export interface UseAgentModeParams {
  sid: Ref<string>
  messages: ComputedRef<ChatMessage[]>
  chatStore: any
  chatMsgStore: any
  tabsStore: any
  route: any
  scrollToBottomIfNeeded: () => void
  pushUser: (
    content: ChatMessageContent,
    mentionedSources?: undefined,
    attachments?: ExcelFileInfo[]
  ) => void
  pushAssistantTyping: (startTime?: number) => string
  currentAgentProcess: Ref<AgentProcessItem[]>
  /**
   * 嵌在库详情页里时，「用户正在看什么」。
   *
   * 每一轮请求前算一次并注入，不写进对话历史 —— 所以带的永远是**当下**的
   * 选中节点，用户点了别的节点就跟着变。不在库里嵌时是 undefined。
   */
  libraryContext?: ComputedRef<LibraryChatContext | null>
}

type ExecuteAgentOptions = {
  isRetry?: boolean
  askMode?: boolean
  /** 供实时语音等入口在本轮收尾后取结果；不参与常规对话 UI。 */
  onFinished?: (outcome: AgentRunOutcome) => void
  /**
   * 这一轮落在**哪条对话**上。不填就是用户正对着的这条。
   *
   * 实时语音派的活固定跑在「语音任务」那条对话上，而用户此刻多半正对着
   * 「语音助手」那条 —— 气泡、过程时间线、流式状态都得建在目标对话上，
   * 用户切过去才看得见完整过程。当前对话专属的那几样状态
   * （`currentAgentProcess`、`currentAgentController`、`fullConversationHistory`）不碰。
   */
  chatSid?: string
  /**
   * 用户**按下发送那一刻**抓好的编辑器快照（闪存）。
   *
   * 这个键**存在**就表示已经定了 —— 抓到的那份，或者 `null`（用户点掉了标签）。
   * 下游一律不再抓：气泡上显示的必须就是模型收到的那一份。
   */
  editorSnapshot?: EditorSnapshot | null
  /**
   * 这条消息钉住的工程，通常就是快照来自的那个。
   *
   * 不给的话会退回读对话戳 —— 而没盖过戳的对话，戳算出来的是「当前工程」=
   * 最近连上的那个。排队期间新连上一个工程，执行时就跑到别人身上去了。
   */
  sessionProject?: { projectName: string; projectPath?: string; engineVersion?: string } | null
  /** 这一轮带着的音视频路径。怎么让模型看由主进程决定，见主进程 `core/promptMedia.ts` */
  mediaFiles?: ChatMediaFile[]
}

type SteerAgentOptions = {
  editorSnapshot?: EditorSnapshot | null
  images?: readonly string[]
  attachments?: SteerAttachments
  /**
   * 插进哪一轮。调用方在自己开始等（抓闪存、传附件）之前记下的 —— 等的这几秒里
   * 用户切了对话，`currentSessionId` 就指向别人正在跑的那一轮了
   */
  targetSessionId?: string
  /**
   * 'restored'：放回输入框；'queued'：留在队列，等这一轮释放后照常发出。
   * 故意不给默认值：被拒提示按它选话术，默认成哪个，都可能和调用方实际的处理对不上
   */
  ifRejected: 'restored' | 'queued'
  /**
   * 把这次摘走的字和附件放回输入框。插进去之后按号记下，用户撤回这条时调它 ——
   * 撤回就是「我还要改」，东西得原样回到手上
   */
  restoreDraft?: () => void
}

export function useAgentMode(params: UseAgentModeParams) {
  const { t } = useI18n()
  const {
    sid,
    messages,
    chatStore,
    chatMsgStore,
    tabsStore,
    route,
    scrollToBottomIfNeeded,
    pushUser,
    pushAssistantTyping,
    currentAgentProcess,
    libraryContext
  } = params

  const agentStreamStore = useAgentStreamStore()
  const aiConfigStore = useAIConfigStore()
  const nbStore = useNotebookStore()

  const isAgentMode = ref(false)
  const currentSessionId = ref('')
  const fullConversationHistory = ref<any[]>([])
  const currentAgentController = ref<AgentRunController | null>(null)
  const askModeRef = ref(false)

  const currentText = computed(() => agentStreamStore.getCurrentText(sid.value))
  const currentThinking = computed(() => agentStreamStore.getCurrentThinking(sid.value))
  const currentTypingId = computed(() => agentStreamStore.getTypingId(sid.value))
  const isCurrentStreaming = computed(() => agentStreamStore.isStreaming(sid.value))

  const WIKI_HIT_PREVIEW_LIMIT = 3
  const pendingNotebookIndexRefreshes = new Set<string>()
  const wikiRagCitationsBySession = ref<Record<string, NotebookRagCitation[]>>({})
  const wikiHitMessageBySession = ref<
    Record<string, { message: string; notifyType: 'progress' | 'warning' }>
  >({})

  const setWikiRagState = (
    sessionId: string,
    citations: NotebookRagCitation[],
    hitMessage?: string,
    notifyType: 'progress' | 'warning' = 'progress'
  ): void => {
    if (!sessionId) return

    wikiRagCitationsBySession.value = {
      ...wikiRagCitationsBySession.value,
      [sessionId]: [...citations]
    }

    if (hitMessage) {
      wikiHitMessageBySession.value = {
        ...wikiHitMessageBySession.value,
        [sessionId]: { message: hitMessage, notifyType }
      }
      return
    }

    const nextHitMessages = { ...wikiHitMessageBySession.value }
    delete nextHitMessages[sessionId]
    wikiHitMessageBySession.value = nextHitMessages
  }

  const getWikiRagCitations = (sessionId?: string): NotebookRagCitation[] => {
    if (!sessionId) return []
    return wikiRagCitationsBySession.value[sessionId] || []
  }

  const getWikiHitState = (
    sessionId?: string
  ): { message: string; notifyType: 'progress' | 'warning' } | undefined => {
    if (!sessionId) return undefined
    return wikiHitMessageBySession.value[sessionId]
  }

  const clearWikiRagState = (sessionId?: string): void => {
    if (!sessionId) return

    const nextCitations = { ...wikiRagCitationsBySession.value }
    delete nextCitations[sessionId]
    wikiRagCitationsBySession.value = nextCitations

    const nextHitMessages = { ...wikiHitMessageBySession.value }
    delete nextHitMessages[sessionId]
    wikiHitMessageBySession.value = nextHitMessages
  }

  const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  const refreshNotebookSourcesAfterIndexing = (notebookId: string, sourceIds: string[]): void => {
    const sourceIdSet = new Set(sourceIds.filter(Boolean))
    if (sourceIdSet.size === 0) return

    const refreshKey = `${notebookId}:${[...sourceIdSet].sort().join(',')}`
    if (pendingNotebookIndexRefreshes.has(refreshKey)) return

    pendingNotebookIndexRefreshes.add(refreshKey)
    void (async () => {
      try {
        await nbStore.loadSources(notebookId)

        for (let attempt = 0; attempt < 8; attempt += 1) {
          const jobs = await window.api.notebook.ragListIndexJobs({ notebookId })
          const activeJob = jobs.some(
            (job) =>
              sourceIdSet.has(job.sourceId) &&
              (job.status === 'pending' || job.status === 'running')
          )

          if (!activeJob) break
          await wait(attempt < 2 ? 800 : 1500)
        }

        await nbStore.loadSources(notebookId)
      } catch (error) {
        console.warn('[Agent模式] 刷新知识库索引状态失败:', error)
      } finally {
        pendingNotebookIndexRefreshes.delete(refreshKey)
      }
    })()
  }

  const buildWikiHitMessage = (
    notebookTitle: string,
    ragContext: Pick<NotebookRagContextResult, 'citations' | 'warnings' | 'queuedIndexSourceIds'>
  ): { message: string; notifyType: 'progress' | 'warning' } => {
    const { citations } = ragContext

    if (citations.length === 0) {
      const warning = ragContext.warnings?.[0]
      if (warning) {
        const queuedCount = ragContext.queuedIndexSourceIds?.length ?? 0
        return {
          message:
            queuedCount > 0
              ? `${warning.message} 已在后台为 ${queuedCount} 个来源补建索引。`
              : warning.message,
          notifyType: 'warning'
        }
      }

      return {
        message: `已检索知识库「${notebookTitle}」，未命中相关内容。`,
        notifyType: 'warning'
      }
    }

    const previewTitles = citations
      .slice(0, WIKI_HIT_PREVIEW_LIMIT)
      .map((citation) => citation.title.trim())
      .filter(Boolean)
    const remainingCount = citations.length - previewTitles.length
    const previewText = previewTitles.join('、')
    const suffix = remainingCount > 0 ? ` 等 ${citations.length} 条来源` : ''

    return {
      message: `已命中知识库「${notebookTitle}」 ${citations.length} 条来源${
        previewText ? `：${previewText}${suffix}` : '。'
      }`,
      notifyType: 'progress'
    }
  }

  const shouldDedupNotify = (
    notifyType: string,
    notifyMessage: string,
    specialist?: string,
    timestamp = Date.now(),
    toolCallId?: string
  ): boolean =>
    isDuplicateNotify(
      currentAgentProcess.value,
      { notifyType, message: notifyMessage, specialist, toolCallId },
      timestamp,
      NOTIFY_DEDUP_WINDOW_MS
    )

  watch(
    sid,
    (newSid) => {
      const process = agentStreamStore.getAgentProcess(newSid)
      const streaming = agentStreamStore.isStreaming(newSid)

      if (streaming && process.length > 0) {
        currentAgentProcess.value = [...process]
      } else {
        currentAgentProcess.value = []
      }

      const agentSessionId = agentStreamStore.getStream(newSid)?.agentSessionId
      currentSessionId.value = agentSessionId || ''

      adoptRunningSession(newSid)
    },
    { immediate: true }
  )

  /**
   * 认领一条已经在跑、但界面这边没接上的对话。
   *
   * 发生在**刷新页面之后**：`agentReattach` 把流式状态重建起来了（正文和推理
   * 会直接落进 Store），但工具调用、步骤、报错这几类事件要有处理器才派得下来 ——
   * 没有的话过程日志会从刷新那一刻起整段空白，出了错也没人报。
   *
   * 按 `hasActiveHandler` 挡重复：切来切去、以及「先挂载后接回」的回调，
   * 都可能对同一条对话调到这里。
   */
  function adoptRunningSession(chatSid: string): void {
    const stream = agentStreamStore.getStream(chatSid)
    if (!stream?.isStreaming || !stream.agentSessionId) return
    if (hasActiveHandler(stream.agentSessionId)) return

    console.log('[Agent模式] 接管刷新前就在跑的内核 session:', stream.agentSessionId)
    currentSessionId.value = stream.agentSessionId
    currentAgentProcess.value = [...stream.agentProcess]
    registerSessionHandlers(stream.agentSessionId, chatSid)
  }

  /**
   * 当前对话的过程时间线。
   *
   * 正文段是 `agentStreamStore.appendText` 直接记进 Store 的，本地那份镜像
   * 看不到 —— 写回消息时要是拿镜像，界面就永远只能看到工具调用，模型说的话
   * 还是会全部堆到最后。
   */
  const resolveProcessItems = (): AgentProcessItem[] => {
    const fromStore = agentStreamStore.getAgentProcess(sid.value)
    return fromStore.length > 0 ? [...fromStore] : [...currentAgentProcess.value]
  }

  const {
    handleAgentToolCall,
    handleAgentToolResult,
    handleAgentStep,
    handleAgentDone,
    handleAgentError,
    handleAgentStopped,
    handleAgentNotifyUsers
  } = createAgentModeHandlers({
    sid,
    messages,
    route,
    tabsStore,
    chatStore,
    chatMsgStore,
    aiConfigStore,
    scrollToBottomIfNeeded,
    currentAgentProcess,
    currentSessionId,
    currentAgentController,
    fullConversationHistory,
    currentText,
    currentThinking,
    currentTypingId,
    agentStreamStore,
    t,
    clearWikiRagState,
    getWikiRagCitations,
    shouldDedupNotify
  })

  function appendLocalAssistantMessage(content: string, chatSid = sid.value): void {
    const typingId = chatMsgStore.pushAssistantTyping(chatSid, Date.now())
    chatMsgStore.replaceTyping(chatSid, typingId, content, true)
    if (chatSid === sid.value) scrollToBottomIfNeeded()
  }

  function restoreAgentModeState(agentMode: boolean): void {
    isAgentMode.value = agentMode

    if (!isAgentMode.value) {
      cleanupAgentListeners()
      fullConversationHistory.value = []
      return
    }

    setupAgentListeners()

    // 刷新后主进程还在跑的那条，先认领回来再判断有没有在跑的内核 session
    adoptRunningSession(sid.value)

    const activeSessionId = findActiveSessionByChatSid(sid.value)
    if (activeSessionId) {
      currentSessionId.value = activeSessionId
      return
    }

    const history = chatStore.getAgentHistory(sid.value)
    const sessionId = chatStore.getAgentSessionId(sid.value)

    fullConversationHistory.value = history && history.length > 0 ? history : []
    if (sessionId) {
      currentSessionId.value = sessionId
    }
  }

  function switchMode(value: boolean): void {
    isAgentMode.value = value
    chatStore.setAgentMode(sid.value, value)

    if (value) {
      const history = chatStore.getAgentHistory(sid.value)
      const sessionId = chatStore.getAgentSessionId(sid.value)
      fullConversationHistory.value = history && history.length > 0 ? history : []
      if (sessionId) {
        currentSessionId.value = sessionId
      }
      setupAgentListeners()
      return
    }

    cleanupAgentListeners()
  }

  /**
   * 把这一轮的事件接到界面上。返回**轮次号**。
   *
   * execute（新一轮）和 continue（断点续跑）走的是同一套回调 —— 续跑对界面
   * 而言就是"这一轮继续往下跑"，没有任何该区别对待的地方。
   *
   * 三条收尾回调都把轮次号带下去：收尾是异步的，而同一条内核 session 紧接着就
   * 可能开跑下一轮（语音把排队的第二件活派回同一条内核 session 正是如此）。不带的话
   * 迟到的收尾会把**新那一轮**的处理器和流式状态一起拆掉 —— 屏幕上像是断了，
   * 后台却还在干活。
   */
  function registerSessionHandlers(
    agentSessionId: string,
    chatSid: string,
    onFinished?: (outcome: AgentRunOutcome) => void
  ): number {
    // 回调都在注册之后才会被调，所以这会儿还是 0 不影响
    let runId = 0
    runId = registerAgentHandler({
      sessionId: agentSessionId,
      chatSid,
      onToolCall: (data) => {
        handleAgentToolCall(null, data)
      },
      onToolResult: (data) => {
        handleAgentToolResult(null, data)
      },
      onStep: (data) => {
        handleAgentStep(null, data)
      },
      onDone: (data) => {
        void handleAgentDone(null, { ...data, runId })
          .then((text) => onFinished?.({ status: 'done', text }))
          .catch((error: unknown) => {
            console.error('[Agent模式] 处理完成事件失败:', error)
            onFinished?.({
              status: 'error',
              text:
                error instanceof Error ? error.message : t('assistant.agentMode.agentExecFailed')
            })
          })
      },
      onStopped: () => {
        handleAgentStopped(null, { sessionId: agentSessionId, runId })
        onFinished?.({ status: 'stopped', text: '' })
      },
      onError: (
        error: string,
        data?: { statusCode?: number; code?: string; detail?: string; planError?: string }
      ) => {
        void handleAgentError(null, {
          message: error,
          sessionId: agentSessionId,
          ...data,
          runId
        }).finally(() => onFinished?.({ status: 'error', text: error }))
      },
      onNotifyUsers: (data) => {
        // 分发器那边 payload 是开放形状（`[key: string]: unknown`），
        // 处理器要的是 message 必填的具体形状 —— 只有分发器保证发的是后者
        handleAgentNotifyUsers(null, data as unknown as NotifyUsersEvent)
      },
      // 正文/推理已经由全局分发器批量刷进消息。这里仅负责当前可见对话的滚动，
      // 不再另起一个 watcher 重复写消息、重复触发布局。
      onStreamPaint: (paintedChatSid) => {
        if (paintedChatSid === sid.value) {
          scrollToBottomIfNeeded()
        }
      }
    })
    return runId
  }

  /**
   * 从断点续跑。
   *
   * 上一轮因为报错或网络中断停在半路时用。与「重发一遍」的区别是实打实的：
   * 续跑保留全部上下文，模型接着上次的位置继续；重发是从头理解一遍任务，
   * 这一轮已经探测出的资产路径、已创建的节点全部作废重来。
   */
  async function resumeAgent(agentSessionId: string): Promise<void> {
    const chatSid = sid.value
    if (!agentSessionId) return
    /*
     * 还占着就别再起一次 —— 主进程会以「会话正在执行中」拒掉。
     *
     * 必须看 `isBusy` 而不是 `isStreaming`：界面停了、主进程还没 `released` 的那个
     * 空档，以及别的窗口正在跑这条对话时，`isStreaming` 都是 false。放过去的话，
     * 被拒后 `abandon()` 会摘掉上一轮留下的「等释放」标记，`isBusy` 提前变 false，
     * 排队的下一条就在主进程真正空出来之前出队、被顶回来 —— 那条话就没了。
     */
    if (agentStreamStore.isBusy(chatSid)) {
      message.info(t('assistant.agentMode.sessionBusy'))
      return
    }

    const typingId = pushAssistantTyping(Date.now())
    const resumeItem: AgentProcessItem = {
      type: 'notify-users',
      data: { message: t('assistant.agentMode.resumeProgress'), notifyType: 'progress' },
      timestamp: Date.now()
    }
    currentAgentProcess.value = [resumeItem]
    chatMsgStore.replaceTyping(chatSid, typingId, t('assistant.agentProcess.thinking'), false, {
      agentProcess: [...currentAgentProcess.value]
    })

    currentSessionId.value = agentSessionId
    agentStreamStore.initStream(chatSid, agentSessionId, typingId)
    // 续跑同样占着这条内核 session，直到主进程说 `released`。
    // 少了它的话，续跑收到 `done` 之后、后台真正放开之前，`isBusy` 会提前变 false，
    // 排队的下一条就在那个空档里发出去、被顶回来 —— 而它已经出队了
    agentStreamStore.markAwaitingRelease(chatSid, agentSessionId)
    agentStreamStore.addAgentProcess(agentSessionId, resumeItem)
    const runId = registerSessionHandlers(agentSessionId, chatSid)

    // 起不来时要把刚摆好的这一摊收掉：留着的话气泡会永远转圈，
    // 而且下一次发消息会因为残留的处理器把事件派到这个已死的内核 session 上
    const abandon = (reason: string): void => {
      chatMsgStore.replaceTyping(
        chatSid,
        typingId,
        t('assistant.agentMode.resumeFailed', { reason }),
        true,
        { outcome: 'error' }
      )
      unregisterAgentHandler(agentSessionId, runId)
      agentStreamStore.cleanupStream(agentSessionId)
      // 没跑起来，主进程不会发 released —— 不摘的话这条对话永远显示「忙」
      agentStreamStore.clearAwaitingRelease(agentSessionId)
      currentAgentProcess.value = []
      currentAgentController.value = null
    }

    const boundModel = chatStore.getModel?.(chatSid)
    try {
      const result = await window.api.agentV3.continue({
        sessionId: agentSessionId,
        mode: askModeRef.value || resolvePermissionMode(chatSid) === 'read-only' ? 'ask' : 'agent',
        // 同 execute：续跑也得带上对话归属的工程，否则接着聊的那半程又只认当前连接
        sessionProject: toSessionProjectPayload(chatStore.getProject?.(chatSid)),
        // 同理，档位也得带，而且是**这条对话**的那一份。不带的话主进程按最严的
        // 一档跑，用户设的是「帮我批准」，一点「从断点继续」却开始每一步写操作
        // 都弹框 —— 他什么都没改过
        approvalMode: toApprovalMode(resolvePermissionMode(chatSid)),
        // 报错之后用户可能在输入框里换了模型，续跑要用换过的那个
        ...(boundModel
          ? { sessionModel: { providerId: boundModel.providerId, modelId: boundModel.modelId } }
          : {})
      })
      if (result?.success) return

      // 失败走的是返回值不是异常（同 execute）。不看它的话界面会一直转圈。
      const reason = describeStartupError(
        { message: result?.error, code: result?.code },
        t,
        t('assistant.agentMode.agentExecFailed')
      )
      abandon(reason)
      message.warning(reason)
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      console.error('[Agent模式] 续跑失败:', error)
      abandon(reason)
      message.error(reason)
    }
  }

  async function executeAgent(
    userMessage: ChatMessageContent,
    excelContext?: string,
    options: ExecuteAgentOptions = {}
  ): Promise<void> {
    let reported = false
    const reportOutcome = (outcome: AgentRunOutcome): void => {
      if (reported) return
      reported = true
      options.onFinished?.(outcome)
    }

    const chatSid = options.chatSid || sid.value
    /** 目标对话就是眼前这条。不是的话，当前对话专属的那几样状态一律不碰 */
    const isCurrent = chatSid === sid.value

    if (typeof userMessage === 'string' && isEchoedAgentFallbackInput(userMessage)) {
      appendLocalAssistantMessage(AGENT_EMPTY_RESPONSE_ECHO_TEXT, chatSid)
      reportOutcome({ status: 'done', text: AGENT_EMPTY_RESPONSE_ECHO_TEXT })
      return
    }

    /*
     * 这里原来先过一道 `parseAskCommand`，把 `/ask` 前缀翻成一次性的只读模式。
     * 那条路删了：审批下拉本来就有「只读」一档（`applyPermissionMode`），
     * 而且它是**对话级、看得见、能改回来**的，比一个每轮都要重打的前缀好。
     * 下面 `permissionMode === 'read-only'` 那句才是真正在用的判据 ——
     * 留着两条通往同一件事的路，只会让「我到底是不是只读」变得要靠猜。
     */
    const preparedUserMessage = userMessage
    const effectiveOptions: ExecuteAgentOptions = { ...options }

    // 这份历史是当前对话的（V2 遗留），别的对话那一轮不往里记
    if (!effectiveOptions.isRetry && isCurrent) {
      if (excelContext) {
        fullConversationHistory.value.push({
          role: 'user',
          content: `【用户上传的 Excel 文件内容】\n${excelContext}\n\n请根据以上表格内容回答我的问题。`
        })
      }

      fullConversationHistory.value.push({
        role: 'user',
        content: preparedUserMessage
      })
    }

    const typingId = isCurrent
      ? pushAssistantTyping(Date.now())
      : chatMsgStore.pushAssistantTyping(chatSid, Date.now())
    const pendingPlaceholderText = t('assistant.agentProcess.thinking')

    /**
     * 过程日志**从空开始**。
     *
     * 这里原本会先塞一条随机文案（「匹配合适的专家」「判断合适的处理方式」…），
     * 那是 V2 Router 时代的产物 —— 那时确实在做专家匹配。V3 是扁平单 agent，
     * 没有专家、没有路由决策，这句话描述的事情**根本不存在**。
     *
     * 它唯一的作用是让过程日志在第一个真实事件到来前不空着。但为了填空而
     * 编造一句正在发生的事，比空着糟得多：用户会照着它去理解系统在干什么。
     * 真实事件（工具调用、工具结果、压缩、插话）到了自然会出现。
     */
    if (isCurrent) currentAgentProcess.value = []

    const targetMessages: ChatMessage[] = isCurrent
      ? messages.value
      : chatMsgStore.getMessages(chatSid)
    const lastIndex = targetMessages.length - 1
    if (lastIndex >= 0 && targetMessages[lastIndex].id === typingId) {
      chatMsgStore.replaceTyping(chatSid, typingId, pendingPlaceholderText, false, {
        agentProcess: []
      })
    }

    /**
     * 内核 session id 在**一个对话里必须保持不变**。
     *
     * 原来这里每轮 `crypto.randomUUID()` 现开一个，而 V3 是按 sessionId 恢复
     * transcript 的 —— 等于每发一条消息就换一个全新的 agent。加上界面只把
     * **最新一条**用户消息发过去（历史由内核自己恢复），结果是模型完全看不到
     * 上一轮：问「刚才那个材质叫什么」它答不上来。
     *
     * V2 时代随机 ID 是对的（那时历史整包塞在 messages 里，ID 只用于事件路由）；
     * 换成 pi 内核后它变成了内核 session 的身份，语义变了。
     */
    const agentSessionId = chatStore.getAgentSessionId(chatSid) || crypto.randomUUID()
    if (isCurrent) currentSessionId.value = agentSessionId
    agentStreamStore.initStream(chatSid, agentSessionId, typingId)
    /*
     * 从这一刻起这条对话就「忙」了，一直忙到主进程说 `released`。
     *
     * 不能只看流式状态：`done` 一到界面就把它清了，而主进程那边还要跑完
     * `finally` 里的 release 才真正空出来。那个间隙里发下一条会被顶回来，
     * 而排队投递是先出队再发的 —— 被顶回来的话就没了。
     */
    agentStreamStore.markAwaitingRelease(chatSid, agentSessionId)
    clearWikiRagState(agentSessionId)

    if (isCurrent) {
      chatStore.setAgentHistory(chatSid, fullConversationHistory.value)
      chatStore.setAgentCurrentText(chatSid, currentText.value)
    }
    chatStore.setAgentSessionId(chatSid, agentSessionId)

    /**
     * 登记处理器要和 `initStream` 挨着，**不能等准备工作做完**（知识库检索、取默认
     * 模型都是 IPC，要好几十毫秒）。
     *
     * 处理器就是「这条内核 session 现在归谁」的凭证：中间这段空档里，上一轮迟到的收尾看到
     * 的还是上一轮自己的处理器，于是认为这条内核 session 仍归它管，把这一轮刚建好的流式状态
     * 一起清了 —— 之后正文增量找不到落点，屏幕上像是断了，后台却还在干活。
     */
    const runId = registerSessionHandlers(agentSessionId, chatSid, reportOutcome)

    try {
      const historyUserMessage = isCurrent
        ? fullConversationHistory.value[fullConversationHistory.value.length - 1]
        : { role: 'user', content: preparedUserMessage }

      // 附件上下文并进用户这条：内核只收最后一条，单独推一条的话它从来到不了模型
      // 音视频不在这里拼：怎么让模型看（传对象存储换链接，还是只给路径）由主进程定
      const currentUserMessage = historyUserMessage
        ? {
            ...historyUserMessage,
            content: mergeTurnContext(
              historyUserMessage.content as ChatMessageContent,
              excelContext ? [excelContext] : []
            )
          }
        : undefined
      const finalMessages = currentUserMessage
        ? [JSON.parse(JSON.stringify(currentUserMessage))]
        : []

      /*
       * 库详情页的上下文。放在最前面 unshift，所以它会排在知识库 RAG 和
       * UE 工程上下文**之后**（后 unshift 的排更前），紧贴着用户这句话 ——
       * 「他正在看什么」是理解这句话的直接依据，离得越近越好。
       */
      const libraryContextMessage = buildLibraryContextMessage(libraryContext?.value)
      if (libraryContextMessage) {
        finalMessages.unshift({ ...libraryContextMessage })
      }

      const notebookRagTarget = await resolveNotebookRagTarget({
        boundNotebook: chatStore.getBoundNotebook?.(chatSid),
        routeName: route.name,
        routeNotebookId: route.params?.id,
        getNotebook: window.api.notebook.get
      })

      if (route.name === 'NotebookDetail' || notebookRagTarget?.notebookId) {
        try {
          const ueProjectContext = await buildCurrentUEProjectContext()
          if (ueProjectContext.contextMessage) {
            finalMessages.unshift(JSON.parse(JSON.stringify(ueProjectContext.contextMessage)))
          }
        } catch (error) {
          console.warn('[Agent模式] 当前 UE 工程上下文注入失败:', error)
        }
      }

      // 检索按用户问的那句话，不按并进了附件全文的那条：带着一份 200KB 的表格问问题，
      // 拿整张表去检索知识库，相关度全被表格淹掉，太长还会让向量化直接失败
      const ragQuery = extractTextForNotebookRag(historyUserMessage?.content ?? preparedUserMessage)
      if (notebookRagTarget?.notebookId && ragQuery) {
        try {
          const ragContext = await buildNotebookRagContext({
            notebookId: notebookRagTarget.notebookId,
            notebookTitle: notebookRagTarget.title,
            query: ragQuery
          })

          const routeNotebookId = Array.isArray(route.params?.id)
            ? route.params.id[0]
            : route.params?.id
          const shouldRefreshCurrentNotebook =
            route.name === 'NotebookDetail' &&
            String(routeNotebookId || '') === notebookRagTarget.notebookId
          if (shouldRefreshCurrentNotebook && ragContext.queuedIndexSourceIds?.length) {
            refreshNotebookSourcesAfterIndexing(
              notebookRagTarget.notebookId,
              ragContext.queuedIndexSourceIds
            )
          }

          if (ragContext.contextMessage) {
            finalMessages.unshift(JSON.parse(JSON.stringify(ragContext.contextMessage)))
          }

          const wikiHitState = buildWikiHitMessage(notebookRagTarget.title, ragContext)
          setWikiRagState(
            agentSessionId,
            ragContext.citations,
            wikiHitState.message,
            wikiHitState.notifyType
          )
        } catch (error) {
          console.error('[Agent模式] notebook RAG 注入失败:', error)
          setWikiRagState(
            agentSessionId,
            [],
            `知识库「${notebookRagTarget.title}」检索失败，本轮将继续按普通 Agent 流程回答。`,
            'warning'
          )
        }
      }

      const wikiHitState = getWikiHitState(agentSessionId)
      if (wikiHitState) {
        const wikiHitItem: AgentProcessItem = {
          type: 'notify-users',
          data: {
            message: wikiHitState.message,
            notifyType: wikiHitState.notifyType,
            specialist: 'wiki-rag'
          },
          timestamp: Date.now()
        }
        currentAgentProcess.value.push(wikiHitItem)
        agentStreamStore.addAgentProcess(agentSessionId, wikiHitItem)

        chatMsgStore.replaceTyping(chatSid, typingId, pendingPlaceholderText, false, {
          agentProcess: [...currentAgentProcess.value]
        })
      }
      const enabledByok = aiConfigStore.getEnabledOpenAICompatibleByok()
      /**
       * 权限档位**问目标对话要**。
       *
       * 这里原来读的是全局设置，于是 A 对话上设的只读会被 B 对话上设的完全访问
       * 顶掉 —— 而语音那一路更糟：它跑在「语音任务」那条对话上，凭什么用
       * 用户此刻正看着的那条对话的档位。
       */
      const permissionMode = resolvePermissionMode(chatSid)
      // askModeRef 是调用方强制锁只读用的（小窗口就这么干），保留它的一票否决
      const askMode =
        effectiveOptions.askMode ??
        ((isCurrent && askModeRef.value) || permissionMode === 'read-only')
      let startupFailed = false

      // 模型跟着对话走：第一轮发出时绑定，之后别的对话里切模型不影响这一条
      const { model: sessionModel, unavailable: sessionModelUnavailable } =
        await ensureSessionModel(chatSid, {
          chatStore,
          sessionModelOf: (id) => agentV3API.sessionModel(id),
          getSettings: () => aiProviderAPI.getSettings()
        })
      if (sessionModel && sessionModelUnavailable) {
        message.warning(
          t('assistant.agentMode.sessionModelUnavailable', { model: sessionModel.modelId })
        )
      }

      const controller = await aiAPI.executeAgent(
        {
          messages: finalMessages,
          provider: enabledByok
            ? enabledByok.mode === 'anthropic-native'
              ? 'claude'
              : 'openai'
            : undefined,
          model: enabledByok?.model,
          sessionId: agentSessionId,
          chatSid,
          // 这条对话挂在哪个工程下。主进程只知道「谁连着」——不带下去的话，
          // 用户在 test222 下问「这是啥项目」，模型会照着当前连接答成别的工程。
          // 必须先拍成普通对象：store 里那份是响应式代理，过不了 IPC 的结构化克隆。
          /*
           * 这一轮钉在哪个工程上。
           *
           * 调用方给了就用它 —— 那是**抓快照时**的那个工程，抓的和执行的必须是
           * 同一个。没给才退回对话戳（老行为）。
           */
          sessionProject:
            effectiveOptions.sessionProject ??
            toSessionProjectPayload(chatStore.getProject?.(chatSid)),
          // 键存在就一路带下去（含 null）；不存在说明这个入口还没接闪存
          ...(effectiveOptions.editorSnapshot !== undefined
            ? { editorSnapshot: effectiveOptions.editorSnapshot }
            : {}),
          ...(effectiveOptions.mediaFiles?.length
            ? { mediaFiles: effectiveOptions.mediaFiles }
            : {}),
          // 绑了知识库才给模型检索工具。上面注入的那份是**这一轮**的地基（顺带出引用），
          // 工具管的是它看完之后想换个说法再查 —— 那件事注入做不到
          notebook: notebookRagTarget?.notebookId
            ? { id: notebookRagTarget.notebookId, title: notebookRagTarget.title }
            : null,
          approvalMode: toApprovalMode(permissionMode),
          thinkingLevel: aiConfigStore.agentThinkingLevel,
          fastMode: aiConfigStore.agentFastMode,
          cursorContext: aiConfigStore.agentCursorContext,
          skillLearning: aiConfigStore.skillLearningMode,
          editorScreenshotEnabled: aiConfigStore.editorScreenshotEnabled,
          sessionModel,
          defaultEngineVersion: localStorage.getItem('defaultEngineVersion') || undefined,
          askMode,
          byokOpenAICompatible: enabledByok || undefined
        },
        {
          onError: (error) => {
            if (error?.sessionId === agentSessionId) {
              return
            }

            startupFailed = true
            // 主进程回的是码，文案在这边查 —— 直接显示 error.message 的话，
            // 用户读到的是带 sessionId 和 IPC 通道名的诊断原文
            const readable = describeStartupError(
              error,
              t,
              t('assistant.agentMode.agentExecFailed')
            )
            reportOutcome({ status: 'error', text: readable })
            const targetTypingId = (isCurrent && currentTypingId.value) || typingId
            const errorMsg = `${t('assistant.agentMode.errorPrefix')}: ${readable}`
            chatMsgStore.replaceTyping(chatSid, targetTypingId, errorMsg, true, {
              outcome: 'error'
            })
            message.error(readable)
            if (currentSessionId.value === agentSessionId) {
              currentAgentController.value = null
              currentAgentProcess.value = []
            }
            unregisterAgentHandler(agentSessionId, runId)
            agentStreamStore.cleanupStream(agentSessionId)
            // 这一轮压根没跑起来，主进程不会发 released —— 不摘的话这条对话永远"忙"，
            // 后面排的话一条都发不出去
            agentStreamStore.clearAwaitingRelease(agentSessionId)
            clearWikiRagState(agentSessionId)
          }
        }
      )

      if (startupFailed) {
        return
      }

      // 控制器是「当前对话那一轮」的。别的对话上的运行，用户切过去之后
      // 由 stopAgent 按 currentSessionId 走 IPC 停，不经过它
      if (isCurrent) currentAgentController.value = controller
    } catch (error) {
      unregisterAgentHandler(agentSessionId, runId)
      agentStreamStore.cleanupStream(agentSessionId)
      agentStreamStore.clearAwaitingRelease(agentSessionId)
      const errorMsg = `${t('assistant.agentMode.errorPrefix')}: ${
        error instanceof Error ? error.message : t('assistant.agentMode.agentExecException')
      }`
      chatMsgStore.replaceTyping(chatSid, typingId, errorMsg, true)
      message.error(t('assistant.agentMode.agentExecException'))
      if (isCurrent) currentAgentController.value = null
      clearWikiRagState(agentSessionId)
      if (currentSessionId.value === agentSessionId) {
        currentAgentProcess.value = []
      }
      reportOutcome({
        status: 'error',
        text: error instanceof Error ? error.message : t('assistant.agentMode.agentExecException')
      })
    }
  }

  /**
   * 停止当前这一轮。
   *
   * 返回值是「它真的停下来了吗」：主进程会等内核 session 收尾再回话，卡住停不下来
   * 时回 false。只按停止按钮的调用方不用管这个值；**停完接着要重发一轮**的
   * （编辑消息、重新生成）必须看 —— 没停干净就发，新一轮会被旧的顶掉。
   */
  async function stopAgent(): Promise<boolean> {
    if (currentAgentController.value) {
      try {
        return await currentAgentController.value.stop()
      } catch (error) {
        console.error('[Agent模式] 控制器停止失败:', error)
      }
    }

    if (!currentSessionId.value) {
      /*
       * 这一轮在**别的窗口**里跑（独立对话窗口显示着主窗口发起的那一轮，或者反过来）。
       * 这边没有它的流式状态，但主进程按内核 session 停，不认窗口；停下来之后的收尾
       * （气泡写上「已停止」）由发起的那个窗口做，再同步过来。
       */
      const elsewhereSessionId = agentStreamStore.isBusyElsewhere(sid.value)
        ? chatStore.getAgentSessionId(sid.value)
        : ''
      if (elsewhereSessionId) {
        try {
          const result = await window.api.agentV3.stop({ sessionId: elsewhereSessionId })
          return result?.drained !== false
        } catch (error) {
          console.error('[Agent模式] 停止别的窗口里的内核 session 失败:', error)
          return false
        }
      }
      return true
    }

    try {
      // 走 window.api.agentV3 而不是原始 invoke：agent-v3:* 不在
      // RAW_REQUEST_CHANNELS 白名单里，直接 invoke 会被 preload 挡下
      const result = await window.api.agentV3.stop({ sessionId: currentSessionId.value })
      handleAgentStopped(null, { sessionId: currentSessionId.value })
      return result?.drained !== false
    } catch (error) {
      console.error('[Agent模式] IPC 停止失败:', error)
      return false
    }
  }

  /**
   * 运行中插话改方向 —— V2 完全没有的能力。
   *
   * 消息在**当前这一步结束后**注入，agent 看到它再决定下一步：不打断执行，
   * 已经做完的部分保留。这与「停止后重新说一遍」的区别是实打实的 ——
   * 后者会丢掉这一轮已经探测出的资产路径、已创建的节点。
   *
   * 插话写进**当前这条回复的时间线**，就插在它发生的那两步之间。
   * 挂到消息列表末尾是不行的：那条气泡会一直浮在屏幕最下方，而 agent 后面
   * 做的每一件事都显示在它上面 —— 看起来像是这句话根本没被读到。
   *
   * 返回这句话有没有真的送进去。调用方据此决定要不要把它留在自己手上 ——
   * 「把排队的那条改成立即插话」失败时，那条必须还在队列里，
   * 否则用户点了一下，话就没了，而他只看到一个转瞬即逝的提示。
   *
   * `images` 是随这句话一起带的图（data URL）。**不会为它换模型**：这一轮用哪个
   * 模型在跑起来那一刻就定了，中途换等于把整段 prompt cache 作废。当前模型看不了
   * 图时，模型会照实说自己看不到 —— 比背着用户换模型诚实，代价也小得多。
   *
   * `attachments` 是图片以外的附件（音视频路径、文档正文），和普通发送同一套处理，
   * 只是塞进正在跑的这一轮。
   */
  async function steerAgent(text: string, options: SteerAgentOptions): Promise<boolean> {
    const { editorSnapshot, images, attachments, targetSessionId, ifRejected, restoreDraft } =
      options
    const sessionId = targetSessionId || currentSessionId.value
    // 这一轮属于哪条对话，也在等之前定下来：回执晚到时气泡得落回它自己的对话里
    const ownerChatSid = sessionId
      ? agentStreamStore.getChatSidByAgentSession(sessionId) || sid.value
      : sid.value
    // 只带附件没打字的，补一句说明。输入框和排队转插话两条路都走这里，补在这里就只有一处
    const trimmed =
      text.trim() || attachmentsOnlySteerText(t, images?.length ?? 0, attachments?.files)
    if (!sessionId || !trimmed) return false

    /*
     * 外链图片内联不了，退化成一行文本跟在话后面 —— 至少让模型知道有这么个东西。
     * 和普通发送那条路同一个函数，两边的行为不会分叉。
     */
    const converted = toAgentV3Images(images ?? [])
    const messageText = [trimmed, ...converted.fallbackTexts].join('\n\n')

    /** 主进程给这条插话的号。时间线上的撤回按钮拿它指认要撤哪一条 */
    let steerId: string | undefined

    try {
      /*
       * 快照和正在跑的那一轮工程对不上时，主进程会**整条拒绝**这次插话
       * （而不是丢掉快照照发）。那时下面的 `success: false` 分支会把原因说给用户，
       * 调用方拿到 false 就把这条留在原地 —— 它之后会按自己钉住的工程发出去。
       */
      const result = await window.api.agentV3.steer({
        sessionId,
        message: messageText,
        // 同 execute：过桥前拍平，队列里取出来那份是响应式代理
        ...(editorSnapshot !== undefined
          ? { editorSnapshot: toPlainEditorSnapshot(editorSnapshot) }
          : {}),
        ...(converted.images.length > 0 ? { images: converted.images } : {}),
        // 同上：拍平成普通对象再过桥，调用方给的可能是响应式代理
        ...(attachments?.mediaFiles?.length
          ? { mediaFiles: attachments.mediaFiles.map((file) => ({ ...file })) }
          : {}),
        ...(attachments?.contextText ? { contextText: attachments.contextText } : {})
      })
      if (!result?.success) {
        /*
         * 这一轮已结束（NOT_RUNNING）、或快照和正在跑的工程对不上
         * （PROJECT_MISMATCH）都不是「失败」：被拒的那条话按 `ifRejected`
         * 各有下文，用 info 如实说。其余拒绝照旧走 steerFailed 外框。
         */
        const rejection = describeSteerRejection(result, ifRejected, t)
        if (rejection) {
          message.info(rejection)
        } else {
          message.warning(
            t('assistantInputComposer.steerFailed', {
              reason: result?.error || t('assistant.agentMode.agentExecFailed')
            })
          )
        }
        return false
      }
      steerId = result.steerId
      if (steerId && restoreDraft) rememberSteerDraft(steerId, restoreDraft)
    } catch (error) {
      console.error('[Agent模式] 插话失败:', error)
      message.warning(
        t('assistantInputComposer.steerFailed', {
          reason: error instanceof Error ? error.message : String(error)
        })
      )
      return false
    }

    // 先把还在缓冲区里的正文放出来，插话才会落在它真正发生的位置之后
    agentStreamStore.flushBuffer(sessionId)

    /*
     * 时间线上记的必须和送进去的那句**一字不差**：生效回执是按文本相等匹配的
     * （`markSteerApplied`），差一个字这条就永远显示「未生效」。所以外链退化出来的
     * 那行也照记 —— 那正是模型看到的东西。
     */
    // 记进正在跑的那条回复的时间线；没有流在跑（切了对话、刚好收尾）
    // 才退回普通用户气泡 —— 无论如何用户都得在对话里看见自己说过的话。
    const files = attachments?.files
    if (
      !agentStreamStore.pushUserSteer(
        sessionId,
        messageText,
        steerId,
        images,
        files,
        // 用户没打字：那句说明是补给内核的，时间线上有图/卡片，不再重复画一遍
        !text.trim()
      )
    ) {
      // 写回这一轮所属的那条对话，不是此刻页面上开着的那条（等的时候可能切走了）
      if (ownerChatSid === sid.value) {
        pushUser(
          images?.length ? buildMultimodalContent(messageText, [...images]) : messageText,
          undefined,
          files
        )
      } else {
        chatMsgStore.pushUser(
          ownerChatSid,
          images?.length ? buildMultimodalContent(messageText, [...images]) : messageText,
          undefined,
          files
        )
      }
      // 内核已经收下了，只是界面上没有正在跑的流可以插进去 —— 对调用方来说
      // 这句话**已经送出去**了，不能当失败让它再发一遍
      return true
    }

    const chatSid = agentStreamStore.getChatSidByAgentSession(sessionId) || sid.value
    paintLiveTimeline(chatSid)
    if (chatSid === sid.value) {
      scrollToBottomIfNeeded()
    }
    return true
  }

  /**
   * 把时间线立刻刷进正在打字的那条消息。
   *
   * 平时这件事是工具事件顺手做的，但插话之后下一个事件可能几十秒才来
   * （一个跑很久的 Python 脚本）—— 不主动刷一次，用户按下发送后屏幕上
   * 什么都不会变，只能怀疑自己那句话是不是丢了。
   */
  function paintLiveTimeline(chatSid: string): void {
    const items = agentStreamStore.getAgentProcess(chatSid)
    if (items.length === 0) return

    const typing = chatMsgStore
      .getMessages(chatSid)
      .find((item: ChatMessage) => item.role === 'assistant' && item.status === 'typing')
    if (!typing) return

    chatMsgStore.replaceTyping(chatSid, typing.id, String(typing.content || ''), false, {
      agentProcess: [...items]
    })
  }

  function setupAgentListeners(): void {
    // The global dispatcher owns IPC subscriptions.
  }

  function cleanupAgentListeners(): void {
    if (currentText.value && currentText.value.length > 0) {
      chatStore.setAgentCurrentText(sid.value, currentText.value)
      const lastTypingMsg = messages.value.find(
        (item) => item.role === 'assistant' && item.status === 'typing'
      )
      if (lastTypingMsg) {
        chatMsgStore.replaceTyping(sid.value, lastTypingMsg.id, currentText.value, false)
      }
    }
  }

  function handleBeforeUnload(): void {
    if (!currentSessionId.value || !currentText.value) {
      return
    }

    chatStore.setAgentCurrentText(sid.value, currentText.value)

    const typingMsg = messages.value.find(
      (item) => item.role === 'assistant' && item.status === 'typing'
    )
    if (typingMsg) {
      const processItems = resolveProcessItems()
      chatMsgStore.replaceTyping(sid.value, typingMsg.id, currentText.value, false, {
        thinking: currentThinking.value,
        agentProcess: processItems.length > 0 ? processItems : undefined
      })
    }

    // beforeunload 之后等不到下一次检查点：两份 Store 都强制抓最新快照。
    // chat-messages 的专用 `$persist()` 会在序列化后立即 flush 共用存储，因此
    // chat-sessions 刚写进去的 agentCurrentText 也会一起落盘。
    try {
      // 对话那份也一起：上面刚写进去的 agentCurrentText 同样等不到 nextTick
      chatStore.$persist()
      chatMsgStore.$persist()
    } catch (error) {
      console.error('[Agent模式] beforeunload: 保存失败', error)
    }
  }

  /**
   * 重连是一次 IPC 往返，而对话界面通常在它回来之前就挂载完了 ——
   * 光靠挂载时查一遍 Store 会漏掉「先挂载、后接回」的那一半。
   */
  let disposeReattachListener: (() => void) | null = null

  onMounted(() => {
    window.addEventListener('beforeunload', handleBeforeUnload)
    adoptRunningSession(sid.value)
    disposeReattachListener = onAgentReattached((session) => {
      if (session.chatSid !== sid.value) return
      adoptRunningSession(session.chatSid)
    })
  })

  onUnmounted(() => {
    window.removeEventListener('beforeunload', handleBeforeUnload)
    disposeReattachListener?.()
    disposeReattachListener = null
    if (isAgentMode.value) {
      cleanupAgentListeners()
    }
  })

  /**
   * 清空一个对话。
   *
   * 除了清界面上的历史，**必须把 V3 那边的 transcript 也删掉**：
   * 内核的记忆存在自己的 JSONL 里，只清界面的话用户看到屏幕空了，
   * 模型却还记得刚才说的每一句 —— 这不是"清空"。
   */
  function clearConversationHistory(chatSid?: string): void {
    const targetSid = chatSid || sid.value
    fullConversationHistory.value = []
    chatStore.setAgentHistory(targetSid, [])
    chatStore.setAgentCurrentText(targetSid, '')
    chatStore.clearContextUsage(targetSid)

    const staleSessionId = chatStore.getAgentSessionId(targetSid)
    if (!staleSessionId) return

    // 先断开身份，再删盘：删除失败也不该让下一轮又接回旧记忆
    chatStore.setAgentSessionId(targetSid, '')
    if (currentSessionId.value === staleSessionId) {
      currentSessionId.value = ''
    }
    void window.api.agentV3
      .deleteSession({ sessionId: staleSessionId })
      .catch((error: unknown) => console.error('[Agent模式] 删除 V3 内核 session 失败:', error))
  }

  return {
    isAgentMode,
    currentSessionId,
    currentText,
    fullConversationHistory,
    askModeRef,
    isCurrentStreaming,
    restoreAgentModeState,
    switchMode,
    executeAgent,
    stopAgent,
    steerAgent,
    resumeAgent,
    clearConversationHistory,
    setupAgentListeners,
    cleanupAgentListeners
  }
}
