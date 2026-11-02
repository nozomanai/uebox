/** @vitest-environment node */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import { defineTool, type UnrealAgentTool } from '../../tools/defineTool'
import { forceReleaseAll, getLockOwner } from '../assetLock'
import { getTargetProjectPath } from '../projectTargetContext'
import { editorKeyActive } from './editorKey'
import {
  createExternalTeamRegistry,
  gateFacts,
  type ExternalTeamRecord,
  type ExternalTeamRegistry
} from './externalTeam'
import { createExternalTeamSession, type ExternalTeamSession } from './externalTeamTools'
import { runWithTeamSeat } from './teamSeatContext'
import type { Snapshot, TeamSnapshots } from './snapshots'
import { createTeamStore, type TeamStore } from './teamStore'

/**
 * 外部团队：Claude Code 当大脑，盒子当工作室（docs/外部大脑跑团队设计-2026-10-17.md）。
 *
 * 这里量的是「这次调用是谁」那道门：没进团队的连接原样透传；制作人、验收员拿不到写工具；
 * 队员的写操作带自己的锁主、进团队的工程、记进交付闸；交回存快照、放锁。
 * 前半段不带通行证、按连接认人（Claude Code 插件的打法）；最后一组带通行证，一条连接跑全队。
 */

let dir: string
let clock: number
let registry: ExternalTeamRegistry
const stores = new Map<string, TeamStore>()
let saved: string[]
let calls: { tool: string; owner?: string; project?: string; editorKey: boolean }[]

const now = (): number => clock

function storeFor(id: string): TeamStore {
  let store = stores.get(id)
  if (!store) {
    store = createTeamStore(registry.dirsFor(id), now)
    stores.set(id, store)
  }
  return store
}

const snapshots: TeamSnapshots = {
  async save(message) {
    saved.push(message)
    return { id: `s${saved.length}`, message, at: clock } as Snapshot
  },
  list: async () => [],
  rollback: async () => '已退回'
}

function fakeTool(
  name: string,
  namespace: string,
  risk: 'safe' | 'mutating'
): UnrealAgentTool<never> {
  return defineTool({
    name,
    description: `假的 ${name}`,
    namespace,
    risk,
    input: z.object({ path: z.string().optional(), action: z.string().optional() }),
    execute: async () => {
      calls.push({
        tool: name,
        owner: getLockOwner(),
        project: getTargetProjectPath(),
        editorKey: editorKeyActive()
      })
      return { text: `${name} ok` }
    }
  }) as unknown as UnrealAgentTool<never>
}

const BOX_TOOLS = [
  fakeTool('ue_get_actor', 'ue.level', 'safe'),
  fakeTool('write_script', 'ue.level', 'mutating'),
  fakeTool('generate_image', 'aigc', 'mutating'),
  fakeTool('task', 'core', 'safe'),
  fakeTool('project_manage', 'ue.project', 'mutating')
]

interface Connection {
  session: ExternalTeamSession
  tools: UnrealAgentTool<never>[]
  call: (name: string, args?: Record<string, unknown>) => Promise<string>
  details: (name: string, args?: Record<string, unknown>) => Promise<unknown>
}

function connect(reg: ExternalTeamRegistry = registry): Connection {
  const session = createExternalTeamSession({
    registry: reg,
    storeFor,
    snapshots,
    namespaces: ['ue.level', 'aigc'],
    resolveTarget: (projectPath) => ({ connectionId: `offline:${projectPath}`, projectPath }),
    now
  })
  const tools = session.guard([...BOX_TOOLS, ...session.tools])
  let seq = 0
  const run = async (
    name: string,
    args: Record<string, unknown> = {}
  ): ReturnType<UnrealAgentTool<never>['execute']> => {
    const tool = tools.find((t) => t.name === name)
    if (!tool) throw new Error(`没有 ${name}`)
    return tool.execute(`c${++seq}`, args as never)
  }
  return {
    session,
    tools,
    call: async (name, args) =>
      (await run(name, args)).content.map((c) => (c.type === 'text' ? c.text : '')).join(''),
    details: async (name, args) => (await run(name, args)).details
  }
}

