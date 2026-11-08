#!/usr/bin/env node
/**
 * 官方服务端端点棘轮门禁。
 *
 * 为什么需要它：`scripts/verify-offline-boot.mjs` 靠 CDP 的 Network 域，
 * **只看得见渲染层，而且只看页面加载**。主进程的 fetch / axios / net.request 既不走
 * session.webRequest 也不进 CDP；点按钮之后才发的请求它同样看不到。这里做静态扫描补上。
 *
 * 覆盖范围（2026-08 从「只匹配 api/ai/v1」扩到全部官方面）：
 *   · 所有 `/api/...` 路径 —— 不再只盯 AI 网关。曾经因为只匹配 `api/ai/v1`，
 *     `/api/boards`、`/api/notebooks`、`/stats/events` 这些一直在门禁视野之外。
 *   · `stats/events` —— 遥测上报，路径上没有 `/api/` 前缀。
 *   · 官方域名字面量 —— 硬编码兜底域名（`VITE_APP_BASE_URL || '<官方域名>'`）
 *     会随源码开源，而且会把「配漏了」变成「静默打向线上」。
 *
 * 为什么是棘轮而不是一刀切归零：社区版目前仍有少量历史官方端点，具体位置由
 * baseline 逐文件列明。硬要求归零只会逼着后来的人绕过门禁，所以先记一份
 * **允许残留清单**，只保证不再新增；每迁走一批就把清单调小，单向收紧。
 *
 * 棘轮只能往一个方向转：`--update` **只接受变小**。想让基线变大会被直接拒绝，
 * 否则任何卡在这道门禁上的人（尤其是 AI Agent）最省事的做法就是跑一下 --update
 * 把红灯刷成绿灯 —— 那样这道门禁等于不存在。
 *
 * 用法：
 *   node scripts/check-official-endpoints.mjs          校验
 *   node scripts/check-official-endpoints.mjs --update  收紧基线（仅允许变小）
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const SRC = join(ROOT, 'src')
const BASELINE = join(ROOT, 'scripts', 'official-endpoints.baseline.json')

/**
 * 应用**自带的本地 HTTP 服务**（给 UE 插件调用的那个），路由也长成 `/api/xxx`，
 * 但它跑在本机、与官方服务端无关。整文件排除，比逐条路径开白名单好维护。
 */
const EXCLUDED_FILES = new Set(['src/main/services/http/server.ts'])

const SCANNED_EXTENSIONS = ['.ts', '.vue', '.js', '.mjs']

/**
 * 测试文件不计入。
 *
 * 门禁要守的是「**发出去的代码**不许调官方服务端」，测试不进产物。而且守这道门禁的
 * 测试本身就要写出官方路径来断言它被拦住了 —— 把它们算进来，等于写一条防泄漏的
 * 测试就会把门禁自己顶红。
 */
const TEST_FILE_PATTERN = /\.(test|spec)\.(ts|js|mjs)$/

/**
 * 端点特征。
 *
 * 这几条正则认的是「长得像服务端地址」，认不出**那是谁的服务端** ——
 * 用户自建的资产服务器、第三方厂商的 API、注释里记着的历史，全都会被匹配上。
 * 分辨这件事交给下面的 `NOT_OFFICIAL_CALLS`。
 */
const ENDPOINT_PATTERNS = [
  /\/api\/[a-z0-9][a-z0-9-]*/gi,
  /stats\/events/gi,
  /unrealagent\.net/gi,
  /uebox\.ai/gi,
  /ue5box\.com/gi
]

/**
 * 模块说明符不是端点。
 *
 * npm 包的子路径导出长得和 URL 路径一模一样
 * （`@earendil-works/pi-ai/api/openai-responses.lazy`、`@ai-sdk/openai`），
 * 会被 `/api/...` 那条正则一路匹配上 —— 于是「多导入一个 API 实现」
 * 就会把这道门禁顶红，而它跟官方服务端一点关系都没有。
 *
 * 真正要守的是「发出去的请求」。请求里的地址不会出现在 `from '…'`、
 * `import('…')`、`require('…')` 这几个位置上，所以把它们整段抹掉是安全的，
 * 抹掉之后剩下的才是这道门禁该看的东西。
 */
