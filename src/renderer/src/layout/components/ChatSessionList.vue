<script setup lang="ts">
import AppDropdown from '@renderer/components/AppDropdown.vue'
import AppMenu from '@renderer/components/AppMenu.vue'
import AppMenuDivider from '@renderer/components/AppMenuDivider.vue'
import AppMenuItem from '@renderer/components/AppMenuItem.vue'
import AppMenuItemGroup from '@renderer/components/AppMenuItemGroup.vue'
import AppMenuSubmenu from '@renderer/components/AppMenuSubmenu.vue'
import AppModal from '@renderer/components/AppModal.vue'
import AppTooltip from '@renderer/components/AppTooltip.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { computed, nextTick, ref, watch } from 'vue'
import { useConnectedProjects } from '@renderer/composables/useBridgeStatus'
import { confirmDialog } from '@renderer/utils/dialog'
import { message } from '@renderer/utils/messageManager'
// 图标统一走 Phosphor：同一套 256 网格、同一笔画宽度，
// 菜单里几个条目的视觉重量才对得齐（Ant Design 的 inbox/folder 是宽扁的，pencil/trash 是高窄的，混在一列里一眼就歪）
import {
  PhArchive,
  PhArrowSquareOut,
  PhCheck,
  // 模板里一直在用它渲染「正在运行」，但从来没导入过 —— 那个转圈其实没渲染出来
  PhCircleNotch,
  PhDotsThree,
  PhFolder,
  PhFolderMinus,
  PhFolderOpen,
  PhPencilSimple,
  PhPlus,
  PhPushPin,
  // 「这条对话在等你回答」。用问号而不是铃铛/感叹号：它不是通知也不是告警，
  // 就是字面意义上有一个问题挂在那儿等人回话
  PhQuestion,
  PhSparkle,
  PhTrash,
  PhUsersThree
} from '@phosphor-icons/vue'
import { useI18n } from 'vue-i18n'
import { useChatSessionsStore, type ChatSession } from '@renderer/store/modules/chatSessions'
import { useChatSidebarStore } from '@renderer/store/modules/chatSidebarStore'
import { useChatMessagesStore } from '@renderer/store/modules/chatMessages'
import { useAgentStreamStore } from '@renderer/store/modules/agentStream'
import { useTabsStore } from '@renderer/store/modules/tabs'
import { deleteChatSessions } from '@renderer/composables/deleteChatSession'
import { detachChatSession, isDraggedOutOf } from '@renderer/composables/detachChatSession'
import { useRouter } from 'vue-router'
import { applySessionClick, pruneSelection } from '../composables/chatSessionSelection'
import { retitleSession } from '@renderer/composables/sessionRetitle'
import {
  SECTION_PINNED_KEY,
  SECTION_PLAIN_KEY,
  SECTION_PROJECTS_KEY,
  collectKnownProjects,
  groupChatSessions,
  sessionActivityState,
  sessionGroupKey,
  sessionInProjectGroup,
  sessionSectionKey,
  type ChatGroupMode,
  type ChatSessionGroup,
  type ChatSortMode,
  type ConnectedProjectRef
} from '../composables/chatSessionGrouping'
import { listConnectedProjects } from '@renderer/views/Assistant/composables/ueProjectContext'
import SidebarSectionHeader from './SidebarSectionHeader.vue'
import AddProjectModal from './AddProjectModal.vue'
import type { SidebarProject } from '@renderer/store/modules/chatSidebarStore'
import { externalTeamChats } from '../composables/externalTeamChats'
import { useExternalTeamChats } from '../composables/useExternalTeamChats'
import { externalTeamStatus } from '@renderer/views/Assistant/composables/externalTeamStatus'

interface Props {
  /** 侧边栏是否处于折叠态 */
  collapsed: boolean
  /** 当前路由正在查看的对话 ID */
  activeChatSid?: string
}

const props = withDefaults(defineProps<Props>(), { activeChatSid: '' })

const emit = defineEmits<{
  (e: 'open', chatSid: string): void
  /**
   * 开新对话；带上工程名时，这条新对话直接归到那个工程下。
   * 同名工程被拆成几组时再带上路径，否则主进程只能按名字挑一个。
   */
  (e: 'new-chat', projectName?: string, projectPath?: string): void
}>()

const { t } = useI18n()
const chatStore = useChatSessionsStore()
const sidebarStore = useChatSidebarStore()
const chatMsgStore = useChatMessagesStore()
const agentStreamStore = useAgentStreamStore()
const tabsStore = useTabsStore()

const LOAD_STEP = 20
const COLLAPSED_LIMIT = 12
/** 「项目」下先显示几个工程，其余折在「显示更多」后面 */
const PROJECT_LIMIT = 5

const showAllProjects = ref(false)

const loadedCount = ref(LOAD_STEP)

function toConnectedRefs(projects: unknown[]): ConnectedProjectRef[] {
  return listConnectedProjects(projects).map((project) => ({
    projectName: project.projectName,
    projectPath: project.projectPath,
    engineVersion: project.engineVersion
  }))
}

/**
 * 订阅 + 首拉都交给 useConnectedProjects。
 *
 * 原来是手写的：首拉不 await 就直接订阅，看着没有泄漏，但 `getProjects()`
 * 回来时会**无条件覆盖** —— 启动过程中连上的编辑器被那份更旧的快照盖掉，
 * 要等下一次连接变化才重新出现。composable 里的 `pushed` 就是挡这个的。
 * 顺带：读失败时原来会写成 `[]`，那是拿一次失败的读断言「什么都没连」。
 */
const connectedProjectsRaw = useConnectedProjects()
const connectedProjects = computed(() => toConnectedRefs(connectedProjectsRaw.value ?? []))

const { teams: externalTeams } = useExternalTeamChats()
const externalById = computed(() => new Map(externalTeams.value.map((team) => [team.id, team])))
const allSessions = computed<ChatSession[]>(() => [
  ...chatStore.displayableSessions,
  ...externalTeamChats(externalTeams.value, [
    ...connectedProjects.value,
    ...manualProjects.value,
    ...chatStore.sessions.flatMap((session) => (session.project ? [session.project] : []))
  ])
])

function externalTooltip(session: ChatSession): string {
  const team = externalById.value.get(session.id)
  if (!team) return session.title
  return [
    session.title,
    t('externalTeams.driven'),
    t(`externalTeams.status.${externalTeamStatus(team).key}`),
    t('externalTeams.members', { n: team.members }),
    team.projectPath
  ]
    .filter(Boolean)
    .join('\n')
}

const manualProjects = computed<ConnectedProjectRef[]>(() => sidebarStore.manualProjects)

const groups = computed<ChatSessionGroup[]>(() =>
  groupChatSessions(allSessions.value, {
    mode: sidebarStore.groupMode as ChatGroupMode,
    sortMode: sidebarStore.sortMode as ChatSortMode,
    connectedProjects: connectedProjects.value,
    manualProjects: manualProjects.value,
    hiddenProjects: sidebarStore.hiddenProjects,
    pinnedProjects: sidebarStore.pinnedProjects
  })
)

const projectGroups = computed<ChatSessionGroup[]>(() =>
  groups.value.filter((group) => group.kind === 'project')
)

/** 工程多了先只露头几个，剩下的点「显示更多」一次全展开 */
const visibleProjectGroups = computed<ChatSessionGroup[]>(() =>
  showAllProjects.value ? projectGroups.value : projectGroups.value.slice(0, PROJECT_LIMIT)
)

const hasMoreProjects = computed<boolean>(
  () => !showAllProjects.value && projectGroups.value.length > PROJECT_LIMIT
)

const plainGroup = computed<ChatSessionGroup | undefined>(() =>
  groups.value.find((group) => group.kind === 'unassigned' || group.kind === 'all')
)

/** 「对话」区不给按钮，滚到底自动续 —— loadedCount 由父级的滚动事件推 */
const plainSessions = computed<ChatSession[]>(() =>
  (plainGroup.value?.sessions || []).slice(0, loadedCount.value)
)

