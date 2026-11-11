<template>
  <!-- 使用 morphdom 增量更新，不再使用 v-html -->
  <div
    ref="rootRef"
    v-bind="$attrs"
    class="markdown-body"
    :class="{ 'thinking-placeholder': isThinkingPlaceholder }"
  ></div>
  <!-- 外部链接确认对话框 -->
  <AppModal
    v-model:open="linkConfirmVisible"
    :title="$t('markdownRendererLinkConfirm.title')"
    :mask-closable="false"
    :keyboard="true"
    centered
    width="480px"
    class="link-confirm-modal"
    @ok="handleConfirmLink"
    @cancel="handleCancelLink"
  >
    <div class="link-confirm-content">
      <p class="confirm-text">{{ $t('markdownRendererLinkConfirm.confirmText') }}</p>
      <div class="link-url">{{ pendingLinkUrl }}</div>
    </div>
    <template #footer>
      <AppButton @click="handleCancelLink">{{
        $t('markdownRendererLinkConfirm.cancelButton')
      }}</AppButton>
      <AppButton variant="primary" @click="handleConfirmLink">{{
        $t('markdownRendererLinkConfirm.continueButton')
      }}</AppButton>
    </template>
  </AppModal>
  <!-- 正文里的本地/网络路径的右键菜单 -->
  <!-- 每条消息都是一个 MarkdownRenderer，菜单一直挂着会有几十份全局监听，右键时才创建 -->
  <ContextMenu
    v-if="pathMenuMounted"
    ref="pathMenuRef"
    :menu-items="pathMenuItems"
    @click="handlePathMenuClick"
  />
</template>

<script setup lang="ts">
// 根节点不止一个（正文 + 弹窗 + 菜单），外面传的 class 手动落到正文 div 上
defineOptions({ inheritAttrs: false })

import AppModal from '@renderer/components/AppModal.vue'
import AppButton from '@renderer/components/AppButton.vue'
import { ref, onMounted, onUnmounted, watch, nextTick } from 'vue'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js'
import 'highlight.js/styles/atom-one-dark.css'
import { useI18n } from 'vue-i18n'
import morphdom from 'morphdom'
import { sanitizeRenderedHtml } from '@renderer/utils/sanitizeHtml'
import { copyImageToClipboard, downloadImage } from '@renderer/utils/imageBlob'
import { useGlobalAudioStore } from '@renderer/store/modules/globalAudio'
import { openImageViewer } from '@renderer/services/imageViewer'
import { buildImageHtml, buildVideoHtml, createMediaPreviewRule } from './markdownMediaPreview'
import { buildPathLinkHtml, createPathLinkRule, installLocalLinkSupport } from './markdownPathLinks'
import ContextMenu from '@renderer/components/ContextMenu/ContextMenu.vue'
import { openFilePath, useFilePathMenu } from '@renderer/composables/useFilePathMenu'
import { createLatestValueScheduler } from './latestValueScheduler'

const { t } = useI18n()

const props = defineProps<{
  content: string
  isThinkingPlaceholder?: boolean
  streaming?: boolean
}>()

const emit = defineEmits<{
  (e: 'open-location', folderKey: string): void
  (e: 'resize'): void
}>()

// 链接确认对话框
const linkConfirmVisible = ref(false)
const pendingLinkUrl = ref('')

// 全局音频播放器
const audioStore = useGlobalAudioStore()

// 初始化 markdown-it
const md = new MarkdownIt({
  html: true,
  linkify: true,
  breaks: true,
  typographer: true
})

/**
 * 生成字符串的简单哈希值，用于创建稳定的元素 ID
 * @param str 输入字符串
 * @returns 哈希值的 36 进制表示
 */
function hashCode(str: string): string {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = (hash << 5) - hash + str.charCodeAt(i)
    hash |= 0 // 转换为32位整数
  }
  return Math.abs(hash).toString(36)
}

