import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'

import McpSettings from './McpSettings.vue'

/**
 * MCP 设置页。
 *
 * 这里盯两类东西：
 *
 *   1. **渐进披露**：第一次进来只该看到一个开关和一行字。端口、写工具开关、
 *      那段客户端 JSON、令牌，全部收在折叠区里。上一版把它们平铺在一屏，
 *      用户要先读完六段文字才知道该点哪儿。
 *   2. **功能没被重排弄丢**：端口用持久化的那个、非法端口不让启动、
 *      重置令牌要确认、复制的是整段配置。
 */

const status = vi.fn()
const start = vi.fn()
const stop = vi.fn()
const rotateToken = vi.fn()
const installClient = vi.fn()
const saveConfig = vi.fn()
const writeText = vi.fn().mockResolvedValue(undefined)
const getSettings = vi.fn()
const epicStatus = vi.fn()
const reconnect = vi.fn()
const blenderStatus = vi.fn()
const blenderSetup = vi.fn()
const blenderInstallPrereqs = vi.fn()
const startAgentChat = vi.fn()

vi.mock('@renderer/views/Assistant/composables/handOffToAgent', () => ({
  startAgentChat: (...args: unknown[]) => startAgentChat(...args)
}))
const showOpenDialog = vi.fn()
const removeServerIpc = vi.fn()
const saveServerIpc = vi.fn()

const TOKEN = '643fc00c1621ac16897808a3ce7551d056c9d9de127e6c6c'

const HOST_VIEW = {
  running: false,
  error: undefined as string | undefined,
  exposedTools: 0,
  url: 'http://127.0.0.1:17861/',
  // 和主进程 clientConfigSnippet() 生成的形状一致
  clientConfig: JSON.stringify(
    {
      mcpServers: {
        'unreal-box': {
          type: 'http',
          url: 'http://127.0.0.1:17861/',
          headers: { Authorization: `Bearer ${TOKEN}` }
        }
      }
    },
    null,
    2
  ),
  settings: { enabled: false, port: 17861, token: TOKEN, includeMutating: true }
}

const RUNNING = { ...HOST_VIEW, running: true, exposedTools: 69 }

/**
 * 有状态的假主进程。
 *
 * 界面在启停之后会回主进程再问一次真实状态（不信任本次操作自己回的结果），
 * 所以 `status` 不能是个固定值 —— 那样刚开起来的服务会被下一次 status
 * 打回「未启动」，测试和真实行为都对不上。
 */
let current: typeof HOST_VIEW

beforeEach(() => {
  vi.clearAllMocks()
  current = { ...HOST_VIEW }

  status.mockImplementation(async () => ({ ...current }))
  start.mockImplementation(async () => {
    current = { ...RUNNING, settings: { ...current.settings } }
    return { success: true, status: { ...current } }
  })
  stop.mockImplementation(async () => {
    current = { ...HOST_VIEW, settings: { ...current.settings } }
    return { success: true, status: { ...current } }
  })
  rotateToken.mockImplementation(async () => {
    current = {
      ...current,
      settings: { ...current.settings, token: 'tok-new' },
      clientConfig: 'Bearer tok-new'
    }
    return { success: true, status: { ...current } }
  })
  saveConfig.mockImplementation(async (patch: Record<string, unknown>) => {
    current = { ...current, settings: { ...current.settings, ...patch } }
    return { success: true, status: { ...current } }
  })

  getSettings.mockResolvedValue({
    settings: { version: 1, mcpServers: {} },
    path: 'C:/fake/mcp.json',
    statuses: []
  })
  epicStatus.mockResolvedValue({ success: true, projects: [] })
  reconnect.mockResolvedValue({ success: true, statuses: [] })
  // 默认这台机器什么都没装：一键块该给出「缺什么」而不是按钮
  blenderStatus.mockResolvedValue({
    success: true,
    status: {
      state: 'blocked',
      prerequisites: [
        { id: 'blender', ok: false, problem: 'missing' },
        { id: 'git', ok: false, problem: 'missing' },
        { id: 'python', ok: false, problem: 'missing' }
      ],
      installRoot: 'C:/fake/BlenderMcp'
    }
  })
  showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
  removeServerIpc.mockResolvedValue({
    success: true,
    settings: { version: 1, mcpServers: {} },
    statuses: []
  })
  saveServerIpc.mockResolvedValue({
    success: true,
    settings: { version: 1, mcpServers: {} },
    statuses: []
  })

  // 只替 window.api，不动 window 本身 —— 整个换掉会把 happy-dom 的
  // Event 构造器一起换没，@vue/test-utils 的 trigger 会炸在
  // 「SupportedEventInterface is not a constructor」
  window.api = {
    ...window.api,
    agentV3: {
      mcp: {
        getSettings,
        saveSettings: vi.fn(),
        reconnect,
        epicStatus,
        epicSetup: vi.fn(),
        blenderStatus,
        blenderSetup,
        blenderInstallPrereqs,
        removeServer: removeServerIpc,
        saveServer: saveServerIpc
      },
      mcpServer: { status, start, stop, rotateToken, saveConfig, installClient }
    },
    platform: 'win32',
    dialog: { showOpenDialog }
  } as unknown as typeof window.api

  // happy-dom 的 navigator.clipboard 是不可重定义的，只能打在方法上
  vi.spyOn(window.navigator.clipboard, 'writeText').mockImplementation(writeText)
})

type Wrapper = ReturnType<typeof mount>

async function mountPanel(): Promise<Wrapper> {
  const wrapper = mount(McpSettings)
  await flushPromises()
  return wrapper
}

/** 主开关：section.host 里唯一那个直接子级 setting-item 的 toggle */
async function flipMainToggle(wrapper: Wrapper): Promise<void> {
  await wrapper.find('.host [role="switch"]').trigger('click')
  await flushPromises()
}

/** 现在有两个 `.setting-row .category-open`（连接配置 / 高级），按文案挑 */
async function openDisclosure(wrapper: Wrapper, label: string): Promise<void> {
  const button = wrapper.findAll('.host .category-open').find((b) => b.text().includes(label))
  expect(button, `没找到「${label}」折叠入口`).toBeTruthy()
  await button!.trigger('click')
  await flushPromises()
}

async function openAdvanced(wrapper: Wrapper): Promise<void> {
  await openDisclosure(wrapper, '端口和权限')
}

/** 权限开关。收在「端口和权限」里，是展开后 `.host` 的第二个开关 */
async function flipScopeToggle(wrapper: Wrapper): Promise<void> {
  const toggles = wrapper.findAll('.host [role="switch"]')
  await toggles[toggles.length - 1].trigger('click')
  await flushPromises()
}

