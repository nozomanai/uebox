/**
 * `project_find_non_english_text` —— 找出工程里还没换成英文的文字。
 *
 * ## 为什么要有它
 *
 * 面向英文评委、英文玩家交付（Epic 的 jam 明确要求游戏内文字、语音全英文）时，
 * 最常漏的是散在各处的中文：UMG 控件的默认文字、DataTable 的格子、蓝图里的 Text 字面量、
 * 字幕、窗口标题、C++ 里的 `TEXT("…")`。一个个资产打开看不现实，让模型现写 Python
 * 遍历控件树又依赖每个版本的 Python 暴露面。
 *
 * ## 直接读磁盘上的资产
 *
 * 编辑器存的 .uasset / .umap 里，含非 ASCII 字符的 FString（FText 的源字符串、
 * 名字表里的 FName 都是）一律按 UTF-16LE 存：先一个负的 int32 长度（含结尾的 0），
 * 再是字符，最后两个 0 字节。按这个格式逐位匹配，只认长度和结尾都对得上的 ——
 * 纹理、网格的二进制数据里随便两个字节就能「解」成一个汉字，不校验长度会全是误报。
 *
 * 好处：不连编辑器也能跑，UE 5.0–5.8 一样，几百 MB 的工程几秒扫完。
 * 局限：查到的是「这个资产里有中文」，不是「中文在哪个控件上」。蓝图注释、
 * 变量说明这类只在编辑器里看得到的文字也会被列出来，要回编辑器确认、用对应的工具改。
 * 语音内容本身查不了，只能查到中文的字幕和音频资产名。
 */

import { promises as fs } from 'fs'
import { extname, join, relative, sep } from 'path'
import { z } from 'zod'

import { defineTool, type UnrealAgentTool } from '../defineTool'
import { getTargetProjectPath } from '../../core/projectTargetContext'
import { decodeUeText } from '../../../utils/ueTextFile'

/** 中日韩文字、假名、谚文、全角标点 */
const CJK = /[\u3000-\u303f\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uff00-\uffef]/

/**
 * 正常文字里会出现的字符。纹理、网格、关卡里的二进制数据偶尔恰好凑成「负长度 + 结尾两个 0」，
 * 解出来是 `￿賾`、`Ó销` 这种东西 —— 实测一张风格化地图能凑出四十多条。
 */
const PLAIN_TEXT =
  /^[\t\n\r\x20-\x7e\u2010-\u2027\u3000-\u303f\u3040-\u30ff\u4e00-\u9fff\uff01-\uff5e]+$/
const HAN = /[\u4e00-\u9fff]/g

/** 一个字符串最多这么长才算（超长的多半是误匹配，真文字也没法在回执里展示） */
const MAX_CHARS = 2000

/**
 * GB2312 的 6763 个常用汉字。没有 FText 结构佐证的字符串，汉字必须全在这里面才算 ——
 * 二进制凑出来的「汉字」绝大多数是生僻字。运行时没有 GB 解码器（裁剪过 ICU）时返回 null，
 * 只剩字符集那一道筛。
 */
let commonHan: Set<string> | null | undefined
function commonHanSet(): Set<string> | null {
  if (commonHan !== undefined) return commonHan
  try {
    const decoder = new TextDecoder('gb18030')
    const set = new Set<string>()
    for (let hi = 0xb0; hi <= 0xf7; hi++) {
      for (let lo = 0xa1; lo <= 0xfe; lo++) {
        const ch = decoder.decode(new Uint8Array([hi, lo]))
        if (/^[\u4e00-\u9fff]$/.test(ch)) set.add(ch)
      }
    }
    commonHan = set.size > 6000 ? set : null
  } catch {
    commonHan = null
  }
  return commonHan
}

/**
 * 前面紧挨着一个 32 位十六进制的 FString（int32 33 + 32 个字符 + 结尾 0）——
 * 这是 FText 的 key。FText 按「命名空间、key、源字符串」的顺序存，
 * 控件文字、DataTable 的 Text 列、蓝图 Text 字面量、字幕都是这个形状。
 */
function followsTextKey(buf: Buffer, i: number): boolean {
  const at = i - 37
  if (at < 0 || buf.readInt32LE(at) !== 33 || buf[i - 1] !== 0) return false
  for (let k = at + 4; k < i - 1; k++) {
    const c = buf[k]
    const hex = (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66)
    if (!hex) return false
  }
  return true
}

/** 真文字里不会有的字符：除制表、换行以外的控制字符，代理项，U+FFF0 以后的特殊码位 */
function hasJunkChar(text: string): boolean {
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k)
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return true
    if ((c >= 0xd800 && c <= 0xdfff) || c >= 0xfff0) return true
  }
  return false
}