const hasMorePlainSessions = computed<boolean>(
  () => (plainGroup.value?.sessions.length || 0) > plainSessions.value.length
)

/** 折叠态只给一列首字缩写，置顶的排前面 */
const collapsedSessions = computed<ChatSession[]>(() =>
  groups.value.flatMap((group) => group.sessions).slice(0, COLLAPSED_LIMIT)
)

/** 顶层区里要渲染的一行：要么是一个工程小标题，要么是一条对话 */
type SectionEntry =
  | { type: 'group'; key: string; group: ChatSessionGroup }
  | { type: 'session'; key: string; session: ChatSession; indent: boolean }

interface SidebarSection {
  key: string
  label: string
  entries: SectionEntry[]
}

/**
 * 把分组结果摊成三个同级的顶层区：置顶 / 项目 / 对话。
 *
 * 「项目」里再挂一层工程小标题，其余两个区直接铺对话。
 */
const sections = computed<SidebarSection[]>(() => {
  const result: SidebarSection[] = []

  const pinned = groups.value.find((group) => group.kind === 'pinned')
  if (pinned) {
    result.push({
      key: SECTION_PINNED_KEY,
      label: t('chatSidebar.pinned'),
      entries: pinned.sessions.map((session) => ({
        type: 'session',
        key: session.id,
        session,
        indent: false
      }))
    })
  }

  // 「项目」区在按工程整理时固定显示：一个工程都没有时也留着，右上角的「+」才有落点。
  // 「在一个列表中」时所有对话都进了「对话」区，再留个空的「项目」区只会显示「暂无项目」，
  // 看着像工程丢了 —— 直接不出这个区，切回去的入口在「对话」标题的 ⋯ 里。
  if (sidebarStore.groupMode !== 'flat') {
    const projectEntries: SectionEntry[] = []
    for (const group of visibleProjectGroups.value) {
      projectEntries.push({ type: 'group', key: group.key, group })
      if (sidebarStore.isGroupCollapsed(group.key)) continue
      for (const session of group.sessions) {
        projectEntries.push({
          type: 'session',
          key: session.id,
          session,
          indent: true
        })
      }
    }
    result.push({
      key: SECTION_PROJECTS_KEY,
      label: t('chatSidebar.projects'),
      entries: projectEntries
    })
  }

  result.push({
    key: SECTION_PLAIN_KEY,
    label: t('chatSidebar.unassigned'),
    entries: plainSessions.value.map((session) => ({
      type: 'session',
      key: session.id,
      session,
      indent: false
    }))
  })

  // 已归档不在侧边栏露面：入口在「设置 → AI 助手 → 归档的对话」
  return result
})

const knownProjects = computed<ConnectedProjectRef[]>(() =>
  collectKnownProjects(allSessions.value, [
    ...connectedProjects.value,
    ...manualProjects.value
  ]).filter((project) => !sidebarStore.isProjectHidden(project.projectName))
)

const connectedNames = computed<Set<string>>(
  () => new Set(connectedProjects.value.map((project) => project.projectName.trim().toLowerCase()))
)

/**
 * 这条对话此刻是不是在跑。
 *
 * 两种模式各有各的信号：Agent 模式看流式 store，普通 Chat 模式看最后一条
 * 是不是还在打字 —— 没打开过的对话查索引，不为一个小圆点把整段历史读进来。
 */
function isSessionRunning(chatSid: string): boolean {
  return agentStreamStore.isStreaming(chatSid) || chatMsgStore.isLastReplyTyping(chatSid)
}

function activityOf(session: ChatSession): ReturnType<typeof sessionActivityState> {
  return sessionActivityState(
    isSessionRunning(session.id),
    Boolean(session.taskDone),
    agentStreamStore.hasPendingQuestion(session.id)
  )
}

function isProjectConnected(projectName: string): boolean {
  return connectedNames.value.has(projectName.trim().toLowerCase())
}

/**
 * 打开某个对话时，把它所在的分组展开并加载到可见范围。
 *
 * 否则从别处（标签页、Spotlight）跳过来时，高亮那一条可能正藏在
 * 折叠的分组里或「显示更多」后面，看着就像侧边栏没反应。
 */
watch(
  [
    () => props.activeChatSid,
    () => allSessions.value.some((item) => item.id === props.activeChatSid)
  ],
  ([id]) => {
    if (!id || props.collapsed) return

    const session = allSessions.value.find((item) => item.id === id)
    if (!session) return

    chatStore.clearTaskDone(id)

    const mode = sidebarStore.groupMode as ChatGroupMode
    sidebarStore.expandGroup(sessionSectionKey(session, mode))
    // 同名工程按路径拆开后，分组 key 得看整张分组表才知道 —— 先在表里找它
    const owner = groups.value.find((group) => group.sessions.some((item) => item.id === id))
    sidebarStore.expandGroup(owner?.key ?? sessionGroupKey(session, mode))
    if (owner && projectGroups.value.indexOf(owner) >= PROJECT_LIMIT) showAllProjects.value = true

    const position = groups.value
      .flatMap((group) => group.sessions)
      .findIndex((item) => item.id === id)
    if (position >= loadedCount.value) {
      loadedCount.value = Math.ceil((position + 1) / LOAD_STEP) * LOAD_STEP
    }
  },
  { immediate: true }
)

/** 供父级滚动到底时调用：只续「对话」区，不碰工程列表 */
function loadMore(): boolean {
  if (!hasMorePlainSessions.value) return false
  loadedCount.value += LOAD_STEP
  return true
}

defineExpose({ loadMore })

/** 这一组的全部对话（含已归档、含置顶到上面去的）；拆开的同名组只算自己路径下的 */
function projectGroupSessions(group: ChatSessionGroup): ChatSession[] {
  return chatStore
    .sessionsOfProject(group.projectName)
    .filter((session) => sessionInProjectGroup(session, group))
}

function groupTooltip(group: ChatSessionGroup): string {
  const parts = [group.projectName]
  if (group.engineVersion) parts.push(`UE ${group.engineVersion}`)
  if (group.projectPath) parts.push(group.projectPath)
  const count = allSessions.value.filter((session) => sessionInProjectGroup(session, group)).length
  parts.push(t('chatSidebar.projectSessionCount', { count }))
  return parts.join('\n')
}

function isCollapsed(key: string): boolean {
  return sidebarStore.isGroupCollapsed(key)
}

/** 只有「项目」和「对话」两个标题带 ⋯ 和 +，置顶区保持干净 */
function hasHeaderActions(key: string): boolean {
  return key === SECTION_PROJECTS_KEY || key === SECTION_PLAIN_KEY
}

function toggleCollapsed(key: string): void {
  sidebarStore.toggleGroup(key)
}

// ==================== 工程分组：添加 / 置顶 / 改名 / 归档 / 移除 ====================
const addProjectOpen = ref(false)

function openAddProject(): void {
  addProjectOpen.value = true
}

function handleAddProject(project: SidebarProject): void {
  sidebarStore.addManualProject(project)
  sidebarStore.expandGroup(SECTION_PROJECTS_KEY)
  startNewChat(project.projectName)
}

function toggleProjectPinned(group: ChatSessionGroup): void {
  sidebarStore.toggleProjectPinned(group.projectName)
}

/** 在系统文件管理器里打开工程目录；没有路径时这一项不显示 */
async function openProjectInExplorer(group: ChatSessionGroup): Promise<void> {
  if (!group.projectPath) return

  try {
    const result = await window.api.shell.openPath(group.projectPath)
    if (!result?.success) {
      message.error(result?.error || t('chatSidebar.openInExplorerFailed'))
    }
  } catch (error) {
    console.warn('[ChatSessionList] 打开工程目录失败:', error)
    message.error(t('chatSidebar.openInExplorerFailed'))
  }
}