describe('渐进披露', () => {
  /**
   * 第一屏的全部内容：一个开关 + 一行说明 + 两个折叠条。
   * 多一样都是在用户还没决定开不开的时候塞信息给他。
   */
  it('服务没开时，端口、权限开关、客户端配置都不出现', async () => {
    const wrapper = await mountPanel()

    expect(wrapper.findAll('.host [role="switch"]')).toHaveLength(1)
    expect(wrapper.find('input[type="number"]').exists()).toBe(false)
    expect(wrapper.find('.config').exists()).toBe(false)
    expect(wrapper.text()).not.toContain(TOKEN)
  })

  it('可写风险警告只在展开权限设置后出现', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.find('.warning').exists()).toBe(false)

    await openAdvanced(wrapper)
    expect(wrapper.find('.warning').exists()).toBe(true)
  })

  it('切到只读时隐藏风险警告，切回可写后重新显示', async () => {
    const wrapper = await mountPanel()
    await openAdvanced(wrapper)

    await flipScopeToggle(wrapper)
    expect(wrapper.find('.warning').exists()).toBe(false)

    await flipScopeToggle(wrapper)
    expect(wrapper.find('.warning').exists()).toBe(true)
  })

  /**
   * 风险可以折起来，但不能藏在一个叫「高级」的抽屉里。
   *
   * 真正的毛病一直是**标签不预告里面有什么**，不是它折起来了。所以标题直接写
   * 「端口和权限」，当前档位挂在标题上 —— 不展开也看得见是只读还是可写。
   */
  it('折叠标题点名说出里面有权限，并把当前档位写在标题上', async () => {
    const wrapper = await mountPanel()

    const label = wrapper.findAll('.host .category-open').map((b) => b.text())
    expect(label.some((l) => l.includes('权限'))).toBe(true)
    expect(wrapper.find('.scope-tag').text()).toBe('可写')
  })

  it('端口和权限都收在折叠区里，展开才有', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.find('input[type="number"]').exists()).toBe(false)

    await openAdvanced(wrapper)

    const portInput = wrapper.find('input[type="number"]')
    expect(portInput.exists()).toBe(true)
    expect((portInput.element as HTMLInputElement).value).toBe('17861')
    expect(wrapper.findAll('.host [role="switch"]')).toHaveLength(2)
  })

  // 刚开启时用户正要去配外部客户端，这一步不该还要他自己点开
  it('开启服务后自动摊开连接配置', async () => {
    const wrapper = await mountPanel()
    await flipMainToggle(wrapper)

    expect(wrapper.find('.config').exists()).toBe(true)
    expect(wrapper.find('.config').text()).toContain('mcpServers')
  })

  /**
   * 用户报的第 3 条：「缺少复制配置、令牌等的按钮」。
   *
   * 上一版把「连接配置」这个入口塞在 `v-if="host.running"` 里面，
   * 服务没开时整块够不着。而端口和令牌是持久化的、停着也算得出来，
   * 用户的典型顺序恰恰是先配好客户端再回来开服务。
   */
  it('服务没开也能展开连接配置，拿到 JSON 和复制按钮', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.find('.dot').exists()).toBe(false)

    await openDisclosure(wrapper, '连接配置')

    expect(wrapper.find('.config').text()).toContain('mcpServers')
    const labels = wrapper.findAll('.category-body button').map((b) => b.text())
    expect(labels).toContain('复制配置')
    expect(labels).toContain('只复制令牌')
    expect(labels).toContain('重置令牌')
  })

  /**
   * 五个动作砍到三个，且只有一个是按钮。
   *
   * 原来这一排是「复制配置 / 打码令牌 / 显示 / 复制令牌 / 重置」，全都一样重，
   * 最右那个红色的「重置」还紧挨着「复制令牌」—— 而同一页里「删除」被特意推到
   * 最右、和状态胶囊隔开。破坏性动作降级成链接，并且推到最右。
   */
  it('写入 Claude Code：调主进程写配置，成功后提示文件位置', async () => {
    installClient.mockResolvedValue({ success: true, path: 'C:/Users/me/.claude.json' })
    const wrapper = await mountPanel()
    await openDisclosure(wrapper, '连接配置')

    const link = wrapper.findAll('.row-actions .link').find((b) => b.text() === '写入 Claude Code')!
    await link.trigger('click')
    await flushPromises()

    expect(installClient).toHaveBeenCalledWith('claude-code')
  })

  it('复制配置是唯一的按钮，破坏性的重置降级成最右边的链接', async () => {
    const wrapper = await mountPanel()
    await openDisclosure(wrapper, '连接配置')

    const actions = wrapper.find('.row-actions')
    expect(actions.findAll('.app-button')).toHaveLength(1)
    expect(actions.find('.app-button').text()).toBe('复制配置')

    const links = actions.findAll('.link').map((b) => b.text())
    expect(links).toEqual(['写入 Claude Code', '写入 Codex', '只复制令牌', '重置令牌'])
    expect(actions.find('.link.danger').text()).toBe('重置令牌')
  })

  /**
   * 令牌是凭据，没理由一直摊在屏幕上（身边有人、录屏、共享桌面）。
   *
   * 底下那一行单独的打码令牌拿掉了 —— 它和上面 JSON 里印的是同一把，
   * 说两遍不会更安全。现在只剩 JSON 那一份，同样打码。
   */
  it('令牌只显示头尾，完整值不出现在界面上', async () => {
    const wrapper = await mountPanel()
    await flipMainToggle(wrapper)

    const config = wrapper.find('.config').text()
    expect(config).toContain('643fc00c')
    expect(config).toContain('7e6c6c')
    expect(config).not.toContain(TOKEN)
  })

  it('运行中给出状态点和工具数', async () => {
    const wrapper = await mountPanel()
    await flipMainToggle(wrapper)

    expect(wrapper.find('.dot').exists()).toBe(true)
    expect(wrapper.text()).toContain('69')
  })

  /**
   * 面板标题和页面 Header 是同一句，重复两遍是上一版最刺眼的地方。
   *
   * 三个小标题：内置 / 手动配置 / 共享虚幻引擎能力。前两个把「盒子自己装的」
   * 和「用户自己加的」分开 —— 责任人不同，混在一张表里用户分不清哪条归谁管。
   */
  it('三组各有小标题，且都不重复页面 Header 那句', async () => {
    const wrapper = await mountPanel()
    const titles = wrapper.findAll('.section-title').map((n) => n.text())

    expect(titles).toEqual(['内置', '手动配置', '共享虚幻引擎能力'])
    for (const title of titles) expect(title).not.toContain('接入外部 MCP 服务')
  })

  // 一条 server 都没有时，「保存并连接」「重新连接」没有意义
  it('没有第三方 server 时只给「添加服务」一个按钮', async () => {
    const wrapper = await mountPanel()
    const buttons = wrapper.findAll('.manual-foot button')
    expect(buttons).toHaveLength(1)
  })

  /**
   * 空组要说一句话。
   *
   * 这一页栽过一次同样的跟头（见 `hideEpicSetup`）：什么都不渲染时，
   * 「这里本来就没有」和「坏了」长得一模一样。
   */
  it('手动配置一条都没有时给一句话，不是一片空白', async () => {
    const wrapper = await mountPanel()
    expect(wrapper.find('.manual-foot .section-note').text()).toContain('暂无手动配置的服务')
  })
})

