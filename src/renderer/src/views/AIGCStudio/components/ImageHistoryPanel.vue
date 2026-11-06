<script setup lang="ts">
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  PhCheckCircle,
  PhCircleNotch,
  PhClock,
  PhClockCounterClockwise,
  PhDotsThree,
  PhDownloadSimple,
  PhEraser,
  PhImage,
  PhListBullets,
  PhMagnifyingGlass,
  PhPencilSimple,
  PhSquaresFour,
  PhTrash,
  PhX,
  PhXCircle
} from '@phosphor-icons/vue'
import { message } from '@renderer/utils/messageManager'
import { confirmDialog } from '@renderer/utils/dialog'
import { imageGenerationAPI } from '@renderer/api/imageGeneration'
import { getTaskDisplayUrls, useImageStudioStore, type ImageGenerationTask } from '../imageStore'
import {
  getAvailableImageTaskActions,
  type ImageTaskActionDef,
  type ImageTaskActionKey
} from '../composables/useImageTaskActions'
import { getImageModelLabel } from '../../../../../shared/imageGenerationModels'

type FilterKey = 'all' | 'active' | 'completed' | 'failed'
type SortKey = 'desc' | 'asc'
type ViewMode = 'list' | 'gallery'

const VIEW_MODE_KEY = 'aigc-image-history-view-mode'

const imageStore = useImageStudioStore()
const { t } = useI18n()

const emit = defineEmits<{
  (e: 'select', task: ImageGenerationTask): void
  /**
   * 图片动作。清单和实现都在 composables/useImageTaskActions.ts，
   * 中间的大图预览抛的是同一件事 —— 两个入口，一份行为。
   */
  (e: 'action', payload: { key: ImageTaskActionKey; task: ImageGenerationTask | null }): void
}>()

const searchKeyword = ref('')
const activeFilter = ref<FilterKey>('all')
const sortOrder = ref<SortKey>('desc')
const isClearingFailed = ref(false)
const cancellingTaskIds = ref<string[]>([])
const viewMode = ref<ViewMode>(
  localStorage.getItem(VIEW_MODE_KEY) === 'gallery' ? 'gallery' : 'list'
)

const allTasks = computed(() => imageStore.allTasks)
const previewTaskId = computed(() => imageStore.previewTaskId)
const isLoadingHistory = computed(() => imageStore.isLoadingHistory)
const hasMoreHistory = computed(() => imageStore.hasMoreHistory)

const summary = computed(() => {
  const tasks = allTasks.value
  return {
    total: Math.max(imageStore.historyTotal, tasks.length),
    active: tasks.filter((task) => task.status === 'pending' || task.status === 'processing')
      .length,
    completed: tasks.filter((task) => task.status === 'completed').length,
    failed: tasks.filter((task) => task.status === 'failed').length
  }
})

