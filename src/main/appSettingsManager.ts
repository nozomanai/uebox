import { app } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync, existsSync } from 'fs'
import { logger } from './services'
import { START_HIDDEN_ARG } from './startupVisibility'
import { projectComparisonKey } from './utils/projectPath'
import { setMainLanguage } from './i18n'
import { DEFAULT_GOAL_MAX_ROUNDS, normalizeGoalMaxRounds } from '../shared/goalRounds'

/**
 * Agent 浏览器窗口的显示方式。
 *
 * - `window`：独立窗口。看得最清楚，也最容易被用户接管，但它会抢焦点、
 *   盖在虚幻上面 —— 用户正在编辑器里干活时，这是一次打断。
 * - `embedded`：嵌在助手页面右侧分屏，对话和网页同屏看。**这是默认档**：
 *   一样看得见（安全前提不变），但不抢窗口。
 * - `hidden`：不显示。**这一档会削弱这套能力的核心安全性质** ——
 *   「用户能看到 agent 在操作什么」不再成立，只剩审批弹窗和台账。
 *   给的是明确知道自己在做什么的用户，不做默认。
 */
export type AgentBrowserMode = 'window' | 'embedded' | 'hidden'

/**
 * agent 能读写这台电脑上的哪些位置。
 *
 * - `ue-only`：只剩虚幻相关的位置 —— 装好的引擎、导入盒子的工程、素材库。
 *   想把 agent 圈在虚幻这一摊里的用户自己去设置里选它。
 * - `full`：除凭据、密钥、浏览器数据（见 `pathBoundary.ts`）之外，哪儿都能碰。
 *   **这是默认档。** 真实用法里「把 D:/素材 整理一下 / 导进来」「看一眼这份
 *   导出的 FBX」是常态而不是例外，默认收窄的结果是绝大多数人第一次用就撞墙，
 *   而挡下来的那件事本身完全正当。收窄这一层挡的从来不是恶意（shell 不受它
 *   限制，见 `accessScope.ts`），真正兜底的是黑名单加每步审批。
 *
 * 这一档存在应用设置里而不是 aiConfig store：判定发生在主进程的工具里，
 * 渲染层那个 store 主进程读不到。
 */
export type AgentFileAccessScope = 'ue-only' | 'full'

/**
 * 一轮跑完了要不要弹系统通知。
 *
 * - `unfocused`：**默认**。只有盒子不在前台时才提醒。用户正盯着屏幕看它干活，
 *   右下角再弹一条「完成了」是纯噪音。
 * - `always`：始终提醒。多显示器 / 盒子开在副屏时有用 —— 窗口「在前台」，
 *   但用户的眼睛不在那块屏上。
 * - `off`：不提醒。
 */
export type TurnCompleteNotification = 'off' | 'unfocused' | 'always'

/**
 * 应用设置接口
 */
