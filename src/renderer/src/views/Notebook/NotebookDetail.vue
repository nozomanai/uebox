<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import {
  ref,
  onUnmounted,
  watch,
  computed,
  onMounted,
  onActivated,
  onDeactivated,
  nextTick
} from 'vue'
import { debounce } from 'lodash'
import { useI18n } from 'vue-i18n'
defineOptions({ name: 'NotebookDetail' })
import { useRouter, useRoute } from 'vue-router'
import { PhArrowLeft, PhChatCircle, PhGear } from '@phosphor-icons/vue'
import { message } from '@renderer/utils/messageManager'
import NoteSourcePanel from './components/NoteSourcePanel.vue'
import AssistantWelcome from '@renderer/views/Assistant/Welcome.vue'
import NoteEditor from '@renderer/views/NoteEditor.vue'
import NoteStudioPanel from './components/NoteStudioPanel.vue'
import AddSourceModal from './components/AddSourceModal.vue'
import SourcePreviewPanel from './components/SourcePreviewPanel.vue'
import noteAPI from '../../api/note'
import { provide } from 'vue'
import type { EditableNote } from './utils/noteStore'
import { useNotebookStore, type SourceItem } from '@renderer/store/modules/notebookStore'
import { useTabsStore } from '@renderer/store/modules/tabs'
import { getTabCacheKey, getTabIdFromQuery } from '@renderer/common/tabRoute'
import { useChatMessagesStore } from '@renderer/store/modules/chatMessages'
import { useStudioOutputStore, type StudioOutput } from '@renderer/store/modules/studioOutputStore'
import {
  shouldCleanWebContent,
  cleanWebContent
} from '@renderer/services/notebookContent/SourceSummarizer'
import { getFormattedErrorMessage } from '@renderer/utils/errorMessage'
import { buildNotebookListRoute } from '@renderer/views/Notebook/utils/notebookTabRoute'
import { isBilibiliVideoUrl } from '@core/shared/bilibiliUrl'

const router = useRouter()
const route = useRoute()
const notebookStore = useNotebookStore()
const tabsStore = useTabsStore()
const chatMsgStore = useChatMessagesStore()
const studioOutputStore = useStudioOutputStore()
const { t } = useI18n()

/**
 * 当前知识库 ID
 */
const notebookId = computed(() => route.params.id as string)
const notebookTabId = computed(() => getTabIdFromQuery(route.query))

/**
 * 当前知识库里那条对话的消息
 */
const chatMessages = computed(() => chatMsgStore.getMessages(`notebook-chat-${notebookId.value}`))

const notebookTitle = ref(t('notebook.detail.newNotebook'))
const showAddSourceModal = ref(false)
const isEditingTitle = ref(false)
const titleDraft = ref('')
const isSavingTitle = ref(false)
const isTraining = ref(false)
let titleInputEl: HTMLInputElement | null = null
let loadNotebookRequestId = 0

const syncNotebookTabTitle = (): void => {
  const title = notebookTitle.value.trim()
  if (!title) return

  const updated = tabsStore.updateTabTitleByPath(getTabCacheKey(route), title)
  if (updated) return

  void nextTick(() => {
    tabsStore.updateTabTitleByPath(getTabCacheKey(route), title)
  })
}

watch(
  () => notebookTitle.value,
  () => syncNotebookTabTitle(),
  { immediate: true }
)

const setTitleInputRef = (el: unknown): void => {
  titleInputEl = el as HTMLInputElement | null
}

const startEditTitle = (): void => {
  if (isEditingTitle.value) return
  titleDraft.value = notebookTitle.value
  isEditingTitle.value = true
  nextTick(() => {
    if (titleInputEl) {
      titleInputEl.focus()
      titleInputEl.select()
    }
  })
}

const cancelEditTitle = (): void => {
  isEditingTitle.value = false
  titleDraft.value = ''
}

const submitTitle = async (): Promise<void> => {
  if (!isEditingTitle.value || isSavingTitle.value) return
  const trimmed = titleDraft.value.trim()
  if (!trimmed) {
    message.warning(t('notebook.list.renameEmpty'))
    nextTick(() => {
      if (titleInputEl) {
        titleInputEl.focus()
        titleInputEl.select()
      }
    })
    return
  }
  if (trimmed === notebookTitle.value) {
    cancelEditTitle()
    return
  }
  try {
    isSavingTitle.value = true
    if (notebookId.value) {
      await window.api.notebook.update(notebookId.value, { title: trimmed })
      notebookTitle.value = trimmed
      message.success(t('notebook.list.renameSuccess'))
    }
    cancelEditTitle()
  } catch (error) {
    console.error('[NotebookDetail] 重命名失败:', error)
    message.error(t('notebook.list.renameFailed'))
    nextTick(() => {
      if (titleInputEl) {
        titleInputEl.focus()
        titleInputEl.select()
      }
    })
  } finally {
    isSavingTitle.value = false
  }
}

/**
 * 全局重定向标志（模块级，防止多个 KeepAlive 缓存的组件实例并发触发跳转）
 * 使用 window 对象确保跨组件实例共享
 */
const REDIRECT_FLAG_KEY = '__notebook_detail_redirecting__'
const getIsRedirecting = (): boolean =>
  (window as unknown as Record<string, unknown>)[REDIRECT_FLAG_KEY] === true
const setIsRedirecting = (value: boolean): void => {
  ;(window as unknown as Record<string, unknown>)[REDIRECT_FLAG_KEY] = value
}

/**
 * 已记录过警告的 ID 集合（避免同一 ID 多次重复打印日志）
 */
const WARNED_IDS_KEY = '__notebook_detail_warned_ids__'
const getWarnedIds = (): Set<string> => {
  const existing = (window as unknown as Record<string, unknown>)[WARNED_IDS_KEY]
  if (existing instanceof Set) return existing
  const newSet = new Set<string>()
  ;(window as unknown as Record<string, unknown>)[WARNED_IDS_KEY] = newSet
  return newSet
}

/** route 是 Layout 为本 tab 冻结的路由，它的 cache key 就是本 tab 的 key */
const isOwnTabInFront = (): boolean =>
  getTabCacheKey(router.currentRoute.value) === getTabCacheKey(route)

/**
 * 恢复中断的分析任务
 * 当页面刷新后，如果有来源处于 loading 状态但没有内容，说明分析被中断，需要重新分析
 * 注意：主进程会自动对相同 URL 进行去重，同一个视频不会重复提交分析任务
 * 支持的类型：bilibili, youtube
 * @param targetNotebookId 知识库 ID
 */
const resumeInterruptedAnalysisTasks = (targetNotebookId: string): void => {
  const currentSources = notebookStore.sourcesOf(targetNotebookId)

  const interruptedSources = currentSources.filter((source) => {
    if (source.loading !== true || source.error) return false
    if (source.content && source.content.trim().length > 0) return false

    if (source.type === 'file') {
      return !!source.filePath
    }

    if (source.type === 'link' || source.type === 'bilibili' || source.type === 'youtube') {
      return !!source.sourceUrl
    }

    return false
  })

  if (interruptedSources.length === 0) {
    return
  }

  console.log(`[NotebookDetail] Resuming ${interruptedSources.length} interrupted source tasks`)

  interruptedSources.forEach((source) => {
    const sourceRef = source.filePath || source.sourceUrl || source.title
    console.log(`[NotebookDetail] Resuming source task: ${source.type} - ${sourceRef}`)

    retrySource(source.id).catch((error) => {
      console.error('[NotebookDetail] Failed to resume source task:', error)
      notebookStore.updateSource(targetNotebookId, source.id, {
        loading: false,
        error: error instanceof Error ? error.message : 'Resume failed'
      })
    })
  })
}

/**
 * 加载知识库详情和来源数据
 * 如果知识库不存在（如数据库被删除），自动跳转回列表页
 */
const loadNotebookData = async (id: string): Promise<void> => {
  if (!id) return
  const requestId = ++loadNotebookRequestId

  /*
   * 产出（脑图、报告、知识网页…）从保管库读回来。
   *
   * 它们原来整包存在 localStorage 里：配额几 MB，一张信息图的 base64 就几百 KB，
   * 写满之后新产出静默存不上；而且拷不走、备份不到，换台机器就没了。
   * 这一步顺带把老用户 localStorage 里那份搬进保管库（先写盘、写成了才清旧的）。
   */
  void studioOutputStore.loadNotebook(id)

  // 防止重复跳转（使用全局标志）
  if (getIsRedirecting()) return

  // 加载知识库基本信息并验证存在性
  try {
    const notebook = await window.api.notebook.get(id)
    if (requestId !== loadNotebookRequestId || notebookId.value !== id) return
    if (!notebook) {
      // 不在前台时先不处理：切回本 tab 时 onActivated 会重新加载，届时仍不存在再跳转
      if (!isOwnTabInFront()) return
      // 知识库不存在，清理状态并跳转回列表页
      // 只在首次遇到该 ID 时打印警告
      const warnedIds = getWarnedIds()
      if (!warnedIds.has(id)) {
        warnedIds.add(id)
        console.warn(`[NotebookDetail] 知识库 ${id} 不存在，跳转回列表页`)
      }

      if (!getIsRedirecting()) {
        setIsRedirecting(true)
        notebookStore.clearActiveNotebook(notebookTabId.value)
        router.replace(buildNotebookListRoute(notebookTabId.value)).finally(() => {
          setIsRedirecting(false)
        })
      }
      return
    }
    notebookTitle.value = notebook.title
  } catch (error) {
    if (requestId !== loadNotebookRequestId || notebookId.value !== id) return
    console.error('[NotebookDetail] 加载知识库信息失败:', error)
    // 不在前台时先不处理：切回本 tab 时 onActivated 会重新加载，届时仍不存在再跳转
    if (!isOwnTabInFront()) return
    // 发生错误也跳转回列表页
    if (!getIsRedirecting()) {
      setIsRedirecting(true)
      notebookStore.clearActiveNotebook(notebookTabId.value)
      router.replace(buildNotebookListRoute(notebookTabId.value)).finally(() => {
        setIsRedirecting(false)
      })
    }
    return
  }

  // activeNotebookId 不在这里设置，由 NotebookLayout 按本 tab 的路由记录

  // 加载来源数据
  await notebookStore.loadSources(id)
  if (requestId !== loadNotebookRequestId || notebookId.value !== id) return

  // 恢复中断的分析任务（页面刷新后 loading 状态的来源需要重新分析）
  resumeInterruptedAnalysisTasks(id)
}