async function openTeam(projectPath?: string): Promise<{ producer: Connection; teamId: string }> {
  const producer = connect()
  const details = (await producer.details('team_open', {
    objective: '做一个塔防',
    ...(projectPath ? { project_path: projectPath } : {})
  })) as { teamId: string }
  return { producer, teamId: details.teamId }
}

function makeRegistry(onChange?: (id: string) => void): ExternalTeamRegistry {
  let n = 0
  return createExternalTeamRegistry({
    dirsFor: (id) => ({
      stateDir: join(dir, 'sessions', `${id}.team`),
      workspaceDir: join(dir, 'team', id)
    }),
    stateRoot: () => join(dir, 'sessions'),
    now,
    onChange,
    newId: () => `ext-t${++n}`
  })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'external-team-'))
  clock = 1_000
  saved = []
  calls = []
  stores.clear()
  forceReleaseAll()
  registry = makeRegistry()
})

afterEach(() => {
  forceReleaseAll()
  rmSync(dir, { recursive: true, force: true })
})

describe('外部团队名册', () => {
  it('创建、补工程和验收落盘后立即通知列表，无改动和写入失败不通知', async () => {
    const changed = vi.fn(
      (id: string) =>
        JSON.parse(
          readFileSync(join(dir, 'sessions', `${id}.team`, 'external.json'), 'utf8')
        ) as ExternalTeamRecord
    )
    registry = makeRegistry(changed)
    const team = await registry.create({ objective: '甲' })
    expect(changed).toHaveBeenCalledWith(team.id)
    expect(changed.mock.results[0].value).toMatchObject({ id: team.id, objective: '甲' })
    await registry.update(team.id, (record) => ({ ...record, projectPath: 'D:/Games/A' }))
    expect(changed.mock.results[1].value).toMatchObject({ projectPath: 'D:/Games/A' })
    await registry.recordVerdict(team.id, { kind: 'pass', reason: '玩通了' })
    expect(changed.mock.results[2].value.state.verdict).toBe('pass')
    await registry.update(team.id, () => null)
    await expect(
      registry.update(team.id, () => {
        throw new Error('cannot write')
      })
    ).rejects.toThrow('cannot write')
    expect(changed).toHaveBeenCalledTimes(3)
  })

  it('窗口通知失败不影响已经落盘的团队', async () => {
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    try {
      registry = makeRegistry(() => {
        throw new Error('window closed')
      })
      const team = await registry.create({ objective: '甲' })
      expect(await registry.get(team.id)).toMatchObject({ objective: '甲' })
      expect(warning).toHaveBeenCalled()
    } finally {
      warning.mockRestore()
    }
  })

  it('建、读、列；不是 ext- 开头的 id 一律当不存在', async () => {
    const a = await registry.create({ objective: '甲' })
    clock = 2_000
    const b = await registry.create({ objective: '乙', projectPath: 'D:/Games/B' })
    expect(await registry.get(a.id)).toMatchObject({ objective: '甲', state: { verdict: null } })
    expect((await registry.list()).map((r) => r.id)).toEqual([b.id, a.id])
    expect(await registry.get('session-123')).toBeUndefined()
  })

  it('PASS 之后又写了工程，就不算过', async () => {
    const team = await registry.create({ objective: '甲' })
    clock = 2_000
    await registry.recordVerdict(team.id, { kind: 'pass', reason: '玩通了' })
    expect(gateFacts((await registry.get(team.id))!).passed).toBe(true)
    clock = 3_000
    await registry.noteWrite(team.id)
    const facts = gateFacts((await registry.get(team.id))!)
    expect(facts).toMatchObject({ verdict: 'pass', passed: false, lastWriteAt: 3_000 })
  })
})

