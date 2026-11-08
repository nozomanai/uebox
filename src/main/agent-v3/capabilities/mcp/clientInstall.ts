/**
 * 一键把盒子的对外 MCP 写进 Claude Code / Codex 的用户级配置。
 *
 * 「复制配置 → 找到配置文件 → 粘进去」对 UE 开发者是三步运维活：Claude Code 的用户级
 * 配置藏在 `~/.claude.json` 里一大坨状态中间，Codex 用的是 TOML，格式和 JSON 片段对不上。
 * 这里替用户做这一步。
 *
 * 只动自己那一条（`unreal-box`），文件里别的东西原样保留；文件解析不了就报错，
 * 不覆盖 —— 那是用户的配置，写坏了他的 Claude Code / Codex 都起不来。
 * 写入走「临时文件 + 改名」，写到一半断电也不会留下半个文件。
 */

import { promises as fs } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'

import { hostUrl, readHostSettings, type McpHostSettings } from './hostStore'

export type McpClientId = 'claude-code' | 'codex'

export const SERVER_NAME = 'unreal-box'

export function clientConfigPath(client: McpClientId, env = process.env): string {
  if (client === 'claude-code') return join(homedir(), '.claude.json')
  return join(env.CODEX_HOME || join(homedir(), '.codex'), 'config.toml')
}

/** Claude Code：顶层 `mcpServers` 里放一条 HTTP 服务，其余字段一个不碰 */
export function mergeClaudeCodeConfig(raw: string | null, settings: McpHostSettings): string {
  let config: Record<string, unknown> = {}
  if (raw && raw.trim()) {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('配置文件不是一个 JSON 对象')
    }
    config = parsed as Record<string, unknown>
  }
  const servers =
    config.mcpServers && typeof config.mcpServers === 'object' && !Array.isArray(config.mcpServers)
      ? (config.mcpServers as Record<string, unknown>)
      : {}
  config.mcpServers = {
    ...servers,
    [SERVER_NAME]: {
      type: 'http',
      url: hostUrl(settings),
      headers: { Authorization: `Bearer ${settings.token}` }
    }
  }
  return `${JSON.stringify(config, null, 2)}\n`
}

const tomlString = (value: string): string => JSON.stringify(value)

/**
 * Codex：去掉旧的 `[mcp_servers.unreal-box]`（连同它的子表），在末尾追加新的。
 * 不引 TOML 库：只认自己写进去的那种表头，别的行原样保留。
 */
export function mergeCodexConfig(raw: string | null, settings: McpHostSettings): string {
  const lines = (raw ?? '').split(/\r?\n/)
  const ours = /^\s*\[\s*mcp_servers\s*\.\s*(?:"unreal-box"|unreal-box)\s*(?:\.[^\]]*)?\]\s*(#.*)?$/
  const anyTable = /^\s*\[/
  const kept: string[] = []
  let skipping = false
  for (const line of lines) {
    if (anyTable.test(line)) skipping = ours.test(line)
    if (!skipping) kept.push(line)
  }
  while (kept.length && !kept[kept.length - 1].trim()) kept.pop()
  const block = [
    `[mcp_servers.${SERVER_NAME}]`,
    `url = ${tomlString(hostUrl(settings))}`,
    `http_headers = { Authorization = ${tomlString(`Bearer ${settings.token}`)} }`
  ]
  return [...kept, ...(kept.length ? [''] : []), ...block, ''].join('\n')
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function writeAtomic(path: string, content: string): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true })
  const temp = `${path}.uebox-${process.pid}.tmp`
  await fs.writeFile(temp, content, 'utf8')
  await fs.rename(temp, path)
}

export async function installMcpClient(client: McpClientId): Promise<{ path: string }> {
  const settings = await readHostSettings()
  const path = clientConfigPath(client)
  const raw = await readIfExists(path)
  let next: string
  try {
    next =
      client === 'claude-code'
        ? mergeClaudeCodeConfig(raw, settings)
        : mergeCodexConfig(raw, settings)
  } catch (error) {
    throw new Error(
      `${path} 解析失败，没有改动：${error instanceof Error ? error.message : String(error)}`
    )
  }
  await writeAtomic(path, next)
  return { path }
}