interface AppSettings {
  /** 开机自启 */
  autoLaunch: boolean
  /** 启用智能追加提问建议 */
  enableFollowUpSuggestions: boolean
  /** 应用语言设置 */
  language: 'zh-CN' | 'en-US'
  /** 启动项目时自动启用 UnrealAgentLink 插件 */
  autoEnableUnrealAgentLink: boolean
  /**
   * 首次导入工程时「要不要装连接插件」那一问，问过没有。只问一次，答完不再问。
   *
   * 老用户（升级前就有配置文件）一律算问过：他们一直是自动安装，没必要补问。
   */
  ualinkInstallPromptShown: boolean
  /**
   * 明确拒绝安装 UnrealAgentLink 的项目（规范化后的 .uproject 路径）。
   *
   * 用户在项目上点过「移除 UnrealAgentLink」就进这个名单。没有它的话，
   * 用户手动删掉插件、下次从盒子打开项目又会被装回去 —— 在用户眼里就是
   * 「这东西删不掉」。
   */
  ualinkOptOutProjects: string[]
  /** Agent 浏览器怎么显示。见 `AgentBrowserMode` */
  agentBrowserMode: AgentBrowserMode
  /** agent 能读写哪些位置。见 `AgentFileAccessScope` */
  agentFileAccessScope: AgentFileAccessScope
  /**
   * 工具搜索：只常驻一小撮核心工具，其余由技能带组或 `search_tools` 按需取回。
   * 默认打开，每次启动 Agent 时读取。
   *
   * 2026-10-08 由默认关改为默认开。全量注入已经 230 个工具、约 12 万 token，占一次
   * 请求的大头；真机上 CodeBuddy hy4 带图时过了约 14 万 token 就多半被拒，长一点的
   * 会话光工具就把它顶到线上（见 `agent-v3/core/streamFn.ts` 里 `contextHasImages` 那段）
   */
  agentToolSearchEnabled: boolean
  /**
   * 用户在设置页亲手拨过工具搜索开关没有。
   *
   * 没有它分不清「默认值被顺手写进了文件」和「用户自己关的」：`saveSettings` 每次
   * 存的是整份设置，所以老用户磁盘上那个 `false` 多半只是当年的默认值。没拨过的
   * 跟着新默认走，拨过的听他的
   */
  agentToolSearchUserSet: boolean
  /**
   * 自动断点续传：中转不稳时每 60 秒自动续跑，连续失败满 30 分钟才报错。
   * 默认打开，每次开跑时读取。见 `agent-v3/core/autoResume.ts`。
   */
  agentPersistentAutoResume: boolean
  /**
   * 目标模式（`/goal`）最多迭代几轮。每次开跑时读取，范围见 `shared/goalRounds.ts`。
   */
  agentGoalMaxRounds: number
  /**
   * 全量模式下用户关掉的工具名。默认一个都没关。
   *
   * 记「关掉的」而不是「开着的」：以后每加一个工具，老用户的配置里没有它，
   * 于是它默认开着 —— 反过来存白名单的话，新工具对所有老用户都是静默消失的。
   */
  agentDisabledTools: string[]
  /**
   * 审批卡片上点过「以后都允许」的工具名。默认空。
   *
   * 按工具名记，覆盖的是工具声明的风险；逐次审批的工具和只读对话不受它影响
   * （判定在 `agent-v3/core/approval.ts`）。用户在「偏好设置 → AI」里能看到、能移除。
   */
  agentAlwaysAllowedTools: string[]
  /**
   * 工具搜索模式下，偏离内置常驻清单的那些工具。`true` = 强行常驻，`false` = 改成搜索加载。
   *
   * 同样只存**差量**：内置常驻清单会随实验结论调整（见 `toolSearch.ts` 的
   * `DEFAULT_RESIDENT_NAMES`），存全量的话，用户点过一次开关就永远停在那一版清单上。
   */
  agentResidentTools: Record<string, boolean>
  /** 一轮跑完要不要弹系统通知。见 `TurnCompleteNotification` */
  notifyTurnComplete: TurnCompleteNotification
  /** agent 卡在审批上时，窗口不在前台就弹一条通知 */
  notifyApprovalRequired: boolean
  /** agent 反问用户时，窗口不在前台就弹一条通知 */
  notifyQuestionRequired: boolean
  /**
   * 从盒子里打开工程之后，把主界面收进托盘。
   *
   * 默认关着。收进托盘之后窗口在任务栏里也不见了，不知道有托盘图标的人
   * 会以为盒子自己退出了 —— 这个代价只该由主动去开它的人承担。
   */
  hideWindowOnProjectLaunch: boolean
  /**
   * 编辑器崩溃后自动收拾现场：关掉崩溃报告窗口、备份未保存的自动存档、重新打开工程。
   * 见 `services/editorCrashWatch`。
   */
  autoRecoverEditorCrash: boolean
  /**
   * agent 搜素材时看不看别的保管库。默认关着：只搜当前活跃的那个库。
   *
   * 默认关的理由：搜到别的库的东西，导入、移动、删除照样得先切过去
   * （「读跨库，写不跨库」，见 `agent-v3/tools/adapted/asset/vaultScope.ts`），
   * 结果里混着一堆当下动不了的资产，比只看眼前这个库更让人迷糊。
   */
  assetCrossVaultSearch: boolean
  /**
   * agent 改资产期间，把它锁住的 `.uasset` 设成只读，挡住用户在编辑器里手动保存。
   *
   * 默认关：只读位挡的是**用户自己**的 Ctrl+S —— 用户在编辑器里存不了自己的
   * 改动、弹一个「文件只读」，比偶尔两边写同一个资产更让人困惑。会话之间的
   * 内存锁（`agent-v3/core/assetLock.ts`）不受这个开关影响。
   */
  assetReadonlyLock: boolean
  /**
   * Agent 浏览器能不能打开本机和局域网地址（localhost、192.168.x.x、*.local）。
   *
   * 默认关：浏览器打开的往往是不受信任的网页，网页里的链接和跳转能借 agent
   * 的手去访问路由器后台、本机服务（SSRF）。用户在本机起了开发服务器、
   * 想让 agent 看一眼时再打开。
   */
  agentBrowserAllowLocalNetwork: boolean
}