// 自定义代码块渲染
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]
  const info = token.info ? md.utils.unescapeAll(token.info).trim() : ''
  const lang = info.split(/\s+/g)[0]
  const code = token.content

  // 使用内容哈希生成稳定的 ID，确保 morphdom 能正确识别复用代码块
  const id = `code_${hashCode(code)}_${idx}`

  let highlightedCode = ''
  let detectedLang = lang

  if (lang && hljs.getLanguage(lang)) {
    try {
      highlightedCode = hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
    } catch {
      // 忽略错误，回退到默认转义
    }
  } else {
    // 尝试自动检测语言
    try {
      const result = hljs.highlightAuto(code)
      highlightedCode = result.value
      detectedLang = result.language || ''
    } catch {
      // 忽略错误
    }
  }

  if (!highlightedCode) {
    // 简单的转义，防止XSS
    highlightedCode = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  const langHtml = detectedLang ? `<span class="lang">${detectedLang}</span>` : ''

  return `
  <div class="code-block">
    <div class="code-header">${langHtml}<button class="copy" data-target="${id}">${t(
      'assistant.markdownRenderer.copy'
    )}</button></div>
    <pre id="${id}"><code class="hljs ${
      detectedLang ? `language-${detectedLang}` : ''
    }">${highlightedCode}</code></pre>
  </div>`
}

// 自定义图片渲染以支持预览
md.renderer.rules.image = (tokens, idx, options, env, self) => {
  void options
  void env
  void self
  const token = tokens[idx]
  const srcIndex = token.attrIndex('src')
  const src = srcIndex >= 0 ? String(token.attrs![srcIndex][1]) : ''

  // 将图片包裹在容器中，添加复制和下载按钮
  return buildImageHtml({
    src,
    alt: token.content,
    copyLabel: t('assistant.markdownRenderer.copyImage'),
    downloadLabel: t('assistant.markdownRenderer.downloadImage')
  })
}

// 正文里只写了媒体路径（如「保存位置: `I:/.../UAShot.png`」）时，
// 在该段落后面补一张预览图 / 一个播放器
md.core.ruler.push(
  'inline_media_preview',
  createMediaPreviewRule({
    image: (src) =>
      buildImageHtml({
        src,
        preview: true,
        copyLabel: t('assistant.markdownRenderer.copyImage'),
        downloadLabel: t('assistant.markdownRenderer.downloadImage')
      }),
    video: (src) => buildVideoHtml({ src, preview: true })
  })
)

// 正文里的本地 / 网络路径变成可点的链接（放在图片预览之后，别抢掉图片路径的预览图）
md.core.ruler.push('fs_path_link', createPathLinkRule(buildPathLinkHtml))

// 自定义链接渲染以支持 folder: 协议
const originalLinkOpen =
  md.renderer.rules.link_open ||
  ((tokens, idx, options, env, self) => {
    void options
    void env
    void self
    return self.renderToken(tokens, idx, options)
  })

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  void options
  void env
  void self
  const token = tokens[idx]
  const hrefIndex = token.attrIndex('href')
  if (hrefIndex >= 0) {
    const href = String(token.attrs![hrefIndex][1])
    // 如果是 folder: 协议，添加特殊类名和 data 属性
    if (href && href.startsWith('folder:')) {
      const folderKey = href.replace('folder:', '')
      token.attrSet('class', 'folder-link')
      token.attrSet('data-folder-key', folderKey)
      token.attrSet('href', '#')
    }
  }
  return originalLinkOpen(tokens, idx, options, env, self)
}

// 指向本地文件的 Markdown 链接（[index.html](C:/x/index.html)）按路径链接处理
installLocalLinkSupport(md)

// 内容长度限制 (500KB - 支持大型 PDF 文档)
const MAX_CONTENT_LENGTH = 500000

/**
 * 渲染 Markdown 内容为 HTML
 * @param content Markdown 原始内容
 * @returns 渲染后的 HTML 字符串
 */
