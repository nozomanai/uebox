import type {
  BrowserGroupState,
  BrowserCommand,
  BrowserTabCommand,
  BrowserNavigationState,
  BrowserToolbarAction
} from '../shared/agentBrowser'
import type {
  NotificationActivatePayload,
  NotificationActivationResult
} from '../shared/agentNotificationActivation'
import type { TrayAction, TrayRecentSession } from '../shared/trayActions'
import type {
  SharedSkillInstallFailure,
  SharedSkillInstallOutcome,
  SharedSkillInstallRequest,
  SharedSkillOrigin,
  SharedSkillPack,
  SharedSkillConnectPrompt,
  SharedSkillSubmitResult
} from '../shared/share'
import type {
  CommunityFetchResult,
  CommunityTemplate,
  TemplateDownloadProgress,
  TemplateInfo,
  TemplateSource
} from '../shared/projectTemplate'
import type {
  AssetImportStatusSummary,
  DependencyGraphEdge,
  DependencyGraphNode
} from '../shared/assetDependency'
import type { AgentTurnUsage } from '../shared/agentUsage'
import type { EditorHealthResult } from '../shared/editorHealth'
import type {
  DismissalErrorCode,
  ExternalTeamSummary,
  ModelCheckup,
  ModelDossier,
  TeamStateView
} from '../shared/agentTeam'
import type { AgentReviewResult, AgentReviewTarget } from '../shared/agentReview'
import type {
  AgentStartRejectionCode,
  SteerRejectionCode,
  SteerRejectionErrorParams
} from '../shared/agentRunRejection'
import type { SideQuestionContext } from '../shared/sideQuestion'
import type { ChatSyncPatch } from '../shared/chatWindowSync'
import type {
  EditorSnapshot,
  EditorSnapshotCaptureResult,
  MiniChatInitialMessage
} from '../shared/editorSnapshot'
import type { CliPathChangeResult, CliStatus } from '../shared/cli'
import type {
  ObjectStorageConfigView,
  ObjectStorageListResult,
  ObjectStorageRemoveResult,
  ObjectStorageSaveInput
} from '../shared/objectStorage'
import type { DroppedPathVerdict } from '../shared/droppedPath'
import type { ImportFailureReport, MissingPlugin, UnavailablePlugin } from '../shared/projectImport'
import type { ProjectCoverMode } from '../shared/projectCover'
import type { SpotlightAction, SpotlightSearchResponse } from '../shared/spotlight'
import type { NotebookContextLevel } from '../shared/notebookContext'
import type { RealtimeEchoGuard } from '../shared/realtimeEchoGuard'
import type {
  LibraryKind,
  LibraryPackageDto,
  LibraryPackageProblemDto
} from '../shared/libraryPackage'

import type {
  CatalogAssetDetail,
  CatalogConnectInput,
  CatalogConnectResult,
  CatalogFacetField,
  CatalogFacets,
  CatalogFolder,
  CatalogLibraryEvent,
  CatalogLibraryStatus,
  CatalogLibraryView,
  CatalogListQuery,
  CatalogProbeResult,
  CatalogRemoteLibrary,
  CatalogServerView,
  CatalogWindow,
  CatalogTagDef,
  CatalogFavorites,
  CatalogFolder,
  CatalogClosure,
  CatalogUnclaimed
} from '../shared/catalogLibrary'
import type { TeamEvent, TeamFact, TeamJoinLink } from '../shared/teamProject'

/** 服务端资产库 IPC 的统一返回形状（见 src/main/ipc/catalogLibrary.ts） */
type CatalogIpcResult<T> =
  | { success: true; data: T; error?: undefined; errorCode?: undefined }
  | { success: false; data?: undefined; error: string; errorCode: string }

export {}

