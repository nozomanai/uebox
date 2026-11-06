<script setup lang="ts">
/**
 * 库浏览器 —— 资产库、蓝图库、材质库共用的那一个壳。
 *
 * 三个库不是三个页面，是同一个浏览器的三个 {@link BrowserScope}：
 * 侧边栏点哪个入口，就换一份 scope 进来（限定 kind、换一套筛选字段、
 * 指定双击打开谁）。用户自己存的智能集合跟它们平级。
 *
 * 卡片、网格、搜索框、下拉、视图切换、空状态全部复用
 * `library-common/components/` 里现成的那批，这里只做**编排**：
 * 筛选、选中、拖放落点、以及把模块挂到插槽上。
 *
 * ## 这里面没有什么
 *
 * 没有百度云、没有 WebDAV、没有网络协作库、没有依赖图、没有导入任务。
 * 那些不是每个人都在用，全部做成模块挂在插槽上（见 `moduleRegistry.ts`）。
 * 这个文件里出现任何一个具体云盘的名字，都说明模块机制没做对。
 */
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useInitialLoading } from '@renderer/composables/useInitialLoading'

import LibraryCard from '@renderer/views/library-common/components/LibraryCard.vue'
import LibraryEmptyState from '@renderer/views/library-common/components/LibraryEmptyState.vue'
import LibraryGrid from '@renderer/views/library-common/components/LibraryGrid.vue'
import LibraryListTable from '@renderer/views/library-common/components/LibraryListTable.vue'
import LibrarySearchIsland from '@renderer/views/library-common/components/LibrarySearchIsland.vue'
import LibrarySelect from '@renderer/views/library-common/components/LibrarySelect.vue'
import LibrarySkeletonCard from '@renderer/views/library-common/components/LibrarySkeletonCard.vue'
import LibraryViewToggle from '@renderer/views/library-common/components/LibraryViewToggle.vue'

import BrowserFolderTree from './BrowserFolderTree.vue'
import {
  collectBulkActions,
  collectSidebarPanels,
  collectStatusPanels,
  collectToolbarActions,
  isActionEnabled,
  type BrowserAction,
  type BrowserActionContext,
  type ResolvedAction
} from './moduleRegistry'
import { useBrowserModules } from './useBrowserModules'
import type {
  BrowserContext,
  BrowserDensity,
  BrowserFolder,
  BrowserItem,
  BrowserScope,
  BrowserSortType,
  BrowserViewMode
} from './types'

const props = withDefaults(
  defineProps<{
    scope: BrowserScope
    items: BrowserItem[]
    folders: BrowserFolder[]
    loading?: boolean
  }>(),
  { loading: false }
)

const emit = defineEmits<{
  (e: 'open', item: BrowserItem): void
  /** 把一批条目移到某个文件夹 —— 落点是文件夹树，不是另一张卡片 */
  (e: 'move', items: BrowserItem[], folderKey: string): void
  (e: 'selection-change', items: BrowserItem[]): void
  (e: 'create-folder', name: string, onCreated: (folderKey: string) => void): void
  (e: 'rename-folder', folderKey: string, name: string): void
  (e: 'delete-folder', folderKey: string): void
}>()
/** 未绑定时由组件自行维护；需要在重启后保留视图模式的库，自行绑定并负责存盘 */
const viewMode = defineModel<BrowserViewMode>('viewMode', { default: 'grid' })

const { t } = useI18n()
const initialLoading = useInitialLoading(
  () => props.loading,
  () => props.items.length > 0
)

// ========== 浏览状态 ==========

const folderKey = ref('')
const keyword = ref('')
const sortType = ref<BrowserSortType>('recent')
/** 每个 facet 当前选了什么，空串表示不限 */
const facetValues = ref<Record<string, string>>({})
const selectedIds = ref<string[]>([])
/** 正在拖的那批。拖动开始时定下来，落到树上时用。 */
const dragging = ref<BrowserItem[]>([])