function looksLikeText(text: string, isTextValue: boolean): boolean {
  if (!CJK.test(text)) return false
  if (hasJunkChar(text)) return false
  if (isTextValue) return true
  if (!PLAIN_TEXT.test(text)) return false
  const han = text.match(HAN) ?? []
  const common = commonHanSet()
  return common ? han.every((ch) => common.has(ch)) : true
}

/**
 * 从一份 .uasset / .umap 里捞出所有含中日韩文字的 FString。
 * 去重，保持出现顺序。
 */
export interface FoundString {
  text: string
  /** 带 FText 的 key：控件文字、Text 字面量、字幕这类玩家多半看得到的文字 */
  isText: boolean
}

export function findCjkFStrings(buf: Buffer): FoundString[] {
  const out = new Map<string, boolean>()
  const end = buf.length - 6
  for (let i = 0; i <= end; i++) {
    // 负长度的高两个字节必然是 0xFFFF：先用它筛，绝大多数位置一步就跳过
    if (buf[i + 3] !== 0xff || buf[i + 2] !== 0xff) continue
    const len = -buf.readInt32LE(i)
    if (len < 2 || len > MAX_CHARS) continue
    const start = i + 4
    const stop = start + (len - 1) * 2
    if (stop + 2 > buf.length) continue
    if (buf[stop] !== 0 || buf[stop + 1] !== 0) continue
    const text = buf.toString('utf16le', start, stop)
    const isText = followsTextKey(buf, i)
    if (!looksLikeText(text, isText)) continue
    out.set(text, (out.get(text) ?? false) || isText)
    i = stop + 1
  }
  return [...out].map(([text, isText]) => ({ text, isText }))
}

/** C++ / C# 源码里带中日韩文字的字符串字面量。注释里的中文不算 —— 它不进游戏 */
export function cjkStringLiterals(source: string): string[] {
  const out = new Set<string>()
  const noComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  for (const match of noComments.matchAll(/"((?:[^"\\\n]|\\.)*)"/g)) {
    if (CJK.test(match[1])) out.add(match[1])
  }
  return [...out]
}

/** ini 里带中日韩文字的行（窗口标题、工程显示名都在这） */
export function cjkIniLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(';') && CJK.test(line))
}

export type TextHitKind = 'asset' | 'map' | 'config' | 'source' | 'localization'

export interface TextHit {
  file: string
  kind: TextHitKind
  /** 这个文件里一共几条 */
  count: number
  /** 其中有 FText 结构的几条（资产、关卡才有；配置和源码按全部都是算） */
  textCount: number
  /** 前几条原文 */
  samples: string[]
}

/** 不进包、或者不归游戏管的目录 */
const SKIP_DIRS = new Set([
  'Saved',
  'Intermediate',
  'Binaries',
  'DerivedDataCache',
  '.git',
  '.vs',
  'node_modules',
  'UnrealAgentLink'
])

function kindOf(rel: string): TextHitKind | null {
  const ext = extname(rel).toLowerCase()
  const parts = rel.split(sep)
  if (parts.includes('Localization')) {
    return ['.po', '.archive', '.manifest', '.locres'].includes(ext) ? 'localization' : null
  }
  if (ext === '.uasset') return 'asset'
  if (ext === '.umap') return 'map'
  if (ext === '.ini' && parts.includes('Config')) return 'config'
  if (['.cpp', '.h', '.cs'].includes(ext) && parts.includes('Source')) return 'source'
  return null
}

async function* walk(dir: string, root: string): AsyncGenerator<string> {
  for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue
      yield* walk(join(dir, entry.name), root)
    } else if (entry.isFile()) {
      yield relative(root, join(dir, entry.name))
    }
  }
}

/** 扫一个工程。localization 只计数不取样：.po 里的中文是给中文玩家的，本来就该在 */
export async function auditProjectText(
  projectDir: string,
  signal?: AbortSignal
): Promise<{ hits: TextHit[]; scanned: number }> {
  const hits: TextHit[] = []
  let scanned = 0
  for await (const rel of walk(projectDir, projectDir)) {
    signal?.throwIfAborted()
    const kind = kindOf(rel)
    if (!kind) continue
    scanned++
    const buf = await fs.readFile(join(projectDir, rel)).catch(() => null)
    if (!buf) continue
    const asText = (list: string[]): FoundString[] => list.map((text) => ({ text, isText: true }))
    let found: FoundString[]
    if (kind === 'asset' || kind === 'map') found = findCjkFStrings(buf)
    else if (kind === 'config') found = asText(cjkIniLines(decodeUeText(buf)))
    else if (kind === 'source') found = asText(cjkStringLiterals(decodeUeText(buf)))
    // .po / .archive 是文本，.locres 是二进制
    else found = CJK.test(buf.toString('utf8')) || findCjkFStrings(buf).length ? asText(['…']) : []
    if (!found.length) continue
    const texts = found.filter((f) => f.isText)
    // 有 Text 的只拿 Text 当样本：同一个资产里的「事件图表」「默认」不用看
    const shown = texts.length ? texts : found
    hits.push({
      file: rel.split(sep).join('/'),
      kind,
      count: found.length,
      textCount: texts.length,
      samples: kind === 'localization' ? [] : shown.slice(0, 5).map((f) => f.text.slice(0, 120))
    })
  }
  return { hits, scanned }
}

