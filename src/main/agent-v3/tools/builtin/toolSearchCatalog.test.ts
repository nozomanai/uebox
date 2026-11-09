import { beforeAll, describe, expect, it, vi } from 'vitest'
import { electronMock, servicesMock, targetContextMock } from '../../testSupport/toolMocks'

vi.mock('electron', () => electronMock())
vi.mock('../../../services', () => servicesMock())
vi.mock('../../core/projectTargetContext', async (importOriginal) =>
  targetContextMock(importOriginal)
)

import { buildSystemPrompt, resolveAgentTools, type SessionContext } from '../../core/createAgent'
import {
  ALWAYS_RESIDENT_TOOL_NAMES,
  createToolSearch,
  groupDomainTerms,
  TOOL_SEARCH_RULES,
  toolDefinitionBytes,
  toolSearchGroup
} from './toolSearch'
import { createTaskTool } from './task'
import type { UnrealAgentTool } from '../defineTool'
import { BROWSER_TOOL_NAMES, OFFLINE_UE_TOOLS } from '../toolNames'
import { createSkillTools, discoverEnabledSkills } from '../../capabilities/skills'

const ctx: SessionContext = {
  sessionId: 'search-catalog',
  ueConnected: true,
  shellAvailable: true,
  requestApproval: async () => 'reject',
  requestQuestion: async () => ({ action: 'cancel' }),
  onVoiceReport: () => undefined,
  sessionProjectControl: { listProjects: () => [], onChange: () => undefined }
}
const task = createTaskTool({
  getParentMessages: () => [],
  runSubAgent: async () => ({ text: '', messageCount: 0 })
}) as UnrealAgentTool<never>
let skills: Awaited<ReturnType<typeof discoverEnabledSkills>>
let catalog: UnrealAgentTool<never>[]
beforeAll(async () => {
  skills = await discoverEnabledSkills()
  catalog = resolveAgentTools(ctx, skills, task)
})

function loadedNames(result: Awaited<ReturnType<UnrealAgentTool<never>['execute']>>): string[] {
  const text = result.content.find((block) => block.type === 'text')
  if (!text || text.type !== 'text') throw new Error('missing search result')
  return (JSON.parse(text.text) as { loaded: { name: string }[] }).loaded.map((tool) => tool.name)
}

/** 常驻判据的唯一真相：加载入口 + 宿主交互 */
function residentNames(): Set<string> {
  return new Set(
    createToolSearch(catalog, () => catalog)
      .getTools()
      .map((tool) => tool.name)
  )
}

