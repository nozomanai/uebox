import type {
  BrowserGroupState,
  BrowserCommand,
  BrowserTabCommand,
  BrowserNavigationState,
  BrowserToolbarAction
} from '../shared/agentBrowser'
import { contextBridge, ipcRenderer, webUtils } from 'electron'
import {
  NOTIFICATION_ACTIVATE_CHANNEL,
  NOTIFICATION_ACTIVATION_RESULT_CHANNEL,
  NOTIFICATION_TAKE_PENDING_CHANNEL,
  type NotificationActivatePayload,
  type NotificationActivationResult
} from '../shared/agentNotificationActivation'
import {
  TRAY_ACTION_CHANNEL,
  TRAY_CONFIRM_QUIT_CHANNEL,
  TRAY_SET_RECENT_SESSIONS_CHANNEL,
  TRAY_TAKE_PENDING_CHANNEL,
  type TrayAction,
  type TrayRecentSession
} from '../shared/trayActions'
import type { AgentTurnUsage } from '../shared/agentUsage'
import type { AgentReviewTarget } from '../shared/agentReview'
import type { SideQuestionContext } from '../shared/sideQuestion'
import type { ChatSyncPatch } from '../shared/chatWindowSync'
import type { EditorSnapshot, MiniChatInitialMessage } from '../shared/editorSnapshot'
import type { SpotlightAction, SpotlightSearchResponse } from '../shared/spotlight'
import type { NotebookContextLevel } from '../shared/notebookContext'
import type { RealtimeEchoGuard } from '../shared/realtimeEchoGuard'
/**
 * 命名规则保存的载荷。**只取类型**（`import type` 在编译期就被整条擦掉，
 * 预加载包里不会出现主进程代码），这样桥这一侧和主进程的 handler 说的是同一个形状。
 *
 * `index.d.ts` 里另有一份同形的全局声明给渲染侧 —— tsc 会忽略和 `index.ts`
 * 同名的 `.d.ts`，所以那一份在这里取不到，只能各写一次。
 */
import type { NamingRulesSavePayload } from '../main/utils/namingRulesConfig'

/**
 * `ws:status` / `ws:status-changed` 送过来的那个对象。
 *
 * 和渲染层的全局 `BridgeStatus` 同形，但 preload 看不到那份全局声明，
 * 所以在这边单独写一份。改动时两边要一起改。
 */
interface BridgeStatusPayload {
  state: string
  port: number
  startedAt?: number
  startError?: string
}

type RendererListener = (event: unknown, ...args: any[]) => void

/** 一条经验在哪：哪一层、哪个工程、哪个工具文件、哪一条。主进程会再校验一遍 */
interface ExperienceRefArg {
  layer: 'global' | 'project'
  projectPath?: string
  tool: string
  id: string
}

const RAW_REQUEST_CHANNELS = new Set(
  `agent-v3:approval-reply agent-v3:question-reply agent-v3:mcp:get-settings
aigc:importLocalModel aigc:save3DModelFromUrls aigc:update3DModelFolderName app:show-input-context-menu asset:confirmOverwriteResponse asset:resolveImportError
backup:create backup:delete backup:getConfig backup:list backup:restore backup:setConfig backup:stats
clouddrive:downloadFile db:assetFolder:search db:assetSearch:engineFacet db:assetSearch:search db:settings:get db:settings:set db:shortcut:getAll db:shortcut:resetAll db:shortcut:update
diagnostics:abandon-import diagnostics:dismiss-import-recovery diagnostics:list-import-recovery diagnostics:resume-import dialog:saveFile dialog:savePdfFromHtml dialog:showSaveDialog file:execute fs:writeFile
image:deleteTask image:getActiveTasks image:getHistory image:startGeneration legacy:import-blueprints legacy:read-all-nodes legacy:scan-db legacy:select-db
assetNote:create assetNote:delete assetNote:getById assetNote:saveImage assetNote:saveVideo assetNote:search assetNote:update
note:create note:delete note:getById note:list note:saveImage note:saveVideo note:search note:update notebook:infographic:saveLocal
notebook:outputs:read notebook:outputs:remove notebook:outputs:write
screen-recorder:selection-cancelled screen-recorder:selection-complete spotlight:getShortcutStatus
vault:checkUpgradeReadiness vault:retryNetwork
window-close window-maximize window-minimize`
    .trim()
    .split(/\s+/)
)

const RAW_EVENT_CHANNELS = new Set(
  `agent:note:changed agent:notebook:source-changed image:event
asset-tree:refresh asset:changed asset:confirmOverwrite asset:folderImportCancelled asset:folderImportCompleted asset:folderImportError asset:folderImportNeedsRecovery asset:folderImportProgress asset:folderImportStage asset:importErrorOccurred asset:unrealImportStarted
baiduyun:download-progress fs:scanBatch fs:scanProgress spotlight:action spotlight:hide spotlight:show
vault:switched`
    .trim()
    .split(/\s+/)
)

const GENERIC_INVOKE_CHANNELS = new Set(
  `aigc:findModelByTaskId aigc:getReferenceLibraryAssets aigc:save3DModelFromUrls app:getHostname assets:saveImageToLibrary
dialog:showOpenDialog file:execute fs:copyDir fs:ensureDir fs:exists fs:writeFile
networkVault:connect networkVault:saveCredentials networkVault:testAccess
networkVaultV2:batch networkVaultV2:connectRemoteVault networkVaultV2:createRemoteVault networkVaultV2:deleteAsset networkVaultV2:deleteFolder networkVaultV2:deleteRemoteVault networkVaultV2:getConnectionStatus networkVaultV2:getDeletedAssets networkVaultV2:getRole networkVaultV2:getServerAccess networkVaultV2:getThumbnailBackupStatus networkVaultV2:listRemoteRoots networkVaultV2:listRemoteVaults networkVaultV2:pullSync networkVaultV2:purgeAsset networkVaultV2:restoreAsset networkVaultV2:restoreThumbnailBackup networkVaultV2:rotateServerAccess networkVaultV2:scan networkVaultV2:setRemoteVaultApiKey networkVaultV2:setShareWritePublish networkVaultV2:syncThumbnailBackup
shell:openPath shell:openSkillsDir shell:openUproject shell:showItemInFolder
vault:cleanThumbnailCache vault:create vault:delete vault:getAll vault:getCurrentPath vault:getStats vault:move vault:rename vault:switch vault:updateBrowsePath vault:updateIcon vault:updateNetworkPath vault:validatePath`
    .trim()
    .split(/\s+/)
)

const GENERIC_INVOKE_PREFIXES = ['library-store:']
const GENERIC_EVENT_CHANNELS = new Set([
  // 用户点了 agent 的系统通知，界面要跳到发通知的那条对话
  NOTIFICATION_ACTIVATE_CHANNEL,
  // 托盘有一条动作待取
  TRAY_ACTION_CHANNEL,
  // agent-v3 的事件全部走 window.api.on（见 renderer/src/api/agentV3.ts），
  // 所以要登记在这里而不是 RAW_EVENT_CHANNELS —— 后者是 electron.ipcRenderer.on 用的。
  'agent-v3:approval-required',
  // 审批在别处（语音口头批的）落定了，界面上那个确认框要跟着收掉
  'agent-v3:approval-settled',
  'agent-v3:compacting',
  'agent-v3:context-usage',
  'agent-v3:done',
  'agent-v3:error',
  // /goal 目标模式的复核进度与裁决。注入回模型的那条续跑消息界面上是看不见的
  // （agentStream 的 markSteerApplied 对不上就忽略），不走这条通道说一声的话，
  // 用户看到的是模型莫名其妙又干起来了
  'agent-v3:goal',
  // 目标模式的目标定下了 / 收齐了 / 取消了。只带 sessionId，输入框上方那行自己去重读
  'agent-v3:goal-state',
  // 工作室模式的名册、任务板、留言变了。只带 sessionId，面板自己去重读 ——
  // 任务板在两轮之间也要活着，所以不挂在按运行订阅的那套事件上
  'agent-v3:team-board',
  // 队员干活时的一条动态（调了什么工具、说了什么）。后台派的活进度推不到
  // 已经结束的那次工具调用上，单独走这条
  'agent-v3:team-activity',
  // 两条内核 session 抢同一个资产。必须让用户看见 —— 他可能开着两个窗口，
  // 以为两边在干不同的活
  'agent-v3:lock-conflict',
  // 这一轮开跑前的准备进度（音视频传对象存储）。几百 MB 要传好一阵，不说一声像卡住了
  'agent-v3:notice',
  // 模型连接中途断了，主进程过几秒自动接着跑（`core/autoResume.ts`）。
  // 不说一声的话，用户看到的是停了半分钟又自己动起来
  'agent-v3:auto-resume',
  // 模型请求卡住、网关已自动重发。不说一声的话最后一张卡片一直转圈，看着像死机
  'agent-v3:model-retry',
  // agent 反问用户。界面在时间线上长一张选项卡片，用户点完经 question-reply 回传
  'agent-v3:question-required',
  // 这条内核 session **真的**空出来了（锁放了、run 摘了）。界面上排队的跟进消息等的是
  // 它而不是 `done` —— `done` 发出来时 prompt() 还没返回，那会儿发下一轮
  // 会被顶回一个 `SESSION_BUSY`
  'agent-v3:released',
  // 模型把这条对话改挂到别的工程下了（`set_session_project`）。
  // 侧边栏分组和顶栏胶囊靠它跟上
  'agent-v3:session-project',
  // 别的窗口正在跑的内核 session 变了。独立对话窗口显示的对话可能是主窗口发起的，
  // 判忙、停止都要知道它在跑
  'agent-v3:runs-elsewhere',
  // 提问卡片在别的窗口里答过了，发起窗口要把自己那张也收成只读
  'agent-v3:question-settled',
  'agent-v3:start',
  'agent-v3:stopped',
  'agent-v3:step',
  'agent-v3:text',
  'agent-v3:thinking',
  'agent-v3:tool-call',
  'agent-v3:tool-progress',
  'agent-v3:tool-result',
  'agent-v3:turn-usage',
  'agent-v3:user-message',
  // Agent 浏览器的开关状态。嵌入模式下助手页面据此决定要不要给它留位置
  'agent-browser:state',
  // 焦点在网页里按了 Ctrl+L / Ctrl+F：主进程让面板打开地址栏或查找条
  'agent-browser:ui',
  'app:blur-active-element',
  'asset:repairVaultThumbnailsProgress',
  'chat-sessions:refresh',
  // 主进程往包目录写了一条库条目（blueprint_library_save）。渲染层的库 store
  // 不经手这次写入，收到这条才去重读 —— 否则 AI 说「已存进蓝图库」，
  // 用户回列表什么都没有。**不能靠「那一轮 agent 跑完了」来代替**：
  // appExecuteAgent 是后台发起、立刻返回的，那时候多半还没存。
  'library:entry-saved',
  'main-log',
  'networkVaultV2:statusChange',
  'networkVaultV2:syncComplete',
  'networkVaultV2:syncProgress'
])

function assertChannelAllowed(channel: string, allowed: Set<string>, operation: string): void {
  if (typeof channel !== 'string' || !allowed.has(channel)) {
    throw new Error(`[preload] Blocked ${operation} channel: ${String(channel)}`)
  }
}

function assertGenericInvokeAllowed(channel: string): void {
  const allowed =
    GENERIC_INVOKE_CHANNELS.has(channel) ||
    GENERIC_INVOKE_PREFIXES.some((prefix) => channel.startsWith(prefix))
  if (!allowed) {
    throw new Error(`[preload] Blocked generic invoke channel: ${String(channel)}`)
  }
}

type InternalIpcListener = (event: Electron.IpcRendererEvent, ...args: any[]) => void

const listenerRegistry = new Map<string, Map<RendererListener, InternalIpcListener>>()
const hiddenEvent = Object.freeze({ sender: undefined })

function addSafeListener(channel: string, listener: RendererListener, once = false): () => void {
  assertChannelAllowed(channel, RAW_EVENT_CHANNELS, once ? 'once' : 'on')
  const wrapped: InternalIpcListener = (_event, ...args) => {
    if (once) listenerRegistry.get(channel)?.delete(listener)
    listener(hiddenEvent, ...args)
  }
  const channelListeners = listenerRegistry.get(channel) ?? new Map()
  channelListeners.set(listener, wrapped)
  listenerRegistry.set(channel, channelListeners)
  if (once) ipcRenderer.once(channel, wrapped)
  else ipcRenderer.on(channel, wrapped)
  return () => removeSafeListener(channel, listener)
}

function removeSafeListener(channel: string, listener: RendererListener): void {
  assertChannelAllowed(channel, RAW_EVENT_CHANNELS, 'removeListener')
  const channelListeners = listenerRegistry.get(channel)
  const wrapped = channelListeners?.get(listener)
  if (!wrapped) return
  ipcRenderer.removeListener(channel, wrapped)
  channelListeners?.delete(listener)
  if (channelListeners?.size === 0) listenerRegistry.delete(channel)
}

const safeIpcRenderer = {
  send: (channel: string, ...args: any[]) => {
    assertChannelAllowed(channel, RAW_REQUEST_CHANNELS, 'send')
    ipcRenderer.send(channel, ...args)
  },
  invoke: (channel: string, ...args: any[]) => {
    assertChannelAllowed(channel, RAW_REQUEST_CHANNELS, 'invoke')
    return ipcRenderer.invoke(channel, ...args)
  },
  on: (channel: string, listener: RendererListener) => addSafeListener(channel, listener),
  once: (channel: string, listener: RendererListener) => addSafeListener(channel, listener, true),
  off: (channel: string, listener: RendererListener) => removeSafeListener(channel, listener),
  removeListener: (channel: string, listener: RendererListener) => {
    removeSafeListener(channel, listener)
    return safeIpcRenderer
  },
  removeAllListeners: (channel: string) => {
    assertChannelAllowed(channel, RAW_EVENT_CHANNELS, 'removeAllListeners')
    for (const wrapped of listenerRegistry.get(channel)?.values() ?? []) {
      ipcRenderer.removeListener(channel, wrapped)
    }
    listenerRegistry.delete(channel)
  }
}

const safeElectronAPI = { ipcRenderer: safeIpcRenderer }

