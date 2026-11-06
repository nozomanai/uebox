<script setup lang="ts">
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import AppModal from '@renderer/components/AppModal.vue'
import AppCheckbox from '@renderer/components/AppCheckbox.vue'
import AppButton from '@renderer/components/AppButton.vue'
import {
  computed,
  inject,
  type Component,
  ref,
  watch,
  onMounted,
  onUnmounted,
  onActivated
} from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@renderer/utils/messageManager'
import {
  PhArrowClockwise,
  PhBrain,
  PhCaretDown,
  PhCheck,
  PhCircleNotch,
  PhDotsThree,
  PhFile,
  PhFileText,
  PhGlobe,
  PhLink,
  PhPencilSimple,
  PhPlus,
  PhSlidersHorizontal,
  PhTrash,
  PhYoutubeLogo
} from '@phosphor-icons/vue'
import { getFileTypeLabel, isSupportedSourceFile } from '../utils/fileTypeUtils'
import type { SourceItem } from '@renderer/store/modules/notebookStore'
import { useNotebookStore } from '@renderer/store/modules/notebookStore'
import {
  isSourceIncluded,
  normalizeNotebookContextLevel,
  summarizeContextBudget,
  type NotebookContextLevel
} from '@core/shared/notebookContext'
import { ensureSourceSummary } from '@renderer/services/notebookContent/ensureSourceSummary'
import {
  notebookCharBudgetSync,
  resolveNotebookCharBudget
} from '@renderer/services/notebook/contextBudget'

const props = defineProps<{
  sources: SourceItem[]
  activeId?: string
  isTraining?: boolean
  /** 来源是否有变动但尚未训练，用于显示警告状态 */
  needsTraining?: boolean
  /** 编辑笔记后自不自动重新索引 —— 就是下面那个按钮要不要自己按 */
  autoTrain?: boolean
  notebookId?: string
}>()

const emit = defineEmits<{
  (e: 'select', source: SourceItem): void
  (e: 'click-empty'): void
  (e: 'remove', sourceId: string): void
  (e: 'train'): void
  (e: 'update:autoTrain', enabled: boolean): void
  (e: 'retry', sourceId: string): void
  /**
   * 添加 Web 搜索结果作为来源
   * @param url 网页 URL
   * @param title 网页标题
   */
  (e: 'add-web-source', url: string, title: string): void
  /**
   * 创建笔记并添加到知识库
   * @param title 笔记标题
   * @param content 笔记内容（Markdown）
   */
  (e: 'create-note', title: string, content: string): void
  /**
   * 重命名来源
   * @param sourceId 来源 ID
   * @param newTitle 新标题
   */
  (e: 'rename', sourceId: string, newTitle: string): void
  /**
   * 从视频提取音频并解析
   * @param sourceId 来源 ID
   * @param filePath 视频文件路径
   */
  /**
   * 拖拽添加文件来源
   * @param file 文件对象
   */
  (e: 'add-file-source', file: File): void
}>()

const openAddSource = inject<() => void>('openAddSource')
const openNoteEditor = inject<() => void>('openNoteEditor')

// 召回测试：入口暂时隐藏，逻辑留着给开发时用
const recallResults = ref<Record<string, unknown>[]>([])
const showRecallResults = ref(false)

// i18n
const { t } = useI18n()

const nbStore = useNotebookStore()

/**
 * Agent 往这个知识库里存了来源就刷新列表。
 *
 * 存来源现在是 `add_notebook_source` 这个工具干的（用户在助手里说「查一下 X 存进来」），
 * 主进程存完发这条事件。不听的话用户要手动切一次页面才看得见新来源。
 *
 * 认 notebookId 是因为 KeepAlive 会缓存好几个 NoteSourcePanel，不认的话每一个都会跟着刷。
 * 出于同样的原因，卸载时只移除自己的监听：removeAllListeners 会把其他面板的监听
 * 一并移除，而缓存中的面板不会重新挂载，移除后就再也收不到事件。
 */
let offSourceChanged: (() => void) | null = null

/**
 * B 站视频分析的进度，按来源 URL 存。
 *
 * 不写进 store：这是一次调用期间的临时状态，而 store 里的来源会落库。
 * 整条链要解析链接、下载、可能压一遍、再等模型，最坏好几分钟 ——
 * 不显示的话这段时间侧栏只有一行「Bilibili」在转圈。
 */
const analyzeNotes = ref<Record<string, string>>({})
let offAnalyzeProgress: (() => void) | null = null

/** 来源正在加载时那一行要显示的字：有进度就报进度，没有就报类型 */
const getSourceLoadingLabel = (source: SourceItem): string => {
  const note = source.sourceUrl ? analyzeNotes.value[source.sourceUrl] : ''
  return note || getSourceTypeLabel(source)
}

/**
 * 一条来源重新转起来，就先把上一轮留下的进度句丢掉。
 *
 * 缓存按 URL 存，而重试用的是同一条 URL。不丢的话用户点重试，这一行会先亮出
 * 上次失败前停住的「正在让 X 看这段视频…」，要等几秒后新的进度才盖掉它 ——
 * 那几秒里侧栏报的是上一轮的状态。
 */