describe('对外暴露的功能本身', () => {
  it('按持久化的端口启动', async () => {
    status.mockResolvedValue({
      ...HOST_VIEW,
      settings: { ...HOST_VIEW.settings, port: 18999, includeMutating: true }
    })
    const wrapper = await mountPanel()
    await flipMainToggle(wrapper)

    expect(start).toHaveBeenCalledWith({ includeMutating: true, port: 18999 })
  })

  it('端口非法时开关点不动 —— 否则请求发出去只会拿回一句底层报错', async () => {
    const wrapper = await mountPanel()
    await openAdvanced(wrapper)
    await wrapper.find('input[type="number"]').setValue(80)
    await flushPromises()

    expect(wrapper.find('.host [role="switch"]').attributes('disabled')).toBeDefined()
    await flipMainToggle(wrapper)
    expect(start).not.toHaveBeenCalled()
  })

  /**
   * 用户报的第 2 条：「开关只能开不能关」。
   *
   * 根因在主进程（`McpServerHost.stop()` 等一个永远不来的 close 回调，
   * 见那边的测试）。界面这边守住的是：关掉之后开关真的回到关，
   * 状态点消失 —— 而不是弹回「开」。
   */
  it('再点一次开关停止服务，开关回到关', async () => {
    const wrapper = await mountPanel()
    await flipMainToggle(wrapper)
    expect(wrapper.find('.dot').exists()).toBe(true)

    await wrapper.find('.host [role="switch"]').trigger('click')
    await flushPromises()

    expect(stop).toHaveBeenCalled()
    expect(wrapper.find('.dot').exists()).toBe(false)
    expect(wrapper.find('.host [role="switch"]').attributes('aria-checked')).toBe('false')
  })

  /**
   * 用户报的第 1 条：「配置没有持久化」。
   *
   * 端口和「开放写操作工具」原来**只有点开启时才写盘**。用户在高级里改完
   * 不点开启就切走，下次回来全变回默认值。
   */
  it('改端口后失焦就落盘，不用等点开启', async () => {
    const wrapper = await mountPanel()
    await openAdvanced(wrapper)

    const input = wrapper.find('input[type="number"]')
    await input.setValue(18888)
    await input.trigger('blur')
    await flushPromises()

    expect(saveConfig).toHaveBeenCalledWith({ port: 18888, includeMutating: true })
    expect(start).not.toHaveBeenCalled()
  })

  it('改权限档也立刻落盘', async () => {
    const wrapper = await mountPanel()
    await openAdvanced(wrapper)
    await flipScopeToggle(wrapper)

    expect(saveConfig).toHaveBeenCalledWith({ port: 17861, includeMutating: false })
  })

  it('服务运行中也能切权限，由保存接口重启并保持主开关开启', async () => {
    const wrapper = await mountPanel()
    await flipMainToggle(wrapper)
    await openAdvanced(wrapper)
    start.mockClear()

    const toggles = wrapper.findAll('.host [role="switch"]')
    expect(toggles[toggles.length - 1].attributes('disabled')).toBeUndefined()
    await flipScopeToggle(wrapper)

    expect(saveConfig).toHaveBeenCalledWith({ port: 17861, includeMutating: false })
    expect(start).not.toHaveBeenCalled()
    expect(stop).not.toHaveBeenCalled()
    expect(wrapper.find('.running-row').exists()).toBe(true)
    expect(wrapper.find('.scope-tag').text()).toBe('只读')
  })

  it('运行中切权限重启失败时显示错误和真实停服状态', async () => {
    const wrapper = await mountPanel()
    await flipMainToggle(wrapper)
    await openAdvanced(wrapper)
    saveConfig.mockImplementationOnce(async (patch: Record<string, unknown>) => {
      current = {
        ...current,
        running: false,
        error: '重启失败',
        settings: { ...current.settings, ...patch }
      }
      return { success: false, error: '重启失败', status: { ...current } }
    })

    await flipScopeToggle(wrapper)

    expect(wrapper.find('.running-row').exists()).toBe(false)
    expect(wrapper.find('.category-body .error').text()).toContain('重启失败')
    expect(wrapper.text()).not.toContain('已保存')
  })

  /**
   * 主进程比渲染层旧的时候不能整个废掉。
   *
   * 开发时改渲染层是热更新的，Electron 主进程不会跟着重启 —— 新界面配上
   * 旧主进程，`status` 里没有 `settings`，`view.settings.includeMutating`
   * 直接抛 TypeError：`load()` 挂掉、面板停在初始状态、开关按下去没反应、
   * 连接配置那块也出不来。用户报的三条症状都能由这一个异常解释。
   */
  it('主进程回的状态缺字段时，面板照样能用', async () => {
    status.mockResolvedValue({ running: false, exposedTools: 0 })
    const wrapper = await mountPanel()

    expect(wrapper.find('.host [role="switch"]').exists()).toBe(true)
    await openDisclosure(wrapper, '连接配置')
    expect(wrapper.find('.config').exists()).toBe(true)
    await openAdvanced(wrapper)
    expect((wrapper.find('input[type="number"]').element as HTMLInputElement).value).toBe('17861')
  })

  it('status 整个失败时也不把面板打挂', async () => {
    status.mockRejectedValue(new Error('IPC 没这个 handler'))
    const wrapper = await mountPanel()

    expect(wrapper.find('.host [role="switch"]').exists()).toBe(true)
    expect(wrapper.findAll('.host .category-open').length).toBe(2)
  })

  // 不信任 start/stop 自己回的结果：以主进程报的实际状态为准
  it('启停之后回主进程再确认一次真实状态', async () => {
    const wrapper = await mountPanel()
    status.mockClear()
    await flipMainToggle(wrapper)

    expect(status).toHaveBeenCalled()
  })

  // 非法端口写进去，下次开机自启会拿一个必然失败的端口
  it('端口非法时不落盘', async () => {
    const wrapper = await mountPanel()
    await openAdvanced(wrapper)

    const input = wrapper.find('input[type="number"]')
    await input.setValue(80)
    await input.trigger('blur')
    await flushPromises()

    expect(saveConfig).not.toHaveBeenCalled()
  })

  /**
   * 重置令牌会让所有已配好的外部客户端立刻失效，不能手滑触发。
   */
  it('重置令牌要先确认，取消就什么都不做', async () => {
    const wrapper = await mountPanel()
    await flipMainToggle(wrapper)
    window.confirm = vi.fn().mockReturnValue(false)

    await wrapper.find('.row-actions .link.danger').trigger('click')
    await flushPromises()
    expect(rotateToken).not.toHaveBeenCalled()
  })

  it('确认之后换新令牌，配置片段跟着更新', async () => {
    const wrapper = await mountPanel()
    await flipMainToggle(wrapper)
    window.confirm = vi.fn().mockReturnValue(true)

    await wrapper.find('.row-actions .link.danger').trigger('click')
    await flushPromises()

    expect(rotateToken).toHaveBeenCalled()
    expect(wrapper.find('.config').text()).toContain('tok-new')
  })

  it('「复制配置」复制的是整段 JSON，不是只有令牌', async () => {
    const wrapper = await mountPanel()
    await flipMainToggle(wrapper)
    await wrapper.find('.category-body button.app-button--primary').trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith(HOST_VIEW.clientConfig)
  })
})

/**
 * 上半页：接入第三方 server 的状态胶囊。
 *
 * 停用的 server 也会带一条状态回来（agent 要能区分「停用」和「没配过」），
 * 界面得跟着分开显示 —— 把用户自己关掉的东西报成「连接失败」，
 * 只会让人去排查一个根本不存在的故障。
 */
describe('第三方 server 的状态胶囊', () => {
  function withServers(statuses: unknown[]): void {
    getSettings.mockResolvedValue({
      settings: {
        version: 1,
        mcpServers: { filesystem: { type: 'stdio', command: 'npx', args: ['-y', 'srv'] } }
      },
      path: 'C:/fake/mcp.json',
      statuses
    })
  }

  it('连上时显示工具数', async () => {
    withServers([{ id: 'filesystem', connected: true, toolCount: 7 }])
    const chip = (await mountPanel()).find('.category.manual .status')

    expect(chip.classes()).toContain('ok')
    expect(chip.text()).toContain('7')
  })

  // 原因不再放 tooltip：会去排查的人不会想到悬停，见 `errorOf`
  it('连不上时显示失败，原因直接写在行下面', async () => {
    withServers([{ id: 'filesystem', connected: false, toolCount: 0, error: 'spawn npx ENOENT' }])
    const wrapper = await mountPanel()

    expect(wrapper.find('.category.manual .status').classes()).toContain('bad')
    expect(wrapper.find('.category.manual .row-error').text()).toBe('spawn npx ENOENT')
  })

  it('停用时显示「已停用」而不是「连接失败」', async () => {
    withServers([{ id: 'filesystem', connected: false, toolCount: 0, disabled: true }])
    const chip = (await mountPanel()).find('.category.manual .status')

    expect(chip.classes()).toContain('muted')
    expect(chip.classes()).not.toContain('bad')
  })

  // 保存和重连都跟着各自那一行走了，底下永远只剩「添加服务」
  it('有 server 时底部也只有「添加服务」一个按钮', async () => {
    withServers([{ id: 'filesystem', connected: true, toolCount: 1 }])
    const wrapper = await mountPanel()

    expect(wrapper.findAll('.manual-foot button')).toHaveLength(1)
  })
})

/**
 * 引擎内置工具集那一块。
 *
 * 跑得好好的时候用户什么都不用做，摊开五行只是占地方；一旦连不上，
 * 里面就有原因要看、有按钮要点 —— 那时候藏起来等于没有。
 */