// Custom APIs for renderer
const api = {
  platform: process.platform,
  // 数据库操作API
  window: {
    minimize: () => ipcRenderer.send('window-minimize'),
    maximize: () => ipcRenderer.send('window-maximize'),
    close: () => ipcRenderer.send('window-close'),
    quit: () => ipcRenderer.send('app-quit'),
    focus: () => ipcRenderer.send('window-focus'),
    toggleDevTools: () => ipcRenderer.send('window-toggle-devtools')
  },
  /**
   * MiniChat 那个小窗口。
   *
   * 这些通道原来是渲染层直接 `window.electron.ipcRenderer.send('mini-chat:…')`
   * 调的，而那个包装带白名单校验，`mini-chat:*` 一个都没登记 —— 于是小窗口的
   * 关闭、最小化、置顶、透明度全都在抛 `Blocked send channel`。收进 `window.api`
   * 既修掉了那个，也回到 AGENTS.md 硬规则 4（渲染层不碰 ipcRenderer）。
   */
  miniChat: {
    close: () => ipcRenderer.send('mini-chat:close'),
    minimize: () => ipcRenderer.send('mini-chat:minimize'),
    togglePin: () => ipcRenderer.send('mini-chat:toggle-pin'),
    setOpacity: (opacity: number) => ipcRenderer.send('mini-chat:set-opacity', opacity),
    /** messages 是给主窗口同步进自己 store 用的，少传侧边栏会多出一条空对话 */
    sessionSaved: (session: { id: string; title: string; messages?: unknown[] }) =>
      ipcRenderer.send('mini-chat:session-saved', session),
    requestInitialMessage: () => ipcRenderer.send('mini-chat:request-initial-message'),
    /** 带着主对话的上下文打开侧边窗口（主窗口调） */
    openWithContext: (context: SideQuestionContext) =>
      ipcRenderer.send('mini-chat:open-with-context', context),
    /** 小窗口挂载完主动索取一次，免得投递早于挂载 */
    requestInitialContext: () => ipcRenderer.send('mini-chat:request-initial-context'),
    /**
     * Spotlight 里按回车带过来的那句话。
     *
     * 带着闪存：抓取发生在**用户按回车那一刻**（主进程 `spotlight:execute` 里），
     * 不是小窗口挂载之后 —— 建窗口、加载页面、等 Vue 挂载一共半秒多，
     * 这半秒里用户完全可能已经换了选区。
     */
    onInitialMessage: (callback: (message: MiniChatInitialMessage) => void) => {
      const handler = (_: Electron.IpcRendererEvent, message: MiniChatInitialMessage) =>
        callback(message)
      ipcRenderer.on('mini-chat:initial-message', handler)
      return () => ipcRenderer.removeListener('mini-chat:initial-message', handler)
    },
    onInitialContext: (callback: (context: SideQuestionContext) => void) => {
      const handler = (_: Electron.IpcRendererEvent, context: SideQuestionContext) =>
        callback(context)
      ipcRenderer.on('mini-chat:initial-context', handler)
      return () => ipcRenderer.removeListener('mini-chat:initial-context', handler)
    },
    onPinChanged: (callback: (pinned: boolean) => void) => {
      const handler = (_: Electron.IpcRendererEvent, pinned: boolean) => callback(pinned)
      ipcRenderer.on('mini-chat:pin-changed', handler)
      return () => ipcRenderer.removeListener('mini-chat:pin-changed', handler)
    },
    onResetSession: (callback: () => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('mini-chat:reset-session', handler)
      return () => ipcRenderer.removeListener('mini-chat:reset-session', handler)
    }
  },
  /**
   * 从标签栏拖出来的独立对话窗口，以及它和主窗口之间的对话同步。
   * 见 main/chatWindowManager.ts 文件头。
   */
  chatWindow: {
    open: (args: { chatSid: string; screenX?: number; screenY?: number }) =>
      ipcRenderer.invoke('chat-window:open', args),
    list: (): Promise<string[]> => ipcRenderer.invoke('chat-window:list'),
    bindAgentSession: (args: { chatSid: string; agentSessionId: string }) =>
      ipcRenderer.send('chat-window:bind-agent-session', args),
    openInMain: (path: string) => ipcRenderer.send('chat-window:open-in-main', { path }),
    push: (patch: ChatSyncPatch) => ipcRenderer.send('chat-sync:push', patch),
    requestSnapshot: (chatSid: string) =>
      ipcRenderer.send('chat-sync:request-snapshot', { chatSid }),
    resendApprovals: (sessionIds: string[]): Promise<number> =>
      ipcRenderer.invoke('chat-window:resend-approvals', { sessionIds }),
    runsElsewhere: (): Promise<string[]> => ipcRenderer.invoke('agent-v3:runs-elsewhere'),
    onChanged: (callback: (chatSids: string[]) => void) => {
      const handler = (_: Electron.IpcRendererEvent, chatSids: string[]) => callback(chatSids)
      ipcRenderer.on('chat-window:changed', handler)
      return () => ipcRenderer.removeListener('chat-window:changed', handler)
    },
    onNavigate: (callback: (args: { path: string }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, args: { path: string }) => callback(args)
      ipcRenderer.on('chat-window:navigate', handler)
      return () => ipcRenderer.removeListener('chat-window:navigate', handler)
    },
    onApply: (callback: (patch: ChatSyncPatch) => void) => {
      const handler = (_: Electron.IpcRendererEvent, patch: ChatSyncPatch) => callback(patch)
      ipcRenderer.on('chat-sync:apply', handler)
      return () => ipcRenderer.removeListener('chat-sync:apply', handler)
    },
    onSnapshotRequest: (callback: (args: { sid: string }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, args: { sid: string }) => callback(args)
      ipcRenderer.on('chat-sync:snapshot-request', handler)
      return () => ipcRenderer.removeListener('chat-sync:snapshot-request', handler)
    }
  },
  /** Spotlight 快捷搜索窗口；收口到专用桥接，避免裸 IPC 被安全白名单拦截。 */
  spotlight: {
    search: (query: string): Promise<SpotlightSearchResponse> =>
      ipcRenderer.invoke('spotlight:search', query),
    execute: (action: SpotlightAction, data: Record<string, unknown>) =>
      ipcRenderer.send('spotlight:execute', action, data),
    close: () => ipcRenderer.send('spotlight:close'),
    onShow: (callback: (payload: { dictate: boolean }) => void) => {
      // 旧版主进程不带载荷。缺省成「不听写」，别让一条没有 payload 的显示
      // 把窗口开成录音态
      const handler = (_event: unknown, payload?: { dictate?: boolean }): void =>
        callback({ dictate: Boolean(payload?.dictate) })
      ipcRenderer.on('spotlight:show', handler)
      return () => ipcRenderer.removeListener('spotlight:show', handler)
    },
    onHide: (callback: () => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('spotlight:hide', handler)
      return () => ipcRenderer.removeListener('spotlight:hide', handler)
    },
    /**
     * 语音热键还按着（键盘自动重复，约 31ms 一次）。
     *
     * 「按住说话」的收尾主要靠渲染层自己收到的 keyup；这条是**兜底**：
     * 窗口没抢到焦点时 keyup 不会来，那就只能靠「重复不再来了」判松手。
     */
    onHold: (callback: () => void) => {
      const handler = (): void => callback()
      ipcRenderer.on('spotlight:hold', handler)
      return () => ipcRenderer.removeListener('spotlight:hold', handler)
    },
    /** 渲染层收到了语音热键的 keyup：告诉主进程「这一次按住结束了」，下一次按下算新的一轮 */
    holdReleased: () => ipcRenderer.send('spotlight:hold-released')
  },
  database: {
    // 用户相关操作
    user: {
      getAll: () => ipcRenderer.invoke('db:users:getAll'),
      getById: (id: number) => ipcRenderer.invoke('db:users:getById', id),
      getByUsername: (username: string) => ipcRenderer.invoke('db:users:getByUsername', username),
      create: (userData: any) => ipcRenderer.invoke('db:users:create', userData),
      update: (id: number, userData: any) => ipcRenderer.invoke('db:users:update', id, userData),
      delete: (id: number) => ipcRenderer.invoke('db:users:delete', id)
    },
    // 标签相关操作
    tag: {
      getAll: () => ipcRenderer.invoke('db:tags:getAll'),
      getById: (id: number) => ipcRenderer.invoke('db:tags:getById', id),
      getByName: (name: string) => ipcRenderer.invoke('db:tags:getByName', name),
      getByGroupId: (groupId: number) => ipcRenderer.invoke('db:tags:getByGroupId', groupId),
      getUngrouped: () => ipcRenderer.invoke('db:tags:getUngrouped'),
      create: (tagData: any) => ipcRenderer.invoke('db:tags:create', tagData),
      update: (id: number, updates: any) => ipcRenderer.invoke('db:tags:update', id, updates),
      delete: (id: number) => ipcRenderer.invoke('db:tags:delete', id),
      search: (keyword: string) => ipcRenderer.invoke('db:tags:search', keyword),
      batchCreate: (tagsData: any[]) => ipcRenderer.invoke('db:tags:batchCreate', tagsData),
      batchDelete: (ids: number[]) => ipcRenderer.invoke('db:tags:batchDelete', ids),
      moveToGroup: (tagIds: number[], groupId: number | null) =>
        ipcRenderer.invoke('db:tags:moveToGroup', tagIds, groupId),
      getFavorites: () => ipcRenderer.invoke('db:tags:getFavorites'),
      toggleFavorite: (id: number) => ipcRenderer.invoke('db:tags:toggleFavorite', id)
    },
    // 标签组相关操作
    tagGroup: {
      getAll: () => ipcRenderer.invoke('db:tagGroups:getAll'),
      getAllWithCount: () => ipcRenderer.invoke('db:tagGroups:getAllWithCount'),
      getById: (id: number) => ipcRenderer.invoke('db:tagGroups:getById', id),
      getByName: (name: string) => ipcRenderer.invoke('db:tagGroups:getByName', name),
      getTagCount: (groupId: number) => ipcRenderer.invoke('db:tagGroups:getTagCount', groupId),
      create: (groupData: any) => ipcRenderer.invoke('db:tagGroups:create', groupData),
      update: (id: number, updates: any) => ipcRenderer.invoke('db:tagGroups:update', id, updates),
      delete: (id: number) => ipcRenderer.invoke('db:tagGroups:delete', id),
      search: (keyword: string) => ipcRenderer.invoke('db:tagGroups:search', keyword),
      batchCreate: (groupsData: any[]) =>
        ipcRenderer.invoke('db:tagGroups:batchCreate', groupsData),
      batchDelete: (ids: number[]) => ipcRenderer.invoke('db:tagGroups:batchDelete', ids),
      batchUpdateSort: (sortData: Array<{ id: number; sort_order: number }>) =>
        ipcRenderer.invoke('db:tagGroups:batchUpdateSort', sortData),
      duplicate: (id: number, newName?: string) =>
        ipcRenderer.invoke('db:tagGroups:duplicate', id, newName)
    },
    // 资产文件夹相关操作
    assetFolder: {
      getAll: () => ipcRenderer.invoke('db:assetFolder:getAll'),
      getByKey: (folderKey: string) => ipcRenderer.invoke('db:assetFolder:getByKey', folderKey),
      getByFatherKey: (
        fatherKey: string,
        sortBy?: 'assetName' | 'modifiedTime' | 'fileSize' | 'assetType',
        sortOrder?: 'asc' | 'desc',
        limit?: number,
        offset?: number
      ) =>
        ipcRenderer.invoke(
          'db:assetFolder:getByFatherKey',
          fatherKey,
          sortBy,
          sortOrder,
          limit,
          offset
        ),
      getChildCount: (fatherKey: string) =>
        ipcRenderer.invoke('db:assetFolder:getChildCount', fatherKey),
      getRootFolders: (
        sortBy?: 'assetName' | 'modifiedTime' | 'fileSize' | 'assetType',
        sortOrder?: 'asc' | 'desc'
      ) => ipcRenderer.invoke('db:assetFolder:getRootFolders', sortBy, sortOrder),
      create: (folderData: any) => ipcRenderer.invoke('db:assetFolder:create', folderData),
      update: (folderKey: string, folderData: any) =>
        ipcRenderer.invoke('db:assetFolder:update', folderKey, folderData),
      delete: (folderKey: string) => ipcRenderer.invoke('db:assetFolder:delete', folderKey),
      batchDelete: (folderKeys: string[]) =>
        ipcRenderer.invoke('db:assetFolder:batchDelete', folderKeys),
      restore: (folderKey: string) => ipcRenderer.invoke('db:assetFolder:restore', folderKey),
      getDeleted: (page?: number, pageSize?: number) =>
        ipcRenderer.invoke('db:assetFolder:getDeleted', page, pageSize),
      getByPath: (fullPath: string) => ipcRenderer.invoke('db:assetFolder:getByPath', fullPath),
      // 新增的高效查询方法
      getPathArray: (folderKey: string) =>
        ipcRenderer.invoke('db:assetFolder:getPathArray', folderKey),
      getBatchPaths: (folderKeys: string[]) =>
        ipcRenderer.invoke('db:assetFolder:getBatchPaths', folderKeys),
      getByDepth: (depth: number) => ipcRenderer.invoke('db:assetFolder:getByDepth', depth),
      updatePathsRecursively: (rootFolderKey: string) =>
        ipcRenderer.invoke('db:assetFolder:updatePathsRecursively', rootFolderKey),
      hardDelete: (folderKey: string) => ipcRenderer.invoke('db:assetFolder:hardDelete', folderKey),
      clearDeleted: () => ipcRenderer.invoke('db:assetFolder:clearDeleted'),
      search: (criteria: any) => ipcRenderer.invoke('db:assetFolder:search', criteria)
    },
    // 资产数据相关操作
    assetData: {
      getAll: () => ipcRenderer.invoke('db:assetData:getAll'),
      getDistinctAssetTypes: () => ipcRenderer.invoke('db:assetData:getDistinctAssetTypes'),
      getById: (assetKey: string) => ipcRenderer.invoke('db:assetData:getById', assetKey),
      getByFolderKey: (
        folderKey: string,
        sortBy?: 'assetName' | 'modifiedTime' | 'fileSize' | 'assetType',
        sortOrder?: 'asc' | 'desc',
        showDependencies?: boolean,
        limit?: number,
        offset?: number
      ) =>
        ipcRenderer.invoke(
          'db:assetData:getByFolderKey',
          folderKey,
          sortBy,
          sortOrder,
          showDependencies,
          limit,
          offset
        ),
      getCountByFolderKey: (folderKey: string, showDependencies?: boolean) =>
        ipcRenderer.invoke('db:assetData:getCountByFolderKey', folderKey, showDependencies),
      getByFolderKeyRecursive: (folderKey: string, filters?: { keyword?: string }) =>
        ipcRenderer.invoke('db:assetData:getByFolderKeyRecursive', folderKey, filters),
      /**
       * 名称搜索包装函数
       * 主进程处理通道为 `db:assetData:search`，此处保持方法名 `searchByName` 以兼容调用方。
       */
      searchByName: (name: string) => ipcRenderer.invoke('db:assetData:search', name),
      create: (assetData: any) => ipcRenderer.invoke('db:assetData:create', assetData),
      update: (assetKey: string, assetData: any) =>
        ipcRenderer.invoke('db:assetData:update', assetKey, assetData),
      delete: (assetKey: string) => ipcRenderer.invoke('db:assetData:delete', assetKey),
      restore: (assetKey: string) => ipcRenderer.invoke('db:assetData:restore', assetKey),
      moveToFolder: (assetKey: string, newFolderKey: string) =>
        ipcRenderer.invoke('db:assetData:moveToFolder', assetKey, newFolderKey),
      batchCreate: (assetsData: any[]) =>
        ipcRenderer.invoke('db:assetData:batchCreate', assetsData),
      batchDelete: (assetKeys: string[]) =>
        ipcRenderer.invoke('db:assetData:batchDelete', assetKeys),
      importFolderStructureWithMetadata: (
        folderContents: any[],
        rootFolderPath: string,
        targetFolderKey?: string,
        importConcurrency?: number,
        taskId?: string,
        importOptions?: {
          retryOfTaskId?: string
          forceOverwrite?: boolean
        }
      ) =>
        ipcRenderer.invoke(
          'db:importFolderStructureWithMetadata',
          folderContents,
          rootFolderPath,
          targetFolderKey,
          importConcurrency,
          taskId,
          importOptions
        ),
      processAssetMetadata: (assetKey: string, filePath: string) =>
        ipcRenderer.invoke('db:assetData:processAssetMetadata', assetKey, filePath),
      hardDeleteMany: (assetKeys: string[]) =>
        ipcRenderer.invoke('db:assetData:hardDeleteMany', assetKeys),
      restoreMany: (assetKeys: string[]) =>
        ipcRenderer.invoke('db:assetData:restoreMany', assetKeys),
      clearDeleted: () => ipcRenderer.invoke('db:assetData:clearDeleted'),
      getAssetReferences: (assetKey: string) =>
        ipcRenderer.invoke('db:assetData:getAssetReferences', assetKey),
      getAssetImportStatus: (assetKey: string) =>
        ipcRenderer.invoke('db:assetData:getAssetImportStatus', assetKey),
      getAssetDependencyGraph: (assetKey: string) =>
        ipcRenderer.invoke('db:assetData:getAssetDependencyGraph', assetKey)
    },
    // 资产收藏相关操作
    assetFavorite: {
      add: (assetKey: string, userId: number, vaultId: string) =>
        ipcRenderer.invoke('db:assetFavorite:add', assetKey, userId, vaultId),
      remove: (assetKey: string, userId: number, vaultId: string) =>
        ipcRenderer.invoke('db:assetFavorite:remove', assetKey, userId, vaultId),
      toggle: (assetKey: string, userId: number, vaultId: string) =>
        ipcRenderer.invoke('db:assetFavorite:toggle', assetKey, userId, vaultId),
      isFavorite: (assetKey: string, userId: number, vaultId: string) =>
        ipcRenderer.invoke('db:assetFavorite:isFavorite', assetKey, userId, vaultId),
      getFavoritesByUser: (userId: number, vaultId: string) =>
        ipcRenderer.invoke('db:assetFavorite:getFavoritesByUser', userId, vaultId),
      batchCheckFavorites: (assetKeys: string[], userId: number, vaultId: string) =>
        ipcRenderer.invoke('db:assetFavorite:batchCheckFavorites', assetKeys, userId, vaultId),
      getFavoriteCount: (userId: number, vaultId: string) =>
        ipcRenderer.invoke('db:assetFavorite:getFavoriteCount', userId, vaultId),
      clearAllFavorites: (userId: number, vaultId: string) =>
        ipcRenderer.invoke('db:assetFavorite:clearAllFavorites', userId, vaultId),
      // 文件夹收藏相关操作
      addFolder: (folderKey: string, userId: number, vaultId: string) =>
        ipcRenderer.invoke('db:assetFavorite:addFolder', folderKey, userId, vaultId),
      removeFolder: (folderKey: string, userId: number, vaultId: string) =>
        ipcRenderer.invoke('db:assetFavorite:removeFolder', folderKey, userId, vaultId),
      toggleFolder: (folderKey: string, userId: number, vaultId: string) =>
        ipcRenderer.invoke('db:assetFavorite:toggleFolder', folderKey, userId, vaultId),
      isFolderFavorite: (folderKey: string, userId: number, vaultId: string) =>
        ipcRenderer.invoke('db:assetFavorite:isFolderFavorite', folderKey, userId, vaultId),
      getFavoriteFoldersWithDetails: (userId: number, vaultId: string) =>
        ipcRenderer.invoke('db:assetFavorite:getFavoriteFoldersWithDetails', userId, vaultId),
      getAllFavoritesWithDetails: (userId: number, vaultId: string) =>
        ipcRenderer.invoke('db:assetFavorite:getAllFavoritesWithDetails', userId, vaultId)
    },
    // 资产标签相关操作
    assetTag: {
      add: (assetKey: string, tagId: number) =>
        ipcRenderer.invoke('db:assetTag:add', assetKey, tagId),
      remove: (assetKey: string, tagId: number) =>
        ipcRenderer.invoke('db:assetTag:remove', assetKey, tagId),
      getTagIdsByAssetKey: (assetKey: string) =>
        ipcRenderer.invoke('db:assetTag:getTagIdsByAssetKey', assetKey),
      getAssetsByTagId: (tagId: number) =>
        ipcRenderer.invoke('db:assetTag:getAssetsByTagId', tagId),
      getAssetsByAnyTag: (tagIds: number[]) =>
        ipcRenderer.invoke('db:assetTag:getAssetsByAnyTag', tagIds),
      getAssetsByAllTags: (tagIds: number[]) =>
        ipcRenderer.invoke('db:assetTag:getAssetsByAllTags', tagIds),
      setTagsForAsset: (assetKey: string, tagIds: number[]) =>
        ipcRenderer.invoke('db:assetTag:setTagsForAsset', assetKey, tagIds),
      filterAssets: (options: {
        includeTagIds?: number[]
        excludeTagIds?: number[]
        matchMode?: 'any' | 'all'
        folderKey?: string
      }) => ipcRenderer.invoke('db:assetTag:filterAssets', options),
      getUsageCounts: () => ipcRenderer.invoke('db:assetTag:getUsageCounts')
    },
    // 文件夹标签相关操作
    folderTag: {
      add: (folderKey: string, tagId: number) =>
        ipcRenderer.invoke('db:folderTag:add', folderKey, tagId),
      remove: (folderKey: string, tagId: number) =>
        ipcRenderer.invoke('db:folderTag:remove', folderKey, tagId),
      getTagIdsByFolderKey: (folderKey: string) =>
        ipcRenderer.invoke('db:folderTag:getTagIdsByFolderKey', folderKey),
      getFoldersByTagId: (tagId: number) =>
        ipcRenderer.invoke('db:folderTag:getFoldersByTagId', tagId),
      getFoldersByAnyTag: (tagIds: number[]) =>
        ipcRenderer.invoke('db:folderTag:getFoldersByAnyTag', tagIds),
      getFoldersByAllTags: (tagIds: number[]) =>
        ipcRenderer.invoke('db:folderTag:getFoldersByAllTags', tagIds),
      setTagsForFolder: (folderKey: string, tagIds: number[]) =>
        ipcRenderer.invoke('db:folderTag:setTagsForFolder', folderKey, tagIds),
      addTagsToFolder: (folderKey: string, tagIds: number[]) =>
        ipcRenderer.invoke('db:folderTag:addTagsToFolder', folderKey, tagIds),
      removeTagsFromFolder: (folderKey: string, tagIds: number[]) =>
        ipcRenderer.invoke('db:folderTag:removeTagsFromFolder', folderKey, tagIds),
      clear: (folderKey: string) => ipcRenderer.invoke('db:folderTag:clear', folderKey),
      countFoldersWithTag: (tagId: number) =>
        ipcRenderer.invoke('db:folderTag:countFoldersWithTag', tagId)
    },
    // 统一资产搜索
    assetSearch: {
      search: (criteria: any) => ipcRenderer.invoke('db:assetSearch:search', criteria)
    },
    // 资产库语义搜索（默认关闭，用户在设置里自己开）
    assetSemantic: {
      status: () => ipcRenderer.invoke('db:assetSemantic:status'),
      enable: () => ipcRenderer.invoke('db:assetSemantic:enable'),
      disable: () => ipcRenderer.invoke('db:assetSemantic:disable'),
      resume: () => ipcRenderer.invoke('db:assetSemantic:resume')
    },
    // 项目相关操作（公共数据库）
    project: {
      saveCover: (projectKey: string, image: Uint8Array) =>
        ipcRenderer.invoke('db:project:saveCover', projectKey, image),
      restoreAutomaticCover: (projectKey: string) =>
        ipcRenderer.invoke('db:project:restoreAutomaticCover', projectKey),
      importByFilePath: (filePath: string) =>
        ipcRenderer.invoke('db:project:importByFilePath', filePath),
      scanDirectory: (startPath: string) =>
        ipcRenderer.invoke('db:project:scanDirectory', startPath),
      importByDirectory: (startPath: string) =>
        ipcRenderer.invoke('db:project:importByDirectory', startPath),
      create: (record: any) => ipcRenderer.invoke('db:project:create', record),
      update: (projectKey: string, updates: any) =>
        ipcRenderer.invoke('db:project:update', projectKey, updates),
      getAll: () => ipcRenderer.invoke('db:project:getAll'),
      getByKey: (projectKey: string) => ipcRenderer.invoke('db:project:getByKey', projectKey),
      delete: (projectKey: string) => ipcRenderer.invoke('db:project:delete', projectKey),
      exists: (projectKey: string) => ipcRenderer.invoke('db:project:exists', projectKey),
      search: (keyword: string) => ipcRenderer.invoke('db:project:search', keyword),
      /**
       * 查找项目目录下的 .sln 文件（检测 C++ 工程）
       * @param projectDir - 项目目录路径
       * @returns 如果找到 .sln 文件返回其路径，否则返回 null
       */
      findSlnFile: (projectDir: string) => ipcRenderer.invoke('db:project:findSlnFile', projectDir),
      /** 查询项目里 UnrealAgentLink 的安装状态 */
      ualinkStatus: (uprojectPath: string) =>
        ipcRenderer.invoke('db:project:ualinkStatus', uprojectPath),
      /** 从项目里移除 UnrealAgentLink，并记住不再自动安装 */
      ualinkRemove: (uprojectPath: string) =>
        ipcRenderer.invoke('db:project:ualinkRemove', uprojectPath),
      /** 把 UnrealAgentLink 装回项目 */
      ualinkInstall: (uprojectPath: string) =>
        ipcRenderer.invoke('db:project:ualinkInstall', uprojectPath),
      /** 首次导入时那一问的答案；装失败的工程和原因码原样返回 */
      ualinkPromptAnswer: (install: boolean, uprojectPaths: string[]) =>
        ipcRenderer.invoke('db:project:ualinkPromptAnswer', install, uprojectPaths),
      /** 首次导入工程、自动安装又关着时，主进程请界面问一句要不要装，返回退订函数 */
      onUALinkInstallPrompt: (callback: (uprojectPath: string) => void) => {
        const handler = (_: Electron.IpcRendererEvent, uprojectPath: string): void =>
          callback(uprojectPath)
        ipcRenderer.on('db:project:ualink-install-prompt', handler)
        return () => ipcRenderer.removeListener('db:project:ualink-install-prompt', handler)
      },
      /**
       * 「我的项目」里多了工程时的通知，返回退订函数。
       *
       * 用得上是因为入库不只发生在用户点导入的时候：agent 建工程、UE 连上时
       * 补登记，都在用户没操作首页的时候往库里加东西。不订这个的话，工程
       * 明明进库了首页还是空的，用户会以为「它说建好了但其实没有」。
       */
      onLibraryChanged: (callback: () => void) => {
        const handler = (): void => callback()
        ipcRenderer.on('db:project:library-changed', handler)
        return () => ipcRenderer.removeListener('db:project:library-changed', handler)
      },
      /**
       * 开机后台升级插件时有工程失败了，返回退订函数。
       *
       * 和导入那条路分开：导入失败能跟在「导入成功」后面说，而这一条**没有对应的
       * 用户动作** —— 它发生在开机后的后台，不推的话用户永远不知道自己还停在旧插件上。
       */
      onPluginUpgradeFailed: (
        callback: (
          failures: Array<{ project: string; reason: string; uprojectPath: string }>
        ) => void
      ) => {
        const handler = (
          _: Electron.IpcRendererEvent,
          failures: Array<{ project: string; reason: string; uprojectPath: string }>
        ): void => callback(failures)
        ipcRenderer.on('db:project:plugin-upgrade-failed', handler)
        return () => ipcRenderer.removeListener('db:project:plugin-upgrade-failed', handler)
      }
    },
    // 工程合集相关操作（公共数据库）
    projectCollection: {
      create: (record: any) => ipcRenderer.invoke('db:projectCollection:create', record),
      update: (collectionKey: string, updates: any) =>
        ipcRenderer.invoke('db:projectCollection:update', collectionKey, updates),
      delete: (collectionKey: string) =>
        ipcRenderer.invoke('db:projectCollection:delete', collectionKey),
      getAll: () => ipcRenderer.invoke('db:projectCollection:getAll'),
      getByKey: (collectionKey: string) =>
        ipcRenderer.invoke('db:projectCollection:getByKey', collectionKey),
      exists: (collectionKey: string) =>
        ipcRenderer.invoke('db:projectCollection:exists', collectionKey),
      search: (keyword: string) => ipcRenderer.invoke('db:projectCollection:search', keyword),
      getProjects: (collectionKey: string) =>
        ipcRenderer.invoke('db:projectCollection:getProjects', collectionKey),
      addProject: (projectKey: string, collectionKey: string) =>
        ipcRenderer.invoke('db:projectCollection:addProject', projectKey, collectionKey),
      // 不给 collectionKey 就是从所有分组里移出去
      removeProject: (projectKey: string, collectionKey?: string | null) =>
        ipcRenderer.invoke('db:projectCollection:removeProject', projectKey, collectionKey)
    },
    importTask: {
      create: (task: any) => ipcRenderer.invoke('db:importTask:create', task),
      update: (taskId: string, patch: any) =>
        ipcRenderer.invoke('db:importTask:update', taskId, patch),
      get: (taskId: string) => ipcRenderer.invoke('db:importTask:get', taskId),
      list: () => ipcRenderer.invoke('db:importTask:list'),
      pause: (taskId: string) => ipcRenderer.invoke('db:importTask:pause', taskId),
      resume: (taskId: string) => ipcRenderer.invoke('db:importTask:resume', taskId)
    }
  },
  // 文件对话框API
  dialog: {
    showOpenDialog: (options?: any) => ipcRenderer.invoke('dialog:showOpenDialog', options),
    showSaveDialog: (options?: any) => ipcRenderer.invoke('dialog:showSaveDialog', options),
    showMessageBox: (options?: any) => ipcRenderer.invoke('dialog:showMessageBox', options),
    showErrorBox: (title: string, content: string) =>
      ipcRenderer.invoke('dialog:showErrorBox', title, content)
  },
  // 文件系统API
  fs: {
    onOverwriteSettled: (callback: (payload: { confirmId: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { confirmId: string }): void =>
        callback(payload)
      ipcRenderer.on('asset:overwriteSettled', handler)
      return () => ipcRenderer.removeListener('asset:overwriteSettled', handler)
    },
    readFolderContents: (folderPath: string) =>
      ipcRenderer.invoke('fs:readFolderContents', folderPath),
    // 文件系统操作
    onImportErrorSettled: (callback: (payload: { taskId: string }) => void) => {
      const handler = (_event: Electron.IpcRendererEvent, payload: { taskId: string }): void =>
        callback(payload)
      ipcRenderer.on('asset:importErrorSettled', handler)
      return () => ipcRenderer.removeListener('asset:importErrorSettled', handler)
    },
    cancelImport: (taskId: string) => ipcRenderer.invoke('asset:cancelImport', taskId),
    resolveImportError: (taskId: string, action: string) =>
      ipcRenderer.invoke('asset:resolveImportError', { taskId, action }),
    readFolderContentsRecursive: (folderPath: string, options?: { taskId?: string }) =>
      ipcRenderer.invoke('fs:readFolderContentsRecursive', folderPath, options),
    processFileMetadata: (filePath: string) =>
      ipcRenderer.invoke('fs:processFileMetadata', filePath),
    processBatchFileMetadata: (filePaths: string[]) =>
      ipcRenderer.invoke('fs:processBatchFileMetadata', filePaths),
    // 读取文件内容（用于文本预览）
    readFile: (
      filePath: string,
      options?: { encoding?: BufferEncoding; maxLines?: number; maxBytes?: number }
    ) => ipcRenderer.invoke('fs:readFile', filePath, options),
    // 读取文件的二进制内容（用于上传到云端）
    readFileBuffer: (filePath: string) => ipcRenderer.invoke('fs:readFileBuffer', filePath),
    copyFile: (src: string, dest: string) => ipcRenderer.invoke('fs:copyFile', src, dest),
    /**
     * 获取指定路径所在磁盘的剩余空间
     * @param targetPath 目标路径（用于确定检查哪个磁盘）
     * @returns { free: number, total: number } 剩余空间和总空间（字节）
     */
    getDiskSpace: (
      targetPath: string
    ): Promise<{ success: boolean; free?: number; total?: number; error?: string }> =>
      ipcRenderer.invoke('fs:getDiskSpace', targetPath)
  },

  // 资产相关通用 API
  asset: {
    saveThumbnail: (base64Data: string, assetKey?: string) =>
      ipcRenderer.invoke('asset:saveThumbnail', base64Data, assetKey),
    /**
     * 保存本地文件作为缩略图（支持视频/GIF）
     * @param srcPath 源文件路径
     * @param assetKey 资产键
     */
    saveThumbnailFile: (srcPath: string, assetKey?: string) =>
      ipcRenderer.invoke('asset:saveThumbnailFile', srcPath, assetKey),
    /**
     * 双图保存：原图 + 裁剪压缩图
     * @param originalBase64 原图 base64 数据
     * @param croppedBase64  裁剪后 base64 数据
     * @param assetKey       资产键
     */
    saveOriginalAndCroppedThumbnail: (
      originalBase64: string,
      croppedBase64: string,
      assetKey?: string
    ) =>
      ipcRenderer.invoke(
        'asset:saveOriginalAndCroppedThumbnail',
        originalBase64,
        croppedBase64,
        assetKey
      ),
    /**
     * 读取本地文件并转换为 base64 编码
     * @param filePath 本地文件路径
     */
    readFileAsBase64: (filePath: string) => ipcRenderer.invoke('asset:readFileAsBase64', filePath),
    /**
     * 覆盖已有缩略图的 _thumb 压缩版（重新剪裁时使用）
     * @param posterFilename customPoster 文件名
     * @param croppedBase64  裁剪后的 base64 数据
     */
    overwriteThumb: (posterFilename: string, croppedBase64: string, assetKey?: string) =>
      ipcRenderer.invoke('asset:overwriteThumb', posterFilename, croppedBase64, assetKey),
    /**
     * 扫描当前保管库已引用的缩略图，并重新上传到 NAS V2 远程服务器
     */
    syncCurrentVaultThumbnailsToRemote: () =>
      ipcRenderer.invoke('asset:syncCurrentVaultThumbnailsToRemote'),
    /**
     * 读取当前保管库最近的缩略图修复审计日志
     */
    listThumbnailRepairAuditLogs: (limit?: number) =>
      ipcRenderer.invoke('asset:listThumbnailRepairAuditLogs', limit),
    /**
     * 重新导入单个资产
     * @param assetKey 资产键
     */
    reimportAsset: (assetKey: string) => ipcRenderer.invoke('asset:reimportAsset', assetKey),
    /**
     * 工程整包上传：把一个工程目录（或 zip/rar/7z）作为一个文件送到 HTTP 资产服务器
     * @param sourcePath 工程目录或压缩包路径
     * @param targetFolderKey 目标文件夹 key，缺省进根目录
     * @param taskId 界面预先建好的任务卡 id，进度事件按它回传
     */
    uploadProjectArchive: (sourcePath: string, targetFolderKey?: string | null, taskId?: string) =>
      ipcRenderer.invoke('asset:uploadProjectArchive', sourcePath, targetFolderKey, taskId),
    /**
     * 取回工程整包：从 HTTP 资产服务器把压缩包下到 destDir，zip 会自动解开成工程目录
     */
    pullProjectArchive: (params: {
      remotePath: string
      fileName: string
      destDir: string
      taskId?: string
    }) => ipcRenderer.invoke('asset:pullProjectArchive', params),
    /**
     * 重新导入文件夹
     * @param folderKey 文件夹键
     */
    reimportFolder: (folderKey: string) => ipcRenderer.invoke('asset:reimportFolder', folderKey)
  },

  // 视频相关 API
  video: {
    /**
     * 用 FFmpeg 抽帧存缩略图。**回退路径** —— 首选是渲染层 Chromium 解码后走
     * `asset.saveThumbnail`（那条路不需要 FFmpeg）。返回纯文件名。
     */
    extractAndSaveThumbnail: (videoPath: string, assetKey: string) =>
      ipcRenderer.invoke('video:extractAndSaveThumbnail', videoPath, assetKey),
    /** 检查文件是否为视频文件 */
    isVideoFile: (filePath: string) => ipcRenderer.invoke('video:isVideoFile', filePath),
    /** 检查 FFmpeg 是否可用 */
    checkFFmpegAvailable: () => ipcRenderer.invoke('video:checkFFmpegAvailable'),

    // ==================== 视频压缩 API ====================

    /**
     * 压缩视频到指定大小以下（双遍编码，精确控制大小）
     * @param inputPath - 输入视频路径
     * @param outputPath - 输出视频路径（可选，默认在输入文件同目录生成）
     * @param options - 压缩配置
     */
    compress: (
      inputPath: string,
      outputPath?: string,
      options?: {
        targetSizeMB?: number
        fps?: number
        width?: number
        audioBitrate?: number
        monoAudio?: boolean
        crfMax?: number
      }
    ) => ipcRenderer.invoke('video:compress', inputPath, outputPath, options),

    /**
     * 快速压缩视频（单遍，速度更快但大小控制不精确）
     */
    compressFast: (
      inputPath: string,
      outputPath?: string,
      options?: {
        targetSizeMB?: number
        fps?: number
        width?: number
        audioBitrate?: number
        monoAudio?: boolean
        crfMax?: number
      }
    ) => ipcRenderer.invoke('video:compressFast', inputPath, outputPath, options),

    /**
     * 为 AI 分析压缩视频（预设参数优化）
     * 使用最佳参数配置：95MB目标、15fps、720p、AAC单声道
     * 确保视频适合发送给多模态大模型
     */
    compressForAI: (inputPath: string, outputPath?: string) =>
      ipcRenderer.invoke('video:compressForAI', inputPath, outputPath)
  },

  // Shell API
  shell: {
    openPath: (targetPath: string) => ipcRenderer.invoke('shell:openPath', targetPath),
    showItemInFolder: (targetPath: string) =>
      ipcRenderer.invoke('shell:showItemInFolder', targetPath),
    openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),
    openWith: (filePath: string, appPath: string) =>
      ipcRenderer.invoke('shell:openWith', filePath, appPath),
    openInEditor: (targetPath: string, editor: string) =>
      ipcRenderer.invoke('shell:openInEditor', targetPath, editor),
    listEditors: () => ipcRenderer.invoke('shell:listEditors')
  },

  // 路径/URL工具
  path: {
    getPublicThumbnailUrl: (filename: string) =>
      ipcRenderer.invoke('path:getPublicThumbnailUrl', filename),
    getVaultThumbnailFilePath: (filename: string) =>
      ipcRenderer.invoke('path:getVaultThumbnailFilePath', filename)
  },

  // 获取拖拽文件的真实路径 - 直接在 preload 中使用 webUtils
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  /**
   * 拖拽入口的路径体检。压缩包里拖出来的东西不是磁盘上的文件，要在入口挡掉，
   * 判定用的「系统临时目录在哪」只有主进程知道。
   */
  classifyDroppedPaths: (filePaths: string[]) =>
    ipcRenderer.invoke('fs:classifyDroppedPaths', filePaths),
  getFileStats: (filePath: string) => ipcRenderer.invoke('fs:getFileStats', filePath),
  startNativeFileDrag: (filePath: string) => ipcRenderer.invoke('fs:startNativeFileDrag', filePath),
  deleteFile: (filePath: string) => ipcRenderer.invoke('fs:deleteFile', filePath),
  importSingleFile: (filePath: string, targetFolderKey: string) =>
    ipcRenderer.invoke('asset:importSingleFile', filePath, targetFolderKey),

  // 拖拽移动API
  dragMove: {
    moveItems: (items: any[], targetFolderId: string) =>
      ipcRenderer.invoke('db:dragMove:moveItems', items, targetFolderId),
    validateMove: (items: any[], targetFolderId: string) =>
      ipcRenderer.invoke('db:dragMove:validateMove', items, targetFolderId)
  },

  // 蓝图包 / 材质包（保管库里的 .ueblueprint / .uematerial 目录）
  libraryPackage: {
    scan: () => ipcRenderer.invoke('library-package:scan'),
    read: (dirPath: string) => ipcRenderer.invoke('library-package:read', dirPath),
    create: (payload: {
      library: 'blueprint' | 'material'
      id: string
      name: string
      payload: unknown
      parentRelPath?: string
    }) => ipcRenderer.invoke('library-package:create', payload),
    update: (dirPath: string, patch: { name?: string; payload?: unknown; cover?: string }) =>
      ipcRenderer.invoke('library-package:update', dirPath, patch),
    rename: (dirPath: string, newName: string) =>
      ipcRenderer.invoke('library-package:rename', dirPath, newName),
    delete: (dirPath: string) => ipcRenderer.invoke('library-package:delete', dirPath),
    readMeta: () => ipcRenderer.invoke('library-package:readMeta'),
    writeMeta: (text: string) => ipcRenderer.invoke('library-package:writeMeta', text),
    writeFile: (dirPath: string, relPath: string, data: Uint8Array) =>
      ipcRenderer.invoke('library-package:writeFile', dirPath, relPath, data),
    readFile: (dirPath: string, relPath: string) =>
      ipcRenderer.invoke('library-package:readFile', dirPath, relPath)
  },

  // 兼容旧调用点的受限 invoke；新代码应优先使用上面的具名 API。
  invoke: (channel: string, ...args: any[]) => {
    assertGenericInvokeAllowed(channel)
    return ipcRenderer.invoke(channel, ...args)
  },

  // 百度云下载API
  baiduYun: {
    downloadByFsId: (params: {
      downloadId: string
      accessToken: string
      fsId: number
      filename?: string
      savePath: string
    }) => ipcRenderer.invoke('baiduyun:downloadByFsId', params),
    downloadByDlink: (params: {
      downloadId: string
      accessToken: string
      dlink: string
      filename?: string
      savePath: string
    }) => ipcRenderer.invoke('baiduyun:downloadByDlink', params),
    onProgress: (
      listener: (event: {
        downloadId: string
        loaded: number
        total?: number
        percent: number
      }) => void
    ) => {
      const handler = (_: Electron.IpcRendererEvent, payload: any) => listener(payload)
      ipcRenderer.on('baiduyun:download-progress', handler)
      return () => ipcRenderer.removeListener('baiduyun:download-progress', handler)
    },
    /**
     * 获取百度网盘用户信息
     */
    getUserInfo: (params: { accessToken: string }) =>
      ipcRenderer.invoke('baiduyun:getUserInfo', params),
    /**
     * 获取文件列表
     */
    getFileList: (params: {
      accessToken: string
      dir?: string
      order?: string
      desc?: number
      start?: number
      limit?: number
      web?: number
      folder?: number
      showempty?: number
    }) => ipcRenderer.invoke('baiduyun:getFileList', params),
    /**
     * 搜索文件
     */
    searchFiles: (params: {
      accessToken: string
      key: string
      dir?: string
      category?: number
      recursion?: number
      web?: number
    }) => ipcRenderer.invoke('baiduyun:searchFiles', params),
    /**
     * 文件管理：重命名、删除、复制、移动
     */
    fileManager: (params: {
      accessToken: string
      opera: 'copy' | 'move' | 'rename' | 'delete'
      filelist: Array<{ path: string; newname?: string; dest?: string }>
      async?: number
      ondup?: string
    }) => ipcRenderer.invoke('baiduyun:fileManager', params),

    // ==================== 上传相关 API ====================

    /**
     * 预上传：通知云端新建上传任务
     */
    precreate: (params: {
      accessToken: string
      path: string
      size: number
      isdir?: 0 | 1
      blockList: string[]
      rtype?: 0 | 1 | 2 | 3
    }) => ipcRenderer.invoke('baiduyun:precreate', params),

    /**
     * 获取上传域名
     */
    locateUpload: (params: { accessToken: string; path: string; uploadid: string }) =>
      ipcRenderer.invoke('baiduyun:locateUpload', params),

    /**
     * 上传文件（主进程读取本地文件并分片上传）
     */
    uploadFile: (params: {
      accessToken: string
      localPath: string
      remotePath: string
      uploadid: string
      host: string
      uploadId: string
      blockSize?: number
    }) => ipcRenderer.invoke('baiduyun:uploadFile', params),

    /**
     * 创建文件（合并分片）
     */
    create: (params: {
      accessToken: string
      path: string
      size: number
      isdir?: 0 | 1
      blockList: string[]
      uploadid?: string
      rtype?: 0 | 1 | 2 | 3
    }) => ipcRenderer.invoke('baiduyun:create', params),

    /**
     * 创建文件夹
     */
    createFolder: (params: { accessToken: string; path: string; rtype?: 0 | 1 | 2 | 3 }) =>
      ipcRenderer.invoke('baiduyun:createFolder', params),

    /**
     * 查询文件信息
     */
    filemetas: (params: {
      accessToken: string
      fsids: Array<number | string>
      dlink?: 0 | 1
      thumb?: 0 | 1
    }) => ipcRenderer.invoke('baiduyun:filemetas', params),

    /**
     * 监听上传进度
     */
    onUploadProgress: (
      listener: (event: {
        uploadId: string
        loaded: number
        total: number
        percent: number
        partIndex: number
        partCount: number
      }) => void
    ) => {
      const handler = (_: Electron.IpcRendererEvent, payload: any) => listener(payload)
      ipcRenderer.on('baiduyun:upload-progress', handler)
      return () => ipcRenderer.removeListener('baiduyun:upload-progress', handler)
    },

    // ==================== 文件夹下载相关 API ====================

    /**
     * 下载整个文件夹（递归）
     * @param params.downloadId - 下载任务ID
     * @param params.accessToken - 访问令牌
     * @param params.folderPath - 百度网盘文件夹路径
     * @param params.folderName - 文件夹名称
     * @param params.savePath - 本地保存根路径
     */
    downloadFolder: (params: {
      downloadId: string
      accessToken: string
      folderPath: string
      folderName: string
      savePath: string
    }) => ipcRenderer.invoke('baiduyun:downloadFolder', params),

    /**
     * 监听文件夹下载进度
     */
    onFolderDownloadProgress: (
      listener: (event: {
        downloadId: string
        phase: 'scanning' | 'downloading' | 'done' | 'error'
        totalFiles: number
        downloadedFiles: number
        failedFiles: number
        currentFile: string
        percent: number
      }) => void
    ) => {
      const handler = (_: Electron.IpcRendererEvent, payload: any) => listener(payload)
      ipcRenderer.on('baiduyun:folder-download-progress', handler)
      return () => ipcRenderer.removeListener('baiduyun:folder-download-progress', handler)
    }
  },
  unrealPath: {
    // 扫描 Unreal 引擎
    scanEngines: () => ipcRenderer.invoke('unreal:engines:scan'),
    // Inspect invalid persisted custom engine records
    inspectInvalidCustomPaths: () => ipcRenderer.invoke('unreal:engines:inspectInvalidCustomPaths'),
    // 添加自定义引擎路径
    addCustomPath: (customPath: string | string[]) =>
      ipcRenderer.invoke('unreal:engines:addCustomPath', customPath),
    // 移除自定义引擎路径（从数据库删除）
    removeCustomPath: (rootPath: string) =>
      ipcRenderer.invoke('unreal:engines:removeCustomPath', rootPath),
    // 把 EngineAssociation 批量翻成版本号（自编译引擎写的是 GUID）
    resolveEngineAssociations: (associations: (string | null)[]) =>
      ipcRenderer.invoke('unreal:engines:resolveAssociations', associations),
    // 解析可执行版本
    getExeVersion: (filePath: string) => ipcRenderer.invoke('unreal:exe:getVersion', filePath),
    // 比较版本号（返回 -1/0/1）
    compareVersions: (a: string | number, b: string | number) =>
      ipcRenderer.invoke('unreal:version:compare', a, b)
  },
  /**
   * 虚幻引擎进程检测 API
   * 用于获取当前运行的虚幻引擎项目信息
   */
  unrealProcess: {
    // 获取所有正在运行的虚幻引擎项目
    getRunningProjects: () => ipcRenderer.invoke('unreal:process:getRunningProjects'),
    // 检查虚幻编辑器是否正在运行
    isRunning: () => ipcRenderer.invoke('unreal:process:isRunning'),
    // 获取主要运行的项目（第一个）
    getPrimaryProject: () => ipcRenderer.invoke('unreal:process:getPrimaryProject'),
    // 根据项目名称查找运行中的项目
    findByName: (projectName: string) =>
      ipcRenderer.invoke('unreal:process:findByName', projectName),
    // 根据项目路径查找运行中的项目
    findByPath: (projectPath: string) =>
      ipcRenderer.invoke('unreal:process:findByPath', projectPath)
  },
  /**
   * UE 崩溃日志 API
   * 读取项目 Saved/Crashes 和 Saved/Logs 目录获取崩溃日志
   */
  ueCrashLogs: {
    /**
     * 获取崩溃日志
     * @param params.projectPath 可选的项目路径，不提供则自动获取
     * @param params.maxLogs 最大日志数量，默认 3
     */
    get: (params?: {
      projectPath?: string
      maxLogs?: number
    }): Promise<{
      success: boolean
      reports?: Array<{
        timestamp: string
        error: string
        callStack: string
        logSnippet: string
        source: 'CrashContext' | 'LogFile'
      }>
      projectPath?: string
      message?: string
      error?: string
    }> => ipcRenderer.invoke('ue:crashLogs:get', params || {})
  },
  /** 顶栏状态监控：这条对话归属的工程现在的编辑器状况 */
  ueEditorHealth: {
    get: (params: { projectPath: string }) => ipcRenderer.invoke('ue:editorHealth:get', params)
  },
  system: {
    /**
     * 获取系统信息（平台、版本、是否为 Windows 11）
     */
    getInfo: () => ipcRenderer.invoke('system:getInfo')
  },
  webdav: {
    testConnection: (params: { serverUrl: string; username: string; password: string }) =>
      ipcRenderer.invoke('webdav:testConnection', params),
    getDirectoryContents: (params: {
      serverUrl: string
      username: string
      password: string
      path: string
    }) => ipcRenderer.invoke('webdav:getDirectoryContents', params),
    uploadFile: (params: {
      serverUrl: string
      username: string
      password: string
      remotePath: string
      fileBuffer: ArrayBuffer
    }) => ipcRenderer.invoke('webdav:uploadFile', params),
    downloadFile: (params: {
      serverUrl: string
      username: string
      password: string
      remotePath: string
      savePath?: string
    }) => ipcRenderer.invoke('webdav:downloadFile', params),
    deleteFile: (params: { serverUrl: string; username: string; password: string; path: string }) =>
      ipcRenderer.invoke('webdav:deleteFile', params),
    createDirectory: (params: {
      serverUrl: string
      username: string
      password: string
      path: string
    }) => ipcRenderer.invoke('webdav:createDirectory', params),
    moveFile: (params: {
      serverUrl: string
      username: string
      password: string
      fromPath: string
      toPath: string
    }) => ipcRenderer.invoke('webdav:moveFile', params)
  },
  /**
   * 局域网协作库 API
   */
  networkVault: {
    /**
     * 测试网络路径访问
     */
    testAccess: (networkPath: string) => ipcRenderer.invoke('networkVault:testAccess', networkPath),
    /**
     * 读取清单
     */
    readManifest: (networkPath: string) =>
      ipcRenderer.invoke('networkVault:readManifest', networkPath),
    /**
     * 扫描现有资产并初始化清单
     * @param networkPath 网络路径
     * @param vaultName 资产库名称
     */
    initializeFromExisting: (networkPath: string, vaultName: string) =>
      ipcRenderer.invoke('networkVault:initializeFromExisting', networkPath, vaultName),
    /**
     * 扫描资产
     */
    scanAssets: (networkPath: string, options?: object) =>
      ipcRenderer.invoke('networkVault:scanAssets', networkPath, options),
    /**
     * 检查远程更新
     */
    checkForUpdates: (networkPath: string, lastKnownVersion: number) =>
      ipcRenderer.invoke('networkVault:checkForUpdates', networkPath, lastKnownVersion),
    /**
     * 删除资产（同步到网络并删除本地记录）
     */
    deleteAsset: (networkPath: string, assetKey: string) =>
      ipcRenderer.invoke('networkVault:deleteAsset', networkPath, assetKey),
    /**
     * 批量删除资产（性能优化版）
     * - 写入单个批量 Journal
     * - 并行删除物理文件
     * - SQLite 事务批量删除
     */
    batchDeleteAssets: (networkPath: string, assetKeys: string[]) =>
      ipcRenderer.invoke('networkVault:batchDeleteAssets', networkPath, assetKeys) as Promise<{
        success: boolean
        data?: { deletedCount: number }
        error?: string
      }>,
    /**
     * 检查网络路径的写入权限
     */
    checkWritePermission: (networkPath: string) =>
      ipcRenderer.invoke('networkVault:checkWritePermission', networkPath) as Promise<{
        canWrite: boolean
        error?: string
      }>
  },
  /**
   * Agent V3 API —— 扁平单 agent + pi 内核。
   *
   * 渲染层**必须**走这里，不要直接 ipcRenderer.invoke('agent-v3:*')：
   * 那些通道不在 RAW_REQUEST_CHANNELS 白名单里，会被挡下。
   */
  /**
   * Agent 浏览器的界面通道。
   *
   * 只在嵌入模式下有用：那一档把网页挂成主窗口的子视图，而子视图浮在
   * 渲染层内容之上、不参与网页布局 —— 位置只能由界面量出来报给主进程。
   *
   * 地址栏按内核 session 导航；主进程统一校验 URL 和 DNS。
   */
  agentBrowser: {
    tab: (
      sessionId: string,
      command: BrowserTabCommand
    ): Promise<{ success: boolean; data: null; error?: string; code?: string }> =>
      ipcRenderer.invoke('agent-browser:tab', sessionId, command),
    toolbar: (
      sessionId: string,
      action: BrowserToolbarAction
    ): Promise<{
      success: boolean
      data: null
      error?: string
      code?: string
    }> => ipcRenderer.invoke('agent-browser:toolbar', sessionId, action),
    openUrl: (
      sessionId: string,
      address: string
    ): Promise<{
      success: boolean
      data: { url: string }
      error?: string
      code?: string
    }> => ipcRenderer.invoke('agent-browser:open-url', sessionId, address),
    /** 焦点在面板上时按的浏览器快捷键 */
    command: (
      sessionId: string,
      command: BrowserCommand
    ): Promise<{ success: boolean; data: null; error?: string; code?: string }> =>
      ipcRenderer.invoke('agent-browser:command', sessionId, command),
    /** 页内查找，传 null 收起 */
    find: (
      sessionId: string,
      query: { text: string; forward?: boolean; findNext?: boolean } | null
    ): Promise<{ success: boolean; data: null; error?: string; code?: string }> =>
      ipcRenderer.invoke('agent-browser:find', sessionId, query),
    /** 报告嵌入面板的位置；传 null 表示此刻不该显示 */
    setBounds: (
      bounds: { x: number; y: number; width: number; height: number } | null,
      sessionId?: string
    ): void => ipcRenderer.send('agent-browser:set-bounds', bounds, sessionId),
    /** 关掉当前页面 */
    close: (sessionId?: string): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('agent-browser:close', sessionId),
    /** 现在开着吗、哪一档模式 */
    getState: (
      sessionId?: string,
      restore = false
    ): Promise<{
      success: boolean
      data: {
        tabs: BrowserGroupState['tabs']
        activeTabId: string | null
        open: boolean
        mode: 'window' | 'embedded' | 'hidden'
        url: string
        navigation: BrowserNavigationState
      }
      error?: string
    }> => ipcRenderer.invoke('agent-browser:get-state', sessionId, restore)
  },

  agentV3: {
    /** 发起一轮。会自动恢复该 sessionId 此前的 transcript */
    execute: (args: {
      sessionId: string
      prompt: string
      mode?: 'agent' | 'ask'
      approvalMode?: 'ask' | 'auto-edit' | 'yolo'
      /** 思考程度。auto=不指定，随模型自己的默认；其余档位由模型自己声明 */
      thinkingLevel?: 'auto' | 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
      /** 「快速」：Codex 订阅走 priority 档，别的模型忽略 */
      fastMode?: boolean
      /** Cursor Context 档：auto 不发，256k / 500k */
      cursorContext?: 'auto' | '256k' | '500k'
      /** 技能沉淀档位。不传等于 ask（想沉淀时先问用户） */
      skillLearning?: 'off' | 'ask' | 'auto'
      /**
       * 允不允许 agent 拍编辑器画面（「设置 → AI 助手 → 隐私」那一档）。
       *
       * 不传等于**允许** —— 那是这一档的默认状态。关掉时主进程会把 `ue_screenshot`
       * 从这一轮的工具池里摘掉，试玩也不再截图。
       */
      editorScreenshotEnabled?: boolean
      /** 随这轮一起发的图片。pi 的 prompt(input, images?) 原生支持 */
      images?: Array<{ type: 'image'; data: string; mimeType: string }>
      /** 随这轮带的音视频（本地路径）。主进程决定传对象存储换链接，还是只给路径 */
      mediaFiles?: Array<{ filePath: string; fileName: string; kind: 'video' | 'audio' }>
      /**
       * 这条对话归属的 UE 工程（侧边栏分组用的那个戳）。
       *
       * 主进程只知道「谁连着」，不传它就只能拿当前连接当成「这个工程」——
       * 用户在 test222 下问「这是啥项目」会得到连着的那个工程的答案。
       */
      sessionProject?: {
        projectName: string
        projectPath?: string
        engineVersion?: string
      } | null
      /** 这条对话绑着的知识库。绑了主进程才给 search_notebook_sources 工具 */
      notebook?: { id: string; title?: string } | null
      /** 用户按下发送那一刻的编辑器状态（闪存）。null = 用户明确去掉了 */
      editorSnapshot?: EditorSnapshot | null
      /** 这条对话绑定的模型。不传就用执行记录里那份，都没有按全局默认绑定 */
      sessionModel?: { providerId: string; modelId: string }
    }) => ipcRenderer.invoke('agent-v3:execute', args),
    /** 从断点续跑（上一轮报错或中断时用），保留全部上下文 */
    continue: (args: {
      sessionId: string
      mode?: 'agent' | 'ask'
      sessionProject?: { projectName: string; projectPath?: string; engineVersion?: string } | null
      /** 不带的话续跑会退回默认的「每步都问」，而用户什么都没改过 */
      approvalMode?: 'ask' | 'auto-edit' | 'yolo'
      /** 对话此刻绑的模型；用户报错后换了模型再续跑，得用新的 */
      sessionModel?: { providerId: string; modelId: string }
    }) => ipcRenderer.invoke('agent-v3:continue', args),
    /**
     * 用户在界面上改了这条对话归属哪个工程（顶栏胶囊、侧边栏「归入工程 / 移出项目」）。
     *
     * 必须发这一条：归属的主人是主进程那张表，而随消息捎带的那份戳只在表里
     * 还空着时用来初始化。不发的话，对话发过第一条消息之后用户再改归属，
     * 主进程永远收不到 —— 胶囊上写着新工程，引擎命令还发往旧的那个。
     *
     * `project: null` = 移出项目。`sessionId` 是**内核** session id。
     */
    setSessionProject: (args: {
      sessionId: string
      project: { projectName: string; projectPath?: string; engineVersion?: string } | null
    }) => ipcRenderer.invoke('agent-v3:set-session-project', args),
    /** 运行中插话改方向。消息在当前轮结束后注入，不打断执行 */
    steer: (args: {
      sessionId: string
      message: string
      editorSnapshot?: EditorSnapshot | null
      /** 随这句插话一起带的图。这一轮的模型看不了图时它会照实说自己看不到，不换模型 */
      images?: Array<{ type: 'image'; data: string; mimeType: string }>
      /** 随这句插话带的音视频路径，主进程按正在跑的模型决定换链接还是只给路径 */
      mediaFiles?: Array<{ filePath: string; fileName: string; kind: 'video' | 'audio' }>
      /** 已经解析好的文档 / 表格正文 */
      contextText?: string
    }) => ipcRenderer.invoke('agent-v3:steer', args),
    /** 撤回一条还排着的插话。内核已经读走了就撤不回来，那时 success 为 false */
    cancelSteer: (args: { sessionId: string; steerId: string }) =>
      ipcRenderer.invoke('agent-v3:cancel-steer', args),
    /**
     * 抓一份此刻的编辑器状态（闪存）。
     *
     * 在用户**按下发送那一刻**调，抓到的东西随消息一起提交。跑着的内核 session 上提交
     * 东西时要带 `runningSessionId` —— 排队的和插的最终都落在那一轮上，
     * 必须和它盯着同一个工程。
     */
    captureEditorSnapshot: (args: {
      sessionProject?: { projectName: string; projectPath?: string; engineVersion?: string } | null
      runningSessionId?: string
    }) => ipcRenderer.invoke('agent-v3:editor-snapshot:capture', args),
    stop: (args: { sessionId: string }) => ipcRenderer.invoke('agent-v3:stop', args),
    /** 当前被 agent 独占的资产。界面上那个「AI 锁定了 N 个资产」读它 */
    locks: () => ipcRenderer.invoke('agent-v3:locks'),
    /** 目标模式（`/goal`）还没收齐的目标，输入框上方那一行 */
    goalState: (args: { sessionId: string }) => ipcRenderer.invoke('agent-v3:goal-state', args),
    goalEnd: (args: { sessionId: string }) => ipcRenderer.invoke('agent-v3:goal-end', args),
    /** 工作室模式（`/team`）的任务板面板：名册、任务、留言、验收结论 */
    teamState: (args: { sessionId: string }) => ipcRenderer.invoke('agent-v3:team-state', args),
    /** 「外部团队」页：Claude Code 当大脑的那些团队 */
    externalTeams: () => ipcRenderer.invoke('agent-v3:external-teams'),
    teamTaskReopen: (args: { sessionId: string; taskId: string }) =>
      ipcRenderer.invoke('agent-v3:team-task-reopen', args),
    teamJobReopen: (args: { sessionId: string; jobId: string }) =>
      ipcRenderer.invoke('agent-v3:team-job-reopen', args),
    teamMemberModel: (args: {
      sessionId: string
      name: string
      providerId: string
      modelId: string
    }) => ipcRenderer.invoke('agent-v3:team-member-model', args),
    teamMemberDismiss: (args: { sessionId: string; name: string; reason: string }) =>
      ipcRenderer.invoke('agent-v3:team-member-dismiss', args),
    teamEnd: (args: { sessionId: string }) => ipcRenderer.invoke('agent-v3:team-end', args),
    /** 设置「团队」页：模型档案、重新检测 */
    teamModels: () => ipcRenderer.invoke('agent-v3:team-models'),
    teamModelCheckup: (args: { providerId: string; modelId: string }) =>
      ipcRenderer.invoke('agent-v3:team-model-checkup', args),
    /**
     * 全部强制解锁 —— 逃生口。
     *
     * 锁一旦因为 bug 卡死，用户的感受是「盒子把我工程搞坏了」而不是
     * 「有个 bug」。必须永远留一个看得见、点得到的出口。
     */
    releaseAllLocks: () => ipcRenderer.invoke('agent-v3:locks-release-all'),
    /** 改某条对话的审批档位（`sessionId` 传它当前的内核 session id）。运行中也立刻生效，下一个工具调用就按新档位走 */
    setApprovalMode: (args: {
      sessionId: string
      approvalMode: 'ask' | 'auto-edit' | 'yolo'
      mode?: 'agent' | 'ask'
    }) => ipcRenderer.invoke('agent-v3:set-approval-mode', args),
    /** 回复工具审批弹窗 */
    replyApproval: (args: {
      toolCallId: string
      verdict: 'approve' | 'always' | 'forever' | 'reject'
    }): void => {
      ipcRenderer.send('agent-v3:approval-reply', args)
    },
    /**
     * 回复 agent 的反问。
     *
     * 三态而不是「答了/没答」：`accept` 是选了，`decline` 是「你自己定」，
     * `cancel` 是把卡片关了。后两者对模型的指示正好相反 —— 一个让它带着假设继续，
     * 一个让它停下来等人。见 `main/agent-v3/host/questionChannel.ts`。
     */
    replyQuestion: (args: {
      toolCallId: string
      action: 'accept' | 'decline' | 'cancel'
      /** 与提问同序，空串表示这一问没选。只在 accept 时有意义 */
      answers?: string[]
    }): void => {
      ipcRenderer.send('agent-v3:question-reply', args)
    },
    /**
     * 刷新页面后重新接回还在跑的内核 session。
     *
     * agent 跑在主进程，刷新只重启了界面 —— 报上界面记得的内核 session id，
     * 主进程回哪些真的还活着（顺带补发卡在那儿的审批弹窗）。
     */
    reattach: (args: { sessionIds?: string[] }) => ipcRenderer.invoke('agent-v3:reattach', args),
    listSessions: () => ipcRenderer.invoke('agent-v3:list-sessions'),
    /** 技能清单。输入框的 / 菜单和「技能」设置页共用，含来源和开关状态 */
    listSkills: () => ipcRenderer.invoke('agent-v3:list-skills'),
    /** 详情弹窗：读 SKILL.md 全文（含 frontmatter） */
    readSkill: (name: string) => ipcRenderer.invoke('agent-v3:read-skill', name),
    /** 详情弹窗：写回正文。内置/插件带的会另存成用户副本 */
    writeSkill: (args: { name: string; content: string }) =>
      ipcRenderer.invoke('agent-v3:write-skill', args),
    /** 关掉 / 打开一个技能，控制它加不加载 */
    setSkillDisabled: (args: { name: string; disabled: boolean }) =>
      ipcRenderer.invoke('agent-v3:set-skill-disabled', args),
    /** 删掉用户自己那几条技能。内置和插件带的删不掉，主进程会拒 */
    deleteSkills: (names: string[]) => ipcRenderer.invoke('agent-v3:delete-skills', names),
    /** 技能页「经验」分组：通用层 + 项目库里各工程的经验，附上次整理的摘要 */
    listExperiences: () => ipcRenderer.invoke('agent-v3:list-experiences'),
    /** 固定保留一条经验（不被自动淘汰），或取消 */
    setExperiencePinned: (args: { ref: ExperienceRefArg; pinned: boolean }) =>
      ipcRenderer.invoke('agent-v3:set-experience-pinned', args),
    deleteExperience: (ref: ExperienceRefArg) =>
      ipcRenderer.invoke('agent-v3:delete-experience', ref),
    /** 撤销上次整理：各目录回到那次整理之前 */
    undoLastCuration: () => ipcRenderer.invoke('agent-v3:undo-last-curation'),
    /** 工具名 → 风险等级，渲染层算「本轮改动」用 */
    toolRisks: () => ipcRenderer.invoke('agent-v3:tool-risks'),
    /** 「设置 → 工具」那一页的清单，含第三方 MCP */
    listTools: () => ipcRenderer.invoke('agent-v3:list-tools'),

    /** 当前绑定的模型支持哪几档思考。档位各家不同，输入框那个下拉据此列清单 */
    thinkingLevels: (args?: { model?: { providerId: string; modelId: string } }) =>
      ipcRenderer.invoke('agent-v3:thinking-levels', args),
    /** 这条对话绑定的模型（执行记录里那份）。没绑过为 null */
    sessionModel: (args: { sessionId: string }) =>
      ipcRenderer.invoke('agent-v3:session-model', args),
    /** 在编辑器里打开「本轮改动」列出的那个资产 —— 清单说不清材质长什么样，眼见为实 */
    openAsset: (args: { contentPath: string }) => ipcRenderer.invoke('agent-v3:open-asset', args),
    /** 审查本轮改动：问引擎「这些资产现在到底是什么状态」 */
    reviewChanges: (args: { targets: AgentReviewTarget[] }) =>
      ipcRenderer.invoke('agent-v3:review-changes', args),
    /** 侧边问一句：把上下文复制一份给小窗口，主对话跑着也能分 */
    forkForSideQuestion: (args: { sessionId: string }) =>
      ipcRenderer.invoke('agent-v3:fork-for-side-question', args),
    /** 资产快照原型：只给真机验证脚本用，界面不要接 */
    snapshot: {
      capture: (args: {
        projectDir: string
        sessionId: string
        contentPath: string
        maxBytes?: number
      }) => ipcRenderer.invoke('agent-v3:snapshot:capture', args),
      restore: (args: { entry: unknown }) => ipcRenderer.invoke('agent-v3:snapshot:restore', args)
    },
    loadSession: (args: { sessionId: string }) => ipcRenderer.invoke('agent-v3:load-session', args),
    deleteSession: (args: { sessionId: string }) =>
      ipcRenderer.invoke('agent-v3:delete-session', args),
    /** 分支：复制成一个新 sessionId；带 keepUserTurns 就只复制到那一轮为止 */
    forkSession: (args: { sessionId: string; keepUserTurns?: number }) =>
      ipcRenderer.invoke('agent-v3:fork-session', args),
    /** 把 transcript 截回前 keepUserTurns 个用户轮次 —— 重新生成 / 编辑消息用 */
    truncateSession: (args: { sessionId: string; keepUserTurns: number }) =>
      ipcRenderer.invoke('agent-v3:truncate-session', args),
    /** 手动压缩上下文：把早期对话换成一段摘要，腾出窗口 */
    compact: (args: { sessionId: string }) => ipcRenderer.invoke('agent-v3:compact', args),
    /** AI 设置改动后调用，让下次执行重建 Provider */
    invalidateProviders: () => ipcRenderer.invoke('agent-v3:invalidate-providers'),
    /** pi 内核可用性诊断 */
    smoke: () => ipcRenderer.invoke('agent-v3:smoke'),
    /*
     * 插件（装上来的能力包）**刻意没有渲染层入口**。
     *
     * 机制在 `agent-v3/capabilities/plugins/registry.ts` 里是通的（插件的技能进
     * 发现路径、插件的 mcp.json 会被连上），但清单里那组权限声明从来没有被展示
     * 也没有被约束 —— 于是「从文件夹安装」实际上等于「下次起内核 session 时照那个
     * mcp.json 写的命令拉一个子进程」，全程不问用户。在补出安装确认之前，
     * 不给这条链任何 IPC 入口：一个没人调用的 `plugins.install(dir)` 挂在
     * `window.api` 上，本身就是可以被利用的面。
     */
    /** 接入第三方 MCP server */
    mcp: {
      getSettings: () => ipcRenderer.invoke('agent-v3:mcp:get-settings'),
      saveSettings: (args: { settings: unknown }) =>
        ipcRenderer.invoke('agent-v3:mcp:save-settings', args),
      reconnect: () => ipcRenderer.invoke('agent-v3:mcp:reconnect'),
      /** 删一条 server 并当场落盘。不碰别的行，也不提交表单里未保存的编辑 */
      removeServer: (args: { id: string }) =>
        ipcRenderer.invoke('agent-v3:mcp:remove-server', args),
      /** 存一条 server 并重连。`renamedFrom` 非空时顺手删掉旧名字那条 */
      saveServer: (args: { id: string; config: unknown; renamedFrom?: string }) =>
        ipcRenderer.invoke('agent-v3:mcp:save-server', args),
      /** 已连接项目的「UE 5.8 官方 MCP」开启状态 */
      epicStatus: () => ipcRenderer.invoke('agent-v3:mcp:epic-status'),
      /** 一键给某个项目开启 UE 5.8 官方 MCP */
      epicSetup: (args: { connectionId: string }) =>
        ipcRenderer.invoke('agent-v3:mcp:epic-setup', args),
      /** 官方 Blender Lab MCP 的前置依赖与配置状态 */
      blenderStatus: () => ipcRenderer.invoke('agent-v3:mcp:blender-status'),
      /** 一键装官方 Blender Lab MCP 并写进配置 */
      blenderSetup: (args: { blenderPath?: string } = {}) =>
        ipcRenderer.invoke('agent-v3:mcp:blender-setup', args),
      /** 用 winget 装 Blender 接入缺的 Git / Python */
      blenderInstallPrereqs: (args: { ids: Array<'git' | 'python'> }) =>
        ipcRenderer.invoke('agent-v3:mcp:blender-install-prereqs', args)
    },
    /** 把虚幻引擎能力对外暴露成 MCP server */
    mcpServer: {
      start: (args: { namespaces?: string[]; includeMutating?: boolean; port?: number }) =>
        ipcRenderer.invoke('agent-v3:mcp-server:start', args),
      stop: () => ipcRenderer.invoke('agent-v3:mcp-server:stop'),
      status: () => ipcRenderer.invoke('agent-v3:mcp-server:status'),
      /** 换新令牌，旧的客户端配置随即失效 */
      rotateToken: () => ipcRenderer.invoke('agent-v3:mcp-server:rotate-token'),
      /** 写进 Claude Code / Codex 的用户级配置，服务没开就一起开 */
      installClient: (client: 'claude-code' | 'codex') =>
        ipcRenderer.invoke('agent-v3:mcp-server:install-client', client),
      /** 保存端口 / 暴露范围；运行中变更会自动重启服务 */
      saveConfig: (args: { port?: number; includeMutating?: boolean }) =>
        ipcRenderer.invoke('agent-v3:mcp-server:save-config', args)
    }
  },
  /**
   * 服务端资产库（新后端 asset-catalog）。通道全部是 catalogLibrary:*，
   * 返回 { success, data?, error?, errorCode? }；令牌从不经过这里。
   */
  catalogLibrary: {
    list: () => ipcRenderer.invoke('catalogLibrary:list'),
    servers: () => ipcRenderer.invoke('catalogLibrary:servers'),
    probe: (address: string, caFingerprint?: string | null, caPem?: string | null) =>
      ipcRenderer.invoke('catalogLibrary:probe', address, caFingerprint ?? null, caPem ?? null),
    connect: (input: unknown) => ipcRenderer.invoke('catalogLibrary:connect', input),
    remoteLibraries: (serverId: string) =>
      ipcRenderer.invoke('catalogLibrary:remoteLibraries', serverId),
    add: (serverId: string, libraries: Array<{ id: string; name: string }>) =>
      ipcRenderer.invoke('catalogLibrary:add', serverId, libraries),
    remove: (key: string) => ipcRenderer.invoke('catalogLibrary:remove', key),
    signIn: (serverId: string, input: unknown) =>
      ipcRenderer.invoke('catalogLibrary:signIn', serverId, input),
    signOut: (serverId: string) => ipcRenderer.invoke('catalogLibrary:signOut', serverId),
    setLoreRemote: (serverId: string, remote: string | null) =>
      ipcRenderer.invoke('catalogLibrary:setLoreRemote', serverId, remote),
    status: (key: string) => ipcRenderer.invoke('catalogLibrary:status', key),
    watch: (key: string) => ipcRenderer.invoke('catalogLibrary:watch', key),
    unwatch: (key: string) => ipcRenderer.invoke('catalogLibrary:unwatch', key),
    folders: (key: string, parent: number) =>
      ipcRenderer.invoke('catalogLibrary:folders', key, parent),
    folderByPath: (key: string, path: string) =>
      ipcRenderer.invoke('catalogLibrary:folderByPath', key, path),
    listWindow: (key: string, query: unknown, start: number, limit: number) =>
      ipcRenderer.invoke('catalogLibrary:listWindow', key, query, start, limit),
    facets: (key: string, query: unknown, fields?: string[], limit?: number) =>
      ipcRenderer.invoke('catalogLibrary:facets', key, query, fields, limit),
    detail: (key: string, id: number) => ipcRenderer.invoke('catalogLibrary:detail', key, id),
    probeAnnotations: (key: string) => ipcRenderer.invoke('catalogLibrary:probeAnnotations', key),
    editAnnotations: (key: string, ops: unknown[]) =>
      ipcRenderer.invoke('catalogLibrary:editAnnotations', key, ops),
    loreInfo: () => ipcRenderer.invoke('catalogLibrary:loreInfo'),
    listTags: (key: string) => ipcRenderer.invoke('catalogLibrary:listTags', key),
    putTag: (key: string, name: string, patch: unknown) =>
      ipcRenderer.invoke('catalogLibrary:putTag', key, name, patch),
    deleteTag: (key: string, name: string) =>
      ipcRenderer.invoke('catalogLibrary:deleteTag', key, name),
    searchFolders: (key: string, q: string, limit?: number, dir?: number) =>
      ipcRenderer.invoke('catalogLibrary:searchFolders', key, q, limit, dir),
    closure: (key: string, id: number) => ipcRenderer.invoke('catalogLibrary:closure', key, id),
    unclaimed: (key: string) => ipcRenderer.invoke('catalogLibrary:unclaimed', key),
    claim: (key: string, from: string, to: string) =>
      ipcRenderer.invoke('catalogLibrary:claim', key, from, to),
    favorites: (key: string) => ipcRenderer.invoke('catalogLibrary:favorites', key),
    setFavorite: (key: string, kind: 'asset' | 'folder', id: number, on: boolean) =>
      ipcRenderer.invoke('catalogLibrary:setFavorite', key, kind, id, on),
    download: (key: string, input: unknown) =>
      ipcRenderer.invoke('catalogLibrary:download', key, input),
    resolveRepository: (key: string, folder: { dirId: number; path: string }) =>
      ipcRenderer.invoke('catalogLibrary:resolveRepository', key, folder),
    import: (key: string, input: unknown) =>
      ipcRenderer.invoke('catalogLibrary:import', key, input),
    cancelJob: (jobId: string) => ipcRenderer.invoke('catalogLibrary:cancelJob', jobId),
    clearCache: (key?: string | null) =>
      ipcRenderer.invoke('catalogLibrary:clearCache', key ?? null),
    getActive: () => ipcRenderer.invoke('catalogLibrary:getActive'),
    setActive: (key: string | null) => ipcRenderer.invoke('catalogLibrary:setActive', key),
    pickFiles: () => ipcRenderer.invoke('catalogLibrary:pickFiles'),
    pickFolder: () => ipcRenderer.invoke('catalogLibrary:pickFolder'),
    pickCaFile: () => ipcRenderer.invoke('catalogLibrary:pickCaFile'),
    onEvent: (listener: (event: unknown) => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: unknown): void => listener(event)
      ipcRenderer.on('catalogLibrary:event', handler)
      return () => {
        ipcRenderer.removeListener('catalogLibrary:event', handler)
      }
    }
  },
  /**
   * 团队工程（版本控制与资产协作）。通道全部是 team:*，
   * 返回 { success, data?, error?, errorCode? }；令牌从不经过这里。
   * `call` 只认主进程路由表里有名字的动作（src/main/libraryV3/team/teamOps.ts）。
   */
  team: {
    join: (input: unknown) => ipcRenderer.invoke('team:join', input),
    peek: (link: unknown) => ipcRenderer.invoke('team:peek', link),
    parseLink: (raw: string) => ipcRenderer.invoke('team:parseLink', raw),
    pendingJoinLink: () => ipcRenderer.invoke('team:pendingJoinLink'),
    call: (key: string, op: string, args?: unknown) =>
      ipcRenderer.invoke('team:call', key, op, args ?? {}),
    facts: (key: string, hashes: string[], library?: string | null) =>
      ipcRenderer.invoke('team:facts', key, hashes, library ?? null),
    inviteLink: (key: string) => ipcRenderer.invoke('team:inviteLink', key),
    startStreams: () => ipcRenderer.invoke('team:startStreams'),
    restartStream: (serverId: string) => ipcRenderer.invoke('team:restartStream', serverId),
    streamState: (serverId: string) => ipcRenderer.invoke('team:streamState', serverId),
    localInfo: (key: string) => ipcRenderer.invoke('team:localInfo', key),
    freeSpace: (path: string) => ipcRenderer.invoke('team:freeSpace', path),
    inspectFolder: (path: string) => ipcRenderer.invoke('team:inspectFolder', path),
    syncToLocal: (key: string, input: unknown) =>
      ipcRenderer.invoke('team:syncToLocal', key, input),
    putIn: (key: string, input: unknown) => ipcRenderer.invoke('team:putIn', key, input),
    setFolderSynced: (key: string, folder: string, synced: boolean) =>
      ipcRenderer.invoke('team:setFolderSynced', key, folder, synced),
    restore: (key: string, input: unknown) => ipcRenderer.invoke('team:restore', key, input),
    isModified: (key: string, path: string) => ipcRenderer.invoke('team:isModified', key, path),
    cancelCheckout: (key: string, input: unknown) =>
      ipcRenderer.invoke('team:cancelCheckout', key, input),
    deliver: (key: string, input: unknown) => ipcRenderer.invoke('team:deliver', key, input),
    approveDelivery: (key: string, input: unknown) =>
      ipcRenderer.invoke('team:approveDelivery', key, input),
    sendReference: (key: string, input: unknown) =>
      ipcRenderer.invoke('team:sendReference', key, input),
    openPath: (path: string) => ipcRenderer.invoke('team:openPath', path),
    notify: (input: unknown) => ipcRenderer.invoke('team:notify', input),
    onEvent: (listener: (event: unknown) => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: unknown): void => listener(event)
      ipcRenderer.on('team:event', handler)
      return () => {
        ipcRenderer.removeListener('team:event', handler)
      }
    }
  },
  /**
   * 共享技能（官网共享库）。通道全部是 share:*，返回 { success, data?, error? }。
   * 安装请求由主进程推过来（onInstallRequest），用户在确认框里决定后用 installReply 回复。
   */
  share: {
    pendingInstalls: () => ipcRenderer.invoke('share:pending-installs'),
    installReply: (requestId: string, approve: boolean) =>
      ipcRenderer.invoke('share:install-reply', requestId, approve),
    packSkill: (name: string) => ipcRenderer.invoke('share:pack-skill', name),
    submitSkill: (name: string) => ipcRenderer.invoke('share:submit-skill', name),
    connect: () => ipcRenderer.invoke('share:connect'),
    cancelConnect: () => ipcRenderer.invoke('share:cancel-connect'),
    onConnectPrompt: (listener: (prompt: unknown) => void) => {
      const handler = (_: Electron.IpcRendererEvent, prompt: unknown): void => listener(prompt)
      ipcRenderer.on('share:connect-prompt', handler)
      return () => {
        ipcRenderer.removeListener('share:connect-prompt', handler)
      }
    },
    openPage: (url: string) => ipcRenderer.invoke('share:open-page', url),
    onInstallRequest: (listener: (request: unknown) => void) => {
      const handler = (_: Electron.IpcRendererEvent, request: unknown): void => listener(request)
      ipcRenderer.on('share:install-request', handler)
      return () => {
        ipcRenderer.removeListener('share:install-request', handler)
      }
    },
    onInstallFailed: (listener: (failure: unknown) => void) => {
      const handler = (_: Electron.IpcRendererEvent, failure: unknown): void => listener(failure)
      ipcRenderer.on('share:install-failed', handler)
      return () => {
        ipcRenderer.removeListener('share:install-failed', handler)
      }
    }
  },
  /**
   * 通用事件监听器 - 监听主进程发送的事件
   */
  on: (channel: string, listener: (...args: any[]) => void) => {
    assertChannelAllowed(channel, GENERIC_EVENT_CHANNELS, 'api.on')
    const handler = (_: Electron.IpcRendererEvent, ...args: any[]) => listener(...args)
    ipcRenderer.on(channel, handler)
    return handler
  },
  /**
   * 通用事件移除 - 移除事件监听器
   */
  off: (channel: string, handler: (...args: any[]) => void) => {
    assertChannelAllowed(channel, GENERIC_EVENT_CHANNELS, 'api.off')
    ipcRenderer.removeListener(channel, handler)
  },
  projectTemplate: {
    list: () => ipcRenderer.invoke('projectTemplate:list'),
    createFromTemplate: (params: {
      templatePath: string
      targetDir: string
      projectName: string
    }) => ipcRenderer.invoke('projectTemplate:createFromTemplate', params),
    addCustomTemplate: (params: { sourceProjectPath: string; templateName: string }) =>
      ipcRenderer.invoke('projectTemplate:addCustomTemplate', params),
    /** 列出社区模板源 */
    listSources: () => ipcRenderer.invoke('projectTemplate:listSources'),
    /** 启用 / 禁用一个源。启用之前不会发出任何网络请求 */
    setSourceEnabled: (params: { id: string; enabled: boolean }) =>
      ipcRenderer.invoke('projectTemplate:setSourceEnabled', params),
    /** 添加自定义源 */
    addSource: (params: { name: string; url: string }) =>
      ipcRenderer.invoke('projectTemplate:addSource', params),
    /** 删除自定义源（内置源不可删） */
    removeSource: (params: { id: string }) =>
      ipcRenderer.invoke('projectTemplate:removeSource', params),
    /** 抓取所有已启用源的清单 */
    fetchCommunity: () => ipcRenderer.invoke('projectTemplate:fetchCommunity'),
    /** 下载一条社区模板到本地模板库 */
    downloadCommunity: (params: { sourceId: string; template: unknown }) =>
      ipcRenderer.invoke('projectTemplate:downloadCommunity', params),
    /** 取消一个进行中的下载 */
    cancelDownload: (params: { sourceId: string; templateId: string }) =>
      ipcRenderer.invoke('projectTemplate:cancelDownload', params),
    /** 订阅下载进度，返回取消订阅函数 */
    onDownloadProgress: (
      listener: (payload: {
        sourceId: string
        templateId: string
        received: number
        total: number
        percent: number
      }) => void
    ) => {
      const handler = (_: Electron.IpcRendererEvent, payload: any): void => listener(payload)
      ipcRenderer.on('projectTemplate:downloadProgress', handler)
      return () => ipcRenderer.removeListener('projectTemplate:downloadProgress', handler)
    }
  },
  /**
   * Epic Launcher 引擎项目读取 API
   */
  epic: {
    /**
     * 获取所有引擎版本的最近打开项目列表
     */
    getRecentProjects: () => ipcRenderer.invoke('epic:getRecentProjects')
  },
  projectImport: {
    checkCompatibility: (
      project: { EngineAssociation?: string | null },
      sources: Array<{ assetKey?: string }>
    ) => ipcRenderer.invoke('project:checkImportCompatibility', project, sources),
    importUAssets: (project: unknown, source: unknown) =>
      ipcRenderer.invoke('project:importUAssets', project, source),
    /**
     * 整个文件夹一次导完。
     * 主进程内部走「规划串行 + 拷贝并发」的流水线，整批共用依赖解析状态
     */
    importUAssetsBatch: (
      project: unknown,
      sources: unknown[],
      options?: { requestId?: string; ignoreEngineVersion?: boolean }
    ) => ipcRenderer.invoke('project:importUAssetsBatch', project, sources, options),
    /** 把插件写进工程的 .uproject（用户在弹窗里确认过的） */
    enablePlugins: (project: unknown, names: string[]) =>
      ipcRenderer.invoke('project:enablePlugins', project, names),
    /** 中止一批正在跑的导入；正在拷的那个文件会写完 */
    cancelImportUAssetsBatch: (requestId: string) =>
      ipcRenderer.invoke('project:importUAssetsBatch:cancel', requestId),
    /** 订阅批量导入进度，返回取消订阅函数 */
    onImportUAssetsBatchProgress: (
      listener: (payload: {
        requestId: string
        processed: number
        total: number
        succeeded: number
        existing: number
        failed: number
        currentName: string
        filesCopied: number
        filesQueued: number
        bytesCopied: number
        bytesTotal: number
        cancelled: boolean
      }) => void
    ) => {
      const handler = (_: Electron.IpcRendererEvent, payload: any): void => listener(payload)
      ipcRenderer.on('project:importUAssetsBatch:progress', handler)
      return () => ipcRenderer.removeListener('project:importUAssetsBatch:progress', handler)
    },
    /**
     * 通过 UE 插件导入外部文件（FBX/GLB/PNG 等）
     * 这些文件需要通过 UE 的 Import API 正确导入，而不是直接复制到 Content 目录
     */
    importExternalFiles: (params: {
      files: string[]
      destinationPath?: string
      overwrite?: boolean
    }) => ipcRenderer.invoke('project:importExternalFiles', params),
    /**
     * 规范化导入 uasset/umap 资产到 UE 项目
     * 通过 UE 插件的 content.normalized_import 命令实现
     * 自动处理依赖闭包、包名重映射和引用修复，将资产导入到规范化的目录结构中
     * @param params.files - 要导入的 uasset/umap 文件路径列表
     * @param params.targetRoot - 目标根目录，默认 /Game/Imported
     * @param params.usePascalCase - 是否使用 PascalCase 命名，默认 true
     * @param params.autoRenameOnConflict - 冲突时是否自动重命名，默认 true
     */
    normalizedImportAssets: (params: {
      files: string[]
      targetRoot?: string
      usePascalCase?: boolean
      autoRenameOnConflict?: boolean
    }) => ipcRenderer.invoke('project:normalizedImportAssets', params),
    /**
     * 把 zip 素材包解进工程的 Content 目录
     */
    extractArchiveToProject: (params: { zipPath: string; projectPath: string }) =>
      ipcRenderer.invoke('project:extractArchiveToProject', params)
  },
  /**
   * uebox 命令行。随安装包发，跑在盒子外面 —— 这里只回答「它在哪」
   * 和「要不要加进 PATH」。
   */
  cli: {
    status: () => ipcRenderer.invoke('cli:status'),
    addToPath: () => ipcRenderer.invoke('cli:add-to-path'),
    removeFromPath: () => ipcRenderer.invoke('cli:remove-from-path'),
    reveal: () => ipcRenderer.invoke('cli:reveal')
  },
  /**
   * 对象存储（用户自己的 S3 兼容桶）。对话里的音视频传上去换链接，模型直接看。
   * Secret 只进不出：读配置只回 `hasSecret`
   */
  objectStorage: {
    get: () => ipcRenderer.invoke('object-storage:get'),
    save: (input: unknown) => ipcRenderer.invoke('object-storage:save', input),
    test: (input: unknown) => ipcRenderer.invoke('object-storage:test', input),
    ready: () => ipcRenderer.invoke('object-storage:ready'),
    list: () => ipcRenderer.invoke('object-storage:list'),
    remove: (keys: string[]) => ipcRenderer.invoke('object-storage:remove', keys),
    clean: (days: number) => ipcRenderer.invoke('object-storage:clean', days),
    upload: (filePath: string) => ipcRenderer.invoke('object-storage:upload', filePath),
    onUploadProgress: (
      callback: (payload: { filePath: string; percent: number; note: string }) => void
    ): (() => void) => {
      const listener = (
        _e: unknown,
        payload: { filePath: string; percent: number; note: string }
      ): void => callback(payload)
      ipcRenderer.on('object-storage:upload-progress', listener)
      return () => ipcRenderer.removeListener('object-storage:upload-progress', listener)
    }
  },
  updater: {
    /**
     * 检查更新
     */
    checkForUpdates: () => ipcRenderer.invoke('updater:check-for-updates'),
    /**
     * 下载更新（不会自动开始，要用户确认过）
     */
    downloadUpdate: () => ipcRenderer.invoke('updater:download-update'),
    /**
     * 退出并安装更新
     */
    quitAndInstall: () => ipcRenderer.invoke('updater:quit-and-install'),
    /**
     * 获取更新状态
     */
    getStatus: () => ipcRenderer.invoke('updater:get-status'),
    /**
     * 监听更新事件
     */
    onUpdateChecking: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('updater:update-checking', handler)
      return () => ipcRenderer.removeListener('updater:update-checking', handler)
    },
    /**
     * 监听更新可用事件
     */
    onUpdateAvailable: (callback: (data: { version: string }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: any) => callback(data)
      ipcRenderer.on('updater:update-available', handler)
      return () => ipcRenderer.removeListener('updater:update-available', handler)
    },
    /**
     * 监听更新不可用事件
     */
    onUpdateNotAvailable: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('updater:update-not-available', handler)
      return () => ipcRenderer.removeListener('updater:update-not-available', handler)
    },
    /**
     * 监听下载进度事件
     */
    onDownloadProgress: (
      callback: (data: { percent: number; transferred: number; total: number }) => void
    ) => {
      const handler = (_: Electron.IpcRendererEvent, data: any) => callback(data)
      ipcRenderer.on('updater:update-download-progress', handler)
      return () => ipcRenderer.removeListener('updater:update-download-progress', handler)
    },
    /**
     * 监听更新下载完成事件
     */
    onUpdateDownloaded: (callback: (data: { version: string }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: any) => callback(data)
      ipcRenderer.on('updater:update-downloaded', handler)
      return () => ipcRenderer.removeListener('updater:update-downloaded', handler)
    },
    /**
     * 监听更新错误事件
     */
    onUpdateError: (callback: (data: { message: string; code?: string }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: any) => callback(data)
      ipcRenderer.on('updater:update-error', handler)
      return () => ipcRenderer.removeListener('updater:update-error', handler)
    }
  },
  /**
   * WebSocket 服务 API
   * 用于与 Unreal Engine 实例通讯
   */
  websocket: {
    /**
     * 启动 WebSocket 服务器
     */
    start: (port?: number) => ipcRenderer.invoke('ws:start', port),
    /**
     * 停止 WebSocket 服务器
     */
    stop: () => ipcRenderer.invoke('ws:stop'),
    /**
     * 获取服务状态
     */
    getStatus: () => ipcRenderer.invoke('ws:status'),
    /**
     * 获取连接列表
     */
    getConnections: () => ipcRenderer.invoke('ws:connections'),
    /**
     * 发送事件（单向通知）
     */
    emit: (method: string, payload: unknown, clientId?: string) =>
      ipcRenderer.invoke('ws:emit', method, payload, clientId),
    /**
     * 发送请求（RPC 模式）
     */
    call: <T>(method: string, payload: unknown, clientId?: string, timeout?: number): Promise<T> =>
      ipcRenderer.invoke('ws:call', method, payload, clientId, timeout),
    /**
     * 监听来自 UE 的事件
     */
    onEvent: (
      callback: (data: { method?: string; payload: unknown; clientId?: string }) => void
    ) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        data: { method?: string; payload: unknown; clientId?: string }
      ) => callback(data)
      ipcRenderer.on('ws:event', handler)
      return () => ipcRenderer.removeListener('ws:event', handler)
    },
    /**
     * 监听连接变化
     */
    onConnectionChange: (
      callback: (data: { clientId: string; connected: boolean; payload?: unknown }) => void
    ) => {
      const handler = (
        _: Electron.IpcRendererEvent,
        data: { clientId: string; connected: boolean; payload?: unknown }
      ) => callback(data)
      ipcRenderer.on('ws:connection-change', handler)
      return () => ipcRenderer.removeListener('ws:connection-change', handler)
    },
    /**
     * 获取所有已连接的工程列表
     */
    getProjects: () => ipcRenderer.invoke('ws:projects'),
    /**
     * 获取指定连接的工程信息
     */
    getProject: (connectionId: string) => ipcRenderer.invoke('ws:project:get', connectionId),
    /**
     * 监听工程列表变化
     */
    onProjectsChanged: (callback: (projects: unknown[]) => void) => {
      const handler = (_: Electron.IpcRendererEvent, projects: unknown[]) => callback(projects)
      ipcRenderer.on('ws:projects-changed', handler)
      return () => ipcRenderer.removeListener('ws:projects-changed', handler)
    },
    /**
     * 监听桥接自身的状态变化（起来了 / 起不来 / 被停掉），返回退订函数。
     *
     * 和 `onProjectsChanged` 是两回事：那个说的是「哪些工程此刻连着」，
     * 这个说的是「盒子这一侧的服务在不在」。只在挂载时问一次 `getStatus()` 的话，
     * 用户修好端口冲突重启桥接后提示还挂着，运行中桥接挂掉则根本不提示。
     */
    onStatusChanged: (callback: (status: BridgeStatusPayload) => void) => {
      // 通道里送的是**整个**状态对象（`broadcastStatus()` 发的就是 getStatus()），
      // 这里原来把类型窄成只有 startError，于是设置页想显示端口都拿不到
      const handler = (_: Electron.IpcRendererEvent, status: BridgeStatusPayload): void =>
        callback(status)
      ipcRenderer.on('ws:status-changed', handler)
      return () => ipcRenderer.removeListener('ws:status-changed', handler)
    }
  },
  /**
   * 蓝图预览 API
   * 用于接收 Agent 发送的蓝图规划数据
   */
  blueprintPreview: {
    /**
     * 监听蓝图规划预览事件
     */
    onPreview: (callback: (plan: unknown) => void) => {
      const handler = (_: Electron.IpcRendererEvent, plan: unknown) => callback(plan)
      ipcRenderer.on('blueprint-plan:preview', handler)
      return () => ipcRenderer.removeListener('blueprint-plan:preview', handler)
    }
  },
  /**
   * 命名规则配置 API
   */
  namingRules: {
    /**
     * 加载配置
     */
    loadConfig: () => ipcRenderer.invoke('namingRules:loadConfig'),
    /**
     * 保存配置。配置本体 + `removedKeys`（这一轮在设置页点掉的出厂键）。
     *
     * 类型不能写成 `NamingRulesConfig`：删除就只剩结构化克隆在运行期把它带过去，
     * 哪天少报一份，类型上一点痕迹都没有 —— 而少报的后果是用户删不掉那一行。
     */
    saveConfig: (config: NamingRulesSavePayload) =>
      ipcRenderer.invoke('namingRules:saveConfig', config),
    /**
     * 重置配置
     */
    resetConfig: () => ipcRenderer.invoke('namingRules:resetConfig')
  },
  ai: {
    chatCompletion: (args: Record<string, unknown>) =>
      ipcRenderer.invoke('ai:chat-completion', args),
    /**
     * 这个角色实际会用哪个模型、它的窗口有多大。
     * 渲染层拿它来算「这次能往模型里送多少材料」。
     */
    modelLimits: (args?: { role?: string; level?: string }) =>
      ipcRenderer.invoke('ai:model-limits', args ?? {}),
    /**
     * 流式补全。
     *
     * 增量走事件而不是这个 Promise 的返回值 —— invoke 是一次性的，没法边算边出。
     * 调用方先用 onStreamChunk / onStreamDone / onStreamError 挂上监听再发起。
     */
    chatStream: (args: Record<string, unknown>) => ipcRenderer.invoke('ai:chat-stream', args),
    abortStream: (sessionId: string) => ipcRenderer.invoke('ai:chat-stream-abort', { sessionId }),
    onStreamChunk: (callback: (payload: { sessionId: string; delta: string }) => void) => {
      const listener = (_e: unknown, payload: { sessionId: string; delta: string }): void =>
        callback(payload)
      ipcRenderer.on('ai:stream-chunk', listener)
      return () => ipcRenderer.removeListener('ai:stream-chunk', listener)
    },
    onStreamDone: (
      callback: (payload: {
        sessionId: string
        text: string
        aborted: boolean
        /** 本轮 token 用量。厂商不报用量时没有这个字段 */
        usage?: AgentTurnUsage
      }) => void
    ) => {
      const listener = (
        _e: unknown,
        payload: { sessionId: string; text: string; aborted: boolean; usage?: AgentTurnUsage }
      ): void => callback(payload)
      ipcRenderer.on('ai:stream-done', listener)
      return () => ipcRenderer.removeListener('ai:stream-done', listener)
    },
    onStreamError: (callback: (payload: { sessionId: string; message: string }) => void) => {
      const listener = (_e: unknown, payload: { sessionId: string; message: string }): void =>
        callback(payload)
      ipcRenderer.on('ai:stream-error', listener)
      return () => ipcRenderer.removeListener('ai:stream-error', listener)
    },
    /**
     * 用户自己配的「生图」模型出图。
     *
     * 与 chatCompletion 同一条路：密钥不进渲染层，所以生成必须在主进程发起。
     * 图片以 base64 回来，不是外链。
     * providerId/modelId 可覆盖全局「生图」绑定，供信息图等需要逐次选模型的入口使用。
     */
    generateImage: (args: Record<string, unknown>) => ipcRenderer.invoke('ai:image-generate', args),
    /** 绑没绑生图模型、绑的是哪个。不发网络请求，可以随便调 */
    imageModelStatus: () => ipcRenderer.invoke('ai:image-model-status')
  },
  /**
   * AIGC 生图任务。
   *
   * 历史、删除、启动那几条走 `window.electron.ipcRenderer`（见 RAW_REQUEST_CHANNELS），
   * 取消单独走这里：它不需要让渲染层拿到一条可以随便 send 的裸通道。
   */
  imageGeneration: {
    /** 掐断正在出图的那条任务：中止请求、停掉进度模拟、把库里的记录置为失败 */
    cancelTask: (taskId: string) => ipcRenderer.invoke('image:cancelTask', taskId)
  },
  /**
   * 本地直连 Provider 配置。
   *
   * 密钥是**单向**的：可以写进去，读不回来。get-settings 返回的 provider
   * 只带 `hasKey: boolean`，明文既不进渲染层也不进 models.json。
   */
  speech: {
    synthesize: (request: import('../shared/speech').SpeechRequest) =>
      ipcRenderer.invoke('speech:synthesize', request),
    cancel: (requestId: string) => ipcRenderer.invoke('speech:cancel', requestId),
    onChunk: (callback: (chunk: import('../shared/speech').SpeechChunk) => void) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        chunk: import('../shared/speech').SpeechChunk
      ): void => callback(chunk)
      ipcRenderer.on('speech:chunk', handler)
      return () => ipcRenderer.removeListener('speech:chunk', handler)
    }
  },
  aiProvider: {
    /** 内置厂商目录。纯静态数据，不联网 */
    catalog: () => ipcRenderer.invoke('ai-provider:catalog'),
    getSettings: () => ipcRenderer.invoke('ai-provider:get-settings'),
    saveProvider: (draft: unknown) => ipcRenderer.invoke('ai-provider:save-provider', draft),
    deleteProvider: (providerId: string) =>
      ipcRenderer.invoke('ai-provider:delete-provider', providerId),
    setEnabled: (providerId: string, enabled: boolean) =>
      ipcRenderer.invoke('ai-provider:set-enabled', providerId, enabled),
    /** 正在跑的对话里有几个用着这个服务商。删之前问 */
    usage: (providerId: string) => ipcRenderer.invoke('ai-provider:usage', providerId),
    setRoles: (patch: unknown) => ipcRenderer.invoke('ai-provider:set-roles', patch),
    /** 连通性测试。用草稿而不是已存配置，让用户存盘前就能验 */
    test: (draft: unknown, modelId: string) =>
      ipcRenderer.invoke('ai-provider:test', draft, modelId),
    listModels: (draft: unknown) => ipcRenderer.invoke('ai-provider:list-models', draft),
    revealConfig: () => ipcRenderer.invoke('ai-provider:reveal-config'),
    /**
     * 用系统浏览器走一次 OAuth。
     *
     * 必须把 `draft` 一起传过去：拿到的是会过期的令牌时（ChatGPT、Kimi），
     * 主进程要**直接把整个 provider 落盘**（令牌不能进渲染层），那一步需要
     * 用户当前编辑的这份草稿。少传这个参数主进程会拿到 undefined。
     */
    oauthLogin: (oauthProvider: string, draft: unknown) =>
      ipcRenderer.invoke('ai-provider:oauth-login', oauthProvider, draft),
    /** 放弃正在等的那次登录，主进程停止监听回调 / 轮询 */
    oauthCancel: () => ipcRenderer.invoke('ai-provider:oauth-cancel'),
    /**
     * 设备码流程要显示给用户的那串码。
     *
     * 只能靠事件推 —— 码是在 `oauthLogin` 这次 invoke **还没返回**的时候产生的，
     * 用户得先拿着它去浏览器里输，那个 Promise 才会 resolve。
     */
    onOAuthDeviceCode: (
      listener: (prompt: {
        userCode: string
        verificationUri: string
        verificationUriComplete?: string
      }) => void
    ) => {
      const handler = (_: Electron.IpcRendererEvent, prompt: unknown): void =>
        listener(
          prompt as {
            userCode: string
            verificationUri: string
            verificationUriComplete?: string
          }
        )
      ipcRenderer.on('ai-provider:oauth-device-code', handler)
      return () => ipcRenderer.removeListener('ai-provider:oauth-device-code', handler)
    }
  },
  /** Box Plan：一把 Key 配好多个角色。没连接时这些调用都不联网 */
  creatorPlan: {
    state: () => ipcRenderer.invoke('creator-plan:state'),
    /** 设备授权。码通过 onDeviceCode 推过来；用户在浏览器里允许后才 resolve */
    connect: () => ipcRenderer.invoke('creator-plan:connect'),
    cancel: () => ipcRenderer.invoke('creator-plan:cancel'),
    preview: () => ipcRenderer.invoke('creator-plan:preview'),
    /** options.storage：导入预览里勾没勾「对象存储」；不传 = 不动对象存储 */
    apply: (roles: string[], options?: { storage?: boolean }) =>
      ipcRenderer.invoke('creator-plan:apply', roles, options),
    disconnect: () => ipcRenderer.invoke('creator-plan:disconnect'),
    /** 打开清单里的 manage_url。对话里的套餐错误提示用 */
    openManage: () => ipcRenderer.invoke('creator-plan:open-manage'),
    /** 活动状态（MegaJam）。没连接时不联网 */
    campaign: () => ipcRenderer.invoke('creator-plan:campaign'),
    /** 参赛登记，填 itch.io 主页 */
    claimCampaign: (itchUrl: string) => ipcRenderer.invoke('creator-plan:campaign-claim', itchUrl),
    /** 交卷，填 itch 作品页 */
    submitCampaignEntry: (entryUrl: string) =>
      ipcRenderer.invoke('creator-plan:campaign-submit', entryUrl),
    onDeviceCode: (listener: (prompt: { userCode: string; verificationUri: string }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, prompt: unknown): void =>
        listener(prompt as { userCode: string; verificationUri: string })
      ipcRenderer.on('creator-plan:device-code', handler)
      return () => ipcRenderer.removeListener('creator-plan:device-code', handler)
    }
  },
  /**
   * 网页读取 API
   * 给一个网址，回一段能进知识库的正文（图片/视频走视觉分析）
   */
  webRead: {
    /**
     * 读取网页内容
     * @param url - 要读取的网页 URL
     * @returns 网页内容结果
     */
    read: (
      url: string
    ): Promise<{
      success: boolean
      title?: string
      content?: string
      description?: string
      url?: string
      error?: string
    }> => ipcRenderer.invoke('web:read', url)
  },
  /**
   * 微信公众号文章采集 API
   * 用于读取微信公众号文章并转换为 Markdown
   */
  wechat: {
    /**
     * 读取微信公众号文章
     * @param url - 微信公众号文章 URL (mp.weixin.qq.com)
     * @returns 文章内容结果
     */
    read: (
      url: string
    ): Promise<{
      success: boolean
      title?: string
      content?: string
      author?: string
      publishTime?: string
      error?: string
    }> => ipcRenderer.invoke('wechat:read', url),
    /**
     * 验证是否为有效的微信公众号文章链接
     * @param url - 待验证的 URL
     */
    validate: (url: string): Promise<boolean> => ipcRenderer.invoke('wechat:validate', url)
  },
  /**
   * 对话附件解释 API
   *
   * 视频、PDF、Word 这类文件模型吃不下，得先在本地解释成描述文本或图片帧。
   * 解析在主进程做 —— ffmpeg 和 anydoc 原生模块都不在渲染进程这边。
   */
  attachment: {
    /**
     * 解释一个附件
     * @param filePath - 文件的绝对路径（拖拽来的 File 请先过 getPathForFile）
     */
    ingest: (
      filePath: string
    ): Promise<{
      success: boolean
      kind: 'image' | 'video' | 'audio' | 'document' | 'unsupported'
      fileName: string
      text?: string
      /** 抽帧产出的联系表，data URL 形式，按时间先后排列 */
      images?: string[]
      model?: string
      compressed?: boolean
      framesFallback?: boolean
      error?: string
    }> => ipcRenderer.invoke('attachment:ingest', { filePath }),
    /**
     * 订阅解释进度。视频那条可能跑一两分钟，界面要能说清此刻在干什么
     * @returns 取消订阅的函数
     */
    onProgress: (callback: (payload: { filePath: string; note: string }) => void): (() => void) => {
      const listener = (_e: unknown, payload: { filePath: string; note: string }): void =>
        callback(payload)
      ipcRenderer.on('attachment:ingest-progress', listener)
      return () => ipcRenderer.removeListener('attachment:ingest-progress', listener)
    }
  },
  /**
   * 文档加载器 API
   * 使用 LangChain.js 加载各种文档格式
   */
  documentLoader: {
    /**
     * 加载文档
     * @param filePath - 文件的绝对路径
     * @returns 文档内容和元数据
     */
    load: (
      filePath: string
    ): Promise<{
      success: boolean
      content?: string
      metadata?: {
        source: string
        title?: string
        [key: string]: unknown
      }
      error?: string
    }> => ipcRenderer.invoke('document:load', filePath),
    /**
     * 加载文档（增强版，支持图片提取）
     * @param filePath - 文件的绝对路径
     * @param options - 配置选项
     * @returns 文档内容、元数据和提取的图片路径
     */
    loadWithImages: (
      filePath: string,
      options: { notebookId: string; extractImages?: boolean }
    ): Promise<{
      success: boolean
      content?: string
      metadata?: {
        source: string
        title?: string
        images?: string[]
        imageCount?: number
        [key: string]: unknown
      }
      error?: string
    }> => ipcRenderer.invoke('document:loadWithImages', filePath, options),
    /**
     * 检查文件类型是否支持
     * @param filePath - 文件路径
     */
    isSupported: (filePath: string): Promise<boolean> =>
      ipcRenderer.invoke('document:isSupported', filePath),
    /**
     * 获取支持的文件扩展名列表
     */
    getSupportedExtensions: (): Promise<string[]> =>
      ipcRenderer.invoke('document:getSupportedExtensions')
  },
  /**
   * 阿里云百炼 DashScope API
   * 用于上传文件到临时存储获取临时 URL
   */
  dashScope: {
    /**
     * 上传文件到阿里云百炼临时存储
     * @param params.filePath - 本地文件路径（必需）
     * @param params.apiKey - API Key（可选，默认从环境变量或服务端获取）
     * @param params.modelName - 模型名称（可选，默认使用 qwen3-vl-flash）
     * @param params.authToken - 认证令牌（可选，打包后从服务端获取 API Key 时需要）
     * @returns 上传结果，包含临时 URL 和过期时间
     */
    upload: (params: {
      filePath: string
      apiKey?: string
      modelName?: string
    }): Promise<{
      success: boolean
      ossUrl?: string
      expireTime?: string
      error?: string
    }> => ipcRenderer.invoke('dashscope:upload', params),
    /**
     * 使用视觉模型为3D模型生成名称（图生模型：识别图片）
     * @param params.imageBase64 - 模型缩略图的 Base64 数据
     * @returns 生成的名称
     */
    generate3DModelName: (params: {
      imageBase64: string
    }): Promise<{
      success: boolean
      name?: string
      error?: string
    }> => ipcRenderer.invoke('dashscope:generate3DModelName', params),
    /**
     * 使用LLM从Prompt生成名称（文生模型：分析Prompt）
     * @param params.prompt - 用户输入的生成Prompt
     * @returns 生成的名称（3-8字）
     */
    generateNameFromPrompt: (params: {
      prompt: string
    }): Promise<{
      success: boolean
      name?: string
      error?: string
    }> => ipcRenderer.invoke('dashscope:generateNameFromPrompt', params)
  },
  /**
   * 实时语音连接。
   *
   * 音频两个方向都走这里：上行 `sendAudio`（不等返回，一秒十几次），
   * 下行和其余事件都从 `onEvent` 回来。密钥只在主进程。
   */
  realtimeVoice: {
    /**
     * 上行要多少赫兹，**在开会话之前问**。
     *
     * 麦克风要赶在连接建立之前开起来往缓冲里攒（首字），而采集的 AudioContext
     * 必须按目标采样率创建。配置没配好时回 `ok: false`，走 `start` 报错那条路。
     */
    audioSpec: () => ipcRenderer.invoke('realtime-voice:audio-spec'),
    /**
     * `echoGuard` 是偏好设置里的回声门限档位。**随开会话一起带上来**，
     * 不像防冷场那样单开一条通道推 —— 它只在首帧（`session.update`）读一次，
     * 推过去的话「什么时候到」和「什么时候建会话」没有先后保证。
     */
    start: (args?: {
      model?: string
      voice?: string
      history?: Array<{ role: 'user' | 'assistant'; text: string }>
      echoGuard?: RealtimeEchoGuard
      /** 这条对话输入框里选的模型。拼装通话（没绑实时语音时）拿它接电话 */
      brain?: { providerId: string; modelId: string }
    }) => ipcRenderer.invoke('realtime-voice:start', args),
    /**
     * 只转写、不回答的听写会话（全局热键 → Spotlight）。
     *
     * 和 `start` 分开而不是加个参数：失败的处置完全不同。这一路的 `busy` /
     * `vendor-unsupported` 是「退回打字」，不是报错，调用方要能分辨。
     */
    startDictation: () => ipcRenderer.invoke('realtime-voice:start-dictation'),
    /** 「按住说话」松手了：别等静音判停，现在就转写。只有听写那一路用 */
    commitAudio: () => ipcRenderer.invoke('realtime-voice:commit-audio'),
    stop: () => ipcRenderer.invoke('realtime-voice:stop'),
    playbackReady: (connectionId: number) =>
      ipcRenderer.send('realtime-voice:playback-ready', connectionId),
    /** base64 的 PCM16 单声道。采样率由 start 的返回值给出（进出可能不一样） */
    sendAudio: (base64: string) => ipcRenderer.send('realtime-voice:audio', base64),
    /** 防冷场开关（偏好设置 → 语音助手）。改了就发一次，主进程只认最后收到的值 */
    setAntiSilence: (enabled: boolean) => ipcRenderer.send('realtime-voice:anti-silence', enabled),
    setAutoHangup: (enabled: boolean) => ipcRenderer.send('realtime-voice:auto-hangup', enabled),
    /** 不挂断通话，键盘输入直接作为这通电话的下一轮 */
    sendText: (text: string) => ipcRenderer.send('realtime-voice:text', text),
    /** 只读工具（列工程、列已连编辑器）在主进程当场答，不进 agent */
    runLocalTool: (name: string) => ipcRenderer.invoke('realtime-voice:local-tool', { name }),
    /** 谁在说话。主进程据此决定能不能插播后台进度 */
    reportFloor: (args: { userSpeaking: boolean; assistantSpeaking: boolean }) =>
      ipcRenderer.send('realtime-voice:floor', args),
    /** 登记一件活。**要在真正启动 agent 之前调**，否则最初几条事件会丢 */
    dispatchTask: (args: {
      instruction: string
      executionInstruction?: string
      resumeTaskId?: string
      agentSessionId: string
      sessionLabel?: string
      when?: 'queue' | 'now'
    }) => ipcRenderer.invoke('realtime-voice:dispatch', args),
    /**
     * 队列排到了，主进程让这边把它跑起来。
     *
     * 主进程发不起 agent 运行（那是渲染层的入口），所以排队的活只能这样推回来。
     * 返回取消订阅函数。
     */
    onRunTask: (
      handler: (task: {
        taskId: string
        attempt?: number
        agentSessionId: string
        instruction: string
        executionInstruction?: string
      }) => void
    ) => {
      const listener = (_event: unknown, task: unknown): void =>
        handler(
          task as {
            taskId: string
            attempt?: number
            agentSessionId: string
            instruction: string
            executionInstruction?: string
          }
        )
      ipcRenderer.on('realtime-voice:run-task', listener)
      return () => ipcRenderer.removeListener('realtime-voice:run-task', listener)
    },
    /** 启动失败。不标掉的话那条内核 session 永远派不进新活 */
    taskFailed: (args: { taskId: string; reason: string; attempt?: number }) =>
      ipcRenderer.send('realtime-voice:task-failed', args),
    describeTask: (taskId?: string) =>
      ipcRenderer.invoke('realtime-voice:describe-task', { taskId }),
    /** 只问「该停谁」。真正的停止走 agentV3.stop，要拿它的真实返回值 */
    cancelTask: (taskId?: string) => ipcRenderer.invoke('realtime-voice:cancel-task', { taskId }),
    /** 只问「该答给谁」。真正的回传走 agentV3.replyQuestion */
    answerQuestion: (taskId?: string) =>
      ipcRenderer.invoke('realtime-voice:answer-question', { taskId }),
    /** 只问「该批给谁」。真正的回传走 agentV3.replyApproval */
    approveTask: (taskId?: string) => ipcRenderer.invoke('realtime-voice:approve-task', { taskId }),
    /** 用户说要挂了。只问「能不能挂」，什么时候挂由渲染层定 —— 告别得先念完 */
    endCall: (force?: boolean) => ipcRenderer.invoke('realtime-voice:end-call', { force }),
    /** 用户插话了，让服务端停止生成这一轮。光停本地播放不够 */
    cancelResponse: (): void => ipcRenderer.send('realtime-voice:cancel-response'),
    /** 工具执行完把结果交回模型。一次给一批 —— 豆包要求同一轮的结果聚合回传 */
    sendToolResults: (results: { callId: string; output: string }[]) =>
      ipcRenderer.send('realtime-voice:tool-result', results),
    /** 返回取消订阅函数 —— 组件卸载时要调，否则换一路会话会有两个监听在收 */
    onEvent: (handler: (payload: unknown) => void) => {
      const listener = (_event: unknown, payload: unknown): void => handler(payload)
      ipcRenderer.on('realtime-voice:event', listener)
      return () => ipcRenderer.removeListener('realtime-voice:event', listener)
    },
    /**
     * 用户按了「打断语音助手」那个全局快捷键。
     *
     * 全双工之后厂商的服务端 VAD 自己就能发现用户开口（见
     * `useRealtimeVoice.shouldMuteUplink`），所以这个键不再是**唯一**的打断入口。
     * 留着是因为它管得到「不方便说话」的场合：会议里、旁边有人，
     * 或者本机语音合成正在念一条长通知（那一路的回声消不掉，期间上行仍是闭的）。
     * 返回取消订阅函数。
     */
    onInterruptShortcut: (handler: () => void) => {
      const listener = (): void => handler()
      ipcRenderer.on('voice:interrupt-via-shortcut', listener)
      return () => ipcRenderer.removeListener('voice:interrupt-via-shortcut', listener)
    },
    /** 主窗口的语音通话接通 / 挂断了。主进程转给每个窗口 —— 小窗据此在通话期间不自动朗读 */
    setCallActive: (active: boolean) => ipcRenderer.send('realtime-voice:call-active', active),
    /** 别的窗口现在在不在通话（窗口刚起来时问一次） */
    getCallActiveElsewhere: (): Promise<boolean> =>
      ipcRenderer.invoke('realtime-voice:call-active-elsewhere'),
    onCallActive: (handler: (active: boolean) => void) => {
      const listener = (_event: unknown, active: unknown): void => handler(active === true)
      ipcRenderer.on('realtime-voice:call-active', listener)
      return () => ipcRenderer.removeListener('realtime-voice:call-active', listener)
    },
    /** Spotlight 开始听写了。正在朗读的窗口得停下，不然念的话会被当成指令转写进去 */
    onDictationStarted: (handler: () => void) => {
      const listener = (): void => handler()
      ipcRenderer.on('voice:dictation-started', listener)
      return () => ipcRenderer.removeListener('voice:dictation-started', listener)
    }
  },
  /**
   * 听写（语音识别）。**只出文字，一个音都不出。**
   *
   * 和上面 `realtimeVoice` 是两路独立会话：这一路连的是厂商的纯识别接口
   * （豆包 sauc、阿里百炼 ASR），没有「让模型说一句」「打断它」那些动作。
   * 绑了「语音识别」角色时 Spotlight 优先走这条，没绑才回落到实时语音那一路。
   */
  speechToText: {
    /**
     * 上行要多少赫兹，**在开会话之前问**；顺带回答「这一路能不能走」。
     *
     * `ok: false` = 没绑语音识别角色，调用方据此回落到 `realtimeVoice.startDictation`。
     */
    audioSpec: () => ipcRenderer.invoke('stt:audio-spec'),
    start: () => ipcRenderer.invoke('stt:start'),
    /**
     * 「按住说话」松手了：音频到此为止，但**终稿还要**。
     *
     * 别拿 `stop` 代替 —— 它一进门就不再放事件，收尾包换回来的那条终稿
     * 正好被丢掉，表现是松手之后输入框永远少最后一句。
     */
    flush: () => ipcRenderer.invoke('stt:flush'),
    stop: () => ipcRenderer.invoke('stt:stop'),
    /** base64 的 PCM16 单声道，16kHz。主进程会攒到 200ms 再往厂商发 */
    sendAudio: (base64: string) => ipcRenderer.send('stt:audio', base64),
    /** 返回取消订阅函数 —— 组件卸载时要调，否则换一轮会有两个监听在收 */
    onEvent: (handler: (payload: unknown) => void) => {
      const listener = (_event: unknown, payload: unknown): void => handler(payload)
      ipcRenderer.on('stt:event', listener)
      return () => ipcRenderer.removeListener('stt:event', listener)
    }
  },
  /**
   * 视觉识别 API
   * 使用 Gemini 3 Flash Preview 进行图片、视频和音频内容识别
   */
  vision: {
    /**
     * 分析图片、视频或音频内容
     * @param params.mediaPath - 媒体文件的本地路径（优先使用，IPC 会读取并转 Base64）
     * @param params.mediaUrl - 媒体文件的 HTTP URL 或 Data URL（备用）
     * @param params.mediaType - 媒体类型：image、video 或 audio
     * @param params.prompt - 自定义提示词（可选）
     * @param params.authToken - 认证 Token（可选）
     * @returns 分析结果，包含 Markdown 格式的内容描述
     */
    analyze: (params: {
      mediaPath?: string
      mediaUrl?: string
      mediaType: 'image' | 'video'
      prompt?: string
    }): Promise<{
      success: boolean
      markdown?: string
      error?: string
      /** 视频的 临时媒体 URL */
      mediaUrl?: string
    }> => ipcRenderer.invoke('vision:analyze', params),
    /**
     * 检查视觉服务状态
     */
    status: (): Promise<{ available: boolean; model?: string; error?: string }> =>
      ipcRenderer.invoke('vision:status'),
    /**
     * 简化的文档图片分析（用于 DOCX 内嵌图片）
     * @param params.imagePath - 本地文件路径（优先）
     * @param params.imageUrl - 图片 URL（备用）
     */
    analyzeDocumentImage: (params: {
      imagePath?: string
      imageUrl?: string
      context?: string
    }): Promise<{ success: boolean; description?: string; error?: string }> =>
      ipcRenderer.invoke('vision:analyzeDocumentImage', params),
    /**
     * 简化的 PDF 页面分析（用于扫描版 PDF）
     * @param params.imagePath - 本地文件路径（优先）
     * @param params.imageUrl - 图片 URL（备用）
     */
    analyzePdfPage: (params: {
      imagePath?: string
      imageUrl?: string
      pageNumber?: number
    }): Promise<{ success: boolean; content?: string; error?: string }> =>
      ipcRenderer.invoke('vision:analyzePdfPage', params)
  },

  /**
   * YouTube 视频分析 API
   * 使用 Gemini gemini-3-pro-preview 模型分析 YouTube 视频内容
   * 供知识库添加 YouTube 来源使用
   */
  youtube: {
    /**
     * 分析 YouTube 视频内容
     * @param params.url - YouTube 视频 URL
     * @param params.prompt - 自定义分析提示词（可选）
     * @param params.authToken - 认证 Token
     * @returns 分析结果，包含 Markdown 格式的视频内容描述
     */
    analyze: (params: {
      url: string
      prompt?: string
    }): Promise<{
      success: boolean
      content?: string
      title?: string
      videoId?: string
      url?: string
      error?: string
    }> => ipcRenderer.invoke('youtube:analyze', params),
    /**
     * 验证 YouTube URL 格式
     * @param url - 待验证的 URL
     */
    validate: (url: string): Promise<boolean> => ipcRenderer.invoke('youtube:validate', url),
    /**
     * 提取 YouTube 视频 ID
     * @param url - YouTube 视频 URL
     */
    extractId: (url: string): Promise<string | null> => ipcRenderer.invoke('youtube:extractId', url)
  },
  /**
   * Bilibili 视频分析 API
   * 主进程把视频下到本地，交给用户在 设置 → 模型 里勾了「视频」能力的那个模型
   * 供知识库添加 Bilibili 来源使用
   */
  bilibili: {
    /**
     * 分析 Bilibili 视频内容
     * @param params.url - Bilibili 视频 URL
     * @param params.prompt - 自定义分析提示词（可选）
     * @returns 分析结果，包含 Markdown 格式的视频内容描述
     */
    analyze: (params: {
      url: string
      prompt?: string
    }): Promise<{
      success: boolean
      content?: string
      videoId?: string
      error?: string
    }> => ipcRenderer.invoke('bilibili:analyze', params),
    /**
     * 订阅分析进度。解析链接、下载、压缩、送模型各报一句，整条链最长要几分钟
     * @returns 退订函数
     */
    onAnalyzeProgress: (
      callback: (payload: { url: string; note: string }) => void
    ): (() => void) => {
      const handler = (_event: unknown, payload: { url: string; note: string }): void =>
        callback(payload)
      ipcRenderer.on('bilibili:analyzeProgress', handler)
      return () => ipcRenderer.removeListener('bilibili:analyzeProgress', handler)
    },
    /**
     * 验证 Bilibili URL 格式
     * @param url - 待验证的 URL
     */
    validate: (url: string): Promise<boolean> => ipcRenderer.invoke('bilibili:validate', url),
    /**
     * 提取 Bilibili 视频 ID (BV号)
     * @param url - Bilibili 视频 URL
     */
    extractId: (url: string): Promise<string | null> =>
      ipcRenderer.invoke('bilibili:extractId', url),
    /** 获取用于播放/展示的临时视频直链，不执行内容分析 */
    resolveVideoUrl: (url: string): Promise<{ success: boolean; data: string; error?: string }> =>
      ipcRenderer.invoke('bilibili:resolveVideoUrl', url),
    /**
     * 快速获取视频元信息（标题、封面、描述）
     * @param bvid - 视频 BV 号
     * @returns 视频元信息
     */
    fetchInfo: (
      bvid: string
    ): Promise<{
      success: boolean
      title?: string
      pic?: string
      desc?: string
      owner?: { name: string; face: string; mid: number }
      duration?: number
      bvid?: string
      error?: string
    }> => ipcRenderer.invoke('bilibili:fetchInfo', bvid)
  },
  /**
   * 知识库 API
   * 本地存储知识库及来源数据
   */
  notebook: {
    /**
     * 创建知识库
     */
    create: (data: {
      title?: string
      description?: string
      coverStyle?: string
      coverImage?: string
    }): Promise<string> => ipcRenderer.invoke('notebook:create', data),
    /**
     * 获取单个知识库
     */
    get: (notebookId: string) => ipcRenderer.invoke('notebook:get', notebookId),
    /**
     * 获取知识库列表
     */
    list: (options?: { limit?: number; offset?: number }) =>
      ipcRenderer.invoke('notebook:list', options),
    /**
     * 更新知识库
     */
    update: (
      notebookId: string,
      updates: {
        title?: string
        description?: string
        coverStyle?: string
        coverImage?: string
      }
    ) => ipcRenderer.invoke('notebook:update', notebookId, updates),
    /**
     * 删除知识库
     */
    delete: (notebookId: string): Promise<boolean> =>
      ipcRenderer.invoke('notebook:delete', notebookId),
    /**
     * 获取知识库数量
     */
    count: (): Promise<number> => ipcRenderer.invoke('notebook:count'),
    // ========== 来源相关 ==========
    /**
     * 添加来源
     */
    createSource: (data: {
      sourceId?: string
      notebookId: string
      title: string
      type:
        | 'file'
        | 'link'
        | 'youtube'
        | 'bilibili'
        | 'text'
        | 'note'
        | 'ue-project'
        | 'wechat'
        | 'mp'
      content: string
      /** 抓回来的原文（清洗过的网页才有） */
      rawContent?: string | null
      sourceUrl?: string
      fileName?: string
      /** 文件的本地路径（用于重试加载） */
      filePath?: string
      loading?: boolean
      error?: string
    }): Promise<string> => ipcRenderer.invoke('notebook:source:create', data),
    /**
     * 获取知识库的所有来源
     */
    getSources: (notebookId: string) => ipcRenderer.invoke('notebook:source:list', notebookId),
    /**
     * 更新来源
     */
    updateSource: (
      sourceId: string,
      updates: {
        title?: string
        type?:
          | 'file'
          | 'link'
          | 'youtube'
          | 'bilibili'
          | 'text'
          | 'note'
          | 'ue-project'
          | 'wechat'
          | 'mp'
        content?: string
        /** 抓回来的原文（清洗过的网页才有） */
        rawContent?: string | null
        sourceUrl?: string | null
        fileName?: string | null
        filePath?: string | null
        loading?: boolean
        error?: string | null
        /** 这条来源进上下文的档位 */
        contextLevel?: NotebookContextLevel
        summaryContent?: string | null
        summaryStatus?: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped'
        /** 视频的 临时媒体 URL */
        mediaUrl?: string | null
      }
    ): Promise<boolean> => ipcRenderer.invoke('notebook:source:update', sourceId, updates),
    /**
     * 删除来源
     */
    deleteSource: (sourceId: string): Promise<boolean> =>
      ipcRenderer.invoke('notebook:source:delete', sourceId),
    /**
     * 把这条来源正文里的图交给视觉模型读一遍。
     * 开关没开时原样返回，不改任何东西也不报错。
     */
    readSourceImages: (sourceId: string) =>
      ipcRenderer.invoke('notebook:source:read-images', sourceId),
    /**
     * RAG: 索引知识库内容
     */
    ragIndex: (params: { notebookId: string; sourceIds?: string[] }) =>
      ipcRenderer.invoke('notebook:rag:index', params),
    /**
     * RAG: 将知识库来源加入后台索引队列
     */
    ragQueueIndex: (params: { notebookId: string; sourceIds?: string[] }) =>
      ipcRenderer.invoke('notebook:rag:queue-index', params),
    /**
     * RAG: 查询后台索引队列状态
     */
    ragListIndexJobs: (params?: { notebookId?: string }) =>
      ipcRenderer.invoke('notebook:rag:list-index-jobs', params),
    /**
     * Chat V2: 准备知识库对话上下文
     * 只读取已就绪索引，并返回来源状态、引用和诊断信息。
     */
    chatV2Prepare: (params: {
      notebookId: string
      query: string
      sourceIds?: string[]
      notebookTitle?: string
      limit?: number
      contextMaxChars?: number
      searchTimeoutMs?: number
    }) => ipcRenderer.invoke('notebook:chat-v2:prepare', params),
    /**
     * RAG: 向量检索
     * @param params.sourceIds 可选，仅检索指定来源的内容
     */
    ragSearch: (params: {
      notebookId: string
      query: string
      limit?: number
      sourceIds?: string[]
    }) => ipcRenderer.invoke('notebook:rag:search', params)
  },
  /**
   * 应用设置 API
   */
  settings: {
    get: (key: string, defaultValue?: any) =>
      ipcRenderer.invoke('db:settings:get', key, defaultValue).then((res) => {
        if (res.success) return res.data
        throw new Error(res.error)
      }),
    set: (key: string, value: any) =>
      ipcRenderer.invoke('db:settings:set', key, value).then((res) => {
        if (res.success) return true
        throw new Error(res.error)
      })
  },

  /**
   * AI 对话历史落盘 API（原来存 localStorage，配额只有几 MB）。
   * 只搬运整份 JSON 字符串，不理解内容；见 renderer/utils/chatHistoryStorage.ts。
   */
  chatHistory: {
    read: (): Promise<{ 'chat-sessions'?: string; 'follow-up-queue'?: string }> =>
      ipcRenderer.invoke('chat-history:read'),
    write: (key: string, value: string): Promise<void> =>
      ipcRenderer.invoke('chat-history:write', key, value),
    /** 对话正文一个对话一个文件；见 main/ipc/chatSessionFiles.ts */
    sessionsIndex: (): Promise<Record<string, { typing?: string[] }>> =>
      ipcRenderer.invoke('chat-history:sessions-index'),
    importLegacySessions: (json: string): Promise<Record<string, { typing?: string[] }>> =>
      ipcRenderer.invoke('chat-history:sessions-import-legacy', json),
    /** 同步读：store 接口是同步的，第一次碰到某个对话时才读它 */
    readSessionSync: (sid: string): string | null =>
      ipcRenderer.sendSync('chat-history:session-read-sync', sid),
    readSessions: (sids: string[]): Promise<Record<string, string>> =>
      ipcRenderer.invoke('chat-history:sessions-read', sids),
    writeSessions: (
      writes: Array<{ sid: string; json: string | null; typing?: string[] }>
    ): Promise<void> => ipcRenderer.invoke('chat-history:sessions-write', writes)
  },

  /**
   * 渲染层凭据的加密落盘（原来明文存在 localStorage）；见 main/ipc/secureStore.ts。
   */
  secureStore: {
    read: (): Promise<{ available: boolean; values: Record<string, string> }> =>
      ipcRenderer.invoke('secure-store:read'),
    write: (key: string, value: string | null): Promise<void> =>
      ipcRenderer.invoke('secure-store:write', key, value)
  },

  /**
   * 个性化 API：用户写给 agent 的那段常驻说明。技能的列与删在 `agentV3` 下。
   */
  personalization: {
    /** 读那段说明，连同字数上限和它在盘上的位置 */
    getInstructions: (): Promise<{ text: string; limit: number; path: string }> =>
      ipcRenderer.invoke('personalization:getInstructions'),
    setInstructions: (text: string): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('personalization:setInstructions', text)
  },

  /** agent 系统通知：用户点了之后界面要跳到那条对话，见 shared/agentNotificationActivation.ts */
  agentNotifications: {
    /** 取走主进程存着的那条激活（取走即清）。推送落空时靠它补回来 */
    takePending: (): Promise<NotificationActivatePayload | null> =>
      ipcRenderer.invoke(NOTIFICATION_TAKE_PENDING_CHANNEL),
    /** 回话：这条激活认没认出来。没认出来主进程会把通知重新弹一条 */
    reportActivation: (result: NotificationActivationResult): Promise<void> =>
      ipcRenderer.invoke(NOTIFICATION_ACTIVATION_RESULT_CHANNEL, result)
  },

  /** 系统托盘菜单：界面报最近对话、取还没送到的托盘动作，见 shared/trayActions.ts */
  tray: {
    /** 最近活跃的三条对话变了，主进程据此重建菜单 */
    setRecentSessions: (sessions: TrayRecentSession[]): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(TRAY_SET_RECENT_SESSIONS_CHANNEL, sessions),
    /** 取走主进程存着的那条托盘动作（取走即清）—— 唯一的送达路径 */
    takePending: (): Promise<TrayAction | null> => ipcRenderer.invoke(TRAY_TAKE_PENDING_CHANNEL),
    /** 用户在退出确认框里选了「仍然退出」 */
    confirmQuit: (reason?: 'update'): Promise<{ success: boolean }> =>
      ipcRenderer.invoke(TRAY_CONFIRM_QUIT_CHANNEL, reason)
  },

  /**
   * 应用设置 API
   */
  appSettings: {
    /**
     * 获取应用设置
     */
    get: (): Promise<{
      autoLaunch: boolean
      enableFollowUpSuggestions: boolean
      language: 'zh-CN' | 'en-US'
      autoEnableUnrealAgentLink: boolean
      agentBrowserMode: 'window' | 'embedded' | 'hidden'
      agentFileAccessScope: 'ue-only' | 'full'
      agentToolSearchEnabled: boolean
      agentPersistentAutoResume: boolean
      agentGoalMaxRounds: number
      agentDisabledTools: string[]
      agentAlwaysAllowedTools: string[]
      agentResidentTools: Record<string, boolean>
      notifyTurnComplete: 'off' | 'unfocused' | 'always'
      notifyApprovalRequired: boolean
      notifyQuestionRequired: boolean
      hideWindowOnProjectLaunch: boolean
      autoRecoverEditorCrash: boolean
      /** agent 搜素材时看不看别的保管库，默认关 */
      assetCrossVaultSearch: boolean
      assetReadonlyLock: boolean
      agentBrowserAllowLocalNetwork: boolean
    }> => ipcRenderer.invoke('app-settings:get'),
    /**
     * 更新应用设置
     */
    set: (settings: {
      autoLaunch?: boolean
      enableFollowUpSuggestions?: boolean
      autoEnableUnrealAgentLink?: boolean
      agentBrowserMode?: 'window' | 'embedded' | 'hidden'
      agentFileAccessScope?: 'ue-only' | 'full'
      agentToolSearchEnabled?: boolean
      agentPersistentAutoResume?: boolean
      agentGoalMaxRounds?: number
      agentDisabledTools?: string[]
      agentAlwaysAllowedTools?: string[]
      agentResidentTools?: Record<string, boolean>
      notifyTurnComplete?: 'off' | 'unfocused' | 'always'
      notifyApprovalRequired?: boolean
      notifyQuestionRequired?: boolean
      hideWindowOnProjectLaunch?: boolean
      autoRecoverEditorCrash?: boolean
      assetCrossVaultSearch?: boolean
      assetReadonlyLock?: boolean
      agentBrowserAllowLocalNetwork?: boolean
    }): Promise<{ success: boolean }> => ipcRenderer.invoke('app-settings:set', settings),
    /**
     * 设置开机自启
     */
    setAutoLaunch: (enabled: boolean): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('app-settings:setAutoLaunch', enabled),
    /**
     * 设置启用智能追加提问建议
     */
    setEnableFollowUpSuggestions: (enabled: boolean): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('app-settings:setEnableFollowUpSuggestions', enabled),
    /**
     * 设置应用语言
     */
    setLanguage: (language: 'zh-CN' | 'en-US'): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('app-settings:setLanguage', language),
    /**
     * 获取应用语言
     */
    getLanguage: (): Promise<'zh-CN' | 'en-US'> => ipcRenderer.invoke('app-settings:getLanguage'),
    /** 让 Windows 任务栏和托盘图标跟随实际生效的主题 */
    setThemeIcon: (
      theme: 'light' | 'dark'
    ): Promise<{ success: boolean; data: boolean; error?: string }> =>
      ipcRenderer.invoke('app-settings:setThemeIcon', theme),
    /**
     * 设置启动项目时自动启用 UnrealAgentLink 插件
     */
    setAutoEnableUnrealAgentLink: (enabled: boolean): Promise<{ success: boolean }> =>
      ipcRenderer.invoke('app-settings:setAutoEnableUnrealAgentLink', enabled),
    /**
     * 获取启动项目时自动启用 UnrealAgentLink 插件设置
     */
    getAutoEnableUnrealAgentLink: (): Promise<boolean> =>
      ipcRenderer.invoke('app-settings:getAutoEnableUnrealAgentLink'),
    /**
     * 手动修复并清理引擎目录中残留的 UnrealAgentLink 插件
     */
    repairUnrealAgentLinkEngineResidue: (): Promise<{
      success: boolean
      scannedEngineCount: number
      cleanedEngineCount: number
      skippedEngineCount: number
      failedEngines: Array<{
        engineName: string
        engineRootPath: string
        error: string
      }>
      error?: string
    }> => ipcRenderer.invoke('app-settings:repairUnrealAgentLinkEngineResidue')
  },
  /**
   * 截图模式 API
   * 用于截取产品图，支持透明背景
   */
  screenshot: {
    /**
     * 进入截图模式
     * 窗口向四周扩展透明区域
     */
    enterMode: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('screenshot:enter-mode'),
    /**
     * 退出截图模式
     * 恢复窗口原始状态
     */
    exitMode: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke('screenshot:exit-mode'),
    /**
     * 执行截图
     * 捕获当前窗口内容并保存为 PNG
     */
    capture: (): Promise<{ success: boolean; filePath?: string; error?: string }> =>
      ipcRenderer.invoke('screenshot:capture'),
    /**
     * 获取截图模式状态
     */
    getState: (): Promise<{ isActive: boolean; padding: number }> =>
      ipcRenderer.invoke('screenshot:get-state'),
    /**
     * 监听截图模式变化事件
     */
    onModeChanged: (callback: (data: { active: boolean; padding: number }) => void) => {
      const handler = (_: Electron.IpcRendererEvent, data: { active: boolean; padding: number }) =>
        callback(data)
      ipcRenderer.on('screenshot:mode-changed', handler)
      return () => ipcRenderer.removeListener('screenshot:mode-changed', handler)
    },
    /**
     * 监听通过快捷键触发进入截图模式
     */
    onEnterViaShortcut: (callback: () => void) => {
      const handler = () => callback()
      ipcRenderer.on('screenshot:enter-via-shortcut', handler)
      return () => ipcRenderer.removeListener('screenshot:enter-via-shortcut', handler)
    }
  },
  /**
   * 屏幕录制 API
   */
  screenRecorder: {
    getSources: () => ipcRenderer.invoke('screen-recorder:get-sources'),
    saveFile: (buffer: ArrayBuffer, extension?: string) =>
      ipcRenderer.invoke('screen-recorder:save-file', { buffer, extension }),
    autoSave: (buffer: ArrayBuffer, extension?: string) =>
      ipcRenderer.invoke('screen-recorder:auto-save', { buffer, extension }),
    openQuickWindow: () => ipcRenderer.invoke('screen-recorder:open-quick-window'),
    closeQuickWindow: () => ipcRenderer.invoke('screen-recorder:close-quick-window'),
    moveQuickWindow: (position: 'center' | 'bottom-right') =>
      ipcRenderer.invoke('screen-recorder:move-quick-window', { position }),
    setQuickWindowMode: (mode: 'expanded' | 'collapsed') =>
      ipcRenderer.invoke('screen-recorder:set-quick-window-mode', { mode }),
    exportRecording: (payload: {
      inputPath: string
      format: 'mp4' | 'gif'
      quality: 'high' | 'balanced' | 'fast'
      resolution: 'original' | '1080p' | '720p'
      fps: number
      bitrate: number
      includeAudio: boolean
      highQualityScale: boolean
      trimStart: number
      trimEnd: number
    }) => ipcRenderer.invoke('screen-recorder:export', payload),
    getRecordingsDir: () => ipcRenderer.invoke('screen-recorder:get-recordings-dir'),
    listRecordings: () => ipcRenderer.invoke('screen-recorder:list-recordings'),
    deleteRecording: (filePath: string) =>
      ipcRenderer.invoke('screen-recorder:delete-recording', filePath),
    startSelection: () => ipcRenderer.invoke('screen-recorder:start-selection'),
    selectionComplete: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.send('screen-recorder:selection-complete', bounds),
    selectionCancelled: () => ipcRenderer.send('screen-recorder:selection-cancelled')
  }
}

// 单独暴露 electronAPI 对象，包含 vaultManager
const electronAPIExtended = {
  ...safeElectronAPI,
  vaultManager: {
    updateVaultOrder: (vaultIds: string[]) => ipcRenderer.invoke('vault:updateOrder', vaultIds)
  }
}

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', safeElectronAPI)
    contextBridge.exposeInMainWorld('electronAPI', electronAPIExtended)
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (define in dts)
  window.electron = safeElectronAPI
  // @ts-ignore (define in dts)
  window.electronAPI = electronAPIExtended
  // @ts-ignore (define in dts)
  window.api = api
}

// ==================== Agent 跳转事件转发 ====================
// 监听主进程发送的 agent:action:jump 消息，转发为前端可监听的 window 事件
ipcRenderer.on('agent:action:jump', (_, data: { folderKey: string }) => {
  console.log('[preload] agent:action:jump received, dispatching asset-folder:changed event', data)
  window.dispatchEvent(
    new CustomEvent('asset-folder:changed', {
      detail: { folderKey: data.folderKey }
    })
  )
})