/**
 * 默认设置值
 */
const DEFAULT_SETTINGS: AppSettings = {
  // 默认关：不问一声就登记开机启动、静默进托盘，用户嫌打扰，安全软件也按可疑处理。
  // 盒子是从项目里开虚幻时才用得上，想常驻的人去设置页打开
  autoLaunch: false,
  enableFollowUpSuggestions: false,
  language: 'zh-CN',
  // 默认关：往用户工程里写插件、改 .uproject，得先问一声。首次导入工程时弹窗问，
  // 用户点了安装才打开（见 `ualinkInstallPromptShown`）
  autoEnableUnrealAgentLink: false,
  ualinkInstallPromptShown: false,
  ualinkOptOutProjects: [],
  // 默认嵌入助手：安全前提「用户看得见 agent 在操作什么」照样成立，
  // 但不会弹一个独立窗口盖在虚幻上面打断用户。默认值不该是把它藏起来的那一档
  agentBrowserMode: 'embedded',
  // 默认整台电脑。收窄档挡下的第一件事往往是「把 D:/素材 导进来」这种完全正当的
  // 需求，而这一层本来就挡不住 shell（见 accessScope.ts），兜底靠的是凭据黑名单
  // 加每步审批 —— 拿它当默认，换来的只是所有人第一次用都撞一次墙
  agentFileAccessScope: 'full',
  agentToolSearchEnabled: true,
  agentToolSearchUserSet: false,
  // 默认开：它只在「这次失败重来可能就好」时才动手，关着的代价是任务半路停下等人点
  agentPersistentAutoResume: true,
  agentGoalMaxRounds: DEFAULT_GOAL_MAX_ROUNDS,
  // 默认全部打开。设置页里那一长串开关，起手状态就该等于「什么都没设置过」
  agentDisabledTools: [],
  agentAlwaysAllowedTools: [],
  agentResidentTools: {},
  // 默认开着，但只在窗口不在前台时响。盒子干的是长活，用户派完就切回虚幻里
  // 接着做自己的事 —— 而审批**超时五分钟按拒绝算**，不提醒的话他回来只看到
  // 一句「这一步被拒绝了」，从头到尾没人问过他
  notifyTurnComplete: 'unfocused',
  notifyApprovalRequired: true,
  notifyQuestionRequired: true,
  // 默认不藏。用户开着盒子的窗口是他自己的决定，一次「打开工程」不该顺手收走它
  hideWindowOnProjectLaunch: false,
  // 默认开着。崩溃报告窗口不点就一直挡着，agent 那一轮活也就停在那儿；
  // 重开之前会把未保存的自动存档备份好，不替用户决定恢复不恢复
  autoRecoverEditorCrash: true,
  assetCrossVaultSearch: false,
  assetReadonlyLock: false,
  agentBrowserAllowLocalNetwork: false
}