watch(
  () =>
    props.sources
      .filter((source) => source.loading && source.sourceUrl)
      .map((source) => source.sourceUrl as string),
  (loadingUrls, previousUrls) => {
    const alreadyLoading = new Set(previousUrls ?? [])
    const started = loadingUrls.filter((url) => !alreadyLoading.has(url) && analyzeNotes.value[url])
    if (started.length === 0) return

    const next = { ...analyzeNotes.value }
    for (const url of started) delete next[url]
    analyzeNotes.value = next
  }
)

onMounted(() => {
  offSourceChanged = window.electron.ipcRenderer.on(
    'agent:notebook:source-changed',
    async (_event, payload: { notebookId?: string }) => {
      if (!props.notebookId || payload?.notebookId !== props.notebookId) return
      await nbStore.loadSources(props.notebookId)
    }
  )
  offAnalyzeProgress = window.api.bilibili.onAnalyzeProgress(({ url, note }) => {
    analyzeNotes.value = { ...analyzeNotes.value, [url]: note }
  })
})

onUnmounted(() => {
  offSourceChanged?.()
  offSourceChanged = null
  offAnalyzeProgress?.()
  offAnalyzeProgress = null
})

/**
 * 召回测试。入口暂时隐藏，留着开发时手动验证检索质量。
 */
const runRecallTest = async (query: string): Promise<void> => {
  if (!props.notebookId || !query.trim()) return

  try {
    // 取选中的来源 ID（转成普通数组以便 IPC 序列化）
    const selectedIds = [...selectedSourceIds.value]
    recallResults.value = await window.api.notebook.ragSearch({
      notebookId: props.notebookId,
      query,
      limit: 10,
      sourceIds: selectedIds
    })
    showRecallResults.value = true
  } catch (error) {
    console.error('Recall search failed:', error)
    message.error(t('notebook.addSource.recallTestFailed'))
  }
}
defineExpose({ runRecallTest })

const getIcon = (type: string): Component => {
  switch (type) {
    case 'link':
      return PhLink
    case 'youtube':
      return PhYoutubeLogo
    case 'bilibili':
      return PhGlobe
    case 'text':
      return PhFileText
    case 'note':
      return PhFileText
    case 'file':
      return PhFile
    default:
      return PhGlobe
  }
}

/**
 * 获取来源类型的显示标签
 * @param source 来源项
 * @returns 显示标签，如 "Word 文档"、"网页" 等
 */
const getSourceTypeLabel = (source: SourceItem): string => {
  if (source.type === 'file' && source.fileName) {
    return getFileTypeLabel(source.fileName)
  }
  switch (source.type) {
    case 'link':
      return 'Web'
    case 'youtube':
      return 'YouTube'
    case 'bilibili':
      return 'Bilibili'
    case 'text':
      return t('notebook.addSource.sourceType.text')
    case 'note':
      return t('notebook.addSource.sourceType.note')
    case 'file':
      return t('notebook.addSource.sourceType.file')
    default:
      return source.type
  }
}

const getSourceIndexStatus = (
  source: SourceItem
): { label: string; className: string; title?: string; spinning?: boolean } | null => {
  if (source.loading) {
    return null
  }

  switch (source.indexStatus) {
    case 'indexed':
      return {
        label: t('notebook.addSource.indexStatus.indexed'),
        className: 'indexed',
        title: source.indexedAt
          ? t('notebook.addSource.indexStatus.indexedAt', { at: source.indexedAt })
          : t('notebook.addSource.indexStatus.indexed')
      }
    case 'keyword':
      return {
        label: t('notebook.addSource.indexStatus.keyword'),
        className: 'keyword',
        title: source.indexError || t('notebook.addSource.indexStatus.keywordHint')
      }
    case 'indexing':
      return {
        label: t('notebook.addSource.indexStatus.indexing'),
        className: 'indexing',
        spinning: true
      }
    case 'pending':
      return { label: t('notebook.addSource.indexStatus.pending'), className: 'pending' }
    case 'error':
      return {
        label: t('notebook.addSource.indexStatus.error'),
        className: 'error',
        title: source.indexError || t('notebook.addSource.indexStatus.error')
      }
    default:
      return source.content?.trim()
        ? { label: t('notebook.addSource.indexStatus.pending'), className: 'pending' }
        : null
  }
}

// ============ 来源选择逻辑 ============

/** 当前 hover 的来源 ID */
const hoveredSourceId = ref<string | null>(null)

/**
 * 「…」菜单开在哪一条来源上。
 *
 * 那颗按钮平时是 `display: none`，只有整行 hover 才出现。菜单弹出来之后鼠标要往
 * 菜单上移，一离开这一行按钮就没了 —— 触发器连盒子都不剩，浮层的定位失去锚点。
 * 所以菜单开着的时候得把按钮钉住（`.more-btn.open`），顺带也不会出现
 * 「菜单还开着、它的按钮却消失了」这种看着就不对的画面。
 */
const openMenuSourceId = ref<string | null>(null)

/** 重命名弹窗相关 */
const renameModalVisible = ref(false)
const renameSourceId = ref<string | null>(null)
const renameNewTitle = ref('')

/**
 * 会进上下文的来源 id。
 *
 * 按本面板自己的来源算：面板缓存在后台时，前台 tab 打开的可能是别的笔记本
 */
