<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import AppCheckbox from '@renderer/components/AppCheckbox.vue'
/**
 * MCP 设置。
 *
 * 两个方向分开呈现，别让用户混淆：
 *   - 上半：**接入**第三方 server（盒子是 client）
 *   - 下半：**对外暴露**虚幻引擎能力（盒子是 server）
 *
 * ## 渐进披露：两半都要守
 *
 * 判据只有一条 —— **每次进这个页面，用户是来干什么的？**
 * 答案是「看一眼通没通」和「开不开」。不是来改启动命令、调端口、读安全条款的。
 * 所以默认态就该只有这两样，其余全部折起来。
 *
 * 下半页（对外暴露）分三层：
 *
 *   1. 常驻：一个开关 + 一行状态。这是 99% 的访问只需要的东西。
 *   2. 「连接配置」展开：粘给外部客户端的那段 JSON 和令牌。
 *      配一次就不用再看，不该常驻。
 *   3. 「端口和权限」展开：端口、写工具开关、那段长警告。
 *
 * 上半页（接入第三方）同一条规矩：**每条 server 收起来只有一行** ——
 * 名字 + 通没通 + 删除。四个输入框只在展开时出现。
 * 这一条曾经整个漏掉，一条 blender 就占掉半屏。
 *
 * ## 折叠区藏默认值，标签负责预告风险
 *
 * 权限档一度被提到主开关同层，理由是「不能把风险藏进『高级』」。那个理由只对了
 * 一半：毛病是**「高级」这两个字不预告里面有什么**，不是它折起来了。
 * 现在标题直接叫「端口和权限」，当前档位（只读/可写）挂在标题上 ——
 * 不展开也看得见，第一屏还少一块。
 *
 * 安全警告同理：默认只有一行短的（只监听本机 / 要令牌 / 可写），
 * **可写时在权限设置里展开那段长的** —— 风险相关的位置明确提示。
 * 常驻的警告等于没有警告。
 */
import { PhCaretRight } from '@phosphor-icons/vue'
import { computed, nextTick, onMounted, ref } from 'vue'
import { message } from '@renderer/utils/messageManager'
import { useI18n } from 'vue-i18n'

import {
  isEngineServerId,
  isValidPort,
  isValidServerId,
  mcpClientAPI,
  mcpServerAPI,
  parseEnvText,
  toFormValues,
  toSettings,
  BLENDER_SERVER_ID,
  type BlenderSetupStatus,
  type EpicSetupProjectStatus,
  type McpServerFormValue
} from '@renderer/api/mcp'
import { startAgentChat } from '@renderer/views/Assistant/composables/handOffToAgent'
import AppSwitch from '@renderer/components/AppSwitch.vue'

const { t } = useI18n()

const servers = ref<McpServerFormValue[]>([])
const statuses = ref<McpServerStatus[]>([])
const configPath = ref('')
/** 正在存的那一条的 id。按行存，所以「正在忙」也是按行的 */
const savingId = ref('')
const saveError = ref('')

/** 停止状态下也带着端口/令牌/配置片段，所以初值要给全 */
const EMPTY_HOST: McpServerHostView = {
  running: false,
  exposedTools: 0,
  url: '',
  clientConfig: '',
  settings: { enabled: false, port: 17861, token: '', includeMutating: true }
}

const host = ref<McpServerHostView>({ ...EMPTY_HOST })
const includeMutating = ref(true)
const port = ref(17861)
const hostBusy = ref(false)
const copied = ref('')

/** 两块折叠区。默认都收起 —— 配一次就不用再看的东西不该常驻 */
const showConfig = ref(false)
const showAdvanced = ref(false)

const portError = computed(() => (isValidPort(port.value) ? '' : t('mcp.server.portInvalid')))

/**
 * 令牌打码。
 *
 * 它是凭据，没理由一直摊在屏幕上 —— 用户身边有人、或者在录屏/共享桌面时
 * 尤其如此。要用的时候点「复制令牌」，要核对的时候看头尾就够了。
 */
const maskedToken = computed(() => {
  const token = host.value.settings?.token ?? ''
  if (token.length <= 16) return token
  return `${token.slice(0, 8)}……${token.slice(-6)}`
})

/**
 * 预览里的令牌也要打码。
 *
 * 上面那段打码原来**完全是白做的**：同一把令牌一字不差地印在上方那块 JSON 里，
 * 字号还更大。屏幕上但凡有第二个人、或者正在录屏共享，泄露的是那一块，
 * 不是底下那行头尾。
 *
 * 复制走的始终是完整的 `clientConfig` —— 打码是给眼睛看的，不影响粘贴。
 * 要肉眼核对完整值就点「显示」，那是一个明确的动作。
 */
const revealToken = ref(false)

const displayedConfig = computed(() => {
  const token = host.value.settings?.token ?? ''
  const config = host.value.clientConfig ?? ''
  if (!token || revealToken.value) return config
  return config.split(token).join(maskedToken.value)
})

const statusById = computed(() => new Map(statuses.value.map((s) => [s.id, s])))

const duplicateIds = computed(() => {
  const seen = new Set<string>()
  const dupes = new Set<string>()
  for (const s of servers.value) {
    const id = s.id.trim()
    if (!id) continue
    if (seen.has(id)) dupes.add(id)
    seen.add(id)
  }
  return dupes
})

/**
 * 一个字都没填的行。
 *
 * **这是这一节里最值钱的一个判断**，一条规则解掉三个毛病：
 *
 *   - 点「添加服务」立刻蹦出一句「标识不能为空」—— 用户还没输入就被判有罪
 *   - 那条红字让 `hasErrors` 为真，「保存并连接」整个禁掉，
 *     于是他连**刚刚在另一行改好的东西**都存不了
 *   - 存的时候还得想「这条空行会不会被写进 mcp.json」
 *
 * 加机制（逐行 touched 标记、失焦才校验、保存时再统一飘红）都能治，
 * 但都是往上堆。真正的语义很简单：**加了没填就等于没加**。
 * 空行不报错、不挡保存、保存时丢掉。
 */
function isBlankRow(value: McpServerFormValue): boolean {
  return (
    !value.id.trim() && !value.commandLine.trim() && !value.url.trim() && !(value.env ?? '').trim()
  )
}

function idError(value: McpServerFormValue): string {
  if (isBlankRow(value)) return ''
  const id = value.id.trim()
  if (!id) return t('mcp.errors.idRequired')
  if (!isValidServerId(id)) return t('mcp.errors.idInvalid')
  if (duplicateIds.value.has(id)) return t('mcp.errors.idDuplicate')
  return ''
}

/**
 * 这条是不是还没存过。
 *
 * 用「有没有状态」判断，而不是再维护一份影子数据：存过的 server 一定会带回
 * 一条状态（连上了 / 连不上 / 被停用），**只有没存过的那条什么都没有**。
 * 草稿和已生效的配置长得一模一样，用户分不出哪条正在跑。
 */
function isDraftRow(value: McpServerFormValue): boolean {
  return !isBlankRow(value) && !statusById.value.has(value.id.trim())
}

/**
 * 认不出来的环境变量行。
 *
 * 必须挡住保存，不能只是灰着提示一句：这个面板刚因为「悄悄丢配置」出过事
 * （见 `api/mcp.ts` 的 `PreservedServerFields`），再让一行写错的 env 静默消失，
 * 用户看到的又会是「配了，但没生效，也没人告诉我」。
 */
function envError(value: McpServerFormValue): string {
  if (value.transport !== 'stdio') return ''
  const { invalid } = parseEnvText(value.env ?? '')
  if (invalid.length === 0) return ''
  return t('mcp.errors.envInvalid', { line: invalid[0] })
}

/** 这一行自己有没有填错。挡的只是它自己的保存按钮 */
function rowError(value: McpServerFormValue): string {
  return idError(value) || envError(value)
}

/**
 * 盘上现在是什么：id → 那一条配置的 JSON。
 *
 * ## 为什么是逐条，不是整张表一个快照
 *
 * 每条 server 各存各的（见 `saveRow`），所以「有没有改过」也必须逐条问。
 * 原来是整张表一个 `savedSnapshot`，那时候保存也是整张表一起写，两者是配的；
 * 现在按行存，再用整表快照就会出现「A 行存完了，B 行因为还没存而让 A 也
 * 显示成未保存」。
 *
 * 比较用 `toSettings([row])` 的结果而不是表单值本身 —— 表单里
 * `commandLine` 和 `env` 是文本，多一个空格、换一下行序都会变，但落盘的
 * 结果一模一样。拿文本比会让一条没改过的配置一直亮着「未保存」。
 */
const diskSnapshot = ref<Record<string, string>>({})

function rowSnapshot(value: McpServerFormValue): string {
  const id = value.id.trim()
  return JSON.stringify(toSettings([value]).mcpServers[id] ?? null)
}

function rememberDisk(settings: McpSettings): void {
  const next: Record<string, string> = {}
  for (const row of toFormValues(settings)) next[row.id] = rowSnapshot(row)
  diskSnapshot.value = next
}

/**
 * 这一行和盘上不一样吗？
 *
 * 空行不算（还没填，谈不上改动）。盘上没有这个 id 的一律算「没存过」——
 * 新加的行、以及刚改过名的行都落在这里，两种都确实还没写进 `mcp.json`。
 */
function isRowDirty(value: McpServerFormValue): boolean {
  if (isBlankRow(value)) return false
  const saved = diskSnapshot.value[value.id.trim()]
  return saved === undefined || saved !== rowSnapshot(value)
}

/**
 * 引擎自动发现来的 server（UE 5.8 内置的官方 MCP）。
 *
 * 它不在 `mcp.json` 里，所以不能混进上面那张可编辑的表 —— 用户会去找一个
 * 删不掉也改不动的条目。单独一块只读地列出来，并告诉他怎么覆盖。
 *
 * 用户如果真在 `mcp.json` 里写了同名条目，那条就归可编辑列表管，这里不再重复。
 */
const engineStatuses = computed(() => {
  const configured = new Set(servers.value.map((s) => s.id.trim()))
  return statuses.value.filter((s) => isEngineServerId(s.id) && !configured.has(s.id))
})

/** 状态胶囊。停用是用户自己的选择，不能和连接失败混为一谈 */
function chipOf(rawId: string): { tone: string; label: string; title: string } | undefined {
  const status = statusById.value.get(rawId.trim())
  if (!status) return undefined
  if (status.disabled) return { tone: 'muted', label: t('mcp.status.disabled'), title: '' }
  if (status.connected) {
    return { tone: 'ok', label: t('mcp.status.connected', { count: status.toolCount }), title: '' }
  }
  return { tone: 'bad', label: t('mcp.status.failed'), title: status.error ?? '' }
}

/**
 * 连不上的原因。
 *
 * 原来只塞在胶囊的 `title` 里 —— 而这个文件自己早就写过那句教训：
 * **会去排查的人不会想到悬停**。一条「连接失败」不带原因，用户能做的只有瞪着它；
 * 而原因往往一句话就说清了（`spawn npx ENOENT`、`ECONNREFUSED`），
 * 是这一屏信息量最大的一行字。
 */
function errorOf(rawId: string): string {
  const status = statusById.value.get(rawId.trim())
  if (!status || status.connected || status.disabled) return ''
  return status.error ?? ''
}

/** 停用是用户自己关的，不算「连不上」 */
const engineFailed = computed(() => engineStatuses.value.some((s) => !s.connected && !s.disabled))