/** 只保留字符串项；不是数组就当空名单 */
function sanitizeToolNames(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((name): name is string => typeof name === 'string')
    : []
}

/** 只保留 `工具名 → 布尔` 这种项，其余丢掉 */
function sanitizeResidentTools(value: unknown): Record<string, boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const result: Record<string, boolean> = {}
  for (const [name, resident] of Object.entries(value as Record<string, unknown>)) {
    if (typeof resident === 'boolean') result[name] = resident
  }
  return result
}

/**
 * 应用设置管理器
 * 负责持久化存储用户的应用设置
 */
class AppSettingsManager {
  private configPath: string
  private settings: AppSettings

  constructor() {
    this.configPath = join(app.getPath('userData'), 'app-settings.json')
    this.settings = this.loadSettings()
    // 主进程那几句（托盘菜单与悬停提示、原生对话框标题）跟着这份设置走。
    // 方向是这边推过去的：`i18n.ts` 一个 import 都不能有，理由见那个文件的头。
    setMainLanguage(this.settings.language)
  }

  /**
   * 加载设置
   */
  private loadSettings(): AppSettings {
    try {
      if (existsSync(this.configPath)) {
        const data = readFileSync(this.configPath, 'utf8')
        const savedSettings = JSON.parse(data) as Partial<AppSettings>

        // 只保留当前仍支持的设置项，旧版本遗留字段不会继续透传或写回。
        const mergedSettings = { ...DEFAULT_SETTINGS, ...savedSettings }
        return {
          autoLaunch: mergedSettings.autoLaunch,
          enableFollowUpSuggestions: mergedSettings.enableFollowUpSuggestions,
          language: mergedSettings.language,
          // 老配置里没写这个字段的，按当时的默认（开）算，别让升级悄悄把它关掉
          autoEnableUnrealAgentLink: savedSettings.autoEnableUnrealAgentLink !== false,
          // 有配置文件就是老用户：没写这个字段说明是升级上来的，不再补问
          ualinkInstallPromptShown: savedSettings.ualinkInstallPromptShown !== false,
          ualinkOptOutProjects: mergedSettings.ualinkOptOutProjects,
          agentBrowserMode: mergedSettings.agentBrowserMode,
          agentFileAccessScope: mergedSettings.agentFileAccessScope,
          // 没拨过的跟着新默认走（见 `agentToolSearchUserSet`）。例外：在全量模式下关过工具的
          // 老用户留在全量模式 —— 搜索模式不认那份名单，切过去等于把他关掉的工具又放出来
          agentToolSearchEnabled:
            savedSettings.agentToolSearchUserSet === true
              ? savedSettings.agentToolSearchEnabled === true
              : sanitizeToolNames(mergedSettings.agentDisabledTools).length > 0
                ? savedSettings.agentToolSearchEnabled === true
                : DEFAULT_SETTINGS.agentToolSearchEnabled,
          agentToolSearchUserSet: savedSettings.agentToolSearchUserSet === true,
          // 只有用户明确关掉才算关：旧配置里没有这个字段的，跟着默认走
          agentPersistentAutoResume: mergedSettings.agentPersistentAutoResume !== false,
          // 手改坏的配置（字符串、负数、9999）夹回范围，不让它变成零轮或者跑一整夜
          agentGoalMaxRounds: normalizeGoalMaxRounds(mergedSettings.agentGoalMaxRounds),
          // 配置文件被手改坏（写成对象、混进数字）时退回「什么都没关」。
          // 这两份名单只会让模型少拿到工具，读坏了宁可全给，不能让人对着一个
          // 空空如也的助手查半天
          agentDisabledTools: sanitizeToolNames(mergedSettings.agentDisabledTools),
          agentAlwaysAllowedTools: sanitizeToolNames(mergedSettings.agentAlwaysAllowedTools),
          agentResidentTools: sanitizeResidentTools(mergedSettings.agentResidentTools),
          notifyTurnComplete: mergedSettings.notifyTurnComplete,
          notifyApprovalRequired: mergedSettings.notifyApprovalRequired,
          notifyQuestionRequired: mergedSettings.notifyQuestionRequired,
          hideWindowOnProjectLaunch: mergedSettings.hideWindowOnProjectLaunch,
          autoRecoverEditorCrash: mergedSettings.autoRecoverEditorCrash,
          assetCrossVaultSearch: mergedSettings.assetCrossVaultSearch === true,
          // 这两个都是放宽或改动用户文件的开关，只有明确写着 true 才算开
          assetReadonlyLock: mergedSettings.assetReadonlyLock === true,
          agentBrowserAllowLocalNetwork: mergedSettings.agentBrowserAllowLocalNetwork === true
        }
      }
    } catch (error) {
      logger.warn('加载应用设置失败:', error)
    }

    return { ...DEFAULT_SETTINGS }
  }