describe('引擎块：好的时候一行，坏的时候摊开', () => {
  function withEngine(status: Record<string, unknown>): void {
    getSettings.mockResolvedValue({
      settings: { version: 1, mcpServers: {} },
      path: 'C:/fake/mcp.json',
      statuses: [status]
    })
  }

  it('连上时收成一行，说明和提示都不出现', async () => {
    withEngine({ id: 'ue-official', connected: true, toolCount: 3 })
    const wrapper = await mountPanel()

    expect(wrapper.find('.builtin.engine').text()).toContain('虚幻引擎')
    expect(wrapper.find('.builtin.engine .status.ok').text()).toContain('3')
    expect(wrapper.find('.builtin.engine .category-body .engine-desc').exists()).toBe(false)
    expect(wrapper.find('.builtin.engine .engine-hint').exists()).toBe(false)
  })

  it('点一下摊开，才有说明和条目', async () => {
    withEngine({ id: 'ue-official', connected: true, toolCount: 3 })
    const wrapper = await mountPanel()

    await wrapper.find('.builtin.engine .category-open').trigger('click')
    await flushPromises()

    expect(wrapper.find('.builtin.engine .category-body .engine-desc').exists()).toBe(true)
    expect(wrapper.find('.builtin.engine .category-body .engine-row').text()).toContain(
      'ue-official'
    )
  })

  /**
   * 「连接失败」四个字不带原因，用户能做的只有瞪着它。
   * 原因原来只塞在 title 里 —— 这个文件自己写过：会去排查的人不会想到悬停。
   */
  it('连不上时强制摊开，把原因原样写出来', async () => {
    withEngine({
      id: 'ue-official',
      connected: false,
      toolCount: 0,
      error: 'connect ECONNREFUSED 127.0.0.1:30069'
    })
    const wrapper = await mountPanel()

    expect(wrapper.find('.builtin.engine .status.bad').exists()).toBe(true)
    expect(wrapper.find('.builtin.engine .row-error').text()).toBe(
      'connect ECONNREFUSED 127.0.0.1:30069'
    )
  })

  it('连不上时给「重试连接」，点了就真去重连', async () => {
    withEngine({ id: 'ue-official', connected: false, toolCount: 0, error: 'boom' })
    const wrapper = await mountPanel()

    const retry = wrapper.find('.builtin.engine .category-body .actions button')
    expect(retry.text()).toBe('重试连接')
    await retry.trigger('click')
    await flushPromises()

    expect(reconnect).toHaveBeenCalled()
  })

  // 好好跑着的时候没什么可重试的
  it('连上时不给重试按钮', async () => {
    withEngine({ id: 'ue-official', connected: true, toolCount: 3 })
    const wrapper = await mountPanel()
    await wrapper.find('.builtin.engine .category-open').trigger('click')
    await flushPromises()

    expect(wrapper.find('.builtin.engine .category-body .actions').exists()).toBe(false)
  })

  // 同一条毛病，手配的那几条也犯 —— 不能只修一半
  it('手配的服务连不上时，原因也写在行下面', async () => {
    getSettings.mockResolvedValue({
      settings: { version: 1, mcpServers: { filesystem: { type: 'stdio', command: 'npx' } } },
      path: 'C:/fake/mcp.json',
      statuses: [{ id: 'filesystem', connected: false, toolCount: 0, error: 'spawn npx ENOENT' }]
    })
    const wrapper = await mountPanel()

    expect(wrapper.find('.category.manual .row-error').text()).toBe('spawn npx ENOENT')
  })
})

/**
 * 上半页的渐进披露。
 *
 * 下半页守得挺好（端口、令牌、JSON 都折起来了），上半页却整个漏掉：每条 server
 * 把四个输入框 + 两行说明永久摊在屏幕上，一条就占掉半屏。可是「改启动命令」
 * 一辈子做一两次，而**每次进这个页面都是为了看一眼它通没通**。
 */
describe('已配好的服务默认只占一行', () => {
  function withBlender(): void {
    getSettings.mockResolvedValue({
      settings: {
        version: 1,
        mcpServers: { 'dcc-bridge': { type: 'stdio', command: 'dcc-cli', env: { A: '1' } } }
      },
      path: 'C:/fake/mcp.json',
      statuses: [{ id: 'dcc-bridge', connected: true, toolCount: 26 }]
    })
  }

  it('默认收起：只有名字和状态，输入框一个都不出现', async () => {
    withBlender()
    const wrapper = await mountPanel()

    expect(wrapper.find('.category.manual .category-head').text()).toContain('dcc-bridge')
    expect(wrapper.find('.category.manual .category-head .status').text()).toContain('26')
    expect(wrapper.find('.category.manual input[type="text"]').exists()).toBe(false)
    expect(wrapper.find('.category.manual textarea').exists()).toBe(false)
  })

  it('点一下才摊开成编辑态', async () => {
    withBlender()
    const wrapper = await mountPanel()

    await wrapper.find('.category.manual .category-open').trigger('click')
    await flushPromises()

    expect(wrapper.find('.category.manual .command-input').exists()).toBe(true)
    expect(wrapper.find('.env-field').exists()).toBe(true)
  })

  it('再点一下收回去', async () => {
    withBlender()
    const wrapper = await mountPanel()

    await wrapper.find('.category.manual .category-open').trigger('click')
    await flushPromises()
    await wrapper.find('.category.manual .category-open').trigger('click')
    await flushPromises()

    expect(wrapper.find('.category.manual .command-input').exists()).toBe(false)
  })

  // 收起的行里报错等于没报错
  it('有错的行强制展开，藏不住', async () => {
    getSettings.mockResolvedValue({
      settings: {
        version: 1,
        mcpServers: { 'dcc-bridge': { type: 'stdio', command: 'x', env: { A: '1' } } }
      },
      path: 'C:/fake/mcp.json',
      statuses: [{ id: 'dcc-bridge', connected: true, toolCount: 1 }]
    })
    const wrapper = await mountPanel()
    // 写一行认不出来的环境变量
    await wrapper.find('.category.manual .category-open').trigger('click')
    await flushPromises()
    await wrapper.find('.env-field textarea').setValue('这不是环境变量')
    await flushPromises()
    // 就算这时候去点收起，也收不掉
    await wrapper.find('.category.manual .category-open').trigger('click')
    await flushPromises()

    expect(wrapper.find('.category.manual .error').exists()).toBe(true)
    expect(wrapper.find('.env-field').exists()).toBe(true)
  })

  it('存完就把编辑态收回去 —— 事办完了，屏幕该回到一行一个服务', async () => {
    withBlender()
    const wrapper = await mountPanel()
    await wrapper.find('.category.manual .category-open').trigger('click')
    await flushPromises()
    // 改一下才会出现这一行自己的保存按钮
    await wrapper.find('.category.manual .command-input').setValue('dcc-cli --transport stdio')
    await flushPromises()

    await wrapper.find('button.save-row').trigger('click')
    await flushPromises()

    expect(wrapper.find('.category.manual .command-input').exists()).toBe(false)
  })
})

/**
 * 令牌是凭据，屏幕上一处都不该有完整值。
 *
 * 底下那行头尾打码原来**完全是白做的**：同一把令牌一字不差地印在上方
 * 那块 JSON 预览里，字号还更大。屏幕上多一个人、或者正在录屏共享，
 * 泄露的是那一块。
 */
describe('令牌不摊在屏幕上', () => {
  it('预览里的令牌也打码，不是只有底下那行', async () => {
    const wrapper = await mountPanel()
    await openDisclosure(wrapper, '连接配置')

    const preview = wrapper.find('.config').text()
    expect(preview).toContain('mcpServers')
    expect(preview).not.toContain(TOKEN)
    expect(preview).toContain('643fc00c')
  })

  it('点「显示」才给完整值，这是一个明确的动作', async () => {
    const wrapper = await mountPanel()
    await openDisclosure(wrapper, '连接配置')

    await wrapper.find('.config-wrap .reveal').trigger('click')
    await flushPromises()

    expect(wrapper.find('.config').text()).toContain(TOKEN)
  })

  // 打码是给眼睛看的，不能影响粘贴
  it('打码状态下复制到的仍然是完整配置', async () => {
    const wrapper = await mountPanel()
    await openDisclosure(wrapper, '连接配置')
    await wrapper.find('.category-body button.app-button--primary').trigger('click')
    await flushPromises()

    expect(writeText).toHaveBeenCalledWith(HOST_VIEW.clientConfig)
  })

  it('换了新令牌就收回明文 —— 上次「显示」是针对旧令牌的决定', async () => {
    const wrapper = await mountPanel()
    await openDisclosure(wrapper, '连接配置')
    await wrapper.find('.config-wrap .reveal').trigger('click')
    await flushPromises()

    window.confirm = vi.fn().mockReturnValue(true)
    await wrapper.find('.row-actions .link.danger').trigger('click')
    await flushPromises()

    expect(wrapper.find('.config-wrap .reveal').text()).toBe('显示')
  })
})

/**
 * 每条服务各存各的。
 *
 * 原来是页面底部一个总的「保存并连接」，于是几条互不相干的服务被绑成一件事：
 * 改 dcc-bridge 的时候顺手把另一条半填的也提交了，另一条填错了 dcc-bridge 这条
 * 也存不了。
 */