const selectedSourceIds = computed(
  () => new Set(props.sources.filter(isSourceIncluded).map((s) => s.id))
)

/**
 * 检查来源是否被选中
 */
const isSourceSelected = (sourceId: string): boolean => {
  return selectedSourceIds.value.has(sourceId)
}

/**
 * 切换来源选中状态
 */
const toggleSourceSelection = (sourceId: string): void => {
  if (!props.notebookId) return
  nbStore.toggleSourceIncluded(props.notebookId, sourceId)
}

/**
 * 是否全选
 */
const isAllSelected = (): boolean => {
  return props.sources.length > 0 && props.sources.every(isSourceIncluded)
}

/**
 * 是否部分选中（用于 indeterminate 状态）
 */
const isSomeSelected = (): boolean => {
  const count = getSelectedSourceCount()
  return count > 0 && count < props.sources.length
}

/**
 * 获取选中来源数量
 */
const getSelectedSourceCount = (): number => {
  return selectedSourceIds.value.size
}

/**
 * 切换全选/取消全选
 */
const toggleAllSelection = (): void => {
  if (!props.notebookId) return
  nbStore.setAllContextLevels(props.notebookId, isAllSelected() ? 'excluded' : 'full')
}

// ============ 上下文档位 ============

/** 正在生成摘要的来源 id。摘要要跑几十秒，这一条得转起来 */
const summarizingSourceIds = ref<Set<string>>(new Set())

const getContextLevel = (source: SourceItem): NotebookContextLevel =>
  normalizeNotebookContextLevel(source.contextLevel)

/** 这条来源的摘要还没生成好（正在生成，或者生成失败了） */
const isSummaryPending = (source: SourceItem): boolean =>
  summarizingSourceIds.value.has(source.id) || source.summaryStatus === 'processing'

const isSummaryFailed = (source: SourceItem): boolean => source.summaryStatus === 'failed'

/**
 * 改一条来源的档位。切到「只给摘要」时顺手把摘要生成出来。
 *
 * 档位先落库、摘要后台补 —— 反过来的话用户点一下要干等几十秒才看到勾变过来。
 * 摘要没生成成功也不回退档位：那一档照样能用（退回正文开头），
 * 界面上会把「摘要没生成」如实标出来。
 */
const setContextLevel = async (source: SourceItem, level: NotebookContextLevel): Promise<void> => {
  if (getContextLevel(source) === level) return
  /*
    这一条正在生成摘要就别再动它。

    一次 condenseSource 要几十秒，而转圈期间徽章和下拉菜单都还能点。不挡的话
    用户来回切两下就发出两次付费调用，先回来的那次把转圈停掉，后回来的那次
    再覆盖一遍 summaryContent。
  */
  if (summarizingSourceIds.value.has(source.id)) return
  if (!props.notebookId) return
  const notebookId = props.notebookId

  await nbStore.setSourceContextLevel(notebookId, source.id, level)
  if (level !== 'summary') return

  summarizingSourceIds.value = new Set(summarizingSourceIds.value).add(source.id)
  try {
    const outcome = await ensureSourceSummary(source, (updates) =>
      nbStore.updateSource(notebookId, source.id, updates)
    )
    if (outcome === 'failed') {
      message.warning(t('notebook.source.context.summaryFailed', { title: source.title }))
    }
  } finally {
    const next = new Set(summarizingSourceIds.value)
    next.delete(source.id)
    summarizingSourceIds.value = next
  }
}

/** 在「全文」和「只给摘要」之间来回切 —— 徽章点一下就走这条 */
const toggleContextLevel = (source: SourceItem): void => {
  void setContextLevel(source, getContextLevel(source) === 'summary' ? 'full' : 'summary')
}

/** 整份来源列表的档位一起改 */
const setAllContextLevels = (level: NotebookContextLevel): void => {
  if (!props.notebookId) return
  void nbStore.setAllContextLevels(props.notebookId, level)
}

/**
 * 这次生成会送多少字进模型。
 *
 * 上限按**用户当前绑的模型的窗口**算，不是一个写死的数 —— 配了 1M 窗口的模型
 * 就该能多送。首帧可能拿到保守缺省值，模型上限读回来之后重新算。
 *
 * 装箱逻辑和真正生成时是同一条（`@core/shared/notebookContext`），
 * 所以这里写的数字就是实际会送出去的数字，不是另算的一个近似值。
 */
const charBudget = ref(notebookCharBudgetSync())

const refreshCharBudget = (): void => {
  void resolveNotebookCharBudget().then((budget) => {
    charBudget.value = budget
  })
}

onMounted(refreshCharBudget)

/*
  回到这个页面时重新问一次预算。

  只在 onMounted 问的话这个数就再也不会变了：知识库页是 keepAlive 的，而且所有
  知识库共用同一个缓存键，所以从来不会重新挂载。用户的典型动作恰恰是「先打开知识库
  （此时还没绑模型，拿到的是保守缺省值），再去设置里绑模型，然后回来」—— 回来之后
  计量条还写着缺省值那几十万字、说每条来源都装得下，而真正生成时用的是新模型的真实
  预算，于是绝大部分来源被默默丢掉。onActivated 会随 keepAlive 的页面一起触发到子组件，
  正好覆盖这条路径。
*/
onActivated(refreshCharBudget)

