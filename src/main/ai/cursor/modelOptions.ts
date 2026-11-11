/**
 * Cursor 订阅模型在界面上的「思考程度」「上下文」「快速」能力。
 * 与 Cursor 客户端一致：Grok 有 Effort 四档与 256K/500K Context；Composer / Grok 可开 Fast。
 */

const GROK_PREFIX = 'grok-4.'

/** 输入框 Context 下拉里的 wire 值（小写 k，与 Cursor CLI 一致） */
export const CURSOR_CONTEXT_TIERS = ['256k', '500k'] as const
export type CursorContextTier = (typeof CURSOR_CONTEXT_TIERS)[number]

/** 这个 wire id 能不能在输入框里开「快速」 */
export function cursorModelSupportsFast(modelId: string): boolean {
  const id = modelId.trim().replace(/-fast$/, '')
  if (id === 'composer-2.5') return true
  if (id.startsWith(GROK_PREFIX)) return true
  return false
}

/** 这个模型能不能选 Context 档（目前只有 Grok 4.x 在客户端里露出 256K / 500K） */
export function cursorModelContextTiers(modelId: string): CursorContextTier[] | undefined {
  const id = modelId.trim().replace(/-fast$/, '')
  if (id.startsWith(GROK_PREFIX)) return [...CURSOR_CONTEXT_TIERS]
  return undefined
}

/** 大于 300K 的 context 档要走 RequestedModel.max_mode（与 Cursor SDK / CLI 一致） */
export function cursorMaxModeForContext(context: string | undefined): boolean {
  const trimmed = context?.trim()
  if (!trimmed || trimmed === 'auto') return false
  const match = /^(\d+(?:\.\d+)?)([km])$/i.exec(trimmed)
  if (!match) return false
  const amount = Number(match[1]) * (match[2].toLowerCase() === 'm' ? 1_000_000 : 1_000)
  return amount > 300_000
}

/** 从 pi 的 reasoning 档位解析 Cursor requested_model 里的 reasoning_effort 值 */
export function cursorWireEffort(
  reasoning: string | undefined,
  levelMap?: Record<string, string | null>
): string | undefined {
  if (!reasoning || reasoning === 'off' || reasoning === 'auto') return undefined
  const mapped = levelMap?.[reasoning]
  if (mapped === null) return undefined
  if (typeof mapped === 'string' && mapped.length > 0) return mapped
  return reasoning
}

/** auto / 未选时不发 context 参数，让服务端用该型号的默认档 */
export function cursorWireContext(choice: string | undefined): string | undefined {
  const trimmed = choice?.trim()
  if (!trimmed || trimmed === 'auto') return undefined
  return trimmed
}
