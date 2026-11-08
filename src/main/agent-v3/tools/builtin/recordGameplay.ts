/**
 * `record_gameplay_video` —— 录一段玩法视频。
 *
 * jam 提交、商店页、发给别人看都要一段 30–60 秒的实机视频。两种来源：
 *
 * - 给了 `exe_path`：起打包版（窗口化 1280×720），录它的窗口，录完关掉。录的时候人去玩。
 * - 没给：录正在跑 PIE 的那个窗口。在同一条消息里同时调 `ue_autoplay`，机器人玩、这里录；
 *   或者让用户自己在编辑器里点 Play 去玩。PIE 开在新窗口里时只录游戏画面，开在关卡视口里
 *   录的是整个编辑器窗口。
 *
 * 录制用 Chromium 自带的窗口采集，不依赖 FFmpeg；装了 FFmpeg 就顺手转成 MP4（见 windowRecorder.ts）。
 */

import { spawn, type ChildProcess } from 'child_process'
import { promises as fs } from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { z } from 'zod'

import { defineTool, type UnrealAgentTool } from '../defineTool'
import { getTargetProjectPath } from '../../core/projectTargetContext'
import { killTree } from './projectPackage'
import type { WindowSource } from '../../../services/windowRecorder'

/**
 * 选要录的窗口。
 *
 * - 点了名：名字里含这段文字的第一个
 * - 起了打包版：启动后才出现的窗口里，最后出现的那个（UE 打包版先弹启动画面，再开游戏窗口）
 * - 录 PIE：新窗口模式的 PIE（标题带「Preview [NetMode」）优先，其次是这个工程的编辑器窗口
 */
export function pickWindow(
  sources: WindowSource[],
  options: { before?: WindowSource[]; titleHint?: string; projectName?: string }
): WindowSource | null {
  if (options.titleHint) {
    const hint = options.titleHint.toLowerCase()
    return sources.find((s) => s.name.toLowerCase().includes(hint)) ?? null
  }
  if (options.before) {
    const old = new Set(options.before.map((s) => s.id))
    const fresh = sources.filter((s) => !old.has(s.id) && s.name.trim())
    return fresh[fresh.length - 1] ?? null
  }
  const pie = sources.find((s) => /Preview \[NetMode/i.test(s.name))
  if (pie) return pie
  const editors = sources.filter((s) => /Unreal Editor/i.test(s.name))
  const project = options.projectName?.toLowerCase()
  return (
    (project && editors.find((s) => s.name.toLowerCase().includes(project))) || editors[0] || null
  )
}

/** webm → MP4（H.264，yuv420p，宽高取偶数 —— 不取偶 libx264 直接报错） */
export function mp4Args(input: string, output: string): string[] {
  return [
    '-y',
    '-i',
    input,
    '-vf',
    'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-an',
    output
  ]
}

const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((done, fail) => {
    const timer = setTimeout(done, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        fail(new Error('已停止'))
      },
      { once: true }
    )
  })

function runFfmpeg(ffmpeg: string, args: string[]): Promise<void> {
  return new Promise((done, fail) => {
    const child = spawn(ffmpeg, args, { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let tail = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      tail = (tail + chunk.toString('utf8')).slice(-1500)
    })
    child.on('error', fail)
    child.on('close', (code) =>
      code === 0 ? done() : fail(new Error(`FFmpeg 退出码 ${code}：${tail}`))
    )
  })
}

const input = z.object({
  seconds: z.number().min(5).max(120).optional().default(45).describe('录多久，默认 45 秒'),
  exe_path: z
    .string()
    .optional()
    .describe('打包版的 exe（project_package 的结果）。给了就起它来录；不给就录正在跑 PIE 的窗口'),
  start_delay_seconds: z
    .number()
    .min(0)
    .max(60)
    .optional()
    .default(0)
    .describe('找到窗口后等几秒再开录，跳过加载画面'),
  window_title: z.string().optional().describe('只录标题里含这段文字的窗口。一般不用给'),
  output_dir: z
    .string()
    .optional()
    .describe('视频放哪。省略 = <工程>/Saved/UEBoxVideos，没有工程时放系统「视频」文件夹')
})

export interface RecordResult {
  path: string
  bytes: number
  format: 'mp4' | 'webm'
  window: string
}