describe('按行保存', () => {
  function withTwo(): void {
    getSettings.mockResolvedValue({
      settings: {
        version: 1,
        mcpServers: {
          'dcc-bridge': { type: 'stdio', command: 'dcc-cli' },
          filesystem: { type: 'stdio', command: 'npx' }
        }
      },
      path: 'C:/fake/mcp.json',
      statuses: [
        { id: 'dcc-bridge', connected: true, toolCount: 26 },
        { id: 'filesystem', connected: true, toolCount: 7 }
      ]
    })
  }

  async function editRow(wrapper: Wrapper, at: number, command: string): Promise<void> {
    await wrapper
      .findAll('.category.manual')
      [at].find('.category.manual .category-open')
      .trigger('click')
    await flushPromises()
    await wrapper
      .findAll('.category.manual')
      [at].find('.category.manual .command-input')
      .setValue(command)
    await flushPromises()
  }

  // 没改过的行摆一个保存按钮，既是噪音，点下去也什么都不会发生
  it('只有改过的那一行才长出保存按钮', async () => {
    withTwo()
    const wrapper = await mountPanel()
    expect(wrapper.findAll('button.save-row')).toHaveLength(0)

    await editRow(wrapper, 0, 'dcc-cli --transport stdio')

    const rows = wrapper.findAll('.category.manual')
    expect(rows[0].find('button.save-row').exists()).toBe(true)
    expect(rows[1].find('button.save-row').exists()).toBe(false)
  })

  it('存的时候只把这一条递下去，不碰另一条', async () => {
    withTwo()
    const wrapper = await mountPanel()
    await editRow(wrapper, 0, 'dcc-cli --transport stdio')

    await wrapper.find('button.save-row').trigger('click')
    await flushPromises()

    expect(saveServerIpc).toHaveBeenCalledTimes(1)
    const [args] = saveServerIpc.mock.calls[0]
    expect(args.id).toBe('dcc-bridge')
    expect(args.config.command).toBe('dcc-cli')
    expect(args.config.args).toEqual(['--transport', 'stdio'])
  })

  /**
   * 改名会在盘上留下一条旧的：用新 id 写进去，旧 id 那条还躺在 mcp.json 里，
   * 下次打开面板它又冒出来。所以存的时候要把旧名字一起递下去。
   */
  it('改过名的行把旧名字一起递下去，好让主进程删掉旧的那条', async () => {
    withTwo()
    const wrapper = await mountPanel()
    await wrapper
      .findAll('.category.manual')[0]
      .find('.category.manual .category-open')
      .trigger('click')
    await flushPromises()
    await wrapper.findAll('.category.manual')[0].find('.id-field input').setValue('dcc-bridge-52')
    await flushPromises()

    await wrapper.find('button.save-row').trigger('click')
    await flushPromises()

    const [args] = saveServerIpc.mock.calls[0]
    expect(args.id).toBe('dcc-bridge-52')
    expect(args.renamedFrom).toBe('dcc-bridge')
  })

  // 信任是对这一个 server 的放宽：勾上要能存下去，而且只写进这一条
  it('勾上「信任此服务器」：长出保存按钮，存下去的配置带 trusted', async () => {
    withTwo()
    const wrapper = await mountPanel()
    await wrapper
      .findAll('.category.manual')[1]
      .find('.category.manual .category-open')
      .trigger('click')
    await flushPromises()
    await wrapper
      .findAll('.category.manual')[1]
      .find('.trust-checkbox [role="checkbox"]')
      .trigger('click')
    await flushPromises()

    await wrapper.find('button.save-row').trigger('click')
    await flushPromises()

    const [args] = saveServerIpc.mock.calls[0]
    expect(args.id).toBe('filesystem')
    expect(args.config.trusted).toBe(true)
  })

  it('存失败时把主进程给的原因显示出来', async () => {
    withTwo()
    saveServerIpc.mockResolvedValue({ success: false, error: 'EPERM: mcp.json 被占用' })
    const wrapper = await mountPanel()
    await editRow(wrapper, 0, 'dcc-cli --transport stdio')

    await wrapper.find('button.save-row').trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('EPERM: mcp.json 被占用')
  })
})

/**
 * 删除是这一页唯一**立刻落盘**的编辑。
 *
 * 其余的改动都要点「保存并连接」，删除原来也一样 —— 于是用户点了删除、
 * 看见那行消失了、切回来发现它还在，只能判断成「删除坏了」。确认弹窗还写着
 * 「不能撤销」，更坐实了这个误解。按下确认的那一刻事情就该办完。
 */
describe('删除当场落盘', () => {
  function withServers(): void {
    getSettings.mockResolvedValue({
      settings: {
        version: 1,
        mcpServers: {
          'dcc-bridge': { type: 'stdio', command: 'dcc-cli' },
          filesystem: { type: 'stdio', command: 'npx' }
        }
      },
      path: 'C:/fake/mcp.json',
      statuses: [
        { id: 'dcc-bridge', connected: true, toolCount: 26 },
        { id: 'filesystem', connected: true, toolCount: 7 }
      ]
    })
  }

  async function clickRemove(wrapper: Wrapper, at = 0): Promise<void> {
    await wrapper.findAll('.category.manual .link.danger')[at].trigger('click')
    await flushPromises()
  }

  it('确认之后立刻写盘，不用再点保存', async () => {
    withServers()
    window.confirm = vi.fn().mockReturnValue(true)
    const wrapper = await mountPanel()

    await clickRemove(wrapper)

    expect(removeServerIpc).toHaveBeenCalledWith({ id: 'dcc-bridge' })
    // 走的是专门的删除通道，只摘掉这一个键，盘上别的条目原样不动
    expect(saveServerIpc).not.toHaveBeenCalled()
  })

  it('取消就什么都不做，行也留着', async () => {
    withServers()
    window.confirm = vi.fn().mockReturnValue(false)
    const wrapper = await mountPanel()

    await clickRemove(wrapper)

    expect(removeServerIpc).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('dcc-bridge')
  })

  // 盘上本来就没有它，跑一趟 IPC 纯属多余
  it('没保存过的新行直接删掉，不碰盘', async () => {
    withServers()
    window.confirm = vi.fn().mockReturnValue(true)
    const wrapper = await mountPanel()

    await wrapper
      .findAll('button')
      .find((b) => b.text() === '添加服务')!
      .trigger('click')
    await flushPromises()
    const rows = wrapper.findAll('.category.manual .link.danger')
    await rows[rows.length - 1].trigger('click')
    await flushPromises()

    expect(removeServerIpc).not.toHaveBeenCalled()
  })

  /**
   * 删完那条已经在盘上没了，剩下那条没改过，所以一个保存按钮都不该冒出来 ——
   * 基准线按**盘上现在的内容**重算，不是按表单现在的样子。
   */
  it('删完之后剩下那条不该跟着亮「保存」', async () => {
    withServers()
    window.confirm = vi.fn().mockReturnValue(true)
    removeServerIpc.mockResolvedValue({
      success: true,
      settings: {
        version: 1,
        mcpServers: { filesystem: { type: 'stdio', command: 'npx' } }
      },
      statuses: [{ id: 'filesystem', connected: true, toolCount: 7 }]
    })
    const wrapper = await mountPanel()

    await clickRemove(wrapper)
    expect(wrapper.find('button.save-row').exists()).toBe(false)

    // 再去改剩下那行：这回该出现它自己的保存按钮
    await wrapper.find('.category.manual .category-open').trigger('click')
    await flushPromises()
    await wrapper.find('.category.manual .command-input').setValue('npx -y something-else')
    await flushPromises()
    expect(wrapper.find('button.save-row').exists()).toBe(true)
  })

  it('主进程删失败时把原因显示出来', async () => {
    withServers()
    window.confirm = vi.fn().mockReturnValue(true)
    removeServerIpc.mockResolvedValue({ success: false, error: 'EPERM: mcp.json 被占用' })
    const wrapper = await mountPanel()

    await clickRemove(wrapper)

    expect(wrapper.text()).toContain('EPERM: mcp.json 被占用')
  })
})

/**
 * 空行的那条规则。
 *
 * 点「添加服务」立刻蹦一句「标识不能为空」，那条红字原来还会把总的
 * 「保存并连接」整个禁掉 —— 用户连**刚在另一行改好的东西**都存不了。
 * 现在按行存，一行填坏挡不住别的行；但「加了没填就等于没加」这条语义
 * 仍然要守住，否则一个空行会一直亮着红字。
 */
