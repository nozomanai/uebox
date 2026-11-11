import { MINI_CHAT_SETTINGS_ENABLED } from '../../../../shared/miniChatPreferences'
import {
  DEFAULT_REALTIME_ECHO_GUARD,
  normalizeRealtimeEchoGuard,
  type RealtimeEchoGuard
} from '../../../../shared/realtimeEchoGuard'
import {
  DEFAULT_SPEECH_BRIEFING_STYLE,
  normalizeSpeechBriefingStyle,
  type SpeechBriefingStyle
} from '../../../../shared/speechBriefing'
import { defineStore } from 'pinia'
import { ref, computed, watch } from 'vue'
import type { SendShortcut } from '../../views/Assistant/composables/sendShortcut'
import type { ChatPermissionMode } from './chatSessions'
import { StorageUtils } from '../../common/utils/storage'

/**
 * AI模型提供商类型
 */
export type AIProvider = 'openai' | 'gemini' | 'xai' | 'claude'
export type CustomProviderMode = 'openai-compatible' | 'anthropic-native'

/**
 * agent 跑着的时候，用户按回车发出去的那句话怎么处置。
 *
 * - `queue`：**默认**。攒着，等这一轮真的结束再作为新一轮发出去。
 *   用户想说的多半是「等你干完这个，顺便再做那个」，而不是「停下改做别的」。
 * - `steer`：插话。当场注入这一轮，模型立刻改方向。
 *
 * 按住 Ctrl 回车对**这一条**反着来，见 `resolveFollowUpAction`。
 */
export type AgentFollowUpBehavior = 'queue' | 'steer'

/**
 * 每个提供商的默认对话模型
 *
 *
 *
 */
export const DEFAULT_CHAT_MODELS: Record<AIProvider, string> = {
  openai: 'gpt-5.2',
  gemini: 'gemini-3-pro-preview', //输入 0.026642    输出0.121128
  claude: 'claude-opus-4-5',
  xai: 'grok-4-1-fast-reasoning'
}

/**
 * 检查模型是否属于指定的提供商
 */
function isModelForProvider(model: string, provider: AIProvider): boolean {
  const modelLower = model.toLowerCase()
  switch (provider) {
    case 'openai':
      return modelLower.startsWith('gpt-') || modelLower.includes('openai')
    case 'gemini':
      return modelLower.startsWith('gemini-') || modelLower.includes('gemini')
    case 'xai':
      return (
        modelLower.startsWith('grok-') || modelLower.includes('xai') || modelLower.includes('grok')
      )
    case 'claude':
      return modelLower.startsWith('claude-') || modelLower.includes('anthropic')
    default:
      return false
  }
}

export interface CustomProviderProfile {
  baseUrl?: string
  apiKey?: string
  model?: string
}

export interface CustomProviderProfiles {
  'openai-compatible'?: CustomProviderProfile
  'anthropic-native'?: CustomProviderProfile
}

/**
 * 自定义 Provider BYOK 配置（本地存储）
 */
export interface CustomProviderByokConfig {
  enabled: boolean
  mode?: CustomProviderMode
  profiles?: CustomProviderProfiles
  baseUrl?: string
  apiKey?: string
  model?: string
}

export type OpenAICompatibleByokConfig = CustomProviderByokConfig

function getCustomProviderProfile(
  value: CustomProviderByokConfig | undefined,
  mode: CustomProviderMode
): CustomProviderProfile {
  const hasProfiles = !!value?.profiles && Object.keys(value.profiles).length > 0
  const profile = value?.profiles?.[mode]
  if (profile && (profile.baseUrl || profile.apiKey || profile.model)) {
    return profile
  }

  // 仅对旧结构做迁移兜底：一旦已经存在 profiles，就不再回退到顶层字段，
  // 否则切换协议时会被旧的顶层值“粘住”。
  if (
    !hasProfiles &&
    (value?.baseUrl || value?.apiKey || value?.model) &&
    (value?.mode || 'openai-compatible') === mode
  ) {
    return {
      baseUrl: value.baseUrl,
      apiKey: value.apiKey,
      model: value.model
    }
  }

  return {}
}

