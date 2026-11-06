<script setup lang="ts">
/**
 * AI 创作 —— 生图工作室。
 *
 * 布局：左侧参数面板 | 中间预览区 | 右侧历史画廊（可拖拽调整宽度）。
 *
 * **这个面板只有生图**，但 3D 与视频并不是没有 —— 它们走 agent 那条路
 * （`generate_3d_model` / `generate_video`），生成结果直接在对话窗口里
 * 预览和播放，同样存进素材库。
 *
 * 为什么那两样没做成面板：都是**异步任务式**，一次几分钟、按次或按秒计费。
 * 面板那套「填参数 → 点生成 → 等一个进度条」对它们是负担 —— 用户真正需要的是
 * 有人替他决定档位、盯着轮询、失败时说清钱扣没扣，那正是 agent 在做的事。
 * 生图相反：几秒出图、便宜、要连着改十几版，才值得一个专门的工作台。
 *
 * 真有人要手动调参出视频再说 —— 那时补一个 tab，底座（ai/video.ts）已经在了。
 */
import { ref, computed, onActivated, onMounted, onUnmounted, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute, useRouter } from 'vue-router'
import { PhGear } from '@phosphor-icons/vue'
import { getTaskDisplayUrls, useImageStudioStore, type ImageGenerationTask } from './imageStore'
import { isImageGenerationConfigured, resolveImageGenerationAccess } from './imageGenerationAccess'
import {
  useImageTaskActionRunner,
  type ImageTaskActionKey
} from './composables/useImageTaskActions'
import { aigcEventBus, AIGC_EVENTS } from './aigcEventBus'
import { AIGC_IMAGE_REFERENCE_LIMIT } from '../../../../shared/aigcReferenceLibrary'
import { getImageModelLabel } from '../../../../shared/imageGenerationModels'

// 子组件
import ImagePanel from './components/ImagePanel.vue'
import ImagePreviewArea from './components/ImagePreviewArea.vue'
import ImageHistoryPanel from './components/ImageHistoryPanel.vue'
import type { ImageViewerItemInput } from '@renderer/services/imageViewer'

const { t } = useI18n()
const route = useRoute()
const router = useRouter()
const imageStore = useImageStudioStore()

/**
 * 出图能力是否就绪。`null` 表示还没查出结果。
 *
 * 没绑生图模型时，参数面板（宽高比、分辨率、质量、张数……）整屏都是点不动的死控件 ——
 * 用户唯一该做的事只有一件：去绑一个模型。所以这种情况下把三栏全收起来，
 * 只留一句提示和一个跳转按钮，等模型绑好了再把界面铺开。
 */
const imageModelReady = ref<boolean | null>(null)
const showImageModelGate = computed(() => imageModelReady.value === false)
/**
 * 结果没出来之前先不铺开三栏 —— 先铺开再收起是一次肉眼可见的晃动。
 * 这是一次本地 IPC，通常几毫秒就回来。
 */
const isCheckingImageModel = computed(() => imageModelReady.value === null)

async function refreshImageModelReady(): Promise<void> {
  imageModelReady.value = await isImageGenerationConfigured()
}

/**
 * 跳去配置、绑好模型再切回来时，KeepAlive 不会重新 mount，只会 activated ——
 * 只挂 onMounted 的话用户配完回来看到的还是那张「去配置」卡片。
 *
 * KeepAlive 下 onActivated 首次挂载也会触发，所以不必再在 onMounted 里查一次。
 */
onActivated(() => {
  void refreshImageModelReady()
})

function goToModelSettings(): void {
  router.push('/preferences?tab=models')
}

/**
 * 页面加载时初始化
 * - 初始化主进程事件监听
 * - 加载历史记录
 * - 处理路由参数中的 prompt 预填（仅首次）
 *
 * 注意：由于 KeepAlive 使用 route.fullPath 作为 key，每个不同的 fullPath
 * 都会创建独立的组件实例，因此不需要监听路由变化。
 */
onMounted(() => {
  imageStore.setupMainProcessListeners()
  imageStore.loadHistory()

  // 处理 Prompt 预填（仅首次初始化时）
  // 通过 ref 直接设置，避免全局事件总线影响其他标签页
  const prompt = route.query.prompt as string | undefined
  if (prompt) {
    nextTick(() => {
      setTimeout(() => {
        if (imagePanelRef.value) {
          imagePanelRef.value.prompt = prompt
        }
      }, 300)
    })
  }

  // 监听事件总线：从资产库传入参考图
  aigcEventBus.on(AIGC_EVENTS.SWITCH_TO_IMAGE_AND_SET_REFERENCE, handleSwitchToImageAndSetReference)
  window.addEventListener('dragend', clearInputPanelDragState)
  window.addEventListener('drop', clearInputPanelDragState)
})

