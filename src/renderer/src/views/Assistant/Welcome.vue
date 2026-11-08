<template>
  <!--
    嵌入模式下要和浏览器分屏并排，所以外面套一层横向 flex。
    浏览器面板只是**占位**：网页由主进程挂在主窗口上，浮在这块之上。
  -->
  <div class="assistant-shell">
    <div
      class="assistant-welcome"
      :class="{ 'is-conversation': conversationMode }"
      :style="{ '--composer-height': composerHeightVar }"
      @mousemove="handleSphereMouseMove"
    >
      <div class="sticky-header">
        <TopNav
          :notebook-mode="notebookMode"
          :chat-sid="sid"
          :pending-project-name="pendingProjectName"
          :hide-project-chip="!conversationMode"
          @side-question="handleSideQuestion"
          @clear="handleClearSession"
          @export-image="exportAsImage"
          @export-json="exportAsJSON"
          @export-md="exportAsMarkdown"
        />
      </div>

      <VoiceStatusPanel
        v-if="!conversationMode && showVoiceStatus"
        :voice="voice"
        :status-text="voiceStatusText"
        :bound-title="voiceBoundTitle"
        @open-call="openVoiceCall"
        @retry="toggleVoice"
      />

      <section v-if="!conversationMode" class="hero">
        <button
          type="button"
          class="hero-sphere-button"
          :aria-label="
            t(
              voice.connecting.value
                ? 'assistantInputComposer.voice.cancelConnection'
                : 'assistantInputComposer.voice.start'
            )
          "
          :aria-busy="voice.connecting.value"
          @click="toggleVoice"
        >
          <BrandSphere :size="180" :mouse-x="sphereMouseX" :mouse-y="sphereMouseY" />
        </button>
        <h1 class="hero-title">{{ greetingMessage }}</h1>
        <!-- 还没开聊时工程归属放在问候语下面，开聊后回到右上角 -->
        <div class="hero-project">
          <SessionProjectChip
            :chat-sid="sid"
            :pending-project-name="pendingProjectName"
            placement="bottom"
          />
        </div>
      </section>

      <section v-if="!conversationMode" class="composer-section">
        <InputComposer
          :is-generating="isGenerating"
          :is-image-generation-mode="isImageGenerationMode"
          :is-agent-mode="true"
          :ask-mode="askModeRef"
          :hide-chips="voice.connecting.value"
          :notebook-mode="notebookMode"
          :notebook-sources="notebookSources"
          :bound-notebook="boundNotebook"
          :chat-sid="sid"
          :voice="voice"
          :queued-follow-ups="queuedFollowUps"
          @send="handleComposerSend"
          @attach="handleAttach"
          @run-command="handleRunCommand"
          @create-image="handleCreateImage"
          @cancel-image-generation="handleCancelImageGeneration"
          @search-web="handleSearchWeb"
          @toggle-ask-mode="handleAskModeChange"
          @bind-wiki="handleBindWiki"
          @clear-bound-wiki="handleClearBoundWiki"
          @steer="handleComposerSteer"
          @cancel-queued="handleCancelQueuedFollowUp"
          @steer-queued="handleSteerQueuedFollowUp"
        />
      </section>

      <section v-if="!conversationMode" class="suggestions">
        <SuggestionCards :items="suggestions" @select="handleSuggestionClick" />
      </section>

      <section v-if="conversationMode" ref="chatContainerRef" class="chat-log-area">
        <ChatLog
          ref="chatLogRef"
          :messages="messages"
          @retry="handleBubbleRetry"
          @stop="handleBubbleStop"
          @suggest="handleBubbleSuggest"
          @copy="handleBubbleCopy"
          @branch="handleBubbleBranch"
          @followups-ready="handleFollowupsReady"
          @action="handleBubbleAction"
          @open-location="handleOpenLocation"
          @content-resize="handleContentResize"
          @source-click="handleSourceClick"
          @user-copy="handleUserBubbleCopy"
          @user-confirm-edit="handleUserConfirmEdit"
          @user-scrolled-away="handleUserScrolledAway"
        />
        <div ref="bottomSentinel" class="bottom-sentinel"></div>
        <div v-if="showNewMsgToast" class="new-msg-toast">
          <AppButton
            variant="text"
            shape="circle"
            class="scroll-to-bottom-btn"
            @click="scrollToBottom"
          >
            <template #icon>
              <PhCaretCircleDown weight="fill" />
            </template>
          </AppButton>
        </div>
      </section>

      <section
        v-if="conversationMode"
        ref="chatComposerRef"
        class="composer-section chat-composer-sticky"
      >
        <!--
          审批框的停靠位：空的时候一点高度都不占，有待审批时从这里顶起来，
          正好落在输入框上方 —— 你刚打完字的地方。

          框本身挂在 `MainLayout` 上（助手页没有 keepAlive，挂这儿切页就没了），
          只是把内容 Teleport 进来。理由和取舍见 `useApprovalDock.ts`。

          放在这一层里面（而不是当它的兄弟）是为了蹭 `chatComposerRef` 那个
          ResizeObserver：卡片一出来，`--composer-height` 自己就长高了，
          对话区按新值收缩，输入框和卡片都还在可视区里。当兄弟节点的话
          得再写一套测量，还容易把 sticky 的输入框顶出屏幕。
        -->
        <div :ref="setApprovalDock" class="approval-dock"></div>

        <!-- 对话页的语音状态条放在输入框这一层：高度算进 --composer-height，不盖住消息区 -->
        <VoiceStatusPanel
          v-if="showVoiceStatus"
          :voice="voice"
          :status-text="voiceStatusText"
          :bound-title="voiceBoundTitle"
          @open-call="openVoiceCall"
          @retry="toggleVoice"
        />

        <!--
          输入框上方的语音球。谁在说话由它一个人交代 ——
          红色向内收是你在说，蓝色向外扩是它在说。
        -->
        <!--
          它说话期间麦克风是闭着的（外放时音箱贴着麦克风，靠比响度分不开回声和
          人声），所以打断只能手动 —— 点球体就是其中一条入口，另一条是可自配的
          全局快捷键。没在说话时按钮是禁用的，点了不会误挂断通话。
        -->
        <div v-if="voice.active.value" class="voice-orb-dock">
          <button
            type="button"
            class="voice-orb-button"
            :disabled="!voice.speaking.value"
            :title="voice.speaking.value ? voiceInterruptLabel : voiceInterruptHint"
            :aria-label="voiceInterruptLabel"
            @click="voice.interrupt()"
          >
            <VoiceOrb
              :phase="voice.phase.value"
              :input-level="voice.inputLevel.value"
              :output-level="voice.outputLevel.value"
              :size="72"
            />
          </button>
        </div>
        <!-- 目标模式（/goal）的目标，一行，悬停看全文。跨轮挂着，点 × 才取消 -->
        <div v-if="sessionGoal.objective.value" class="session-goal">
          <PhTarget class="session-goal-icon" />
          <span class="session-goal-label">{{ t('assistant.composer.currentGoal') }}</span>
          <span class="session-goal-text" :title="sessionGoal.objective.value">
            {{ sessionGoal.objective.value }}
          </span>
          <button
            type="button"
            class="session-goal-cancel"
            :title="t('assistant.composer.cancelGoal')"
            :aria-label="t('assistant.composer.cancelGoal')"
            @click="sessionGoal.cancel"
          >
            <PhX :size="12" />
          </button>
        </div>
        <!-- 工作室模式（/team）的任务板摘要。只有工作室对话才有，点开在右侧面板看全部 -->
        <TeamBoardPanel
          v-if="teamBoard.team.value"
          :team="teamBoard.team.value"
          @open="teamTab.show"
        />
        <InputComposer
          :is-generating="isGenerating"
          :is-image-generation-mode="isImageGenerationMode"
          :is-agent-mode="true"
          :ask-mode="askModeRef"
          :hide-chips="true"
          :notebook-mode="notebookMode"
          :notebook-sources="notebookSources"
          :bound-notebook="boundNotebook"
          :chat-sid="sid"
          :voice="voice"
          :queued-follow-ups="queuedFollowUps"
          @send="handleComposerSend"
          @attach="handleAttach"
          @run-command="handleRunCommand"
          @create-image="handleCreateImage"
          @cancel-image-generation="handleCancelImageGeneration"
          @search-web="handleSearchWeb"
          @stop="handleComposerStop"
          @toggle-ask-mode="handleAskModeChange"
          @bind-wiki="handleBindWiki"
          @clear-bound-wiki="handleClearBoundWiki"
          @images-change="handleComposerImagesChange"
          @steer="handleComposerSteer"
          @cancel-queued="handleCancelQueuedFollowUp"
          @steer-queued="handleSteerQueuedFollowUp"
        />
      </section>
    </div>

    <AgentBrowserPane
      v-if="browserSessionId || fileReview || teamTab.open.value || teamTab.reports.value.length"
      :key="`${sid}:${browserSessionId}`"
      :session-id="browserSessionId || ''"
      :open="
        browserPaneOpen || !!fileReview || teamTab.open.value || !!teamTab.reports.value.length
      "
      :review-open="!!fileReview"
      :review-active="
        !!fileReview &&
        !teamTab.active.value &&
        !teamTab.activeReport.value &&
        (fileReview.active || !browserPaneOpen)
      "
      :team-open="teamTab.open.value"
      :team-active="teamTab.active.value"
      :reports="teamTab.reports.value"
      :active-report="teamTab.activeReport.value"
      :url="browserUrl"
      :navigation="browserNavigation"
      :group="browserGroup"
      :find="browserFind"
      :visible="paneActive"
      @select-review="selectReviewTab"
      @close-review="closeFileReview"
      @select-team="teamTab.show"
      @close-team="teamTab.close"
      @select-report="teamTab.openReport"
      @close-report="teamTab.closeReport"
      @select-browser="selectBrowserPage"
    >
      <template #review>
        <FileReviewPane
          v-if="fileReview"
          :changes="fileReview.changes"
          :selected-path="fileReview.selectedPath"
        />
      </template>
      <template #team>
        <TeamBoardPanel
          v-if="teamBoard.team.value"
          docked
          :team="teamBoard.team.value"
          :session-id="browserSessionId || ''"
          :activity="teamBoard.activity.value"
          :running="isGenerating"
          :model-choices="teamBoard.modelChoices.value"
          :models-loaded="teamBoard.modelsLoaded.value"
          @reopen="teamBoard.reopen"
          @reopen-job="teamBoard.reopenJob"
          @end="teamBoard.end"
          @open-models="teamBoard.loadModels"
          @set-model="teamBoard.setMemberModel"
          @dismiss="teamBoard.dismissMember"
          @open-report="teamTab.openReport"
        />
      </template>
      <template #report>
        <TeamReportPane
          v-if="teamBoard.team.value && teamTab.activeReport.value"
          :key="teamTab.activeReport.value"
          :team="teamBoard.team.value"
          :activity="teamBoard.activity.value"
          :job-id="teamTab.activeReport.value"
          :title="
            teamTab.reports.value.find((r) => r.id === teamTab.activeReport.value)?.title ?? ''
          "
        />
      </template>
    </AgentBrowserPane>
  </div>
</template>

<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import VoiceStatusPanel from './components/VoiceStatusPanel.vue'
import { provideApprovalDock } from '@renderer/components/useApprovalDock'
defineOptions({ name: 'AssistantWelcome' })
import {
  computed,
  onMounted,
  onBeforeUnmount,
  onActivated,
  onDeactivated,
  ref,
  watch,
  nextTick,
  inject,
  provide,
  type PropType,
  type Ref
} from 'vue'
import { storeToRefs } from 'pinia'
/* ... imports ... */

/* ... existing code ... */

/**
 * 外部触发输入并发送
 */
/**
 * 外部触发输入并发送
 */
function triggerInput(text: string): void {
  console.log('[Welcome] triggerInput called with:', text)
  if (!text) return
  // 确保对话存在，参考 handleBubbleSuggest 的逻辑
  chatStore.ensureSession(sid.value || normalizeSid(''), t('assistant.chatFlow.unnamedChat'))
  handleSend({ content: text, images: [] })
}

defineExpose({
  triggerInput
})