function buildCustomProviderState(
  value: CustomProviderByokConfig | undefined,
  modeOverride?: CustomProviderMode
): CustomProviderByokConfig {
  const mode = modeOverride || value?.mode || 'openai-compatible'
  const profile = getCustomProviderProfile(value, mode)

  return {
    enabled: value?.enabled ?? false,
    mode,
    profiles: value?.profiles || {},
    baseUrl: profile.baseUrl || '',
    apiKey: profile.apiKey || '',
    model: profile.model || ''
  }
}

/**
 * AI配置状态
 */
export interface AIConfigState {
  // 普通对话模式配置
  normalProvider: AIProvider
  normalChatModel?: string

  // Agent 模式配置
  agentProvider: AIProvider
  agentChatModel?: string

  // 图像模型（共用）
  imageModel?: string

  /**
   * 上一次在输入框里选的权限档位。**新对话从这一档起步。**
   *
   * 它不是「全局档位」——真正生效的那一份存在对话上
   * （`chatSessions.permissionModeById`）。这里只记「用户最近一次的选择」，
   * 好让新开的对话接着上次的习惯走，而不是每次都退回出厂档。
   */
  agentPermissionMode?: ChatPermissionMode

  /**
   * 思考程度。缺省是 `auto`（不指定，随模型自己的默认）。
   *
   * 存的是用户的选择本身，不做推导 —— 与审批策略不同，这里没有需要兼容的
   * 老字段，缺省就是「没选过」。
   */
  agentThinkingLevel?: AgentV3ThinkingLevel

  /**
   * 「快速」开关（Codex 订阅的 priority 档，额度按倍数扣）。缺省关。
   * 只有支持的模型才在菜单里露出来，别的模型带上也被主进程忽略。
   */
  agentFastMode?: boolean

  /**
   * Cursor 订阅的 Context 档。缺省 500k —— 与 Cursor 客户端 Grok 默认一致。
   * `auto` 保留兼容：不发 context 参数，完全随服务端默认。
   */
  agentCursorContext?: 'auto' | '256k' | '500k'

  /**
   * 技能沉淀档位。缺省是 `ask` —— 想沉淀时先问用户。
   *
   * 和思考程度一样存用户的选择本身，不做推导：没选过就是默认那档。
   */
  skillLearningMode?: AgentV3SkillLearning

  /**
   * agent 跑着的时候按回车，是排队还是插话。缺省 `queue`。
   *
   * 存在这里而不是主进程的应用设置里：判定全发生在渲染层（输入框决定这次回车
   * 走哪条路），主进程读不到也用不上。
   */
  followUpBehavior?: AgentFollowUpBehavior

  /**
   * 哪个键算「发出去」。缺省 `enter`（回车发送，Shift+回车换行）。
   *
   * 判定在输入框那一层，形状定义在 `composables/sendShortcut.ts`。
   */
  sendShortcut?: SendShortcut

  // 编辑器截图权限开关（默认开启）
  editorScreenshotEnabled?: boolean

  // MiniChat 持久对话开关（默认关闭）
  miniChatPersistEnabled?: boolean

  // MiniChat 窗口透明度（0.4 - 1.0，默认 1.0）
  miniChatOpacity?: number

  // 智能追加提问开关（默认开启）
  followUpSuggestionsEnabled?: boolean

  // 每轮结束后自动重起标题（默认关闭：它每轮都要花一次轻量模型调用）
  autoRetitleEnabled?: boolean

  // 语音任务进度反馈（默认开启）
  voiceAntiSilenceEnabled?: boolean
  // 无人回应时自动结束；缺失时兼容旧反馈开关的选择
  voiceMicrophoneDeviceId?: string
  voiceAutoPlayEnabled?: boolean
  voiceAutoHangupEnabled?: boolean
  // 回声门限档位（默认「外放」）。含义见 shared/realtimeEchoGuard.ts
  voiceEchoGuard?: RealtimeEchoGuard
  // 播报风格（默认「完整」）。含义见 shared/speechBriefing.ts
  voiceBriefingStyle?: SpeechBriefingStyle