/**
 * 引擎块收起时那一行的状态。
 *
 * 有一个连不上就整块报失败 —— 折叠区最怕的就是把问题盖住，
 * 收起来的那一行必须自己说清楚里面是好是坏。
 */
const engineSummary = computed((): { tone: string; label: string } | undefined => {
  const list = engineStatuses.value
  if (list.length === 0) return undefined
  if (engineFailed.value) return { tone: 'bad', label: t('mcp.status.failed') }

  const connected = list.filter((s) => s.connected)
  if (connected.length === 0) return { tone: 'muted', label: t('mcp.status.disabled') }
  const count = connected.reduce((sum, s) => sum + (s.toolCount ?? 0), 0)
  return { tone: 'ok', label: t('mcp.engine.connected', { count }) }
})

/**
 * 连不上的时候强制摊开。
 *
 * 和 server 行同一条规矩：错误原因和重试按钮藏在折叠里等于不存在。
 * 好好跑着的时候才允许收成一行 —— 那时候里面确实没有要处理的事。
 */
const showEngine = ref(false)

/**
 * 把主进程回的视图落到本地表单状态。
 *
 * **必须容忍字段缺失。** 开发时改渲染层是热更新的，主进程不会跟着重启 ——
 * 于是新界面配上旧主进程，`status` 里没有 `settings`，
 * `view.settings.includeMutating` 直接抛 TypeError：`load()` 挂掉、
 * 面板停在初始状态、开关按下去没反应、连接配置那块也出不来。
 * 用户报的三条症状都能由这一个异常解释。
 *
 * 打包版本不会出现这种搭配，但开发时天天遇到，不该让面板整个废掉。
 */
function applyHost(view: McpServerHostView | undefined): void {
  if (!view) return
  const settings = { ...EMPTY_HOST.settings, ...(view.settings ?? {}) }
  host.value = {
    ...EMPTY_HOST,
    ...view,
    settings,
    url: view.url || `http://127.0.0.1:${settings.port}/`
  }
  includeMutating.value = settings.includeMutating
  port.value = settings.port
}

/**
 * 启停之后回主进程要一次真实状态。
 *
 * 不信任 start/stop 自己回的那个：万一某一步只成功了一半（端口占用、
 * 关闭超时），界面显示的必须是服务**实际**在什么状态，
 * 而不是这次操作声称的结果。开关卡住的观感就是这么来的。
 */
async function refreshHost(): Promise<void> {
  try {
    applyHost(await mcpServerAPI.status())
  } catch (error) {
    console.warn('[MCP] 刷新对外服务状态失败:', error)
  }
}

/**
 * 上下两半分开加载。
 *
 * 一开始是一个 `load()` 串着两个请求，结果下半页（对外暴露）出错时
 * 上半页也一起白掉。两块之间没有依赖，不该互相拖累。
 */
async function load(): Promise<void> {
  try {
    const result = await mcpClientAPI.getSettings()
    servers.value = toFormValues(result.settings)
    statuses.value = result.statuses
    configPath.value = result.path
    // 逐条的「未保存」基准线。读失败时留空 —— 那时候一切改动都无从比较，
    // 顶着一个假的「已保存」比不显示更糟
    rememberDisk(result.settings)
  } catch (error) {
    console.warn('[MCP] 读取第三方 server 配置失败:', error)
  }
  await Promise.all([refreshHost(), refreshEpic(), refreshBlender()])
}

/**
 * 一键开启 UE 5.8 官方 MCP。
 *
 * 手工流程要在 Edit > Plugins 和 Editor Preferences 两个面板里点四步，
 * **大部分用户走不完，走不完就等于这个能力不存在**。这里代劳前三步。
 *
 * ## 这一块永远显示（除非已经开好了）
 *
 * 初版写的是「没有可操作项目就整个不渲染」，理由是「不给用户一个永远点不了的
 * 按钮」。**那个理由是错的**：结果不是界面更干净，而是用户在设置页里
 * 什么都看不到，也无从知道为什么 —— 没连项目、引擎太老、主进程没起来，
 * 三种完全不同的原因长得一模一样，都是「一片空白」。
 *
 * 空白不是「没有噪音」，空白是「看起来坏了」。所以现在：块常驻，
 * **能一键就给按钮，不能就说清楚差什么**。只有真正开好了（ready）才收起来 ——
 * 那时下面的自动发现块已经在报「已连接」，再留一块就真是重复了。
 */
const epicProjects = ref<EpicSetupProjectStatus[]>([])
const epicBusy = ref('')
const epicMessage = ref('')
const epicError = ref('')
const epicLoading = ref(true)

/** 可以点按钮的项目 */
const epicActionable = computed(() =>
  epicProjects.value.filter((p) => p.state === 'needs-plugins' || p.state === 'needs-start')
)

/** 配好了但还没重启编辑器的 */
const epicPendingRestart = computed(() =>
  epicProjects.value.filter((p) => p.state === 'needs-restart')
)

/** 引擎版本不够的。要点名说出来，否则用户只会觉得「按钮怎么不见了」 */
const epicUnsupported = computed(() => epicProjects.value.filter((p) => p.state === 'unsupported'))

/** 已经开好的。正常情况下由下面的自动发现块接手报状态，这里只在它没接上时兜底 */
const epicReady = computed(() => epicProjects.value.filter((p) => p.state === 'ready'))

/** 空列表不算：那说明一个项目都没连，得告诉用户先去打开项目 */
const epicAllReady = computed(
  () => epicProjects.value.length > 0 && epicProjects.value.every((p) => p.state === 'ready')
)

/**
 * 探到服务在跑、缓存里却没有它 —— 自动补一次重连。
 *
 * `currentStatuses()` 只有在 agent 跑过一次、或用户手点「重新连接」时才会更新，
 * 没有任何东西会因为「用户刚打开了工程」去重新发现。不补的话用户得自己猜到
 * 去点那个跟引擎看起来毫无关系的按钮。
 *
 * 一次挂载只补一次：补不上（发现的三道门有一道没过）就让上面的 ready 行兜底，
 * 不要在这儿空转。
 */
const engineReconnectTried = ref(false)

async function syncEngineConnection(): Promise<void> {
  if (engineReconnectTried.value || !epicAllReady.value) return
  // 用原始列表判断，不是 engineStatuses —— 用户在 mcp.json 里手写了同名条目时
  // 它会被过滤掉，但那条**已经连上了**，再重连一次纯属多余
  if (statuses.value.some((s) => isEngineServerId(s.id))) return

  engineReconnectTried.value = true
  try {
    const result = await mcpClientAPI.reconnect()
    if (result.success) statuses.value = result.statuses ?? []
  } catch (error) {
    console.warn('[MCP] 引擎 server 补连失败:', error)
  }
}

async function refreshEpic(): Promise<void> {
  epicLoading.value = true
  epicError.value = ''
  try {
    const result = await mcpClientAPI.epicStatus()
    epicProjects.value = result.success ? result.projects : []
    // 主进程报的错要显示出来。吞掉的话界面又变回那片没有原因的空白 ——
    // 开发时最常见的一种就是主进程没重启，新的 IPC 通道压根不存在
    if (!result.success) epicError.value = result.error ?? ''
  } catch (error) {
    epicProjects.value = []
    epicError.value = (error as Error).message
  } finally {
    epicLoading.value = false
  }
  await syncEngineConnection()
}

async function setupEpic(project: EpicSetupProjectStatus): Promise<void> {
  if (epicBusy.value) return
  epicBusy.value = project.connectionId
  epicMessage.value = ''
  try {
    const result = await mcpClientAPI.epicSetup(project.connectionId)
    // message 由主进程给：它才知道这次是「起来了」「要重启」还是「配置失败」，
    // 渲染层照着 state 猜会和实际发生的事对不上
    epicMessage.value = result.message ?? result.error ?? ''
    if (result.statuses) statuses.value = result.statuses
    await refreshEpic()
  } catch (error) {
    epicMessage.value = (error as Error).message
  } finally {
    epicBusy.value = ''
  }
}

/**
 * 一键接入官方 Blender Lab MCP。
 *
 * 和上面的引擎一键是同一个病：手工流程写在技能文档里，四道关
 * （装 git/Python、跑安装脚本、手填一长串绝对路径、再手填三行环境变量），
 * **走完的用户几乎没有**，走不完就等于这个能力不存在。
 *
 * ## 这一块也常驻，理由同上
 *
 * 缺 git、缺 Python、Blender 版本不够、Linux —— 四种原因如果都渲染成
 * 「按钮不出现」，用户看到的是同一片空白。所以：能装就给按钮，不能装就
 * **点名说缺哪一个、去哪装**（`describeMissing` 在主进程里拼好）。
 *
 * 只有已经配过（`configured`）才收起 —— 那时下面的 server 列表里就有这一条，
 * 通没通看那里，这块再留着就是重复。
 */
const blender = ref<BlenderSetupStatus | undefined>()
const blenderBusy = ref(false)
const blenderMessage = ref('')
const blenderError = ref('')
const blenderLoading = ref(true)

/**
 * 用户自己指的那个 Blender。
 *
 * 自动探测只认官方安装器和 Steam 的标准位置 —— 便携版、装在 D 盘、
 * 放在网络盘上的都猜不到，而那不是少数。没有这个入口的话，那些用户看到的是
 * 一个永远点不了的按钮加一句「没找到 Blender」，**没有任何出路**。
 */
const pickedBlender = ref('')

/** 装的时候用哪个 Blender：用户指的优先 */
const blenderTarget = computed(() => pickedBlender.value || blender.value?.blenderPath || '')

/**
 * 配好**而且真的连上了**才收起来。下面的 server 列表接手报工具数。
 *
 * ## 后半句不能省
 *
 * 只看 `state === 'configured'` 的话，`mcp.json` 里一旦有一条带
 * `BLENDER_PATH` 的配置，这一块就永远消失 —— 哪怕桥已经死了。真会发生：
 * 插件装在 Blender 5.1 的扩展目录里，用户升到 5.2 之后扩展是分版本存的，
 * 桥没了；或者用户在 Blender 偏好里把插件停用了；或者安装目录被清掉了。
 * 这些时候 `runBlenderSetup` 的「再点一次修一修」正是唯一的出路，
 * 而唯一能调它的按钮刚好不见了，只剩下手改 `mcp.json`。
 *
 * 判据和上面引擎那块的 `hideEpicSetup` 是同一条：**接手的那块真的在
 * 说话了，才允许收起**。
 */
const hideBlenderSetup = computed(() => {
  if (blender.value?.state !== 'configured') return false
  const id = blender.value.configuredServerId
  return statuses.value.some((s) => s.id === id && s.connected)
})

/**
 * 真正挡住安装的那几条。
 *
 * 用户自己指了 Blender 之后，探到的那条 blender 前置就不该再挡路 ——
 * 探测本来就只认标准位置，让它否决一个用户亲手指出来的文件是本末倒置。
 * git 和 python 两条与选哪个 Blender 无关，照挡。
 */
const blenderBlockers = computed(() =>
  (blender.value?.prerequisites ?? []).filter(
    (item) => !item.ok && !(item.id === 'blender' && pickedBlender.value)
  )
)

const canInstallBlender = computed(
  () =>
    blender.value !== undefined &&
    blender.value.state !== 'unsupported' &&
    blenderTarget.value !== '' &&
    blenderBlockers.value.length === 0
)