describe('没进团队的连接', () => {
  it('普通工具原样透传：不套锁主、不进工程、写工具照样放行', async () => {
    const plain = connect()
    expect(await plain.call('write_script')).toBe('write_script ok')
    expect(calls).toEqual([
      { tool: 'write_script', owner: undefined, project: undefined, editorKey: false }
    ])
  })

  it('只能进门、看清单、查交付闸', async () => {
    const plain = connect()
    await expect(plain.call('team_board', { action: 'list' })).rejects.toThrow('不能调 team_board')
    await expect(plain.call('team_hire', { name: 'a', role: 'b' })).rejects.toThrow('不能调')
    expect(await plain.call('team_list')).toContain('还没有外部团队')
  })
})

describe('制作人', () => {
  it('team_open 开团队、拿到制作人须知；写工具和 task 都被拒', async () => {
    const producer = connect()
    const brief = await producer.call('team_open', { objective: '做一个塔防' })
    expect(brief).toContain('<team_mode>')
    expect(brief).toContain('ext-t1')
    expect(brief).toContain('uebox-member')

    await expect(producer.call('write_script')).rejects.toThrow('制作人不直接改工程')
    await expect(producer.call('task')).rejects.toThrow('外部团队里不用 task')
    // 建工程、打开工程是制作人能做的唯一写操作；往工程里加东西派给队员
    expect(await producer.call('project_manage', { action: 'create_project' })).toBe(
      'project_manage ok'
    )
    await expect(producer.call('project_manage', { action: 'import_asset' })).rejects.toThrow(
      '制作人不直接改工程'
    )
    expect(await producer.call('ue_get_actor')).toBe('ue_get_actor ok')
  })

  it('接着已有团队干时可以补上工程路径；之后的调用都进那个工程', async () => {
    const { teamId } = await openTeam()
    const again = connect()
    await again.call('team_open', { team_id: teamId, project_path: 'D:/Games/TD' })
    await again.call('ue_get_actor')
    expect(calls.at(-1)).toMatchObject({ project: 'D:/Games/TD', owner: undefined })
  })

  it('team_hire 只登记，保留名字不让用，命名空间要认得', async () => {
    const { producer } = await openTeam()
    expect(await producer.call('team_hire', { name: '程序', role: '写脚本' })).toContain(
      '已登记 程序'
    )
    await expect(producer.call('team_hire', { name: 'acceptor', role: 'x' })).rejects.toThrow(
      '保留'
    )
    await expect(
      producer.call('team_hire', { name: '美术', role: 'x', namespaces: ['ue.material'] })
    ).rejects.toThrow('没有这些命名空间')
  })
})