  // 自定义 Provider BYOK（自带 Key，本地存储）
  openAICompatibleByok?: CustomProviderByokConfig

  // 向后兼容字段（已废弃，用于迁移）
  provider?: AIProvider
  chatModel?: string
}

/**
 * 给两个提供商字段补默认值，返回有没有真的改过。
 *
 * 这里原来还顺手写一堆 V2 Router 时代的字段（routingPolicy、skillModeEnabled、
 * productModeSchemaVersion），外加一套「产品三档模式」的推导。V3 是扁平单 agent，
 * 那些值一个都没人读了，连同推导一起删掉 —— 对话是 Agent 还是 Chat，
 * 现在只由 `lastAskMode` 一个布尔决定。
 *
 * 参数收 `Partial` 而不是 `AIConfigState`：这两个字段在类型上是必填的，但配置是从
 * localStorage 反序列化回来的 —— 早期版本存下的那份就是没有它们，这个函数存在的
 * 全部意义就是接住那种情况。
 */
export function normalizeAIConfig(config: Partial<AIConfigState>): boolean {
  let changed = false

  if (!config.normalProvider) {
    config.normalProvider = 'gemini'
    changed = true
  }

  if (!config.agentProvider) {
    config.agentProvider = 'openai'
    changed = true
  }

  return changed
}

/**
 * AI配置Store
 */
