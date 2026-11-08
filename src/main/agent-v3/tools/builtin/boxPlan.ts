/**
 * `box_plan` —— 在对话里替用户连接 Box Plan、领活动套餐、导入模型。
 *
 * 设置页能做的这几步，用户也可以直接让 agent 做（「帮我领 MegaJam 套餐并配好」）。
 * 走的是设置页同一套逻辑（`ai/creatorPlan/service.ts`），落盘规则不会两边不一致。
 *
 * 唯一做不到的一步是账户授权：`connect` 打开浏览器，登录和「允许」由用户自己点，
 * 工具在这里等，用户点完才往下走。
 *
 * - `status`：连没连、套餐状态、MegaJam 活动开没开、领没领。只读
 * - `connect`：设备授权。已经连着就直接回状态
 * - `claim_megajam`：填 itch.io 主页领活动套餐，套餐开在连着的账户上
 * - `import`：把套餐的模型按导入预览的默认勾选接到各角色上（用户自己配过的角色不动），
 *   不动对象存储。导入后从下一轮对话起生效
 */

import { z } from 'zod'

import type { ModelRole } from '../../../../shared/aiProvider'
import type { CreatorPlanPreview, CreatorPlanState } from '../../../../shared/creatorPlan'
import { defineTool, type ToolRisk, type UnrealAgentTool } from '../defineTool'

const input = z.object({
  action: z
    .enum(['status', 'connect', 'claim_megajam', 'import'])
    .describe(
      'status=查看连接、套餐和 MegaJam 活动状态；connect=连接 Box Plan（打开浏览器，用户登录并允许）；' +
        'claim_megajam=领 MegaJam 激励套餐；import=把套餐模型接到各角色（不动用户自己配过的角色）'
    ),
  itch_url: z
    .string()
    .optional()
    .describe(
      'claim_megajam 必填：用户的 itch.io 个人主页，如 https://name.itch.io。先问用户，不要猜'
    )
})

type Input = z.infer<typeof input>

export interface BoxPlanResult {
  action: Input['action']
  connected: boolean
  claimed?: boolean
  expiresAt?: string | null
  importedRoles?: ModelRole[]
}

/** 导入预览里默认勾上的角色：没绑过的、本来就由套餐管着的；用户手动配过的不勾 */
export function defaultImportRoles(previewData: CreatorPlanPreview): ModelRole[] {
  return previewData.changes.filter((change) => change.defaultSelected).map((change) => change.role)
}

export function describePlanState(state: CreatorPlanState): string {
  if (!state.connected) return 'Box Plan 未连接。'
  const summary = state.summary
  const parts = ['Box Plan 已连接']
  if (summary?.tierName) parts.push(`套餐 ${summary.tierName}`)
  if (summary?.status) parts.push(`状态 ${summary.status}`)
  if (summary?.currentPeriodEnd) parts.push(`本期到 ${summary.currentPeriodEnd}`)
  if (state.error) parts.push(`问题：${state.error}`)
  parts.push(
    state.managedRoles.length
      ? `由套餐接管的角色：${state.managedRoles.join('、')}`
      : '还没有角色用套餐的模型（可以 import）'
  )
  return `${parts.join('，')}。`
}

const CLAIM_ERRORS: Record<string, string> = {
  invalid_itch_url: 'itch.io 主页格式不对，要个人主页地址，如 https://name.itch.io',
  already_claimed: '这个账户已经领过 MegaJam 激励套餐',
  sold_out: 'MegaJam 激励套餐已经发完',
  campaign_closed: 'MegaJam 领取已结束或没有开放',
  unauthorized: 'Box Plan 授权已失效，先 connect',
  not_connected: 'Box Plan 还没连接，先 connect',
  network: '连不上 Box Plan 服务'
}