const filteredTasks = computed(() => {
  const keyword = searchKeyword.value.trim().toLowerCase()

  return [...allTasks.value]
    .filter((task) => {
      if (activeFilter.value === 'active') {
        return task.status === 'pending' || task.status === 'processing'
      }
      if (activeFilter.value === 'completed') {
        return task.status === 'completed'
      }
      if (activeFilter.value === 'failed') {
        return task.status === 'failed'
      }
      return true
    })
    .filter((task) => {
      if (!keyword) return true
      const searchableText = [
        task.name,
        task.prompt,
        task.model,
        task.style,
        task.resolution,
        task.ratio,
        getErrorText(task)
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return searchableText.includes(keyword)
    })
    .sort((a, b) => {
      const aTime = new Date(a.createdAt || 0).getTime()
      const bTime = new Date(b.createdAt || 0).getTime()
      return sortOrder.value === 'desc' ? bTime - aTime : aTime - bTime
    })
})

const groupedTasks = computed(() => {
  const groups = new Map<string, { key: string; label: string; tasks: ImageGenerationTask[] }>()

  filteredTasks.value.forEach((task) => {
    const groupKey = getDayKey(task.createdAt)
    const existing = groups.get(groupKey)
    if (existing) {
      existing.tasks.push(task)
      return
    }
    groups.set(groupKey, {
      key: groupKey,
      label: formatGroupLabel(task.createdAt),
      tasks: [task]
    })
  })

  return Array.from(groups.values())
})

function getStatusIcon(status: string) {
  switch (status) {
    case 'processing':
    case 'pending':
      return PhCircleNotch
    case 'completed':
      return PhCheckCircle
    case 'failed':
      return PhXCircle
    default:
      return PhImage
  }
}

function getStatusColor(status: string): string {
  switch (status) {
    case 'processing':
    case 'pending':
      return 'var(--color-accent-text)'
    case 'completed':
      return 'var(--color-success-text)'
    case 'failed':
      return 'var(--color-danger-text)'
    default:
      return 'var(--color-text-muted)'
  }
}

function getStatusLabel(task: ImageGenerationTask): string {
  if (task.status === 'processing')
    return t('aigcImageHistoryPanel.status.generating', { progress: task.progress || 0 })
  if (task.status === 'pending') return t('aigcImageHistoryPanel.status.pending')
  if (task.status === 'completed') return t('aigcImageHistoryPanel.status.completed')
  if (task.status === 'failed') return t('aigcImageHistoryPanel.status.failed')
  return t('aigcImageHistoryPanel.status.unknown')
}

/**
 * 卡片上那行失败原因。
 *
 * 主进程说不出语言的原因（用户取消）给的是 i18n key，厂商报错给的是原文，
 * 两者都从这里出去 —— 搜索和卡片看到的必须是同一句。
 */
function getErrorText(task: ImageGenerationTask): string {
  if (task.errorKey) return t(task.errorKey)
  return task.error || ''
}

function getThumbnail(task: ImageGenerationTask): string | null {
  // 本地副本优先：远端链接会过期，老记录只认这一份
  return getTaskDisplayUrls(task)[0] || null
}

/** 缩略图同样等浏览器实际拿到像素后才显示。 */
function revealThumbnail(event: Event): void {
  const image = event.currentTarget as HTMLElement
  image.classList.add('is-loaded')
}

function getImageCount(task: ImageGenerationTask): number {
  return task.imageUrls?.length || 0
}

function getReferenceCount(task: ImageGenerationTask): number {
  return task.referenceImages?.length || 0
}

function getMetaChips(task: ImageGenerationTask): string[] {
  const chips: string[] = []
  if (task.model) chips.push(getImageModelLabel(task.model))
  if (task.quality) chips.push(task.quality)
  if (task.resolution) chips.push(task.resolution)
  if (task.ratio) chips.push(task.ratio)
  if (task.style) chips.push(task.style)
  if (task.materialMode) chips.push('PBR maps')
  if (getImageCount(task) > 1)
    chips.push(t('aigcImageHistoryPanel.chips.imageCount', { count: getImageCount(task) }))
  if (getReferenceCount(task) > 0)
    chips.push(t('aigcImageHistoryPanel.chips.reference', { count: getReferenceCount(task) }))
  return chips.slice(0, 5)
}

function formatTime(dateStr?: string): string {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${hours}:${minutes}`
}

function formatRelativeTime(dateStr?: string): string {
  if (!dateStr) return ''
  const now = Date.now()
  const target = new Date(dateStr).getTime()
  const diffMinutes = Math.max(0, Math.floor((now - target) / 60000))

  if (diffMinutes < 1) return t('aigcImageHistoryPanel.relativeTime.justNow')
  if (diffMinutes < 60)
    return t('aigcImageHistoryPanel.relativeTime.minutesAgo', { count: diffMinutes })

  const diffHours = Math.floor(diffMinutes / 60)
  if (diffHours < 24) return t('aigcImageHistoryPanel.relativeTime.hoursAgo', { count: diffHours })

  const diffDays = Math.floor(diffHours / 24)
  if (diffDays < 7) return t('aigcImageHistoryPanel.relativeTime.daysAgo', { count: diffDays })

  return formatGroupLabel(dateStr)
}

function getDayKey(dateStr?: string): string {
  if (!dateStr) return 'unknown'
  const date = new Date(dateStr)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function formatGroupLabel(dateStr?: string): string {
  if (!dateStr) return t('aigcImageHistoryPanel.groupLabel.earlier')

  const date = new Date(dateStr)
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const target = new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
  const diffDays = Math.round((today - target) / 86400000)

  if (diffDays === 0) return t('aigcImageHistoryPanel.groupLabel.today')
  if (diffDays === 1) return t('aigcImageHistoryPanel.groupLabel.yesterday')
  if (diffDays < 7) return t('aigcImageHistoryPanel.groupLabel.daysAgo', { count: diffDays })

  const month = date.getMonth() + 1
  const day = date.getDate()
  return t('aigcImageHistoryPanel.groupLabel.monthDay', { month, day })
}

function handleSelectTask(task: ImageGenerationTask) {
  imageStore.setPreviewTask(task.id)
  emit('select', task)
}

function toggleViewMode() {
  viewMode.value = viewMode.value === 'list' ? 'gallery' : 'list'
  localStorage.setItem(VIEW_MODE_KEY, viewMode.value)
}

/**
 * 卡片上的动作全都交给父组件跑。
 *
 * 「⋯」里是**完整清单**，和中间大图的那份逐字相同；平铺出来的
 * 「填回参数 / 下载」只是快捷方式，不从清单里去掉 ——
 * 找不到就点「⋯」，这条规则要在哪儿都成立。
 */
function runCardAction(key: ImageTaskActionKey, task: ImageGenerationTask | null): void {
  emit('action', { key, task })
}

/** 卡片当下能做哪些事。判断规则和大图区共用一个函数，不会一边多一边少 */
function menuActionsFor(task: ImageGenerationTask): ImageTaskActionDef[] {
  return getAvailableImageTaskActions({
    hasImage: getImageCount(task) > 0,
    hasPrompt: Boolean(task.prompt),
    isCompleted: task.status === 'completed'
  })
}

function isCancellable(task: ImageGenerationTask): boolean {
  return task.status === 'pending' || task.status === 'processing'
}

/**
 * 掐断还在出图的那条任务。
 *
 * 终态只认主进程那一份：它中止请求、停掉进度模拟、把库里的记录置为失败，
 * 再补发一条 `image:event` 的 failed，卡片靠它回落。取消请求比任务登记先到时
 * 主进程会把 ID 记下，登记完自己停掉，照样回这条事件。
 *
 * 所以这里**不要**再本地置一次失败：以前那一手恰好只在「其实没取消成功」的时候
 * 触发，把卡片挪进历史、翻成失败，而主进程的图还在照出 —— 钱花了、图进库了，
 * 卡片随后被后到的 progress 事件翻回转圈，而看门狗只看活跃列表，再没人能收它。
 */
async function handleCancelTask(task: ImageGenerationTask): Promise<void> {
  if (cancellingTaskIds.value.includes(task.id)) return
  cancellingTaskIds.value = [...cancellingTaskIds.value, task.id]

  try {
    const result = await imageGenerationAPI.cancelTask(task.id)
    if (!result.success) {
      message.error(result.error || t(result.errorKey || 'common.error'))
    }
  } finally {
    cancellingTaskIds.value = cancellingTaskIds.value.filter((id) => id !== task.id)
  }
}

function handleHistoryScroll(event: Event): void {
  const target = event.currentTarget as HTMLElement | null
  if (!target || isLoadingHistory.value || !hasMoreHistory.value) return

  const distanceToBottom = target.scrollHeight - target.scrollTop - target.clientHeight
  if (distanceToBottom <= 120) {
    void imageStore.loadMoreHistory()
  }
}

function toggleSortOrder() {
  sortOrder.value = sortOrder.value === 'desc' ? 'asc' : 'desc'
}

function clearSearch() {
  searchKeyword.value = ''
}

async function handleClearFailedTasks(): Promise<void> {
  const failedTasks = allTasks.value.filter((task) => task.status === 'failed')
  if (failedTasks.length === 0 || isClearingFailed.value) return

  confirmDialog({
    title: t('aigcImageHistoryPanel.clearFailedModal.title'),
    content: t('aigcImageHistoryPanel.clearFailedModal.content', { count: failedTasks.length }),
    okText: t('aigcImageHistoryPanel.clearFailedModal.okText'),
    cancelText: t('aigcImageHistoryPanel.clearFailedModal.cancelText'),
    danger: true,
    async onOk() {
      isClearingFailed.value = true
      try {
        for (const task of failedTasks) {
          await imageStore.deleteTask(task.id)
        }
        message.success(
          t('aigcImageHistoryPanel.clearFailedModal.successMessage', {
            count: failedTasks.length
          })
        )
      } finally {
        isClearingFailed.value = false
      }
    }
  })
}

function getEmptyTitle(): string {
  if (summary.value.total === 0) return t('aigcImageHistoryPanel.emptyState.titleNoRecords')
  if (searchKeyword.value.trim()) return t('aigcImageHistoryPanel.emptyState.titleNoMatch')
  if (activeFilter.value === 'active') return t('aigcImageHistoryPanel.emptyState.titleNoActive')
  if (activeFilter.value === 'completed')
    return t('aigcImageHistoryPanel.emptyState.titleNoCompleted')
  if (activeFilter.value === 'failed') return t('aigcImageHistoryPanel.emptyState.titleNoFailed')
  return t('aigcImageHistoryPanel.emptyState.titleNoRecordsToShow')
}

function getEmptyDescription(): string {
  if (summary.value.total === 0) return t('aigcImageHistoryPanel.emptyState.descNoRecords')
  if (searchKeyword.value.trim()) return t('aigcImageHistoryPanel.emptyState.descNoMatch')
  if (activeFilter.value === 'failed') return t('aigcImageHistoryPanel.emptyState.descNoFailed')
  return t('aigcImageHistoryPanel.emptyState.descDefault')
}
</script>

<template>
  <div class="image-history-panel">
    <div class="panel-header">
      <div class="header-main">
        <div class="header-title">
          <PhClockCounterClockwise class="header-icon" />
          <div>
            <div class="title-text">{{ $t('aigcImageHistoryPanel.header.title') }}</div>
          </div>
        </div>
        <button class="header-link" @click="runCardAction('locate', null)">
          {{ $t('aigcImageHistoryPanel.header.openVaultLink') }}
        </button>
      </div>

      <div class="search-box">
        <PhMagnifyingGlass class="search-icon" />
        <input
          v-model="searchKeyword"
          type="text"
          :placeholder="$t('aigcImageHistoryPanel.search.placeholder')"
        />
        <button v-if="searchKeyword" class="clear-search-btn" @click="clearSearch()">
          <PhEraser />
        </button>
      </div>

      <div class="filter-row">
        <button
          class="filter-chip"
          :class="{ active: activeFilter === 'all' }"
          @click="activeFilter = 'all'"
        >
          {{ $t('aigcImageHistoryPanel.filters.all') }}
          <span>{{ summary.total }}</span>
        </button>
        <button
          class="filter-chip"
          :class="{ active: activeFilter === 'active' }"
          @click="activeFilter = 'active'"
        >
          {{ $t('aigcImageHistoryPanel.filters.active') }}
          <span>{{ summary.active }}</span>
        </button>
        <button
          class="filter-chip"
          :class="{ active: activeFilter === 'completed' }"
          @click="activeFilter = 'completed'"
        >
          {{ $t('aigcImageHistoryPanel.filters.completed') }}
          <span>{{ summary.completed }}</span>
        </button>
        <button
          class="filter-chip"
          :class="{ active: activeFilter === 'failed' }"
          @click="activeFilter = 'failed'"
        >
          {{ $t('aigcImageHistoryPanel.filters.failed') }}
          <span>{{ summary.failed }}</span>
        </button>
      </div>

      <div class="toolbar-row">
        <div class="toolbar-group">
          <button class="toolbar-btn" @click="toggleSortOrder()">
            <PhClock />
            {{
              sortOrder === 'desc'
                ? $t('aigcImageHistoryPanel.toolbar.sortDesc')
                : $t('aigcImageHistoryPanel.toolbar.sortAsc')
            }}
          </button>
          <button class="toolbar-btn" @click="toggleViewMode()">
            <component :is="viewMode === 'list' ? PhSquaresFour : PhListBullets" />
            {{
              viewMode === 'list'
                ? $t('aigcImageHistoryPanel.toolbar.galleryMode')
                : $t('aigcImageHistoryPanel.toolbar.listMode')
            }}
          </button>
        </div>
        <button
          v-if="summary.failed > 0"
          class="toolbar-btn danger"
          :disabled="isClearingFailed"
          @click="handleClearFailedTasks()"
        >
          <PhTrash />
          {{ $t('aigcImageHistoryPanel.toolbar.clearFailed') }}
        </button>
      </div>
    </div>

    <div class="history-list" @scroll="handleHistoryScroll">
      <template v-if="groupedTasks.length > 0">
        <section v-for="group in groupedTasks" :key="group.key" class="history-group">
          <div class="group-header">
            <span>{{ group.label }}</span>
            <span class="group-count">{{ group.tasks.length }}</span>
          </div>

          <div class="group-content" :class="{ gallery: viewMode === 'gallery' }">
            <div
              v-for="task in group.tasks"
              :key="task.id"
              class="history-card"
              :class="{
                active: previewTaskId === task.id,
                processing: task.status === 'processing' || task.status === 'pending',
                failed: task.status === 'failed',
                gallery: viewMode === 'gallery'
              }"
              @click="handleSelectTask(task)"
              @dblclick="task.status === 'completed' && runCardAction('locate', task)"
            >
              <div class="thumbnail-wrapper">
                <img
                  v-if="getThumbnail(task)"
                  :key="getThumbnail(task) ?? task.id"
                  :src="getThumbnail(task)!"
                  class="thumbnail thumbnail-result"
                  @load="revealThumbnail"
                  @error="revealThumbnail"
                />
                <div
                  v-else-if="task.status === 'processing' || task.status === 'pending'"
                  class="thumbnail-skeleton"
                >
                  <div class="skeleton-shimmer"></div>
                </div>
                <div v-else class="thumbnail-placeholder">
                  <component
                    :is="getStatusIcon(task.status)"
                    :style="{ color: getStatusColor(task.status) }"
                  />
                </div>

                <div v-if="getImageCount(task) > 1" class="image-count-badge">
                  {{ $t('aigcImageHistoryPanel.chips.imageCount', { count: getImageCount(task) }) }}
                </div>
              </div>

              <div class="card-body">
                <div class="card-topline">
                  <p class="prompt" :title="task.name || task.prompt">
                    {{ task.name || task.prompt || $t('aigcImageHistoryPanel.card.untitled') }}
                  </p>
                  <span class="relative-time">{{ formatRelativeTime(task.createdAt) }}</span>
                </div>

                <div class="meta-row">
                  <span class="status-pill" :style="{ color: getStatusColor(task.status) }">
                    <component :is="getStatusIcon(task.status)" />
                    {{ getStatusLabel(task) }}
                  </span>
                  <span class="time-label">{{ formatTime(task.createdAt) }}</span>
                </div>

                <div class="chip-row">
                  <span v-for="chip in getMetaChips(task)" :key="chip" class="meta-chip">
                    {{ chip }}
                  </span>
                </div>

                <p
                  v-if="task.status === 'failed' && getErrorText(task)"
                  class="error-reason"
                  :title="getErrorText(task)"
                >
                  {{ getErrorText(task) }}
                </p>

                <div v-if="task.status === 'processing'" class="progress-bar">
                  <div class="progress-fill" :style="{ width: `${task.progress}%` }"></div>
                </div>
              </div>

              <!--
                五个图标压在缩略图上，既盖住了要看的东西，也逼着人逐个猜。
                卡片窄，只平铺两个最常用的；「⋯」里是完整清单，
                和中间大图顶部的那份逐字相同 —— 删除尤其不该和下载并排。
              -->
              <div class="action-column" :class="{ gallery: viewMode === 'gallery' }">
                <button
                  class="action-btn"
                  :title="$t('aigcImageActions.useParams')"
                  :aria-label="$t('aigcImageActions.useParams')"
                  @click.stop="runCardAction('useParams', task)"
                >
                  <PhPencilSimple />
                </button>
                <button
                  v-if="isCancellable(task)"
                  class="action-btn danger"
                  :disabled="cancellingTaskIds.includes(task.id)"
                  :title="$t('common.cancel')"
                  :aria-label="$t('common.cancel')"
                  @click.stop="handleCancelTask(task)"
                >
                  <PhX />
                </button>
                <button
                  v-if="task.status === 'completed'"
                  class="action-btn"
                  :title="$t('aigcImageActions.download')"
                  :aria-label="$t('aigcImageActions.download')"
                  @click.stop="runCardAction('download', task)"
                >
                  <PhDownloadSimple />
                </button>
                <AppDropdown
                  v-if="task.status === 'completed' || task.status === 'failed'"
                  :trigger="['click']"
                  placement="bottomRight"
                >
                  <button
                    class="action-btn"
                    :title="$t('aigcImageActions.more')"
                    :aria-label="$t('aigcImageActions.more')"
                    @click.stop
                  >
                    <PhDotsThree />
                  </button>
                  <template #overlay>
                    <AppMenu @click="(info) => runCardAction(info.key as ImageTaskActionKey, task)">
                      <AppMenuItem
                        v-for="action in menuActionsFor(task)"
                        :key="action.key"
                        :item-key="action.key"
                        :danger="action.danger === true"
                      >
                        <template #icon><component :is="action.icon" /></template>
                        {{ $t(action.labelKey) }}
                      </AppMenuItem>
                    </AppMenu>
                  </template>
                </AppDropdown>
              </div>
            </div>
          </div>
        </section>

        <div v-if="hasMoreHistory || isLoadingHistory" class="history-load-more">
          <button
            class="load-more-btn"
            :disabled="isLoadingHistory"
            @click="imageStore.loadMoreHistory()"
          >
            <PhCircleNotch v-if="isLoadingHistory" />
            {{
              isLoadingHistory
                ? $t('aigcImageHistoryPanel.loadMore.loading')
                : $t('aigcImageHistoryPanel.loadMore.loadMore')
            }}
          </button>
        </div>
      </template>

      <div v-else class="empty-state">
        <PhImage class="empty-icon" />
        <p class="empty-title">{{ getEmptyTitle() }}</p>
        <p class="empty-desc">{{ getEmptyDescription() }}</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.image-history-panel {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 16px 14px 16px 10px;
  color: var(--color-text-primary);
}

.panel-header {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 14px;
  border-bottom: 1px solid var(--color-border);
}

.header-main {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.header-title {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.header-icon {
  font-size: 18px;
  color: var(--color-text-primary);
}

.title-text {
  font-size: 15px;
  font-weight: 600;
  line-height: 1.2;
}

.header-link {
  border: none;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-secondary);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.18s ease;
  white-space: nowrap;
}

.header-link:hover {
  color: var(--color-text-primary);
  background: var(--color-bg-surface-hover);
}

.search-box {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 10px;
  border-radius: 10px;
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
}

.search-icon {
  color: var(--color-text-muted);
  font-size: 14px;
}

.search-box input {
  flex: 1;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--color-text-primary);
  font-size: 13px;
  outline: none;
}

.search-box input::placeholder {
  color: var(--color-text-muted);
}

.clear-search-btn {
  width: 24px;
  height: 24px;
  border: none;
  background: transparent;
  color: var(--color-text-muted);
  cursor: pointer;
  border-radius: 6px;
}

.clear-search-btn:hover {
  color: var(--color-text-primary);
  background: var(--color-bg-surface-hover);
}

.filter-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.filter-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-bg-surface-hover);
  color: var(--color-text-secondary);
  border-radius: 999px;
  padding: 6px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.18s ease;
}

.filter-chip span {
  min-width: 18px;
  height: 18px;
  border-radius: 999px;
  background: var(--color-bg-surface-hover);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
}

.filter-chip.active {
  color: var(--color-text-primary);
  background: var(--color-bg-selected);
}

.filter-chip.active span {
  background: var(--color-bg-selected);
}

.toolbar-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 8px;
}

.toolbar-group {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  border: none;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-secondary);
  border-radius: 8px;
  padding: 7px 10px;
  font-size: 12px;
  cursor: pointer;
  transition: all 0.18s ease;
}

.toolbar-btn:hover:not(:disabled) {
  color: var(--color-text-primary);
  background: var(--color-bg-surface-hover);
}

.toolbar-btn:disabled {
  color: var(--color-text-disabled);
  cursor: not-allowed;
}

.toolbar-btn.danger:hover:not(:disabled) {
  color: var(--color-text-primary);
  background: var(--color-danger-bg);
}

.history-list {
  flex: 1;
  overflow-y: auto;
  padding-top: 14px;
  padding-right: 2px;
}

.history-load-more {
  display: flex;
  justify-content: center;
  padding: 10px 0 2px;
}

.load-more-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 32px;
  padding: 0 14px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-secondary);
  font-size: 12px;
  cursor: pointer;
  transition:
    background 0.18s ease,
    color 0.18s ease,
    border-color 0.18s ease;
}

.load-more-btn:hover:not(:disabled) {
  color: var(--color-text-primary);
  background: var(--color-bg-surface-hover);
  border-color: var(--color-border);
}

.load-more-btn:disabled {
  cursor: default;
  color: var(--color-text-disabled);
}

.history-group + .history-group {
  margin-top: 18px;
}

.group-content.gallery {
  display: block;
  column-width: 220px;
  column-gap: 14px;
}

.group-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  color: var(--color-text-secondary);
  font-size: 12px;
  font-weight: 500;
}

.group-count {
  color: var(--color-text-muted);
}

.history-card {
  display: flex;
  gap: 12px;
  padding: 12px;
  border-radius: 14px;
  cursor: pointer;
  margin-bottom: 10px;
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  transition:
    transform 0.18s ease,
    border-color 0.18s ease,
    background 0.18s ease,
    box-shadow 0.18s ease;
}

.history-card.gallery {
  position: relative;
  display: inline-block;
  width: 100%;
  padding: 0;
  margin-bottom: 14px;
  overflow: hidden;
  border-radius: 16px;
  break-inside: avoid;
  page-break-inside: avoid;
}

.history-card:hover {
  transform: translateY(-1px);
  border-color: var(--color-border);
  box-shadow: 0 14px 24px var(--shadow-color-weak);
}

.history-card.active {
  background: var(--color-bg-selected);
}

.history-card.gallery:hover {
  background: var(--color-bg-surface-hover);
}

/* 「正在看的那张图」得跟「鼠标碰巧划过的那张」分开 */
.history-card.gallery.active {
  background: var(--color-bg-selected);
}

.history-card.processing {
  border-color: var(--color-accent-border);
}

.history-card.failed {
  border-color: var(--color-danger-border);
}

.thumbnail-wrapper {
  position: relative;
  width: 64px;
  height: 64px;
  border-radius: 12px;
  overflow: hidden;
  flex-shrink: 0;
  background: var(--color-bg-surface-hover);
}

.history-card.gallery .thumbnail-wrapper {
  width: 100%;
  height: auto;
  min-height: 220px;
  aspect-ratio: auto;
  border-radius: 0;
}

.thumbnail {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.thumbnail-result {
  opacity: 0;
  transform: scale(0.985);
}

.thumbnail-result.is-loaded {
  opacity: 1;
  transform: scale(1);
  animation: thumbnail-result-reveal var(--motion-fast) var(--easing-decelerate) both;
}

@keyframes thumbnail-result-reveal {
  from {
    opacity: 0;
    transform: scale(0.985);
  }

  to {
    opacity: 1;
    transform: scale(1);
  }
}

.history-card.gallery .thumbnail {
  height: auto;
  min-height: 220px;
  display: block;
}

.history-card.gallery .thumbnail-skeleton,
.history-card.gallery .thumbnail-placeholder {
  min-height: 240px;
}

.thumbnail-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 24px;
  background: var(--color-bg-surface-hover);
}

.thumbnail-skeleton {
  width: 100%;
  height: 100%;
  background: var(--color-accent-bg);
  position: relative;
  overflow: hidden;
}

.skeleton-shimmer {
  position: absolute;
  top: 0;
  left: -100%;
  width: 100%;
  height: 100%;
  background: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.18) 50%,
    transparent 100%
  );
  animation: shimmer 1.4s infinite;
}

@keyframes shimmer {
  0% {
    left: -100%;
  }
  100% {
    left: 100%;
  }
}

@media (prefers-reduced-motion: reduce) {
  .thumbnail-result,
  .thumbnail-result.is-loaded {
    animation: none;
    transform: none;
  }

  .skeleton-shimmer {
    animation: none;
  }
}

.image-count-badge {
  position: absolute;
  right: 6px;
  bottom: 6px;
  min-width: 24px;
  height: 20px;
  padding: 0 6px;
  border-radius: 999px;
  background: var(--color-bg-overlay);
  color: var(--color-text-on-solid);
  font-size: 11px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.history-card.gallery .image-count-badge {
  top: 10px;
  right: auto;
  bottom: auto;
  left: 10px;
  background: var(--color-bg-overlay);
  backdrop-filter: blur(8px);
}

.card-body {
  flex: 1;
  min-width: 0;
}

.history-card.gallery .card-body {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 1;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 56px 12px 12px;
  background: linear-gradient(
    180deg,
    rgba(15, 23, 42, 0),
    var(--color-bg-surface) 34%,
    var(--color-bg-surface)
  );
  opacity: 0;
  transform: translateY(10px);
  transition:
    opacity 0.18s ease,
    transform 0.18s ease;
}

.history-card.gallery:hover .card-body,
.history-card.gallery.active .card-body {
  opacity: 1;
  transform: translateY(0);
}

.card-topline {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.prompt {
  margin: 0;
  color: var(--color-text-primary);
  font-size: 13px;
  font-weight: 500;
  line-height: 1.45;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.history-card.gallery .prompt {
  -webkit-line-clamp: 2;
  min-height: 0;
  color: var(--color-text-primary);
  font-weight: 600;
  text-shadow: 0 2px 12px var(--shadow-color-strong);
}

.relative-time {
  flex-shrink: 0;
  font-size: 11px;
  color: var(--color-text-muted);
}

.history-card.gallery .relative-time,
.history-card.gallery .time-label {
  color: var(--color-text-primary);
}

.meta-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  min-height: 22px;
}

.status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 500;
}

.time-label {
  font-size: 11px;
  color: var(--color-text-muted);
}

.chip-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.history-card.gallery .chip-row {
  gap: 5px;
  max-height: 23px;
  overflow: hidden;
  margin-top: 0;
}

.meta-chip {
  display: inline-flex;
  align-items: center;
  max-width: 100%;
  border-radius: 999px;
  padding: 4px 8px;
  font-size: 11px;
  color: var(--color-text-secondary);
  background: var(--color-bg-surface-hover);
  border: 1px solid var(--color-border-subtle);
}

.history-card.gallery .meta-chip {
  padding: 3px 7px;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
  border-color: var(--color-border-subtle);
  backdrop-filter: blur(8px);
}

.error-reason {
  margin: 8px 0 0 0;
  font-size: 11px;
  line-height: 1.45;
  color: var(--color-danger-text);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.progress-bar {
  margin-top: 10px;
  height: 4px;
  border-radius: 999px;
  background: var(--color-bg-surface-hover);
  overflow: hidden;
}

.history-card.gallery .progress-bar {
  height: 4px;
  margin-top: 2px;
}

.progress-fill {
  height: 100%;
  border-radius: inherit;
  background: var(--gradient-accent);
  transition: width 0.3s ease;
}

.action-column {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  opacity: 0;
  transition: opacity 0.18s ease;
}

.action-column.gallery {
  position: absolute;
  top: 10px;
  right: 10px;
  z-index: 2;
  flex-direction: row;
  justify-content: flex-end;
  flex-wrap: wrap;
  max-width: calc(100% - 20px);
  padding: 5px;
  border-radius: 10px;
  background: var(--color-bg-surface-hover);
  backdrop-filter: blur(10px);
  opacity: 0;
}

.history-card.gallery:hover .action-column.gallery,
.history-card.gallery.active .action-column.gallery {
  opacity: 1;
}

.history-card.gallery .action-btn {
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
}

.history-card:hover .action-column,
.history-card.active .action-column {
  opacity: 1;
}

.action-btn {
  width: 28px;
  height: 28px;
  border: none;
  border-radius: 8px;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-secondary);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition: all 0.18s ease;
}

.action-btn:hover {
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
}

.action-btn.danger:hover:not(:disabled) {
  background: var(--color-danger-bg);
  color: var(--color-text-primary);
}

.action-btn:disabled {
  color: var(--color-text-disabled);
  cursor: not-allowed;
}

/* 还在出图的卡片把动作列常驻：取消按钮藏在 hover 里等于没有 */
.history-card.processing .action-column,
.history-card.processing .action-column.gallery {
  opacity: 1;
}

.empty-state {
  min-height: 240px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--color-text-muted);
  padding: 24px 12px;
}

.empty-icon {
  font-size: 34px;
  margin-bottom: 12px;
  opacity: 0.7;
}

.empty-title {
  margin: 0;
  color: var(--color-text-primary);
  font-size: 14px;
  font-weight: 500;
}

.empty-desc {
  margin: 8px 0 0 0;
  max-width: 240px;
  line-height: 1.6;
  font-size: 12px;
}
</style>
