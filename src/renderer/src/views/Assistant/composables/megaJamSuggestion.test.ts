import { describe, expect, it } from 'vitest'
import { isMegaJamCardVisible, withMegaJamSuggestion } from './megaJamSuggestion'

describe('isMegaJamCardVisible', () => {
  it('本地时间 2026-11-30 23:59 显示', () => {
    expect(isMegaJamCardVisible(new Date(2026, 10, 30, 23, 59, 59, 999))).toBe(true)
  })

  it('本地时间 2026-12-01 00:00 隐藏', () => {
    expect(isMegaJamCardVisible(new Date(2026, 11, 1, 0, 0, 0, 0))).toBe(false)
  })

  it('之后一直隐藏', () => {
    expect(isMegaJamCardVisible(new Date(2027, 0, 1))).toBe(false)
  })
})

describe('withMegaJamSuggestion', () => {
  const others = [{ title: 'a' }, { title: 'b' }]
  const card = { title: 'MegaJam' }

  it('到期前放在第一张', () => {
    expect(withMegaJamSuggestion(others, card, new Date(2026, 10, 30, 23, 59))).toEqual([
      card,
      ...others
    ])
  })

  it('到期后不含这张', () => {
    expect(withMegaJamSuggestion(others, card, new Date(2026, 11, 1))).toEqual(others)
  })
})