const contextBudget = computed(() => summarizeContextBudget(props.sources, charBudget.value))

/** 4 万字这种数字写成「4.0 万」比写 40000 好读 */
const formatChars = (chars: number): string =>
  chars >= 10000 ? `${(chars / 10000).toFixed(1)}万` : String(chars)

/** 进度条宽度。超额时钉在 100%，不要溢出容器 */
const budgetPercent = computed(() => {
  const { totalChars, maxChars } = contextBudget.value
  return Math.min(100, Math.round((totalChars / maxChars) * 100))
})

/** 被挤掉的来源标题，用来在提示里点名 */
const droppedTitles = computed(() =>
  contextBudget.value.droppedTitles.map(
    (title) => title?.trim() || t('notebook.source.context.untitled')
  )
)

/**
 * 打开重命名弹窗
 */
const openRenameModal = (source: SourceItem): void => {
  renameSourceId.value = source.id
  renameNewTitle.value = source.title || ''
  renameModalVisible.value = true
}

/**
 * 确认重命名
 */
const confirmRename = (): void => {
  if (renameSourceId.value && renameNewTitle.value.trim()) {
    emit('rename', renameSourceId.value, renameNewTitle.value.trim())
    renameModalVisible.value = false
    renameSourceId.value = null
    renameNewTitle.value = ''
  }
}

// ============ 拖拽上传逻辑 ============

/** 递归遍历目录获取所有支持的文件 */
const traverseDirectory = async (entry: FileSystemDirectoryEntry): Promise<File[]> => {
  const files: File[] = []
  const reader = entry.createReader()

  const readEntries = (): Promise<FileSystemEntry[]> => {
    return new Promise((resolve, reject) => {
      reader.readEntries(
        (entries) => resolve(entries),
        (error) => reject(error)
      )
    })
  }

  const processEntry = async (childEntry: FileSystemEntry): Promise<void> => {
    if (childEntry.isFile) {
      const fileEntry = childEntry as FileSystemFileEntry
      const file = await new Promise<File>((resolve, reject) => {
        fileEntry.file(resolve, reject)
      })
      if (isSupportedSourceFile(file.name)) {
        files.push(file)
      }
    } else if (childEntry.isDirectory) {
      const subFiles = await traverseDirectory(childEntry as FileSystemDirectoryEntry)
      files.push(...subFiles)
    }
  }

  let entries: FileSystemEntry[]
  do {
    entries = await readEntries()
    await Promise.all(entries.map(processEntry))
  } while (entries.length > 0)

  return files
}

/** 是否正在拖拽文件到来源区域 */
const isDragOver = ref(false)

const handleDragOver = (e: DragEvent): void => {
  e.preventDefault()
  e.stopPropagation()
  isDragOver.value = true
}

const handleDragLeave = (e: DragEvent): void => {
  e.preventDefault()
  e.stopPropagation()
  isDragOver.value = false
}

const handleDrop = async (e: DragEvent): Promise<void> => {
  e.preventDefault()
  e.stopPropagation()
  isDragOver.value = false

  const items = e.dataTransfer?.items
  const files = e.dataTransfer?.files
  if (!items || items.length === 0) return

  const allFiles: File[] = []
  const processPromises: Promise<void>[] = []

  for (let i = 0; i < items.length; i++) {
    const item = items[i]
    const entry = item.webkitGetAsEntry?.()

    if (entry?.isDirectory) {
      processPromises.push(
        traverseDirectory(entry as FileSystemDirectoryEntry).then((dirFiles) => {
          allFiles.push(...dirFiles)
        })
      )
    } else if (entry?.isFile && files && files[i]) {
      const file = files[i]
      if (isSupportedSourceFile(file.name)) {
        allFiles.push(file)
      }
    }
  }

  if (processPromises.length > 0) {
    message.loading({ content: t('notebook.addSource.scanning'), key: 'folder_scan' })
    try {
      await Promise.all(processPromises)
      message.destroy('folder_scan')
    } catch (error) {
      console.error('[NoteSourcePanel] 扫描文件夹失败:', error)
      message.error({ content: t('notebook.addSource.scanFailed'), key: 'folder_scan' })
      return
    }
  }

  if (allFiles.length === 0) {
    message.warning(t('notebook.addSource.noSupportedFiles'))
    return
  }

  for (const file of allFiles) {
    emit('add-file-source', file)
  }
  message.success(t('notebook.addSource.addedFiles', { count: allFiles.length }))
}
</script>