/**
 * 缺的 Git / Python 盒子能用 winget 替用户装（只在 Windows 上）。
 *
 * 有这几条时，行右端的主按钮从「一键接入」换成「安装 Git 和 Python」——
 * 这一刻用户唯一该做的事就是这个，给一个点不了的「一键接入」加一句
 * 「请先去 git-scm.com 下载」等于把运维活甩给他。
 * Blender 本身不在这里装：版本、装哪个盘都是用户的选择，有「选择…」那条路。
 */
const prereqsToInstall = computed<Array<'git' | 'python'>>(() =>
  window.api.platform === 'win32'
    ? blenderBlockers.value
        .map((item) => item.id)
        .filter((id): id is 'git' | 'python' => id === 'git' || id === 'python')
    : []
)

const prereqNames = computed(() =>
  prereqsToInstall.value
    .map((id) => (id === 'git' ? 'Git' : 'Python'))
    .join(t('mcp.blenderSetup.nameJoiner'))
)

/** 正在装 Git / Python（不是装 Blender 服务）。按钮文案要分开说 */
const prereqBusy = ref(false)

/**
 * winget 装失败时的原话。有它才出现「交给 AI 排查」——
 * 没失败过的时候那个按钮只是噪音。
 */
const prereqFailure = ref<{ names: string; detail: string } | undefined>()

async function installPrereqs(): Promise<void> {
  if (blenderBusy.value || prereqsToInstall.value.length === 0) return
  const names = prereqNames.value
  blenderBusy.value = true
  prereqBusy.value = true
  blenderMessage.value = ''
  prereqFailure.value = undefined
  try {
    const result = await mcpClientAPI.blenderInstallPrereqs([...prereqsToInstall.value])
    if (result.success) {
      blenderMessage.value = t('mcp.blenderSetup.prereqsInstalled', { names })
    } else {
      blenderMessage.value = result.message || result.error || ''
      prereqFailure.value = { names, detail: result.error || result.message }
    }
    await refreshBlender()
  } catch (error) {
    blenderMessage.value = (error as Error).message
    prereqFailure.value = { names, detail: (error as Error).message }
  } finally {
    prereqBusy.value = false
    blenderBusy.value = false
  }
}

/** 自动安装失败了，把 winget 的原话交给 AI */
function askAiAboutPrereqs(): void {
  const failure = prereqFailure.value
  if (!failure) return
  try {
    startAgentChat(
      t('mcp.blenderSetup.aiPrompt', { names: failure.names, detail: failure.detail }),
      'blender-prereqs'
    )
  } catch (error) {
    message.error(t('mcp.blenderSetup.askAiFailed', { reason: (error as Error).message }))
  }
}

/** 让用户自己指一个 blender 可执行文件 */
async function chooseBlender(): Promise<void> {
  try {
    const result = await window.api.dialog.showOpenDialog({
      properties: ['openFile'],
      // macOS 上用户看到的是 Blender.app；安装脚本两种都收，交给它解析
      filters:
        window.api.platform === 'darwin'
          ? [{ name: 'Blender', extensions: ['app'] }]
          : [{ name: 'Blender', extensions: ['exe'] }]
    })
    const picked = result.canceled ? '' : (result.filePaths?.[0] ?? '')
    if (picked) pickedBlender.value = picked
  } catch (error) {
    console.warn('[MCP] 选择 Blender 失败:', error)
  }
}

/** 一条前置渲染成一行人话。`found` 原样带上，「4.5，需要 5.1+」才指得出下一步 */
function prerequisiteLabel(item: {
  id: 'blender' | 'git' | 'python'
  found?: string
  problem?: 'missing' | 'too-old'
}): string {
  const key = item.problem === 'too-old' ? 'tooOld' : 'missing'
  return t(`mcp.blenderSetup.prereq.${item.id}.${key}`, { found: item.found ?? '' })
}

async function refreshBlender(): Promise<void> {
  blenderLoading.value = true
  blenderError.value = ''
  try {
    const result = await mcpClientAPI.blenderStatus()
    blender.value = result.success ? result.status : undefined
    // 主进程报的错照样要显示 —— 开发时最常见的是主进程没重启，
    // 新 IPC 通道压根不存在，吞掉就又成了那片没有原因的空白
    if (!result.success) blenderError.value = result.error ?? ''
  } catch (error) {
    blender.value = undefined
    blenderError.value = (error as Error).message
  } finally {
    blenderLoading.value = false
  }
}

/**
 * 把主进程刚写进 `mcp.json` 的那条 Blender 认领进表单，**只动那一行**。
 *
 * ## 为什么不能直接 `load()`
 *
 * `load()` 会 `servers.value = toFormValues(...)` 整张表重来。装一次要几分钟，
 * 用户完全可能在等待期间接着编辑别的 server —— 回来时他新加的那行没了、
 * 其余行全收起了（`expandedRows` 按对象身份记，换了对象就全丢），
 * **连出过事的痕迹都没有**。
 *
 * 所以只补那一行：盘上新增的 Blender 进表单，用户手上的编辑原样留着，
 * 基准线按**盘上的内容**重算，于是他那些编辑仍然显示为未保存。
 */
async function adoptInstalledBlenderRow(): Promise<void> {
  try {
    const result = await mcpClientAPI.getSettings()
    statuses.value = result.statuses
    configPath.value = result.path

    const installed = toFormValues(result.settings).find((row) => row.id === BLENDER_SERVER_ID)
    if (installed) {
      const at = servers.value.findIndex((row) => row.id === BLENDER_SERVER_ID)
      if (at >= 0) servers.value.splice(at, 1, installed)
      else servers.value.push(installed)
    }

    // 基准线是「盘上现在是什么」，不是「表单现在是什么」——
    // 后者会把用户没保存的编辑一起算成已保存
    rememberDisk(result.settings)
  } catch (error) {
    console.warn('[MCP] 装完之后重读配置失败:', error)
  }
}

/**
 * 点一次装一次。
 *
 * 跑几分钟很正常（git fetch + 建 venv + pip + 两次后台 Blender），所以
 * 按钮上要写「安装中」而不是转个圈 —— 静默几分钟的界面，用户会当它死了
 * 然后去点第二次。主进程那边有 15 分钟上限，不会无限挂着。
 */
async function setupBlender(): Promise<void> {
  if (blenderBusy.value) return
  blenderBusy.value = true
  blenderMessage.value = ''
  try {
    const result = await mcpClientAPI.blenderSetup(blenderTarget.value)
    // message 由主进程给：这次是装好了、缺前置、还是脚本自己挂了，
    // 只有它知道；渲染层照 state 猜会和实际发生的事对不上
    blenderMessage.value = result.message ?? result.error ?? ''
    if (result.statuses) statuses.value = result.statuses
    // 装成功那一刻 `blenderActionable` 会翻假，这一行本来会自动收起 ——
    // 连同刚写好的那句回执一起消失。用户等了三五分钟，界面什么都没留下，
    // 丢掉的还偏偏是别处没有的那句「盒子会自己把 Blender 拉起来，不用手动开」。
    showBlender.value = true
    if (result.success) await adoptInstalledBlenderRow()
    await refreshBlender()
  } catch (error) {
    blenderMessage.value = (error as Error).message
  } finally {
    blenderBusy.value = false
  }
}

/* ── 内置 vs 手动配置 ─────────────────────────────────────── */

/**
 * 盒子自己装的那条 Blender，从「手动配置」里摘出去。
 *
 * 它写在 `mcp.json` 里，所以技术上和手填的那几条一模一样 —— 但**来源不同就是
 * 两回事**：手填的那条坏了是用户自己的责任，这条坏了该去点「重新安装」。
 * 混在一起的时候，装好的 blender 和一条随手加的 filesystem 长得完全一样，
 * 用户分不清哪条归谁管，也想不到上面那块安装卡片和下面这一行说的是同一个东西。
 */
function isPresetRow(value: McpServerFormValue): boolean {
  return value.id.trim() === BLENDER_SERVER_ID
}

const blenderRowIndex = computed(() => servers.value.findIndex(isPresetRow))
const blenderRow = computed(() => servers.value[blenderRowIndex.value])

/** 手动配置那一组里还剩几条。空组要给一句话，不能留一片空白 */
const manualCount = computed(() => servers.value.filter((s) => !isPresetRow(s)).length)

/**
 * 从一行的环境变量文本里取一个键。
 *
 * 装好的 Blender 真正可能要改的只有两样：装在哪（`BLENDER_PATH`）和端口
 * （`BLENDER_MCP_PORT`）。它们埋在一块三行的 `KEY=VALUE` 文本里，用户得先知道
 * 有这两个键、再知道拼写，才改得动。给它们各自一个带标签的输入框。
 */
function envOf(value: McpServerFormValue | undefined, key: string): string {
  if (!value) return ''
  return parseEnvText(value.env ?? '').env[key] ?? ''
}

/**
 * 改回环境变量文本，**只动这一个键**。
 *
 * 不能整段重写：`parseEnvText` 认得的只是它认得的那些，用户手写的注释、
 * 顺序、以及这个面板没在意的别的键都得原样留着 —— 这一页已经因为
 * 「悄悄丢配置」出过一次事（见 `api/mcp.ts` 的 `PreservedServerFields`）。
 */
function setEnvOf(value: McpServerFormValue | undefined, key: string, next: string): void {
  if (!value) return
  const text = (value.env ?? '').trim()

  // 整块 JSON 的写法也得认。按行改一个 `KEY=VALUE` 进去会把 JSON 改成
  // 一段两种语法混着的东西，`parseEnvText` 从此整段算无效 —— 用户改了个
  // 路径，结果整组环境变量静默消失，症状是「连上了、一调就失败」
  if (text.startsWith('{')) {
    const { env } = parseEnvText(text)
    value.env = JSON.stringify({ ...env, [key]: next }, null, 2)
    return
  }

  // 逐行改，只动这一个键：用户手写的注释、顺序、以及这个面板不认识的别的键
  // 都得原样留着。这一页已经因为「悄悄丢配置」出过一次事
  const lines = text.split(/\r?\n/).filter((line) => line.trim() !== '')
  const at = lines.findIndex((line) => line.split('=')[0]?.trim() === key)
  if (at >= 0) lines[at] = `${key}=${next}`
  else lines.push(`${key}=${next}`)
  value.env = lines.join('\n')
}

/** 「高级（原始 MCP 配置）」—— 逃生口，默认收着 */
const showBlenderRaw = ref(false)

/**
 * 内置那两行什么时候强制摊开。
 *
 * 和 server 行同一条规矩：**有事要办、却藏在收起态里，等于这件事不存在**。
 * 安装按钮、重试按钮、缺的前置、失败原因，任何一样在里面就摊开。
 * 好好跑着的时候才允许收成一行 —— 那时里面确实没有要处理的事。
 */
const engineActionable = computed(
  () =>
    epicActionable.value.length > 0 ||
    epicError.value !== '' ||
    engineFailed.value ||
    // 引擎那边好了、盒子这边还没接上：屏幕上只有一句「已开启 · 运行中」，
    // 而**下一步在摊开的里面**（`readyHint`：会在下次对话时自动接上）。
    // 这是原来那条一键块/自动发现块互锁换了个位置 —— 接手的那条真的在说话了，
    // 才允许收起。两边都不说话的那片空白，用户读到的是「坏了」。
    (epicReady.value.length > 0 && engineStatuses.value.length === 0)
)
const engineRowOpen = computed(() => showEngine.value || engineActionable.value)

