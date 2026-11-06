/**
 * 图片生成轮询服务
 * 在主进程中执行图片生成，并通过 IPC 事件通知渲染进程
 * 生成完成后自动保存到资产库 /AIGC/图片/
 */

import { net } from 'electron'
import { getAppWindows } from '../appWindows'
import { promises as fs } from 'fs'
import { join } from 'path'
import { getPublicDatabase } from '../sqliteDataBase'
import {
  createAiImageGeneration,
  updateAiImageGeneration,
  getAiImageGenerationByTaskId
} from '../sqliteDataBase/models/aiImageGeneration'
import { createAssetData } from '../sqliteDataBase/models/assetData'
import {
  assertAIGCVaultLocalWritesAllowed,
  ensureAIGCDirectory,
  ensureFolderRecord,
  withAIGCVaultDatabase
} from './aigcVaultService'
import { generate3DModelName } from './dashscope/imageAnalyzer'
import { IMAGE_CONFIG_ERROR_MARKER, resolveImageBinding } from '../ai/imageGeneration'
import { NO_VISION_MODEL_ERROR_KEY, type AiNamingErrorKey } from '../../shared/aiNamingErrorKey'
import {
  decodeImageDataUri,
  mediaTypeFromContentType,
  resolveImageExtension
} from './imageFileType'
import { generateWithLocalImageModel } from './localImageGeneration'
import {
  GPT_IMAGE_PROVIDER,
  GPT_IMAGE_MODEL,
  normalizeImageQuality,
  normalizeImageResolutionForModel,
  normalizeImageRatioForModel
} from '../../shared/imageGenerationModels'
const electronNetFetch: typeof fetch = (input, init) =>
  net.fetch(input as Parameters<typeof net.fetch>[0], init)
const SUPPORTED_ASPECT_RATIOS = new Set([
  '1:1',
  '1:4',
  '1:8',
  '2:3',
  '3:2',
  '3:4',
  '4:1',
  '4:3',
  '4:5',
  '5:4',
  '8:1',
  '9:16',
  '16:9',
  '21:9'
])

/**
 * 图片生成请求参数
 */
interface ImageGenerationParams {
  prompt: string
  /** 参考图数组（最多9张） */
  referenceImages?: string[]
  ratio?: string
  /** 分辨率 1K/2K/4K */
  resolution?: string
  model?: string
  style?: string
  quality?: string
  clientRequestId?: string
  count?: number
  provider?: string
  /** 材质模式 - 生成 Albedo/Roughness/Normal/AO 四张 PBR 贴图 */
  materialMode?: boolean
}

type ImageGenerateApiImage = {
  url?: string
  base64?: string
}

type ImageGenerateApiResult = {
  ok?: boolean
  status?: 'processing' | 'completed' | 'failed' | 'needs_review' | 'not_found'
  clientRequestId?: string
  images?: ImageGenerateApiImage[]
  result?: ImageGenerateApiResult
  error?: string | { message?: string }
  message?: string
  metadata?: Record<string, unknown>
}

type ImageGenerateRequestOptions = {
  requestBody: Record<string, unknown>
  senderId?: number
  signal?: AbortSignal
  clientRequestId: string
}

function normalizeAspectRatio(ratio?: string): string {
  const normalized = String(ratio || '1:1').trim()
  if (SUPPORTED_ASPECT_RATIOS.has(normalized)) {
    return normalized
  }
  return '1:1'
}
async function resolveImageTarget(
  params: ImageGenerationParams
): Promise<{ provider: string; model: string }> {
  const target = await resolveImageBinding({
    prompt: params.prompt,
    providerId: params.provider,
    modelId: params.model
  })
  return { provider: target.provider.id, model: target.modelId }
}

function buildFinalPrompt(prompt: string, style?: string): string {
  const basePrompt = String(prompt || '').trim()
  const normalizedStyle = String(style || '').trim()
  if (!normalizedStyle || normalizedStyle === '智能推荐') {
    return basePrompt
  }
  return `${basePrompt}，风格：${normalizedStyle}`
}

/**
 * 活跃任务管理
 */
const activeTasks = new Map<
  string,
  {
    params: ImageGenerationParams
    abortController: AbortController
    progressTimer?: NodeJS.Timeout
    senderId?: number
  }
>()

/**
 * 用户取消的标记。
 *
 * 落库的 `error_msg` 和 `failed` 事件里放的都是这一个值，不是成品文案：
 * 主进程不知道界面是什么语言（`src/main/i18n.ts` 文件头：能交给渲染层的文案就别
 * 写在主进程），渲染层拿到标记再去查语言包。这里曾经写死一句「用户取消」，
 * 英文界面上照样显示中文。
 *
 * 渲染层那份同名常量在 `src/renderer/src/views/AIGCStudio/imageStore.ts`，
 * 改这里要一起改 —— 跨进程的常量没有共享文件可放。
 *
 * 它只走 `failed` 事件和 `error_msg`，**不往 IPC 的返回值里放**：那条返回值
 * 被调用方当成一句能直接弹的错误用（`result.error || t('…')`），
 * 标记漏过去就是在界面上弹一行 `IMAGE_TASK_CANCELLED_BY_USER`。
 * 取消的终态由 `markImageTaskCancelled` 一处发出，返回值只说「这次没出图」。
 */