/* ... rest of script ... */
import { useRoute, useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import TopNav from './components/TopNav.vue'
import SessionProjectChip from './components/SessionProjectChip.vue'
import BrandSphere from './components/BrandSphere.vue'
import VoiceOrb from './components/VoiceOrb.vue'
import InputComposer from './components/InputComposer.vue'
import SuggestionCards, { type SuggestionItem } from './components/SuggestionCards.vue'
import ChatLog, { type ChatMessage } from './components/ChatLog.vue'
import AgentBrowserPane from './components/AgentBrowserPane.vue'
import FileReviewPane from './components/FileReviewPane.vue'
import { conversationToMarkdown } from './composables/devlogMarkdown'
import { provideFileReview } from './composables/useFileReview'
import { useSessionBrowser } from './composables/useSessionBrowser'
import { useChatSessionsStore, type BoundNotebook } from '../../store/modules/chatSessions'
import TeamBoardPanel from './components/TeamBoardPanel.vue'
import TeamReportPane from './components/TeamReportPane.vue'
import { useTeamBoard } from './composables/useTeamBoard'
import { useTeamTab } from './composables/useTeamTab'
import { useSessionGoal } from './composables/useSessionGoal'
import { useTabsStore } from '../../store/modules/tabs'
import {
  useChatMessagesStore,
  type ChatMessageContent,
  type ExcelFileInfo
} from '../../store/modules/chatMessages'
import { useVaultStore } from '../../store/modules/vaultStore'
import { message } from '@renderer/utils/messageManager'
import { confirmDialog } from '@renderer/utils/dialog'
import { PhCaretCircleDown, PhTarget, PhX } from '@phosphor-icons/vue'
import { useGreeting } from './composables/useGreeting'
import { useContextChips } from './composables/useContextChips'
import { useAgentMode } from './composables/useAgentMode'
import { ensurePermissionMode } from './composables/sessionPermissionMode'
import { AGENT_RESUME_ACTION } from './composables/agentHandlerShared'
import { useChatFlow, type NotebookSourceItem } from './composables/useChatFlow'
import type { LibraryChatContext } from './composables/libraryChatContext'
import {
  clearFollowUps,
  enqueueFollowUp,
  findFollowUp,
  listFollowUps,
  removeFollowUp,
  type FollowUpQueues
} from './composables/followUpQueue'
import { bubbleAttachments, type SteerAttachments } from './composables/turnAttachments'
import {
  attachVoiceHost,
  startVoiceIn,
  useVoiceAssistant,
  voiceChatSid,
  type VoiceHost
} from './composables/voiceAssistant'
import type { AgentProcessItem } from './components/AgentProcessLog.types'
import { useAgentStreamStore } from '../../store/modules/agentStream'
import { useFollowUpQueueStore } from '../../store/modules/followUpQueue'
import { agentV3API } from '@renderer/api/agentV3'
import { branchChat } from './composables/chatBranch'
import { countUserTurnsBefore, rewindTranscript } from './composables/transcriptRewind'
import { openSideQuestion } from './composables/sideQuestion'
import {
  buildReviewFixPrompt,
  buildSelfCheckPrompt,
  findRequestBefore,
  REVIEW_FIX_ACTION,
  SELF_CHECK_ACTION,
  type SelfCheckInput
} from './composables/selfCheck'
import { SESSION_PROJECT_KEY } from './composables/reviewOpenProject'
import { captureChatAsPng } from './components/chatImageExport'

const chatStore = useChatSessionsStore()
const tabsStore = useTabsStore()
const chatMsgStore = useChatMessagesStore()
const agentStreamStore = useAgentStreamStore()
const vaultStore = useVaultStore()

const route = useRoute()
const router = useRouter()
const { t } = useI18n()

// SSE流控制器引用已移至 useChatFlow composable 中管理

// ==================== Agent 模式相关状态 ====================

// ==================== 问候语逻辑（使用 composable）====================
const { greetingMessage } = useGreeting()

/**
 * 根据当前模式返回不同的建议卡片内容
 * - 图片生成模式：显示图片相关建议
 * - 视频生成模式：显示视频相关建议
 * - 智能对话模式（默认）：显示虚幻引擎开发相关建议
 */
const suggestions = computed<SuggestionItem[]>(() => {
  /*
   * 嵌进别的页面时，那个页面自己的起手式更有用 —— 在蓝图详情页里摆一张
   * 「帮我生成一张概念图」的卡片，等于在提示一件和这个页面无关的事。
   * 给了就整组换掉，不和通用的混在一起。
   */
  if (props.customSuggestions?.length) return props.customSuggestions

  // 图片生成模式
  if (isImageGenerationMode.value) {
    return [
      {
        title: t('assistant.suggestions.imageGen.item1.title'),
        description: t('assistant.suggestions.imageGen.item1.desc'),
        prompt: t('assistant.suggestions.imageGen.item1.prompt')
      },
      {
        title: t('assistant.suggestions.imageGen.item2.title'),
        description: t('assistant.suggestions.imageGen.item2.desc'),
        prompt: t('assistant.suggestions.imageGen.item2.prompt')
      },
      {
        title: t('assistant.suggestions.imageGen.item3.title'),
        description: t('assistant.suggestions.imageGen.item3.desc'),
        prompt: t('assistant.suggestions.imageGen.item3.prompt')
      }
    ]
  }
  // 默认：智能对话模式
  return [
    {
      title: t('assistant.suggestions.blueprintDebug.title'),
      description: t('assistant.suggestions.blueprintDebug.desc'),
      prompt: t('assistant.suggestions.blueprintDebug.prompt')
    },
    {
      title: t('assistant.suggestions.materialRender.title'),
      description: t('assistant.suggestions.materialRender.desc'),
      prompt: t('assistant.suggestions.materialRender.prompt')
    },
    {
      title: t('assistant.suggestions.buildPackage.title'),
      description: t('assistant.suggestions.buildPackage.desc'),
      prompt: t('assistant.suggestions.buildPackage.prompt')
    }
  ]
})

const messages = computed<ChatMessage[]>(() => chatMsgStore.getMessages(sid.value))
const boundNotebook = computed<BoundNotebook | null>(() => {
  if (props.notebookMode) {
    return null
  }

  if (!sid.value) return null
  return chatStore.getBoundNotebook(sid.value)
})

// ==================== 智能推荐芯片（使用 composable）====================
const { contextChips, updateContextChips } = useContextChips()

const props = defineProps({
  forceChatView: {
    type: Boolean,
    default: false
  },
  chatSid: {
    type: String,
    default: undefined
  },
  /** 知识库模式：启用 @ 提及功能 */
  notebookMode: {
    type: Boolean,
    default: false
  },
  /** 知识库来源列表 */
  notebookSources: {
    type: Array as PropType<NotebookSourceItem[]>,
    default: () => []
  },
  /**
   * 嵌在蓝图库 / 材质库详情页里时，「用户正在看什么」。
   *
   * 每一轮请求前注入一条上下文消息，**不进对话历史** —— 所以带的永远是
   * 当下的选中节点。页面自己算好传进来（`libraryChatContext.ts`）。
   */
  libraryContext: {
    type: Object as PropType<LibraryChatContext | null>,
    default: null
  },
  /** 起手式卡片。给了就整组顶掉通用的那组（嵌在别的页面里时用） */
  customSuggestions: {
    type: Array as PropType<SuggestionItem[]>,
    default: () => []
  }
})

const sid = ref<string>('')
// 审查时引擎没连上，气泡要知道该替用户打开哪个工程
provide(
  SESSION_PROJECT_KEY,
  computed(() => chatStore.getProject?.(sid.value) ?? null)
)
/** 工作室模式的任务板。不是工作室的对话 team 为 null，面板不出现 */
const teamBoard = useTeamBoard(sid)
/** 目标模式的目标。没有就是 null，那一行不出现 */
const sessionGoal = useSessionGoal(sid)
const {
  review: fileReview,
  select: selectFileReview,
  close: closeFileReview,
  selectBrowser: selectBrowserTab
} = provideFileReview(sid)
// Initialize sid immediately if prop is provided
if (props.chatSid) {
  sid.value = props.chatSid
}
const chatOnlyMode = computed<boolean>(() => props.forceChatView || props.notebookMode)

/**
 * 侧边栏在工程标题上点「+」新建对话时带过来的工程名（`?project=`）。
 *
 * 对话要等第一条消息才进 store（`ensureSessionWithTitle` 里由
 * `stampSessionProject` 盖戳），在那之前归属只存在于路由上，顶栏胶囊照这个显示。
 * 标签页是 keep-alive 的，所以要求 `?sid=` 对得上，免得别的标签的参数漏进来。
 */
const pendingProjectName = computed<string>(() => {
  const name = typeof route.query.project === 'string' ? route.query.project.trim() : ''
  if (!name) return ''

  const routeSid = typeof route.query.sid === 'string' ? route.query.sid.trim() : ''
  if (routeSid && sid.value && routeSid !== sid.value) return ''
  return name
})

// Watch for chatSid prop changes (critical for keep-alive components)
watch(
  () => props.chatSid,
  (newVal) => {
    if (newVal && newVal !== sid.value) {
      console.log('[Welcome] chatSid prop changed:', newVal)
      sid.value = newVal
    }
  }
)
const isChatMode = computed<boolean>(() => {
  if (props.forceChatView) return true
  const hasLocal = messages.value.length > 0
  const s = chatStore.sessionById(sid.value)
  const hasPreview = !!(s && s.lastMessagePreview && s.lastMessagePreview.length)
  return hasLocal || hasPreview
})
const chatContainerRef = ref<HTMLElement | null>(null)
const chatLogRef = ref<{
  scrollToBottom: (options?: { behavior?: ScrollBehavior }) => void
  stopAutoScroll: () => void
  isNearBottom: () => boolean
  getScrollElement: () => HTMLElement | null
  setUserScrolledAway: (value: boolean) => void
  userHasScrolledAway: { value: boolean }
} | null>(null)
// useScrollToBottom removed as it conflicts with manual scroll logic

const bottomSentinel = ref<HTMLElement | null>(null)

/**
 * 监听用户手动滚动离开底部事件（来自 ChatLog）
 * 更新 atBottom 状态
 */
function handleUserScrolledAway(isAway: boolean) {
  atBottom.value = !isAway
}

/** 输入框是否有待发送图片，用于首帧测量前的高度兜底 */
const hasComposerImages = ref(false)

/**
 * 输入框的真实高度。
 * 长文本、图片预览、@ 提及都会把输入框撑高，写死 130/210px 会让对话区
 * 算出的 max-height 偏大，多出来的部分把 sticky 输入框顶出可视区。
 * 这里实测高度，对话区按实测值收缩，输入框永远贴在窗口底部。
 */
const chatComposerRef = ref<HTMLElement | null>(null)

/**
 * 审批框停靠位的函数 ref。绑在输入框上方那个空 div 上，
 * 应用级的 `SensitiveActionConfirm` 会把内容 Teleport 到这里。
 */
const setApprovalDock = provideApprovalDock()

const composerHeightPx = ref(0)
const composerHeightVar = computed(() => {
  if (composerHeightPx.value > 0) return `${composerHeightPx.value}px`
  return hasComposerImages.value ? '210px' : '130px'
})

let composerResizeObserver: ResizeObserver | null = null

watch(chatComposerRef, (el) => {
  composerResizeObserver?.disconnect()
  composerResizeObserver = null
  if (!el) {
    composerHeightPx.value = 0
    return
  }
  composerHeightPx.value = Math.round(el.getBoundingClientRect().height)
  composerResizeObserver = new ResizeObserver((entries) => {
    const h = entries[0]?.borderBoxSize?.[0]?.blockSize ?? el.getBoundingClientRect().height
    if (h > 0) composerHeightPx.value = Math.round(h)
  })
  composerResizeObserver.observe(el)
})

onBeforeUnmount(() => {
  composerResizeObserver?.disconnect()
  composerResizeObserver = null
})

/** 球体交互：鼠标相对于球体中心的归一化坐标 (-1 到 1) */
const sphereMouseX = ref(0)
const sphereMouseY = ref(0)

/** 球体交互：目标坐标（鼠标实际位置） */
let targetMouseX = 0
let targetMouseY = 0

/** 动画帧ID */
let sphereAnimationId: number | null = null

/**
 * 线性插值函数
 * @param current 当前值
 * @param target 目标值
 * @param factor 插值因子 (0-1)，越小越平滑
 */
function lerp(current: number, target: number, factor: number): number {
  return current + (target - current) * factor
}

/**
 * 球体动画循环
 * 使用阻尼效果平滑过渡到目标位置
 */
function animateSphere(): void {
  // 阻尼系数：0.08 表示每帧移动8%的距离差
  const damping = 0.08

  sphereMouseX.value = lerp(sphereMouseX.value, targetMouseX, damping)
  sphereMouseY.value = lerp(sphereMouseY.value, targetMouseY, damping)

  sphereAnimationId = requestAnimationFrame(animateSphere)
}

/**
 * 处理整个欢迎页面的鼠标移动
 * 只更新目标位置，实际动画由 animateSphere 处理
 */
function handleSphereMouseMove(e: MouseEvent): void {
  const target = e.currentTarget as HTMLElement
  const rect = target.getBoundingClientRect()
  const centerX = rect.left + rect.width / 2
  const centerY = rect.top + rect.height * 0.3

  // 更新目标位置
  targetMouseX = Math.max(-1, Math.min(1, (e.clientX - centerX) / (rect.width / 3)))
  targetMouseY = Math.max(-1, Math.min(1, (e.clientY - centerY) / (rect.height / 4)))
}

const isGenerating = computed<boolean>(() => {
  // 检查方式 1: 消息列表中是否有 typing 状态的消息
  const typingMessages = messages.value.filter(
    (m) => m.role === 'assistant' && m.status === 'typing'
  )
  const hasTypingMessage = typingMessages.length > 0

  // 检查方式 2: agentStreamStore 中是否有流式状态（解决 Tab 切换后状态不同步问题）
  const isStreaming = agentStreamStore.isStreaming(sid.value)

  const result = hasTypingMessage || isStreaming
  return result
})

// 监听 isGenerating 的变化
watch(
  isGenerating,
  (newVal, oldVal) => {
    console.log('[Welcome.vue] isGenerating 变化', {
      from: oldVal,
      to: newVal,
      timestamp: new Date().toISOString()
    })
  },
  { immediate: true }
)

/**
 * 规整对话ID：若为空则生成一个新的ID。
 * @param raw 原始sid字符串
 * @returns 正常化后的sid
 */

/**
 * 推入一条用户消息。
 * @param content 文本内容或多模态内容
 * @param mentionedSources 可选的@提及来源列表
 * @param excelFiles 可选的 Excel 文件列表
 */
function pushUser(
  content: ChatMessageContent,
  mentionedSources?: { id: string; title: string; type: string }[],
  excelFiles?: ExcelFileInfo[]
): void {
  chatMsgStore.pushUser(sid.value, content, mentionedSources, excelFiles)
  scrollToBottomIfNeeded()
}

/**
 * 推入一条助手打字消息。
 * @param startTime 可选的消息开始时间戳
 * @returns 消息ID
 */
function pushAssistantTyping(startTime?: number): string {
  const id = chatMsgStore.pushAssistantTyping(sid.value, startTime)
  scrollToBottomIfNeeded()
  return id
}

/**
 * 处理生成图片事件
 * 实现互斥逻辑：切换到图片生成模式时，自动关闭对话模式
 */
const isImageGenerationMode = ref(false)

/** 使用用户配置的模型生成图片。 */
function handleCreateImage(): void {
  if (chatOnlyMode.value) return
  isImageGenerationMode.value = true
  // 保存到对话
  chatStore.setImageGenerationMode(sid.value, true)
}

function handleCancelImageGeneration(): void {
  isImageGenerationMode.value = false
  chatStore.setImageGenerationMode(sid.value, false)
}

/**
 * 执行一条不带参数的内置命令（见 `components/slashCommands.ts`）。
 *
 * 结果一律用 toast 说清楚，**包括拒绝的情况**：压缩会在对话正跑着、
 * 没有历史、或者压完没变小的时候拒绝，各有各的原因。一律报「失败」
 * 会让用户以为按钮坏了，而实际上内核是对的。
 */
async function handleRunCommand(name: string): Promise<void> {
  if (name === 'image') {
    handleCreateImage()
    return
  }

  if (name !== 'compact') return

  /*
   * 取对话上存着的那份 agentSessionId，**不是**流式状态里的那份：
   * 压缩只在没跑的时候才允许（跑着会和自动压缩抢同一份 transcript），
   * 而那正是流式状态不存在的时候。
   */
  const agentSessionId = chatStore.getAgentSessionId(sid.value)
  if (!agentSessionId) {
    message.info(t('assistantInputComposer.toast.compactFailed.empty'))
    return
  }

  const result = await agentV3API.compact(agentSessionId)

  if (result.success) {
    message.success(
      t('assistantInputComposer.toast.compacted', {
        before: result.messagesBefore,
        after: result.messagesAfter,
        saved: Math.max(0, result.tokensBefore - result.tokensAfter)
      })
    )
    return
  }

  message.info(t(`assistantInputComposer.toast.compactFailed.${result.reason}`))
}

// Agent 思考过程
const currentAgentProcess = ref<AgentProcessItem[]>([])

// ==================== Agent 模式逻辑（使用 composable）====================
const {
  fullConversationHistory,
  askModeRef,
  restoreAgentModeState,
  executeAgent,
  stopAgent,
  steerAgent,
  resumeAgent,
  clearConversationHistory,
  // keep-alive 生命周期支持
  setupAgentListeners,
  cleanupAgentListeners
} = useAgentMode({
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
  libraryContext: computed(() => props.libraryContext)
})

function handleAskModeChange(enabled: boolean): void {
  askModeRef.value = enabled
}

/**
 * 换对话时给它盖上权限档位，只读状态跟着**新的这条**走。
 *
 * 盖章：新对话继承「上一次选的那一档」，盖上之后就归它自己了 ——
 * 之后别的标签页再怎么调，这条都不会跟着变（见 sessionPermissionMode.ts）。
 *
 * 对齐只读：这个组件是复用的，标签页切换只是把 `sid` 换掉，`askModeRef`
 * 还留着上一条对话的值 —— 在 A 里选了只读再切到 B，B 会被悄悄锁成只读，
 * 而它的下拉里明明写着别的档位。
 */
watch(
  sid,
  (currentSid) => {
    askModeRef.value = currentSid ? ensurePermissionMode(currentSid) === 'read-only' : false
  },
  { immediate: true }
)

// ==================== 对话流程逻辑（使用 composable）====================
const { handleSend, respondWithImageGeneration, normalizeSid } = useChatFlow({
  sid,
  chatStore,
  chatMsgStore,
  tabsStore,
  route,
  chatOnlyMode,
  isImageGenerationMode,
  executeAgent,
  scrollToBottom,
  updateContextChips,
  pushUser,
  pushAssistantTyping
})

/**
 * 实时语音是**应用级**的一路（`composables/voiceAssistant.ts`），这个页面只是宿主。
 *
 * 每条对话是一个独立的 keep-alive 页面实例。语音原先由这个组件持有，
 * 切到「语音任务」看一眼过程，新页面的语音状态是空的、旧页面被换掉时还顺手
 * 关了麦克风 —— 用户看到的就是「切一下对话，语音助手没了」。现在球体、字幕、
 * 状态在哪个页面看都是同一份，切对话、切标签页、去别的页面都不断线。
 *
 * 页面借给语音的只剩两件**纯显示**的事：滚到底、更新上下文标签。派活不用它 ——
 * 那走应用级的 `appAgentRunner`，助手页开着没开着都一样。
 */
const voice = useVoiceAssistant()

const voiceHost: VoiceHost = {
  sid: () => sid.value,
  scrollToBottomIfNeeded,
  onUserText: updateContextChips
}

/** 激活时重新登记，销毁时注销 */
let detachVoiceHost: (() => void) | null = attachVoiceHost(voiceHost)

/** 语音连上后立即进入同一套普通对话界面；不再切换到独立的“语音页”。 */
const conversationMode = computed(() => isChatMode.value || voice.active.value)
const voiceStatusText = computed(() =>
  voice.muted.value && voice.active.value
    ? t('assistantInputComposer.voice.muted')
    : t(
        `assistantInputComposer.voice.status.${voice.phase.value === 'idle' ? 'listening' : voice.phase.value}`
      )
)
const showVoiceStatus = computed(
  () => voice.connecting.value || voice.active.value || Boolean(voice.error.value)
)

function openVoiceCall(): void {
  router.push({ name: 'AssistantWelcome', query: { sid: voiceChatSid() } })
}

const voiceBoundTitle = computed(() => {
  if (!voice.active.value && !voice.connecting.value) return ''
  return chatStore.sessionById(voiceChatSid())?.title || t('assistant.chatFlow.unnamedChat')
})
/** 球体此刻的用途：它在说话时点一下就是打断，不说话时提示去配个快捷键 */
const voiceInterruptLabel = computed(() =>
  t(
    voice.canInterruptByVoice.value && !voice.muted.value
      ? 'assistantInputComposer.voice.interruptByVoice'
      : 'assistantInputComposer.voice.interrupt'
  )
)
const voiceInterruptHint = computed(() => t('assistantInputComposer.voice.interruptHint'))

/**
 * 点球体开/关语音。
 *
 * 开的时候**就地绑住眼前这条对话**，不再跳去一条固定的「语音助手」。球体只在
 * 一条消息都没有的对话上出现，所以每次从这儿开口都是一条干净的新对话 ——
 * 用户要再开一段独立的，点「新对话」就行，上一段原样留在侧边栏。
 * 派出去的活仍在「语音任务」那条，用户自己切过去看。
 */
function toggleVoice(): void {
  if (voice.active.value || voice.connecting.value) {
    void voice.stop()
    return
  }
  void startVoiceIn(sid.value)
}

type ComposerSendPayload = Parameters<typeof handleSend>[0] & {
  docFiles?: Array<{ fileName: string; kind?: 'document' | 'video' | 'audio' }>
  inlineDocuments?: Array<{ fileName: string; mimeType: string; base64Data: string }>
}

/**
 * 排着队等下一轮的跟进消息，按 chatSid 分桶。
 *
 * 存在 store 里而不是这个页面里：助手路由没开 `meta.keepAlive`，切去别的标签页
 * 那一刻整棵组件树就卸载了 —— 曾经它是这里的一个 ref，用户排了一句话、去看了眼
 * 别的页面再回来，那句话就没了。理由和 `pendingApprovals` 那个 store 一样，
 * 详见 `store/modules/followUpQueue.ts`。
 *
 * 仍然按 `chatSid` 分桶而不是只存一条：欢迎态下 `sid` 是发送那一刻才定的，
 * 同一个实例前后可以对应两条不同的对话。
 *
 * 这里收窄 payload 的类型：store 按 `unknown` 存（它不解释 payload），
 * 而这一层知道里面装的是什么。
 */
const followUpQueues = storeToRefs(useFollowUpQueueStore()).queues as unknown as Ref<
  FollowUpQueues<ComposerSendPayload>
>

/**
 * 这条消息只有文字吗。
 *
 * 判的是「归不归语音那一路」：语音把打的字当成对话内容，附件它一样也带不走。
 */
function isPlainTextOnly(payload: ComposerSendPayload): boolean {
  return (
    isSteerable(payload) &&
    (payload.images?.length || 0) === 0 &&
    (payload.imageFiles?.length || 0) === 0 &&
    !payload.excelContext &&
    (payload.docFiles?.length || 0) === 0
  )
}

/**
 * 这条排着的消息能不能改成「立即插话」。
 *
 * 插话带得走文字、图、表格、文档和音视频（`agent-v3:steer` 的 `images` / `mediaFiles` /
 * `contextText`），带不走 @ 来源和内嵌 PDF —— 带着它们的那条如果给了按钮，用户点下去
 * 东西会**静悄悄少一半**，所以只能排队等下一轮。
 *
 * 只有附件没有字的也算：那句说明由 `steerAgent` 补。
 */
function isSteerable(payload: ComposerSendPayload): boolean {
  return (
    (payload.content.trim().length > 0 ||
      (payload.images?.length || 0) > 0 ||
      Boolean(payload.excelContext) ||
      (payload.docFiles?.length || 0) > 0) &&
    (payload.forcedSources?.length || 0) === 0 &&
    (payload.inlineDocuments?.length || 0) === 0
  )
}

/** 当前这条对话排着的消息。传给输入框画成一排小标签 */
const queuedFollowUps = computed(() =>
  listFollowUps(followUpQueues.value, sid.value).map((item) => ({
    id: item.id,
    text: item.text,
    canSteer: isSteerable(item.payload),
    canEdit: isTextOnly(item.payload)
  }))
)

/**
 * 排着的这条只有字、没带任何附件 —— 只有这种能退回输入框改。
 * 附件在排队那一刻已经处理成 payload 里的成品，放不回输入框的附件栏，
 * 退回去等于静悄悄丢掉。
 */
function isTextOnly(payload: ComposerSendPayload): boolean {
  return (
    payload.content.trim().length > 0 &&
    (payload.images?.length || 0) === 0 &&
    (payload.imageFiles?.length || 0) === 0 &&
    !payload.excelContext &&
    (payload.excelFiles?.length || 0) === 0 &&
    (payload.docFiles?.length || 0) === 0 &&
    (payload.mediaFiles?.length || 0) === 0 &&
    (payload.forcedSources?.length || 0) === 0 &&
    (payload.inlineDocuments?.length || 0) === 0
  )
}

function handleCancelQueuedFollowUp(id: string): void {
  followUpQueues.value = removeFollowUp(followUpQueues.value, sid.value, id)
}

/**
 * 「这条别等了，现在就插进去」。
 *
 * 排队是默认档，但用户排上之后随时可能改主意 —— 他看着 agent 正往错的方向
 * 跑，这时候「等你跑完」正是他不想要的。没有这条出路的话，他只能取消掉
 * 那个标签、再把同一句话重打一遍。
 *
 * 插成功了才把它从队列里摘掉：这一轮刚好收尾时插话会失败（内核那边已经没有
 * 在跑的轮次了），先摘的话用户点了一下，话就没了，而他只看到一个转瞬即逝的
 * 失败提示。失败就留在原地，他可以再点、也可以就让它排着。
 */
async function handleSteerQueuedFollowUp(id: string): Promise<void> {
  // 插话要等主进程传完附件，可能好几秒；这期间用户切走了，`sid` 就变了 ——
  // 摘条目得按点的那一刻所在的对话摘，不然摘不掉，之后又当新一轮发一遍
  const chatSid = sid.value
  const item = findFollowUp(followUpQueues.value, chatSid, id)
  if (!item) return

  /*
   * 三种情况，不是两种。
   *
   * 中间那一档是「界面停了、后台还没放」：`isGenerating` 那时已经是 false，
   * 但主进程还没走完收尾，这时候当新一轮发出去会被顶回来一个 `SESSION_BUSY`，
   * 而条目已经从队列里摘掉了 —— 用户点了一下，话就没了。
   */
  if (agentStreamStore.isBusy(chatSid)) {
    if (isGenerating.value) {
      /*
       * 真的在跑：插进去。带上**入队那一刻**的快照，不是现在的。
       *
       * 工程对不上时主进程会整条拒绝（比如这条是在另一个工程上排的），
       * `steerAgent` 返回 false，条目留在队列里 —— 之后按它自己钉住的工程发出去。
       */
      const queued = item.payload
      const files = bubbleAttachments(queued.excelFiles, queued.docFiles)
      const attachments: SteerAttachments | undefined = files
        ? {
            files,
            ...(queued.mediaFiles?.length ? { mediaFiles: queued.mediaFiles } : {}),
            ...(queued.excelContext ? { contextText: queued.excelContext } : {})
          }
        : undefined
      // 用 payload 里用户真打的字，不是 `item.text` —— 那是队列标签上显示的那行，
      // 纯附件的条目是「（附件）」，传进去 steerAgent 就补不上那句「补充附件：…」了
      const runningSessionId = chatStore.getAgentSessionId?.(chatSid) || undefined
      if (
        !(await steerAgent(queued.content, {
          editorSnapshot: queued.editorSnapshot,
          images: queued.images,
          attachments,
          targetSessionId: runningSessionId,
          ifRejected: 'queued'
        }))
      ) {
        return
      }
      followUpQueues.value = removeFollowUp(followUpQueues.value, chatSid, id)
    }
    // 等释放中：什么都不做，留在队列里。`released` 一到自然会投递
    return
  }

  // 已经彻底空出来了：直接作为新一轮发出去 —— 用户要的是「现在就办」，现在正好办得了。
  // 负载里已经有 editorSnapshot 键，`handleSend` 会原样用，**不重抓**
  followUpQueues.value = removeFollowUp(followUpQueues.value, chatSid, id)
  void handleSend(item.payload)
}

/*
 * 「这条对话空出来了，把排着的下一条发出去」——那段逻辑不在这里了。
 *
 * 它原本是这个页面在监听 `agent-v3:released` 自己判自己发，而助手路由没开
 * keepAlive：用户切去别的页面那一刻监听器就没了，跑完的话没人接。现在归
 * `followUpDelivery`（挂在常驻布局上）管，页面只负责把话排进队列、以及显示
 * 排着的是哪几条。
 */

/**
 * 每条对话一条**提交链**，保证「先点的先发」。
 *
 * 闪存抓取是异步的（最多 2 秒），而每次点击都各自立刻发起自己的抓取 —— 不排队等
 * 前一条抓完，否则第二条的快照就偏离了它自己的发送时刻，闪存的意义就没了。
 * 但抓取有快有慢：A 先点、A 的抓取要 2 秒，B 后点、B 的 100 毫秒就回来了 ——
 * 不串行的话 B 会插到 A 前面，模型看到的顺序和用户说话的顺序就反了。
 *
 * 所以：**抓取并发，投递串行**。
 */
const submitChains = new Map<string, Promise<void>>()

function enqueueSubmit(chatSid: string, task: () => Promise<void>): void {
  const previous = submitChains.get(chatSid) ?? Promise.resolve()
  // 前一条失败不能卡死整条链，所以 catch 掉再接下一棒
  const next = previous.then(task, task)
  submitChains.set(chatSid, next)
  void next.catch((error) => console.error('[Assistant] 提交链出错:', error))
}

function handleComposerSend(payload: ComposerSendPayload): void {
  const plainTextOnly = isPlainTextOnly(payload)

  // 语音是应用级的一路：只有正对着**这次通话绑的那条**对话时，打的字才归它。
  // 在别的对话里打字仍然是普通发送 —— 用户在「语音任务」里补一句，不是在跟语音聊。
  // 这一条判在排队之前：语音那边本来就有自己的排活机制（taskBus），
  // 再攒一层等于同一句话有两个地方在等它
  if (voice.active.value && plainTextOnly && sid.value === voiceChatSid()) {
    voice.sendText(payload.content)
    return
  }

  /*
   * 对话 id 在**这一刻**定下来，后面全用它。
   *
   * 下面要 await 抓取，那期间用户完全可能切到别的对话去 —— 再读 `sid.value`
   * 就把这条话发到别人那里了。
   */
  const chatSid = sid.value

  /*
   * 闪存**立刻**开抓，不 await。
   *
   * 这是整个机制的落点：用户按下发送的那一刻，他眼前是什么就抓什么。晚一秒
   * 抓到的就可能是另一个选区，而那正是闪存要消灭的东西。
   *
   * 对话正在跑时要带上它的内核 session id：这条消息最终落在那一轮或紧接着的下一轮，
   * 得跟着那一轮盯的工程抓，不能自己按对话戳重算。
   */
  /*
   * 工程归属要**按用户指定的那个**算，不能只读对话戳。
   *
   * 从侧边栏工程 A 的「+」新建对话时，归属这时候还只在路由参数上
   * （`?project=`）—— 对话要等第一条消息发出去才进 store 盖戳（见
   * `chatSendPrimitives` 的 `stampSessionProject`）。只读戳的话这里拿到 null，
   * 于是按「当前连接」抓，抓到的是碰巧连着的 B，还把这一轮钉死在 B 上；
   * 稍后对话才被归入 A。用户从 A 下面点的「+」，第一句话却在 B 上执行。
   */
  const sessionProject =
    chatStore.getProject?.(chatSid) ??
    (pendingProjectName.value
      ? {
          projectName: pendingProjectName.value,
          ...(typeof route.query.projectPath === 'string' && route.query.projectPath.trim()
            ? { projectPath: route.query.projectPath.trim() }
            : {})
        }
      : null)

  const capture = agentV3API.captureEditorSnapshot({
    sessionProject,
    ...(agentStreamStore.isBusy(chatSid)
      ? { runningSessionId: chatStore.getAgentSessionId?.(chatSid) || undefined }
      : {})
  })

  enqueueSubmit(chatSid, async () => {
    const captured = await capture
    const withSnapshot: ComposerSendPayload = {
      ...payload,
      editorSnapshot: captured.ok ? captured.snapshot : null,
      // 快照来自哪个工程，这条消息就钉在哪个工程上 —— 排队期间别的工程连上也不改
      ...(captured.ok
        ? {
            sessionProject: {
              projectName: captured.snapshot.project.projectName,
              ...(captured.snapshot.project.projectPath
                ? { projectPath: captured.snapshot.project.projectPath }
                : {})
            }
          }
        : {})
    }

    /*
     * 抓完**重新判**一次忙不忙 —— 这两秒里那一轮可能已经跑完了。
     *
     * 判定到入队/发送之间没有 await，`isBusy` 是同步读的，所以中间没有窗口。
     * 用 `isBusy` 而不是 `isGenerating`：界面停止输出（`done`）之后、主进程发
     * `released` 之前，内核 session 其实还没空出来，这时候发出去会被顶回来。
     *
     * 跑着的时候来的 send 一律排队 —— 输入框那边已经按用户的设置判过了，
     * 想插话的话它发的是 `steer` 事件，走不到这里。
     */
    if (agentStreamStore.isBusy(chatSid)) {
      const preview = payload.content.trim()
      const { queues } = enqueueFollowUp(
        followUpQueues.value,
        chatSid,
        preview || t('assistantInputComposer.queueUntitled'),
        withSnapshot
      )
      followUpQueues.value = queues
      return
    }

    await handleSend(withSnapshot)
  })
}

watch(
  [chatOnlyMode, sid],
  ([forcedChatOnly, currentSid]) => {
    if (!forcedChatOnly) return

    restoreAgentModeState(false)
    askModeRef.value = false
    isImageGenerationMode.value = false
    if (currentSid) {
      chatStore.setAgentMode(currentSid, false)
      chatStore.setImageGenerationMode(currentSid, false)
      if (props.notebookMode) {
        chatStore.clearBoundNotebook(currentSid)
      }
    }
  },
  { immediate: true }
)

// Notebook 模式下的来源点击处理
const onSourceClick = inject<((source: unknown) => void) | null>('onSourceClick', null)
const handleSourceClick = (source: unknown): void => {
  if (onSourceClick) {
    onSourceClick(source)
  }
}

// 监听路由参数中的 autoPrompt

/**
 * 页面挂载时初始化：
 * - 读取路由查询参数中的 sid 与 q
 * - 保证对话存在
 * - 若存在初始问题 q，则进入对话模式并追加消息
 */
onMounted(() => {
  // 优先使用 props.chatSid (如果存在)，否则从 URL query 读取
  sid.value = normalizeSid(props.chatSid || String(route.query.sid || ''))

  // 助手永远是 Agent。
  //
  // 这里原来读对话里存的 agentMode 和全局偏好 lastAgentMode —— 那两个都是
  // Chat/Agent 下拉框写下的，而下拉框已经删了。继续读的话，存量用户磁盘上
  // 那个 false 会把他永久钉在老链路上，界面上再没有任何开关能把他弄出来。
  //
  // 知识库问答（chatOnlyMode）是另一件事：它有自己的问答链路，不在这里换。
  const session = chatStore.sessionById(sid.value)
  let modeToRestore = !chatOnlyMode.value

  // 只读状态由上面那个 watch 按 sid 对齐 —— 它是这条对话权限档位的派生状态，
  // 不再是一个全局开关（存量用户磁盘上那个 lastAgentMode/lastAskMode 一律不读）

  // 恢复生图模式状态
  if (session && !chatOnlyMode.value) {
    isImageGenerationMode.value = chatStore.getImageGenerationMode(sid.value)
  } else {
    // Chat-only sessions should not restore generation modes.
    isImageGenerationMode.value = false
  }

  // 生图模式优先级高于代理模式：检测到生成模式就不恢复代理模式
  const finalModeToRestore = isImageGenerationMode.value ? false : modeToRestore

  restoreAgentModeState(finalModeToRestore)

  // 确保模式互斥：如果恢复为Agent模式，关闭其他模式
  if (finalModeToRestore) {
    isImageGenerationMode.value = false
    chatStore.setImageGenerationMode(sid.value, false)
  }

  // 只有当前路由是AI助手页面时才更新标签标题
  const isAssistantRoute =
    route.path === '/dev-assistant' || route.path.startsWith('/dev-assistant/')
  if (isAssistantRoute) {
    tabsStore.updateTabTitleByPath(
      route.fullPath,
      chatStore.sessionById(sid.value)?.title || t('assistant.chatFlow.unnamedChat')
    )
  }
  // 支持两种初始消息参数：q（原有）和 initialMessage（来自 Spotlight）
  const initial = String(route.query.q || route.query.initialMessage || '').trim()
  if (initial) {
    chatStore.ensureSession(sid.value, t('assistant.chatFlow.unnamedChat'))
    chatStore.appendMessage(sid.value, initial)
    pushUser(initial) // 显示用户消息气泡
    executeAgent(initial)
    // 有初始问题时，强制滚动到底部
    nextTick(() => {
      scrollToBottom()
    })
  } else {
    // 没有初始问题（查看历史），暂停自动滚动以防止进入时跳到底部
    pauseAutoScroll(1000)
  }
  observeBottom()
  bindScrollObserver()

  window.addEventListener('resize', checkCanScroll)
  nextTick(() => {
    checkCanScroll()
  })

  // 启动球体平滑动画
  animateSphere()
})

/**
 * 组件卸载前清理Agent监听器和定时器
 */
onBeforeUnmount(() => {
  // Agent 监听器清理已在 useAgentMode 中处理
  // 清理滚动防抖计时器
  if (scrollIfNeededTimer) {
    clearTimeout(scrollIfNeededTimer)
    scrollIfNeededTimer = null
  }
  if (removeScrollObserver) {
    removeScrollObserver()
    removeScrollObserver = null
  }
  // 清理球体动画
  if (sphereAnimationId) {
    cancelAnimationFrame(sphereAnimationId)
    sphereAnimationId = null
  }
  window.removeEventListener('resize', checkCanScroll)
  // 只注销宿主，**不停语音** —— 那一路是应用级的，见 voiceAssistant.ts
  detachVoiceHost?.()
  detachVoiceHost = null
})

/**
 * keep-alive 组件激活时重新注册 Agent 监听器
 * 解决页面切换后 UI 不更新的问题
 */
onActivated(() => {
  console.log('[Welcome.vue] 组件激活 (onActivated)')
  // 重新登记成「最近激活」的宿主：语音派活借的是它
  detachVoiceHost = attachVoiceHost(voiceHost)
  console.log('[Welcome.vue] onActivated - sid.value:', sid.value)
  console.log('[Welcome.vue] onActivated - route.query.sid:', route.query.sid)
  console.log('[Welcome.vue] onActivated - route.fullPath:', route.fullPath)
  console.log('[Welcome.vue] onActivated - messages.length:', messages.value.length)
  console.log(
    '[Welcome.vue] onActivated - messages:',
    messages.value.map((m) => ({ id: m.id, role: m.role, status: m.status }))
  )

  setupAgentListeners()
  // 重新绑定滚动观察器
  observeBottom()
  bindScrollObserver()
  window.addEventListener('resize', checkCanScroll)
  nextTick(() => {
    checkCanScroll()
  })
})

/**
 * keep-alive 组件失活时清理 Agent 监听器
 * 避免监听器累积导致内存泄漏
 */
onDeactivated(() => {
  console.log('[Welcome.vue] 组件失活 (onDeactivated)，清理 Agent 监听器')
  /*
   * **不停语音，也不注销宿主。**
   *
   * 这里原本会 `voice.stop()`，于是切一下标签页通话就断了。但通话不是
   * 哪个页面的附属品：整套前台/后厨的设计（任务表搬进主进程、
   * 界面切走照样播报）就是为了让任务跑着的时候用户能去干别的。
   * 切走就挂断，等于把这套东西的意义抹掉了。
   *
   * 现在那一路语音是应用级的（`composables/voiceAssistant.ts`），这个页面
   * 销毁了它也不停。宿主也留着：失活的页面照样能替语音发起运行，
   * 用户切去资产库时活着的宿主可能全是失活的。
   */
  cleanupAgentListeners()
  // 清理滚动相关资源
  if (scrollIfNeededTimer) {
    clearTimeout(scrollIfNeededTimer)
    scrollIfNeededTimer = null
  }
  if (removeScrollObserver) {
    removeScrollObserver()
    removeScrollObserver = null
  }
  window.removeEventListener('resize', checkCanScroll)
})

/**
 * 监听当前对话标题变化并同步到标签标题。
 */
watch(
  () => chatStore.sessionById(sid.value)?.title,
  (newTitle) => {
    const t = String(newTitle || '').trim()
    // 只有当前路由是AI助手页面时才更新标签标题
    const isAssistantRoute =
      route.path === '/dev-assistant' || route.path.startsWith('/dev-assistant/')
    if (t && isAssistantRoute) {
      tabsStore.updateTabTitleByPath(route.fullPath, t)
    }
  }
)

/**
 * 监听对话ID变化，恢复对应对话的Agent模式状态
 */
/**
 * 恢复指定对话的模式状态和滚动位置
 */
const restoreSessionState = (targetSid: string): void => {
  // 注意：不取消SSE流，让它在后台继续运行
  // 流回调使用捕获的 currentSid 正确写入对应对话的消息列表
  // 用户切回该Tab时会自动看到已完成的内容

  // 保存当前对话的滚动位置（在切换之前）
  const currentSidValue = sid.value
  const scrollEl = chatLogRef.value?.getScrollElement()
  if (scrollEl && currentSidValue && currentSidValue !== targetSid) {
    scrollPositionCache.set(currentSidValue, scrollEl.scrollTop)
  }

  // 同上：助手永远是 Agent，磁盘上存的 agentMode / lastAgentMode 不再参与
  const session = chatStore.sessionById(targetSid)
  const modeToRestore = !chatOnlyMode.value

  // 恢复生图模式状态
  if (session && !chatOnlyMode.value) {
    isImageGenerationMode.value = chatStore.getImageGenerationMode(targetSid)
  } else {
    isImageGenerationMode.value = false
  }

  const finalModeToRestore = isImageGenerationMode.value ? false : modeToRestore

  restoreAgentModeState(finalModeToRestore)

  if (finalModeToRestore) {
    isImageGenerationMode.value = false
    chatStore.setImageGenerationMode(targetSid, false)
  }

  // 恢复目标对话的滚动位置（切换对话后）
  nextTick(() => {
    const targetScrollEl = chatLogRef.value?.getScrollElement()
    if (!targetScrollEl) return

    const cachedPosition = scrollPositionCache.get(targetSid)
    if (cachedPosition !== undefined && cachedPosition > 0) {
      // 有缓存的滚动位置，先让虚拟滚动器渲染内容
      if (chatLogRef.value && typeof (chatLogRef.value as any).scrollToItem === 'function') {
        const estimatedIndex = Math.floor(cachedPosition / 100)
        const targetIndex = Math.min(estimatedIndex, messages.value.length - 1)
        if (targetIndex > 0) {
          try {
            ;(chatLogRef.value as any).scrollToItem(targetIndex)
          } catch (e) {
            console.warn('[对话切换] scrollToItem 失败:', e)
          }
        }
      }
      // 延迟后精确恢复滚动位置
      setTimeout(() => {
        const el = chatLogRef.value?.getScrollElement()
        if (el) {
          el.scrollTop = cachedPosition
          atBottom.value = chatLogRef.value ? chatLogRef.value.isNearBottom() : false
        }
      }, 100)
    } else {
      // 没有缓存位置，默认滚动到底部（聊天应用的正常用户预期）
      scrollToBottom()
    }
  })
}

/**
 * 监听对话ID变化(URL)，恢复对应对话的Agent模式状态
 */
watch(
  () => route.query.sid,
  (newSid) => {
    // 如果有 props.chatSid，则忽略 URL 的 sid 变化
    if (props.chatSid) return

    const normalizedSid = normalizeSid(String(newSid || ''))
    const currentSid = sid.value

    if (normalizedSid && normalizedSid !== currentSid) {
      sid.value = normalizedSid
      restoreSessionState(normalizedSid)
    }
  },
  { immediate: false }
)

/**
 * 监听 Props chatSid 变化 (如 Notebook 切换)
 */
watch(
  () => props.chatSid,
  (newSid) => {
    if (newSid && newSid !== sid.value) {
      sid.value = newSid
      restoreSessionState(newSid)
    }
  },
  { immediate: true }
)

/**
 * 监听图片生成模式变化并同步到对话存储
 */
watch(isImageGenerationMode, (newValue) => {
  if (sid.value) {
    console.log('[图片生成模式] 状态变化，保存到对话:', newValue)
    chatStore.setImageGenerationMode(sid.value, newValue)
  }
})

/**
 * 处理建议卡片点击：在本页直接进入对话模式并发送消息。
 * 使用 prompt 字段作为发送内容，如果没有则回退到 title
 * @param item 建议项
 */
function handleSuggestionClick(item: SuggestionItem): void {
  const q = String(item.prompt || item.title || '').trim()
  if (!q) return
  handleSend({ content: q, images: [] })
}

/**
 */
function extractTextFromContent(content: ChatMessageContent): string {
  if (typeof content === 'string') {
    return content
  }
  return content
    .filter((item) => item.type === 'text' && item.text)
    .map((item) => item.text)
    .join('\n')
}

/**
 * 确保对话存在并在首次发送消息时设置标题
 * @param chatSid 对话ID
 * @param messageText 消息文本
 */

/**
 * 处理输入区的发送事件：在本页直接进入对话模式并发送消息。
 * @param payload 包含文本和图片的发送内容
 */

/**
 * 生成智能的对话标题
 * 优先级：有文本 > 工具使用 > 已发送图片
 * @param text 用户输入的文本
 * @param images 图片数组
 * @param isImageGenMode 是否是图片生成模式
 * @returns 用于显示的标题文本
 */

/**
 * 处理附件入口点击事件（占位）。
 */
function handleAttach(): void {
  console.log('Attach clicked')
}

/**
 * 处理语音入口点击事件（占位）。
 */
/**
 * 处理生成图片事件。
 * 设置标志，下次用户发送消息时将作为图片生成的prompt
 */

/**
 * 处理搜索网页事件（占位）。
 */
function handleSearchWeb(): void {
  message.info(t('assistant.search.notImplemented'))
}

function handleBindWiki(value: BoundNotebook): void {
  if (props.notebookMode) return

  const targetSid = normalizeSid(sid.value)
  if (targetSid !== sid.value) {
    sid.value = targetSid
  }

  chatStore.ensureSession(targetSid, t('assistant.chatFlow.unnamedChat'))
  chatStore.setBoundNotebook(targetSid, value)
  message.success(t('actionToast.notebook.bound', { title: value.title }))
}

function handleClearBoundWiki(): void {
  if (props.notebookMode) return
  if (!sid.value) return
  chatStore.clearBoundNotebook(sid.value)
  message.success(t('actionToast.notebook.unbound'))
}

/**
 * 处理输入框图片变化事件
 * 用于动态调整对话区域高度，防止滚动到底部按钮被图片预览遮挡
 * @param hasImages 是否有待发送图片
 */
function handleComposerImagesChange(hasImages: boolean): void {
  hasComposerImages.value = hasImages
}

/**
 * 恢复Agent模式状态（用于对话切换时）
 */

/**
 * 使用真实AI API生成图片，并替换"打字中"占位。
 * @param prompt 图片描述
 * @param typingId 占位消息ID
 */

/**
 * 基于实际时间获取状态文本（用于显示刷新）
 * @param status 任务状态
 * @param startTime 任务开始时间（毫秒）
 */

/**
 * 判断消息是否是图片生成消息。
 * 如果消息内容主要是图片Markdown格式（![...](...)），则认为是图片生成。
 * @param content 消息内容
 * @returns 是否是图片生成消息
 */
function isImageGenerationMessage(content: string): boolean {
  const text = String(content || '').trim()
  if (!text) return false

  // 匹配Markdown图片格式：![alt](url)
  const imagePattern = /!\[([^\]]*)\]\(([^)]+)\)/g
  const imageMatches = text.match(imagePattern) || []

  // 移除所有图片标记后，检查剩余文本
  const textWithoutImages = text.replace(imagePattern, '').trim()

  // 如果内容主要是图片（图片标记数量 > 0 且剩余文本很少），则认为是图片生成
  return imageMatches.length > 0 && textWithoutImages.length < 50
}

