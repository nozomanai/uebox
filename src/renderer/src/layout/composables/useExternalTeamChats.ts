import { onMounted, onUnmounted, ref, type Ref } from 'vue'
import type { ExternalTeamSummary } from '@core/shared/agentTeam'
import { agentV3API } from '@renderer/api/agentV3'

/** 侧边栏一直订阅团队变化，未打开任务板时新团队也能出现在项目下。 */
export function useExternalTeamChats(): { teams: Ref<ExternalTeamSummary[]> } {
  const teams = ref<ExternalTeamSummary[]>([])
  let generation = 0
  async function refresh(): Promise<void> {
    const mine = ++generation
    try {
      const next = await agentV3API.externalTeams()
      if (mine === generation) teams.value = next
    } catch {
      // 一次读取失败不能把已有对话从列表中清掉。
    }
  }
  const off = agentV3API.onTeamBoardChanged((id) => {
    if (id.startsWith('ext-')) void refresh()
  })
  onMounted(refresh)
  onUnmounted(() => {
    generation++
    off()
  })
  return { teams }
}