/** 还没装好就等于有事要办：按钮在行右端，缺的前置和说明在摊开的里面 */
const blenderActionable = computed(() => !hideBlenderSetup.value && !blenderLoading.value)
const showBlender = ref(false)
const blenderRowOpen = computed(
  () => showBlender.value || blenderActionable.value || blenderError.value !== ''
)

/**
 * 虚幻引擎那一行右端说什么。
 *
 * 原来这些状态散在两块卡片里（一键块报「还没连项目 / 版本太低 / 要重启」，
 * 自动发现块报「已连接 / 连接失败」），而它们说的是**同一个东西**在不同阶段。
 * 压成一行之后就得排个优先级：真连上了以连接状态为准，没连上才轮到
 * 「差哪一步」。
 */
const engineRowMeta = computed((): { tone: string; label: string } | undefined => {
  if (engineSummary.value) return engineSummary.value
  if (epicLoading.value) return { tone: 'muted', label: t('mcp.epicSetup.checking') }
  if (epicError.value) return { tone: 'bad', label: t('mcp.status.failed') }
  if (epicProjects.value.length === 0) {
    return { tone: 'muted', label: t('mcp.epicSetup.noProjectShort') }
  }
  if (epicPendingRestart.value.length > 0) {
    return { tone: 'muted', label: t('mcp.epicSetup.needsRestart') }
  }
  if (epicUnsupported.value.length > 0) {
    return { tone: 'muted', label: t('mcp.epicSetup.unsupported') }
  }
  if (epicReady.value.length > 0) return { tone: 'ok', label: t('mcp.epicSetup.ready') }
  return undefined
})

/**
 * Blender 那一行右端说什么。
 *
 * 已经接上了就报连接状态（工具数 / 连接失败 / 已停用）—— 那是每次进这个页面
 * 真正想知道的。没接上才轮到「差哪一步」，而那几句都得短到能挂在一行上；
 * 完整的说明留给摊开的里面。
 */
const blenderRowMeta = computed((): { tone: string; label: string } => {
  if (blenderLoading.value) return { tone: 'muted', label: t('mcp.blenderSetup.checking') }
  const chip = chipOf(BLENDER_SERVER_ID)
  if (chip) return { tone: chip.tone, label: chip.label }
  if (blenderError.value) return { tone: 'bad', label: t('mcp.status.failed') }
  if (blender.value?.state === 'unsupported') {
    return { tone: 'muted', label: t('mcp.blenderSetup.unsupportedShort') }
  }
  if (!blenderTarget.value) return { tone: 'muted', label: t('mcp.blenderSetup.noBlender') }
  if (blenderBlockers.value.length > 0) {
    return { tone: 'muted', label: t('mcp.blenderSetup.missingPrereq') }
  }
  return { tone: 'muted', label: t('mcp.blenderSetup.notConnected') }
})

/** 新行的标识输入框。加完要把光标送进去，见 `addServer` */
const idInputs = ref<HTMLInputElement[]>([])

async function addServer(): Promise<void> {
  servers.value.push({
    id: '',
    transport: 'stdio',
    commandLine: '',
    url: '',
    disabled: false,
    env: '',
    preserved: {}
  })
  // 新行摊开着（空行本来就强制展开），但要**记下来**：一旦填进标识就不再是空行，
  // 收起去会把用户正在填的东西吞掉
  expandedRows.value = new Set([...expandedRows.value, servers.value[servers.value.length - 1]])

  // 加完一行不给焦点，用户得自己再去点一下那个框；行多了还要先找到它在哪
  await nextTick()
  const last = idInputs.value[idInputs.value.length - 1]
  last?.focus()
  last?.scrollIntoView({ block: 'nearest' })
}

/**
 * 删一条配置。
 *
 * 要确认：手填的路径和环境变量删掉就没了，没有撤销。原来这里是裸删，
 * 而破坏性差不多的「重置令牌」反倒有确认 —— 保护级别正好反了。
 */
/**
 * 删一条 server，**当场落盘**。
 *
 * ## 为什么这一个动作不跟着「改完要点保存」走
 *
 * 这一页的其余编辑都是暂存的：改命令行、改 env，都要点「保存并连接」才生效。
 * 删除原来也一样，于是用户点了删除、看见那行消失了，切回来发现它还在 ——
 * 只能判断成「删除坏了」。确认弹窗还写着「不能撤销」，更坐实了这个误解。
 *
 * 删除和改一个输入框不是一回事：它有独立的确认弹窗，用户按下去的那一刻
 * 认为事情已经办完了。所以让它真的办完。
 *
 * ## 只删这一条
 *
 * 不复用「保存并连接」那条路 —— 那个是把整张表写下去，会把用户在别的行里
 * 还没保存的编辑一起提交。主进程的 `removeMcpServer` 走原文，只摘掉这一个键。
 *
 * 没保存过的行（草稿、空行）不必跑这一趟：盘上本来就没有它。
 */
async function removeServer(index: number): Promise<void> {
  const value = servers.value[index]
  const id = value.id.trim()
  // 空行是用户刚点出来还没填的，删它没有任何损失，不该再拦一道
  if (!isBlankRow(value) && !window.confirm(t('mcp.actions.removeConfirm', { id }))) return

  const onDisk = !isBlankRow(value) && !isDraftRow(value)
  servers.value.splice(index, 1)
  if (!onDisk) return

  try {
    const result = await mcpClientAPI.removeServer(id)
    if (!result.success) {
      saveError.value = result.error ?? t('mcp.errors.saveFailed')
      return
    }
    if (result.statuses) statuses.value = result.statuses
    // 基准线按**盘上现在的内容**重算：这一条已经删掉了，不该再顶着「未保存」，
    // 而用户在别的行里没保存的编辑要继续算未保存
    if (result.settings) rememberDisk(result.settings)
  } catch (error) {
    saveError.value = (error as Error).message
  }
}

/**
 * 存一条 server，当场落盘并重连。
 *
 * ## 为什么按行存，而不是一个总的「保存并连接」
 *
 * 一个总按钮把整张表一起写下去，于是几条互不相干的服务被绑成一件事：
 * 改 blender 的时候顺手把另一条半填的也提交了；另一条填错了，blender
 * 这条也存不了。**每条服务本来就是独立的**，编辑的粒度就该是一条。
 *
 * 配的这条 `saveServer` 只写这一个键，盘上别的条目原样不动 —— 包括
 * `readMcpSettings` 认不出、但用户手写在 `mcp.json` 里的那些。
 */
async function saveRow(index: number): Promise<void> {
  const value = servers.value[index]
  const id = value.id.trim()
  if (savingId.value || rowError(value) !== '' || isBlankRow(value)) return

  const config = toSettings([value]).mcpServers[id]
  if (!config) return

  savingId.value = id
  saveError.value = ''
  try {
    // 存即重连，用户在这个页面就能看到它通没通，
    // 而不是等下一次对话才发现配错
    const result = await mcpClientAPI.saveServer(id, config, value.savedId)
    if (result.success) {
      statuses.value = result.statuses ?? []
      if (result.settings) rememberDisk(result.settings)
      // 改过名的话，旧名字那条已经在盘上删掉了，这一行从此认新名字
      value.savedId = id
      // 存完了就把这一行收回去 —— 事办完了，它该回到「一行一个服务」
      const next = new Set(expandedRows.value)
      next.delete(value)
      expandedRows.value = next
    } else saveError.value = result.error ?? t('mcp.errors.saveFailed')
  } catch (error) {
    saveError.value = (error as Error).message
  } finally {
    savingId.value = ''
  }
}

/**
 * 重连全部 server。
 *
 * 引擎块的「重试连接」走的是同一个动作 —— 主进程那边本来就是整批重建
 * （`reconnectMcp` 先 shutdown 再 ensureConnected），没有单独重连一条的口子。
 * 按钮放在失败那块旁边，是因为**用户是在那儿看到问题的**，
 * 不该让他去猜「下面那个跟第三方服务放在一起的按钮也管引擎」。
 */
const reconnecting = ref(false)

async function reconnect(): Promise<void> {
  if (reconnecting.value) return
  reconnecting.value = true
  try {
    const result = await mcpClientAPI.reconnect()
    if (result.success) statuses.value = result.statuses ?? []
  } finally {
    reconnecting.value = false
  }
}

/**
 * 端口 / 暴露范围一改就落盘。
 *
 * 原来这两项**只有点「开启」才会写进 mcp-server.json** —— 用户改完不开启
 * 就切走页面，下次回来全变回默认值，看起来就是「配置没有持久化」。
 * 端口非法时不写：写进去下次开机自启会拿一个必然失败的端口。
 * 服务运行中修改权限会由主进程自动重启，旧会话立即失效。
 */
const configSaved = ref(false)
const configError = ref('')

async function persistConfig(): Promise<void> {
  if (hostBusy.value || portError.value) return
  hostBusy.value = true
  configError.value = ''
  configSaved.value = false
  try {
    const status = await mcpServerAPI.saveConfig({
      port: port.value,
      includeMutating: includeMutating.value
    })
    // 只更新 host（配置片段要跟着新端口走），不回灌本地表单 ——
    // 用户可能正在输入
    host.value = { ...host.value, ...status, settings: status.settings }
    // 失焦即落盘是个看不见的动作。不给回执的话，用户改完端口只能干等着，
    // 没法分辨「存好了」和「什么都没发生」；失败时更糟 —— 原来只进 console
    configSaved.value = true
    setTimeout(() => (configSaved.value = false), 2000)
  } catch (error) {
    configError.value = (error as Error).message
    await refreshHost()
  } finally {
    hostBusy.value = false
  }
}

async function toggleHost(): Promise<void> {
  if (hostBusy.value || (portError.value && !host.value.running)) return
  const wasRunning = host.value.running
  hostBusy.value = true
  try {
    if (wasRunning) {
      applyHost((await mcpServerAPI.stop()).status)
    } else {
      const result = await mcpServerAPI.start({
        includeMutating: includeMutating.value,
        port: port.value
      })
      applyHost(result.status)
      // 刚开启时自动把配置摊开 —— 这时候用户正要去配外部客户端
      if (host.value.running) showConfig.value = true
    }
  } catch (error) {
    // 整条 IPC 挂了也不能把开关锁死在错误状态上
    console.warn('[MCP] 切换对外服务失败:', error)
  } finally {
    hostBusy.value = false
    // 以主进程报的为准，见 refreshHost 的说明
    await refreshHost()
  }
}

/**
 * 换一把新令牌。
 *
 * 明确二次确认：一按下去，所有已经配好这个服务的外部客户端立刻连不上，
 * 得挨个重新粘配置。用户想要的场景是「令牌泄露了」，不该手滑触发。
 */
const installing = ref<'' | 'claude-code' | 'codex'>('')

async function installClient(client: 'claude-code' | 'codex'): Promise<void> {
  if (installing.value) return
  installing.value = client
  try {
    const result = await mcpServerAPI.installClient(client)
    if (result.status) applyHost(result.status)
    if (result.success) {
      message.success(
        t(client === 'codex' ? 'mcp.server.installedCodex' : 'mcp.server.installedClaudeCode', {
          path: result.path
        })
      )
    } else {
      message.error(t('mcp.server.installFailed', { error: result.error ?? '' }))
    }
  } finally {
    installing.value = ''
  }
}

