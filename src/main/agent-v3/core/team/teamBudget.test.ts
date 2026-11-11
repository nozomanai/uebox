/** @vitest-environment node */
import {
  createAssistantMessageEventStream,
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Model,
  normalizeContext
} from '@earendil-works/pi-ai'
import type { StreamFn } from '@earendil-works/pi-agent-core'
import { describe, expect, it } from 'vitest'

import { AdaptiveLimiter, DEFAULT_GATE_CONFIG, pacedStreamFn } from './requestGate'
import {
  DEFAULT_TEAM_TOKEN_LIMIT,
  TEAM_TOKEN_LIMIT_ENV,
  billedTokens,
  createTeamBudget,
  formatTokens,
  teamBudgetFor,
  teamTokenStep
} from './teamBudget'

/**
 * 封顶要回答的事：一局团队累计用到上限就不再发模型请求，把原因说清楚；用户接着跑时能恢复。
 */

const model = { id: 'm', api: 'openai-completions', provider: 'plan' } as unknown as Model<Api>
const context = normalizeContext({ messages: [] })

const reply = (usage: Partial<AssistantMessage['usage']>): AssistantMessage =>
  ({
    role: 'assistant',
    content: [{ type: 'text', text: 'hi' }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, ...usage },
    stopReason: 'stop',
    timestamp: 0
  }) as AssistantMessage

/** 每次请求都回一条带这份用量的话，并数着被调了几次 */
function spender(usage: Partial<AssistantMessage['usage']>): { fn: StreamFn; calls: () => number } {
  let calls = 0
  const fn: StreamFn = () => {
    calls++
    const stream = createAssistantMessageEventStream()
    void (async () => {
      await Promise.resolve()
      stream.push({ type: 'start', partial: reply({}) })
      stream.push({ type: 'done', reason: 'stop', message: reply(usage) })
      stream.end()
    })()
    return stream
  }
  return { fn, calls: () => calls }
}

async function collect(stream: AsyncIterable<AssistantMessageEvent>): Promise<string[]> {
  const types: string[] = []
  for await (const event of stream) {
    types.push(event.type === 'error' ? `error:${event.error.errorMessage}` : event.type)
  }
  return types
}

describe('用量折算口径', () => {
  it('input + output + cacheWrite 全额，cacheRead 按 0.1', () => {
    expect(billedTokens({ input: 1000, output: 200, cacheWrite: 300, cacheRead: 5000 })).toBe(2000)
  })

  it('缺字段、非数字、负数按 0', () => {
    expect(billedTokens(undefined)).toBe(0)
    expect(billedTokens({ input: Number.NaN, output: -5, cacheRead: 100 })).toBe(10)
  })

  it('一档的大小：默认 2000 万，环境变量给了正整数就用它', () => {
    expect(teamTokenStep({})).toBe(DEFAULT_TEAM_TOKEN_LIMIT)
    expect(teamTokenStep({ [TEAM_TOKEN_LIMIT_ENV]: '5000000' })).toBe(5_000_000)
    expect(teamTokenStep({ [TEAM_TOKEN_LIMIT_ENV]: '0' })).toBe(DEFAULT_TEAM_TOKEN_LIMIT)
    expect(teamTokenStep({ [TEAM_TOKEN_LIMIT_ENV]: 'abc' })).toBe(DEFAULT_TEAM_TOKEN_LIMIT)
  })

  it('给人看的数字按万写', () => {
    expect(formatTokens(20_000_000)).toBe('2000 万')
    expect(formatTokens(20_304_999)).toBe('2030 万')
    expect(formatTokens(9000)).toBe('9000')
  })
})

