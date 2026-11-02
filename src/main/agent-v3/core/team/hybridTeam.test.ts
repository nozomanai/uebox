/** @vitest-environment node */
import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))

import type { UnrealAgentTool } from '../../tools/defineTool'
import type { SubAgentResult } from '../../tools/builtin/task'
import type { RunMemberInput, TeamToolDeps } from './teamTools'
import { editorKeyActive } from './editorKey'
import {
  createExternalTeamRegistry,
  type ExternalTeamRecord,
  type ExternalTeamRegistry
} from './externalTeam'
import { createExternalTeamSession } from './externalTeamTools'
import {
  createHybridTeamHost,
  HYBRID_SEND_WAIT_MS,
  hybridParentContext,
  type HybridTeamDeps,
  type HybridTeamHost
} from './hybridTeam'
import {
  createHybridProducerTools,
  hybridHireCatalog,
  openedProjectPath,
  withProducerMailbox
} from './hybridTeamTools'
import { buildProducerBrief } from './teamPrompt'
import { createTeamStore, PRODUCER, type TeamStore } from './teamStore'

/**
 * 混合团队的宿主（docs/混合团队设计-2026-10-24.md 第 2 节）：制作人在外部客户端，
 * 队员是盒子里的子 Agent。模型怎么干活不在这里测（假的 runMember 代替），
 * 量的是宿主这一侧：后台派活、等结果、信箱、当场插话、写工程作废验收、取消不杀队员。
 */

let dir: string
let registry: ExternalTeamRegistry
let store: TeamStore
let noted: string[]
const hosts: HybridTeamHost[] = []

/** 一件活怎么跑由用例定。默认：立刻交回 */
let behave: (input: RunMemberInput) => Promise<SubAgentResult>
let seen: Array<{ parent: { sessionId: string; externalClient?: boolean }; editorKey: boolean }>

const done = (text: string): SubAgentResult => ({ text, messageCount: 1 })

function deps(): HybridTeamDeps {
  return {
    store,
    namespaces: ['ue.level'],
    jobScope: async () => ({
      parent: hybridParentContext({
        shellAvailable: true,
        userInstructions: '',
        uiLanguage: 'zh-CN',
        editorScreenshotEnabled: true,
        ueConnected: false,
        runtime: { runtimeScopeId: 'rt-test', observedAt: 'now', engineLink: 'none' }
      }),
      run: (fn) => fn()
    }),
    runTool: (_record, fn) => fn(),
    runners: (parentOf): Pick<TeamToolDeps, 'runMember' | 'runAcceptance'> => ({
      runMember: async (input) => {
        seen.push({ parent: parentOf(), editorKey: editorKeyActive() })
        return behave(input)
      },
      runAcceptance: async () => 'VERDICT: PASS — ok'
    }),
    noteWrite: async (id) => {
      noted.push(id)
    }
  }
}

async function open(): Promise<HybridTeamHost> {
  const record = await registry.create({ objective: '做一个塔防', members: 'box' })
  store = createTeamStore(registry.dirsFor(record.id))
  const host = await createHybridTeamHost(record, deps())
  hosts.push(host)
  await host.call('team_hire', { name: '策划', role: '写设计文档' })
  return host
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'hybrid-team-'))
  registry = createExternalTeamRegistry({
    dirsFor: (id) => ({ stateDir: join(dir, `${id}.team`), workspaceDir: join(dir, id, 'ws') }),
    stateRoot: () => dir
  })
  noted = []
  seen = []
  behave = async (input) => done(`做完了：${input.message.split('\n').at(-1)}`)
})

afterEach(async () => {
  await Promise.all(hosts.splice(0).map((h) => h.dispose()))
  rmSync(dir, { recursive: true, force: true })
})