/** ImagePanel 组件引用 */
const imagePanelRef = ref<InstanceType<typeof ImagePanel> | null>(null)

const isInputPanelDragOver = ref(false)
let inputPanelDragCounter = 0

function clearInputPanelDragState() {
  inputPanelDragCounter = 0
  isInputPanelDragOver.value = false
}

function hasDraggedImages(dataTransfer?: DataTransfer | null): boolean {
  if (!dataTransfer) return false

  const items = Array.from(dataTransfer.items || [])
  if (items.some((item) => item.kind === 'file' && item.type.startsWith('image/'))) {
    return true
  }

  return Array.from(dataTransfer.files || []).some((file) => file.type.startsWith('image/'))
}

function getDroppedImageFiles(dataTransfer?: DataTransfer | null): File[] {
  return Array.from(dataTransfer?.files || []).filter((file) => file.type.startsWith('image/'))
}

function handleInputPanelDragEnter(event: DragEvent) {
  if (!hasDraggedImages(event.dataTransfer)) return

  event.preventDefault()
  inputPanelDragCounter += 1
  isInputPanelDragOver.value = true
}

function handleInputPanelDragOver(event: DragEvent) {
  if (!hasDraggedImages(event.dataTransfer)) return

  event.preventDefault()
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = 'copy'
  }
  isInputPanelDragOver.value = true
}

function handleInputPanelDragLeave(event: DragEvent) {
  const currentTarget = event.currentTarget as Node | null
  const relatedTarget = event.relatedTarget as Node | null

  if (!currentTarget || !relatedTarget || !currentTarget.contains(relatedTarget)) {
    inputPanelDragCounter = Math.max(0, inputPanelDragCounter - 1)
  }

  if (inputPanelDragCounter === 0) {
    isInputPanelDragOver.value = false
  }
}

async function handleInputPanelDrop(event: DragEvent) {
  const imageFiles = getDroppedImageFiles(event.dataTransfer)
  clearInputPanelDragState()
  if (imageFiles.length === 0) return

  event.preventDefault()

  const { message } = await import('ant-design-vue')

  if (!imagePanelRef.value) return

  const addedCount = await imagePanelRef.value.appendReferenceImages(imageFiles)
  if (addedCount > 0) {
    message.success(t('aigcStudio.reference.added', { count: addedCount }))
  } else {
    message.warning(t('aigcStudio.reference.addFailed'))
  }
}

/**
 * 处理从资产库传入的参考图
 * 通过 ref 直接调用 ImagePanel 的方法，只有当前标签页会收到，不影响其他标签页
 */
function handleSwitchToImageAndSetReference(imagePaths: string[]) {
  nextTick(() => {
    setTimeout(() => {
      if (!imagePanelRef.value) return

      imagePanelRef.value.setReferenceImages(imagePaths.slice(0, AIGC_IMAGE_REFERENCE_LIMIT))
      if (imagePaths.length > AIGC_IMAGE_REFERENCE_LIMIT) {
        import('ant-design-vue').then(({ message }) => {
          message.warning(
            t('aigcStudio.reference.truncated', { limit: AIGC_IMAGE_REFERENCE_LIMIT })
          )
        })
      }
    }, 100)
  })
}

/**
 * 把预览区那条提示词填回左侧输入框。
 *
 * 走 ref 而不是事件总线：总线会打到每一个标签页的 ImagePanel 上，
 * 而用户点的是**这一页**的「用这段再生成」（同 handleSwitchToImageAndSetReference）。
 */
function handleReusePrompt(text: string): void {
  if (!text) return
  nextTick(() => {
    if (!imagePanelRef.value) return
    imagePanelRef.value.prompt = text
    imagePanelRef.value.promptInputRef?.focus()
  })
}

/**
 * 处理将图片添加到参考图（增量，不覆盖）
 * 如果超过上限则提示
 */