describe('真实工具库检索回归', () => {
  it('默认只有加载入口和宿主交互工具常驻，其余全部按需加载', () => {
    const host = ['ask_user', 'voice_report', 'set_session_project', 'update_plan', 'wrap_up']
    const resident = [...residentNames()]
    expect(resident).toEqual(expect.arrayContaining(['search_tools', 'load_skill', 'ask_user']))
    for (const name of resident)
      expect(
        ALWAYS_RESIDENT_TOOL_NAMES.has(name) || host.includes(name),
        `${name} 不该默认常驻`
      ).toBe(true)
  })

  /*
   * 拆组是**无声**改错的地方：多一个 `ue.content` 工具没归子组、
   * 或者一个组没有领域词，表现都是「模型偶尔搜不到它」，没人会去查。
   */
  it('ue.content 的每个工具都归进了子组', () => {
    const orphans = catalog
      .filter((tool) => tool.unrealBox.namespace === 'ue.content')
      .filter((tool) => toolSearchGroup(tool) === 'ue.content')
      .map((tool) => tool.name)
    expect(
      orphans,
      `这些 ue.content 工具还没归子组：${orphans.join('、')}。` +
        '在 toolSearch.ts 的 UE_CONTENT_SUBGROUPS 里按「导入 / 整理 / 体检」归位。'
    ).toEqual([])
  })

  /**
   * `mcp` 那条领域词说的是「接 MCP 这件事」。摊给每一台第三方 server 的组的话，
   * 搜「启用插件」会把它们全捞上来，目录里也看不出是哪台 server
   */
  it('第三方 MCP 的组不继承「接 MCP」的领域词', () => {
    expect(groupDomainTerms('mcp')).not.toBe('')
    expect(groupDomainTerms('mcp.example')).toBe('')
  })

  it('每个在用的工具组都查得到领域词', () => {
    const groups = [...new Set(catalog.map((tool) => toolSearchGroup(tool)))]
    const blank = groups.filter((group) => !groupDomainTerms(group)).sort()
    expect(
      blank,
      `这些组在 DOMAIN_TERMS 里一行都回退不到：${blank.join('、')}。` +
        '缺一行的后果是无声的 —— 那一组的中文查询只能指望描述里刚好有字面词。'
    ).toEqual([])
  })

  /*
   * 原来这条断言「每个组都能放进 64 KB 加载区」。那道闸 2026-09-17 删了
   * （见 toolSearch.ts 顶部），所以断言改成记录各组体积 —— 组多大仍然值得知道
   * （蓝图组 44,572 字节，一个就占旧闸七成），只是它不再是一条会让任务失败的线。
   */
  it('记录各按需工具组的体积', () => {
    const search = createToolSearch(catalog, () => catalog)
    const resident = new Set(search.getTools())
    const groups = new Map<string, number>()
    for (const tool of catalog.filter((tool) => !resident.has(tool))) {
      const group = toolSearchGroup(tool)
      groups.set(group, (groups.get(group) ?? 0) + toolDefinitionBytes(tool))
    }
    expect(groups.size).toBeGreaterThan(0)
    if (process.env.TOOL_SEARCH_MEASURE === '1')
      console.info('TOOL_SEARCH_GROUP_BYTES', JSON.stringify(Object.fromEntries(groups)))
  })

  /*
   * 技能带组是主路径，`search_tools` 只是兜底。所以「有没有哪个工具组，任何技能都
   * 引用不到」是一条会无声出现的缺陷：新加一组工具、谁都没在技能里提它，模型就只能
   * 靠搜索去撞 —— 而 09-11 实测模型 39 次该搜有 38 次压根没搜。
   *
   * 2026-09-17 首测：23 组里 6 组无覆盖，其中 4 组是真缺口（local / library / note /
   * ue.input，共 8 个工具），已分别补进 local-files、asset-library、
   * knowledge-base-and-projects、ue-editor-inspection 四个已有技能的正文。
   *
   * 剩下 `host` 允许不被覆盖：宿主交互工具默认常驻、不参与折叠。
   */
  it('每个按需工具组都至少被一个技能引用到', async () => {
    const resident = residentNames()
    const groups = new Set<string>()
    for (const tool of catalog) if (!resident.has(tool.name)) groups.add(toolSearchGroup(tool))
    const covered = new Set<string>()
    for (const skill of skills as { name: string }[]) {
      const search = createToolSearch(catalog, () => catalog)
      const loader = createSkillTools(skills, 'off', search.loadFromSkill).find(
        (tool) => tool.name === 'load_skill'
      )!
      const before = new Set(search.getTools().map((tool) => tool.name))
      await loader.execute('coverage', { name: skill.name })
      for (const tool of search.getTools())
        if (!before.has(tool.name) && !resident.has(tool.name)) covered.add(toolSearchGroup(tool))
    }
    // 常驻的宿主交互组不走折叠，不需要技能带它们
    const uncovered = [...groups].filter((g) => !covered.has(g) && g !== 'host')
    expect(
      uncovered.sort(),
      `这些工具组没有任何技能引用得到，模型只能靠 search_tools 撞：${uncovered.join('、')}。` +
        '在语义最接近的已有技能正文里加一段真正的引导（不是堆工具名），' +
        '或者说明为什么这一组只配走兜底。'
    ).toEqual([])
  })

  it.each([
    ['ue-material-authoring', 'ue.material'],
    ['ue-blueprint-graph-editing', 'ue.blueprint'],
    ['ue-actor-placement', 'ue.actor']
  ])('真实 %s 加载后直接提供整个 %s 组', async (name, group) => {
    const search = createToolSearch(catalog, () => catalog)
    const loader = createSkillTools(skills, 'off', search.loadFromSkill).find(
      (tool) => tool.name === 'load_skill'
    )!
    const result = await loader.execute('skill', { name })
    const members = catalog.filter((tool) => toolSearchGroup(tool) === group)
    expect(members.length).toBeGreaterThan(1)
    expect(search.getTools()).toEqual(expect.arrayContaining(members))
    const details = result.details as { toolSearch?: { loadedToolNames?: string[] } }
    expect(details.toolSearch?.loadedToolNames).toEqual(
      expect.arrayContaining(members.map((tool) => tool.name))
    )
    if (process.env.TOOL_SEARCH_MEASURE === '1')
      console.info('TOOL_SEARCH_SKILL', name, JSON.stringify(result.details))
  })

  it('常驻也服从断连、只读、子任务和白名单，MCP 不自动常驻', async () => {
    for (const overrides of [
      { ueConnected: false },
      { readOnly: true },
      { isSubAgent: true },
      { toolNames: ['web_read'] }
    ]) {
      const tools = resolveAgentTools({ ...ctx, ...overrides }, [], task)
      // 默认没有领域工具常驻，这里把几个设成常驻，才测得到它们也服从过滤
      const forced = Object.fromEntries(
        ['web_read', 'ue_save', 'ue_get_actor', 'run_shell_command'].map((n) => [n, true])
      )
      const search = createToolSearch(tools, () => tools, forced)
      const names = search.getTools().map((tool) => tool.name)
      expect(
        search
          .getTools()
          .filter((tool) => tool.name !== 'search_tools')
          .every((tool) => tools.includes(tool))
      ).toBe(true)
      if ('ueConnected' in overrides)
        expect(
          search
            .getTools()
            .filter((tool) => tool.unrealBox.namespace.startsWith('ue.'))
            .every((tool) => OFFLINE_UE_TOOLS.has(tool.name))
        ).toBe(true)
      if ('readOnly' in overrides)
        expect(search.getTools().every((tool) => tool.unrealBox.risk === 'safe')).toBe(true)
      if ('isSubAgent' in overrides) expect(names).not.toEqual(expect.arrayContaining(['task']))
      if ('isSubAgent' in overrides)
        for (const name of [
          ...BROWSER_TOOL_NAMES,
          'ask_user',
          'voice_report',
          'set_session_project',
          'update_plan',
          'wrap_up'
        ])
          expect(names).not.toContain(name)
      if ('toolNames' in overrides) expect(names).toEqual(['search_tools', 'web_read'])
    }
    const external = {
      ...catalog[0],
      name: 'mcp_example_tool',
      unrealBox: { namespace: 'mcp.example', risk: 'safe' as const }
    }
    const tools = [...catalog, external]
    const search = createToolSearch(tools, () => tools)
    expect(search.getTools()).not.toContain(external)
    await search.tool.execute('load', { names: [external.name] })
    expect(search.getTools()).toContain(external)
  })

  it('测量完整真实定义，包含 task 与现造工具', async () => {
    const tools = resolveAgentTools(ctx, skills, task)
    const initial = createToolSearch(tools, () => tools).getTools()
    const coreBytes = initial.reduce((sum, tool) => sum + toolDefinitionBytes(tool), 0)
    // 默认常驻只剩加载入口和宿主交互工具；有人往默认常驻里加东西，这条线先响
    expect(coreBytes).toBeLessThan(14_000)
    if (process.env.TOOL_SEARCH_MEASURE !== '1') return
    const [cl100k, o200k] = await Promise.all([
      import('gpt-tokenizer/encoding/cl100k_base'),
      import('gpt-tokenizer/encoding/o200k_base')
    ])
    const count = (text: string): number =>
      Math.max(cl100k.encode(text).length, o200k.encode(text).length)
    const sum = (list: UnrealAgentTool<never>[]): number =>
      list.reduce(
        (total, tool) =>
          total +
          count(
            JSON.stringify({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters
            })
          ),
        0
      )
    const prompt = buildSystemPrompt(ctx, skills)
    console.info(
      'TOOL_SEARCH_MEASURE',
      JSON.stringify({
        taskTokens: sum([task]),
        initialCount: initial.length,
        initialBytes: coreBytes,
        initialToolTokens: sum(initial),
        initialPrefixTokens: sum(initial) + count(prompt + TOOL_SEARCH_RULES),
        fullCount: tools.length,
        fullPrefixTokens: sum(tools) + count(prompt)
      })
    )
  })

  it.each([
    ['创建材质实例', 'material_create_instance'],
    ['查看材质节点连线', 'material_get_graph'],
    ['调整材质实例参数', 'material_set_param'],
    ['整理材质节点布局', 'material_tidy_graph'],
    ['compile blueprint', 'blueprint_compile'],
    ['蓝图添加变量', 'blueprint_add_variable'],
    ['按文件名查找 fbx', 'find_local_files'],
    ['网页搜索', 'web_search'],
    // 真机上模型没搜、直接写了 Python（2026-10-13 反馈）；钉住这条搜得到
    ['新建增强输入动作', 'ue_input_add_mapping'],
    ['灯光阴影普查', 'ue_light_census'],
    // 以前技能让模型写 Python 的 set_convex_decomposition_collisions；现在要搜得到工具
    ['凸包分解生成碰撞', 'mesh_optimize'],
    // 改 C++ 成员前查波及面；以前技能说「没工具，全量编译看谁报错」
    ['哪些蓝图用到了这个函数', 'blueprint_find_usages']
  ])('%s 应能加载 %s', async (query, expected) => {
    expect(
      catalog.some((tool) => tool.name === expected),
      `样本工具已改名：${expected}`
    ).toBe(true)
    const search = createToolSearch(catalog, () => catalog)
    const result = await search.tool.execute('probe', { query })
    expect(loadedNames(result)).toContain(expected)
  })

  /*
   * 灯光普查是按需子组：不常驻、不跟 ue.level 整组走（那组有开关卡、存关卡这些写操作），
   * 而项目体检技能一加载就把它带上 —— 渲染线程 / GPU 瓶颈的排查正是从那里进来的
   */
  it('ue_light_census 自成按需子组，由项目体检技能带上', async () => {
    const census = catalog.find((tool) => tool.name === 'ue_light_census')!
    expect(census).toBeDefined()
    expect(toolSearchGroup(census)).toBe('ue.level.lights')
    expect(residentNames().has('ue_light_census')).toBe(false)
    expect(groupDomainTerms('ue.level.lights')).toContain('灯光')

    const search = createToolSearch(catalog, () => catalog)
    const loader = createSkillTools(skills, 'off', search.loadFromSkill).find(
      (tool) => tool.name === 'load_skill'
    )!
    await loader.execute('skill', { name: 'ue-project-audit' })
    expect(search.getTools().map((tool) => tool.name)).toContain('ue_light_census')
  })

  /*
   * mesh_optimize 和 mesh_describe 同属 ue.mesh 命名空间，但单成按需子组，
   * 由几何编辑技能（和导入整理技能）点名带上。
   */
  it('mesh_optimize 自成按需子组，由几何编辑技能带上', async () => {
    const optimize = catalog.find((tool) => tool.name === 'mesh_optimize')!
    expect(optimize).toBeDefined()
    expect(optimize.unrealBox.namespace).toBe('ue.mesh')
    expect(toolSearchGroup(optimize)).toBe('ue.mesh.optimize')
    expect(residentNames().has('mesh_optimize')).toBe(false)
    expect(groupDomainTerms('ue.mesh.optimize')).toContain('凸包')

    for (const name of ['ue-geometry-editing', 'ue-content-import-organize']) {
      const search = createToolSearch(catalog, () => catalog)
      const loader = createSkillTools(skills, 'off', search.loadFromSkill).find(
        (tool) => tool.name === 'load_skill'
      )!
      await loader.execute('skill', { name })
      expect(
        search.getTools().map((tool) => tool.name),
        `${name} 加载后应带上 mesh_optimize`
      ).toContain('mesh_optimize')
    }
  })

  /*
   * blueprint_find_usages 属 ue.blueprint 命名空间，但单成按需子组：search_tools 按「谁在用」
   * 命中时可以只加载它，不必连带二十多个写图工具（蓝图组是最大的一组）。
   * 由 C++ 工作流和蓝图编辑两个技能点名带上；
   * 搜得到它由上面 it.each 的「哪些蓝图用到了这个函数」那条钉住。
   */
  it('blueprint_find_usages 自成按需子组，由 C++ 和蓝图编辑技能带上', async () => {
    const usages = catalog.find((tool) => tool.name === 'blueprint_find_usages')!
    expect(usages).toBeDefined()
    expect(usages.unrealBox.namespace).toBe('ue.blueprint')
    expect(usages.unrealBox.risk).toBe('safe')
    expect(toolSearchGroup(usages)).toBe('ue.blueprint.usages')
    expect(residentNames().has('blueprint_find_usages')).toBe(false)
    expect(groupDomainTerms('ue.blueprint.usages')).toContain('哪些蓝图')

    for (const name of ['ue-cpp-workflow', 'ue-blueprint-graph-editing']) {
      const search = createToolSearch(catalog, () => catalog)
      const loader = createSkillTools(skills, 'off', search.loadFromSkill).find(
        (tool) => tool.name === 'load_skill'
      )!
      await loader.execute('skill', { name })
      const loaded = search.getTools().map((tool) => tool.name)
      expect(loaded, `${name} 加载后应带上 blueprint_find_usages`).toContain(
        'blueprint_find_usages'
      )
    }
  })

  it('泛称本地文件搜索时至少提供文件名查找或文件内容搜索', async () => {
    const search = createToolSearch(catalog, () => catalog)
    const result = await search.tool.execute('probe', { query: '本地文件搜索' })
    expect(
      loadedNames(result).some((name) => ['find_local_files', 'grep_local_files'].includes(name))
    ).toBe(true)
  })
})