  /**
   * 保存设置
   */
  saveSettings(settings: Partial<AppSettings>): void {
    try {
      this.settings = { ...this.settings, ...settings }
      writeFileSync(this.configPath, JSON.stringify(this.settings, null, 2))
      logger.info('应用设置已保存:', this.settings)
    } catch (error) {
      logger.error('保存应用设置失败:', error)
    }
  }

  /**
   * 获取当前设置
   */
  getSettings(): AppSettings {
    return { ...this.settings }
  }

  /** 先落盘再更新内存，保存失败时让设置页显示错误并保留原值。 */
  setAgentToolSearchEnabled(enabled: boolean): void {
    const next = { ...this.settings, agentToolSearchEnabled: enabled, agentToolSearchUserSet: true }
    writeFileSync(this.configPath, JSON.stringify(next, null, 2))
    this.settings = next
  }

  /** 同上：先落盘再更新内存 */
  setAssetCrossVaultSearch(enabled: boolean): void {
    const next = { ...this.settings, assetCrossVaultSearch: enabled }
    writeFileSync(this.configPath, JSON.stringify(next, null, 2))
    this.settings = next
  }

  /** 同上：先落盘再更新内存 */
  setAssetReadonlyLock(enabled: boolean): void {
    const next = { ...this.settings, assetReadonlyLock: enabled }
    writeFileSync(this.configPath, JSON.stringify(next, null, 2))
    this.settings = next
  }

  /** 锁住的资产要不要设只读位。只认 true（见字段注释） */
  getAssetReadonlyLock(): boolean {
    return this.settings.assetReadonlyLock === true
  }

  /** 同上：先落盘再更新内存 */
  setAgentBrowserAllowLocalNetwork(enabled: boolean): void {
    const next = { ...this.settings, agentBrowserAllowLocalNetwork: enabled }
    writeFileSync(this.configPath, JSON.stringify(next, null, 2))
    this.settings = next
  }

  /** Agent 浏览器能不能访问本机和局域网地址。只认 true（见字段注释） */
  getAgentBrowserAllowLocalNetwork(): boolean {
    return this.settings.agentBrowserAllowLocalNetwork === true
  }

  /** 同上：先落盘再更新内存 */
  setAgentPersistentAutoResume(enabled: boolean): void {
    const next = { ...this.settings, agentPersistentAutoResume: enabled }
    writeFileSync(this.configPath, JSON.stringify(next, null, 2))
    this.settings = next
  }

  /** 同上：先落盘再更新内存。越界的值夹回范围再存 */
  setAgentGoalMaxRounds(rounds: number): void {
    const next = { ...this.settings, agentGoalMaxRounds: normalizeGoalMaxRounds(rounds) }
    writeFileSync(this.configPath, JSON.stringify(next, null, 2))
    this.settings = next
  }

  /**
   * 全量模式下关掉的那些工具。同样先落盘 —— 用户看到开关弹回去，
   * 好过看到它停在新位置而下一轮那个工具照常出现。
   */
  setAgentDisabledTools(names: string[]): void {
    const next = { ...this.settings, agentDisabledTools: sanitizeToolNames(names) }
    writeFileSync(this.configPath, JSON.stringify(next, null, 2))
    this.settings = next
  }