// 来源正文的生命周期跟随本页面实例：被 keep-alive 缓存期间仍算持有，
// 只有真正卸载（返回列表、关闭 tab、被挤出 keep-alive 缓存）时才释放。
// 先登记持有再加载：loadSources 只为有人持有的笔记本加载。
// route 是 NotebookLayout 为本 tab 冻结的路由，切到别的 tab 时不会变化
let heldNotebookId: string | null = null
watch(
  notebookId,
  (id) => {
    if (heldNotebookId) notebookStore.releaseSources(heldNotebookId)
    heldNotebookId = id || null
    if (heldNotebookId) {
      notebookStore.retainSources(heldNotebookId)
      loadNotebookData(heldNotebookId)
    }
  },
  { immediate: true }
)
onUnmounted(() => {
  if (heldNotebookId) notebookStore.releaseSources(heldNotebookId)
  heldNotebookId = null
  // 卸载后不再发起新的加工：同一笔记本仍被其他 tab 持有时 loadSources 会放行，
  // 否则在途的 loadNotebookData 会继续执行 resumeInterruptedAnalysisTasks → retrySource
  loadNotebookRequestId += 1
})

let wasDeactivated = false
onDeactivated(() => {
  wasDeactivated = true
})
// 从缓存切回前台时刷新：停留在别的 tab 期间可能新增了来源。
// 只处理真正从后台切回的情况：新开 tab 时 activated 也会触发，那一次由上面的 watch 负责加载
onActivated(() => {
  if (!wasDeactivated) return
  wasDeactivated = false
  if (notebookId.value) {
    syncNotebookTabTitle()
    loadNotebookData(notebookId.value)
  }
})

/**
 * 监听 Spotlight 添加来源事件
 * 当用户通过 Spotlight 保存内容到知识库时，刷新来源列表
 */
const handleSpotlightSourceAdded = (event: Event): void => {
  const customEvent = event as CustomEvent<{ notebookId: string; sourceId: string }>
  const { notebookId: targetId } = customEvent.detail
  // 只有当前知识库与目标知识库相同时才刷新
  if (targetId === notebookId.value) {
    console.log('[NotebookDetail] Spotlight 添加来源，刷新列表')
    notebookStore.loadSources(targetId)
  }
}

onMounted(() => {
  window.addEventListener('spotlight:source-added', handleSpotlightSourceAdded)
})

onUnmounted(() => {
  window.removeEventListener('spotlight:source-added', handleSpotlightSourceAdded)
})

/**
 * 从 store 获取当前知识库的来源列表
 * 使用 computed 确保响应式更新
 * 按本页的笔记本获取，而不是按前台 tab：页面在后台缓存时，读到的也是自己的数据
 */
const sources = computed(() => notebookStore.sourcesOf(notebookId.value))

/**
 * 添加来源到当前知识库
 * 只有当来源内容就绪（有内容、不在loading状态、无错误）时才触发向量化
 */
const addSource = (source: SourceItem, targetNotebookId?: string): void => {
  const idToUse = targetNotebookId || notebookId.value
  if (idToUse) {
    notebookStore.addSource(idToUse, source)
    // 标记来源有变动，需要训练
    needsTraining.value = true
    // 只有当来源内容就绪时才触发向量化
    if (isSourceReady(source)) {
      scheduleTrainNotebook(idToUse)
    }
  }
}

/**
 * 检查来源是否内容就绪（可以进行向量化）
 * 条件：有实际内容 + 不在加载中 + 无错误
 */
const isSourceReady = (source: Partial<SourceItem>): boolean => {
  // loading 状态说明内容还在获取中
  if (source.loading) return false
  // 有错误说明内容获取失败
  if (source.error) return false
  // 内容为空说明没有可向量化的数据
  if (!source.content || source.content.trim().length === 0) return false
  return true
}

const isTrainingPending = ref(false)

/**
 * 知识来源是否有变动但尚未训练
 * 当来源发生添加/更新/删除时设置为 true，训练完成后设置为 false
 */
const needsTraining = ref(false)

/**
 * 执行知识库训练核心逻辑
 * 训练状态通过 isTraining 反映在按钮上，不再弹出消息打断用户心流
 */
const performTrainNotebook = async (
  options: { showError?: boolean; targetNotebookId?: string } = {}
): Promise<void> => {
  /*
    索引哪个知识库必须**明确传进来**，不能在这里读当前路由。

    后台那条流水线（清洗 + 读图）要跑 30 到 120 秒，用户完全可能在这期间切到别的
    知识库。读 `notebookId.value` 的话，索引的就是他现在看的那个 —— 刚导入的来源
    永远不会被索引，而另一个库白白重算一遍。链路上每一步都带着 targetNotebookId，
    只有这里漏了。
  */
  const targetId = options.targetNotebookId || notebookId.value
  if (!targetId) return
  const { showError = true } = options

  /*
    用户没在看这个知识库时，只管把索引做掉，不碰界面状态机。

    `isTraining` / `needsTraining` / `isTrainingPending` 描述的是**当前这一页**的
    按钮和提示。给别的库做索引时去改它们，会让用户看到一个跟自己无关的转圈，
    还会把当前库真实的「待训练」提示给清掉。
  */
  if (targetId !== notebookId.value) {
    try {
      await window.api.notebook.ragIndex({ notebookId: targetId })
      console.log(`[NotebookDetail] 后台训练完成（${targetId}）`)
    } catch (error) {
      console.error(`[NotebookDetail] 后台训练失败（${targetId}）:`, error)
    }
    return
  }

  // 如果正在训练，标记为待处理，当前训练结束后会再次触发
  if (isTraining.value) {
    isTrainingPending.value = true
    return
  }

  try {
    isTraining.value = true

    // 使用循环处理可能在训练过程中产生的挂起请求
    do {
      isTrainingPending.value = false
      console.log('[NotebookDetail] 开始训练知识库...')

      const result = await window.api.notebook.ragIndex({ notebookId: targetId })

      if (result.indexedSources > 0 || result.indexedChunks > 0) {
        console.log(
          `[NotebookDetail] 训练完成：${result.indexedSources} 个来源，${result.indexedChunks} 个片段`
        )
      } else {
        console.log('[NotebookDetail] 知识库已是最新')
      }
      // 训练完成后清除警告状态
      needsTraining.value = false
    } while (isTrainingPending.value)
  } catch (error) {
    console.error('[NotebookDetail] RAG train failed:', error)
    const errorMessage = getFormattedErrorMessage(error, '训练失败')
    if (showError) {
      message.error({
        content: errorMessage,
        key: 'notebook-train'
      })
    }
  } finally {
    isTraining.value = false
    isTrainingPending.value = false
  }
}

/**
 * 等着被向量化的知识库 id。
 *
 * 防抖只有一个定时器，但这 10 秒里攒下来的可能不止一个库（往 A 导完接着往 B 导，
 * 或者 A 的后台清洗还在跑、用户已经在 B 里加来源了）。只记一个 id 就会漏掉别的，
 * 所以攒成一个集合，到点一起做。
 */
const pendingTrainNotebookIds = new Set<string>()

/**
 * 防抖的向量化函数（用于导入来源）
 * 无条件执行，不受自动训练开关控制
 * 延迟 10 秒执行，避免频繁触发
 */
const debouncedTrainNotebookForSources = debounce(() => {
  const ids = [...pendingTrainNotebookIds]
  pendingTrainNotebookIds.clear()
  for (const id of ids) {
    void performTrainNotebook({ showError: false, targetNotebookId: id })
  }
}, 10000)

/** 安排某个知识库的向量化。id 必须显式给，别让防抖到点时去猜当前是哪个库 */
const scheduleTrainNotebook = (targetNotebookId: string): void => {
  pendingTrainNotebookIds.add(targetNotebookId)
  debouncedTrainNotebookForSources()
}

/**
 * 编辑笔记后自不自动重新索引。
 *
 * 这个开关原来在「偏好设置 → 知识库」里。它管的是眼前这块面板上那个「训练知识库」
 * 按钮要不要自己按 —— 开关和它管的那个按钮分在两个页面，用户看不出是同一件事。
 * 现在挂在按钮旁边，设置项本身还是同一个 `notebook_auto_train`。
 *
 * 默认关是有意的：重新索引要把改过的内容重新嵌入一遍，云端模型按量计费。
 */
const autoTrainEnabled = ref(false)

// 用可选链取：这一句在 setup 阶段就跑，而单元测试里的 window.api 桩件
// 只铺了自己要用的那几块，settings 常常不在里面
void Promise.resolve(window.api?.settings?.get('notebook_auto_train', false))
  .then((enabled) => {
    autoTrainEnabled.value = !!enabled
  })
  .catch((error) => {
    console.warn('[NotebookDetail] 读取自动索引开关失败，按关闭处理:', error)
  })

const handleAutoTrainChange = async (enabled: boolean): Promise<void> => {
  autoTrainEnabled.value = enabled
  try {
    await window.api.settings.set('notebook_auto_train', enabled)
  } catch (error) {
    console.error('[NotebookDetail] 保存自动索引开关失败:', error)
  }
}

/**
 * 防抖的自动训练函数（仅用于笔记编辑）
 * 受上面那个开关控制，延迟 10 秒执行，避免频繁触发
 */
const debouncedTrainNotebook = debounce(() => {
  if (autoTrainEnabled.value) {
    performTrainNotebook({ showError: false })
  }
}, 10000)

/**
 * 手动触发训练（立即执行）
 */
const handleTrainNotebook = (): void => {
  performTrainNotebook()
}

/**
 * 打开设置页面
 */
const openSettings = (): void => {
  router.push('/preferences?tab=notebook')
}

/**
 * 更新指定来源
 * 如果更新后来源内容就绪（导入完成、内容刷新等场景），则触发向量化
 *
 * @param options.deferTraining 这次先别向量化。用于「正文马上还要被后台清洗覆盖」
 *   的场景：不推迟的话同一个网页会被向量化两次（先原文、几十秒后再清洗后的），
 *   花的是用户自己的 embedding 额度。
 */
const updateSource = (
  sourceId: string,
  updates: Partial<SourceItem>,
  targetNotebookId?: string,
  options: { deferTraining?: boolean } = {}
): void => {
  const idToUse = targetNotebookId || notebookId.value
  if (idToUse) {
    notebookStore.updateSource(idToUse, sourceId, updates)
    // 标记来源有变动，需要训练
    needsTraining.value = true

    if (options.deferTraining) return

    // 检查更新后的来源状态，只有内容就绪时才触发向量化
    // 页面已卸载、来源已释放时，缓存中没有这条来源。
    // 就绪判断基于缓存中的数据加上本次更新，这样后台加工完成后仍会照常向量化
    const updatedSource = { ...(notebookStore.getSource(idToUse, sourceId) ?? {}), ...updates }
    if (isSourceReady(updatedSource)) {
      scheduleTrainNotebook(idToUse)
    }
  }
}

/** 当前预览的来源 */
const currentPreviewSource = ref<SourceItem | null>(null)

// Provide open method to child components
const openAddSource = (): void => {
  showAddSourceModal.value = true
}
provide('openAddSource', openAddSource)

/**
 * 打开笔记编辑器创建新笔记
 */
const openNoteEditor = (): void => {
  currentNoteId.value = undefined
  isAutoCreate.value = true
  currentView.value = 'note-editor'
  currentPreviewSource.value = null
}
provide('openNoteEditor', openNoteEditor)

