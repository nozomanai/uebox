import { chmodSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'

import { electronMock, servicesMock, targetContextMock } from '../testSupport/toolMocks'

// registry 会 eager import 全部 V2 工具模块，其中几个在加载时就有副作用。
// 打桩的理由见 testSupport/toolMocks.ts 文件头。
// 包一层箭头：vi.mock 会被提升到 import 之上，直接传标识符会在初始化前访问它
// （ReferenceError: Cannot access '__vi_import_0__' before initialization）。
// 箭头把标识符的求值推迟到工厂真正被调用时。
vi.mock('electron', () => electronMock())
vi.mock('../../services', () => servicesMock())
vi.mock('../../agent-v3/core/projectTargetContext', async (importOriginal) =>
  targetContextMock(importOriginal)
)

import {
  allToolNames,
  buildAllTools,
  listToolCatalog,
  listToolRisks,
  resetToolCacheForTest,
  rewriteCrossReferences
} from './registry'
import {
  CURRENT_LEVEL_LOCK,
  acquire,
  forceReleaseAll,
  listLocks,
  runWithLockOwner
} from '../core/assetLock'
import {
  resetEnforcementState,
  setProjectRootResolver,
  setReadonlyLockEnabledResolver
} from '../core/assetLockEnforcement'
import { resetReadonlyGuardCaches } from '../core/assetReadonlyGuard'
import { runWithEditorKey } from '../core/team/editorKey'
import { invalidateSettingsCache } from '../../ai/store'
import { estimateTokens } from '../../../shared/tokenBudget'
import { effectiveRisk } from './defineTool'

beforeEach(() => resetToolCacheForTest())

describe('rewriteCrossReferences', () => {
  // 不做这一步，模型会照着描述去调 material.get_graph，而注册的是 material_get_graph，
  // 表现为「模型反复调用不存在的工具」
  it('把描述里的 V2 点号名换成 V3 下划线名', () => {
    expect(rewriteCrossReferences('改图之前先 material.get_graph 拿 node_id')).toBe(
      '改图之前先 material_get_graph 拿 node_id'
    )
  })

  // 逐节点写图那两个已经下线（它们不排版），映射指向接替它们的整图写入工具
  it('已下线的逐节点材质写图工具指向 material_apply_graph', () => {
    expect(rewriteCrossReferences('material.add_node 之后 material.connect_pins')).toBe(
      'material_apply_graph 之后 material_apply_graph'
    )
  })

  it('一句话里多个引用全部替换', () => {
    expect(rewriteCrossReferences('先 blueprint.get_graph 再 blueprint.connect_pins')).toBe(
      // connect_pins 这个工具已经下线，映射指向接替它的整图写入工具 ——
      // skill 正文里还留着旧写法，指过去才不会让模型去调一个不存在的工具
      '先 blueprint_get_graph 再 blueprint_apply_graph'
    )
  })

  it('不误伤无关的点号文本', () => {
    expect(rewriteCrossReferences('路径 /Game/M_Wood.M_Wood')).toBe('路径 /Game/M_Wood.M_Wood')
  })
})

describe('buildAllTools', () => {
  it('全部工具都能造出来（schema 转换不炸）', () => {
    const tools = buildAllTools()
    expect(tools.length).toBeGreaterThan(60)
  })

  it('工具名全局唯一 —— 重名会静默覆盖，模型看到的行为与描述对不上', () => {
    const names = buildAllTools().map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  // 大结果存档（core/resultArchive.ts）只认工具声明的表。声明要从注册表一路带到 unrealBox 上，
  // 少一层转手就静默失效：结果照旧整份给，没有任何报错
  it('声明了存档的工具把表声明带到了 unrealBox 上', () => {
    const byName = new Map(buildAllTools().map((t) => [t.name, t]))
    expect(byName.get('search_assets')?.unrealBox.archive?.lists.assets).toContain('name')
    expect(byName.get('project_list')?.unrealBox.archive?.lists.templates).toContain('name')
    expect(byName.get('ue_get_actor')?.unrealBox.archive?.lists.actors).toContain('name')
    expect(byName.get('ue_content_describe')?.unrealBox.archive?.lists.dependencies).toContain(
      'path'
    )
    expect(byName.get('ue_content_search')?.unrealBox.archive?.lists.folders).toContain('path')
    expect(byName.get('project_manage')?.unrealBox.archive).toBeUndefined()
  })

  /**
   * 工具**几乎都是**无状态的，唯一的例外是 `generate_3d_model`：它的入参表取决于
   * 用户给「3D 生成」绑的是哪家厂商。不跟着配置作废的话，用户在偏好设置里换完
   * 厂商要重启应用才生效 —— 而那种「改了没反应」最难查，因为界面上配置明明是新的。
   */
  it('用户改了 AI 配置之后工具表重造，而不是一直吃缓存', () => {
    const first = buildAllTools()
    expect(buildAllTools(), '同一份配置下应当命中缓存').toBe(first)

    invalidateSettingsCache()

    expect(buildAllTools()).not.toBe(first)
  })

  /**
   * 浏览器工具**不能**出现在这里。
   *
   * `/api/debug/tool` 直接从 `buildAllTools()` 取工具 execute，既不过
   * `resolveTools` 的过滤，也不过审批门。它们只在 `resolveTools` 里现造 ——
   * 这一条测的就是那个闸门没被人顺手拆掉。
   */
  it('不含浏览器工具：那条路绕开了审批门', () => {
    const names = buildAllTools().map((t) => t.name)

    expect(names.filter((name) => name.startsWith('browser_'))).toEqual([])
  })

  it('但 allToolNames() 要有它们，否则 skill 体检会误报', () => {
    const names = allToolNames()

    expect(names.has('browser_open')).toBe(true)
    expect(names.has('browser_interact')).toBe(true)
  })

  it('工具名符合厂商约定，否则请求会被直接拒', () => {
    for (const tool of buildAllTools()) {
      expect(tool.name, `非法工具名: ${tool.name}`).toMatch(/^[a-zA-Z0-9_-]{1,64}$/)
    }
  })

  it('每个工具都有可用的 JSON Schema', () => {
    for (const tool of buildAllTools()) {
      const params = tool.parameters as { type?: string }
      expect(params, `${tool.name} 缺 parameters`).toBeTruthy()
      expect(params.type, `${tool.name} 的 schema 不是 object`).toBe('object')
    }
  })

  it('每个工具都有非空描述 —— 模型全靠它选工具', () => {
    for (const tool of buildAllTools()) {
      expect(tool.description.length, `${tool.name} 描述为空`).toBeGreaterThan(10)
    }
  })

  it('每个工具都带 V3 元数据（审批门和过滤依赖它）', () => {
    for (const tool of buildAllTools()) {
      expect(tool.unrealBox.namespace, `${tool.name} 缺 namespace`).toBeTruthy()
      expect(['safe', 'mutating', 'destructive']).toContain(tool.unrealBox.risk)
    }
  })

  it('描述里不再残留 V2 的点号工具名', () => {
    const stale: string[] = []
    for (const tool of buildAllTools()) {
      const hit = tool.description.match(/\b(blueprint|material|widget)\.[a-z_]+\b/g)
      if (hit) stale.push(`${tool.name}: ${hit.join(', ')}`)
    }
    expect(stale).toEqual([])
  })

  it('能在引擎里执行任意代码的工具一律标 destructive', () => {
    const byName = new Map(buildAllTools().map((t) => [t.name, t]))
    for (const name of ['ue_run_console_command', 'ue_run_python_script', 'ue_manage_plugin']) {
      expect(byName.get(name)?.unrealBox.risk, name).toBe('destructive')
    }
  })

  it('删除类工具标 destructive，查询类标 safe', () => {
    const byName = new Map(buildAllTools().map((t) => [t.name, t]))
    expect(byName.get('ue_destroy_actor')?.unrealBox.risk).toBe('destructive')
    expect(byName.get('ue_content_delete')?.unrealBox.risk).toBe('destructive')
    // 素材库的删除是软删除（进回收站），restore_assets 原样捞得回来，按可撤销的改动登记
    expect(byName.get('delete_assets')?.unrealBox.risk).toBe('mutating')
    // 删除有了，恢复就必须有 —— 否则 agent 删错了自己救不回来
    expect(byName.get('restore_assets')?.unrealBox.risk).toBe('mutating')
    expect(byName.get('move_assets')?.unrealBox.risk).toBe('mutating')
    // 删文件夹会连里面的资产一起带走，对应的撤销键是 restore_folders ——
    // 光有 restore_assets 捞不回目录结构
    expect(byName.get('delete_folders')?.unrealBox.risk).toBe('mutating')
    expect(byName.get('restore_folders')?.unrealBox.risk).toBe('mutating')
    // 标签按风险拆成两个：改名/改色可逆，删除和合并没有回收站
    expect(byName.get('manage_tags')?.unrealBox.risk).toBe('mutating')
    expect(byName.get('delete_tags')?.unrealBox.risk).toBe('destructive')
    // 整理工程库改的全是盒子自己的归类信息，工程文件一个字节都不碰，
    // 解散合集也只是拆分组、工程照样在库里 —— 标 destructive 会让
    // 「按引擎版本分个组」每次弹窗，把用户练成无脑点确认
    expect(byName.get('project_organize')?.unrealBox.risk).toBe('mutating')
    expect(byName.get('ue_get_actor')?.unrealBox.risk).toBe('safe')
    expect(byName.get('blueprint_get_graph')?.unrealBox.risk).toBe('safe')
    expect(byName.get('blueprint_search_nodes')?.unrealBox.risk).toBe('safe')
    expect(byName.get('ue_content_search')?.unrealBox.risk).toBe('safe')
  })

  /**
   * 开源版放宽审批：声明的仍是最坏情况，按参数降到 mutating 的那些，
   * 默认的 auto-edit 下不再弹窗；真会丢东西的那种调用照旧 destructive。
   */
  describe('按参数降风险', () => {
    const risk = (name: string, args: unknown): string => {
      const tool = buildAllTools().find((t) => t.name === name)
      expect(tool, name).toBeDefined()
      return effectiveRisk(tool!.unrealBox, args)
    }

    it.each(['ue_open_level', 'ue_new_level', 'ue_restart_editor'])(
      '%s 不带 force 时插件会拦未保存，按 mutating；带 force 才 destructive',
      (name) => {
        expect(risk(name, {})).toBe('mutating')
        expect(risk(name, { force: false })).toBe('mutating')
        expect(risk(name, { force: true })).toBe('destructive')
      }
    )

    it('ue_new_level 给了 save_as 会盖掉同路径关卡，仍按 destructive', () => {
      expect(risk('ue_new_level', { save_as: '/Game/Maps/New' })).toBe('destructive')
    })

    it('project_manage 只往外加的动作按 mutating，改 .uproject 和覆盖导入仍 destructive', () => {
      for (const action of [
        'create_project',
        'open_project',
        'import_assets',
        'import_assets_to_scene',
        'setup_level_sequence'
      ]) {
        expect(risk('project_manage', { action }), action).toBe('mutating')
      }
      expect(risk('project_manage', { action: 'enable_plugins' })).toBe('destructive')
      expect(risk('project_manage', { action: 'import_assets', overwrite: true })).toBe(
        'destructive'
      )
      expect(risk('project_manage', { action: 'nonsense' })).toBe('destructive')
    })

    it('blueprint_function_signature 只有加参数是 mutating，删参数、删函数撤不回', () => {
      expect(risk('blueprint_function_signature', { action: 'add_param' })).toBe('mutating')
      expect(risk('blueprint_function_signature', { action: 'remove_param' })).toBe('destructive')
      expect(risk('blueprint_function_signature', { action: 'remove_function' })).toBe(
        'destructive'
      )
    })

    it('撤销和删节点开在插件事务里，ue_undo 撤得回来，声明为 mutating', () => {
      const byName = new Map(buildAllTools().map((t) => [t.name, t]))
      expect(byName.get('ue_undo')?.unrealBox.risk).toBe('mutating')
      expect(byName.get('blueprint_delete_node')?.unrealBox.risk).toBe('mutating')
      expect(byName.get('material_delete_node')?.unrealBox.risk).toBe('mutating')
    })
  })

  it('改同一份图表的工具声明为串行', () => {
    const byName = new Map(buildAllTools().map((t) => [t.name, t]))
    for (const name of ['blueprint_apply_graph', 'blueprint_compile']) {
      expect((byName.get(name) as { executionMode?: string })?.executionMode, name).toBe(
        'sequential'
      )
    }
  })

  /**
   * 蓝图/控件蓝图的写工具全部串行。
   *
   * 并发的话，同一条消息里两次写同一个蓝图的执行顺序不保证，而返回还是按请求
   * 顺序排 —— 调用方据此以为按序执行了。真机上撞出来过：先把父类改成 Info、
   * 再改回 Actor，两条都成功，蓝图最后停在 Info（2026-09-16 的用户反馈）。
   *
   * 逐个列名字而不是遍历：新增一个写工具时这条测试要**红**，那正是提醒的时机。
   */
  it('蓝图和控件蓝图的写工具全部串行', () => {
    const byName = new Map(buildAllTools().map((t) => [t.name, t]))
    const writers = [
      'blueprint_create',
      'blueprint_apply_graph',
      'blueprint_delete_node',
      'blueprint_disconnect_pins',
      'blueprint_add_component',
      'blueprint_set_property',
      'blueprint_create_function',
      'blueprint_create_event_graph',
      'blueprint_add_variable',
      'blueprint_set_variable_meta',
      'blueprint_remove_variable',
      'blueprint_event_dispatcher',
      'blueprint_component_event',
      'blueprint_function_signature',
      'blueprint_set_parent_class',
      'blueprint_compile',
      'blueprint_tidy_graph',
      'blueprint_compile_all',
      'widget_create',
      'widget_add_child',
      'widget_set_slot',
      'widget_make_variable',
      'widget_set_property',
      'widget_replace',
      'widget_remove'
    ]
    for (const name of writers) {
      expect((byName.get(name) as { executionMode?: string })?.executionMode, name).toBe(
        'sequential'
      )
    }
  })

  /** 读工具照旧并发 —— 串行化只针对写，查询变慢是纯损失 */
  it('蓝图的读工具仍然并发', () => {
    const byName = new Map(buildAllTools().map((t) => [t.name, t]))
    for (const name of ['blueprint_describe', 'blueprint_get_graph', 'blueprint_search_nodes']) {
      expect((byName.get(name) as { executionMode?: string })?.executionMode, name).not.toBe(
        'sequential'
      )
    }
  })

  it('材质工具走 V3 原生重写版，不是适配版', () => {
    const material = buildAllTools().filter((t) => t.unrealBox.namespace === 'ue.material')
    // 20 = 原来 19 个 + material_graph_slice（ue-inspect 里，只读，大图按段读）
    expect(material).toHaveLength(20)
    expect(material.map((t) => t.name)).toContain('material_create')
  })

  /**
   * 材质有节点说明书，和蓝图对齐。
   *
   * 没有它的时候，问「这个节点的引脚叫什么」只有一条路：先把节点建出来再读回来。
   * 真机上的实际做法是新建一个 31 节点的探针材质把类型各放一个，抄下引脚名再
   * 回去写真正的图 —— 一次任务三分之一的往返花在这上面，探针材质还留在了用户工程里。
   */
  it('材质有节点说明书，且是只读的', () => {
    const byName = new Map(buildAllTools().map((t) => [t.name, t]))
    expect(byName.has('material_search_nodes')).toBe(true)
    expect(byName.get('material_search_nodes')?.unrealBox.risk).toBe('safe')
  })

  /**
   * 逐节点写图那条路**没有任何一步会排版**：add_node 不传 position 就落在原点，
   * 传了就是模型自己猜的坐标。真机上的走向是先用 apply_graph 建好一张排过版的图，
   * 之后每次修改都退回逐节点 —— 交付的就是一团叠在一起的节点。
   * 蓝图那边不会这样，因为那边根本没有逐节点工具。钉住这条，别让它们被加回来。
   */
  it('材质没有逐节点写图工具 —— 那条路不排版', () => {
    const names = new Set(buildAllTools().map((t) => t.name))
    expect(names.has('material_add_node')).toBe(false)
    expect(names.has('material_connect_pins')).toBe(false)
    expect(names.has('material_apply_graph')).toBe(true)
  })

  /**
   * 建图要有声明式的那一条。
   *
   * 逐节点建图（add_node → 记住 node_id → connect_pins）把三件事推给了调用方：
   * 每个节点一次往返、自己记引擎返的 id、半路失败留下一张说不清的半成品图。
   * 蓝图早就只给 `blueprint_apply_graph`，材质补上同一形状的那一个。
   */
  it('材质有声明式的整图写入工具，且串行', () => {
    const tool = buildAllTools().find((t) => t.name === 'material_apply_graph')

    expect(tool).toBeDefined()
    expect((tool as unknown as { executionMode?: string })?.executionMode).toBe('sequential')
  })

  /**
   * 材质图必须能**往回收**，不能只往上加。
   *
   * 只能连不能断的时候，改一根接错的线只有两条路：把节点整个删了重建
   * （顺带丢掉这个节点上其他正确的连线），或者留着不管（编译失败）。
   * 而「接错一根线」在边试边搭的过程里几乎必然发生。
   */
  it('材质图有断线和清理死节点的工具', () => {
    const names = new Set(buildAllTools().map((t) => t.name))
    expect(names.has('material_disconnect_pins')).toBe(true)
    expect(names.has('material_delete_unused_nodes')).toBe(true)
  })

  /**
   * 蓝图成员必须能**调和删**，不能只加。
   *
   * 尤其是变量元数据：建出来的变量默认不暴露给实例，而「让策划在场景里
   * 逐个实例调」才是蓝图变量最常见的用途 —— 少了这一步，建出来的变量
   * 只能在图里用，等于少了一半价值。
   */
  it('蓝图成员有调整、删除和事件分发器的工具', () => {
    const byName = new Map(buildAllTools().map((t) => [t.name, t]))

    expect(byName.has('blueprint_set_variable_meta')).toBe(true)
    expect(byName.has('blueprint_event_dispatcher')).toBe(true)
    // 删变量不可逆（插件端没开事务），且会让引用它的节点变成孤儿 —— 必须过审批门
    expect(byName.get('blueprint_remove_variable')?.unrealBox.risk).toBe('destructive')
  })

  /**
   * 触发式交互（走进触发区、点一下、撞到）的入口。
   *
   * 没有它，这类需求只能退化成 Tick 里每帧算距离 —— 性能和正确性都是错的，
   * 而模型在没有别的选择时就会那么写。
   */
  it('组件事件能绑', () => {
    expect(new Set(buildAllTools().map((t) => t.name)).has('blueprint_component_event')).toBe(true)
  })

  /**
   * 「一个开关控制全场景材质」。MPC 建出来还得能在材质里引用到，
   * 所以这两条要一起在 —— 只有 MPC 没有 CollectionParameter 节点类型的话，
   * 建出来的集合影响不了任何东西。
   */
  it('材质参数集合建得出来，也引用得上', () => {
    const byName = new Map(buildAllTools().map((t) => [t.name, t]))
    expect(byName.has('material_parameter_collection')).toBe(true)

    const applyGraph = byName.get('material_apply_graph')
    const nodeType = (
      applyGraph?.parameters as {
        properties?: { nodes?: { items?: { properties?: { node_type?: { enum?: string[] } } } } }
      }
    )?.properties?.nodes?.items?.properties?.node_type
    expect(nodeType?.enum).toContain('CollectionParameter')
  })

  // 插件注册了 15 条 material.*，这里长期只接了 10 条 —— 其中 create_instance
  // 是材质工作流的主干，漏了它 skill 只能教模型「让用户自己去编辑器里建实例」。
  // 钉住这三条，避免下次重构又把它们掉在半路上。
  it('母材质 → 材质实例这条主干链路的工具齐全', () => {
    const names = new Set(buildAllTools().map((t) => t.name))
    for (const name of [
      'material_create',
      'material_create_instance',
      'material_set_param',
      'material_apply'
    ]) {
      expect(names.has(name), `${name} 未注册`).toBe(true)
    }
  })

  /**
   * 后端有、工具没有 = 模型够不着的能力。
   *
   * 这几条都是真机审计里翻出来的：插件/模型层早就实现了，中间那一层却没有
   * 任何入口。钉在这里，是因为它们的共同点是「不报错、只是永远做不到」——
   * 掉了没有任何测试会红，只有用户会觉得「这活儿它干不了」。
   */
  it('够得着的能力不许再掉：控件槽位、标签整理、文件夹恢复、材质复制', () => {
    const names = new Set(buildAllTools().map((t) => t.name))
    for (const name of [
      // widget.set_canvas_slot / set_vertical_slot：加完控件还能挪
      'widget_set_slot',
      // widget.replace / remove：现成的界面换得了控件、删得掉控件
      'widget_replace',
      'widget_remove',
      // models/tag.ts 的 updateTag / deleteTag：标签改得动、合并得了
      'manage_tags',
      'delete_tags',
      // restoreAssetFolder：delete_folders 的撤销键
      'restore_folders',
      // material.duplicate：照着现成材质改一版，不用重连整张图
      'material_duplicate'
    ]) {
      expect(names.has(name), `${name} 未注册`).toBe(true)
    }
  })

  it('材质的两个只读工具不触发审批', () => {
    const byName = new Map(buildAllTools().map((t) => [t.name, t]))
    expect(byName.get('material_describe')?.unrealBox.risk).toBe('safe')
    expect(byName.get('material_get_graph')?.unrealBox.risk).toBe('safe')
  })

  it('旧笔记工具不再暴露，知识库来源工具只在绑定知识库后出现', () => {
    const legacyNoteTools = [
      'get_note',
      'search_notes',
      'create_note',
      'update_note',
      'delete_note'
    ]
    const defaultTools = buildAllTools().map((t) => t.name)
    expect(defaultTools).not.toEqual(expect.arrayContaining(legacyNoteTools))

    resetToolCacheForTest()
    const notebook = { id: 'notebook-1', title: '研究资料' }
    const withoutSender = buildAllTools({ notebook }).map((t) => t.name)
    expect(withoutSender).toContain('search_notebook_sources')
    expect(withoutSender).not.toContain('add_notebook_source')

    resetToolCacheForTest()
    const fakeSender = { send: () => undefined } as unknown as WebContents
    const withSender = buildAllTools({ notebook, sender: fakeSender }).map((t) => t.name)
    expect(withSender).toContain('add_notebook_source')

    resetToolCacheForTest()
    const unboundWithSender = buildAllTools({ sender: fakeSender }).map((t) => t.name)
    expect(unboundWithSender).toContain('add_notebook_source')
  })

  it('覆盖了全部预期的命名空间', () => {
    const namespaces = new Set(buildAllTools().map((t) => t.unrealBox.namespace))
    expect([...namespaces].sort()).toEqual([
      // 生图。用用户自己配的 Provider 直连厂商，不依赖引擎连接，
      // 但主要用法是拿视口截图当参考图出渲染成品图
      'aigc',
      'asset',
      // 盒子本身：对话记录、状态、技能 / MCP / 导入 / 备份的管理（builtin/box.ts）
      'box',
      // 扫这台机器上装了哪些引擎。不是 ue.*：引擎没连上时正是最需要它的时候
      'engine',
      // 蓝图库 / 材质库的片段仓库。检索和保存只碰本地包目录（不依赖引擎），
      // 只有「放回工程」会经引擎写用户资产 —— 所以不归在 ue.* 下
      'library',
      // 本地文件读写 / 查找 / 搜索。不依赖引擎连接
      'local',
      // 跑 shell 命令。单独一个命名空间，好让 resolveTools 在没有
      // shell 的机器上整个不注册
      'local.shell',
      // 接入第三方 MCP server（connect_mcp_server）。和 engine 一样是盒子的
      // 本地能力 —— 用户说「我装了个 MCP 你连一下」的时候，引擎往往还没开
      'mcp',
      // 用户自己写的笔记。是盒子本地的数据，不依赖引擎连接 ——
      // 资产/文件夹的「详细说明」和输入框里 @ 的那篇笔记都靠它读
      'note',
      'project',
      'ue.actor',
      'ue.animation',
      'ue.blueprint',
      'ue.content',
      // C++ 工作流（cpp.*）。目前只有只读的探测与模块列举，
      'ue.cpp',
      // 数据表（datatable.*）：读列和行、批量改。C++ 实现，替代现写 Python
      'ue.datatable',
      'ue.editor',
      // 输入映射查询（input.*）。键位是运行时状态不是配置 ——
      // 挂着哪些输入上下文由游戏逻辑随时增删，
      'ue.input',
      // 地形与地形 RVT（landscape.*）。C++ 实现：UE 的 Python 建不出地形
      'ue.landscape',
      'ue.level',
      'ue.material',
      // 网格走插件 RPC（mesh.*）—— C++ 实现，和 Sequencer 的 Python 路线相反。
      'ue.mesh',
      // PCG 走插件 RPC，但引擎侧靠反射调 PCG（可选插件，不能链接）——
      // 见 plugin/.../UAL_PCGCommands.cpp 的文件头
      'ue.pcg',
      // Sequencer 走 Python 通道（runEditorPython），不依赖插件 RPC —— 见
      'ue.sequencer',
      'ue.system',
      'ue.widget',
      'video.production',
      // 无头检索（web_search / web_read）。只读、不开窗口、不弹审批 ——
      // 和有头的 browser.* 是两回事，见 builtin/web.ts
      'web'
    ])
  })
})

/**
 * 资产锁包在注册表这一处（见 `withAssetLock`）。
 *
 * 这几条验的是**接线**而不是锁本身的逻辑（那些在 assetLock.test.ts）：
 * 包装有没有真的套到工具上、safe 有没有被放过、拿不到锁时是不是抛异常。
 */
describe('资产锁接线', () => {
  const CONN = undefined // targetContextMock 里 getTargetConnectionId 返回 undefined

  beforeEach(() => forceReleaseAll())

  const toolNamed = (name: string): ReturnType<typeof buildAllTools>[number] => {
    const tool = buildAllTools().find((t) => t.name === name)
    if (!tool) throw new Error(`测试用的工具不见了：${name}`)
    return tool
  }

  it('别的对话占着资产时，写工具直接抛错、不执行', async () => {
    acquire(CONN, 'other-session', ['/Game/BP_Door'])

    const tool = toolNamed('blueprint_set_property')
    await expect(
      runWithLockOwner('me', () =>
        tool.execute('call-1', { blueprint_path: '/Game/BP_Door', property_name: 'x', value: 1 })
      )
    ).rejects.toThrow('另一条 AI 对话')
  })

  it('自己占着的资产照常放行 —— 一轮 run 里会反复碰到同一个资产', async () => {
    acquire(CONN, 'me', ['/Game/BP_Door'])

    const tool = toolNamed('blueprint_set_property')
    // 走到内层会因为没有真引擎而失败，但**不该**是锁的那句
    await expect(
      runWithLockOwner('me', () =>
        tool.execute('call-2', { blueprint_path: '/Game/BP_Door', property_name: 'x', value: 1 })
      )
    ).rejects.not.toThrow('另一条 AI 对话')
  })

  it('safe 工具不受锁影响 —— 读不冲突，加读锁不划算', async () => {
    acquire(CONN, 'other-session', ['/Game/BP_Door'])

    const tool = toolNamed('blueprint_describe')
    await expect(
      runWithLockOwner('me', () => tool.execute('call-3', { blueprint_path: '/Game/BP_Door' }))
    ).rejects.not.toThrow('另一条 AI 对话')
  })

  /**
   * Actor 类工具的参数里一个资产路径都没有，但它改的是**当前关卡**那个包。
   * 真机上验出来过：让 AI 反复改场景十几轮，一个锁都没触发。
   */
  it('Actor 工具没有资产路径，但会软锁当前关卡', async () => {
    const tool = toolNamed('ue_spawn_actor')
    await runWithLockOwner('me', () =>
      tool.execute('call-4', { actor_class: 'StaticMeshActor' }).catch(() => undefined)
    )

    const level = listLocks().filter((l) => l.path === CURRENT_LEVEL_LOCK)
    expect(level).toHaveLength(1)
    // 软锁：只挡另一条会话，不翻只读位
    expect(level[0].soft).toBe(true)
  })

  it('第二条会话改同一张关卡会被挡下', async () => {
    acquire(CONN, 'other-session', [CURRENT_LEVEL_LOCK], { soft: true })

    const tool = toolNamed('ue_spawn_actor')
    await expect(
      runWithLockOwner('me', () => tool.execute('call-4b', { actor_class: 'StaticMeshActor' }))
    ).rejects.toThrow('当前关卡')
  })

  it('工作室模式制作人锁不上关卡时，先拿到的资产路径锁一并放掉', async () => {
    acquire(CONN, 'other-session', [CURRENT_LEVEL_LOCK], { soft: true })

    const tool = toolNamed('ue_spawn_actor')
    await expect(
      runWithEditorKey(() =>
        runWithLockOwner('producer', () =>
          tool.execute('call-4d', { actor_class: '/Game/BP_Door' })
        )
      )
    ).rejects.toThrow('当前关卡')

    expect(listLocks().filter((l) => l.owner === 'producer')).toHaveLength(0)
  })

  it('不碰关卡的写工具不会顺手锁上关卡', async () => {
    const tool = toolNamed('blueprint_set_property')
    await runWithLockOwner('me', () =>
      tool
        .execute('call-4c', { blueprint_path: '/Game/BP_Door', property_name: 'x', value: 1 })
        .catch(() => undefined)
    )

    expect(listLocks().filter((l) => l.path === CURRENT_LEVEL_LOCK)).toHaveLength(0)
  })

  it('不在会话上下文里时完全不加锁 —— 没有主人的锁没人释放', async () => {
    const tool = toolNamed('blueprint_set_property')
    await tool
      .execute('call-5', { blueprint_path: '/Game/BP_Door', property_name: 'x', value: 1 })
      .catch(() => undefined)
    expect(listLocks()).toHaveLength(0)
  })

  /**
   * 只读位（B 阶段）在这里一开一合，范围是**会话手上的全部锁**。
   *
   * 参数里没有资产路径的工具**也要**走这一遭：`ue_save` 参数里根本没有路径，
   * 它存的是这一轮所有被改脏的包。要是按参数提前返回，agent 自己的保存就会被
   * 自己几步之前加的只读位挡下，报出来的还是「文件只读」。
   */
  it('参数里没有路径的写工具，照样为已持有的锁开合只读位', async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'ual-registry-lock-'))
    const file = path.join(root, 'Content', 'BP_Door.uasset')
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, 'bytes', 'utf8')
    setProjectRootResolver(async () => root)
    setReadonlyLockEnabledResolver(async () => true)

    try {
      acquire(CONN, 'me', ['/Game/BP_Door'])

      // 这个工具的参数里一个 /Game/ 路径都没有
      const tool = toolNamed('ue_spawn_actor')
      await runWithLockOwner('me', () =>
        tool.execute('call-6', { actor_class: 'StaticMeshActor' }).catch(() => undefined)
      )

      // 位翻上去了 = enforceAfterWrite 拿到了「会话手上的锁」而不是「参数里的路径」
      expect(statSync(file).mode & 0o200).toBe(0)
    } finally {
      chmodSync(file, 0o666)
      setProjectRootResolver(undefined)
      setReadonlyLockEnabledResolver(undefined)
      resetEnforcementState()
      resetReadonlyGuardCaches()
      rmSync(root, { recursive: true, force: true })
    }
  })
})

