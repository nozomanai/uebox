/**
 * AI 图片生成 IPC 接口
 * 处理前端请求，调用主进程服务
 */

import { ipcMain } from 'electron'
import { getPublicDatabase } from '../sqliteDataBase'
import {
  listAiImageGenerations,
  getAiImageGenerationByTaskId,
  deleteAiImageGeneration,
  updateAiImageGeneration,
  countAiImageGenerations
} from '../sqliteDataBase/models/aiImageGeneration'

/**
 * 注册 AI 图片生成 IPC 处理程序
 */
export function registerAiImageIPC(): void {
  /**
   * 启动图片生成任务
   */
  ipcMain.handle(
    'image:startGeneration',
    async (
      event,
      params: {
        taskId: string
        prompt: string
        /** 参考图数组（最多9张） */
        referenceImages?: string[]
        ratio?: string
        /** 分辨率 1K/2K/4K */
        resolution?: string
        model?: string
        style?: string
        quality?: string
        count?: number
        provider?: string
        /** 材质模式 - 生成 PBR 贴图 */
        materialMode?: boolean
      }
    ) => {
      try {
        const hasPrompt = params.prompt && params.prompt.trim()
        if (!hasPrompt) {
          return { success: false, error: '提示词不能为空' }
        }

        const { imagePollingService } = await import('../services/imagePollingService')

        // Start the background task immediately, but wait one microtask so
        // synchronous/bootstrap failures can still be returned to the renderer.
        const startPromise = imagePollingService
          .startGeneration(
            params.taskId,
            {
              prompt: params.prompt,
              referenceImages: params.referenceImages,
              ratio: params.ratio,
              resolution: params.resolution,
              model: params.model,
              style: params.style,
              quality: params.quality,
              count: params.count,
              provider: params.provider,
              materialMode: params.materialMode
            },
            event.sender.id
          )
          .catch((error) => {
            console.error('[image:startGeneration] 后台任务失败:', error)
            return {
              success: false as const,
              error: error instanceof Error ? error.message : String(error)
            }
          })

        const startupResult = await Promise.race([
          startPromise.then((result) => ({ settled: true as const, result })),
          Promise.resolve().then(() => ({ settled: false as const }))
        ])

        if (startupResult.settled) {
          return startupResult.result
        }

        return { success: true }
      } catch (error) {
        console.error('[image:startGeneration] 失败:', error)
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /**
   * 获取图片生成历史记录
   */
  ipcMain.handle(
    'image:getHistory',
    async (
      _,
      options?: {
        status?: string
        limit?: number
        offset?: number
      }
    ) => {
      try {
        const db = getPublicDatabase()
        const records = listAiImageGenerations(db, options)
        const total = countAiImageGenerations(db)
        return { success: true, data: records, total }
      } catch (error) {
        console.error('[image:getHistory] 失败:', error)
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /**
   * 获取单个任务详情
   */
  ipcMain.handle('image:getTask', async (_, taskId: string) => {
    try {
      const db = getPublicDatabase()
      const record = getAiImageGenerationByTaskId(db, taskId)
      return { success: true, data: record }
    } catch (error) {
      console.error('[image:getTask] 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * 取消图片生成任务。
   *
   * `found` 是取消那一刻主进程有没有在跑这条任务。`false` 不代表取消落空 ——
   * 任务 ID 已经记在主进程里，登记完会自己停掉（见 `cancelImageTask`）。
   * 以前这里无条件回 `success: true`，而查不到任务时主进程什么都不做，
   * 于是刚起的任务上按取消会「报成功、图照出」。
   */
  ipcMain.handle('image:cancelTask', async (_, taskId: string) => {
    try {
      const { imagePollingService } = await import('../services/imagePollingService')
      const { found } = imagePollingService.cancelTask(taskId)
      return { success: true, found }
    } catch (error) {
      console.error('[image:cancelTask] 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * 删除历史记录
   */
  ipcMain.handle('image:deleteTask', async (_, taskId: string) => {
    try {
      const db = getPublicDatabase()
      const record = getAiImageGenerationByTaskId(db, taskId)
      if (record?.id) {
        deleteAiImageGeneration(db, record.id)
      }
      return { success: true }
    } catch (error) {
      console.error('[image:deleteTask] 失败:', error)
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    }
  })

  /**
   * 获取活跃任务列表
   */
  ipcMain.handle('image:getActiveTasks', async () => {
    try {
      const { imagePollingService } = await import('../services/imagePollingService')
      return { success: true, tasks: imagePollingService.getActiveTasks() }
    } catch {
      return { success: false, tasks: [] }
    }
  })

  /**
   * 更新任务状态（用于刷新后标记中断任务）
   */
  ipcMain.handle(
    'image:updateStatus',
    async (
      _,
      params: {
        id: number
        status: string
        error_msg?: string
      }
    ) => {
      try {
        const db = getPublicDatabase()
        updateAiImageGeneration(db, params.id, {
          status: params.status,
          error_msg: params.error_msg
        })
        return { success: true }
      } catch (error) {
        console.error('[image:updateStatus] 失败:', error)
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  console.log('[IPC] AI图片生成接口已注册')
}
