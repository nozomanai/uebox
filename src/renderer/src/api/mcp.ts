import { unwrapResult } from '@renderer/common/utils'

/**
 * MCP 的渲染层 API。
 *
 * 渲染层不直接碰 `ipcRenderer`（AGENTS.md 硬规则 4），一律走这里。
 *
 * 两个方向别混淆：
 *   - `mcpClientAPI` —— 盒子**接入**第三方 server（我们是 client）
 *   - `mcpServerAPI` —— 盒子**对外暴露**虚幻引擎能力（我们是 server）
 */

/**
 * 界面上没有控件、但必须原样带回磁盘的字段。
 *
 * 这一层不是洁癖，是补一个真实事故：表单原来只认 id/命令行/url/停用四项，
 * `toSettings` 也只写这四项 —— 于是**用户手写在 `mcp.json` 里的其余配置，
 * 只要在设置面板里点一次保存就被抹掉**，而且没有任何提示。
 * Blender 的 `BLENDER_PATH` 就是这么丢的：env 一没，自动拉起 Blender 的整段逻辑
 * 认不出这是本机 Blender，静默不挂载（见 `capabilities/mcp/blenderBridge.ts`）。
 *
 * 所以规矩是：**表单读不懂的字段照原样搬回去**，不是丢掉。
 */
export interface PreservedServerFields {
  cwd?: string
  headers?: Record<string, string>
  allowedTools?: string[]
  readOnlyTools?: string[]
}

/** 界面用的一条 server 配置。比磁盘格式扁平，便于表单绑定 */
export interface McpServerFormValue {
  id: string
  /**
   * 这一条在盘上是什么名字。新加的行没有。
   *
   * 每条 server 各存各的之后，改名就成了「盘上多一条旧的」：用新 id 写进去，
   * 旧 id 那条还躺在 `mcp.json` 里，下次打开面板它又冒出来。存的时候拿它
   * 把旧的那条删掉。
   */
  savedId?: string
  transport: 'stdio' | 'http'
  /** stdio：完整命令行，如 `npx -y @modelcontextprotocol/server-filesystem /path` */
  commandLine: string
  /** http：远程地址 */
  url: string
  disabled: boolean
  /**
   * 信任这个 server：它的工具按可撤销的改动算，「帮我批准」档不再逐次确认。
   * 见主进程 `capabilities/mcp/types.ts`。可选是为了老的表单值不用改
   */
  trusted?: boolean
  /** stdio：环境变量，每行一条 `KEY=VALUE`。解析规则见 `parseEnvText` */
  env: string
  /** 界面管不到、但要原样保住的部分。见 `PreservedServerFields` */
  preserved: PreservedServerFields
}

/**
 * 命令行字符串 → command + args。
 *
 * 用户从文档里复制的是一整行命令，让他手工拆成 command/args 数组既反直觉又易错。
 * 支持引号，路径带空格时才不会被拆坏。
 */
export function parseCommandLine(line: string): { command: string; args: string[] } {
  const parts: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null

  for (const char of line.trim()) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
    } else if (char === '"' || char === "'") {
      quote = char
    } else if (/\s/.test(char)) {
      if (current) {
        parts.push(current)
        current = ''
      }
    } else {
      current += char
    }
  }
  if (current) parts.push(current)

  return { command: parts[0] ?? '', args: parts.slice(1) }
}

/** command + args → 命令行字符串。带空格的部分补引号，复制出去能直接用 */
export function formatCommandLine(command: string, args: string[] = []): string {
  const quote = (s: string): string => (/\s/.test(s) ? `"${s}"` : s)
  return [command, ...args].map(quote).join(' ')
}

/** 环境变量名的通行写法。放宽到中文之类只会让 server 侧拿不到 */
const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * 环境变量输入 → `Record<string, string>`。
 *
 * 认两种写法，因为用户手上的两种来源长得就是这两样：
 *   - 每行 `KEY=VALUE` —— 界面里自己敲的、`.env` 文件里抄的
 *   - 一整块 JSON —— Claude Desktop / Cursor 的配置片段、本仓库 blender 技能
 *     的 `setup.md` 给的就是这个形状，用户会整段粘进来
 *
 * `invalid` 里是**没能变成配置的那些行**。这个返回值不是装饰：整个 bug 的根子
 * 就是「悄悄丢掉」，所以解析不了的东西必须能被界面拦下来说出口，
 * 不能当成空环境变量存下去。
 */
export function parseEnvText(text: string): {
  env: Record<string, string>
  invalid: string[]
} {
  const trimmed = text.trim()
  if (!trimmed) return { env: {}, invalid: [] }

  if (trimmed.startsWith('{')) return parseEnvJson(trimmed)

  const env: Record<string, string> = {}
  const invalid: string[] = []

  for (const raw of trimmed.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue

    const at = line.indexOf('=')
    const key = at < 0 ? '' : line.slice(0, at).trim()
    if (!ENV_KEY.test(key)) {
      invalid.push(line)
      continue
    }
    env[key] = unquote(line.slice(at + 1).trim())
  }

  return { env, invalid }
}