  /** 「以后都允许」的名单整份替换（设置页移除一项时用）。先落盘再更新内存 */
  setAgentAlwaysAllowedTools(names: string[]): void {
    const next = {
      ...this.settings,
      agentAlwaysAllowedTools: [...new Set(sanitizeToolNames(names))]
    }
    writeFileSync(this.configPath, JSON.stringify(next, null, 2))
    this.settings = next
  }

  /** 审批卡片上点了「以后都允许」。已在名单里就不重写文件 */
  addAgentAlwaysAllowedTool(name: string): void {
    const current = this.getAgentAlwaysAllowedTools()
    if (current.includes(name)) return
    this.setAgentAlwaysAllowedTools([...current, name])
  }

  getAgentAlwaysAllowedTools(): string[] {
    return this.settings.agentAlwaysAllowedTools ?? []
  }

  /** 工具搜索模式下偏离内置常驻清单的那些 */
  setAgentResidentTools(overrides: Record<string, boolean>): void {
    const next = { ...this.settings, agentResidentTools: sanitizeResidentTools(overrides) }
    writeFileSync(this.configPath, JSON.stringify(next, null, 2))
    this.settings = next
  }

  /**
   * 设置开机自启
   * 使用 Electron 的 setLoginItemSettings API
   */
  private applyAutoLaunchSetting(enabled: boolean, persist: boolean): boolean {
    try {
      // Windows 下使用 args 参数添加 --hidden 标志
      // 因为 Electron 的 wasOpenedAtLogin 只在 macOS 下可靠
      // 注意：在 Windows 上，需要同时指定 path 和 args 才能正确设置带参数的启动命令
      const args = enabled ? [START_HIDDEN_ARG] : []

      if (process.platform === 'win32') {
        // Windows: 需要显式指定 path 才能让 args 生效
        app.setLoginItemSettings({
          openAtLogin: enabled,
          path: process.execPath,
          args
        })
      } else {
        // macOS/Linux
        app.setLoginItemSettings({
          openAtLogin: enabled,
          args
        })
      }

      if (persist) {
        this.saveSettings({ autoLaunch: enabled })
      }
      logger.info(
        `开机自启已${enabled ? '启用' : '禁用'}，启动参数: ${args.join(' ')}, 路径: ${process.execPath}`
      )
      return true
    } catch (error) {
      logger.error('设置开机自启失败:', error)
      return false
    }
  }

  setAutoLaunch(enabled: boolean): boolean {
    return this.applyAutoLaunchSetting(enabled, true)
  }

  /**
   * 启动时对一次开机自启：系统里的状态就是真相，只把它读回设置文件，**不往回写**。
   *
   * 以前每次启动都重写一遍：Windows 上这一写会顺手删掉任务管理器 / 360 记的
   * 「已禁用」（StartupApproved），用户关一次、下次开机又回来 —— 关不掉，
   * 而「自己把被禁的启动项改回来」正是安全软件按病毒处理的那种行为。
   */
  ensureAutoLaunchSetting(): boolean {
    const actual = this.getAutoLaunchStatus()
    if (actual !== this.settings.autoLaunch) {
      this.saveSettings({ autoLaunch: actual })
    }
    return true
  }

  /**
   * 获取开机自启状态
   * 从系统获取实际状态
   */
  getAutoLaunchStatus(): boolean {
    try {
      if (process.platform === 'win32') {
        // 登记时带了 --hidden，查的时候不带，openAtLogin 永远是 false（设置页一直显示「关」）。
        // executableWillLaunchAtLogin 不比参数，并且认任务管理器 / 360 里的「已禁用」
        return app.getLoginItemSettings({ path: process.execPath, args: [START_HIDDEN_ARG] })
          .executableWillLaunchAtLogin
      }
      return app.getLoginItemSettings().openAtLogin
    } catch (error) {
      logger.error('获取开机自启状态失败:', error)
      return this.settings.autoLaunch
    }
  }

