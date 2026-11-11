import type { MarkdownIt, StateCore, Token } from 'markdown-it'

/**
 * 对话正文里的本地 / 网络路径变成可点的链接。
 *
 * AI 回复里经常直接甩一条 `I:/UE Project/xxx/说明.html` 或 `\\nas\share\a.uasset`，
 * 用户只能手动复制到资源管理器里去找。这里把这类路径识别出来包成
 * `<span class="fs-path">`，左键打开、右键出菜单（打开 / 资源管理器 / VS Code / 复制）。
 *
 * 只认盘符路径（`C:\` `C:/`）和 UNC 网络路径（`\\server\share\`）——
 * 裸 POSIX 路径在中文正文里和「和/或」这类写法分不开，认了全是误报。
 *
 * 注意：UNC 路径必须写在反引号里才认得出。裸写在正文里时，markdown 会先把
 * `\\` 当成转义吃掉一个反斜杠，轮到这条规则时前缀已经不成立了。
 */

/**
 * 正文里扫路径的起点：到第一个空白为止，带空格的部分由 `extendAcrossSpaces` 接上。
 * 也停在中文的逗号句号这类断句标点上：「I:/UE/Saved，打开看看」后半句不是路径。
 */
const PATH_IN_TEXT = /(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])[^\s"'`<>|*?，。；！？、]*/g

/** 空格后面紧跟的那个词 */
const NEXT_WORD = /^ ([^\s"'`<>|*?，。；！？、]+)/

/**
 * 路径里带空格时往后接。
 *
 * UE 的工程目录常带空格（`I:\UEBox Project\Claude\UEBox_Test_TASK_1`），只扫到空格为止的话，
 * 链接只剩 `I:\UEBox`，点开是个不存在的目录。
 *
 * 只在空格后那个词里还有**同一种**分隔符时才接：`Project\Claude\...` 一看就还在路径里；
 * 而「复制 C:\a\b 到 D:\c」里的「到」、句末的「Project.」这种后面没有分隔符的词，
 * 分不清是目录名还是正文，宁可不接 —— 接错了是把正文吞进链接，比短一截更难看。
 * 后者想整条认出来，就得写在反引号里。
 */
function extendAcrossSpaces(source: string, start: number, path: string): string {
  const separator = path.startsWith('\\\\') ? '\\' : path[2]
  let extended = path
  for (;;) {
    const word = NEXT_WORD.exec(source.slice(start + extended.length))?.[1]
    if (!word || !word.includes(separator)) return extended
    // 下一个词自己就是一条路径（`a.png, D:\b.png`、`robocopy C:\src D:\dst`）：那是另一条，不接
    if (/^(?:[A-Za-z]:[\\/]|\\\\)/.test(word)) return extended
    // 前一段以逗号、分号收尾：是在列举，不是路径里的空格
    if (/[,;]$/.test(extended)) return extended
    extended += ` ${word}`
  }
}

/** 反引号里整段就是一条路径时，允许带空格 */
const WHOLE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\[^\\/\s]+[\\/])[^"'`<>|*?]*$/

/** 路径结尾粘上的中英文标点不算路径的一部分 */
const TRAILING_PUNCT = /[.,;:!?)）】」』。，、；：！？]+$/

/** 至少要有个盘符加一段内容，光一个 `C:\` 不值得做成链接 */
const MIN_LENGTH = 4

/** 转义 HTML，路径里的 `&` `<` 不能直通 */
function escapeHtml(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 判断一个字符串整体是不是一条本地 / 网络绝对路径
 * @param value 候选字符串
 */
export function isFilesystemPath(value: string): boolean {
  const trimmed = String(value ?? '').trim()
  return trimmed.length >= MIN_LENGTH && WHOLE_PATH.test(trimmed)
}

/**
 * 生成路径链接的 HTML
 * @param path 绝对路径
 */
export function buildPathLinkHtml(path: string): string {
  const escaped = escapeHtml(path)
  return `<span class="fs-path" data-fs-path="${escaped}" title="${escaped}">${escaped}</span>`
}

/**
 * 从一段纯文本里切出「普通文字 / 路径」的片段
 * @param text 文本内容
 * @returns 交替出现的片段；没有路径时返回 null
 */
export function splitTextByPath(text: string): { text: string; path?: string }[] | null {
  const source = String(text ?? '')
  if (!source) return null

  const parts: { text: string; path?: string }[] = []
  let cursor = 0
  PATH_IN_TEXT.lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = PATH_IN_TEXT.exec(source)) !== null) {
    const path = extendAcrossSpaces(source, match.index, match[0]).replace(TRAILING_PUNCT, '')
    if (path.length < MIN_LENGTH) continue

    if (match.index > cursor) parts.push({ text: source.slice(cursor, match.index) })
    parts.push({ text: path, path })
    cursor = match.index + path.length
    PATH_IN_TEXT.lastIndex = cursor
  }

  if (parts.length === 0) return null
  if (cursor < source.length) parts.push({ text: source.slice(cursor) })
  return parts
}

/**
 * 创建 markdown-it 的 core 规则：把正文里的路径替换成路径链接
 * @param renderPath 把路径渲染成 HTML 的函数
 */
export function createPathLinkRule(
  renderPath: (path: string) => string
): (state: StateCore) => void {
  return (state: StateCore): void => {
    for (const token of state.tokens) {
      if (token.type !== 'inline' || !token.children) continue

      const next: Token[] = []
      let changed = false

      for (const child of token.children) {
        // 反引号里的路径：整段替换（这样带空格的路径也能认）
        if (child.type === 'code_inline' && isFilesystemPath(child.content)) {
          const html = new state.Token('html_inline', '', 0)
          html.content = renderPath(child.content.trim())
          next.push(html)
          changed = true
          continue
        }

        if (child.type === 'text') {
          const parts = splitTextByPath(child.content)
          if (parts) {
            for (const part of parts) {
              if (part.path) {
                const html = new state.Token('html_inline', '', 0)
                html.content = renderPath(part.path)
                next.push(html)
              } else {
                const plain = new state.Token('text', '', 0)
                plain.content = part.text
                next.push(plain)
              }
            }
            changed = true
            continue
          }
        }

        next.push(child)
      }

      if (changed) token.children = next
    }
  }
}

/**
 * 把链接地址还原成本地 / 网络路径；不是本地路径时返回 null。
 *
 * 模型交付文件时常写成 Markdown 链接：`[index.html](C:/x/index.html)`、
 * `[index.html](file:///C:/x/index.html)`。前者渲染成 `<a href="C:/…">`，
 * 消毒时 `C:` 被当成未知协议摘掉 href，点了没反应；后者 markdown-it 默认不认。
 * @param href 链接地址（可能已被 markdown-it 百分号编码）
 */
export function localPathFromHref(href: string): string | null {
  let value = String(href ?? '').trim()
  if (!value) return null

  const fileUrl = /^file:\/\/(.*)$/i.exec(value)
  if (fileUrl) {
    // file:///C:/a → C:/a；file://server/share/a → //server/share/a
    value = fileUrl[1].startsWith('/') ? fileUrl[1].slice(1) : `//${fileUrl[1]}`
  }

  try {
    value = decodeURIComponent(value)
  } catch {
    // 编码不完整就按原样判断
  }
  if (value.startsWith('//')) value = value.replace(/\//g, '\\')

  return isFilesystemPath(value) ? value : null
}

/**
 * 让指向本地文件的 Markdown 链接和正文里的路径一样可点：
 * 链接改成 `.fs-path`，左键用系统默认程序打开、右键出路径菜单。
 * @param md markdown-it 实例；要在其它 link_open 覆写之后调用
 */
export function installLocalLinkSupport(md: MarkdownIt): void {
  const validateLink = md.validateLink.bind(md)
  md.validateLink = (url: string): boolean => /^file:\/\//i.test(url.trim()) || validateLink(url)

  const linkOpen =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self): string => self.renderToken(tokens, idx, options))

  md.renderer.rules.link_open = (tokens, idx, options, env, self): string => {
    const token = tokens[idx]
    const path = localPathFromHref(String(token.attrGet('href') ?? ''))
    if (path) {
      token.attrSet('href', '#')
      token.attrJoin('class', 'fs-path')
      token.attrSet('data-fs-path', path)
      token.attrSet('title', path)
    }
    return linkOpen(tokens, idx, options, env, self)
  }
}
