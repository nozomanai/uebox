/** @vitest-environment node */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../utils/UnrealPathManager', () => ({ default: {} }))

import { mkdir, mkdtemp, rm, stat, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import AdmZip from 'adm-zip'

import {
  buildUatArgs,
  createZipBuildTool,
  fatalLines,
  formatBytes,
  keyErrors,
  quoteForCmd,
  stageOf,
  zipArgs,
  zipFileName
} from './projectPackage'

/**
 * 打包一次半小时，参数拼错、日志读错都要到最后才发现。这几个纯函数先钉住。
 */

describe('UAT 参数', () => {
  it('BuildCookRun 全流程：编译、烘焙、打包、归档到指定目录', () => {
    const args = buildUatArgs({
      uproject: 'I:/UE Project/TD/TD.uproject',
      configuration: 'Development',
      archiveDir: 'I:/UE Project/TD/Saved/UEBoxBuilds/x',
      platform: 'Win64'
    })
    expect(args[0]).toBe('BuildCookRun')
    for (const flag of ['-build', '-cook', '-stage', '-pak', '-archive', '-unattended', '-noP4']) {
      expect(args).toContain(flag)
    }
    expect(args).toContain('-clientconfig=Development')
    expect(args).toContain('-archivedirectory=I:/UE Project/TD/Saved/UEBoxBuilds/x')
  })

  it('路径有空格：-key=值 只包值，别的整体包', () => {
    expect(quoteForCmd('-project=I:/UE Project/TD.uproject')).toBe(
      '-project="I:/UE Project/TD.uproject"'
    )
    expect(quoteForCmd('C:/Program Files/Epic/RunUAT.bat')).toBe(
      '"C:/Program Files/Epic/RunUAT.bat"'
    )
    expect(quoteForCmd('-cook')).toBe('-cook')
  })

  it('cmd 的命令符号一律包进引号 —— R&D 目录不会被拆成两条命令', () => {
    expect(quoteForCmd('-project=D:\\R&D\\TD\\TD.uproject')).toBe(
      '-project="D:\\R&D\\TD\\TD.uproject"'
    )
    expect(quoteForCmd('-archivedirectory=C:\\tmp\\x&calc')).toBe(
      '-archivedirectory="C:\\tmp\\x&calc"'
    )
    expect(quoteForCmd('D:\\a^b|c')).toBe('"D:\\a^b|c"')
  })

  it('引号里也挡不住的 % 和 " 直接拒绝；结尾反斜杠去掉，免得吞掉收尾引号', () => {
    expect(() => quoteForCmd('-archivedirectory=C:\\%PATH%')).toThrow()
    expect(() => quoteForCmd('C:\\a"b')).toThrow()
    expect(quoteForCmd('-archivedirectory=D:\\My Builds\\')).toBe(
      '-archivedirectory="D:\\My Builds"'
    )
  })
})

describe('读 UAT 输出', () => {
  it('认得出各个阶段', () => {
    expect(stageOf('********** COOK COMMAND STARTED **********')).toBe('烘焙资源')
    expect(stageOf('BUILD SUCCESSFUL')).toBe('完成')
    expect(stageOf('LogCook: Display: Cooked packages 120')).toBeNull()
  })

  it('关键报错：去重、跳过「0 个错误」这类总结行', () => {
    const errors = keyErrors([
      'LogCook: Error: Missing asset /Game/Hero',
      '[2026.09.25-12.00.01] LogCook: Error: Missing asset /Game/Hero',
      'Success - 0 error(s), 3 warning(s)',
      'ERROR: UnrealBuildTool failed with exit code 6'
    ])
    expect(errors).toEqual([
      'LogCook: Error: Missing asset /Game/Hero',
      'ERROR: UnrealBuildTool failed with exit code 6'
    ])
  })
})

describe('读打包版游戏日志', () => {
  it('挑出致命错误那几行', () => {
    const log = [
      'LogInit: Display: Starting Game.',
      'LogWindows: Error: Fatal error: [File:Unknown] Access violation',
      'LogTemp: Warning: something minor'
    ].join('\n')
    expect(fatalLines(log)).toEqual([
      'LogWindows: Error: Fatal error: [File:Unknown] Access violation'
    ])
    expect(fatalLines('LogInit: all good')).toEqual([])
  })
})

describe('打包版压 zip', () => {
  it('文件名只留英文字母、数字、连字符', () => {
    expect(zipFileName('Pixel Crew', 'Moon-Runner!')).toBe('PixelCrew_Moon-Runner.zip')
    expect(() => zipFileName('像素小队', 'Game')).toThrow(/英文/)
  })

  it('tar 参数：zip 格式、去掉 pdb、第一层是 exe 所在目录', () => {
    expect(zipArgs('D:/b', 'Windows', 'D:/b/T_G.zip')).toEqual([
      '-a',
      '-c',
      '-f',
      'D:/b/T_G.zip',
      '--exclude',
      '*.pdb',
      '-C',
      'D:/b',
      'Windows'
    ])
  })

  it('大小按十进制 GB 报', () => {
    expect(formatBytes(1_230_000_000)).toBe('1.23 GB')
    expect(formatBytes(5_400_000)).toBe('5 MB')
  })

  it.runIf(process.platform === 'win32' || process.platform === 'darwin')(
    '真压一次：zip 里有 exe，没有 pdb，回执报的是磁盘上的大小',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'uebox-zip-'))
      try {
        const build = join(root, 'Windows')
        await mkdir(join(build, 'Game', 'Binaries'), { recursive: true })
        await writeFile(join(build, 'Game.exe'), 'exe')
        await writeFile(join(build, 'Game', 'Binaries', 'Game.pdb'), 'x'.repeat(10_000))
        const tool = createZipBuildTool()
        const result = await tool.execute('call-1', {
          exe_path: join(build, 'Game.exe'),
          team_name: 'Team',
          game_name: 'Game'
        })
        const zipPath = join(root, 'Team_Game.zip')
        expect(result.details.zipPath).toBe(zipPath)
        expect(result.details.bytes).toBe((await stat(zipPath)).size)
        expect(result.details.overLimit).toBe(false)
        const names = new AdmZip(zipPath).getEntries().map((e) => e.entryName)
        expect(names.some((n) => n.endsWith('Game.exe'))).toBe(true)
        expect(names.some((n) => n.endsWith('.pdb'))).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  )
})