const MODULE_SPECIFIER_PATTERNS = [
  /\bfrom\s+['"][^'"]+['"]/g,
  /\bimport\s*\(\s*['"][^'"]+['"]\s*\)/g,
  /\brequire\s*\(\s*['"][^'"]+['"]\s*\)/g,
  // 只为副作用的导入：import '@/styles/foo.css'
  /^\s*import\s+['"][^'"]+['"]/gm
]

function stripModuleSpecifiers(text) {
  let out = text
  for (const pattern of MODULE_SPECIFIER_PATTERNS) out = out.replace(pattern, ' ')
  return out
}

/**
 * 整行注释不是端点。
 *
 * 理由与 `stripModuleSpecifiers` 完全相同：这道门禁守的是「**发出去的请求**」。
 * 而这个仓库的风格是**把踩过的坑记在原地** —— `updateFeed.ts` 的注释里写着
 * 曾经硬编码的官方域名，`AssetImportService.ts` 的注释里写着被删掉的
 * `/stats/events/batch` 上报。那些注释正是「这条已经没了」的证据，
 * 把它们算成引用，等于「一写清楚就顶红」，会逼着后来的人删注释来过门禁。
 *
 * 只认**整行**注释，不做完整词法分析：代码行里带 `//` 的多半是 URL 本身
 * （`https://…`），一刀切会把真正该被看见的调用也抹掉。
 * 这个取舍与 `src/preload/officialAuthRemoved.test.ts` 的 `codeLinesOf` 一致。
 */
function stripLineComments(text) {
  let inBlock = false
  return text
    .split('\n')
    .filter((line) => {
      const trimmed = line.trim()
      if (inBlock) {
        if (trimmed.includes('*/')) inBlock = false
        return false
      }
      if (trimmed.startsWith('/*')) {
        if (!trimmed.includes('*/')) inBlock = true
        return false
      }
      return !trimmed.startsWith('//') && !trimmed.startsWith('*')
    })
    .join('\n')
}

/**
 * 匹配到了地址，但**不是对官方服务端的调用**。
 *
 * 这不是白名单，是**分类**。基线曾经把两类东西混在一个数里：真正打向官方服务端的
 * 调用，和打向「用户自己那台服务器」的调用。后者是社区版的正常能力，永远不会消失，
 * 于是那个数永远归不了零，也看不出真实剩余量 —— 门禁失去了指示作用，
 * 将来真混进一个官方端点，也会淹没在一百多处噪声里。
 *
 * 分完之后 `official-endpoints.baseline.json` 只统计第一类，**目标是零**。
 *
 * 每条都要写清楚基址是谁给的。新文件被匹配到时必须在这里做一次判断，不能默认放行：
 * 认不出来的一律当官方，进基线。
 */
