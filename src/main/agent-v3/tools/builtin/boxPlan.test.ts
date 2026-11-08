/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { CreatorPlanPreview, CreatorPlanState } from '../../../../shared/creatorPlan'

const service = {
  planStateNow: vi.fn(),
  campaignStatus: vi.fn(),
  connectPlan: vi.fn(),
  claimPlanCampaign: vi.fn(),
  submitPlanCampaignEntry: vi.fn(),
  previewPlan: vi.fn(),
  applyPlanRoles: vi.fn(),
  hasPendingConnection: vi.fn(() => false),
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
  service.hasPendingConnection.mockReturnValue(false)
})

describe('box_plan', () => {
  it('status 只读；其余动作要审批', () => {
    const riskFor = createBoxPlanTool().unrealBox.riskFor!
    expect(riskFor({ action: 'status' })).toBe('safe')
    for (const action of ['connect', 'claim_megajam', 'submit_megajam_entry', 'import']) {
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
      data: {
        open: true,
        claimed: false,
        planTitle: 'MegaJam',
        claimUntil: null,
        expiresAt: null,
        submitOpen: true,
        submitUntil: null,
        entryUrl: null
      }
    })
    const on = await run({ action: 'status' })
    expect(on.content[0]).toMatchObject({ text: expect.stringContaining('可以参赛登记') })
    expect(on.content[0]).toMatchObject({ text: expect.stringContaining('还没交卷') })
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
      '已经登记过'
    )
    service.claimPlanCampaign.mockResolvedValueOnce({
      ok: true,
      data: { expiresAt: '2026-11-19T05:00:00Z' }
    })
    const ok = await run({ action: 'claim_megajam', itch_url: 'neon.itch.io' })
    expect(service.claimPlanCampaign).toHaveBeenLastCalledWith('neon.itch.io')
    expect(ok.details).toMatchObject({ claimed: true, expiresAt: '2026-11-19T05:00:00Z' })
  })

  it('submit_megajam_entry：缺作品页先问用户；草稿页报打不开；成功回规范化地址', async () => {
    await expect(run({ action: 'submit_megajam_entry' })).rejects.toThrow('entry_url')
    service.submitPlanCampaignEntry.mockResolvedValueOnce({
      ok: false,
      code: 'entry_not_found',
      error: 'HTTP 422'
    })
    await expect(
      run({ action: 'submit_megajam_entry', entry_url: 'neon.itch.io/draft' })
    ).rejects.toThrow('公开')
    service.submitPlanCampaignEntry.mockResolvedValueOnce({
      ok: true,
      data: { entryUrl: 'https://neon.itch.io/star-fort' }
    })
    const ok = await run({ action: 'submit_megajam_entry', entry_url: 'Neon.itch.io/Star-Fort' })
    expect(service.submitPlanCampaignEntry).toHaveBeenLastCalledWith('Neon.itch.io/Star-Fort')
    expect(ok.details).toMatchObject({ entryUrl: 'https://neon.itch.io/star-fort' })
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

  it('刚授权、还没导入：算连着，不再弹浏览器；status 照样能看活动', async () => {
    service.hasPendingConnection.mockReturnValue(true)
    service.planStateNow.mockResolvedValue(disconnected)
    await run({ action: 'connect' })
    expect(service.connectPlan).not.toHaveBeenCalled()

    service.campaignStatus.mockResolvedValueOnce({
      ok: true,
      data: { open: true, claimed: false, planTitle: 'MegaJam', claimUntil: null, expiresAt: null }
    })
    const status = await run({ action: 'status' })
    expect(status.details.connected).toBe(true)
    expect(service.campaignStatus).toHaveBeenCalled()
  })
})
