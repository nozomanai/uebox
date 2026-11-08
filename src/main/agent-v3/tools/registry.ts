/**
 * V3 工具注册表。
 *
 * 这是 V2 那 16 个 specialist 的替代品：不再按「谁负责什么」在运行时路由，
 * 而是把全部工具扁平登记在一处，由 `resolveTools` 按会话状态过滤。
 *
 * ## 名字为什么要改
 *
 * V2 里蓝图/材质/粒子等用点号命名（`blueprint.add_node`），但 OpenAI 等厂商
 * 要求工具名匹配 `^[a-zA-Z0-9_-]+$`，点号会被直接拒。所以统一转下划线。
 *
 * 光改名字不够 —— 工具描述里有大量交叉引用（「用 material.add_node 一步完成」），
 * 不一起改的话模型会去调一个不存在的工具。`rewriteCrossReferences` 负责这件事。
 *
 * ## 适配 vs 重写
 *
 * 绝大多数工具走 `adaptV2Tool`（业务逻辑与 schema 逐字保留）。
 * 需要 V3 增量能力（流式进度、图片进上下文、并发语义）的单独重写 ——
 * 材质工具集已经是重写版，所以不在这里适配。
 *
 * ## AIGC
 *
 * 生图、视频和 3D 工具通过主进程调用用户配置的模型服务。
 */

import { aigcTools } from './aigc'
import { taskVideoTools } from './builtin/taskVideo'
import { engineTools } from './builtin/engines'
import { projectPackageTools } from './builtin/projectPackage'
import { createRecordGameplayTool } from './builtin/recordGameplay'
import { createBoxPlanTool } from './builtin/boxPlan'
import { createProjectUpdatePluginTool } from './adapted/project/updatePlugin'
import { createWebTools } from './builtin/web'
import { createLocalFileTools } from './builtin/localFiles'
import { createInspectUassetTool } from './builtin/inspectUasset'
import { createLocalSearchTools } from './builtin/localSearch'
import { createAddNotebookSourceTool } from './builtin/addNotebookSource'
import { createSearchNotebookSourcesTool, type NotebookScope } from './builtin/notebookSources'
import { createBoxTools } from './builtin/box'
import {
  createProjectListTool,
  createProjectWriteTool,
  projectManageRisk
} from './adapted/project/splitByRisk'
import { createOrganizeProjectsTool } from './adapted/project/organizeProjects'
import { createLocalWriteTools, createShellTool } from './builtin/localShell'
import { mcpTools } from './builtin/mcpConnect'
import { createBrowserTools } from './builtin/browser'
import { isDefaultResidentTool } from './builtin/toolSearch'
import { estimateTokens } from '../../../shared/tokenBudget'
import { formatSkillLint, isSkillFile, lintSkillFile } from '../capabilities/skillLint'
import type { WebContents } from 'electron'

import { onSettingsChanged } from '../../ai/store'
import { adaptV2Tool, type V2Tool } from './adaptV2Tool'
import {
  CURRENT_LEVEL_LOCK,
  acquire,
  describeConflicts,
  extractPackagePaths,
  getLockOwner,
  locksOwnedBy,
  releasePaths,
  sameTeam,
  teamRootOf
} from '../core/assetLock'
import { enforceAfterWrite, suspendForWrite } from '../core/assetLockEnforcement'
import { effectiveConnectionId } from '../core/projectTargetContext'
import { editorKeyActive, withEditorKey } from '../core/team/editorKey'
import {
  ASK_USER_TOOL_NAME,
  BROWSER_TOOL_NAMES,
  SET_SESSION_PROJECT_RISK,
  SET_SESSION_PROJECT_TOOL_NAME,
  rewriteCrossReferences
} from './toolNames'
import { UPDATE_PLAN_TOOL_NAME, WRAP_UP_TOOL_NAME } from '../../../shared/agentTurnReport'
import type { ArchiveSpec, ToolRisk, UnrealAgentTool } from './defineTool'
import { effectiveRisk } from './defineTool'
import { materialTools } from './ue-material'
import { meshTools } from './ue-mesh'
import { landscapeTools } from './ue-landscape'
import { animationTools } from './ue-animation'
import { contentOrganizeTools } from './ue-content'
import { assetGuidelinesTool } from './adapted/ue-editor/assetGuidelines'
import { pcgTools } from './ue-pcg'
import { sequencerTools } from './ue-sequencer'
import { inspectTools } from './ue-inspect'
import { dataTableTools } from './ue-datatable'

// ── V2 工具工厂 ──────────────────────────────────────────────────────────
import * as noteTools from '../../agent-v3/tools/adapted/note'
import * as ueActor from '../../agent-v3/tools/adapted/ue-actor'
import * as ueBlueprint from '../../agent-v3/tools/adapted/ue-blueprint'
import * as ueContent from '../../agent-v3/tools/adapted/ue-content-browser'
import { cppTools } from '../../agent-v3/tools/adapted/ue-cpp'
import * as ueEditor from '../../agent-v3/tools/adapted/ue-editor'
import * as ueInput from '../../agent-v3/tools/adapted/ue-input'
import * as ueAutoplay from '../../agent-v3/tools/adapted/ue-autoplay'
import * as ueLevel from '../../agent-v3/tools/adapted/ue-level'
import * as ueSystem from '../../agent-v3/tools/adapted/ue-system'
import * as ueWidget from '../../agent-v3/tools/adapted/ue-widget'
import * as assetTools from '../../agent-v3/tools/adapted/asset'
import * as libraryTools from '../../agent-v3/tools/adapted/library'

/**
 * 会话体检工具。无状态，和 `materialTools` 一样造一次就够。
 *
 * 单独拎出来是因为 `buildAllTools()` 和 `listToolRisks()` 都要它，
 * 而两次 `createSessionHealthTool()` 会造出两个 name 相同的对象 ——
 * 风险表和工具清单从此可能各拿一个，是那种很难查的漂移。
 */
const sessionHealthTool = ueSystem.createSessionHealthTool()

/** 一条登记：V3 名字 + 命名空间 + 风险 + 怎么造出这个 V2 工具 */
interface Registration {
  name: string
  namespace: string
  risk: ToolRisk
  /** 需要 sender 的工具（会给渲染层发通知）用它拿 */
  make: (deps: { sender?: WebContents }) => V2Tool
  /**
   * 没有 sender 就造不出来。
   *
   * 无人值守场景（定时任务、以后的 MCP server）没有窗口可发通知，这类工具
   * 直接跳过 —— 强行传 undefined 会在工具执行时抛 TypeError，
   * 那比一开始就不注册难查得多。
   */
  needsSender?: boolean
  concurrency?: 'sequential' | 'parallel'
  /** 按这次的参数降风险（见 `ToolMeta.riskFor`）。工具自己带了的话这里优先 */
  riskFor?: (args: unknown) => ToolRisk
  /** 结果太大时存档、只给目录页（见 `ArchiveSpec`） */
  archive?: ArchiveSpec
}

/** 带着 `force: true`（丢弃未保存的改动）才算 destructive；不带时插件有未保存就拒绝 */
const destructiveOnlyWithForce = (args: unknown): ToolRisk =>
  (args as { force?: unknown } | null)?.force === true ? 'destructive' : 'mutating'

/**
 * 写完一个 SKILL.md 就地体检，报告贴在写入工具的返回值里。
 *
 * 挂在返回值上而不是另做一个 `check_skill` 工具：另做工具就要靠模型记得调，
 * 而它最该调的那一次，恰恰是它以为已经写完的那一次。
 *
 * 只对 SKILL.md 生效，别的文件一律原样返回 —— 写日志、写配置、写脚本
 * 都不该在返回值后面多出一段体检报告。
 */
async function lintWrittenSkill(params: Record<string, unknown>): Promise<string> {
  const path = typeof params.path === 'string' ? params.path : ''
  if (!path || !isSkillFile(path)) return ''

  return formatSkillLint(await lintSkillFile(path, allToolNames()))
}

/**
 * 全部工具名，**不看运行时条件**。
 *
 * 和 `buildAllTools()` 的差别：那个会把没绑知识库时的来源工具滤掉。
 * 体检要判的是「skill 里写的这个工具名存不存在」，不能只看当前会话清单。
 */
