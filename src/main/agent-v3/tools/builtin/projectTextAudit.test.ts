/** @vitest-environment node */
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import {
  auditProjectText,
  cjkIniLines,
  cjkStringLiterals,
  findCjkFStrings,
  formatTextAudit
} from './projectTextAudit'

/** 按引擎的格式写一个 FString：ASCII 用正长度 + 单字节，其余用负长度 + UTF-16LE */
function fstring(text: string): Buffer {
  if ([...text].every((c) => c.charCodeAt(0) < 0x80)) {
    const len = Buffer.alloc(4)
    len.writeInt32LE(text.length + 1)
    return Buffer.concat([len, Buffer.from(text + '\0', 'latin1')])
  }
  const len = Buffer.alloc(4)
  len.writeInt32LE(-(text.length + 1))
  return Buffer.concat([len, Buffer.from(text + '\0', 'utf16le')])
}

/** FText（Base 历史）：命名空间、32 位十六进制 key、源字符串 */
function ftext(source: string): Buffer {
  return Buffer.concat([fstring(''), fstring('0123456789ABCDEF0123456789ABCDEF'), fstring(source)])
}

describe('从资产二进制里找中文', () => {
  it('FText 的源字符串记为玩家看得到的文字', () => {
    const buf = Buffer.concat([Buffer.alloc(16, 7), ftext('开始游戏'), Buffer.alloc(8)])
    expect(findCjkFStrings(buf)).toEqual([{ text: '开始游戏', isText: true }])
  })

  it('普通 FString（资产名、参数名）也找，但不算 Text', () => {
    const buf = Buffer.concat([fstring('粗糙度'), Buffer.alloc(4)])
    expect(findCjkFStrings(buf)).toEqual([{ text: '粗糙度', isText: false }])
  })

  it('二进制恰好凑出「负长度 + 结尾 0」时不算：生僻字、全角怪字符、混 Latin-1', () => {
    const fake = (codes: number[]): Buffer => {
      const len = Buffer.alloc(4)
      len.writeInt32LE(-(codes.length + 1))
      const body = Buffer.alloc(codes.length * 2 + 2)
      codes.forEach((c, k) => body.writeUInt16LE(c, k * 2))
      return Buffer.concat([len, body])
    }
    // 「￿賾」「Ó销」「曈礀枴」都是真机地图里凑出来的
    const buf = Buffer.concat([
      fake([0xffff, 0x8cfe]),
      fake([0xd3, 0x9500]),
      fake([0x66c8, 0x7900, 0x67b4])
    ])
    expect(findCjkFStrings(buf)).toEqual([])
  })

  it('没有中文的 FString 不报', () => {
    expect(findCjkFStrings(Buffer.concat([ftext('Start Game'), fstring('Roughness')]))).toEqual([])
  })
})

describe('源码和配置', () => {
  it('只报字符串字面量，注释里的中文不算', () => {
    const src =
      '// 中文注释\nUE_LOG(LogTemp, Log, TEXT("开始"));\n/* 块注释 中文 */\nFString A = "Start";'
    expect(cjkStringLiterals(src)).toEqual(['开始'])
  })

  it('ini 跳过注释行', () => {
    expect(
      cjkIniLines('; 注释\n[/Script/EngineSettings.GeneralProjectSettings]\nProjectName=霓虹堡垒\n')
    ).toEqual(['ProjectName=霓虹堡垒'])
  })
})

describe('扫一个工程', () => {
  it('分出玩家看得到的和编辑器内的；跳过 Saved、Intermediate、插件自己的目录；本地化只计数', async () => {
    const root = await mkdtemp(join(tmpdir(), 'uebox-text-'))
    try {
      await mkdir(join(root, 'Content', 'UI'), { recursive: true })
      await mkdir(join(root, 'Content', 'Materials'), { recursive: true })
      await mkdir(join(root, 'Content', 'Localization', 'Game', 'zh-Hans'), { recursive: true })
      await mkdir(join(root, 'Saved', 'Autosaves'), { recursive: true })
      await mkdir(join(root, 'Config'), { recursive: true })
      await writeFile(
        join(root, 'Content', 'UI', 'WBP_Menu.uasset'),
        Buffer.concat([fstring('事件图表'), ftext('开始游戏')])
      )
      await writeFile(join(root, 'Content', 'Materials', 'M_Rock.uasset'), fstring('粗糙度'))
      await writeFile(
        join(root, 'Content', 'Localization', 'Game', 'zh-Hans', 'Game.po'),
        'msgstr "开始"'
      )
      await writeFile(join(root, 'Saved', 'Autosaves', 'WBP_Menu.uasset'), ftext('开始游戏'))
      await writeFile(join(root, 'Config', 'DefaultGame.ini'), 'ProjectName=Neon Fort\n')

      const { hits, scanned } = await auditProjectText(root)
      expect(scanned).toBe(4)
      const menu = hits.find((h) => h.file === 'Content/UI/WBP_Menu.uasset')
      expect(menu).toMatchObject({ kind: 'asset', count: 2, textCount: 1, samples: ['开始游戏'] })
      expect(hits.find((h) => h.file === 'Content/Materials/M_Rock.uasset')?.textCount).toBe(0)
      expect(hits.find((h) => h.kind === 'localization')?.samples).toEqual([])
      expect(hits.some((h) => h.file.startsWith('Saved'))).toBe(false)

      const text = formatTextAudit(hits, scanned, 10)
      expect(text).toContain('1 个里有玩家多半看得到的文字')
      expect(text.indexOf('WBP_Menu')).toBeLessThan(text.indexOf('M_Rock'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('全是英文时直说没有', () => {
    expect(formatTextAudit([], 12, 10)).toMatch(/^扫了 12 个文件.*没有中日韩文字/)
  })
})