function handleAddToReferenceImages(imageUrl: string) {
  nextTick(() => {
    setTimeout(() => {
      if (!imagePanelRef.value) return

      const currentRefs = imagePanelRef.value.referenceImages || []

      // 去重检查：如果图片已存在则提示
      if (currentRefs.includes(imageUrl)) {
        import('ant-design-vue').then(({ message }) => {
          message.warning(t('aigcStudio.reference.duplicate'))
        })
        return
      }

      if (currentRefs.length >= AIGC_IMAGE_REFERENCE_LIMIT) {
        import('ant-design-vue').then(({ message }) => {
          message.warning(
            t('aigcStudio.reference.limitReached', { limit: AIGC_IMAGE_REFERENCE_LIMIT })
          )
        })
        return
      }

      imagePanelRef.value.referenceImages = [...currentRefs, imageUrl]
      import('ant-design-vue').then(({ message }) => {
        message.success(
          t('aigcStudio.reference.addedOne', {
            current: currentRefs.length + 1,
            limit: AIGC_IMAGE_REFERENCE_LIMIT
          })
        )
      })
    }, 100)
  })
}

/**
 * 把整套生成参数回填到左侧面板。
 *
 * 走 ref 而不是事件总线：同 handleReusePrompt —— 总线会打到每一个标签页的
 * ImagePanel 上，而用户点的是**这一页**卡片上的「填回参数」。
 */
function handleFillForm(task: ImageGenerationTask): void {
  nextTick(() => {
    if (!imagePanelRef.value) return
    imagePanelRef.value.fillForm({
      prompt: task.prompt,
      referenceImages: task.referenceImages || [],
      model: task.model,
      quality: task.quality,
      ratio: task.ratio as never,
      resolution: task.resolution as never,
      count: task.count,
      style: task.style
    })
    import('ant-design-vue').then(({ message }) => {
      message.success(t('aigcImageActions.messages.filledForm'))
    })
  })
}

/**
 * 一张生成图能做的事只有一份实现，中间大图和右侧卡片都打到这里来。
 * 清单和行为见 composables/useImageTaskActions.ts。
 */
const imageActions = useImageTaskActionRunner({
  fillForm: handleFillForm,
  addToReference: handleAddToReferenceImages
})

/** 大图区的动作作用在**当前翻到的那张**上 */
function handlePreviewAction(payload: { key: ImageTaskActionKey; index: number }): void {
  void imageActions.run(payload.key, { task: imageStore.previewTask, index: payload.index })
}

/** 卡片的动作作用在这条记录的首图上；`task` 为空是标题栏那个「打开资产库」 */
function handleHistoryAction(payload: {
  key: ImageTaskActionKey
  task: ImageGenerationTask | null
}): void {
  void imageActions.run(payload.key, { task: payload.task, index: 0 })
}

/**
 * 图片生成状态（从 store 读取）
 * 只有当预览任务本身是正在生成的任务时才显示加载状态
 */
const generatedImages = computed(() => imageStore.previewImages)
const historyViewerItems = computed<ImageViewerItemInput[]>(() =>
  imageStore.allTasks.flatMap((task) =>
    getTaskDisplayUrls(task).map((src) => ({
      src,
      alt: task.name || task.prompt
    }))
  )
)
const isImageGenerating = computed(() => {
  const task = imageStore.previewTask
  return task?.status === 'processing' || task?.status === 'pending'
})
const currentProgress = computed(() => imageStore.previewTask?.progress ?? 0)
const previewError = computed(() => {
  const task = imageStore.previewTask
  if (task?.status !== 'failed') return undefined
  // 取消这类「主进程说不出语言」的原因放在 errorKey 上，厂商原文才在 error 里。
  // 只看 error 的那一版会让同一屏上的卡片说「已取消」、大图区说「生成失败」。
  const reason = task.errorKey ? t(task.errorKey) : task.error
  return reason || t('aigcStudio.generateFailed')
})
const previewPrompt = computed(() => imageStore.previewTask?.prompt || '')
const previewModelLabel = computed(() => getImageModelLabel(imageStore.previewTask?.model))

/**
 * 重试生成：使用失败任务的参数重新生成
 * 支持文生图和图生图
 */