describe('一局的账', () => {
  it('没到顶不拒绝；到顶后给出用了多少、上限多少、怎么继续', () => {
    const budget = createTeamBudget({ step: 20_000_000 })
    budget.charge({ input: 19_999_999 })
    expect(budget.exhausted()).toBe(false)
    expect(budget.refusal()).toBeNull()

    budget.charge({ output: 300_001 })
    expect(budget.exhausted()).toBe(true)
    expect(budget.refusal()).toBe(
      '本局团队已用 2030 万 token，达到上限 2000 万，已停止。回复「继续」可再运行 2000 万。'
    )
  })

  it('抬一档：上限变成「已用 + 一档」，恢复放行', () => {
    const budget = createTeamBudget({ step: 1000, spent: 1250 })
    expect(budget.exhausted()).toBe(true)
    expect(budget.raise()).toBe(2250)
    expect(budget.refusal()).toBeNull()
    budget.charge({ input: 1000 })
    expect(budget.exhausted()).toBe(true)
  })

  it('对盘上的总账只往大的方向改；落盘的上限照用，没有就回到一档', () => {
    const budget = createTeamBudget({ step: 1000 })
    budget.charge({ input: 400 })
    budget.seed(300)
    expect(budget.spent()).toBe(400)
    budget.seed(900)
    expect(budget.spent()).toBe(900)

    budget.setLimit(5000)
    expect(budget.limit()).toBe(5000)
    budget.setLimit(undefined)
    expect(budget.limit()).toBe(1000)
  })

  it('同一条会话拿到的是同一份', () => {
    expect(teamBudgetFor('budget-test-a')).toBe(teamBudgetFor('budget-test-a'))
    expect(teamBudgetFor('budget-test-a')).not.toBe(teamBudgetFor('budget-test-b'))
  })
})

describe('模型请求关口上的封顶', () => {
  const gate = (inner: StreamFn, budget: ReturnType<typeof createTeamBudget>): StreamFn => {
    const limiter = new AdaptiveLimiter(DEFAULT_GATE_CONFIG)
    return pacedStreamFn(inner, { limiterFor: () => limiter, budget })
  }

  it('没到顶放行，回话的用量记到账上', async () => {
    const budget = createTeamBudget({ step: 1000 })
    const inner = spender({ input: 300, output: 100, cacheRead: 1000 })
    const events = await collect(await gate(inner.fn, budget)(model, context, {}))
    expect(events).toEqual(['start', 'done'])
    expect(budget.spent()).toBe(500)
  })

  it('到顶后不再发请求，回一条写明原因的失败；抬高上限后恢复', async () => {
    const budget = createTeamBudget({ step: 1000 })
    const inner = spender({ input: 600 })
    const stream = gate(inner.fn, budget)

    // 制作人和队员各一个请求：两个都放行，合计 1200 过了 1000
    await collect(await stream(model, context, {}))
    await collect(await stream(model, context, {}))
    expect(inner.calls()).toBe(2)

    const refused = await collect(await stream(model, context, {}))
    expect(inner.calls()).toBe(2)
    expect(refused).toEqual([
      'error:本局团队已用 1200 token，达到上限 1000，已停止。回复「继续」可再运行 1000。'
    ])

    budget.raise()
    expect(await collect(await stream(model, context, {}))).toEqual(['start', 'done'])
    expect(inner.calls()).toBe(3)
  })

  it('回到一半才失败的请求，用量照记', async () => {
    const budget = createTeamBudget({ step: 1000 })
    const failing: StreamFn = () => {
      const stream = createAssistantMessageEventStream()
      void (async () => {
        await Promise.resolve()
        stream.push({ type: 'start', partial: reply({}) })
        stream.push({
          type: 'error',
          reason: 'error',
          error: { ...reply({ input: 700 }), stopReason: 'error', errorMessage: 'bad request' }
        })
        stream.end()
      })()
      return stream
    }
    await collect(await gate(failing, budget)(model, context, {}))
    expect(budget.spent()).toBe(700)
  })

  it('不带封顶的会话不受影响', async () => {
    const inner = spender({ input: 10 ** 9 })
    const limiter = new AdaptiveLimiter(DEFAULT_GATE_CONFIG)
    const stream = pacedStreamFn(inner.fn, { limiterFor: () => limiter })
    await collect(await stream(model, context, {}))
    expect(await collect(await stream(model, context, {}))).toEqual(['start', 'done'])
  })
})