/** 归档这个工程下的所有对话（含没在当前页显示出来的） */
function archiveProjectSessions(group: ChatSessionGroup): void {
  const sessions = projectGroupSessions(group).filter((session) => !session.archived)
  if (sessions.length === 0) return

  confirmDialog({
    title: t('chatSidebar.archiveProjectTitle'),
    content: t('chatSidebar.archiveProjectContent', {
      name: group.projectName,
      count: sessions.length
    }),
    okText: t('chatSidebar.archive'),
    cancelText: t('chatSidebar.cancel'),
    onOk() {
      for (const session of sessions) {
        chatStore.setArchived(session.id, true)
      }
    }
  })
}

/**
 * 把工程从侧边栏拿掉。
 *
 * 里面的对话不删，只是解除归属、落回「对话」区 —— 删对话得走每条对话自己的删除。
 */
function removeProject(group: ChatSessionGroup): void {
  const sessions = projectGroupSessions(group)

  const apply = (): void => {
    for (const session of sessions) {
      chatStore.clearProject(session.id)
    }
    // 同名的另一组还在，按名字隐藏/取消置顶会把它一起带走
    if (group.split) return
    sidebarStore.removeManualProject(group.projectName)
    sidebarStore.hideProject(group.projectName)
    if (sidebarStore.isProjectPinned(group.projectName)) {
      sidebarStore.toggleProjectPinned(group.projectName)
    }
  }

  if (sessions.length === 0) {
    apply()
    return
  }

  confirmDialog({
    title: t('chatSidebar.removeProjectTitle'),
    content: t('chatSidebar.removeProjectContent', {
      name: group.projectName,
      count: sessions.length
    }),
    okText: t('chatSidebar.removeProjectGroup'),
    cancelText: t('chatSidebar.cancel'),
    danger: true,
    onOk: apply
  })
}

// ==================== 工程改名 ====================
const projectRenameOpen = ref(false)
const renamingProjectName = ref('')
const projectRenameInput = ref('')

function openProjectRename(group: ChatSessionGroup): void {
  renamingProjectName.value = group.projectName
  projectRenameInput.value = group.projectName
  projectRenameOpen.value = true
}

function confirmProjectRename(): void {
  const next = projectRenameInput.value.trim()
  const current = renamingProjectName.value
  if (next && current && next !== current) {
    chatStore.renameProject(current, next)
    sidebarStore.renameProject(current, next)
  }
  closeProjectRename()
}

function closeProjectRename(): void {
  projectRenameOpen.value = false
  renamingProjectName.value = ''
  projectRenameInput.value = ''
}

function setGroupMode(mode: ChatGroupMode): void {
  sidebarStore.setGroupMode(mode)
  // 摊平后对话全在「对话」区，它要是折着，看上去就是什么都没了
  if (mode === 'flat') sidebarStore.expandGroup(SECTION_PLAIN_KEY)
}

function setSortMode(mode: ChatSortMode): void {
  sidebarStore.setSortMode(mode)
}

function openChat(id: string): void {
  emit('open', id)
}

// ==================== 拖出去成独立窗口 ====================
// 和标签栏那个是同一件事（见 TabsHeader 的 handleDragEnd）：把一条对话从侧边栏
// 拖到右边内容区或窗口外松手，它就单独开一个窗口。
const router = useRouter()
const listRef = ref<HTMLElement | null>(null)
/** 拖动用的数据类型。不用 text/plain：拖到输入框上松手会把 id 当文字插进去 */
const SESSION_DRAG_MIME = 'application/x-uebox-chat-session'
let draggingChatSid = ''

function handleSessionDragStart(chatSid: string, event: DragEvent): void {
  draggingChatSid = chatSid
  if (!event.dataTransfer) return
  event.dataTransfer.effectAllowed = 'move'
  event.dataTransfer.setData(SESSION_DRAG_MIME, chatSid)
}

function handleSessionDragEnd(event: DragEvent): void {
  const chatSid = draggingChatSid
  draggingChatSid = ''
  const area = listRef.value?.getBoundingClientRect()
  if (!chatSid || !area || !isDraggedOutOf(area, event)) return
  void detachChatSession(router, chatSid, { screenX: event.screenX, screenY: event.screenY })
}

function openInNewWindow(chatSid: string): void {
  void detachChatSession(router, chatSid)
}

function startNewChat(projectName?: string, projectPath?: string): void {
  emit('new-chat', projectName, projectPath || undefined)
}

function togglePinned(id: string): void {
  chatStore.togglePinned(id)
}

function toggleArchived(id: string): void {
  chatStore.toggleArchived(id)
}

// ==================== 多选：Ctrl/Cmd 逐个加，Shift 拉范围 ====================
/**
 * 选择集和锚点只活在这个组件里：纯界面临时状态，不进 store、不落盘。
 *
 * 锚点是最近一次普通 / Ctrl 点击的那条；Shift 点击不移动锚点，
 * 可以连续拉大或缩小范围（契约见 chatSessionSelection.ts）。
 */
const selectedChatSids = ref<string[]>([])
const selectionAnchorId = ref('')
const contextMenuChatSid = ref('')
const contextMenuPoint = ref({ x: 0, y: 0 })

const hasSelection = computed<boolean>(() => selectedChatSids.value.length > 0)

/** 屏幕上实际渲染出来的对话顺序（跨三个区摊平）：Shift 范围就按这条顺序取区间 */
const visibleChatSids = computed<string[]>(() =>
  sections.value.flatMap((section) =>
    section.entries
      .filter((entry) => entry.type === 'session' && !externalById.value.has(entry.key))
      .map((entry) => entry.key)
  )
)

function isSessionSelected(id: string): boolean {
  return selectedChatSids.value.includes(id)
}

/**
 * 对话行上的点击。
 *
 * 没进多选时和以前一个手感：普通点击直接打开；进了多选（选择集非空）后
 * 普通点击只改选择，双击才打开 —— 和资源管理器一致，也避免一次误点
 * 把辛辛苦苦攒的选择全冲掉。
 */
function handleItemClick(session: ChatSession, event: MouseEvent): void {
  const result = applySessionClick(
    selectedChatSids.value,
    selectionAnchorId.value,
    visibleChatSids.value,
    session.id,
    { shiftKey: event.shiftKey, ctrlKey: event.ctrlKey, metaKey: event.metaKey }
  )

  selectedChatSids.value = result.selected
  selectionAnchorId.value = result.anchor
  if (result.open) openChat(session.id)
}

async function openSessionContextMenu(chatSid: string, event: MouseEvent): Promise<void> {
  // 同一行连续右键时也要重新走一次定位，否则菜单会停在上一次的鼠标位置。
  contextMenuChatSid.value = ''
  await nextTick()
  contextMenuPoint.value = { x: event.clientX, y: event.clientY }
  contextMenuChatSid.value = chatSid
}

function syncSessionContextMenuOpen(chatSid: string, open: boolean): void {
  if (!open && contextMenuChatSid.value === chatSid) {
    contextMenuChatSid.value = ''
  }
}

function clearSessionSelection(): void {
  selectedChatSids.value = []
  selectionAnchorId.value = ''
}

/** 对话没了（删除 / 归档 / 搜索过滤）就把选择里的死 id 摘掉，批量栏随之消失；指向它的右键菜单也一并关掉 */
watch(allSessions, (sessions) => {
  const existing = new Set(sessions.map((session) => session.id))
  if (contextMenuChatSid.value && !existing.has(contextMenuChatSid.value)) {
    contextMenuChatSid.value = ''
  }
  if (!hasSelection.value) return

  const next = pruneSelection(selectedChatSids.value, existing)
  if (next.length !== selectedChatSids.value.length) {
    selectedChatSids.value = next
  }
})

// ==================== 批量操作：归入工程 / 归档 / 删除 ====================
const selectedSessions = computed<ChatSession[]>(() =>
  selectedChatSids.value
    .map((id) => chatStore.sessionById(id))
    .filter((session): session is ChatSession => Boolean(session))
)