async function handleRetryGeneration() {
  const failedTask = imageStore.previewTask
  if (!failedTask) return

  // 官方令牌或本地生图模型，两者有其一就能重试
  const access = await resolveImageGenerationAccess()
  if (!access.ok) {
    import('ant-design-vue').then(({ message }) => {
      message.error(t(access.reasonKey))
    })
    return
  }

  // 使用原任务参数创建新任务（包含所有参数）
  const newTask = imageStore.createTask({
    prompt: failedTask.prompt,
    referenceImages: failedTask.referenceImages,
    ratio: failedTask.ratio,
    resolution: failedTask.resolution,
    provider: failedTask.provider,
    model: failedTask.model,
    quality: failedTask.quality,
    style: failedTask.style,
    count: failedTask.count,
    materialMode: failedTask.materialMode
  })

  try {
    const result = await window.electron.ipcRenderer.invoke('image:startGeneration', {
      taskId: newTask.id,
      prompt: failedTask.prompt,
      referenceImages: failedTask.referenceImages,
      ratio: failedTask.ratio,
      resolution: failedTask.resolution || '2K',
      provider: failedTask.provider,
      model: failedTask.model,
      quality: failedTask.quality,
      style: failedTask.style,
      count: failedTask.count,
      materialMode: failedTask.materialMode
    })

    if (!result.success) {
      import('ant-design-vue').then(({ message }) => {
        message.error(result.error || t('aigcStudio.retryFailed'))
      })
    } else {
      import('ant-design-vue').then(({ message }) => {
        message.info(t('aigcStudio.regenerating'))
      })
    }
  } catch (error) {
    console.error('[AIGCStudio] 重试失败:', error)
    import('ant-design-vue').then(({ message }) => {
      message.error(error instanceof Error ? error.message : t('aigcStudio.retryFailed'))
    })
  }
}

/**
 * 右侧面板宽度（可拖拽调整，从localStorage恢复）
 */
const HISTORY_PANEL_WIDTH_KEY = 'aigc-studio-history-panel-width'
const savedWidth = localStorage.getItem(HISTORY_PANEL_WIDTH_KEY)
const historyPanelWidth = ref(savedWidth ? Math.min(600, Math.max(300, parseInt(savedWidth))) : 300)
const minHistoryWidth = 300
const maxHistoryWidth = 600

const isResizing = ref(false)

function startResizing(e: MouseEvent) {
  e.preventDefault()
  isResizing.value = true
  document.addEventListener('mousemove', handleMouseMove)
  document.addEventListener('mouseup', stopResizing)
  document.body.style.cursor = 'ew-resize'
  document.body.style.userSelect = 'none'
}

function handleMouseMove(e: MouseEvent) {
  if (!isResizing.value) return
  const container = document.querySelector('.aigc-studio')
  if (!container) return

  const containerRect = container.getBoundingClientRect()
  // 从右边界计算新宽度
  const newWidth = containerRect.right - e.clientX
  historyPanelWidth.value = Math.min(maxHistoryWidth, Math.max(minHistoryWidth, newWidth))
}

function stopResizing() {
  isResizing.value = false
  document.removeEventListener('mousemove', handleMouseMove)
  document.removeEventListener('mouseup', stopResizing)
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  localStorage.setItem(HISTORY_PANEL_WIDTH_KEY, String(historyPanelWidth.value))
}

onUnmounted(() => {
  document.removeEventListener('mousemove', handleMouseMove)
  document.removeEventListener('mouseup', stopResizing)
  window.removeEventListener('dragend', clearInputPanelDragState)
  window.removeEventListener('drop', clearInputPanelDragState)
  clearInputPanelDragState()
  aigcEventBus.off(
    AIGC_EVENTS.SWITCH_TO_IMAGE_AND_SET_REFERENCE,
    handleSwitchToImageAndSetReference
  )
})
</script>

