/**
 * 打包出可执行文件（`project_package`），以及拿打包版跑一次冒烟（`project_smoke_test`）。
 *
 * ## 为什么要有它们
 *
 * 工作室模式的交付标准第一条是「打包好的游戏」（docs/AI游戏工作室设计-2026-09-25.md 第 1 节）。
 * 以前只能让模型自己拼一条 RunUAT 命令走 shell：引擎在哪、参数怎么写、输出在哪、
 * 失败了日志里哪句是关键 —— 每一步都在碰运气，而一次打包动辄半小时。
 *
 * ## 降优先级跑
 *
 * 打包是整机满载的活（编译、烘焙着色器），而用户往往就在这台机器上干活。
 * UAT 一起来就降成「低于正常」：Windows 上低优先级进程派生的子进程
 * （UBT、烘焙用的编辑器命令行）默认继承这个优先级，整棵树都让着前台。
 *
 * ## 停得下来
 *
 * UAT 会一层层派生子进程。用户按停止时只杀最外层，里面的烘焙还会跑完半小时；
 * 所以停止时按进程树杀（`taskkill /T`）。
 *
 * 冒烟测的是「打包版能不能起来、跑一会儿不崩」，不是好不好玩 —— 那由验收员在编辑器里玩。
 * 两者互补：编辑器里能玩的，打包后丢资源、缺地图、启动就崩的事并不少见。
 */

import { spawn, type ChildProcess } from 'child_process'
import { createWriteStream, promises as fs } from 'fs'
import { constants, setPriority } from 'os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { z } from 'zod'

import { defineTool, type UnrealAgentTool } from '../defineTool'
import { getTargetProjectPath } from '../../core/projectTargetContext'
import UnrealPathManagerUtil from '../../../utils/UnrealPathManager'
import { readUeJsonFile } from '../../../utils/ueTextFile'
import { createFindNonEnglishTextTool } from './projectTextAudit'

// ── 纯函数：参数、阶段、日志 ────────────────────────────────────────────

export type PackageConfiguration = 'Development' | 'Shipping'

export function buildUatArgs(input: {
  uproject: string
  configuration: PackageConfiguration
  archiveDir: string
  platform: 'Win64' | 'Mac'
  /** 只烘焙这几张地图；不给 = 工程里所有地图 */
  maps?: string[]
}): string[] {
  return [
    'BuildCookRun',
    `-project=${input.uproject}`,
    '-noP4',
    `-platform=${input.platform}`,
    `-clientconfig=${input.configuration}`,
    `-serverconfig=${input.configuration}`,
    '-build',
    '-cook',
    input.maps?.length ? `-map=${input.maps.join('+')}` : '-allmaps',
    '-stage',
    '-pak',
    '-archive',
    `-archivedirectory=${input.archiveDir}`,
    '-utf8output',
    '-unattended'
  ]
}

/**
 * 地图参数规整成 UAT `-map=` 认的写法：`/Game/Maps/Main` 或 `Main`，去掉 `.umap` 和对象名后缀。
 * 名字里只许字母、数字、下划线、连字符和斜杠 —— `+` 是 UAT 的分隔符，其余字符进不了命令行。
 */
export function normalizeMaps(maps: string[] | undefined): string[] {
  const out: string[] = []
  for (const raw of maps ?? []) {
    const name = raw
      .trim()
      .replace(/\\/g, '/')
      .replace(/\.umap$/i, '')
      .replace(/\.[A-Za-z0-9_]+$/, '')
    if (!name) continue
    if (!/^[A-Za-z0-9_\-/]+$/.test(name)) {
      throw new Error(
        `地图「${raw}」的写法不对：给地图名（Main）或资产路径（/Game/Maps/Main），只能有字母、数字、下划线、连字符和斜杠`
      )
    }
    if (!out.includes(name)) out.push(name)
  }
  return out
}

/**
 * 给 cmd.exe 的一个参数加引号：只要带了安全字符以外的东西就整体（`-key=值` 只包值）包起来。
 *
 * 命令行是交给 `cmd /s /c` 原样执行的，没包起来的 `&` `^` `|` `<` `>` `(` `)` 会被 cmd
 * 当成命令符号 —— 工程在 `D:\R&D\` 下就会被拆成两条命令，模型给的 output_dir 还能借此
 * 塞进任意命令。引号里 `%` 照样会被展开、`"` 没法转义，这两种直接拒绝。
 */
