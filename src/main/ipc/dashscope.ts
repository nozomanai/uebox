import { ipcMain, app } from 'electron'
import {
  uploadFileAndGetUrl,
  DEFAULT_VL_MODEL,
  OssUploadResult
} from '../services/dashscope/ossUpload'
import { generate3DModelName, generateNameFromPrompt } from '../services/dashscope/imageAnalyzer'

/**
 * 上传文件请求参数
 */
interface UploadFileArgs {
  /** 本地文件路径 */
  filePath: string
  /** API Key（可选，不传则从环境变量获取） */
  apiKey?: string
  /** 模型名称（可选，默认使用 DEFAULT_VL_MODEL） */
  modelName?: string
}

/**
 * 注册 DashScope 相关 IPC 处理器
 */
export function registerDashScopeIPC(): void {
  /**
   * 上传文件到阿里云百炼临时存储，获取临时 URL
   *
   * @param args.filePath - 本地文件路径（必需）
   * @param args.apiKey - 用户自己的 API Key（开发环境允许从环境变量获取）
   * @param args.modelName - 模型名称（可选，默认使用 vl 配置或 qwen3-vl-flash）
   *
   * @returns 上传结果
   */
  ipcMain.handle(
    'dashscope:upload',
    async (_event, args: UploadFileArgs): Promise<OssUploadResult> => {
      const { filePath, apiKey: providedApiKey, modelName: providedModelName } = args

      // 验证文件路径
      if (!filePath) {
        return { success: false, error: '文件路径不能为空' }
      }

      // 优先使用用户提供的 Key，开发环境可读取本机环境变量。
      const apiKey = app.isPackaged
        ? providedApiKey
        : providedApiKey || process.env.DASHSCOPE_API_KEY

      if (!apiKey) {
        return {
          success: false,
          error: '请配置百炼 API Key'
        }
      }

      // 获取模型名称
      const modelName = providedModelName || DEFAULT_VL_MODEL
      console.log(`[DashScope IPC] 使用模型: ${modelName}`)

      // 执行上传
      console.log(`[DashScope IPC] 开始上传文件: ${filePath}, 模型: ${modelName}`)
      const result = await uploadFileAndGetUrl({
        apiKey,
        modelName,
        filePath
      })

      return result
    }
  )

  /**
   * 看着缩略图给 3D 模型取名。用用户自己绑的图片理解模型，不绑任何一家厂商。
   *
   * @param args.imageBase64 - 模型缩略图的 Base64 数据
   * @returns 生成的名称；没绑看得懂图的模型时带 `errorKey`，界面据此提示去配置
   */
  ipcMain.handle(
    'dashscope:generate3DModelName',
    async (
      _event,
      args: { imageBase64: string }
    ): Promise<{ success: boolean; name?: string; error?: string; errorKey?: string }> => {
      const { imageBase64 } = args

      if (!imageBase64) {
        return { success: false, error: '缩略图数据不能为空' }
      }

      console.log('[DashScope IPC] 开始使用视觉模型为3D模型命名')
      const result = await generate3DModelName(imageBase64)

      return result
    }
  )

  /**
   * 使用LLM从Prompt生成名称（文生模型：分析Prompt）
   *
   * @param args.prompt - 用户输入的生成Prompt
   * @returns 生成的名称
   */
  ipcMain.handle(
    'dashscope:generateNameFromPrompt',
    async (
      _event,
      args: { prompt: string }
    ): Promise<{ success: boolean; name?: string; error?: string }> => {
      const { prompt } = args

      if (!prompt) {
        return { success: false, error: 'Prompt不能为空' }
      }

      console.log('[DashScope IPC] 开始使用LLM从Prompt生成名称')
      const result = await generateNameFromPrompt(prompt)

      return result
    }
  )

  console.log('[DashScope IPC] 处理器已注册')
}
