<script setup lang="ts">
/**
 * 从标签栏拖出来的那条对话，单独一个窗口。
 *
 * 只放这一条对话：没有侧边栏、没有标签栏。要去别的页面（资产库、偏好设置、别的
 * 对话）一律回主窗口打开（路由守卫做的，见 `router/index.ts`），这里不长第二套主界面。
 *
 * 这个窗口和主窗口之间的对话同步见 `utils/chatWindowSync.ts`。下面挂的几样后台件
 * 和主布局里的同一套，理由也一样：它们不能拴在对话页的寿命上 —— 这边发起的一轮，
 * 排队的话要接着发，确认框要弹，改挂工程要跟上。
 */
import { computed, onBeforeUnmount, watch } from 'vue'
import { useRoute } from 'vue-router'

import Welcome from '@renderer/views/Assistant/Welcome.vue'
import ExternalTeamChat from '@renderer/views/Assistant/components/ExternalTeamChat.vue'
import SensitiveActionConfirm from '@renderer/components/SensitiveActionConfirm.vue'
import { useI18n } from '@renderer/hooks/useI18n'
import { followLocaleFromOtherWindows } from '@renderer/i18n'
import { useChatSessionsStore } from '@renderer/store/modules/chatSessions'
import { useAppAgentRunner } from '@renderer/views/Assistant/composables/appAgentRunner'
import { useFollowUpDelivery } from '@renderer/views/Assistant/composables/followUpDelivery'
import { useSessionProjectSync } from '@renderer/views/Assistant/composables/sessionProjectSync'

const { t } = useI18n()
const route = useRoute()
const chatStore = useChatSessionsStore()

const isMac = window.api?.platform === 'darwin'

const sid = computed(() => (typeof route.query.sid === 'string' ? route.query.sid.trim() : ''))

const title = computed(() => {
  const value = chatStore.sessionById(sid.value)?.title?.trim()
  return value || t('chatWindow.windowTitle')
})

// 任务栏上认得出是哪条对话：好几个独立窗口并排时全叫「AI 对话」等于没名字
watch(
  title,
  (value) => {
    document.title = value
  },
  { immediate: true }
)

// 语言在主窗口的设置页里切，这边跟着变
onBeforeUnmount(followLocaleFromOtherWindows())

// 顺序同主布局：投递要用运行器，运行器先装
useAppAgentRunner()
useFollowUpDelivery()
useSessionProjectSync()

const minimize = (): void => window.api.window.minimize()
const maximize = (): void => window.api.window.maximize()
const close = (): void => window.api.window.close()
</script>

<template>
  <div class="chat-window">
    <header class="chat-window__titlebar" :class="{ 'is-mac': isMac }">
      <span class="chat-window__title">{{ title }}</span>
      <div v-if="!isMac" class="chat-window__controls">
        <button
          class="chat-window__button"
          :aria-label="t('chatWindow.minimize')"
          @click="minimize"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <rect x="2" y="5" width="8" height="2" fill="currentColor" />
          </svg>
        </button>
        <button
          class="chat-window__button"
          :aria-label="t('chatWindow.maximize')"
          @click="maximize"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <rect
              x="2"
              y="2"
              width="8"
              height="8"
              stroke="currentColor"
              stroke-width="1"
              fill="none"
            />
          </svg>
        </button>
        <button
          class="chat-window__button is-close"
          :aria-label="t('chatWindow.close')"
          @click="close"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
            <path
              d="M2 2L10 10M10 2L2 10"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>
    </header>

    <main class="chat-window__body">
      <ExternalTeamChat v-if="sid.startsWith('ext-')" :team-id="sid" />
      <Welcome v-else-if="sid" :chat-sid="sid" />
    </main>

    <SensitiveActionConfirm />
  </div>
</template>

<style scoped lang="less">
.chat-window {
  /* 对话页按「顶栏 64px」算高度，这里只有一条细顶栏 */
  --chat-window-titlebar-height: 36px;

  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--color-bg-page);
  overflow: hidden;
}

.chat-window__titlebar {
  flex: 0 0 var(--chat-window-titlebar-height);
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding-left: var(--space-3);
  background: var(--color-bg-page);
  -webkit-app-region: drag;
  user-select: none;

  /* macOS 的红绿灯浮在左上角，标题给它让位 */
  &.is-mac {
    padding-left: var(--space-20);
  }
}

.chat-window__title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.chat-window__controls {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  align-self: stretch;
  -webkit-app-region: no-drag;
}

.chat-window__button {
  width: 36px;
  height: 100%;
  border: none;
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background var(--motion-fast) var(--easing-standard);

  svg {
    opacity: 0.7;
  }

  &:hover {
    background: var(--color-bg-surface-hover);
    color: var(--color-text-primary);

    svg {
      opacity: 1;
    }
  }

  &.is-close:hover {
    background: var(--color-danger-solid);
    color: var(--color-text-on-solid);
  }
}

.chat-window__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
}
</style>
