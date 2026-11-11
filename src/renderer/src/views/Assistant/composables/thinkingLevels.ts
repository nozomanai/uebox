/**
 * 输入框那个「思考程度」下拉的清单逻辑。
 *
 * ## 为什么不能写死一份清单
 *
 * 档位是**每个模型自己声明的**，各家差得很远：GPT-5 系是
 * minimal/low/medium/high，有的模型只有 off/high/max，本地小模型一档都没有。
 * 界面写死一份「快/中/深」的话，用户会看到当前模型根本不存在的档位 ——
 * 选了之后内核会悄悄夹到最近的一档（`clampThinkingLevel`），表现是
 * 「选了没反应」，而且没有任何提示。
 *
 * 所以清单向主进程现问（`agentV3.thinkingLevels()`），这里只负责：
 * 把内核给的档位配上文案、把用户存的选择夹到当前模型的范围里、
 * 并算出「实际会用哪一档」好让界面说清楚。
 *
 * 换模型时**不清空用户的选择**：他选的是「我要深度思考」这个意图，
 * 换个模型这个意图不变。存原值、按当前模型夹一次，换回去还是原来那档。
 */

/** 全部档位，顺序即强度。与内核的 EXTENDED_THINKING_LEVELS 一致，`auto` 是界面额外加的 */
export const THINKING_LADDER: readonly AgentV3ThinkingLevel[] = Object.freeze([
  'auto',
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max'
])

/** 主进程回的「这个模型支持哪几档」 */
export interface ModelThinkingSupport {
  levels: AgentV3ThinkingLevel[]
  /** 厂商给档位起的别名。有的模型把 high 叫成别的词 */
  levelMap: Record<string, string | null>
  modelId: string
  /** 这个模型能不能开「快速」。老主进程不回这个字段，按不能算 */
  fastMode?: boolean
  /** Cursor Grok 可选 Context 档（256k / 500k） */
  contextTiers?: Array<'256k' | '500k'>
}

export type AgentCursorContext = 'auto' | '256k' | '500k'

export function formatContextTierLabel(tier: '256k' | '500k'): string {
  return tier.replace('k', 'K')
}

export interface ThinkingOption {
  value: AgentV3ThinkingLevel
  /**
   * 显示名，就是**档位本身的名字**（low / high / max…），不做本地化包装。
   *
   * 不翻译成「快速思考」「深度思考」是有意的：档位是模型声明的原始词汇，
   * 用户在厂商文档、官方客户端、pi 里看到的都是这几个词。翻一遍只会让
   * 「我在文档里看到的 xhigh 去哪了」这种问题冒出来。说明放在右边那一列。
   *
   * 厂商给某一档起了别名时显示别名，原名进 `original`。
   */
  label: string
  /** 用了厂商别名时，档位的原名。界面显示在括号里 */
  original?: string
  desc: string
}

/** 触发器上显示的当前档位。与选项里的 label 同一套规则 */
export function thinkingDisplayLabel(
  level: AgentV3ThinkingLevel,
  support: ModelThinkingSupport | null
): string {
  if (level === 'auto') return level
  return support?.levelMap[level] || level
}

/**
 * 当前模型该列哪几档。
 *
 * `support` 为 null（还没问到、或者模型没配好）时列全集 —— 空下拉比列多了
 * 更难理解，用户会以为功能坏了。
 *
 * `auto` 永远在列：它是「不指定」，与模型支持哪些档位无关。
 */
export function buildThinkingOptions(
  support: ModelThinkingSupport | null,
  describe: (level: AgentV3ThinkingLevel) => string
): ThinkingOption[] {
  return THINKING_LADDER.filter(
    (level) => level === 'auto' || !support || support.levels.includes(level)
  ).map((level) => {
    const desc = describe(level)
    const alias = level === 'auto' ? null : support?.levelMap[level]
    // 别名与原名相同就不用显示两遍
    return alias && alias !== level
      ? { value: level, label: alias, original: level, desc }
      : { value: level, label: level, desc }
  })
}

/**
 * 用户存的档位，在当前模型上实际会变成哪一档。
 *
 * 与内核的 `clampThinkingLevel` 同一套规则：先往上找更强的，再往下找更弱的。
 * 界面据此提示「你选的这一档这个模型没有，实际用的是 X」——
 * 不说的话用户只会觉得这个开关时灵时不灵。
 */
export function resolveEffectiveLevel(
  chosen: AgentV3ThinkingLevel,
  support: ModelThinkingSupport | null
): AgentV3ThinkingLevel {
  if (chosen === 'auto' || !support) return chosen
  if (support.levels.includes(chosen)) return chosen
  if (support.levels.length === 0) return 'auto'

  const index = THINKING_LADDER.indexOf(chosen)
  for (let i = index + 1; i < THINKING_LADDER.length; i++) {
    if (support.levels.includes(THINKING_LADDER[i])) return THINKING_LADDER[i]
  }
  for (let i = index - 1; i > 0; i--) {
    if (support.levels.includes(THINKING_LADDER[i])) return THINKING_LADDER[i]
  }
  return 'auto'
}