// 换库（换 scope）时把上一个库的筛选状态清掉 —— 留着会让人以为「东西怎么少了」
watch(
  () => props.scope.id,
  () => {
    folderKey.value = ''
    keyword.value = ''
    facetValues.value = {}
    selectedIds.value = []
  }
)

// ========== 筛选 ==========

const scopedItems = computed(() => {
  const kinds = props.scope.kinds
  if (kinds.length === 0) return props.items
  const allowed = new Set(kinds)
  return props.items.filter((item) => allowed.has(item.kind))
})

const visibleItems = computed(() => {
  const needle = keyword.value.trim().toLowerCase()
  const facets = Object.entries(facetValues.value).filter(([, value]) => value)

  const filtered = scopedItems.value.filter((item) => {
    if (folderKey.value && item.folderKey !== folderKey.value) return false

    if (needle) {
      const haystack = `${item.name} ${item.subtitle ?? ''} ${item.tags.join(' ')}`.toLowerCase()
      if (!haystack.includes(needle)) return false
    }

    // facet 的取值从原始领域对象上读 —— 壳层不认识「混合模式」这种字段，
    // 只知道按 key 去 source 上取一个值来比
    for (const [key, value] of facets) {
      const source = item.source as Record<string, unknown> | null
      if (String(source?.[key] ?? '') !== value) return false
    }

    return true
  })

  return [...filtered].sort((a, b) => {
    if (sortType.value === 'name') return a.name.localeCompare(b.name, 'zh-Hans-CN')
    if (sortType.value === 'created') return b.createdAt - a.createdAt
    return b.updatedAt - a.updatedAt
  })
})

/** 每个文件夹里有多少条目，画在树上 */
const folderCounts = computed(() => {
  const counts: Record<string, number> = {}
  for (const item of scopedItems.value) {
    counts[item.folderKey] = (counts[item.folderKey] ?? 0) + 1
  }
  return counts
})

const selection = computed(() =>
  visibleItems.value.filter((item) => selectedIds.value.includes(item.id))
)

/** 用户此刻有没有在缩小范围。点文件夹不算 —— 它是浏览位置，不是筛选条件 */
const hasQuery = computed(
  () => keyword.value.trim().length > 0 || Object.values(facetValues.value).some((value) => value)
)

/**
 * 一条都不剩有三种原因，该说的话不一样：
 *
 *   1. 库里本来就什么都没有 —— 用户该去新建。标题带上 `scope.title`，
 *      所以蓝图库说「蓝图库」、材质库说「材质库」，这一个壳不用为两个库各写一套文案。
 *   2. 库里有东西，但用户点开的那个文件夹里没有 —— 用户该去换个文件夹。
 *   3. 搜索或筛选把东西筛没了 —— 用户该去放宽条件。
 *
 * 第 2 种以前和第 3 种共用一句话，于是什么都没搜、只是点了个空文件夹的人
 * 会读到「没有符合条件的条目」—— 他一个条件都没设。
 */
const emptyTitle = computed(() => {
  if (scopedItems.value.length === 0) {
    return t('libraryBrowser.emptyTitle', { library: t(props.scope.title) })
  }
  if (!hasQuery.value && folderKey.value) return t('libraryBrowser.emptyFolderTitle')
  return t('libraryBrowser.filteredEmptyTitle')
})

/**
 * 界面重量。不填按 full —— 新加一个库时先给它完整的，
 * 觉得太重了再显式降级，比反过来安全。
 */
const density = computed<BrowserDensity>(() => props.scope.density ?? 'full')
const isLight = computed(() => density.value === 'light')

const sortOptions = computed(() => [
  { value: 'recent', label: t('libraryBrowser.sortRecent') },
  { value: 'name', label: t('libraryBrowser.sortName') },
  { value: 'created', label: t('libraryBrowser.sortCreated') }
])