export function allToolNames(): Set<string> {
  const names = new Set(buildAllTools().map((t) => t.name))
  for (const reg of REGISTRATIONS) names.add(reg.name)
  names.add('search_notebook_sources')
  names.add('add_notebook_source')
  // skill 层自己的两个工具不在注册表里（`createSkillTools` 按发现结果现造）
  names.add('load_skill')
  names.add('read_skill_resource')
  names.add('task')
  names.add('search_tools')
  // 浏览器工具故意不进 `buildAllTools()`（见 `builtin/browser.ts` 的说明），
  // 但名字必须在这里 —— 否则写了浏览器步骤的 skill 会被体检误报成
  // 「引用了不存在的工具」
  for (const name of BROWSER_TOOL_NAMES) names.add(name)
  // 反问用户同理：在 `resolveTools` 里现造，不进 `buildAllTools()`
  names.add(ASK_USER_TOOL_NAME)
  // 换对话归属同理。系统提示词和 `open_project` 的返回里都写着让模型调它，
  // 名字不在这儿的话，第一个把这套流程写进 SKILL.md 的人会被体检告知
  // 「引用了不存在的工具」，然后把唯一正确的那句删掉
  names.add(SET_SESSION_PROJECT_TOOL_NAME)
  // 任务清单、收尾提问同理
  names.add(UPDATE_PLAN_TOOL_NAME)
  names.add(WRAP_UP_TOOL_NAME)
  return names
}

/**
 * 本地文件工具只造一次。
 *
 * `createLocalFileTools()` 内部会建 `NodeExecutionEnv`，每次都新建一个没有
 * 意义；而且两个工具要共用同一个 env，否则 cwd 语义会各说各话。
 */
let localFileToolsCache: UnrealAgentTool<never>[] | undefined
function getLocalFileTools(): UnrealAgentTool<never>[] {
  if (!localFileToolsCache) {
    localFileToolsCache = [
      ...createLocalFileTools(),
      ...createLocalSearchTools(),
      createInspectUassetTool(),
      ...createLocalWriteTools({ afterWrite: lintWrittenSkill }),
      // shell 工具照常造出来，由 `resolveTools` 按 `local.shell` 命名空间
      // 决定这台机器上给不给 —— 注册表本身是同步的，探测 shell 是异步的
      createShellTool()
    ]
  }
  return localFileToolsCache
}