describe('混合团队的宿主', () => {
  it('派活一律后台：马上回来，结论进制作人信箱，team_wait 取得到，取过不再给', async () => {
    const host = await open()
    let finish!: () => void
    behave = () => new Promise((resolve) => (finish = () => resolve(done('设计文档写好了'))))

    expect(await host.send({ to: '策划', message: '写设计文档' })).toContain('在后台干')
    await vi.waitFor(() => expect(finish).toBeDefined())
    expect(host.live.pendingJobs().map((j) => j.member)).toEqual(['策划'])

    const waiting = host.wait(60_000)
    finish()
    const got = await waiting
    expect(got).toContain('【交活】策划')
    expect(got).toContain('设计文档写好了')
    expect(await host.drain()).toBe('')
    expect(await host.wait(1000)).toBe('没有在干的活，也没有新消息。')
  })

  it('父上下文：团队 id 当会话、不带 externalClient、自动审批、模型请求排队；队员跑在编辑器钥匙之外由 runTool 决定', async () => {
    const host = await open()
    await host.send({ to: '策划', message: '写', wait: true })
    const [{ parent }] = seen
    expect(parent.sessionId).toBe(host.teamId)
    expect(parent.externalClient).toBeUndefined()
    expect(parent).toMatchObject({
      approvalMode: 'yolo',
      pacedRequests: true,
      thinkingLevel: 'auto'
    })
    expect((parent as { team?: { store?: unknown } }).team?.store).toBe(store)
  })

  it('wait=true 等到它交回；结论在信箱里，下一次调用附上', async () => {
    const host = await open()
    expect(await host.send({ to: '策划', message: '写', wait: true })).toBe(
      '策划 交回了，结论在下面。'
    )
    expect(await host.drain()).toContain('做完了：写')
  })

  it('wait=true 等到点就回来，活接着在后台干', async () => {
    // 只假计时器和时钟：落盘是真的 I/O，要靠 setImmediate 让它走完
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date']
    })
    try {
      const host = await open()
      behave = () => new Promise(() => undefined)
      let reply: string | undefined
      void host.send({ to: '策划', message: '写', wait: true }).then((text) => (reply = text))
      for (let minute = 0; minute < 20 && reply === undefined; minute++) {
        for (let i = 0; i < 20; i++) await new Promise((resolve) => setImmediate(resolve))
        await vi.advanceTimersByTimeAsync(60_000)
      }
      expect(reply).toContain('还没交回')
      expect(host.live.pendingJobs()).toHaveLength(1)
      expect(Date.now()).toBeGreaterThanOrEqual(HYBRID_SEND_WAIT_MS)
    } finally {
      vi.useRealTimers()
    }
  })

  it('客户端取消这次调用不杀队员：活用宿主自己的中止信号', async () => {
    const host = await open()
    let signal: AbortSignal | undefined
    let finish!: () => void
    behave = (input) => {
      signal = input.signal
      return new Promise((resolve) => (finish = () => resolve(done('照样交回'))))
    }
    const client = new AbortController()
    const sent = host.send({ to: '策划', message: '写', wait: true }, client.signal)
    await vi.waitFor(() => expect(signal).toBeDefined())
    client.abort()
    await sent
    expect(signal!.aborted).toBe(false)
    finish()
    expect(await host.wait(60_000)).toContain('照样交回')

    // 团队结束才停
    behave = (input) => {
      signal = input.signal
      return new Promise(() => undefined)
    }
    await host.send({ to: '策划', message: '再写' })
    await vi.waitFor(() => expect(signal?.aborted).toBe(false))
    await host.dispose()
    expect(signal!.aborted).toBe(true)
  })

  it('制作人发的 team_message 当场插进正在干活的队员；队员发给制作人的进信箱，交到手上才算读到', async () => {
    const host = await open()
    let heard: string | undefined
    let finish!: () => void
    behave = async (input) => {
      // 盒子里的子 Agent 开跑时就这样登记（createAgent 的 attachTeamLive）
      const detach = host.live.attach(input.member.name, { steer: (text) => (heard = text) })
      await host.live.send(input.member.name, PRODUCER, '关卡要几层？')
      await new Promise<void>((resolve) => (finish = resolve))
      await detach()
      return done('写完了')
    }
    await host.send({ to: '策划', message: '写设计文档' })
    await vi.waitFor(() => expect(finish).toBeDefined())

    const reply = await host.call('team_message', { to: '策划', text: '三层' })
    expect(JSON.stringify(reply.content)).toContain('插进它的下一步')
    expect(heard).toContain('三层')

    const question = await host.wait(60_000)
    expect(question).toContain('关卡要几层？')
    const mail = (await store.mail()).find((m) => m.text === '关卡要几层？')
    expect(mail?.readAt).toBeDefined()
    finish()
  })

  it('队员写过工程（含停下）就记一笔，之前的验收作废；只读的活不记', async () => {
    const host = await open()
    behave = async (input) => {
      input.ledger.start('w1', 'ue_set_property', {})
      input.ledger.end('w1', true)
      return done('改好了')
    }
    await host.send({ to: '策划', message: '改', wait: true })
    expect(noted).toEqual([host.teamId])

    behave = async () => done('只看了看')
    await host.send({ to: '策划', message: '看', wait: true })
    expect(noted).toHaveLength(1)
  })

  it('用量、活的账记进团队：任务板上看得到', async () => {
    const host = await open()
    behave = async (input) => {
      input.keepUsage?.({
        input: 100,
        output: 20,
        cacheRead: 0,
        cacheWrite: 0,
        total: 120,
        cost: 0,
        unpriced: 0
      })
      return done('写好了')
    }
    await host.send({ to: '策划', message: '写设计文档', wait: true })
    const [job] = await store.jobs()
    expect(job).toMatchObject({ member: '策划', outcome: 'done' })
    expect((await store.usage()).total.total).toBe(120)
  })

  it('到点没消息：说清谁还在干', async () => {
    const host = await open()
    behave = () => new Promise(() => undefined)
    await host.send({ to: '策划', message: '写' })
    expect(await host.wait(50)).toMatch(/秒内没有新消息。还在干：策划 \(0 min\)/)
  })
})

