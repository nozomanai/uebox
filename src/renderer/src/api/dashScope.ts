/**
 * AI 智能命名 IPC 的渲染层封装。
 *
 * ## 为什么要有这一层
 *
 * AGENTS.md §5 规则 5：渲染进程不直接碰 `ipcRenderer`，走 `window.api.*`，
 * **并且在 `src/renderer/src/api/*` 里包一层**。资产库原来是直接
 * `(window as any).api.dashScope.generate3DModelName(...)`：`as any` 之后
 * 桥没装上（独立窗口、preload 改名）时抛的是「Cannot read properties of
 * undefined」，而拼错一个方法名编译期一个字都不会提醒。
 *
 * ## 为什么这里不用 unwrapResult
 *
 * `unwrapResult()` 失败时抛异常，适合「拿不到数据就没法往下走」的读取类调用。
 * 智能命名是**可以失败的辅助动作** —— 取不到名字就留原名，调用方按 `errorKey`
 * 自己决定弹不弹。抛出去只会逼调用点再包一层 try。所以这一层统一的是桥的
 * 存在性和返回值形状，不是抛不抛。同 `api/imageGeneration.ts`、`api/updater.ts`。
 */

import type { AiNamingErrorKey } from '@core/shared/aiNamingErrorKey'

/** 智能命名的结果 */
export interface AiNameResult {
  success: boolean
  /** 模型取的名字，已经按文件名规则清洗过 */
  name?: string
  /** 主进程给的原文，只进日志 —— 里面是中文，翻不了 */
  error?: string
  /**
   * 可枚举的失败原因，由 `@core/shared/aiNamingErrorKey` 两端共用。
   *
   * 只有「用户没绑看得懂图的模型」这一种有码：那是他不动手就永远不会好的事。
   * 网断了、余额不够、下载超时都不给码 —— 弹出来等于说他没配置。
   */
  errorKey?: AiNamingErrorKey
}

/**
 * 预加载桥上这个方法的形状。
 *
 * 手写一份是因为 `src/preload/index.d.ts` 里 `dashScope` 目前只声明了 `upload`，
 * `generate3DModelName` 只在 `src/preload/index.ts` 里有实现。等那边补上声明，
 * 这个接口连同下面的断言一起删掉。
 */
interface DashScopeNamingBridge {
  generate3DModelName?: (params: { imageBase64: string }) => Promise<AiNameResult | undefined>
}

function namingBridge(): DashScopeNamingBridge | undefined {
  return window.api?.dashScope as unknown as DashScopeNamingBridge | undefined
}

/** 桥没装上、或者主进程什么都没回：当成一次普通失败，不给 errorKey */
const NO_RESULT: AiNameResult = { success: false }

function failed(error: unknown): AiNameResult {
  console.error('[dashScope] 智能命名失败:', error)
  return { success: false, error: error instanceof Error ? error.message : String(error) }
}

/** 看着缩略图给 3D 模型取个名字。用的是用户自己在 设置 → 模型 里绑的模型 */
async function generate3DModelName(imageBase64: string): Promise<AiNameResult> {
  const bridge = namingBridge()
  if (!bridge?.generate3DModelName) return NO_RESULT

  try {
    return (await bridge.generate3DModelName({ imageBase64 })) ?? NO_RESULT
  } catch (error) {
    return failed(error)
  }
}

export const dashScopeAPI = {
  generate3DModelName
}
