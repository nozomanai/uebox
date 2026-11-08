import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'

const root = mkdtempSync(join(tmpdir(), 'agent-v3-skills-'))

vi.mock('electron', () => ({
  app: {
    getPath: (): string => root,
    getAppPath: (): string => root,
    isPackaged: false
  }
}))

import { discoverSkills } from '../../agent-v3/capabilities/skillsService/SkillsService'
import {
  applySkillLearningMode,
  buildSkillLearningSection,
  buildSkillsSection,
  createSkillTools,
  discoverEnabledSkills,
  isUserSkillPath,
  listSkillSummaries,
  readDisabledSkills,
  readSkillDocument,
  setSkillDisabled,
  skillBodyVisible,
  SKILL_CREATOR_NAME,
  userSkillsDir,
  writeSkillDocument
} from './skills'

afterAll(() => rmSync(root, { recursive: true, force: true }))

const SKILL_DIR = join(root, 'skills')

function writeSkill(name: string, description: string, body: string): void {
  const dir = join(SKILL_DIR, name)
  mkdirSync(join(dir, 'references'), { recursive: true })
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`,
    'utf8'
  )
  writeFileSync(
    join(dir, 'references', 'notes.md'),
    '先调 blueprint.get_graph 拿到 node_id。',
    'utf8'
  )
}

writeSkill(
  'ue-blueprint-graph-wiring',
  '连蓝图执行流，用 blueprint.connect_pins 落地。什么时候用：入口节点已经定下来之后。不要用于修编译错误。',
  '# 流程\n\n1. 用 blueprint.get_graph 拿真实 node_id\n2. 用 blueprint.add_node 加节点\n3. blueprint.compile 编译'
)
writeSkill('ue-material-create-pbr', '创建 PBR 材质。', '# 流程\n\n用 material.create 起手。')
writeSkill(
  'ue-content-import',
  'Import content into a known /Game/... destination. Use when staging a fresh batch.',
  '# 流程\n\n先建目录。'
)

writeSkill(
  SKILL_CREATOR_NAME,
  '把验证过的经验沉淀成可复用的 skill。Use when 用户说「把这次经验沉淀成技能」。',
  '# 流程\n\n先提案，后写入。'
)

const skills = await discoverSkills([SKILL_DIR])
const tools = createSkillTools(skills)
const loadSkillTool = tools.find((t) => t.name === 'load_skill')!
const readResourceTool = tools.find((t) => t.name === 'read_skill_resource')!

describe('buildSkillsSection', () => {
  it('列出全部技能的 name + description', () => {
    const section = buildSkillsSection(skills)
    expect(section).toContain('ue-blueprint-graph-wiring')
    expect(section).toContain('ue-material-create-pbr')
  })

  it('description 里的点号工具名也要重写', () => {
    // 清单常驻 system prompt，这里留着旧名字，模型第一眼看到的就是错的
    const section = buildSkillsSection(skills)
    // connect_pins 已下线，映射指向接替它的 blueprint_apply_graph
    expect(section).toContain('blueprint_apply_graph')
    expect(section).not.toContain('blueprint.connect_pins')
  })

  it('没有技能时不产出空章节', () => {
    expect(buildSkillsSection([])).toBe('')
  })

  it('把用户显式选择的 $技能名 解释为必须先加载', () => {
    const section = buildSkillsSection(skills)
    expect(section).toContain('user writes `$<skill-name>`')
    expect(section).toContain('call `load_skill` with')
  })

  /**
   * 清单要用 `<available_skills>` 划出边界。
   *
   * 50 条清单不封口的话，模型分不清「清单在哪结束、指令从哪继续」——
   * 排在它后面的 `<environment>` 很容易被读成第 51 条 skill。
   */
  it('清单被 <available_skills> 包住', () => {
    const section = buildSkillsSection(skills)
    expect(section).toContain('<available_skills>')
    expect(section).toContain('</available_skills>')
  })

  /**
   * 触发条件和负向边界必须原样进清单。
   *
   * 这里一度只取第一句来省 token，结果把唯一能分开相邻 skill 的那段删了：
   * description 写成「做什么。Use when……。Do not use for……」，句子边界正好
   * 落在「做什么」之后 —— 12 个内置 skill 100% 丢掉后两段，模型看到的十二条
   * 能力概述几乎无从区分。
   */
  it('描述里的触发条件和负向边界都要进清单', () => {
    const section = buildSkillsSection(skills)

    expect(section).toContain('连蓝图执行流')
    expect(section).toContain('什么时候用')
    expect(section).toContain('不要用于修编译错误')
  })

  // 界面清单仍然只要第一句 —— 两边的取舍不一样，不能一起改
  it('界面清单不受影响，仍然只取第一句', () => {
    const summary = listSkillSummaries(skills).find((s) => s.name === 'ue-blueprint-graph-wiring')

    expect(summary?.description).toContain('连蓝图执行流')
    expect(summary?.description).not.toContain('不要用于修编译错误')
  })

  // 有个内置 skill 的描述里写了 /Game/...，按「句号即断句」会被砍成半句
  it('/Game/... 这类写法不会被当成句号切断', () => {
    expect(buildSkillsSection(skills)).toContain('/Game/... destination.')
  })

  // 上限只防用户/插件目录里没有节制的描述，合规的（≤1024）一个都不该被动
  it('超长描述才截断，合规长度原样保留', async () => {
    const longDir = join(root, 'long-skills')
    mkdirSync(join(longDir, 'long-skill'), { recursive: true })
    writeFileSync(
      join(longDir, 'long-skill', 'SKILL.md'),
      `---\nname: long-skill\ndescription: ${'很长的描述。'.repeat(300)}\n---\n`,
      'utf8'
    )

    const section = buildSkillsSection(await discoverSkills([longDir]))
    const line = section.split('\n').find((l) => l.startsWith('- long-skill:'))!

    expect(line.length).toBeLessThan(1100)
    expect(line.endsWith('…')).toBe(true)
  })
})

describe('skill summaries', () => {
  it('只暴露界面所需字段，并保留用户/插件/内置来源', async () => {
    const pluginDir = join(root, 'plugin-skills')
    const pluginSkillDir = join(pluginDir, 'plugin-skill')
    mkdirSync(pluginSkillDir, { recursive: true })
    writeFileSync(
      join(pluginSkillDir, 'SKILL.md'),
      '---\nname: plugin-skill\ndescription: 插件技能。后续说明不进菜单。\n---\n',
      'utf8'
    )

    const discovered = await discoverSkills([SKILL_DIR, pluginDir], ['user', 'plugin'])
    const summaries = listSkillSummaries(discovered)

    expect(summaries.find((item) => item.name === 'ue-material-create-pbr')?.source).toBe('user')
    expect(summaries.find((item) => item.name === 'plugin-skill')).toEqual({
      name: 'plugin-skill',
      description: '插件技能。',
      source: 'plugin',
      enabled: true
    })
    expect(summaries.some((item) => 'path' in item)).toBe(false)
  })

  // 关掉的仍然要在清单里，只是标成关的 —— 不列出来，用户就没法再打开它
  it('关掉的技能照样列出来，只是 enabled 为 false', () => {
    const summaries = listSkillSummaries(skills, new Set(['ue-material-create-pbr']))

    expect(summaries.find((s) => s.name === 'ue-material-create-pbr')?.enabled).toBe(false)
    expect(summaries.find((s) => s.name === 'ue-content-import')?.enabled).toBe(true)
    expect(summaries).toHaveLength(skills.length)
  })
})

describe('load_skill', () => {
  it('正文和附带资源都在旧工具名重写后触发加载，并保留完整正文及加载记录', async () => {
    const loadTools = vi.fn((content: string) => ({
      text: `整组已加载：${content.length}`,
      details: { loadedToolNames: ['blueprint_get_graph'], loadedGroups: ['ue.blueprint'] }
    }))
    const wired = createSkillTools(skills, 'off', loadTools)
    for (const [name, args] of [
      ['load_skill', { name: 'ue-blueprint-graph-wiring' }],
      [
        'read_skill_resource',
        { name: 'ue-blueprint-graph-wiring', relativePath: 'references/notes.md' }
      ]
    ] as const) {
      const result = await wired.find((tool) => tool.name === name)!.execute('load', args)
      // 加载记录跟着 details 落盘，下一条消息靠它把工具装回来（toolSearch.ts 的 restore）
      expect(result.details).toMatchObject({
        toolSearch: { loadedToolNames: ['blueprint_get_graph'], loadedGroups: ['ue.blueprint'] }
      })
      expect(JSON.stringify(result.content)).toContain('拿')
    }
    expect(loadTools).toHaveBeenCalledTimes(2)
    for (const call of loadTools.mock.calls) {
      expect(call[0]).toContain('blueprint_get_graph')
      expect(call[0]).not.toContain('blueprint.get_graph')
    }
  })

  it('返回 SKILL.md 正文', async () => {
    const result = await loadSkillTool.execute('c1', { name: 'ue-blueprint-graph-wiring' })
    const text = (result.content[0] as { text: string }).text

    expect(text).toContain('# 流程')
    expect(text).toContain('拿真实 node_id')
  })

  // 53 个内置 skill 里有 13 个引用点号工具名。不重写的话，模型会照着
  // 技能的指示去调 blueprint.get_graph，而注册的是 blueprint_get_graph。
  it('正文里的点号工具名全部重写成下划线', async () => {
    const result = await loadSkillTool.execute('c1', { name: 'ue-blueprint-graph-wiring' })
    const text = (result.content[0] as { text: string }).text

    expect(text).toContain('blueprint_get_graph')
    expect(text).toContain('blueprint_apply_graph')
    expect(text).toContain('blueprint_compile')
    expect(text).not.toMatch(/blueprint\.[a-z_]+/)
  })

  /**
   * skill 不是写完就定死的。`ue-skill-creator` 早就写了「更新」该怎么做，
   * 缺的是有人叫它去做 —— 没有这句话，agent 照着一条过时的 skill 撞了墙，
   * 会绕过去接着干，那条 skill 继续错着等下一个人。
   */
  it('正文后面跟一句「照着走发现不对就回头改」', async () => {
    const result = await loadSkillTool.execute('c1', { name: 'ue-blueprint-graph-wiring' })
    const text = (result.content[0] as { text: string }).text

    // 两个触发条件都要在：被证伪，以及「没说到你撞上的这个情况」——
    // 只有前者的话，一条从单次经验沉淀出来的 skill 永远只会被纠错，不会被补全
    expect(text).toContain('proven wrong')
    expect(text).toContain('silent on the case you hit')
    // 门槛必须写死在「有具体的事发生了」这一档，否则模型会开始提措辞改进意见
    expect(text).toContain('not a reason')
  })

  // 关档时 ue-skill-creator 根本不在清单里，叫模型去改它只会让它手搓一个改法
  it('沉淀关档时不追那句话', async () => {
    const offTool = createSkillTools(skills, 'off').find((t) => t.name === 'load_skill')!
    const result = await offTool.execute('c1', { name: 'ue-blueprint-graph-wiring' })
    const text = (result.content[0] as { text: string }).text

    expect(text).toContain('# 流程')
    expect(text).not.toContain('proven wrong')
  })

  it('frontmatter 不进正文', async () => {
    const result = await loadSkillTool.execute('c1', { name: 'ue-blueprint-graph-wiring' })
    const text = (result.content[0] as { text: string }).text

    expect(text).not.toContain('description:')
    expect(text).not.toContain('---')
  })

  it('技能不存在时抛出，并列出可选项', async () => {
    // 只返回错误对象的话 pi 会当成功；而不给可选项模型只能反复猜
    await expect(loadSkillTool.execute('c1', { name: '不存在的技能' })).rejects.toThrow(
      /ue-blueprint-graph-wiring/
    )
  })
})

/**
 * 真机上 game-jam 五轮里加载了四次：每次正文都作为最新的工具结果进上下文，
 * 模型就从「先问五个问题」重来一遍，用户答过的全白答。
 */
describe('重复加载去重', () => {
  const NAME = 'ue-blueprint-graph-wiring'

  /** 按 pi 落盘的样子包一条工具结果 */
  function asToolResult(
    result: { content: unknown[]; details?: unknown },
    extra: Record<string, unknown> = {}
  ): Record<string, unknown> {
    return {
      role: 'toolResult',
      toolCallId: 't1',
      toolName: 'load_skill',
      content: result.content,
      details: result.details,
      isError: false,
      ...extra
    }
  }

  function wiredWith(
    view: () => unknown[],
    loadTools = vi.fn(() => ({ text: '', details: {} }))
  ): { load: (typeof tools)[number]; loadTools: typeof loadTools } {
    const wired = createSkillTools(skills, 'ask', loadTools, {
      bodyVisible: (name, content) => skillBodyVisible(view(), name, content)
    })
    return { load: wired.find((t) => t.name === 'load_skill')!, loadTools }
  }

  it('正文还在上下文里：第二次只回一句话，不再贴正文，工具照常补加载', async () => {
    let view: unknown[] = []
    const { load, loadTools } = wiredWith(() => view)

    const first = await load.execute('c1', { name: NAME })
    expect((first.content[0] as { text: string }).text).toContain('# 流程')
    view = [asToolResult(first)]

    const second = await load.execute('c2', { name: NAME })
    const text = (second.content[0] as { text: string }).text
    expect(text).not.toContain('# 流程')
    expect(text).not.toContain('proven wrong')
    expect(text).toContain('已经加载过')
    expect(text).toContain('不要再问')
    expect(second.details).toMatchObject({ skillName: NAME, alreadyLoaded: true })
    expect(loadTools).toHaveBeenCalledTimes(2)
  })

  it('那一次「不再重复」的回执本身不算正文：正文被压掉后照样能重新加载', async () => {
    let view: unknown[] = []
    const { load } = wiredWith(() => view)
    const first = await load.execute('c1', { name: NAME })
    view = [asToolResult(first)]
    const second = await load.execute('c2', { name: NAME })
    // 压缩把第一次的正文换成了摘要，只剩那条短回执
    view = [{ role: 'user', content: '（摘要）' }, asToolResult(second)]

    const third = await load.execute('c3', { name: NAME })
    expect((third.content[0] as { text: string }).text).toContain('# 流程')
  })

  it.each([
    ['正文已被压缩进摘要', () => [{ role: 'user', content: [{ type: 'text', text: '（摘要）' }] }]],
    [
      '上下文里是另一个技能',
      () => [
        {
          role: 'toolResult',
          toolName: 'load_skill',
          isError: false,
          details: { skillName: 'ue-material-create-pbr' },
          content: [{ type: 'text', text: '# 流程\n\n用 material_create 起手。' }]
        }
      ]
    ],
    [
      '那次加载失败了',
      () => [
        {
          role: 'toolResult',
          toolName: 'load_skill',
          isError: true,
          details: { skillName: NAME },
          content: [{ type: 'text', text: '技能不存在' }]
        }
      ]
    ],
    [
      '大结果存档把正文换成了存根',
      () => [
        {
          role: 'toolResult',
          toolName: 'load_skill',
          isError: false,
          details: { skillName: NAME },
          content: [{ type: 'text', text: '[结果已存档，用 query_result 查看]' }]
        }
      ]
    ]
  ])('%s：照常给全文', async (_label, view) => {
    const { load } = wiredWith(view)
    const result = await load.execute('c1', { name: NAME })
    expect((result.content[0] as { text: string }).text).toContain('# 流程')
    expect(result.details).not.toHaveProperty('alreadyLoaded')
  })

  it('不给接缝（外部 MCP 宿主）：每次都给全文', async () => {
    const plain = createSkillTools(skills, 'ask').find((t) => t.name === 'load_skill')!
    for (const id of ['c1', 'c2']) {
      const result = await plain.execute(id, { name: NAME })
      expect((result.content[0] as { text: string }).text).toContain('# 流程')
    }
  })
})

describe('read_skill_resource', () => {
  it('读取 references/ 下的文件并重写工具名', async () => {
    const result = await readResourceTool.execute('c1', {
      name: 'ue-blueprint-graph-wiring',
      relativePath: 'references/notes.md'
    })
    const text = (result.content[0] as { text: string }).text

    expect(text).toContain('blueprint_get_graph')
    expect(text).not.toContain('blueprint.get_graph')
  })

  it('路径穿越被拒', async () => {
    await expect(
      readResourceTool.execute('c1', {
        name: 'ue-blueprint-graph-wiring',
        relativePath: '../../../etc/passwd'
      })
    ).rejects.toThrow()
  })

  it('文件不存在时抛出，并带上可用资源清单', async () => {
    await expect(
      readResourceTool.execute('c1', {
        name: 'ue-blueprint-graph-wiring',
        relativePath: 'references/nope.md'
      })
    ).rejects.toThrow(/notes\.md|可用资源|没有附带资源/)
  })
})

describe('skill 工具的元数据', () => {
  it('都是只读，不触发审批', () => {
    for (const tool of tools) {
      expect(tool.unrealBox.risk).toBe('safe')
      expect(tool.unrealBox.namespace).toBe('core')
    }
  })

  it('没有技能时不注册这两个工具', () => {
    expect(createSkillTools([])).toEqual([])
  })
})

/**
 * 针对**真实内置 skill**（`resources/skills`）的检查。
 *
 * 上面的用例用的是临时目录里的假 skill；这一组直接读仓库里真正会打包进产物的
 * 那批，确保重写规则覆盖到了实际用到的每一个工具名。新增 skill 时如果引用了
 * 一个没登记进重命名表的点号工具名，这里会失败。
 *
 * 目前内置 skill 是**空的** —— 原来那 50 条是从 V2 工具直转过来的，
 * 其中 32 条在指挥 `ue_python` / `ue_reviewer` 这些 V3 里不存在的 V2 专家，
 * 已整批删除，等真机验证完再按验证结果重写。所以这里不断言数量，
 * 只断言「有多少条就查多少条」—— 重写时这道门禁要立刻生效，
 * 而不是等攒够 40 条才开始起作用。
 */
describe('内置 skill 的工具名重写覆盖度', () => {
  const builtinDir = join(process.cwd(), 'resources', 'skills')

  it('重写后没有任何点号工具名残留', async () => {
    const builtin = await discoverSkills([builtinDir])

    const builtinTools = createSkillTools(builtin)
    const load = builtinTools.find((t) => t.name === 'load_skill')!

    const stale: string[] = []
    for (const skill of builtin) {
      const result = await load.execute('c', { name: skill.name })
      const text = (result.content[0] as { text: string }).text
      const hit = text.match(/\b(blueprint|material|widget)\.[a-z_]+/g)
      if (hit) stale.push(`${skill.name}: ${[...new Set(hit)].join(', ')}`)

      const descHit = buildSkillsSection([skill]).match(/\b(blueprint|material|widget)\.[a-z_]+/g)
      if (descHit) stale.push(`${skill.name}(description): ${[...new Set(descHit)].join(', ')}`)
    }

    expect(stale).toEqual([])
  }, 30_000)
})

/**
 * 技能沉淀的三档开关。
 *
 * 关档必须是**真的看不到** —— 留在清单里再叫模型别用，既照付 token
 * 又时灵时不灵；自动档必须**明说覆盖** —— `ue-skill-creator` 正文写死了
 * 「先提案，后写入」，不覆盖的话用户选了自动档等于没选。
 */
describe('技能沉淀档位', () => {
  it('关档时 ue-skill-creator 整条从清单里消失', () => {
    const trimmed = applySkillLearningMode(skills, 'off')
    expect(trimmed.some((s) => s.name === SKILL_CREATOR_NAME)).toBe(false)
    // 只删这一条，别的 skill 一个不动
    expect(trimmed).toHaveLength(skills.length - 1)
    expect(buildSkillsSection(trimmed)).not.toContain(SKILL_CREATOR_NAME)
  })

  it.each(['ask', 'auto'] as const)('%s 档保留完整清单', (mode) => {
    expect(applySkillLearningMode(skills, mode)).toHaveLength(skills.length)
  })

  it('关档时不产出任何沉淀说明', () => {
    expect(buildSkillLearningSection(skills, 'off')).toBe('')
  })

  // 模型不知道用户 skill 存在哪，写出来的文件不会被加载 —— 两档都要给路径
  it.each(['ask', 'auto'] as const)('%s 档把用户 skill 目录写进提示词', (mode) => {
    expect(buildSkillLearningSection(skills, mode)).toContain(userSkillsDir())
  })

  it('只有自动档才说「不用先问」', () => {
    expect(buildSkillLearningSection(skills, 'auto')).toContain('propose first')
    expect(buildSkillLearningSection(skills, 'ask')).not.toContain('propose first')
  })

  // 这台机器上没装那个 skill 时，说了也没用，反而占 token
  it('清单里没有 ue-skill-creator 时整段不出现', () => {
    const without = skills.filter((s) => s.name !== SKILL_CREATOR_NAME)
    expect(buildSkillLearningSection(without, 'auto')).toBe('')
  })

  it('缺省按 ask —— 不传档位不该退成关档', () => {
    expect(buildSkillLearningSection(skills)).toContain(userSkillsDir())
  })
})

/**
 * 删除是不可逆的，而这个目录的同层放着 `ai-provider-secrets.bin`。
 * 判定错一次，用户丢的不只是一条技能。
 */
describe('只删用户目录里的技能', () => {
  it('用户目录下的子目录算', () => {
    expect(isUserSkillPath(join(userSkillsDir(), 'my-skill'))).toBe(true)
  })

  it('用户目录本身不算 —— 别把整个目录当成一条技能删掉', () => {
    expect(isUserSkillPath(userSkillsDir())).toBe(false)
  })

  it('同层的兄弟目录不算，即使名字以它开头', () => {
    expect(isUserSkillPath(`${userSkillsDir()}-backup`)).toBe(false)
  })

  it('用 .. 爬出去的不算 —— 名字是渲染层给的，不能直接拼进路径', () => {
    expect(isUserSkillPath(join(userSkillsDir(), '..', 'ai-provider-secrets.bin'))).toBe(false)
    expect(isUserSkillPath(join(userSkillsDir(), 'a', '..', '..', 'elsewhere'))).toBe(false)
  })

  it('内置技能目录不算 —— 那些随包发，用户删不掉也不该删', () => {
    expect(isUserSkillPath(join(root, 'resources', 'skills', 'ue-blueprint-graph-wiring'))).toBe(
      false
    )
  })
})

/**
 * 「这个技能加不加载」的开关。
 *
 * 失效的方向只能是「多关掉」，不能是「悄悄还开着」—— 所以过滤放在
 * `discoverEnabledSkills()` 里，任何新的 agent 路径默认只拿到开着的那些。
 */
describe('技能开关', () => {
  it('默认一个都没关', async () => {
    expect([...(await readDisabledSkills())]).toEqual([])
  })

  it('关掉之后 discoverEnabledSkills 里就没有它了，盘上那份还在', async () => {
    await setSkillDisabled('ue-material-create-pbr', true)

    const enabled = await discoverEnabledSkills()
    expect(enabled.some((s) => s.name === 'ue-material-create-pbr')).toBe(false)
    // 清单页读的是盘上全部，关掉的必须还能被列出来
    expect(await readSkillDocument('ue-material-create-pbr')).not.toBeNull()
  })

  it('再打开就回来了', async () => {
    await setSkillDisabled('ue-material-create-pbr', false)
    const enabled = await discoverEnabledSkills()
    expect(enabled.some((s) => s.name === 'ue-material-create-pbr')).toBe(true)
  })

  it('文件坏了按「一个都没关」算 —— 宁可多加载，不能让 agent 突然什么都不会', async () => {
    writeFileSync(join(root, 'disabled-skills.json'), '{ 这不是 JSON', 'utf8')
    expect([...(await readDisabledSkills())]).toEqual([])
    rmSync(join(root, 'disabled-skills.json'), { force: true })
  })
})

/**
 * 详情弹窗里的读与写。
 *
 * 校验那几条不是形式主义：发现流程对写坏的 SKILL.md 是**静默跳过**的，
 * 不挡在保存这一步，用户改完回到清单会发现技能没了 —— 没有报错，没有线索。
 */
describe('技能正文的读与写', () => {
  it('读出来的是全文，含 frontmatter —— description 那行决定它什么时候被用上', async () => {
    const doc = await readSkillDocument('ue-content-import')

    expect(doc?.content).toContain('name: ue-content-import')
    expect(doc?.content).toContain('description:')
    expect(doc?.content).toContain('先建目录')
  })

  it('技能不存在时返回 null', async () => {
    expect(await readSkillDocument('没有这个技能')).toBeNull()
  })

  it('改用户自己的那份是原地改', async () => {
    const before = await readSkillDocument('ue-content-import')
    const next = `${before!.content}\n改了一行。\n`

    expect(await writeSkillDocument('ue-content-import', next)).toEqual({
      success: true,
      source: 'user'
    })
    expect((await readSkillDocument('ue-content-import'))?.content).toContain('改了一行。')
  })

  it('没有 frontmatter 直接拒 —— 存下去这条技能会从清单上无声消失', async () => {
    const result = await writeSkillDocument('ue-content-import', '# 只有正文，没有开头那段')

    expect(result.success).toBe(false)
    expect((result as { error: string }).error).toContain('frontmatter')
  })

  it('frontmatter 里的 name 和正在编辑的对不上也拒', async () => {
    const result = await writeSkillDocument(
      'ue-content-import',
      '---\nname: 别的名字\ndescription: x\n---\n\n正文\n'
    )

    expect(result.success).toBe(false)
    expect((result as { error: string }).error).toContain('别的名字')
  })

  // 名字是渲染层给的，会成为目录名；同层放着 ai-provider-secrets.bin
  it('名字里带路径符号的一律拒', async () => {
    for (const bad of ['../escape', 'a/b', '..']) {
      expect((await writeSkillDocument(bad, '---\nname: x\n---\n')).success).toBe(false)
    }
  })
})

/**
 * 工程自带的 skill（`<工程根>/.uebox/skills`）。
 *
 * 那次数字人动作导入：工程 `Scripts/` 里现成的导入脚本 agent 从没看见过 ——
 * 跨工程的目录放不下只属于一个工程的做法，所以工程自己得有一层。
 */
describe('工程自带的 skill', () => {
  const projectRoot = join(root, 'MyProject')
  const projectSkill = (name: string, description: string): void => {
    const dir = join(projectRoot, '.uebox', 'skills', name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: ${description}\n---\n\n正文\n`
    )
  }
  projectSkill('doubao-motion-import', '导入数字人动作。')
  // 和用户目录里那条同名：工程的要胜出
  projectSkill('ue-content-import', '本工程的导入规矩。')

  it('给了工程路径才会出现，来源标成 project', async () => {
    const without = await discoverEnabledSkills()
    expect(without.some((s) => s.name === 'doubao-motion-import')).toBe(false)

    const withProject = await discoverEnabledSkills(projectRoot)
    const found = withProject.find((s) => s.name === 'doubao-motion-import')
    expect(found?.source).toBe('project')
  })

  it('给 .uproject 文件路径也认', async () => {
    const skills = await discoverEnabledSkills(join(projectRoot, 'MyProject.uproject'))
    expect(skills.some((s) => s.name === 'doubao-motion-import')).toBe(true)
  })

  it('同名时工程的盖过用户的', async () => {
    const skills = await discoverEnabledSkills(projectRoot)
    const hits = skills.filter((s) => s.name === 'ue-content-import')
    expect(hits).toHaveLength(1)
    expect(hits[0].source).toBe('project')
    expect(hits[0].description).toBe('本工程的导入规矩。')
  })
})