async function rotateToken(): Promise<void> {
  if (hostBusy.value) return
  if (!window.confirm(t('mcp.server.rotateConfirm'))) return
  hostBusy.value = true
  try {
    applyHost((await mcpServerAPI.rotateToken()).status)
    // 换了新的一把就收回明文：上一次「显示」是针对旧令牌的决定
    revealToken.value = false
  } finally {
    hostBusy.value = false
  }
}

async function copy(what: 'config' | 'token' | 'url' | 'path'): Promise<void> {
  // 复制的永远是完整值，跟屏幕上打没打码无关
  const text =
    what === 'config'
      ? host.value.clientConfig
      : what === 'token'
        ? host.value.settings?.token
        : what === 'url'
          ? host.value.url
          : configPath.value
  if (!text) return
  await navigator.clipboard.writeText(text)
  copied.value = what
  setTimeout(() => (copied.value = ''), 2000)
}

/**
 * 哪几行摊开成编辑态。
 *
 * ## 为什么默认全收起
 *
 * 渐进披露这条原则，上一版在**下半页**守得挺好（端口、令牌、JSON 都折起来了），
 * 上半页却整个漏掉了：每条 server 都把四个输入框 + 两行说明永久摊在屏幕上。
 * 一条 blender 就占掉半屏，两条就是一屏。
 *
 * 可是「改 blender 的启动命令」是一辈子做一两次的事，而**每次进这个页面都是
 * 为了看一眼它通没通**。所以默认态该是一行：名字 + 通没通。要改再展开。
 *
 * 三种情况强制展开，否则会出现「有东西要处理、但看不见」：
 *   - 空行（刚点出来的，收起来就是一行空白，没法填）
 *   - 有错的行（错误信息藏在收起的行里等于没报错）
 *   - 用户自己点开的
 */
const expandedRows = ref(new Set<McpServerFormValue>())

function isExpanded(value: McpServerFormValue): boolean {
  return (
    expandedRows.value.has(value) ||
    isBlankRow(value) ||
    idError(value) !== '' ||
    envError(value) !== ''
  )
}

function toggleRow(value: McpServerFormValue): void {
  // 重新建一个 Set 才会触发更新 —— Set 本身的增删 Vue 的 ref 看不见
  const next = new Set(expandedRows.value)
  if (next.has(value)) next.delete(value)
  else next.add(value)
  expandedRows.value = next
}

/** 在资源管理器里定位 mcp.json。光把路径印出来，用户还得自己去粘 */
async function revealConfig(): Promise<void> {
  if (!configPath.value) return
  try {
    // 返回值必须看：shell:* 失败时是 return {success:false}，不抛 —— 只 warn 等于静默
    const res = await window.api.shell.showItemInFolder(configPath.value)
    if (!res?.success) {
      console.warn('[MCP] 打开配置文件位置失败:', res?.error)
      message.error(`无法打开配置文件所在位置：${configPath.value}`, 8)
    }
  } catch (error) {
    console.warn('[MCP] 打开配置文件位置失败:', error)
    message.error(`无法打开配置文件所在位置：${configPath.value}`, 8)
  }
}

onMounted(load)
</script>

