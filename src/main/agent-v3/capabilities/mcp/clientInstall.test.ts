/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

vi.mock('./hostStore', () => ({
  hostUrl: (s: { port: number }) => `http://127.0.0.1:${s.port}/`,
  readHostSettings: vi.fn()
}))

import { clientConfigPath, mergeClaudeCodeConfig, mergeCodexConfig } from './clientInstall'

const settings = { enabled: true, port: 8790, token: 'tok', includeMutating: true }

describe('写进 Claude Code 的 ~/.claude.json', () => {
  it('只加 mcpServers.unreal-box，别的字段和别的服务原样保留', () => {
    const raw = JSON.stringify({
      numStartups: 42,
      projects: { 'D:/x': { allowedTools: [] } },
      mcpServers: { other: { command: 'npx' } }
    })
    const out = JSON.parse(mergeClaudeCodeConfig(raw, settings))
    expect(out.numStartups).toBe(42)
    expect(out.projects).toEqual({ 'D:/x': { allowedTools: [] } })
    expect(out.mcpServers.other).toEqual({ command: 'npx' })
    expect(out.mcpServers['unreal-box']).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:8790/',
      headers: { Authorization: 'Bearer tok' }
    })
  })

  it('文件不存在时新建', () => {
    expect(JSON.parse(mergeClaudeCodeConfig(null, settings)).mcpServers['unreal-box'].url).toBe(
      'http://127.0.0.1:8790/'
    )
  })

  it('解析不了就抛错，不覆盖用户的文件', () => {
    expect(() => mergeClaudeCodeConfig('{ broken', settings)).toThrow()
    expect(() => mergeClaudeCodeConfig('[1,2]', settings)).toThrow(/JSON 对象/)
  })
})

describe('写进 Codex 的 config.toml', () => {
  it('追加一张表，别的内容不动', () => {
    const raw = 'model = "gpt-6"\n\n[mcp_servers.figma]\ncommand = "npx"\n'
    const out = mergeCodexConfig(raw, settings)
    expect(out).toContain('model = "gpt-6"\n\n[mcp_servers.figma]\ncommand = "npx"\n')
    expect(out).toContain(
      '[mcp_servers.unreal-box]\nurl = "http://127.0.0.1:8790/"\n' +
        'http_headers = { Authorization = "Bearer tok" }\n'
    )
  })

  it('已有旧的 unreal-box（含子表、带引号的写法）整段换掉，后面的表保留', () => {
    const raw = [
      '[mcp_servers."unreal-box"]',
      'url = "http://127.0.0.1:1111/"',
      '[mcp_servers.unreal-box.env]',
      'A = "1"',
      '[profiles.fast]',
      'model = "x"'
    ].join('\n')
    const out = mergeCodexConfig(raw, settings)
    expect(out).not.toContain('1111')
    expect(out).not.toContain('A = "1"')
    expect(out).toContain('[profiles.fast]\nmodel = "x"')
    expect(out.match(/\[mcp_servers\.unreal-box\]/g)).toHaveLength(1)
  })

  it('文件不存在时只有这一张表', () => {
    expect(mergeCodexConfig(null, settings).startsWith('[mcp_servers.unreal-box]')).toBe(true)
  })

  it('CODEX_HOME 优先', () => {
    expect(clientConfigPath('codex', { CODEX_HOME: 'D:/codex' })).toMatch(
      /^D:[\\/]codex[\\/]config\.toml$/
    )
  })
})