/**
 * 移除来源
 * 注意：删除来源时不需要触发向量化训练
 * 相关的向量数据会在主进程的 deleteSource 中被同步删除
 */
const removeSource = (sourceId: string): void => {
  if (notebookId.value) {
    // 如果删除的是当前正在预览的来源，则清除预览
    if (currentPreviewSource.value && currentPreviewSource.value.id === sourceId) {
      currentPreviewSource.value = null
      currentView.value = 'assistant'
    }
    notebookStore.removeSource(notebookId.value, sourceId)
    // 标记来源有变动，需要训练
    needsTraining.value = true
  }
}

/**
 * 重命名来源
 * @param sourceId 来源 ID
 * @param newTitle 新标题
 */
const renameSource = (sourceId: string, newTitle: string): void => {
  if (notebookId.value) {
    notebookStore.updateSource(notebookId.value, sourceId, { title: newTitle })
  }
}

/**
 * 处理 Web 搜索结果添加为来源
 * @param url 网页 URL
 * @param title 网页标题
 */
const handleAddWebSource = (url: string, title: string): void => {
  handleAddSource({
    type: 'link',
    title: title || url,
    content: '',
    sourceUrl: url,
    loading: true
  })
}

/**
 * 重试加载失败的来源
 * @param sourceId 来源 ID
 */
const loadDocxWithVision = async (
  filePath: string,
  targetNotebookId: string
): Promise<{ success: boolean; content?: string; error?: string }> => {
  const result = await window.api.documentLoader.loadWithImages(filePath, {
    notebookId: targetNotebookId
  })

  if (!result.success || !result.content) {
    return {
      success: false,
      error: result.error || '加载失败'
    }
  }

  let finalContent = result.content
  const extractedImages = result.metadata?.images as string[] | undefined

  if (extractedImages && extractedImages.length > 0) {
    const imageDescriptions: Map<string, string> = new Map()

    for (let i = 0; i < extractedImages.length; i++) {
      const imgPath = extractedImages[i]

      try {
        const visionRes = await window.api.vision.analyzeDocumentImage({
          imagePath: imgPath
        })

        if (visionRes.success && visionRes.description) {
          imageDescriptions.set(imgPath, `\n\n> 🖼 **图片**: ${visionRes.description}\n`)
        } else {
          imageDescriptions.set(imgPath, '[图片识别失败]')
        }
      } catch {
        imageDescriptions.set(imgPath, '[图片识别失败]')
      }
    }

    for (const [imgPath, description] of imageDescriptions) {
      const escapedPath = imgPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const regex = new RegExp(`!\\[[^\\]]*\\]\\(${escapedPath}\\)`, 'g')
      finalContent = finalContent.replace(regex, description)
    }
  }

  return {
    success: true,
    content: finalContent
  }
}

const retrySource = async (sourceId: string): Promise<void> => {
  // 捕获当前的 notebookId，避免在异步操作过程中切换页面导致状态混乱
  const currentNotebookId = notebookId.value
  if (!currentNotebookId) return

  let source = sources.value.find((s) => s.id === sourceId)
  if (!source) return

  // 自动检测 YouTube URL 并切换类型 (针对 link 类型)
  if (source.type === 'link' && source.sourceUrl) {
    try {
      const urlObj = new URL(source.sourceUrl)
      const isYoutube =
        urlObj.hostname === 'www.youtube.com' ||
        urlObj.hostname === 'youtube.com' ||
        urlObj.hostname === 'youtu.be' ||
        urlObj.hostname === 'm.youtube.com'

      if (isYoutube) {
        console.log('[NotebookDetail] Retry: Detected YouTube URL, switching type to youtube')
        // 更新 store 中的类型
        updateSource(sourceId, { type: 'youtube' }, currentNotebookId)
        // 重新获取 source 以确保类型最新 (防止 store 更新导致引用陈旧)
        // 注意：这里仍然依赖 sources.value，这通常是响应式的。即便切换页面，只要 store 没变，sources 还是对的。
        // 但如果切换了 notebook，sources.value 会变。所以最好重新从 store 获取或者基于 id 查找
        const updatedSource = notebookStore.getSource(currentNotebookId, sourceId)
        if (updatedSource) {
          source = updatedSource
        }
      }
    } catch {
      // Ignore
    }
  }

  // 再次检查 source 是否存在，满足 TS 检查
  if (!source) return

  // 清除错误状态，设置为加载中
  updateSource(sourceId, { loading: true, error: null }, currentNotebookId)

  // 根据来源类型重新加载
  if (source.type === 'link' && source.sourceUrl) {
    try {
      const pageResult = await window.api.webRead.read(source.sourceUrl)
      if (pageResult.success && pageResult.content) {
        updateSource(
          sourceId,
          {
            title: pageResult.title || source.title,
            content: pageResult.content,
            loading: false,
            error: null
          },
          currentNotebookId
        )
      } else {
        updateSource(
          sourceId,
          {
            loading: false,
            error: pageResult.error || '读取网页内容失败'
          },
          currentNotebookId
        )
      }
    } catch (error) {
      updateSource(
        sourceId,
        {
          loading: false,
          error: error instanceof Error ? error.message : '重试失败'
        },
        currentNotebookId
      )
    }
  } else if (source.type === 'youtube' && source.sourceUrl) {
    try {
      // 这里的 authToken 是可选的，因为是在 retry 中
      const ytResult = await window.api.youtube.analyze({
        url: source.sourceUrl
      })
      if (ytResult.success && ytResult.content) {
        updateSource(
          sourceId,
          {
            title: ytResult.title || source.title,
            content: ytResult.content,
            loading: false,
            error: null
          },
          currentNotebookId
        )
      } else {
        updateSource(
          sourceId,
          {
            loading: false,
            error: ytResult.error || '分析 YouTube 视频失败'
          },
          currentNotebookId
        )
      }
    } catch (error) {
      updateSource(
        sourceId,
        {
          loading: false,
          error: error instanceof Error ? error.message : '重试失败'
        },
        currentNotebookId
      )
    }
  } else if (source.type === 'bilibili' && source.sourceUrl) {
    // Bilibili 视频类型重试
    try {
      const biliResult = await window.api.bilibili.analyze({
        url: source.sourceUrl
      })
      if (biliResult.success && biliResult.content) {
        updateSource(
          sourceId,
          {
            // 标题来自 `bilibili:fetchInfo` 那一步，分析本身不再回标题
            title: source.title,
            content: biliResult.content,
            loading: false,
            error: null
          },
          currentNotebookId
        )
      } else {
        updateSource(
          sourceId,
          {
            loading: false,
            error: biliResult.error || '分析 Bilibili 视频失败'
          },
          currentNotebookId
        )
      }
    } catch (error) {
      updateSource(
        sourceId,
        {
          loading: false,
          error: error instanceof Error ? error.message : '重试失败'
        },
        currentNotebookId
      )
    }
  } else if (source.type === 'file' && source.filePath) {
    // 文件类型重试：根据文件扩展名判断处理方式
    const ext = source.filePath.toLowerCase().split('.').pop() || ''
    const imageExts = [
      'jpg',
      'jpeg',
      'png',
      'gif',
      'bmp',
      'webp',
      'ico',
      'tif',
      'tiff',
      'heic',
      'heif',
      'jp2'
    ]
    const videoExts = ['mp4', 'avi', 'mov', 'mkv', 'wmv', 'flv', 'webm', 'm4v', '3gp']
    const audioExts = ['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac', 'wma', 'opus', 'aiff', 'ape']

    if (imageExts.includes(ext)) {
      // 图片类型：重新进行视觉识别
      processVisionFile(sourceId, source.filePath, 'image', currentNotebookId)
    } else if (videoExts.includes(ext)) {
      // 视频类型：重新进行视觉识别
      processVisionFile(sourceId, source.filePath, 'video', currentNotebookId)
    } else if (audioExts.includes(ext)) {
      updateSource(
        sourceId,
        {
          content: source.content || String(t('notebook.source.audioAttachment')),
          loading: false,
          error: null
        },
        currentNotebookId
      )
    } else {
      // 文档类型：重新加载文档
      try {
        const result =
          ext === 'docx'
            ? await loadDocxWithVision(source.filePath, currentNotebookId)
            : await window.api.documentLoader.load(source.filePath)
        if (result.success && result.content) {
          updateSource(
            sourceId,
            {
              content: result.content,
              loading: false,
              error: null
            },
            currentNotebookId
          )
        } else {
          updateSource(
            sourceId,
            {
              loading: false,
              error: result.error || '重新加载文档失败'
            },
            currentNotebookId
          )
        }
      } catch (error) {
        updateSource(
          sourceId,
          {
            loading: false,
            error: error instanceof Error ? error.message : '重试失败'
          },
          currentNotebookId
        )
      }
    }
  } else {
    updateSource(
      sourceId,
      {
        loading: false,
        error: '不支持重试此类型的来源'
      },
      currentNotebookId
    )
  }
}

import MindmapViewer from './components/MindmapViewer.vue'
import ReportViewer from './components/ReportViewer.vue'
import KnowledgeGraphViewer from './components/KnowledgeGraphViewer.vue'
import MockInterviewViewer from './components/MockInterviewViewer.vue'
import InfographicViewer from './components/InfographicViewer.vue'
import WebPageViewer from './components/WebPageViewer.vue'
import BrainstormViewer from './components/BrainstormViewer.vue'
import { type MindmapNode } from '@renderer/services/mindmap'
import { type KnowledgeGraphData } from '@renderer/services/knowledgeGraph'

// View switching logic - 从 store 恢复状态
type ViewType =
  | 'assistant'
  | 'note-editor'
  | 'source-preview'
  | 'mindmap-viewer'
  | 'report-viewer'
  | 'knowledge-graph'
  | 'interview-viewer'
  | 'infographic-viewer'
  | 'webpage-viewer'
  | 'brainstorm-viewer'
// 本 tab 上次停在哪个视图、哪条笔记，按自己的 tab id 读
const savedTabUiState = notebookStore.ensureTabUiState(notebookTabId.value)
const currentView = ref<ViewType>(savedTabUiState.detailViewType || 'assistant')
const currentNoteId = ref<number | undefined>(savedTabUiState.currentNoteId ?? undefined)
const isAutoCreate = ref(false)

// Mindmap State
const currentMindmapData = ref<MindmapNode | null>(null)
const currentReportOutputId = ref<string | null>(null)
const currentKnowledgeGraphData = ref<KnowledgeGraphData | null>(null)
const currentInterviewOutputId = ref<string | null>(null)
const currentInfographicOutputId = ref<string | null>(null)
const currentWebPageOutputId = ref<string | null>(null)
const currentBrainstormOutputId = ref<string | null>(null)

const currentReportOutput = computed(() => {
  if (!currentReportOutputId.value || !notebookId.value) return null
  const outputs = studioOutputStore.getOutputs(notebookId.value)
  return outputs.find((o) => o.id === currentReportOutputId.value) || null
})