export function createRecordGameplayTool(): UnrealAgentTool<RecordResult> {
  return defineTool<typeof input, RecordResult>({
    name: 'record_gameplay_video',
    namespace: 'project',
    risk: 'mutating',
    description:
      '录一段玩法视频（jam 提交、商店页用）。给 exe_path 就起打包版录它的窗口，人在录的时候去玩；' +
      '不给就录正在跑 PIE 的窗口 —— 在同一条消息里同时调 ue_autoplay 让机器人玩，或者请用户自己点 Play 去玩。' +
      '装了 FFmpeg 输出 MP4，没装输出 webm（B 站、YouTube 都能直接传）。' +
      '视频开头 5 秒就要看到玩法：有加载画面就用 start_delay_seconds 跳过。',
    input,
    execute: async (args, ctx) => {
      const { listWindowSources, recordWindow } = await import('../../../services/windowRecorder')
      const projectDir = getTargetProjectPath()
      let game: ChildProcess | null = null
      try {
        let target: WindowSource | null
        if (args.exe_path) {
          await fs.access(args.exe_path).catch(() => {
            throw new Error(`找不到 ${args.exe_path}`)
          })
          const before = await listWindowSources()
          game = spawn(args.exe_path, ['-windowed', '-ResX=1280', '-ResY=720'], {
            cwd: dirname(args.exe_path),
            stdio: 'ignore',
            detached: process.platform !== 'win32'
          })
          ctx.report({ text: '已启动打包版，等游戏窗口出来' })
          target = null
          for (let waited = 0; waited < 90 && !target; waited++) {
            await sleep(1000, ctx.signal)
            if (game.exitCode !== null)
              throw new Error(`游戏启动后就退出了（退出码 ${game.exitCode}）`)
            target = pickWindow(await listWindowSources(), { before, titleHint: args.window_title })
          }
          if (!target) throw new Error('等了 90 秒没看到游戏窗口')
          // 启动画面之后才是游戏窗口：再等一会儿重新挑一次
          await sleep(4000, ctx.signal)
          target =
            pickWindow(await listWindowSources(), { before, titleHint: args.window_title }) ??
            target
        } else {
          const sources = await listWindowSources()
          target = pickWindow(sources, {
            titleHint: args.window_title,
            projectName: projectDir ? basename(projectDir) : undefined
          })
          if (!target) {
            throw new Error(
              args.window_title
                ? `没有标题含「${args.window_title}」的窗口。现有窗口：${sources.map((s) => s.name).join('、')}`
                : '没找到虚幻编辑器窗口。先打开工程并开始 PIE，或者给 exe_path 录打包版'
            )
          }
        }

        if (args.start_delay_seconds > 0) await sleep(args.start_delay_seconds * 1000, ctx.signal)

        const dir = resolve(
          args.output_dir ??
            (projectDir
              ? join(projectDir, 'Saved', 'UEBoxVideos')
              : join((await import('electron')).app.getPath('videos'), 'UEBox'))
        )
        await fs.mkdir(dir, { recursive: true })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const webm = join(dir, `gameplay-${stamp}.webm`)
        ctx.report({ text: `开始录制「${target.name}」，${args.seconds} 秒` })
        await recordWindow({
          sourceId: target.id,
          seconds: args.seconds,
          output: webm,
          signal: ctx.signal
        })
        if (game) killTree(game)

        let path = webm
        let format: RecordResult['format'] = 'webm'
        let note = '没装 FFmpeg，输出的是 webm（B 站、YouTube 都能直接传）。'
        const { findFFmpeg } = await import('../../../services/ffmpegPath')
        const ffmpeg = await findFFmpeg()
        if (ffmpeg) {
          ctx.report({ text: '转成 MP4' })
          const mp4 = webm.replace(/\.webm$/, '.mp4')
          try {
            await runFfmpeg(ffmpeg, mp4Args(webm, mp4))
            await fs.rm(webm, { force: true })
            path = mp4
            format = 'mp4'
            note = ''
          } catch (error) {
            note = `转 MP4 失败，保留 webm：${error instanceof Error ? error.message : String(error)}`
          }
        }
        const bytes = (await fs.stat(path)).size
        return {
          text: [
            `录好了：${path}（${Math.round(bytes / 100_000) / 10} MB，录的窗口：${target.name}）`,
            note
          ]
            .filter(Boolean)
            .join('\n'),
          details: { path, bytes, format, window: target.name }
        }
      } finally {
        if (game) killTree(game)
      }
    }
  })
}