/** facet 下拉的第一项是「不限」，用 facet 自己的名字当占位 */
function facetOptions(
  facet: BrowserScope['facets'][number]
): Array<{ value: string; label: string }> {
  return [{ value: '', label: t(facet.label) }, ...facet.options]
}

/**
 * 列表模式的表头。
 *
 * 列名刻意是通用的（「信息」而不是「引擎版本」）—— 同一个表格要同时装下
 * 蓝图的「2 图表 · UE 5.5」和材质的「混合 · 着色」，见 LibraryListTable 的注释。
 */
const listColumns = computed(() => [
  t('libraryBrowser.colName'),
  t('libraryBrowser.colType'),
  t('libraryBrowser.colUpdated'),
  t('libraryBrowser.colInfo'),
  t('libraryBrowser.colTags')
])

/** 骨架屏铺几张。固定 8 张：够占满第一屏，又不会在小窗口里拖出滚动条。 */
const SKELETON_COUNT = 8

function formatUpdated(timestamp: number): string {
  if (!timestamp) return ''
  return new Date(timestamp).toLocaleDateString()
}

// ========== 模块 ==========

const browserContext = computed<BrowserContext>(() => ({
  scope: props.scope,
  folderKey: folderKey.value,
  selection: selection.value,
  items: visibleItems.value
}))

const modules = useBrowserModules(() => browserContext.value)

const actionContext = computed<BrowserActionContext>(() => ({
  ...browserContext.value,
  target: selection.value[0] ?? null
}))

const toolbarActions = computed(() =>
  collectToolbarActions(modules.activeModules.value, actionContext.value)
)
const bulkActions = computed(() =>
  collectBulkActions(modules.activeModules.value, actionContext.value)
)
const sidebarPanels = computed(() =>
  collectSidebarPanels(modules.activeModules.value, browserContext.value)
)
const statusPanels = computed(() =>
  collectStatusPanels(modules.activeModules.value, browserContext.value)
)

/**
 * 跑一个模块动作。
 *
 * 包一层 try/catch：模块是可插拔的，一个云盘上传失败不该把浏览器整个带崩。
 */
async function runAction(action: ResolvedAction | BrowserAction): Promise<void> {
  try {
    await action.run(actionContext.value)
  } catch (error) {
    console.error(`[LibraryBrowser] 模块动作执行失败: ${action.id}`, error)
  }
}

// ========== 交互 ==========

function onClick(item: BrowserItem, event: MouseEvent): void {
  if (props.scope.openOnClick) {
    if (event.detail <= 1) onOpen(item)
    return
  }
  if (event.ctrlKey || event.metaKey) {
    selectedIds.value = selectedIds.value.includes(item.id)
      ? selectedIds.value.filter((id) => id !== item.id)
      : [...selectedIds.value, item.id]
  } else {
    selectedIds.value = [item.id]
  }
  emit('selection-change', selection.value)
}

function onOpen(item: BrowserItem): void {
  props.scope.open?.(item)
  emit('open', item)
}

function onDragStart(item: BrowserItem): void {
  // 拖一个没选中的条目 = 只拖它；拖选中的其中一个 = 拖整批
  dragging.value = selectedIds.value.includes(item.id) ? selection.value : [item]
}

/** 删掉的正是当前选中的那个文件夹时，把视图退回「全部」，否则会停在一个不存在的地方 */
function onDeleteFolder(target: string): void {
  if (folderKey.value === target) folderKey.value = ''
  emit('delete-folder', target)
}

function onDropToFolder(target: string): void {
  if (dragging.value.length === 0) return
  emit('move', dragging.value, target)
  dragging.value = []
}

// ========== 侧栏拖宽 ==========

/** 拖好的宽度记在这台机器上。三个库共用这个壳，宽度跟机器走，不跟库走 */
const SIDEBAR_WIDTH_KEY = 'library-browser-sidebar-width'
const SIDEBAR_MIN_WIDTH = 180
const SIDEBAR_MAX_WIDTH = 480
const SIDEBAR_DEFAULT_WIDTH = 240
const SIDEBAR_LIGHT_WIDTH = 200