// 监听视图切换，同步到 store
watch(currentView, (newView, oldView) => {
  // 如果从笔记编辑页面离开，触发训练
  if (oldView === 'note-editor') {
    debouncedTrainNotebook()
  }
  // 只持久化基础视图类型，特殊视图（mindmap、report 等）不持久化
  // 因为这些视图需要数据支持，刷新后无法直接恢复
  const persistableViews = ['assistant', 'note-editor', 'source-preview'] as const
  if (persistableViews.includes(newView as (typeof persistableViews)[number])) {
    notebookStore.setDetailViewType(
      newView as (typeof persistableViews)[number],
      notebookTabId.value
    )
  }
})

watch(
  currentNoteId,
  (newNoteId) => {
    notebookStore.setCurrentNoteId(newNoteId ?? null, notebookTabId.value)
  },
  { immediate: true }
)

// ... existing watches ...

/**
 * 切换到 AI 对话视图
 * 点击 AI对话 按钮时调用
 */
const handleSwitchToAIChat = (): void => {
  currentView.value = 'assistant'
  currentNoteId.value = undefined
  currentPreviewSource.value = null
  currentMindmapData.value = null
  currentReportOutputId.value = null
}
provide('onSwitchToAIChat', handleSwitchToAIChat)

/**
 * 打开思维导图视图
 */
const handleOpenMindmap = (data: MindmapNode): void => {
  currentMindmapData.value = data
  currentView.value = 'mindmap-viewer'
  currentNoteId.value = undefined
  currentPreviewSource.value = null
}
provide('openMindmap', handleOpenMindmap)

/**
 * 打开报告视图
 */
const handleOpenReport = (output: StudioOutput): void => {
  currentReportOutputId.value = output.id
  currentView.value = 'report-viewer'
}

/**
 * 关闭报告视图
 */
const handleCloseReport = (): void => {
  currentReportOutputId.value = null
  handleSwitchToAIChat()
}
provide('openReport', handleOpenReport)

/**
 * 打开知识图谱视图
 */
const handleOpenKnowledgeGraph = (data: KnowledgeGraphData): void => {
  currentKnowledgeGraphData.value = data
  currentView.value = 'knowledge-graph'
  currentNoteId.value = undefined
  currentPreviewSource.value = null
}

/**
 * 处理知识图谱节点双击：发起 AI 对话
 */
const handleKnowledgeGraphNodeDoubleClick = (nodeLabel: string): void => {
  const prompt = `请基于提供的知识内容，帮助我全面的了解「${nodeLabel}」`

  // 切换到对话视图
  handleSwitchToAIChat()

  // 触发对话
  const tryTrigger = (attempts = 0): void => {
    if (assistantWelcomeRef.value) {
      assistantWelcomeRef.value.triggerInput(prompt)
    } else if (attempts < 20) {
      setTimeout(() => tryTrigger(attempts + 1), 50)
    }
  }

  nextTick(() => {
    tryTrigger()
  })
}
provide('openKnowledgeGraph', handleOpenKnowledgeGraph)

/**
 * 面试 Output 计算属性
 */
const currentInterviewOutput = computed(() => {
  if (!currentInterviewOutputId.value || !notebookId.value) return null
  const outputs = studioOutputStore.getOutputs(notebookId.value)
  return outputs.find((o) => o.id === currentInterviewOutputId.value) || null
})

/**
 * 打开面试视图
 */
const handleOpenMockInterview = (output: StudioOutput): void => {
  currentInterviewOutputId.value = output.id
  currentView.value = 'interview-viewer'
  currentNoteId.value = undefined
  currentPreviewSource.value = null
}

/**
 * 关闭面试视图
 */
const handleCloseMockInterview = (): void => {
  currentInterviewOutputId.value = null
  handleSwitchToAIChat()
}

/**
 * 处理面试中的AI解释请求
 */
const handleInterviewAskAI = (context: string): void => {
  // 切换到AI对话视图
  handleSwitchToAIChat()
  // 延迟触发AI对话，等待视图切换完成
  setTimeout(() => {
    if (assistantWelcomeRef.value) {
      assistantWelcomeRef.value.triggerInput(context)
    }
  }, 100)
}

provide('openMockInterview', handleOpenMockInterview)

/**
 * 信息图 Output 计算属性
 */
const currentInfographicOutput = computed(() => {
  if (!currentInfographicOutputId.value || !notebookId.value) return null
  const outputs = studioOutputStore.getOutputs(notebookId.value)
  return outputs.find((o) => o.id === currentInfographicOutputId.value) || null
})

/**
 * 打开信息图视图
 */
const handleOpenInfographic = (output: StudioOutput): void => {
  currentInfographicOutputId.value = output.id
  currentView.value = 'infographic-viewer'
  currentNoteId.value = undefined
  currentPreviewSource.value = null
}

/**
 * 关闭信息图视图
 */
const handleCloseInfographic = (): void => {
  currentInfographicOutputId.value = null
  handleSwitchToAIChat()
}

provide('openInfographic', handleOpenInfographic)

/**
 * 网页 Output 计算属性
 */
const currentWebPageOutput = computed(() => {
  if (!currentWebPageOutputId.value || !notebookId.value) return null
  const outputs = studioOutputStore.getOutputs(notebookId.value)
  return outputs.find((o) => o.id === currentWebPageOutputId.value) || null
})

/**
 * 打开网页视图。
 *
 * 没有「分享」这一步：分享是把 HTML 传到官方服务端换一个公开链接，
 * 社区版没有那台服务器。网页照样能预览、下载、复制，都是本地能力。
 */
const handleOpenWebPage = (output: StudioOutput): void => {
  currentWebPageOutputId.value = output.id
  currentView.value = 'webpage-viewer'
  currentNoteId.value = undefined
  currentPreviewSource.value = null
}

/**
 * 关闭网页视图
 */
const handleCloseWebPage = (): void => {
  currentWebPageOutputId.value = null
  handleSwitchToAIChat()
}

provide('openWebPage', handleOpenWebPage)

/**
 * 头脑风暴 Output 计算属性
 */
const currentBrainstormOutput = computed(() => {
  if (!currentBrainstormOutputId.value || !notebookId.value) return null
  const outputs = studioOutputStore.getOutputs(notebookId.value)
  return outputs.find((o) => o.id === currentBrainstormOutputId.value) || null
})

/**
 * 打开头脑风暴视图
 */
const handleOpenBrainstorm = (output: StudioOutput): void => {
  currentBrainstormOutputId.value = output.id
  currentView.value = 'brainstorm-viewer'
  currentNoteId.value = undefined
  currentPreviewSource.value = null
}

/**
 * 关闭头脑风暴视图
 */
const handleCloseBrainstorm = (): void => {
  currentBrainstormOutputId.value = null
  handleSwitchToAIChat()
}

/**
 * 处理头脑风暴创意双击：发起 AI 对话
 */
const handleBrainstormIdeaDblclick = (idea: { title: string; description: string }): void => {
  const prompt = `基于知识库内容，帮我深入分析这个想法：「${idea.title}」\n\n背景描述：${idea.description}`

  // 切换到对话视图
  handleSwitchToAIChat()

  // 触发对话
  const tryTrigger = (attempts = 0): void => {
    if (assistantWelcomeRef.value) {
      assistantWelcomeRef.value.triggerInput(prompt)
    } else if (attempts < 20) {
      setTimeout(() => tryTrigger(attempts + 1), 50)
    }
  }

  nextTick(() => {
    tryTrigger()
  })
}

provide('openBrainstorm', handleOpenBrainstorm)

const assistantWelcomeRef = ref<InstanceType<typeof AssistantWelcome> | null>(null)

/**
 * 处理思维导图节点双击：发起 AI 对话
 */
const handleMindmapNodeDoubleClick = (payload: {
  data: MindmapNode['data']
  parent: MindmapNode['data'] | null
}): void => {
  console.log('NotebookDetail: handleMindmapNodeDoubleClick triggered', payload)
  const nodeName = payload.data.text
  const parentName = payload.parent ? payload.parent.text : null

  let prompt = ''
  if (parentName) {
    prompt = `在更大的“${parentName}”背景范畴下，根据知识讨论对“${nodeName}”的看法。`
  } else {
    prompt = `根据知识讨论对“${nodeName}”的看法。`
  }

  // 1. 切换到对话视图
  handleSwitchToAIChat()

  // 2. 触发对话 (需要在视图切换完成、组件激活后执行)
  // 使用轮询确保 ref 已挂载
  const tryTrigger = (attempts = 0): void => {
    if (assistantWelcomeRef.value) {
      console.log('NotebookDetail: calling triggerInput with prompt:', prompt)
      assistantWelcomeRef.value.triggerInput(prompt)
    } else {
      if (attempts < 20) {
        // 最多等待 1 秒 (20 * 50ms)
        console.log(
          `NotebookDetail: AssistantWelcome ref not ready (attempt ${attempts}), retrying...`
        )
        setTimeout(() => tryTrigger(attempts + 1), 50)
      } else {
        console.error(
          'NotebookDetail: Failed to access AssistantWelcome ref after multiple attempts'
        )
        message.warning(t('notebook.detail.autoSendFailed'))
      }
    }
  }

  nextTick(() => {
    tryTrigger()
  })
}

/**
 * 处理思维导图节点点击
 */
const handleMindmapNodeClick = (nodeData: MindmapNode['data']): void => {
  console.log('Mindmap node clicked:', nodeData)
}

/**
 * 来源数据负载接口
 */
interface SourcePayload {
  type: 'file' | 'link' | 'youtube' | 'bilibili' | 'wechat' | 'text' | 'note' | 'ue-project'
  content: string | File
  title?: string
  /** 网页描述(可选，由 Jina Reader 返回) */
  description?: string
  /** 原始 URL(针对网页类型) */
  sourceUrl?: string
  /** 是否正在加载 */
  loading?: boolean
}

/**
 * 处理视觉识别文件（图片/视频/音频）
 * 直接使用本地文件路径，vision IPC 会自动转换为 Base64 发送给 Gemini
 * 图片保留本地文件，并在 Markdown 中追加本地预览链接
 * @param sourceId - 来源 ID
 * @param filePath - 文件路径
 * @param mediaType - 媒体类型 image/video/audio
 */
