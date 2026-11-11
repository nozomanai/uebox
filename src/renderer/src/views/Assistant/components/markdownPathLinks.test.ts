import { describe, expect, it } from 'vitest'
import MarkdownIt from 'markdown-it'
import type { MarkdownIt as MarkdownItInstance } from 'markdown-it'

import {
  buildPathLinkHtml,
  createPathLinkRule,
  installLocalLinkSupport,
  isFilesystemPath,
  localPathFromHref
} from './markdownPathLinks'
import { sanitizeRenderedHtml } from '@renderer/utils/sanitizeHtml'

function createRenderer(): MarkdownItInstance {
  const md = new MarkdownIt({ html: true, linkify: true, breaks: true, typographer: true })
  md.core.ruler.push('fs_path_link', createPathLinkRule(buildPathLinkHtml))
  return md
}

function pathsIn(html: string): string[] {
  return Array.from(html.matchAll(/data-fs-path="([^"]*)"/g)).map((m) => m[1])
}

describe('isFilesystemPath', () => {
  it('接受盘符路径与 UNC 网络路径', () => {
    expect(isFilesystemPath('I:/UE Project/SampleProject/说明.html')).toBe(true)
    expect(isFilesystemPath('C:\\Users\\me\\a.txt')).toBe(true)
    expect(isFilesystemPath('\\\\nas\\share\\Content\\a.uasset')).toBe(true)
  })

  it('拒绝相对路径、URL 和过短的片段', () => {
    expect(isFilesystemPath('assets/a.png')).toBe(false)
    expect(isFilesystemPath('https://example.com/a')).toBe(false)
    expect(isFilesystemPath('C:')).toBe(false)
    expect(isFilesystemPath('')).toBe(false)
  })
})

describe('createPathLinkRule', () => {
  it('把反引号里的路径变成链接（带空格也认）', () => {
    const html = createRenderer().render('我已经写到了：`I:/UE Project/SampleProject/说明.html`')
    expect(pathsIn(html)).toEqual(['I:/UE Project/SampleProject/说明.html'])
  })

  it('把裸写在正文里的路径变成链接，并剥掉尾部标点', () => {
    const html = createRenderer().render('文件在 C:\\Users\\me\\a.txt。')
    expect(pathsIn(html)).toEqual(['C:\\Users\\me\\a.txt'])
    expect(html).toContain('。')
  })

  // UE 工程目录常带空格。只扫到空格的话，链接只剩 `I:\UEBox`，点开是个不存在的目录
  it('裸写的路径带空格时，后面还有分隔符就接上', () => {
    const html = createRenderer().render(
      '例如 I:\\UEBox Project\\Claude\\UEBox_Test_TASK_1 → Claude_UEBox_Test_TASK_1。'
    )
    expect(pathsIn(html)).toEqual(['I:\\UEBox Project\\Claude\\UEBox_Test_TASK_1'])

    const slash = createRenderer().render('工程在 I:/UE Project/My Game/Saved，打开看看')
    expect(pathsIn(slash)).toEqual(['I:/UE Project/My Game/Saved'])
  })

  // 接错了是把正文吞进链接，比短一截更难看
  it('空格后面的词没有分隔符就不接', () => {
    expect(pathsIn(createRenderer().render('复制 C:\\a\\b 到 D:\\c'))).toEqual([
      'C:\\a\\b',
      'D:\\c'
    ])
    expect(pathsIn(createRenderer().render('Let me list I:\\UEBox Project.'))).toEqual([
      'I:\\UEBox'
    ])
  })

  it('反斜杠路径不会把后面带斜杠的正文吞进来', () => {
    expect(pathsIn(createRenderer().render('C:\\a\\b and/or D:\\c'))).toEqual(['C:\\a\\b', 'D:\\c'])
  })

  it('同一行里的几条路径各是各的，不连成一条', () => {
    expect(pathsIn(createRenderer().render('Files: C:\\x\\a.png, C:\\x\\b.png'))).toEqual([
      'C:\\x\\a.png',
      'C:\\x\\b.png'
    ])
    expect(pathsIn(createRenderer().render('robocopy C:\\src D:\\dst /E'))).toEqual([
      'C:\\src',
      'D:\\dst'
    ])
  })

  it('认反引号里的 UNC 网络路径', () => {
    const html = createRenderer().render('放在 `\\\\nas\\share\\Content` 里')
    expect(pathsIn(html)).toEqual(['\\\\nas\\share\\Content'])
  })

  it('不动普通文本、代码块和相对路径', () => {
    const html = createRenderer().render('见 assets/a.png 和 README.md\n\n```\nC:\\a\\b.txt\n```')
    expect(pathsIn(html)).toEqual([])
  })

  it('转义路径里的 HTML 特殊字符', () => {
    const html = createRenderer().render('`C:/a<b>/c.txt`')
    expect(html).not.toContain('<b>')
    expect(html).toContain('&lt;b&gt;')
  })
})

describe('localPathFromHref', () => {
  it('还原盘符路径、file URL 和 UNC', () => {
    expect(localPathFromHref('C:/x%20y/a.html')).toBe('C:/x y/a.html')
    expect(localPathFromHref('C:%5Cx%5Ca.html')).toBe('C:\\x\\a.html')
    expect(localPathFromHref('file:///C:/x/a.html')).toBe('C:/x/a.html')
    expect(localPathFromHref('file://nas/share/a.html')).toBe('\\\\nas\\share\\a.html')
  })

  it('网页链接和相对路径不算', () => {
    expect(localPathFromHref('https://example.com/a.html')).toBeNull()
    expect(localPathFromHref('docs/a.html')).toBeNull()
    expect(localPathFromHref('')).toBeNull()
  })
})

describe('installLocalLinkSupport', () => {
  function render(source: string): string {
    const md = createRenderer()
    installLocalLinkSupport(md)
    return sanitizeRenderedHtml(md.render(source))
  }

  it('指向本地文件的 Markdown 链接消毒后仍是路径链接', () => {
    expect(pathsIn(render('[index.html](C:/x/index.html)'))).toEqual(['C:/x/index.html'])
    expect(pathsIn(render('[index.html](file:///C:/x/index.html)'))).toEqual(['C:/x/index.html'])
    expect(pathsIn(render('[index.html](<C:/x y/index.html>)'))).toEqual(['C:/x y/index.html'])
  })

  it('网页链接不受影响', () => {
    const html = render('[官网](https://uebox.ai)')
    expect(html).toContain('href="https://uebox.ai"')
    expect(pathsIn(html)).toEqual([])
  })
})