export function createBoxPlanTool(): UnrealAgentTool<BoxPlanResult> {
  return defineTool<typeof input, BoxPlanResult>({
    name: 'box_plan',
    namespace: 'box',
    // 最坏情况；status 只读，见 riskFor
    risk: 'mutating',
    riskFor: (args): ToolRisk => ((args as Input).action === 'status' ? 'safe' : 'mutating'),
    concurrency: 'sequential',
    description:
      '替用户连接 Box Plan（盒子的模型订阅）、领 2026 Epic AI MegaJam 激励套餐、把套餐模型导入到各角色。' +
      '用户说「帮我领套餐」「帮我配好 Box Plan」时用，按 status → connect → claim_megajam → import 的顺序走，' +
      '已经做过的步骤跳过。connect 会打开浏览器，登录和「允许」只能由用户自己点：调用前告诉用户。' +
      'claim_megajam 要用户的 itch.io 个人主页，先问用户。import 不动用户自己配过的角色，从下一轮对话起生效。',
    input,
    execute: async (args, ctx) => {
      const service = await import('../../../ai/creatorPlan/service')

      if (args.action === 'status') {
        const state = await service.planStateNow()
        const lines = [describePlanState(state)]
        let claimed: boolean | undefined
        let expiresAt: string | null | undefined
        if (state.connected) {
          const campaign = await service.campaignStatus()
          if (campaign.ok) {
            claimed = campaign.data.claimed
            expiresAt = campaign.data.expiresAt
            lines.push(
              campaign.data.claimed
                ? `MegaJam 激励套餐已领取${campaign.data.expiresAt ? `，${campaign.data.expiresAt} 到期` : ''}。`
                : campaign.data.open
                  ? 'MegaJam 激励套餐可以领取（claim_megajam）。'
                  : 'MegaJam 激励套餐当前不能领取。'
            )
          }
        }
        return {
          text: lines.join('\n'),
          details: { action: 'status', connected: state.connected, claimed, expiresAt }
        }
      }

      if (args.action === 'connect') {
        const before = await service.planStateNow()
        if (before.connected && before.error !== 'unauthorized') {
          return {
            text: `已经连着，不用再连。${describePlanState(before)}`,
            details: { action: 'connect', connected: true }
          }
        }
        try {
          await service.connectPlan({
            signal: ctx.signal,
            onPrompt: (prompt) =>
              ctx.report({
                text: `已打开浏览器：请登录 Box Plan，核对确认码 ${prompt.userCode} 后点「允许」`
              })
          })
        } catch (error) {
          const failed = service.failResult(error)
          throw new Error(
            failed.code === 'denied'
              ? '用户在浏览器里拒绝了授权'
              : failed.code === 'expired'
                ? '确认码过期了，用户没有在时限内点「允许」。可以再 connect 一次'
                : `连接失败：${failed.error}`
          )
        }
        return {
          text: '已连接 Box Plan。还没有把模型接到任何角色：领完套餐后用 import。',
          details: { action: 'connect', connected: true }
        }
      }

      if (args.action === 'claim_megajam') {
        if (!args.itch_url?.trim()) throw new Error('缺 itch_url：先问用户的 itch.io 个人主页')
        const result = await service.claimPlanCampaign(args.itch_url)
        if (!result.ok) throw new Error(CLAIM_ERRORS[result.code] ?? `领取失败：${result.error}`)
        return {
          text:
            `已领取 MegaJam 激励套餐${result.data.expiresAt ? `，${result.data.expiresAt} 到期` : ''}。` +
            '模型还要 import 才会用上。',
          details: {
            action: 'claim_megajam',
            connected: true,
            claimed: true,
            expiresAt: result.data.expiresAt
          }
        }
      }

      // import
      const previewData = await service.previewPlan().catch((error: unknown) => {
        const failed = service.failResult(error)
        throw new Error(CLAIM_ERRORS[failed.code] ?? `拉不到套餐清单：${failed.error}`)
      })
      const roles = defaultImportRoles(previewData)
      if (!roles.length) {
        return {
          text: '没有可以接管的角色：每个角色都是用户自己配的模型，按规则不动。需要的话让用户在设置 → 模型 → Box Plan 里手动勾选。',
          details: { action: 'import', connected: true, importedRoles: [] }
        }
      }
      const state = await service.applyPlanRoles(roles)
      const kept = previewData.changes.filter((change) => !change.defaultSelected)
      return {
        text:
          `已把 Box Plan 的模型接到 ${roles.length} 个角色：${roles.join('、')}。从下一轮对话起生效。` +
          (kept.length
            ? `\n用户自己配过的 ${kept.length} 个角色没动：${kept.map((c) => c.role).join('、')}。`
            : ''),
        details: {
          action: 'import',
          connected: state.connected,
          importedRoles: roles
        }
      }
    }
  })
}