/** 选中的对话里有没有挂着工程的 —— 决定批量栏「移出工程」要不要出现 */
const selectionHasProject = computed<boolean>(() =>
  selectedSessions.value.some((session) => Boolean(session.project?.projectName))
)

/**
 * 一次行级操作要作用到哪些对话：操作的那条在多选里，就作用于整个选择 ——
 * 和资源管理器一个规矩；不在多选里就只作用于它自己。
 */
function actionTargets(session: ChatSession): string[] {
  return isSessionSelected(session.id) ? [...selectedChatSids.value] : [session.id]
}

/** 一次操作的目标里有没有挂工程的（决定右键菜单「移出工程」要不要出现） */
function targetsHaveProject(session: ChatSession): boolean {
  return actionTargets(session).some((id) =>
    Boolean(chatStore.sessionById(id)?.project?.projectName)
  )
}

function archiveSessions(ids: string[], archived: boolean): void {
  for (const id of ids) {
    chatStore.setArchived(id, archived)
  }
}

/** 批量栏的归档：全部收进归档区，可逆，不弹确认 */
function archiveSelectedSessions(): void {
  archiveSessions([...selectedChatSids.value], true)
}

function assignSessionsToProject(ids: string[], project: ConnectedProjectRef): void {
  for (const id of ids) {
    assignProject(id, project)
  }
}

function clearSessionsProject(ids: string[]): void {
  for (const id of ids) {
    clearProject(id)
  }
}

function assignSelectedToProject(project: ConnectedProjectRef): void {
  assignSessionsToProject([...selectedChatSids.value], project)
}

function clearSelectedProject(): void {
  clearSessionsProject([...selectedChatSids.value])
}

/**
 * 删除对话 —— 把它在**所有**地方的痕迹一起清掉。
 *
 * 只调 `chatStore.removeSession` 的话，消息还留在 localStorage、内核记忆还留在
 * 盘上的 JSONL，用户以为删干净了其实没有。三处一起清的逻辑在 `deleteChatSession`
 * 里；批量删除走同一条链路，内核记忆删失败只报一次，但必须报 —— 用户得知道
 * 盘上还留着东西。
 */
function deleteSessionsByIds(ids: string[]): void {
  const targets = ids
    .map((id) => chatStore.sessionById(id))
    .filter((session): session is ChatSession => Boolean(session))
  if (targets.length === 0) return

  confirmDialog({
    title: targets.length === 1 ? t('chatSidebar.deleteTitle') : t('chatSidebar.batch.deleteTitle'),
    content:
      targets.length === 1
        ? t('chatSidebar.deleteContent', { title: targets[0].title })
        : t('chatSidebar.batch.deleteContent', { count: targets.length }),
    okText: t('chatSidebar.delete'),
    cancelText: t('chatSidebar.cancel'),
    danger: true,
    async onOk() {
      const result = await deleteChatSessions({
        targets: targets.map((session) => ({
          chatSid: session.id,
          agentSessionId: session.agentSessionId
        })),
        deleteTranscript: (agentSessionId) =>
          window.api.agentV3.deleteSession({ sessionId: agentSessionId }),
        // 每个 store 只变更一次 —— 持久化是把整个库序列化进 localStorage，
        // 循环调单条删除的话几百条对话能把主线程卡上一分钟
        dropSessions: (ids) => chatMsgStore.dropSessions(ids),
        removeSessions: (ids) => chatStore.removeSessions(ids),
        listTabs: () => tabsStore.historyTabs.map((tab) => ({ key: tab.key, path: tab.path })),
        closeTab: (key) => tabsStore.removeTab(key)
      })

      if (result.transcriptErrors.length > 0) {
        message.warning(
          t('chatSidebar.deleteTranscriptFailed', { error: result.transcriptErrors[0] })
        )
      }
      clearSessionSelection()
    }
  })
}

function openBatchProjectModal(): void {
  openProjectModal([...selectedChatSids.value])
}

function deleteSelectedSessions(): void {
  deleteSessionsByIds([...selectedChatSids.value])
}

// ==================== 重命名 ====================
const renameModalOpen = ref(false)
const renamingId = ref('')
const renameTitle = ref('')

function openRenameModal(session: ChatSession): void {
  renamingId.value = session.id
  renameTitle.value = session.title
  renameModalOpen.value = true
}

function confirmRename(): void {
  const next = renameTitle.value.trim()
  if (renamingId.value && next) {
    chatStore.updateTitle(renamingId.value, next)
  }
  closeRenameModal()
}

function closeRenameModal(): void {
  renameModalOpen.value = false
  renamingId.value = ''
  renameTitle.value = ''
}

/**
 * 智能命名：**弹窗立刻关掉**，把整段对话的梗概喂给轻量模型，名字回来直接落库。
 *
 * 不让用户对着一个转圈的弹窗干等几秒：这是个一句话就能讲清的动作（「按现在聊的
 * 内容重起个名」），没有需要他确认的中间态。名字不合意，再点一次重命名就是了。
 *
 * 失败什么都不做，原名继续用着 —— 弹窗已经不在了，只能用一条 toast 说明。
 */
async function smartName(): Promise<void> {
  const chatSid = renamingId.value
  if (!chatSid) return

  closeRenameModal()
  const outcome = await retitleSession(
    chatSid,
    chatMsgStore.getMessages(chatSid),
    (title) => chatStore.updateTitle(chatSid, title),
    () => chatStore.sessionById(chatSid)?.title
  )
  if (outcome === 'empty') message.warning(t('chatSidebar.smartNameEmpty'))
  if (outcome === 'failed') message.error(t('chatSidebar.smartNameFailed'))
  // `skipped` 也要说一声，而且和「失败」分开说。开了「自动生成新标题」的话，每轮
  // 收尾都有一次起名在途，撞上了就被这条对话的在途标记挡掉 —— 静默处理的表现是
  // 弹窗关了、名字没变、屏幕上一个字都没有，用户只能再点一次碰运气。
  // 用 info 不用 error：它不是坏了，等一下再点就有
  if (outcome === 'skipped') message.info(t('chatSidebar.smartNameBusy'))
}

// ==================== 归入工程 ====================
// 目标是一组对话 id：单条操作传一个，批量操作传整个选择集，弹窗共用
const projectModalOpen = ref(false)
const projectTargetIds = ref<string[]>([])
const projectNameInput = ref('')

function assignProject(chatSid: string, project: ConnectedProjectRef): void {
  sidebarStore.showProject(project.projectName)
  chatStore.setProject(chatSid, {
    projectName: project.projectName,
    projectPath: project.projectPath,
    engineVersion: project.engineVersion
  })
}

function clearProject(chatSid: string): void {
  chatStore.clearProject(chatSid)
}

function openProjectModal(chatSids: string | string[]): void {
  projectTargetIds.value = Array.isArray(chatSids) ? [...chatSids] : [chatSids]
  projectNameInput.value = ''
  projectModalOpen.value = true
}

function confirmProjectModal(): void {
  const name = projectNameInput.value.trim()
  if (projectTargetIds.value.length && name) {
    for (const chatSid of projectTargetIds.value) {
      assignProject(chatSid, { projectName: name })
    }
  }
  closeProjectModal()
}

function closeProjectModal(): void {
  projectModalOpen.value = false
  projectTargetIds.value = []
  projectNameInput.value = ''
}

// ==================== 删除 ====================
// 单条和批量删除都走 deleteSessionsByIds（见「批量操作」一节）

/**
 * 折叠态用的首字缩写
 */
function getChatInitial(title: string): string {
  const text = title.trim()
  if (!text) return t('chatSidebar.initialFallback')
  const first = text[0]
  return /^[a-zA-Z]$/.test(first) ? first.toUpperCase() : first
}
</script>