describe('新增行不该立刻报错、更不该挡住别的行', () => {
  function withOneServer(): void {
    getSettings.mockResolvedValue({
      settings: {
        version: 1,
        mcpServers: { 'dcc-bridge': { type: 'stdio', command: 'dcc-cli' } }
      },
      path: 'C:/fake/mcp.json',
      statuses: [{ id: 'dcc-bridge', connected: true, toolCount: 26 }]
    })
  }

  async function clickAdd(wrapper: Wrapper): Promise<void> {
    await wrapper.findAll('.manual-foot button')[0].trigger('click')
    await flushPromises()
  }

  it('刚加出来的空行不报「标识不能为空」', async () => {
    withOneServer()
    const wrapper = await mountPanel()
    await clickAdd(wrapper)

    expect(wrapper.findAll('.category.manual')).toHaveLength(2)
    expect(wrapper.find('.category.manual .error').exists()).toBe(false)
  })

  // 一行填坏了是它自己的事，别的行照样能存
  it('填坏的那行不挡住另一行的保存', async () => {
    withOneServer()
    const wrapper = await mountPanel()
    await clickAdd(wrapper)
    // 新行填了命令没填标识 —— 它自己是错的
    await wrapper
      .findAll('.category.manual')[1]
      .find('.category.manual .command-input')
      .setValue('npx -y some-server')
    // 老那行也改一下，让它出现自己的保存按钮
    await wrapper
      .findAll('.category.manual')[0]
      .find('.category.manual .category-open')
      .trigger('click')
    await flushPromises()
    await wrapper
      .findAll('.category.manual')[0]
      .find('.category.manual .command-input')
      .setValue('dcc-cli --x')
    await flushPromises()

    const rows = wrapper.findAll('.category.manual')
    expect(rows[0].find('button.save-row').attributes('disabled')).toBeUndefined()
    expect(rows[1].find('button.save-row').attributes('disabled')).toBeDefined()
  })

  // 填了一半才算错 —— 这时候用户确实漏了东西
  it('填了命令却没填标识才报错', async () => {
    withOneServer()
    const wrapper = await mountPanel()
    await clickAdd(wrapper)
    await wrapper
      .findAll('.category.manual')[1]
      .find('.category.manual .command-input')
      .setValue('npx -y some-server')
    await flushPromises()

    expect(wrapper.find('.category.manual .error').text()).toContain('标识')
  })

  // 空行盘上没有，也没什么可存的，不该给它一个保存按钮
  it('空行没有保存按钮', async () => {
    withOneServer()
    const wrapper = await mountPanel()
    await clickAdd(wrapper)

    expect(wrapper.findAll('.category.manual')[1].find('button.save-row').exists()).toBe(false)
  })
})

/**
 * 用户报的：「打开了 5.8 工程、也开了 MCP 插件，顶部那块反而不见了」。
 *
 * 根因是两块的判据来自两份不同步的数据：一键块看的是**每次实时探端口**的
 * `epicStatus`，自动发现块看的是 MCP manager **上次连接时的快照** `statuses`。
 * 用户开着盒子再去打开工程时两者必然错位 —— 一键块因为「已经好了」收起，
 * 自动发现块因为「还不知道好了」不出现，中间一片没有任何解释的空白。
 */
describe('一键块和自动发现块的交接', () => {
  const READY_PROJECT = {
    connectionId: 'c1',
    projectName: 'BIKEOUT',
    state: 'ready' as const,
    missingPlugins: [],
    autoStartEnabled: true,
    url: 'http://127.0.0.1:30069/mcp'
  }

  it('引擎已开启但盒子还没连上时，一键块不许消失', async () => {
    epicStatus.mockResolvedValue({ success: true, projects: [READY_PROJECT] })
    const wrapper = await mountPanel()

    // 至少要有一处在说话，否则用户看到的就是「坏了」
    expect(wrapper.find('.builtin.engine').exists()).toBe(true)
    expect(wrapper.find('.builtin.engine .category-body').text()).toContain('BIKEOUT')
  })

  /**
   * 两块合成一行之后，「收起来」的含义变了：行永远在，收起的是摊开的内容。
   * 判据还是同一条 —— 真连上了就没有要办的事，行右端报连接状态即可。
   */
  it('真连上之后那一行收起来，只报连接状态', async () => {
    epicStatus.mockResolvedValue({ success: true, projects: [READY_PROJECT] })
    getSettings.mockResolvedValue({
      settings: { version: 1, mcpServers: {} },
      path: 'C:/fake/mcp.json',
      statuses: [{ id: 'ue-official', connected: true, toolCount: 3 }]
    })
    const wrapper = await mountPanel()

    expect(wrapper.find('.builtin.engine .category-body').exists()).toBe(false)
    expect(wrapper.find('.builtin.engine .status.ok').text()).toContain('3')
  })

  /**
   * `currentStatuses()` 只在 agent 跑过或用户手点「重新连接」时更新，没有任何东西
   * 会因为「用户刚打开了工程」去重新发现。不自动补的话，用户得自己猜到去点那个
   * 跟引擎看起来毫无关系的按钮。
   */
  it('探到已开启、缓存里却没有引擎 server 时自动补一次重连', async () => {
    epicStatus.mockResolvedValue({ success: true, projects: [READY_PROJECT] })
    reconnect.mockResolvedValue({
      success: true,
      statuses: [{ id: 'ue-official', connected: true, toolCount: 3 }]
    })
    const wrapper = await mountPanel()

    expect(reconnect).toHaveBeenCalled()
    // 补上之后行右端就报「已连接」，摊开的内容随之收起
    expect(wrapper.find('.builtin.engine .category-body').exists()).toBe(false)
    expect(wrapper.find('.builtin.engine .status.ok').exists()).toBe(true)
  })

  it('缓存里已经有引擎 server 就不多此一举地重连', async () => {
    epicStatus.mockResolvedValue({ success: true, projects: [READY_PROJECT] })
    getSettings.mockResolvedValue({
      settings: { version: 1, mcpServers: {} },
      path: 'C:/fake/mcp.json',
      statuses: [{ id: 'ue-official', connected: true, toolCount: 3 }]
    })
    await mountPanel()

    expect(reconnect).not.toHaveBeenCalled()
  })

  it('还没开好的项目照旧给按钮，不受影响', async () => {
    epicStatus.mockResolvedValue({
      success: true,
      projects: [{ ...READY_PROJECT, state: 'needs-plugins' }]
    })
    const wrapper = await mountPanel()

    // 只有一个项目可操作时，按钮就摆在行右端 —— 藏进摊开的里面等于它不存在
    expect(wrapper.find('.builtin.engine .row-action').exists()).toBe(true)
    expect(reconnect).not.toHaveBeenCalled()
  })
})

/**
 * 一键接入 Blender。
 *
 * 和引擎那块是同一个病、同一条对策：手工流程四道关（装 git/Python、跑安装
 * 脚本、手填一长串绝对路径、再手填三行环境变量），走完的用户几乎没有。
 * 走不完就等于这个能力不存在 —— 真机上模型因此回过一句「我没有连 Blender
 * 的工具」，而设置页里就摆着这个按钮。
 */
/**
 * Blender 是内置的一条，不是手动配置的一条。
 *
 * 它原来在页面上**出现两次**：上面一块「一键接入」的安装卡片，下面「手动配置
 * 的服务」里还有一条可编辑的 `blender` —— 而那条恰恰是安装卡片自己写进
 * `mcp.json` 的。用户看到的是同一个东西的两个身份，而且下面那条长得和随手加的
 * 第三方服务一模一样，看不出它归盒子管、坏了该去点「重新安装」。
 */
