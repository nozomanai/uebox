/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CreatorPlanPreview, CreatorPlanState } from '../../../../shared/creatorPlan'

const service = {
  planStateNow: vi.fn(),
  campaignStatus: vi.fn(),
  connectPlan: vi.fn(),
  claimPlanCampaign: vi.fn(),
  previewPlan: vi.fn(),
  applyPlanRoles: vi.fn(),
  failResult: vi.fn((error: unknown) => ({
    ok: false,
    code: (error as { code?: string }).code ?? 'unknown',
    error: String(error)
  }))
}
vi.mock('../../../ai/creatorPlan/service', () => service)

import { createBoxPlanTool, defaultImportRoles } from './boxPlan'

const disconnected: CreatorPlanState = {
  connected: false,
  summary: null,
  managedRoles: [],
  error: null,
  deprecations: []
}
const connected: CreatorPlanState = { ...disconnected, connected: true }

const preview = (selected: Record<string, boolean>): CreatorPlanPreview =>
  ({
    summary: {},
    changes: Object.entries(selected).map(([role, defaultSelected]) => ({
      role,
      model: role,
      modelDisplayName: role,
      current: null,
      managed: false,
      defaultSelected
    }))
  }) as unknown as CreatorPlanPreview

const run = (
  args: Record<string, unknown>
): ReturnType<ReturnType<typeof createBoxPlanTool>['execute']> =>
  createBoxPlanTool().execute('call-1', args)

beforeEach(() => {
  vi.clearAllMocks()
})

describe('box_plan', () => {
  it('status 只读；其余动作要审批', () => {
    const riskFor = createBoxPlanTool().unrealBox.riskFor!
    expect(riskFor({ action: 'status' })).toBe('safe')
    for (const action of ['connect', 'claim_megajam', 'import']) {
      expect(riskFor({ action })).toBe('mutating')
    }
  })

  it('status：没连接时不问活动；连着时带上活动领取状态', async () => {
    service.planStateNow.mockResolvedValueOnce(disconnected)
    const off = await run({ action: 'status' })
    expect(service.campaignStatus).not.toHaveBeenCalled()
    expect(off.details.connected).toBe(false)

    service.planStateNow.mockResolvedValueOnce(connected)
    service.campaignStatus.mockResolvedValueOnce({
      ok: true,
      data: { open: true, claimed: false, planTitle: 'MegaJam', claimUntil: null, expiresAt: null }
    })
    const on = await run({ action: 'status' })
    expect(on.content[0]).toMatchObject({ text: expect.stringContaining('可以领取') })
  })

  it('connect：已经连着就不再授权；没连时把确认码报给用户', async () => {
    service.planStateNow.mockResolvedValueOnce(connected)
    await run({ action: 'connect' })
    expect(service.connectPlan).not.toHaveBeenCalled()

    service.planStateNow.mockResolvedValueOnce(disconnected)
    service.connectPlan.mockImplementationOnce(async ({ onPrompt }) => {
      onPrompt({ userCode: 'ABCD-1234', verificationUri: 'https://t/connect' })
      return preview({})
    })
    const result = await run({ action: 'connect' })
    expect(result.details.connected).toBe(true)
  })

  it('connect：用户在浏览器里拒绝，说清楚原因', async () => {
    service.planStateNow.mockResolvedValueOnce(disconnected)
    service.connectPlan.mockRejectedValueOnce(
      Object.assign(new Error('denied'), { code: 'denied' })
    )
    await expect(run({ action: 'connect' })).rejects.toThrow('拒绝')
  })

  it('claim_megajam：缺 itch 主页先问用户；服务端错误码翻成人话', async () => {
    await expect(run({ action: 'claim_megajam' })).rejects.toThrow('itch_url')
    service.claimPlanCampaign.mockResolvedValueOnce({
      ok: false,
      code: 'already_claimed',
      error: 'HTTP 409'
    })
    await expect(run({ action: 'claim_megajam', itch_url: 'neon.itch.io' })).rejects.toThrow(
      '已经领过'
    )
    service.claimPlanCampaign.mockResolvedValueOnce({
      ok: true,
      data: { expiresAt: '2026-11-19T05:00:00Z' }
    })
    const ok = await run({ action: 'claim_megajam', itch_url: 'neon.itch.io' })
    expect(service.claimPlanCampaign).toHaveBeenLastCalledWith('neon.itch.io')
    expect(ok.details).toMatchObject({ claimed: true, expiresAt: '2026-11-19T05:00:00Z' })
  })

  it('import：只接预览默认勾上的角色，用户自己配过的不动', async () => {
    service.previewPlan.mockResolvedValueOnce(preview({ agent: true, chat: false, vision: true }))
    service.applyPlanRoles.mockResolvedValueOnce(connected)
    const result = await run({ action: 'import' })
    expect(service.applyPlanRoles).toHaveBeenCalledWith(['agent', 'vision'])
    expect(result.details.importedRoles).toEqual(['agent', 'vision'])
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining('chat') })
  })

  it('import：没有可接管的角色就不落盘', async () => {
    service.previewPlan.mockResolvedValueOnce(preview({ chat: false }))
    const result = await run({ action: 'import' })
    expect(service.applyPlanRoles).not.toHaveBeenCalled()
    expect(result.details.importedRoles).toEqual([])
  })

  it('默认勾选规则来自预览', () => {
    expect(defaultImportRoles(preview({ a: true, b: false }))).toEqual(['a'])
  })
})
