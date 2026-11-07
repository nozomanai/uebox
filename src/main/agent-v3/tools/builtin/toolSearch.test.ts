import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { defineTool, type UnrealAgentTool } from '../defineTool'
import { createToolSearch, toolDefinitionBytes } from './toolSearch'

function tool(
  name: string,
  namespace = 'ue.material',
  description = '材质颜色 roughness'
): UnrealAgentTool<never> {
  return defineTool({
    name,
    namespace,
    description,
    risk: 'safe',
    input: z.object({ value: z.number().default(1) }),
    execute: async () => ({ text: 'ok' })
  }) as unknown as UnrealAgentTool<never>
}

async function search(
  controller: ReturnType<typeof createToolSearch>,
  args: Record<string, unknown>
): Promise<{
  loaded?: { name: string }[]
  missing?: string[]
  evicted?: string[]
  addedToolNames?: string[]
  loadedGroups?: string[]
  directories?: { namespace: string }[]
  hint?: string
  nextOffset: number | null
}> {
  const result = await controller.tool.execute('search', args)
  const first = result.content[0]
  if (first.type !== 'text') throw new Error('expected text')
  return JSON.parse(first.text)
}

describe('Beta 工具搜索', () => {
  it('工具库翻倍不会扩大初始注入，未来工具和 MCP 自动可搜', async () => {
    const catalog = Array.from({ length: 400 }, (_, i) =>
      tool(`future_${i}`, `mcp.future${Math.floor(i / 20)}`, '新能力 '.repeat(100))
    )
    const small = createToolSearch(catalog.slice(0, 200), () => catalog.slice(0, 200))
    const large = createToolSearch(catalog, () => catalog)
    expect(large.getTools().map((t) => t.name)).toEqual(['search_tools'])
    expect(large.getTools().reduce((sum, t) => sum + toolDefinitionBytes(t), 0)).toBe(
      small.getTools().reduce((sum, t) => sum + toolDefinitionBytes(t), 0)
    )
    await search(large, { names: ['future_399'] })
    expect(large.getTools()).toContain(catalog[399])
  })

  it('自然语言、精确名称都可加载；原始完整说明、参数和执行函数不变', async () => {
    const material = tool(
      'set_surface_color',
      'ue.material',
      '设置表面颜色。危险边界及修复说明。'.repeat(30)
    )
    const catalog = [material, tool('open_project', 'project', '打开工程')]
    const controller = createToolSearch(catalog, () => catalog)
    expect((await search(controller, { query: '材质颜色', limit: 1 })).loaded?.[0].name).toBe(
      material.name
    )
    expect(controller.getTools().find((t) => t.name === material.name)).toBe(material)
    const result = await controller.tool.execute('exact', { names: [material.name] })
    expect(JSON.parse((result.content[0] as { text: string }).text).addedToolNames).toEqual([])
    expect((await search(controller, { query: 'open_project', limit: 1 })).loaded?.[0].name).toBe(
      'open_project'
    )
  })

  it('目录及目录内工具可以分页发现，不因没命中检索永久丢失', async () => {
    const catalog = [tool('a'), tool('b'), tool('c', 'mcp.blender')]
    const controller = createToolSearch(catalog, () => catalog)
    const page = await search(controller, { limit: 1 })
    expect(page.directories).toHaveLength(1)
    expect(page.nextOffset).toBe(1)
    expect((await search(controller, { namespace: 'ue.material', limit: 1 })).loaded).toEqual([
      { name: 'a', description: '材质颜色 roughness' }
    ])
    expect(
      (await search(controller, { namespace: 'ue.material', offset: 1, limit: 1 })).loaded?.[0].name
    ).toBe('b')
    expect((await search(controller, { query: 'zxqwv' })).loaded).toEqual([])
  })

  it('搜索和精确加载都不能取回当前不可用的工具，断开引擎后已加载工具也移除', async () => {
    const catalog = [tool('hidden'), tool('visible')]
    let available = [catalog[1]]
    const controller = createToolSearch(catalog, () => available)
    const result = await search(controller, { names: ['hidden', 'visible'] })
    expect(result.missing).toEqual(['hidden'])
    expect(controller.getTools().map((t) => t.name)).toEqual(['search_tools', 'visible'])
    available = []
    expect(controller.getTools().map((t) => t.name)).toEqual(['search_tools'])
    available = catalog
    expect((await search(controller, { names: ['hidden'] })).loaded?.[0].name).toBe('hidden')
  })

  /*
   * 这里原本有三条容量测试（组装不下就 deferred、单个超大定义不加载、常驻不挤占
   * 加载区）。2026-09-17 那道 64 KB 闸整个删了，理由见 toolSearch.ts 顶部：
   * 已加载 + 常驻永远是全库子集，最坏情况等于全量注入，闸防不住任何事，
   * 却会把仍然省一半的跨领域任务判死。
   *
   * 替换成对**新行为**的断言 —— 守的是「装得下」而不是「拦得住」。
   */
  it('多个大组可以同时加载，先装的组不被淘汰', async () => {
    const a = tool('a', 'ue.material', 'a'.repeat(35000))
    const b = tool('b', 'ue.blueprint', 'b'.repeat(35000))
    const catalog = [a, b]
    const controller = createToolSearch(catalog, () => catalog)
    await search(controller, { names: ['a'] })
    await search(controller, { names: ['b'] })
    // 两个加起来 70,000 字节，在旧闸下第二个会被拒；现在都在
    expect(controller.getTools()).toContain(a)
    expect(controller.getTools()).toContain(b)
  })

  it('单个超大定义照常整体加载，不截断也不假报', async () => {
    const oversized = tool('oversized', 'mcp.large', '汉'.repeat(64000))
    const controller = createToolSearch([oversized], () => [oversized])
    expect((await search(controller, { names: [oversized.name] })).loaded?.[0].name).toBe(
      'oversized'
    )
    expect(controller.getTools()).toContain(oversized)
  })

  it('常驻清单不会被搜索加载挤掉', async () => {
    const resident = tool('ue_save', 'ue.editor', '完整常驻说明'.repeat(5000))
    const a = tool('a', 'ue.material', 'a'.repeat(35000))
    const b = tool('b', 'ue.blueprint', 'b'.repeat(35000))
    const catalog = [resident, a, b]
    const controller = createToolSearch(catalog, () => catalog, { ue_save: true })
    expect(controller.getTools()).toContain(resident)
    await search(controller, { names: ['a'] })
    await search(controller, { names: ['b'] })
    expect(controller.getTools()).toContain(resident)
    expect(controller.getTools()).toContain(a)
    expect(controller.getTools()).toContain(b)
  })

  it('技能正文精确引用带入整组，重复读取不重排，资源可追加另一组', () => {
    const catalog = [
      tool('blueprint_read', 'ue.blueprint'),
      tool('material_read'),
      tool('material_write'),
      tool('ue_save', 'ue.editor')
    ]
    const controller = createToolSearch(catalog, () => catalog)
    const initial = controller.getTools()
    const first = controller.loadFromSkill(
      '先用 `material_read`；unknown_tool 和 material_read_fake 不是可用工具。'
    )
    expect(JSON.parse(first.text!).addedToolNames).toEqual(['material_read', 'material_write'])
    const materialTools = controller.getTools()
    expect(materialTools.slice(0, initial.length)).toEqual(initial)
    expect(JSON.parse(controller.loadFromSkill('material_write').text!).addedToolNames).toEqual([])
    controller.loadFromSkill('blueprint_read')
    expect(controller.getTools().slice(0, materialTools.length)).toEqual(materialTools)
    expect(controller.getTools().at(-1)).toBe(catalog[0])
  })

  it('截图和聚焦随场景组加载，权限排除的成员不会被带回', async () => {
    const catalog = [
      tool('ue_get_actor', 'ue.actor'),
      tool('ue_screenshot', 'ue.editor'),
      tool('ue_focus_viewport', 'ue.editor')
    ]
    const allowed = catalog.slice(0, 2)
    const controller = createToolSearch(allowed, () => allowed)
    await search(controller, { names: ['ue_get_actor'] })
    expect(controller.getTools().slice(1)).toEqual(allowed)
  })

  /*
   * 2026-09-21 起 query 按**组**分页。按工具分页时 `limit` 的真实含义是「我愿意
   * 浪费几个名额」：中文查询撞上领域词表，整组同分并列，名额被一个组吃光，
   * 第二个组还要再搜一次。实测真实轮次里 44% 需要 ≥2 个组。
   */
  describe('query 按组分页', () => {
    const catalog = [
      tool('material_a', 'ue.material', '材质 颜色'),
      tool('material_b', 'ue.material', '材质 颜色'),
      tool('blueprint_a', 'ue.blueprint', '材质 颜色'),
      tool('blueprint_b', 'ue.blueprint', '材质 颜色')
    ]

    it('limit 数的是组不是工具，一页给整组、翻页换下一组', async () => {
      const controller = createToolSearch(catalog, () => catalog)
      const first = await search(controller, { query: '材质 颜色', limit: 1 })
      // 一个组的两个成员一起到手，而不是两个组各给一个
      expect(first.loaded?.map((entry) => entry.name).sort()).toEqual(['material_a', 'material_b'])
      expect(first.nextOffset).toBe(1)
      const second = await search(controller, { query: '材质 颜色', offset: 1, limit: 1 })
      expect(second.loaded?.map((entry) => entry.name).sort()).toEqual([
        'blueprint_a',
        'blueprint_b'
      ])
      expect(second.nextOffset).toBe(null)
    })

    it('默认一次最多 3 个组', async () => {
      const wide = Array.from({ length: 6 }, (_, i) => tool(`t_${i}`, `mcp.s${i}`, '材质 颜色'))
      const controller = createToolSearch(wide, () => wide)
      const page = await search(controller, { query: '材质 颜色' })
      expect(new Set(page.loadedGroups)).toHaveLength(3)
      expect(page.nextOffset).toBe(3)
    })

    /*
     * `limit` 是上限不是配额。没有这道线就每次凑满，而多加载一组要多作废一次
     * prompt cache（约 1.25×P₀）—— 凑一个不相关的组进来比少搜一次贵得多。
     */
    it('分数远低于头名的组不被凑进来', async () => {
      const mixed = [
        tool('material_exact', 'ue.material', '材质 材质 材质 颜色 颜色'),
        tool('unrelated', 'ue.pcg', '材质')
      ]
      const controller = createToolSearch(mixed, () => mixed)
      const page = await search(controller, { query: '材质 颜色' })
      expect(page.loadedGroups).toEqual(['ue.material'])
    })

    /*
     * 常驻工具混在排序里有两种输法，这套改动把两种都放大了（8 个组整组常驻，
     * 名额从 5 个工具收到 3 个组）：吃掉一个名额，或者当了头名把真正要的折叠组
     * 压到地板之下。两种的表象都是 `addedToolNames` 为空 —— 看起来像没搜着，
     * 于是模型再搜一次，正是要消灭的那种连发。
     */
    it('命中的常驻工具不占名额、不当分母，但仍然回在 loaded 里', async () => {
      // `ue_save` 被用户设成常驻；描述写得比折叠组更贴题，足以当头名
      const withResident = [
        tool('ue_save', 'ue.editor', '整理 整理 整理 资产 资产 资产'),
        tool('content_organize', 'ue.content', '整理 资产')
      ]
      const controller = createToolSearch(withResident, () => withResident, {
        ue_save: true,
        content_organize: false
      })
      const page = await search(controller, { query: '整理资产', limit: 1 })
      // 唯一那个名额给了折叠组，没被常驻的 ue_save 吃掉；也没被它拉高的地板筛没
      expect(page.loadedGroups).toEqual(['ue.content'])
      expect(page.addedToolNames).toEqual(['content_organize'])
      // 但「你已经有 ue_save 了」这件事仍然告诉模型
      expect(page.loaded?.map((entry) => entry.name)).toContain('ue_save')
    })

    it('只命中常驻工具时说清楚是「已经有了」，不说未命中', async () => {
      const onlyResident = [tool('ue_save', 'ue.editor', '保存 存盘')]
      const controller = createToolSearch(onlyResident, () => onlyResident, { ue_save: true })
      const page = await search(controller, { query: '保存' })
      expect(page.addedToolNames).toEqual([])
      expect(page.loaded?.map((entry) => entry.name)).toEqual(['ue_save'])
      expect(page.hint).toContain('已经在你的清单里')
    })
  })

  /*
   * 精确点名不是检索结果，按 `limit` 截断只会无声丢掉后面几个 ——
   * 旧默认是 5，报 8 个名字就哑掉 3 个，返回里还什么都不说。
   */
  it('names 全部加载，不受 limit 截断', async () => {
    const catalog = Array.from({ length: 6 }, (_, i) => tool(`t_${i}`, `mcp.s${i}`))
    const controller = createToolSearch(catalog, () => catalog)
    const result = await search(controller, { names: catalog.map((entry) => entry.name) })
    expect(result.loaded).toHaveLength(6)
    expect(result.nextOffset).toBe(null)
    expect(controller.getTools()).toEqual(expect.arrayContaining(catalog))
  })

  /*
   * `ue.content` 整组 41,099 字节、摊薄只有 1.6，是全表最差的一组。拆成
   * 导入 / 整理 / 体检三组之后，图片生成那类只想「把文件放进工程」的技能
   * 不会再把删除和重定向修复一起拖进来。
   */
  it('ue.content 按子组加载，导入不会带来删除', async () => {
    const catalog = [
      tool('ue_content_import', 'ue.content', '导入'),
      tool('ue_content_delete', 'ue.content', '删除'),
      tool('ue_content_describe', 'ue.content', '查看')
    ]
    const controller = createToolSearch(catalog, () => catalog)
    const result = await search(controller, { names: ['ue_content_import'] })
    expect(result.addedToolNames).toEqual(['ue_content_import'])
    expect(result.loadedGroups).toEqual(['ue.content.import'])
    expect(controller.getTools().map((entry) => entry.name)).not.toContain('ue_content_delete')
  })

  it('目录列的是工具组，父目录名也能浏览', async () => {
    const catalog = [
      tool('ue_content_import', 'ue.content', '导入'),
      tool('ue_content_delete', 'ue.content', '删除')
    ]
    const controller = createToolSearch(catalog, () => catalog)
    expect((await search(controller, {})).directories?.map((d) => d.namespace)).toEqual([
      'ue.content.import',
      'ue.content.organize'
    ])
    // 模型手里可能是拆组之前的那份记忆，或者它本来就只想说「内容浏览器那一摊」
    const parent = await search(controller, { namespace: 'ue.content' })
    expect(parent.loaded?.map((entry) => entry.name).sort()).toEqual([
      'ue_content_delete',
      'ue_content_import'
    ])
  })

  /*
   * 父目录认的是**真实存在的命名空间**，不是任意字符串前缀。按前缀匹配的话
   * `namespace: 'ue'` 会一口咬住全部 UE 工具，而这条路径没有打分 —— 按名字排完
   * 取头几个，等于整组整组地加载模型压根没要的东西，一次三份前缀重写。
   */
  it('namespace 只认真实目录，半截前缀不会扫走一整摊', async () => {
    const catalog = [
      tool('ue_content_import', 'ue.content', '导入'),
      tool('material_set', 'ue.material', '材质'),
      tool('blueprint_add', 'ue.blueprint', '蓝图')
    ]
    const controller = createToolSearch(catalog, () => catalog)
    const half = await search(controller, { namespace: 'ue' })
    expect(half.loaded).toEqual([])
    expect(half.addedToolNames).toEqual([])
    expect(controller.getTools().map((entry) => entry.name)).toEqual(['search_tools'])
  })

  it('浏览目录不跟着 query 的每页 3 组收窄', async () => {
    const catalog = Array.from({ length: 6 }, (_, i) => tool(`t_${i}`, `mcp.s${i}`))
    const controller = createToolSearch(catalog, () => catalog)
    // query 一页 3 个组，目录一页 5 个条目 —— 逃生口不该跟着变窄
    expect((await search(controller, {})).directories).toHaveLength(5)
    expect((await search(controller, { query: '材质颜色' })).loadedGroups).toHaveLength(3)
  })

  /**
   * 「设置 → 工具」在搜索模式下那一排开关，记的就是这份差量。
   *
   * 只存差量而不是整份常驻清单：内置清单会随实验结论调整，存全量的话，
   * 用户点过一次开关就永远停在他点那天的那一版清单上。
   */
  describe('用户改过的常驻清单', () => {
    it('改成常驻的一起首发，不必再被搜出来', async () => {
      const catalog = [tool('material_write'), tool('ue_save', 'ue.editor')]
      const controller = createToolSearch(catalog, () => catalog, { material_write: true })
      expect(controller.getTools().map((entry) => entry.name)).toEqual([
        'search_tools',
        'material_write'
      ])
    })

    it('改成搜索加载的就不首发了，但仍然搜得回来', async () => {
      const catalog = [tool('voice_report', 'host'), tool('ue_save', 'ue.editor')]
      const controller = createToolSearch(catalog, () => catalog, { voice_report: false })
      expect(controller.getTools().map((entry) => entry.name)).toEqual(['search_tools'])
      await search(controller, { names: ['voice_report'] })
      expect(controller.getTools().map((entry) => entry.name)).toContain('voice_report')
      await search(controller, { names: ['ue_save'] })
      expect(controller.getTools().map((entry) => entry.name)).toContain('ue_save')
    })

    it('加载入口关不掉 —— 关掉之后就没人能再加载任何工具了', () => {
      const catalog = [tool('load_skill', 'core'), tool('material_write')]
      const controller = createToolSearch(catalog, () => catalog, {
        load_skill: false,
        material_write: false
      })
      expect(controller.getTools().map((entry) => entry.name)).toEqual([
        'search_tools',
        'load_skill'
      ])
    })

    it('没写差量的照旧按内置清单走：只有宿主交互工具常驻', () => {
      const catalog = [tool('voice_report', 'host'), tool('ue_save', 'ue.editor')]
      const controller = createToolSearch(catalog, () => catalog)
      expect(controller.getTools().map((entry) => entry.name)).toEqual([
        'search_tools',
        'voice_report'
      ])
    })
  })
})