<template>
  <!-- Esc 是多选的标准退出键；capture 挂在根上，焦点在列表里任何一行都能收到 -->
  <div
    ref="listRef"
    class="chat-session-list"
    :class="{ collapsed: props.collapsed }"
    @keydown.esc.capture="clearSessionSelection"
  >
    <template v-if="props.collapsed">
      <AppTooltip
        v-for="session in collapsedSessions"
        :key="session.id"
        placement="right"
        :title="
          activityOf(session) === 'waiting'
            ? `${session.title} — ${t('chatSidebar.awaitingAnswer')}`
            : externalTooltip(session)
        "
      >
        <button
          type="button"
          class="chat-collapsed-item"
          :class="{
            active: session.id === props.activeChatSid,
            waiting: activityOf(session) === 'waiting'
          }"
          @click="openChat(session.id)"
        >
          {{ getChatInitial(session.title) }}
        </button>
      </AppTooltip>
    </template>

    <template v-for="section in sections" v-else :key="section.key">
      <SidebarSectionHeader
        :label="section.label"
        :expanded="!isCollapsed(section.key)"
        @toggle="toggleCollapsed(section.key)"
      >
        <!-- 「项目」「对话」两个标题带操作：⋯ 是整理/排序，+ 分别是加工程和开新对话 -->
        <template v-if="hasHeaderActions(section.key)" #actions>
          <AppDropdown :trigger="['click']" placement="bottomRight">
            <AppButton
              variant="text"
              size="small"
              class="chat-icon-btn"
              :aria-label="t('chatSidebar.organize')"
              @click.stop
            >
              <template #icon>
                <PhDotsThree />
              </template>
            </AppButton>
            <template #overlay>
              <AppMenu>
                <AppMenuItemGroup :title="t('chatSidebar.organize')">
                  <AppMenuItem
                    key="group-project"
                    item-key="group-project"
                    @click="setGroupMode('project')"
                  >
                    <span class="chat-session-context-menu-entry">
                      <PhCheck v-if="sidebarStore.groupMode === 'project'" />
                      <span v-else class="chat-session-context-menu-slot" />
                      <span class="chat-session-context-menu-label">
                        {{ t('chatSidebar.groupByProject') }}
                      </span>
                    </span>
                  </AppMenuItem>
                  <AppMenuItem key="group-flat" item-key="group-flat" @click="setGroupMode('flat')">
                    <span class="chat-session-context-menu-entry">
                      <PhCheck v-if="sidebarStore.groupMode === 'flat'" />
                      <span v-else class="chat-session-context-menu-slot" />
                      <span class="chat-session-context-menu-label">
                        {{ t('chatSidebar.groupFlat') }}
                      </span>
                    </span>
                  </AppMenuItem>
                </AppMenuItemGroup>
                <AppMenuDivider />
                <AppMenuItemGroup :title="t('chatSidebar.sortBy')">
                  <AppMenuItem
                    key="sort-recent"
                    item-key="sort-recent"
                    @click="setSortMode('recent')"
                  >
                    <span class="chat-session-context-menu-entry">
                      <PhCheck v-if="sidebarStore.sortMode === 'recent'" />
                      <span v-else class="chat-session-context-menu-slot" />
                      <span class="chat-session-context-menu-label">
                        {{ t('chatSidebar.sortRecent') }}
                      </span>
                    </span>
                  </AppMenuItem>
                  <AppMenuItem
                    key="sort-created"
                    item-key="sort-created"
                    @click="setSortMode('created')"
                  >
                    <span class="chat-session-context-menu-entry">
                      <PhCheck v-if="sidebarStore.sortMode === 'created'" />
                      <span v-else class="chat-session-context-menu-slot" />
                      <span class="chat-session-context-menu-label">
                        {{ t('chatSidebar.sortCreated') }}
                      </span>
                    </span>
                  </AppMenuItem>
                  <AppMenuItem key="sort-name" item-key="sort-name" @click="setSortMode('name')">
                    <span class="chat-session-context-menu-entry">
                      <PhCheck v-if="sidebarStore.sortMode === 'name'" />
                      <span v-else class="chat-session-context-menu-slot" />
                      <span class="chat-session-context-menu-label">
                        {{ t('chatSidebar.sortName') }}
                      </span>
                    </span>
                  </AppMenuItem>
                </AppMenuItemGroup>
              </AppMenu>
            </template>
          </AppDropdown>

          <AppButton
            variant="text"
            size="small"
            class="chat-icon-btn"
            :aria-label="
              section.key === SECTION_PROJECTS_KEY
                ? t('chatSidebar.addProject.title')
                : t('chatSidebar.newChat')
            "
            @click.stop="section.key === SECTION_PROJECTS_KEY ? openAddProject() : startNewChat()"
          >
            <template #icon>
              <PhPlus />
            </template>
          </AppButton>
        </template>
      </SidebarSectionHeader>

      <template v-if="!isCollapsed(section.key)">
        <template v-for="entry in section.entries" :key="entry.key">
          <!-- 「项目」区里的一个 UE 工程 -->
          <div v-if="entry.type === 'group'" class="chat-group-row">
            <AppTooltip placement="right" :title="groupTooltip(entry.group)" :offset="60">
              <button
                type="button"
                class="chat-group-header"
                :aria-expanded="!isCollapsed(entry.group.key)"
                @click="toggleCollapsed(entry.group.key)"
              >
                <!-- 展开/收起看文件夹开没开；连着编辑器的工程把图标染成 UE 蓝 -->
                <PhFolderOpen
                  v-if="!isCollapsed(entry.group.key)"
                  :class="['chat-group-icon', { connected: entry.group.connected }]"
                />
                <PhFolder
                  v-else
                  :class="['chat-group-icon', { connected: entry.group.connected }]"
                />
                <span class="chat-group-title">{{ entry.group.projectName }}</span>
                <PhPushPin v-if="entry.group.pinned" weight="fill" class="chat-group-pin" />
              </button>
            </AppTooltip>

            <span class="chat-group-actions">
              <AppDropdown :trigger="['click']" placement="bottomRight">
                <AppButton
                  variant="text"
                  size="small"
                  class="chat-icon-btn"
                  :aria-label="t('chatSidebar.more')"
                  @click.stop
                >
                  <template #icon>
                    <PhDotsThree />
                  </template>
                </AppButton>
                <template #overlay>
                  <AppMenu>
                    <AppMenuItem
                      :key="`project-pin-${entry.group.key}`"
                      :item-key="`project-pin-${entry.group.key}`"
                      @click="toggleProjectPinned(entry.group)"
                    >
                      <span class="chat-session-context-menu-entry">
                        <PhPushPin />
                        <span class="chat-session-context-menu-label">
                          {{ entry.group.pinned ? t('chatSidebar.unpin') : t('chatSidebar.pin') }}
                        </span>
                      </span>
                    </AppMenuItem>
                    <!-- 改名是按名字改整批对话的戳，拆开的同名组改不准，不给 -->
                    <AppMenuItem
                      v-if="
                        !entry.group.split &&
                        (projectGroupSessions(entry.group).length > 0 ||
                          sidebarStore.isManualProject(entry.group.projectName))
                      "
                      :key="`project-rename-${entry.group.key}`"
                      :item-key="`project-rename-${entry.group.key}`"
                      @click="openProjectRename(entry.group)"
                    >
                      <span class="chat-session-context-menu-entry">
                        <PhPencilSimple />
                        <span class="chat-session-context-menu-label">
                          {{ t('chatSidebar.rename') }}
                        </span>
                      </span>
                    </AppMenuItem>
                    <template v-if="entry.group.projectPath">
                      <AppMenuDivider />
                      <AppMenuItem
                        :key="`project-explorer-${entry.group.key}`"
                        :item-key="`project-explorer-${entry.group.key}`"
                        @click="openProjectInExplorer(entry.group)"
                      >
                        <span class="chat-session-context-menu-entry">
                          <PhFolderOpen />
                          <span class="chat-session-context-menu-label">
                            {{ t('chatSidebar.openInExplorer') }}
                          </span>
                        </span>
                      </AppMenuItem>
                    </template>
                    <template v-if="projectGroupSessions(entry.group).length > 0">
                      <AppMenuDivider />
                      <AppMenuItem
                        :key="`project-archive-${entry.group.key}`"
                        :item-key="`project-archive-${entry.group.key}`"
                        @click="archiveProjectSessions(entry.group)"
                      >
                        <span class="chat-session-context-menu-entry">
                          <PhArchive />
                          <span class="chat-session-context-menu-label">
                            {{ t('chatSidebar.archiveProjectChats') }}
                          </span>
                        </span>
                      </AppMenuItem>
                    </template>
                    <AppMenuDivider />
                    <AppMenuItem
                      v-if="
                        !entry.group.split ||
                        !entry.group.sessions.some((session) => externalById.has(session.id))
                      "
                      :key="`project-remove-${entry.group.key}`"
                      :item-key="`project-remove-${entry.group.key}`"
                      danger
                      @click="removeProject(entry.group)"
                    >
                      <span class="chat-session-context-menu-entry">
                        <PhFolderMinus />
                        <span class="chat-session-context-menu-label">
                          {{ t('chatSidebar.removeProjectGroup') }}
                        </span>
                      </span>
                    </AppMenuItem>
                  </AppMenu>
                </template>
              </AppDropdown>

              <AppButton
                variant="text"
                size="small"
                class="chat-icon-btn"
                :aria-label="t('chatSidebar.newChatInProject')"
                @click.stop="
                  startNewChat(
                    entry.group.projectName,
                    entry.group.split ? entry.group.projectPath : undefined
                  )
                "
              >
                <template #icon>
                  <PhPlus />
                </template>
              </AppButton>
            </span>
          </div>

          <!-- 外部驱动的对话使用同一列表与路由，管理动作仍由团队任务板提供。 -->
          <button
            v-else-if="externalById.has(entry.session.id)"
            type="button"
            class="chat-item chat-item-external"
            :class="{ active: entry.session.id === props.activeChatSid, indent: entry.indent }"
            :title="externalTooltip(entry.session)"
            :aria-current="entry.session.id === props.activeChatSid ? 'true' : undefined"
            @click="openChat(entry.session.id)"
          >
            <span class="chat-item-title">{{ entry.session.title }}</span>
            <PhUsersThree class="chat-item-external-icon" :aria-label="t('externalTeams.driven')" />
          </button>

          <!-- 一条对话：行尾是置顶和归档，其余操作走右键；
               Ctrl/Cmd+点击逐个多选、Shift+点击拉范围，双击在多选中打开 -->
          <AppDropdown
            v-else
            :trigger="[]"
            :open="contextMenuChatSid === entry.session.id"
            :anchor-point="contextMenuPoint"
            placement="rightStart"
            @update:open="syncSessionContextMenuOpen(entry.session.id, $event)"
          >
            <div
              class="chat-item"
              :class="{
                active: entry.session.id === props.activeChatSid,
                selected: isSessionSelected(entry.session.id),
                indent: entry.indent
              }"
              :title="entry.session.title"
              role="button"
              tabindex="0"
              draggable="true"
              @dragstart="handleSessionDragStart(entry.session.id, $event)"
              @dragend="handleSessionDragEnd"
              @click="handleItemClick(entry.session, $event)"
              @dblclick="openChat(entry.session.id)"
              @contextmenu.stop.prevent="openSessionContextMenu(entry.session.id, $event)"
              @keydown.enter.prevent="openChat(entry.session.id)"
              @keydown.space.prevent="openChat(entry.session.id)"
            >
              <PhQuestion
                v-if="activityOf(entry.session) === 'waiting'"
                weight="bold"
                class="chat-item-waiting"
                :title="t('chatSidebar.awaitingAnswer')"
              />
              <PhCircleNotch
                v-else-if="activityOf(entry.session) === 'running'"
                class="chat-item-running icon-spin"
                :title="t('chatSidebar.running')"
              />
              <span
                v-else-if="activityOf(entry.session) === 'done'"
                class="chat-item-dot"
                :title="t('chatSidebar.taskDone')"
              />
              <span class="chat-item-title">{{ entry.session.title }}</span>
              <span class="chat-item-actions">
                <AppButton
                  variant="text"
                  size="small"
                  class="chat-icon-btn"
                  :title="entry.session.pinned ? t('chatSidebar.unpin') : t('chatSidebar.pin')"
                  :aria-label="entry.session.pinned ? t('chatSidebar.unpin') : t('chatSidebar.pin')"
                  @click.stop="togglePinned(entry.session.id)"
                >
                  <template #icon>
                    <PhPushPin v-if="entry.session.pinned" weight="fill" />
                    <PhPushPin v-else />
                  </template>
                </AppButton>
                <AppButton
                  variant="text"
                  size="small"
                  class="chat-icon-btn"
                  :title="
                    entry.session.archived ? t('chatSidebar.unarchive') : t('chatSidebar.archive')
                  "
                  :aria-label="
                    entry.session.archived ? t('chatSidebar.unarchive') : t('chatSidebar.archive')
                  "
                  @click.stop="toggleArchived(entry.session.id)"
                >
                  <template #icon>
                    <PhArchive />
                  </template>
                </AppButton>
              </span>
            </div>

            <template #overlay>
              <AppMenu>
                <AppMenuItem
                  :key="`window-${entry.session.id}`"
                  :item-key="`window-${entry.session.id}`"
                  @click="openInNewWindow(entry.session.id)"
                >
                  <span class="chat-session-context-menu-entry">
                    <PhArrowSquareOut />
                    <span class="chat-session-context-menu-label">
                      {{ t('tabs.openInNewWindow') }}
                    </span>
                  </span>
                </AppMenuItem>
                <AppMenuItem
                  :key="`rename-${entry.session.id}`"
                  :item-key="`rename-${entry.session.id}`"
                  @click="openRenameModal(entry.session)"
                >
                  <span class="chat-session-context-menu-entry">
                    <PhPencilSimple />
                    <span class="chat-session-context-menu-label">
                      {{ t('chatSidebar.rename') }}
                    </span>
                  </span>
                </AppMenuItem>
                <!-- 目标在多选里就作用于整个选区，和资源管理器一个规矩 -->
                <AppMenuItem
                  :key="`archive-${entry.session.id}`"
                  :item-key="`archive-${entry.session.id}`"
                  @click="archiveSessions(actionTargets(entry.session), !entry.session.archived)"
                >
                  <span class="chat-session-context-menu-entry">
                    <PhArchive />
                    <span class="chat-session-context-menu-label">
                      {{
                        entry.session.archived
                          ? t('chatSidebar.unarchive')
                          : t('chatSidebar.archive')
                      }}
                    </span>
                  </span>
                </AppMenuItem>
                <AppMenuSubmenu>
                  <template #title>
                    <span class="chat-session-context-menu-entry">
                      <PhFolder />
                      <span class="chat-session-context-menu-label">
                        {{ t('chatSidebar.moveToProject') }}
                      </span>
                    </span>
                  </template>
                  <AppMenuItem
                    v-for="project in knownProjects"
                    :key="`move-${entry.session.id}-${project.projectName}`"
                    :item-key="`move-${entry.session.id}-${project.projectName}`"
                    @click="assignSessionsToProject(actionTargets(entry.session), project)"
                  >
                    {{ project.projectName }}
                    <span v-if="isProjectConnected(project.projectName)">
                      · {{ t('chatSidebar.connected') }}
                    </span>
                  </AppMenuItem>
                  <AppMenuDivider v-if="knownProjects.length" />
                  <AppMenuItem
                    :key="`move-${entry.session.id}-new`"
                    :item-key="`move-${entry.session.id}-new`"
                    @click="openProjectModal(actionTargets(entry.session))"
                  >
                    {{ t('chatSidebar.newProjectGroup') }}
                  </AppMenuItem>
                  <AppMenuItem
                    v-if="targetsHaveProject(entry.session)"
                    :key="`move-${entry.session.id}-none`"
                    :item-key="`move-${entry.session.id}-none`"
                    @click="clearSessionsProject(actionTargets(entry.session))"
                  >
                    {{ t('chatSidebar.removeFromProject') }}
                  </AppMenuItem>
                </AppMenuSubmenu>
                <AppMenuDivider />
                <AppMenuItem
                  :key="`delete-${entry.session.id}`"
                  :item-key="`delete-${entry.session.id}`"
                  danger
                  @click="deleteSessionsByIds(actionTargets(entry.session))"
                >
                  <span class="chat-session-context-menu-entry">
                    <PhTrash />
                    <span class="chat-session-context-menu-label">
                      {{ t('chatSidebar.delete') }}
                    </span>
                  </span>
                </AppMenuItem>
              </AppMenu>
            </template>
          </AppDropdown>
        </template>

        <div v-if="section.entries.length === 0" class="chat-group-empty">
          {{
            section.key === SECTION_PROJECTS_KEY
              ? t('chatSidebar.noProjects')
              : t('chatSidebar.empty')
          }}
        </div>

        <!-- 只有工程列表需要手动展开；「对话」滚到底自动续 -->
        <button
          v-if="section.key === SECTION_PROJECTS_KEY && hasMoreProjects"
          type="button"
          class="chat-load-more"
          @click="showAllProjects = true"
        >
          {{ t('chatSidebar.loadMore') }}
        </button>
      </template>
    </template>

    <!-- 多选批量栏：浮在列表底部，归入工程 / 归档 / 删除 / 取消 -->
    <div v-if="!props.collapsed && hasSelection" class="chat-batch-bar">
      <span class="chat-batch-actions">
        <AppDropdown :trigger="['click']" placement="topRight">
          <AppButton
            variant="text"
            size="small"
            class="chat-icon-btn"
            :title="t('chatSidebar.moveToProject')"
            :aria-label="t('chatSidebar.moveToProject')"
          >
            <template #icon>
              <PhFolder />
            </template>
          </AppButton>
          <template #overlay>
            <AppMenu>
              <AppMenuItem
                v-for="project in knownProjects"
                :key="`batch-move-${project.projectName}`"
                :item-key="`batch-move-${project.projectName}`"
                @click="assignSelectedToProject(project)"
              >
                {{ project.projectName }}
                <span v-if="isProjectConnected(project.projectName)">
                  · {{ t('chatSidebar.connected') }}
                </span>
              </AppMenuItem>
              <AppMenuDivider v-if="knownProjects.length" />
              <AppMenuItem
                key="batch-move-new"
                item-key="batch-move-new"
                @click="openBatchProjectModal"
              >
                {{ t('chatSidebar.newProjectGroup') }}
              </AppMenuItem>
              <AppMenuItem
                v-if="selectionHasProject"
                key="batch-move-none"
                item-key="batch-move-none"
                @click="clearSelectedProject"
              >
                {{ t('chatSidebar.removeFromProject') }}
              </AppMenuItem>
            </AppMenu>
          </template>
        </AppDropdown>

        <AppButton
          variant="text"
          size="small"
          class="chat-icon-btn"
          :title="t('chatSidebar.archive')"
          :aria-label="t('chatSidebar.archive')"
          @click="archiveSelectedSessions"
        >
          <template #icon>
            <PhArchive />
          </template>
        </AppButton>
        <AppButton
          variant="text"
          size="small"
          class="chat-icon-btn chat-batch-danger"
          :title="t('chatSidebar.delete')"
          :aria-label="t('chatSidebar.delete')"
          @click="deleteSelectedSessions"
        >
          <template #icon>
            <PhTrash />
          </template>
        </AppButton>
        <AppButton
          variant="text"
          size="small"
          class="chat-icon-btn"
          :title="t('chatSidebar.batch.clearSelection')"
          :aria-label="t('chatSidebar.batch.clearSelection')"
          @click="clearSessionSelection"
        >
          <template #icon>
            <PhFolderMinus />
          </template>
        </AppButton>
      </span>
    </div>

    <AppModal
      v-model:open="renameModalOpen"
      :title="t('chatSidebar.renameTitle')"
      @ok="confirmRename"
      @cancel="closeRenameModal"
    >
      <a-input
        v-model:value="renameTitle"
        :placeholder="t('chatSidebar.renamePlaceholder')"
        @press-enter="confirmRename"
      />
      <template #footer>
        <!-- 智能命名靠左：它是个可选的辅助动作，位置和右边「取消/确认」分两组，
             但长相跟「取消」一样带边框 —— 同一排按钮里混一个无框的，看着像没做完 -->
        <AppButton class="rename-modal__smart" @click="smartName">
          <template #icon>
            <PhSparkle />
          </template>
          {{ t('chatSidebar.smartName') }}
        </AppButton>
        <AppButton @click="closeRenameModal">{{ t('chatSidebar.cancel') }}</AppButton>
        <AppButton variant="primary" :disabled="!renameTitle.trim()" @click="confirmRename">
          {{ t('common.confirm') }}
        </AppButton>
      </template>
    </AppModal>

    <AppModal
      v-model:open="projectModalOpen"
      :title="t('chatSidebar.newProjectGroup')"
      @ok="confirmProjectModal"
      @cancel="closeProjectModal"
    >
      <a-input
        v-model:value="projectNameInput"
        :placeholder="t('chatSidebar.projectNamePlaceholder')"
        @press-enter="confirmProjectModal"
      />
    </AppModal>

    <AppModal
      v-model:open="projectRenameOpen"
      :title="t('chatSidebar.renameProjectTitle')"
      @ok="confirmProjectRename"
      @cancel="closeProjectRename"
    >
      <a-input
        v-model:value="projectRenameInput"
        :placeholder="t('chatSidebar.projectNamePlaceholder')"
        @press-enter="confirmProjectRename"
      />
    </AppModal>

    <AddProjectModal v-model:open="addProjectOpen" @confirm="handleAddProject" />
  </div>