const processVisionFile = async (
  sourceId: string,
  filePath: string,
  mediaType: 'image' | 'video',
  targetNotebookId?: string
): Promise<void> => {
  // 跟踪是否需要清理压缩后的临时文件
  let compressedFilePath: string | null = null

  // 保存原始标题用于恢复
  const originalTitle = sources.value.find((s) => s.id === sourceId)?.title || ''

  try {
    console.log(`[Vision] 开始分析 ${mediaType}: ${filePath}`)

    // 最终用于分析的文件路径（视频可能会被压缩）
    let analysisFilePath = filePath

    // 视频类型：检查文件大小，超过 100MB 自动压缩
    if (mediaType === 'video') {
      try {
        const stats = await window.api.getFileStats(filePath)
        const fileSizeMB = stats.size / (1024 * 1024)

        if (fileSizeMB > 100) {
          console.log(`[Vision] 视频文件过大 (${fileSizeMB.toFixed(1)} MB)，开始自动压缩...`)

          // 更新来源状态为"压缩中"（保持 loading 状态，不设置 error 避免红色边框）
          updateSource(
            sourceId,
            {
              loading: true,
              title: t('actionToast.notebook.compressing', { title: originalTitle })
            },
            targetNotebookId
          )

          // 使用 AI 分析优化参数进行压缩：95MB目标、15fps、720p、AAC单声道
          const compressResult = await window.api.video.compressForAI(filePath)

          if (compressResult.success && compressResult.outputPath) {
            console.log(
              `[Vision] 视频压缩成功: ${fileSizeMB.toFixed(1)} MB → ${compressResult.outputSizeMB?.toFixed(1)} MB`
            )
            analysisFilePath = compressResult.outputPath
            // 标记需要清理的压缩文件路径
            compressedFilePath = compressResult.outputPath

            // 清除压缩状态，恢复原标题，进入分析阶段
            updateSource(
              sourceId,
              {
                loading: true,
                title: t('actionToast.notebook.analyzing', { title: originalTitle }),
                error: null
              },
              targetNotebookId
            )
          } else {
            console.error('[Vision] 视频压缩失败:', compressResult.error)
            updateSource(
              sourceId,
              {
                loading: false,
                error: `视频过大 (${fileSizeMB.toFixed(0)} MB)，压缩失败: ${compressResult.error || '未知错误'}。请手动压缩后重试。`
              },
              targetNotebookId
            )
            return
          }
        }
      } catch (statsError) {
        console.warn('[Vision] 获取视频文件大小失败，继续尝试分析:', statsError)
      }
    }

    // 直接调用视觉识别 API，使用本地文件路径（IPC 会自动转 Base64）
    const visionResult = await window.api.vision.analyze({
      mediaPath: analysisFilePath,
      mediaType
    })

    // 更新来源状态
    if (visionResult.success && visionResult.markdown) {
      const finalMarkdown = visionResult.markdown

      updateSource(
        sourceId,
        {
          // 只有压缩过的视频才需要恢复原始标题（因为压缩时临时修改了标题）
          ...(compressedFilePath ? { title: originalTitle } : {}),
          content: finalMarkdown,
          loading: false,
          error: null
        },
        targetNotebookId
      )
      console.log(`[Vision] ${mediaType} 识别成功，Markdown 长度: ${finalMarkdown.length}`)

      // 视频类型：如果返回了 媒体 URL，保存到来源的 mediaUrl 字段
      // 这样用户在 @ 引用该来源时可以将视频 URL 传给 AI
      if (mediaType === 'video' && visionResult.mediaUrl) {
        console.log('[Vision] 保存视频 媒体 URL 到来源:', visionResult.mediaUrl)
        // 同时更新数据库和内存缓存，确保用户 @ 引用时能获取到 mediaUrl
        window.api.notebook.updateSource(sourceId, { mediaUrl: visionResult.mediaUrl })
        if (targetNotebookId) {
          notebookStore.updateSource(targetNotebookId, sourceId, {
            mediaUrl: visionResult.mediaUrl
          })
        }
      }
    } else {
      updateSource(
        sourceId,
        {
          loading: false,
          error: visionResult.error || '识别失败'
        },
        targetNotebookId
      )
    }
  } catch (error) {
    console.error(`[Vision] ${mediaType} 处理失败:`, error)
    updateSource(
      sourceId,
      {
        loading: false,
        error: error instanceof Error ? error.message : '处理失败'
      },
      targetNotebookId
    )
  } finally {
    // 清理压缩后的临时文件（无论成功或失败都要删除）
    if (compressedFilePath) {
      try {
        await window.api.deleteFile(compressedFilePath)
        console.log('[Vision] 已清理压缩临时文件:', compressedFilePath)
      } catch (cleanupError) {
        console.warn('[Vision] 清理压缩临时文件失败:', cleanupError)
      }
    }
  }
}

/**
 * 处理添加来源
 * 如果 payload.loading 为 true，则异步读取内容
 */
/**
 * 处理添加来源
 * 如果 payload.loading 为 true，则异步读取内容
 */