const NOT_OFFICIAL_CALLS = {
  // ── 用户自建的服务器（地址由用户在界面上填，或从 .vault 发现文件读出来）──
  'src/main/networkV2/SyncClient.ts': '打 .vault 发现文件里的服务器地址',
  'src/main/networkV2/AssetServer.ts': '本机起的资产服务器，自己的路由',
  'src/main/networkV2/ImportSessionClient.ts': '打用户的 vault 服务器',
  'src/main/ipc/networkVaultV2.ts': '打用户的 vault 服务器',
  'src/main/ipc/projectImport.ts': '打用户的 vault 服务器（serverBaseUrl 由调用方传入）',
  'src/main/services/asset/projectArchivePull.ts':
    '打用户的 vault 服务器取回工程整包（fileUrl 由 IPC 层按当前库的 networkPath 拼出）',
  'src/main/networkV2/assetProxy.ts':
    '只代理 VaultServiceManager 已登记的用户资源库，地址和凭据取自匹配的 SyncClient',
  'src/main/sqliteDataBase/VaultManager.ts': '打用户的 vault 服务器',
  'src/main/sqliteDataBase/ipc/assetData/thumbnails.ts': '打 remoteInfo.serverBase',
  'src/main/agent-v3/tools/adapted/project/projectTool.ts': '打用户的 vault 服务器',
  'src/renderer/src/views/ServerManagement/index.vue':
    '整页都在打用户填的服务器地址（/api/system/* 是 standalone 资产服务器的路由）',
  'src/renderer/src/views/System/Preferences/panels/ProfileAsset.vue':
    '查用户那台资产服务器的版本与更新',

  // ── 第三方厂商，跟官方服务端没有关系 ──
  'src/main/ai/catalog.generated.ts':
    '第三方模型厂商目录，其中几家的地址正好带 /api/（火山方舟、智谱、OpenRouter、Venice）。' +
    '这是生成产物，加厂商时数会涨 —— 涨之前先确认新增的确实是厂商地址',
  'src/main/services/dashscope/ossUpload.ts':
    '用户自己的 API Key 直接请求 dashscope.aliyuncs.com 的临时上传凭证',
  'src/main/ai/speechVoiceDesign.ts':
    '百炼声音设计的 /api/v1/services/audio/tts/customization：域名取自用户配的语音合成 Provider，用自己的 API Key 直连',
  'src/main/ai/oauth.ts': '厂商自己的 OAuth 端点（OpenRouter / ChatGPT / Kimi）',
  'src/main/ai/zcode.ts':
    '用户主动连接的 ZCode 订阅：向 zcode.z.ai 登录和发送 Anthropic 消息，使用用户自己的 JWT',
  'src/main/ai/zcodeCaptcha.ts':
    '仅在 ZCode 模型调用时读取 zcode.z.ai 的验证配置，必要时在隔离浏览器运行阿里云验证 SDK',
  'src/main/ipc/assistant.ts': 'Epic Games 社区的 Assistant API（dev.epicgames.com）',
  'src/main/ai/realtime/doubaoRealtime.ts':
    '豆包全双工语音的 WebSocket 端点，由用户配置 Provider 并用自己的 API Key 直连',
  'src/main/ai/stt/doubaoStt.ts':
    '豆包流式语音识别（sauc）的 WebSocket 端点，同上：用户自己配 Provider、自己的 API Key 直连',
  'src/main/ai/stt/transcriptionStt.ts':
    'SenseVoice 自带服务的 /api/v1/asr 路径：用户本机或自建的识别服务，地址由用户在 Provider 里填',
  'src/main/ai/model3d.ts':
    '3D 生成厂商（Tripo / Meshy / Hyper3D Rodin），全部打 provider.baseUrl —— ' +
    '地址由用户在模型配置里填、用自己的 API Key 直连。' +
    '被匹配到的是 meshy 的 `doc:` 厂商文档链接（docs.meshy.ai/en/api/…），不是请求地址',

  // ── 界面文案，不是请求 ──
  'src/renderer/src/i18n/locales/en-US.ts':
    '纯文案文件，一行请求都不发。被匹配到的是 3D 生成说明里教用户怎么填 ' +
    'Hyper3D Rodin 的 Base URL（api.hyper3d.com/api/v2）—— 第三方厂商地址',
  'src/renderer/src/i18n/locales/zh-CN.ts': '同 en-US.ts',

  // ── 用户点击才会打开的外链，不是应用发出的请求 ──
  'src/renderer/src/App.vue': '更新公告弹层里「查看详情」的链接',
  'src/renderer/src/views/System/Preferences/panels/ProfileAbout.vue': '关于页的官网链接'
}

/**
 * 用户主动开通的官方付费服务。
 *
 * 和上面两类不同，这里的地址**确实是官方服务端**，不假装成第三方。它能留在社区版里，
 * 靠的是三条约束，缺一条就不该进这张表：
 *   1. 用户在界面上主动点「连接」之后才会用到；没连接时，启动、打开任何页面都零请求。
 *   2. 与本地功能无关：不连接，应用的一切照常可用，不出现任何提示或门禁。
 *   3. 进这张表的文件**只放地址常量**，不发请求 —— 下面会查：出现 fetch / axios /
 *      net.request / ipcMain 就判为分类过期。请求代码放在别的文件、从参数拿地址，
 *      于是域名全仓只有这一处，要审的面就只有这一处。
 */