<template>
  <div class="note-source-panel">
    <div class="panel-header">
      <span class="title">{{ t('notebook.source.title') }}</span>
      <div class="actions">
        <AppButton
          class="train-btn"
          :class="{ warning: needsTraining && !isTraining }"
          size="small"
          :loading="isTraining"
          :disabled="isTraining || sources.length === 0"
          @click="$emit('train')"
        >
          <PhBrain />
          {{ t('notebook.source.trainKnowledge') }}
        </AppButton>

        <!--
          「编辑后自动重新索引」挂在这个按钮旁边，因为它管的就是这个按钮要不要自己按。
          原来它在「偏好设置 → 知识库」，隔着两个页面，看不出是同一件事
        -->
        <AppDropdown :trigger="['click']" placement="bottomRight">
          <button class="train-options-btn" :title="t('notebook.source.trainOptions')">
            <PhCaretDown />
          </button>
          <template #overlay>
            <AppMenu>
              <AppMenuItem
                key="auto-train"
                item-key="auto-train"
                @click="$emit('update:autoTrain', !autoTrain)"
              >
                <PhCheck v-if="autoTrain" class="auto-train-check" />
                {{ t('notebook.source.autoTrain') }}
              </AppMenuItem>
            </AppMenu>
          </template>
        </AppDropdown>
      </div>
    </div>

    <!-- Add Source Action Area (支持拖拽文件上传) -->
    <div
      class="add-source-area"
      :class="{ 'drag-over': isDragOver }"
      @dragover="handleDragOver"
      @dragleave="handleDragLeave"
      @drop="handleDrop"
    >
      <div class="add-btn-wrapper">
        <AppButton class="main-add-btn" block @click="openAddSource?.()">
          <PhPlus /> {{ t('notebook.source.addSource') }}
        </AppButton>
      </div>
      <AppButton class="add-note-btn" block @click="openNoteEditor?.()">
        <PhFileText /> {{ t('notebook.source.addNote') }}
      </AppButton>
    </div>

    <!-- Source List Area -->
    <div v-if="sources.length === 0" class="source-list empty-container"></div>
    <template v-else>
      <!-- 全选/取消全选 Header -->
      <div class="source-list-header">
        <AppCheckbox
          :checked="isAllSelected()"
          :indeterminate="isSomeSelected()"
          @change="toggleAllSelection"
        >
          <span class="select-all-label">
            {{
              isAllSelected() ? t('notebook.source.deselectAll') : t('notebook.source.selectAll')
            }}
          </span>
        </AppCheckbox>
        <span class="selected-count-label">
          {{ t('notebook.source.selectedSourceCount', { count: getSelectedSourceCount() }) }}
        </span>
        <!-- 批量改档位：来源多的时候一条条点太慢 -->
        <AppDropdown :trigger="['click']" placement="bottomRight">
          <div class="bulk-level-btn" :title="t('notebook.source.context.bulkTitle')">
            <PhSlidersHorizontal />
          </div>
          <template #overlay>
            <AppMenu>
              <AppMenuItem key="all-full" item-key="all-full" @click="setAllContextLevels('full')">
                {{ t('notebook.source.context.allFull') }}
              </AppMenuItem>
              <AppMenuItem
                key="all-summary"
                item-key="all-summary"
                @click="setAllContextLevels('summary')"
              >
                {{ t('notebook.source.context.allSummary') }}
              </AppMenuItem>
              <AppMenuItem
                key="all-excluded"
                item-key="all-excluded"
                @click="setAllContextLevels('excluded')"
              >
                {{ t('notebook.source.context.allExcluded') }}
              </AppMenuItem>
            </AppMenu>
          </template>
        </AppDropdown>
      </div>

      <!-- 上下文预算：生成之前就把「这次会送多少字」摆出来 -->
      <div class="context-budget" :class="{ over: contextBudget.overBudget }">
        <div class="budget-bar">
          <div class="budget-fill" :style="{ width: budgetPercent + '%' }"></div>
        </div>
        <div class="budget-text">
          <span>
            {{
              t('notebook.source.context.budget', {
                used: formatChars(contextBudget.totalChars),
                max: formatChars(contextBudget.maxChars),
                count: contextBudget.includedCount
              })
            }}
          </span>
        </div>
        <div v-if="contextBudget.overBudget" class="budget-warning">
          {{
            t('notebook.source.context.overBudget', {
              count: droppedTitles.length,
              titles: droppedTitles.join('、')
            })
          }}
        </div>
        <!--
          批量切到摘要档不会顺带生成摘要（那是 N 次模型调用，用户没同意这笔钱），
          所以这里得说清楚：这几条现在送的是正文开头，不是摘要。
        -->
        <div v-if="contextBudget.summaryMissingCount > 0" class="budget-hint">
          {{
            t('notebook.source.context.summaryMissingHint', {
              count: contextBudget.summaryMissingCount
            })
          }}
        </div>
      </div>

      <div class="source-list filled-list" @click.self="$emit('click-empty')">
        <div
          v-for="source in sources"
          :key="source.id"
          class="source-item"
          :class="{
            active: source.id === activeId,
            loading: source.loading,
            error: !!source.error,
            unselected: !isSourceSelected(source.id)
          }"
          @click.stop="!source.loading && $emit('select', source)"
          @mouseenter="hoveredSourceId = source.id"
          @mouseleave="hoveredSourceId = null"
        >
          <!-- 左侧图标区域：hover 时显示 checkbox -->
          <div class="source-icon-area" @click.stop="toggleSourceSelection(source.id)">
            <AppCheckbox
              v-if="hoveredSourceId === source.id || isSourceSelected(source.id)"
              :checked="isSourceSelected(source.id)"
              class="source-checkbox"
            />
            <component :is="getIcon(source.type)" v-else class="source-icon-inner" />
          </div>

          <div class="source-info">
            <div class="source-title">{{ source.title || t('notebook.source.loading') }}</div>
            <div class="source-meta">
              <span
                v-if="source.loading"
                class="loading-meta"
                :title="getSourceLoadingLabel(source)"
                >{{ getSourceLoadingLabel(source) }}</span
              >
              <span v-else-if="source.error" class="error-text" :title="source.error">{{
                source.error
              }}</span>
              <span v-else>{{ getSourceTypeLabel(source) }}</span>
              <span
                v-if="getSourceIndexStatus(source)"
                class="index-status"
                :class="getSourceIndexStatus(source)?.className"
                :title="getSourceIndexStatus(source)?.title"
              >
                <PhCircleNotch
                  v-if="getSourceIndexStatus(source)?.spinning"
                  class="index-status-icon"
                />
                {{ getSourceIndexStatus(source)?.label }}
              </span>
              <!--
                档位徽章。排除掉的来源不显示 —— 勾选框已经说明白了，
                再挂一个「不进上下文」只是把同一句话说两遍。
              -->
              <span
                v-if="isSourceSelected(source.id)"
                class="context-level"
                :class="[
                  getContextLevel(source),
                  { pending: isSummaryPending(source), failed: isSummaryFailed(source) }
                ]"
                :title="t('notebook.source.context.badgeHint')"
                @click.stop="toggleContextLevel(source)"
              >
                <PhCircleNotch v-if="isSummaryPending(source)" class="index-status-icon" />
                {{
                  getContextLevel(source) === 'summary'
                    ? isSummaryPending(source)
                      ? t('notebook.source.context.summarizing')
                      : isSummaryFailed(source)
                        ? t('notebook.source.context.summaryUnavailable')
                        : t('notebook.source.context.summary')
                    : t('notebook.source.context.full')
                }}
              </span>
            </div>
          </div>

          <!-- Retry Button (Visible on Error) -->
          <div v-if="source.error" class="retry-btn" @click.stop="$emit('retry', source.id)">
            <PhArrowClockwise />
          </div>

          <!-- More 下拉菜单 (替代原来的 delete-btn) -->
          <AppDropdown
            :trigger="['click']"
            placement="bottomRight"
            :open="openMenuSourceId === source.id"
            @update:open="(open: boolean) => (openMenuSourceId = open ? source.id : null)"
          >
            <div class="more-btn" :class="{ open: openMenuSourceId === source.id }" @click.stop>
              <PhDotsThree />
            </div>
            <template #overlay>
              <AppMenu>
                <AppMenuItem
                  key="level-full"
                  item-key="level-full"
                  @click="setContextLevel(source, 'full')"
                >
                  {{ getContextLevel(source) === 'full' ? '✓ ' : '' }}
                  {{ t('notebook.source.context.full') }}
                </AppMenuItem>
                <AppMenuItem
                  key="level-summary"
                  item-key="level-summary"
                  @click="setContextLevel(source, 'summary')"
                >
                  {{ getContextLevel(source) === 'summary' ? '✓ ' : '' }}
                  {{ t('notebook.source.context.summary') }}
                </AppMenuItem>
                <AppMenuItem
                  key="level-excluded"
                  item-key="level-excluded"
                  @click="setContextLevel(source, 'excluded')"
                >
                  {{ getContextLevel(source) === 'excluded' ? '✓ ' : '' }}
                  {{ t('notebook.source.context.excluded') }}
                </AppMenuItem>
                <AppMenuItem key="rename" item-key="rename" @click="openRenameModal(source)">
                  <PhPencilSimple /> {{ t('notebook.source.rename') }}
                </AppMenuItem>
                <AppMenuItem
                  key="delete"
                  item-key="delete"
                  danger
                  @click="$emit('remove', source.id)"
                >
                  <PhTrash /> {{ t('common.delete') }}
                </AppMenuItem>
              </AppMenu>
            </template>
          </AppDropdown>

          <!-- 右侧加载状态 -->
          <div v-if="source.loading" class="source-loading-status">
            <PhCircleNotch class="spinning-icon" />
          </div>
        </div>
      </div>
    </template>

    <!-- 重命名弹窗 -->
    <AppModal
      v-model:open="renameModalVisible"
      :title="t('notebook.source.renameTitle')"
      @ok="confirmRename"
    >
      <a-input
        v-model:value="renameNewTitle"
        :placeholder="t('notebook.source.renamePlaceholder')"
        @press-enter="confirmRename"
      />
    </AppModal>

    <!-- Recall Results Modal -->
    <AppModal
      v-model:open="showRecallResults"
      :title="t('notebook.source.recallModalTitle')"
      hide-footer
      width="600px"
      :body-style="{ padding: '20px', maxHeight: '600px', overflowY: 'auto' }"
    >
      <div class="recall-results">
        <div v-for="(result, index) in recallResults" :key="index" class="recall-item">
          <div class="recall-header">
            <span class="recall-score">
              <template v-if="result.distance == null">
                {{ t('notebook.source.recallKeywordHit') }}
              </template>
              <template v-else>
                {{ t('notebook.source.recallDistance') }}: {{ Number(result.distance).toFixed(4) }}
              </template>
            </span>
            <span class="recall-source"
              >{{ t('notebook.source.recallSource') }}: {{ result.sourceTitle || 'Unknown' }}</span
            >
          </div>
          <div class="recall-content">{{ result.content }}</div>
        </div>
        <div v-if="recallResults.length === 0" class="no-results">
          {{ t('notebook.source.recallNoResult') }}
        </div>
      </div>
    </AppModal>
  </div>