/**
 * 「设置 → 工具」那一页的清单。
 *
 * 它比后端窄的话，用户会在清单里找不到一个正在跑的工具 —— 然后以为盒子
 * 根本没有这个能力。
 */
describe('listToolCatalog', () => {
  it('覆盖全部工具，并补上按会话现造的浏览器那一摊', () => {
    const names = listToolCatalog().map((entry) => entry.name)
    for (const tool of buildAllTools()) expect(names).toContain(tool.name)
    expect(names).toContain('browser_open')
  })

  it('每一条都带得起设置页要显示的东西', () => {
    for (const entry of listToolCatalog()) {
      expect(entry.namespace).toBeTruthy()
      expect(entry.description).toBeTruthy()
      expect(['safe', 'mutating', 'destructive']).toContain(entry.risk)
      expect(typeof entry.defaultResident).toBe('boolean')
      // 0 会让设置页把「每次对话多付多少」算少，而那正是这个数存在的理由
      expect(entry.tokens).toBeGreaterThan(0)
    }
  })

  // 一份工具定义里最贵的常常是参数表，不是说明。只量说明会把复杂入参的工具
  // 算得比实际便宜一大截，用户照着这个数去瘦身就会砍错人
  it('token 估算把参数表也算进去', () => {
    const byName = new Map(listToolCatalog().map((entry) => [entry.name, entry]))
    const tool = buildAllTools().find((entry) => entry.name === 'ue_spawn_actor')!
    expect(byName.get('ue_spawn_actor')!.tokens).toBeGreaterThan(estimateTokens(tool.description))
  })

  // 第三方 MCP 归「MCP」设置页管。同一批工具两个页面各有一个开关，
  // 用户关了一个发现还在，只会以为开关坏了
  it('不含第三方 MCP', () => {
    expect(listToolCatalog().filter((entry) => entry.namespace.startsWith('mcp.'))).toEqual([])
  })

  // 默认常驻清单是这一页每个开关的起手状态，读错了用户看到的就是一页假开关
  it('列出的工具默认都不常驻', () => {
    expect(listToolCatalog().filter((entry) => entry.defaultResident)).toEqual([])
  })
})