// ── 制作人连接：门 + 精简工具集 ────────────────────────────────────────

describe('混合团队的制作人连接', () => {
  function producerConnection(): {
    call: (name: string, args?: Record<string, unknown>) => Promise<string>
    tools: UnrealAgentTool<never>[]
    hostOf: (id: string) => Promise<HybridTeamHost>
    /** 一条普通连接（Claude Code 的 Stop hook 走的那种），同样认得混合团队的宿主 */
    plain: (
      name: string,
      args: Record<string, unknown>
    ) => Promise<{ text: string; details: unknown }>
  } {
    const made = new Map<string, Promise<HybridTeamHost>>()
    const ready = new Map<string, HybridTeamHost>()
    const hostOf = (id: string): Promise<HybridTeamHost> => {
      let host = made.get(id)
      if (!host) {
        host = registry.get(id).then(async (record) => {
          store = createTeamStore(registry.dirsFor(id))
          const h = await createHybridTeamHost(record!, deps())
          hosts.push(h)
          ready.set(id, h)
          return h
        })
        made.set(id, host)
      }
      return host
    }
    const storeFor = (id: string): TeamStore => createTeamStore(registry.dirsFor(id))
    const hybrid = {
      facts: async (id: string) => ready.get(id)?.gateFacts(),
      stop: async (id: string) => {
        await ready.get(id)?.pause()
      },
      update: (record: ExternalTeamRecord) => ready.get(record.id)?.update(record)
    }
    const plainSession = createExternalTeamSession({
      registry,
      storeFor,
      namespaces: ['ue.level'],
      resolveTarget: (projectPath) => ({ projectPath }),
      hybrid
    })
    const plainTools = plainSession.guard(plainSession.tools)
    const team = createExternalTeamSession({
      registry,
      storeFor,
      namespaces: ['ue.level'],
      resolveTarget: (projectPath) => ({ projectPath }),
      hybrid,
      hosted: {
        brief: async (record) => {
          ;(await hostOf(record.id)).update(record)
          return buildProducerBrief({
            objective: record.objective,
            workspaceDir: 'ws',
            hybrid: { teamId: record.id }
          })
        }
      }
    })
    const tools = team.guard(
      withProducerMailbox(
        [
          ...team.tools.filter((t) => ['team_open', 'team_list', 'team_gate'].includes(t.name)),
          ...createHybridProducerTools({
            teamOf: team.producerTeam,
            hostOf,
            namespaces: ['ue.level']
          })
        ],
        { teamOf: team.producerTeam, running: (id) => ready.get(id) }
      )
    )
    let seq = 0
    return {
      tools,
      hostOf,
      plain: async (name, args) => {
        const result = await plainTools
          .find((t) => t.name === name)!
          .execute(`x${++seq}`, args as never)
        return {
          text: result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n'),
          details: result.details
        }
      },
      call: async (name, args = {}) => {
        const tool = tools.find((t) => t.name === name)
        if (!tool) throw new Error(`没有 ${name}`)
        const result = await tool.execute(`p${++seq}`, args as never)
        return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n')
      }
    }
  }

  it('team_open 开的是盒子托管队员的团队：须知是混合版，没有 team_deliver，记下思考档位', async () => {
    const conn = producerConnection()
    const text = await conn.call('team_open', { objective: '做一个塔防', thinking_level: 'high' })
    expect(text).toContain('team_wait')
    expect(text).not.toContain('team_deliver')
    expect(text).not.toContain('team_join')
    const [record] = await registry.list()
    expect(record).toMatchObject({
      members: 'box',
      approvalMode: 'yolo',
      thinkingLevel: 'high'
    })
  })

  it('交付闸：还有活在跑、有话没看都报出来；收工摘信箱，再调工具挂回来', async () => {
    const conn = producerConnection()
    await conn.call('team_open', { objective: '做一个塔防' })
    await conn.call('team_hire', { name: '策划', role: '写设计文档' })
    const [record] = await registry.list()
    const id = record!.id
    let finish!: () => void
    behave = () => new Promise((resolve) => (finish = () => resolve(done('写好了'))))
    await conn.call('team_send', { to: '策划', message: '写' })
    await vi.waitFor(() => expect(finish).toBeDefined())

    const busy = await conn.plain('team_gate', { team_id: id })
    expect(busy.details).toMatchObject({ pendingJobs: 1, unreadForProducer: 0 })
    finish()
    const host = await conn.hostOf(id)
    await vi.waitFor(async () => expect((await host.gateFacts()).unreadForProducer).toBe(1))

    // 收工：制作人从「谁在跑」上摘下来，队员再发话就进信箱
    await conn.plain('team_gate', { team_id: id, phase: 'stop' })
    expect(host.live.view().running).not.toContain(PRODUCER)
    const queued = await host.live.send('策划', PRODUCER, '还有个问题')
    expect(queued.delivery).toBe('queued')
    // 制作人再调工具：挂回来，攒下的话一起交到手上
    const text = await conn.call('team_wait', { seconds: 1 })
    expect(text).toContain('写好了')
    expect(text).toContain('还有个问题')
    expect(host.live.view().running).toContain(PRODUCER)
  })

  it('新一轮：用户那句话记给验收员，任务板旧账带回来；验收员的提示词里有它，结论进团队事件', async () => {
    const conn = producerConnection()
    await conn.call('team_open', { objective: '做一个塔防' })
    const [record] = await registry.list()
    const id = record!.id
    // 上一轮开工前就挂着「进行中」、整轮没人动过的，下一轮开局要摆出来
    await conn.call('team_board', {
      action: 'update',
      tasks: [{ id: 't1', title: '做主角', status: 'doing' }]
    })
    await new Promise((resolve) => setTimeout(resolve, 5))
    const first = await conn.plain('team_gate', {
      team_id: id,
      phase: 'round',
      latest_request: '加一个 Boss'
    })
    expect(first.text).not.toContain('<team_board_carryover>')
    const second = await conn.plain('team_gate', {
      team_id: id,
      phase: 'round',
      latest_request: 'Boss 要会飞'
    })
    expect(second.text).toContain('<team_board_carryover>')
    expect(second.text).toContain('t1')
    expect((await registry.get(id))?.latestRequest).toBe('Boss 要会飞')

    const joined = await conn.plain('team_join', {
      team_id: id,
      member: 'acceptor',
      report: '做好了',
      how_to_play: '打开 Main'
    })
    expect(joined.text).toContain('Boss 要会飞')
    const seat = (joined.details as { seat: string }).seat
    await conn.plain('team_verdict', { verdict: 'FAIL', reason: 'Boss 不会飞', team_seat: seat })
    expect((await createTeamStore(registry.dirsFor(id)).events()).at(-1)).toMatchObject({
      kind: 'verdict',
      verdict: 'fail'
    })
  })

  it('招人、派活、等结果；队员给制作人的话附在下一个工具结果后面', async () => {
    const conn = producerConnection()
    await conn.call('team_open', { objective: '做一个塔防' })
    expect(await conn.call('team_hire', { name: '策划', role: '写设计文档' })).toContain(
      '已招入 策划'
    )
    expect(await conn.call('team_send', { to: '策划', message: '写设计文档' })).toContain(
      'team_wait'
    )
    const result = await conn.call('team_wait', { seconds: 30 })
    expect(result).toContain('做完了：写设计文档')

    const [record] = await registry.list()
    const host = await conn.hostOf(record!.id)
    await host.live.send('策划', PRODUCER, '我把文档放进工作区了')
    expect(await conn.call('team_board', { action: 'list' })).toContain('我把文档放进工作区了')
  })

  it('混合团队不走 team_join；普通连接也开不了它', async () => {
    const conn = producerConnection()
    await conn.call('team_open', { objective: '做一个塔防' })
    await conn.call('team_hire', { name: '策划', role: '写设计文档' })
    const [record] = await registry.list()

    const plain = createExternalTeamSession({
      registry,
      storeFor: (id) => createTeamStore(registry.dirsFor(id)),
      namespaces: [],
      resolveTarget: (projectPath) => ({ projectPath })
    })
    const plainTools = plain.guard(plain.tools)
    const run = (name: string, args: Record<string, unknown>): Promise<unknown> =>
      plainTools.find((t) => t.name === name)!.execute('x', args as never)

    await expect(
      run('team_join', { team_id: record!.id, member: '策划', brief: '写' })
    ).rejects.toThrow('由盒子托管')
    await expect(run('team_open', { team_id: record!.id })).rejects.toThrow('X-Unreal-Box-Profile')
  })

  it('没进团队的连接调不了派活、等结果', async () => {
    const conn = producerConnection()
    await expect(conn.call('team_wait', {})).rejects.toThrow()
    await expect(conn.call('team_send', { to: '策划', message: 'x' })).rejects.toThrow()
  })
})