<template>
  <div class="settings-content">
    <!-- ── 接入第三方 server ─────────────────────────────────── -->
    <!--
      这里不重复标题：页面 Header 已经写着「接入外部 MCP 服务」和同一句描述，
      面板里再来一遍是上一版最刺眼的重复。
    -->
    <section class="settings-section">
      <!--
        一键开启，排在最前面 —— 这是用户在这一屏唯一需要做决定的地方。

        **这块常驻**（除非已经全部开好、且下面的自动发现块接手了 —— 见
        `hideEpicSetup`）。初版做成「没有可操作项目就不渲染」，
        结果是用户什么都看不到、也不知道为什么：没连项目、引擎太老、
        主进程没起来，三种原因长得一模一样，都是一片空白。
        空白不是「没有噪音」，空白是「看起来坏了」。
      -->
      <h4 class="section-title">{{ t('mcp.client.builtinTitle') }}</h4>

      <ul class="category-list">
        <li class="category builtin engine">
          <div class="category-head">
            <button class="category-open" @click="showEngine = !showEngine">
              <PhCaretRight class="caret" :class="{ open: engineRowOpen }" />
              <span class="category-name">{{ t('mcp.epicSetup.rowTitle') }}</span>
              <!--
                一行里只说一件事：现在是什么状态。原来这些话散在两块卡片里 ——
                一键块说「还没连项目 / 版本太低 / 要重启」，自动发现块说
                「已连接 / 连接失败」，可它们讲的是同一个东西的不同阶段。
              -->
              <span v-if="engineRowMeta" class="status" :class="engineRowMeta.tone">
                {{ engineRowMeta.label }}
              </span>
            </button>

            <!--
            有得点就把按钮放在行右端，别藏进摊开的里面 —— 这一整块存在的理由
            就是那一下点击。只在**恰好一个**项目可操作时放这儿；多个项目时
            按钮跟着各自的项目名走，摆在摊开的里面才分得清点的是哪个。
          -->
            <AppButton
              v-if="epicActionable.length === 1"
              class="row-action"
              variant="primary"
              size="medium"
              :disabled="epicBusy !== ''"
              @click="setupEpic(epicActionable[0])"
            >
              {{
                epicBusy === epicActionable[0].connectionId
                  ? t('mcp.epicSetup.working')
                  : epicActionable[0].state === 'needs-start'
                    ? t('mcp.epicSetup.start')
                    : t('mcp.epicSetup.enable')
              }}
            </AppButton>
          </div>

          <div v-if="engineRowOpen" class="category-body">
            <!-- 主进程报的错原样显示。最常见的是开发时主进程没重启 -->
            <p v-if="epicError" class="error">
              {{ t('mcp.epicSetup.failed', { error: epicError }) }}
            </p>

            <!-- 一个项目都没连：这是最常见的「按钮怎么不见了」，必须点破 -->
            <p v-else-if="epicProjects.length === 0" class="section-note">
              {{ t('mcp.epicSetup.noProject') }}
            </p>

            <template v-else>
              <!-- 多个项目才逐条给按钮，否则行右端那一个就够了（见上面） -->
              <template v-if="epicActionable.length > 1">
                <div
                  v-for="project in epicActionable"
                  :key="project.connectionId"
                  class="engine-row"
                >
                  <code>{{ project.projectName }}</code>
                  <AppButton
                    variant="primary"
                    size="medium"
                    :disabled="epicBusy !== ''"
                    @click="setupEpic(project)"
                  >
                    {{
                      epicBusy === project.connectionId
                        ? t('mcp.epicSetup.working')
                        : project.state === 'needs-start'
                          ? t('mcp.epicSetup.start')
                          : t('mcp.epicSetup.enable')
                    }}
                  </AppButton>
                </div>
              </template>

              <!-- 配好了但没重启：给不了按钮，UE 没法热加载新插件模块 -->
              <div
                v-for="project in epicPendingRestart"
                :key="project.connectionId"
                class="engine-row"
              >
                <code>{{ project.projectName }}</code>
                <span class="status muted">{{ t('mcp.epicSetup.needsRestart') }}</span>
              </div>

              <!-- 引擎太老：点名说出版本号，否则用户只会觉得按钮丢了 -->
              <div
                v-for="project in epicUnsupported"
                :key="project.connectionId"
                class="engine-row"
              >
                <code>{{ project.projectName }}</code>
                <span class="status muted">{{ t('mcp.epicSetup.unsupported') }}</span>
              </div>

              <!--
              已经开好了，但下面那几条自动发现的 server 还没接上。
              正常情况下这几行不会出现 —— 接上了就由 `engineStatuses` 报状态。
              它只为一种情况存在：引擎服务确实在跑，盒子这边还没连上（补连失败、
              或用户在 mcp.json 里把它停用了）。那时候什么都不显示，
              用户看到的就是一片「坏了」。
            -->
              <template v-if="engineStatuses.length === 0">
                <div v-for="project in epicReady" :key="project.connectionId" class="engine-row">
                  <code>{{ project.projectName }}</code>
                  <span class="status ok">{{ t('mcp.epicSetup.ready') }}</span>
                </div>
              </template>
            </template>

            <!--
            真连上的那几条 server。原来这是一块独立的「自动发现」卡片，
            而它报的「已连接 · 3 个入口」和上面一键块报的「已开启 · 运行中」
            是同一件事的两种说法，摆成两块只会让人对账。
          -->
            <!-- 用户没做任何配置就多出一条东西，必须说清楚它从哪来 -->
            <p v-if="engineStatuses.length > 0" class="engine-desc">
              {{ t('mcp.engine.description') }}
            </p>

            <div v-for="status in engineStatuses" :key="status.id" class="engine-entry">
              <div class="engine-row">
                <code>{{ status.id }}</code>
                <!--
                连上时不能报「3 个工具」。上面刚说完「约 900 个」，
                旁边一个「3 个工具」的绿标签，看起来就是没接全 ——
                这是真实被问过的一句「怎么只有三个工具」。
                这里说清楚 3 是**入口**，不是能力总数。
              -->
                <span v-if="status.connected" class="status ok" :title="t('mcp.engine.twoTier')">
                  {{ t('mcp.engine.connected', { count: status.toolCount }) }}
                </span>
                <span v-else class="status" :class="chipOf(status.id)!.tone">
                  {{ chipOf(status.id)!.label }}
                </span>
              </div>
              <!--
              原因写出来，不放 tooltip。一条「连接失败」不带原因，用户能做的只有
              瞪着它；而原因常常一句话就说清了（`ECONNREFUSED 127.0.0.1:30069`），
              是这一屏信息量最大的一行字。
            -->
              <p v-if="errorOf(status.id)" class="row-error">{{ errorOf(status.id) }}</p>
            </div>

            <!-- 重试放在看到问题的地方。好好跑着的时候不给按钮：没什么可重试的 -->
            <div v-if="engineFailed" class="actions">
              <AppButton
                variant="primary"
                size="medium"
                :disabled="reconnecting"
                @click="reconnect"
              >
                {{ reconnecting ? t('mcp.engine.retrying') : t('mcp.engine.retry') }}
              </AppButton>
            </div>

            <p v-if="epicMessage" class="section-note">{{ epicMessage }}</p>
            <p v-else-if="epicActionable.length > 0" class="section-note">
              {{ t('mcp.epicSetup.hint') }}
            </p>
            <!-- 能走到这儿说明引擎那边好了、盒子这边还没接上，得说清下一步 -->
            <p v-else-if="epicReady.length > 0 && engineStatuses.length === 0" class="section-note">
              {{ t('mcp.epicSetup.readyHint') }}
            </p>

            <!--
            两层结构讲在正文里，不能只放进 tooltip —— 会问「怎么只有三个」的人不会去悬停。
            但**只在真连上时讲**：连接失败的时候屏幕上没有那个「3」，
            再解释一遍「每个入口包含多种操作」就是纯噪音，还盖住了真正的问题。
          -->
            <p v-if="engineStatuses.some((s) => s.connected)" class="section-note">
              {{ t('mcp.engine.twoTier') }}
            </p>
            <p v-if="engineStatuses.length > 0" class="section-note">
              {{ t('mcp.engine.hint') }}
            </p>
          </div>
        </li>

        <!--
        一键接入 Blender。同样常驻（配好了才收起）——
        缺 git、缺 Python、Blender 太老、Linux，四种原因如果都长成
        「按钮不出现」，用户看到的是同一片空白。
      -->
        <!--
        Blender 也是内置的一条。

        原来它出现**两次**：上面一块「一键接入」的安装卡片，下面「手动配置的
        服务」里还有一条可编辑的 `blender` —— 而那条恰恰是安装卡片自己写进
        `mcp.json` 的。用户看到的是同一个东西的两个身份，且下面那条长得和
        随手加的第三方服务一模一样，看不出它归盒子管。
      -->
        <li class="category builtin blender">
          <div class="category-head">
            <button class="category-open" @click="showBlender = !showBlender">
              <PhCaretRight class="caret" :class="{ open: blenderRowOpen }" />
              <span class="category-name">{{ t('mcp.blenderSetup.rowTitle') }}</span>
              <span class="status" :class="blenderRowMeta.tone">
                {{ blenderRowMeta.label }}
              </span>
            </button>

            <!--
            没装好就把「一键接入」摆在行右端 —— 这一整块存在的理由就是这一下点击，
            藏进摊开的里面等于它不存在。摊开是自动的（见 `blenderRowOpen`），
            所以缺哪个前置、要用哪个 Blender，点之前都看得见。
          -->
            <AppButton
              v-if="blenderActionable && prereqsToInstall.length > 0"
              class="row-action"
              variant="primary"
              size="medium"
              :disabled="blenderBusy"
              @click="installPrereqs"
            >
              {{
                prereqBusy
                  ? t('mcp.blenderSetup.installingPrereqs', { names: prereqNames })
                  : t('mcp.blenderSetup.installPrereqs', { names: prereqNames })
              }}
            </AppButton>
            <AppButton
              v-else-if="blenderActionable && blender?.state !== 'unsupported'"
              class="row-action"
              variant="primary"
              size="medium"
              :disabled="blenderBusy || !canInstallBlender"
              @click="setupBlender"
            >
              {{ blenderBusy ? t('mcp.blenderSetup.working') : t('mcp.blenderSetup.install') }}
            </AppButton>
          </div>

          <!-- 连不上的原因常驻显示，和手配的那几条一样 -->
          <p v-if="errorOf(BLENDER_SERVER_ID)" class="row-error">
            {{ errorOf(BLENDER_SERVER_ID) }}
          </p>

          <div v-if="blenderRowOpen" class="category-body">
            <!-- 主进程报的错原样显示，最常见的是开发时主进程没重启 -->
            <p v-if="blenderError" class="error">
              {{ t('mcp.blenderSetup.failed', { error: blenderError }) }}
            </p>

            <p v-else-if="blender?.state === 'unsupported'" class="section-note">
              {{ t('mcp.blenderSetup.unsupported') }}
            </p>

            <!-- ── 还没装好：选 Blender、看缺什么 ────────────────── -->
            <template v-else-if="blenderActionable">
              <div class="engine-row">
                <code v-if="blenderTarget">{{ blenderTarget }}</code>
                <!--
                这里是「探到了什么」，不是状态胶囊，所以不用 `.status` ——
                胶囊那个类在这一页是「连上了没有」的专用词汇，借过来用会让
                「没找到 Blender」和一条 server 的连接状态长得一样。
              -->
                <span v-else class="section-note">{{ t('mcp.blenderSetup.noBlender') }}</span>
                <!--
                自动探测只认标准安装位置。没有这个按钮的话，便携版和装在
                别处的用户看到的是一个永远点不了的按钮，没有任何出路。
              -->
                <AppButton
                  variant="soft"
                  size="medium"
                  :disabled="blenderBusy"
                  @click="chooseBlender"
                >
                  {{ t('mcp.blenderSetup.choose') }}
                </AppButton>
              </div>

              <!--
              缺什么逐条列出来。合成一句「环境不满足」等于让用户自己去猜是
              缺 git 还是 Python 版本低 —— 而那正是安装脚本原来的失败样子
              （一句 Command failed: git）。
            -->
              <p v-for="item in blenderBlockers" :key="item.id" class="section-note">
                {{ prerequisiteLabel(item) }}
              </p>
              <!-- 管理员确认框只有用户能点，点之前就要说，不然弹出来像是出了什么事 -->
              <p v-if="prereqsToInstall.includes('git')" class="section-note">
                {{ t('mcp.blenderSetup.prereqsUacHint') }}
              </p>

              <p v-if="blenderMessage" class="section-note">
                {{ blenderMessage }}
                <button
                  v-if="prereqFailure && !blenderBusy"
                  class="link"
                  @click="askAiAboutPrereqs"
                >
                  {{ t('mcp.blenderSetup.askAi') }}
                </button>
              </p>
              <p v-else-if="canInstallBlender" class="section-note">
                {{ t('mcp.blenderSetup.hint') }}
              </p>
            </template>

            <!-- ── 已经装好：只给真正会变的那两样 ────────────────── -->
            <template v-else>
              <!--
              装成功那句回执要活过安装态自己的消失 —— 用户等了三五分钟，
              界面把整块连同刚写好的回执一起删掉，什么都没留下。丢掉的还偏偏是
              别处没有的那一句「盒子会自己把 Blender 拉起来，不用手动开」。
            -->
              <p v-if="blenderMessage" class="section-note">{{ blenderMessage }}</p>

              <!--
              标识、连接方式、启动命令都是盒子自己写的，给输入框只会让用户改坏
              一条本来好好的配置。真正会变的只有两样：Blender 装在哪、端口多少。
              要动别的就去「高级」——留一个逃生口，但不摆在默认路径上。
            -->
              <label class="field">
                <span class="field-label">{{ t('mcp.blenderSetup.pathLabel') }}</span>
                <input
                  class="field-input path-input"
                  type="text"
                  spellcheck="false"
                  :value="envOf(blenderRow, 'BLENDER_PATH')"
                  @input="
                    setEnvOf(blenderRow, 'BLENDER_PATH', ($event.target as HTMLInputElement).value)
                  "
                />
                <small class="section-note">{{ t('mcp.blenderSetup.pathHint') }}</small>
              </label>

              <label class="field port-field">
                <span class="field-label">{{ t('mcp.blenderSetup.portLabel') }}</span>
                <input
                  class="field-input"
                  type="text"
                  spellcheck="false"
                  :value="envOf(blenderRow, 'BLENDER_MCP_PORT')"
                  @input="
                    setEnvOf(
                      blenderRow,
                      'BLENDER_MCP_PORT',
                      ($event.target as HTMLInputElement).value
                    )
                  "
                />
              </label>

              <!-- 原始配置：和手配的那几行同一套字段，改完走同一个保存 -->
              <template v-if="showBlenderRaw && blenderRow">
                <label class="field grow">
                  <span class="field-label">{{ t('mcp.fields.command') }}</span>
                  <textarea
                    v-model="blenderRow.commandLine"
                    class="field-input command-input"
                    rows="2"
                    spellcheck="false"
                  ></textarea>
                </label>

                <label class="field env-field">
                  <span class="field-label">{{ t('mcp.fields.env') }}</span>
                  <textarea
                    v-model="blenderRow.env"
                    class="field-input"
                    rows="3"
                    spellcheck="false"
                  ></textarea>
                  <small v-if="envError(blenderRow)" class="error">{{
                    envError(blenderRow)
                  }}</small>
                  <small v-else class="section-note">{{ t('mcp.fields.envHint') }}</small>
                </label>
              </template>

              <!--
              一排链接，不是一排按钮。原来「删除」是个红色实心按钮贴在状态旁边，
              而它在这一行的语义其实是「不用 Blender 了」，不该比「重新安装」还重。
            -->
              <div class="row-actions">
                <button class="link" :disabled="blenderBusy" @click="setupBlender">
                  {{
                    blenderBusy ? t('mcp.blenderSetup.working') : t('mcp.blenderSetup.reinstall')
                  }}
                </button>
                <button class="link" @click="showBlenderRaw = !showBlenderRaw">
                  {{ showBlenderRaw ? t('mcp.blenderSetup.rawBack') : t('mcp.blenderSetup.raw') }}
                </button>
                <!-- 这一行真的改过才长出保存 —— 没改过的按钮点下去什么都不会发生 -->
                <AppButton
                  v-if="blenderRow && isRowDirty(blenderRow)"
                  class="save-row"
                  variant="primary"
                  size="medium"
                  :disabled="savingId !== '' || rowError(blenderRow) !== ''"
                  :title="rowError(blenderRow)"
                  @click="saveRow(blenderRowIndex)"
                >
                  {{
                    savingId === BLENDER_SERVER_ID ? t('mcp.actions.saving') : t('mcp.actions.save')
                  }}
                </AppButton>
                <button
                  v-if="blenderRow"
                  class="link danger"
                  @click="removeServer(blenderRowIndex)"
                >
                  {{ t('mcp.actions.remove') }}
                </button>
              </div>
            </template>
          </div>
        </li>
      </ul>

      <!--
        手动配置的那几条自成一组。

        和「内置」分开是因为**责任人不同**：这一组是用户自己加的，坏了要自己
        去看命令行和环境变量；内置那组坏了该去点「重新安装」或「重试连接」。
        原来两类混在一张表里，盒子装的 blender 和随手加的 filesystem 长得一样。
      -->
      <h4 class="section-title">{{ t('mcp.client.manualTitle') }}</h4>

      <ul class="category-list">
        <template v-for="(server, index) in servers" :key="index">
          <li
            v-if="!isPresetRow(server)"
            class="category manual"
            :class="{ draft: isDraftRow(server), open: isExpanded(server) }"
          >
            <!--
          收起态：一行就够 —— 名字 + 通没通 + 删除。

          **这是这一屏最大的一处减法。** 每次进这个页面都是为了看一眼服务通没通，
          而「改 blender 的启动命令」是一辈子做一两次的事；原来却把四个输入框
          和两行说明永久摊着，一条 server 占掉半屏。
        -->
            <div class="category-head">
              <button class="category-open" @click="toggleRow(server)">
                <PhCaretRight class="caret" :class="{ open: isExpanded(server) }" />
                <span class="category-name">
                  {{ server.id.trim() || t('mcp.client.newServer') }}
                </span>
                <!--
            停用的 server 也会带一条状态回来（agent 要能区分「停用」和「没配过」），
            所以这里必须分开显示：把用户自己关掉的东西报成「连接失败」，
            只会让人去排查一个根本不存在的故障。
          -->
                <span v-if="chipOf(server.id)" class="status" :class="chipOf(server.id)!.tone">
                  {{ chipOf(server.id)!.label }}
                </span>

                <!-- 没存过的那条要说出来，否则和正在跑的配置长得一模一样 -->
                <span v-else-if="isDraftRow(server)" class="status muted">
                  {{ t('mcp.status.unsaved') }}
                </span>
              </button>

              <div class="head-control">
                <!--
            保存按钮长在它自己这一行上。

            原来是页面底部一个总的「保存并连接」，于是几条互不相干的服务被绑成
            一件事：改 blender 的时候顺手把另一条半填的也提交了，另一条填错了
            blender 这条也存不了。每条服务本来就是独立的。

            只在这一行真的改过时才出现 —— 没改过的行摆一个按钮，既是噪音，
            点下去也什么都不会发生。
          -->
                <AppButton
                  v-if="isRowDirty(server)"
                  class="save-row"
                  variant="primary"
                  size="medium"
                  :disabled="savingId !== '' || rowError(server) !== ''"
                  :title="rowError(server)"
                  @click="saveRow(index)"
                >
                  {{
                    savingId === server.id.trim() ? t('mcp.actions.saving') : t('mcp.actions.save')
                  }}
                </AppButton>

                <!--
                  删除降级成链接。它是破坏性的，但也不是用户来这一页要干的事 ——
                  做成一个和「保存并连接」一样重的实心按钮，只会让手更容易点错。
                  Blender 那条用的是同一条规矩。
                -->
                <button class="link danger" @click="removeServer(index)">
                  {{ t('mcp.actions.remove') }}
                </button>
              </div>
            </div>

            <!--
          连不上的原因常驻显示，不放 tooltip。收起态下这是唯一能让用户知道
          「为什么不通」的东西 —— 一条光秃秃的「连接失败」，他能做的只有瞪着它。
        -->
            <p v-if="errorOf(server.id)" class="row-error">{{ errorOf(server.id) }}</p>

            <div v-if="isExpanded(server)" class="category-body">
              <div class="row-fields">
                <label class="field id-field">
                  <span class="field-label">{{ t('mcp.fields.id') }}</span>
                  <input
                    ref="idInputs"
                    v-model="server.id"
                    class="field-input"
                    type="text"
                    placeholder="filesystem"
                  />
                  <small v-if="idError(server)" class="error">{{ idError(server) }}</small>
                </label>

                <label class="field">
                  <span class="field-label">{{ t('mcp.fields.transport') }}</span>
                  <select v-model="server.transport" class="field-input">
                    <option value="stdio">{{ t('mcp.fields.stdio') }}</option>
                    <option value="http">{{ t('mcp.fields.http') }}</option>
                  </select>
                </label>

                <!--
            启动命令用 textarea 而不是单行 input。
            实际的命令是一长串绝对路径（`…\UnrealBox\BlenderMcp\4309a396\venv\Scri…`），
            单行框只能看到开头，用户想核对路径对不对只能把光标拖到底。
            反倒是环境变量给了三行 —— 两者本该反过来。
            `parseCommandLine` 按空白切词，换行本来就吃得下。
          -->
                <label v-if="server.transport === 'stdio'" class="field grow">
                  <span class="field-label">{{ t('mcp.fields.command') }}</span>
                  <textarea
                    v-model="server.commandLine"
                    class="field-input command-input"
                    rows="2"
                    spellcheck="false"
                    :title="server.commandLine"
                    placeholder="npx -y @modelcontextprotocol/server-filesystem D:/assets"
                  ></textarea>
                </label>

                <label v-else class="field grow">
                  <span class="field-label">{{ t('mcp.fields.url') }}</span>
                  <input
                    v-model="server.url"
                    class="field-input"
                    type="text"
                    placeholder="https://example.com/mcp"
                  />
                </label>
              </div>

              <!--
                环境变量。
                常驻显示而不是折在「高级」后面 —— 有些 server 没有它根本不工作，
                而缺了之后的症状是「连上了、工具也在、一调就失败」，
                用户不会想到去展开一个折叠区找原因。Blender 的 BLENDER_PATH 就是这样。
              -->
              <label v-if="server.transport === 'stdio'" class="field env-field">
                <span class="field-label">{{ t('mcp.fields.env') }}</span>
                <textarea
                  v-model="server.env"
                  class="field-input"
                  rows="3"
                  spellcheck="false"
                  :placeholder="t('mcp.fields.envPlaceholder')"
                ></textarea>
                <small v-if="envError(server)" class="error">{{ envError(server) }}</small>
                <small v-else class="section-note">{{ t('mcp.fields.envHint') }}</small>
              </label>

              <!-- 「停用」是改配置，跟着编辑态走；状态和删除留在收起的那一行上 -->
              <AppCheckbox v-model:checked="server.disabled" class="checkbox">
                {{ t('mcp.fields.disabled') }}
              </AppCheckbox>
              <!-- 信任同样是改配置，跟着「保存并连接」走；那句代价写在旁边，不藏 tooltip -->
              <div class="trust-field">
                <AppCheckbox v-model:checked="server.trusted" class="checkbox trust-checkbox">
                  {{ t('mcp.fields.trusted') }}
                </AppCheckbox>
                <small class="section-note">{{ t('mcp.fields.trustedHint') }}</small>
              </div>
            </div>
          </li>
        </template>
      </ul>

      <!--
        空组要说一句话，不能留一片空白 —— 这一页已经栽过一次：什么都不渲染时，
        「这里本来就没有」和「坏了」长得一模一样。
        「添加服务」挨着这句话，因为那正是这一组唯一的下一步。
      -->
      <div class="manual-foot">
        <span v-if="manualCount === 0" class="section-note">
          {{ t('mcp.client.manualEmpty') }}
        </span>
        <AppButton class="add" variant="soft" size="medium" @click="addServer">
          {{ t('mcp.actions.add') }}
        </AppButton>
      </div>

      <p v-if="saveError" class="error">{{ saveError }}</p>

      <!-- 路径光印出来没用，用户还得自己选中再粘。给两个能点的动作 -->
      <p v-if="configPath" class="path" :title="configPath">
        <span>{{ t('mcp.client.configPath', { path: configPath }) }}</span>
        <button class="link" @click="revealConfig">{{ t('mcp.actions.reveal') }}</button>
        <button class="link" @click="copy('path')">
          {{ copied === 'path' ? t('mcp.server.copied') : t('mcp.actions.copyPath') }}
        </button>
      </p>
    </section>

    <!-- ── 对外暴露虚幻引擎能力 ──────────────────────────────── -->
    <section class="settings-section host">
      <h4 class="section-title">{{ t('mcp.server.title') }}</h4>

      <div class="settings-list">
        <!-- 第一层：只有开关和一行说明 -->
        <div class="setting-item">
          <div class="setting-info">
            <div class="setting-label">{{ t('mcp.server.label') }}</div>
            <div class="setting-desc">{{ t('mcp.server.shortNote') }}</div>
          </div>
          <AppSwitch
            :checked="host.running"
            :disabled="hostBusy || (!host.running && !!portError)"
            @change="toggleHost"
          />
        </div>

        <p v-if="host.error" class="error">{{ host.error }}</p>

        <!--
          运行中才有状态行。停着的时候一个字都不多说。

          不再用 `setting-item`：那是个两端对齐的布局，而这一行右边没有任何控件，
          于是整块歪在左边，和上面开关那行的节奏对不上。
        -->
        <!--
          一行说完。原来这里是三行：地址一行、工具数一行、口径说明一行 ——
          而**地址和令牌本来就完整印在下面那段 JSON 里**，同一份连接信息
          在一屏上说了三遍。现在 JSON 块是唯一来源，这行只管「通没通」。

          三个「工具数」口径不同那句免责声明也不再常驻：两节现在各有标题，
          「引擎工具」四个字自己说清了。要对账的人还够得着 —— 挂在 title 上。
        -->
        <div v-if="host.running" class="running-row" :title="t('mcp.server.toolsNote')">
          <span class="dot"></span>
          {{ t('mcp.server.runningShort', { count: host.exposedTools }) }}
        </div>

        <!--
          「连接配置」不跟着运行状态走。
          端口和令牌是持久化的，停着也算得出来，而用户的典型顺序恰恰是
          **先把配置粘进 Claude Code，再回来开服务** —— 上一版把这个入口
          藏在 `v-if="host.running"` 里面，服务没开时根本够不着复制按钮。
        -->
        <ul class="category-list">
          <li class="category">
            <div class="category-head">
              <button class="category-open" @click="showConfig = !showConfig">
                <PhCaretRight class="caret" :class="{ open: showConfig }" />
                <span class="category-name">{{ t('mcp.server.clientConfig') }}</span>
              </button>
            </div>

            <!-- 第二层：粘给外部客户端的东西。配一次就不用再看 -->
            <div v-if="showConfig" class="category-body">
              <p class="section-note">{{ t('mcp.server.clientHint') }}</p>
              <!--
            这块里的令牌**也**要打码。下面那行头尾打码原来完全是白做的：
            同一把令牌一字不差地印在这儿，字号还更大。屏幕上多一个人、
            或者正在录屏共享，泄露的是这一块。复制拿到的始终是完整值。
          -->
              <!--
              「显示 / 隐藏」挪到代码块自己的右上角。它改的就是这一块里显示什么，
              放在下面那排动作里，用户得先读完四个按钮才知道哪个管这块。
            -->
              <div class="config-wrap">
                <pre class="config"><code>{{ displayedConfig }}</code></pre>
                <button
                  class="reveal"
                  :title="t('mcp.server.tokenMasked')"
                  :aria-label="revealToken ? t('mcp.server.hideToken') : t('mcp.server.showToken')"
                  @click="revealToken = !revealToken"
                >
                  {{ revealToken ? t('mcp.server.hideToken') : t('mcp.server.showToken') }}
                </button>
              </div>

              <!--
              五个动作砍到三个，且只有一个是按钮。

              原来这一排是：复制配置、一段打码令牌、显示、复制令牌、重置 ——
              全都长得一样重，而最右那个红色的「重置」紧挨着「复制令牌」。
              这跟同一页把「删除」推到最右、和状态胶囊隔开的规矩正好相反。
            -->
              <div class="row-actions">
                <AppButton variant="primary" size="medium" @click="copy('config')">
                  {{ copied === 'config' ? t('mcp.server.copied') : t('mcp.server.copyConfig') }}
                </AppButton>
                <button
                  class="link"
                  :disabled="installing !== ''"
                  @click="installClient('claude-code')"
                >
                  {{ t('mcp.server.installClaudeCode') }}
                </button>
                <button class="link" :disabled="installing !== ''" @click="installClient('codex')">
                  {{ t('mcp.server.installCodex') }}
                </button>
                <button class="link" @click="copy('token')">
                  {{ copied === 'token' ? t('mcp.server.copied') : t('mcp.server.copyToken') }}
                </button>
                <button class="link danger" :disabled="hostBusy" @click="rotateToken">
                  {{ t('mcp.server.rotate') }}
                </button>
              </div>
              <p class="section-note">{{ t('mcp.server.autoStartHint') }}</p>
            </div>
          </li>

          <!--
          第三层：端口和权限档。

          ## 权限档回到折叠区里，但标题要点名

          上一版把它提到了主开关同层，理由是「不能把风险藏进『高级』」。
          **那个理由只对了一半**：真正的毛病是「高级」这两个字不预告里面有什么，
          而不是它折起来了 —— 位置不是问题，标签才是。提上来之后第一屏多了一整块
          两行的设置项，而 99% 的访问根本不需要动它，这就又违背了整页的渐进披露。

          所以折回去，但标题直接写「端口和权限」，并且**把当前档位写在标题上**：
          不展开也看得见现在是只读还是可写。风险照样在明面上，第一屏少一块。
        -->
          <li class="category">
            <div class="category-head">
              <button class="category-open" @click="showAdvanced = !showAdvanced">
                <PhCaretRight class="caret" :class="{ open: showAdvanced }" />
                <span class="category-name">{{ t('mcp.server.advanced') }}</span>
                <span class="scope-tag" :class="{ writable: includeMutating }">
                  {{
                    includeMutating
                      ? t('mcp.server.scopeTagWritable')
                      : t('mcp.server.scopeTagReadOnly')
                  }}
                </span>
              </button>
              <!-- 当前端口也挂在标题行上，和「可写」一个套路：不展开也看得见 -->
              <code class="category-count">:{{ port }}</code>
            </div>

            <div v-if="showAdvanced" class="category-body">
              <div class="setting-item">
                <div class="setting-info">
                  <div class="setting-label">{{ t('mcp.server.includeMutating') }}</div>
                  <div class="setting-desc">
                    {{
                      includeMutating
                        ? t('mcp.server.scopeWritable')
                        : t('mcp.server.scopeReadOnly')
                    }}
                  </div>
                </div>
                <AppSwitch
                  v-model:checked="includeMutating"
                  :disabled="hostBusy"
                  @change="persistConfig"
                />
              </div>

              <!--
            长警告只在**风险真的变了**的时候出现。常驻的警告等于没有警告 ——
            用户第三次进这个页面就不看了。

            分现在时/将来时两句：服务停着的时候说「写操作会直接执行」，
            讲的是一件此刻并没有在发生的事，而屏幕上主开关明明是关的。
          -->
              <p v-if="includeMutating" class="warning">
                {{ host.running ? t('mcp.server.securityNote') : t('mcp.server.securityNoteIdle') }}
              </p>

              <div class="setting-item">
                <div class="setting-info">
                  <div class="setting-label">{{ t('mcp.server.port') }}</div>
                  <!--
                描述里不再写「更改前请先停止服务」：控件在运行时本来就 disabled，
                点不动的原因没必要每次都读一遍。真去点的时候用 title 说。
              -->
                  <div class="setting-desc">{{ t('mcp.server.portDesc') }}</div>
                </div>
                <input
                  v-model.number="port"
                  class="threshold-input"
                  type="number"
                  :disabled="host.running || hostBusy"
                  :title="host.running ? t('mcp.server.stopToChange') : ''"
                  min="1024"
                  @blur="persistConfig"
                  @keyup.enter="persistConfig"
                />
              </div>
              <p v-if="portError" class="error">{{ portError }}</p>
              <!-- 失焦即落盘是看不见的动作，成败都要有回执 -->
              <p v-else-if="configError" class="error">{{ configError }}</p>
              <p v-else-if="configSaved" class="section-note">
                {{ t('mcp.server.configSaved') }}
              </p>
            </div>
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-10);
  color: var(--color-text-primary);
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.section-title {
  margin: 0;
  padding-bottom: var(--space-2);
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--color-text-primary);
  letter-spacing: 0.02em;
}

