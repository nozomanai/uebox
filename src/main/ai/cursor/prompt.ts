import { randomUUID } from 'crypto'
import {
  contentText,
  getCurrentSystemPrompt,
  getCurrentTools,
  type ImageContent,
  type Message,
  type Tool
} from '@earendil-works/pi-ai'

import type { CursorImage, CursorToolDef } from './wire'

export interface ToolFollowUp {
  id: string
  name: string
  text: string
  isError: boolean
}

/** 紧挨在末尾的工具结果。任务的下一轮就是这些，用来续上还开着的 Cursor 运行 */
export function trailingToolResults(messages: readonly Message[]): ToolFollowUp[] | null {
  const results: ToolFollowUp[] = []
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message.role === 'system') continue
    if (message.role !== 'toolResult') return results.length > 0 ? results.reverse() : null
    results.push({
      id: message.toolCallId,
      name: message.toolName,
      text: message.content.map((part) => (part.type === 'text' ? part.text : '')).join(''),
      isError: message.isError
    })
  }
  return results.length > 0 ? results.reverse() : null
}

export interface CursorPrompt {
  systemPrompt: string
  userText: string
  tools: CursorToolDef[]
  images: CursorImage[]
}

const IMAGE_LIMIT = 4

function textOf(content: Message['content'] | string): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return contentText(content as Parameters<typeof contentText>[0])
}

function imagesOf(message: Message): CursorImage[] {
  if (message.role !== 'user' || !Array.isArray(message.content)) return []
  const images: CursorImage[] = []
  for (const part of message.content) {
    if (part.type !== 'image') continue
    const image = part as ImageContent
    const raw = image.data.includes(',') ? image.data.slice(image.data.indexOf(',') + 1) : image.data
    const data = Buffer.from(raw, 'base64')
    if (data.length === 0) continue
    images.push({
      uuid: randomUUID(),
      mimeType: image.mimeType || 'image/png',
      data
    })
    if (images.length >= IMAGE_LIMIT) break
  }
  return images
}

function renderMessage(message: Message): string {
  if (message.role === 'user') return `[user]\n${textOf(message.content)}`
  if (message.role === 'toolResult') {
    const body = message.content.map((part) => (part.type === 'text' ? part.text : '')).join('')
    const flag = message.isError ? ' error' : ''
    return `[tool_result ${message.toolName} ${message.toolCallId}${flag}]\n${body}`
  }
  if (message.role !== 'assistant') return ''
  const blocks: string[] = []
  for (const part of message.content) {
    if (part.type === 'thinking' && part.thinking.trim()) blocks.push(`[thinking]\n${part.thinking}`)
    else if (part.type === 'text' && part.text) blocks.push(part.text)
    else if (part.type === 'toolCall') {
      blocks.push(
        `[tool_call ${part.name} ${part.id}]\n${JSON.stringify(part.arguments)}`
      )
    }
  }
  return blocks.length > 0 ? `[assistant]\n${blocks.join('\n')}` : ''
}

/**
 * 把 pi 的对话折成 Cursor 这一轮能吃的一份提示。
 *
 * 每一轮都是一次新的 Agent 运行：上文、工具结果和思考写进用户文本，
 * 系统提示词单独走 blob。只有一句用户话时不包对话标记，避免简单问候被格式带偏。
 * 思考程度走 requested_model 的 effort 参数，不折进系统提示词。
 */
export function renderCursorPrompt(messages: readonly Message[]): CursorPrompt {
  const tools = getCurrentTools(messages).map(toToolDef)
  const systemParts = [getCurrentSystemPrompt(messages)].filter(Boolean)
  const history = messages.filter((message) => message.role !== 'system')
  const lastUser = [...history].reverse().find((message) => message.role === 'user')
  const images = lastUser ? imagesOf(lastUser) : []

  const onlyUser = history.length === 1 && history[0]?.role === 'user'
  const userText = onlyUser
    ? textOf(history[0].content)
    : history
        .map(renderMessage)
        .filter(Boolean)
        .join('\n\n')

  return {
    systemPrompt: systemParts.join('\n\n'),
    userText,
    tools,
    images
  }
}

function toToolDef(tool: Tool): CursorToolDef {
  let schema: unknown = { type: 'object', properties: {} }
  try {
    schema = JSON.parse(JSON.stringify(tool.parameters))
  } catch {
    schema = { type: 'object', properties: {} }
  }
  return {
    name: tool.name,
    description: tool.description,
    schema
  }
}