/** 整块 JSON 的写法。解析不了就整段算无效，不去猜用户想写什么 */
function parseEnvJson(text: string): { env: Record<string, string>; invalid: string[] } {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { env: {}, invalid: [text] }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { env: {}, invalid: [text] }
  }

  const env: Record<string, string> = {}
  const invalid: string[] = []
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    // 端口这类值在别处的配置里常常写成数字，收下并转成字符串比让用户改一遍强
    const usable = typeof value === 'number' || typeof value === 'boolean' ? String(value) : value
    if (!ENV_KEY.test(key) || typeof usable !== 'string') {
      invalid.push(`${key}: ${JSON.stringify(value)}`)
      continue
    }
    env[key] = usable
  }
  return { env, invalid }
}

/** 去掉整体包裹的一对引号。文档里的路径常常带引号，留着会进到子进程里 */
function unquote(value: string): string {
  const quoted = /^"(.*)"$/.exec(value) ?? /^'(.*)'$/.exec(value)
  return quoted ? quoted[1] : value
}

/** `Record<string, string>` → 每行 `KEY=VALUE`。首尾有空白的值补引号，往返才不变 */
export function formatEnvText(env: Record<string, string> | undefined): string {
  if (!env) return ''
  return Object.entries(env)
    .map(([key, value]) => `${key}=${value !== value.trim() ? `"${value}"` : value}`)
    .join('\n')
}

/** 磁盘格式 → 表单值 */
export function toFormValues(settings: McpSettings): McpServerFormValue[] {
  return Object.entries(settings.mcpServers ?? {}).map(([id, config]) => ({
    id,
    savedId: id,
    transport: config.url ? 'http' : 'stdio',
    commandLine: config.command ? formatCommandLine(config.command, config.args) : '',
    url: config.url ?? '',
    disabled: config.disabled === true,
    // 只有信任了才带这个键：老的表单值和往返比较都不用跟着改
    ...(config.trusted === true ? { trusted: true } : {}),
    env: formatEnvText(config.env),
    preserved: {
      ...(config.cwd ? { cwd: config.cwd } : {}),
      ...(config.headers ? { headers: config.headers } : {}),
      ...(config.allowedTools ? { allowedTools: config.allowedTools } : {}),
      ...(config.readOnlyTools ? { readOnlyTools: config.readOnlyTools } : {})
    }
  }))
}

/** 换连接方式时，另一形态专属的字段不该跟着串过去 */
function sharedPreserved(preserved: PreservedServerFields): PreservedServerFields {
  return {
    ...(preserved.allowedTools ? { allowedTools: preserved.allowedTools } : {}),
    ...(preserved.readOnlyTools ? { readOnlyTools: preserved.readOnlyTools } : {})
  }
}

/** 表单值 → 磁盘格式。跳过明显填不全的条目而不是写一条坏配置进去 */
export function toSettings(values: McpServerFormValue[]): McpSettings {
  const mcpServers: Record<string, McpServerConfigView> = {}

  for (const value of values) {
    const id = value.id.trim()
    if (!id) continue

    const preserved = value.preserved ?? {}
    if (value.transport === 'http') {
      if (!value.url.trim()) continue
      mcpServers[id] = {
        type: 'http',
        url: value.url.trim(),
        ...(preserved.headers ? { headers: preserved.headers } : {}),
        ...sharedPreserved(preserved),
        ...(value.disabled ? { disabled: true } : {}),
        ...(value.trusted ? { trusted: true } : {})
      }
    } else {
      const { command, args } = parseCommandLine(value.commandLine)
      if (!command) continue
      const { env } = parseEnvText(value.env ?? '')
      mcpServers[id] = {
        type: 'stdio',
        command,
        ...(args.length ? { args } : {}),
        ...(Object.keys(env).length ? { env } : {}),
        ...(preserved.cwd ? { cwd: preserved.cwd } : {}),
        ...sharedPreserved(preserved),
        ...(value.disabled ? { disabled: true } : {}),
        ...(value.trusted ? { trusted: true } : {})
      }
    }
  }

  return { version: 1, mcpServers }
}

/** serverId 会成为工具名的一部分，非法字符会让整个模型请求被厂商拒掉 */
export function isValidServerId(id: string): boolean {
  return /^[a-zA-Z0-9_-]{1,32}$/.test(id)
}

/**
 * 自动发现出来的 UE 官方 server 的 id 前缀。
 *
 * 与主进程 `agent-v3/capabilities/mcp/epicToolsets.ts` 的 `EPIC_SERVER_ID_PREFIX`
 * 必须一致 —— 那边是唯一真相源，这里只是渲染层不便跨进程引用而复述一遍。
 */
const ENGINE_SERVER_ID_PREFIX = 'ue-official'

/**
 * 这条状态是不是引擎自动发现来的。
 *
 * 用来把它和用户手配的分开呈现：它不在 `mcp.json` 里，用户在列表里删不掉也改不动，
 * 混在一起只会让人找一个根本不存在的配置项。
 */