export const IMAGE_TASK_CANCELLED_MARKER = 'IMAGE_TASK_CANCELLED_BY_USER'

/**
 * 还没登记就被取消的任务 ID。
 *
 * `startImageGeneration` 要先解析模型绑定、建库记录，才把任务放进 `activeTasks`。
 * 这段窗口里按取消，`cancelImageTask` 什么都查不到 —— 以前它就此 return，而 IPC
 * 照样回 `success`，于是图照出、钱照扣、卡片永远转圈。现在把 ID 记在这里，
 * 任务登记完自己检查一次：取消的权威在主进程，不靠渲染层猜。
 *
 * 只存 ID、带上限：条目正常只活到任务登记那一瞬，超过上限的按先进先出丢掉，
 * 不让它变成一张只增不减的表。
 */
const cancelledTaskIds = new Set<string>()
const CANCELLED_TASK_ID_LIMIT = 50

function rememberCancelledTaskId(taskId: string): void {
  cancelledTaskIds.add(taskId)
  while (cancelledTaskIds.size > CANCELLED_TASK_ID_LIMIT) {
    const oldest = cancelledTaskIds.values().next().value
    if (oldest === undefined) break
    cancelledTaskIds.delete(oldest)
  }
}

/** 取一次就清掉：同一条任务不会被取消两遍 */
function consumeCancelledTaskId(taskId: string): boolean {
  return cancelledTaskIds.delete(taskId)
}

/**
 * 写下「这条任务是用户取消的」这个终态：库里一条、渲染层一条。
 *
 * 终态只由取消这条路写。生成那边的 catch 看到 `signal.aborted` 就什么都不写，
 * 否则后到的那一条会把原因覆盖成 abort 的原始报错。
 */
function markImageTaskCancelled(taskId: string, dbId?: number): void {
  const db = getPublicDatabase()
  const recordId = dbId ?? getAiImageGenerationByTaskId(db, taskId)?.id
  if (recordId) {
    updateAiImageGeneration(db, recordId, {
      status: 'failed',
      error_msg: IMAGE_TASK_CANCELLED_MARKER
    })
  }

  sendToRenderer('failed', { taskId, error: IMAGE_TASK_CANCELLED_MARKER })
}

/**
 * 发送事件到渲染进程
 * @param type 事件类型
 * @param data 事件数据
 */
function sendToRenderer(type: string, data: Record<string, unknown>): void {
  const windows = getAppWindows()
  for (const win of windows) {
    if (!win.isDestroyed()) {
      win.webContents.send('image:event', { type, ...data })
    }
  }
}

function extractBackendErrorMessage(errorMsg: string): string | null {
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
      // Ignore malformed JSON fragments and keep falling back.
    }
  }

  return null
}

/**
 * 将 API 错误消息转换为用户友好的中文提示
 * @param errorMsg 原始错误消息
 * @returns 用户友好的错误提示
 */
function getFriendlyErrorMessage(errorMsg: string): string {
  const normalizedMsg = extractBackendErrorMessage(errorMsg) || errorMsg
  if (normalizedMsg.includes('参考图上传失败') || normalizedMsg.includes('上传接口地址无效')) {
    return normalizedMsg
  }

  // 本地生图模型的配置类错误本身就是「该怎么改」的说明，必须原样透出。
  // 下面那套按关键词归类 + 超过 100 字就截断的规则会把它压成一句
  // 「生成失败，请稍后重试」—— 正确，但用户照着它什么也做不了。
  if (normalizedMsg.includes(IMAGE_CONFIG_ERROR_MARKER)) {
    return normalizedMsg
  }

  const lowerMsg = normalizedMsg.toLowerCase()

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
    return '模型服务认证失败，请检查该服务的 API Key 或登录状态'
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

  // 其他错误：返回简化消息
  if (normalizedMsg.length > 100) {
    return '生成失败，请稍后重试'
  }

  return normalizedMsg
}

/**
 * 生成图片名称
 * 优先使用 prompt 截取，没有时使用 VL 识别
 *
 * 取不到中文名时除了回退名，还把**可识别的原因**一起交出去：没绑视觉模型的用户
 * 在这条路上原先只拿到一个 `image_1699…`，界面上一个字都没有。
 * 网络抖动、余额不够这类一次性失败不带原因码 —— 那不是用户没配置。
 *
 * @param prompt 用户提示词
 * @param image 首图字节（用于 VL 识别，由调用方下好传进来）
 */
