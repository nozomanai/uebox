import { describe, expect, it } from 'vitest'
import { isMegaJamCardVisible, withMegaJamSuggestion } from './megaJamSuggestion'

describe('isMegaJamCardVisible', () => {
  it('本地时间 2026-11-16 09:59 显示', () => {
    expect(isMegaJamCardVisible(new Date(2026, 10, 16, 9, 59, 59, 999))).toBe(true)
  })

  it('本地时间 2026-11-16 10:00 隐藏', () => {
    expect(isMegaJamCardVisible(new Date(2026, 10, 16, 10, 0, 0, 0))).toBe(false)
  })

  it('之后一直隐藏', () => {
    expect(isMegaJamCardVisible(new Date(2027, 0, 1))).toBe(false)
  })
})

describe('withMegaJamSuggestion', () => {
  const others = [{ title: 'a' }, { title: 'b' }, { title: 'c' }]
  const card = { title: 'MegaJam' }

  it('截止前顶替第一张，总数不变', () => {
    expect(withMegaJamSuggestion(others, card, new Date(2026, 10, 16, 9, 59))).toEqual([
      card,
      { title: 'b' },
      { title: 'c' }
    ])
  })

  it('截止后换回原来的三张', () => {
    expect(withMegaJamSuggestion(others, card, new Date(2026, 10, 16, 10, 0))).toEqual(others)
  })
})
