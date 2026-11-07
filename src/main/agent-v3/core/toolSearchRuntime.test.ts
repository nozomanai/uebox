/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createModels, getCurrentSystemPrompt, getCurrentTools } from '@earendil-works/pi-ai'
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall
} from '@earendil-works/pi-ai/providers/faux'
import { z } from 'zod'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { defineTool } from '../tools/defineTool'

const resolveModel = vi.hoisted(() => vi.fn())
const buildTools = vi.hoisted(() => vi.fn(() => [] as unknown[]))
const settings = vi.hoisted(() => ({ agentToolSearchEnabled: false }))
vi.mock('./streamFn', () => ({ resolveAgentModel: resolveModel }))
vi.mock('../tools/registry', () => ({ buildAllTools: buildTools }))
vi.mock('../tools/builtin/browser', () => ({ createBrowserTools: () => [] }))
vi.mock('../capabilities/skills', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../capabilities/skills')>()),
  applySkillLearningMode: (skills: unknown[]) => skills,
  discoverEnabledSkills: async () => [],
  buildSkillsSection: () => '',
  buildSkillLearningSection: () => ''
}))
vi.mock('../../appSettingsManager', () => ({ appSettingsManager: { getSettings: () => settings } }))
vi.mock('electron', () => ({ app: { getPath: () => '' } }))
vi.mock('./compactionCheckpoint', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./compactionCheckpoint')>()),
  loadCheckpoint: async () => null
}))

import { createUnrealAgent } from './createAgent'
import { restoreTranscript } from './systemMessages'
import { discoverSkills } from '../capabilities/skillsService/SkillsService'

const faux = fauxProvider({ tokensPerSecond: 100000 })
const models = createModels()
models.setProvider(faux.provider)
const write = vi.fn(async () => ({ text: 'written' }))
const read = vi.fn(async () => ({ text: 'read' }))
const base = { sessionId: 'beta-test', ueConnected: true, isSubAgent: true, skills: [] }
const requests: Array<{ key?: string; system?: string; tools: string[] }> = []