const USER_ENABLED_OFFICIAL_SERVICES = {
  'src/main/ai/creatorPlan/endpoint.ts':
    '创作者 Token Plan 的服务地址。只有用户在「设置 → 模型」里点「连接」才会用到；' +
    '未连接时 creator-plan:state 直接返回、不发请求（见 src/main/ai/creatorPlan/service.ts）',
  'src/main/services/share/endpoint.ts':
    '官网共享技能库的地址。只有用户在网页上点「装到盒子」、让 Agent 或 uebox skills add 安装，' +
    '或在技能页点「分享」/「浏览共享技能」时才会用到；启动和打开页面不发请求（见 src/main/ipc/share.ts）'
}

/** 进了「用户主动开通」一类的文件里不许出现的东西：它只该是个地址常量 */
const REQUEST_MARKERS = ['fetch(', 'axios', 'net.request', 'ipcMain', 'XMLHttpRequest', 'WebSocket']

/**
 * 官方基址的取用方式。
 *
 * 用来给 `NOT_OFFICIAL_CALLS` 兜底：一个文件被归为「不是官方调用」，却又出现了这些
 * 标记，说明分类过期了 —— 要么它新增了官方调用，要么当初就归错了。
 * 这条守的正是分类本身最大的风险：把一个文件放进分类表之后，它就不再被计数了。
 */
const OFFICIAL_BASE_MARKERS = [
  'requireOfficialBaseUrl',
  'getOfficialBaseUrl',
  'hasOfficialEndpoint',
  'VITE_APP_BASE_URL',
  'authorizedFetch',
  'ensureFreshAccessToken'
]

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      walk(full, out)
      continue
    }
    if (TEST_FILE_PATTERN.test(name)) continue
    if (SCANNED_EXTENSIONS.some((ext) => name.endsWith(ext))) out.push(full)
  }
  return out
}

function toRepoPath(file) {
  // 统一成正斜杠，免得基线在 Windows 与 CI 之间来回变动
  return relative(ROOT, file).split(sep).join('/')
}

function collect() {
  const counts = {}
  /** 分类表里声明了「不是官方调用」，却出现官方基址标记的文件 */
  const misclassified = []

  for (const file of walk(SRC)) {
    const repoPath = toRepoPath(file)
    if (EXCLUDED_FILES.has(repoPath)) continue

    const raw = readFileSync(file, 'utf-8')

    if (repoPath in USER_ENABLED_OFFICIAL_SERVICES) {
      const code = stripLineComments(raw)
      const found = [...OFFICIAL_BASE_MARKERS, ...REQUEST_MARKERS].filter((marker) =>
        code.includes(marker)
      )
      if (found.length > 0) misclassified.push({ file: repoPath, markers: found })
      continue
    }

    if (repoPath in NOT_OFFICIAL_CALLS) {
      const found = OFFICIAL_BASE_MARKERS.filter((marker) =>
        stripLineComments(raw).includes(marker)
      )
      if (found.length > 0) misclassified.push({ file: repoPath, markers: found })
      continue
    }

    const text = stripModuleSpecifiers(stripLineComments(raw))
    let hits = 0
    for (const pattern of ENDPOINT_PATTERNS) {
      const matches = text.match(pattern)
      if (matches) hits += matches.length
    }
    if (hits > 0) counts[repoPath] = hits
  }

  // 表里登记了、文件却不在了：分类表跟着删，别让它变成一条永远用不上的放行
  for (const file of Object.keys(USER_ENABLED_OFFICIAL_SERVICES)) {
    if (!existsSync(join(ROOT, file))) misclassified.push({ file, markers: ['文件不存在'] })
  }

  if (misclassified.length > 0) {
    console.error('✖ 分类过期了：这些文件进了分类表（因此不计数），内容却和分类对不上：\n')
    for (const { file, markers } of misclassified) {
      console.error(`  · ${file} —— ${markers.join(', ')}`)
    }
    console.error(
      '\n要么它新增了官方调用（那就从 NOT_OFFICIAL_CALLS 里拿掉，让它进基线），' +
        '\n要么当初归错了（那就修正分类里写的理由）。' +
        '\n「用户主动开通」一类的文件只许放地址常量：请求代码挪到别的文件、从参数拿地址；' +
        '\n文件删了就把它从 USER_ENABLED_OFFICIAL_SERVICES 里一起删掉。' +
        '\n\n这条守的是分类本身：文件一旦进了分类表就不再计数，' +
        '\n所以「进了表之后偷偷加官方调用」必须被拦下来。'
    )
    process.exit(1)
  }

  return counts
}