export function quoteForCmd(arg: string): string {
  if (/["%\r\n]/.test(arg)) {
    throw new Error(`参数里有命令行没法安全传递的字符（" % 或换行）：${arg}`)
  }
  if (/^[\w\-.:/\\=+,@]*$/.test(arg)) return arg
  const eq = arg.indexOf('=')
  // 结尾的反斜杠会把收尾的引号转义掉，吞掉后面的参数
  const wrap = (value: string): string => `"${value.replace(/\\+$/, '')}"`
  if (arg.startsWith('-') && eq > 0) return `${arg.slice(0, eq + 1)}${wrap(arg.slice(eq + 1))}`
  return wrap(arg)
}

/** UAT 在每个阶段开头打的那一行 → 给人看的阶段名 */
const STAGES: Array<[RegExp, string]> = [
  [/BUILD COMMAND STARTED/i, '编译'],
  [/COOK COMMAND STARTED/i, '烘焙资源'],
  [/STAGE COMMAND STARTED/i, '整理文件'],
  [/PACKAGE COMMAND STARTED/i, '打包'],
  [/ARCHIVE COMMAND STARTED/i, '归档'],
  [/BUILD SUCCESSFUL/i, '完成']
]

export function stageOf(line: string): string | null {
  for (const [pattern, name] of STAGES) if (pattern.test(line)) return name
  return null
}

/** 日志里值得交给模型看的那几句：报错、致命错误。去重，最多 n 条 */
export function keyErrors(lines: string[], n = 20): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of lines) {
    const line = raw.trim()
    if (!/\berror\b|fatal|failed|exception|critical/i.test(line)) continue
    if (/\b0 error|errors?: 0\b|warning/i.test(line)) continue
    const key = line
      .replace(/\[\d[\d.:\- ]*\]/g, '')
      .trim()
      .slice(0, 200)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(line.slice(0, 300))
    if (out.length >= n) break
  }
  return out
}

/** 打包版游戏日志里说明「它崩了」的那几种话 */
const FATAL_LINE =
  /Fatal error|Unhandled Exception|Assertion failed|appError called|Critical error/i

export function fatalLines(log: string): string[] {
  return log
    .split(/\r?\n/)
    .filter((line) => FATAL_LINE.test(line))
    .slice(0, 10)
}

// ── 引擎与工程 ──────────────────────────────────────────────────────────

export async function findUproject(projectDir: string): Promise<string> {
  const name = (await fs.readdir(projectDir)).find((entry) => entry.endsWith('.uproject'))
  if (!name) throw new Error(`${projectDir} 里没有 .uproject`)
  return join(projectDir, name)
}

/** 这个工程用哪个引擎：自编译引擎按 GUID 查注册表，安装版按版本号对 */
export async function engineRootFor(uproject: string): Promise<string> {
  // 引擎存 .uproject 时遇到中文工程名、中文描述会整份存成 UTF-16LE，按 utf-8 读就是乱码
  const association = String(
    (await readUeJsonFile<{ EngineAssociation?: unknown }>(uproject)).EngineAssociation ?? ''
  )
  if (!association)
    throw new Error(`${basename(uproject)} 没写 EngineAssociation，不知道用哪个引擎`)

  if (UnrealPathManagerUtil.isSourceBuildGUID(association)) {
    const resolved = await UnrealPathManagerUtil.resolveEngineVersionFromGUID(association)
    if (resolved?.engineRootPath) return resolved.engineRootPath
    throw new Error(`找不到自编译引擎 ${association} 装在哪`)
  }
  const engines = await UnrealPathManagerUtil.findUnrealEnginePaths()
  const hit = engines.find(
    (engine) =>
      engine.version === association ||
      engine.version.startsWith(`${association}.`) ||
      engine.name === `UE_${association}` ||
      basename(engine.rootPath) === `UE_${association}`
  )
  if (!hit) {
    throw new Error(
      `这台机器上没有 UE ${association}。装了的：${engines.map((e) => e.version || e.name).join('、') || '（无）'}`
    )
  }
  return hit.rootPath
}

function runUatPath(engineRoot: string): string {
  return process.platform === 'win32'
    ? join(engineRoot, 'Engine', 'Build', 'BatchFiles', 'RunUAT.bat')
    : join(engineRoot, 'Engine', 'Build', 'BatchFiles', 'RunUAT.sh')
}

/**
 * 起来就立刻降优先级。RunUAT.bat 真正派生编译、烘焙进程之前还有一段准备
 * （找 dotnet、检查环境），这点空档足够；之后派生的子进程都继承这个优先级。
 * 降不下来不影响打包本身，只是会和用户抢 CPU。
 */