const REGISTRATIONS: readonly Registration[] = Object.freeze([
  // ── Actor ────────────────────────────────────────────────────────────
  {
    name: 'ue_spawn_actor',
    namespace: 'ue.actor',
    risk: 'mutating',
    make: () => ueActor.createSpawnActorTool()
  },
  // 删 Actor 不可逆
  {
    name: 'ue_destroy_actor',
    namespace: 'ue.actor',
    risk: 'destructive',
    make: () => ueActor.createDestroyActorTool()
  },
  {
    name: 'ue_get_actor',
    namespace: 'ue.actor',
    risk: 'safe',
    make: () => ueActor.createGetActorTool(),
    // 整关列 Actor 一次就是几百行、六万字符；目录页给名字和类型，属性按编号取
    archive: { lists: { actors: ['name', 'class', 'path'] } }
  },
  {
    name: 'ue_set_property',
    namespace: 'ue.actor',
    risk: 'mutating',
    make: () => ueActor.createSetPropertyTool()
  },
  {
    name: 'ue_set_transform',
    namespace: 'ue.actor',
    risk: 'mutating',
    make: () => ueActor.createSetTransformUnifiedTool()
  },

  // ── Blueprint ────────────────────────────────────────────────────────
  {
    name: 'blueprint_describe',
    namespace: 'ue.blueprint',
    risk: 'safe',
    make: () => ueBlueprint.createDescribeBlueprintTool()
  },
  {
    name: 'blueprint_get_graph',
    namespace: 'ue.blueprint',
    risk: 'safe',
    make: () => ueBlueprint.createGetBlueprintGraphTool(),
    archive: ueBlueprint.BLUEPRINT_GRAPH_ARCHIVE
  },
  {
    name: 'blueprint_search_nodes',
    namespace: 'ue.blueprint',
    risk: 'safe',
    make: () => ueBlueprint.createSearchBlueprintNodesTool()
  },
  /**
   * 全项目搜「哪些蓝图用了这个名字」（引擎的 Find in Blueprints，不加载蓝图）。
   * 只读；index_unindexed 只是请编辑器弹它自己的「Index All」确认框，加不加载由用户在框里定。
   * 分组见 toolSearch.ts：自成按需子组 ue.blueprint.usages，由 C++ 和蓝图编辑两个技能点名
   */
  {
    name: 'blueprint_find_usages',
    namespace: 'ue.blueprint',
    risk: 'safe',
    make: () => ueBlueprint.createFindBlueprintUsagesTool()
  },
  /**
   * 蓝图的写工具**一律 sequential**。
   *
   * 同一条消息里的多个工具调用默认并发跑（`defineTool` 的
   * `executionMode: 'parallel'`），而返回是按请求顺序排的 —— 于是调用方看到
   * 一份「按我写的顺序执行了」的假象。真机上撞出来过：同一条消息里先把父类
   * 改成 Info、再改回 Actor，两条都报成功，蓝图最后停在 **Info** 上，
   * 第二条的 `old_parent` 还写着 Actor（2026-09-16 的用户反馈）。
   *
   * 这种错没有任何征兆，换更强的模型也一样中招 —— 它是并发，不是判断失误。
   * 读工具不受影响，照旧并发。
   */
  {
    name: 'blueprint_create',
    namespace: 'ue.blueprint',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueBlueprint.createBlueprintTool()
  },
  /**
   * 唯一的写图工具。
   *
   * 它替掉了 add_node / connect_pins / set_pin_value / add_timeline /
   * build_logic 五个 —— 那几个是节点级命令式接口，每一步都
   * 依赖当前图的状态，逼着调用方「查一个写一个」地往返；六个功能重叠的
   * 写工具本身也是选择负担，真机评测里模型选对了批量那个却被插件顶回来，
   * 于是退回逐节点，三十分钟写十个节点。
   *
   * sequential：同一份图表并发写会互相覆盖。
   */
  {
    name: 'blueprint_apply_graph',
    namespace: 'ue.blueprint',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueBlueprint.createApplyBlueprintGraphTool()
  },
  /**
   * 写图的两个逆操作。
   *
   * apply_graph 只能往上加；接错一根线、多建一个节点，以前唯一的收回办法是
   * `clear_existing` 整图重写，顺带重建所有节点 —— 代价远大于这件事本身。
   * 它们不和 apply_graph 争「怎么写一片逻辑」，所以不构成当初要避免的选择负担。
   */
  {
    // 插件端删节点开在事务里（进 agent 那条撤销栈），ue_undo 撤得回来
    name: 'blueprint_delete_node',
    namespace: 'ue.blueprint',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueBlueprint.createDeleteBlueprintNodeTool()
  },
  {
    name: 'blueprint_disconnect_pins',
    namespace: 'ue.blueprint',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueBlueprint.createDisconnectBlueprintPinsTool()
  },
  /**
   * 注释框 —— 蓝图里唯一的分组手段。
   *
   * 它不属于「写图的逆操作」那一组：注释框不参与编译，加错了也只是图上多一个框。
   */
  {
    name: 'blueprint_comment',
    namespace: 'ue.blueprint',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueBlueprint.createBlueprintCommentTool()
  },
  {
    name: 'blueprint_add_component',
    namespace: 'ue.blueprint',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueBlueprint.createAddComponentToBlueprintTool()
  },
  {
    name: 'blueprint_set_property',
    namespace: 'ue.blueprint',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueBlueprint.createSetBlueprintPropertyTool()
  },
  {
    name: 'blueprint_create_function',
    namespace: 'ue.blueprint',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueBlueprint.createCreateBlueprintFunctionTool()
  },
  {
    name: 'blueprint_create_event_graph',
    namespace: 'ue.blueprint',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueBlueprint.createBlueprintCreateEventGraphTool()
  },
  {
    name: 'blueprint_add_variable',
    namespace: 'ue.blueprint',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueBlueprint.createAddBlueprintVariableTool()
  },
  {
    // 建完变量通常还要调一次这个：默认建出来的变量不暴露给实例，
    // 而「让策划在场景里逐个实例调」才是蓝图变量最常见的用途
    name: 'blueprint_set_variable_meta',
    namespace: 'ue.blueprint',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueBlueprint.createSetBlueprintVariableMetaTool()
  },
  {
    // 删变量不可逆（插件端没开事务，ue_undo 撤不回），且会让引用它的节点变成孤儿
    name: 'blueprint_remove_variable',
    namespace: 'ue.blueprint',
    risk: 'destructive',
    concurrency: 'sequential',
    make: () => ueBlueprint.createRemoveBlueprintVariableTool()
  },
  {
    name: 'blueprint_event_dispatcher',
    namespace: 'ue.blueprint',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueBlueprint.createBlueprintEventDispatcherTool()
  },
  {
    // 所有触发式交互的入口。没有它，「走进触发区就开门」只能退化成
    // Tick 里每帧算距离 —— 错的写法，而模型没有别的选择时就会那么写
    name: 'blueprint_component_event',
    namespace: 'ue.blueprint',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueBlueprint.createBlueprintComponentEventTool()
  },
  {
    // 能删函数，所以按最坏情况标 —— 删掉的函数调用点会全变成孤儿节点
    name: 'blueprint_function_signature',
    namespace: 'ue.blueprint',
    risk: 'destructive',
    // 加参数只往上加；删参数、删函数没有事务撤不回，仍按 destructive 问
    riskFor: (args) =>
      (args as { action?: unknown } | null)?.action === 'add_param' ? 'mutating' : 'destructive',
    concurrency: 'sequential',
    make: () => ueBlueprint.createBlueprintFunctionSignatureTool()
  },
  {
    // 改父类大概率会打断一批节点，且没有一键还原
    name: 'blueprint_set_parent_class',
    namespace: 'ue.blueprint',
    risk: 'destructive',
    concurrency: 'sequential',
    make: () => ueBlueprint.createSetBlueprintParentClassTool()
  },
  {
    name: 'blueprint_compile',
    namespace: 'ue.blueprint',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueBlueprint.createCompileBlueprintTool()
  },
  /**
   * 排版：只挪位置，不动节点和连线。
   *
   * mutating 而不是 safe —— 它会把蓝图改脏、需要保存。但它改不坏逻辑，
   * 而且可以 Ctrl+Z 撤销，所以不到 destructive。
   */
  {
    name: 'blueprint_tidy_graph',
    namespace: 'ue.blueprint',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueBlueprint.createTidyBlueprintGraphTool()
  },
  {
    name: 'blueprint_compile_all',
    namespace: 'ue.blueprint',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueBlueprint.createCompileAllBlueprintsTool()
  },

  // ── Content Browser ──────────────────────────────────────────────────
  {
    name: 'ue_content_search',
    namespace: 'ue.content',
    risk: 'safe',
    make: () => ueContent.createSearchAssetsTool(),
    // 盘点大工程时目录清单和资产列表各能上万字符，留在上下文里之后每一步都要重发
    archive: { lists: { folders: ['path', 'assets'], results: ['path', 'class'] } }
  },
  {
    name: 'ue_content_describe',
    namespace: 'ue.content',
    risk: 'safe',
    make: () => ueContent.createDescribeAssetTool(),
    // 一个关卡的依赖动辄两三百个
    archive: { lists: { dependencies: ['path', 'class'], referencers: ['path', 'class'] } }
  },
  {
    name: 'ue_content_audit_optimization',
    namespace: 'ue.content',
    risk: 'safe',
    make: () => ueContent.createAuditOptimizationTool()
  },
  /**
   * 全工程资源占用排行 / 单资产依赖体积。
   *
   * 两个都只读资产注册表和文件大小，一个资产都不加载 —— 所以是 safe，
   * 而且可以放心对整个 /Game 跑。
   */
  {
    name: 'ue_project_asset_ranking',
    namespace: 'ue.content',
    risk: 'safe',
    make: () => ueContent.createAssetRankingTool()
  },
  {
    name: 'ue_asset_size_map',
    namespace: 'ue.content',
    risk: 'safe',
    make: () => ueContent.createSizeMapTool()
  },
  {
    name: 'ue_message_log',
    namespace: 'ue.content',
    risk: 'safe',
    make: () => ueContent.createMessageLogTool()
  },
  {
    name: 'ue_content_import',
    namespace: 'ue.content',
    risk: 'mutating',
    make: () => ueContent.createImportAssetsTool()
  },
  {
    name: 'ue_content_delete',
    namespace: 'ue.content',
    risk: 'destructive',
    make: () => ueContent.createDeleteAssetsTool()
  },

  // ── Editor / Project 配置 ────────────────────────────────────────────
  {
    name: 'ue_screenshot',
    namespace: 'ue.editor',
    risk: 'safe',
    make: () => ueEditor.createScreenshotTool()
  },
  /**
   * 把视口镜头对准某个 Actor（等同于选中后按 F）。
   *
   * 标 mutating 而不是 safe —— 它不改任何资产，但它**抢走用户正在看的画面**，
   * 顺带清空并重设选中（实现上必须先选中才能聚焦）。Ask 模式下用户预期
   * 「AI 只是在看」，而这个会真的动他的编辑器，不该不问就做。
   *
   * 同理，`ue_screenshot` 上**没有** focus 参数：把这件事塞进一个标 safe 的
   * 工具里，等于让只读模式偷偷获得动用户视口的能力，那是在挖安全机制的墙脚。
   * 宁可让模型分两步调。
   */
  {
    name: 'ue_focus_viewport',
    namespace: 'ue.editor',
    risk: 'mutating',
    make: () => ueEditor.createFocusViewportTool()
  },
  {
    name: 'ue_get_project_info',
    namespace: 'ue.editor',
    risk: 'safe',
    make: () => ueEditor.createGetProjectInfoTool()
  },
  /**
   * 用户此刻选中/打开着什么。
   *
   * safe：纯读。特别注意插件那边取焦点用的是 `FindEditorForAsset(Asset, false)`，
   * 第二个参数是「顺便把它调到前面来」—— 传 true 的话一个只读工具就会动用户的窗口。
   */
  {
    name: 'ue_get_selection',
    namespace: 'ue.editor',
    risk: 'safe',
    make: () => ueEditor.createGetSelectionTool()
  },
  {
    name: 'ue_get_config',
    namespace: 'ue.editor',
    risk: 'safe',
    make: () => ueEditor.createGetConfigTool()
  },
  {
    name: 'ue_set_config',
    namespace: 'ue.editor',
    risk: 'mutating',
    make: () => ueEditor.createSetConfigTool()
  },
  {
    name: 'ue_list_unsaved',
    namespace: 'ue.editor',
    risk: 'safe',
    make: () => ueEditor.createListUnsavedTool()
  },
  /**
   * 落盘。
   *
   * 在它之前这套工具**做的所有事都不落盘** —— 插件里 SavePackage 只在几个
   * 蓝图处理器内部出现过，材质、关卡、Actor 改完全靠用户自己按保存。
   *
   * 标 mutating 而不是 safe：它确实改磁盘。但默认只存 agent 自己改脏的包，
   * 用户手改到一半的东西不碰 —— 替他做保存决定是越界的，而且不可撤销。
   *
   * sequential：并发存同一批包会互相打架。
   */
  {
    name: 'ue_save',
    namespace: 'ue.editor',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueEditor.createSaveChangesTool()
  },
  {
    name: 'ue_undo_history',
    namespace: 'ue.editor',
    risk: 'safe',
    make: () => ueEditor.createUndoHistoryTool()
  },
  /**
   * 撤销 agent 自己做过的步骤。
   *
   * 插件端给 agent 单开了一条撤销栈（换掉 `GEditor->Trans`），所以这里的
   * 「全撤」是「把 AI 干的全撤了」，撤不到用户手动做的任何操作。
   *
   * 标 mutating：只撤 agent 自己的事务，撤错了有 redo 走回来，本身就是可撤销的改动。
   *
   * sequential：并发撤销同一条栈会互相打架。
   */
  {
    name: 'ue_undo',
    namespace: 'ue.editor',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueEditor.createUndoTool()
  },
  /**
   * 垃圾回收：只动引擎内存，不碰任何工程内容。
   *
   * 标 mutating 而不是 safe —— 它会让编辑器卡顿几秒、并且会真的卸载对象。
   * Ask 模式（只读）下不该出现。
   */
  {
    name: 'ue_collect_garbage',
    namespace: 'ue.editor',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueEditor.createCollectGarbageTool()
  },
  /**
   * 这两个标 destructive。
   *
   * 重启会丢掉全部未保存改动；清理重定向器会删资产并重写一批引用者。
   * 两个都不可撤销，auto-edit 模式下也要先问一句。
   *
   * 插件端对重启还有一道脏检查（有未保存就回 409），所以重启只在带 force 时
   * 按 destructive 问；不带 force 时丢不了东西，按 mutating 走。
   */
  /**
   * 试玩：把游戏跑起来看它到底能不能跑。
   *
   * mutating 而不是 safe —— PIE 会真的执行游戏逻辑，蓝图里写了什么它就干
   * 什么（生成 Actor、改存档、发网络请求都有可能）。它不改磁盘上的资产，
   * 但绝不是一次只读观察。
   *
   * sequential：同一时间只能有一个 PIE 会话，插件端也会拒绝第二个。
   */
  /**
   * 输入映射查询。**要模拟玩家操作之前先调它** —— 键位是运行时状态，
   * 不是配置：挂着哪些输入上下文由游戏逻辑随时增删，菜单里和跑图时不是一套。
   */
  {
    name: 'ue_input_map',
    namespace: 'ue.input',
    risk: 'safe',
    make: () => ueInput.createInputMapTool()
  },
  /**
   * 在运行中的游戏里模拟一次操作。
   *
   * `sequential`：两次注入并发下去会互相盖住 —— 一次按 W 一次按 S，
   * 角色到底该往哪走没有答案，而返回都会说成功。
   */
  {
    name: 'ue_inject_input',
    namespace: 'ue.input',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueInput.createInjectInputTool()
  },
  /**
   * 加按键映射：写 IMC / InputAction 资产，或旧输入系统的 DefaultInput.ini。
   * sequential —— 两次并发写同一个 IMC，后存的那次会把前一次的映射盖掉。
   */
  {
    name: 'ue_input_add_mapping',
    namespace: 'ue.input',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueInput.createInputAddMappingTool()
  },
  {
    name: 'ue_playtest',
    namespace: 'ue.editor',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueEditor.createPlaytestTool()
  },
  /**
   * 自主试玩机器人：在 pie.run 跑着的时候边看边操作。
   *
   * 和 ue_playtest 同级：mutating（游戏逻辑真的会执行，按钮真的会点）、
   * sequential（同一时间只有一个 PIE 会话）。
   */
  {
    name: 'ue_autoplay',
    namespace: 'ue.editor',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueAutoplay.createAutoplayTool()
  },
  {
    name: 'ue_restart_editor',
    namespace: 'ue.editor',
    risk: 'destructive',
    // 不带 force 时有未保存插件就拒绝，丢不了东西
    riskFor: destructiveOnlyWithForce,
    concurrency: 'sequential',
    make: () => ueEditor.createRestartEditorTool()
  },
  {
    name: 'ue_fixup_redirectors',
    namespace: 'ue.content',
    risk: 'destructive',
    // dry_run 按 safe 算（工具自己的 riskFor），预演上点的「本对话内都允许」放不过真正的那次
    concurrency: 'sequential',
    make: () => ueEditor.createFixupRedirectorsTool()
  },

  // ── Level ────────────────────────────────────────────────────────────
  {
    name: 'ue_find_heavy_assets',
    namespace: 'ue.level',
    risk: 'safe',
    make: () => ueLevel.createQueryAssetsTool()
  },
  {
    name: 'level_organize_actors',
    namespace: 'ue.level',
    risk: 'mutating',
    make: () => ueLevel.createOrganizeActorsTool()
  },
  {
    name: 'ue_get_current_level',
    namespace: 'ue.level',
    risk: 'safe',
    make: () => ueLevel.createGetCurrentLevelTool()
  },
  {
    name: 'ue_save_level',
    namespace: 'ue.level',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueLevel.createSaveLevelTool()
  },
  /**
   * 打开 / 新建关卡声明 destructive（最坏情况），实际按参数算。
   *
   * 带 force 时它们会丢弃全部未保存的改动，且**无法撤销**。不带 force 时插件端
   * 在有脏改动时拒绝并回 409，丢不了东西 —— 所以只有 force 那次按 destructive 问。
   */
  {
    name: 'ue_open_level',
    namespace: 'ue.level',
    risk: 'destructive',
    // 不带 force 时有未保存插件就拒绝（409），丢不了东西
    riskFor: destructiveOnlyWithForce,
    concurrency: 'sequential',
    make: () => ueLevel.createOpenLevelTool()
  },
  {
    name: 'ue_new_level',
    namespace: 'ue.level',
    risk: 'destructive',
    // 同上；但 save_as 会直接盖掉同路径的已有关卡（插件不查），给了就仍按 destructive 问
    riskFor: (args) =>
      (args as { save_as?: unknown } | null)?.save_as
        ? 'destructive'
        : destructiveOnlyWithForce(args),
    concurrency: 'sequential',
    make: () => ueLevel.createNewLevelTool()
  },
  {
    name: 'ue_get_levels',
    namespace: 'ue.level',
    risk: 'safe',
    make: () => ueLevel.createGetLevelsTool()
  },
  /**
   * 标 destructive，判据是**撤销**，不是「会不会删东西」。
   *
   * 改流送方式那一项走的是「摘掉旧对象、按新类重加一个」，撤销栈接不住
   * （引擎自己的 Levels 窗格也没给它开事务）。而这套风险等级的定义就是拿
   * 可撤销性划的：`mutating` 写着「可撤销，auto-edit 放行」，`destructive`
   * 写着「不可逆，始终审批」——而 auto-edit 是**默认档**，它的界面标签就是
   * 「可撤销的自动放行」。标成 mutating 等于让一个 Ctrl+Z 撤不回来的操作
   * 在默认设置下不问一声就执行，那道门就是为了拦它才存在的。
   *
   * 一度按 mutating 记，理由是「改错了再调一次就回去了」。那句话本身是错的：
   * 换回 ULevelStreamingDynamic 会新建一个对象，它的两个游戏侧标志默认全 false，
   * 于是「还原」反而把这一层从游戏里彻底摘掉。插件现在会把原值接回来，
   * 但这只是兜底，撑不起「可撤销」这个等级。
   */
  {
    name: 'ue_set_level_streaming',
    namespace: 'ue.level',
    risk: 'destructive',
    concurrency: 'sequential',
    make: () => ueLevel.createSetLevelStreamingTool()
  },

  // ── System ───────────────────────────────────────────────────────────
  // 会话体检（`ue_session_health`）不在这张表里 —— 它是 V3 原生工具，
  // 见下面 `buildAllTools()` 里的说明。
  {
    name: 'ue_get_performance_stats',
    namespace: 'ue.system',
    risk: 'safe',
    make: () => ueSystem.createGetPerformanceStatsTool()
  },
  {
    name: 'ue_get_crash_logs',
    namespace: 'ue.system',
    risk: 'safe',
    make: () => ueSystem.createGetCrashLogsTool()
  },
  /**
   * 一段时间的性能采样，不是单帧快照。用引擎自带的 CSV Profiler，
   * 只读不改工程内容 —— 落盘的 CSV 在 Saved/Profiling，和资产无关。
   */
  {
    name: 'ue_capture_perf_trace',
    namespace: 'ue.system',
    risk: 'safe',
    make: () => ueSystem.createCapturePerfTraceTool()
  },
  /**
   * Unreal Insights：action=capture 录一段 trace（只落盘到 Saved/Profiling，不改工程），
   * action=analyze 跑一次 UnrealInsights.exe 分析已有的 .utrace。
   *
   * 2026-09-11 由 ue_capture_insights_trace + ue_analyze_insights_trace 合成一个：
   * 永远连着用、风险同档、参数不重叠，拆开只是多一个名字给模型挑
   * 。
   *
   * analyze 会启动一个外部进程，但不是「执行任意代码」—— 目标固定是引擎自带的
   * UnrealInsights.exe，只读一个已经录好的 trace 文件，不碰工程内容，
   * 和 ue_run_console_command / ue_run_python_script 的风险不是一回事。
   */
  {
    name: 'ue_insights_trace',
    namespace: 'ue.system',
    risk: 'safe',
    make: () => ueSystem.createInsightsTraceTool()
  },
  /**
   * ZenServer 只读诊断：命中率、占盘、登记的工程。直接问本机的 Zen HTTP 接口，
   * 不经过插件，也不清理任何东西。Zen 随编辑器起停，所以照常跟着引擎连接走，
   * 不进离线名单。
   */
  {
    name: 'ue_zen_server',
    namespace: 'ue.system',
    risk: 'safe',
    make: () => ueSystem.createZenServerTool()
  },
  /**
   * 编辑器状况：启动耗时、卡顿率、进 PIE 耗时、本地缓存命中、可用内存。
   * 只读快照，和顶栏状态监控面板同一份数据（services/editorHealth.ts）。
   */
  {
    name: 'ue_editor_health',
    namespace: 'ue.system',
    risk: 'safe',
    make: () => ueSystem.createEditorHealthTool()
  },
  // 下面四个都能在引擎里执行任意代码 —— 一律按不可逆处理，auto-edit 下也要问
  {
    name: 'ue_run_console_command',
    namespace: 'ue.system',
    risk: 'destructive',
    make: () => ueSystem.createRunConsoleCommandTool()
  },
  {
    name: 'ue_run_python_script',
    namespace: 'ue.system',
    risk: 'destructive',
    make: () => ueSystem.createRunPythonScriptTool()
  },
  {
    name: 'ue_manage_plugin',
    namespace: 'ue.system',
    risk: 'destructive',
    make: () => ueSystem.createManagePluginTool()
  },

  // ── Widget (UMG) ─────────────────────────────────────────────────────
  {
    name: 'widget_get_hierarchy',
    namespace: 'ue.widget',
    risk: 'safe',
    make: () => ueWidget.getWidgetHierarchyTool()
  },
  {
    name: 'widget_preview',
    namespace: 'ue.widget',
    risk: 'safe',
    make: () => ueWidget.previewWidgetTool()
  },
  {
    // 控件蓝图的写操作同样一律 sequential，理由见上面 blueprint_create 那段
    name: 'widget_create',
    namespace: 'ue.widget',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueWidget.createWidgetTool()
  },
  {
    name: 'widget_add_child',
    namespace: 'ue.widget',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueWidget.addChildTool()
  },
  /**
   * 改已有控件的槽位。
   *
   * 插件的 widget.set_canvas_slot / set_vertical_slot 一直没有任何调用点 ——
   * 于是槽位参数只有添加控件的那一刻能给，加完想挪一挪只能删了重加，
   * 而重加会丢掉控件上已经设过的属性、事件绑定和变量标记。
   *
   * sequential：同一份 WidgetTree 并发改会互相覆盖，和 widget_add_child 同理。
   */
  {
    name: 'widget_set_slot',
    namespace: 'ue.widget',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueWidget.setSlotTool()
  },
  {
    name: 'widget_make_variable',
    namespace: 'ue.widget',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueWidget.makeVariableTool()
  },
  {
    name: 'widget_set_property',
    namespace: 'ue.widget',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueWidget.setPropertyTool()
  },
  /**
   * 改现成的界面：原地换控件、删控件。
   *
   * 控件工具原来只有「往里加」，用户说「把登录按钮换成导航那种」时，调用方只能
   * 在旁边再加一个，然后让用户自己去编辑器里删旧的、接事件。
   *
   * 两个都是 mutating：插件端开在事务里，ue_undo 撤得回来；删除碰到图表引用
   * 默认拒绝，替换碰到接不上的事件也拒绝，都要调用方显式确认。
   */
  {
    name: 'widget_replace',
    namespace: 'ue.widget',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueWidget.replaceWidgetTool()
  },
  {
    name: 'widget_remove',
    namespace: 'ue.widget',
    risk: 'mutating',
    concurrency: 'sequential',
    make: () => ueWidget.removeWidgetTool()
  },

  // ── 资产库（盒子本地，不依赖引擎连接）────────────────────────────────
  {
    name: 'search_assets',
    namespace: 'asset',
    risk: 'safe',
    make: () => assetTools.createSearchAssetsTool(),
    // 一页最多几百个资产、每行十来个字段，真实会话里单次到过 17.8 万字符
    archive: { lists: { assets: ['name', 'type', 'path', 'vault', 'engineVersion'] } }
  },
  // 「我库里有什么」不能靠翻页去数。几十万个资产的库里，search_assets 一页 100 个，
  // 调用方拿到的只会是按名字排在最前的那一百个，然后拿它们总结全库 —— 错得看不出来。
  // 这个工具回的是 SQL 精确算出来的分布，库多大它都只有几百 token。
  {
    name: 'library_overview',
    namespace: 'asset',
    risk: 'safe',
    make: () => assetTools.createLibraryOverviewTool()
  },
  // 读跨库、写不跨库（见 adapted/asset/vaultScope.ts）。于是「东西在另一个库里，
  // 但改动只能在活跃库做」这一幕必然会撞上，出路只有换库 —— 而换库是用户的决定：
  // 应用整个界面会跟着换。所以定成 mutating 走审批门，用户可以放行一次，
  // 也可以点「本对话内都允许」让它以后自己切。
  {
    name: 'switch_vault',
    namespace: 'asset',
    risk: 'mutating',
    make: () => assetTools.createSwitchVaultTool()
  },
  {
    name: 'annotate_asset',
    namespace: 'asset',
    risk: 'mutating',
    make: () => assetTools.createAnnotateAssetTool()
  },
  // 打标签之前得先看得见已有的标签，否则「树 / 树木 / Tree」会越攒越多
  {
    name: 'list_tags',
    namespace: 'asset',
    risk: 'safe',
    make: () => assetTools.createListTagsTool()
  },

  // ── 笔记 ──────────────────────────────────────────────────────────────
  //
  // 实现一直躺在 adapted/note/ 里没人调 —— 于是用户在输入框 @ 了一篇笔记，
  // 模型手上却没有任何能打开它的工具，只能回一句「我读不到」。
  // 笔记是盒子自己的数据，不依赖引擎连接。
  //
  // `create_note` 一度被 deep-research / knowledge-base-and-projects 两个 skill
  // 明令禁用，理由是 agent 建出来的笔记没有任何用户能打开的入口。现在的规则
  // 直接堵死了那个问题：**建笔记必须挂在一个资产或文件夹上**，挂不上就回滚。
  // 规则和话术见 agent/tools/app-control/notes/noteAttachment.ts
  {
    name: 'search_notes',
    namespace: 'note',
    risk: 'safe',
    make: () => noteTools.createSearchNotesTool()
  },
  {
    name: 'get_note',
    namespace: 'note',
    risk: 'safe',
    make: () => noteTools.createGetNoteTool()
  },
  {
    name: 'create_note',
    namespace: 'note',
    risk: 'mutating',
    needsSender: true,
    make: (deps) => noteTools.createCreateNoteTool(deps.sender!)
  },
  // 改笔记是覆盖正文，写坏了没有版本可回；但目标明确、改完用户在详情面板里
  // 立刻看得见，和「删掉」不是一个量级
  {
    name: 'update_note',
    namespace: 'note',
    risk: 'mutating',
    needsSender: true,
    make: (deps) => noteTools.createUpdateNoteTool(deps.sender!)
  },
  // 删笔记没有回收站，而且笔记里可能挂着用户贴的图和视频 —— 每次都问
  {
    name: 'delete_note',
    namespace: 'note',
    risk: 'destructive',
    needsSender: true,
    make: (deps) => noteTools.createDeleteNoteTool(deps.sender!)
  },

  // ── 蓝图库 / 材质库（片段仓库）────────────────────────────────────────
  // 只读本地包目录，不碰引擎
  {
    name: 'library_search',
    namespace: 'library',
    risk: 'safe',
    make: () => libraryTools.createLibrarySearchTool()
  },
  // 读引擎、写本地保管库。不改用户工程，所以是 mutating 而不是 destructive ——
  // 存错了删掉重存就行，不像写图那样会动到别人的东西。
  {
    name: 'blueprint_library_save',
    namespace: 'library',
    risk: 'mutating',
    make: () => libraryTools.createBlueprintLibrarySaveTool()
  },
  // **唯一会改用户工程的一步**，必须走审批门。
  // 保护不在这里，在插件的 require_empty 里（见 services/library/pluginCapabilities.ts）：
  // 盒子发参数拦不住旧插件，所以写入前先探能力，探不到就拒绝。
  {
    name: 'blueprint_library_apply',
    namespace: 'library',
    risk: 'mutating',
    make: () => libraryTools.createBlueprintLibraryApplyTool()
  },
  // 看得见、加得上，还得改得动。annotate_asset 遇到新名字会自动建标签，
  // 也就是说 agent 有能力把标签体系搅碎却没能力收拾 —— 改名/改色是可逆的日常整理，
  // 登记成 mutating。
  {
    name: 'manage_tags',
    namespace: 'asset',
    risk: 'mutating',
    make: () => assetTools.createManageTagsTool()
  },
  // 删标签和合并标签**没有回收站**，丢掉的分类信息找不回来 —— 和改名不是一个量级，
  // 所以单独拆出来登记成 destructive，每次都问。
  {
    name: 'delete_tags',
    namespace: 'asset',
    risk: 'destructive',
    make: () => assetTools.createDeleteTagsTool()
  },
  // 软删除（进回收站、能恢复、不动磁盘文件），restore_assets 就能原样捞回来，
  // 是可撤销的改动，登记成 mutating。
  {
    name: 'delete_assets',
    namespace: 'asset',
    risk: 'mutating',
    make: () => assetTools.createDeleteAssetsTool()
  },
  // 恢复和删除必须同时存在。只给删不给恢复，等于让用户在没有撤销键的编辑器里
  // 干活 —— agent 认错一个 assetKey 删掉一条，它自己连补救都做不了。
  {
    name: 'restore_assets',
    namespace: 'asset',
    risk: 'mutating',
    make: () => assetTools.createRestoreAssetsTool()
  },
  {
    name: 'move_assets',
    namespace: 'asset',
    risk: 'mutating',
    make: () => assetTools.createMoveAssetsTool()
  },
  {
    name: 'create_folders',
    namespace: 'asset',
    risk: 'mutating',
    make: () => assetTools.createFoldersTool()
  },
  {
    name: 'rename_folder',
    namespace: 'asset',
    risk: 'mutating',
    make: () => assetTools.createRenameFolderTool()
  },
  // 删文件夹连里面的资产一起软删，restore_folders 连目录树一起恢复 —— 同样可撤销
  {
    name: 'delete_folders',
    namespace: 'asset',
    risk: 'mutating',
    make: () => assetTools.createDeleteFoldersTool()
  },
  // delete_folders 的撤销键。删文件夹连里面的资产一起带走，而 restore_assets
  // 只捞得回资产、捞不回它们原来待的那棵目录树 —— 少了这个，agent 删错一整个
  // 素材包就只能让用户自己去界面里点。不给参数时只列回收站，是只读的。
  {
    name: 'restore_folders',
    namespace: 'asset',
    risk: 'mutating',
    make: () => assetTools.createRestoreFoldersTool()
  },
  // 工程管理拆成两个：只读的列举、和会动工程/关卡的写操作。
  //
  // 原来注册的是 `adapted/asset/projectTool`（245 行、只有 3 个动作），
  // 而功能完整的 `adapted/project/projectTool`（1758 行、7 个动作，
  // 含把素材库资产导入工程）**只挂在一个调试 HTTP 端点上，agent 够不着** ——
  // 「把我素材库里那两把椅子导进工程」这件事因此做不了。
  //
  // 换成完整版，并按风险拆开：注册表只能按工具声明 risk，
  // 七个动作从「列模板」到「往关卡里放 Actor」差了两个量级，
  // 混在一起要么静默放行太危险，要么连列举都弹窗、把用户练成无脑点确认。
  {
    name: 'project_list',
    namespace: 'project',
    risk: 'safe',
    make: () => createProjectListTool(),
    // list_templates 一次回 300 个模板（约 10 万字符），模型只挑其中一个
    archive: {
      lists: {
        templates: ['name', 'templateKey', 'category', 'engineVersion'],
        projects: ['name', 'projectKey', 'engineVersion', 'path']
      }
    }
  },
  {
    name: 'project_manage',
    namespace: 'project',
    risk: 'destructive',
    // 只往外加东西的动作按 mutating 走，见 `splitByRisk.ts` 的 projectManageRisk
    riskFor: projectManageRisk,
    /*
     * 串行，因为 `open_project` 会**改掉这一轮的目标工程**
     * （见 `adapted/project/awaitProjectLive.ts`）。
     *
     * 并行的话，同一条 assistant 消息里的兄弟工具会在它切过去的那一刻被顺手
     * 带走：UE 工具每发一条 RPC 都重新读一次目标，于是一张蓝图的前半截落在
     * 旧工程、后半截落在新工程，两边都不报错。`ue_restart_editor` 和
     * `set_session_project` 这两个同样会动目标的工具，早就是串行的。
     *
     * **它只管得住这一批。** pi 的串行是「同一条 assistant 消息的这一批工具调用」
     * 范围内的，跨 agent 不管 —— 并行的 `task` 子 agent 之间靠 `runSubAgent`
     * 给每个子任务开一份自己的目标上下文来隔离（见 `core/createAgent.ts`）。
     */
    concurrency: 'sequential',
    make: () => createProjectWriteTool()
  },
  /*
   * 工程库的整理（分组、置顶）。
   *
   * 和上面两个分开，因为它既不只读也不动用户的磁盘：改的全是盒子自己数据库里的
   * 归类信息，工程文件一个字节都不碰，删合集也只是拆分组、工程照样在库里。
   * 标 destructive 会让「帮我按引擎版本分个组」这种纯整理动作每次弹窗，
   * 用户很快就会养成无脑点确认的习惯 —— 那比不弹更危险（见 splitByRisk.ts）。
   */
  {
    name: 'project_organize',
    namespace: 'project',
    risk: 'mutating',
    make: () => createOrganizeProjectsTool()
  }

  // 旧的 note 工具不在这里注册。产品里的「笔记」早已收进知识库成为 text 来源，
  // 单独 create_note 会写进用户没有入口可见的旧表。知识库读写统一走下面按会话绑定的
  // search_notebook_sources / add_notebook_source。
])