  /**
   * 设置启用智能追加提问建议
   */
  setEnableFollowUpSuggestions(enabled: boolean): void {
    this.saveSettings({ enableFollowUpSuggestions: enabled })
    logger.info(`智能追加提问建议已${enabled ? '启用' : '禁用'}`)
  }

  /**
   * 获取启用智能追加提问建议设置
   */
  getEnableFollowUpSuggestions(): boolean {
    return this.settings.enableFollowUpSuggestions
  }

  /**
   * 设置 Agent 浏览器的显示方式。
   *
   * 改了要通知服务把当前窗口收掉 —— 否则用户切到「嵌入」之后，
   * 眼前还杵着一个独立窗口，而设置页显示的是另一回事。
   */
  setAgentBrowserMode(mode: AgentBrowserMode): void {
    this.saveSettings({ agentBrowserMode: mode })
    logger.info(`Agent 浏览器显示方式已设置为: ${mode}`)
  }

  /** 获取 Agent 浏览器的显示方式 */
  getAgentBrowserMode(): AgentBrowserMode {
    return this.settings.agentBrowserMode ?? 'embedded'
  }

  /** 设置 agent 的文件访问范围 */
  setAgentFileAccessScope(scope: AgentFileAccessScope): void {
    this.saveSettings({ agentFileAccessScope: scope })
    logger.info(`Agent 文件访问范围已设置为: ${scope}`)
  }

  /**
   * 获取 agent 的文件访问范围。
   *
   * 只认 `ue-only` 这一个字面量，其余一律当默认档（`full`）。收窄是用户
   * **主动选出来**的一档，所以只有明确写着 `ue-only` 才收 —— 字段缺失、
   * 配置文件损坏、写进去一个不认识的值，都当没选过。
   *
   * 注意这和界面的兜底必须一字不差地一致（见 `ProfileAI.vue`），否则会出现
   * 最糟的错位：界面高亮着一档，实际生效的是另一档。
   */
  getAgentFileAccessScope(): AgentFileAccessScope {
    return this.settings.agentFileAccessScope === 'ue-only' ? 'ue-only' : 'full'
  }

  /** 设置「一轮跑完弹不弹通知」 */
  setNotifyTurnComplete(mode: TurnCompleteNotification): void {
    this.saveSettings({ notifyTurnComplete: mode })
    logger.info(`轮次完成通知已设置为: ${mode}`)
  }

  /**
   * 读「一轮跑完弹不弹通知」。
   *
   * 只认三个字面量，其余（配置文件损坏、旧版本没这个字段）一律回默认档。
   * 这里兜底成 `unfocused` 而不是 `off`：读不出来时宁可多响一声，
   * 也好过用户以为自己开着、结果一条通知都没等到。
   */
  getNotifyTurnComplete(): TurnCompleteNotification {
    const value = this.settings.notifyTurnComplete
    return value === 'off' || value === 'always' ? value : 'unfocused'
  }

  /** 设置「需要审批时提醒」 */
  setNotifyApprovalRequired(enabled: boolean): void {
    this.saveSettings({ notifyApprovalRequired: enabled })
    logger.info(`权限通知已${enabled ? '启用' : '禁用'}`)
  }

  /** 读「需要审批时提醒」。缺值按开着算，理由同 `getNotifyTurnComplete` */
  getNotifyApprovalRequired(): boolean {
    return this.settings.notifyApprovalRequired !== false
  }

  /** 设置「需要回答时提醒」 */
  setNotifyQuestionRequired(enabled: boolean): void {
    this.saveSettings({ notifyQuestionRequired: enabled })
    logger.info(`问题通知已${enabled ? '启用' : '禁用'}`)
  }

  /** 读「需要回答时提醒」。缺值按开着算 */
  getNotifyQuestionRequired(): boolean {
    return this.settings.notifyQuestionRequired !== false
  }