export function lowerPriority(child: ChildProcess): void {
  if (!child.pid) return
  try {
    setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL)
  } catch {
    // 进程已经没了，或者没权限：随它
  }
}

/** 停止时连子孙一起杀：UAT 派生的编译、烘焙进程不跟着死的话会自己再跑半小时 */
export function killTree(child: ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' }).on(
      'error',
      () => undefined
    )
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM')
    } catch {
      child.kill('SIGTERM')
    }
  }
}

/**
 * 打包出来的可执行文件：Windows 是归档目录下第一到三层的 .exe，Mac 是 .app 包。
 * 找不到给 null
 */
async function findPackagedExe(archiveDir: string): Promise<string | null> {
  const mac = process.platform === 'darwin'
  const queue = [archiveDir]
  for (let depth = 0; depth < 3 && queue.length; depth++) {
    const next: string[] = []
    for (const dir of queue) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
        const full = join(dir, entry.name)
        if (/CrashReport/i.test(entry.name)) continue
        if (mac && entry.isDirectory() && /\.app$/i.test(entry.name)) return full
        if (!mac && entry.isFile() && /\.exe$/i.test(entry.name)) return full
        if (entry.isDirectory() && entry.name !== 'Engine') next.push(full)
      }
    }
    queue.splice(0, queue.length, ...next)
  }
  return null
}

// ── project_package ─────────────────────────────────────────────────────

const PACKAGE_TIMEOUT_MS = 3 * 60 * 60_000

const packageInput = z.object({
  project_path: z
    .string()
    .optional()
    .describe('工程目录（含 .uproject 的那一层）。省略 = 这一轮正在干的工程'),
  configuration: z
    .enum(['Development', 'Shipping'])
    .optional()
    .default('Development')
    .describe('Development 带日志和控制台，适合冒烟和排错；Shipping 是发行版'),
  maps: z
    .array(z.string())
    .optional()
    .describe(
      '只烘焙这几张地图（地图名或 /Game/ 路径），要带上启动地图和游戏里会切到的每一张。' +
        '省略 = 工程里所有地图，带着示例和测试地图时包体会大很多'
    ),
  output_dir: z.string().optional().describe('输出目录。省略 = <工程>/Saved/UEBoxBuilds/<时间>')
})

export interface PackageResult {
  success: boolean
  exe?: string
  outputDir: string
  logPath: string
  minutes: number
}