const handleAddSource = async (payload: SourcePayload): Promise<void> => {
  console.log('[NotebookDetail] handleAddSource called with payload:', {
    type: payload.type,
    title: payload.title,
    loading: payload.loading,
    contentLength: typeof payload.content === 'string' ? payload.content.length : 'File'
  })

  // 捕获当前的 notebookId
  const currentNotebookId = notebookId.value
  if (!currentNotebookId) {
    console.error('[NotebookDetail] skip add source: no notebook id')
    return
  }

  // 去重检查：文件按路径去重，链接按 URL 去重
  const filePath =
    payload.content instanceof File ? window.api.getPathForFile(payload.content) : undefined
  if (
    notebookStore.isDuplicateSource(currentNotebookId, {
      type: payload.type,
      filePath,
      sourceUrl: payload.sourceUrl
    })
  ) {
    console.log('[NotebookDetail] 跳过重复来源:', payload.title || filePath || payload.sourceUrl)
    message.warning(t('actionToast.notebook.skippedExisting'))
    return
  }

  // 生成唯一 ID。
  //
  // 之前用 `Date.now().toString()`：批量添加来源时（比如网页搜索结果批量导入）
  // 是同步 for 循环连续 emit，每次 handleAddSource 的同步前缀（几个字符串操作、
  // 一次数组 push）执行完全用不到 1 毫秒——`Date.now()` 的精度只有毫秒，
  // 于是好几个来源拿到完全相同的 id。source_id 在数据库里是 UNIQUE 约束，
  // 后面几个的 createSource 请求全部因主键冲突失败；而失败清理逻辑
  // （notebookStore.addSource 的 catch 分支）按 id 做等值判断来定位要移除的
  // 那一条——id 相同时这个判断永远为真，于是每失败一次就顺手删掉数组里
  // 随便一条同 id 的来源，5 个只剩 1 个，正是复现出来的现象。
  const sourceId = crypto.randomUUID()

  // 自动检测 YouTube URL 并切换类型
  if (payload.type === 'link' && payload.sourceUrl) {
    try {
      const urlObj = new URL(payload.sourceUrl)
      const isYoutube =
        urlObj.hostname === 'www.youtube.com' ||
        urlObj.hostname === 'youtube.com' ||
        urlObj.hostname === 'youtu.be' ||
        urlObj.hostname === 'm.youtube.com'

      if (isYoutube) {
        console.log('[NotebookDetail] Detected YouTube URL, switching type to youtube')
        payload.type = 'youtube'
      }

      // 检测 Bilibili 视频页。
      //
      // 判定走 `shared/bilibiliUrl`，和主进程 `isValidBilibiliUrl` 是同一份：这边判宽一点，
      // 多出来的那些链接就会走视频分析、撞一句「请提供有效的 Bilibili 视频 URL」结束，
      // 用户没有任何办法把它们当普通网页加进来。认不出是视频就留在 link，交给 webRead 读。
      if (isBilibiliVideoUrl(urlObj.href)) {
        console.log('[NotebookDetail] Detected Bilibili URL, switching type to bilibili')
        payload.type = 'bilibili'
      }
    } catch {
      // Ignore invalid URLs
    }
  }

  // 如果是带 loading 状态的链接，先添加占位符然后异步加载
  if (payload.loading && payload.type === 'link' && payload.sourceUrl) {
    // 从 URL 中提取域名作为初始标题
    let initialTitle = payload.sourceUrl
    try {
      const url = new URL(payload.sourceUrl)
      initialTitle = url.hostname + (url.pathname !== '/' ? url.pathname.slice(0, 30) : '')
    } catch {
      // 无效 URL，使用原始值
    }

    // 先添加一个加载中的条目
    addSource(
      {
        id: sourceId,
        title: initialTitle,
        type: 'link',
        content: '',
        sourceUrl: payload.sourceUrl,
        loading: true
      },
      currentNotebookId
    )

    // 异步读取网页内容
    try {
      const result = await window.api.webRead.read(payload.sourceUrl)

      if (result.success) {
        const rawContent = result.content || ''
        const pageTitle = result.title || payload.sourceUrl

        /*
          抓到就先落地、先结束 loading。

          上一版是「等清洗跑完才算导入完成」—— 一个网页要盯着转圈 30 到 120 秒，
          而清洗完全可以后台补。现在原文立刻可用，清洗好了再把正文换掉。
        */
        // 后台还要清洗 / 读图，两步都可能改正文 —— 等它们做完再一次向量化
        updateSource(
          sourceId,
          { title: pageTitle, content: rawContent, loading: false, error: null },
          currentNotebookId,
          { deferTraining: true }
        )

        void processWebSourceInBackground(
          sourceId,
          rawContent,
          pageTitle,
          payload.sourceUrl,
          currentNotebookId
        )
      } else {
        updateSource(
          sourceId,
          {
            loading: false,
            error: result.error || '读取失败'
          },
          currentNotebookId
        )
      }
    } catch (error) {
      console.error('[NotebookDetail] Jina 读取失败:', error)
      updateSource(
        sourceId,
        {
          loading: false,
          error: '网络请求失败'
        },
        currentNotebookId
      )
    }
    return
  }

  // 如果是带 loading 状态的 YouTube 链接，异步调用 Gemini 分析
  if (payload.loading && payload.type === 'youtube' && payload.sourceUrl) {
    // 从 YouTube URL 中提取视频信息作为初始标题
    let initialTitle = 'YouTube 视频'
    try {
      const url = new URL(payload.sourceUrl)
      // 尝试从 URL 中提取视频 ID
      const videoId = url.searchParams.get('v') || url.pathname.split('/').pop()
      if (videoId) {
        initialTitle = `YouTube 视频 (${videoId})`
      }
    } catch {
      // 无效 URL，使用默认值
    }

    // 先添加一个加载中的条目
    addSource(
      {
        id: sourceId,
        title: initialTitle,
        type: 'youtube',
        content: '',
        sourceUrl: payload.sourceUrl,
        loading: true
      },
      currentNotebookId
    )

    // 异步调用 YouTube 分析 API（使用 Gemini gemini-2.5-pro-preview 模型）
    try {
      console.log('[NotebookDetail] 开始分析 YouTube 视频:', payload.sourceUrl)

      const result = await window.api.youtube.analyze({
        url: payload.sourceUrl
      })

      if (result.success && result.content) {
        updateSource(
          sourceId,
          {
            title: result.title || initialTitle,
            content: result.content,
            loading: false,
            error: null
          },
          currentNotebookId
        )
        console.log('[NotebookDetail] YouTube 分析成功，内容长度:', result.content.length)
      } else {
        updateSource(
          sourceId,
          {
            loading: false,
            error: result.error || '视频分析失败'
          },
          currentNotebookId
        )
        console.error('[NotebookDetail] YouTube 分析失败:', result.error)
      }
    } catch (error) {
      console.error('[NotebookDetail] YouTube 分析异常:', error)
      updateSource(
        sourceId,
        {
          loading: false,
          error: error instanceof Error ? error.message : '分析请求失败'
        },
        currentNotebookId
      )
    }
    return
  }

  // 如果是带 loading 状态的 Bilibili 链接，异步调用视频分析
  if (payload.loading && payload.type === 'bilibili' && payload.sourceUrl) {
    // 从 Bilibili URL 中提取视频信息作为初始标题
    let initialTitle = 'Bilibili 视频'
    let thumbnail: string | undefined
    let description: string | undefined
    let bvid: string | null = null

    try {
      const url = new URL(payload.sourceUrl)
      // 尝试从 URL 中提取视频 ID (BV 号)
      const pathMatch = url.pathname.match(/\/(BV[a-zA-Z0-9]+)/)
      if (pathMatch && pathMatch[1]) {
        bvid = pathMatch[1]
        initialTitle = `Bilibili 视频 (${bvid})`
      }
    } catch {
      // 无效 URL，使用默认值
    }

    // 【增强】先快速获取视频元信息，让用户在等待分析期间有东西看
    if (bvid) {
      try {
        console.log('[NotebookDetail] 快速获取 Bilibili 视频元信息:', bvid)
        const info = await window.api.bilibili.fetchInfo(bvid)
        if (info.success) {
          initialTitle = info.title || initialTitle
          thumbnail = info.pic
          description = info.desc
          console.log('[NotebookDetail] 获取视频元信息成功:', info.title)
        }
      } catch (err) {
        // 获取元信息失败不影响后续分析，仅记录日志
        console.warn('[NotebookDetail] 获取视频元信息失败，使用默认值:', err)
      }
    }

    // 先添加一个加载中的条目（现在包含真实标题和封面）
    addSource(
      {
        id: sourceId,
        title: initialTitle,
        type: 'bilibili',
        content: '',
        sourceUrl: payload.sourceUrl,
        thumbnail,
        description,
        loading: true
      },
      currentNotebookId
    )

    // 异步调用 Bilibili 分析 API
    try {
      console.log('[NotebookDetail] 开始分析 Bilibili 视频:', payload.sourceUrl)

      const result = await window.api.bilibili.analyze({
        url: payload.sourceUrl
      })

      if (result.success && result.content) {
        updateSource(
          sourceId,
          {
            // 标题在上面 `bilibili:fetchInfo` 那一步就定了，分析本身不再回标题
            title: initialTitle,
            content: result.content,
            loading: false,
            error: null
          },
          currentNotebookId
        )
        console.log('[NotebookDetail] Bilibili 分析成功，内容长度:', result.content.length)
      } else {
        updateSource(
          sourceId,
          {
            loading: false,
            error: result.error || '视频分析失败'
          },
          currentNotebookId
        )
        console.error('[NotebookDetail] Bilibili 分析失败:', result.error)
      }
    } catch (error) {
      console.error('[NotebookDetail] Bilibili 分析异常:', error)
      updateSource(
        sourceId,
        {
          loading: false,
          error: error instanceof Error ? error.message : '分析请求失败'
        },
        currentNotebookId
      )
    }
    return
  }

  // 如果是带 loading 状态的微信公众号链接，异步调用文章采集
  if (payload.loading && payload.type === 'wechat' && payload.sourceUrl) {
    // 从微信 URL 中提取信息作为初始标题
    let initialTitle = '微信公众号文章'
    try {
      const url = new URL(payload.sourceUrl)
      initialTitle = `微信文章 (${url.pathname.slice(0, 20)}...)`
    } catch {
      // 无效 URL，使用默认值
    }

    // 先添加一个加载中的条目
    addSource(
      {
        id: sourceId,
        title: initialTitle,
        type: 'link', // 最终存储为 link 类型
        content: '',
        sourceUrl: payload.sourceUrl,
        loading: true
      },
      currentNotebookId
    )

    // 异步调用微信文章采集 API
    try {
      console.log('[NotebookDetail] 开始采集微信公众号文章:', payload.sourceUrl)

      const result = await window.api.wechat.read(payload.sourceUrl)

      if (result.success && result.content) {
        const pageTitle = result.title || initialTitle
        // 公众号页面的导航、二维码、推广是噪音大户，和普通网页一样要清洗；
        // 而它的关键信息又常常做进图里，所以读图这一步更要走到。
        updateSource(
          sourceId,
          {
            title: pageTitle,
            content: result.content,
            loading: false,
            error: null
          },
          currentNotebookId,
          // 后台还要清洗 / 读图，两步都可能改正文 —— 等它们做完再一次向量化
          { deferTraining: true }
        )
        console.log('[NotebookDetail] 微信文章采集成功，内容长度:', result.content.length)

        void processWebSourceInBackground(
          sourceId,
          result.content,
          pageTitle,
          payload.sourceUrl,
          currentNotebookId
        )
      } else {
        updateSource(
          sourceId,
          {
            loading: false,
            error: result.error || '文章采集失败'
          },
          currentNotebookId
        )
        console.error('[NotebookDetail] 微信文章采集失败:', result.error)
      }
    } catch (error) {
      console.error('[NotebookDetail] 微信文章采集异常:', error)
      updateSource(
        sourceId,
        {
          loading: false,
          error: error instanceof Error ? error.message : '采集请求失败'
        },
        currentNotebookId
      )
    }
    return
  }

  // 文件类型处理
  if (payload.type === 'file' && payload.content instanceof File) {
    const file = payload.content
    const fileName = file.name
    const title = payload.title || fileName
    const filePath = window.api.getPathForFile(file)
    const ext = fileName.toLowerCase().substring(fileName.lastIndexOf('.'))

    // 图片类型 - 使用视觉识别
    const imageExts = [
      '.jpg',
      '.jpeg',
      '.png',
      '.gif',
      '.bmp',
      '.webp',
      '.ico',
      '.tif',
      '.tiff',
      '.heic',
      '.heif',
      '.jp2'
    ]
    if (imageExts.includes(ext)) {
      // 检查文件大小（限制 10MB）
      if (file.size > 10 * 1024 * 1024) {
        addSource(
          {
            id: sourceId,
            title: title,
            type: 'file',
            content: '',
            fileName: fileName,
            error: '图片文件超过 10MB 限制'
          },
          currentNotebookId
        )
        return
      }

      // 添加加载中条目
      addSource(
        {
          id: sourceId,
          title: title,
          type: 'file',
          content: '',
          fileName: fileName,
          filePath: filePath,
          loading: true
        },
        currentNotebookId
      )

      // 异步处理视觉识别
      processVisionFile(sourceId, filePath, 'image', currentNotebookId)
      return
    }

    // 视频类型 - 使用视觉识别
    const videoExts = ['.mp4', '.avi', '.mov', '.mkv', '.wmv', '.flv', '.webm', '.m4v', '.3gp']
    if (videoExts.includes(ext)) {
      // 检查文件大小（限制 2.5GB，后端会压缩）和时长（后端处理）
      if (file.size > 2.5 * 1024 * 1024 * 1024) {
        addSource(
          {
            id: sourceId,
            title: title,
            type: 'file',
            content: '',
            fileName: fileName,
            error: '视频文件超过 2.5GB 限制'
          },
          currentNotebookId
        )
        return
      }

      // 添加加载中条目
      addSource(
        {
          id: sourceId,
          title: title,
          type: 'file',
          content: '',
          fileName: fileName,
          filePath: filePath,
          loading: true
        },
        currentNotebookId
      )

      // 异步处理视觉识别
      processVisionFile(sourceId, filePath, 'video', currentNotebookId)
      return
    }

    // 音频作为原文件附件保留。
    const audioExts = [
      '.mp3',
      '.wav',
      '.flac',
      '.ogg',
      '.m4a',
      '.aac',
      '.wma',
      '.opus',
      '.aiff',
      '.ape'
    ]
    if (audioExts.includes(ext)) {
      addSource(
        {
          id: sourceId,
          title,
          type: 'file',
          content: String(t('notebook.source.audioAttachment')),
          fileName,
          filePath,
          loading: false
        },
        currentNotebookId
      )
      return
    }

    // 检查文件类型是否为文档格式
    const isSupported = await window.api.documentLoader.isSupported(filePath)

    if (isSupported) {
      // 先添加一个加载中的条目
      addSource(
        {
          id: sourceId,
          title: title,
          type: 'file',
          content: '',
          fileName: fileName,
          filePath: filePath,
          loading: true
        },
        currentNotebookId
      )

      // 异步加载文档
      try {
        // DOCX 文件使用增强版加载器（支持图片提取 + Vision 识别）
        if (ext === '.docx') {
          console.log('[NotebookDetail] 使用增强加载器处理 DOCX:', fileName)
          const result = await loadDocxWithVision(filePath, currentNotebookId)

          if (!result.success || !result.content) {
            updateSource(
              sourceId,
              { loading: false, error: result.error || '加载失败' },
              currentNotebookId
            )
          } else {
            updateSource(
              sourceId,
              { content: result.content, loading: false, error: null },
              currentNotebookId
            )
          }
        } else {
          // 其他文档格式使用普通加载器
          const result = await window.api.documentLoader.load(filePath)
          if (result.success && result.content) {
            updateSource(
              sourceId,
              {
                content: result.content,
                loading: false,
                error: null
              },
              currentNotebookId
            )
          } else {
            updateSource(
              sourceId,
              {
                loading: false,
                error: result.error || '加载失败'
              },
              currentNotebookId
            )
          }
        }
      } catch (error) {
        console.error('[NotebookDetail] 文档加载失败:', error)
        updateSource(
          sourceId,
          {
            loading: false,
            error: '文档加载失败'
          },
          currentNotebookId
        )
      }
      return
    }

    // 不支持的文件类型，直接添加（显示不支持预览的提示）
    addSource(
      {
        id: sourceId,
        title: title,
        type: 'file',
        content: '',
        fileName: fileName,
        error: '不支持此文件类型的预览'
      },
      currentNotebookId
    )
    return
  }

  // 其他类型直接添加
  let title = payload.title || 'Untitled Source'
  if (!payload.title) {
    if (payload.content instanceof File) {
      title = payload.content.name
    } else if (typeof payload.content === 'string' && payload.content) {
      title = payload.content.slice(0, 30) + (payload.content.length > 30 ? '...' : '')
    }
  }

  // 对于非 File 类型的内容，直接存储
  const contentStr = typeof payload.content === 'string' ? payload.content : ''

  addSource(
    {
      id: sourceId,
      title: title,
      type: payload.type,
      content: contentStr,
      sourceUrl: payload.sourceUrl
    },
    currentNotebookId
  )
}

// Handle Note Created
const handleNoteCreated = (note: EditableNote): void => {
  // Add the newly created note to the sources list
  addSource({
    id: note.id ? note.id.toString() : Date.now().toString(),
    title: note.title || 'Untitled Note',
    type: 'note', // Notes from Tiptap editor are HTML format
    content: note.content
  })
  // Update current note ID and turn off auto-create
  currentNoteId.value = note.id
  isAutoCreate.value = false
}