  /** 设置「打开工程后隐藏主界面」 */
  setHideWindowOnProjectLaunch(enabled: boolean): void {
    this.saveSettings({ hideWindowOnProjectLaunch: enabled })
    logger.info(`打开工程后隐藏主界面已${enabled ? '启用' : '禁用'}`)
  }

  /**
   * 读「打开工程后隐藏主界面」。
   *
   * 只认 `true`。缺值（旧配置文件、文件损坏）一律按关着算 —— 界面还在，
   * 用户至多多点一下最小化；反过来兜底成开，他会突然找不到盒子的窗口。
   */
  getHideWindowOnProjectLaunch(): boolean {
    return this.settings.hideWindowOnProjectLaunch === true
  }

  /** 设置「编辑器崩溃后自动重开」 */
  setAutoRecoverEditorCrash(enabled: boolean): void {
    this.saveSettings({ autoRecoverEditorCrash: enabled })
    logger.info(`编辑器崩溃后自动重开已${enabled ? '启用' : '禁用'}`)
  }

  /** 读「编辑器崩溃后自动重开」。缺值按开着算 */
  getAutoRecoverEditorCrash(): boolean {
    return this.settings.autoRecoverEditorCrash !== false
  }

  /**
   * 设置应用语言
   */
  setLanguage(language: 'zh-CN' | 'en-US'): void {
    this.saveSettings({ language })
    // 托盘菜单与悬停提示要当场重建，而不是等下次启动才变成新语言
    setMainLanguage(language)
    logger.info(`应用语言已设置为: ${language}`)
  }

  /**
   * 获取应用语言设置
   */
  getLanguage(): 'zh-CN' | 'en-US' {
    return this.settings.language
  }

  /**
   * 设置启动项目时自动启用 UnrealAgentLink 插件
   */
  setAutoEnableUnrealAgentLink(enabled: boolean): void {
    this.saveSettings({ autoEnableUnrealAgentLink: enabled })
    logger.info(`启动项目自动启用 UnrealAgentLink 插件已${enabled ? '启用' : '禁用'}`)
  }

  /**
   * 获取启动项目时自动启用 UnrealAgentLink 插件设置
   */
  getAutoEnableUnrealAgentLink(): boolean {
    return this.settings.autoEnableUnrealAgentLink
  }

  /** 首次导入时的安装询问是否已经问过 */
  getUALinkInstallPromptShown(): boolean {
    return this.settings.ualinkInstallPromptShown
  }

  setUALinkInstallPromptShown(shown: boolean): void {
    this.saveSettings({ ualinkInstallPromptShown: shown })
  }

  /**
   * 这个项目是否明确拒绝过 UnrealAgentLink
   */
  isUALinkOptedOut(uprojectPath: string): boolean {
    if (!uprojectPath) return false
    const target = projectComparisonKey(uprojectPath)
    return (this.settings.ualinkOptOutProjects || []).some(
      (item) => projectComparisonKey(item) === target
    )
  }

  /**
   * 记住/撤销「这个项目不要装 UnrealAgentLink」
   *
   * @param uprojectPath .uproject 绝对路径
   * @param optOut true = 不再自动安装；false = 恢复自动安装
   */
  setUALinkOptOut(uprojectPath: string, optOut: boolean): void {
    if (!uprojectPath) return
    const target = projectComparisonKey(uprojectPath)
    const current = this.settings.ualinkOptOutProjects || []
    const without = current.filter((item) => projectComparisonKey(item) !== target)

    // 已经是想要的状态就不写盘，省得每次打开项目都刷一遍配置文件
    if (optOut && without.length === current.length) {
      this.saveSettings({ ualinkOptOutProjects: [...without, uprojectPath] })
    } else if (!optOut && without.length !== current.length) {
      this.saveSettings({ ualinkOptOutProjects: without })
    }

    logger.info(`UnrealAgentLink ${optOut ? '已加入' : '已移出'}项目黑名单: ${uprojectPath}`)
  }
}

export const appSettingsManager = new AppSettingsManager()
