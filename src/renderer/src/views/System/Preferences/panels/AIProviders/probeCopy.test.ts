/**
 * 「测试连接」那一句话，英文用户也得读得懂。
 *
 * 红灯用例：把界面语言切成 English，去设置 → 模型点「测试连接」，
 * 密钥填错时弹出来的是「API Key 无效或已失效。」—— 一整句中文。
 * 而这恰恰是他最需要读懂的一句：密钥对不对、地址通不通、协议选没选错，全看它。
 *
 * 根因是主进程直接返回了成品中文（`main/ai/probe.ts`）。改成回码之后，
 * 这里守两件事：**每个码两侧都配了文案**，以及**没配上时不会把 key 甩给用户**。
 */
import { describe, expect, it, beforeEach } from 'vitest'

import enUS from '@renderer/i18n/locales/en-US'
import i18n from '@renderer/i18n'
import zhCN from '@renderer/i18n/locales/zh-CN'

import { describeProbeFailure } from './probeCopy'

/** 主进程可能回的每一个码。新增码时这里要跟着加，否则文案漏配没人发现 */
const ALL_CODES = [
  'timeout',
  'unauthorized',
  'forbidden',
  'providerServerError',
  'modelNotFound',
  'rateLimited',
  'badRequest',
  'protocolMismatch',
  'toolsRejected',
  'unreachable',
  'unknown',
  'listUnsupportedGenerative',
  'listUnsupportedProtocol',
  'listUnsupportedCodex',
  'listUnsupportedCursor',
  'listHttpError',
  'listEmpty',
  'noDraft'
] as const

describe('describeProbeFailure', () => {
  beforeEach(() => {
    i18n.global.locale.value = 'zh-CN'
  })

  it('每个码在中英两侧都配了文案', () => {
    const missing: string[] = []
    for (const code of ALL_CODES) {
      for (const [name, pack] of [
        ['zh-CN', zhCN],
        ['en-US', enUS]
      ] as const) {
        const value = (pack.aiProvider.probe as Record<string, unknown>)[code]
        if (typeof value !== 'string') missing.push(`${name}.${code}`)
      }
    }
    expect(missing.join(', ')).toBe('')
  })

  it('跟着界面语言走 —— 这条用例存在的全部理由', () => {
    const zh = describeProbeFailure({ code: 'unauthorized' })
    i18n.global.locale.value = 'en-US'
    const en = describeProbeFailure({ code: 'unauthorized' })

    expect(zh).toContain('API 密钥')
    expect(en).toContain('API key')
    expect(en).not.toMatch(/[一-鿿]/)
  })

  it('5xx 和 400 把厂商原话带上 —— 翻译过去仍然说不清的那几种', () => {
    const text = describeProbeFailure({
      code: 'providerServerError',
      raw: 'quota pool missing'
    })
    expect(text).toContain('通常与本地配置无关')
    expect(text).toContain('quota pool missing')
  })

  it('403 把厂商原话带上 —— 中转站的客户端校验也回 403，不全是密钥没权限', () => {
    const text = describeProbeFailure({ code: 'forbidden', raw: '403 请使用标准 Codex 客户端请求' })
    expect(text).toContain('403')
    expect(text).toContain('请使用标准 Codex 客户端请求')
  })

  it('不带原文的码不拼后缀', () => {
    expect(describeProbeFailure({ code: 'unauthorized', raw: '401 whatever' })).not.toContain(
      '401 whatever'
    )
  })

  /*
   * 归不上类的那一档，整个内容就是厂商原话。
   *
   * 红灯用例：机器上没有安全存储 → `materialize()` 抛 `EncryptionUnavailableError`
   * → `failProbe()` 回 `{ code:'unknown', raw:'<真正的原因>' }` → 界面显示
   * 「连接失败，但厂商没有给出原因。」。这句话是**假的**，而且用户手里没有任何
   * 能拿去搜、能贴进求助帖的东西。改动之前他看到的就是那句原话。
   */
  it('unknown 带原文时只显示原文，不说「没有给出原因」', () => {
    const text = describeProbeFailure({
      code: 'unknown',
      raw: 'unable to access keyring: no such interface'
    })
    expect(text).toBe('unable to access keyring: no such interface')
    expect(text).not.toContain('没有给出原因')
  })

  it('unknown 没有原文时才说「没有给出原因」', () => {
    expect(describeProbeFailure({ code: 'unknown' })).toBe(zhCN.aiProvider.probe.unknown)
  })

  /*
   * 主进程加了新码却忘了配文案时，用户该看到英文原始错误，
   * 而不是一句 `aiProvider.probe.somethingNew` —— 后者既读不懂也没法搜。
   */
  it('没配文案时退回原文，绝不把 i18n key 甩给用户', () => {
    const text = describeProbeFailure({ code: 'somethingNew', raw: 'HTTP 418 teapot' } as never)
    expect(text).toBe('HTTP 418 teapot')
    expect(text).not.toContain('aiProvider.probe')
  })

  it('连原文都没有时也不露 key', () => {
    const text = describeProbeFailure({ code: 'somethingNew' } as never)
    expect(text).not.toContain('aiProvider.probe')
    expect(text).toBe(zhCN.aiProvider.probe.unknown)
  })

  it('空值不炸', () => {
    expect(describeProbeFailure(null)).toBeTypeOf('string')
    expect(describeProbeFailure(undefined)).toBeTypeOf('string')
  })
})

// 换着试出来的协议要写进那句话里：只说「协议不对」用户还得自己猜该换成哪个
it('protocolMismatch 说出试通的那个协议', () => {
  i18n.global.locale.value = 'zh-CN'
  expect(
    describeProbeFailure({ code: 'protocolMismatch', suggestedProtocol: 'openai-responses' })
  ).toContain('openai-responses')
})
