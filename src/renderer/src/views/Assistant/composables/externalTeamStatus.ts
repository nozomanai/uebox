/**
 * 项目对话列表中外部团队的状态：结束了、过了验收、验收没过、改过之后没重验、还没验。
 * 文案在 `externalTeams.status.<key>`。
 */

import type { ExternalTeamSummary } from '@core/shared/agentTeam'
import type { TagTone } from '@renderer/components/AppTag.types'

export type ExternalTeamStatusKey = 'ended' | 'passed' | 'stale' | 'failed' | 'blocked' | 'pending'

export function externalTeamStatus(
  team: Pick<ExternalTeamSummary, 'ended' | 'passed' | 'verdict'>
): { key: ExternalTeamStatusKey; tone: TagTone } {
  if (team.ended) return { key: 'ended', tone: 'neutral' }
  if (team.passed) return { key: 'passed', tone: 'success' }
  // PASS 之后又改过工程：那次结论只说明当时的游戏
  if (team.verdict === 'pass') return { key: 'stale', tone: 'neutral' }
  if (team.verdict === 'fail') return { key: 'failed', tone: 'warning' }
  if (team.verdict === 'blocked') return { key: 'blocked', tone: 'danger' }
  return { key: 'pending', tone: 'info' }
}
