/**
 * AI 图片生成 Store - 状态管理
 * 管理图片生成任务、历史记录
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import i18n from '@renderer/i18n'
import { toLocalResourceUrl } from '@renderer/utils/localResource'
import { message } from '@renderer/utils/messageManager'
import { NO_VISION_MODEL_ERROR_KEY } from '../../../../shared/aiNamingErrorKey'
import {
  GPT_IMAGE_MODEL,
  GPT_IMAGE_PROVIDER,
  getImageProviderForModel
} from '../../../../shared/imageGenerationModels'

const PENDING_START_TIMEOUT_MS = 20_000
const PROCESSING_NO_PROGRESS_TIMEOUT_MS = 90_000
const PROCESSING_IDLE_TIMEOUT_MS = 12 * 60_000

function extractBackendErrorMessage(errorMsg: string | undefined | null): string | null {
  const rawText = String(errorMsg || '').trim()
  if (!rawText) return null

  const candidates = [rawText]
  const httpJsonMatch = rawText.match(/HTTP\s+\d+\s*:\s*(\{[\s\S]*\})$/)
  if (httpJsonMatch?.[1]) {
    candidates.unshift(httpJsonMatch[1])
  }

  for (const candidate of candidates) {
    const firstBrace = candidate.indexOf('{')
    const lastBrace = candidate.lastIndexOf('}')
    if (firstBrace === -1 || lastBrace <= firstBrace) continue

    const jsonText = candidate.slice(firstBrace, lastBrace + 1)
    try {
      const parsed = JSON.parse(jsonText) as
        | { message?: unknown; error?: { message?: unknown }; data?: { message?: unknown } }
        | undefined
      const message =
        typeof parsed?.message === 'string'
          ? parsed.message
          : typeof parsed?.error?.message === 'string'
            ? parsed.error.message
            : typeof parsed?.data?.message === 'string'
              ? parsed.data.message
              : ''
      if (message.trim()) {
        return message.trim()
      }
    } catch {
      // Ignore malformed JSON fragments and fall back to the raw text.
    }
  }

  return null
}

/**
 * 将 API 错误消息转换为用户友好的中文提示
 * @param errorMsg 原始错误消息
 * @returns 用户友好的错误提示
 */
function getFriendlyErrorMessage(errorMsg: string | undefined | null): string {
  if (!errorMsg) return ''
  const normalizedMsg = extractBackendErrorMessage(errorMsg) || errorMsg
  if (normalizedMsg.includes('参考图上传失败') || normalizedMsg.includes('上传接口地址无效')) {
    return normalizedMsg
  }
  const lowerMsg = normalizedMsg.toLowerCase()

  if (
    lowerMsg.includes('ai_active_device_limit_exceeded') ||
    lowerMsg.includes('正在使用 ai 功能') ||
    lowerMsg.includes('等待其他设备空闲后再继续')
  ) {
    return '当前已有其他设备正在使用 AI 功能，请稍后再试'
  }

  // 敏感内容审核
  if (
    lowerMsg.includes('sensitive') ||
    lowerMsg.includes('内容审核') ||
    lowerMsg.includes('违规')
  ) {
    return '提示词可能包含敏感内容，请修改后重试'
  }

  // API 限流
  if (
    lowerMsg.includes('rate limit') ||
    lowerMsg.includes('too many requests') ||
    lowerMsg.includes('429')
  ) {
    return '请求过于频繁，请稍后再试'
  }

  // 网络/超时
  if (
    lowerMsg.includes('timeout') ||
    lowerMsg.includes('network') ||
    lowerMsg.includes('fetch failed') ||
    lowerMsg.includes('headers timeout') ||
    lowerMsg.includes('und_err_headers_timeout') ||
    lowerMsg.includes('econnrefused') ||
    lowerMsg.includes('econnreset') ||
    lowerMsg.includes('socket hang up')
  ) {
    return '网络连接失败，请检查网络后重试'
  }

  // 认证问题
  if (
    lowerMsg.includes('unauthorized') ||
    lowerMsg.includes('401') ||
    lowerMsg.includes('authentication')
  ) {
    return '认证失败，请重新登录'
  }

  // 余额不足
  if (
    lowerMsg.includes('insufficient') ||
    lowerMsg.includes('balance') ||
    lowerMsg.includes('quota')
  ) {
    return '模型服务商余额不足，请到服务商控制台充值后重试'
  }

  // 模型不支持
  if (lowerMsg.includes('unsupported model')) {
    return '当前模型暂不可用，请选择其他模型'
  }

  // HTTP 错误（如 HTTP 500: {...}）
  if (lowerMsg.includes('http 500') || lowerMsg.includes('http 400')) {
    return '生成失败，请稍后重试'
  }

  // 其他过长错误
  if (normalizedMsg.length > 50) {
    return '生成失败，请稍后重试'
  }

  return normalizedMsg
}