export function createPackageTool(): UnrealAgentTool<PackageResult> {
  return defineTool<typeof packageInput, PackageResult>({
    name: 'project_package',
    namespace: 'project',
    // 在工程目录里产出一大堆文件、跑几十分钟满载 —— 不是只读，但不碰工程本身的资产
    risk: 'mutating',
    concurrency: 'sequential',
    description:
      '把 UE 工程打包成可执行文件（UAT BuildCookRun：编译、烘焙、打包、归档）。' +
      '要几分钟到几十分钟，以较低的 CPU 优先级跑，不抢用户前台。' +
      '返回 exe 路径和完整日志路径；失败时附日志里的关键报错。' +
      '打包前先保存编辑器里的改动 —— 打包读的是磁盘上的资产。' +
      '默认烘焙工程里所有地图；要控制包体（itch.io 网页上传上限 1 GB）时用 maps 只打游戏真正用到的地图。' +
      '打包出来之后用 project_smoke_test 起一次看会不会崩。',
    input: packageInput,
    execute: async ({ project_path, configuration, output_dir, maps }, ctx) => {
      const cookMaps = normalizeMaps(maps)
      const projectDir = project_path ?? getTargetProjectPath()
      if (!projectDir)
        throw new Error('不知道打包哪个工程：这一轮没有连着的工程，请给 project_path')
      const uproject = await findUproject(projectDir)
      const engineRoot = await engineRootFor(uproject)
      const runUat = runUatPath(engineRoot)
      await fs.access(runUat).catch(() => {
        throw new Error(
          `引擎里没有 ${runUat}。安装版引擎要在 Epic 启动器里勾上「编辑器符号」以外的默认组件`
        )
      })

      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      // 相对路径按工程目录算；resolve 顺带去掉结尾的斜杠：带着它拼进命令行会把收尾的引号转义掉
      const outputDir = resolve(projectDir, output_dir ?? join('Saved', 'UEBoxBuilds', stamp))
      await fs.mkdir(outputDir, { recursive: true })
      const logPath = join(outputDir, 'uat.log')
      const args = buildUatArgs({
        uproject,
        configuration,
        archiveDir: outputDir,
        platform: process.platform === 'darwin' ? 'Mac' : 'Win64',
        maps: cookMaps
      })
      // 先把命令行拼出来：带了没法安全传递的字符就在起进程之前报错。只有 Windows 走 cmd
      const commandLine =
        process.platform === 'win32' ? `"${[runUat, ...args].map(quoteForCmd).join(' ')}"` : ''
      // 前面几步 await 的时候用户可能已经点了停止，这时候别再起一个跑几十分钟的进程
      ctx.signal?.throwIfAborted()
      const log = createWriteStream(logPath)
      // 写日志失败（磁盘满、目录不可写）不能变成未捕获异常 —— 那会把整个应用关掉
      log.on('error', () => undefined)

      const started = Date.now()
      ctx.report({ text: `开始打包 ${basename(uproject, '.uproject')}（${configuration}）` })

      // 不用 `start /BELOWNORMAL`：它起 .bat 走的是 `cmd /K`，跑完不退出，这里会一直等下去
      const child =
        process.platform === 'win32'
          ? spawn('cmd.exe', ['/d', '/s', '/c', commandLine], {
              windowsVerbatimArguments: true,
              windowsHide: true,
              cwd: dirname(runUat)
            })
          : spawn(runUat, args, { detached: true })
      lowerPriority(child)

      const tail: string[] = []
      let stage = ''
      const onData = (chunk: Buffer): void => {
        const text = chunk.toString('utf8')
        log.write(text)
        for (const line of text.split(/\r?\n/)) {
          if (!line.trim()) continue
          tail.push(line)
          if (tail.length > 400) tail.shift()
          const next = stageOf(line)
          if (next && next !== stage) {
            stage = next
            ctx.report({ text: `打包：${stage}` })
          }
        }
      }
      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)

      const onAbort = (): void => killTree(child)
      ctx.signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => killTree(child), PACKAGE_TIMEOUT_MS)

      const exitCode = await new Promise<number | null>((resolve) => {
        child.on('close', (code) => resolve(code))
        child.on('error', () => resolve(null))
      }).finally(() => {
        clearTimeout(timer)
        ctx.signal?.removeEventListener('abort', onAbort)
        log.end()
      })

      const minutes = Math.round((Date.now() - started) / 6_000) / 10
      const exe = exitCode === 0 ? await findPackagedExe(outputDir) : null
      const result: PackageResult = {
        success: exitCode === 0 && exe !== null,
        ...(exe ? { exe } : {}),
        outputDir,
        logPath,
        minutes
      }
      if (result.success) {
        return {
          text:
            `打包成功（${minutes} 分钟）。\nexe：${exe}\n输出目录：${outputDir}\n完整日志：${logPath}` +
            (cookMaps.length ? `\n烘焙的地图：${cookMaps.join('、')}` : ''),
          details: result
        }
      }
      const errors = keyErrors(tail)
      throw new Error(
        `打包失败（退出码 ${exitCode ?? '无'}，${minutes} 分钟，停在「${stage || '开始'}」）。` +
          `完整日志：${logPath}\n` +
          (errors.length
            ? `关键报错：\n${errors.join('\n')}`
            : `最后几行：\n${tail.slice(-20).join('\n')}`)
      )
    }
  })
}

// ── project_smoke_test ──────────────────────────────────────────────────

const smokeInput = z.object({
  exe_path: z.string().min(1).describe('project_package 返回的 exe'),
  seconds: z.number().int().min(10).max(180).optional().default(30).describe('跑多久')
})

export interface SmokeResult {
  passed: boolean
  ranSeconds: number
  exitedEarly: boolean
  exitCode: number | null
  fatal: string[]
  logPath: string | null
}

/** 打包版的日志在 `<exe 同级>/<工程名>/Saved/Logs/<工程名>.log` */
async function packagedLog(exe: string): Promise<string | null> {
  const project = basename(exe, '.exe').replace(/-Win64-(Shipping|Development|Test)$/i, '')
  const candidate = join(dirname(exe), project, 'Saved', 'Logs', `${project}.log`)
  return (await fs.access(candidate).then(
    () => true,
    () => false
  ))
    ? candidate
    : null
}