export { rewriteCrossReferences } from './toolNames'

/**
 * 工具名 → 风险等级。
 *
 * 渲染层要靠它算「本轮改动」：哪些调用真的动了东西、哪些不可回滚。
 * 风险声明只有注册表这一份，绝不能在渲染层再抄一张表 —— 抄了必然漂移。
 * 本地文件/shell 工具不在 REGISTRATIONS 里，它们的风险写在工具自身上。
 */
export function listToolRisks(): Record<string, ToolRisk> {
  const table: Record<string, ToolRisk> = {}

  for (const reg of REGISTRATIONS) {
    table[reg.name] = reg.risk
  }

  for (const tool of getLocalFileTools()) {
    table[tool.name] = tool.unrealBox.risk
  }

  for (const tool of materialTools) {
    table[tool.name] = tool.unrealBox.risk
  }

  for (const tool of pcgTools) {
    table[tool.name] = tool.unrealBox.risk
  }

  for (const tool of sequencerTools()) {
    table[tool.name] = tool.unrealBox.risk
  }

  for (const tool of meshTools()) {
    table[tool.name] = tool.unrealBox.risk
  }
  for (const tool of landscapeTools()) {
    table[tool.name] = tool.unrealBox.risk
  }
  for (const tool of animationTools()) {
    table[tool.name] = tool.unrealBox.risk
  }
  for (const tool of inspectTools()) {
    table[tool.name] = tool.unrealBox.risk
  }

  for (const tool of contentOrganizeTools()) {
    table[tool.name] = tool.unrealBox.risk
  }

  for (const tool of dataTableTools()) {
    table[tool.name] = tool.unrealBox.risk
  }

  table[assetGuidelinesTool.name] = assetGuidelinesTool.unrealBox.risk

  for (const tool of engineTools) {
    table[tool.name] = tool.unrealBox.risk
  }

  for (const tool of createBoxTools()) {
    table[tool.name] = tool.unrealBox.risk
  }

  for (const tool of projectPackageTools()) {
    table[tool.name] = tool.unrealBox.risk
  }
  const boxPlan = createBoxPlanTool()
  table[boxPlan.name] = boxPlan.unrealBox.risk
  const recordGameplay = createRecordGameplayTool()
  table[recordGameplay.name] = recordGameplay.unrealBox.risk
  // 装 / 更新插件会关掉再重开编辑器，同样不在 REGISTRATIONS 里
  const updatePlugin = createProjectUpdatePluginTool()
  table[updatePlugin.name] = updatePlugin.unrealBox.risk

  for (const tool of aigcTools()) {
    table[tool.name] = tool.unrealBox.risk
  }

  for (const tool of taskVideoTools()) {
    table[tool.name] = tool.unrealBox.risk
  }

  table[sessionHealthTool.name] = sessionHealthTool.unrealBox.risk

  // 接第三方 MCP：会起本机进程、写 mcp.json。漏了它，「本轮改动」里看不见这一步
  for (const tool of mcpTools) {
    table[tool.name] = tool.unrealBox.risk
  }
  // 编译 C++ 同理（改了工程的二进制），原来也不在表里
  for (const tool of cppTools()) {
    table[tool.name] = tool.unrealBox.risk
  }

  /*
   * 在 `resolveTools` 里现造、进不了 `REGISTRATIONS` 的那个写工具。
   *
   * 别的现造工具（`ask_user`、`voice_report`、浏览器读那几个）都是 safe，
   * 查不到就按 safe 处理没有代价；这一个是 `mutating`，漏了它，
   * 渲染层的「本轮改动」会把一次换工程归属完全略过 —— 而那正是最该让用户
   * 看见的一类改动。
   */
  table[SET_SESSION_PROJECT_TOOL_NAME] = SET_SESSION_PROJECT_RISK

  return table
}

