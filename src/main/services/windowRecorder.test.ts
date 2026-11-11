/** @vitest-environment node */
import { describe, expect, it } from 'vitest'

import { parseRecording, recorderScript } from './windowRecorder'

const dataUrl = (bytes: number[]): string =>
  `data:video/webm;base64,${Buffer.from(bytes).toString('base64')}`

describe('录制脚本的返回值', () => {
  it('有数据、有帧数：原样带回', () => {
    const out = parseRecording({ dataUrl: dataUrl([1, 2, 3]), frames: 90 })
    expect([...out.data]).toEqual([1, 2, 3])
    expect(out.frames).toBe(90)
  })

  it('0 帧就报错，哪怕容器里有字节', () => {
    expect(() => parseRecording({ dataUrl: dataUrl([1, 2, 3]), frames: 0 })).toThrow(
      /一帧画面都没录到/
    )
  })

  it('帧数报不出来时不拦，只按字节判断', () => {
    expect(parseRecording({ dataUrl: dataUrl([1]), frames: null }).frames).toBeNull()
    expect(() => parseRecording({ dataUrl: dataUrl([]), frames: null })).toThrow(/一帧画面都没录到/)
  })

  it('脚本没回东西', () => {
    expect(() => parseRecording(undefined)).toThrow(/没有产出数据/)
    expect(() => parseRecording({ dataUrl: 'nope' })).toThrow(/没有产出数据/)
  })

  it('脚本把帧数和数据一起返回', () => {
    const script = recorderScript('window:1:0', 5, 30)
    expect(script).toContain('totalFrames')
    expect(script).toContain('return { dataUrl, frames }')
  })
})