declare global {
  /**
   * 命名规则保存时交上去的东西：完整配置 **+ 这一次点掉了哪些出厂键**。
   *
   * 和主进程的 `NamingRulesSavePayload`（`src/main/utils/namingRulesConfig.ts`）
   * 是同一个形状。这里重写一遍而不是 import 过来：那个模块 import 了 `electron` 和 `fs`，
   * 而本文件同时在 tsconfig.web 的程序里，把主进程模块拉进渲染侧会直接挂。
   * 放在 global 里是为了 `src/preload/index.ts` 也能标注同一个类型（硬规则 4）。
   * 四张表的键名跟着主进程那边改。
   */
  type NamingRulesSavePayload = import('../renderer/src/types/namingRules').NamingRulesConfig & {
    removedKeys?: Partial<
      Record<
        | 'assetPrefixes'
        | 'assetTypeToDirectory'
        | 'libraryAssetTypeToDirectory'
        | 'extensionToAssetType',
        string[]
      >
    >
  }

  /**
   * 引擎桥接（盒子这一侧的 WebSocket 服务）的状态。
   *
   * 注意它**不是** `{ success, data }` 那个形状 —— `ws:status` 直接返回它。
   * 界面要的是 `startError`：桥接没起来时那句话是用户唯一的线索
   * （端口被谁占了、该怎么办）。
   */
  interface BridgeStatus {
    state: string
    port: number
    startedAt?: number
    /** 服务没起来的原因，已经是一句能照做的话。起来之后会被擦掉 */
    startError?: string
  }

  /**
   * 此刻连着的一个工程。
   *
   * 两端都是 `projectManager.getInteractiveProjects()` 发的（`ws:projects` 拉、
   * `ws:projects-changed` 推），所以形状一致 —— 跑批的 commandlet 已经滤掉了。
   *
   * 这里定死一次，省得每个用它的组件各写一份内联类型：之前四处调用方写出了三种
   * 形状（同一个字段有的必填有的可选），还得各自 `as` 一次才能读。
   */
  interface ConnectedProject {
    connectionId: string
    projectName: string
    projectPath?: string
    engineVersion?: string
    enabledPlugins?: string[]
    isConnected?: boolean
  }

  /** 包 IPC 统一的返回形状，渲染层用 `unwrapResult()` 拆 */
  interface LibraryPackageIpcResult<T> {
    success: boolean
    data: T
    error?: string
  }

  interface RendererIpcAPI {
    send: (channel: string, ...args: any[]) => void
    invoke: (channel: string, ...args: any[]) => Promise<any>
    on: (channel: string, listener: (event: unknown, ...args: any[]) => void) => () => void
    once: (channel: string, listener: (event: unknown, ...args: any[]) => void) => () => void
    off: (channel: string, listener: (event: unknown, ...args: any[]) => void) => void
    removeListener: (
      channel: string,
      listener: (event: unknown, ...args: any[]) => void
    ) => RendererIpcAPI
    removeAllListeners: (channel: string) => void
  }

  interface RendererElectronAPI {
    ipcRenderer: RendererIpcAPI
  }

  // 用户模型接口
  interface User {
    id?: number
    username: string
    email: string
    password: string
    created_at?: string
    updated_at?: string
  }

  // 文件夹类型枚举（与数据库保持一致）
  type FolderType = 'normal' | 'plugin' | 'project' | 'system'

  // 资产文件夹模型接口
  interface AssetFolder {
    folderKey: string
    fatherKey?: string
    img?: string
    type?: FolderType
    folderName: string
    // 下面字段与层级路径相关，由数据库维护
    fullPath?: string
    pathArray?: string
    depth?: number
    ancestorKeys?: string
    isDelete?: number
    /** 进回收站的时刻。没删过就是 null；老库补列之前删的也是 null */
    deletedAt?: string | null
    created_at?: string
    updated_at?: string
    hasChildren?: boolean // 是否有子文件夹（运行时计算）
    color?: string // 自定义文件夹颜色
    note?: string // 一句话备注（纯文本）
    noteId?: number | null // 关联的富文本说明书，指向 note 表
  }

  // 资产数据模型接口
  interface AssetData {
    assetKey: string
    folderKey: string
    assetName: string
    /** 资产缩略图在本地的相对路径 */
    imgLocalPath?: string
    /** 自定义封面（Base64 或 URL） */
    customPoster?: string
    isDelete?: number
    /** 进回收站的时刻。没删过就是 null；老库补列之前删的也是 null */
    deletedAt?: string | null
    created_at?: string
    updated_at?: string
  }

  // 筛选器接口（可扩展）
  interface AssetDataFilter {
    keyword?: string
  }

  // 标签筛选选项
  interface TagFilterOptions {
    includeTagIds?: number[]
    excludeTagIds?: number[]
    matchMode?: 'any' | 'all'
    folderKey?: string
  }

  /**
   * 资产库语义搜索的状态。
   *
   * `pending` 是还没算向量的资产条数 —— 它不为 0 就说明索引还没建完，
   * 界面上要如实显示进度，不能只显示一个「已开启」。
   */
  interface AssetSemanticStatus {
    enabled: boolean
    /** sqlite-vec 扩展在这台机器上能不能用。false 时语义搜索整个不可用 */
    available: boolean
    dimension: number
    indexed: number
    pending: number
    total: number
    ready: boolean
    running: boolean
    /** 上一次算向量失败的原因（没配模型 / 网断了 / 余额没了）。null = 没出过错 */
    lastError: string | null
  }

  // 统一资产搜索条件接口（可扩展）
  interface AssetSearchCriteria {
    folderKey?: string
    includeSubfolders?: boolean
    keyword?: string
    tagFilter?: {
      includeTagIds?: number[]
      excludeTagIds?: number[]
      matchMode?: 'any' | 'all'
    }
    hasNoTags?: boolean
    assetTypes?: string[]
    classNameCnFilters?: string[]
    fileExtensions?: string[]
    sizeRange?: { min?: number; max?: number }
    engineVersions?: string[]
    dateRange?: { start?: string; end?: string }
    favoriteStatus?: 'all' | 'favorite' | 'unfavorite'
    userId?: number | null
    vaultId?: string | null
    sortBy?: 'assetName' | 'created_at' | 'updated_at' | 'fileSize' | 'size'
    sortOrder?: 'asc' | 'desc'
    limit?: number
    offset?: number
  }

  // 文件夹搜索条件接口
  interface FolderSearchCriteria {
    folderKey?: string
    includeSubfolders?: boolean
    keyword?: string
    sortBy?: 'folderName' | 'created_at' | 'updated_at' | 'depth'
    sortOrder?: 'asc' | 'desc'
    limit?: number
    offset?: number
  }

  // 标签接口
  interface Tag {
    id?: number
    name: string
    color?: string
    group_id?: number | null
    is_favorite?: boolean
    created_at?: string
    updated_at?: string
  }

  // 标签组接口
  interface TagGroup {
    id?: number
    name: string
    color?: string
    sort_order?: number
    created_at?: string
    updated_at?: string
  }

  // 资产-标签关联接口
  interface AssetTagMap {
    id?: number
    assetKey: string
    tagId: number
    created_at?: string
    updated_at?: string
  }

  // 资产收藏接口
  interface AssetFavorite {
    id?: number
    assetKey: string
    userId?: number
    vaultId?: string
    created_at?: string
    updated_at?: string
  }

  // 项目记录接口（公共数据库）
  /** 一条资产快照记录（回滚原型） */
  interface AgentV3AssetSnapshotEntry {
    contentPath: string
    diskPath: string
    snapshotPath: string
    kind: 'modified' | 'created'
    bytes: number
    at: number
  }

  /** 项目里 UnrealAgentLink 的当前状态 */
  interface UnrealAgentLinkStatus {
    /** 插件目录是否存在且有 .uplugin */
    installed: boolean
    /** 已安装的版本号，读不到就是 null */
    version: string | null
    /** 随应用分发的版本号 */
    bundledVersion: string
    /** 用户是否明确拒绝过这个项目 */
    optedOut: boolean
    /** .uproject 里是否已启用 */
    enabledInUproject: boolean
  }

  interface ProjectRecord {
    id?: number
    projectKey: string
    projectName?: string | null
    EngineAssociation?: string | null
    projectData?: string | null
    projectPath?: string | null
    originPath?: string | null
    projectConfig?: string | null
    image?: string | null
    coverMode?: ProjectCoverMode | null
    note?: string | null
    isPinned?: number | null
    created_at?: string
    updated_at?: string
  }

  // 工程合集接口（公共数据库）
  interface ProjectCollectionRecord {
    id?: number
    collectionKey: string
    name?: string | null
    description?: string | null
    color?: string | null
    icon?: string | null
    sort_order?: number | null
    isPinned?: number | null
    created_at?: string
    updated_at?: string
    // 查询列表接口新增：返回该合集下的项目数据
    items?: ProjectRecord[]
  }

  // 数据库API接口
  interface DatabaseAPI {
    user: {
      getAll: () => Promise<{ success: boolean; data: User[]; error?: string }>
      getById: (id: number) => Promise<{ success: boolean; data: User | undefined; error?: string }>
      getByUsername: (
        username: string
      ) => Promise<{ success: boolean; data: User | undefined; error?: string }>
      create: (
        userData: User
      ) => Promise<{ success: boolean; data: { id: number }; error?: string }>
      update: (
        id: number,
        userData: Partial<User>
      ) => Promise<{ success: boolean; data: { updated: boolean }; error?: string }>
      delete: (
        id: number
      ) => Promise<{ success: boolean; data: { deleted: boolean }; error?: string }>
    }
    tag: {
      getAll: () => Promise<{ success: boolean; data: Tag[]; error?: string }>
      getById: (id: number) => Promise<{ success: boolean; data: Tag | null; error?: string }>
      getByName: (name: string) => Promise<{ success: boolean; data: Tag | null; error?: string }>
      getByGroupId: (groupId: number) => Promise<{ success: boolean; data: Tag[]; error?: string }>
      getUngrouped: () => Promise<{ success: boolean; data: Tag[]; error?: string }>
      create: (tagData: Tag) => Promise<{ success: boolean; data: { id: number }; error?: string }>
      update: (
        id: number,
        updates: Partial<Tag>
      ) => Promise<{ success: boolean; data: { updated: boolean }; error?: string }>
      delete: (
        id: number
      ) => Promise<{ success: boolean; data: { deleted: boolean }; error?: string }>
      search: (keyword: string) => Promise<{ success: boolean; data: Tag[]; error?: string }>
      batchCreate: (
        tagsData: Tag[]
      ) => Promise<{ success: boolean; data: { createdCount: number }; error?: string }>
      batchDelete: (ids: number[]) => Promise<{
        success: boolean
        data: { deletedCount: number; total: number }
        error?: string
      }>
      moveToGroup: (
        tagIds: number[],
        groupId: number | null
      ) => Promise<{
        success: boolean
        data: { updatedCount: number; total: number }
        error?: string
      }>
      getFavorites: () => Promise<{ success: boolean; data: Tag[]; error?: string }>
      toggleFavorite: (
        id: number
      ) => Promise<{ success: boolean; data: { updated: boolean }; error?: string }>
    }
    tagGroup: {
      getAll: () => Promise<{ success: boolean; data: TagGroup[]; error?: string }>
      getAllWithCount: () => Promise<{
        success: boolean
        data: Array<TagGroup & { tagCount: number }>
        error?: string
      }>
      getById: (id: number) => Promise<{ success: boolean; data: TagGroup | null; error?: string }>
      getByName: (
        name: string
      ) => Promise<{ success: boolean; data: TagGroup | null; error?: string }>
      getTagCount: (groupId: number) => Promise<{ success: boolean; data: number; error?: string }>
      create: (
        groupData: TagGroup
      ) => Promise<{ success: boolean; data: { id: number }; error?: string }>
      update: (
        id: number,
        updates: Partial<TagGroup>
      ) => Promise<{ success: boolean; data: { updated: boolean }; error?: string }>
      delete: (
        id: number
      ) => Promise<{ success: boolean; data: { deleted: boolean }; error?: string }>
      search: (keyword: string) => Promise<{ success: boolean; data: TagGroup[]; error?: string }>
      batchCreate: (
        groupsData: TagGroup[]
      ) => Promise<{ success: boolean; data: { createdCount: number }; error?: string }>
      batchDelete: (ids: number[]) => Promise<{
        success: boolean
        data: { deletedCount: number; total: number }
        error?: string
      }>
      batchUpdateSort: (
        sortData: Array<{ id: number; sort_order: number }>
      ) => Promise<{ success: boolean; data: { updated: boolean }; error?: string }>
      duplicate: (
        id: number,
        newName?: string
      ) => Promise<{ success: boolean; data: { id: number }; error?: string }>
    }
    assetFolder: {
      getAll: () => Promise<{ success: boolean; data: AssetFolder[]; error?: string }>
      getByKey: (
        folderKey: string
      ) => Promise<{ success: boolean; data: AssetFolder | undefined; error?: string }>
      getByFatherKey: (
        fatherKey: string,
        sortBy?: 'assetName' | 'modifiedTime' | 'fileSize' | 'assetType',
        sortOrder?: 'asc' | 'desc',
        limit?: number,
        offset?: number
      ) => Promise<{ success: boolean; data: AssetFolder[]; error?: string }>
      getChildCount: (
        fatherKey: string
      ) => Promise<{ success: boolean; data: number; error?: string }>
      getRootFolders: (
        sortBy?: 'assetName' | 'modifiedTime' | 'fileSize' | 'assetType',
        sortOrder?: 'asc' | 'desc'
      ) => Promise<{ success: boolean; data: AssetFolder[]; error?: string }>
      create: (
        folderData: AssetFolder
      ) => Promise<{ success: boolean; data: number; error?: string }>
      update: (
        folderKey: string,
        folderData: Partial<AssetFolder>
      ) => Promise<{
        success: boolean
        data: boolean
        error?: string
        /**
         * 「改成了，但有一半没跟上」：库里改完了，共享盘上的目录没改成。
         * 不是失败（所以 success 仍是 true —— 报 false 会让调用方按「什么都没发生」
         * 回滚界面，而数据库里已经是新名字），但必须说给用户听。
         */
        warning?: { code: string; message: string }
      }>
      delete: (folderKey: string) => Promise<{
        success: boolean
        data: boolean
        /** 失败原因的机器码，目前只有 NETWORK_DIR_DELETE_FAILED（共享盘目录没删掉） */
        code?: string
        error?: string
      }>
      restore: (folderKey: string) => Promise<{ success: boolean; data: boolean; error?: string }>
      getDeleted: (
        page?: number,
        pageSize?: number
      ) => Promise<{
        success: boolean
        data: AssetFolder[] | { list: AssetFolder[]; total: number }
        error?: string
      }>
      getPathArray: (
        folderKey: string
      ) => Promise<{ success: boolean; data: string[]; error?: string }>
      getBatchPaths: (
        folderKeys: string[]
      ) => Promise<{ success: boolean; data: Record<string, string[]>; error?: string }>
      getByDepth: (
        depth: number
      ) => Promise<{ success: boolean; data: AssetFolder[]; error?: string }>
      updatePathsRecursively: (
        rootFolderKey: string
      ) => Promise<{ success: boolean; data: boolean; error?: string }>
      hardDelete: (
        folderKey: string
      ) => Promise<{ success: boolean; data: boolean; error?: string }>
      clearDeleted: () => Promise<{ success: boolean; data: boolean; error?: string }>
      search: (
        criteria: FolderSearchCriteria
      ) => Promise<{ success: boolean; data: AssetFolder[]; error?: string }>
      batchDelete: (folderKeys: string[]) => Promise<{
        success: boolean
        data: { deletedCount: number }
        code?: string
        error?: string
      }>
    }
    folderTag: {
      add: (
        folderKey: string,
        tagId: number
      ) => Promise<{ success: boolean; data: number; error?: string }>
      remove: (
        folderKey: string,
        tagId: number
      ) => Promise<{ success: boolean; data: boolean; error?: string }>
      getTagIdsByFolderKey: (
        folderKey: string
      ) => Promise<{ success: boolean; data: number[]; error?: string }>
      getFoldersByTagId: (
        tagId: number
      ) => Promise<{ success: boolean; data: AssetFolder[]; error?: string }>
      setTagsForFolder: (
        folderKey: string,
        tagIds: number[]
      ) => Promise<{ success: boolean; data: { added: number; deleted: number }; error?: string }>
    }
    assetData: {
      getAll: () => Promise<{ success: boolean; data: AssetData[]; error?: string }>
      getDistinctAssetTypes: () => Promise<{
        success: boolean
        data: { className: string; classNameCn: string }[]
        error?: string
      }>
      getById: (
        assetKey: string
      ) => Promise<{ success: boolean; data: AssetData | undefined; error?: string }>
      getByFolderKey: (
        folderKey: string,
        sortBy?: 'assetName' | 'modifiedTime' | 'fileSize' | 'assetType',
        sortOrder?: 'asc' | 'desc',
        showDependencies?: boolean,
        limit?: number,
        offset?: number
      ) => Promise<{ success: boolean; data: AssetData[]; error?: string }>
      getCountByFolderKey: (
        folderKey: string,
        showDependencies?: boolean
      ) => Promise<{ success: boolean; data: number; error?: string }>
      getByFolderKeyRecursive: (
        folderKey: string,
        filters?: AssetDataFilter
      ) => Promise<{ success: boolean; data: AssetData[]; error?: string }>
      searchByName: (
        name: string
      ) => Promise<{ success: boolean; data: AssetData[]; error?: string }>
      create: (assetData: AssetData) => Promise<{ success: boolean; data: number; error?: string }>
      update: (
        assetKey: string,
        assetData: Partial<AssetData>
      ) => Promise<{ success: boolean; data: boolean; error?: string }>
      delete: (assetKey: string) => Promise<{ success: boolean; data: boolean; error?: string }>
      restore: (assetKey: string) => Promise<{ success: boolean; data: boolean; error?: string }>
      moveToFolder: (
        assetKey: string,
        newFolderKey: string
      ) => Promise<{ success: boolean; data: boolean; error?: string }>
      batchCreate: (
        assetsData: AssetData[]
      ) => Promise<{ success: boolean; data: number[]; error?: string }>
      batchDelete: (
        assetKeys: string[]
      ) => Promise<{ success: boolean; data: { deleted: number }; error?: string }>
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
      ) => Promise<any>
      processAssetMetadata: (
        assetKey: string,
        filePath: string
      ) => Promise<{ success: boolean; data: any; error?: string }>
      hardDeleteMany: (assetKeys: string[]) => Promise<{
        success: boolean
        data: { deleted: string[]; failed: Array<{ assetKey: string; error: string }> }
        error?: string
      }>
      restoreMany: (assetKeys: string[]) => Promise<{
        success: boolean
        data: { restored: string[]; failed: Array<{ assetKey: string; error: string }> }
        error?: string
      }>
      clearDeleted: () => Promise<{ success: boolean; data: boolean; error?: string }>
      getAssetReferences: (
        assetKey: string
      ) => Promise<{ success: boolean; data: AssetData[]; error?: string }>
      getAssetImportStatus: (
        assetKey: string
      ) => Promise<{ success: boolean; data: AssetImportStatusSummary; error?: string }>
      getAssetDependencyGraph: (assetKey: string) => Promise<{
        success: boolean
        data: { nodes: DependencyGraphNode[]; edges: DependencyGraphEdge[] }
        error?: string
      }>
    }
    assetTag: {
      add: (
        assetKey: string,
        tagId: number
      ) => Promise<{ success: boolean; data: number; error?: string }>
      remove: (
        assetKey: string,
        tagId: number
      ) => Promise<{ success: boolean; data: boolean; error?: string }>
      getTagIdsByAssetKey: (
        assetKey: string
      ) => Promise<{ success: boolean; data: number[]; error?: string }>
      getAssetsByTagId: (
        tagId: number
      ) => Promise<{ success: boolean; data: AssetData[]; error?: string }>
      getAssetsByAnyTag: (
        tagIds: number[]
      ) => Promise<{ success: boolean; data: AssetData[]; error?: string }>
      getAssetsByAllTags: (
        tagIds: number[]
      ) => Promise<{ success: boolean; data: AssetData[]; error?: string }>
      setTagsForAsset: (
        assetKey: string,
        tagIds: number[]
      ) => Promise<{ success: boolean; data: { added: number; deleted: number }; error?: string }>
      filterAssets: (
        options: TagFilterOptions
      ) => Promise<{ success: boolean; data: AssetData[]; error?: string }>
      /** 每个标签在当前保管库里打在多少个资产上（按库统计，不是全局） */
      getUsageCounts: () => Promise<{
        success: boolean
        data: Array<{ tagId: number; count: number }>
        error?: string
      }>
    }
    assetSemantic: {
      status: () => Promise<{ success: boolean; data: AssetSemanticStatus; error?: string }>
      enable: () => Promise<{ success: boolean; data: AssetSemanticStatus; error?: string }>
      disable: () => Promise<{ success: boolean; data: AssetSemanticStatus; error?: string }>
      resume: () => Promise<{ success: boolean; data: AssetSemanticStatus; error?: string }>
    }
    assetSearch: {
      search: (
        criteria: AssetSearchCriteria
      ) => Promise<{ success: boolean; data: AssetData[]; error?: string }>
    }
    assetFavorite: {
      add: (
        assetKey: string,
        userId?: number,
        vaultId?: string
      ) => Promise<{ success: boolean; data: number; error?: string }>
      remove: (
        assetKey: string,
        userId?: number,
        vaultId?: string
      ) => Promise<{ success: boolean; data: boolean; error?: string }>
      toggle: (
        assetKey: string,
        userId?: number,
        vaultId?: string
      ) => Promise<{ success: boolean; data: boolean; error?: string }>
      isFavorite: (
        assetKey: string,
        userId?: number,
        vaultId?: string
      ) => Promise<{ success: boolean; data: boolean; error?: string }>
      getFavoritesByUser: (
        userId?: number,
        vaultId?: string
      ) => Promise<{ success: boolean; data: AssetFavorite[]; error?: string }>
      batchCheckFavorites: (
        assetKeys: string[],
        userId?: number,
        vaultId?: string
      ) => Promise<{ success: boolean; data: Record<string, boolean>; error?: string }>
      getFavoriteCount: (
        userId?: number,
        vaultId?: string
      ) => Promise<{ success: boolean; data: number; error?: string }>
      clearAllFavorites: (
        userId?: number,
        vaultId?: string
      ) => Promise<{ success: boolean; data: number; error?: string }>
      addFolder: (
        folderKey: string,
        userId?: number,
        vaultId?: string
      ) => Promise<{ success: boolean; data: number | boolean; error?: string }>
      removeFolder: (
        folderKey: string,
        userId?: number,
        vaultId?: string
      ) => Promise<{ success: boolean; data: boolean; error?: string }>
      toggleFolder: (
        folderKey: string,
        userId?: number,
        vaultId?: string
      ) => Promise<{ success: boolean; data: boolean; error?: string }>
      isFolderFavorite: (
        folderKey: string,
        userId?: number,
        vaultId?: string
      ) => Promise<{ success: boolean; data: boolean; error?: string }>
      getFavoriteFoldersWithDetails: (
        userId?: number,
        vaultId?: string
      ) => Promise<{ success: boolean; data: any[]; error?: string }>
      getAllFavoritesWithDetails: (
        userId?: number,
        vaultId?: string
      ) => Promise<{ success: boolean; data: any[]; error?: string }>
    }
    project: {
      saveCover: (
        projectKey: string,
        image: Uint8Array
      ) => Promise<{ success: boolean; data: string; error?: string }>
      restoreAutomaticCover: (
        projectKey: string
      ) => Promise<{ success: boolean; data: boolean; error?: string }>
      importByFilePath: (filePath: string) => Promise<{
        success: boolean
        data?: ProjectRecord
        /** 工程本来就在库里：success 为 false，data 是库里那条现成记录 */
        alreadyRegistered?: boolean
        /** 工程进库了但 UnrealAgentLink 没装上，值是原因码/原文 */
        pluginFailure?: string
        error?: string
      }>
      scanDirectory: (
        startPath: string
      ) => Promise<{ success: boolean; data?: string[]; error?: string }>
      importByDirectory: (startPath: string) => Promise<{
        success: boolean
        data?: { total: number; results: Array<{ filePath: string; id?: number; error?: string }> }
        error?: string
      }>
      create: (record: ProjectRecord) => Promise<{ success: boolean; data: number; error?: string }>
      update: (
        projectKey: string,
        updates: Partial<ProjectRecord>
      ) => Promise<{ success: boolean; data: boolean; error?: string }>
      getAll: () => Promise<{ success: boolean; data: ProjectRecord[]; error?: string }>
      getByKey: (
        projectKey: string
      ) => Promise<{ success: boolean; data: ProjectRecord | undefined; error?: string }>
      delete: (projectKey: string) => Promise<{ success: boolean; data: boolean; error?: string }>
      exists: (projectKey: string) => Promise<{ success: boolean; data: boolean; error?: string }>
      search: (
        keyword: string
      ) => Promise<{ success: boolean; data: ProjectRecord[]; error?: string }>
      /**
       * 查找项目目录下的 .sln 文件（检测 C++ 工程）
       * @param projectDir - 项目目录路径
       * @returns 如果找到 .sln 文件返回其路径，否则返回 null
       */
      findSlnFile: (
        projectDir: string
      ) => Promise<{ success: boolean; data: string | null; error?: string }>
      /** 查询项目里 UnrealAgentLink 的安装状态 */
      ualinkStatus: (
        uprojectPath: string
      ) => Promise<{ success: boolean; data?: UnrealAgentLinkStatus; error?: string }>
      /** 从项目里移除 UnrealAgentLink，并记住不再自动安装 */
      ualinkRemove: (uprojectPath: string) => Promise<{ success: boolean; error?: string }>
      /** 把 UnrealAgentLink 装回项目 */
      ualinkInstall: (uprojectPath: string) => Promise<{ success: boolean; error?: string }>
      /** 首次导入时那一问的答案；装失败的工程和原因码原样返回 */
      ualinkPromptAnswer: (
        install: boolean,
        uprojectPaths: string[]
      ) => Promise<Array<{ uprojectPath: string; reason: string }>>
      /** 首次导入工程、自动安装又关着时，请界面问一句要不要装，返回退订函数 */
      onUALinkInstallPrompt: (callback: (uprojectPath: string) => void) => () => void
      /** 「我的项目」里多了工程时的通知，返回退订函数 */
      onLibraryChanged: (callback: () => void) => () => void
      /** 开机后台升级插件失败时的通知，返回退订函数 */
      onPluginUpgradeFailed: (
        callback: (
          failures: Array<{ project: string; reason: string; uprojectPath: string }>
        ) => void
      ) => () => void
    }
    projectCollection: {
      create: (
        record: ProjectCollectionRecord
      ) => Promise<{ success: boolean; data: number; error?: string }>
      update: (
        collectionKey: string,
        updates: Partial<ProjectCollectionRecord>
      ) => Promise<{ success: boolean; data: boolean; error?: string }>
      delete: (collectionKey: string) => Promise<{
        success: boolean
        data: { deleted: boolean; cleared: number }
        error?: string
      }>
      getAll: () => Promise<{
        success: boolean
        data: Array<ProjectCollectionRecord & { items: ProjectRecord[] }>
        error?: string
      }>
      getByKey: (
        collectionKey: string
      ) => Promise<{ success: boolean; data: ProjectCollectionRecord | undefined; error?: string }>
      exists: (
        collectionKey: string
      ) => Promise<{ success: boolean; data: boolean; error?: string }>
      search: (
        keyword: string
      ) => Promise<{ success: boolean; data: ProjectCollectionRecord[]; error?: string }>
      getProjects: (
        collectionKey: string
      ) => Promise<{ success: boolean; data: ProjectRecord[]; error?: string }>
      addProject: (
        projectKey: string,
        collectionKey: string
      ) => Promise<{ success: boolean; data: boolean; error?: string }>
      removeProject: (
        projectKey: string,
        collectionKey?: string | null
      ) => Promise<{ success: boolean; data: boolean; error?: string }>
    }
    importTask: {
      create: (task: any) => Promise<{ success: boolean; data: any; error?: string }>
      update: (
        taskId: string,
        patch: any
      ) => Promise<{ success: boolean; data: any; error?: string }>
      get: (taskId: string) => Promise<{ success: boolean; data: any; error?: string }>
      list: () => Promise<{ success: boolean; data: any[]; error?: string }>
      pause: (taskId: string) => Promise<{ success: boolean; data: any; error?: string }>
      resume: (taskId: string) => Promise<{ success: boolean; data: any; error?: string }>
    }
  }

  /**
   * 工程模板 API
   */
  interface ProjectTemplateAPI {
    /** 列出所有可用模板（内置 / 自制 / 已下载的社区模板） */
    list: () => Promise<{ success: boolean; templates?: TemplateInfo[]; error?: string }>
    /** 从模板创建工程 */
    createFromTemplate: (params: {
      templatePath: string
      targetDir: string
      projectName: string
    }) => Promise<{ success: boolean; uprojectPath?: string; error?: string }>
    /** 添加自定义模板 */
    addCustomTemplate: (params: {
      sourceProjectPath: string
      templateName: string
    }) => Promise<{ success: boolean; error?: string }>
    /** 列出社区模板源 */
    listSources: () => Promise<{ success: boolean; sources?: TemplateSource[]; error?: string }>
    /** 启用 / 禁用一个源。启用之前不会发出任何网络请求 */
    setSourceEnabled: (params: {
      id: string
      enabled: boolean
    }) => Promise<{ success: boolean; sources?: TemplateSource[]; error?: string }>
    /** 添加自定义源 */
    addSource: (params: {
      name: string
      url: string
    }) => Promise<{ success: boolean; sources?: TemplateSource[]; error?: string }>
    /** 删除自定义源（内置源不可删） */
    removeSource: (params: {
      id: string
    }) => Promise<{ success: boolean; sources?: TemplateSource[]; error?: string }>
    /** 抓取所有已启用源的清单 */
    fetchCommunity: () => Promise<{
      success: boolean
      results?: CommunityFetchResult[]
      error?: string
    }>
    /** 下载一条社区模板到本地模板库 */
    downloadCommunity: (params: {
      sourceId: string
      template: CommunityTemplate
    }) => Promise<{ success: boolean; templatePath?: string; error?: string }>
    /** 取消一个进行中的下载 */
    cancelDownload: (params: {
      sourceId: string
      templateId: string
    }) => Promise<{ success: boolean }>
    /** 订阅下载进度，返回取消订阅函数 */
    onDownloadProgress: (listener: (payload: TemplateDownloadProgress) => void) => () => void
  }

  // 文件对话框API接口
  interface DialogAPI {
    showOpenDialog: (
      options?: Electron.OpenDialogOptions
    ) => Promise<Electron.OpenDialogReturnValue>
    showSaveDialog: (
      options?: Electron.SaveDialogOptions
    ) => Promise<Electron.SaveDialogReturnValue>
    showMessageBox: (
      options?: Electron.MessageBoxOptions
    ) => Promise<Electron.MessageBoxReturnValue>
    showErrorBox: (title: string, content: string) => Promise<{ success: boolean }>
  }

  // 保管库管理API接口
  interface VaultManagerAPI {
    updateVaultOrder: (vaultIds: string[]) => Promise<{ success: boolean; error?: string }>
  }

  // 扩展的ElectronAPI接口
  interface ElectronAPIExtended extends RendererElectronAPI {
    vaultManager: VaultManagerAPI
  }

  // 应用API接口
  interface FileSystemAPI {
    readFolderContents: (folderPath: string) => Promise<any>
    onImportErrorSettled: (callback: (payload: { taskId: string }) => void) => () => void
    onOverwriteSettled: (callback: (payload: { confirmId: string }) => void) => () => void
    cancelImport: (taskId: string) => Promise<{ success: boolean }>
    resolveImportError: (
      taskId: string,
      action: string
    ) => Promise<{ success: boolean; error?: string }>
    readFolderContentsRecursive: (folderPath: string, options?: { taskId?: string }) => Promise<any>
    processFileMetadata: (filePath: string) => Promise<any>
    processBatchFileMetadata: (filePaths: string[]) => Promise<any>
    readFile: (
      filePath: string,
      options?: { encoding?: BufferEncoding; maxLines?: number; maxBytes?: number }
    ) => Promise<{
      success: boolean
      content?: string
      hasMore?: boolean
      totalLines?: number
      totalBytes?: number
      truncated?: boolean
      error?: string
    }>
    readFileBuffer: (
      filePath: string
    ) => Promise<{ success: boolean; data?: ArrayBuffer; error?: string }>
    copyFile: (src: string, dest: string) => Promise<{ success: boolean; error?: string }>
    /**
     * 获取指定路径所在磁盘的剩余空间
     * @param targetPath 目标路径（用于确定检查哪个磁盘）
     * @returns 剩余空间和总空间（字节）
     */
    getDiskSpace: (
      targetPath: string
    ) => Promise<{ success: boolean; free?: number; total?: number; error?: string }>
  }

  interface BaiduYunDownloadProgressEvent {
    downloadId: string
    loaded: number
    total?: number
    percent: number
  }

  interface BaiduYunAPI {
    downloadByFsId: (params: {
      downloadId: string
      accessToken: string
      fsId: number
      filename?: string
      savePath: string
    }) => Promise<{ success: boolean; data?: { savePath: string }; error?: string }>
    downloadByDlink: (params: {
      downloadId: string
      accessToken: string
      dlink: string
      filename?: string
      savePath: string
    }) => Promise<{ success: boolean; data?: { savePath: string }; error?: string }>
    onProgress: (listener: (event: BaiduYunDownloadProgressEvent) => void) => () => void
    getUserInfo: (params: {
      accessToken: string
    }) => Promise<{ success: boolean; data?: any; error?: string }>
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
    }) => Promise<{ success: boolean; data?: { list?: any[] }; error?: string }>
    searchFiles: (params: {
      accessToken: string
      key: string
      dir?: string
      category?: number
      recursion?: number
      web?: number
    }) => Promise<{ success: boolean; data?: { list?: any[] }; error?: string }>
    fileManager: (params: {
      accessToken: string
      opera: 'copy' | 'move' | 'rename' | 'delete'
      filelist: Array<{ path: string; newname?: string; dest?: string }>
      async?: number
      ondup?: string
    }) => Promise<{ success: boolean; data?: any; error?: string }>
    /** 预上传：通知云端新建上传任务 */
    precreate: (params: {
      accessToken: string
      path: string
      size: number
      isdir?: 0 | 1
      blockList: string[]
      rtype?: 0 | 1 | 2 | 3
    }) => Promise<{
      success: boolean
      data?: { uploadid: string; [key: string]: unknown }
      error?: string
    }>
    /** 获取上传域名 */
    locateUpload: (params: { accessToken: string; path: string; uploadid: string }) => Promise<{
      success: boolean
      data?: { host?: string; servers?: unknown[]; server?: unknown[]; [key: string]: unknown }
      error?: string
    }>
    /** 上传文件（主进程读取本地文件并分片上传） */
    uploadFile: (params: {
      accessToken: string
      localPath: string
      remotePath: string
      uploadid: string
      host: string
      uploadId: string
      blockSize?: number
    }) => Promise<{ success: boolean; error?: string }>
    /** 创建文件（合并分片） */
    create: (params: {
      accessToken: string
      path: string
      size: number
      isdir?: 0 | 1
      blockList: string[]
      uploadid?: string
      rtype?: 0 | 1 | 2 | 3
    }) => Promise<{ success: boolean; data?: unknown; error?: string }>
    /** 创建文件夹 */
    createFolder: (params: {
      accessToken: string
      path: string
      rtype?: 0 | 1 | 2 | 3
    }) => Promise<{ success: boolean; data?: unknown; error?: string }>
    /** 查询文件信息 */
    filemetas: (params: {
      accessToken: string
      fsids: Array<number | string>
      dlink?: 0 | 1
      thumb?: 0 | 1
    }) => Promise<{ success: boolean; data?: unknown; error?: string }>
    /** 监听上传进度 */
    onUploadProgress: (
      listener: (event: {
        uploadId: string
        loaded: number
        total: number
        percent: number
        partIndex: number
        partCount: number
      }) => void
    ) => () => void

    // ==================== 文件夹下载相关 API ====================

    /** 下载整个文件夹（递归） */
    downloadFolder: (params: {
      downloadId: string
      accessToken: string
      folderPath: string
      folderName: string
      savePath: string
    }) => Promise<{
      success: boolean
      error?: string
      data?: {
        downloadedCount: number
        failedFiles: Array<{ relativePath: string; error: string }>
        truncated: boolean
        savePath?: string
        message?: string
      }
    }>

    /** 监听文件夹下载进度 */
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
    ) => () => void
  }

  interface WebdavAPI {
    testConnection: (params: {
      serverUrl: string
      username: string
      password: string
    }) => Promise<{ success: boolean; data?: any; error?: string }>
    getDirectoryContents: (params: {
      serverUrl: string
      username: string
      password: string
      path: string
    }) => Promise<{ success: boolean; data?: any; error?: string }>
    uploadFile: (params: {
      serverUrl: string
      username: string
      password: string
      remotePath: string
      fileBuffer: ArrayBuffer
    }) => Promise<{ success: boolean; data?: any; error?: string }>
    downloadFile: (params: {
      serverUrl: string
      username: string
      password: string
      remotePath: string
      savePath?: string
    }) => Promise<{ success: boolean; data?: { localPath: string }; error?: string }>
    deleteFile: (params: {
      serverUrl: string
      username: string
      password: string
      path: string
    }) => Promise<{ success: boolean; data?: any; error?: string }>
    createDirectory: (params: {
      serverUrl: string
      username: string
      password: string
      path: string
    }) => Promise<{ success: boolean; data?: any; error?: string }>
    moveFile: (params: {
      serverUrl: string
      username: string
      password: string
      fromPath: string
      toPath: string
    }) => Promise<{ success: boolean; data?: any; error?: string }>
  }

  // 路径/URL 构造 API
  interface PathAPI {
    getPublicThumbnailUrl: (
      filename: string
    ) => Promise<{ success: boolean; data?: string; error?: string }>
    getVaultThumbnailFilePath: (
      filename: string
    ) => Promise<{ success: boolean; data?: string; error?: string }>
  }
  // Unreal 引擎与插件 API
  interface UnrealEngineInfo {
    name: string
    rootPath: string
    appVersion: string
    version: string
    pluginPath: string
    enginePath: string
  }

  interface InvalidCustomEngineInfo {
    name: string
    rootPath: string
    version: string
  }

  interface UnrealPathAPI {
    /**
     * 扫描已安装引擎。
     *
     * `degraded: true` = 这一趟读失败了，`data` 是上次的缓存（可能为空）。
     * 界面必须把它和「真的一个都没装」分开说，也别据此改用户存的默认引擎。
     */
    scanEngines: () => Promise<{
      success: boolean
      data?: UnrealEngineInfo[]
      degraded?: boolean
      error?: string
    }>
    inspectInvalidCustomPaths: () => Promise<{
      success: boolean
      data?: InvalidCustomEngineInfo[]
      error?: string
    }>
    addCustomPath: (
      customPath: string | string[]
    ) => Promise<{ success: boolean; data?: UnrealEngineInfo | null; error?: string }>
    removeCustomPath: (rootPath: string) => Promise<{ success: boolean; error?: string }>
    resolveEngineAssociations: (
      associations: (string | null)[]
    ) => Promise<{ success: boolean; data?: Record<string, string>; error?: string }>
    getExeVersion: (
      filePath: string
    ) => Promise<{ success: boolean; data?: string; error?: string }>
    compareVersions: (
      a: string | number,
      b: string | number
    ) => Promise<{ success: boolean; data?: -1 | 0 | 1; error?: string }>
  }

  /**
   * 运行中的虚幻项目信息接口
   */
  interface RunningUnrealProject {
    /** 进程ID */
    pid: number
    /** 进程名称 */
    processName: string
    /** 项目文件完整路径 (.uproject) */
    projectPath: string
    /** 项目名称 (不含扩展名) */
    projectName: string
    /** 项目目录 */
    projectDir: string
    /** 引擎版本 (从 uproject 文件解析) */
    engineVersion?: string
  }

  /**
   * 虚幻引擎进程检测 API
   * 用于获取当前运行的虚幻引擎项目信息
   */
  interface UnrealProcessAPI {
    /** 获取所有正在运行的虚幻引擎项目 */
    getRunningProjects: () => Promise<{
      success: boolean
      data?: RunningUnrealProject[]
      error?: string
    }>
    /** 检查虚幻编辑器是否正在运行 */
    isRunning: () => Promise<{ success: boolean; data?: boolean; error?: string }>
    /** 获取主要运行的项目（第一个） */
    getPrimaryProject: () => Promise<{
      success: boolean
      data?: RunningUnrealProject | null
      error?: string
    }>
    /** 根据项目名称查找运行中的项目 */
    findByName: (projectName: string) => Promise<{
      success: boolean
      data?: RunningUnrealProject | null
      error?: string
    }>
    /** 根据项目路径查找运行中的项目 */
    findByPath: (projectPath: string) => Promise<{
      success: boolean
      data?: RunningUnrealProject | null
      error?: string
    }>
  }

  interface AgentAPI {
    /**
     * 执行 Agent
     */
    execute: (args: any) => Promise<{ success: boolean }>
    /**
     * 返回工具执行结果
     */
    returnToolResult: (data: {
      toolCallId: string
      result: any
      sessionId?: string
    }) => Promise<{ success: boolean; error?: string }>
    /**
     * 返回工具执行错误
     */
    returnToolError: (data: {
      toolCallId: string
      error: string
      sessionId?: string
    }) => Promise<{ success: boolean; error?: string }>
  }

  interface AssetAPI {
    syncCurrentVaultThumbnailsToRemote: () => Promise<{
      success: boolean
      data?: {
        scannedRefs: number
        uniqueFiles: number
        uploadedOriginal: number
        uploadedThumb: number
        missingLocal: number
        failed: number
        skipped: number
        missingFiles: string[]
        failedFiles: Array<{ fileName: string; reason: string }>
      }
      error?: string
    }>
    listThumbnailRepairAuditLogs: (limit?: number) => Promise<{
      success: boolean
      data?: Array<{
        id: number
        level: 'info' | 'warn' | 'error'
        action: string
        assetKey?: string | null
        folderKey?: string | null
        target?: string | null
        message: string
        details?: Record<string, unknown> | null
        sourceHost: string
        createdAt: string
      }>
      error?: string
    }>
    saveThumbnail: (
      base64Data: string,
      assetKey?: string
    ) => Promise<{ success: boolean; data?: string; error?: string }>
    saveThumbnailFile: (
      srcPath: string,
      assetKey?: string
    ) => Promise<{ success: boolean; data?: string; error?: string }>
    saveOriginalAndCroppedThumbnail: (
      originalBase64: string,
      croppedBase64: string,
      assetKey?: string
    ) => Promise<{ success: boolean; data?: string; error?: string }>
    overwriteThumb: (
      posterFilename: string,
      croppedBase64: string,
      assetKey?: string
    ) => Promise<{ success: boolean; error?: string }>
    readFileAsBase64: (
      filePath: string
    ) => Promise<{ success: boolean; data?: string; error?: string }>
    reimportAsset: (assetKey: string) => Promise<{ success: boolean; error?: string }>
    uploadProjectArchive: (
      sourcePath: string,
      targetFolderKey?: string | null,
      taskId?: string
    ) => Promise<{
      success: boolean
      error?: string
      data?: {
        status: 'committed' | 'failed'
        sessionId?: string
        assetKey: string
        archiveName: string
        remotePath: string
        archiveBytes: number
        fileCount: number
        excludedDirs: string[]
        uploadMs: number
        elapsedMs: number
        mbPerSec: number
        uploadAttempts: number
        error?: string
        errorCode?: string
      }
    }>
    pullProjectArchive: (params: {
      remotePath: string
      fileName: string
      destDir: string
      taskId?: string
    }) => Promise<{
      success: boolean
      error?: string
      data?: {
        localPath: string
        extracted: boolean
        fileCount: number
        archiveBytes: number
        downloadMs: number
        extractMs: number
        mbPerSec: number
      }
    }>
    reimportFolder: (folderKey: string) => Promise<{
      success: boolean
      total?: number
      successCount?: number
      failed?: number
      error?: string
    }>
  }

  interface API {
    readonly platform: NodeJS.Platform
    window: {
      minimize: () => void
      maximize: () => void
      close: () => void
      quit: () => void
      focus: () => void
    }
    /** MiniChat 小窗口的窗口控制与侧边上下文投递 */
    miniChat: {
      close: () => void
      minimize: () => void
      togglePin: () => void
      setOpacity: (opacity: number) => void
      sessionSaved: (session: { id: string; title: string; messages?: unknown[] }) => void
      requestInitialMessage: () => void
      /** 带着主对话的上下文打开侧边窗口（主窗口调） */
      openWithContext: (context: SideQuestionContext) => void
      requestInitialContext: () => void
      /** 这些 on* 一律返回取消订阅的函数，组件卸载时调它 */
      onInitialMessage: (callback: (message: MiniChatInitialMessage) => void) => () => void
      onInitialContext: (callback: (context: SideQuestionContext) => void) => () => void
      onPinChanged: (callback: (pinned: boolean) => void) => () => void
      onResetSession: (callback: () => void) => () => void
    }
    /** 从标签栏拖出来的独立对话窗口，以及它和主窗口之间的对话同步 */
    chatWindow: {
      /** 打开这条对话的独立窗口；已经开着就提到前面。坐标是松手处的屏幕坐标 */
      open: (args: {
        chatSid: string
        screenX?: number
        screenY?: number
      }) => Promise<{ success: boolean; error?: string }>
      /** 现在开在独立窗口里的对话 */
      list: () => Promise<string[]>
      /** 独立窗口报上它那条对话的内核 session id（审批镜像按它找窗口） */
      bindAgentSession: (args: { chatSid: string; agentSessionId: string }) => void
      /** 在主窗口里打开一个路由（独立窗口里点了属于主界面的东西） */
      openInMain: (path: string) => void
      push: (patch: ChatSyncPatch) => void
      /** 独立窗口要一份这条对话的最新全量，主窗口用 full 补丁回 */
      requestSnapshot: (chatSid: string) => void
      /** 把这几个内核 session 的待审批补发给自己 */
      resendApprovals: (sessionIds: string[]) => Promise<number>
      /** 别的窗口正在跑的内核 session */
      runsElsewhere: () => Promise<string[]>
      /** 这些 on* 一律返回取消订阅的函数 */
      onChanged: (callback: (chatSids: string[]) => void) => () => void
      onNavigate: (callback: (args: { path: string }) => void) => () => void
      onApply: (callback: (patch: ChatSyncPatch) => void) => () => void
      onSnapshotRequest: (callback: (args: { sid: string }) => void) => () => void
    }
    /** Spotlight 快捷搜索与窗口控制 */
    spotlight: {
      search: (query: string) => Promise<SpotlightSearchResponse>
      execute: (action: SpotlightAction, data: Record<string, unknown>) => void
      close: () => void
      onShow: (callback: (payload: { dictate: boolean }) => void) => () => void
      onHide: (callback: () => void) => () => void
      /** 语音热键还按着（键盘自动重复）。keyup 收不到时靠它判松手 */
      onHold: (callback: () => void) => () => void
      /** 渲染层收到了语音热键的 keyup，这一次按住结束 */
      holdReleased: () => void
    }
    database: DatabaseAPI
    dialog: DialogAPI
    projectTemplate: ProjectTemplateAPI
    fs: FileSystemAPI
    baiduYun: BaiduYunAPI
    asset: AssetAPI
    /**
     * 视频处理 API
     */
    video: {
      /** 使用 FFmpeg 提取视频中间帧并保存为缩略图，`data` 是纯文件名 */
      extractAndSaveThumbnail: (
        videoPath: string,
        assetKey: string
      ) => Promise<{ success: boolean; data?: string; absolutePath?: string; error?: string }>
      /** 检查文件是否为视频文件 */
      isVideoFile: (
        filePath: string
      ) => Promise<{ success: boolean; data?: boolean; error?: string }>
      /**
       * 检查 FFmpeg 是否可用。
       *
       * 应用不随包分发 FFmpeg，所以除了可用与否，还要给出**当前平台的安装命令**，
       * 界面据此弹可复制的指引（见 renderer/utils/ffmpegGuard.ts）。
       */
      checkFFmpegAvailable: () => Promise<{
        success: boolean
        /** 是否可用。保留这个名字是为了兼容既有调用点 */
        data?: boolean
        /** 探测到的可执行文件路径；不可用时为 null */
        path?: string | null
        /** 当前平台的安装命令，如 winget install Gyan.FFmpeg */
        installCommand?: string
        downloadUrl?: string
        error?: string
      }>
      /** 压缩视频到指定大小以下（双遍编码） */
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
      ) => Promise<{
        success: boolean
        outputPath?: string
        outputSize?: number
        outputSizeMB?: number
        originalSize?: number
        compressionRatio?: number
        error?: string
      }>
      /** 快速压缩视频（单遍） */
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
      ) => Promise<{
        success: boolean
        outputPath?: string
        outputSize?: number
        outputSizeMB?: number
        originalSize?: number
        compressionRatio?: number
        error?: string
      }>
      /** 为 AI 分析压缩视频（预设参数优化） */
      compressForAI: (
        inputPath: string,
        outputPath?: string
      ) => Promise<{
        success: boolean
        outputPath?: string
        outputSize?: number
        outputSizeMB?: number
        originalSize?: number
        compressionRatio?: number
        error?: string
      }>
    }
    webdav: WebdavAPI
    /**
     * 局域网协作库 API
     */
    networkVault: {
      /** 测试网络路径访问 */
      testAccess: (networkPath: string) => Promise<{ success: boolean; error?: string }>
      /** 读取清单 */
      readManifest: (
        networkPath: string
      ) => Promise<{ success: boolean; data?: any; error?: string }>
      /** 扫描现有资产并初始化清单 */
      initializeFromExisting: (
        networkPath: string,
        vaultName: string
      ) => Promise<{ success: boolean; data?: any; error?: string }>
      /** 扫描资产 */
      scanAssets: (
        networkPath: string,
        options?: object
      ) => Promise<{ success: boolean; data?: any; error?: string }>
      /** 检查远程更新 */
      checkForUpdates: (
        networkPath: string,
        lastKnownVersion: number
      ) => Promise<{ success: boolean; data?: any; error?: string }>
      /** 删除资产（同步到网络并删除本地记录） */
      deleteAsset: (
        networkPath: string,
        assetKey: string
      ) => Promise<{ success: boolean; error?: string }>
      /** 批量删除资产 */
      batchDeleteAssets: (
        networkPath: string,
        assetKeys: string[]
      ) => Promise<{
        success: boolean
        data?: { deletedCount: number }
        error?: string
      }>
      /** 检查网络路径写入权限 */
      checkWritePermission: (networkPath: string) => Promise<{ canWrite: boolean; error?: string }>
    }
    path: PathAPI
    oauth: {
      startWechat: (authUrl: string) => Promise<{ success: boolean }>
      onWechatCallback: (listener: (payload: { code: string; state: string }) => void) => () => void
      startEpic: (authUrl: string) => Promise<{ success: boolean }>
      /** 使用系统浏览器打开 Epic OAuth（避免 Cloudflare 阻止） */
      startEpicBrowser: (authUrl: string) => Promise<{ success: boolean; error?: string }>
      /** Epic OAuth 回调监听 - 桌面端返回完整 tokens */
      onEpicCallback: (
        listener: (payload: {
          code: string
          state: string
          error?: string
          accessToken?: string
          refreshToken?: string
          userId?: string
          username?: string
          epicDisplayName?: string
          phone?: string
          action?: string // 'login' 或 'link'
        }) => void
      ) => () => void
    }
    /**
     * Epic 引擎项目发现 API
     */
    epic: {
      /**
       * 获取 Epic Launcher 最近打开的项目列表
       */
      getRecentProjects: () => Promise<{
        success: boolean
        projects?: Array<{
          projectPath: string
          projectName: string
          engineVersion: string
          lastOpenTime: string
          isImported: boolean
          thumbnailPath?: string
        }>
        error?: string
      }>
    }
    unrealPath: UnrealPathAPI
    unrealProcess: UnrealProcessAPI
    /**
     * UE 崩溃日志 API
     * 读取项目 Saved/Crashes 和 Saved/Logs 目录获取崩溃日志
     */
    ueCrashLogs: {
      /**
       * 获取崩溃日志
       * @param params.projectPath 可选的项目路径
       * @param params.maxLogs 最大日志数量
       */
      get: (params?: { projectPath?: string; maxLogs?: number }) => Promise<{
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
      }>
    }
    /** 顶栏状态监控：这条对话归属的工程现在的编辑器状况 */
    ueEditorHealth: {
      get: (params: { projectPath: string }) => Promise<EditorHealthResult>
    }
    agent: AgentAPI
    projectImport: {
      checkCompatibility: (
        project: { EngineAssociation?: string | null },
        sources: Array<{ assetKey?: string }>
      ) => Promise<{
        success: boolean
        error?: string
        data?: {
          projectVersion: string
          blocked: Array<{ assetKey: string; assetName: string; version: string }>
        }
      }>

      importUAssets: (
        project: ProjectRecord,
        source: { assetKey?: string; skipDependencyResolution?: boolean } | null
      ) => Promise<{
        success: boolean
        copied?: number
        total?: number
        warnings?: string[]
        results?: Array<{ assetKey: string; from: string; to: string }>
        error?: string
        alreadyExists?: boolean
      }>
      /**
       * 整个文件夹一次导完。
       * 主进程内部走「规划串行 + 拷贝并发」的流水线，整批共用依赖解析状态
       */
      importUAssetsBatch: (
        project: ProjectRecord,
        sources: Array<{
          assetKey?: string
          assetName?: string
          skipDependencyResolution?: boolean
        }>,
        /** ignoreEngineVersion：用户在版本冲突弹窗点了「仍然导入」才为 true */
        options?: { requestId?: string; ignoreEngineVersion?: boolean }
      ) => Promise<{
        success: boolean
        total: number
        succeeded: number
        existing: number
        failed: number
        copied: number
        /** 排了队但没能写进工程的文件数 */
        filesFailed: number
        bytesCopied: number
        cancelled: boolean
        warnings: string[]
        /** 出了什么问题、影响了谁。失败详情弹窗读它 */
        report: ImportFailureReport
        /** 这批资产用到、目标工程没开的插件 */
        missingPlugins?: MissingPlugin[]
        /** 本机哪儿都找不到的插件和代码，只能提示 */
        unavailablePlugins?: UnavailablePlugin[]
        error?: string
      }>
      /** 把插件写进工程的 .uproject（用户在弹窗里确认过的）。重启编辑器生效 */
      enablePlugins: (
        project: ProjectRecord,
        names: string[]
      ) => Promise<{
        success: boolean
        enabled?: string[]
        /** 编辑器开着却没接住的：只写进了文件，在编辑器里改插件之前要先重启 */
        editorFailed?: string[]
        error?: string
      }>
      /** 中止一批正在跑的导入；正在拷的那个文件会写完 */
      cancelImportUAssetsBatch: (requestId: string) => Promise<{ success: boolean; found: boolean }>
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
      ) => () => void
      /**
       * 通过 UE 插件导入外部文件（FBX/GLB/PNG 等）
       */
      importExternalFiles: (params: {
        files: string[]
        destinationPath?: string
        overwrite?: boolean
      }) => Promise<{
        success: boolean
        imported_count?: number
        imported?: Array<{
          name: string
          path: string
          class: string
          originalName?: string
          normalizedName?: string
        }>
        warnings?: string[]
        error?: string
        ue_not_connected?: boolean
      }>
      /**
       * 规范化导入 uasset/umap 资产到 UE 项目
       * 通过 UE 插件的 content.normalized_import 命令实现
       */
      normalizedImportAssets: (params: {
        files: string[]
        targetRoot?: string
        usePascalCase?: boolean
        autoRenameOnConflict?: boolean
      }) => Promise<{
        success: boolean
        totalFiles?: number
        successCount?: number
        failedCount?: number
        imported?: Array<{
          originalName: string
          normalizedName: string
          oldPath: string
          newPath: string
          assetClass: string
        }>
        redirects?: Array<{ from: string; to: string }>
        warnings?: string[]
        errors?: string[]
        error?: string
        ue_not_connected?: boolean
      }>
      /** 把 zip 素材包解进工程的 Content 目录，见 src/main/services/project/archiveImport.ts */
      extractArchiveToProject: (params: { zipPath: string; projectPath: string }) => Promise<{
        success: boolean
        destDir?: string
        fileCount?: number
        error?: string
      }>
    }
    cli: {
      status: () => Promise<CliStatus>
      addToPath: () => Promise<CliPathChangeResult>
      removeFromPath: () => Promise<CliPathChangeResult>
      reveal: () => Promise<{ ok: boolean; message?: string }>
    }
    /** 对象存储（用户自己的 S3 兼容桶）。Secret 只进不出 */
    objectStorage: {
      get: () => Promise<ObjectStorageConfigView>
      save: (
        input: ObjectStorageSaveInput
      ) => Promise<{ success: boolean; view?: ObjectStorageConfigView; error?: string }>
      test: (input: ObjectStorageSaveInput) => Promise<{ ok: boolean; message: string }>
      /** 开着且配完整了 */
      ready: () => Promise<boolean>
      list: () => Promise<ObjectStorageListResult>
      remove: (keys: string[]) => Promise<ObjectStorageRemoveResult>
      clean: (days: number) => Promise<ObjectStorageRemoveResult>
      upload: (filePath: string) => Promise<{ success: boolean; key?: string; error?: string }>
      onUploadProgress: (
        callback: (payload: { filePath: string; percent: number; note: string }) => void
      ) => () => void
    }
    updater: {
      checkForUpdates: () => Promise<{ success: boolean; error?: string }>
      downloadUpdate: () => Promise<{ success: boolean; error?: string }>
      quitAndInstall: () => Promise<{ success: boolean; error?: string }>
      getStatus: () => Promise<{
        success: boolean
        data?: {
          checking: boolean
          updateAvailable: boolean
          updateDownloaded: boolean
          currentVersion: string
          latestVersion?: string
          downloadProgress?: {
            percent: number
            transferred: number
            total: number
          }
        }
        error?: string
      }>
      onUpdateChecking: (callback: () => void) => () => void
      onUpdateAvailable: (callback: (data: { version: string }) => void) => () => void
      onUpdateNotAvailable: (callback: () => void) => () => void
      onDownloadProgress: (
        callback: (data: { percent: number; transferred: number; total: number }) => void
      ) => () => void
      onUpdateDownloaded: (callback: (data: { version: string }) => void) => () => void
      onUpdateError: (callback: (data: { message: string; code?: string }) => void) => () => void
    }
    system: {
      getInfo: () => Promise<{
        platform?: string
        version?: string
        isWindows11?: boolean
        appVersion?: string
      }>
    }
    getPathForFile: (file: File) => string
    /** 拖拽入口的路径体检，见 src/shared/droppedPath.ts */
    classifyDroppedPaths: (
      filePaths: string[]
    ) => Promise<Array<{ path: string; verdict: DroppedPathVerdict }>>
    getFileStats: (filePath: string) => Promise<any>
    startNativeFileDrag: (filePath: string) => Promise<{ success: boolean; data?: boolean }>
    /** 删除本地文件 */
    deleteFile: (filePath: string) => Promise<{ success: boolean; error?: string }>
    importSingleFile: (
      filePath: string,
      targetFolderKey: string
    ) => Promise<{
      success: boolean
      fileExtension?: string
      assetKey?: string
      folderKey?: string
    }>
    invoke: (channel: string, ...args: any[]) => Promise<any>
    /** 蓝图包 / 材质包（保管库里的 .ueblueprint / .uematerial 目录） */
    libraryPackage: {
      scan: () => Promise<
        LibraryPackageIpcResult<{
          entries: LibraryPackageDto[]
          problems: LibraryPackageProblemDto[]
        }>
      >
      read: (dirPath: string) => Promise<LibraryPackageIpcResult<LibraryPackageDto | null>>
      create: (payload: {
        library: LibraryKind
        id: string
        name: string
        payload: unknown
        parentRelPath?: string
      }) => Promise<LibraryPackageIpcResult<LibraryPackageDto | null>>
      update: (
        dirPath: string,
        patch: { name?: string; payload?: unknown; cover?: string }
      ) => Promise<LibraryPackageIpcResult<LibraryPackageDto | null>>
      rename: (
        dirPath: string,
        newName: string
      ) => Promise<LibraryPackageIpcResult<LibraryPackageDto | null>>
      delete: (dirPath: string) => Promise<LibraryPackageIpcResult<boolean>>
      /** 分组列表、迁移标记这类库级元信息。null 表示还没写过。 */
      readMeta: () => Promise<LibraryPackageIpcResult<string | null>>
      writeMeta: (text: string) => Promise<LibraryPackageIpcResult<boolean>>
      writeFile: (
        dirPath: string,
        relPath: string,
        data: Uint8Array
      ) => Promise<LibraryPackageIpcResult<boolean>>
      readFile: (
        dirPath: string,
        relPath: string
      ) => Promise<LibraryPackageIpcResult<Uint8Array | null>>
    }
    shell: {
      /** pathNotFound：路径已经不在磁盘上（删了或移走了），调用方该给一句人话 */
      openPath: (
        targetPath: string
      ) => Promise<{ success: boolean; error?: string; pathNotFound?: boolean }>
      showItemInFolder: (
        targetPath: string
      ) => Promise<{ success: boolean; error?: string; pathNotFound?: boolean }>
      openExternal: (url: string) => Promise<{ success: boolean; error?: string }>
      openWith: (filePath: string, appPath: string) => Promise<{ success: boolean; error?: string }>
      /** 用代码编辑器打开路径（走编辑器注册的 URL 协议，没装则无响应） */
      openInEditor: (
        targetPath: string,
        editor: string
      ) => Promise<{ success: boolean; error?: string }>
      /** 这台机器上装了哪些编辑器（按 URL 协议注册情况判断） */
      listEditors: () => Promise<{ success: boolean; editors?: string[]; error?: string }>
    }
    dragMove: {
      moveItems: (
        items: { id: string; type: 'file' | 'folder' }[],
        targetFolderId: string
      ) => Promise<{ success: boolean; data?: any; error?: string }>
      validateMove: (
        items: { id: string; type: 'file' | 'folder' }[],
        targetFolderId: string
      ) => Promise<{ success: boolean; data?: any; error?: string }>
    }
    /**
     * WebSocket 服务 API
     * 用于与 Unreal Engine 实例通讯
     */
    websocket: {
      /** 启动 WebSocket 服务器 */
      start: (port?: number) => Promise<{ success: boolean; error?: string }>
      /** 停止 WebSocket 服务器 */
      stop: () => Promise<{ success: boolean; error?: string }>
      /**
       * 获取服务状态。
       *
       * 注意它**不是** `{ success, data }` 那个形状 —— `ws:status` 直接把
       * WebSocketServiceStatus 返回出来。界面要的是 `startError`：桥接没起来时
       * 那句话是用户唯一的线索（端口被谁占了、该怎么办）。
       */
      getStatus: () => Promise<BridgeStatus>
      /**
       * 监听桥接自身的状态变化（起来了 / 起不来 / 被停掉），返回退订函数。
       *
       * 和 `onProjectsChanged` 是两回事：那个说「哪些工程此刻连着」，
       * 这个说「盒子这一侧的服务在不在」。
       */
      onStatusChanged: (callback: (status: BridgeStatus) => void) => () => void
      /** 获取连接列表 */
      getConnections: () => Promise<{ success: boolean; data?: unknown[]; error?: string }>
      /** 发送事件（单向通知） */
      emit: (
        method: string,
        payload: unknown,
        clientId?: string
      ) => Promise<{ success: boolean; error?: string }>
      /** 发送请求（RPC 模式） */
      call: <T>(method: string, payload: unknown, clientId?: string, timeout?: number) => Promise<T>
      /** 监听来自 UE 的事件。`method` 是事件名，如 `messagelog.changed` */
      onEvent: (
        callback: (data: { method?: string; payload: unknown; clientId?: string }) => void
      ) => () => void
      /** 监听连接变化 */
      onConnectionChange: (
        callback: (data: { clientId: string; connected: boolean; payload?: unknown }) => void
      ) => () => void
      /** 获取所有已连接的工程列表 */
      getProjects: () => Promise<ConnectedProject[]>
      /** 获取指定连接的工程信息 */
      getProject: (connectionId: string) => Promise<unknown>
      /** 监听工程列表变化 */
      onProjectsChanged: (callback: (projects: ConnectedProject[]) => void) => () => void
    }
    /**
     * 蓝图预览 API
     * 用于接收 Agent 发送的蓝图规划数据
     */
    blueprintPreview: {
      /** 监听蓝图规划预览事件 */
      onPreview: (callback: (plan: unknown) => void) => () => void
    }
    /**
     * 命名规则配置 API
     */
    namingRules: {
      /** 加载配置 */
      loadConfig: () => Promise<import('../renderer/src/types/namingRules').NamingRulesConfig>
      /** 保存配置。`removedKeys` 是这一轮在设置页点掉的出厂键，按表分组 */
      saveConfig: (config: NamingRulesSavePayload) => Promise<boolean>
      /** 重置配置 */
      resetConfig: () => Promise<boolean>
    }
    ai: {
      chatCompletion: (
        args: unknown
      ) => Promise<{ success: boolean; data?: unknown; error?: string }>
      /** 这个角色实际会用哪个模型、窗口多大。没配模型时返回保守缺省值 */
      modelLimits: (args?: { role?: string; level?: string }) => Promise<{
        success: boolean
        data?: {
          configured: boolean
          providerId?: string
          modelId?: string
          contextWindow: number
          maxOutputTokens: number
        }
        error?: string
      }>
      chatStream: (args: unknown) => Promise<{ success: boolean; error?: string }>
      abortStream: (sessionId: string) => Promise<{ success: boolean }>
      /** 返回取消监听的函数 */
      onStreamChunk: (
        callback: (payload: { sessionId: string; delta: string }) => void
      ) => () => void
      onStreamDone: (
        callback: (payload: {
          sessionId: string
          text: string
          aborted: boolean
          /** 本轮 token 用量。厂商不报用量时没有这个字段 */
          usage?: AgentTurnUsage
        }) => void
      ) => () => void
      onStreamError: (
        callback: (payload: { sessionId: string; message: string }) => void
      ) => () => void
      /**
       * 用户自己配的「生图」模型出图。图片以 base64 回来，不是外链。
       *
       * 线格式见 `src/main/ai/imageGeneration.ts` 的 GenerateImagesRequest。
       */
      generateImage: (args: {
        prompt: string
        providerId?: string
        modelId?: string
        count?: number
        size?: string
        aspectRatio?: string
        referenceImages?: string[]
        seed?: number
        /** 顺手存进素材库 AIGC/图片；存上的那张带回 filePath */
        saveToLibrary?: boolean
      }) => Promise<{
        success: boolean
        data?: { images: Array<{ base64: string; mediaType: string; filePath?: string }> }
        error?: string
      }>
      imageModelStatus: () => Promise<{
        success: boolean
        data?: { configured: boolean; model: string | null }
      }>
    }
    /** AIGC 生图任务 */
    imageGeneration: {
      /** 掐断正在出图的那条任务。主进程会补发一条 `image:event` 的 failed，界面据此回落 */
      cancelTask: (taskId: string) => Promise<{ success: boolean; error?: string }>
    }
    /**
     * 本地直连 Provider 配置。
     *
     * 线格式见 `src/shared/aiProvider.ts`。注意 getSettings 拿回来的密钥
     * 只有 `hasKey: boolean` —— 明文读不回渲染层，这是设计而非遗漏。
     */
    speech: {
      synthesize: (
        request: import('../shared/speech').SpeechRequest
      ) => Promise<import('../shared/speech').SpeechResult>
      cancel: (requestId: string) => Promise<void>
      onChunk: (callback: (chunk: import('../shared/speech').SpeechChunk) => void) => () => void
    }
    aiProvider: {
      catalog: () => Promise<import('../shared/aiProvider').CatalogEntry[]>
      getSettings: () => Promise<import('../shared/aiProvider').SettingsView>
      saveProvider: (
        draft: import('../shared/aiProvider').ProviderDraft
      ) => Promise<
        import('../shared/aiProvider').AiProviderResult<import('../shared/aiProvider').SettingsView>
      >
      deleteProvider: (
        providerId: string
      ) => Promise<
        import('../shared/aiProvider').AiProviderResult<import('../shared/aiProvider').SettingsView>
      >
      setEnabled: (
        providerId: string,
        enabled: boolean
      ) => Promise<
        import('../shared/aiProvider').AiProviderResult<import('../shared/aiProvider').SettingsView>
      >
      /** 正在跑的对话里有几个用着这个服务商 */
      usage: (providerId: string) => Promise<number>
      /** 只发改了的角色，null = 清空；主进程在最新的配置上合并 */
      setRoles: (
        patch: import('../shared/aiProvider').RoleBindingsPatch
      ) => Promise<
        import('../shared/aiProvider').AiProviderResult<import('../shared/aiProvider').SettingsView>
      >
      test: (
        draft: import('../shared/aiProvider').ProviderDraft,
        modelId: string
      ) => Promise<import('../shared/aiProvider').TestProviderResult>
      listModels: (
        draft: import('../shared/aiProvider').ProviderDraft
      ) => Promise<import('../shared/aiProvider').ListModelsResult>
      revealConfig: () => Promise<void>
      oauthLogin: (
        oauthProvider: string,
        draft: import('../shared/aiProvider').ProviderDraft
      ) => Promise<
        import('../shared/aiProvider').AiProviderResult<{
          key?: string
          settings?: import('../shared/aiProvider').SettingsView
        }>
      >
      oauthCancel: () => Promise<void>
      onOAuthDeviceCode: (
        callback: (prompt: {
          userCode: string
          verificationUri: string
          verificationUriComplete?: string
        }) => void
      ) => () => void
    }
    /** Box Plan。没连接时这些调用都不联网 */
    creatorPlan: {
      state: () => Promise<
        import('../shared/creatorPlan').CreatorPlanResult<
          import('../shared/creatorPlan').CreatorPlanState
        >
      >
      connect: () => Promise<
        import('../shared/creatorPlan').CreatorPlanResult<
          import('../shared/creatorPlan').CreatorPlanPreview
        >
      >
      cancel: () => Promise<void>
      preview: () => Promise<
        import('../shared/creatorPlan').CreatorPlanResult<
          import('../shared/creatorPlan').CreatorPlanPreview
        >
      >
      apply: (
        roles: import('../shared/aiProvider').ModelRole[],
        options?: import('../shared/creatorPlan').CreatorPlanApplyOptions
      ) => Promise<
        import('../shared/creatorPlan').CreatorPlanResult<
          import('../shared/creatorPlan').CreatorPlanState
        >
      >
      disconnect: () => Promise<
        import('../shared/creatorPlan').CreatorPlanResult<
          import('../shared/creatorPlan').CreatorPlanDisconnectResult
        >
      >
      openManage: () => Promise<void>
      onDeviceCode: (
        callback: (prompt: import('../shared/creatorPlan').CreatorPlanDevicePrompt) => void
      ) => () => void
    }
    /**
     * Jina Reader / Search API
     * 用于读取网页内容和 Web 搜索
     */
    webRead: {
      /**
       * 读取网页内容
       * @param url - 要读取的网页 URL
       * @returns 网页内容结果
       */
      read: (url: string) => Promise<{
        success: boolean
        title?: string
        content?: string
        description?: string
        url?: string
        error?: string
      }>
    }
    /**
     * 对话附件解释 API
     *
     * 视频、PDF、Word 这类文件模型吃不下，得先在本地解释成描述文本或图片帧。
     */
    attachment: {
      /**
       * 解释一个附件
       * @param filePath - 文件的绝对路径（拖拽来的 File 请先过 getPathForFile）
       */
      ingest: (filePath: string) => Promise<{
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
      }>
      /**
       * 订阅解释进度
       * @returns 取消订阅的函数
       */
      onProgress: (callback: (payload: { filePath: string; note: string }) => void) => () => void
    }
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
      load: (filePath: string) => Promise<{
        success: boolean
        content?: string
        metadata?: {
          source: string
          title?: string
          [key: string]: unknown
        }
        error?: string
      }>
      /**
       * 加载文档（增强版，支持图片提取）
       * @param filePath - 文件的绝对路径
       * @param options - 配置选项
       * @returns 文档内容、元数据和提取的图片路径
       */
      loadWithImages: (
        filePath: string,
        options: { notebookId: string; extractImages?: boolean }
      ) => Promise<{
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
      }>
      /**
       * 检查文件类型是否支持
       * @param filePath - 文件路径
       */
      isSupported: (filePath: string) => Promise<boolean>
      /**
       * 获取支持的文件扩展名列表
       */
      getSupportedExtensions: () => Promise<string[]>
    }
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
      upload: (params: { filePath: string; apiKey?: string; modelName?: string }) => Promise<{
        success: boolean
        ossUrl?: string
        expireTime?: string
        error?: string
      }>
    }
    /** 实时语音连接。密钥只在主进程，渲染层只负责麦克风与喇叭 */
    realtimeVoice: {
      /** 上行采样率。开会话之前问，麦克风要赶在连接之前开起来攒首字 */
      audioSpec: () => Promise<
        { ok: true; inputSampleRate: number; outputSampleRate: number } | { ok: false }
      >
      /** `echoGuard`：回声门限档位。首帧只读一次，所以随开会话一起带，不单推 */
      start: (args?: {
        model?: string
        voice?: string
        history?: Array<{ role: 'user' | 'assistant'; text: string }>
        echoGuard?: RealtimeEchoGuard
        /** 这条对话输入框里选的模型。拼装通话（没绑实时语音时）拿它接电话 */
        brain?: { providerId: string; modelId: string }
      }) => Promise<
        | { ok: true; inputSampleRate: number; outputSampleRate: number; connectionId: number }
        | { ok: false; error: string }
      >
      /**
       * 只转写、不回答的听写会话。
       *
       * `reason` 分三类，调用方处置不同：`busy`（助手页正在通话）和
       * `vendor-unsupported`（豆包做不了只转写不回答）都该**静默退回打字**，
       * 只有 `unconfigured` / `failed` 需要把 `error` 说给用户听。
       */
      startDictation: () => Promise<
        | { ok: true; inputSampleRate: number; outputSampleRate: number; connectionId: number }
        | { ok: false; reason: 'busy' | 'vendor-unsupported' }
        | { ok: false; reason: 'unconfigured' | 'failed'; error: string }
      >
      /** 「按住说话」松手了：别等静音判停，现在就转写 */
      commitAudio: () => Promise<{ ok: true }>
      stop: () => Promise<{ ok: true }>
      playbackReady: (connectionId: number) => void
      sendAudio: (base64: string) => void
      sendText: (text: string) => void
      /** 防冷场开关（偏好设置 → 语音助手） */
      setAntiSilence: (enabled: boolean) => void
      /** 无人回应时自动结束通话 */
      setAutoHangup: (enabled: boolean) => void
      runLocalTool: (name: string) => Promise<{ ok: boolean; output: string }>
      reportFloor: (args: { userSpeaking: boolean; assistantSpeaking: boolean }) => void
      dispatchTask: (args: {
        instruction: string
        executionInstruction?: string
        resumeTaskId?: string
        agentSessionId: string
        sessionLabel?: string
        when?: 'queue' | 'now'
      }) => Promise<
        | {
            ok: true
            action: 'start'
            taskId: string
            attempt?: number
            ack: string
            agentSessionId?: string
            instruction?: string
            executionInstruction?: string
          }
        | { ok: true; action: 'queued'; taskId: string; ack: string }
        | { ok: true; action: 'steer'; taskId: string; agentSessionId: string; ack: string }
        | { ok: false; ack: string }
      >
      taskFailed: (args: { taskId: string; reason: string; attempt?: number }) => void
      describeTask: (taskId?: string) => Promise<{ text: string }>
      cancelTask: (
        taskId?: string
      ) => Promise<
        { found: true; taskId: string; agentSessionId: string } | { found: false; text: string }
      >
      answerQuestion: (taskId?: string) => Promise<
        | {
            found: true
            taskId: string
            toolCallId: string
            agentSessionId: string
            questionCount: number
          }
        | { found: false; text: string }
      >
      approveTask: (taskId?: string) => Promise<
        | {
            found: true
            taskId: string
            toolCallId: string
            toolName: string
            allowAlways: boolean
          }
        | { found: false; text: string }
      >
      endCall: (force?: boolean) => Promise<{ hangUp: boolean; text: string }>
      onRunTask: (
        handler: (task: {
          taskId: string
          attempt?: number
          agentSessionId: string
          instruction: string
          executionInstruction?: string
        }) => void
      ) => () => void
      cancelResponse: () => void
      sendToolResults: (results: { callId: string; output: string }[]) => void
      onEvent: (
        handler: (payload: import('../main/ai/realtime/types').VoiceSessionEvent) => void
      ) => () => void
      /** 用户按了「打断语音助手」那个全局快捷键。返回取消订阅函数 */
      onInterruptShortcut: (handler: () => void) => () => void
      /** 主窗口报「语音通话接通 / 挂断」，主进程转给每个窗口 */
      setCallActive: (active: boolean) => void
      /** 别的窗口现在在不在通话（窗口刚起来时问一次） */
      getCallActiveElsewhere: () => Promise<boolean>
      /** 别的窗口的语音通话接通 / 挂断。返回取消订阅函数 */
      onCallActive: (handler: (active: boolean) => void) => () => void
      /** Spotlight 开始听写（该停下朗读了）。返回取消订阅函数 */
      onDictationStarted: (handler: () => void) => () => void
    }
    /**
     * 听写（语音识别）。只出文字，和 `realtimeVoice` 是两路独立会话。
     *
     * 绑了「语音识别」角色时 Spotlight 优先走这条；没绑（`audioSpec` 回
     * `ok: false`）才回落到 `realtimeVoice.startDictation`。
     */
    speechToText: {
      /** 上行采样率；`ok: false` 表示没绑这个角色，调用方该回落 */
      audioSpec: () => Promise<{ ok: true; inputSampleRate: number } | { ok: false }>
      /**
       * `reason` 分三类，调用方处置不同：`busy`（助手页正在通话）**静默退回打字**，
       * `unconfigured`（没绑语音识别角色）**回落到实时语音那一路**，
       * 只有 `failed` 需要把 `error` 说给用户听。
       */
      start: () => Promise<
        | { ok: true; inputSampleRate: number }
        | { ok: false; reason: 'busy' | 'unconfigured' }
        | { ok: false; reason: 'failed'; error: string }
      >
      /**
       * 「按住说话」松手了：音频到此为止，但**终稿还要**。
       *
       * 别拿 `stop` 代替 —— 它一进门就不再放事件，收尾包换回来的那条终稿
       * 正好被丢掉，表现是松手之后输入框永远少最后一句。
       */
      flush: () => Promise<{ ok: true }>
      stop: () => Promise<{ ok: true }>
      sendAudio: (base64: string) => void
      onEvent: (handler: (payload: unknown) => void) => () => void
    }
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
      }) => Promise<{
        success: boolean
        markdown?: string
        error?: string
        /** 视频的 临时媒体 URL */
        mediaUrl?: string
      }>
      /**
       * 检查视觉服务状态
       */
      status: () => Promise<{ available: boolean; model?: string; error?: string }>
      /**
       * 简化的文档图片分析（用于 DOCX 内嵌图片）
       * @param params.imagePath - 本地文件路径（优先）
       * @param params.imageUrl - 图片 URL（备用）
       */
      analyzeDocumentImage: (params: {
        imagePath?: string
        imageUrl?: string
        context?: string
      }) => Promise<{ success: boolean; description?: string; error?: string }>
      /**
       * 简化的 PDF 页面分析（用于扫描版 PDF）
       * @param params.imagePath - 本地文件路径（优先）
       * @param params.imageUrl - 图片 URL（备用）
       */
      analyzePdfPage: (params: {
        imagePath?: string
        imageUrl?: string
        pageNumber?: number
      }) => Promise<{ success: boolean; content?: string; error?: string }>
    }

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
      analyze: (params: { url: string; prompt?: string }) => Promise<{
        success: boolean
        content?: string
        title?: string
        videoId?: string
        url?: string
        error?: string
      }>
      /**
       * 验证 YouTube URL 格式
       * @param url - 待验证的 URL
       */
      validate: (url: string) => Promise<boolean>
      /**
       * 提取 YouTube 视频 ID
       * @param url - YouTube 视频 URL
       */
      extractId: (url: string) => Promise<string | null>
    }
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
      read: (url: string) => Promise<{
        success: boolean
        title?: string
        content?: string
        author?: string
        publishTime?: string
        error?: string
      }>
      /**
       * 验证是否为有效的微信公众号文章链接
       * @param url - 待验证的 URL
       */
      validate: (url: string) => Promise<boolean>
    }
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
      analyze: (params: { url: string; prompt?: string }) => Promise<{
        success: boolean
        content?: string
        videoId?: string
        error?: string
      }>
      /**
       * 订阅分析进度。解析链接、下载、压缩、送模型各报一句，整条链最长要几分钟
       * @returns 退订函数
       */
      onAnalyzeProgress: (callback: (payload: { url: string; note: string }) => void) => () => void
      /**
       * 验证 Bilibili URL 格式
       * @param url - 待验证的 URL
       */
      validate: (url: string) => Promise<boolean>
      /**
       * 提取 Bilibili 视频 ID (BV号)
       * @param url - Bilibili 视频 URL
       */
      extractId: (url: string) => Promise<string | null>
      /** 获取用于播放/展示的临时视频直链，不执行内容分析 */
      resolveVideoUrl: (url: string) => Promise<{
        success: boolean
        data: string
        error?: string
      }>
      /**
       * 快速获取视频元信息（标题、封面、描述）
       * @param bvid - 视频 BV 号
       * @returns 视频元信息
       */
      fetchInfo: (bvid: string) => Promise<{
        success: boolean
        title?: string
        pic?: string
        desc?: string
        owner?: { name: string; face: string; mid: number }
        duration?: number
        bvid?: string
        error?: string
      }>
    }
    /**
     * 知识库 API
     * 本地存储知识库及来源数据
     */
    notebook: {
      /** 创建知识库 */
      create: (data: {
        title?: string
        description?: string
        coverStyle?: string
        coverImage?: string
      }) => Promise<string>
      /** 获取单个知识库 */
      get: (notebookId: string) => Promise<NotebookData | null>
      /** 获取知识库列表 */
      list: (options?: { limit?: number; offset?: number }) => Promise<NotebookData[]>
      /** 更新知识库 */
      update: (
        notebookId: string,
        updates: {
          title?: string
          description?: string
          coverStyle?: string
          coverImage?: string
        }
      ) => Promise<boolean>
      /** 删除知识库 */
      delete: (notebookId: string) => Promise<boolean>
      /** 获取知识库数量 */
      count: () => Promise<number>
      /** 添加来源 */
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
      }) => Promise<string>
      /** 获取知识库的所有来源 */
      getSources: (notebookId: string) => Promise<NotebookSourceData[]>
      /** 更新来源 */
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
          summaryContent?: string | null
          summaryStatus?: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped' | null
          /** 这条来源进上下文的档位 */
          contextLevel?: NotebookContextLevel
          /** 视频的 临时媒体 URL */
          mediaUrl?: string | null
        }
      ) => Promise<boolean>
      /** 删除来源 */
      deleteSource: (sourceId: string) => Promise<boolean>
      /** 把这条来源正文里的图交给视觉模型读一遍。开关没开时原样返回 */
      readSourceImages: (sourceId: string) => Promise<{
        success: boolean
        stats?: {
          total: number
          read: number
          decorative: number
          skipped: number
          overLimit: number
        }
        error?: string
      }>
      /** RAG: 索引知识库内容 */
      ragIndex: (params: { notebookId: string; sourceIds?: string[] }) => Promise<{
        indexedSources: number
        indexedChunks: number
      }>
      /** RAG: 将知识库来源加入后台索引队列 */
      ragQueueIndex: (params: { notebookId: string; sourceIds?: string[] }) => Promise<{
        queuedJobs: number
        skippedSources: number
        queuedSourceIds: string[]
      }>
      /** RAG: 查询后台索引队列状态 */
      ragListIndexJobs: (params?: { notebookId?: string }) => Promise<NotebookIndexJobStatusView[]>
      /** Chat V2: 准备知识库对话上下文 */
      chatV2Prepare: (params: {
        notebookId: string
        query: string
        sourceIds?: string[]
        notebookTitle?: string
        limit?: number
        contextMaxChars?: number
        searchTimeoutMs?: number
      }) => Promise<NotebookChatV2PrepareResult>
      /** RAG: 向量检索 */
      ragSearch: (params: {
        notebookId: string
        query: string
        limit?: number
        sourceIds?: string[]
      }) => Promise<
        Array<{
          chunkId: string
          notebookId: string
          sourceId: string
          content: string
          metadata?: string | null
          chunkIndex: number
          createdAt: string
          updatedAt: string
          /** 向量距离，只按关键词命中的片段为 null */
          distance: number | null
          score?: number
          matchedBy?: 'semantic' | 'keyword' | 'both'
          sourceTitle?: string | null
          sourceUrl?: string | null
          fileName?: string | null
        }>
      >
    }
    /**
     * 应用设置 API（通用键值存储）
     */
    settings: {
      get: (key: string, defaultValue?: any) => Promise<any>
      set: (key: string, value: any) => Promise<boolean>
    }
    /**
     * AI 对话历史落盘 API（原来存 localStorage，配额只有几 MB）
     */
    chatHistory: {
      read: () => Promise<{ 'chat-sessions'?: string; 'follow-up-queue'?: string }>
      write: (key: string, value: string) => Promise<void>
      sessionsIndex: () => Promise<Record<string, { typing?: string[] }>>
      importLegacySessions: (json: string) => Promise<Record<string, { typing?: string[] }>>
      readSessionSync: (sid: string) => string | null
      readSessions: (sids: string[]) => Promise<Record<string, string>>
      writeSessions: (
        writes: Array<{ sid: string; json: string | null; typing?: string[] }>
      ) => Promise<void>
    }
    /**
     * 渲染层凭据的加密落盘；available 为 false 时 write 会被拒绝
     */
    secureStore: {
      read: () => Promise<{ available: boolean; values: Record<string, string> }>
      write: (key: string, value: string | null) => Promise<void>
    }
    /**
     * 个性化 API：用户写给 agent 的那段常驻说明。技能的列与删在 `agentV3` 下。
     */
    personalization: {
      /** 读那段说明，连同字数上限和它在盘上的位置 */
      getInstructions: () => Promise<{ text: string; limit: number; path: string }>
      setInstructions: (text: string) => Promise<{ success: boolean; error?: string }>
    }
    /** agent 系统通知：用户点了之后界面要跳到那条对话 */
    agentNotifications: {
      /** 取走主进程存着的那条激活（取走即清）。推送落空时靠它补回来 */
      takePending: () => Promise<NotificationActivatePayload | null>
      /** 回话：这条激活认没认出来。没认出来主进程会把通知重新弹一条 */
      reportActivation: (result: NotificationActivationResult) => Promise<void>
    }
    /** 系统托盘菜单：界面报最近对话、取还没送到的托盘动作 */
    tray: {
      /** 最近活跃的三条对话变了，主进程据此重建菜单 */
      setRecentSessions: (sessions: TrayRecentSession[]) => Promise<{ success: boolean }>
      /** 取走主进程存着的那条托盘动作（取走即清）—— 唯一的送达路径 */
      takePending: () => Promise<TrayAction | null>
      /** 用户在退出确认框里选了「仍然退出」 */
      confirmQuit: (reason?: 'update') => Promise<{ success: boolean }>
    }
    /**
     * 应用设置 API
     */
    appSettings: {
      /** 获取应用设置 */
      get: () => Promise<{
        autoLaunch: boolean
        enableFollowUpSuggestions: boolean
        language: 'zh-CN' | 'en-US'
        autoEnableUnrealAgentLink: boolean
        agentBrowserMode: 'window' | 'embedded' | 'hidden'
        agentFileAccessScope: 'ue-only' | 'full'
        agentToolSearchEnabled: boolean
        /** 自动断点续传：中转不稳时每 60 秒自动续跑，最长 30 分钟 */
        agentPersistentAutoResume: boolean
        /** 目标模式最多迭代几轮，范围见 `shared/goalRounds.ts` */
        agentGoalMaxRounds: number
        /** 全量模式下关掉的工具名 */
        agentDisabledTools: string[]
        /** 审批卡片上点过「以后都允许」的工具名 */
        agentAlwaysAllowedTools: string[]
        /** 工具搜索模式下偏离内置常驻清单的那些 */
        agentResidentTools: Record<string, boolean>
        notifyTurnComplete: 'off' | 'unfocused' | 'always'
        notifyApprovalRequired: boolean
        notifyQuestionRequired: boolean
        hideWindowOnProjectLaunch: boolean
        autoRecoverEditorCrash: boolean
        /** agent 搜素材时看不看别的保管库，默认关 */
        assetCrossVaultSearch: boolean
        /** agent 改资产期间把锁住的文件设成只读，默认关 */
        assetReadonlyLock: boolean
        /** Agent 浏览器能否访问本机和局域网地址，默认关 */
        agentBrowserAllowLocalNetwork: boolean
      }>
      /** 更新应用设置 */
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
      }) => Promise<{ success: boolean }>
      /** 设置开机自启 */
      setAutoLaunch: (enabled: boolean) => Promise<{ success: boolean }>
      /** 设置应用语言 */
      setLanguage: (language: 'zh-CN' | 'en-US') => Promise<{ success: boolean }>
      /** 获取应用语言 */
      getLanguage: () => Promise<'zh-CN' | 'en-US'>
      /** 让 Windows 任务栏和托盘图标跟随实际生效的主题 */
      setThemeIcon: (
        theme: 'light' | 'dark'
      ) => Promise<{ success: boolean; data: boolean; error?: string }>
      /** 设置启动项目时自动启用 UnrealAgentLink 插件 */
      setAutoEnableUnrealAgentLink: (enabled: boolean) => Promise<{ success: boolean }>
      /** 获取启动项目时自动启用 UnrealAgentLink 插件设置 */
      getAutoEnableUnrealAgentLink: () => Promise<boolean>
      /** 手动修复并清理引擎目录中残留的 UnrealAgentLink 插件 */
      repairUnrealAgentLinkEngineResidue: () => Promise<{
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
      }>
    }
    /**
     * 截图模式 API
     * 用于截取产品图，支持透明背景
     */
    screenshot: {
      /** 进入截图模式 */
      enterMode: () => Promise<{ success: boolean; error?: string }>
      /** 退出截图模式 */
      exitMode: () => Promise<{ success: boolean; error?: string }>
      /** 执行截图 */
      capture: () => Promise<{ success: boolean; filePath?: string; error?: string }>
      /** 获取截图模式状态 */
      getState: () => Promise<{ isActive: boolean; padding: number }>
      /** 监听截图模式变化事件 */
      onModeChanged: (callback: (data: { active: boolean; padding: number }) => void) => () => void
      /** 监听通过快捷键触发进入截图模式 */
      onEnterViaShortcut: (callback: () => void) => () => void
    }
    /**
     * 屏幕录制 API
     */
    screenRecorder: {
      getSources: () => Promise<Array<{ id: string; name: string; thumbnail: string }>>
      saveFile: (
        buffer: ArrayBuffer,
        extension?: string
      ) => Promise<{ success: boolean; filePath?: string; error?: string }>
      autoSave: (
        buffer: ArrayBuffer,
        extension?: string
      ) => Promise<{ success: boolean; filePath?: string; error?: string }>
      openQuickWindow: () => Promise<{ success: boolean; error?: string }>
      closeQuickWindow: () => Promise<{ success: boolean; error?: string }>
      moveQuickWindow: (
        position: 'center' | 'bottom-right'
      ) => Promise<{ success: boolean; error?: string }>
      setQuickWindowMode: (
        mode: 'expanded' | 'collapsed'
      ) => Promise<{ success: boolean; error?: string }>
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
        outputPath?: string
      }) => Promise<{ success: boolean; filePath?: string; error?: string }>
      getRecordingsDir: () => Promise<{ success: boolean; dirPath?: string; error?: string }>
      listRecordings: () => Promise<{
        success: boolean
        dirPath?: string
        data?: Array<{ name: string; path: string; size: number; mtime: string; extension: string }>
        error?: string
      }>
      deleteRecording: (filePath: string) => Promise<{ success: boolean; error?: string }>
      startSelection: () => Promise<{
        selection: { x: number; y: number; width: number; height: number }
        displayBounds: { x: number; y: number; width: number; height: number }
      } | null>
      selectionComplete: (bounds: { x: number; y: number; width: number; height: number }) => void
      selectionCancelled: () => void
    }
    /**
     * 服务端资产库（新后端 asset-catalog）：在线分页浏览，本机只缓存看过的页和图。
     * 令牌只在主进程；这里只回"有没有登录"。
     */
    catalogLibrary: {
      list: () => Promise<CatalogIpcResult<CatalogLibraryView[]>>
      servers: () => Promise<CatalogIpcResult<CatalogServerView[]>>
      probe: (
        address: string,
        caFingerprint?: string | null,
        caPem?: string | null
      ) => Promise<CatalogIpcResult<CatalogProbeResult>>
      connect: (input: CatalogConnectInput) => Promise<CatalogIpcResult<CatalogConnectResult>>
      remoteLibraries: (serverId: string) => Promise<CatalogIpcResult<CatalogRemoteLibrary[]>>
      add: (
        serverId: string,
        libraries: Array<{ id: string; name: string }>
      ) => Promise<CatalogIpcResult<CatalogLibraryView[]>>
      remove: (key: string) => Promise<CatalogIpcResult<void>>
      signIn: (
        serverId: string,
        input: {
          member?: string | null
          password?: string | null
          inviteCode?: string | null
          identityToken?: string | null
        }
      ) => Promise<CatalogIpcResult<CatalogServerView>>
      signOut: (serverId: string) => Promise<CatalogIpcResult<void>>
      setLoreRemote: (serverId: string, remote: string | null) => Promise<CatalogIpcResult<void>>
      status: (key: string) => Promise<CatalogIpcResult<CatalogLibraryStatus>>
      watch: (key: string) => Promise<CatalogIpcResult<CatalogLibraryStatus>>
      unwatch: (key: string) => Promise<CatalogIpcResult<void>>
      folders: (
        key: string,
        parent: number
      ) => Promise<
        CatalogIpcResult<{ folder: CatalogFolder | null; items: CatalogFolder[]; stale: boolean }>
      >
      folderByPath: (key: string, path: string) => Promise<CatalogIpcResult<CatalogFolder>>
      listWindow: (
        key: string,
        query: CatalogListQuery,
        start: number,
        limit: number
      ) => Promise<CatalogIpcResult<CatalogWindow>>
      facets: (
        key: string,
        query: CatalogListQuery,
        fields?: CatalogFacetField[],
        limit?: number
      ) => Promise<CatalogIpcResult<CatalogFacets>>
      detail: (key: string, id: number) => Promise<CatalogIpcResult<CatalogAssetDetail>>
      probeAnnotations: (key: string) => Promise<CatalogIpcResult<boolean>>
      editAnnotations: (
        key: string,
        ops: Array<{
          path?: string
          folderPath?: string
          set?: Record<string, unknown>
          addTags?: string[]
          removeTags?: string[]
        }>
      ) => Promise<CatalogIpcResult<{ accepted: number; journalSeq: number | null }>>
      loreInfo: () => Promise<
        CatalogIpcResult<{
          path: string | null
          version: string | null
          pinned: boolean
          problem: string | null
        }>
      >
      listTags: (key: string) => Promise<CatalogIpcResult<CatalogTagDef[]>>
      putTag: (
        key: string,
        name: string,
        patch: { color?: string | null; group?: string | null }
      ) => Promise<CatalogIpcResult<void>>
      deleteTag: (key: string, name: string) => Promise<CatalogIpcResult<void>>
      searchFolders: (
        key: string,
        q: string,
        limit?: number,
        dir?: number
      ) => Promise<CatalogIpcResult<CatalogFolder[] | null>>
      closure: (key: string, id: number) => Promise<CatalogIpcResult<CatalogClosure | null>>
      unclaimed: (key: string) => Promise<CatalogIpcResult<CatalogUnclaimed[] | null>>
      claim: (key: string, from: string, to: string) => Promise<CatalogIpcResult<void>>
      favorites: (key: string) => Promise<CatalogIpcResult<CatalogFavorites>>
      setFavorite: (
        key: string,
        kind: 'asset' | 'folder',
        id: number,
        on: boolean
      ) => Promise<CatalogIpcResult<CatalogFavorites>>
      download: (
        key: string,
        input: { ids: number[]; targetRoot: string; withDependencies: boolean }
      ) => Promise<CatalogIpcResult<string>>
      resolveRepository: (
        key: string,
        folder: { dirId: number; path: string }
      ) => Promise<
        CatalogIpcResult<{
          repositoryId: string | null
          candidates: string[]
          names: Record<string, string>
        }>
      >
      import: (
        key: string,
        input: {
          files: string[]
          folderPath: string
          repositoryId: string
          message?: string | null
        }
      ) => Promise<CatalogIpcResult<string>>
      cancelJob: (jobId: string) => Promise<CatalogIpcResult<void>>
      clearCache: (key?: string | null) => Promise<CatalogIpcResult<void>>
      getActive: () => Promise<CatalogIpcResult<string | null>>
      setActive: (key: string | null) => Promise<CatalogIpcResult<void>>
      pickFiles: () => Promise<CatalogIpcResult<string[]>>
      pickFolder: () => Promise<CatalogIpcResult<string | null>>
      pickCaFile: () => Promise<CatalogIpcResult<string | null>>
      /** 订阅主进程推来的失效 / 状态 / 作业进度；返回取消订阅 */
      onEvent: (listener: (event: CatalogLibraryEvent) => void) => () => void
    }
    /** 共享技能（官网共享库）。类型见 src/shared/share.ts */
    share: {
      pendingInstalls: () => Promise<ShareIpcResult<SharedSkillInstallRequest[]>>
      installReply: (
        requestId: string,
        approve: boolean
      ) => Promise<ShareIpcResult<SharedSkillInstallOutcome>>
      packSkill: (name: string) => Promise<ShareIpcResult<SharedSkillPack>>
      submitSkill: (name: string) => Promise<ShareIpcResult<SharedSkillSubmitResult>>
      connect: () => Promise<ShareIpcResult<{ account: string | null }>>
      cancelConnect: () => Promise<void>
      onConnectPrompt: (listener: (prompt: SharedSkillConnectPrompt) => void) => () => void
      openPage: (url: string) => Promise<ShareIpcResult<void>>
      onInstallRequest: (listener: (request: SharedSkillInstallRequest) => void) => () => void
      onInstallFailed: (listener: (failure: SharedSkillInstallFailure) => void) => () => void
    }
    /**
     * 团队工程（版本控制与资产协作）。`call` 的动作名和参数见
     * src/main/libraryV3/team/teamOps.ts；返回值是团队服务成员面的 JSON（src/shared/teamProject.ts）。
     */
    team: {
      join: (input: {
        server: string
        caFingerprint?: string | null
        project?: string | null
        member: string
        password: string
      }) => Promise<
        CatalogIpcResult<{
          member: string
          displayName: string
          keys: string[]
          openKey: string | null
          noProjects: boolean
        }>
      >
      peek: (link: TeamJoinLink) => Promise<CatalogIpcResult<{ projectName: string | null }>>
      parseLink: (raw: string) => Promise<CatalogIpcResult<TeamJoinLink | null>>
      pendingJoinLink: () => Promise<CatalogIpcResult<TeamJoinLink | null>>
      call: (key: string, op: string, args?: unknown) => Promise<CatalogIpcResult<unknown>>
      facts: (
        key: string,
        hashes: string[],
        library?: string | null
      ) => Promise<CatalogIpcResult<Record<string, TeamFact | null>>>
      inviteLink: (key: string) => Promise<CatalogIpcResult<string | null>>
      startStreams: () => Promise<CatalogIpcResult<void>>
      restartStream: (serverId: string) => Promise<CatalogIpcResult<void>>
      streamState: (
        serverId: string
      ) => Promise<CatalogIpcResult<{ connected: boolean; signedOut: boolean }>>
      localInfo: (key: string) => Promise<
        CatalogIpcResult<{
          localPath: string | null
          exists: boolean
          uproject: string | null
          unsynced: string[]
        }>
      >
      freeSpace: (path: string) => Promise<CatalogIpcResult<number | null>>
      inspectFolder: (
        path: string
      ) => Promise<CatalogIpcResult<{ hasLore: boolean; uproject: string | null; empty: boolean }>>
      syncToLocal: (
        key: string,
        input: { targetDir: string; existing?: boolean }
      ) => Promise<CatalogIpcResult<string>>
      putIn: (key: string, input: { sourceDir: string }) => Promise<CatalogIpcResult<string>>
      setFolderSynced: (
        key: string,
        folder: string,
        synced: boolean
      ) => Promise<CatalogIpcResult<{ ok: boolean; pending: number }>>
      restore: (
        key: string,
        input: { path: string; number: number }
      ) => Promise<CatalogIpcResult<{ ok: boolean }>>
      isModified: (key: string, path: string) => Promise<CatalogIpcResult<boolean>>
      cancelCheckout: (
        key: string,
        input: { path: string; discard: boolean }
      ) => Promise<CatalogIpcResult<{ kept: string | null }>>
      deliver: (
        key: string,
        input: { files: string[]; message: string; facts?: unknown[] }
      ) => Promise<CatalogIpcResult<string>>
      approveDelivery: (
        key: string,
        input: { id: string; paths: string[]; message: string }
      ) => Promise<CatalogIpcResult<string>>
      sendReference: (
        key: string,
        input: { company: string; paths: string[]; note: string }
      ) => Promise<CatalogIpcResult<string>>
      openPath: (path: string) => Promise<CatalogIpcResult<boolean>>
      notify: (input: {
        key?: string
        title: string
        body: string
        open?: { serverId: string; project: string; path?: string } | null
      }) => Promise<CatalogIpcResult<boolean>>
      /** 订阅团队事件（通知、该重新取了、通知流连上 / 断开、邀请链接）；返回取消订阅 */
      onEvent: (listener: (event: TeamEvent) => void) => () => void
    }
    /**
     * Agent V3 —— 扁平单 agent + pi 内核。
     *
     * 渲染层必须走这里，不要直接 ipcRenderer.invoke('agent-v3:*')：
     * 那些通道不在 RAW_REQUEST_CHANNELS 白名单里，会被挡下。
     */
    agentBrowser: {
      tab: (
        sessionId: string,
        command: BrowserTabCommand
      ) => Promise<{ success: boolean; data: null; error?: string; code?: string }>
      toolbar: (
        sessionId: string,
        action: BrowserToolbarAction
      ) => Promise<{
        success: boolean
        data: null
        error?: string
        code?: string
      }>
      openUrl: (
        sessionId: string,
        address: string
      ) => Promise<{
        success: boolean
        data: { url: string }
        error?: string
        code?: string
      }>
      command: (
        sessionId: string,
        command: BrowserCommand
      ) => Promise<{ success: boolean; data: null; error?: string; code?: string }>
      find: (
        sessionId: string,
        query: { text: string; forward?: boolean; findNext?: boolean } | null
      ) => Promise<{ success: boolean; data: null; error?: string; code?: string }>
      /** 报告嵌入面板的位置；传 null 表示此刻不该显示 */
      setBounds: (
        bounds: { x: number; y: number; width: number; height: number } | null,
        sessionId?: string
      ) => void
      /** 关掉当前页面 */
      close: (sessionId?: string) => Promise<{ success: boolean }>
      /** 查询状态；进入对话时传 restore 恢复已保存页面 */
      getState: (
        sessionId?: string,
        restore?: boolean
      ) => Promise<{
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
      }>
    }
    agentV3: {
      /** 发起一轮。会自动恢复该 sessionId 此前的 transcript */
      execute: (args: {
        sessionId: string
        prompt: string
        mode?: 'agent' | 'ask'
        approvalMode?: AgentV3ApprovalMode
        /** 思考程度。不传等于 auto（不指定，随模型默认） */
        thinkingLevel?: AgentV3ThinkingLevel
        /** 「快速」：Codex 订阅走 priority 档，别的模型忽略 */
        fastMode?: boolean
        /** 技能沉淀档位。不传等于 ask（想沉淀时先问用户） */
        skillLearning?: AgentV3SkillLearning
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
        /** 这条对话归属的 UE 工程；主进程只知道「谁连着」，归属得由渲染层带下来 */
        sessionProject?: AgentV3SessionProject | null
        /** 这条对话绑着的知识库。绑了主进程才给 search_notebook_sources 工具 */
        notebook?: { id: string; title?: string } | null
        /**
         * 用户按下发送那一刻的编辑器状态（闪存）。
         *
         * 主进程**不会自己抓** —— 到那时排队的消息可能已经等了几分钟。
         * `null` 是用户明确去掉了，不传是这个入口还没接。
         */
        editorSnapshot?: EditorSnapshot | null
        /** 这条对话绑定的模型。不传就用执行记录里那份，都没有按全局默认绑定 */
        sessionModel?: { providerId: string; modelId: string }
      }) => Promise<{
        success: boolean
        /** 按码拒绝（如 SESSION_BUSY）时带，渲染层查文案用；error 原文始终保留给日志 */
        code?: AgentStartRejectionCode
        error?: string
        modelId?: string
        providerId?: string
        toolCount?: number
        /** 这条内核 session 真正拿到的工具名。数量答不了「那个工具在不在池里」，只能逐个核对 */
        toolNames?: string[]
        ueConnected?: boolean
        restoredMessages?: number
      }>
      /** 从断点续跑（上一轮报错或中断时用），保留全部上下文 */
      continue: (args: {
        sessionId: string
        mode?: 'agent' | 'ask'
        sessionProject?: AgentV3SessionProject | null
        /** 不带的话续跑会退回默认的「每步都问」，而用户什么都没改过 */
        approvalMode?: AgentV3ApprovalMode
        /** 对话此刻绑的模型；用户报错后换了模型再续跑，得用新的 */
        sessionModel?: { providerId: string; modelId: string }
      }) => Promise<{
        success: boolean
        /** 按码拒绝（如 SESSION_BUSY）时带，渲染层查文案用；error 原文始终保留给日志 */
        code?: AgentStartRejectionCode
        error?: string
        restoredMessages?: number
      }>
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
      }) => Promise<{ success: boolean; data: null; error?: string }>
      /** 运行中插话改方向。消息在当前轮结束后注入，不打断执行 */
      steer: (args: {
        sessionId: string
        message: string
        /**
         * 提交那一刻的编辑器状态（闪存）。
         *
         * 它和正在跑的那一轮**必须是同一个工程**，对不上主进程直接拒绝这次插话
         * （`success: false`），一个字都不注入 —— 丢掉快照照发的话，模型会在
         * 正在跑的工程里找一个不存在的「这个」。
         */
        editorSnapshot?: EditorSnapshot | null
        /**
         * 随这句插话一起带的图。
         *
         * **不会为它换模型**：这一轮用哪个模型在跑起来那一刻就定了，中途换会把
         * 整段 prompt cache 作废。当前模型看不了图时，模型会照实说自己看不到。
         */
        images?: Array<{ type: 'image'; data: string; mimeType: string }>
        /** 随这句插话带的音视频路径，主进程按正在跑的模型决定换链接还是只给路径 */
        mediaFiles?: Array<{ filePath: string; fileName: string; kind: 'video' | 'audio' }>
        /** 已经解析好的文档 / 表格正文 */
        contextText?: string
        /** 撤回这一条要用的号。这一轮已经收尾、内核不收时没有它 */
      }) => Promise<{
        success: boolean
        /** 按码拒绝（NOT_RUNNING / PROJECT_MISMATCH）时带，渲染层查文案用 */
        code?: SteerRejectionCode
        error?: string
        /** PROJECT_MISMATCH 时带：快照抓的工程 / 这一轮在跑的工程，原值，可能为空串 */
        errorParams?: SteerRejectionErrorParams
        steerId?: string
      }>
      /**
       * 撤回一条还排着的插话。
       *
       * 「排队中」只是界面上的说法 —— 话早就交给内核了。内核已经把它读进上下文
       * 的话就撤不回来（抽掉等于篡改历史），那时 `success` 为 false、
       * `reason` 是 `already-sent`，界面要如实说「晚了一步」。
       */
      cancelSteer: (args: {
        sessionId: string
        steerId: string
      }) => Promise<{ success: boolean; reason?: 'already-sent' }>
      /**
       * 抓一份此刻的编辑器状态（闪存）。在用户**按下发送那一刻**调。
       *
       * 外层永远 `success: true`；抓取本身的成败在 `data.ok` 里，
       * 发送流程照它降级 —— 闪存抓不到绝不该让一条消息发不出去。
       */
      captureEditorSnapshot: (args: {
        sessionProject?: AgentV3SessionProject | null
        /** 这条对话正在跑时传它的内核 session id：排队的和插的都要跟着那一轮的工程 */
        runningSessionId?: string
      }) => Promise<{ success: true; data: EditorSnapshotCaptureResult }>
      /**
       * 停止一条内核 session。**等它真的停下来**才返回。
       *
       * `drained` 为 false 表示等超时了它还没停 —— 这时紧接着再 execute 一次
       * 会被主进程以 `SESSION_BUSY` 拒掉，调用方该改成提示用户稍后再试。
       */
      stop: (args: {
        sessionId: string
      }) => Promise<{ success: boolean; drained?: boolean; error?: string }>
      /** 当前被 agent 独占的资产。界面上那个「AI 锁定了 N 个资产」读它 */
      locks: () => Promise<{
        success: boolean
        locks: Array<{
          path: string
          connectionId?: string
          owner: string
          acquiredAt: number
        }>
      }>
      /** 全部强制解锁 —— 逃生口。锁卡死时用户唯一的出路 */
      releaseAllLocks: () => Promise<{ success: boolean; released: number }>
      /** 目标模式（`/goal`）这条内核 session 的目标。没有时 goal 为 null；settled = 这一轮复核已有结论 */
      goalState: (args: {
        sessionId: string
      }) => Promise<{ success: boolean; goal: { objective: string; settled: boolean } | null }>
      /** 取消这条内核 session 的目标。正在跑的时候不行（errorKey 'running'） */
      goalEnd: (args: {
        sessionId: string
      }) => Promise<{ success: boolean; error?: string; errorKey?: 'running' }>
      /** 工作室模式（`/team`）的任务板面板。不是工作室的内核 session team 为 null */
      teamState: (args: {
        sessionId: string
      }) => Promise<{ success: boolean; team: TeamStateView | null }>
      /** 「外部团队」页：Claude Code 当大脑的那些团队（`ext-*`），最近的在前 */
      externalTeams: () => Promise<{ success: boolean; teams: ExternalTeamSummary[] }>
      /** 任务板上卡住的一项改回待办，下一轮制作人会看到 */
      teamTaskReopen: (args: {
        sessionId: string
        taskId: string
      }) => Promise<{ success: boolean; error?: string }>
      /** 把一件停下的活交回制作人：任务板上加一项「用户重开」的待办 */
      teamJobReopen: (args: {
        sessionId: string
        jobId: string
      }) => Promise<{ success: boolean; error?: string }>
      /** 给一个队员换模型，记成用户定的。先过入职体检，没过带回 checkup。正在跑也行：它下一件活开始用 */
      teamMemberModel: (args: {
        sessionId: string
        name: string
        providerId: string
        modelId: string
      }) => Promise<{ success: boolean; error?: string; checkup?: ModelCheckup }>
      /** 辞退一个队员。理由必填；手上有活的不行（errorKey 'busy'）。档案留在团队的账里 */
      teamMemberDismiss: (args: {
        sessionId: string
        name: string
        reason: string
      }) => Promise<{ success: boolean; error?: string; errorKey?: DismissalErrorCode }>
      /** 结束团队模式。正在跑的时候不行（errorKey 'running'）；任务板和队员留在盘上 */
      teamEnd: (args: {
        sessionId: string
      }) => Promise<{ success: boolean; error?: string; errorKey?: 'running' }>
      /** 设置「团队」页：检测过或干过活的模型，各自的体检结论和履历汇总 */
      teamModels: () => Promise<{ success: boolean; models: ModelDossier[] }>
      /** 设置「团队」页的「重新检测」：不管上次结论新不新都测一次 */
      teamModelCheckup: (args: {
        providerId: string
        modelId: string
      }) => Promise<{ success: boolean; error?: string; checkup?: ModelCheckup }>
      /** 改某条对话的审批档位（`sessionId` 传它当前的内核 session id）。运行中也立刻生效，下一个工具调用就按新档位走 */
      setApprovalMode: (args: {
        sessionId: string
        approvalMode: AgentV3ApprovalMode
        mode?: 'agent' | 'ask'
      }) => Promise<{ success: boolean; error?: string }>
      /** 回复工具审批弹窗 */
      replyApproval: (args: { toolCallId: string; verdict: AgentV3ApprovalVerdict }) => void
      /**
       * 回复 agent 的反问。
       *
       * 三态：`accept` 选了、`decline`「你自己定」、`cancel` 把卡片关了。
       * 后两者对模型的指示正好相反 —— 一个让它带着假设继续，一个让它停下来等人。
       */
      replyQuestion: (args: {
        toolCallId: string
        action: AgentV3QuestionAction
        /** 与提问同序，空串表示这一问没选。只在 accept 时有意义 */
        answers?: string[]
      }) => void
      /**
       * 刷新页面后重新接回还在跑的内核 session。
       *
       * 传界面记得的那些 sessionId，回其中**真的还在主进程里跑**的那些
       * （`pendingApprovals` / `pendingQuestions` 是顺带补发的审批弹窗和
       * 提问卡片条数）。不传就是全要。
       */
      reattach: (args: { sessionIds?: string[] }) => Promise<{
        sessionIds: string[]
        pendingApprovals: number
        pendingQuestions: number
      }>
      listSessions: () => Promise<AgentV3SessionMeta[]>
      /** 技能清单。输入框的 / 菜单和「技能」设置页共用，含来源和开关状态 */
      listSkills: () => Promise<{ skills: AgentV3SkillSummary[] }>
      /** 详情弹窗：读 SKILL.md 全文（含 frontmatter）。名字对不上时 document 为 null */
      readSkill: (name: string) => Promise<{ document: AgentV3SkillDocument | null }>
      /** 详情弹窗：写回正文。内置/插件带的会另存成用户副本 */
      writeSkill: (args: {
        name: string
        content: string
      }) => Promise<
        { success: true; source: 'user' | 'plugin' | 'builtin' } | { success: false; error: string }
      >
      /** 关掉 / 打开一个技能，控制它加不加载 */
      setSkillDisabled: (args: {
        name: string
        disabled: boolean
      }) => Promise<{ success: boolean; error?: string }>
      /** 技能页「经验」分组：通用层 + 项目库里各工程的经验，附上次整理的摘要 */
      listExperiences: () => Promise<{
        success: boolean
        entries: AgentV3Experience[]
        lastCuration?: AgentV3CurationSummary
        error?: string
      }>
      /** 固定保留一条经验（不被自动淘汰），或取消 */
      setExperiencePinned: (args: {
        ref: AgentV3ExperienceRef
        pinned: boolean
      }) => Promise<{ success: boolean; error?: string }>
      deleteExperience: (ref: AgentV3ExperienceRef) => Promise<{ success: boolean; error?: string }>
      /** 撤销上次整理：各目录回到那次整理之前 */
      undoLastCuration: () => Promise<{
        success: boolean
        undone?: AgentV3CurationSummary
        error?: string
      }>
      /** 删掉用户自己那几条技能。内置和插件带的删不掉，主进程会拒 */
      deleteSkills: (
        names: string[]
      ) => Promise<{ success: boolean; deleted: number; error?: string }>
      /** 工具名 → 风险等级（safe / mutating / destructive），算「本轮改动」用 */
      toolRisks: () => Promise<Record<string, 'safe' | 'mutating' | 'destructive'>>
      /** 「设置 → 工具」那一页的清单，含第三方 MCP */
      listTools: () => Promise<{ tools: AgentV3ToolSummary[] }>

      /**
       * 当前绑定的模型支持哪几档思考。模型没配好时为 null。
       *
       * `levels` 不含 `auto` —— 那是界面额外加的「不指定」，不是模型的档位。
       */
      thinkingLevels: (args?: { model?: { providerId: string; modelId: string } }) => Promise<{
        levels: AgentV3ThinkingLevel[]
        levelMap: Record<string, string | null>
        modelId: string
        /** 这个模型能不能开「快速」（目前只有 ChatGPT 订阅） */
        fastMode: boolean
      } | null>
      /** 这条对话绑定的模型（执行记录里那份）。没绑过为 null */
      sessionModel: (args: {
        sessionId: string
      }) => Promise<{ providerId: string; modelId: string } | null>
      /**
       * 在编辑器里打开一个资产，并在内容浏览器里选中它。
       *
       * 「本轮改动」只能告诉用户「M_GlowBreath 是新建的」，说不清它长什么样 ——
       * 那一步交给编辑器本身。关卡不走这条路（引擎 API 对 level 无效，
       * 而且打开关卡是切换当前关卡，用户只是想看一眼）。
       */
      openAsset: (args: { contentPath: string }) => Promise<{
        success: boolean
        /** 资产已经开着时引擎不再开一个窗口，这里是 false —— 不算失败 */
        opened?: boolean
        error?: string
      }>
      /**
       * 资产快照原型（保存 → 拷贝 → 还原 → 重载）。
       * 只给 tests/manual/verify-asset-snapshot.mjs 用，真机验证通过前界面不要接。
       */
      snapshot: {
        capture: (args: {
          projectDir: string
          sessionId: string
          contentPath: string
          maxBytes?: number
        }) => Promise<{
          ok: boolean
          entry?: AgentV3AssetSnapshotEntry
          skipped?: string
          detail?: string
        }>
        restore: (args: { entry: AgentV3AssetSnapshotEntry }) => Promise<{
          ok: boolean
          reloaded: boolean
          tried: string[]
          error?: string
        }>
      }
      loadSession: (args: { sessionId: string }) => Promise<{ messages: unknown[] }>
      deleteSession: (args: { sessionId: string }) => Promise<{ success: boolean; error?: string }>
      /**
       * 分支：把 transcript 复制成一个新 sessionId，之后两边各聊各的。
       *
       * `keepUserTurns` 是「从这条往后砍掉」——只复制前这么多个用户轮次；
       * 不给就整份复制。`reason` 是失败的**类型**（'busy'=正在跑，
       * 'missing'=还没有 transcript / 截完是空的），措辞归渲染层。
       */
      forkSession: (args: { sessionId: string; keepUserTurns?: number }) => Promise<{
        success: boolean
        sessionId?: string
        messageCount?: number
        reason?: 'busy' | 'missing'
        error?: string
      }>
      /**
       * 把 transcript 截回前 `keepUserTurns` 轮 —— 重新生成 / 编辑消息用。
       *
       * 界面删掉气泡只动渲染层那份历史，内核每轮都从盘上恢复自己那份；不截的话
       * 模型看着刚被丢掉的答案再答一遍。`reason` 同 `forkSession`。
       */
      truncateSession: (args: { sessionId: string; keepUserTurns: number }) => Promise<{
        success: boolean
        /** 截完还剩几条内核消息 */
        messageCount?: number
        /** 这次丢掉了几条 */
        dropped?: number
        reason?: 'busy' | 'missing'
        error?: string
      }>
      /**
       * 侧边问一句：复制一份上下文给小窗口。
       *
       * 和 `forkSession` 的区别是**跑着的时候也能分** —— 那正是这个功能的用处。
       */
      forkForSideQuestion: (args: { sessionId: string }) => Promise<{
        success: boolean
        sessionId?: string
        messageCount?: number
        /** 主对话此刻还在跑，这份上下文是快照 */
        live?: boolean
        reason?: 'empty' | 'error'
        error?: string
      }>
      /** 审查本轮改动：问引擎「这些资产现在到底是什么状态」 */
      reviewChanges: (args: { targets: AgentReviewTarget[] }) => Promise<AgentReviewResult>
      /** 手动压缩上下文：把早期对话换成一段摘要，腾出窗口 */
      compact: (args: { sessionId: string }) => Promise<{
        success: boolean
        /**
         * 失败的**类型**，不是给用户看的文案。
         *
         * 措辞归渲染层：主进程写的是实现语言，而且绕过 i18n。
         */
        reason?:
          | 'busy'
          | 'empty'
          | 'too-short'
          | 'summary-failed'
          | 'already-compact'
          | 'cancelled'
          | 'error'
        /** 只有 reason === 'error' 时才有：意料之外的失败，带上原文供排查 */
        error?: string
        tokensBefore?: number
        tokensAfter?: number
        messagesBefore?: number
        messagesAfter?: number
        contextWindow?: number
      }>
      /** AI 设置改动后调用，让下次执行重建 Provider */
      invalidateProviders: () => Promise<{ success: boolean }>
      /** pi 内核可用性诊断 */
      smoke: () => Promise<AgentV3SmokeReport>
      /*
       * 插件没有渲染层入口 —— 权限声明还没落地成安装确认，理由见 index.ts 同处。
       */
      /** 接入第三方 MCP server */
      mcp: {
        getSettings: () => Promise<{
          settings: McpSettings
          path: string
          statuses: McpServerStatus[]
        }>
        saveSettings: (args: { settings: McpSettings }) => Promise<{
          success: boolean
          error?: string
          statuses?: McpServerStatus[]
        }>
        reconnect: () => Promise<{
          success: boolean
          error?: string
          statuses?: McpServerStatus[]
        }>
        /**
         * 删一条 server 并当场落盘。
         *
         * 只删这一条 —— 不碰盘上别的条目，也不提交表单里未保存的编辑。
         * 回来的 `settings` 是删完之后的盘上内容，界面拿它重算「未保存」基准线。
         */
        removeServer: (args: { id: string }) => Promise<{
          success: boolean
          error?: string
          settings?: McpSettings
          statuses?: McpServerStatus[]
        }>
        /**
         * 存一条 server 并重连。只写这一条。
         *
         * `renamedFrom` 是它在盘上的旧名字 —— 改过名的话要顺手删掉那条，
         * 否则盘上会多出一份旧的，下次打开面板又冒出来。
         */
        saveServer: (args: {
          id: string
          config: McpServerConfigView
          renamedFrom?: string
        }) => Promise<{
          success: boolean
          error?: string
          settings?: McpSettings
          statuses?: McpServerStatus[]
        }>
        /** 已连接项目的「UE 5.8 官方 MCP」开启状态 */
        epicStatus: () => Promise<{
          success: boolean
          error?: string
          projects: Array<{
            connectionId: string
            projectName: string
            state: 'unsupported' | 'needs-plugins' | 'needs-restart' | 'needs-start' | 'ready'
            missingPlugins: string[]
            autoStartEnabled: boolean
            url: string
          }>
        }>
        /** 一键给某个项目开启 UE 5.8 官方 MCP */
        epicSetup: (args: { connectionId: string }) => Promise<{
          success: boolean
          error?: string
          /** 主进程给的那句话：它才知道这次是起来了、要重启、还是失败 */
          message?: string
          needsRestart?: boolean
          addedPlugins?: string[]
          wroteAutoStart?: boolean
          running?: boolean
          statuses?: McpServerStatus[]
        }>
        /** 官方 Blender Lab MCP 的前置依赖与配置状态 */
        blenderStatus: () => Promise<{
          success: boolean
          error?: string
          status?: BlenderSetupStatusView
        }>
        /** 一键装官方 Blender Lab MCP 并写进配置。装一次要几分钟 */
        blenderSetup: (args?: { blenderPath?: string }) => Promise<{
          success: boolean
          /** 主进程给的那句话：它才知道这次是装好了、缺前置、还是装挂了 */
          message?: string
          error?: string
          blenderPath?: string
          statuses?: McpServerStatus[]
        }>
        /** 用 winget 装 Blender 接入缺的 Git / Python。装完主进程会刷新 PATH 再探一次 */
        blenderInstallPrereqs: (args: { ids: Array<'git' | 'python'> }) => Promise<{
          success: boolean
          message: string
          /** winget 的退出码和原话，「交给 AI 排查」时原样带上 */
          error?: string
        }>
      }
      /** 把虚幻引擎能力对外暴露成 MCP server */
      mcpServer: {
        start: (args: {
          namespaces?: string[]
          includeMutating?: boolean
          port?: number
        }) => Promise<{ success: boolean; error?: string; status?: McpServerHostView }>
        stop: () => Promise<{ success: boolean; status: McpServerHostView }>
        status: () => Promise<McpServerHostView>
        /** 换新令牌，旧的客户端配置随即失效 */
        rotateToken: () => Promise<{ success: boolean; status: McpServerHostView }>
        /** 保存端口 / 暴露范围；运行中变更会自动重启服务 */
        saveConfig: (args: {
          port?: number
          includeMutating?: boolean
        }) => Promise<{ success: boolean; error?: string; status: McpServerHostView }>
      }
    }
    /**
     * 通用事件监听器 - 监听主进程发送的事件
     */
    on: (channel: string, listener: (...args: unknown[]) => void) => (...args: unknown[]) => void
    /**
     * 通用事件移除 - 移除事件监听器
     */
    off: (channel: string, handler: (...args: unknown[]) => void) => void
  }

  /** 工具审批模式。ask=每个写操作都问；auto-edit=可撤销的放行；yolo=全放行 */
  type AgentV3ApprovalMode = 'ask' | 'auto-edit' | 'yolo'

  /**
   * 思考程度。
   *
   * 档位**由模型自己声明**，各家不同：有的是 minimal/low/medium/high，
   * 有的只有 off/high/max，不会思考的模型只有 off。这个联合类型是全集，
   * 界面上该列哪几档要问 `agentV3.thinkingLevels()`。
   *
   * `auto` 是额外的一档，表示**不指定**，让模型按自己的默认来 ——
   * 与「最低」不是一回事，也是默认值：加上这个开关不会悄悄改掉所有人的行为。
   */
  type AgentV3ThinkingLevel =
    | 'auto'
    | 'off'
    | 'minimal'
    | 'low'
    | 'medium'
    | 'high'
    | 'xhigh'
    | 'max'

  /**
   * 技能沉淀档位。
   *
   * off = 不会自己写技能（`ue-skill-creator` 整条从清单里删掉）；
   * ask = 想沉淀时先给一条提案，用户点头才写（默认）；
   * auto = 自己写，写完在交付里说。
   *
   * 三档都不越过写文件的审批门 —— auto 省掉的是「要不要沉淀」这一问，
   * 不是「能不能写盘」那一问。
   */
  type AgentV3SkillLearning = 'off' | 'ask' | 'auto'

  /** always = 批准且本对话内该工具不再询问（按内核 session 记：重启、清空对话、切到 Ask 模式后失效，分出的新对话也不继承） */
  /** forever = 批准且以后所有对话里该工具都不再询问（存进应用设置，在偏好设置里移除） */
  type AgentV3ApprovalVerdict = 'approve' | 'always' | 'forever' | 'reject'

  /**
   * 用户对 agent 反问的处置。
   *
   * `decline` 和 `cancel` 必须分开：前者是「我懒得选，你自己定」，
   * 后者是「这事先停一停」。合成一个的话，用户按了停止，agent 反而收到
   * 一句「你自己定」然后继续埋头干活。
   */
  type AgentV3QuestionAction = 'accept' | 'decline' | 'cancel'

  interface AgentV3SessionMeta {
    sessionId: string
    createdAt: number
    modifiedAt: number
    messageCount: number
  }

  /** AI 输入框 / 技能菜单展示项。不包含本机技能目录。 */
  interface AgentV3SkillSummary {
    name: string
    description: string
    source: 'user' | 'plugin' | 'builtin'
    /** 用户有没有把它关掉。关掉的仍然在清单里 —— 否则没法再打开 */
    enabled: boolean
    /** 从官网共享库装的 */
    shared?: SharedSkillOrigin
  }

  type ShareIpcResult<T> = { success: true; data: T } | { success: false; error: string }

  /** 一条经验在哪。主进程只认项目库里登记过的工程路径 */
  interface AgentV3ExperienceRef {
    layer: 'global' | 'project'
    projectPath?: string
    tool: string
    id: string
  }

  /** 技能页「经验」分组里的一条（见 main/agent-v3/experience/library.ts） */
  interface AgentV3Experience {
    id: string
    title: string
    tool: string
    errorPattern: string
    advice: string
    expect: { tool?: string; param?: string }
    source: string
    verified?: { date: string; engine?: string }
    status: 'trial' | 'proven' | 'retired'
    /** 退休的才有；这个字段出现之前退休的旧经验没有 */
    retiredBecause?:
      | 'capacity'
      | 'replaced'
      | 'failed'
      | 'ignored'
      | 'no-lift'
      | 'refuted'
      | 'script-bug'
    pinned?: boolean
    engines?: string[]
    notFor?: string[]
    layer: 'global' | 'project'
    projectName?: string
    projectPath?: string
    stats: {
      shown: number
      shownOk: number
      holdout: number
      holdoutOk: number
      adopted: number
      adoptedOk: number
      adoptedFail: number
      ignoredStreak: number
      lastShownAt?: string
      /** 出场组成功率 − 对照组成功率。对照样本不够时没有 */
      lift?: number
    }
  }

  /** 上次整理：什么时候、新加几条、淘汰几条 */
  interface AgentV3CurationSummary {
    id: string
    at: string
    added: number
    retired: number
  }

  /** 「设置 → 工具」清单里的一条。开关状态不在这儿 —— 那是应用设置里的两份名单 */
  interface AgentV3ToolSummary {
    name: string
    /** 形如 `ue.material` / `asset`，设置页按它归大类。不含第三方 MCP */
    namespace: string
    description: string
    risk: 'safe' | 'mutating' | 'destructive'
    /** 没人动过设置时，工具搜索模式下它是不是常驻 */
    defaultResident: boolean
    /** 这一条塞进每次请求大约多少 token（名字 + 说明 + 参数表），偏保守 */
    tokens: number
  }

  /** 一个技能的 SKILL.md 全文，详情弹窗编辑用 */
  interface AgentV3SkillDocument {
    name: string
    source: 'user' | 'plugin' | 'builtin'
    /** 完整内容，含开头那段 frontmatter */
    content: string
    /** `own` = 原地改自己的文件；`copy` = 保存时在用户目录里另存一份覆盖它 */
    savesAs: 'own' | 'copy'
  }

  /**
   * 对话归属的 UE 工程（侧边栏按它分组）。
   *
   * 和「当前连着的工程」不是一回事：对话的归属在第一条消息时就定死了，
   * 之后用户可能关了那个工程去开另一个。
   */
  interface AgentV3SessionProject {
    projectName: string
    projectPath?: string
    engineVersion?: string
  }

  /** MCP server 配置。形状对齐 Claude Desktop 的 mcpServers，可直接粘贴已有配置 */
  interface McpSettings {
    version: 1
    mcpServers: Record<string, McpServerConfigView>
  }

  interface McpServerConfigView {
    type?: 'stdio' | 'http'
    /** stdio 形态：要执行的命令 */
    command?: string
    args?: string[]
    env?: Record<string, string>
    cwd?: string
    /** http 形态：远程地址 */
    url?: string
    headers?: Record<string, string>
    /** 关掉但保留配置 */
    disabled?: boolean
    /** 只暴露这些工具，省略则全部 */
    allowedTools?: string[]
    /**
     * 点名降级为 `safe`（不弹审批）的工具。见主进程 `capabilities/mcp/types.ts`。
     *
     * 磁盘上一直有这一项，这里原来漏了 —— 类型比它承载的配置窄，
     * 渲染层就会在往返时把它当成不存在的东西丢掉。
     */
    readOnlyTools?: string[]
    /** 用户信任这个 server：它的工具按 mutating 审批。见主进程 `capabilities/mcp/types.ts` */
    trusted?: boolean
  }

  interface McpServerStatus {
    id: string
    connected: boolean
    toolCount: number
    error?: string
    /** 用户主动停用。和「连不上」是两回事，界面上不能都显示成失败 */
    disabled?: boolean
    serverName?: string
    serverVersion?: string
  }

  /**
   * 一条 Blender 前置依赖的检查结果。
   *
   * `found` 要原样显示：「Blender 4.5，需要 5.1+」比「版本不符」有用得多，
   * 用户据此知道该升级还是该换一个路径。
   */
  interface BlenderPrerequisiteView {
    id: 'blender' | 'git' | 'python'
    ok: boolean
    found?: string
    path?: string
    problem?: 'missing' | 'too-old'
  }

  /** 官方 Blender Lab MCP 的一键状态。见主进程 `capabilities/mcp/blenderSetup.ts` */
  interface BlenderSetupStatusView {
    state: 'configured' | 'ready' | 'blocked' | 'unsupported'
    prerequisites: BlenderPrerequisiteView[]
    /** 一键会用的 Blender。blocked 时可能没有 */
    blenderPath?: string
    installRoot: string
    /** configured 时：配置里记的那个 Blender */
    configuredBlenderPath?: string
    /** configured 时：那条 server 的 id。界面拿它去 statuses 里查连上没有 */
    configuredServerId?: string
  }

  /** 盒子对外暴露的 MCP server 状态 */
  interface McpServerHostStatus {
    running: boolean
    url?: string
    token?: string
    exposedTools: number
    error?: string
  }

  /** 对外 MCP server 的持久化配置。端口与令牌跨重启不变，外部客户端才配得住 */
  interface McpHostSettings {
    /** 开机是否自动启动 */
    enabled: boolean
    port: number
    token: string
    /** 是否连写操作工具一起暴露 */
    includeMutating: boolean
  }

  /**
   * 界面拿到的完整视图：运行状态 + 持久化配置 + 现成的客户端配置片段。
   *
   * 服务**没启动时也有** url/token —— 用户的典型顺序是先把配置粘进
   * Claude Code，再回来开服务。
   */
  interface McpServerHostView extends McpServerHostStatus {
    settings: McpHostSettings
    url: string
    /** 可直接粘进 Claude Code / Cursor 的 JSON */
    clientConfig: string
  }

  interface AgentV3SmokeReport {
    ok: boolean
    providerCount: number
    sampledProviders: string[]
    agentConstructed: boolean
    toolSchemaKeys: string[]
    toolExecuted: boolean
    estimatedTokens: number
    toolCount: number
    toolCountWithoutUe: number
    toolsByNamespace: Record<string, number>
    toolsByRisk: Record<string, number>
    skillCount: number
    skillDirs: string[]
    errors: string[]
  }

  /**
   * 知识库数据接口
   */
  interface NotebookData {
    id?: number
    notebookId: string
    title: string
    description?: string | null
    coverStyle?: string | null
    /** 自定义封面图片路径 */
    coverImage?: string | null
    sourceCount?: number
    createdAt?: string
    updatedAt?: string
  }

  /**
   * 知识库来源数据接口
   */
  interface NotebookSourceData {
    id?: number
    sourceId: string
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
    /** 抓回来的原文（清洗过的网页才有）。清洗有损，原文必须留一份 */
    rawContent?: string | null
    sourceUrl?: string | null
    fileName?: string | null
    /** 文件的本地路径（用于重试加载） */
    filePath?: string | null
    /** 媒体 URL（用于视频的 临时媒体 URL） */
    mediaUrl?: string | null
    loading?: boolean
    error?: string | null
    indexStatus?: string | null
    indexedAt?: string | null
    indexError?: string | null
    embeddingModel?: string | null
    embeddingDim?: number | null
    /** 摘要正文。「只给摘要」档送的就是它 */
    summaryContent?: string | null
    /** 摘要状态 */
    summaryStatus?: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped' | null
    /** 这条来源进上下文的档位 */
    contextLevel?: NotebookContextLevel
    createdAt?: string
    updatedAt?: string
  }

  type NotebookChatV2Mode =
    | 'rag'
    | 'no_selected_sources'
    | 'no_indexed_sources'
    | 'no_results'
    | 'search_failed'

  type NotebookChatV2SourceFreshness =
    | 'indexed'
    | 'keyword'
    | 'stale'
    | 'pending'
    | 'indexing'
    | 'error'
    | 'empty'
    | 'loading'
    | 'unindexed'

  type NotebookIndexJobStatus = 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'

  interface NotebookIndexJobStatusView {
    jobId: string
    notebookId: string
    sourceId: string
    targetRevision: number
    status: NotebookIndexJobStatus
    attemptCount: number
    nextRetryAt: string | null
    lastError: string | null
    createdAt: string | null
    updatedAt: string | null
    startedAt: string | null
    completedAt: string | null
  }

  interface NotebookChatV2SourceState {
    sourceId: string
    title: string
    type: string
    contextLevel: NotebookContextLevel
    loading: boolean
    hasContent: boolean
    indexStatus: string | null
    indexError: string | null
    indexedAt: string | null
    updatedAt: string | null
    chunkCount: number
    indexFreshness: NotebookChatV2SourceFreshness
    /** 能检索（至少关键词一路） */
    canSearch: boolean
    /** 向量也齐了，语义一路会参与 */
    vectorReady: boolean
    shouldIndex: boolean
    reason?: string
  }

  interface NotebookChatV2Citation {
    id: string
    title: string
    url?: string | null
    filePath?: string | null
    content: string
    sourceId: string
    type?: string | null
  }

  interface NotebookChatV2PrepareResult {
    ok: true
    mode: NotebookChatV2Mode
    citations: NotebookChatV2Citation[]
    contextMessage?: {
      role: 'user'
      content: string
    }
    sourceStates: NotebookChatV2SourceState[]
    warnings: Array<{
      code:
        | 'no_selected_sources'
        | 'no_indexed_sources'
        | 'some_sources_not_ready'
        | 'search_failed'
      message: string
      severity: 'info' | 'warning'
    }>
    diagnostics: {
      queryLength: number
      selectedSourceCount: number
      indexedSourceCount: number
      resultCount: number
      contextChars: number
      elapsedMs: number
      searchElapsedMs?: number
    }
  }

  interface Window {
    electron: RendererElectronAPI
    electronAPI: ElectronAPIExtended
    api: API
  }
}