/**
 * 重发之前先把跑着的那一轮停干净。
 *
 * 「重新生成」和「编辑消息」都是**开新一轮**，而一条对话同时只能跑一轮 ——
 * 用户在它思考的时候改了自己那句话点发送，界面照发不误，主进程只能顶回来
 * 一个 `SESSION_BUSY`：屏幕上多一条红字，他刚敲的那段话没了。
 *
 * 停不干净（卡在审批框、工具没退出）就别发，如实说一声让他稍后再试 ——
 * 硬发下去撞到的还是那句话，只是这次是我们自己撞上去的。
 */
async function ensureIdleBeforeResend(): Promise<boolean> {
  if (!isGenerating.value) return true

  if (await stopAgent()) return true

  message.warning(t('assistant.chat.stopBeforeResendFailed'))
  return false
}

/**
 * 处理气泡重新生成事件：
 * - 找到当前AI回复对应的用户提问
 * - 删除当前AI回复及之后的所有消息
 * - 保留用户提问之前的所有历史对话
 * - 基于保留的历史重新生成AI回复
 * @param payload 气泡信息
 */
async function handleBubbleRetry(payload: { id: string; content: string }): Promise<void> {
  // 先停干净再重来。放在删消息之前：停不下来时这一步要能原样退出
  if (!(await ensureIdleBeforeResend())) return

  // 找到当前消息的索引
  const msgIndex = messages.value.findIndex((m) => m.id === payload.id)
  if (msgIndex < 0) {
    message.error(t('assistant.chat.messageNotFound'))
    return
  }

  const currentMsg = messages.value[msgIndex]
  if (currentMsg.role !== 'assistant') {
    message.error(t('assistant.chat.onlyRetryAI'))
    return
  }

  // 向前查找对应的用户消息
  let userMsgIndex = -1
  for (let i = msgIndex - 1; i >= 0; i--) {
    if (messages.value[i].role === 'user') {
      userMsgIndex = i
      break
    }
  }

  if (userMsgIndex < 0) {
    message.error(t('assistant.chat.userMessageNotFound'))
    return
  }

  const userMsg = messages.value[userMsgIndex]
  const userText = extractTextFromContent(userMsg.content)

  // 判断是否是图片生成消息
  const base = String(payload.content || '').trim()
  const isImageGen = isImageGenerationMessage(base)

  // 删除当前AI消息及之后的所有消息。
  // 这个 store 就是历史本身，删到这里就够了 —— 原来还要再删一次后端 SQLite，
  // 那份副本连同它的读取路径已经一起移除。
  chatMsgStore.deleteMessagesFromIndex(sid.value, msgIndex)

  // 生图模式重画一张；其余一律交给 Agent
  if (isImageGen) {
    const typingId = pushAssistantTyping()
    respondWithImageGeneration(userText, typingId)
  } else {
    // 更新 fullConversationHistory：只保留到用户消息（不包括被删除的AI回复）
    // 构建新的历史到用户消息位置，保留完整的消息内容（包括图片）
    const newHistory: any[] = []
    for (let i = 0; i <= userMsgIndex; i++) {
      const msg = messages.value[i]
      if (msg.role === 'user') {
        newHistory.push({
          role: 'user',
          content: msg.content // 保留完整内容，包括图片
        })
      } else if (msg.role === 'assistant') {
        newHistory.push({
          role: 'assistant',
          content: extractTextFromContent(msg.content) // 助手消息只保留文本
        })
      }
    }
    fullConversationHistory.value = newHistory

    // 保存状态
    chatStore.setAgentHistory(sid.value, fullConversationHistory.value)

    // 内核那份历史也得倒回去。只删气泡的话，模型看着自己刚被丢掉的答案
    // 再答一遍同一个问题 —— 用户以为是重来，对它而言是追问。
    await rewindTranscript(
      chatStore.getAgentSessionId(sid.value),
      countUserTurnsBefore(messages.value, userMsgIndex),
      agentV3API.truncateSession
    )

    // 重新执行Agent，使用完整的用户消息内容（包括图片）
    executeAgent(userMsg.content, undefined, { isRetry: true })
  }

  // 发送消息后立即滚动到底部
  nextTick(() => {
    scrollToBottom()
    stickToBottomFor(1800)
  })
}