<template>
  <!--
    没绑生图模型时不铺开三栏：那一屏参数（宽高比、分辨率、质量、张数……）全是点不动的死控件，
    用户唯一该做的事只有一件。渐进式披露 —— 先只给这一件事，配好了再把界面放出来。
  -->
  <div v-if="showImageModelGate || isCheckingImageModel" class="aigc-studio aigc-studio--gated">
    <div v-if="showImageModelGate" class="gate-body">
      <div class="gate-card">
        <h2 class="gate-title">{{ t('aigcImagePanel.gate.title') }}</h2>
        <p class="gate-desc">{{ t('aigcImagePanel.access.noImageModel') }}</p>
        <button class="gate-action" type="button" @click="goToModelSettings">
          <PhGear />
          <span>{{ t('aigcImagePanel.gate.action') }}</span>
        </button>
      </div>
    </div>
  </div>

  <div v-else class="aigc-studio">
    <!-- 左侧：输入参数面板 -->
    <aside
      class="input-panel-container"
      :class="{ 'drag-over': isInputPanelDragOver }"
      @dragenter="handleInputPanelDragEnter"
      @dragover="handleInputPanelDragOver"
      @dragleave="handleInputPanelDragLeave"
      @drop="handleInputPanelDrop"
    >
      <ImagePanel ref="imagePanelRef" />
    </aside>

    <!-- 中间：预览区域 -->
    <main class="preview-container">
      <ImagePreviewArea
        class="preview-area"
        :images="generatedImages"
        :viewer-items="historyViewerItems"
        :is-loading="isImageGenerating"
        :progress="currentProgress"
        :error="previewError"
        :prompt="previewPrompt"
        :model-label="previewModelLabel"
        :is-completed="imageStore.previewTask?.status === 'completed'"
        @action="handlePreviewAction"
        @retry="handleRetryGeneration"
        @reuse-prompt="handleReusePrompt"
      />
    </main>

    <!-- 右侧：历史/画廊面板（可拖拽调整宽度） -->
    <aside
      class="history-panel-container"
      :style="{ width: `${historyPanelWidth}px` }"
      :class="{ resizing: isResizing }"
    >
      <ImageHistoryPanel @action="handleHistoryAction" />

      <!-- 拖拽调整手柄（放在最后确保在层叠顺序上最高） -->
      <div class="resize-handle" @mousedown="startResizing"></div>
    </aside>

    <!-- 「发送到画布」指的是发到一块**云端**画布，社区版没有这个概念 -->
  </div>
</template>

<style scoped>
.aigc-studio {
  display: flex;
  height: 100%;
  width: 100%;
  background: var(--color-bg-surface);
  overflow: hidden;
}

/* 未绑定生图模型时的最小界面 */
.aigc-studio--gated {
  flex-direction: column;
}

.gate-body {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

.gate-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  max-width: 420px;
  text-align: center;
}

.gate-title {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
}

.gate-desc {
  margin: 0;
  font-size: var(--font-size-sm);
  line-height: 1.7;
  color: var(--color-text-secondary);
}

.gate-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-top: 4px;
  padding: 8px 18px;
  border: none;
  border-radius: var(--radius-sm);
  background: var(--color-accent-solid);
  color: var(--color-text-on-solid);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: opacity var(--motion-fast) var(--easing-standard);
}

.gate-action:hover {
  opacity: 0.88;
}

/* 左侧输入面板 */
.input-panel-container {
  position: relative;
  width: 330px;
  min-width: 280px;
  max-width: 400px;
  height: 100%;
  border-right: 1px solid var(--color-border-subtle);
  overflow-y: auto;
  flex-shrink: 0;
  transition:
    border-color 0.2s ease,
    background 0.2s ease;
}

.input-panel-container.drag-over {
  border-right-color: var(--color-accent-border);
  background: var(--color-accent-bg);
}

/* 中间预览区 */
.preview-container {
  flex: 1;
  height: 100%;
  min-width: 400px;
  display: flex;
  flex-direction: column;
}

.preview-container .preview-area {
  flex: 1;
  min-height: 0;
}

/* 右侧历史面板 */
.history-panel-container {
  position: relative;
  min-width: 300px;
  max-width: 600px;
  height: 100%;
  border-left: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface);
  overflow-y: auto;
  flex-shrink: 0;
}

.history-panel-container.resizing {
  user-select: none;
}

/* 拖拽调整手柄 */
.resize-handle {
  position: absolute;
  left: 0;
  top: 0;
  bottom: 0;
  width: 4px;
  background: transparent;
  cursor: ew-resize;
  transition: background 0.2s ease;
  z-index: 100;
}

.resize-handle:hover,
.history-panel-container.resizing .resize-handle {
  background: var(--color-accent-solid);
}

/* 滚动条样式 */
.input-panel-container::-webkit-scrollbar,
.history-panel-container::-webkit-scrollbar {
  width: 4px;
}

.input-panel-container::-webkit-scrollbar-thumb,
.history-panel-container::-webkit-scrollbar-thumb {
  background: var(--color-bg-surface-hover);
  border-radius: 2px;
}

.input-panel-container::-webkit-scrollbar-thumb:hover,
.history-panel-container::-webkit-scrollbar-thumb:hover {
  background: var(--color-text-muted);
}

/* 入场动画关键帧 */
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

@keyframes fadeInLeft {
  from {
    opacity: 0;
    transform: translateX(-20px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}

@keyframes fadeInRight {
  from {
    opacity: 0;
    transform: translateX(20px);
  }
  to {
    opacity: 1;
    transform: translateX(0);
  }
}
</style>
