<script setup lang="ts">
import { computed, defineAsyncComponent } from 'vue'
import { useRoute } from 'vue-router'

// 外部对话不挂载普通输入框，也不创建盒子内核的对话记录。
const Welcome = defineAsyncComponent(() => import('./Welcome.vue'))
const ExternalTeamChat = defineAsyncComponent(() => import('./components/ExternalTeamChat.vue'))
const route = useRoute()
const sid = computed(() => (typeof route.query.sid === 'string' ? route.query.sid : ''))
</script>

<template>
  <ExternalTeamChat v-if="sid.startsWith('ext-')" :team-id="sid" />
  <Welcome v-else />
</template>