describe('装好的 Blender 归内置组', () => {
  const installed = {
    settings: {
      version: 1,
      mcpServers: {
        blender: {
          type: 'stdio' as const,
          command: 'C:/box/BlenderMcp/venv/Scripts/blender-mcp.exe',
          args: ['--transport', 'stdio'],
          env: {
            BLENDER_MCP_PORT: '9876',
            BLENDER_PATH: 'H:/Game/Blender/blender.exe',
            BLENDER_MCP_HOST: '127.0.0.1'
          }
        }
      }
    },
    path: 'C:/fake/mcp.json',
    statuses: [{ id: 'blender', connected: true, toolCount: 26 }]
  }

  const configuredStatus = {
    success: true,
    status: {
      state: 'configured' as const,
      prerequisites: [],
      installRoot: '/x',
      configuredBlenderPath: 'H:/Game/Blender/blender.exe',
      configuredServerId: 'blender'
    }
  }

  beforeEach(() => {
    getSettings.mockResolvedValue(installed)
    blenderStatus.mockResolvedValue(configuredStatus)
  })

  it('只出现在内置那一组，手动配置里没有它', async () => {
    const wrapper = await mountPanel()

    expect(wrapper.find('.builtin.blender').text()).toContain('Blender')
    expect(wrapper.findAll('.category.manual')).toHaveLength(0)
    expect(wrapper.find('.manual-foot .section-note').exists()).toBe(true)
  })

  /**
   * 标识、连接方式、启动命令都是盒子自己写的，给输入框只会让用户改坏一条
   * 本来好好的配置。真正会变的只有两样：Blender 装在哪、端口多少 ——
   * 而它们原来埋在一块三行的 KEY=VALUE 文本里，得先知道有这两个键才改得动。
   */
  it('默认只给「装在哪」和「端口」两个字段，值从环境变量里取', async () => {
    const wrapper = await mountPanel()
    await wrapper.find('.builtin.blender .category-open').trigger('click')
    await flushPromises()

    const inputs = wrapper.findAll('.builtin.blender .category-body input')
    expect(inputs).toHaveLength(2)
    expect((inputs[0].element as HTMLInputElement).value).toBe('H:/Game/Blender/blender.exe')
    expect((inputs[1].element as HTMLInputElement).value).toBe('9876')
    // 启动命令和整块环境变量都收在「高级」后面
    expect(wrapper.find('.builtin.blender .category-body textarea').exists()).toBe(false)
  })

  /**
   * 改路径只动 BLENDER_PATH 那一行。整段重写会把这个面板没在意的键一起抹掉 ——
   * 这一页已经因为「悄悄丢配置」出过一次事。
   */
  it('改路径只动那一个键，别的环境变量原样留着', async () => {
    const wrapper = await mountPanel()
    await wrapper.find('.builtin.blender .category-open').trigger('click')
    await flushPromises()

    await wrapper
      .findAll('.builtin.blender .category-body input')[0]
      .setValue('D:/portable/blender.exe')
    await flushPromises()

    // 「高级」里那块原文是唯一能看到全部键的地方
    await wrapper
      .findAll('.builtin.blender .category-body .row-actions .link')
      .find((b) => b.text().includes('高级'))!
      .trigger('click')
    await flushPromises()

    const env = wrapper.find('.builtin.blender .category-body .env-field textarea')
      .element as HTMLTextAreaElement
    expect(env.value).toContain('BLENDER_PATH=D:/portable/blender.exe')
    expect(env.value).toContain('BLENDER_MCP_HOST=127.0.0.1')
    expect(env.value).toContain('BLENDER_MCP_PORT=9876')
  })

  // 逃生口要留着：排障时得够得着盒子到底写了什么
  it('「高级」调得出启动命令和完整环境变量', async () => {
    const wrapper = await mountPanel()
    await wrapper.find('.builtin.blender .category-open').trigger('click')
    await flushPromises()

    await wrapper
      .findAll('.builtin.blender .category-body .row-actions .link')
      .find((b) => b.text().includes('高级'))!
      .trigger('click')
    await flushPromises()

    const command = wrapper.find('.builtin.blender .category-body .command-input')
      .element as HTMLTextAreaElement
    expect(command.value).toContain('blender-mcp.exe')
  })

  /**
   * 整块 JSON 的写法也得认。按行改一个 `KEY=VALUE` 进去会写出一段两种语法
   * 混着的东西，`parseEnvText` 从此整段算无效 —— 用户改了个路径，结果整组
   * 环境变量静默消失，症状是「连上了、工具也在、一调就失败」。
   */
  it('环境变量是整块 JSON 时，改路径不把它改坏', async () => {
    getSettings.mockResolvedValue({
      ...installed,
      settings: {
        version: 1,
        mcpServers: {
          blender: {
            ...installed.settings.mcpServers.blender,
            env: { BLENDER_PATH: 'H:/Game/Blender/blender.exe', BLENDER_MCP_HOST: '127.0.0.1' }
          }
        }
      }
    })
    const wrapper = await mountPanel()
    await wrapper.find('.builtin.blender .category-open').trigger('click')
    await flushPromises()

    // 先切成 JSON 写法，再从上面的路径框改一次
    const env = wrapper.find('.builtin.blender .category-body input')
    await wrapper
      .findAll('.builtin.blender .category-body .row-actions .link')
      .find((b) => b.text().includes('高级'))!
      .trigger('click')
    await flushPromises()
    await wrapper
      .find('.builtin.blender .category-body .env-field textarea')
      .setValue('{ "BLENDER_PATH": "H:/old.exe", "BLENDER_MCP_HOST": "127.0.0.1" }')
    await env.setValue('D:/portable/blender.exe')
    await flushPromises()

    const text = (
      wrapper.find('.builtin.blender .category-body .env-field textarea')
        .element as HTMLTextAreaElement
    ).value
    expect(JSON.parse(text)).toEqual({
      BLENDER_PATH: 'D:/portable/blender.exe',
      BLENDER_MCP_HOST: '127.0.0.1'
    })
  })

  // 改了才长出保存按钮 —— 没改过的按钮点下去什么都不会发生
  it('改过之后才长出保存，存的是这一条', async () => {
    const wrapper = await mountPanel()
    await wrapper.find('.builtin.blender .category-open').trigger('click')
    await flushPromises()
    expect(wrapper.find('.builtin.blender .category-body .save-row').exists()).toBe(false)

    await wrapper.findAll('.builtin.blender .category-body input')[1].setValue('9999')
    await flushPromises()

    await wrapper.find('.builtin.blender .category-body .save-row').trigger('click')
    await flushPromises()

    const args = saveServerIpc.mock.calls[0][0]
    expect(args.id).toBe('blender')
    expect(args.config.env.BLENDER_MCP_PORT).toBe('9999')
  })
})