describe('队员', () => {
  it('不在名册上进不了门；进门拿到人设、这件活和给它的留言', async () => {
    const { producer, teamId } = await openTeam()
    const member = connect()
    await expect(
      member.call('team_join', { team_id: teamId, member: '程序', brief: '写主角' })
    ).rejects.toThrow('团队里没有「程序」')

    await producer.call('team_hire', { name: '程序', role: '写 GDScript' })
    await producer.call('team_message', { to: '程序', text: '主角用 CharacterBody2D' })
    const text = await member.call('team_join', {
      team_id: teamId,
      member: '程序',
      brief: '写主角'
    })
    expect(text).toContain('<role>写 GDScript</role>')
    expect(text).toContain('写主角')
    expect(text).toContain('主角用 CharacterBody2D')
  })

  it('写操作带自己的锁主和编辑器钥匙、进团队工程，并记进交付闸', async () => {
    const { producer, teamId } = await openTeam('D:/Games/TD')
    await producer.call('team_hire', { name: '程序', role: '写脚本' })
    const member = connect()
    await member.call('team_join', { team_id: teamId, member: '程序', brief: '写主角' })

    clock = 5_000
    await member.call('write_script', { path: 'res://player.gd' })
    expect(calls.at(-1)).toEqual({
      tool: 'write_script',
      owner: expect.stringMatching(new RegExp(`^${teamId}:mate-程序@`)),
      project: 'D:/Games/TD',
      editorKey: true
    })
    expect((await registry.get(teamId))!.state.lastWriteAt).toBe(5_000)
  })

  it('两个队员的锁主不同：文件锁能把它们分开', async () => {
    const { producer, teamId } = await openTeam()
    await producer.call('team_hire', { name: '程序', role: 'a' })
    await producer.call('team_hire', { name: '关卡', role: 'b' })
    const a = connect()
    const b = connect()
    await a.call('team_join', { team_id: teamId, member: '程序', brief: 'x' })
    await b.call('team_join', { team_id: teamId, member: '关卡', brief: 'y' })
    await a.call('write_script')
    await b.call('write_script')
    expect(new Set(calls.map((c) => c.owner)).size).toBe(2)
  })

  it('只读岗位和工具范围由盒子把关；task 一律不给', async () => {
    const { producer, teamId } = await openTeam()
    await producer.call('team_hire', { name: '评审', role: '找问题', read_only: true })
    await producer.call('team_hire', { name: '美术', role: '出图', namespaces: ['aigc'] })
    const reviewer = connect()
    const artist = connect()
    await reviewer.call('team_join', { team_id: teamId, member: '评审', brief: '看看' })
    await artist.call('team_join', { team_id: teamId, member: '美术', brief: '画主角' })

    await expect(reviewer.call('write_script')).rejects.toThrow('只读岗位')
    expect(await reviewer.call('ue_get_actor')).toBe('ue_get_actor ok')
    await expect(artist.call('write_script')).rejects.toThrow('不在 美术 的工具范围里')
    expect(await artist.call('generate_image')).toBe('generate_image ok')
    await expect(artist.call('task')).rejects.toThrow('外部团队里不用 task')
  })

  it('team_report：收工、记改动、改过东西才存快照，然后退出团队', async () => {
    const { producer, teamId } = await openTeam()
    await producer.call('team_hire', { name: '程序', role: 'a' })
    const member = connect()

    await member.call('team_join', { team_id: teamId, member: '程序', brief: '只是看看' })
    expect(await member.call('team_report', { report: '看过了，没问题。' })).toContain('没有写操作')
    expect(saved).toEqual([])

    await member.call('team_join', { team_id: teamId, member: '程序', brief: '写主角' })
    await member.call('write_script', { path: 'res://player.gd' })
    const done = await member.call('team_report', {
      report: '主角能跑能跳。证据：ue_get_actor 0 错'
    })
    expect(done).toContain('write_script ×1（res://player.gd）')
    expect(done).toContain('【快照】已存 s1')
    expect(saved).toEqual(['程序：主角能跑能跳。'])
    expect(member.session.binding()).toBeUndefined()

    const jobs = await storeFor(teamId).jobs()
    expect(jobs.map((j) => j.outcome)).toEqual(['done', 'done'])
    // 下一件活进门时带上之前交回的报告，代替盒子里队员自带的记忆
    const next = await member.call('team_join', {
      team_id: teamId,
      member: '程序',
      brief: '加二段跳'
    })
    expect(next).toContain('主角能跑能跳')
  })

  it('连接断了没交回：活收成停下', async () => {
    const { producer, teamId } = await openTeam()
    await producer.call('team_hire', { name: '程序', role: 'a' })
    const member = connect()
    await member.call('team_join', { team_id: teamId, member: '程序', brief: '写主角' })
    await member.session.dispose()
    const [job] = await storeFor(teamId).jobs()
    expect(job).toMatchObject({
      outcome: 'stopped',
      reason: expect.stringContaining('team_report')
    })
  })
})

