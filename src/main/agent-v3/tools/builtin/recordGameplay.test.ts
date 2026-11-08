/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../utils/UnrealPathManager', () => ({ default: {} }))

import { mp4Args, pickWindow } from './recordGameplay'

const w = (id: string, name: string): { id: string; name: string } => ({ id, name })

describe('选要录的窗口', () => {
  const editor = w('1', 'NeonFort - Unreal Editor')
  const other = w('2', 'OtherGame - Unreal Editor')
  const chrome = w('3', 'Google Chrome')

  it('新窗口模式的 PIE 优先', () => {
    const pie = w('9', 'NeonFort Preview [NetMode: Standalone 0]  (64-bit/PC D3D SM6)')
    expect(pickWindow([editor, pie, chrome], { projectName: 'NeonFort' })).toBe(pie)
  })

  it('PIE 在视口里：录这个工程的编辑器窗口，不录别的工程', () => {
    expect(pickWindow([other, editor, chrome], { projectName: 'NeonFort' })).toBe(editor)
  })

  it('起了打包版：挑启动后才出现的、最后出现的那个窗口', () => {
    const before = [editor, chrome]
    const splash = w('5', 'NeonFort')
    const game = w('6', 'NeonFort (64-bit Development PCD3D_SM6)')
    expect(pickWindow([editor, chrome, splash, game], { before })).toBe(game)
    expect(pickWindow([editor, chrome], { before })).toBeNull()
  })

  it('点了名就按名字找，大小写不敏感', () => {
    expect(pickWindow([editor, chrome], { titleHint: 'chrome' })).toBe(chrome)
    expect(pickWindow([editor], { titleHint: 'nope' })).toBeNull()
  })

  it('没有编辑器窗口时返回 null', () => {
    expect(pickWindow([chrome], {})).toBeNull()
  })
})

it('MP4：H.264、yuv420p、宽高取偶数、去掉音轨', () => {
  const args = mp4Args('a.webm', 'a.mp4')
  expect(args).toContain('libx264')
  expect(args).toContain('yuv420p')
  expect(args).toContain('scale=trunc(iw/2)*2:trunc(ih/2)*2')
  expect(args.at(-1)).toBe('a.mp4')
})