async function generateImageName(
  prompt: string,
  image?: { buffer: Buffer; mediaType: string | null }
): Promise<{ name: string; errorKey?: AiNamingErrorKey }> {
  // 1. 优先从 prompt 截取
  if (prompt && prompt.trim()) {
    let name = prompt.trim()
    // 截取前20字符
    if (name.length > 20) {
      name = name.substring(0, 20)
    }
    // 清理非法文件名字符
    name = name.replace(/[\\/:*?"<>|]/g, '_')
    return { name }
  }

  // 2. 使用 VL 识别
  if (image) {
    try {
      const dataUri = `data:${image.mediaType || 'image/png'};base64,${image.buffer.toString('base64')}`
      const result = await generate3DModelName(dataUri)
      if (result.success && result.name) {
        return { name: result.name }
      }
      console.warn('[ImagePollingService] VL命名失败:', result.error)
      if (result.errorKey === NO_VISION_MODEL_ERROR_KEY) {
        return { name: `image_${Date.now()}`, errorKey: NO_VISION_MODEL_ERROR_KEY }
      }
    } catch (error) {
      console.error('[ImagePollingService] VL命名失败:', error)
    }
  }

  // 3. 回退：使用时间戳
  return { name: `image_${Date.now()}` }
}

/**
 * 取回一张图的字节，顺便定下它该用什么扩展名。
 *
 * 两件事必须一起做：data URI 的类型写在前缀里，远端图片的类型在响应头里，
 * 分开取就会出现「按 A 判类型、按 B 拿数据」的错位。判定规则见 imageFileType.ts。
 */
async function readImageBytes(
  url: string
): Promise<{ buffer: Buffer; extension: string; mediaType: string | null }> {
  if (url.startsWith('data:')) {
    const { mediaType, base64 } = decodeImageDataUri(url)
    const buffer = Buffer.from(base64, 'base64')
    return { buffer, mediaType, extension: resolveImageExtension({ mediaType, bytes: buffer }) }
  }

  const response = await electronNetFetch(url)
  if (!response.ok) throw new Error(`下载失败: HTTP ${response.status}`)

  const buffer = Buffer.from(await response.arrayBuffer())
  const mediaType = mediaTypeFromContentType(response.headers.get('content-type'))
  return {
    buffer,
    mediaType,
    extension: resolveImageExtension({
      mediaType,
      url,
      bytes: buffer
    })
  }
}

/**
 * 保存图片到资产库 /AIGC/图片/
 * @param imageUrls 图片URL列表
 * @param taskId 任务ID
 * @param prompt 提示词（用于命名）
 */
async function saveImagesToAssetLibrary(
  imageUrls: string[],
  _taskId: string, // 参数保留用于接口兼容
  prompt: string,
  notePrompt: string = prompt
): Promise<{
  success: boolean
  savedPaths: string[]
  generatedName?: string
  /** 没拿到中文名的可识别原因（没绑视觉模型），给界面弹提示用 */
  nameErrorKey?: AiNamingErrorKey
  error?: string
}> {
  try {
    assertAIGCVaultLocalWritesAllowed()

    const baseDir = await ensureAIGCDirectory('AIGC', '图片')

    // 首图只下一次：命名要看它，存盘也要用它的字节。
    // 原先命名那一步自己又下了一遍，同一张几 MB 的图下两遍。
    const firstImage = imageUrls.length > 0 ? await readImageBytes(imageUrls[0]) : undefined
    const naming = await generateImageName(prompt, firstImage)
    const baseName = naming.name
    const savedPaths: string[] = []
    const timestamp = Date.now()
    const randomSuffix = Math.random().toString(36).slice(2, 6)
    const note = String(notePrompt || '').trim()

    await withAIGCVaultDatabase(async (db) => {
      ensureFolderRecord(db, 'AIGC', null, 'system', 'AIGC')
      ensureFolderRecord(db, 'AIGC_image', 'AIGC', 'folder', '图片')

      for (let i = 0; i < imageUrls.length; i++) {
        const url = imageUrls[i]

        // 扩展名要等拿到图才知道：远端那一支的类型在响应头里，
        // 所以先取字节再拼文件名，不能反过来。首图上面已经取过，别再下一遍。
        const { buffer, extension } = i === 0 && firstImage ? firstImage : await readImageBytes(url)
        const fileName =
          imageUrls.length > 1
            ? `${baseName}_${timestamp}_${randomSuffix}_${i + 1}.${extension}`
            : `${baseName}_${timestamp}_${randomSuffix}.${extension}`
        const filePath = join(baseDir, fileName)

        await fs.writeFile(filePath, buffer)
        savedPaths.push(filePath)

        createAssetData(db, {
          assetKey: `aigc_img_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          folderKey: 'AIGC_image',
          assetName: fileName,
          filePath,
          originPath: filePath,
          fileSize: buffer.length,
          fileExtension: extension,
          modifiedTime: new Date().toISOString(),
          processorType: 'AIGC',
          assetType: 'Texture',
          classNameCn: 'AI 图片',
          classColor: '#9B59B6',
          note
        })

        console.log(`[ImagePollingService] 保存图片: ${fileName}`)
      }
    })

    return { success: true, savedPaths, generatedName: baseName, nameErrorKey: naming.errorKey }
  } catch (error) {
    console.error('[ImagePollingService] 保存图片失败:', error)
    return {
      success: false,
      savedPaths: [],
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

// ============ PBR 材质贴图生成相关函数 ============

/**
 * 构建 Albedo（基础色/漫反射）贴图 Prompt
 * @param userMaterialDesc 用户输入的材质描述（可选，用于文生图模式）
 */
function buildAlbedoPrompt(userMaterialDesc?: string): string {
  const materialHint = userMaterialDesc
    ? `Create a seamless PBR Albedo/Diffuse texture of: ${userMaterialDesc}`
    : `Generate a seamless PBR Albedo/Diffuse texture map from this material photo`

  return `${materialHint}:
- Extract pure color information only, completely remove ALL lighting, shadows, and reflections
- Create a perfectly seamless tileable pattern with no visible seams at edges
- Uniform flat lighting appearance as if photographed in a light box
- 1:1 square aspect ratio, suitable for 3D material workflow
- High resolution, sharp details, production-ready quality
- Output should look like a professional game/architectural texture asset`
}

/**
 * 构建 Roughness（粗糙度）贴图 Prompt
 * 从已生成的 Albedo 推断表面粗糙度特性
 */
function buildRoughnessPrompt(): string {
  return `Generate a seamless PBR Roughness map based on this Albedo texture:
- Output a GRAYSCALE image only (no color)
- WHITE areas = rough/matte surfaces (diffuse reflection)
- BLACK areas = smooth/glossy surfaces (specular reflection)
- Analyze the material type from Albedo to determine appropriate roughness values
- Seamless tileable pattern that perfectly aligns with the reference Albedo
- Same scale, resolution, and alignment as the reference texture
- 1:1 square aspect ratio`
}

/**
 * 构建 Normal（法线）贴图 Prompt
 * 从 Albedo 推断表面几何细节
 */
function buildNormalPrompt(): string {
  return `Generate a seamless PBR Normal map based on this Albedo texture:
- Output an RGB normal map in TANGENT SPACE (OpenGL convention: Y-up)
- Predominantly BLUE color with red/green variations encoding surface direction
- Flat areas should be pure blue (128,128,255)
- Capture all surface micro-geometry, bumps, scratches, and relief details
- Seamless tileable pattern matching the reference Albedo exactly
- Same scale and alignment as the reference texture
- 1:1 square aspect ratio, production-ready for game engines`
}

/**
 * 构建 Ambient Occlusion（环境光遮蔽）贴图 Prompt
 * 从 Albedo 推断几何遮蔽信息
 */
function buildAOPrompt(): string {
  return `Generate a seamless Ambient Occlusion (AO) map based on this Albedo texture:
- Output a GRAYSCALE image only (no color)
- WHITE areas = fully exposed to ambient light
- BLACK areas = occluded/shadowed in crevices and corners
- Add soft contact shadows in grooves, gaps, and concave areas
- Seamless tileable pattern matching the reference Albedo
- Subtle, realistic occlusion - avoid harsh black areas
- Same scale and alignment as the reference texture
- 1:1 square aspect ratio`
}

/**
 * 调用图片生成 API（单张）
 * @param prompt 提示词
 * @param ratio 比例
 * @param resolution 分辨率 1K/2K/4K
 * @param referenceImage 参考图（可选）
 * @param signal 中止信号
 */
async function generateSingleImage(
  prompt: string,
  ratio: string,
  resolution: string,
  senderId?: number,
  referenceImage?: string,
  signal?: AbortSignal,
  provider = GPT_IMAGE_PROVIDER,
  model = GPT_IMAGE_MODEL,
  quality?: string,
  clientRequestId = createImageClientRequestId('single', Date.now())
): Promise<{ success: boolean; imageUrl?: string; error?: string }> {
  try {
    const normalizedResolution = normalizeImageResolutionForModel(model, resolution)
    const normalizedRatio = normalizeImageRatioForModel(model, normalizeAspectRatio(ratio))
    const requestBody: Record<string, unknown> = {
      provider,
      model,
      prompt,
      imageSize: normalizedResolution,
      aspectRatio: normalizedRatio,
      batchSize: 1
    }

    if (quality) {
      requestBody.quality = normalizeImageQuality(quality)
    }

    if (referenceImage) {
      requestBody.image = referenceImage
    }

    console.log(
      `[generateSingleImage] 发送请求, prompt 长度: ${prompt.length}, 有参考图: ${!!referenceImage}`
    )

    const result = await requestImageGenerationResult({
      requestBody,
      senderId,
      signal,
      clientRequestId
    })
    console.log(`[generateSingleImage] 响应: ok=${result.ok}, images=${result.images?.length || 0}`)

    const imageUrl = extractImageUrlsFromResult(result)[0]
    if (!imageUrl) {
      const errorMessage = getImageApiErrorMessage(result)
      return { success: false, error: errorMessage || '未获取到有效图片' }
    }

    console.log(`[generateSingleImage] 成功获取图片`)
    return { success: true, imageUrl }
  } catch (error) {
    console.log(
      `[generateSingleImage] 异常: ${error instanceof Error ? error.message : String(error)}`
    )
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * 延时函数。取消之后立刻返回 —— 重试间隔是用户按下取消后最长的一段白等。
 * @param ms 延时毫秒数
 * @param signal 中止信号
 */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise((resolve) => {
    // 计时器句柄存在对象里，`finish` 才能既被计时器调用、又被 abort 调用，
    // 而不出现「先用后声明」
    const pending: { timer?: NodeJS.Timeout } = {}
    const finish = (): void => {
      if (pending.timer) clearTimeout(pending.timer)
      signal?.removeEventListener('abort', finish)
      resolve()
    }
    pending.timer = setTimeout(finish, ms)
    signal?.addEventListener('abort', finish, { once: true })
  })
}

function createImageClientRequestId(...parts: Array<string | number | undefined>): string {
  const raw = parts
    .filter((part) => part !== undefined && part !== null && String(part).trim())
    .map((part) => String(part).trim())
    .join(':')
  const normalized = raw.replace(/[^A-Za-z0-9_.:-]/g, '-').replace(/-+/g, '-')
  return normalized.slice(0, 150)
}

function getImageApiErrorMessage(result: ImageGenerateApiResult | null | undefined): string {
  const error = result?.error
  if (typeof error === 'string') return error
  if (typeof error?.message === 'string') return error.message
  if (typeof result?.message === 'string') return result.message
  return 'Image generation failed'
}
async function requestImageGenerationResult({
  requestBody,
  signal
}: ImageGenerateRequestOptions): Promise<ImageGenerateApiResult> {
  return generateWithLocalImageModel(requestBody, signal)
}

function extractImageUrlsFromResult(result: ImageGenerateApiResult): string[] {
  const images = result.images || []
  const imageUrls: string[] = []
  for (const img of images) {
    if (img.url) {
      imageUrls.push(img.url)
    } else if (img.base64) {
      imageUrls.push(
        img.base64.startsWith('data:') ? img.base64 : `data:image/png;base64,${img.base64}`
      )
    }
  }
  return imageUrls
}

/**
 * 单张视图生成（带重试）
 * @param viewName 视图名称
 * @param prompt 提示词
 * @param ratio 比例
 * @param resolution 分辨率 1K/2K/4K
 * @param referenceImage 参考图
 * @param signal 中止信号
 * @param maxRetries 最大重试次数
 */
async function generateImageWithRetry(
  viewName: string,
  prompt: string,
  ratio: string,
  resolution: string,
  senderId: number | undefined,
  referenceImage: string | undefined,
  signal: AbortSignal,
  maxRetries: number = 3,
  provider = GPT_IMAGE_PROVIDER,
  model = GPT_IMAGE_MODEL,
  quality?: string,
  clientRequestIdBase = createImageClientRequestId(viewName, Date.now())
): Promise<{ success: boolean; imageUrl?: string; error?: string }> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    // 取消之后一次都不再发：原先这里只把信号传给请求，被取消的那次失败照样
    // 进下一轮重试，用户按下取消还要再等两轮（每轮之间还白等 3 秒）。
    if (signal.aborted) {
      return { success: false, error: IMAGE_TASK_CANCELLED_MARKER }
    }

    const attemptClientRequestId = createImageClientRequestId(
      clientRequestIdBase,
      `attempt-${attempt}`
    )
    console.log(`[ImagePollingService] ${viewName} 第${attempt}次尝试`)
    const result = await generateSingleImage(
      prompt,
      ratio,
      resolution,
      senderId,
      referenceImage,
      signal,
      provider,
      model,
      quality,
      attemptClientRequestId
    )

    if (result.success && result.imageUrl) {
      console.log(`[ImagePollingService] ${viewName} 生成成功`)
      return result
    }

    console.log(`[ImagePollingService] ${viewName} 第${attempt}次失败: ${result.error}`)

    if (attempt < maxRetries) {
      // 重试前等待3秒
      await delay(3000, signal)
    }
  }

  return { success: false, error: `${viewName}生成失败，已重试${maxRetries}次` }
}

async function startMaterialGeneration(
  taskId: string,
  params: ImageGenerationParams,
  senderId?: number
): Promise<{ success: boolean; error?: string }> {
  const target = await resolveImageTarget(params)
  console.log(`[ImagePollingService] 启动 PBR 材质生成任务: ${taskId}`)

  // 参考图可选 - 支持图生图或文生图
  const hasReferenceImage = params.referenceImages && params.referenceImages.length > 0

  const db = getPublicDatabase()
  const dbId = createAiImageGeneration(db, {
    task_id: taskId,
    prompt: params.prompt || 'PBR Material',
    reference_images: params.referenceImages ? JSON.stringify(params.referenceImages) : null,
    ratio: '1:1', // 材质贴图固定 1:1
    resolution: params.resolution || '2K',
    model: target.model,
    style: 'PBR Material',
    count: 4,
    material_mode: 1,
    provider: target.provider,
    status: 'processing',
    progress: 0
  })

  const abortController = new AbortController()
  activeTasks.set(taskId, { params, abortController, senderId })

  // 和单图那条一样：取消可能在登记之前就到了（见 cancelImageTask）
  if (consumeCancelledTaskId(taskId)) {
    abortController.abort()
    activeTasks.delete(taskId)
    markImageTaskCancelled(taskId, dbId)
    console.log(`[ImagePollingService] PBR 材质任务登记时发现已被取消: ${taskId}`)
    return { success: false }
  }

  sendToRenderer('taskCreated', { taskId, dbId })

  // 收集所有贴图结果
  const allMaps: { type: string; url: string }[] = []
  const resolution = params.resolution || '2K'
  const sourceImage = hasReferenceImage ? params.referenceImages![0] : undefined

  try {
    // ========== Phase 1: 生成 Albedo ==========
    sendToRenderer('progress', { taskId, progress: 5, phase: 'albedo' })
    updateAiImageGeneration(db, dbId, { progress: 5 })
    console.log(`[ImagePollingService] 生成 Albedo 贴图 (1/4)`)

    const albedoResult = await generateImageWithRetry(
      'Albedo',
      buildAlbedoPrompt(params.prompt),
      '1:1',
      resolution,
      senderId,
      sourceImage,
      abortController.signal,
      3,
      target.provider,
      target.model,
      undefined,
      createImageClientRequestId(taskId, 'albedo')
    )

    if (!albedoResult.success || !albedoResult.imageUrl) {
      throw new Error(`Albedo 生成失败: ${albedoResult.error}`)
    }
    allMaps.push({ type: 'albedo', url: albedoResult.imageUrl })

    sendToRenderer('progress', { taskId, progress: 25, phase: 'albedo_complete' })
    updateAiImageGeneration(db, dbId, { progress: 25 })
    console.log(`[ImagePollingService] Albedo 完成 (1/4)`)

    // ========== Phase 2: 并行生成 Roughness、Normal、AO ==========
    sendToRenderer('progress', { taskId, progress: 30, phase: 'parallel_maps' })
    console.log(`[ImagePollingService] 并行生成 Roughness/Normal/AO (2-4/4)`)

    const [roughnessResult, normalResult, aoResult] = await Promise.all([
      generateImageWithRetry(
        'Roughness',
        buildRoughnessPrompt(),
        '1:1',
        resolution,
        senderId,
        albedoResult.imageUrl,
        abortController.signal,
        3,
        target.provider,
        target.model,
        undefined,
        createImageClientRequestId(taskId, 'roughness')
      ),
      generateImageWithRetry(
        'Normal',
        buildNormalPrompt(),
        '1:1',
        resolution,
        senderId,
        albedoResult.imageUrl,
        abortController.signal,
        3,
        target.provider,
        target.model,
        undefined,
        createImageClientRequestId(taskId, 'normal')
      ),
      generateImageWithRetry(
        'AO',
        buildAOPrompt(),
        '1:1',
        resolution,
        senderId,
        albedoResult.imageUrl,
        abortController.signal,
        3,
        target.provider,
        target.model,
        undefined,
        createImageClientRequestId(taskId, 'ao')
      )
    ])

    // 收集成功结果
    if (roughnessResult.success && roughnessResult.imageUrl) {
      allMaps.push({ type: 'roughness', url: roughnessResult.imageUrl })
    } else {
      console.warn(`[ImagePollingService] Roughness 生成失败: ${roughnessResult.error}`)
    }

    if (normalResult.success && normalResult.imageUrl) {
      allMaps.push({ type: 'normal', url: normalResult.imageUrl })
    } else {
      console.warn(`[ImagePollingService] Normal 生成失败: ${normalResult.error}`)
    }

    if (aoResult.success && aoResult.imageUrl) {
      allMaps.push({ type: 'ao', url: aoResult.imageUrl })
    } else {
      console.warn(`[ImagePollingService] AO 生成失败: ${aoResult.error}`)
    }

    sendToRenderer('progress', { taskId, progress: 90, phase: 'maps_complete' })
    updateAiImageGeneration(db, dbId, { progress: 90 })
    console.log(`[ImagePollingService] 并行贴图生成完成`)

    // 取消就停在这里，不往下走存盘和置 completed。
    //
    // 这条判断不能只靠下面那个 `allMaps.length === 0` + catch：Phase 2 期间按取消时
    // Albedo 已经在 allMaps 里了，并行那三张全失败也凑不出 0 —— 于是一路走到底，
    // 半截贴图进资产库、库里写 completed、卡片几十秒后翻成「已完成」，
    // 而用户几十秒前就按了取消。终态由 cancelImageTask 写，这里什么都不写。
    if (abortController.signal.aborted) {
      activeTasks.delete(taskId)
      console.log(`[ImagePollingService] PBR 材质任务已取消，不保存已出的贴图: ${taskId}`)
      return { success: false }
    }

    // ========== 检查成功数量 ==========
    if (allMaps.length === 0) {
      throw new Error('所有贴图生成均失败')
    }

    const isPartialSuccess = allMaps.length < 4
    if (isPartialSuccess) {
      console.warn(`[ImagePollingService] 部分成功: ${allMaps.length}/4 张`)
    }

    // ========== 保存到资产库 ==========
    sendToRenderer('progress', { taskId, progress: 95, phase: 'saving' })
    const imageUrls = allMaps.map((m) => m.url)
    console.log(`[ImagePollingService] PBR 材质生成完成: ${allMaps.length}/4 张`)

    const baseName = params.prompt?.substring(0, 20) || 'material'
    const saveResult = await saveImagesToAssetLibrary(
      imageUrls,
      taskId,
      `${baseName}_pbr`,
      params.prompt
    )
    if (saveResult.success) {
      console.log(`[ImagePollingService] PBR 材质已保存到资产库`)
    }

    // 更新数据库，同时保存生成的名称
    updateAiImageGeneration(db, dbId, {
      status: 'completed',
      progress: 100,
      image_urls: JSON.stringify(imageUrls),
      local_paths: JSON.stringify(saveResult.savedPaths),
      name: saveResult.generatedName || null
    })

    // 发送名称更新事件（确保前端实时显示）
    // `nameErrorKey`：没拿到中文名的原因跟着定名字的那条事件走，界面据此弹提示。
    if (saveResult.generatedName) {
      sendToRenderer('nameUpdated', {
        taskId,
        name: saveResult.generatedName,
        nameErrorKey: saveResult.nameErrorKey
      })
    }

    activeTasks.delete(taskId)

    sendToRenderer('complete', {
      taskId,
      imageUrls,
      localPaths: saveResult.savedPaths,
      progress: 100,
      materialMode: true,
      maps: allMaps.map((m) => m.type),
      partialSuccess: isPartialSuccess,
      successCount: allMaps.length,
      totalCount: 4
    })

    return { success: true }
  } catch (error) {
    // 用户取消的终态由 cancelImageTask 写，这里不覆盖（理由见单图那条的同一处判断）。
    // 材质这条的重试包装会把 abort 咽成一句「Albedo生成失败，已重试3次」，
    // 所以判的是信号而不是错误类型。
    if (abortController.signal.aborted) {
      activeTasks.delete(taskId)
      console.log(`[ImagePollingService] PBR 材质任务已取消，跳过失败回写: ${taskId}`)
      return { success: false }
    }

    const rawErrorMsg = error instanceof Error ? error.message : String(error)
    console.error(`[ImagePollingService] PBR 材质任务失败: ${taskId}`, error)

    const errorMsg = getFriendlyErrorMessage(rawErrorMsg)
    updateAiImageGeneration(db, dbId, { status: 'failed', error_msg: rawErrorMsg })
    activeTasks.delete(taskId)
    sendToRenderer('failed', { taskId, error: errorMsg })

    return { success: false, error: errorMsg }
  }
}

/**
 * 启动图片生成任务
 * @param taskId 任务ID
 * @param params 生成参数
 */
export async function startImageGeneration(
  taskId: string,
  params: ImageGenerationParams,
  senderId?: number
): Promise<{ success: boolean; error?: string }> {
  // PBR 材质模式使用级联生成逻辑
  if (params.materialMode) {
    return startMaterialGeneration(taskId, params, senderId)
  }

  console.log(`[ImagePollingService] 启动图片生成任务: ${taskId}`)
  const target = await resolveImageTarget(params)
  const normalizedRatioForModel = normalizeImageRatioForModel(target.model, params.ratio)
  const normalizedResolution = normalizeImageResolutionForModel(target.model, params.resolution)
  const normalizedQuality = params.quality ? normalizeImageQuality(params.quality) : undefined
  const clientRequestId = params.clientRequestId || createImageClientRequestId(taskId, 'single')

  // 创建数据库记录
  const db = getPublicDatabase()
  const dbId = createAiImageGeneration(db, {
    task_id: taskId,
    prompt: params.prompt,
    reference_images: params.referenceImages ? JSON.stringify(params.referenceImages) : null,
    ratio: normalizedRatioForModel,
    resolution: normalizedResolution,
    model: target.model,
    quality: normalizedQuality || null,
    style: params.style || '智能推荐',
    count: 1,
    material_mode: 0,
    provider: target.provider,
    status: 'processing',
    progress: 0
  })

  // 创建 AbortController
  const abortController = new AbortController()

  // 计算预期总时间（每张图片约120秒）
  const totalExpectedTime = 120 * 1000 // 毫秒

  // 启动模拟进度更新
  let elapsed = 0
  const progressInterval = 1000 // 每秒更新一次
  const progressTimer = setInterval(() => {
    elapsed += progressInterval
    // 模拟进度：最大到95%，留5%给完成状态
    const progress = Math.min(95, Math.round((elapsed / totalExpectedTime) * 100))

    updateAiImageGeneration(db, dbId, { progress })
    sendToRenderer('progress', { taskId, progress })
  }, progressInterval)

  // 保存到活跃任务
  activeTasks.set(taskId, {
    params,
    abortController,
    progressTimer,
    senderId
  })

  // 取消有可能比登记先到：IPC handler 只等一个微任务就回了渲染层，而上面
  // 解析模型绑定、建库记录都是异步的。这一步是那条取消请求的落点 ——
  // 没有它，用户按下的取消会落空，图照出、额度照扣。
  if (consumeCancelledTaskId(taskId)) {
    abortController.abort()
    clearInterval(progressTimer)
    activeTasks.delete(taskId)
    markImageTaskCancelled(taskId, dbId)
    console.log(`[ImagePollingService] 任务登记时发现已被取消: ${taskId}`)
    return { success: false }
  }

  // 通知渲染进程任务已创建
  sendToRenderer('taskCreated', { taskId, dbId })

  try {
    const finalPrompt = buildFinalPrompt(params.prompt, params.style)

    const requestBody: Record<string, unknown> = {
      provider: target.provider,
      model: target.model,
      prompt: finalPrompt,
      imageSize: normalizedResolution,
      aspectRatio: normalizedRatioForModel,
      batchSize: 1
    }

    if (normalizedQuality) {
      requestBody.quality = normalizedQuality
    }

    console.log(`[ImagePollingService] 请求参数:`, {
      provider: requestBody.provider,
      model: requestBody.model,
      imageSize: requestBody.imageSize,
      aspectRatio: requestBody.aspectRatio,
      batchSize: requestBody.batchSize,
      referenceImageCount: params.referenceImages?.length || 0
    })

    // 如果有参考图，添加到请求（支持最多9张）
    if (params.referenceImages && params.referenceImages.length > 0) {
      // 使用第一张作为主要参考图
      requestBody.image = params.referenceImages[0]
      // 如果有多张参考图，传递数组
      if (params.referenceImages.length > 1) {
        requestBody.images = params.referenceImages
      }
    }

    console.log(`[ImagePollingService] 发送生成请求: ${taskId}`)

    const result = await requestImageGenerationResult({
      requestBody,
      senderId,
      signal: abortController.signal,
      clientRequestId
    })

    // 停止进度模拟
    clearInterval(progressTimer)

    const imageUrls = extractImageUrlsFromResult(result)

    // 取消比响应晚一点到：请求已经回来了，存盘还没开始。
    // 没有这道判断就会接着存盘、置 completed、发 complete，
    // 而终态已经被 cancelImageTask 写成「用户取消」—— 卡片说已完成，图也进了资产库。
    if (abortController.signal.aborted) {
      activeTasks.delete(taskId)
      console.log(`[ImagePollingService] 任务已取消，不保存这次的出图: ${taskId}`)
      return { success: false }
    }

    if (imageUrls.length === 0) {
      throw new Error(getImageApiErrorMessage(result) || '未获取到有效图片')
    }

    // 保存到资产库 /AIGC/图片/
    const saveResult = await saveImagesToAssetLibrary(imageUrls, taskId, params.prompt)
    if (saveResult.success) {
      console.log(`[ImagePollingService] 图片已保存到资产库: ${saveResult.savedPaths.length}张`)
    }

    // 更新数据库为完成状态，同时保存生成的名称
    updateAiImageGeneration(db, dbId, {
      status: 'completed',
      progress: 100,
      image_urls: JSON.stringify(imageUrls),
      local_paths: JSON.stringify(saveResult.savedPaths),
      name: saveResult.generatedName || null
    })

    // 发送名称更新事件（确保前端实时显示）
    // `nameErrorKey`：没拿到中文名的原因跟着定名字的那条事件走，界面据此弹提示。
    if (saveResult.generatedName) {
      sendToRenderer('nameUpdated', {
        taskId,
        name: saveResult.generatedName,
        nameErrorKey: saveResult.nameErrorKey
      })
    }

    // 清理活跃任务
    activeTasks.delete(taskId)

    // 通知渲染进程完成
    sendToRenderer('complete', {
      taskId,
      imageUrls,
      localPaths: saveResult.savedPaths,
      progress: 100
    })

    console.log(`[ImagePollingService] 任务完成: ${taskId}, 图片数: ${imageUrls.length}`)
    return { success: true }
  } catch (error) {
    // 停止进度模拟
    clearInterval(progressTimer)

    // 用户取消：终态（status=failed、原因是取消）已经由 cancelImageTask 写过了。
    // 这里再写一遍会把它覆盖成 abort 的原始报错 —— 同步出图的 provider 抛的是
    // DOMException（"This operation was aborted"，友好化那套规则对它零命中、
    // 长度又不到 100 字，于是原样透出，中文界面上冒出一句英文），异步任务式
    // provider 抛 ImageTaskCancelledError，卡片会说「厂商任务仍在运行」，
    // 和用户刚按下的取消互相矛盾。所以这条路什么都不写、也不再发 failed。
    if (abortController.signal.aborted) {
      activeTasks.delete(taskId)
      console.log(`[ImagePollingService] 任务已取消，跳过失败回写: ${taskId}`)
      return { success: false }
    }

    const rawErrorMsg = error instanceof Error ? error.message : String(error)
    console.error(`[ImagePollingService] 任务失败: ${taskId}`, error)

    // 将 API 错误转换为用户友好的提示
    const errorMsg = getFriendlyErrorMessage(rawErrorMsg)

    // 更新数据库为失败状态
    updateAiImageGeneration(db, dbId, {
      status: 'failed',
      error_msg: rawErrorMsg // 数据库保存原始错误便于调试
    })

    // 清理活跃任务
    activeTasks.delete(taskId)

    // 通知渲染进程失败（使用友好消息）
    sendToRenderer('failed', {
      taskId,
      error: errorMsg
    })

    return { success: false, error: errorMsg }
  }
}

/**
 * 取消任务。
 *
 * @param taskId 任务ID
 * @returns `found` —— 取消的那一刻主进程正不正在跑这条任务。
 *   `false` 不等于取消落空：ID 已经记下，任务登记完会自己停掉。
 *   调用方（IPC）要的是这个真相，不是一句无条件的 success。
 */
export function cancelImageTask(taskId: string): { found: boolean } {
  const task = activeTasks.get(taskId)
  if (task) {
    task.abortController.abort()
    if (task.progressTimer) {
      clearInterval(task.progressTimer)
    }
    activeTasks.delete(taskId)
    markImageTaskCancelled(taskId)

    console.log(`[ImagePollingService] 任务已取消: ${taskId}`)
    return { found: true }
  }

  // 查不到这条任务有两种情况，都不能默默 return：
  // 一、任务还在登记（handler 一个微任务就回了渲染层，用户可以立刻点取消）——
  //     记下 ID，等 startImageGeneration 把它放进 activeTasks 时自己停掉；
  // 二、刷新过，库里留着一条半截的 processing 记录 —— 主进程这边早就没有它了，
  //     直接把终态写掉，否则那张卡没人能落地。
  rememberCancelledTaskId(taskId)

  const db = getPublicDatabase()
  const record = getAiImageGenerationByTaskId(db, taskId)
  if (record?.id && (record.status === 'processing' || record.status === 'pending')) {
    markImageTaskCancelled(taskId, record.id)
  }

  console.log(`[ImagePollingService] 任务不在运行中，取消请求已记下: ${taskId}`)
  return { found: false }
}

/**
 * 获取所有活跃任务
 */
export function getActiveImageTasks(): string[] {
  return Array.from(activeTasks.keys())
}

/**
 * 导出服务单例
 */
export const imagePollingService = {
  startGeneration: startImageGeneration,
  cancelTask: cancelImageTask,
  getActiveTasks: getActiveImageTasks
}