const KIND_LABEL: Record<TextHitKind, string> = {
  asset: '资产',
  map: '关卡',
  config: '配置',
  source: '源码字符串',
  localization: '本地化文件'
}

export function formatTextAudit(hits: TextHit[], scanned: number, limit: number): string {
  const real = hits.filter((hit) => hit.kind !== 'localization')
  const loc = hits.filter((hit) => hit.kind === 'localization')
  if (!real.length) {
    return (
      `扫了 ${scanned} 个文件，资产、关卡、配置、源码字符串里没有中日韩文字。` +
      (loc.length ? `\n另有 ${loc.length} 个非英文本地化文件，只在游戏语言不是英文时显示。` : '')
    )
  }
  const visible = real.filter((hit) => hit.textCount > 0)
  const other = real.filter((hit) => hit.textCount === 0)
  const lines = [
    `扫了 ${scanned} 个文件，${real.length} 个含中日韩文字：` +
      `${visible.length} 个里有玩家多半看得到的文字，${other.length} 个只有名字和编辑器内的说明。`
  ]
  const list = (hits: TextHit[], max: number): void => {
    for (const hit of hits.slice(0, max)) {
      const tag =
        hit.kind === 'asset' || hit.kind === 'map' ? `，其中 Text ${hit.textCount} 条` : ''
      lines.push(`- [${KIND_LABEL[hit.kind]}] ${hit.file}（${hit.count} 条${tag}）`)
      for (const sample of hit.samples) lines.push(`    「${sample}」`)
    }
    if (hits.length > max) lines.push(`…另有 ${hits.length - max} 个文件没列出，调大 limit 再看`)
  }
  if (visible.length) {
    lines.push('', '玩家多半看得到（控件文字、Text 字面量、字幕、配置、源码字符串）：')
    list(visible, limit)
  }
  if (other.length) {
    lines.push(
      '',
      '只有名字和编辑器内的说明（资产名、材质参数名、引脚提示、蓝图注释等），一般不影响游戏画面：'
    )
    list(other, Math.max(5, Math.floor(limit / 3)))
  }
  lines.push('')
  if (loc.length)
    lines.push(`另有 ${loc.length} 个非英文本地化文件，只在游戏语言不是英文时显示，可以不管。`)
  lines.push(
    '回编辑器确认文字在哪个控件、哪一格、哪个节点，用对应的工具改成英文，存盘后再跑一次本工具。'
  )
  return lines.join('\n')
}

const input = z.object({
  project_path: z
    .string()
    .optional()
    .describe('工程目录（含 .uproject 的那一层）。省略 = 这一轮正在干的工程'),
  limit: z.number().int().min(1).max(500).optional().default(60).describe('最多列几个文件')
})

export interface TextAuditResult {
  scanned: number
  hits: TextHit[]
}

export function createFindNonEnglishTextTool(): UnrealAgentTool<TextAuditResult> {
  return defineTool<typeof input, TextAuditResult>({
    name: 'project_find_non_english_text',
    namespace: 'project',
    risk: 'safe',
    description:
      '扫描工程磁盘上的资产（.uasset/.umap）、Config 下的 ini、Source 下的源码字符串，' +
      '列出含中日韩文字的文件和原文。不需要连编辑器。' +
      '交付英文版（jam 提交、海外发行）前用：改完一轮存盘后再扫，直到列表为空。' +
      '只读磁盘，编辑器里没存盘的改动扫不到。',
    input,
    execute: async ({ project_path, limit }, ctx) => {
      const projectDir = project_path ?? getTargetProjectPath()
      if (!projectDir) throw new Error('不知道扫哪个工程：这一轮没有连着的工程，请给 project_path')
      ctx.report({ text: '扫描工程里的非英文文字' })
      const { hits, scanned } = await auditProjectText(projectDir, ctx.signal)
      return { text: formatTextAudit(hits, scanned, limit), details: { scanned, hits } }
    }
  })
}