</template>

<style scoped lang="less">
.note-source-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg-surface); // Need dark bg
  padding: 16px;
  /* Removed hardcoded min-width to allow parent resizer to control it */
}

.panel-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 20px;

  .actions {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  /* 训练按钮右边那个小箭头：视觉上跟按钮连成一体，不抢它的注意力 */
  .train-options-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 28px;
    padding: 0;
    border-radius: 14px;
    background: transparent;
    border: 1px solid transparent;
    color: var(--color-text-muted);
    cursor: pointer;
    transition: all 0.2s;

    &:hover {
      background: var(--color-bg-surface-hover);
      border-color: var(--color-border);
      color: var(--color-text-primary);
    }
  }

  .train-btn {
    height: 28px;
    border-radius: 14px;
    background: var(--color-bg-surface-hover);
    border: 1px solid var(--color-border);
    color: var(--color-text-primary);
    font-size: 12px;
    transition: all 0.3s ease;

    &:hover {
      background: var(--color-bg-surface-hover);
      border-color: var(--color-border-strong);
      color: var(--color-text-primary);
    }

    /* 警告状态：来源有变动但尚未训练 */
    &.warning {
      background: var(--color-warning-bg);
      border-color: var(--color-warning-border);
      color: var(--color-warning-text);

      &:hover {
        background: var(--color-warning-bg);
        border-color: var(--color-warning-border);
        color: var(--color-warning-text);
      }
    }
  }

  .title {
    font-size: 16px;
    font-weight: 500;
  }
}