</template>

<style scoped lang="less">
/**
 * 对话行的度量全部取自 SideMenu 上定义的 --sidebar-* 变量，
 * 和上面的工具菜单是同一套行高、圆角、缩进和交互底色。
 */
.chat-session-list {
  padding: 0 var(--space-2) var(--space-3);
}

.chat-session-list.collapsed {
  padding: 0;
}

// Phosphor 是裸 <svg>，没有 antd 那层图标包装的行高归一，
// 不改成块级的话按钮里会多出一条基线间隙，图标看着偏上
.chat-icon-btn :deep(svg) {
  display: block;
}

.chat-icon-btn {
  border: none !important;
  background: transparent !important;
  color: var(--sidebar-text-muted) !important;
  display: inline-flex;
  align-items: center;
  justify-content: center;

  &:hover {
    color: var(--sidebar-text-strong) !important;
    background: var(--sidebar-hover-bg) !important;
  }
}

.chat-group-row {
  display: flex;
  align-items: center;
  // 行尾按钮和分区标题、对话行的按钮对齐在同一条竖线上
  padding-right: var(--space-1);
}

// 工程行尾按钮隐藏时收回占位，悬停或键盘聚焦时再给按钮让出空间
.chat-group-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
  width: 0;
  overflow: hidden;
  opacity: 0;
  transition: opacity 0.2s ease;
}

