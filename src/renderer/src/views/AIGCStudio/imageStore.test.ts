import { describe, expect, it, vi } from 'vitest'
import { message } from '@renderer/utils/messageManager'
import { useImageStudioStore, type ImageGenerationTask } from './imageStore'

/** 主进程取消任务时写进 error_msg 和 failed 事件的标记（真源在 imagePollingService.ts） */
const CANCELLED_MARKER = 'IMAGE_TASK_CANCELLED_BY_USER'

it('preserves upload failure details when restoring history after a refresh', async () => {
  const error = '参考图上传失败 HTTP 400：Image too large. Maximum size is 10MB'
  vi.mocked(window.electron.ipcRenderer.invoke).mockImplementation(async (channel) => {
    if (channel === 'image:getHistory') {
      return {
        success: true,
        data: [{ id: 1, task_id: 'upload-failed', status: 'failed', error_msg: error }]
      }
    }
    return { tasks: [] }
  })
  const store = useImageStudioStore()
  await store.loadHistory()
  expect(store.historyTasks[0].error).toBe(error)
})

function processingTask(): ImageGenerationTask {
  return {
    id: 'img_1',
    prompt: '石头材质',
    status: 'processing',
    progress: 30,
    createdAt: new Date().toISOString(),
    lastUpdatedAt: Date.now()
  }
}

/** 挂上 store 对主进程事件的监听，并把那个回调交出来 */
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

describe('failed 事件的失败原因', () => {
  /**
   * 回归：这条分支曾把事件里的文案又过了一遍渲染层的友好化规则。
   * 两边阈值不一样 —— 主进程超过 100 字才压成通用句，渲染层是 50 字 ——
   * 于是厂商那些 51～100 字、主进程特意原样透出的原因，在卡片上变成一句
   * 「生成失败，请稍后重试」，用户照着它什么也做不了。
   */
  it('主进程已经友好化过的原因原样显示，不再压一遍', () => {
    const reason =
      '模型服务商拒绝了这次生成：该账号开通的区域不提供这个模型，请到控制台把区域换成新加坡，或者在设置里改用其它模型重试。'
    // 这个长度才是回归的关键：主进程放过（≤100），渲染层会压（>50）
    expect(reason.length).toBeGreaterThan(50)
    expect(reason.length).toBeLessThanOrEqual(100)

    const store = useImageStudioStore()
    store.activeTasks = [processingTask()]
    const emit = mainProcessEvents()

    emit({ type: 'failed', taskId: 'img_1', error: reason })

    expect(store.historyTasks[0]?.error).toBe(reason)
    expect(store.historyTasks[0]?.errorKey).toBeUndefined()
  })

  /** 取消给的是标记：界面语言主进程不知道，所以文案落在 errorKey 上 */
  it('取消的标记换成可翻译的 errorKey', () => {
    const store = useImageStudioStore()
    store.activeTasks = [processingTask()]
    const emit = mainProcessEvents()

    emit({ type: 'failed', taskId: 'img_1', error: CANCELLED_MARKER })

    expect(store.historyTasks[0]?.errorKey).toBe('aigcImageHistoryPanel.error.cancelledByUser')
    expect(store.historyTasks[0]?.error).toBeUndefined()
  })

  /** 回归另一侧：这条分支不许再把成品文案当原始报错重压一遍 */
  it('短原因照旧原样显示', () => {
    const store = useImageStudioStore()
    store.activeTasks = [processingTask()]
    const emit = mainProcessEvents()

    emit({ type: 'failed', taskId: 'img_1', error: '网络连接失败，请检查网络后重试' })

    expect(store.historyTasks[0]?.error).toBe('网络连接失败，请检查网络后重试')
  })

  /** 读库那一路是原始 error_msg，没人友好化过，仍旧由 store 压 */
  it('库里的原始报错仍旧在渲染层友好化', async () => {
    const raw = `HTTP 500: ${'x'.repeat(200)}`
    vi.mocked(window.electron.ipcRenderer.invoke).mockImplementation(async (channel) => {
      if (channel === 'image:getHistory') {
        return {
          success: true,
          data: [{ id: 2, task_id: 'db-failed', status: 'failed', error_msg: raw }]
        }
      }
      return { tasks: [] }
    })

    const store = useImageStudioStore()
    await store.loadHistory()

    expect(store.historyTasks[0]?.error).toBe('生成失败，请稍后重试')
  })
})

describe('AI 命名拿不到名字时的提示', () => {
  /**
   * AIGC 出图这条路（主进程轮询）原先完全静默：没绑视觉模型的用户只拿到
   * 一个 `image_1699…`，不知道为什么，也不知道去哪绑。
   */
  it('没绑视觉模型时提示用户，并照旧用回退名', () => {
    const warning = vi.spyOn(message, 'warning').mockImplementation(() => {})
    const store = useImageStudioStore()
    store.activeTasks = [processingTask()]
    const emit = mainProcessEvents()

    emit({
      type: 'nameUpdated',
      taskId: 'img_1',
      name: 'image_1762400000000',
      nameErrorKey: 'noVisionModel'
    })

    expect(warning).toHaveBeenCalledTimes(1)
    expect(store.activeTasks[0]?.name).toBe('image_1762400000000')
  })

  /** 网络抖动、余额不够这些主进程不给 nameErrorKey —— 不许反过来说用户没配置 */
  it('命名正常或只是一次性失败时不提示', () => {
    const warning = vi.spyOn(message, 'warning').mockImplementation(() => {})
    const store = useImageStudioStore()
    store.activeTasks = [processingTask()]
    const emit = mainProcessEvents()

    emit({ type: 'nameUpdated', taskId: 'img_1', name: '青苔石砖' })

    expect(warning).not.toHaveBeenCalled()
    expect(store.activeTasks[0]?.name).toBe('青苔石砖')
  })
})
