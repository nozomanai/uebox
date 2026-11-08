import {
  ROLE_KIND,
  modelAllowsRole,
  modelLabelWithBadge,
  type ModelBinding,
  type ProviderView,
  type SettingsView
} from '@core/shared/aiProvider'
import { isPlanProvider } from '@core/shared/creatorPlan'

export interface AgentModelOption {
  key: string
  providerId: string
  providerName: string
  modelId: string
  modelName: string
  fullLabel: string
  /** 名字旁的小标签、悬停说明：套餐清单给的，原样显示 */
  badge?: string
  description?: string
}

export interface AgentModelGroup {
  providerId: string
  providerName: string
  options: AgentModelOption[]
}

export interface AgentModelCatalog {
  groups: AgentModelGroup[]
  options: AgentModelOption[]
  /**
   * 这一轮实际会用的绑定：对话绑定的模型优先，没有才看全局。
   * Agent 没有单独绑定时，内核会沿用 chat 角色；这里必须显示同一个实际结果。
   */
  binding: ModelBinding | null
  selected: AgentModelOption | null
}

/** Provider / model id 都可能含分隔符，JSON 数组键不会出现拆错位置的问题。 */
export function agentModelOptionKey(providerId: string, modelId: string): string {
  return JSON.stringify([providerId, modelId])
}

function modelName(model: ProviderView['models'][number]): string {
  return model.displayName?.trim() || model.id
}

function modelFullLabel(providerName: string, name: string): string {
  if (!providerName) return name
  if (name.toLowerCase().startsWith(providerName.toLowerCase())) return name
  return `${name} · ${providerName}`
}

/**
 * 输入栏只列能承担 Agent 角色的模型，并保持设置页里的 Provider / 模型顺序。
 * Agent 和普通对话都来自 chat Provider；能力判定沿用共享的 ROLE_KIND，避免另写一套。
 */
export function buildAgentModelCatalog(
  settings: SettingsView,
  sessionBinding?: ModelBinding | null
): AgentModelCatalog {
  const groups = settings.providers
    .filter((provider) => provider.kind === ROLE_KIND.agent && provider.models.length > 0)
    .map((provider): AgentModelGroup => {
      const providerName = provider.displayName.trim() || provider.id
      return {
        providerId: provider.id,
        providerName,
        // 选中的写进主模型那一格（chat，Agent 已并进去），对话钉住的按 agent 校验：两个都得允许
        options: provider.models
          .filter((model) => modelAllowsRole(model, 'chat') && modelAllowsRole(model, 'agent'))
          .map((model): AgentModelOption => {
            const name = modelName(model)
            return {
              key: agentModelOptionKey(provider.id, model.id),
              providerId: provider.id,
              providerName,
              modelId: model.id,
              modelName: name,
              fullLabel: modelFullLabel(providerName, modelLabelWithBadge(name, model.badge)),
              ...(model.badge ? { badge: model.badge } : {}),
              ...(model.description ? { description: model.description } : {})
            }
          })
      }
    })
    .filter((group) => group.options.length > 0)
    // 套餐的对话模型按协议分在两个来源里（Claude 单独一个），对用户是同一个 Box Plan
    .reduce<AgentModelGroup[]>((merged, group) => {
      const last = merged[merged.length - 1]
      if (last && isPlanProvider(last.providerId) && isPlanProvider(group.providerId)) {
        merged[merged.length - 1] = { ...last, options: [...last.options, ...group.options] }
      } else merged.push(group)
      return merged
    }, [])

  const options = groups.flatMap((group) => group.options)
  const globalBinding = settings.roles.agent ?? settings.roles.chat ?? null
  const find = (binding: ModelBinding | null): AgentModelOption | null =>
    binding
      ? (options.find(
          (option) => option.providerId === binding.providerId && option.modelId === binding.modelId
        ) ?? null)
      : null

  // 对话绑的模型被删了：主进程这一轮会退回全局默认，界面也显示那一个
  const sessionSelected = find(sessionBinding ?? null)
  if (sessionBinding && sessionSelected) {
    return { groups, options, binding: sessionBinding, selected: sessionSelected }
  }
  return { groups, options, binding: globalBinding, selected: find(globalBinding) }
}