// :has(:focus-visible) 而不是 :focus-within：点击展开/折叠后按钮会保持焦点，
// 用 :focus-within 会让行尾图标常驻不消失；只有键盘聚焦才需要常驻
.chat-group-row:hover .chat-group-actions,
.chat-group-row:has(:focus-visible) .chat-group-actions {
  width: auto;
  overflow: visible;
  opacity: 1;
}

.chat-group-header {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--sidebar-row-gap);
  height: var(--sidebar-row-height);
  padding: 0 var(--sidebar-row-padding);
  border: none;
  border-radius: var(--sidebar-row-radius);
  background: transparent;
  // 工程是父级：比对话大半档、字重更重
  font-size: var(--sidebar-label-size);
  font-weight: var(--font-weight-medium);
  font-family: inherit;
  color: var(--sidebar-text);
  cursor: pointer;
  user-select: none;
  transition:
    background-color 0.2s ease,
    color 0.2s ease;

  &:hover {
    background: var(--sidebar-hover-bg);
    color: var(--sidebar-text);
  }

  &:focus-visible {
    outline: 2px solid var(--sidebar-focus-ring);
    outline-offset: -2px;
  }
}

.chat-group-icon {
  display: block;
  flex: none;
  font-size: var(--sidebar-icon-size);
  width: var(--sidebar-icon-size);
  height: var(--sidebar-icon-size);
}