export function createSmokeTestTool(): UnrealAgentTool<SmokeResult> {
  return defineTool<typeof smokeInput, SmokeResult>({
    name: 'project_smoke_test',
    namespace: 'project',
    risk: 'mutating',
    concurrency: 'sequential',
    description:
      '把打包好的游戏窗口化起来跑一小段（默认 30 秒）再关掉，看它能不能启动、中途会不会崩。' +
      '判据：提前退出、日志里有致命错误都算不过。只证明「起得来、不崩」，不证明好不好玩。',
    input: smokeInput,
    execute: async ({ exe_path, seconds }, ctx) => {
      await fs.access(exe_path).catch(() => {
        throw new Error(`找不到 ${exe_path}`)
      })
      const started = Date.now()
      const child = spawn(exe_path, ['-windowed', '-ResX=1280', '-ResY=720', '-log'], {
        cwd: dirname(exe_path),
        stdio: 'ignore',
        detached: process.platform !== 'win32'
      })
      ctx.report({ text: `冒烟：已启动，跑 ${seconds} 秒` })

      const exit = new Promise<number | null>((resolve) => {
        child.on('exit', (code) => resolve(code))
        child.on('error', () => resolve(-1))
      })
      const onAbort = (): void => killTree(child)
      ctx.signal?.addEventListener('abort', onAbort, { once: true })
      const early = await Promise.race([
        exit.then((code) => ({ code })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), seconds * 1000))
      ])
      killTree(child)
      ctx.signal?.removeEventListener('abort', onAbort)

      const logPath = await packagedLog(exe_path)
      const fatal = logPath ? fatalLines(await fs.readFile(logPath, 'utf8').catch(() => '')) : []
      const result: SmokeResult = {
        passed: early === null && fatal.length === 0,
        ranSeconds: Math.round((Date.now() - started) / 1000),
        exitedEarly: early !== null,
        exitCode: early?.code ?? null,
        fatal,
        logPath
      }
      const lines = [
        result.passed
          ? `冒烟通过：跑满 ${result.ranSeconds} 秒没退出，日志里没有致命错误。`
          : `冒烟没过：${result.exitedEarly ? `第 ${result.ranSeconds} 秒就退出了（退出码 ${result.exitCode}）` : '跑满了时间'}` +
            `${fatal.length ? '，日志里有致命错误' : ''}。`,
        ...(fatal.length ? ['致命错误：', ...fatal] : []),
        logPath ? `游戏日志：${logPath}` : '没找到游戏日志（Shipping 版默认不写日志）'
      ]
      return { text: lines.join('\n'), details: result }
    }
  })
}

// ── project_zip_build ───────────────────────────────────────────────────
//
// 打包版要交出去（itch.io、jam、发给别人试玩）都是一个 zip。itch 网页上传上限 1 GB，
// Development 版里的 .pdb 动辄几百 MB、试玩用不上，压之前去掉。
// 压缩用系统自带的 tar（Windows 10 起自带 bsdtar，macOS 也是 bsdtar）：边读边写，
// 几个 GB 的包也不占内存；adm-zip 要把整个包读进内存。

/** itch.io 网页上传的上限。按十进制算，比 1 GiB 严一点，宁可提前提醒 */
export const ZIP_UPLOAD_LIMIT_BYTES = 1_000_000_000

/**
 * `队名_游戏名.zip`。只留 ASCII 字母、数字和连字符：jam 要求全英文，
 * 文件名里的中文、空格到了别人的解压软件里也常是乱码。
 */
export function zipFileName(teamName: string, gameName: string): string {
  const clean = (value: string, label: string): string => {
    const out = value
      .trim()
      .replace(/\s+/g, '')
      .replace(/[^A-Za-z0-9-]/g, '')
    if (!out) throw new Error(`${label}「${value}」去掉非英文字符后是空的，请给英文名`)
    return out
  }
  return `${clean(teamName, '队名')}_${clean(gameName, '游戏名')}.zip`
}

/** 把 `parent/folder` 整个压进 dest；zip 里第一层就是 folder。去掉调试符号 */
export function zipArgs(parent: string, folder: string, dest: string): string[] {
  return ['-a', '-c', '-f', dest, '--exclude', '*.pdb', '-C', parent, folder]
}

/**
 * 玩家要的那一整层目录（UE5 是 `Windows/`）。`project_package` 回的是这一层里的启动器 exe，
 * 但人手里常是 `Windows/<工程>/Binaries/Win64/` 下的那个真 exe —— 只压它所在的目录，
 * 压出来的包缺 Content，起不来。
 */
export function packageRootOf(exePath: string): string {
  const dir = dirname(exePath)
  const binaries = dirname(dir)
  if (basename(binaries).toLowerCase() === 'binaries') return dirname(dirname(binaries))
  return dir
}