export const useAIConfigStore = defineStore(
  'aiConfig',
  () => {
    const config = ref<AIConfigState>({
      normalProvider: 'openai',
      agentProvider: 'openai'
    })

    /**
     * 当前提供商（向后兼容，返回普通模式的提供商）
     * @deprecated 请使用 currentNormalProvider 或 currentAgentProvider
     */
    const currentProvider = computed(() => config.value.normalProvider)

    /**
     * 当前普通对话模式的提供商
     */
    const currentNormalProvider = computed(() => {
      // 向后兼容：如果没有新字段，尝试从旧字段读取
      if (!config.value.normalProvider && config.value.provider) {
        return config.value.provider
      }
      // 返回新字段或默认值
      return config.value.normalProvider || 'gemini'
    })

    /**
     * 当前 Agent 模式的提供商
     */
    const currentAgentProvider = computed(() => {
      // 向后兼容：如果没有新字段，尝试从旧字段读取
      if (!config.value.agentProvider && config.value.provider) {
        return config.value.provider
      }
      // 返回新字段或默认值
      return config.value.agentProvider || 'openai'
    })

    /**
     * 当前对话模型（向后兼容，返回普通模式的模型）
     * @deprecated 请使用 currentNormalChatModel 或 currentAgentChatModel
     */
    const currentChatModel = computed(() => {
      const provider = config.value.normalProvider
      const savedModel = config.value.normalChatModel

      // 如果保存的模型存在，检查它是否属于当前 provider
      if (savedModel && !isModelForProvider(savedModel, provider)) {
        // 模型不匹配，清除它并使用默认模型
        config.value.normalChatModel = undefined
        return DEFAULT_CHAT_MODELS[provider]
      }

      return savedModel || DEFAULT_CHAT_MODELS[provider]
    })

    /**
     * 当前普通对话模式的模型
     */
    const currentNormalChatModel = computed(() => {
      // 向后兼容：如果没有新字段，尝试从旧字段读取
      const model = config.value.normalChatModel || config.value.chatModel
      const provider = currentNormalProvider.value

      // 如果保存的模型存在，检查它是否属于当前 provider
      if (model && !isModelForProvider(model, provider)) {
        // 模型不匹配，清除它并使用默认模型
        if (config.value.normalChatModel) {
          config.value.normalChatModel = undefined
        }
        if (config.value.chatModel) {
          config.value.chatModel = undefined
        }
        return DEFAULT_CHAT_MODELS[provider]
      }

      return model || DEFAULT_CHAT_MODELS[provider]
    })

    /**
     * 当前 Agent 模式的模型
     */
    const currentAgentChatModel = computed(() => {
      // 向后兼容：如果没有新字段，尝试从旧字段读取
      const model = config.value.agentChatModel || config.value.chatModel
      return model || DEFAULT_CHAT_MODELS[currentAgentProvider.value]
    })

    /**
     * 当前图像模型
     */
    const currentImageModel = computed(() => config.value.imageModel)

    /**
     * 当前自定义 Provider BYOK 配置
     */
    const currentCustomProviderByok = computed<CustomProviderByokConfig>(() =>
      buildCustomProviderState(config.value.openAICompatibleByok)
    )

    const currentOpenAICompatibleByok = currentCustomProviderByok

    /**
     * 设置提供商（向后兼容，同时设置普通模式和 Agent 模式）
     * @deprecated 请使用 setNormalProvider 或 setAgentProvider
     */
    function setProvider(provider: AIProvider): void {
      config.value.normalProvider = provider
      config.value.agentProvider = provider
      config.value.normalChatModel = undefined
      config.value.agentChatModel = undefined
      config.value.imageModel = undefined
    }

    /**
     * 设置普通对话模式的提供商
     */
    function setNormalProvider(provider: AIProvider): void {
      config.value.normalProvider = provider
      config.value.normalChatModel = undefined
      config.value.imageModel = undefined
    }

    /**
     * 设置 Agent 模式的提供商
     */
    function setAgentProvider(provider: AIProvider): void {
      config.value.agentProvider = provider
      config.value.agentChatModel = undefined
    }

    /**
     * 设置对话模型（向后兼容，设置普通模式的模型）
     * @deprecated 请使用 setNormalChatModel 或 setAgentChatModel
     */
    function setChatModel(model: string): void {
      config.value.normalChatModel = model
    }

    /**
     * 设置普通对话模式的模型
     */
    function setNormalChatModel(model: string): void {
      config.value.normalChatModel = model
    }

    /**
     * 设置 Agent 模式的模型
     */
    function setAgentChatModel(model: string): void {
      config.value.agentChatModel = model
    }

    /**
     * 设置图像模型
     */
    function setImageModel(model: string): void {
      config.value.imageModel = model
    }

    // Chat/Agent 与 Ask 这两个偏好没有了：那个下拉框整个删了，助手永远是 Agent。
    // 留着的话只是两个没人写、却还会被读到的旧值 —— 存量用户磁盘上那个 false
    // 会把他钉在已经删掉的老链路上。

    /**
     * 新对话从哪一档起步 —— 就是用户上一次选的那一档。
     *
     * 设置页那个「敏感操作确认」开关已经删了：权限现在是每条对话自己的事，
     * 在输入框里那个四档下拉上选，一个全局布尔开关既表达不了四档，
     * 也说不清它管的到底是哪条对话。
     *
     * 默认 `auto-edit`：全都问的话每一步写操作都要点一次，实际用不了；
     * 全放行又太危险。可撤销的自动放行、不可逆的仍然问，是唯一能默认开着的档。
     */
    const agentPermissionMode = computed<ChatPermissionMode>(
      () => config.value.agentPermissionMode ?? 'auto-edit'
    )

    function setAgentPermissionMode(mode: ChatPermissionMode): void {
      config.value.agentPermissionMode = mode
    }

    /**
     * Agent 思考程度。
     *
     * 四档对应内核的 thinking level：
     * - `auto`   不指定，随模型自己的默认（默认值）
     * - `low`    想一下就答，最快
     * - `medium` 标准
     * - `high`   复杂任务，慢也贵
     *
     * 默认取 `auto` 而不是某个具体档位：加上这个开关不该悄悄改掉所有人
     * 原来的行为，用户主动选了才生效。
     */
    const agentThinkingLevel = computed<AgentV3ThinkingLevel>(
      () => config.value.agentThinkingLevel ?? 'auto'
    )

    function setAgentThinkingLevel(level: AgentV3ThinkingLevel): void {
      config.value.agentThinkingLevel = level
    }

    const agentFastMode = computed(() => config.value.agentFastMode ?? false)

    function setAgentFastMode(on: boolean): void {
      config.value.agentFastMode = on
    }

    type AgentCursorContext = NonNullable<AIConfigState['agentCursorContext']>

    const agentCursorContext = computed<AgentCursorContext>(
      () => config.value.agentCursorContext ?? '500k'
    )

    function setAgentCursorContext(tier: AgentCursorContext): void {
      config.value.agentCursorContext = tier
    }

    /**
     * 技能沉淀档位（默认 `ask`：想沉淀时先问）。
     *
     * 默认不取 `auto`，理由和思考程度那条一样 —— 加一个开关不该在用户还没
     * 点过它之前就改掉行为，何况这一档会往用户盘上写文件。
     */
    const skillLearningMode = computed<AgentV3SkillLearning>(
      () => config.value.skillLearningMode ?? 'ask'
    )

    function setSkillLearningMode(mode: AgentV3SkillLearning): void {
      config.value.skillLearningMode = mode
    }

    /**
     * 运行中按回车是排队还是插话（默认 `queue`）。
     *
     * 默认取排队而不是沿用老行为（插话）：用户在长任务中途打的字，绝大多数是
     * 「等你干完顺便再做这个」。按插话处理会让模型把手里那件事丢下 —— 而它
     * 已经跑了几分钟。想改方向的人还有那颗「插话」按钮，一眼看得见。
     */
    const followUpBehavior = computed<AgentFollowUpBehavior>(
      () => config.value.followUpBehavior ?? 'queue'
    )

    function setFollowUpBehavior(behavior: AgentFollowUpBehavior): void {
      config.value.followUpBehavior = behavior
    }

    /**
     * 哪个键算发送（默认回车）。
     *
     * 默认不取 `ctrl-enter`：绝大多数人写的是一行话，让他们每次多按一个键
     * 换来的是「这软件怎么发不出去」。要写长提示词的人自己去设置里换。
     */
    const sendShortcut = computed<SendShortcut>(() => config.value.sendShortcut ?? 'enter')

    function setSendShortcut(shortcut: SendShortcut): void {
      config.value.sendShortcut = shortcut
    }

    /**
     * 编辑器截图权限是否启用（默认开启）。
     *
     * 这个 `?? true` 是三处兜底之一，另外两处是主进程的
     * `agent-v3/core/editorScreenshotScope.ts` 的 `EDITOR_SCREENSHOT_DEFAULT`
     * 和执行记录的 zod 校验。**改一处就要三处一起改** —— 不一致的话，
     * 同一个用户在「发消息」和「从断点继续」两条路上会得到两种行为，
     * 而他一个开关都没动过。
     */
    const editorScreenshotEnabled = computed(() => config.value.editorScreenshotEnabled ?? true)

    /**
     * 设置编辑器截图权限开关
     */
    function setEditorScreenshotEnabled(enabled: boolean): void {
      config.value.editorScreenshotEnabled = enabled
    }

    /**
     * MiniChat 持久对话是否启用（默认关闭）
     */
    const miniChatPersistEnabled = computed(() =>
      MINI_CHAT_SETTINGS_ENABLED ? (config.value.miniChatPersistEnabled ?? false) : true
    )

    /**
     * 设置 MiniChat 持久对话开关
     */
    function setMiniChatPersistEnabled(enabled: boolean): void {
      config.value.miniChatPersistEnabled = enabled
    }

    /**
     * 长任务无反馈满一分钟时汇报进度；空闲自动结束由独立偏好控制。
     */
    const voiceAntiSilenceEnabled = computed(() => config.value.voiceAntiSilenceEnabled ?? true)

    function setVoiceAntiSilenceEnabled(enabled: boolean): void {
      // 旧配置两项共用一个开关，首次修改反馈时先保留原来的自动结束选择。
      if (config.value.voiceAutoHangupEnabled === undefined) {
        config.value.voiceAutoHangupEnabled = voiceAntiSilenceEnabled.value
      }
      config.value.voiceAntiSilenceEnabled = enabled
    }

    const voiceMicrophoneDeviceId = computed(() => config.value.voiceMicrophoneDeviceId ?? '')
    const voiceAutoPlayEnabled = computed(() => config.value.voiceAutoPlayEnabled ?? false)
    function setVoiceAutoPlayEnabled(enabled: boolean): void {
      config.value.voiceAutoPlayEnabled = enabled
    }
    function setVoiceMicrophoneDeviceId(deviceId: string): void {
      config.value.voiceMicrophoneDeviceId = deviceId
    }

    const voiceAutoHangupEnabled = computed(
      () => config.value.voiceAutoHangupEnabled ?? voiceAntiSilenceEnabled.value
    )

    function setVoiceAutoHangupEnabled(enabled: boolean): void {
      config.value.voiceAutoHangupEnabled = enabled
    }

    /**
     * 回声门限档位。旧配置里没有这个字段，一律按默认档（外放）读 ——
     * 那也正是这一项要修的那个场景。
     */
    const voiceEchoGuard = computed(() => normalizeRealtimeEchoGuard(config.value.voiceEchoGuard))

    function setVoiceEchoGuard(guard: RealtimeEchoGuard): void {
      config.value.voiceEchoGuard = normalizeRealtimeEchoGuard(guard)
    }

    /**
     * 播报风格。旧配置没这个字段，一律按「原文照念」读 —— 不改老用户听到的东西。
     */
    const voiceBriefingStyle = computed(() =>
      normalizeSpeechBriefingStyle(config.value.voiceBriefingStyle)
    )

    function setVoiceBriefingStyle(style: SpeechBriefingStyle): void {
      config.value.voiceBriefingStyle = normalizeSpeechBriefingStyle(style)
    }

    /**
     * MiniChat 窗口透明度（默认 1.0）
     */
    const miniChatOpacity = computed(() => {
      if (!MINI_CHAT_SETTINGS_ENABLED) return 1
      const raw = config.value.miniChatOpacity
      if (typeof raw !== 'number' || Number.isNaN(raw)) {
        return 1
      }
      return Math.min(1, Math.max(0.4, raw))
    })

    /**
     * 设置 MiniChat 窗口透明度
     */
    function setMiniChatOpacity(opacity: number): void {
      const normalized = Math.min(1, Math.max(0.4, opacity))
      config.value.miniChatOpacity = Math.round(normalized * 100) / 100
    }

    /**
     * 智能追加提问是否启用（默认开启）
     */
    const followUpSuggestionsEnabled = computed(
      () => config.value.followUpSuggestionsEnabled ?? true
    )

    /**
     * 设置智能追加提问开关
     */
    function setFollowUpSuggestionsEnabled(enabled: boolean): void {
      config.value.followUpSuggestionsEnabled = enabled
    }

    /**
     * 每轮结束后自动重起标题（默认关闭）。
     *
     * 默认关是因为它有成本：每轮都多一次轻量模型调用，而且侧边栏那一行会跟着
     * 每轮改名 —— 有人靠标题认对话，名字自己变来变去反而找不着。想要的人自己开。
     */
    const autoRetitleEnabled = computed(() => config.value.autoRetitleEnabled ?? false)

    /** 设置自动重起标题开关 */
    function setAutoRetitleEnabled(enabled: boolean): void {
      config.value.autoRetitleEnabled = enabled
    }

    /**
     * 设置自定义 Provider BYOK 配置
     */
    function setCustomProviderByokConfig(byokConfig: Partial<CustomProviderByokConfig>): void {
      const previous = buildCustomProviderState(config.value.openAICompatibleByok)
      const nextMode = byokConfig.mode || previous.mode || 'openai-compatible'
      const previousProfiles = previous.profiles || {}
      const previousActiveProfile = previousProfiles[nextMode] || {}

      const nextProfiles: CustomProviderProfiles = {
        ...previousProfiles,
        [nextMode]: {
          ...previousActiveProfile,
          ...(byokConfig.baseUrl !== undefined ? { baseUrl: byokConfig.baseUrl } : {}),
          ...(byokConfig.apiKey !== undefined ? { apiKey: byokConfig.apiKey } : {}),
          ...(byokConfig.model !== undefined ? { model: byokConfig.model } : {})
        }
      }

      const nextState = buildCustomProviderState(
        {
          ...previous,
          ...byokConfig,
          mode: nextMode,
          profiles: nextProfiles
        },
        nextMode
      )

      config.value.openAICompatibleByok = nextState
    }

    function setOpenAICompatibleByokConfig(byokConfig: Partial<OpenAICompatibleByokConfig>): void {
      setCustomProviderByokConfig(byokConfig)
    }

    /**
     * 设置自定义 Provider BYOK 启用状态
     */
    function setCustomProviderByokEnabled(enabled: boolean): void {
      setCustomProviderByokConfig({ enabled })
    }

    function setOpenAICompatibleByokEnabled(enabled: boolean): void {
      setCustomProviderByokEnabled(enabled)
    }

    /**
     * 获取启用且配置完整的自定义 Provider BYOK
     */
    function getEnabledCustomProviderByok(): {
      mode: CustomProviderMode
      baseUrl: string
      apiKey: string
      model: string
    } | null {
      const current = currentCustomProviderByok.value
      const mode = current.mode || 'openai-compatible'
      const baseUrl = String(current.baseUrl || '').trim()
      const apiKey = String(current.apiKey || '').trim()
      const model = String(current.model || '').trim()

      if (!current.enabled || !baseUrl || !apiKey || !model) {
        return null
      }

      return {
        mode,
        baseUrl,
        apiKey,
        model
      }
    }

    function getEnabledOpenAICompatibleByok(): {
      mode: CustomProviderMode
      baseUrl: string
      apiKey: string
      model: string
    } | null {
      return getEnabledCustomProviderByok()
    }

    /**
     * 重置配置
     */
    function resetConfig(): void {
      config.value = {
        normalProvider: 'openai',
        agentProvider: 'openai',
        agentPermissionMode: 'auto-edit',
        skillLearningMode: 'ask',
        followUpBehavior: 'queue',
        sendShortcut: 'enter',
        editorScreenshotEnabled: true,
        miniChatPersistEnabled: false,
        miniChatOpacity: 1,
        followUpSuggestionsEnabled: true,
        autoRetitleEnabled: false,
        voiceAntiSilenceEnabled: true,
        voiceAutoHangupEnabled: true,
        voiceMicrophoneDeviceId: '',
        voiceEchoGuard: DEFAULT_REALTIME_ECHO_GUARD,
        voiceBriefingStyle: DEFAULT_SPEECH_BRIEFING_STYLE,
        openAICompatibleByok: {
          enabled: false,
          mode: 'openai-compatible',
          profiles: {
            'openai-compatible': {},
            'anthropic-native': {}
          }
        }
      }
    }

    // 监听配置变化，自动迁移旧字段到新字段
    // 使用 watchEffect 而不是 watch，因为我们需要立即执行一次
    // 但我们只需要在首次加载时执行一次迁移
    let migrationDone = false
    watch(
      config,
      (currentConfig) => {
        if (migrationDone) return

        let needUpdate = false

        // 如果存在旧的 provider 字段，迁移到新字段
        if (currentConfig.provider && !currentConfig.normalProvider) {
          currentConfig.normalProvider = currentConfig.provider
          needUpdate = true
        }
        if (currentConfig.provider && !currentConfig.agentProvider) {
          currentConfig.agentProvider = currentConfig.provider
          needUpdate = true
        }
        if (currentConfig.chatModel && !currentConfig.normalChatModel) {
          currentConfig.normalChatModel = currentConfig.chatModel
          needUpdate = true
        }
        if (currentConfig.chatModel && !currentConfig.agentChatModel) {
          currentConfig.agentChatModel = currentConfig.chatModel
          needUpdate = true
        }

        // 确保新字段存在默认值
        if (normalizeAIConfig(currentConfig)) {
          needUpdate = true
        }

        const currentByok = currentConfig.openAICompatibleByok
        if (currentByok) {
          const mode = currentByok.mode || 'openai-compatible'
          const profiles = currentByok.profiles || {}
          const hasAnyProfile = Object.values(profiles).some(
            (profile) => profile && (profile.baseUrl || profile.apiKey || profile.model)
          )

          if (!currentByok.profiles || !hasAnyProfile) {
            currentConfig.openAICompatibleByok = {
              ...buildCustomProviderState(currentByok, mode),
              profiles: {
                ...profiles,
                [mode]: {
                  baseUrl: currentByok.baseUrl,
                  apiKey: currentByok.apiKey,
                  model: currentByok.model
                }
              }
            }
            needUpdate = true
          } else {
            currentConfig.openAICompatibleByok = buildCustomProviderState(currentByok, mode)
            needUpdate = true
          }
        }

        if (needUpdate) {
          console.log('[AI Config] 配置已迁移到新格式')
        }

        migrationDone = true
      },
      { immediate: true, deep: true }
    )

    return {
      // 状态
      config,

      // 计算属性
      currentProvider, // 向后兼容
      currentNormalProvider,
      currentAgentProvider,
      currentChatModel, // 向后兼容
      currentNormalChatModel,
      currentAgentChatModel,
      currentImageModel,
      currentCustomProviderByok,
      currentOpenAICompatibleByok,
      editorScreenshotEnabled,

      // 方法
      setProvider, // 向后兼容
      setNormalProvider,
      setAgentProvider,
      setChatModel, // 向后兼容
      setNormalChatModel,
      setAgentChatModel,
      setImageModel,
      agentPermissionMode,
      setAgentPermissionMode,
      agentThinkingLevel,
      setAgentThinkingLevel,
      agentFastMode,
      setAgentFastMode,
      agentCursorContext,
      setAgentCursorContext,
      skillLearningMode,
      setSkillLearningMode,
      followUpBehavior,
      setFollowUpBehavior,
      sendShortcut,
      setSendShortcut,
      setEditorScreenshotEnabled,
      miniChatPersistEnabled,
      setMiniChatPersistEnabled,
      miniChatOpacity,
      setMiniChatOpacity,
      followUpSuggestionsEnabled,
      setFollowUpSuggestionsEnabled,
      autoRetitleEnabled,
      setAutoRetitleEnabled,
      voiceAntiSilenceEnabled,
      voiceAutoHangupEnabled,
      voiceMicrophoneDeviceId,
      voiceAutoPlayEnabled,
      voiceEchoGuard,
      setVoiceEchoGuard,
      voiceBriefingStyle,
      setVoiceBriefingStyle,
      setVoiceAutoPlayEnabled,
      setVoiceMicrophoneDeviceId,
      setVoiceAutoHangupEnabled,
      setVoiceAntiSilenceEnabled,
      setCustomProviderByokConfig,
      setOpenAICompatibleByokConfig,
      setCustomProviderByokEnabled,
      setOpenAICompatibleByokEnabled,
      getEnabledCustomProviderByok,
      getEnabledOpenAICompatibleByok,
      resetConfig
    }
  },
  {
    // 持久化配置
    persist: {
      key: 'ai-config-store',
      pick: ['config'],
      storage: localStorage,
      serializer: StorageUtils.createCustomSerializer()
    }
  }
)