.add-source-area {
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding-bottom: 24px;
  border-radius: 12px;
  border: 2px dashed transparent;
  transition: all 0.3s ease;
  padding: 12px;
  margin: -12px;
  margin-bottom: 0;

  &.drag-over {
    border-color: var(--color-accent-border);
    background: var(--color-accent-bg);
  }
}

.main-add-btn {
  border-radius: 20px;
  height: 40px;
  border: 1px solid var(--color-border);
  background: transparent;
  color: var(--color-text-primary);

  &:hover {
    background: var(--color-bg-surface-hover);
    border-color: var(--color-border-strong);
  }
}

.add-note-btn {
  border-radius: 20px;
  height: 40px;
  background: white;
  color: black;
  border: none;
  font-weight: 500;
  margin-top: -4px; // Slight adjustment to group with the button above
  border: 1px solid var(--color-border);

  &:hover {
    background: #e0e0e0;
    color: black;
  }
}

.source-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  overflow-y: auto;

  &.empty-container {
    justify-content: flex-end;
  }

  &.filled-list {
    justify-content: flex-start;
    gap: 8px;
  }

  .source-item {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px;
    background: var(--color-bg-surface-hover);
    border-radius: 8px;
    cursor: pointer;
    transition: all 0.2s;
    width: 100%;
    box-sizing: border-box;
    min-height: 58px; // 保持与其他项高度一致

    &:hover {
      background: var(--color-bg-surface-hover);
    }

    &.active {
      background: var(--color-bg-selected);

      .source-icon {
        color: var(--color-text-selected);
      }

      .source-title {
        color: var(--color-text-primary);
        font-weight: 500;
      }
    }

    // 加载中状态
    &.loading {
      cursor: wait;
      background: var(--color-bg-surface-hover);
      border: 1px solid var(--color-border-subtle);

      .source-icon {
        color: var(--color-text-muted);
      }

      .loading-meta {
        color: var(--color-text-primary);
      }

      .source-title {
        color: var(--color-text-primary);
      }
    }

    // 右侧加载状态图标
    .source-loading-status {
      margin-left: auto;
      display: flex;
      align-items: center;
      padding-right: 4px;

      .spinning-icon {
        color: var(--color-accent-text);
        font-size: 16px;
        animation: spin 1s linear infinite;
      }
    }

    // 错误状态
    &.error {
      border: 1px solid var(--color-danger-border);
      background: var(--color-danger-bg);

      .error-text {
        color: var(--color-danger-text);
      }
    }

    .source-icon {
      color: var(--color-accent-text);
      font-size: 18px;
    }

    .source-info {
      flex: 1 1 0; // 强制占据剩余空间
      min-width: 0; // 允许 flex 子元素缩小，防止溢出
      overflow: hidden;

      .source-title {
        font-size: 13px;
        color: var(--color-text-primary);
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        margin-bottom: 2px;
        width: 100%;
        transition: color 0.2s;
      }

      .source-meta {
        font-size: 11px;
        color: var(--color-text-primary);
        text-transform: capitalize;
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;

        > span:first-child {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        // 失败原因是一整句「去哪配」的指路，一行省略号正好把路切掉。
        // 放到三行，完整那句挂在 title 上。
        // `overflow: hidden` 写在自己这条：line-clamp 要靠它才会裁，
        // 指望上面那条 `> span:first-child` 带过来的话，`.source-meta` 里哪天插进
        // 一个前置 span，截断就静默失效
        > span.error-text {
          display: -webkit-box;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 3;
          white-space: normal;
          overflow: hidden;
        }

        .index-status {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          max-width: 64px;
          padding: 1px 5px;
          border-radius: 4px;
          font-size: 10px;
          line-height: 16px;
          white-space: nowrap;
          text-transform: none;

          &.indexed {
            color: var(--color-success-text);
            background: var(--color-success-bg);
          }

          &.indexing,
          &.pending {
            color: var(--color-accent-text);
            background: var(--color-accent-bg);
          }

          &.keyword {
            color: var(--color-warning-text);
            background: var(--color-warning-bg);
          }

          &.error {
            color: var(--color-danger-text);
            background: var(--color-danger-bg);
          }
        }

        .index-status-icon {
          font-size: 10px;
          animation: spin 1s linear infinite;
        }

        // 档位徽章。点一下在全文和摘要之间切
        .context-level {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          padding: 1px 5px;
          border-radius: 4px;
          font-size: 10px;
          line-height: 16px;
          white-space: nowrap;
          text-transform: none;
          cursor: pointer;
          transition: all 0.2s;

          &.full {
            color: var(--color-text-muted);
            background: var(--color-bg-surface);
          }

          &.summary {
            color: var(--color-accent-text);
            background: var(--color-accent-bg);
          }

          &.pending {
            color: var(--color-accent-text);
            background: var(--color-accent-bg);
          }

          &.failed {
            color: var(--color-warning-text);
            background: var(--color-warning-bg);
          }

          &:hover {
            filter: brightness(1.15);
          }
        }
      }
    }

    // 不进上下文：整条压下去。这一条现在是个真状态（AI 看不到它），
    // 得让人扫一眼就看出来，不能和进上下文的长得一样
    &.unselected {
      opacity: 0.55;

      .source-title {
        color: var(--color-text-muted);
      }

      .source-icon-inner {
        color: var(--color-text-muted);
      }
    }
  }
}

