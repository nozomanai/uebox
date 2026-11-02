import { describe, expect, it } from 'vitest'

import { externalTeamStatus } from './externalTeamStatus'

describe('外部团队的状态标签', () => {
  it('结束 > 过了验收 > 改过没重验 > 没过 > 卡住 > 没验', () => {
    expect(externalTeamStatus({ ended: true, passed: true, verdict: 'pass' }).key).toBe('ended')
    expect(externalTeamStatus({ ended: false, passed: true, verdict: 'pass' })).toEqual({
      key: 'passed',
      tone: 'success'
    })
    // PASS 之后又改过工程：不能再说「过了」
    expect(externalTeamStatus({ ended: false, passed: false, verdict: 'pass' }).key).toBe('stale')
    expect(externalTeamStatus({ ended: false, passed: false, verdict: 'fail' }).key).toBe('failed')
    expect(externalTeamStatus({ ended: false, passed: false, verdict: 'blocked' }).key).toBe(
      'blocked'
    )
    expect(externalTeamStatus({ ended: false, passed: false, verdict: null }).key).toBe('pending')
  })
})
