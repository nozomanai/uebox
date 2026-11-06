/**
 * 取消生图任务、以及出图之后那一步「智能命名」的回归用例。
 *
 * 取消这边三条都是真发生过的事故：
 *   一、取消成功了，但生成那条路的 catch 随后又写了一遍库、又发了一条 failed，
 *      把「用户取消」覆盖成 abort 的原始报错（中文界面上一句英文 DOMException，
 *      或者一句「厂商任务仍在运行」—— 和用户刚按下的取消互相矛盾）。
 *   二、任务刚起、还没登记进 activeTasks 时按取消：主进程什么都不做，
 *      IPC 照样回 success，图照出、额度照扣。
 *   三、材质那条路取消后一路走到底：Albedo 已经成功，并行三张全失败也凑不出
 *      「一张都没成」，于是半截贴图进资产库、库里写 completed、卡片翻成「已完成」。
 *
 * 命名那边：取不到中文名时原先完全静默，没绑视觉模型的用户只拿到一个 image_1699…。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as realFs } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { NO_VISION_MODEL_ERROR_KEY } from '../../shared/aiNamingErrorKey'

/** 1×1 的真 PNG：命名和存盘都要能从同一份字节里认出类型 */
const ONE_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg=='

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  resolveImageBinding: vi.fn(),
  generateWithLocalImageModel: vi.fn(),
  createAiImageGeneration: vi.fn(),
  updateAiImageGeneration: vi.fn(),
  getAiImageGenerationByTaskId: vi.fn(),
  generate3DModelName: vi.fn(),
  ensureAIGCDirectory: vi.fn(async () => 'C:/vault/AIGC/图片'),
  createAssetData: vi.fn()
}))

vi.mock('electron', () => ({ net: { fetch: vi.fn() } }))

vi.mock('../appWindows', () => ({
  getAppWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }]
}))

vi.mock('../sqliteDataBase', () => ({ getPublicDatabase: () => ({}) }))

vi.mock('../sqliteDataBase/models/aiImageGeneration', () => ({
  createAiImageGeneration: mocks.createAiImageGeneration,
  updateAiImageGeneration: mocks.updateAiImageGeneration,
  getAiImageGenerationByTaskId: mocks.getAiImageGenerationByTaskId
}))

vi.mock('../sqliteDataBase/models/assetData', () => ({ createAssetData: mocks.createAssetData }))

vi.mock('./aigcVaultService', () => ({
  assertAIGCVaultLocalWritesAllowed: vi.fn(),
  ensureAIGCDirectory: mocks.ensureAIGCDirectory,
  ensureFolderRecord: vi.fn(),
  withAIGCVaultDatabase: vi.fn(async (run: (db: unknown) => Promise<void>) => run({}))
}))

vi.mock('./dashscope/imageAnalyzer', () => ({ generate3DModelName: mocks.generate3DModelName }))

vi.mock('../ai/imageGeneration', () => ({
  IMAGE_CONFIG_ERROR_MARKER: '设置 → 模型',
  resolveImageBinding: mocks.resolveImageBinding
}))

vi.mock('./localImageGeneration', () => ({
  generateWithLocalImageModel: mocks.generateWithLocalImageModel
}))

const { IMAGE_TASK_CANCELLED_MARKER, cancelImageTask, getActiveImageTasks, startImageGeneration } =
  await import('./imagePollingService')

/** 发给渲染层的 failed 事件 */
function failedEvents(): Array<{ taskId: string; error?: string }> {
  return mocks.send.mock.calls
    .map(([, payload]) => payload as { type: string; taskId: string; error?: string })
    .filter((payload) => payload?.type === 'failed')
}

/** 发给渲染层的 complete 事件 */
function completeEvents(): Array<{ taskId: string }> {
  return mocks.send.mock.calls
    .map(([, payload]) => payload as { type: string; taskId: string })
    .filter((payload) => payload?.type === 'complete')
}

/** 发给渲染层的 nameUpdated 事件 */
function nameUpdatedEvents(): Array<{ name?: string; nameErrorKey?: string }> {
  return mocks.send.mock.calls
    .map(([, payload]) => payload as { type: string; name?: string; nameErrorKey?: string })
    .filter((payload) => payload?.type === 'nameUpdated')
}

