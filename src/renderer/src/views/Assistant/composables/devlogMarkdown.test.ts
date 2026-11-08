import { describe, expect, it } from 'vitest'

import type { ChatMessage } from '@renderer/store/modules/chatMessages'
import { conversationToMarkdown, toolSummary } from './devlogMarkdown'

const labels = {
  user: 'User',
  assistant: 'Assistant',
  tools: 'Tools',
  changes: 'Changes',
  failed: 'failed',
  turn: (n: number) => `Turn ${n}`
}

const call = (name: string): NonNullable<ChatMessage['agentProcess']>[number] => ({
  type: 'tool-call',
  data: { id: name, type: 'function', function: { name, arguments: '{}' } },
  timestamp: 0
})

describe('对话导出成开发日志', () => {
  it('每轮写用户、助手、按顺序合并计数的工具和改动清单', () => {
    const messages: ChatMessage[] = [
      { id: 'u1', role: 'user', content: 'Package the game' },
      {
        id: 'a1',
        role: 'assistant',
        content: 'Packaged and zipped.',
        agentProcess: [
          call('project_package'),
          call('project_smoke_test'),
          call('project_package')
        ],
        responseMetadata: {
          changes: [
            {
              toolName: 'project_zip_build',
              risk: 'mutating',
              target: 'Team_Game.zip',
              reversible: false,
              failed: false
            },
            {
              toolName: 'ue_save_all',
              risk: 'mutating',
              target: '',
              detail: '3 assets',
              reversible: true,
              failed: true
            }
          ]
        }
      },
      {
        id: 'u2',
        role: 'user',
        content: [
          { type: 'text', text: 'Look' },
          { type: 'image_url', image_url: { url: 'x' } }
        ]
      }
    ]
    const md = conversationToMarkdown(messages, labels, 'Neon Fort dev log')
    expect(md).toContain('# Neon Fort dev log')
    expect(md).toContain('## Turn 1\n\n**User:** Package the game')
    expect(md).toContain('**Tools:** `project_package` ×2, `project_smoke_test`')
    expect(md).toContain('- `project_zip_build` Team_Game.zip')
    expect(md).toContain('- `ue_save_all` — 3 assets (failed)')
    expect(md).toContain('## Turn 2\n\n**User:** Look\n[image]')
  })

  it('没调工具、没改东西的轮次不写空的工具和改动行', () => {
    const md = conversationToMarkdown(
      [
        { id: 'u', role: 'user', content: 'hi' },
        { id: 'a', role: 'assistant', content: 'hello' }
      ],
      labels
    )
    expect(md).not.toContain('Tools')
    expect(md).not.toContain('Changes')
  })

  it('忽略非工具调用的过程条目', () => {
    expect(
      toolSummary({
        id: 'a',
        role: 'assistant',
        content: '',
        agentProcess: [{ type: 'text', data: 'x', timestamp: 0 }, call('a')]
      })
    ).toEqual(['`a`'])
  })
})