/**
 * 「设置 → 工具」那一页要显示的清单。
 *
 * 和 `buildAllTools()` 的差别只在**浏览器工具**：那几个是在 `resolveCandidateTools`
 * 里按会话现造的，进不了 `buildAllTools()`。但用户在设置页找不到「浏览网页」
 * 这一摊的话，会以为盒子根本没有这个能力 —— 所以这里补上，用不带会话的实例
 * 取名字和说明（只读元数据，不会碰到任何浏览器状态）。
 *
 * 仍然不补的是 `load_skill` / `ask_user` / `task` / `search_tools` 那几个：
 * 它们在 `ALWAYS_RESIDENT_TOOL_NAMES` 里，本来就不给开关，列出来只会多几行
 * 点不动的东西。
 */
export interface ToolCatalogEntry {
  name: string
  namespace: string
  description: string
  risk: ToolRisk
  /** 没人动过设置时，工具搜索模式下它是不是常驻 */
  defaultResident: boolean
  /**
   * 这一条塞进每次请求要花多少 token（名字 + 说明 + 参数表）。
   *
   * 用运行时那个 `estimateTokens`，不是门禁里那个真 tokenizer ——
   * `gpt-tokenizer` 是 devDependency，打包进去的应用里没有它。
   * 它按「中文一字一 token」算，偏保守（往多了估），而设置页要回答的是
   * 「大概多少」，估多一点好过让用户以为前缀很便宜。
   */
  tokens: number
}