/** 落库的失败写入 */
function failedWrites(): Array<{ status?: string; error_msg?: string }> {
  return mocks.updateAiImageGeneration.mock.calls
    .map(([, , patch]) => patch as { status?: string; error_msg?: string })
    .filter((patch) => patch?.status === 'failed')
}

/** 落库的完成写入 */
function completedWrites(): Array<{ status?: string }> {
  return mocks.updateAiImageGeneration.mock.calls
    .map(([, , patch]) => patch as { status?: string })
    .filter((patch) => patch?.status === 'completed')
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.ensureAIGCDirectory.mockResolvedValue('C:/vault/AIGC/图片')
  mocks.resolveImageBinding.mockResolvedValue({
    provider: { id: 'gemini' },
    modelId: 'gemini-3.1-flash-image-preview'
  })
  mocks.createAiImageGeneration.mockReturnValue(7)
  mocks.getAiImageGenerationByTaskId.mockReturnValue(undefined)
})

describe('取消正在出图的任务', () => {
  /**
   * provider 抛什么，取消后的终态都得是「用户取消」。
   * 同步出图那一支抛的是 DOMException（友好化规则对它零命中、长度不到 100 字，
   * 会被原样透出），异步任务式那一支抛的是「厂商任务仍在运行」。
   */
  it.each([
    ['同步出图的 abort', new DOMException('This operation was aborted', 'AbortError')],
    [
      '异步任务式 provider',
      new Error('已停止等待。厂商任务仍在运行，额度已扣除，可凭任务号 abc 取回结果。')
    ]
  ])('%s：终态是用户取消，不是 abort 报错', async (_label, abortError) => {
    mocks.getAiImageGenerationByTaskId.mockReturnValue({ id: 7, status: 'processing' })
    mocks.generateWithLocalImageModel.mockImplementation(
      (_body: unknown, signal?: AbortSignal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(abortError))
        })
    )

    const started = startImageGeneration('img_cancel', { prompt: '石头材质' })
    await vi.waitFor(() => expect(getActiveImageTasks()).toContain('img_cancel'))

    expect(cancelImageTask('img_cancel')).toEqual({ found: true })
    await started

    // 库里和界面上都只有一条终态，而且原因是取消
    expect(failedWrites()).toEqual([{ status: 'failed', error_msg: IMAGE_TASK_CANCELLED_MARKER }])
    expect(failedEvents()).toEqual([
      { type: 'failed', taskId: 'img_cancel', error: IMAGE_TASK_CANCELLED_MARKER }
    ])
    expect(getActiveImageTasks()).not.toContain('img_cancel')
  })

  /**
   * 取消比响应晚一点到：图已经从厂商那边回来了，存盘还没开始。
   * 接着存盘就是「卡片说取消、资产库里躺着那张图、库里写 completed」。
   */
  it('响应回来之后才取消：不存盘、不写完成', async () => {
    mocks.getAiImageGenerationByTaskId.mockReturnValue({ id: 7, status: 'processing' })
    mocks.generateWithLocalImageModel.mockImplementation(async () => {
      // 响应已经到手，这一刻用户按下取消
      cancelImageTask('img_late')
      return { ok: true, images: [{ url: 'https://cdn.example.com/one.png' }] }
    })

    const result = await startImageGeneration('img_late', { prompt: '石头材质' })

    expect(result.success).toBe(false)
    expect(mocks.ensureAIGCDirectory).not.toHaveBeenCalled()
    expect(mocks.createAssetData).not.toHaveBeenCalled()
    expect(completedWrites()).toEqual([])
    expect(completeEvents()).toEqual([])
    expect(failedWrites()).toEqual([{ status: 'failed', error_msg: IMAGE_TASK_CANCELLED_MARKER }])
    expect(getActiveImageTasks()).not.toContain('img_late')
  })

  /** 主进程给的是标记而不是中文成品文案，否则英文界面上会冒出一句中文 */
  it('终态文案由渲染层翻译，主进程只给标记', () => {
    mocks.getAiImageGenerationByTaskId.mockReturnValue({ id: 7, status: 'processing' })
    cancelImageTask('img_stale')

    expect(failedEvents()[0]?.error).toBe(IMAGE_TASK_CANCELLED_MARKER)
    expect(failedEvents()[0]?.error).not.toMatch(/[\u4e00-\u9fa5]/)
  })
})