describe('验收员', () => {
  it('要带交付说明进门；只读；记下的结论进交付闸，之后再改就作废', async () => {
    const { producer, teamId } = await openTeam()
    await producer.call('team_hire', { name: '程序', role: 'a' })
    const acceptor = connect()
    await expect(
      acceptor.call('team_join', { team_id: teamId, member: 'acceptor' })
    ).rejects.toThrow('交付说明')
    const prompt = await acceptor.call('team_join', {
      team_id: teamId,
      member: 'acceptor',
      report: '塔防做完了',
      how_to_play: '从 main.tscn 开始'
    })
    expect(prompt).toContain('team_verdict')
    await expect(acceptor.call('write_script')).rejects.toThrow('验收员只读')

    clock = 7_000
    await acceptor.call('team_verdict', { verdict: 'PASS', reason: '玩通一局' })
    expect(gateFacts((await registry.get(teamId))!).passed).toBe(true)
    expect(await producer.call('team_gate')).toContain('已过验收')

    const member = connect()
    await member.call('team_join', { team_id: teamId, member: '程序', brief: '再改一下' })
    clock = 8_000
    await member.call('write_script')
    expect(await producer.call('team_gate')).toContain('之后又改过工程')
  })

  it('队员和制作人记不了结论', async () => {
    const { producer, teamId } = await openTeam()
    await producer.call('team_hire', { name: '程序', role: 'a' })
    const member = connect()
    await member.call('team_join', { team_id: teamId, member: '程序', brief: 'x' })
    await expect(
      member.call('team_verdict', { verdict: 'PASS', reason: '我说过了' })
    ).rejects.toThrow('不能调 team_verdict')
    await expect(
      producer.call('team_verdict', { verdict: 'PASS', reason: '我说过了' })
    ).rejects.toThrow('不能调 team_verdict')
  })
})