// Handle Note Updated
const handleNoteUpdated = (note: Partial<EditableNote>): void => {
  if (!note.id) return
  if (note.title) {
    updateSource(note.id.toString(), { title: note.title })
  }
  if (note.content !== undefined) {
    updateSource(note.id.toString(), { content: note.content })
  }
}

/**
 * 处理 Deep Research 创建笔记
 * @param title 笔记标题
 * @param content 笔记内容 (Markdown)
 */
const handleCreateNote = async (title: string, content: string): Promise<void> => {
  const currentNotebookId = notebookId.value
  if (!currentNotebookId) {
    console.error('[NotebookDetail] handleCreateNote: no notebook id')
    return
  }

  try {
    // 1. 调用后端 API 创建真实笔记
    const noteId = await noteAPI.create({
      title: title,
      content: content
    })

    // 2. 将创建的笔记添加到来源列表 (使用真实 ID)
    addSource(
      {
        id: noteId.toString(),
        title: title,
        type: 'note',
        content: content
      },
      currentNotebookId
    )

    // 3. 选中新创建的笔记 (Logic here might be tricky if user navigated away)
    // If user navigated away, we shouldn't switch view or set currentNoteId probably?
    // But since this is a user-initiated action from DeepResearch on THIS notebook,
    // maybe we should only switch view if we are still on the same notebook.
    if (notebookId.value === currentNotebookId) {
      currentNoteId.value = noteId
      isAutoCreate.value = false
      currentView.value = 'note-editor'
    }
  } catch (error) {
    console.error('Deep Research 笔记创建失败:', error)
    message.error(t('actionToast.notebook.createNoteFailed'))
  }
}

/**
 * 把工作台的产出存回来源列表。
 *
 * 走 `addSource` 而不是直接写库：它会顺带触发向量化，新来源当场就能被检索到。
 * 类型用 `note` —— 存进来的是一段 AI 写的 markdown，和用户自己写的笔记同一类东西。
 */
