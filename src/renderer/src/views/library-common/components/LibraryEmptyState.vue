<script setup lang="ts">
/**
 * 一条都没有的时候显示的空状态。
 *
 * 只有一句标题，不配说明性小字：「新建」就在工具栏上，再写一遍
 * 「新建条目，或将文件拖入左侧文件夹」只是把用户已经看得见的东西念一遍。
 * 要放补充操作的，用默认插槽放按钮。
 */
defineProps<{
  /** 一句话说清是谁空了，如「蓝图库为空」 */
  title: string
}>()
</script>

<template>
  <div class="library-empty-state">
    <div class="empty-icon">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
        <path
          d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2z"
        />
      </svg>
    </div>
    <h2>{{ title }}</h2>
    <slot />
  </div>
</template>

<style scoped lang="less">
.library-empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 64px var(--space-6);
  text-align: center;
}

.empty-icon {
  width: 48px;
  height: 48px;
  color: var(--color-text-muted);
  margin-bottom: var(--space-4);

  svg {
    width: 100%;
    height: 100%;
  }
}

h2 {
  margin: 0;
  font-size: var(--font-size-md);
  font-weight: var(--font-weight-semibold);
  color: var(--color-text-secondary);
}
</style>