describe('一键接入 Blender', () => {
  const ready = {
    success: true,
    status: {
      state: 'ready' as const,
      prerequisites: [
        { id: 'blender' as const, ok: true, found: 'Blender 5.2', path: 'C:/b/blender.exe' },
        { id: 'git' as const, ok: true },
        { id: 'python' as const, ok: true }
      ],
      blenderPath: 'C:/b/blender.exe',
      installRoot: 'C:/fake/BlenderMcp'
    }
  }

  /** 安装按钮在行右端 —— 这一块存在的理由就是这一下点击，不藏进摊开的里面 */
  const installButton = (wrapper: Wrapper): ReturnType<Wrapper['find']> =>
    wrapper.find('.builtin.blender .row-action')

  /** 「选择…」在摊开的里面：点之前要先看见要用哪个 Blender、缺什么 */
  const chooseButton = (wrapper: Wrapper): ReturnType<Wrapper['find']> =>
    wrapper.find('.builtin.blender .category-body button')

  it('前置齐了就给一个能点的按钮，并显示要用哪个 Blender', async () => {
    blenderStatus.mockResolvedValue(ready)
    const wrapper = await mountPanel()

    expect(installButton(wrapper).attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.builtin.blender .category-body').text()).toContain('blender.exe')
  })

  // 缺什么要逐条点名。合成一句「环境不满足」正是安装脚本原来的失败样子
  // （一句 Command failed: git），用户看不出要去装什么
  it('缺前置时逐条说明缺哪个', async () => {
    const wrapper = await mountPanel()
    const block = wrapper.find('.builtin.blender .category-body')

    expect(block.text()).toContain('Git')
    expect(block.text()).toContain('Python')
  })

  /**
   * 缺 Git / Python 时主按钮换成「安装 Git 和 Python」。给一个点不了的「一键接入」
   * 加一句「请先去 git-scm.com 下载」，等于把运维活甩给用户。
   */
  it('Windows 上缺 Git / Python 时，主按钮直接替用户装', async () => {
    blenderInstallPrereqs.mockResolvedValue({ success: true, message: '' })
    const wrapper = await mountPanel()

    expect(installButton(wrapper).text()).toBe('安装 Git 和 Python')
    expect(installButton(wrapper).attributes('disabled')).toBeUndefined()
    // 管理员确认框只有用户能点，点之前就要说
    expect(wrapper.find('.builtin.blender .category-body').text()).toContain('管理员权限')

    await installButton(wrapper).trigger('click')
    await flushPromises()

    expect(blenderInstallPrereqs).toHaveBeenCalledWith({ ids: ['git', 'python'] })
    // 装完重新探一次，让界面跟着翻到下一步
    expect(blenderStatus).toHaveBeenCalledTimes(2)
    expect(wrapper.find('.builtin.blender .category-body').text()).toContain('Git 和 Python 已安装')
  })

  it('macOS 上没有 winget，不给安装按钮', async () => {
    window.api = { ...window.api, platform: 'darwin' } as typeof window.api
    const wrapper = await mountPanel()

    expect(installButton(wrapper).text()).toBe('一键接入')
    expect(installButton(wrapper).attributes('disabled')).toBeDefined()
  })

  // 没失败过时「交给 AI 排查」只是噪音；失败了才出现，并把 winget 原话带过去
  it('自动安装失败后才出现「交给 AI 排查」，原话交给 AI', async () => {
    blenderInstallPrereqs.mockResolvedValue({
      success: false,
      message: '安装 Git 未完成（winget 退出码 0x8A150014）。',
      error: 'winget install Git.Git exited with 0x8A150014'
    })
    const wrapper = await mountPanel()
    const askAi = (): ReturnType<Wrapper['find']> | undefined =>
      wrapper
        .findAll('.builtin.blender .category-body button')
        .find((b) => b.text() === '交给 AI 排查')

    expect(askAi()).toBeUndefined()

    await installButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.find('.builtin.blender .category-body').text()).toContain('0x8A150014')
    await askAi()!.trigger('click')

    const [prompt, prefix] = startAgentChat.mock.calls[0]
    expect(prefix).toBe('blender-prereqs')
    expect(prompt).toContain('Git 和 Python')
    expect(prompt).toContain('winget install Git.Git exited with 0x8A150014')
  })

  /**
   * 自动探测只认官方安装器和 Steam 的标准位置。便携版、装在 D 盘、放在网络盘
   * 上的都探不到 —— 没有这条出路，那些用户看到的是一个永远点不了的按钮加一句
   * 「没找到 Blender」。
   */
  it('探不到 Blender 时，用户自己指一个就能装', async () => {
    blenderStatus.mockResolvedValue({
      success: true,
      status: {
        state: 'blocked',
        prerequisites: [
          { id: 'blender', ok: false, problem: 'missing' },
          { id: 'git', ok: true },
          { id: 'python', ok: true }
        ],
        installRoot: 'C:/fake/BlenderMcp'
      }
    })
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['D:/portable/blender.exe'] })
    blenderSetup.mockResolvedValue({ success: true, message: '已接入 Blender。', statuses: [] })
    const wrapper = await mountPanel()

    expect(installButton(wrapper).attributes('disabled')).toBeDefined()

    await chooseButton(wrapper).trigger('click')
    await flushPromises()

    // 用户亲手指出来的文件，不该再被「探测没探到」否决
    expect(installButton(wrapper).attributes('disabled')).toBeUndefined()
    expect(wrapper.find('.builtin.blender .category-body').text()).toContain(
      'D:/portable/blender.exe'
    )

    await installButton(wrapper).trigger('click')
    await flushPromises()
    expect(blenderSetup).toHaveBeenCalledWith({ blenderPath: 'D:/portable/blender.exe' })
  })

  it('取消选择不改动已经探到的那个', async () => {
    blenderStatus.mockResolvedValue(ready)
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    const wrapper = await mountPanel()

    await chooseButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.find('.builtin.blender .category-body').text()).toContain('C:/b/blender.exe')
  })

  // 空白不是「没有噪音」，空白是「看起来坏了」—— 这一课引擎那块已经上过一遍
  it('平台不支持时不给按钮，但要说出原因', async () => {
    blenderStatus.mockResolvedValue({
      success: true,
      status: { state: 'unsupported', prerequisites: [], installRoot: '/x' }
    })
    const wrapper = await mountPanel()
    const block = wrapper.find('.builtin.blender .category-body')

    expect(block.exists()).toBe(true)
    expect(installButton(wrapper).exists()).toBe(false)
    expect(block.text()).toContain('Windows')
  })

  const configured = {
    success: true,
    status: {
      state: 'configured' as const,
      prerequisites: [],
      installRoot: '/x',
      configuredBlenderPath: 'C:/b/blender.exe',
      configuredServerId: 'blender'
    }
  }

  /**
   * 配好而且连上了，这一行就没有要办的事：收成一行，右端报连接状态。
   * 「一键接入」也不再出现 —— 已经接上了，那个按钮此刻只会让人以为没装好。
   */
  it('配好而且连上了就收成一行，只报连接状态', async () => {
    blenderStatus.mockResolvedValue(configured)
    getSettings.mockResolvedValue({
      settings: { version: 1, mcpServers: {} },
      path: 'C:/fake/mcp.json',
      statuses: [{ id: 'blender', connected: true, toolCount: 26 }]
    })
    const wrapper = await mountPanel()

    expect(wrapper.find('.builtin.blender .category-body').exists()).toBe(false)
    expect(installButton(wrapper).exists()).toBe(false)
    expect(wrapper.find('.builtin.blender .status.ok').text()).toContain('26')
  })

  /**
   * 配置还在、桥已经死了，正是「再点一次修一修」唯一有用的时候 ——
   * 而第一版恰好在这时候把唯一能调它的按钮藏了起来。真会发生：插件装在
   * Blender 5.1 的扩展目录里，用户升到 5.2 之后扩展是分版本存的，桥就没了。
   */
  it('配好了但没连上时，按钮必须还在 —— 那是修复的唯一入口', async () => {
    blenderStatus.mockResolvedValue(configured)
    getSettings.mockResolvedValue({
      settings: { version: 1, mcpServers: {} },
      path: 'C:/fake/mcp.json',
      statuses: [{ id: 'blender', connected: false, toolCount: 0, error: 'boom' }]
    })
    const wrapper = await mountPanel()

    expect(installButton(wrapper).exists()).toBe(true)
    // 有事要办就强制摊开，否则原因和前置都藏在收起的那一行里
    expect(wrapper.find('.builtin.blender .category-body').exists()).toBe(true)
  })

  /**
   * 装成功那一刻 `hideBlenderSetup` 会翻真，把整块连同刚写好的回执一起卸掉。
   * 回执得活过这一下 —— 丢掉的偏偏是别处没有的那句「盒子会自己把 Blender
   * 拉起来，不用手动开」。
   */
  it('装成功之后那句回执还得看得见 —— 行不许跟着自动收起', async () => {
    blenderStatus.mockResolvedValueOnce(ready).mockResolvedValue(configured)
    blenderSetup.mockResolvedValue({
      success: true,
      message: '已接入 Blender。盒子会自己把它拉起来。',
      statuses: [{ id: 'blender', connected: true, toolCount: 26 }]
    })
    getSettings.mockResolvedValue({
      settings: { version: 1, mcpServers: {} },
      path: 'C:/fake/mcp.json',
      statuses: [{ id: 'blender', connected: true, toolCount: 26 }]
    })
    const wrapper = await mountPanel()

    await installButton(wrapper).trigger('click')
    await flushPromises()

    expect(installButton(wrapper).exists()).toBe(false)
    expect(wrapper.find('.builtin.blender .category-body').text()).toContain(
      '已接入 Blender。盒子会自己把它拉起来。'
    )
  })

  /**
   * 配置是主进程直接写进 `mcp.json` 的，表单里那份还是旧的。
   * 不重读的话，用户在这一页点一下保存就会把刚装好的那条又抹掉。
   */
  it('装成功之后重读配置，不让表单里的旧快照把新配置写没', async () => {
    blenderStatus.mockResolvedValue(ready)
    blenderSetup.mockResolvedValue({ success: true, message: '已接入 Blender。', statuses: [] })
    const wrapper = await mountPanel()

    getSettings.mockClear()
    await installButton(wrapper).trigger('click')
    await flushPromises()

    expect(blenderSetup).toHaveBeenCalledWith({ blenderPath: 'C:/b/blender.exe' })
    expect(getSettings).toHaveBeenCalled()
  })

  // 主进程才知道这次是装好了、缺前置、还是脚本自己挂了，渲染层照 state 猜会对不上
  it('失败时把主进程那句话原样显示出来', async () => {
    blenderStatus.mockResolvedValue(ready)
    blenderSetup.mockResolvedValue({ success: false, message: '安装未完成：网络连不上。' })
    const wrapper = await mountPanel()

    await installButton(wrapper).trigger('click')
    await flushPromises()

    expect(wrapper.text()).toContain('安装未完成：网络连不上。')
  })
})