export function listToolCatalog(deps: BuildToolsDeps = {}): ToolCatalogEntry[] {
  const tools = [...buildAllTools(deps), ...createBrowserTools()]
  return tools
    .map((tool) => ({
      name: tool.name,
      namespace: tool.unrealBox.namespace,
      description: tool.description,
      risk: tool.unrealBox.risk,
      defaultResident: isDefaultResidentTool(tool),
      tokens: estimateTokens(
        JSON.stringify({
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        })
      )
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}

/** 工具名必须符合厂商约定，否则请求会被直接拒 */
const VALID_TOOL_NAME = /^[a-zA-Z0-9_-]{1,64}$/

export interface BuildToolsDeps {
  sender?: WebContents
  /**
   * 这条对话绑着的知识库。
   *
   * 只有绑了才注册检索工具：没绑的对话给出这个工具，模型调了只能拿到
   * 一句「没有知识库」—— 那是白费一步，而且看上去像功能坏了。
   * `'all'` 是全盒子范围（外部 MCP 会话），见 `NotebookScope`。
   */
  notebook?: NotebookScope
}

let cache: UnrealAgentTool<never>[] | undefined

/*
 * 用户改了 AI 配置就把工具表作废。
 *
 * 工具**几乎都是**无状态的，唯一的例外是 `generate_3d_model`：它的入参表取决于
 * 用户给「3D 生成」绑的是哪家厂商（厂商特供开关只对绑了那一家的人暴露）。
 * 不订阅的话，用户在偏好设置里换完厂商要重启应用才生效 —— 而那种「改了没反应」
 * 最难查，因为界面上配置明明是新的。
 */
onSettingsChanged(() => {
  cache = undefined
})

/**
 * 造出全部 UE / 资产工具。
 *
 * 结果缓存：工具是无状态的，每轮对话重造一遍要跑 60 多次 Zod→JSON Schema 转换。
 */
export function buildAllTools(deps: BuildToolsDeps = {}): UnrealAgentTool<never>[] {
  if (cache && !deps.sender && !deps.notebook) return cache

  const adapted = REGISTRATIONS.filter((reg) => !reg.needsSender || deps.sender).map((reg) => {
    if (!VALID_TOOL_NAME.test(reg.name)) {
      throw new Error(`工具名 "${reg.name}" 不符合厂商约定 ^[a-zA-Z0-9_-]{1,64}$`)
    }
    const v2 = reg.make(deps)
    return adaptV2Tool(v2, {
      name: reg.name,
      namespace: reg.namespace,
      risk: reg.risk,
      ...(reg.riskFor ? { riskFor: reg.riskFor } : {}),
      ...(reg.archive ? { archive: reg.archive } : {}),
      description: rewriteCrossReferences(v2.description ?? reg.name),
      ...(reg.concurrency ? { concurrency: reg.concurrency } : {})
    })
  }) as unknown as UnrealAgentTool<never>[]

  // 材质工具和本地文件工具是 V3 原生的（带 risk / 并发声明），不走适配 ——
  // 再包一层 adaptV2Tool 会因为找不到 inputSchema 而直接抛
  const all = [
    ...adapted,
    ...(materialTools as unknown as UnrealAgentTool<never>[]),
    // PCG 工具走插件 RPC（pcg.*），但引擎侧是靠反射调 PCG 的 —— PCG 是可选插件，
    // 没启用时命令返回 501 而不是消失，所以这里无条件注册
    ...(pcgTools as unknown as UnrealAgentTool<never>[]),
    // Sequencer 工具同样是 V3 原生的。它走 Python 通道（runEditorPython）
    // 而不是插件 RPC ——
    ...sequencerTools(),
    // 网格工具走插件 RPC（mesh.*）。它和 Sequencer 相反 —— 走 C++ 不走 Python，
    ...meshTools(),
    // 地形与地形 RVT（landscape.*）。同样走 C++：UE 的 Python 建不出地形
    ...landscapeTools(),
    ...animationTools(),
    // 细粒度只读：组件级回读（actor.inspect_components）、材质图切片（复用 material.get_graph）
    ...inspectTools(),
    // 内容浏览器整理（content.naming_audit / batch_move / dependencies / migrate）。
    // 同样走 C++；ue_content_move 从 REGISTRATIONS 里的单资产适配件换成了这里的批量版
    ...contentOrganizeTools(),
    // 数据表（datatable.*）：读列和行、批量改格子 / 加删改名行。走 C++，不让模型现写 Python
    ...dataTableTools(),
    // 资产自带的「资产指南」（CitySample 那几个「缺失项目设置」弹框）：查 + 一次改好
    assetGuidelinesTool as unknown as UnrealAgentTool<never>,
    // C++ 工作流（cpp.*）。目前只有两个只读工具：探测编译能力、列模块。
    ...cppTools(),
    // 引擎清单是盒子的本地能力（扫安装记录、查进程），不依赖引擎连接，
    // 所以命名空间不是 ue.* —— 引擎没连上时它照样在
    ...engineTools,
    // 打包成可执行文件、拿打包版冒烟。不依赖编辑器，所以不在 ue.* 下（断开引擎时也能用）
    ...projectPackageTools(),
    // 录玩法视频：录打包版窗口或 PIE 窗口，不依赖编辑器连接
    createRecordGameplayTool() as unknown as UnrealAgentTool<never>,
    // 对话里替用户连接 Box Plan、领 MegaJam 套餐、导入模型。登录和「允许」仍由用户在浏览器里点
    createBoxPlanTool() as unknown as UnrealAgentTool<never>,
    // 装 / 更新工程里的插件。插件太旧或没装上时引擎正连不上，所以同样不在 ue.* 下
    createProjectUpdatePluginTool() as unknown as UnrealAgentTool<never>,
    // 会话体检。命名空间在 `ue.system` 下，但它**不依赖引擎连接** ——
    // 进程检测在盒子这一侧做，所以它同时进了 `createAgent.ts` 的
    // `OFFLINE_UE_TOOLS` 豁免名单：连不上的时候正是最需要它的时候。
    //
    // 它是 V3 原生工具而不是走 REGISTRATIONS 的适配件：`wait_seconds` 那条
    // 等待路径要 `signal`（用户按停止要能立刻停）和 `report`（界面得看得见
    // 「已等 25 秒」），而适配层给 execute 传的是个空对象，两样都没有。
    sessionHealthTool as unknown as UnrealAgentTool<never>,
    // 生图。同样不依赖引擎连接（没连引擎也能出概念图），但它最主要的用法
    // 是拿视口截图当参考图出渲染成品图 —— 见 tools/aigc/generateImage.ts
    ...aigcTools(),
    ...(taskVideoTools() as unknown as UnrealAgentTool<never>[]),
    // 无头检索：只读、不开窗口、不弹审批。和 browser_* 的分工见 builtin/web.ts
    ...createWebTools(),
    // 接入第三方 MCP server。和引擎清单一样是盒子的本地能力，不依赖引擎连接 ——
    // 用户说「我装了个 MCP 你连一下」的时候，引擎往往还没开
    ...mcpTools,
    ...getLocalFileTools(),
    // 盒子本身：看盒子助手的对话、盒子状态，管技能 / 第三方 MCP / 导入 / 备份。
    // 外部 MCP 客户端靠它看见盒子，见 builtin/box.ts
    ...createBoxTools(),
    // 检索只能搜当前绑定的知识库（外部会话是全部）；存来源在未绑定时会新建知识库。
    // 两者都不进 cache —— 每条对话绑的库不一样；存来源还需要 sender 通知界面刷新。
    ...((deps.notebook
      ? [createSearchNotebookSourcesTool(deps.notebook)]
      : []) as unknown as UnrealAgentTool<never>[]),
    ...((deps.sender
      ? [createAddNotebookSourceTool(deps.notebook, deps.sender)]
      : []) as unknown as UnrealAgentTool<never>[])
  ]

  // 资产锁包在这里而不是包在 defineTool 里：工具对象有**两个**构造入口
  // （defineTool 和 adaptV2Tool，后者自己拼对象不走前者），而 callUe 也不是
  // 收口 —— adapted/ 下 73 个工具直接调 WebSocket。这个数组是全部工具唯一
  // 汇合的地方，包在这里才做到「以后加新工具不可能忘记加锁」。
  // 先过资产锁（拿不到立刻失败），再排编辑器钥匙（拿不到就等）。反过来的话，
  // 一个注定被锁挡下的调用要先排完队才知道自己白等了
  const guarded = all.map((tool) => withAssetLock(withEditorKeyGate(tool)))

  assertUniqueNames(guarded)
  if (!deps.sender && !deps.notebook) cache = guarded
  return guarded
}

/**
 * 给一个工具套上资产独占锁。
 *
 * 只拦**写**：`safe` 工具原样返回。读到中间态最坏是模型多问一次，
 * 而加读锁要引入读者计数、写者饥饿、升降级那一整套，代价远大于收益。
 *
 * 拿不到锁**抛异常**而不是返回 isError —— pi 判定工具失败的唯一依据是
 * execute 有没有抛（见 defineTool.ts）。返回值里设 isError 会被静默忽略，
 * 结果是「被锁挡住」被当成执行成功报给模型。
 *
 * 拿到之后**不释放** —— 锁的生命周期是一整轮 run，由 ipc 层在 finally 里
 * 统一放掉。在这里放掉的话，同一轮里下一个工具还得重新抢，中间的空窗
 * 正好够另一条会话插进来。
 *
 * ## 只读位在这里开合（资产锁 B 阶段）
 *
 * 锁只挡得住盒子里的另一条会话；挡用户手动保存靠文件系统的只读位。
 * 可那个位同样挡得住我们自己的插件（实测），所以**持有者动手前必须清位、
 * 做完立刻翻回来**。这一开一合就套在 `inner` 两侧：一处代码，覆盖全部写工具。
 *
 * 开合的范围是**会话手上的全部锁**，不是这次调用参数里那几个 —— 理由见函数体里
 * 那段注释（`ue_save` 参数里根本没有路径）。
 *
 * 两边都吞异常 —— 只读位是增强层，它出问题绝不能让工具本身失败。
 */
/**
 * 这些命名空间下的写工具改的是**当前关卡**，而它们的参数里没有资产路径。
 *
 * `ue.actor`：spawn / 销毁 / 移动 / 改属性，动的都是关卡里的 actor。
 * `ue.level`：保存关卡、整理 actor、改流送设置。
 *
 * `safe` 的那些（`ue_get_actor` / `ue_get_levels` …）在 `withAssetLock` 开头
 * 就返回了，到不了这里。
 */
const LEVEL_SCOPED_NAMESPACES = new Set(['ue.actor', 'ue.level'])

/** 工作室模式撞上队友的锁时，最多等多久、多久看一次 */
const TEAM_LOCK_WAIT_MS = 90_000
const TEAM_LOCK_POLL_MS = 2_000

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Operation aborted'))
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(signal?.reason ?? new Error('Operation aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function withAssetLock(tool: UnrealAgentTool<never>): UnrealAgentTool<never> {
  if (tool.unrealBox.risk === 'safe') return tool

  const inner = tool.execute.bind(tool)

  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      // 不在会话上下文里（单元测试、直接调用）就不加锁：没有主人的锁
      // 没人释放，那才是真会卡死用户的东西
      const owner = getLockOwner()
      if (!owner) return inner(toolCallId, params, signal, onUpdate)
      // 这一次调用只读（riskFor 降成 safe，比如只查不改）：不占锁、不翻只读位
      if (effectiveRisk(tool.unrealBox, params) === 'safe') {
        return inner(toolCallId, params, signal, onUpdate)
      }

      /*
       * 工作室模式（`editorKeyActive()`）两处不一样，都是 2026-09-26 真机反馈逼出来的：
       *
       * - **只挡、不翻只读位**（软锁）。只读位本来是防用户在编辑器里手动保存盖掉 AI 的改动；
       *   可团队里每个队员各有锁主，队员 A 锁着的包在磁盘上变成只读，制作人一句
       *   `ue_save(touched)` 就撞上「File is read-only」，而工具集里没有东西能清它。
       * - **撞上队友的锁先等一会儿**。团队并行时撞锁是常态，立刻失败只会让模型改排任务、
       *   几轮之后再回来补；等一小会儿多半就等到了。等不到再报，报的时候说清是哪个队友。
       */
      const team = editorKeyActive()
      const lock = async (wanted: string[], soft: boolean): Promise<void> => {
        // 没指定目标、只连着一个编辑器时，命令实际发给的就是它 —— 锁也记在它名下。
        // 记成「空连接」的话，别的工程里同名软路径的资产会被一起挡住
        const connection = effectiveConnectionId()
        let result = acquire(connection, owner, wanted, { soft: soft || team })
        const deadline = Date.now() + TEAM_LOCK_WAIT_MS
        while (
          !result.ok &&
          team &&
          Date.now() < deadline &&
          result.conflicts.every((conflict) => sameTeam(conflict.owner, owner))
        ) {
          await sleepUnlessAborted(TEAM_LOCK_POLL_MS, signal)
          result = acquire(connection, owner, wanted, { soft: true })
        }
        if (!result.ok) throw new Error(describeConflicts(result.conflicts, owner))
      }

      const paths = extractPackagePaths(params)
      if (paths.length > 0) await lock(paths, false)

      // Actor / 关卡类工具**参数里没有资产路径**，但它们改的是当前关卡那个包。
      // 用哨兵把它也锁上，否则两条会话可以同时往同一张关卡里塞 actor，
      // 谁都不知道对方在动（真机验出来的：改了十轮场景，一个锁都没触发）。
      //
      // 走**软锁**：只挡另一条 AI 会话、只出提示，不翻只读位。用户在主视口里
      // 干活是常态，把关卡的手动保存也拦下来，代价和收益完全不成比例。
      const levelScoped = LEVEL_SCOPED_NAMESPACES.has(tool.unrealBox.namespace)
      if (levelScoped) {
        try {
          await lock([CURRENT_LEVEL_LOCK], true)
        } catch (error) {
          // 制作人的锁只占这一次调用（见下）：关卡锁没拿到、这次不调了，先拿到的路径锁一并放掉
          if (team && teamRootOf(owner) === owner) {
            releasePaths(effectiveConnectionId(), owner, paths)
          }
          throw error
        }
      }

      // 工作室模式的制作人：它那一轮就是整局，锁跟着一轮走的话，它碰过的资产和「当前关卡」
      // 到交付前队友都改不了（撞上去等 90 秒再失败）。制作人的锁只占这一次调用；
      // 队员照旧占到这件活交回（`releaseAll` 在派活的 finally 里）。团队里全是软锁，
      // 不翻只读位，所以这里不用管下面那一开一合
      if (team && teamRootOf(owner) === owner) {
        try {
          return await inner(toolCallId, params, signal, onUpdate)
        } finally {
          releasePaths(effectiveConnectionId(), owner, [
            ...paths,
            ...(levelScoped ? [CURRENT_LEVEL_LOCK] : [])
          ])
        }
      }

      // 开合的范围是**这条会话手上的全部锁**，不是这次调用参数里那几个 ——
      // 所以「参数里没有资产路径」这条也不能提前返回。
      //
      // 很多工具落盘的不是自己参数里那个资产：`ue_save` 参数里根本没有路径，
      // 它存的是这一轮所有被改脏的包；编译蓝图会顺带改脏依赖它的资产。
      // 按参数开合的话，agent 自己的保存会被自己几步之前加的位挡下，
      // 而报出来的是「文件只读」，看着像用户的锅。
      // 软锁（关卡）不进只读位那条路：哨兵没有磁盘文件可翻，用户的手动保存
      // 也是刻意不拦的。一开一合的名单必须前后一致，否则引用计数会对不上
      const held = locksOwnedBy(owner).filter((lock) => !lock.soft)
      if (held.length === 0) return inner(toolCallId, params, signal, onUpdate)

      // 开合必须严格配对：`suspendForWrite` 里有一个每包的引用计数，多加一次
      // 就永远减不回 0，那个包在本进程剩下的时间里再也翻不上只读位、而且毫无
      // 痕迹。所以 suspend 也放在 try 里 —— 它现在不会抛，但把它留在 try 外面
      // 等于让「以后有人在里面加一行会抛的代码」直接变成静默失效
      try {
        await suspendForWrite(held)
        return await inner(toolCallId, params, signal, onUpdate)
      } finally {
        await enforceAfterWrite(held)
      }
    }
  } as UnrealAgentTool<never>
}

/**
 * 工作室模式下，改编辑器的工具要先拿到编辑器钥匙（见 `core/team/editorKey.ts`）。
 *
 * 只套 `ue.*` 的写工具：读不改状态，并发读没有害处；`ue.*` 以外的写工具
 * （本地文件、素材库、生图）不经过编辑器，本来就该并行。
 * 不在工作室模式里（`editorKeyActive()` 为假）就原样透传，普通会话零改变。
 */
function withEditorKeyGate(tool: UnrealAgentTool<never>): UnrealAgentTool<never> {
  if (tool.unrealBox.risk === 'safe' || !tool.unrealBox.namespace.startsWith('ue.')) return tool

  const inner = tool.execute.bind(tool)
  return {
    ...tool,
    execute: (toolCallId, params, signal, onUpdate) =>
      editorKeyActive()
        ? withEditorKey(
            effectiveConnectionId() ?? 'default',
            () => inner(toolCallId, params, signal, onUpdate),
            signal
          )
        : inner(toolCallId, params, signal, onUpdate)
  } as UnrealAgentTool<never>
}

/** 重名会让后注册的工具静默覆盖前一个，模型看到的行为与描述对不上 */
function assertUniqueNames(tools: UnrealAgentTool<never>[]): void {
  const seen = new Set<string>()
  for (const tool of tools) {
    if (seen.has(tool.name)) throw new Error(`工具名重复：${tool.name}`)
    seen.add(tool.name)
  }
}

/** 测试用：清掉缓存 */
export function resetToolCacheForTest(): void {
  cache = undefined
}