.settings-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
}

.setting-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.setting-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.setting-label {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
}

.setting-desc {
  font-size: 12px;
  color: var(--color-text-muted);
  overflow-wrap: anywhere;
}

/*
 * 运行中那一行。
 *
 * 原来是三行（地址、工具数、口径说明），而且一行里混了三种字号两种字体。
 * 现在只剩一句话加一个点，字号统一到 12px —— 它是状态，不是标题。
 */
.running-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: 12px;
  color: var(--color-text-secondary);
}

/* 运行中的绿点。一眼看到状态，不用读文字 */
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--color-success-solid);
  box-shadow: 0 0 6px var(--color-success-border);
}

/* ── 折叠列表（与「工具」页同一套）───────────────────────── */
/*
 * 这一页原来自己发明了一套词汇（`.pane-list` / `.drawer` / `.server-row`），
 * 跟隔壁几页对不上。现在照搬「工具」页那套 —— `.category-list` 里一张张
 * `.category` 卡片，卡片头是 `.category-head`（caret + 名字 + 计数/状态，
 * 右边一个控件），摊开的内容缩进在同一张卡片里面，条目之间用一条上边线分隔。
 * 见 ProfileTools.vue。
 */
.category-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.category {
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-bg-surface);
}

.category-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
  padding: var(--space-3);
}