const handleSaveStudioOutputAsSource = (payload: { title: string; content: string }): void => {
  const currentNotebookId = notebookId.value
  if (!currentNotebookId) return

  addSource(
    {
      id: `studio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: payload.title,
      type: 'note',
      content: payload.content
    },
    currentNotebookId
  )
}

/**
 * 后台把正文里的图交给视觉模型读一遍。
 *
 * 开关默认是关的（偏好设置 → 知识库 → 读取网页里的图片）—— 读图按张收费，
 * 不能替用户决定。开关没开时主进程原样返回，这里什么都不会发生。
 *
 * 读完直接写库，所以要重新拉一次来源列表，界面上那条才会跟着变。
 */
const readSourceImagesInBackground = async (
  sourceId: string,
  targetNotebookId: string
): Promise<void> => {
  const result = await window.api.notebook.readSourceImages(sourceId)
  if (!result.success) {
    console.warn(`[NotebookDetail] 来源 ${sourceId} 读图失败：${result.error}`)
    return
  }

  const stats = result.stats
  if (!stats || stats.read === 0) return

  console.log(
    `[NotebookDetail] 来源 ${sourceId} 读图完成：${stats.read}/${stats.total} 张读出文字，` +
      `${stats.decorative} 张是装饰图，${stats.overLimit} 张超出上限没读`
  )
  message.success(t('notebook.source.imagesRead', { count: stats.read }))

  if (notebookId.value === targetNotebookId) {
    await notebookStore.loadSources(targetNotebookId)
  }
}

/**
 * 网页来源落地之后的后台加工：该清洗的清洗、该读图的读图，最后统一向量化。
 *
 * ## 为什么读图不能挂在清洗里面
 *
 * 上一版是「清洗成功 / 失败都顺手读一下图」，于是读图只在**决定要清洗**时才可能发生。
 * 而 `shouldCleanWebContent` 对不足 500 字的正文直接返回 false —— 一篇「一句话配图」
 * 的海报式公众号推文正好落在这条线下面，而那恰恰是最需要读图的那种页面：
 * 信息全在图里。用户专门去开了「读取网页里的图片」，结果一张都没读，还没有任何提示。
 *
 * 所以两件事是**并列**的：清洗看正文够不够长，读图看正文里有没有图，互不为前提。
 * 向量化放在最后一次做，两步都可能改正文，索引两遍是白花用户的额度。
 *
 * ## 清洗那一步的两条硬要求
 *
 * 1. **原文必须留一份。** 清洗是有损的 —— 模型判断哪段是广告、哪段是正文，判错了
 *    就是删掉了正文。上一版直接用清洗结果覆盖 `content`，原文当场丢弃，用户再也
 *    对不了账。现在原文存进 `rawContent`，预览面板上能切回去看。
 * 2. **失败要说出来。** 上一版清洗失败静默用原文，「清洗成功」和「模型拒了」
 *    长得一模一样，用户只会觉得「这功能好像没生效」。
 */
const processWebSourceInBackground = async (
  sourceId: string,
  rawContent: string,
  pageTitle: string,
  sourceUrl: string,
  targetNotebookId: string
): Promise<void> => {
  if (shouldCleanWebContent(rawContent, sourceUrl)) {
    const outcome = await cleanWebContent(rawContent)

    if (outcome.ok) {
      /*
        原文进 rawContent，清洗后的进 content —— 两份都留着，用户随时能对照。

        摘要一并清掉：正文换了，主进程的 updateNotebookSource 本来就会把库里的
        summary_content / summary_status 置空。不在这里同步的话，界面上那一条还显示
        「摘要」就绪，并继续拿一份「带广告的旧正文的摘要」参与每次生成，
        直到下次 loadSources 摘要才凭空消失。
      */
      updateSource(
        sourceId,
        { content: outcome.content, rawContent, summaryContent: null, summaryStatus: null },
        targetNotebookId,
        // 读图马上还可能再改一次正文，等它做完再一起向量化，别索引两遍
        { deferTraining: true }
      )
      console.log(
        `[NotebookDetail] 来源 ${sourceId} 清洗完成，原文 ${rawContent.length} 字 -> 清洗后 ${outcome.content.length} 字`
      )
    } else {
      console.warn(`[NotebookDetail] 来源 ${sourceId} 清洗失败：${outcome.reason}`)
      message.warning(t('notebook.source.cleanFailed', { title: pageTitle }))
      // 没清成，正文就一直是原文。读图和向量化照常走
    }
  }

  // 清洗之后再读图：图片链接在清洗里是保留的，而读图产出的文字不该再被清洗一遍
  await readSourceImagesInBackground(sourceId, targetNotebookId)
  scheduleTrainNotebook(targetNotebookId)
}

/**
 * 处理来源选择
 * - note类型: 打开笔记编辑器
 * - 文本类型(纯数字ID): 打开笔记编辑器
 * - 文本类型(非数字ID): 预览内容（如 Deep Research 创建的来源）
 * - 链接/文件类型: 在中间面板预览 Markdown 内容
 */
const handleSourceSelect = (source: SourceItem): void => {
  if (source.type === 'note') {
    // 笔记类型 - 判断是否为真正的笔记
    // 支持两种格式：纯数字 ID (如 "123") 或 note-{id} 格式 (如 "note-123")
    const isRealNote = /^\d+$/.test(source.id)
    const noteIdMatch = source.id.match(/^note-(\d+)$/)

    if (isRealNote) {
      // 纯数字 ID - 打开笔记编辑器
      currentNoteId.value = parseInt(source.id)
      isAutoCreate.value = false
      currentView.value = 'note-editor'
      currentPreviewSource.value = null
    } else if (noteIdMatch) {
      // note-{id} 格式 (Spotlight 创建的笔记) - 打开笔记编辑器
      currentNoteId.value = parseInt(noteIdMatch[1])
      isAutoCreate.value = false
      currentView.value = 'note-editor'
      currentPreviewSource.value = null
    } else {
      // 其他格式的笔记 - 预览内容
      currentPreviewSource.value = source
      currentView.value = 'source-preview'
      currentNoteId.value = undefined
    }
  } else if (source.type === 'text') {
    // 判断是否为真正的笔记（纯数字 ID）
    const isRealNote = /^\d+$/.test(source.id)
    if (isRealNote) {
      // 真正的笔记 - 打开笔记编辑器
      currentNoteId.value = parseInt(source.id)
      isAutoCreate.value = false
      currentView.value = 'note-editor'
      currentPreviewSource.value = null
    } else {
      // Deep Research 等创建的 text 来源 - 预览内容
      currentPreviewSource.value = source
      currentView.value = 'source-preview'
      currentNoteId.value = undefined
    }
  } else if (
    source.type === 'link' ||
    source.type === 'youtube' ||
    source.type === 'bilibili' ||
    source.type === 'wechat' ||
    source.type === 'file' ||
    source.type === 'ue-project'
  ) {
    // 链接/文件/UE项目类型 - 预览内容
    currentPreviewSource.value = source
    currentView.value = 'source-preview'
    currentNoteId.value = undefined
  }
}

// Provide the source click handler to child components (e.g. AssistantWelcome)
provide('onSourceClick', handleSourceSelect)

/**
 * 从来源预览返回到对话界面
 */
const handlePreviewBack = (): void => {
  currentView.value = 'assistant'
  currentPreviewSource.value = null
}

/**
 * 在浏览器中打开来源 URL
 */
const handleOpenSourceUrl = (url: string): void => {
  window.open(url, '_blank')
}

const handleBack = (): void => {
  // 用户主动点击返回，清除缓存状态
  notebookStore.clearActiveNotebook(notebookTabId.value)
  router.push(buildNotebookListRoute(notebookTabId.value))
}

// Resizing Logic
const leftColWidth = ref(
  localStorage.getItem('notebook_left_width')
    ? parseInt(localStorage.getItem('notebook_left_width')!)
    : 300
)
const rightColWidth = ref(
  localStorage.getItem('notebook_right_width')
    ? parseInt(localStorage.getItem('notebook_right_width')!)
    : 320
)
/** 右列折叠状态 */
const isRightCollapsed = ref(false)
const isResizingLeft = ref(false)
const isResizingRight = ref(false)
let startX = 0
let startWidth = 0

/**
 * 切换右列折叠状态
 */
function toggleRightCollapse(): void {
  isRightCollapsed.value = !isRightCollapsed.value
}

// Left Resize
const startResizeLeft = (event: MouseEvent): void => {
  isResizingLeft.value = true
  startX = event.clientX
  startWidth = leftColWidth.value
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onMouseMoveLeft)
  document.addEventListener('mouseup', stopResizeLeft)
}

const onMouseMoveLeft = (event: MouseEvent): void => {
  if (!isResizingLeft.value) return
  const delta = event.clientX - startX
  const newWidth = startWidth + delta
  if (newWidth >= 200 && newWidth <= 600) {
    leftColWidth.value = newWidth
  }
}

const stopResizeLeft = (): void => {
  isResizingLeft.value = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  document.removeEventListener('mousemove', onMouseMoveLeft)
  document.removeEventListener('mouseup', stopResizeLeft)
}

// Right Resize
const startResizeRight = (event: MouseEvent): void => {
  isResizingRight.value = true
  startX = event.clientX
  startWidth = rightColWidth.value
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
  document.addEventListener('mousemove', onMouseMoveRight)
  document.addEventListener('mouseup', stopResizeRight)
}

const onMouseMoveRight = (event: MouseEvent): void => {
  if (!isResizingRight.value) return
  // Dragging left (negative delta) increases width for right panel
  const delta = event.clientX - startX
  const newWidth = startWidth - delta
  if (newWidth >= 200 && newWidth <= 600) {
    rightColWidth.value = newWidth
  }
}

const stopResizeRight = (): void => {
  isResizingRight.value = false
  document.body.style.cursor = ''
  document.body.style.userSelect = ''
  document.removeEventListener('mousemove', onMouseMoveRight)
  document.removeEventListener('mouseup', stopResizeRight)
  // Save to localStorage
  localStorage.setItem('notebook_left_width', leftColWidth.value.toString())
  localStorage.setItem('notebook_right_width', rightColWidth.value.toString())
}

onUnmounted(() => {
  stopResizeLeft()
  stopResizeRight() // Ensure event listeners are removed
})
</script>

<template>
  <div class="notebook-detail-page">
    <!-- Top Header -->
    <div class="detail-header">
      <div class="header-left">
        <AppButton variant="text" class="icon-btn" @click="handleBack">
          <template #icon>
            <PhArrowLeft />
          </template>
        </AppButton>
        <template v-if="isEditingTitle">
          <input
            :ref="(el) => setTitleInputRef(el)"
            v-model="titleDraft"
            class="notebook-title-input"
            type="text"
            :disabled="isSavingTitle"
            @keydown.enter="submitTitle"
            @keydown.esc="cancelEditTitle"
            @blur="submitTitle"
          />
        </template>
        <template v-else>
          <span class="notebook-title" @click="startEditTitle">{{ notebookTitle }}</span>
        </template>
      </div>

      <div class="header-right">
        <AppButton class="header-action-btn" shape="round" @click="handleSwitchToAIChat">
          <PhChatCircle /> {{ t('notebook.detail.aiChat') }}
        </AppButton>

        <AppButton class="header-action-btn" shape="round" @click="openSettings">
          <PhGear /> {{ t('notebook.detail.settings') }}
        </AppButton>
      </div>
    </div>

    <!-- Main Workspace Layout -->
    <div class="workspace-layout">
      <!-- Left Column -->
      <!-- Left Column -->
      <div class="col-left" :style="{ width: leftColWidth + 'px' }">
        <NoteSourcePanel
          :sources="sources"
          :active-id="currentNoteId?.toString()"
          :is-training="isTraining"
          :needs-training="needsTraining"
          :auto-train="autoTrainEnabled"
          :notebook-id="notebookId"
          @train="handleTrainNotebook"
          @update:auto-train="handleAutoTrainChange"
          @select="handleSourceSelect"
          @remove="removeSource"
          @rename="renameSource"
          @retry="retrySource"
          @add-web-source="handleAddWebSource"
          @create-note="handleCreateNote"
          @add-file-source="
            (file: File) => handleAddSource({ type: 'file', content: file, title: file.name })
          "
          @click-empty="
            () => {
              currentView = 'assistant'
              currentNoteId = undefined
            }
          "
        />
      </div>

      <!-- Resizer Left -->
      <div class="resizer" :class="{ active: isResizingLeft }" @mousedown="startResizeLeft"></div>

      <!-- Center Column -->
      <div class="col-center">
        <keep-alive>
          <AssistantWelcome
            v-if="currentView === 'assistant'"
            ref="assistantWelcomeRef"
            :key="'assistant'"
            :force-chat-view="true"
            :chat-sid="`notebook-chat-${notebookId}`"
            :notebook-mode="true"
            :notebook-sources="sources"
          />
          <!-- 知识库里的文本来源存公共库：知识库是全局的，不属于任何保管库，
               所以它不能跟着保管库走。资产/文件夹的说明才走 vault -->
          <NoteEditor
            v-else-if="currentView === 'note-editor'"
            :key="'note-editor'"
            store="public"
            :auto-create="isAutoCreate"
            :note-id="currentNoteId"
            @created="handleNoteCreated"
            @updated="handleNoteUpdated"
          />
        </keep-alive>
        <!-- Source Preview Panel (不使用 keep-alive，避免内容缓存问题) -->
        <SourcePreviewPanel
          v-if="currentView === 'source-preview' && currentPreviewSource"
          :source="currentPreviewSource"
          @back="handlePreviewBack"
          @open-url="handleOpenSourceUrl"
        />
        <!-- Mindmap Viewer -->
        <MindmapViewer
          v-if="currentView === 'mindmap-viewer' && currentMindmapData"
          :data="currentMindmapData"
          @node-click="handleMindmapNodeClick"
          @node-dblclick="handleMindmapNodeDoubleClick"
          @back="handleSwitchToAIChat"
        />
        <!-- Report Viewer -->
        <ReportViewer
          v-if="currentView === 'report-viewer' && currentReportOutput"
          :output="currentReportOutput"
          @close="handleCloseReport"
        />
        <!-- Knowledge Graph Viewer -->
        <KnowledgeGraphViewer
          v-if="currentView === 'knowledge-graph' && currentKnowledgeGraphData"
          :data="currentKnowledgeGraphData"
          @node-dblclick="handleKnowledgeGraphNodeDoubleClick"
          @back="handleSwitchToAIChat"
        />

        <!-- Mock Interview Viewer -->
        <MockInterviewViewer
          v-if="currentView === 'interview-viewer' && currentInterviewOutput"
          :output="currentInterviewOutput"
          :notebook-id="notebookId"
          @close="handleCloseMockInterview"
          @ask-a-i="handleInterviewAskAI"
        />

        <!-- Infographic Viewer -->
        <InfographicViewer
          v-if="currentView === 'infographic-viewer' && currentInfographicOutput"
          :image-url="
            currentInfographicOutput.infographicLocalPath ||
            currentInfographicOutput.infographicImageUrl ||
            null
          "
          :title="currentInfographicOutput.title"
          :output-id="currentInfographicOutput.id"
          @back="handleCloseInfographic"
        />

        <!-- Web Page Viewer -->
        <WebPageViewer
          v-if="currentView === 'webpage-viewer' && currentWebPageOutput"
          :html-content="currentWebPageOutput.webpageHtml || null"
          :title="currentWebPageOutput.title"
          :output-id="currentWebPageOutput.id"
          @back="handleCloseWebPage"
        />

        <!-- Brainstorm Viewer -->
        <BrainstormViewer
          v-if="currentView === 'brainstorm-viewer' && currentBrainstormOutput"
          :data="currentBrainstormOutput.brainstormData || null"
          :title="currentBrainstormOutput.title"
          @back="handleCloseBrainstorm"
          @idea-dblclick="handleBrainstormIdeaDblclick"
        />
      </div>

      <!-- Resizer Right -->
      <div class="resizer" :class="{ active: isResizingRight }" @mousedown="startResizeRight"></div>

      <!-- Right Column -->
      <div
        class="col-right"
        :style="{ width: isRightCollapsed ? '56px' : rightColWidth + 'px' }"
        :class="{ collapsed: isRightCollapsed }"
      >
        <NoteStudioPanel
          :notebook-id="notebookId"
          :notebook-title="notebookTitle"
          :sources="sources"
          :messages="chatMessages"
          :collapsed="isRightCollapsed"
          @click-empty="handleSwitchToAIChat"
          @toggle-collapse="toggleRightCollapse"
          @save-as-source="handleSaveStudioOutputAsSource"
        />
      </div>
    </div>
    <AddSourceModal
      v-model:open="showAddSourceModal"
      :current-count="sources.length"
      @add-source="handleAddSource"
    />
    <!--
      分享弹层由版本贡献提供：它整块只服务云端分享（同步、生成分享码、口令、撤销），
      没有任何本地部分。社区版拿到 null，这里什么都不渲染。
    -->
  </div>
</template>

<style scoped lang="less">
.notebook-detail-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--color-bg-surface); // Base background
  color: var(--color-text-primary);
}

.detail-header {
  height: 56px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 16px;
  border-bottom: 1px solid var(--color-border-subtle);
  animation: fadeInDown 0.4s ease-out;

  .header-left {
    display: flex;
    align-items: center;
    gap: 8px;

    .notebook-title {
      font-size: 16px;
      font-weight: 500;
      cursor: text;
      padding: 2px 4px;
      border-radius: 4px;

      &:hover {
        background: var(--color-bg-surface-hover);
      }
    }

    .notebook-title-input {
      height: 28px;
      min-width: 160px;
      max-width: 360px;
      padding: 0 8px;
      font-size: 16px;
      font-weight: 500;
      color: var(--color-text-primary);
      background: var(--color-bg-surface-hover);
      border: 1px solid var(--color-border);
      border-radius: 4px;
      outline: none;

      &:focus {
        border-color: var(--color-accent-border);
        box-shadow: 0 0 0 2px var(--color-accent-border);
      }
    }
  }

  .header-right {
    display: flex;
    align-items: center;
    gap: 8px;

    .header-action-btn {
      background: var(--color-bg-surface-hover);
      border: none;
      color: var(--color-text-primary);
      font-size: 13px;
      height: 32px;

      &:hover {
        background: var(--color-bg-surface-hover);
      }
    }
  }
}

.workspace-layout {
  flex: 1;
  display: flex;
  overflow: hidden;

  .col-left {
    flex-shrink: 0;
    min-width: 0;
    animation: fadeInLeft 0.4s ease-out 0.1s backwards;
  }

  .resizer {
    width: 1px;
    background: var(--color-bg-surface-hover);
    cursor: col-resize;
    position: relative;
    z-index: 10;
    transition:
      background 0.2s,
      box-shadow 0.2s;
    flex-shrink: 0;

    &::after {
      content: '';
      position: absolute;
      top: 0;
      bottom: 0;
      left: -4px;
      right: -4px;
      z-index: 10;
    }

    &:hover,
    &.active {
      background: var(--color-accent-solid);
      box-shadow: 0 0 5px var(--color-accent-border);
    }
  }

  .col-center {
    flex: 1;
    min-width: 0;
    animation: fadeInDown 0.4s ease-out 0.15s backwards;

    :deep(.input-composer) {
      margin-bottom: 24px;
    }
  }

  .col-right {
    flex-shrink: 0;
    min-width: 0;
    animation: fadeInRight 0.4s ease-out 0.2s backwards;
  }
}

.icon-btn {
  color: var(--color-text-secondary);
  &:hover {
    color: var(--color-text-primary);
    background: var(--color-bg-surface-hover);
  }
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
