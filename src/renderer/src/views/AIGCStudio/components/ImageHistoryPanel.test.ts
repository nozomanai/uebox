import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import zhCN from '@renderer/i18n/locales/zh-CN'
import { message } from '@renderer/utils/messageManager'
import { useImageStudioStore, type ImageGenerationTask } from '../imageStore'

const ImageHistoryPanel = (await import('./ImageHistoryPanel.vue')).default

const cancelTask = vi.fn<(taskId: string) => Promise<{ success: boolean; error?: string }>>()

/** 主进程取消任务时写进 error_msg 和 failed 事件的标记（真源在 imagePollingService.ts） */
const CANCELLED_MARKER = 'IMAGE_TASK_CANCELLED_BY_USER'

function task(patch: Partial<ImageGenerationTask> = {}): ImageGenerationTask {
  return {
    id: 'img_1',
    prompt: '石头材质',
    status: 'processing',
    progress: 30,
    createdAt: new Date().toISOString(),
    lastUpdatedAt: Date.now(),
    ...patch
  }
}

async function mountPanel(): Promise<VueWrapper> {
  const wrapper = mount(ImageHistoryPanel, {
    global: {
      stubs: {
        AppDropdown: true,
        AppMenu: true,
        AppMenuItem: true
      }
    }
  })
  await flushPromises()
  return wrapper
}

/**
 * 挂上 store 对主进程事件的监听，并把那个回调交出来。
 *
 * 取消的终态只由主进程发事件说，所以这几条用例必须从真的事件入口进去，
 * 不能直接改 store 的字段 —— 那样「标记怎么变成界面上的一句话」就没人测了。
 */
function mainProcessEvents(): (payload: Record<string, unknown>) => void {
  const store = useImageStudioStore()
  store.setupMainProcessListeners()
  const on = window.electron.ipcRenderer.on as unknown as {
    mock: { calls: Array<[string, (event: unknown, payload: Record<string, unknown>) => void]> }
  }
  const registered = on.mock.calls.find(([channel]) => channel === 'image:event')
  if (!registered) throw new Error('store 没有挂上 image:event 监听')
  return (payload) => registered[1](null, payload)
}

/** 按钮上挂的是通用「取消」文案，这也是界面上唯一能定位它的稳定标记 */
const CANCEL_SELECTOR = `button[title="${zhCN.common.cancel}"]`

describe('ImageHistoryPanel 取消生图', () => {
  beforeEach(() => {
    localStorage.clear()
    setActivePinia(createPinia())
    vi.clearAllMocks()
    cancelTask.mockResolvedValue({ success: true })
    // @ts-expect-error 测试只需要用到的那一截 preload 接口
    window.api = { imageGeneration: { cancelTask } }
  })

  it('进行中的任务有取消按钮，点了就把这条任务 ID 发给主进程', async () => {
    const store = useImageStudioStore()
    store.activeTasks = [task()]

    const wrapper = await mountPanel()
    const button = wrapper.find(CANCEL_SELECTOR)
    expect(button.exists()).toBe(true)

    await button.trigger('click')
    await flushPromises()

    expect(cancelTask).toHaveBeenCalledWith('img_1')
  })

  /**
   * 回归：这里原来点完就本地把卡片置为失败。那一手恰好只在「其实没取消成功」
   * 的时候起作用（主进程查不到刚起的任务），结果是卡片说失败、主进程照样把图
   * 出完存进资产库，随后的 progress 事件又把这张历史里的卡片翻回转圈。
   * 终态只认主进程那一份。
   */
  it('取消后不在本地改状态，等主进程的终态事件', async () => {
    const store = useImageStudioStore()
    store.activeTasks = [task()]

    const wrapper = await mountPanel()
    await wrapper.find(CANCEL_SELECTOR).trigger('click')
    await flushPromises()

    expect(store.activeTasks).toHaveLength(1)
    expect(store.activeTasks[0]?.status).toBe('processing')
    expect(store.historyTasks).toHaveLength(0)
  })

  /**
   * 失败原因得是「取消」那句可翻译文案。
   *
   * 主进程发过来的是标记：同步出图的 provider abort 抛的是英文 DOMException，
   * 异步任务式的抛「厂商任务仍在运行」—— 两句都不该出现在用户按下取消之后。
   * （文案键 aigcImageHistoryPanel.error.cancelledByUser 由主会话补进语言包，
   * 补上之前 vue-i18n 原样回键名，所以这里断言的是「不是那两句」。）
   */
  it('取消的卡片写的是取消，不是 abort 原始报错', async () => {
    const store = useImageStudioStore()
    store.activeTasks = [task()]
    const emit = mainProcessEvents()

    const wrapper = await mountPanel()
    emit({ type: 'failed', taskId: 'img_1', error: CANCELLED_MARKER })
    await flushPromises()

    expect(store.historyTasks[0]?.status).toBe('failed')
    expect(store.historyTasks[0]?.errorKey).toBe('aigcImageHistoryPanel.error.cancelledByUser')
    expect(store.historyTasks[0]?.error).toBeUndefined()

    const reason = wrapper.find('.error-reason').text()
    expect(reason).not.toContain(CANCELLED_MARKER)
    expect(reason).not.toMatch(/aborted/i)
  })

  /**
   * 回归：窗口期取消过的任务会收到比取消更晚的 taskCreated / progress。
   * 翻回 processing 的那张卡留在历史里转圈，而看门狗只遍历活跃列表，
   * 再没有 12 分钟兜底能收它。
   */
  it('已落终态的卡片不会被后到的事件翻回进行中', async () => {
    const store = useImageStudioStore()
    store.activeTasks = [task()]
    const emit = mainProcessEvents()

    await mountPanel()
    emit({ type: 'failed', taskId: 'img_1', error: CANCELLED_MARKER })
    emit({ type: 'taskCreated', taskId: 'img_1', dbId: 7 })
    emit({ type: 'progress', taskId: 'img_1', progress: 60 })
    await flushPromises()

    expect(store.activeTasks).toHaveLength(0)
    expect(store.historyTasks[0]?.status).toBe('failed')
  })

  it('取消失败时报错，卡片留在进行中', async () => {
    const errorSpy = vi.spyOn(message, 'error').mockImplementation(() => {})
    cancelTask.mockResolvedValue({ success: false, error: '取不掉' })
    const store = useImageStudioStore()
    store.activeTasks = [task()]

    const wrapper = await mountPanel()
    await wrapper.find(CANCEL_SELECTOR).trigger('click')
    await flushPromises()

    expect(errorSpy).toHaveBeenCalledWith('取不掉')
    expect(store.activeTasks[0]?.status).toBe('processing')
  })

  it('已完成的任务没有取消按钮', async () => {
    const store = useImageStudioStore()
    store.historyTasks = [task({ status: 'completed', progress: 100, imageUrls: ['a.png'] })]

    const wrapper = await mountPanel()

    expect(wrapper.find(CANCEL_SELECTOR).exists()).toBe(false)
  })
})