describe('取消 PBR 材质任务', () => {
  /**
   * Albedo 出完、并行三张在跑的时候按取消：三张会一起失败，但 `allMaps` 里
   * 还有那张 Albedo —— 「一张都没成」凑不出来，于是不进 catch，一路走到
   * 存资产库 + status=completed + complete 事件。用户按下取消，卡片几十秒后
   * 变「已完成」，半截贴图躺在资产库里，额度照扣。
   */
  function albedoThenHangingMaps(): { requestCount: () => number } {
    let calls = 0
    mocks.generateWithLocalImageModel.mockImplementation((_body: unknown, signal?: AbortSignal) => {
      calls += 1
      if (calls === 1) {
        return Promise.resolve({
          ok: true,
          images: [{ url: 'https://cdn.example.com/albedo.png' }]
        })
      }
      return new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () =>
          reject(new DOMException('This operation was aborted', 'AbortError'))
        )
      })
    })
    return { requestCount: () => calls }
  }

  beforeEach(() => {
    mocks.getAiImageGenerationByTaskId.mockReturnValue({ id: 7, status: 'processing' })
  })

  it('取消后不保存已出的贴图、不写完成状态', async () => {
    const { requestCount } = albedoThenHangingMaps()

    const started = startImageGeneration('img_pbr', { prompt: '石头材质', materialMode: true })
    // 等到并行那三张都发出去了 —— 这正是 Albedo 已经成功的那段窗口
    await vi.waitFor(() => expect(requestCount()).toBe(4))

    expect(cancelImageTask('img_pbr')).toEqual({ found: true })
    const result = await started

    expect(result.success).toBe(false)
    // 半截贴图不许进资产库
    expect(mocks.ensureAIGCDirectory).not.toHaveBeenCalled()
    expect(mocks.createAssetData).not.toHaveBeenCalled()
    // 终态只有「用户取消」这一条，没有 completed
    expect(completedWrites()).toEqual([])
    expect(completeEvents()).toEqual([])
    expect(failedWrites()).toEqual([{ status: 'failed', error_msg: IMAGE_TASK_CANCELLED_MARKER }])
    expect(failedEvents()).toEqual([
      { type: 'failed', taskId: 'img_pbr', error: IMAGE_TASK_CANCELLED_MARKER }
    ])
    expect(getActiveImageTasks()).not.toContain('img_pbr')
  })

  /** 重试包装原先不看信号：取消之后还要再发两轮，每轮之间白等 3 秒 */
  it('取消后不再发下一轮重试，也不等重试间隔', async () => {
    const { requestCount } = albedoThenHangingMaps()

    const started = startImageGeneration('img_pbr_retry', {
      prompt: '石头材质',
      materialMode: true
    })
    await vi.waitFor(() => expect(requestCount()).toBe(4))

    cancelImageTask('img_pbr_retry')
    const cancelledAt = Date.now()
    await started

    expect(requestCount()).toBe(4)
    expect(Date.now() - cancelledAt).toBeLessThan(1500)
  })
})