/**
 * 主进程取消任务时写进 `error_msg` 和 failed 事件的标记。
 *
 * 主进程不知道界面是什么语言，所以它给标记而不是成品文案（见 `src/main/i18n.ts`
 * 文件头）。真源是 `src/main/services/imagePollingService.ts` 的
 * `IMAGE_TASK_CANCELLED_MARKER`，两边必须一字不差 —— 跨进程的常量没有共享文件可放。
 */
const IMAGE_TASK_CANCELLED_MARKER = 'IMAGE_TASK_CANCELLED_BY_USER'

/** 取消的卡片写哪一句，由界面语言决定，所以存的是 key */
const CANCELLED_BY_USER_ERROR_KEY = 'aigcImageHistoryPanel.error.cancelledByUser'

function isCancelledMarker(raw: string | undefined | null): boolean {
  return String(raw || '').trim() === IMAGE_TASK_CANCELLED_MARKER
}

/**
 * 库里那条原始 `error_msg` 怎么交给界面：能翻的给 i18n key，
 * 翻不了的（厂商原文）在这里过一遍友好化。
 *
 * **只给读库这一路用。** `failed` 事件里的文案已经由主进程友好化过了，
 * 再过一遍就是按两套阈值压两次 —— 主进程超过 100 字才压成通用句，这里是 50 字，
 * 中间那一段「主进程特意原样透出的原因」会在卡片上变成一句
 * 「生成失败，请稍后重试」，用户照着它什么也做不了。
 *
 * 两个字段都要显式赋值 —— 它们是 `Object.assign` 到同一条任务上的，
 * 上一次失败留下的那个字段不清掉就会盖住这一次。
 */
function describeTaskError(raw: string | undefined | null): {
  error?: string
  errorKey?: string
} {
  if (isCancelledMarker(raw)) {
    return { error: undefined, errorKey: CANCELLED_BY_USER_ERROR_KEY }
  }
  return { error: getFriendlyErrorMessage(raw), errorKey: undefined }
}

/**
 * 图片生成任务状态
 */
export type ImageTaskStatus = 'pending' | 'processing' | 'completed' | 'failed'

/**
 * 图片生成任务
 */
export interface ImageGenerationTask {
  id: string
  dbId?: number
  prompt: string
  /** AI 生成的任务名称 */
  name?: string
  status: ImageTaskStatus
  progress: number
  imageUrls?: string[]
  /** 本地保存路径数组（用于资产库定位） */
  localPaths?: string[]
  /** 参考图数组（最多9张） */
  referenceImages?: string[]
  ratio?: string
  /** 分辨率 1K/2K/4K */
  resolution?: string
  provider?: string
  model?: string
  quality?: string
  style?: string
  count?: number
  /** 材质模式 - 生成 PBR 贴图 */
  materialMode?: boolean
  error?: string
  /** 失败原因的 i18n key（取消这类主进程说不出语言的原因走它，优先于 `error`） */
  errorKey?: string
  createdAt?: string
  lastUpdatedAt?: number
}

/**
 * 一条记录该拿哪些地址去显示。
 *
 * `imageUrls` 是模型那边给回来的地址：远端链接过几天就失效，`data:` 又长得吓人。
 * 只要资产库里已经落了本地副本（`localPaths`），显示就优先走它 ——
 * 关掉应用第二天再打开，历史里的图还在，靠的就是这一步。
 *
 * 两个数组同序。某一格没有本地副本（旧记录、或者那张保存失败）就单独回落到远端链接，
 * 不影响其它格 —— 索引必须和 `localPaths` 对得上，下载那边是按下标取的。
 */
