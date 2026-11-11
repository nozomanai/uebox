import { describe, expect, it } from 'vitest'
import {
  cursorMaxModeForContext,
  cursorModelContextTiers,
  cursorModelSupportsFast,
  cursorWireContext,
  cursorWireEffort
} from './modelOptions'

describe('Cursor 模型选项', () => {
  it('Composer 与 Grok 支持 Fast，其它 Cursor 型号不支持', () => {
    expect(cursorModelSupportsFast('composer-2.5')).toBe(true)
    expect(cursorModelSupportsFast('composer-2.5-fast')).toBe(true)
    expect(cursorModelSupportsFast('grok-4.7')).toBe(true)
    expect(cursorModelSupportsFast('claude-4.7-opus')).toBe(false)
  })

  it('Grok 提供 256k / 500k，500k 要开 max_mode', () => {
    expect(cursorModelContextTiers('grok-4.7')).toEqual(['256k', '500k'])
    expect(cursorWireContext('auto')).toBeUndefined()
    expect(cursorWireContext('256k')).toBe('256k')
    expect(cursorMaxModeForContext('256k')).toBe(false)
    expect(cursorMaxModeForContext('500k')).toBe(true)
  })

  it('Grok 档位映射到 wire effort，auto/off 不发', () => {
    const map = { low: 'low', high: 'high', xhigh: 'extra_high', off: null }
    expect(cursorWireEffort('auto', map)).toBeUndefined()
    expect(cursorWireEffort('off', map)).toBeUndefined()
    expect(cursorWireEffort('xhigh', map)).toBe('extra_high')
  })
})