describe('通行证（team_seat）', () => {
  async function seatOf(
    conn: Connection,
    name: string,
    args: Record<string, unknown>
  ): Promise<string> {
    return ((await conn.details(name, args)) as { seat: string }).seat
  }

  it('每个工具的参数表里多一个 team_seat；交给工具的参数里没有它', async () => {
    const conn = connect()
    const write = conn.tools.find((t) => t.name === 'write_script')!
    expect(
      (write.parameters as { properties: Record<string, unknown> }).properties.team_seat
    ).toBeTruthy()
    const seen: unknown[] = []
    const strict = defineTool({
      name: 'strict_tool',
      description: '参数表是严格的',
      namespace: 'ue.level',
      risk: 'safe',
      input: z.object({ path: z.string() }).strict(),
      execute: async (params) => {
        seen.push(params)
        return { text: 'ok' }
      }
    }) as unknown as UnrealAgentTool<never>
    const { teamId } = await openTeam()
    const producerSeat = (
      (await conn.details('team_open', { team_id: teamId })) as { seat: string }
    ).seat
    const [guarded] = conn.session.guard([strict])
    await guarded!.execute('x', { path: 'a', team_seat: producerSeat } as never)
    expect(seen).toEqual([{ path: 'a' }])
  })

  it('一条连接同时跑制作人、两个队员和验收员：各认各的', async () => {
    const conn = connect()
    const producer = await seatOf(conn, 'team_open', {
      objective: '做一个塔防',
      project_path: 'D:/Games/TD'
    })
    const teamId = producer.split('.')[0]!
    await conn.call('team_hire', { name: '程序', role: 'a', team_seat: producer })
    await conn.call('team_hire', { name: '关卡', role: 'b', team_seat: producer })

    // 子 Agent 和主会话共用这条连接：进门不带通行证，各拿一张
    const coder = await seatOf(conn, 'team_join', { team_id: teamId, member: '程序', brief: 'x' })
    const level = await seatOf(conn, 'team_join', { team_id: teamId, member: '关卡', brief: 'y' })
    expect(new Set([producer, coder, level]).size).toBe(3)

    await conn.call('write_script', { team_seat: coder })
    // 能发 `_meta` 的客户端走 `_meta.unrealBox.teamSeat`，效果一样
    await runWithTeamSeat(level, () => conn.call('write_script'))
    expect(calls.map((c) => c.owner)).toEqual([
      expect.stringMatching(new RegExp(`^${teamId}:mate-程序@`)),
      expect.stringMatching(new RegExp(`^${teamId}:mate-关卡@`))
    ])
    expect(calls.every((c) => c.project === 'D:/Games/TD' && c.editorKey)).toBe(true)

    // 共用连接上不带通行证：盒子不猜是谁
    await expect(conn.call('write_script')).rejects.toThrow('team_seat')
    await expect(conn.call('team_board', { action: 'list' })).rejects.toThrow('team_seat')
    // 制作人的规矩还在
    await expect(conn.call('write_script', { team_seat: producer })).rejects.toThrow(
      '制作人不直接改工程'
    )
    await expect(conn.call('team_report', { report: 'x', team_seat: producer })).rejects.toThrow(
      '不能调 team_report'
    )

    await conn.call('team_report', { report: '主角写完了。', team_seat: coder })
    await conn.call('team_report', { report: '关卡搭完了。', team_seat: level })
    expect(saved).toEqual(['程序：主角写完了。', '关卡：关卡搭完了。'])
    // 交回之后这张通行证不能再写
    await expect(conn.call('write_script', { team_seat: coder })).rejects.toThrow('手上没有活')

    // 干过队员的通行证当不了验收员；新进门的验收员可以，哪怕这条连接上跑过队员
    await expect(
      conn.call('team_join', {
        team_id: teamId,
        member: 'acceptor',
        report: 'r',
        how_to_play: 'h',
        team_seat: coder
      })
    ).rejects.toThrow('干过队员的活')
    const acceptor = await seatOf(conn, 'team_join', {
      team_id: teamId,
      member: 'acceptor',
      report: '塔防做完了',
      how_to_play: '从 main 开始'
    })
    await expect(conn.call('write_script', { team_seat: acceptor })).rejects.toThrow('验收员只读')
    clock = 9_000
    await conn.call('team_verdict', { verdict: 'PASS', reason: '玩通一局', team_seat: acceptor })
    expect(await conn.call('team_gate', { team_seat: producer })).toContain('已过验收')
    await expect(
      conn.call('team_verdict', { verdict: 'PASS', reason: '再记一次', team_seat: acceptor })
    ).rejects.toThrow('不能调 team_verdict')
  })

  it('换一条连接、盒子重启之后，通行证还认得', async () => {
    const { producer, teamId } = await openTeam('D:/Games/TD')
    await producer.call('team_hire', { name: '程序', role: 'a' })
    const first = connect()
    const seat = await seatOf(first, 'team_join', {
      team_id: teamId,
      member: '程序',
      brief: '写主角'
    })
    await first.call('write_script', { team_seat: seat })
    const owner = calls.at(-1)!.owner
    // 连接断了：调用方自己带着通行证，活不收
    await first.session.dispose()
    expect((await storeFor(teamId).jobs())[0]!.outcome).toBeUndefined()

    // 盒子重启：进程里什么都没有了，从团队记录里认回来
    const restarted = makeRegistry()
    const second = connect(restarted)
    clock = 6_000
    await second.call('write_script', { team_seat: seat })
    expect(calls.at(-1)).toMatchObject({ owner, project: 'D:/Games/TD', editorKey: true })

    // 再重启一次，交回时没有写操作明细了，但通行证上记着写过：照样存快照
    const third = connect(makeRegistry())
    const done = await third.call('team_report', { report: '主角写完了。', team_seat: seat })
    expect(done).toContain('盒子中途重启过')
    expect(saved).toEqual(['程序：主角写完了。'])
  })

  it('伪造的、不认得的通行证一律拒绝', async () => {
    const { producer, teamId } = await openTeam()
    await producer.call('team_hire', { name: '程序', role: 'a' })
    const conn = connect()
    for (const forged of [`${teamId}.not-a-real-seat`, 'ext-nope.x', 'garbage']) {
      await expect(conn.call('write_script', { team_seat: forged })).rejects.toThrow('不认得')
      await expect(conn.call('team_board', { action: 'list', team_seat: forged })).rejects.toThrow(
        '不认得'
      )
    }
    expect(calls).toEqual([])
    // 别的团队的通行证进不了这个团队
    const other = await openTeam()
    const otherSeat = (await other.producer.details('team_open', { team_id: other.teamId })) as {
      seat: string
    }
    await expect(
      conn.call('team_open', { team_id: teamId, team_seat: otherSeat.seat })
    ).rejects.toThrow('属于团队')
  })
})