// ── 制作人须知 ──────────────────────────────────────────────────────────

describe('制作人须知', () => {
  const input = { objective: '做一个塔防 <游戏> & "x"', workspaceDir: 'C:\\ws\\team' }

  it('盒子里那一份一个字节都没变（制作人放开写工具后量下的指纹）', () => {
    const brief = buildProducerBrief(input)
    expect(brief.length).toBe(4241)
    expect(createHash('sha256').update(brief).digest('hex')).toBe(
      '4ac2c07e40344d6656e392c70b0b7001ea39843b0dbda76df677d30cddcebb2e'
    )
  })

  it('混合版：带团队 id，派活后台 + team_wait，验收走 uebox-acceptor 子 Agent，能开已有工程', () => {
    const brief = buildProducerBrief({ ...input, hybrid: { teamId: 'ext-1' } })
    expect(brief).toContain('team id: ext-1')
    expect(brief).toContain('team_wait')
    expect(brief).toContain('`model_reason`')
    expect(brief).toContain('uebox-acceptor')
    expect(brief).toContain('uebox team use ext-1')
    expect(brief).toContain('open_project')
    expect(brief).toContain('project_package')
    expect(brief).not.toContain('team_deliver')
  })
})

describe('招人的候选名单', () => {
  it('混合团队的 team_hire 说明里不列名单，名单随 team_open 的须知给', async () => {
    const { teamModelCandidates } = await import('../../../../shared/agentTeam')
    const models = {
      candidates: teamModelCandidates([
        { id: 'a', kind: 'chat', models: [{ id: 'm1' }] },
        { id: 'b', kind: 'chat', models: [{ id: 'm2' }] }
      ] as never),
      isAvailable: async () => true
    }
    const [hire] = createHybridProducerTools({
      teamOf: () => undefined,
      hostOf: async () => {
        throw new Error('unused')
      },
      namespaces: [],
      models
    }).filter((t) => t.name === 'team_hire')
    expect(hire!.description).not.toContain('b/m2')
    expect(hire!.description).toContain('team_open')
    expect(hybridHireCatalog(models)).toContain('b/m2')
    expect(hybridHireCatalog(undefined)).toBe('')
  })
})