const current = collect()

/** 读基线；读不到返回 null（首次 bootstrap 用） */
function readBaseline() {
  try {
    return JSON.parse(readFileSync(BASELINE, 'utf-8'))
  } catch {
    return null
  }
}

const sum = (counts) => Object.values(counts).reduce((total, n) => total + n, 0)

if (process.argv.includes('--update')) {
  const previous = readBaseline()

  if (previous === null) {
    writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`, 'utf-8')
    console.log(`已建立初始基线：${Object.keys(current).length} 个文件 / ${sum(current)} 处引用。`)
    process.exit(0)
  }

  // 棘轮只准往一个方向转：任何一处变大都拒绝写入
  const grown = []
  for (const [file, count] of Object.entries(current)) {
    const allowed = previous[file] ?? 0
    if (count > allowed) grown.push(`${file}: ${allowed} → ${count}`)
  }

  if (grown.length > 0) {
    console.error('✖ 拒绝写入基线：棘轮只能收紧，不能放松。\n')
    for (const line of grown) console.error(`  · ${line}`)
    console.error(
      '\n--update 的用途是「迁走了一批官方端点之后，把基线调小」，' +
        '\n不是「新增了官方端点之后，把基线调大让门禁变绿」。' +
        '\n请删除平台请求，使用用户明确配置的服务地址。'
    )
    process.exit(1)
  }

  const before = sum(previous)
  writeFileSync(BASELINE, `${JSON.stringify(current, null, 2)}\n`, 'utf-8')
  console.log(
    `基线已收紧：${before} → ${sum(current)} 处引用（${Object.keys(current).length} 个文件）。`
  )
  process.exit(0)
}

const baseline = readBaseline()
if (baseline === null) {
  console.error(`读不到基线文件 ${relative(ROOT, BASELINE)}。首次使用请先跑 --update。`)
  process.exit(1)
}

const problems = []
for (const [file, count] of Object.entries(current)) {
  const allowed = baseline[file] ?? 0
  if (count > allowed) {
    problems.push(
      allowed === 0
        ? `新增官方端点引用：${file}（${count} 处）`
        : `${file} 的官方端点引用从 ${allowed} 处涨到 ${count} 处`
    )
  }
}

// 变少是好事，但基线得跟着收紧，否则棘轮会松掉。
const shrunk = []
for (const [file, allowed] of Object.entries(baseline)) {
  const count = current[file] ?? 0
  if (count < allowed) shrunk.push(`${file}: ${allowed} → ${count}`)
}

if (problems.length > 0) {
  console.error('✖ 官方端点门禁未通过：\n')
  for (const line of problems) console.error(`  · ${line}`)
  console.error(
    '\n社区版不该新增对官方服务端的调用。' +
      '\n  · 模型走 resolveLanguageModel（主进程）或 window.api.ai（渲染层）；' +
      '\n  · 服务地址和凭据必须由用户明确配置。'
  )
  process.exit(1)
}

if (shrunk.length > 0) {
  console.error(`✖ 有 ${shrunk.length} 个文件的引用变少了，请跑 --update 收紧基线：\n`)
  for (const line of shrunk) console.error(`  · ${line}`)
  process.exit(1)
}

console.log(
  `官方端点门禁通过（${Object.keys(current).length} 个文件 / ${sum(current)} 处引用，均在基线内）。`
)