beforeEach(() => {
  settings.agentToolSearchEnabled = false
  requests.length = 0
  write.mockClear()
  read.mockClear()
  buildTools.mockReturnValue([
    defineTool({
      name: 'read_state',
      namespace: 'ue.material',
      risk: 'safe',
      description: '读取材质',
      input: z.object({}),
      execute: read
    }),
    defineTool({
      name: 'write_state',
      namespace: 'ue.material',
      risk: 'mutating',
      description: '修改材质',
      input: z.object({}),
      execute: write
    })
  ])
  const streamFn: StreamFn = (model, context, options) => {
    requests.push({
      key: options?.sessionId,
      system: getCurrentSystemPrompt(context.messages),
      tools: getCurrentTools(context.messages).map((tool) => tool.name)
    })
    return models.streamSimple(model, context, options)
  }
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

describe('搜索模式真正进入 Agent 循环', () => {
  it('默认全量；开启后只注入核心；明确 false 可以覆盖已开启设置用于 A/B', async () => {
    const full = await createUnrealAgent({ ...base })
    expect(full.tools.map((t) => t.name)).toEqual(['read_state', 'write_state'])
    settings.agentToolSearchEnabled = true
    const beta = await createUnrealAgent({ ...base })
    expect(beta.tools.map((t) => t.name)).toEqual(['search_tools'])
    expect(beta.agent.state.systemPrompt).toContain('<tool_search_beta>')
    const override = await createUnrealAgent({ ...base, toolSearchEnabled: false })
    expect(override.tools.map((t) => t.name)).toEqual(['read_state', 'write_state'])
    expect(override.agent.state.systemPrompt).not.toContain('<tool_search_beta>')
  })

  it('搜索后下一步真正执行原工具，并保留加载记录供供应商重放', async () => {
    const { agent } = await createUnrealAgent({ ...base, toolSearchEnabled: true })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('search_tools', { names: ['read_state'] }, { id: 's' })]),
      fauxAssistantMessage([fauxToolCall('read_state', {}, { id: 'r' })]),
      fauxAssistantMessage('done')
    ])
    await agent.prompt('读取材质')
    expect(read).toHaveBeenCalledOnce()
    expect(agent.state.errorMessage).toBeUndefined()
    expect(agent.state.messages).toContainEqual(
      expect.objectContaining({
        role: 'toolResult',
        toolName: 'search_tools',
        details: expect.objectContaining({
          toolSearch: expect.objectContaining({ loadedToolNames: ['read_state', 'write_state'] })
        })
      })
    )
    expect(requests).toHaveLength(3)
    expect(requests[0].key).not.toBe(requests[1].key)
    expect(requests[1].key).toBe(requests[2].key)
    expect(requests[1].tools).toEqual(['search_tools', 'read_state', 'write_state'])
  })

  it('加载写工具后仍走原有审批，拒绝时绝不执行', async () => {
    const approve = vi.fn(async () => 'reject' as const)
    const { agent } = await createUnrealAgent({
      ...base,
      toolSearchEnabled: true,
      approvalMode: 'ask',
      requestApproval: approve
    })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('search_tools', { names: ['write_state'] }, { id: 's' })]),
      fauxAssistantMessage([fauxToolCall('write_state', {}, { id: 'w' })]),
      fauxAssistantMessage('denied')
    ])
    await agent.prompt('修改材质')
    expect(approve).toHaveBeenCalledOnce()
    expect(write).not.toHaveBeenCalled()
  })

  /*
   * 这条原来断言的是「只读 + 白名单会话里，搜索只能取回 read_state」。
   * 2026-09-21 起这种会话**压根不折叠**（见 `createUnrealAgent` 里那段注释）：
   * 池子已经被收窄过一次，再折一次省不下多少前缀，却仍要为每次加载全价重写一遍。
   *
   * 「权限在搜索之前生效」这条不变量没有丢 —— 它由
   * `toolSearchCatalog.test.ts` 的「常驻也服从断连、只读、子任务和白名单」守着，
   * 那条直接喂 `resolveAgentTools` + `createToolSearch`，不依赖这里开不开折叠。
   */
  it('收窄过的会话不折叠：只读、Ask、白名单都直接给全量', async () => {
    settings.agentToolSearchEnabled = true
    for (const narrowed of [
      { readOnly: true },
      { mode: 'ask' as const },
      { toolNames: ['read_state'] },
      { namespaces: ['ue.material'] }
    ]) {
      const agent = await createUnrealAgent({ ...base, ...narrowed })
      expect(agent.toolSearchEnabled, JSON.stringify(narrowed)).toBe(false)
      expect(
        agent.tools.map((t) => t.name),
        JSON.stringify(narrowed)
      ).not.toContain('search_tools')
      expect(agent.agent.state.systemPrompt).not.toContain('<tool_search_beta>')
    }
    // 没带白名单的子任务拿的是完整工具池，那正是折叠最划算的场景 —— 不关
    const plain = await createUnrealAgent({ ...base, isSubAgent: true })
    expect(plain.toolSearchEnabled).toBe(true)
    expect(plain.tools.map((t) => t.name)).toEqual(['search_tools'])
  })

  it('常驻写工具不用搜索就可请求，但拒绝审批后仍然不能执行', async () => {
    buildTools.mockReturnValue([
      defineTool({
        name: 'ue_save',
        namespace: 'ue.editor',
        risk: 'mutating',
        description: '保存',
        input: z.object({}),
        execute: write
      })
    ])
    const requestApproval = vi.fn(async () => 'reject' as const)
    const { agent, tools } = await createUnrealAgent({
      ...base,
      toolSearchEnabled: true,
      residentTools: { ue_save: true },
      approvalMode: 'ask',
      requestApproval
    })
    expect(tools.map((tool) => tool.name)).toEqual(['search_tools', 'ue_save'])
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('ue_save', {}, { id: 'save' })]),
      fauxAssistantMessage('denied')
    ])
    await agent.prompt('保存')
    expect(requestApproval).toHaveBeenCalledOnce()
    expect(write).not.toHaveBeenCalled()
  })

  it('执行中断连会移除已加载的引擎工具，设置变化不改变本轮模式', async () => {
    let disconnected = false
    read.mockImplementationOnce(async () => {
      disconnected = true
      settings.agentToolSearchEnabled = false
      return { text: 'read, then disconnected' }
    })
    settings.agentToolSearchEnabled = true
    const ctx = {
      ...base,
      isSubAgent: false,
      refreshEngine: () => (disconnected ? { ueConnected: false } : undefined)
    }
    const { agent } = await createUnrealAgent(ctx)
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('search_tools', { names: ['read_state'] }, { id: 's' })]),
      fauxAssistantMessage([fauxToolCall('read_state', {}, { id: 'r' })]),
      fauxAssistantMessage('done')
    ])
    await agent.prompt('读取后断连')
    expect(read).toHaveBeenCalledOnce()
    expect(ctx.ueConnected).toBe(false)
    expect(agent.state.tools.map((tool) => tool.name)).toContain('search_tools')
    expect(agent.state.tools.map((tool) => tool.name)).not.toContain('read_state')
    expect(agent.state.systemPrompt).toContain('<tool_search_beta>')
  })

  it('旧对话切入搜索模式可按历史名字重新加载；关闭 Beta 后直接恢复全量', async () => {
    const first = await createUnrealAgent({ ...base, toolSearchEnabled: false })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read_state', {}, { id: 'old' })]),
      fauxAssistantMessage('done')
    ])
    await first.agent.prompt('read')
    const next = await createUnrealAgent({ ...base, toolSearchEnabled: true })
    restoreTranscript(next.agent, first.agent.state.messages)
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('search_tools', { names: ['read_state'] }, { id: 's' })]),
      fauxAssistantMessage([fauxToolCall('read_state', {}, { id: 'new' })]),
      fauxAssistantMessage('done again')
    ])
    await next.agent.prompt('再读一次')
    expect(read).toHaveBeenCalledTimes(2)
    const fullAgain = await createUnrealAgent({ ...base, toolSearchEnabled: false })
    expect(fullAgain.tools.map((t) => t.name)).toEqual(['read_state', 'write_state'])
  })

  it('恢复历史后第一个请求就带着加载过的工具和这一轮自己的提示词', async () => {
    const first = await createUnrealAgent({ ...base, toolSearchEnabled: true })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('search_tools', { names: ['read_state'] }, { id: 's' })]),
      fauxAssistantMessage('loaded')
    ])
    await first.agent.prompt('加载')
    const next = await createUnrealAgent({ ...base, toolSearchEnabled: true })
    // 宿主的做法：先建 agent，再把盘上的历史装进去（盘上没有 system 消息）
    restoreTranscript(
      next.agent,
      first.agent.state.messages.filter((message) => message.role !== 'system')
    )
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('read_state', {}, { id: 'r' })]),
      fauxAssistantMessage('done')
    ])
    requests.length = 0
    await next.agent.prompt('直接读')
    expect(read).toHaveBeenCalledOnce()
    // pi 1.0 把提示词和工具都放在 transcript 里：直接赋值 state.messages 会把两者一起冲掉
    expect(requests[0].tools).toContain('read_state')
    expect(requests[0].system).toContain('<tool_search_beta>')
  })

  it('真实材质技能带组，下一响应直接执行；恢复聊天首轮就保留整组并重过只读权限', async () => {
    const skills = (await discoverSkills(['resources/skills'])).filter(
      (skill) => skill.name === 'ue-material-authoring'
    )
    expect(skills).toHaveLength(1)
    buildTools.mockReturnValue([
      defineTool({
        name: 'material_get_graph',
        namespace: 'ue.material',
        risk: 'safe',
        description: '读图',
        input: z.object({}),
        execute: read
      }),
      defineTool({
        name: 'material_create',
        namespace: 'ue.material',
        risk: 'mutating',
        description: '建图',
        input: z.object({}),
        execute: write
      })
    ])
    const first = await createUnrealAgent({ ...base, skills, toolSearchEnabled: true })
    faux.setResponses([
      fauxAssistantMessage([
        fauxToolCall('load_skill', { name: 'ue-material-authoring' }, { id: 'skill' })
      ]),
      fauxAssistantMessage([fauxToolCall('material_get_graph', {}, { id: 'graph' })]),
      fauxAssistantMessage('done')
    ])
    await first.agent.prompt('读取材质节点')
    expect(read).toHaveBeenCalledOnce()
    expect(first.agent.state.messages).toContainEqual(
      expect.objectContaining({
        role: 'toolResult',
        toolName: 'load_skill',
        details: expect.objectContaining({
          toolSearch: expect.objectContaining({
            loadedToolNames: ['material_create', 'material_get_graph']
          })
        })
      })
    )
    expect(
      first.agent.state.messages.some(
        (message) => message.role === 'toolResult' && message.toolName === 'search_tools'
      )
    ).toBe(false)
    const next = await createUnrealAgent({
      ...base,
      skills,
      toolSearchEnabled: true,
      readOnly: true
    })
    restoreTranscript(next.agent, first.agent.state.messages)
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('material_get_graph', {}, { id: 'again' })]),
      fauxAssistantMessage('read again')
    ])
    await next.agent.prompt('继续读取')
    expect(read).toHaveBeenCalledTimes(2)
    expect(next.agent.state.tools.map((tool) => tool.name)).not.toContain('material_create')
    expect(next.agent.state.errorMessage).toBeUndefined()
    const truncated = await createUnrealAgent({ ...base, skills, toolSearchEnabled: true })
    expect(truncated.tools.map((tool) => tool.name)).not.toContain('material_get_graph')
  })

  /*
   * 这条原本断言「容量拦住后第三次相同搜索被熔断」。那道 64 KB 闸 2026-09-17 删了
   * （理由见 toolSearch.ts 顶部），所以改成断言相反的事：**超大定义照常装上**。
   *
   * 熔断器本身没动，它仍然管真正的失败和同工具同参数原地打转 —— 只是不再需要
   * 把「容量不够」伪装成失败喂给它。
   */
  it('单个超大工具定义照常加载，不再被容量拦下', async () => {
    buildTools.mockReturnValue([
      defineTool({
        name: 'huge',
        namespace: 'mcp.large',
        description: 'x'.repeat(65000),
        input: z.object({}),
        execute: read
      })
    ])
    const { agent } = await createUnrealAgent({ ...base, toolSearchEnabled: true })
    faux.setResponses([
      fauxAssistantMessage([fauxToolCall('search_tools', { names: ['huge'] }, { id: 'search-1' })]),
      fauxAssistantMessage([fauxToolCall('huge', {}, { id: 'call-1' })]),
      fauxAssistantMessage('done')
    ])
    await agent.prompt('使用 huge')
    expect(agent.state.messages.filter((m) => m.role === 'toolResult')).toHaveLength(2)
    expect(read).toHaveBeenCalledTimes(1)
  })
})