export function getTaskDisplayUrls(
  task: Pick<ImageGenerationTask, 'imageUrls' | 'localPaths'> | null | undefined
): string[] {
  const remoteUrls = task?.imageUrls || []
  const localPaths = task?.localPaths || []
  const total = Math.max(remoteUrls.length, localPaths.length)

  const urls: string[] = []
  for (let index = 0; index < total; index++) {
    const url = toLocalResourceUrl(localPaths[index]) || remoteUrls[index]
    if (url) urls.push(url)
  }
  return urls
}

export const useImageStudioStore = defineStore('imageStudio', () => {
  // ============ 任务管理 ============

  /** 当前活跃任务列表 */
  const activeTasks = ref<ImageGenerationTask[]>([])

  /** 历史记录 */
  const historyTasks = ref<ImageGenerationTask[]>([])

  /** 当前预览的任务ID */
  const previewTaskId = ref<string | null>(null)

  /** 历史加载锁 */
  const isLoadingHistory = ref(false)

  /** 是否还有更多历史记录 */
  const hasMoreHistory = ref(true)

  /** 数据库真实历史总数 */
  const historyTotal = ref(0)

  const HISTORY_PAGE_SIZE = 12

  /** 是否已初始化事件监听 */
  let isListenerInitialized = false
  let watchdogTimer: ReturnType<typeof setInterval> | null = null

  // ============ 计算属性 ============

  /** 是否有活跃任务 */
  const hasActiveTasks = computed(() => activeTasks.value.length > 0)

  /** 当前预览的任务 */
  const previewTask = computed(() => {
    if (!previewTaskId.value) return null
    return (
      [...activeTasks.value, ...historyTasks.value].find((t) => t.id === previewTaskId.value) ||
      null
    )
  })

  /** 当前预览的图片列表（本地副本优先，见 getTaskDisplayUrls） */
  const previewImages = computed(() => getTaskDisplayUrls(previewTask.value))

  /** 所有任务列表（活跃 + 历史） */
  const allTasks = computed(() => [...activeTasks.value, ...historyTasks.value])

  // ============ 主进程事件监听 ============

  /**
   * 初始化主进程事件监听
   */
  function setupMainProcessListeners(): void {
    if (isListenerInitialized) return
    isListenerInitialized = true

    window.electron?.ipcRenderer.on(
      'image:event',
      (
        _event: unknown,
        data: {
          type: 'taskCreated' | 'progress' | 'complete' | 'failed' | 'nameUpdated'
          taskId: string
          dbId?: number
          progress?: number
          imageUrls?: string[]
          /** 本地保存路径数组 */
          localPaths?: string[]
          /** 是否为材质模式 */
          materialMode?: boolean
          /** AI生成的任务名称 */
          name?: string
          /** 没拿到 AI 名字的可识别原因（见 shared/aiNamingErrorKey.ts） */
          nameErrorKey?: string
          error?: string
        }
      ) => {
        console.log('[ImageStudio] 收到主进程事件:', data.type, data.taskId)

        switch (data.type) {
          case 'taskCreated':
            updateTaskStatus(data.taskId, 'processing', { dbId: data.dbId })
            break
          case 'progress':
            updateTaskStatus(data.taskId, 'processing', { progress: data.progress })
            break
          case 'complete':
            updateTaskStatus(data.taskId, 'completed', {
              imageUrls: data.imageUrls,
              localPaths: data.localPaths,
              progress: 100,
              materialMode: data.materialMode
            })
            // 自动设置为预览
            if (data.taskId) setPreviewTask(data.taskId)
            break
          case 'failed':
            // 事件里的文案主进程已经友好化过了，这里只做标记映射、原文照传 ——
            // 再过一遍渲染层那套（阈值 50 字，主进程是 100 字）会把厂商说清楚的
            // 那些原因压成一句「生成失败，请稍后重试」。
            updateTaskStatus(
              data.taskId,
              'failed',
              isCancelledMarker(data.error)
                ? { error: undefined, errorKey: CANCELLED_BY_USER_ERROR_KEY }
                : { error: data.error, errorKey: undefined }
            )
            break
          case 'nameUpdated':
            // 更新任务名称（不改变状态）
            if (data.name) {
              const task = [...activeTasks.value, ...historyTasks.value].find(
                (t) => t.id === data.taskId
              )
              if (task) {
                task.name = data.name
              }
            }
            /*
              只有「一个看得懂图的模型都没绑」这一种说出来：不去设置里绑一个，
              AIGC 出的图永远只能叫 image_1699…，而用户不知道为什么。
              网络抖动、余额不够、密钥解不开那几种主进程不给 nameErrorKey ——
              那些是一次性失败，弹出来等于把用户赶去一个已经填好的页面。
            */
            if (data.nameErrorKey === NO_VISION_MODEL_ERROR_KEY) {
              message.warning(i18n.global.t('assetManagement.aiNaming.noVisionModel'))
            }
            break
        }
      }
    )

    console.log('[ImageStudio] 主进程事件监听已初始化')
    startTaskWatchdog()
  }

  function startTaskWatchdog(): void {
    if (watchdogTimer) return

    watchdogTimer = setInterval(() => {
      const now = Date.now()

      for (const task of [...activeTasks.value]) {
        const lastUpdatedAt = task.lastUpdatedAt || new Date(task.createdAt || 0).getTime() || now
        const idleMs = now - lastUpdatedAt

        if (task.status === 'pending' && !task.dbId && idleMs > PENDING_START_TIMEOUT_MS) {
          updateTaskStatus(task.id, 'failed', {
            error: '图片任务启动超时，请重试。'
          })
          continue
        }

        if (task.status !== 'processing') continue

        if (task.progress <= 0 && idleMs > PROCESSING_NO_PROGRESS_TIMEOUT_MS) {
          updateTaskStatus(task.id, 'failed', {
            error: '长时间没有收到启动进度，请重试。'
          })
          continue
        }

        if (task.progress > 0 && task.progress < 100 && idleMs > PROCESSING_IDLE_TIMEOUT_MS) {
          updateTaskStatus(task.id, 'failed', {
            error: '生成任务长时间无响应，请重试。'
          })
        }
      }
    }, 10_000)
  }

  /**
   * 创建新的生成任务
   * @param params 任务参数
   */
  function createTask(params: {
    prompt: string
    /** 参考图数组（最多9张） */
    referenceImages?: string[]
    ratio?: string
    /** 分辨率 1K/2K/4K */
    resolution?: string
    provider?: string
    model?: string
    quality?: string
    style?: string
    count?: number
    /** 材质模式 */
    materialMode?: boolean
  }): ImageGenerationTask {
    const model = params.model || GPT_IMAGE_MODEL
    const provider = params.provider || getImageProviderForModel(model) || GPT_IMAGE_PROVIDER
    const task: ImageGenerationTask = {
      id: `img_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      prompt: params.prompt,
      status: 'pending',
      progress: 0,
      referenceImages: params.referenceImages,
      ratio: params.materialMode ? '1:1' : params.ratio || '1:1',
      resolution: params.resolution || '2K',
      model,
      provider,
      quality: params.quality,
      style: params.style || '智能推荐',
      count: params.materialMode ? 4 : params.count || 1,
      materialMode: params.materialMode,
      createdAt: new Date().toISOString(),
      lastUpdatedAt: Date.now()
    }

    activeTasks.value.unshift(task)
    historyTotal.value += 1
    return task
  }

  /**
   * 更新任务状态
   */
  function updateTaskStatus(
    taskId: string,
    status: ImageTaskStatus,
    extra?: Partial<ImageGenerationTask>
  ): void {
    // 先在活跃任务中查找
    let task = activeTasks.value.find((t) => t.id === taskId)
    let isInHistory = false

    // 回退查找历史记录
    if (!task) {
      task = historyTasks.value.find((t) => t.id === taskId)
      isInHistory = true
    }

    if (!task) {
      console.warn(`[ImageStudio] updateTaskStatus: 任务 ${taskId} 未找到`)
      return
    }

    // 已经落进历史的终态不许被后到的事件翻回进行中。
    // 取消的任务会收到比取消更晚的 taskCreated / progress：翻回 processing 的那张卡
    // 留在历史里转圈，而看门狗只遍历 activeTasks —— 再没人能把它超时掉。
    // `complete` 不在此列：图真的落进资产库了，说完成比说失败更接近事实。
    if (
      isInHistory &&
      (task.status === 'failed' || task.status === 'completed') &&
      (status === 'pending' || status === 'processing')
    ) {
      console.log(`[ImageStudio] 任务 ${taskId} 已是终态，忽略后到的 ${status} 事件`)
      return
    }

    task.status = status
    task.lastUpdatedAt = Date.now()
    if (extra) {
      Object.assign(task, extra)
    }

    // 完成或失败时移到历史
    if ((status === 'completed' || status === 'failed') && !isInHistory) {
      const index = activeTasks.value.findIndex((t) => t.id === taskId)
      if (index !== -1) {
        activeTasks.value.splice(index, 1)
        historyTasks.value.unshift(task)
      }
    }
  }

  /**
   * 设置预览任务
   */
  function setPreviewTask(taskId: string | null): void {
    previewTaskId.value = taskId
  }

  /**
   * 库里存的 JSON 数组字段。
   *
   * 一行数据坏掉不该把整页历史带走 —— 裸 `JSON.parse` 抛出来会让 loadHistory
   * 整个失败，用户看到的是空白列表而不是「少了一条」。
   */
  function parseJsonArray(value: unknown, fallback: string[] | undefined): string[] | undefined {
    if (typeof value !== 'string' || !value) return fallback
    try {
      const parsed = JSON.parse(value)
      return Array.isArray(parsed) ? parsed : fallback
    } catch {
      console.warn('[ImageStudio] 历史记录里有解析不了的 JSON 字段，已跳过')
      return fallback
    }
  }

  function mapHistoryRecord(record: any): ImageGenerationTask {
    return {
      id: record.task_id || `db_${record.id}`,
      dbId: record.id,
      prompt: record.prompt || '',
      name: record.name || undefined,
      status: mapDbStatus(record.status),
      progress: record.progress || 0,
      imageUrls: parseJsonArray(record.image_urls, []),
      localPaths: parseJsonArray(record.local_paths, undefined),
      referenceImages: parseJsonArray(record.reference_images, undefined),
      ratio: record.ratio,
      resolution: record.resolution,
      provider: record.provider,
      model: record.model,
      quality: record.quality,
      style: record.style,
      count: record.count,
      materialMode: Boolean(record.material_mode),
      ...describeTaskError(record.error_msg),
      createdAt: record.created_at,
      lastUpdatedAt: Date.now()
    }
  }

  function markInterruptedTasks(
    tasks: ImageGenerationTask[],
    mainProcessActiveTaskIds: Set<string>
  ): ImageGenerationTask[] {
    const interruptedTasks: ImageGenerationTask[] = []
    for (const task of tasks) {
      if (task.status === 'pending' || task.status === 'processing') {
        if (mainProcessActiveTaskIds.has(task.id)) continue
        task.status = 'failed'
        task.error = '任务被刷新中断，请重新生成'
        interruptedTasks.push(task)
      }
    }
    return interruptedTasks
  }

  function persistInterruptedTasks(interruptedTasks: ImageGenerationTask[]): void {
    if (interruptedTasks.length === 0) return

    console.log('[ImageStudio] 标记中断任务为失败:', interruptedTasks.length)
    for (const task of interruptedTasks) {
      if (task.dbId) {
        window.electron.ipcRenderer
          .invoke('image:updateStatus', {
            id: task.dbId,
            status: 'failed',
            error_msg: '任务被刷新中断，请重新生成'
          })
          .catch((err) => console.error('[ImageStudio] 更新任务状态失败:', err))
      }
    }
  }

  async function fetchMainProcessActiveTaskIds(): Promise<Set<string>> {
    try {
      const result = await window.electron.ipcRenderer.invoke('image:getActiveTasks')
      const taskIds = Array.isArray(result?.tasks) ? result.tasks : []
      return new Set(taskIds.filter((taskId): taskId is string => typeof taskId === 'string'))
    } catch (error) {
      console.warn('[ImageStudio] Failed to read active image tasks:', error)
      return new Set()
    }
  }

  /**
   * 从数据库加载历史记录
   */
  async function loadHistory(): Promise<void> {
    if (isLoadingHistory.value) return
    isLoadingHistory.value = true

    try {
      const result = await window.electron.ipcRenderer.invoke('image:getHistory', {
        limit: HISTORY_PAGE_SIZE,
        offset: 0
      })

      if (result.success && result.data) {
        const records = Array.isArray(result.data) ? result.data : []
        const tasks: ImageGenerationTask[] = records.map(mapHistoryRecord)
        const mainProcessActiveTaskIds = await fetchMainProcessActiveTaskIds()

        // A refresh can happen while the main process is still generating.
        // Only mark stale records as failed when the main process no longer tracks them.
        persistInterruptedTasks(markInterruptedTasks(tasks, mainProcessActiveTaskIds))

        // 所有任务都归入历史
        const restoredActiveTasks = tasks.filter(
          (task) =>
            mainProcessActiveTaskIds.has(task.id) &&
            (task.status === 'pending' || task.status === 'processing')
        )
        const restoredActiveTaskIds = new Set(restoredActiveTasks.map((task) => task.id))

        activeTasks.value = restoredActiveTasks
        historyTasks.value = tasks.filter((task) => !restoredActiveTaskIds.has(task.id))
        historyTotal.value = Number(result.total ?? records.length)
        hasMoreHistory.value = records.length === HISTORY_PAGE_SIZE

        console.log('[ImageStudio] 加载历史记录:', tasks.length)
      }
    } catch (error) {
      console.error('[ImageStudio] 加载历史失败:', error)
    } finally {
      isLoadingHistory.value = false
    }
  }

  /**
   * 继续加载历史记录
   */
  async function loadMoreHistory(): Promise<void> {
    if (isLoadingHistory.value || !hasMoreHistory.value) return
    isLoadingHistory.value = true

    try {
      const result = await window.electron.ipcRenderer.invoke('image:getHistory', {
        limit: HISTORY_PAGE_SIZE,
        offset: historyTasks.value.length
      })

      if (result.success && result.data) {
        const records = Array.isArray(result.data) ? result.data : []
        const tasks: ImageGenerationTask[] = records.map(mapHistoryRecord)
        const mainProcessActiveTaskIds = await fetchMainProcessActiveTaskIds()
        persistInterruptedTasks(markInterruptedTasks(tasks, mainProcessActiveTaskIds))

        const existingIds = new Set(historyTasks.value.map((task) => task.id))
        for (const task of tasks) {
          if (
            mainProcessActiveTaskIds.has(task.id) &&
            (task.status === 'pending' || task.status === 'processing')
          ) {
            if (!activeTasks.value.some((activeTask) => activeTask.id === task.id)) {
              activeTasks.value.push(task)
            }
            continue
          }

          if (!existingIds.has(task.id)) {
            historyTasks.value.push(task)
          }
        }

        if (typeof result.total === 'number') {
          historyTotal.value = result.total
        }
        hasMoreHistory.value = records.length === HISTORY_PAGE_SIZE
        console.log('[ImageStudio] 加载更多历史记录:', tasks.length)
      }
    } catch (error) {
      console.error('[ImageStudio] 加载更多历史失败:', error)
    } finally {
      isLoadingHistory.value = false
    }
  }

  /**
   * 删除任务
   */
  async function deleteTask(taskId: string): Promise<void> {
    try {
      const existingTask = historyTasks.value.find((t) => t.id === taskId)
      await window.electron.ipcRenderer.invoke('image:deleteTask', taskId)
      historyTasks.value = historyTasks.value.filter((t) => t.id !== taskId)
      if (existingTask) {
        historyTotal.value = Math.max(0, historyTotal.value - 1)
      }
      if (previewTaskId.value === taskId) {
        previewTaskId.value = null
      }
    } catch (error) {
      console.error('[ImageStudio] 删除任务失败:', error)
    }
  }

  /**
   * 映射数据库状态
   */
  function mapDbStatus(dbStatus?: string | null): ImageTaskStatus {
    const map: Record<string, ImageTaskStatus> = {
      pending: 'pending',
      processing: 'processing',
      completed: 'completed',
      failed: 'failed'
    }
    return map[dbStatus || ''] || 'pending'
  }

  return {
    // 状态
    activeTasks,
    historyTasks,
    previewTaskId,
    isLoadingHistory,
    hasMoreHistory,
    historyTotal,
    // 计算属性
    hasActiveTasks,
    previewTask,
    previewImages,
    allTasks,
    // 方法
    setupMainProcessListeners,
    createTask,
    updateTaskStatus,
    setPreviewTask,
    loadHistory,
    loadMoreHistory,
    deleteTask
  }
})