function clampSidebarWidth(width: number): number {
  return Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, width))
}

/** 用户拖过的宽度。没拖过时按库的密度给默认值 —— 换到轻量库侧栏自动窄一档 */
const savedSidebarWidth = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
const draggedSidebarWidth = ref<number | null>(
  savedSidebarWidth > 0 ? clampSidebarWidth(savedSidebarWidth) : null
)
const sidebarWidth = computed(
  () => draggedSidebarWidth.value ?? (isLight.value ? SIDEBAR_LIGHT_WIDTH : SIDEBAR_DEFAULT_WIDTH)
)

/**
 * 分界线拖宽，与 useLibraryEditorShell 里编辑器侧栏同一套手势：
 * 按下后横向拖，document 上听 move/up。区别是这里松手要把结果落盘，
 * 编辑器那份不持久化宽度。
 */
function onSidebarResizeStart(e: MouseEvent): void {
  e.preventDefault()
  const startX = e.clientX
  const startW = sidebarWidth.value

  const onMove = (ev: MouseEvent): void => {
    draggedSidebarWidth.value = clampSidebarWidth(startW + ev.clientX - startX)
  }
  const onUp = (): void => {
    document.removeEventListener('mousemove', onMove)
    document.removeEventListener('mouseup', onUp)
    document.body.style.cursor = ''
    document.body.style.userSelect = ''
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(draggedSidebarWidth.value))
  }
  document.addEventListener('mousemove', onMove)
  document.addEventListener('mouseup', onUp)
  document.body.style.cursor = 'col-resize'
  document.body.style.userSelect = 'none'
}
</script>