/**
 * 处理每条回复下的"继续提问推荐"点击。
 * @param payload 建议文本
 */
function handleBubbleSuggest(payload: { id: string; text: string }): void {
  const q = String(payload.text || '').trim()
  if (!q) return
  chatStore.ensureSession(sid.value || normalizeSid(''), t('assistant.chatFlow.unnamedChat'))

  // 重置用户滚动状态，确保后续生成内容能自动滚动到底部
  if (chatLogRef.value?.setUserScrolledAway) {
    chatLogRef.value.setUserScrolledAway(false)
  }

  handleSend({ content: q, images: [] })

  // 强制滚动到底部并保持贴底
  nextTick(() => {
    scrollToBottom()
    stickToBottomFor(1800)
  })
}

/**
 * 停止当前这一轮。助手只剩 Agent 一条路，停的就是它。
 *
 * 排着的跟进消息一并清掉：按停止是「我不要这个结果了」，紧接着把排着的话
 * 自动发出去等于无视用户刚按的那一下 —— 他会看到自己按了停止，agent 却
 * 立刻又开始干活。
 *
 * 先清队列再停：停下来会让主进程发 `released`，而接那条的
 * `followUpDelivery` 只看队列里还有没有货。反过来写就会正好赶在清空前投递出去。
 */