/* 名字连着 caret 和状态一起可点，点击区域才够大 */
.category-open {
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 0;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
}

.category-open:focus-visible {
  outline: 2px solid var(--color-border-focus);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

/* server 的名字是标识符，等宽；「工具」页那边是中文分类名，所以只有这里加 */
.category-name {
  font-size: var(--font-size-sm);
  color: var(--color-text-primary);
  font-family: var(--font-mono, ui-monospace, monospace);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 当前值挂在标题行上：不展开也看得见。同「工具」页的 N / M */
.category-count {
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}

/* 头部右侧的动作。和「工具」页那个开关同一个位置 */
.category-head .row-action {
  flex: none;
}

.head-control {
  flex: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.caret {
  flex-shrink: 0;
  color: var(--color-text-muted);
  transition: transform var(--motion-fast, 0.15s) var(--easing-standard, ease-in-out);
}

.caret.open {
  transform: rotate(90deg);
}

/*
 * 摊开的内容缩进到名字下面，和「工具」页的 `.tool-list` 同一组内边距 ——
 * 左边那一格留给 caret，读起来才是「这些属于上面那一条」。
 */
.category-body {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: 0 var(--space-3) var(--space-3) var(--space-8);
}

/* 摊开区里的条目：上边线分隔，同 `.tool-item` */
.category-body .engine-entry,
.category-body .engine-row {
  border-top: 1px solid var(--color-border-subtle);
  padding-top: var(--space-2);
}

/* 一排动作。只有主动作是按钮，其余降级成链接 */
.row-actions {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.row-actions .link.danger {
  margin-left: auto;
}

/* 空组那句话和「添加服务」并排：那是这一组唯一的下一步 */
.manual-foot {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.manual-foot .add {
  margin-left: auto;
}

/*
 * 没存过的那条。原来它和正在跑的配置长得一模一样 —— 一条已连接生效、
 * 一条还只是草稿，视觉权重却完全相同，用户分不出哪条在跑。
 */
.category.draft {
  border-style: dashed;
  background: none;
}

/* 当前权限档写在折叠标题上：不展开也看得见现在是只读还是可写 */
.scope-tag {
  padding: 1px 6px;
  border-radius: 9999px;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-muted);
  font-size: 11px;
}

.scope-tag.writable {
  background: var(--color-warning-bg);
  color: var(--color-warning-text);
}

/* ── 客户端配置 ──────────────────────────────────────────── */
/*
 * 代码块是这一页唯一还留着底色方框的东西。行只有分隔线、摊开区只有内边距，
 * 到这里才是一个块 —— 靠这三档权重就能判断层级，不用数缩进。
 */
.config-wrap {
  position: relative;
}

.config {
  margin: 0;
  padding: var(--space-3);
  padding-right: var(--space-10);
  border-radius: var(--radius-sm);
  background: var(--color-bg-surface-hover);
  font-size: 11px;
  line-height: 1.6;
  overflow-x: auto;
  white-space: pre;
}

/* 显示 / 隐藏挂在代码块自己的角上：它改的就是这一块里显示什么 */
.reveal {
  position: absolute;
  top: var(--space-2);
  right: var(--space-2);
  padding: 2px 6px;
  border: none;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--color-text-muted);
  font-size: 11px;
  cursor: pointer;
}

.reveal:hover {
  color: var(--color-text-primary);
}

.port-field input {
  max-width: 120px;
}

/* ── 一条 server 的编辑态 ───────────────────────────────── */
/*
 * 输入框原来是裸的 `<input>` / `<select>` / `<textarea>` —— 在暗色主题下
 * 直接露出系统控件（白底下拉、浅色细边框），跟这一页其它地方完全对不上。
 * 用 AIProviders 那套 `.field-label` + `.field-input`，同一个 token、同一档圆角。
 */
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.field-label {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.field-input {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-sunken);
  color: var(--color-text-primary);
  font-size: 13px;
}

.field-input:focus {
  outline: none;
  border-color: var(--color-accent-border);
}

/*
 * 标识和连接方式并排，启动命令和环境变量各自占满一行。
 *
 * `min-width: 260px` 是给上一版整页宽的卡片配的；摊开区现在缩进了一截
 * （`.category-body` 左边留给 caret），那个下限会把框顶出卡片右边 ——
 * 截图里环境变量那块就是这么溢出去的。
 */
.row-fields {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.row-fields .field {
  flex: 1 1 180px;
}

.row-fields .field.grow {
  flex: 1 1 100%;
}

.id-field {
  max-width: 200px;
}

.port-field {
  max-width: 140px;
}

.env-field textarea,
.path-input,
.command-input {
  resize: vertical;
  font-family: var(--font-mono, ui-monospace, monospace);
  line-height: 1.5;
}

.checkbox {
  align-items: center;
  font-size: var(--font-size-xs);
  color: var(--color-text-muted);
}

.trust-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

/* ── 状态胶囊 ───────────────────────────────────────────── */
.status {
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 11px;
  white-space: nowrap;
}

.status.ok {
  background: var(--color-success-bg);
  color: var(--color-success-text);
}

.status.bad {
  background: var(--color-danger-bg);
  color: var(--color-danger-text);
}

.status.muted {
  background: var(--color-bg-surface-hover);
  color: var(--color-text-muted);
}

/* ── 摊开区里的条目 ─────────────────────────────────────── */
.engine-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.engine-row code {
  font-size: var(--font-size-xs);
  color: var(--color-text-secondary);
}

.engine-entry {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.engine-desc {
  margin: 0;
  font-size: var(--font-size-xs);
  line-height: 1.6;
  color: var(--color-text-muted);
}

/*
 * 连不上的原因。
 * 等宽 + 可换行：这里放的是 `spawn npx ENOENT` 这种原文，
 * 截断了就等于没说；换行难看也比看不全强。
 */
.row-error {
  margin: 0;
  padding-left: var(--space-6);
  color: var(--color-danger-text);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}

/* 卡片里的原因行：和摊开的内容一样缩进到名字下面 */
.category > .row-error {
  padding: 0 var(--space-3) var(--space-3) var(--space-8);
}

/* ── 通用 ────────────────────────────────────────────────── */
.actions {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

/* 说明文字用隔壁几页同一个名字和同一档字号 */
.section-note,
.path {
  margin: 0;
  color: var(--color-text-muted);
  font-size: var(--font-size-xs);
  line-height: 1.6;
}

.path {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.path > :first-child {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 行内的小动作。路径、URL 光印出来没用，用户还得自己选中再粘 */
.link {
  flex: none;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-accent-text, var(--color-text-secondary));
  font-size: 12px;
  cursor: pointer;
}

.link:hover {
  text-decoration: underline;
}

.link:disabled {
  color: var(--color-text-muted);
  cursor: default;
  text-decoration: none;
}

/*
 * 破坏性的动作用链接而不是实心按钮。
 *
 * 「重置令牌」和「不用 Blender 了」都不是用户来这一页要干的事，做成和
 * 「复制配置」「重新安装」一样重的按钮，只会让手更容易点错 —— 同一页里
 * 「删除」被推到最右、和状态胶囊隔开，用的就是这条道理。
 */
.link.danger {
  color: var(--color-danger-text);
}

.error {
  margin: 0;
  color: var(--color-danger-text);
  font-size: 12px;
}

.warning {
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-left: 2px solid var(--color-warning-border);
  border-radius: 0 4px 4px 0;
  background: var(--color-warning-bg);
  color: var(--color-warning-text);
  font-size: 12px;
  line-height: 1.6;
}

/* ── Toggle（与其他设置页一致）───────────────────────────── */
.threshold-input {
  width: 80px;
  padding: 4px 8px;
  border: 1px solid var(--color-border-subtle);
  border-radius: 4px;
  background: var(--color-bg-surface-hover);
  color: var(--color-text-primary);
  font-size: 12px;
  text-align: center;
}

.threshold-input:focus {
  outline: none;
  border-color: var(--color-accent-border);
}

.threshold-input:disabled {
  color: var(--color-text-disabled);
  cursor: not-allowed;
}
</style>