<template>
  <div class="library-browser">
    <aside
      class="browser-sidebar"
      :class="{ 'is-light': isLight }"
      :style="{ width: sidebarWidth + 'px' }"
    >
      <BrowserFolderTree
        v-model="folderKey"
        :folders="folders"
        :counts="folderCounts"
        :root-label="t('libraryBrowser.allFolders')"
        :root-count="scopedItems.length"
        :section-title="t('libraryBrowser.folderSection')"
        :create-title="t('libraryBrowser.createFolder')"
        :default-folder-name="t('libraryBrowser.newFolderName')"
        :rename-title="t('libraryBrowser.renameFolder')"
        :delete-title="t('libraryBrowser.deleteFolder')"
        @drop-items="onDropToFolder"
        @create-folder="
          (name: string, onCreated: (folderKey: string) => void) =>
            emit('create-folder', name, onCreated)
        "
        @rename-folder="(key: string, name: string) => emit('rename-folder', key, name)"
        @delete-folder="onDeleteFolder"
      />

      <!-- 模块挂在侧栏底部，比如网络库的同步状态 -->
      <div v-if="sidebarPanels.length" class="browser-sidebar-modules">
        <component
          :is="panel.component"
          v-for="panel in sidebarPanels"
          :key="`${panel.moduleId}:${panel.id}`"
          :context="browserContext"
        />
      </div>

      <!--
        分界线的拖拽热区：一条透明竖条骑在侧栏右边框上，平时隐形，
        悬停/拖动时把底下那条边框点亮（样式见 .sidebar-resize-handle）。
      -->
      <div
        class="sidebar-resize-handle"
        role="separator"
        aria-orientation="vertical"
        :aria-label="t('libraryBrowser.resizeSidebar')"
        @mousedown="onSidebarResizeStart"
      />
    </aside>

    <section class="browser-main">
      <!--
        控件一律收进「操作岛」，和页面头部同一套语言（裁决 #3 #7）。
        这里不画底色也不画分隔边框 —— 头部与工具栏要读成一整块玻璃头，
        中间横一条实线会把页面切成两截。
      -->
      <header class="browser-toolbar">
        <LibrarySearchIsland
          v-model="keyword"
          :placeholder="t('libraryBrowser.searchPlaceholder')"
          :clear-title="t('libraryBrowser.clearSearch')"
        />

        <!-- 筛选与排序是同一件事（缩小范围），收在一个岛里 -->
        <div class="action-island">
          <LibrarySelect
            v-for="facet in scope.facets"
            :key="facet.key"
            v-model="facetValues[facet.key]"
            :options="facetOptions(facet)"
            :label="t(facet.label)"
          />
          <span v-if="scope.facets.length" class="divider" />
          <LibrarySelect
            v-model="sortType"
            :options="sortOptions"
            :label="t('libraryBrowser.sort')"
          />
        </div>

        <div class="action-island">
          <LibraryViewToggle
            v-model="viewMode"
            :grid-title="t('libraryBrowser.viewGrid')"
            :list-title="t('libraryBrowser.viewList')"
          />
        </div>

        <span class="toolbar-spacer" />

        <slot name="toolbar" />

        <!-- 模块的工具栏按钮排在自带控件后面 -->
        <button
          v-for="action in toolbarActions"
          :key="`${action.moduleId}:${action.id}`"
          type="button"
          class="toolbar-button"
          :disabled="!isActionEnabled(action, actionContext)"
          @click="runAction(action)"
        >
          {{ t(action.label) }}
        </button>
      </header>

      <!--
        选中提示做成一条玻璃带而不是刷满品牌色：整行实心蓝在玻璃页面里太抢眼，
        而它只是个临时状态。
      -->
      <div v-if="selection.length" class="browser-bulkbar">
        <span class="bulkbar-count">
          {{ t('libraryBrowser.selectedCount', { count: selection.length }) }}
        </span>
        <button
          v-for="action in bulkActions"
          :key="`${action.moduleId}:${action.id}`"
          type="button"
          class="toolbar-button"
          :disabled="!isActionEnabled(action, actionContext)"
          @click="runAction(action)"
        >
          {{ t(action.label) }}
        </button>
        <button type="button" class="toolbar-button" @click="selectedIds = []">
          {{ t('libraryBrowser.clearSelection') }}
        </button>
      </div>

      <div class="browser-content">
        <!-- 加载中铺骨架而不是一行「加载中…」：位置先占住，出内容时不会整页跳一下 -->
        <LibraryGrid v-if="initialLoading" :aria-label="t('libraryBrowser.loading')">
          <LibrarySkeletonCard v-for="n in SKELETON_COUNT" :key="n" />
        </LibraryGrid>

        <LibraryEmptyState v-else-if="visibleItems.length === 0" :title="emptyTitle" />

        <!--
          列表模式走真正的表格（表头 + 固定行高 + 六列，裁决 #16–#19），
          不是把网格压成一列 —— 压成一列的话「列表」除了更窄没有任何好处。
        -->
        <!--
          不传 empty-text / is-empty：上面那条 v-else-if 已经把「一条都没有」接走了，
          走到这里时表里一定有行。传一句永远显示不出来的空文案，只会让下一个人
          以为表格自己会处理空态。
        -->
        <LibraryListTable v-else-if="viewMode === 'list'" :columns="listColumns">
          <div
            v-for="item in visibleItems"
            :key="item.id"
            class="list-row"
            :class="{ 'is-selected': selectedIds.includes(item.id) }"
            draggable="true"
            @click="onClick(item, $event)"
            @dblclick="!scope.openOnClick && onOpen(item)"
            @dragstart="onDragStart(item)"
          >
            <span class="col-name" :title="item.name">
              <span class="list-cover-dot" :style="item.coverStyle" />
              <span v-if="item.isFavorite" class="fav-star">★</span>
              {{ item.name }}
            </span>
            <span class="col-type">{{ item.subtitle }}</span>
            <span class="col-aux">{{ formatUpdated(item.updatedAt) }}</span>
            <span class="col-stats">{{ item.meta?.join(' · ') }}</span>
            <span class="col-extra">
              <span v-for="tag in item.tags" :key="tag" class="tag">#{{ tag }}</span>
            </span>
            <span class="col-actions">
              <!-- 复用网格卡那个 card-menu 插槽，调用方不用为列表再写一份 -->
              <div v-if="$slots['card-menu']" class="row-menu" @click.stop>
                <button type="button" class="row-menu-trigger">⋯</button>
                <div class="row-menu-dropdown">
                  <slot name="card-menu" :item="item" />
                </div>
              </div>
            </span>
          </div>
        </LibraryListTable>

        <LibraryGrid v-else>
          <LibraryCard
            v-for="item in visibleItems"
            :key="item.id"
            :name="item.name"
            :meta="item.subtitle"
            :stats="item.meta?.join(' · ')"
            :class="{ 'is-selected': selectedIds.includes(item.id) }"
            draggable="true"
            @click="onClick(item, $event)"
            @dblclick="!scope.openOnClick && onOpen(item)"
            @dragstart="onDragStart(item)"
          >
            <!--
              封面内容归各库自己：蓝图放类型图标和录屏，材质放球预览，贴图放缩略图。
              往 BrowserItem 上堆 coverKind / icon / badge 只会越堆越多，
              一个插槽就够了。不给插槽时退回「有图显图，没图显 coverStyle」。
            -->
            <template #cover>
              <slot name="card-cover" :item="item">
                <div class="card-cover" :style="item.coverStyle">
                  <img
                    v-if="item.thumbnail"
                    class="cover-media"
                    :src="item.thumbnail"
                    :alt="item.name"
                    loading="lazy"
                  />
                </div>
              </slot>
            </template>

            <!-- 删除 / 改名 / 换封面这类领域操作归各库自己，浏览器只把条目递出去 -->
            <template v-if="$slots['card-menu']" #menu>
              <slot name="card-menu" :item="item" />
            </template>

            <!-- 脚注也各库不同：蓝图放标签，材质放资产路径 -->
            <template v-if="$slots['card-footnote'] || item.tags.length" #footnote>
              <slot name="card-footnote" :item="item">
                <!-- 类名要和 LibraryCard 里那套 :deep(.card-tags .tag) 对上，否则标签没有胶囊样式 -->
                <div class="card-tags">
                  <span v-for="tag in item.tags" :key="tag" class="tag">#{{ tag }}</span>
                </div>
              </slot>
            </template>
          </LibraryCard>
        </LibraryGrid>
      </div>

      <footer v-if="statusPanels.length" class="browser-statusbar">
        <component
          :is="panel.component"
          v-for="panel in statusPanels"
          :key="`${panel.moduleId}:${panel.id}`"
          :context="browserContext"
        />
      </footer>
    </section>

    <!-- 详情面板是 full 才有的东西：轻量库里你待三秒就走，用不上它 -->
    <aside v-if="$slots.detail && !isLight" class="browser-detail">
      <slot name="detail" :selection="selection" />
    </aside>
  </div>