function stopAgentAndDropQueue(): void {
  followUpQueues.value = clearFollowUps(followUpQueues.value, sid.value)
  stopAgent()
}

function handleBubbleStop(): void {
  stopAgentAndDropQueue()
}

/**
 * 从输入区停止生成（找到正在生成的消息并停止）。
 */
/**
 * 输入框的停止键。
 *
 * 语音通话时它回话的那段字幕也是「正在输入」，停止键就跟着亮了 —— 可它原来只会停
 * Agent，没有 Agent 在跑就什么都不做，用户点了没反应（真机 2026-10-14）。
 * 所以：这条对话有 Agent 在跑就停 Agent；没有、而通话正绑在这条对话上，就是叫它别说了，
 * 和点球体一样。
 */
function handleComposerStop(): void {
  if (
    !agentStreamStore.isStreaming(sid.value) &&
    voice.active.value &&
    sid.value === voiceChatSid()
  ) {
    voice.interrupt()
    return
  }
  stopAgentAndDropQueue()
}

/**
 * 运行中插话改方向。
 *
 * 取代了原来那个「点 token 图标手动压缩历史」——那条路是 V2 的：它压的是
 * 界面自己那份对话记录（和模型真正看到的上下文是两回事），而且**要求登录**，
 * 社区版不该有账号门槛（AGENTS.md §1）。V3 内核自己会在快溢出时压缩，
 * 用不着用户点。
 */
