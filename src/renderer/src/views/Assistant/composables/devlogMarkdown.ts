/**
 * 对话导出成 Markdown：每一轮写清楚用户要了什么、助手说了什么、调了哪些工具、改了哪些东西。
 *
 * 以前的导出只有双方的文字，工具调用和改动清单都丢了 —— 而拿导出文件当开发日志
 * （jam 的 Glass Box 奖就是评开发日志）的人要的恰恰是「这个游戏是怎么一步步做出来的」。
 * 工具名按调用顺序合并计数，改动来自每轮收尾时算好的 `responseMetadata.changes`，
 * 不在这里重新推断。
 */

import type { ChatMessage, ChatMessageContent } from '@renderer/store/modules/chatMessages'

export interface DevlogLabels {
  user: string
  assistant: string
  tools: string
  changes: string
  failed: string
  turn: (index: number) => string
}

function textOf(content: ChatMessageContent): string {
  if (typeof content === 'string') return content.trim()
  return content
    .map((item) =>
      item.type === 'text' ? (item.text ?? '') : item.type === 'image_url' ? '[image]' : '[file]'
    )
    .filter(Boolean)
    .join('\n')
    .trim()
}

/** 工具名按首次出现的顺序合并：`a ×2, b` */
export function toolSummary(message: ChatMessage): string[] {
  const counts = new Map<string, number>()
  for (const item of message.agentProcess ?? []) {
    if (item.type !== 'tool-call') continue
    const data = item.data as { function?: { name?: string }; name?: string } | undefined
    const name = data?.function?.name ?? data?.name
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1)
  }
  return [...counts].map(([name, n]) => (n > 1 ? `\`${name}\` ×${n}` : `\`${name}\``))
}

export function conversationToMarkdown(
  messages: ChatMessage[],
  labels: DevlogLabels,
  title?: string
): string {
  const out: string[] = []
  if (title) out.push(`# ${title}`, '')
  let turn = 0
  for (const message of messages) {
    const text = textOf(message.content)
    if (message.role === 'user') {
      turn++
      out.push(`## ${labels.turn(turn)}`, '', `**${labels.user}:** ${text}`, '')
      continue
    }
    if (text) out.push(`**${labels.assistant}:** ${text}`, '')
    const tools = toolSummary(message)
    if (tools.length) out.push(`**${labels.tools}:** ${tools.join(', ')}`, '')
    const changes = message.responseMetadata?.changes ?? []
    if (changes.length) {
      out.push(`**${labels.changes}:**`, '')
      for (const change of changes) {
        const target = change.target ? ` ${change.target}` : ''
        const detail = change.detail ? ` — ${change.detail}` : ''
        const failed = change.failed ? ` (${labels.failed})` : ''
        out.push(`- \`${change.toolName}\`${target}${detail}${failed}`)
      }
      out.push('')
    }
  }
  return out.join('\n').trimEnd() + '\n'
}
