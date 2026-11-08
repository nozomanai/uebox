/**
 * Box Plan 的 IPC。
 *
 *   creator-plan:state       卡片状态。没连接时直接回，**不发请求**
 *   creator-plan:connect     设备授权 → 存 Key → 拉清单 → 回导入预览
 *                            （码通过 creator-plan:device-code 事件推给渲染层）
 *   creator-plan:cancel      取消正在进行的授权
 *   creator-plan:preview     已连接时重新拉清单，回导入预览
 *   creator-plan:apply       按用户勾选的角色落盘，先记下被接管角色的原绑定；
 *                            勾了「对象存储」就换成套餐的存储（storage.ts）
 *   creator-plan:disconnect  在服务端吊销 Key → 删来源、还原绑定、删本机 Key
 *   creator-plan:open-manage 打开清单里的 manage_url（对话里的套餐错误提示用）
 *   creator-plan:campaign    活动状态（campaign.ts）；没连接时回 open:false，不发请求
 *   creator-plan:campaign-claim 领取活动套餐，成功后刷新清单
 *
 * 业务逻辑在 service.ts，agent 工具 box_plan 也走它。没连接时不发任何请求：
 * 连接只能由用户发起（点按钮，或让 agent 去连），浏览器里的登录和「允许」仍由用户自己点。
 */

import { ipcMain } from 'electron'
import type { ModelRole } from '../../../shared/aiProvider'
import type {
  CreatorPlanApplyOptions,
  CreatorPlanCampaign,
  CreatorPlanDisconnectResult,
  CreatorPlanPreview,
  CreatorPlanResult,
  CreatorPlanState
} from '../../../shared/creatorPlan'
import {
  applyPlanRoles,
  campaignStatus,
  cancelConnect,
  claimPlanCampaign,
  connectPlan,
  disconnectPlan,
  failResult,
  openPlanManage,
  planStateNow,
  previewPlan
} from './service'

/** 业务逻辑在 service.ts（agent 工具也用它），这里只把结果包成 IPC 的形状 */
async function wrap<T>(run: () => Promise<T>): Promise<CreatorPlanResult<T>> {
  try {
    return { ok: true, data: await run() }
  } catch (error) {
    return failResult(error)
  }
}

export function registerCreatorPlanIPC(): void {
  ipcMain.handle(
    'creator-plan:state',
    (): Promise<CreatorPlanResult<CreatorPlanState>> => wrap(planStateNow)
  )

  ipcMain.handle(
    'creator-plan:connect',
    (event): Promise<CreatorPlanResult<CreatorPlanPreview>> =>
      wrap(() =>
        connectPlan({
          onPrompt: (prompt) => {
            if (!event.sender.isDestroyed()) event.sender.send('creator-plan:device-code', prompt)
          }
        })
      )
  )

  ipcMain.handle('creator-plan:cancel', () => cancelConnect())

  ipcMain.handle(
    'creator-plan:preview',
    (): Promise<CreatorPlanResult<CreatorPlanPreview>> => wrap(previewPlan)
  )

  ipcMain.handle(
    'creator-plan:apply',
    (
      _event,
      roles: ModelRole[],
      options?: CreatorPlanApplyOptions
    ): Promise<CreatorPlanResult<CreatorPlanState>> => wrap(() => applyPlanRoles(roles, options))
  )

  ipcMain.handle(
    'creator-plan:disconnect',
    (): Promise<CreatorPlanResult<CreatorPlanDisconnectResult>> => wrap(disconnectPlan)
  )

  ipcMain.handle(
    'creator-plan:campaign',
    (): Promise<CreatorPlanResult<CreatorPlanCampaign>> => campaignStatus()
  )

  ipcMain.handle(
    'creator-plan:campaign-claim',
    (_event, itchUrl: string): Promise<CreatorPlanResult<{ expiresAt: string | null }>> =>
      claimPlanCampaign(itchUrl)
  )

  ipcMain.handle('creator-plan:open-manage', () => openPlanManage())
}