async function handleComposerSteer(payload: {
  text: string
  images: string[]
  attachments?: SteerAttachments
  /** 插话没成（这一轮刚好收尾、工程对不上……）时把摘走的字和附件放回输入框 */
  restore?: () => void
}): Promise<void> {
  // 等闪存那一两秒里用户可能切了对话 —— 插进哪一轮在开始等之前就定下来
  const runningSessionId = chatStore.getAgentSessionId?.(sid.value) || undefined
  /*
   * 插话也是一次「发送」，闪存同样在这一刻抓。
   *
   * 带 `runningSessionId`：插话注入的是正在跑的那一轮，快照必须来自它盯着的
   * 那个工程 —— 自己按对话戳重算的话，没盖戳的对话会跟着「最近连上的」走，
   * 抓到的可能是另一个工程的编辑器。
   */
  const captured = await agentV3API.captureEditorSnapshot({
    sessionProject: chatStore.getProject?.(sid.value) ?? null,
    runningSessionId
  })
  const steered = await steerAgent(payload.text, {
    editorSnapshot: captured.ok ? captured.snapshot : null,
    images: payload.images,
    attachments: payload.attachments,
    targetSessionId: runningSessionId,
    ifRejected: 'restored',
    restoreDraft: payload.restore
  })
  // 没插进去：用户打的字和附件不能就这么没了（输入框为了不卡手，发出时先摘掉了）
  if (!steered) payload.restore?.()
}

/** 消息气泡上的操作按钮：报错后的「接着跑」、审查之后的「让它自证」「交给 AI 修」 */
async function handleBubbleAction(payload: {
  id: string
  action: string
  data?: { sessionId?: string } & Partial<SelfCheckInput>
}): Promise<void> {
  if (payload.action === SELF_CHECK_ACTION) {
    handleSelfCheck(payload.id, payload.data)
    return
  }

  if (payload.action === REVIEW_FIX_ACTION) {
    // 走输入框那条路：这一轮还在跑（用户已经发了下一句）就排队，不能直接开第二轮
    handleComposerSend({
      content: buildReviewFixPrompt(payload.data?.findings ?? [], t),
      images: []
    })
    return
  }

  if (payload.action !== AGENT_RESUME_ACTION) return
  const sessionId = payload.data?.sessionId
  if (!sessionId) return
  // 只摘按钮，不删消息 —— 这条气泡装着报错那一轮的全部过程日志，
  // 删了的话屏幕上会像是任务从头开始了
  chatMsgStore.clearActionButtons(sid.value, payload.id)
  await resumeAgent(sessionId)
}

/**
 * 让它自证：把机器的审查结论拼成一句话，作为**普通用户消息**发进当前对话。
 *
 * 不偷偷发的原因：以后翻这段对话，会看到一段没头没尾的自我检讨，没人知道
 * 它在回应什么。发成一条看得见的消息，问和答就都留在记录里了。
 *
 * 拼话要用户最初那句要求 —— 自证要对照的是「我要的是什么」，而那句话在
 * 消息列表里，气泡自己看不见，所以这一步在页面这层做。
 */
function handleSelfCheck(bubbleId: string, data?: Partial<SelfCheckInput>): void {
  const prompt = buildSelfCheckPrompt(
    {
      findings: data?.findings ?? [],
      checked: data?.checked ?? 0,
      engineChecked: data?.engineChecked === true,
      request: findRequestBefore(chatMsgStore.getMessages(sid.value), bubbleId)
    },
    t
  )

  // 同「交给 AI 修」：对话忙着就排队
  handleComposerSend({ content: prompt, images: [] })
}

/**
 * 复制气泡内容到剪贴板。
 */
function handleBubbleCopy(payload: { id: string; content: string }): void {
  const text = String(payload.content || '')
  if (navigator.clipboard) {
    navigator.clipboard
      .writeText(text)
      .then(() => {
        message.success(t('common.copied'))
      })
      .catch(() => {
        message.error(t('common.copyFailed'))
      })
  } else {
    // 降级方案：使用传统方法
    const textArea = document.createElement('textarea')
    textArea.value = text
    textArea.style.position = 'fixed'
    textArea.style.opacity = '0'
    document.body.appendChild(textArea)
    textArea.select()
    try {
      document.execCommand('copy')
      message.success(t('common.copied'))
    } catch {
      message.error(t('common.copyFailed'))
    }
    document.body.removeChild(textArea)
  }
}

/**
 * 复制用户气泡内容到剪贴板（复用 handleBubbleCopy 的逻辑）。
 */
function handleUserBubbleCopy(payload: { id: string; content: string }): void {
  handleBubbleCopy(payload)
}

/**
 * 处理用户消息编辑确认事件：删除原消息及其后续消息，使用新内容重新发送
 */
async function handleUserConfirmEdit(payload: {
  id: string
  newContent: string
  originalContent: ChatMessageContent
}): Promise<void> {
  const { id: messageId, newContent, originalContent } = payload

  // 同 handleBubbleRetry：编辑后重发也是开新一轮，先把旧的那轮停干净
  if (!(await ensureIdleBeforeResend())) return

  // 找到当前用户消息的索引
  const msgIndex = messages.value.findIndex((m) => m.id === messageId)
  if (msgIndex < 0) {
    message.error(t('assistant.chat.messageNotFound'))
    return
  }

  const currentMsg = messages.value[msgIndex]
  if (currentMsg.role !== 'user') {
    message.error(t('assistant.chat.onlyEditUserMessage'))
    return
  }

  // 保留原消息的@提及来源（如果有）
  const originalMentionedSources = currentMsg.mentionedSources

  // 保留原消息的图片（如果有）
  let newMessageContent: ChatMessageContent
  if (typeof originalContent === 'string') {
    // 原来是纯文本，直接使用新文本
    newMessageContent = newContent
  } else {
    // 原来是多模态内容，保留图片，更新文本
    const imageItems = originalContent.filter((item) => item.type === 'image_url')
    if (imageItems.length > 0) {
      newMessageContent = [{ type: 'text', text: newContent }, ...imageItems]
    } else {
      newMessageContent = newContent
    }
  }

  // 删除当前用户消息及之后的所有消息
  chatMsgStore.deleteMessagesFromIndex(sid.value, msgIndex)

  {
    // 更新 fullConversationHistory：只保留到该消息之前的历史
    const newHistory: { role: string; content: ChatMessageContent | string }[] = []
    for (let i = 0; i < msgIndex; i++) {
      const msg = messages.value[i]
      if (msg.role === 'user') {
        newHistory.push({
          role: 'user',
          content: msg.content
        })
      } else if (msg.role === 'assistant') {
        newHistory.push({
          role: 'assistant',
          content: extractTextFromContent(msg.content)
        })
      }
    }
    fullConversationHistory.value = newHistory

    // 保存状态
    chatStore.setAgentHistory(sid.value, fullConversationHistory.value)

    // 内核那份历史跟着倒回这条消息之前 —— 不倒的话模型手上还留着原话和
    // 照原话给出的回答，改完再问等于在原话后面追加，而不是把它换掉
    await rewindTranscript(
      chatStore.getAgentSessionId(sid.value),
      countUserTurnsBefore(messages.value, msgIndex),
      agentV3API.truncateSession
    )

    // 推入新的用户消息并执行Agent（保留原来的来源）
    pushUser(newMessageContent, originalMentionedSources)
    executeAgent(newMessageContent)
  }

  // 滚动到底部
  nextTick(() => {
    scrollToBottom()
    stickToBottomFor(1800)
  })
}