// UE 蓝：连着编辑器的工程一眼能挑出来
.chat-group-icon.connected {
  color: var(--color-accent-text);
}

.chat-group-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  text-align: left;
}

.chat-group-pin {
  display: block;
  font-size: 10px;
  width: 10px;
  height: 10px;
  color: var(--color-text-muted);
  flex: none;
}

.chat-group-empty {
  padding: var(--space-1) var(--sidebar-row-padding);
  font-size: var(--font-size-xs);
  color: var(--sidebar-text-disabled);
}

.chat-item {
  display: flex;
  align-items: center;
  gap: var(--space-1);
  height: var(--sidebar-row-height);
  padding: 0 var(--space-1) 0 var(--space-4);
  border-radius: var(--sidebar-row-radius);
  color: var(--sidebar-text);
  font-size: var(--sidebar-item-size);
  font-weight: 350;
  cursor: pointer;
  transition:
    background-color 0.2s ease,
    color 0.2s ease;

  &:hover {
    background: var(--sidebar-hover-bg);
    color: var(--sidebar-text-strong);
  }

  &:focus-visible {
    outline: 2px solid var(--sidebar-focus-ring);
    outline-offset: -2px;
  }

  &.active {
    background: var(--sidebar-active-bg);
    color: var(--sidebar-text-strong);
  }

  // 「项目」区里的对话缩进到工程名的起点：行内边距 + 文件夹图标 + 图标与文字的间距，
  // 这样标题和上面的工程名是一条竖线，读起来就是「这个工程下面的对话」
  &.indent {
    padding-left: calc(
      var(--sidebar-row-padding) + var(--sidebar-icon-size) + var(--sidebar-row-gap)
    );
  }

  // 多选中的行：一层品牌色薄雾，和「当前打开」的渐变底区分开 —— 一个是位置，一个是待操作
  &.selected {
    background: var(--color-bg-selected);

    &:hover {
      background: var(--color-bg-selected-hover);
    }
  }
}

// 「等你回答」压过转圈和蓝点（见 sessionActivityState）。
// 它是这三个里唯一**要人动手**的状态，所以给足对比度并轻轻呼吸一下 ——
// 其余两个都是「你看看就行」，安安静静待着才对。
.chat-item-external {
  width: 100%;
  border: 0;
  background: transparent;
  font-family: inherit;
  text-align: left;
}

.chat-item-external-icon {
  flex: none;
  color: var(--color-text-muted);
}

.chat-item-waiting {
  flex: none;
  font-size: 12px;
  color: var(--color-warning-text);
  animation: chat-item-waiting-pulse 1.8s ease-in-out infinite;
}

@keyframes chat-item-waiting-pulse {
  0%,
  100% {
    opacity: 1;
  }
  50% {
    opacity: 0.45;
  }
}

// 用户把动效关了就只留颜色 —— 呼吸只是加强，不是这个状态的唯一载体
@media (prefers-reduced-motion: reduce) {
  .chat-item-waiting {
    animation: none;
  }
}

// 正在跑的对话转个圈，和「跑完了」的蓝点占同一个位置
.chat-item-running {
  flex: none;
  font-size: 10px;
  color: var(--color-accent-text);
}

// 后台任务跑完还没看的对话，标题前面点一个蓝点
.chat-item-dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--color-accent-solid);
}

.chat-item-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

// 行尾的两个图标默认连布局空间也不占；悬停或键盘聚焦时，标题再把位置让出来
.chat-item-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
  width: 0;
  margin-left: calc(0px - var(--space-1));
  overflow: hidden;
  opacity: 0;
  transition: opacity 0.2s ease;
}

.chat-item:hover .chat-item-actions,
.chat-item:focus-within .chat-item-actions {
  width: auto;
  margin-left: 0;
  overflow: visible;
  opacity: 1;
}

// 多选批量栏：吸附在滚动区底部。玻璃拟态的变量和主题走，深浅色都不会突兀
.chat-batch-bar {
  position: sticky;
  bottom: var(--space-2);
  z-index: 2;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: var(--space-2) var(--space-1) 0;
  padding: var(--space-1) var(--space-2);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-raised);
  backdrop-filter: blur(var(--blur-xl));
  box-shadow: var(--shadow-glass);
}

.chat-batch-actions {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  flex: none;
}

// 批量删除按危险色示意，悬停再加重
.chat-batch-danger {
  color: var(--color-danger-text) !important;

  &:hover {
    color: var(--color-danger-text) !important;
  }
}

// 下拉层会挂到 body，但插槽内容仍带有本组件的作用域标记。
// 每项固定一格图标槽，消除不同 SVG 的固有视口与默认外边距带来的错位。
.chat-session-context-menu-entry {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
  vertical-align: middle;
}

// 18 而不是 16：Phosphor 的墨迹只占框的 0.82，antd 占到 0.96，
// 照搬 16px 会比原来轻掉一截（全局那笔补偿在 main.ts，但这里写死了 px，够不着）
.chat-session-context-menu-entry :deep(svg) {
  display: block;
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
  margin-inline-end: 0;
  font-size: 18px;
}

// 没勾上的排序项也要占住同一格，勾选来回切时文字不跳
.chat-session-context-menu-slot {
  flex: 0 0 18px;
  width: 18px;
  height: 18px;
}

.chat-session-context-menu-label {
  line-height: 1;
}

.chat-load-more {
  width: 100%;
  padding: var(--space-2) var(--sidebar-row-padding);
  font-size: var(--font-size-sm);
  color: var(--sidebar-text-muted);
  text-align: center;
}

.chat-load-more {
  border: none;
  border-radius: var(--sidebar-row-radius);
  background: transparent;
  font-family: inherit;
  cursor: pointer;

  &:hover {
    background: var(--sidebar-hover-bg);
    color: var(--sidebar-text-strong);
  }

  &:focus-visible {
    outline: 2px solid var(--sidebar-focus-ring);
    outline-offset: -2px;
  }
}

// 折叠态：和工具图标同宽同高，共用一根中轴
.chat-collapsed-item {
  position: relative;
  width: var(--sidebar-row-height);
  height: var(--sidebar-row-height);
  margin: var(--space-1) auto;
  border: none;
  border-radius: var(--sidebar-row-radius);
  background: transparent;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: var(--font-size-sm);
  font-family: inherit;
  font-weight: var(--font-weight-semibold);
  color: var(--sidebar-text);
  cursor: pointer;

  &:hover {
    background: var(--sidebar-hover-bg);
    color: var(--sidebar-text-strong);
  }

  &:focus-visible {
    outline: 2px solid var(--sidebar-focus-ring);
    outline-offset: -2px;
  }

  &.active {
    background: var(--sidebar-active-bg);
    color: var(--sidebar-text-strong);
  }

  // 收起来的侧边栏只剩一个首字，没地方摆图标 —— 角上点一颗，
  // 而这恰恰是最容易漏掉提问的场景（时间线整个看不见）
  &.waiting::after {
    content: '';
    position: absolute;
    top: 4px;
    right: 4px;
    width: 6px;
    height: 6px;
    border-radius: var(--radius-full);
    background: var(--color-warning-text);
  }
}

// 智能命名靠左推开，和右边主按钮分两组
.rename-modal__smart {
  margin-right: auto;
}
</style>