describe('结束的团队', () => {
  it('不再拉起宿主：制作人连接上还认得通行证，也救不活队员', async () => {
    const record = await registry.create({ objective: '塔防', members: 'box' })
    store = createTeamStore(registry.dirsFor(record.id))
    const ended = await registry.update(record.id, (r) => ({ ...r, endedAt: 1 }))
    await expect(createHybridTeamHost(ended, deps())).rejects.toThrow('已经结束了')
  })
})

describe('宿主的审批、看护和退回模型', () => {
  it('父上下文带上审批通道和团队共用的「本对话内都允许」', async () => {
    const record = await registry.create({ objective: '塔防', members: 'box', approvalMode: 'ask' })
    store = createTeamStore(registry.dirsFor(record.id))
    const requestApproval = vi.fn(async () => 'approve' as const)
    const host = await createHybridTeamHost(record, { ...deps(), requestApproval })
    hosts.push(host)
    await host.call('team_hire', { name: '策划', role: '写' })
    await host.send({ to: '策划', message: '一', wait: true })
    await host.send({ to: '策划', message: '二', wait: true })
    const [a, b] = seen.map((s) => s.parent as unknown as Record<string, unknown>)
    expect(a).toMatchObject({ approvalMode: 'ask', requestApproval })
    expect(a!.alwaysAllowed).toBeInstanceOf(Set)
    expect(a!.alwaysAllowed).toBe(b!.alwaysAllowed)
  })

  it('编辑器崩了：只认团队的工程，记进团队事件，告诉制作人；团队结束停掉看护', async () => {
    const record = await registry.create({
      objective: '塔防',
      members: 'box',
      projectPath: 'D:/Games/TD'
    })
    store = createTeamStore(registry.dirsFor(record.id))
    let isOurs!: (dir: string) => boolean
    let emit!: (event: import('./editorWatch').EditorWatchEvent) => void
    const stop = vi.fn()
    const host = await createHybridTeamHost(record, {
      ...deps(),
      watchEditor: (ours, onEvent) => {
        isOurs = ours
        emit = onEvent
        return stop
      }
    })
    expect(isOurs('d:\\games\\td\\')).toBe(true)
    expect(isOurs('D:/Games/Other')).toBe(false)
    emit({ kind: 'crashed', projectDir: 'D:/Games/TD', reason: 'Access violation' } as never)
    await vi.waitFor(async () =>
      expect((await store.events()).at(-1)).toMatchObject({ kind: 'crashed' })
    )
    expect(await host.drain()).toContain('crash')
    await host.dispose()
    expect(stop).toHaveBeenCalledOnce()
  })

  it('队员的模型用不了、又没有制作人的模型：回话说改用盒子的默认模型，不说「你的模型」', async () => {
    const record = await registry.create({ objective: '塔防', members: 'box' })
    store = createTeamStore(registry.dirsFor(record.id))
    const models = {
      candidates: [
        { key: 'a/m1', providerId: 'a', modelId: 'm1', name: 'M1', providerName: 'A' },
        { key: 'b/m2', providerId: 'b', modelId: 'm2', name: 'M2', providerName: 'B' }
      ],
      isAvailable: async () => false
    } as never
    const host = await createHybridTeamHost(record, { ...deps(), models })
    hosts.push(host)
    await store.putMember({
      name: '策划',
      persona: '写',
      tier: 'strong',
      model: { providerId: 'b', modelId: 'm2' },
      readOnly: false,
      hiredAt: 0
    })
    await host.send({ to: '策划', message: '写', wait: true })
    const reply = await host.drain()
    expect(reply).toContain('改用盒子的默认模型')
    expect(reply).not.toContain('改用你的模型')
  })
})