/**
 * 从这条回复分出一条新对话并切换过去。
 *
 * 按钮（AIBubble 操作行里的分支图标）挂在哪条回复上，就分到哪条为止：
 * 它之后的问答不跟过去，内核 transcript 和界面消息一起截。原对话原地不动。
 */
async function handleBubbleBranch(payload: { id: string }): Promise<void> {
  const outcome = await branchChat(
    sid.value,
    {
      chatStore,
      chatMsgStore,
      forkTranscript: (agentSessionId, keepUserTurns) =>
        agentV3API.forkSession(agentSessionId, keepUserTurns),
      newChatSid: () => crypto.randomUUID(),
      branchTitle: (title) => {
        const suffix = t('assistant.branch.titleSuffix')
        return title.endsWith(suffix) ? title : `${title}${suffix}`
      },
      navigate: (newSid) => {
        router.push({ name: 'AssistantWelcome', query: { sid: newSid } })
      }
    },
    payload.id
  )

  if (outcome.ok) {
    message.success(
      t(outcome.wholeCopied ? 'assistant.branch.successWhole' : 'assistant.branch.success')
    )
    return
  }

  if (outcome.reason === 'no-agent-session') {
    message.warning(t('assistant.branch.noAgentSession'))
    return
  }
  if (outcome.reason === 'busy') {
    message.warning(t('assistant.branch.busy'))
    return
  }
  if (outcome.reason === 'missing') {
    message.warning(t('assistant.branch.missing'))
    return
  }
  console.error('[分支] 创建失败:', outcome.error)
  message.error(t('assistant.branch.failed'))
}

/**
 * 侧边问一句：把当前上下文复制给小窗口，在那边只读地问。
 *
 * 和「分支」的区别：分支是想换个方向接着**干活**，会在侧边栏留下一条新对话；
 * 侧边是想弄明白**现在是什么情况**，问完关掉，什么都不留下。而且它跑着的时候
 * 也能开 —— 那正是最想问「它在干嘛」的时刻。
 */
async function handleSideQuestion(): Promise<void> {
  const outcome = await openSideQuestion(sid.value, {
    chatStore,
    fork: (agentSessionId) => agentV3API.forkForSideQuestion(agentSessionId),
    open: (context) => window.api.miniChat.openWithContext(context)
  })

  if (outcome.ok) return

  if (outcome.reason === 'no-agent-session' || outcome.reason === 'empty') {
    message.warning(t('assistant.sideQuestion.noContext'))
    return
  }
  console.error('[侧边问一句] 打开失败:', outcome.error)
  message.error(t('assistant.sideQuestion.failed'))
}

/**
 * 处理打开位置（跳转到文件夹）
 * 支持定位到文件夹内的特定资产
 * 确保始终只在一个AssetManagement tab上操作
 */
async function handleOpenLocation(folderKey: string, assetKey?: string): Promise<void> {
  try {
    const { useTabsStore } = await import('@renderer/store/modules/tabs')
    const tabsStore = useTabsStore()

    if (folderKey.startsWith('AIGC_')) {
      if (vaultStore.vaults.length === 0) {
        await vaultStore.loadVaults()
      }

      const aigcVault = vaultStore.vaults.find((vault) => vault.systemKey === 'aigc')
      if (aigcVault && vaultStore.currentVault?.id !== aigcVault.id) {
        await vaultStore.switchVault(aigcVault.id)
      }
    }

    const query: Record<string, string> = { folderKey }
    if (assetKey) {
      query.assetKey = assetKey
    }

    // 查找所有AssetManagement相关的tab（忽略query参数）
    const assetManagementTabs = tabsStore.historyTabs.filter((tab) => {
      const pathWithoutQuery = tab.path.split('?')[0]
      return pathWithoutQuery === '/asset-management'
    })

    console.log('[资产定位] 找到', assetManagementTabs.length, '个AssetManagement tab')

    if (assetManagementTabs.length > 0) {
      // 如果存在多个，关闭除第一个外的所有tab
      for (let i = 1; i < assetManagementTabs.length; i++) {
        const tabToRemove = assetManagementTabs[i]
        if (tabToRemove.isCanDelete !== false) {
          console.log('[资产定位] 关闭多余的tab:', tabToRemove.key)
          tabsStore.removeTab(tabToRemove.key)
        }
      }

      // 激活第一个tab
      const targetTab = assetManagementTabs[0]
      console.log('[资产定位] 激活已存在的tab并导航')

      // 先激活tab
      tabsStore.setActiveTab(targetTab.key)

      // 等待tab切换完成后再导航
      await nextTick()

      // 使用replace在当前tab内导航，不会创建新tab
      router.replace({
        path: '/asset-management',
        query
      })
    } else {
      // 不存在任何AssetManagement tab，创建新的
      console.log('[资产定位] 创建新的AssetManagement tab')
      router.push({
        path: '/asset-management',
        query
      })
    }
  } catch (error) {
    console.error(t('assistant.location.jumpFailed') + ':', error)
    message.error(t('assistant.location.manualJump'))
  }
}

/**
 * 跟进建议区加载完成后，若在底部则滚动到底部。
 */
function handleFollowupsReady(): void {
  stickToBottomFor(800)
}

/**
 * 清空当前对话消息并重置为欢迎态。
 */
function handleClearSession(): void {
  confirmDialog({
    title: t('assistant.chat.clearConfirmTitle'),
    content: t('assistant.chat.clearConfirmContent'),
    okText: t('common.clear'),
    cancelText: t('common.cancel'),
    onOk: async () => {
      // 语音是应用级的一路，只有清的是**这次通话绑的那条**对话才挂断
      if (sid.value === voiceChatSid()) await voice.stop()
      // 清除前端消息
      chatMsgStore.clearSessionMessages(sid.value)
      chatStore.clearPreview(sid.value)
      contextChips.value = []

      // 🔴 关键修复：同步清除前端 Agent 对话历史
      // 避免清空后第一坡消息因残留的旧历史而被误处理
      clearConversationHistory(sid.value)
    }
  })
}

let exportingImage = false

/**
 * 把当前对话从第一条到最后一条导出为一张 PNG 长图。
 */
async function exportAsImage(): Promise<void> {
  const scrollElement = chatLogRef.value?.getScrollElement()
  if (!scrollElement || messages.value.length === 0) {
    message.warning(t('assistant.topNav.exportImageEmpty'))
    return
  }
  if (exportingImage) return

  exportingImage = true
  const hideLoading = message.loading(t('assistant.topNav.exportImagePreparing'), 0)
  try {
    await nextTick()
    const blob = await captureChatAsPng(scrollElement)
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `assistant_${sid.value}.png`
    a.click()
    URL.revokeObjectURL(url)
    message.success(t('assistant.topNav.exportImageSuccess'))
  } catch (error) {
    console.error('[Assistant] Export conversation image failed:', error)
    message.error(t('assistant.topNav.exportImageFailed'))
  } finally {
    hideLoading()
    exportingImage = false
  }
}

/**
 * 导出当前对话为JSON文件。
 */