/*
 * 「工具定义总量」那道门禁已经没有了，这里不要再加回来。
 *
 * 它先是在本文件里用 `字符数 / 3.6` 估算、只量 `buildAllTools()`、阈值 60,000。
 * 2026-09-17 拿真 tokenizer 复核，三个方向同时是错的：换算低估中文 1.84 倍、
 * 范围漏掉 skill 与系统提示词、而且因为只有中文被低估，工具之间的偏差不均匀
 * （1.33x ~ 2.15x）—— 等于一张会把「描述很长」的工具藏起来的排行榜。
 *
 * 换上的逐工具棘轮（`core/toolBudget.test.ts`）量得准，但把前缀钉成了**零和**：
 * 任何一个工具多写一行、任何一个新工具，都要先从别处砍等量的字。真用起来，
 * 它拦下的不是「描述变胖」，而是「新能力写不进文档」—— 而那正是这个仓库在做的事。
 * 2026-09-20 整个删掉。前缀成本该在设计工具时权衡，不该由一道只准变小的棘轮代劳；
 * 真正解决零和的是工具搜索（延迟加载），不是记账。
 *
 * 当时的实测数据留在 `docs/常驻工具集选定-2026-09-17.md`。
 */

/**
 * 渲染层「本轮改动」按这张表认哪些调用改了东西 —— 表里没有的一律当只读略过。
 * 漏一个写工具，它做的事就从用户眼前消失了（原来 connect_mcp_server 就不在表里）。
 */
describe('listToolRisks', () => {
  it('每个会改东西的工具都在风险表里，而且级别一致', () => {
    const table = listToolRisks()
    const wrong = buildAllTools()
      .filter((tool) => tool.unrealBox.risk !== 'safe' && table[tool.name] !== tool.unrealBox.risk)
      .map((tool) => `${tool.name}:${tool.unrealBox.risk}->${table[tool.name]}`)
    expect(wrong).toEqual([])
  })
})