</template>

<style scoped lang="less">
// 操作岛的外观与页面头部共用，见 styles/islands.less
@import '../styles/islands.less';

.library-browser {
  display: flex;
  // 高度由父级 flex 分配。写 height: 100% 会让浏览器和它上面的标题栏
  // 加起来超过一屏，于是页面外层多出一条滚动条，内容区里还有自己一条。
  flex: 1 1 auto;
  min-height: 0;
  // 不刷自己的底色：页面背景归 App 外壳（裁决 #1）。
  // 刷一层不透明底会把窗口的分层背景盖死。
}

.browser-sidebar {
  display: flex;
  flex: 0 0 auto;
  flex-direction: column;
  // 宽度来自模板上的内联 style（默认 full 240 / light 200，拖过分界线后用拖好的），
  // 写死在这里会一直压住拖宽的结果。
  position: relative;
  border-right: 1px solid var(--color-border-subtle);
}

// 分界线的拖拽热区，骑在侧栏右边框上：7px 宽里正好让 ::after
// 盖住那 1px 边框。平时透明，悬停/拖动时点亮，提示这条线可以拖。
.sidebar-resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  right: -3px;
  width: 7px;
  cursor: col-resize;
  z-index: 5;

  &::after {
    content: '';
    position: absolute;
    top: 0;
    bottom: 0;
    left: 3px;
    width: 1px;
    background: transparent;
    transition: background 0.15s;
  }

  &:hover::after,
  &:active::after {
    background: var(--color-accent-solid);
  }
}

