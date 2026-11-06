<script setup lang="ts">
/**
 * 蓝图库 / 材质库共用的列表视图。
 *
 * 外框是一个带描边的表格盒，表头固定 38px、数据行固定 44px —— 固定行高扫读更稳。
 * 列宽由这套类名决定，调用方在每一行里按同样的顺序摆 `<span>`：
 *
 *   col-name (2.5) · col-type (1.5) · col-aux (0.8) · col-stats (1.2) · col-extra (1) · col-actions (90px)
 *
 * 名字刻意是通用的：材质库的第三列是「混合 · 着色」，蓝图库是「引擎版本」，
 * 叫 col-engine 会让另一边读起来莫名其妙。
 */
withDefaults(
  defineProps<{
    /** 表头文案，按上面的列顺序给 5 个（第 6 列是操作，不用标题） */
    columns: readonly string[]
    /**
     * 一行都没有时显示在表格里的文案。
     *
     * 自带空态的调用方（LibraryBrowser 在表格外面画 LibraryEmptyState）不传这两个 ——
     * 它根本不会把一张空表渲染出来。
     */
    emptyText?: string
    /** 是否一行都没有 */
    isEmpty?: boolean
  }>(),
  { emptyText: '', isEmpty: false }
)
</script>

<template>
  <div class="library-list">
    <div class="list-header-row">
      <span v-for="(label, index) in columns" :key="label + index" :class="`col-${index}`">
        {{ label }}
      </span>
      <span class="col-actions"></span>
    </div>

    <slot />

    <div v-if="isEmpty" class="list-empty">{{ emptyText }}</div>
  </div>
</template>

<style scoped lang="less">
.library-list {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
}

.list-header-row {
  display: flex;
  align-items: center;
  height: 38px;
  padding: 0 var(--space-4);
  background: var(--color-bg-surface);
  border-bottom: 1px solid var(--color-border);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  letter-spacing: 0.5px;
  text-transform: uppercase;
  color: var(--color-text-muted);
  user-select: none;
}

// 表头按下标取列宽，数据行按语义类名取——两边宽度必须一致
.col-0,
.library-list :deep(.col-name) {
  flex: 2.5;
}

.col-1,
.library-list :deep(.col-type) {
  flex: 1.5;
}

.col-2,
.library-list :deep(.col-aux) {
  flex: 0.8;
}

.col-3,
.library-list :deep(.col-stats) {
  flex: 1.2;
}

.col-4,
.library-list :deep(.col-extra) {
  flex: 1;
}

.col-actions,
.library-list :deep(.col-actions) {
  flex: 0 0 90px;
  display: flex;
  justify-content: flex-end;
  gap: 4px;
}

// ===== 数据行（由调用方渲染，只能 :deep() 穿透）=====
.library-list :deep(.list-row) {
  display: flex;
  align-items: center;
  height: 44px;
  padding: 0 var(--space-4);
  border-bottom: 1px solid var(--color-border);
  cursor: pointer;
  transition: background 0.15s;
  font-size: 13px;
  color: var(--color-text-secondary);

  &:last-child {
    border-bottom: 0;
  }

  &:hover {
    background: var(--color-bg-surface-hover);

    // 常驻的一排小按钮太吵，悬停才显形
    .row-menu-trigger {
      opacity: 1;
    }
  }

  &.collection-list-row {
    background: var(--color-accent-bg);
  }
}

.library-list :deep(.col-name) {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
}

.library-list :deep(.col-type),
.library-list :deep(.col-aux) {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
}

.library-list :deep(.col-stats),
.library-list :deep(.col-extra) {
  font-size: var(--font-size-sm);
  color: var(--color-text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.library-list :deep(.list-cover-dot) {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
}

.library-list :deep(.list-folder-dot) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: 5px;
  flex-shrink: 0;
  background: var(--color-accent-bg);
  color: var(--color-accent-text);
  font-size: 10px;
}

.library-list :deep(.fav-star) {
  color: var(--color-warning-text);
  font-size: var(--font-size-sm);
  flex-shrink: 0;
}

.library-list :deep(.row-menu-trigger) {
  opacity: 0;
  width: 24px;
  height: 24px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  font-size: 13px;
  transition: all 0.2s;

  &:focus-visible {
    opacity: 1;
  }

  &:hover {
    background: var(--color-bg-raised);
    color: var(--color-text-primary);
  }

  &.danger:hover {
    background: var(--color-danger-bg);
    color: var(--color-danger-text);
  }
}

.list-empty {
  padding: 48px 0;
  text-align: center;
  color: var(--color-text-muted);
  font-size: var(--font-size-base);
}
</style>
