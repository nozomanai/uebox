import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_VISION_MODEL_ERROR_KEY } from '@core/shared/aiNamingErrorKey'
import { dashScopeAPI } from './dashScope'

/**
 * 智能命名这一层包的是什么。
 *
 * 调用点原先是 `(window as any).api.dashScope.generate3DModelName(...)`：
 * 桥没装上（独立窗口、preload 改名）时抛的是「Cannot read properties of
 * undefined」，而命名是个辅助动作，不该因为桥不在就把调用方的流程炸断。
 */

const generate3DModelName = vi.fn()

/** 桥装上，按参数返回 */
function withBridge(): void {
  // @ts-expect-error 测试只用到 preload 接口的这一截
  window.api = { dashScope: { generate3DModelName } }
}

describe('dashScopeAPI.generate3DModelName', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    // @ts-expect-error 每条用例自己决定桥在不在
    window.api = undefined
  })

  it('把缩略图 base64 按桥的参数形状发出去，名字原样回来', async () => {
    withBridge()
    generate3DModelName.mockResolvedValue({ success: true, name: '青铜巨像' })

    const result = await dashScopeAPI.generate3DModelName('AAAA')

    expect(generate3DModelName).toHaveBeenCalledWith({ imageBase64: 'AAAA' })
    expect(result).toEqual({ success: true, name: '青铜巨像' })
  })

  it('主进程给的 errorKey 原样带上来 —— 界面靠它决定弹不弹', async () => {
    withBridge()
    generate3DModelName.mockResolvedValue({
      success: false,
      error: '没有可用的视觉模型',
      errorKey: NO_VISION_MODEL_ERROR_KEY
    })

    const result = await dashScopeAPI.generate3DModelName('AAAA')

    expect(result.errorKey).toBe(NO_VISION_MODEL_ERROR_KEY)
  })

  it('桥没装上时回一次普通失败，不抛、也不说用户没配置', async () => {
    const result = await dashScopeAPI.generate3DModelName('AAAA')

    expect(result).toEqual({ success: false })
    expect(generate3DModelName).not.toHaveBeenCalled()
  })

  it('桥抛异常时收进返回值，errorKey 不给', async () => {
    withBridge()
    generate3DModelName.mockRejectedValue(new Error('IPC 通道已关闭'))

    const result = await dashScopeAPI.generate3DModelName('AAAA')

    expect(result.success).toBe(false)
    expect(result.error).toBe('IPC 通道已关闭')
    expect(result.errorKey).toBeUndefined()
  })

  it('主进程什么都没回时当成失败，不往下传 undefined', async () => {
    withBridge()
    generate3DModelName.mockResolvedValue(undefined)

    const result = await dashScopeAPI.generate3DModelName('AAAA')

    expect(result).toEqual({ success: false })
  })
})
