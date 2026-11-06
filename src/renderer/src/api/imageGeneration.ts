/**
 * 生图任务 IPC 的渲染层封装。
 *
 * ## 为什么要有这一层
 *
 * AGENTS.md §5 规则 5：渲染进程不直接碰 `ipcRenderer`，走 `window.api.*`，
 * **并且在 `src/renderer/src/api/*` 里包一层**。历史面板原来是直接
 * `window.api.imageGeneration.cancelTask(...)`，少了桥的存在性判断 ——
 * 桥没装上（独立窗口、preload 改名）时抛的是
 * 「Cannot read properties of undefined」，而那句话会被原样弹给用户看。
 *
 * ## 为什么这里不用 unwrapResult
 *
 * `unwrapResult()` 失败时抛异常，适合「拿不到数据就没法往下走」的读取类调用。
 * 取消是用户点一下的动作，调用方要自己决定报不报错（历史面板弹 message.error），
 * 抛出去只会逼每个调用点再包一层 try。所以这一层统一的是桥的存在性和返回值形状，
 * 不是抛不抛。同 `api/updater.ts`。
 */

/** 取消生图任务的结果 */
export interface ImageCancelResult {
  success: boolean
  /**
   * 主进程当时有没有在跑这条任务。
   *
   * `false` 不等于取消落空：主进程已经记下这条 ID，任务登记完会自己停掉，
   * 终态随后由 `image:event` 的 failed 送过来。
   */
  found?: boolean
  /** 主进程给的原文。只有主进程自己返回的才往这里放 */
  error?: string
  /**
   * 这一层自己造出来的失败，给 i18n key 而不是成品文案。
   *
   * 写死中文的话英文用户就会看到一句中文（AGENTS.md §5 规则 3）。
   */
  errorKey?: string
}

/** 掐断正在出图的那条任务。终态由主进程写，这里只负责把请求送到 */
async function cancelTask(taskId: string): Promise<ImageCancelResult> {
  const bridge = window.api?.imageGeneration
  if (!bridge) return { success: false, errorKey: 'common.error' }

  try {
    // 没返回结果时两个错误字段都不给：调用方的 `t('common.error')` 兜底才能生效
    return (await bridge.cancelTask(taskId)) ?? { success: false }
  } catch (error) {
    console.error('[imageGeneration] 取消生图任务失败:', error)
    return { success: false, errorKey: 'common.error' }
  }
}

export const imageGenerationAPI = {
  cancelTask
}