// 来源列表 Header - 全选/取消全选
.source-list-header {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--color-border-subtle);
  margin-bottom: 8px;

  .select-all-label {
    font-size: 12px;
    color: var(--color-text-primary);
  }

  .selected-count-label {
    margin-left: auto;
    font-size: 12px;
    color: var(--color-text-primary);
  }

  .bulk-level-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    margin-left: 8px;
    border-radius: 4px;
    color: var(--color-text-muted);
    cursor: pointer;
    transition: all 0.2s;

    &:hover {
      background: var(--color-bg-surface-hover);
      color: var(--color-text-primary);
    }
  }

  :deep(.app-checkbox) {
    color: var(--color-text-primary);
  }
}

// 上下文预算计量条
.context-budget {
  padding: 0 12px 10px;
  margin-bottom: 4px;

  .budget-bar {
    height: 3px;
    border-radius: 2px;
    background: var(--color-bg-surface);
    overflow: hidden;
  }

  .budget-fill {
    height: 100%;
    border-radius: 2px;
    background: var(--color-accent-text);
    transition: width 0.25s ease;
  }

  .budget-text {
    margin-top: 6px;
    font-size: 11px;
    color: var(--color-text-muted);
  }

  .budget-warning {
    margin-top: 4px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--color-warning-text);
  }

  .budget-hint {
    margin-top: 4px;
    font-size: 11px;
    line-height: 1.5;
    color: var(--color-text-muted);
  }

  &.over {
    .budget-fill {
      background: var(--color-warning-text);
    }

    .budget-text {
      color: var(--color-warning-text);
    }
  }
}

// 来源图标区域 - hover 时显示 checkbox
.source-icon-area {
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;

  .source-icon-inner {
    color: var(--color-accent-text);
    font-size: 18px;
    transition: color 0.2s;
  }
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.retry-btn {
  display: none;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--color-text-primary);
  transition: all 0.2s;
  margin-left: 4px;

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }
}

// More 下拉按钮 (替代原来的 delete-btn)
.more-btn {
  display: none;
  width: 24px;
  height: 24px;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  color: var(--color-text-primary);
  transition: all 0.2s;
  margin-left: 4px;
  cursor: pointer;

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);
  }
}

.source-item:hover .more-btn,
.source-item:hover .retry-btn,
/* 菜单开着就一直显示：鼠标移到菜单上时这一行已经不 hover 了 */
.more-btn.open {
  display: flex;
}

.recall-results {
  .recall-item {
    margin-bottom: 16px;
    padding: 12px;
    background: var(--color-bg-surface);
    border: 1px solid var(--color-border);
    border-radius: 8px;

    .recall-header {
      display: flex;
      justify-content: space-between;
      font-size: 12px;
      color: var(--color-text-secondary, rgba(255, 255, 255, 0.5));
      margin-bottom: 8px;
      border-bottom: 1px solid var(--color-border);
      padding-bottom: 4px;
    }

    .recall-content {
      font-size: 14px;
      color: var(--color-text-primary, rgba(255, 255, 255, 0.9));
      white-space: pre-wrap;
      line-height: 1.5;
    }
  }

  .no-results {
    text-align: center;
    color: var(--color-text-secondary, rgba(255, 255, 255, 0.5));
    padding: 20px;
  }
}
</style>