export function isEngineServerId(id: string): boolean {
  return id === ENGINE_SERVER_ID_PREFIX || id.startsWith(`${ENGINE_SERVER_ID_PREFIX}-`)
}

/**
 * 一个已连接项目的「UE 5.8 官方 MCP」开启状态。
 *
 * 状态分这么细是因为**每种状态该给用户的下一步都不一样**：能一键的给按钮，
 * 要重启的说重启，引擎太老的干脆别显示，免得让人白试。
 */
export interface EpicSetupProjectStatus {
  connectionId: string
  projectName: string
  state: 'unsupported' | 'needs-plugins' | 'needs-restart' | 'needs-start' | 'ready'
  missingPlugins: string[]
  autoStartEnabled: boolean
  url: string
}

/**
 * 官方 Blender Lab MCP 的一键状态。
 *
 * 状态分四档的理由同 `EpicSetupProjectStatus`：每一档该给用户的下一步都不一样
 * —— 能装的给按钮，缺前置的点名说缺什么，配过的只报一眼状态，
 * Linux 干脆别显示按钮，免得让人白点。
 */
export interface BlenderSetupStatus {
  state: 'configured' | 'ready' | 'blocked' | 'unsupported'
  prerequisites: Array<{
    id: 'blender' | 'git' | 'python'
    ok: boolean
    found?: string
    path?: string
    problem?: 'missing' | 'too-old'
  }>
  blenderPath?: string
  installRoot: string
  configuredBlenderPath?: string
  /** 已配好时那条 server 的 id。界面拿它去 `statuses` 里查连上没有 */
  configuredServerId?: string
}

/**
 * 一键装出来的那条 server 在 `mcp.json` 里的 id。
 *
 * 与主进程 `capabilities/mcp/blenderSetup.ts` 的 `BLENDER_SERVER_ID` 必须一致 ——
 * 那边是唯一真相源，这里只是渲染层不便跨进程引用而复述一遍（同
 * `ENGINE_SERVER_ID_PREFIX`）。
 */
export const BLENDER_SERVER_ID = 'blender'

export const mcpClientAPI = {
  getSettings() {
    return window.api.agentV3.mcp.getSettings()
  },
  saveSettings(settings: McpSettings) {
    return window.api.agentV3.mcp.saveSettings({ settings })
  },
  reconnect() {
    return window.api.agentV3.mcp.reconnect()
  },
  /** 删一条 server 并当场落盘。不碰别的行，也不提交表单里未保存的编辑 */
  removeServer(id: string) {
    return window.api.agentV3.mcp.removeServer({ id })
  },
  /**
   * 存一条 server 并重连。`renamedFrom` 非空时顺手把旧名字那条删掉。
   *
   * 每条各存各的：不碰盘上别的条目，也不提交别的行里没保存的编辑。
   */
  saveServer(id: string, config: McpServerConfigView, renamedFrom?: string) {
    return window.api.agentV3.mcp.saveServer({ id, config, renamedFrom })
  },
  epicStatus() {
    return window.api.agentV3.mcp.epicStatus()
  },
  epicSetup(connectionId: string) {
    return window.api.agentV3.mcp.epicSetup({ connectionId })
  },
  blenderStatus() {
    return window.api.agentV3.mcp.blenderStatus()
  },
  /** 装一次要几分钟：要 git fetch、建 venv、pip 装依赖、再起两次后台 Blender */
  blenderSetup(blenderPath?: string) {
    return window.api.agentV3.mcp.blenderSetup(blenderPath ? { blenderPath } : {})
  },
  /** 用 winget 装缺的 Git / Python，一个几分钟；装 Git 会弹一次管理员确认 */
  blenderInstallPrereqs(ids: Array<'git' | 'python'>) {
    return window.api.agentV3.mcp.blenderInstallPrereqs({ ids })
  }
}

/** 端口输入框的合法范围。1024 以下在 Windows 上要管理员权限 */
export function isValidPort(value: number): boolean {
  return Number.isInteger(value) && value >= 1024 && value <= 65535
}

export const mcpServerAPI = {
  start(options: { namespaces?: string[]; includeMutating?: boolean; port?: number } = {}) {
    return window.api.agentV3.mcpServer.start(options)
  },
  stop() {
    return window.api.agentV3.mcpServer.stop()
  },
  status() {
    return window.api.agentV3.mcpServer.status()
  },
  rotateToken() {
    return window.api.agentV3.mcpServer.rotateToken()
  },
  /**
   * 写进外部客户端的配置。回 `{ success, path?, error? }` 不抛：
   * 用户点一下就发一次，失败原因（配置文件解析不了）要原样显示给他。
   */
  installClient(client: 'claude-code' | 'codex') {
    return window.api.agentV3.mcpServer.installClient(client)
  },
  /** 保存配置；运行中变更会自动重启，失败时抛出具体原因给界面 */
  async saveConfig(args: { port?: number; includeMutating?: boolean }) {
    const result = await window.api.agentV3.mcpServer.saveConfig(args)
    return unwrapResult({ ...result, data: result.status })
  }
}