/** child 是不是 parent 自己或它里面的路径 */
export function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(2)} GB`
  return `${Math.max(1, Math.round(bytes / 1_000_000))} MB`
}

const zipInput = z.object({
  exe_path: z.string().min(1).describe('project_package 返回的 exe'),
  team_name: z.string().min(1).describe('队名，英文'),
  game_name: z.string().min(1).describe('游戏名，英文'),
  output_dir: z.string().optional().describe('zip 放哪。省略 = 打包输出目录')
})

export interface ZipResult {
  zipPath: string
  bytes: number
  overLimit: boolean
}

export function createZipBuildTool(): UnrealAgentTool<ZipResult> {
  return defineTool<typeof zipInput, ZipResult>({
    name: 'project_zip_build',
    namespace: 'project',
    risk: 'mutating',
    concurrency: 'sequential',
    description:
      '把 project_package 打出来的游戏压成「队名_游戏名.zip」，去掉 .pdb 调试符号，并报告大小；' +
      '超过 1 GB（itch.io 网页上传上限）时会提示。提交 jam、上传 itch.io、发给别人试玩前用。',
    input: zipInput,
    execute: async ({ exe_path, team_name, game_name, output_dir }, ctx) => {
      if (process.platform !== 'win32' && process.platform !== 'darwin') {
        throw new Error('只支持 Windows 和 macOS 上压缩')
      }
      const name = zipFileName(team_name, game_name)
      await fs.access(exe_path).catch(() => {
        throw new Error(`找不到 ${exe_path}`)
      })
      const buildDir = packageRootOf(resolve(exe_path))
      const parent = dirname(buildDir)
      const destDir = resolve(output_dir ?? parent)
      if (isInside(buildDir, destDir)) {
        throw new Error(
          `output_dir 不能放在要压缩的目录里（${buildDir}）：zip 会把自己也压进去。换一个目录，或者省略`
        )
      }
      await fs.mkdir(destDir, { recursive: true })
      const zipPath = join(destDir, name)
      await fs.rm(zipPath, { force: true })

      ctx.report({ text: `压缩 ${name}` })
      const tar =
        process.platform === 'win32'
          ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
          : '/usr/bin/tar'
      await fs.access(tar).catch(() => {
        throw new Error(
          `系统里没有 ${tar}（Windows 10 1803 之前的系统不带）。` +
            `请在资源管理器里右键「${buildDir}」→ 发送到 → 压缩(zipped)文件夹，压好后改名为 ${name}`
        )
      })
      const child = spawn(tar, zipArgs(parent, basename(buildDir), zipPath), {
        windowsHide: true,
        stdio: ['ignore', 'ignore', 'pipe']
      })
      lowerPriority(child)
      let stderr = ''
      child.stderr?.on('data', (chunk: Buffer) => {
        stderr = (stderr + chunk.toString('utf8')).slice(-2000)
      })
      const onAbort = (): void => killTree(child)
      ctx.signal?.addEventListener('abort', onAbort, { once: true })
      const code = await new Promise<number | null>((done) => {
        child.on('close', (exit) => done(exit))
        child.on('error', (error) => {
          stderr += String(error)
          done(null)
        })
      }).finally(() => ctx.signal?.removeEventListener('abort', onAbort))

      const bytes = await fs.stat(zipPath).then(
        (stat) => stat.size,
        () => 0
      )
      if (code !== 0 || bytes === 0) {
        await fs.rm(zipPath, { force: true })
        throw new Error(`压缩失败（退出码 ${code ?? '无'}）：${stderr.trim() || '没有输出'}`)
      }
      const overLimit = bytes > ZIP_UPLOAD_LIMIT_BYTES
      const text = overLimit
        ? `zip 超过 1 GB：${formatBytes(bytes)}，itch.io 网页传不上去。` +
          `用 itch 的 butler 命令行上传，或者减小包体（删没用到的地图和资产、降纹理尺寸）后重新打包。\n${zipPath}`
        : `zip 已生成：${formatBytes(bytes)}，在 1 GB 以内。\n${zipPath}`
      return { text, details: { zipPath, bytes, overLimit } }
    }
  })
}

export const projectPackageTools = (): UnrealAgentTool<never>[] =>
  [
    createPackageTool(),
    createSmokeTestTool(),
    createZipBuildTool(),
    createFindNonEnglishTextTool()
  ] as unknown as UnrealAgentTool<never>[]
