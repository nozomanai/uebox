/**
 * 工作室模式（`/team`）的任务板面板数据。
 *
 * 主进程那份账（名册、任务板、留言，见 `main/agent-v3/core/team/teamStore.ts`）是真相源，
 * 这里只负责读出来、在它变的时候重读。
 *
 * ## 什么时候重读
 *
 * - 换了对话（chatSid 变了，或者这条对话第一次拿到 agent sessionId）
 * - 主进程推 `agent-v3:team-board`：名册、任务板、留言、验收结论任何一样变了
 * - 这条对话的一轮跑完（`agent-v3:released`）：兜底，万一哪次推送没接上
 *
 * 不轮询：不是工作室的对话一次查询都不该多花。
 */

import { computed, onUnmounted, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'

import type { SettingsView } from '@core/shared/aiProvider'
import {
  teamModelCandidates,
  teamModelLabel,
  type TeamActivity,
  type TeamModel,
  type TeamModelCandidate,
  type TeamStateView
} from '@core/shared/agentTeam'
import { agentV3API } from '@renderer/api/agentV3'
import { aiProviderAPI } from '@renderer/api/aiProvider'
import { describeProbeFailure } from '@renderer/views/System/Preferences/panels/AIProviders/probeCopy'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { message } from '@renderer/utils/messageManager'

export interface UseTeamBoard {
  team: Ref<TeamStateView | null>
  loading: Ref<boolean>
  /** 队员最近的动态（调了什么工具、说了什么），旧的在前 */
  activity: Ref<TeamActivity[]>
  /** 这条对话是不是工作室 */
  active: ComputedRef<boolean>
  refresh: () => Promise<void>
  /** 卡住的一项改回待办，下一轮制作人会看到 */
  reopen: (taskId: string) => Promise<void>
  /** 把一件停下的活交回制作人（任务板上加一项「用户重开」的待办） */
  reopenJob: (jobId: string) => Promise<void>
  /** 结束团队模式。任务板和队员留在盘上，下次 /team 接得上 */
  end: () => Promise<void>
  /** 队员能换成哪些模型。和制作人招人时的候选是同一份名单 */
  modelChoices: ComputedRef<TeamModelCandidate[]>
  /** 读过模型设置没有。没读过时不能断言「这个模型用不了」 */
  modelsLoaded: ComputedRef<boolean>
  /** 重读模型设置。用户打开换模型菜单时调，免得刚在设置页加的模型不在里面 */
  loadModels: () => Promise<void>
  /** 给队员换模型，下一件活开始用 */
  setMemberModel: (name: string, model: TeamModel) => Promise<void>
  /** 辞退队员：理由必填，手上有活的不行。档案留在团队的账里 */
  dismissMember: (name: string, reason: string) => Promise<void>
}

/** 界面上最多留多少条动态（所有人加起来） */
const ACTIVITY_KEPT = 80

/**
 * @param teamId 外部驱动的对话直接给团队 id；它没有盒子内核的 session。给了就不看 chatSid
 */
export function useTeamBoard(chatSid: Ref<string>, teamId?: Ref<string>): UseTeamBoard {
  const chatStore = useChatSessionsStore()
  const { t } = useI18n()
  const team = ref<TeamStateView | null>(null)
  const loading = ref(false)
  const agentSessionId = computed(
    () => teamId?.value || (chatSid.value ? chatStore.getAgentSessionId(chatSid.value) : '')
  )

  const activity = ref<TeamActivity[]>([])

  // 两次重读撞在一起时，只认最后发出去的那一次，免得旧结果盖掉新结果
  let generation = 0
  const refresh = async (): Promise<void> => {
    const sessionId = agentSessionId.value
    const mine = ++generation
    if (!sessionId) {
      team.value = null
      loading.value = false
      return
    }
    loading.value = true
    try {
      const next = await agentV3API.teamState(sessionId)
      if (mine !== generation) return
      team.value = next
      // 主进程那份是这次运行里攒下的；它比界面手上的旧（刚打开面板）才拿来垫底
      const recent = next?.live?.recent ?? []
      const newest = activity.value.at(-1)?.at ?? 0
      if (recent.length && (recent.at(-1)?.at ?? 0) >= newest) activity.value = recent
    } catch {
      // 读不到不是错，只是这一次没读到。保留上一次的值，别让面板闪
    } finally {
      if (mine === generation) loading.value = false
    }
  }

  const onChange = (...args: unknown[]): void => {
    const payload = args[0] as { sessionId?: string } | undefined
    if (payload?.sessionId && payload.sessionId === agentSessionId.value) void refresh()
  }

  // preload 的 on() 挂的是包了一层的处理器并把它返回；off() 要传回这一个，传 onChange 摘不掉
  const onActivity = (...args: unknown[]): void => {
    const payload = args[0] as (TeamActivity & { sessionId?: string }) | undefined
    if (!payload?.sessionId || payload.sessionId !== agentSessionId.value) return
    const { member, text, at } = payload
    activity.value = [...activity.value, { member, text, at }].slice(-ACTIVITY_KEPT)
  }

  const boardHandler = window.api.on('agent-v3:team-board', onChange)
  const activityHandler = window.api.on('agent-v3:team-activity', onActivity)
  const releasedHandler = window.api.on('agent-v3:released', onChange)
  watch(
    agentSessionId,
    () => {
      team.value = null
      activity.value = []
      void refresh()
    },
    { immediate: true }
  )

  onUnmounted(() => {
    generation++
    window.api.off('agent-v3:team-board', boardHandler)
    window.api.off('agent-v3:team-activity', activityHandler)
    window.api.off('agent-v3:released', releasedHandler)
  })

  // 成功不用提示：主进程会推 `agent-v3:team-board`，面板自己就变了
  const reopen = async (taskId: string): Promise<void> => {
    const sessionId = agentSessionId.value
    if (!sessionId) return
    const result = await agentV3API.teamTaskReopen(sessionId, taskId).catch(() => null)
    if (!result?.success) message.error(t('assistant.teamBoard.reopenFailed'))
  }
  const reopenJob = async (jobId: string): Promise<void> => {
    const sessionId = agentSessionId.value
    if (!sessionId) return
    const result = await agentV3API.teamJobReopen(sessionId, jobId).catch(() => null)
    if (!result?.success) message.error(t('assistant.teamBoard.reopenFailed'))
  }

  const end = async (): Promise<void> => {
    const sessionId = agentSessionId.value
    if (!sessionId) return
    const result = await agentV3API.teamEnd(sessionId).catch(() => null)
    if (result?.success) return
    message.error(
      t(
        result?.errorKey === 'running'
          ? 'assistant.teamBoard.endWhileRunning'
          : 'assistant.teamBoard.endFailed'
      )
    )
  }

  const modelSettings = ref<SettingsView | null>(null)
  const loadModels = async (): Promise<void> => {
    try {
      modelSettings.value = await aiProviderAPI.getSettings()
    } catch {
      // 读不到就保留上一次的名单；一次都没读到时面板不显示模型
    }
  }
  const active = computed(() => team.value !== null)
  const modelChoices = computed(() =>
    modelSettings.value ? teamModelCandidates(modelSettings.value.providers) : []
  )
  watch(active, (on) => on && void loadModels(), { immediate: true })

  // 换之前主进程要给新模型做一次入职体检（几秒到十几秒），这段时间得让用户知道在等什么
  const setMemberModel = async (name: string, model: TeamModel): Promise<void> => {
    const sessionId = agentSessionId.value
    if (!sessionId) return
    const label = teamModelLabel(modelChoices.value, model)
    const close = message.loading(t('assistant.teamBoard.model.checking', { model: label }), 0)
    const result = await agentV3API
      .teamMemberModel(sessionId, name, model)
      .catch(() => null)
      .finally(close)
    if (result?.success) return
    if (result?.checkup) {
      const checkup = result.checkup
      const reason = !checkup.reachable
        ? describeProbeFailure(checkup.failure)
        : t('assistant.teamBoard.model.checkupNoTools')
      message.error(t('assistant.teamBoard.model.checkupFailed', { model: label, reason }))
      return
    }
    message.error(t('assistant.teamBoard.model.changeFailed'))
  }

  // 成功不提示：主进程推 `agent-v3:team-board`，名册和辞退档案自己就变了
  const dismissMember = async (name: string, reason: string): Promise<void> => {
    const sessionId = agentSessionId.value
    if (!sessionId) return
    const result = await agentV3API.teamMemberDismiss(sessionId, name, reason).catch(() => null)
    if (result?.success) return
    message.error(
      result?.errorKey === 'busy'
        ? t('assistant.teamBoard.dismiss.busy', { name })
        : t('assistant.teamBoard.dismiss.failed')
    )
  }

  return {
    team,
    loading,
    activity,
    active,
    refresh,
    reopen,
    reopenJob,
    end,
    modelChoices,
    modelsLoaded: computed(() => modelSettings.value !== null),
    loadModels,
    setMemberModel,
    dismissMember
  }
}