describe('制作人开的工程', () => {
  it('建工程、开工程：认出工程目录；别的动作和认不出来的不算', () => {
    expect(
      openedProjectPath(
        { action: 'create_project' },
        { projectPath: 'D:/Games/TD', uprojectPath: 'x' }
      )
    ).toBe('D:/Games/TD')
    expect(
      openedProjectPath({ action: 'open_project' }, { openedPath: 'D:\\Games\\TD\\TD.uproject' })
    ).toBe('D:\\Games\\TD')
    expect(openedProjectPath({ action: 'open_project', projectPath: 'E:/Fab/Tpl' }, {})).toBe(
      'E:/Fab/Tpl'
    )
    expect(openedProjectPath({ action: 'open_project', projectKey: 'k' }, {})).toBeUndefined()
    expect(openedProjectPath({ action: 'list_projects' }, { projectPath: 'x' })).toBeUndefined()
  })
})

describe('制作人审批（approval_mode: producer）', () => {
  /** 队员的这一步要过审批：照审批门那样调父上下文的 requestApproval */
  const destroy = {
    sessionId: 'ext-x:mate-搭建',
    toolCallId: 'c1',
    toolName: 'ue_destroy_actor',
    namespace: 'ue.actor',
    risk: 'destructive' as const,
    args: { targets: { names: ['TempCube'] } },
    allowAlways: true,
    allowForever: false
  }

  async function hostWith(
    timeoutMs = 60_000
  ): Promise<{ host: HybridTeamHost; verdicts: string[]; release: () => void }> {
    const record = await registry.create({
      objective: '塔防',
      members: 'box',
      approvalMode: 'producer'
    })
    store = createTeamStore(registry.dirsFor(record.id))
    const boxPopup = vi.fn(async () => 'approve' as const)
    const host = await createHybridTeamHost(record, {
      ...deps(),
      requestApproval: boxPopup,
      approvalTimeoutMs: timeoutMs
    })
    hosts.push(host)
    await host.call('team_hire', { name: '搭建', role: '摆东西' })
    const verdicts: string[] = []
    let release!: () => void
    behave = async () => {
      const parent = seen.at(-1)!.parent as unknown as {
        approvalMode: string
        requestApproval: (r: typeof destroy) => Promise<string>
      }
      expect(parent.approvalMode).toBe('auto-edit')
      expect(parent.requestApproval).not.toBe(boxPopup)
      verdicts.push(await parent.requestApproval(destroy))
      await new Promise<void>((resolve) => (release = resolve))
      return done('删完了')
    }
    expect(boxPopup).not.toHaveBeenCalled()
    return { host, verdicts, release: () => release() }
  }

  it('不可逆的一步不弹盒子的框，进制作人信箱；批准后队员接着干', async () => {
    const { host, verdicts, release } = await hostWith()
    // wait=true 时有审批进来就先回来，不和等批的队员互等
    const sent = await host.send({ to: '搭建', message: '删掉 TempCube', wait: true })
    expect(sent).toContain('有审批在等你答复')
    const mail = await host.drain()
    expect(mail).toContain('[team approval a1 · from 搭建]')
    expect(mail).toContain('ue_destroy_actor')
    expect(mail).toContain('TempCube')
    expect(await host.approve('a1', true)).toContain('已批准')
    await vi.waitFor(() => expect(verdicts).toEqual(['approve']))
    await expect(host.approve('a1', true)).rejects.toThrow('已经答过或超时')
    release()
  })

  it('拒绝：附言当场插给队员', async () => {
    const { host, verdicts, release } = await hostWith()
    let heard = ''
    const detachMember = host.live.attach('搭建', { steer: (text) => (heard += text) })
    await host.send({ to: '搭建', message: '删掉 TempCube' })
    expect(await host.wait(60_000)).toContain('team approval a1')
    expect(await host.approve('a1', false, '别删，挪到角落')).toContain('已拒绝')
    await vi.waitFor(() => expect(verdicts).toEqual(['reject']))
    expect(heard).toContain('别删，挪到角落')
    await detachMember()
    release()
  })

  it('制作人一直不答：到点按拒绝，告诉制作人和队员', async () => {
    const { host, verdicts, release } = await hostWith(50)
    await host.send({ to: '搭建', message: '删掉 TempCube' })
    await vi.waitFor(() => expect(verdicts).toEqual(['reject']))
    const mail = await host.drain()
    expect(mail).toContain('team approval a1')
    expect(mail).toContain('已按拒绝处理')
    release()
  })
})