describe('任务还没登记就被取消', () => {
  it('取消请求记在主进程，任务登记时自己停掉，不去出图', async () => {
    // 解析模型绑定这一步卡住 —— 这正是 IPC handler 已经回了渲染层、
    // 而 activeTasks 里还没有这条任务的那段窗口
    let releaseBinding = (): void => {}
    mocks.resolveImageBinding.mockReturnValue(
      new Promise((resolve) => {
        releaseBinding = () =>
          resolve({ provider: { id: 'gemini' }, modelId: 'gemini-3.1-flash-image-preview' })
      })
    )

    const started = startImageGeneration('img_window', { prompt: '石头材质' })
    expect(getActiveImageTasks()).not.toContain('img_window')

    // 窗口期里按取消：主进程这会儿确实查不到任务，但不能就此不管
    expect(cancelImageTask('img_window')).toEqual({ found: false })

    releaseBinding()
    const result = await started

    expect(result.success).toBe(false)
    // 关键：图不许出
    expect(mocks.generateWithLocalImageModel).not.toHaveBeenCalled()
    expect(failedWrites()).toEqual([{ status: 'failed', error_msg: IMAGE_TASK_CANCELLED_MARKER }])
    expect(failedEvents()).toEqual([
      { type: 'failed', taskId: 'img_window', error: IMAGE_TASK_CANCELLED_MARKER }
    ])
    expect(getActiveImageTasks()).not.toContain('img_window')
  })

  /** 刷新过的那条：主进程早就没有它了，库里还留着一条 processing */
  it('库里留着半截记录时直接写终态', () => {
    mocks.getAiImageGenerationByTaskId.mockReturnValue({ id: 9, status: 'processing' })

    expect(cancelImageTask('img_refreshed')).toEqual({ found: false })

    expect(mocks.updateAiImageGeneration).toHaveBeenCalledWith({}, 9, {
      status: 'failed',
      error_msg: IMAGE_TASK_CANCELLED_MARKER
    })
    expect(failedEvents()).toHaveLength(1)
  })

  /** 已经出完图的记录不许被一条迟到的取消按成失败 */
  it('已完成的记录不动', () => {
    mocks.getAiImageGenerationByTaskId.mockReturnValue({ id: 9, status: 'completed' })

    expect(cancelImageTask('img_done')).toEqual({ found: false })

    expect(failedWrites()).toEqual([])
    expect(failedEvents()).toEqual([])
  })
})

describe('出图之后的智能命名', () => {
  /** 有 prompt 就直接截取，走视觉模型这条路得把 prompt 留空 */
  async function generateWithoutPrompt(taskId: string): Promise<{ success: boolean }> {
    const tmpDir = await realFs.mkdtemp(join(tmpdir(), 'uebox-aigc-'))
    tempDirs.push(tmpDir)
    mocks.ensureAIGCDirectory.mockResolvedValue(tmpDir)
    mocks.generateWithLocalImageModel.mockResolvedValue({
      ok: true,
      images: [{ base64: ONE_PIXEL_PNG_BASE64 }]
    })
    return startImageGeneration(taskId, { prompt: '' })
  }

  const tempDirs: string[] = []

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await realFs.rm(dir, { recursive: true, force: true })
    }
  })

  it('没绑视觉模型时把原因交给界面，名字回退到时间戳', async () => {
    mocks.generate3DModelName.mockResolvedValue({
      success: false,
      error: '一个看得懂图的模型都没绑',
      errorKey: NO_VISION_MODEL_ERROR_KEY
    })

    const result = await generateWithoutPrompt('img_no_vision')

    expect(result.success).toBe(true)
    expect(nameUpdatedEvents()).toEqual([
      {
        type: 'nameUpdated',
        taskId: 'img_no_vision',
        name: expect.stringMatching(/^image_\d+$/),
        nameErrorKey: NO_VISION_MODEL_ERROR_KEY
      }
    ])
  })

  /** 网络抖动这类一次性失败不带原因码 —— 界面据此决定弹不弹 */
  it('一次性失败不带原因码', async () => {
    mocks.generate3DModelName.mockResolvedValue({
      success: false,
      error: '缩略图下载失败: HTTP 502'
    })

    await generateWithoutPrompt('img_flaky')

    expect(nameUpdatedEvents()[0]?.nameErrorKey).toBeUndefined()
  })

  /** 同一张图原先下两遍：命名那一步自己又下了一次 */
  it('命名用的是存盘那次读到的字节，不再下一遍', async () => {
    mocks.generate3DModelName.mockResolvedValue({ success: true, name: '青苔石砖' })

    await generateWithoutPrompt('img_named')

    expect(mocks.generate3DModelName).toHaveBeenCalledTimes(1)
    expect(mocks.generate3DModelName.mock.calls[0][0]).toBe(
      `data:image/png;base64,${ONE_PIXEL_PNG_BASE64}`
    )
    expect(nameUpdatedEvents()[0]?.name).toBe('青苔石砖')
  })
})