.browser-sidebar-modules {
  margin-top: auto;
  border-top: 1px solid var(--color-border-subtle);
}

.browser-main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
}

.browser-toolbar,
.browser-bulkbar {
  display: flex;
  flex: 0 0 auto;
  flex-wrap: wrap;
  gap: 10px;
  align-items: center;
  padding: 0 var(--space-4) var(--space-3);
}

// 岛屿与岛内控件。内容来自子组件与调用方（各自带着自己的 scope id），
// 只能 :deep() 穿透 —— 和 LibraryGalleryHeader 里的写法一致。
.browser-toolbar :deep(.action-island) {
  .library-island();
}

.browser-toolbar :deep(.divider) {
  .library-island-divider();
}

.browser-toolbar :deep(.icon-btn) {
  .library-island-icon-btn();
}

.browser-toolbar :deep(.btn-primary-create) {
  .library-primary-button();
}

.browser-bulkbar {
  padding-top: var(--space-1);
}

.bulkbar-count {
  padding: 0 4px;
  color: var(--color-text-secondary);
  font-size: var(--font-size-sm);
}

.toolbar-spacer {
  flex: 1 1 auto;
}

.toolbar-button {
  .library-ghost-button();
}

.browser-content {
  flex: 1 1 auto;
  min-height: 0;
  padding: var(--space-4);
  overflow-y: auto;
}

.browser-content :deep(.library-card.is-selected) {
  border-color: var(--color-accent-border);
}

// ===== 列表行 =====
// 行本身的高度、列宽、悬停都在 LibraryListTable 里，这里只补它管不到的：
// 选中态，以及复用 card-menu 插槽的那个行内下拉。
.browser-content :deep(.list-row.is-selected) {
  background: var(--color-accent-bg);
}

// 标签列的胶囊。和网格卡里那份（LibraryCard 的 :deep(.card-tags .tag)）长一样，
// 只是这边是行内排列。
.browser-content :deep(.col-extra) .tag {
  display: inline-block;
  margin-right: 6px;
  padding: 2px 6px;
  border-radius: var(--radius-xs);
  background: var(--color-accent-bg);
  color: var(--color-accent-text);
  font-size: var(--font-size-xs);
}

.row-menu {
  position: relative;
}

.row-menu-dropdown {
  display: none;
  position: absolute;
  top: 24px;
  right: 0;
  min-width: 140px;
  padding: 4px;
  border: 1px solid var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-bg-raised);
  box-shadow: var(--shadow-menu);
  z-index: 10;
}

// 只认 :focus-within 的话必须先点一下才出得来，加上 hover（裁决 #15）
.row-menu:hover .row-menu-dropdown,
.row-menu:focus-within .row-menu-dropdown {
  display: block;
}

// 菜单项由调用方渲染，外观跟网格卡里的那份保持一致
.row-menu-dropdown :deep(.menu-item) {
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  color: var(--color-text-secondary);
  cursor: pointer;
  white-space: nowrap;

  &:hover {
    background: var(--color-bg-raised);
    color: var(--color-text-primary);
  }

  &.danger {
    color: var(--color-danger-text);
  }
}

.browser-statusbar {
  display: flex;
  flex: 0 0 auto;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-2) var(--space-4);
  border-top: 1px solid var(--color-border-subtle);
}

.browser-detail {
  flex: 0 0 auto;
  width: 320px;
  border-left: 1px solid var(--color-border-subtle);
  overflow-y: auto;
}
</style>
