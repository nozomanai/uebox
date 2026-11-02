<script setup lang="ts">
import { toRef, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import AppEmpty from '@renderer/components/AppEmpty.vue'
import AppSpin from '@renderer/components/AppSpin.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { useTabsStore } from '@renderer/store/modules/tabs'
import { agentV3API } from '@renderer/api/agentV3'
import { message } from '@renderer/utils/messageManager'
import TeamBoardPanel from './TeamBoardPanel.vue'
import { useTeamBoard } from '../composables/useTeamBoard'

const props = defineProps<{ teamId: string }>()
const { t } = useI18n()
const route = useRoute()
const tabs = useTabsStore()
const board = useTeamBoard(ref(''), toRef(props, 'teamId'))

watch(
  () => [route.fullPath, board.team.value?.objective] as const,
  ([path, objective]) => {
    if (objective) tabs.updateTabTitleByPath(path, objective)
  },
  { immediate: true }
)

async function endTeam(): Promise<void> {
  const id = props.teamId
  const result = await agentV3API.teamEnd(id).catch(() => null)
  if (!result?.success) {
    message.error(t('assistant.teamBoard.endFailed'))
    return
  }
  message.info(t('externalTeams.endedNotice'))
  if (props.teamId === id) await board.refresh()
}
</script>

<template>
  <section class="external-team-chat" :aria-label="t('externalTeams.driven')">
    <TeamBoardPanel
      v-if="board.team.value"
      docked
      :team="board.team.value"
      :session-id="props.teamId"
      :activity="board.activity.value"
      :model-choices="board.team.value.hostedMembers ? board.modelChoices.value : undefined"
      :models-loaded="board.modelsLoaded.value"
      @reopen="board.reopen"
      @reopen-job="board.reopenJob"
      @end="endTeam"
      @open-models="board.loadModels"
      @set-model="board.setMemberModel"
      @dismiss="board.dismissMember"
    />
    <AppSpin v-else-if="board.loading.value" class="detail-empty" />
    <AppEmpty v-else class="detail-empty" :title="t('externalTeams.unavailable')">
      <AppButton @click="board.refresh">{{ t('externalTeams.retry') }}</AppButton>
    </AppEmpty>
  </section>
</template>

<style scoped>
.external-team-chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
  min-height: 0;
  background: var(--color-bg-page);
}

.detail-empty {
  margin: auto;
  padding: var(--space-4);
}
</style>