function renderMarkdown(content: string): string {
  if (!content) return ''

  let contentToRender = content

  // 修复 markdown-it 在中文标点旁无法正确解析 ** 粗体的问题
  // 在 ** 和中文标点之间插入零宽空格，帮助解析器识别强调边界
  contentToRender = contentToRender
    .replace(
      /\*\*(["\u201c\u201d\u2018\u2019\u300a\u300b\u3010\u3011\u3001\uff0c\uff08\uff09])/g,
      '**\u200B$1'
    )
    .replace(
      /(["\u201c\u201d\u2018\u2019\u300a\u300b\u3010\u3011\u3001\uff0c\uff08\uff09])\*\*/g,
      '$1\u200B**'
    )

  // 内容长度检查和截断
  if (contentToRender.length > MAX_CONTENT_LENGTH) {
    console.warn(
      `[MarkdownRenderer] 内容过长 (${contentToRender.length} 字符), 截断至 ${MAX_CONTENT_LENGTH} 字符`
    )
    contentToRender = contentToRender.slice(0, MAX_CONTENT_LENGTH) + '\n\n...(内容过长,已截断)'
  }

  try {
    return md.render(contentToRender)
  } catch (error) {
    console.error('[MarkdownRenderer] Markdown 渲染失败:', error)
    return `<pre>${contentToRender}</pre>`
  }
}

/**
 * 使用 morphdom 增量更新 DOM
 * 这样可以避免完全重建 DOM 导致的图片闪烁问题
 * @param newHtml 新的 HTML 内容
 */
function updateDomWithMorphdom(newHtml: string): void {
  if (!rootRef.value) return

  // 创建临时容器来解析新的 HTML
  const tempContainer = document.createElement('div')
  // 消毒之后再进 DOM：markdown 开着 html:true，而内容来自网页 / 模型输出
  tempContainer.innerHTML = sanitizeRenderedHtml(newHtml)

  // 使用 morphdom 做增量 DOM 更新
  morphdom(rootRef.value, tempContainer, {
    // 只更新子元素，保留根元素的属性
    childrenOnly: true,

    /**
     * 在元素更新之前的钩子
     * 返回 false 跳过该元素的更新
     */
    onBeforeElUpdated: (fromEl, toEl) => {
      // 关键优化：相同 src 的图片不更新，避免闪烁
      if (fromEl.tagName === 'IMG' && toEl.tagName === 'IMG') {
        const fromSrc = fromEl.getAttribute('src')
        const toSrc = toEl.getAttribute('src')
        if (fromSrc === toSrc) {
          // src 相同，跳过更新，保留图片的加载状态
          return false
        }
      }

      // 代码块也可以考虑保留，如果内容相同
      if (
        fromEl.tagName === 'PRE' &&
        toEl.tagName === 'PRE' &&
        fromEl.textContent === toEl.textContent
      ) {
        return false
      }

      return true
    },

    /**
     * 获取元素的唯一标识 key
     * 用于 morphdom 判断元素是否可复用
     */
    getNodeKey: (node) => {
      if (node instanceof Element) {
        // 图片使用 src 作为 key
        if (node.tagName === 'IMG') {
          return node.getAttribute('src') || undefined
        }
        // 代码块使用 id 作为 key
        if (node.tagName === 'PRE' && node.id) {
          return node.id
        }
      }
      return undefined
    }
  })

  bindPreviewImageFallback()
}

/**
 * 给内联预览图绑定加载失败回调。
 *
 * 路径可能已经被删了、也可能压根不是这台机器上的文件，加载不出来就把整块藏掉。
 * CSP 是 `script-src 'self'`，行内 onerror 会被拦，所以只能在这里补绑。
 * 失败标记打在 <img> 上：morphdom 对同 src 的图片会跳过更新，标记才不会被冲掉。
 */
function bindPreviewImageFallback(): void {
  const root = rootRef.value
  if (!root) return

  const images = root.querySelectorAll<HTMLImageElement>('img.markdown-image--preview')
  images.forEach((img) => {
    if (img.dataset.previewBound === '1') return
    img.dataset.previewBound = '1'

    const markFailed = (): void => {
      img.classList.add('preview-failed')
    }
    if (img.complete && img.naturalWidth === 0) {
      markFailed()
      return
    }
    img.addEventListener('error', markFailed, { once: true })
  })
}

/**
 * Markdown 解析、高亮和 DOM 对比都比较重，最多每 80ms 做一次。
 *
 * 这里是 leading + trailing throttle，不是 debounce：第一份内容立即显示，区间内
 * 只保留最新内容，但已有的截止时间绝不因新 token 到来而后移。持续输出时因此
 * 不会再出现「一直等不到 100ms 空档，积压几秒后突然整段冒出来」。
 */
const renderScheduler = createLatestValueScheduler<string>({
  intervalMs: 80,
  onValue: (content) => {
    const html = renderMarkdown(content)
    void nextTick(() => {
      updateDomWithMorphdom(html)
    })
  }
})

watch(
  () => ({ content: props.content, streaming: props.streaming === true }),
  ({ content, streaming }) => {
    renderScheduler.schedule(content)

    // 静态内容和流结束的终稿不需要等下一个节拍，立即把尾巴补齐。
    if (!streaming) {
      renderScheduler.flush()
    }
  },
  { immediate: true }
)

/**
 * 判断URL是否为图片
 */
function isImageUrl(url: string): boolean {
  if (!url) return false
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.svg', '.ico']
  const lowerUrl = url.toLowerCase()
  // 检查文件扩展名
  if (imageExtensions.some((ext) => lowerUrl.includes(ext))) {
    return true
  }
  // 检查是否是data URL图片
  if (lowerUrl.startsWith('data:image/')) {
    return true
  }
  return false
}

/**
 * 判断URL是否为音频文件（mp3）
 */
function isAudioUrl(url: string): boolean {
  if (!url) return false
  const audioExtensions = ['.mp3', '.wav', '.flac', '.aac', '.ogg', '.wma', '.m4a']
  const lowerUrl = url.toLowerCase()
  return audioExtensions.some((ext) => lowerUrl.includes(ext))
}

// ==================== 正文里的本地 / 网络路径 ====================

/** 右键菜单当前指向的路径 */
const activePath = ref('')
const pathMenuMounted = ref(false)
const pathMenuRef = ref<{ show: (x: number, y: number) => void } | null>(null)

const { menuItems: pathMenuItems, runFilePathAction } = useFilePathMenu()

/**
 * 右键正文里的路径时弹出菜单
 */
function onContextMenu(e: MouseEvent): void {
  const el = (e.target as HTMLElement)?.closest?.('.fs-path') as HTMLElement | null
  const path = el?.dataset.fsPath || ''
  if (!path) return

  e.preventDefault()
  e.stopPropagation()
  activePath.value = path

  const { clientX, clientY } = e
  pathMenuMounted.value = true
  void nextTick(() => pathMenuRef.value?.show(clientX, clientY))
}

/**
 * 路径右键菜单的动作分发
 * @param key 菜单项 key
 */
async function handlePathMenuClick(key: string): Promise<void> {
  await runFilePathAction(key, activePath.value)
}

/**
 * 处理复制按钮点击、图片点击、音频点击、文件夹链接点击和普通链接点击（事件代理）
 */
function onClick(e: MouseEvent): void {
  const target = e.target as HTMLElement

  // 正文里的本地 / 网络路径：左键直接打开
  const pathEl = target?.closest?.('.fs-path') as HTMLElement | null
  if (pathEl?.dataset.fsPath) {
    e.preventDefault()
    e.stopPropagation()
    void openFilePath(pathEl.dataset.fsPath)
    return
  }
  const isCopy = target && target.classList.contains('copy')
  const isImage = target && target.tagName === 'IMG' && target.classList.contains('markdown-image')
  const isFolderLink =
    target && (target.classList.contains('folder-link') || target.closest('.folder-link'))

  // 检查是否是图片操作按钮点击
  const copyImageBtn = target.closest('.copy-image-btn') as HTMLElement | null
  const downloadImageBtn = target.closest('.download-image-btn') as HTMLElement | null

  // 检查是否是链接点击（排除图片和文件夹链接）
  const linkElement = target.tagName === 'A' ? target : target.closest('a')
  const isLink = linkElement && !isFolderLink && !isImage

  // 处理复制图片按钮点击
  if (copyImageBtn) {
    e.preventDefault()
    e.stopPropagation()
    const src = copyImageBtn.getAttribute('data-src')
    if (src) {
      copyImageToClipboard(src)
        .then(() => {
          // 显示复制成功反馈
          copyImageBtn.classList.add('success')
          setTimeout(() => {
            copyImageBtn.classList.remove('success')
          }, 1500)
        })
        .catch((error) => {
          console.error('[MarkdownRenderer] 复制图片失败:', error)
          // 显示复制失败反馈
          copyImageBtn.classList.add('error')
          setTimeout(() => {
            copyImageBtn.classList.remove('error')
          }, 1500)
        })
    }
    return
  }

  // 处理下载图片按钮点击
  if (downloadImageBtn) {
    e.preventDefault()
    e.stopPropagation()
    const src = downloadImageBtn.getAttribute('data-src')
    if (src) {
      downloadImage(src)
        .then(() => {
          // 显示下载成功反馈
          downloadImageBtn.classList.add('success')
          setTimeout(() => {
            downloadImageBtn.classList.remove('success')
          }, 1500)
        })
        .catch((error) => {
          console.error('[MarkdownRenderer] 下载图片失败:', error)
          // 显示下载失败反馈
          downloadImageBtn.classList.add('error')
          setTimeout(() => {
            downloadImageBtn.classList.remove('error')
          }, 1500)
        })
    }
    return
  }

  if (isCopy) {
    e.preventDefault()
    e.stopPropagation()
    const id = target.getAttribute('data-target') || ''
    const el = id ? document.getElementById(id) : null
    if (el) {
      const text = el.textContent || ''
      navigator.clipboard?.writeText(text)

      // 可选：添加复制成功的反馈
      const originalText = target.textContent
      target.textContent = t('assistant.markdownRenderer.copied')
      setTimeout(() => {
        target.textContent = originalText
      }, 2000)
    }
  } else if (isImage) {
    e.preventDefault()
    e.stopPropagation()
    const src = target.getAttribute('src')
    if (src) {
      openImagePreview(src)
    }
  } else if (isFolderLink) {
    e.preventDefault()
    e.stopPropagation()
    const folderLinkElement = target.classList.contains('folder-link')
      ? target
      : (target.closest('.folder-link') as HTMLElement)
    if (folderLinkElement) {
      const folderKey = folderLinkElement.getAttribute('data-folder-key')
      if (folderKey) {
        emit('open-location', folderKey)
      }
    }
  } else if (isLink && linkElement) {
    e.preventDefault()
    e.stopPropagation()
    const href = linkElement.getAttribute('href')
    if (!href || href === '#' || href.startsWith('javascript:') || href.startsWith('folder:')) {
      return
    }

    // 判断链接类型
    if (isImageUrl(href)) {
      // 图片链接，使用图片预览
      openImagePreview(href)
    } else if (isAudioUrl(href)) {
      // 音频链接，使用全局播放器播放
      audioStore.playAudio({
        src: href,
        title: linkElement.textContent?.trim() || '音频文件'
      })
    } else {
      // 普通链接，显示确认对话框
      pendingLinkUrl.value = href
      linkConfirmVisible.value = true
    }
  }
}

const rootRef = ref<HTMLElement | null>(null)

/**
 * 打开图片预览模态框
 * @param src 图片地址
 */
function openImagePreview(src: string): void {
  const root = rootRef.value
  if (!root) {
    void openImageViewer({ items: [{ src }], index: 0 })
    return
  }

  // 取当前消息气泡内所有 markdown 图片，支持左右切换（加载失败被隐藏的不进画廊）
  const imgEls = Array.from(
    root.querySelectorAll('img.markdown-image:not(.preview-failed)')
  ) as HTMLImageElement[]
  const items = imgEls
    .map((el) => ({
      src: el.getAttribute('src') || '',
      alt: el.getAttribute('alt') || ''
    }))
    .filter((it) => !!it.src)

  const idx = items.findIndex((it) => it.src === src)

  void openImageViewer({
    items: items.length > 0 ? items : [{ src }],
    index: idx >= 0 ? idx : 0
  })
}

/**
 * 确认打开外部链接
 */
async function handleConfirmLink(): Promise<void> {
  if (pendingLinkUrl.value) {
    try {
      const result = await window.api.shell.openExternal(pendingLinkUrl.value)
      if (!result.success && result.error) {
        console.error('[MarkdownRenderer] 打开外部链接失败:', result.error)
      }
    } catch (error) {
      console.error('[MarkdownRenderer] 打开外部链接异常:', error)
    }
  }
  linkConfirmVisible.value = false
  pendingLinkUrl.value = ''
}

/**
 * 取消打开外部链接
 */
function handleCancelLink(): void {
  linkConfirmVisible.value = false
  pendingLinkUrl.value = ''
}

const resizeObserver = new ResizeObserver(() => {
  emit('resize')
})

/**
 * 事件绑定:组件根元素点击时处理复制事件
 */
onMounted(() => {
  rootRef.value?.addEventListener('click', onClick)
  rootRef.value?.addEventListener('contextmenu', onContextMenu)
  if (rootRef.value) {
    resizeObserver.observe(rootRef.value)
  }
})

onUnmounted(() => {
  rootRef.value?.removeEventListener('click', onClick)
  rootRef.value?.removeEventListener('contextmenu', onContextMenu)
  resizeObserver.disconnect()

  renderScheduler.cancel()
})
</script>

<style scoped lang="less">
.markdown-body {
  font-size: 14px;
  line-height: 1.6;
  color: var(--color-text-primary);

  :deep(p) {
    margin-bottom: 16px;
  }

  :deep(h1),
  :deep(h2),
  :deep(h3),
  :deep(h4),
  :deep(h5),
  :deep(h6) {
    margin-top: 24px;
    margin-bottom: 16px;
    font-weight: 600;
    line-height: 1.25;
  }

  :deep(h1) {
    font-size: 2em;
    border-bottom: 1px solid var(--color-border-subtle);
    padding-bottom: 0.8em;
  }
  :deep(h2) {
    font-size: 1.5em;
    border-bottom: 1px solid var(--color-border-subtle);
    padding-bottom: 0.8em;
  }
  :deep(h3) {
    font-size: 1.25em;
    padding-bottom: 0.8em;
  }
  :deep(h4) {
    font-size: 1em;
    padding-bottom: 0.4em;
  }

  :deep(ul),
  :deep(ol) {
    padding-left: 2em;
    margin-bottom: 16px;
  }

  :deep(li) {
    margin: 0.25em 0;
  }

  :deep(blockquote) {
    margin: 0 0 16px;
    padding: 0 1em;
    color: var(--color-text-primary);
    border-left: 0.25em solid var(--color-border);
  }

  :deep(a) {
    color: var(--color-accent-text);
    text-decoration: none;
    &:hover {
      text-decoration: underline;
    }
  }

  // 正文里的本地 / 网络路径：看起来像链接，左键打开，右键出菜单
  :deep(.fs-path) {
    color: var(--color-accent-text);
    cursor: pointer;
    text-decoration: underline;
    text-decoration-style: dotted;
    text-underline-offset: 2px;
    word-break: break-all;
    font-family:
      ui-monospace,
      SFMono-Regular,
      SF Mono,
      Menlo,
      Consolas,
      Liberation Mono,
      monospace;
    font-size: 92%;

    &:hover {
      color: var(--color-accent-text);
      text-decoration-style: solid;
    }
  }

  :deep(a.folder-link) {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 4px 8px;
    background: var(--color-accent-bg);
    border: 1px solid var(--color-accent-border);
    border-radius: 4px;
    color: var(--color-accent-text);
    cursor: pointer;
    transition: all 0.2s;
    text-decoration: none;

    &:hover {
      background: var(--color-accent-bg);
      border-color: var(--color-accent-border);
      text-decoration: none;
      transform: translateY(-1px);
    }
  }

  :deep(table) {
    border-spacing: 0;
    border-collapse: collapse;
    margin-bottom: 16px;
    width: 100%;

    th,
    td {
      padding: 6px 13px;
      border: 1px solid var(--color-border);
    }

    th {
      font-weight: 600;
      background-color: var(--color-bg-surface-hover);
    }

    tr:nth-child(2n) {
      background-color: var(--color-bg-surface-hover);
    }
  }

  //hr
  :deep(hr) {
    margin: 16px 0;
    border: 0;
    border-top: 1px solid var(--color-border-subtle);
  }
}

// 正在思考... 流光特效
.markdown-body.thinking-placeholder {
  :deep(p) {
    position: relative;
    display: inline-block;
    background: linear-gradient(
      90deg,
      rgba(240, 240, 240, 0.5) 0%,
      rgba(255, 255, 255, 0.8) 20%,
      #58a6ff 50%,
      rgba(255, 255, 255, 0.8) 80%,
      rgba(240, 240, 240, 0.5) 100%
    );
    background-size: 200% 100%;
    -webkit-background-clip: text;
    background-clip: text;
    -webkit-text-fill-color: transparent;
    animation: thinking-shimmer 2.5s ease-in-out infinite;
  }
}

@keyframes thinking-shimmer {
  0% {
    background-position: -200% 0;
  }
  100% {
    background-position: 200% 0;
  }
}

:deep(.inline-code),
:deep(code) {
  background: var(--color-bg-surface-hover);
  padding: 0.2em 0.4em;
  border-radius: 3px;
  font-family:
    ui-monospace,
    SFMono-Regular,
    SF Mono,
    Menlo,
    Consolas,
    Liberation Mono,
    monospace;
  font-size: 85%;
}

:deep(.code-block) {
  margin: 16px 0;
  background: var(--color-bg-surface);
  border-radius: 8px;
  overflow: hidden;
  box-shadow: inset 0 0 0 1px var(--shadow-highlight);

  pre {
    margin: 0;
    padding: 16px;
    overflow: auto;
    background: transparent;

    code {
      background: transparent;
      padding: 0;
      font-size: 100%;
      white-space: pre;
    }
  }
}

:deep(.code-header) {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  padding: 8px 12px;
  background: var(--color-bg-surface-hover);
  border-bottom: 1px solid var(--color-border-subtle);
  font-size: 12px;
  color: var(--color-text-secondary);
  justify-content: flex-end;

  .copy {
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: 4px;
    color: inherit;
    cursor: pointer;
    padding: 2px 8px;
    font-size: 12px;
    transition: all 0.2s;
    margin-left: 12px;

    &:hover {
      background: var(--color-bg-surface-hover);
      color: var(--color-text-primary);
      border-color: var(--color-border-strong);
    }
  }
}

// 使用深度选择器来样式化动态插入的图片
:deep(.markdown-image-wrapper) {
  position: relative;
  display: inline-block;
  margin: 8px 0;

  &:hover {
    .image-actions {
      opacity: 1;
      visibility: visible;
    }
  }
}

:deep(.markdown-image) {
  max-width: 100%;
  height: auto;
  border-radius: 8px;
  margin: 0;
  cursor: pointer;
  transition: transform 0.2s;
  display: block;
  background-color: transparent;
}

:deep(.markdown-image:hover) {
  // transform: scale(1.01);
  box-shadow: 0 4px 12px var(--shadow-color);
}

// 正文里只给了路径时自动补上的预览图，单独占一行
:deep(.markdown-image-preview) {
  margin: 4px 0 16px;
}

// 限制在 500px 见方以内，长宽都不裁切
:deep(.markdown-image--preview) {
  max-width: min(100%, 500px);
  max-height: 500px;
  width: auto;
  height: auto;
}

// 路径指向的文件不存在时，整块藏掉，不留一个破图占位
:deep(.markdown-image-preview:has(> .preview-failed)) {
  display: none;
}

// 正文里的视频播放器。与预览图同一套尺寸，一段回复里图和视频看起来是一路的
:deep(.markdown-video-wrapper) {
  display: block;
  margin: 8px 0;
}

:deep(.markdown-video-preview) {
  margin: 4px 0 16px;
}

:deep(.markdown-video) {
  max-width: min(100%, 500px);
  max-height: 500px;
  border-radius: 8px;
  background-color: var(--color-bg-sunken);
  display: block;
}

// 图片操作按钮容器
:deep(.image-actions) {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 6px;
  opacity: 0;
  visibility: hidden;
  transition: all 0.2s ease;
  z-index: 10;
}

// 图片操作按钮通用样式
:deep(.image-action-btn) {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: var(--color-bg-overlay);
  color: var(--color-text-on-solid);
  cursor: pointer;
  transition: all 0.2s ease;
  backdrop-filter: blur(4px);
  -webkit-app-region: no-drag;

  svg {
    width: 16px;
    height: 16px;
  }

  &:hover {
    background: var(--color-bg-overlay);
    color: var(--color-text-on-solid);
    transform: scale(1.05);
  }

  &:active {
    transform: scale(0.95);
  }

  // 成功状态
  &.success {
    background: var(--color-success-solid);
    color: var(--color-text-on-solid);
  }

  // 失败状态
  &.error {
    background: var(--color-danger-solid);
    color: var(--color-text-on-solid);
  }
}

.link-confirm-modal :deep(.app-modal__body) {
  padding: 24px;
}

.link-confirm-content {
  .confirm-text {
    margin-bottom: 16px;
    color: var(--color-text-primary);
    font-size: 14px;
    line-height: 1.6;
  }

  .link-url {
    padding: 12px;
    background: var(--color-bg-surface-hover);
    border: 1px solid var(--color-border-subtle);
    border-radius: 4px;
    color: var(--color-accent-text);
    word-break: break-all;
    font-size: 12px;
    line-height: 1.5;
  }
}
</style>
