import { readFileSync } from 'fs'
import { parse } from '@vue/compiler-sfc'
import ts from 'typescript'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { NO_VISION_MODEL_ERROR_KEY } from '@core/shared/aiNamingErrorKey'

/**
 * AIGC 模型存下来之后那次自动命名：什么时候告诉用户，什么时候闭嘴。
 *
 * 「没绑看得懂图的模型」是用户不动手就永远不会好的事，所以弹一条。
 * 网断了、余额不够、缩略图下载超时都不弹 —— 那些是一次性失败，弹出来等于
 * 说他没配置，还把他赶去一个已经填好的设置页。
 *
 * 这条分支原先只有一行日志，用户看到的是文件夹拿不到中文名、也不知道为什么。
 *
 * 不挂整个资产库：那要拖起 Pinia、虚拟滚动和一整排 IPC。按
 * `AssetThumbnailFlow.test.ts` 的办法把真的那个 handler 从 SFC 里取出来跑。
 */
function loadHandler<T>(names: string[], scope: Record<string, unknown>): T {
  const source = parse(
    readFileSync('src/renderer/src/views/AssetManagement/components/AssetFileList.vue', 'utf8')
  ).descriptor.scriptSetup!.content
  const ast = ts.createSourceFile('AssetFileList.vue', source, ts.ScriptTarget.Latest, true)
  const statements = ast.statements.filter(
    (statement) =>
      ts.isVariableStatement(statement) &&
      statement.declarationList.declarations.some((item) => names.includes(item.name.getText(ast)))
  )
  const code = ts.transpileModule(statements.map((item) => item.getText(ast)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  return new Function(...Object.keys(scope), `${code}\nreturn {${names.join(',')}}`)(
    ...Object.values(scope)
  )
}

type Complete = (payload: { assetKey: string; base64: string; folderKey?: string }) => Promise<void>

const generate3DModelName = vi.fn()
const warning = vi.fn()
const rename = vi.fn()
const refreshCurrentFolder = vi.fn()

function handler(): Complete {
  const { handleAigcThumbnailComplete } = loadHandler<{
    handleAigcThumbnailComplete: Complete
  }>(['handleAigcThumbnailComplete'], {
    dashScopeAPI: { generate3DModelName },
    message: { warning },
    t: (key: string) => key,
    NO_VISION_MODEL_ERROR_KEY,
    assetContext: { refreshCurrentFolder }
  })
  return handleAigcThumbnailComplete
}

describe('AIGC 模型的自动命名', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    // @ts-expect-error 这个 handler 只用到 preload 接口的这一截
    window.api = { database: { assetFolder: { rename } } }
  })

  it('一个看得懂图的模型都没绑时，弹一条「去绑一个」', async () => {
    generate3DModelName.mockResolvedValue({
      success: false,
      error: '没有可用的视觉模型',
      errorKey: NO_VISION_MODEL_ERROR_KEY
    })

    await handler()({ assetKey: 'a1', base64: 'AAAA', folderKey: 'f1' })

    expect(generate3DModelName).toHaveBeenCalledWith('AAAA')
    expect(warning).toHaveBeenCalledWith('assetManagement.aiNaming.noVisionModel')
    expect(rename).not.toHaveBeenCalled()
  })

  it.each([
    ['余额不足', undefined],
    ['The operation was aborted due to timeout', undefined]
  ])('别的失败一律不弹：%s', async (error, errorKey) => {
    generate3DModelName.mockResolvedValue({ success: false, error, errorKey })

    await handler()({ assetKey: 'a1', base64: 'AAAA', folderKey: 'f1' })

    expect(warning).not.toHaveBeenCalled()
    expect(rename).not.toHaveBeenCalled()
  })

  it('取到名字就带日期后缀改名，然后刷新列表，什么都不弹', async () => {
    generate3DModelName.mockResolvedValue({ success: true, name: '青铜巨像' })

    await handler()({ assetKey: 'a1', base64: 'AAAA', folderKey: 'f1' })

    const now = new Date()
    const dateStr = `${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`
    expect(rename).toHaveBeenCalledWith('f1', `青铜巨像_${dateStr}`)
    expect(refreshCurrentFolder).toHaveBeenCalledTimes(1)
    expect(warning).not.toHaveBeenCalled()
  })

  it('没有 folderKey 时压根不去调模型', async () => {
    await handler()({ assetKey: 'a1', base64: 'AAAA' })

    expect(generate3DModelName).not.toHaveBeenCalled()
  })
})