function exportAsJSON(): void {
  const data = messages.value.map((m) => ({
    id: m.id,
    role: m.role,
    content: m.content,
    status: m.status || 'done'
  }))
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `assistant_${sid.value}.json`
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * 导出当前对话为Markdown文件。
 */
function exportAsMarkdown(): void {
  const markdown = conversationToMarkdown(messages.value, {
    user: t('assistant.export.user'),
    assistant: t('assistant.export.assistant'),
    tools: t('assistant.export.tools'),
    changes: t('assistant.export.changes'),
    failed: t('assistant.export.failed'),
    turn: (index) => t('assistant.export.turn', { n: index })
  })
  const blob = new Blob([markdown], { type: 'text/markdown' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `assistant_${sid.value}.md`
  a.click()
  URL.revokeObjectURL(url)
}

/**
 * 使用真实AI API生成助手回复，并替换"打字中"占位。
 * @param userText 用户输入文本（仅用于标题生成）
 * @param typingId 占位消息ID
 */

const atBottom = ref(true) // 翻转布局下初始状态即为视觉底部
const canScroll = ref(false)
const showNewMsgToast = computed(() => !atBottom.value && canScroll.value)
let removeScrollObserver: (() => void) | null = null

/**
 * 检查是否可以滚动（内容是否超出容器）
 */
function checkCanScroll(): void {
  const scrollEl = chatLogRef.value?.getScrollElement()
  if (scrollEl) {
    canScroll.value = scrollEl.scrollHeight > scrollEl.clientHeight + 1
  } else {
    canScroll.value = false
  }
}

watch(
  () => messages.value.length,
  (newLen, oldLen) => {
    nextTick(() => {
      // 检测是否为批量加载（如切换对话或加载历史）
      const isBulkLoad = (oldLen === undefined || oldLen === 0) && newLen > 1
      // 或者是从一个对话切换到另一个（长度变化大）
      const isSwitch = Math.abs(newLen - (oldLen || 0)) > 1

      if (isBulkLoad || isSwitch) {
        // 批量加载时，延迟检测实际滚动位置（等待翻转布局渲染完成）
        // 在翻转布局下，scrollTop=0 表示视觉底部，初始加载后通常在底部
        setTimeout(() => {
          const nearBottom = chatLogRef.value ? chatLogRef.value.isNearBottom() : true
          atBottom.value = nearBottom
          checkCanScroll()
        }, 50)
      } else {
        // 普通单条消息增加，检查是否在底部附近
        const nearBottom = chatLogRef.value ? chatLogRef.value.isNearBottom() : true
        atBottom.value = nearBottom
        checkCanScroll()
      }
    })
  }
)

/**
 * 滚动到底部并关闭新消息提示。
 */
function scrollToBottom(): void {
  // 使用 ChatLog 组件的滚动方法
  if (chatLogRef.value) {
    // 手动点击时，重置用户上滑状态，恢复自动滚动
    if (typeof chatLogRef.value.setUserScrolledAway === 'function') {
      chatLogRef.value.setUserScrolledAway(false)
    }
    // 使用平滑滚动
    chatLogRef.value.scrollToBottom({ behavior: 'smooth' })
    return
  }
  // 降级方案：使用容器滚动
  const el = chatContainerRef.value
  if (!el) return
  const target = bottomSentinel?.value
  if (target) {
    target.scrollIntoView({ behavior: 'smooth', block: 'end' })
  } else {
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }
}

// 防抖计时器，避免短时间内多次触发滚动
let scrollIfNeededTimer: ReturnType<typeof setTimeout> | null = null

/**
 * 内容尺寸变化处理
 */
function handleContentResize(): void {
  checkCanScroll()
  scrollToBottomIfNeeded()
}

/**
 * 在接近底部时自动滚动；若用户已上滑则不滚动。
 */
function scrollToBottomIfNeeded(): void {
  if (Date.now() < autoScrollPausedUntil.value) return

  // 清除之前的计时器，合并多次调用
  if (scrollIfNeededTimer) {
    clearTimeout(scrollIfNeededTimer)
  }

  // 防抖：延迟执行，合并短时间内多次调用（特别是在打开历史对话时）
  scrollIfNeededTimer = setTimeout(() => {
    scrollIfNeededTimer = null

    // 使用 nextTick 确保 DOM 更新完成后再检查
    nextTick(() => {
      // 【性能优化】移除了此处的 checkCanScroll() 调用
      // checkCanScroll 读取 scrollHeight/clientHeight，强制浏览器同步布局重计算
      // 在流式输出期间（每 150ms 触发一次），这是严重的性能瓶颈
      // canScroll 状态在消息数量变化时和 resize 事件中已经更新
      if (!chatLogRef.value) return

      // 检查用户是否手动上滑离开底部
      const userScrolledAway = chatLogRef.value.userHasScrolledAway?.value ?? false
      if (userScrolledAway) return

      // 检查是否在底部附近
      if (atBottom.value) {
        // 流式更新频繁发生，不能每批都重启平滑滚动动画；直接贴底才不会周期性顿挫。
        chatLogRef.value.scrollToBottom({ behavior: 'auto' })
      }
    })
  }, 100) // 100ms 防抖延迟
}

/**
 * 在一段时间内保持滚动到底部（仅当用户在底部且未上滑）。
 * @param durationMs 持续时间毫秒
 */
function stickToBottomFor(durationMs = 1200): void {
  const start = Date.now()
  const loop = () => {
    if (Date.now() - start > durationMs) return
    // 检查用户是否手动上滑
    const userScrolledAway = chatLogRef.value?.userHasScrolledAway?.value ?? false
    if (userScrolledAway) return // 用户上滑了，停止持续滚动

    if (Date.now() >= autoScrollPausedUntil.value && atBottom.value) {
      // 直接调用 ChatLog 的滚动方法，不通过 scrollToBottom（避免重置状态）
      chatLogRef.value?.scrollToBottom({ behavior: 'smooth' })
    }
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
}

/**
 * 在用户向上滚动后，临时暂停自动贴底。
 * @param ms 暂停毫秒数
 */
const autoScrollPausedUntil = ref(0)
function pauseAutoScroll(ms = 1000): void {
  autoScrollPausedUntil.value = Date.now() + ms
  // 立即停止 ChatLog 中的滚动循环
  if (chatLogRef.value && typeof chatLogRef.value.stopAutoScroll === 'function') {
    chatLogRef.value.stopAutoScroll()
  }
}

/**
 * 观察底部哨兵是否可见，实时更新 atBottom。
 */
function observeBottom(): void {
  // 对于虚拟滚动，使用滚动事件监听而不是 IntersectionObserver
  // 因为虚拟滚动会动态创建和销毁 DOM 元素
  const scrollEl = chatLogRef.value?.getScrollElement()
  if (!scrollEl) return
  if ((observeBottom as any)._io) {
    ;((observeBottom as any)._io as IntersectionObserver).disconnect()
  }
  // 使用滚动事件来更新 atBottom
  const onScroll = () => {
    atBottom.value = chatLogRef.value ? chatLogRef.value.isNearBottom() : true
  }
  scrollEl.addEventListener('scroll', onScroll, { passive: true })
  ;(observeBottom as any)._io = {
    disconnect: () => scrollEl.removeEventListener('scroll', onScroll)
  }
}

/**
 * 绑定滚动与输入设备事件，支持用户上滑后暂停自动贴底。
 */
function bindScrollObserver(): void {
  if (removeScrollObserver) {
    removeScrollObserver()
    removeScrollObserver = null
  }
  // 获取虚拟滚动容器的滚动元素
  const scrollEl = chatLogRef.value?.getScrollElement()
  if (!scrollEl) return
  let lastScrollTop = scrollEl.scrollTop
  const onScroll = () => {
    const current = scrollEl.scrollTop
    const goingUp = current < lastScrollTop
    lastScrollTop = current
    // 使用 ChatLog 组件的方法检查是否在底部附近
    const nearBottom = chatLogRef.value ? chatLogRef.value.isNearBottom() : true
    atBottom.value = nearBottom

    if (goingUp) {
      pauseAutoScroll(3000) // 上划后暂停 3 秒
      // 通知 ChatLog 组件用户已手动上滑
      if (chatLogRef.value && typeof chatLogRef.value.setUserScrolledAway === 'function') {
        chatLogRef.value.setUserScrolledAway(true)
      }
    } else if (nearBottom) {
      // 用户滚动到底部附近时，恢复自动滚动
      if (chatLogRef.value && typeof chatLogRef.value.setUserScrolledAway === 'function') {
        chatLogRef.value.setUserScrolledAway(false)
      }
    }
  }
  // 滚轮方向：deltaY < 0（物理向上滚）= 用户想看历史消息，暂停自动滚动
  const onWheel = (e: WheelEvent) => {
    if (e.deltaY < 0) {
      pauseAutoScroll(3000) // 向上看历史后暂停自动滚动 3 秒
      if (chatLogRef.value && typeof chatLogRef.value.setUserScrolledAway === 'function') {
        chatLogRef.value.setUserScrolledAway(true)
      }
    }
  }
  const onTouchMove = () => {
    pauseAutoScroll(3000) // 触摸上划后暂停 3 秒
    // 通知 ChatLog 组件用户已手动上滑
    if (chatLogRef.value && typeof chatLogRef.value.setUserScrolledAway === 'function') {
      chatLogRef.value.setUserScrolledAway(true)
    }
  }
  scrollEl.addEventListener('scroll', onScroll)
  scrollEl.addEventListener('wheel', onWheel, { passive: true })
  scrollEl.addEventListener('touchmove', onTouchMove, { passive: true })
  removeScrollObserver = () => {
    scrollEl.removeEventListener('scroll', onScroll)
    scrollEl.removeEventListener('wheel', onWheel)
    scrollEl.removeEventListener('touchmove', onTouchMove)
  }
}

// 当容器或模式变化时，重新绑定观察
watch(
  () => conversationMode.value,
  async (v) => {
    if (!v) return
    await nextTick()
    observeBottom()
    bindScrollObserver()
    checkCanScroll()
  }
)
watch(
  () => chatContainerRef.value,
  async () => {
    await nextTick()
    observeBottom()
    bindScrollObserver()
    checkCanScroll()
  }
)

// ==================== TAB 切换时保存/恢复滚动位置 ====================
/**
 * 按对话 ID 存储滚动位置，用于 TAB 切换时恢复
 */
const scrollPositionCache = new Map<string, number>()

/**
 * 组件激活时（TAB 切换回来）恢复滚动位置
 */
onActivated(() => {
  nextTick(() => {
    const scrollEl = chatLogRef.value?.getScrollElement()
    if (!scrollEl) return

    const cachedPosition = scrollPositionCache.get(sid.value)
    if (cachedPosition !== undefined && cachedPosition > 0) {
      // 先让虚拟滚动器渲染内容
      if (chatLogRef.value && typeof (chatLogRef.value as any).scrollToItem === 'function') {
        // 估算需要跳转到的消息索引（假设平均每条消息高度约 100px）
        const estimatedIndex = Math.floor(cachedPosition / 100)
        const targetIndex = Math.min(estimatedIndex, messages.value.length - 1)
        if (targetIndex > 0) {
          try {
            ;(chatLogRef.value as any).scrollToItem(targetIndex)
          } catch (e) {
            console.warn('[滚动恢复] scrollToItem 失败:', e)
          }
        }
      }
      // 延迟后精确恢复滚动位置
      setTimeout(() => {
        const el = chatLogRef.value?.getScrollElement()
        if (el) {
          el.scrollTop = cachedPosition
          // 更新 atBottom 状态
          atBottom.value = chatLogRef.value ? chatLogRef.value.isNearBottom() : false
        }
      }, 100)
    }

    // 重新绑定滚动观察器
    observeBottom()
    bindScrollObserver()
    checkCanScroll()
  })
})

/**
 * 组件失活时（TAB 切换走）保存滚动位置
 */
onDeactivated(() => {
  const scrollEl = chatLogRef.value?.getScrollElement()
  if (scrollEl) {
    scrollPositionCache.set(sid.value, scrollEl.scrollTop)
  }
})

// 组件卸载时清理 Agent 监听器

// ── Agent 浏览器分屏 ────────────────────────────────────────────────────────
//
// 只有「嵌入」这一档才在这里占位。网页本身由主进程挂在主窗口上（一层
// WebContentsView），浮在渲染层之上 —— 这里管的只有「该不该给它留位置」。

/**
 * 助手页此刻在不在前台。
 *
 * 这个页面是 keep-alive 的：切到别的 TAB 时组件不卸载，只是失活。不跟着收起来
 * 的话，那层网页会**继续浮在别的界面上面** —— 它不参与渲染层的布局，别人挡不住它。
 */
const paneActive = ref(true)

onActivated(() => {
  paneActive.value = true
})

onDeactivated(() => {
  paneActive.value = false
})

const browserSessionId = computed(() => chatStore.getAgentSessionId(sid.value))
const {
  open: browserPaneOpen,
  url: browserUrl,
  navigation: browserNavigation,
  group: browserGroup,
  find: browserFind
} = useSessionBrowser(browserSessionId, paneActive, () => {
  message.error(t('assistant.browserPane.restoreFailed'))
})
/** 右侧面板的「团队任务」页签。点输入框上方的团队摘要打开 */
const teamTab = useTeamTab(
  sid,
  computed(() => !!teamBoard.team.value),
  fileReview,
  browserPaneOpen
)

function selectReviewTab(): void {
  teamTab.blur()
  selectFileReview()
}

function selectBrowserPage(): void {
  teamTab.blur()
  selectBrowserTab()
}
</script>

<style scoped lang="less">
.session-goal {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  margin-bottom: var(--space-2);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-accent-border);
  border-radius: var(--radius-md);
  background: var(--color-accent-bg);
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.session-goal-icon,
.session-goal-label {
  flex-shrink: 0;
  color: var(--color-accent-text);
}

.session-goal-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--color-text-primary);
}

.session-goal-cancel {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-secondary);
  cursor: pointer;

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }

  &:focus-visible {
    outline: 2px solid var(--color-border-focus);
    outline-offset: 1px;
  }
}

.assistant-shell {
  display: flex;
  align-items: stretch;
  width: 100%;
  /* 跟着内容区走，别按窗口高度估：估少了底下会空一截。内容多了由 .assistant-welcome 自己滚 */
  height: 100%;
}

.assistant-shell > .assistant-welcome {
  flex: 1;
  min-width: 0;
}

.assistant-welcome {
  position: relative;
  min-height: 100%;
  display: flex;
  flex-direction: column;
  align-items: center;
  color: var(--color-text-primary);
  background: transparent;
  justify-content: center;
  /* --composer-height 由模板绑定输入框的实测高度，测量前用 130/210px 兜底 */
  overflow-y: overlay; /* 防止滚动条出现导致的布局抖动 */
}

.sticky-header {
  position: absolute;
  top: 12px;
  width: 100%;
  z-index: 10;
  justify-content: center;
}

.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  margin-bottom: 20px;
  animation: fadeInDown 0.4s ease-out;
}

.hero-sphere-button {
  display: block;
  padding: 0;
  border: 0;
  color: inherit;
  background: transparent;
  cursor: pointer;
}

.hero-sphere-button:disabled {
  cursor: wait;
}

.hero-sphere-button:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: var(--space-2);
  border-radius: 50%;
}

.hero-title {
  margin-top: 24px;
  font-size: 32px;
  font-weight: 700;
  letter-spacing: 0.4px;
}
.hero-project {
  margin-top: 12px;
}

.composer-section {
  width: 100%;
  max-width: 920px;
  margin-top: 0;
}

.composer-section:not(.chat-composer-sticky) {
  animation: fadeIn 0.5s ease-out 0.1s backwards;
}

.assistant-welcome.is-conversation {
  height: 100%;
  justify-content: flex-end;
}

.chat-composer-sticky {
  position: relative;
  z-index: 1;
  margin-bottom: 14px;
  padding: 0 12px;
}

/*
 * 审批框的停靠位。空的时候不占高度（没内容、没内外边距的块级元素高度就是 0）——
 * 它常驻在输入框上方，平时多出一条缝都不行。有卡片时高度由卡片自己撑出来。
 */
.approval-dock {
  width: 100%;
}

.voice-orb-dock {
  display: flex;
  align-items: center;
  justify-content: center;
  height: var(--space-16);
}

/*
 * 球体本身是纯视觉的（aria-hidden），可点的是外面这层按钮。
 * 不给它任何边框或底色 —— 它要看起来还是那个球，只是能按。
 */
.voice-orb-button {
  display: flex;
  padding: 0;
  cursor: pointer;
  background: none;
  border: 0;
}

/* 它没在说话时没什么可打断的：不拦指针事件，免得挡住球体自己的动效 */
.voice-orb-button:disabled {
  pointer-events: none;
  cursor: default;
}

.suggestions {
  width: 100%;
  max-width: 920px;
  margin-top: 32px;
  margin-bottom: 40px;
  animation: fadeInUp 0.5s ease-out 0.2s backwards;
}

/*
 * 消息区铺满整页，顶栏和输入框浮在它上面，滚动条才能从上到下贯通。
 * 被盖住的两头由 ChatLog 按下面两个变量留白，最后一条消息仍停在输入框上方。
 */
.chat-log-area {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  --chat-log-top-gap: 70px;
  --chat-log-bottom-gap: calc(var(--composer-height) + 14px);
  overflow: hidden; /* 改为hidden，让RecycleScroller自己处理滚动 */
  overscroll-behavior: contain;
}

.context-chips-section {
  width: 100%;
  max-width: 920px;
  margin: 6px 0 10px;
}

.new-msg-toast {
  position: absolute;
  bottom: calc(var(--chat-log-bottom-gap) + 19px);
  align-self: center;
}

.scroll-to-bottom-btn {
  :deep(svg) {
    font-size: 30px;
    color: #ffffffa9;
  }
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

@keyframes fadeInDown {
  from {
    opacity: 0;
    transform: translateY(-20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes fadeInUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
