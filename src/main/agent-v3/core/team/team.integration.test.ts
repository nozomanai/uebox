/**
 * @vitest-environment node
 *
 * 工作室模式端到端：制作人招人、派活 → 队员带着自己的人设和工具范围跑 →
 * 回话回到制作人上下文、队员的记忆落盘。模型说什么由脚本决定（fauxProvider），
 * 验的是盒子这一侧的装配有没有接对。
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createModels, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from '@earendil-works/pi-ai/providers/faux'
import { z } from 'zod'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { defineTool } from '../../tools/defineTool'

const resolveModel = vi.hoisted(() => vi.fn())
const buildTools = vi.hoisted(() => vi.fn(() => [] as unknown[]))
vi.mock('../streamFn', () => ({ resolveAgentModel: resolveModel }))
vi.mock('../../tools/registry', () => ({ buildAllTools: buildTools }))
vi.mock('../../tools/builtin/browser', () => ({ createBrowserTools: () => [] }))
vi.mock('../../capabilities/skills', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../capabilities/skills')>()),
  applySkillLearningMode: (skills: unknown[]) => skills,
  discoverEnabledSkills: async () => [],
  buildSkillsSection: () => '',
  buildSkillLearningSection: () => ''
}))
vi.mock('../../../appSettingsManager', () => ({
  appSettingsManager: { getSettings: () => ({ agentToolSearchEnabled: false }) }
}))
// 体检缓存和履历落在 userData 下：指到临时目录，别写进仓库
const userData = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  return mkdtempSync(`${tmpdir()}/team-e2e-userdata-`)
})
vi.mock('electron', () => ({ app: { getPath: () => userData } }))
// 招人挑了制作人以外的模型要过入职体检：这里不真发请求，直接给过
const checkup = vi.hoisted(() => vi.fn(async () => ({ at: 0, reachable: true, tools: 'ok' })))
vi.mock('../../../ai/probe', () => ({ checkupChatModel: checkup }))
// 招人时的候选模型从这里读：制作人自己那个，再加一个便宜的
const aiSettings = vi.hoisted(() => ({ providers: [] as unknown[], roles: {} }))
vi.mock('../../../ai/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../ai/store')>()),
  readSettings: async () => aiSettings
}))
vi.mock('../compactionCheckpoint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../compactionCheckpoint')>()),
  loadCheckpoint: async () => null
}))

import { createUnrealAgent } from '../createAgent'
import { createTeamStore } from './teamStore'

const root = mkdtempSync(join(tmpdir(), 'team-e2e-'))
afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(userData, { recursive: true, force: true })
})

const faux = fauxProvider({ tokensPerSecond: 100000 })
const models = createModels()
models.setProvider(faux.provider)
const write = vi.fn(async () => ({ text: 'written' }))
const requests: Array<{ system: string; tools: string[] }> = []

beforeEach(() => {
  requests.length = 0
  write.mockClear()
  resolveModel.mockClear()
  buildTools.mockReturnValue([
    defineTool({
      name: 'read_state',
      namespace: 'ue.material',
      risk: 'safe',
      description: '读取材质',
      input: z.object({}),
      execute: async () => ({ text: 'read' })
    }),
    defineTool({
      name: 'write_state',
      namespace: 'ue.material',
      risk: 'mutating',
      description: '修改材质',
      input: z.object({}),
      execute: write
    }),
    defineTool({
      name: 'find_asset',
      namespace: 'asset',
      risk: 'safe',
      description: '找素材',
      input: z.object({}),
      execute: async () => ({ text: 'found' })
    })
  ])
  const streamFn: StreamFn = (model, context, options) => {
    requests.push({
      system: getCurrentSystemPrompt(context.messages),
      tools: getCurrentTools(context.messages).map((tool) => tool.name)
    })
    return models.streamSimple(model, context, options)
  }
  aiSettings.providers = [
    {
      id: 'faux',
      displayName: 'Faux',
      kind: 'chat',
      models: [{ id: faux.getModel().id }, { id: 'cheap', displayName: 'Cheap' }]
    }
  ]
  resolveModel.mockResolvedValue({
    selection: {
      providerId: 'faux',
      modelId: faux.getModel().id,
      role: 'agent',
      model: faux.getModel()
    },
    models,
    summaryModel: faux.getModel(),
    streamFn
  })
})

describe('工作室模式装配', () => {
  it('制作人招人派活 → 队员按自己的人设和范围干活 → 回话和记忆都在', async () => {
    const store = createTeamStore({
      stateDir: join(root, 's1', 'state'),
      workspaceDir: join(root, 's1', 'ws')
    })
    await store.ensure()
    const { agent } = await createUnrealAgent({
      sessionId: 'team-e2e',
      ueConnected: true,
      skills: [],
      modelRequest: { role: 'agent' },
      team: { objective: '做一个塔防游戏', store }
    })

    faux.setResponses([
      // 制作人
      fauxAssistantMessage([
        fauxToolCall(
          'team_hire',
          {
            name: '材质师',
            role: '负责所有材质',
            model: 'faux/cheap',
            model_reason: '活简单，用便宜的',
            namespaces: ['ue.material']
          },
          { id: 'h' }
        )
      ]),
      fauxAssistantMessage([
        fauxToolCall('team_send', { to: '材质师', message: '把地面材质做成草地' }, { id: 's' })
      ]),
      // 队员
      fauxAssistantMessage([fauxToolCall('write_state', {}, { id: 'w' })]),
      fauxAssistantMessage('草地材质做好了'),
      // 制作人收尾
      fauxAssistantMessage('好')
    ])
    await agent.prompt('做一个塔防游戏')
    expect(agent.state.errorMessage).toBeUndefined()

    // 制作人：四个团队工具在手，系统提示词里有交付标准和工作区；
    // 制作人可以自己动手：写工具留着
    const producer = requests[0]!
    expect(producer.tools).toEqual(
      expect.arrayContaining([
        'team_hire',
        'team_send',
        'team_board',
        'team_deliver',
        'write_state'
      ])
    )
    expect(producer.system).toContain('<team_mode>')
    expect(producer.system).toContain(join(root, 's1', 'ws'))

    // 队员：只拿白名单里的命名空间 + 任务板和留言；没有招人、派活、子任务
    const member = requests[2]!
    expect(member.tools.sort()).toEqual([
      'read_state',
      'team_board',
      'team_message',
      'team_status',
      'write_state'
    ])
    expect(member.system).toContain('<role>负责所有材质</role>')
    expect(member.system).not.toContain('<team_mode>')
    expect(write).toHaveBeenCalledOnce()

    // 挑了制作人以外的模型：先体检过了才招
    expect(checkup).toHaveBeenCalledOnce()
    // 队员钉在制作人给它挑的模型上
    expect(resolveModel.mock.calls.map((call) => call[0]?.pin)).toContainEqual({
      providerId: 'faux',
      modelId: 'cheap'
    })

    // 回话回到制作人上下文，附带记账记出来的写操作
    const reply = agent.state.messages.find(
      (m) => m.role === 'toolResult' && (m as { toolName?: string }).toolName === 'team_send'
    ) as { content: Array<{ text?: string }> }
    const text = reply.content.map((c) => c.text ?? '').join('')
    expect(text).toContain('材质师（Cheap） 回话')
    expect(text).toContain('草地材质做好了')
    expect(text).toContain('write_state')

    // 这件活记进了履历：哪个模型、交回来了
    const record = readFileSync(join(userData, 'team-models', 'track-record.jsonl'), 'utf8')
    expect(
      record
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    ).toEqual([
      expect.objectContaining({
        kind: 'task',
        model: { providerId: 'faux', modelId: 'cheap' },
        outcome: 'done'
      })
    ])

    // 队员的记忆落盘了：下次派活它记得这件
    const history = await store.history('材质师')
    expect(JSON.stringify(history)).toContain('把地面材质做成草地')
  })

  it('不是工作室的会话一个团队工具都没有', async () => {
    const { tools } = await createUnrealAgent({ sessionId: 'plain', ueConnected: true, skills: [] })
    expect(tools.map((t) => t.name)).not.toEqual(expect.arrayContaining(['team_hire']))
    expect(tools.some((t) => t.name.startsWith('team_'))).toBe(false)
  })
})
