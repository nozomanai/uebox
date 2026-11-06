import { afterEach, beforeEach, vi } from 'vitest'
import { config } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createI18n } from 'vue-i18n'
import zhCN from '@renderer/i18n/locales/zh-CN'

// 全局测试设置

/**
 * 主进程的测试用 `@vitest-environment node`（HTTP server、子进程这类东西在
 * happy-dom 里跑不了：它的 fetch 强制 CORS，会把 127.0.0.1 当跨域拦掉）。
 * node 环境下没有 window，这个 setup 里所有浏览器侧的桩都要跳过。
 */
const hasDom = typeof window !== 'undefined'

if (hasDom) {
  // 模拟 Electron API
  Object.defineProperty(window, 'electron', {
    value: {
      ipcRenderer: {
        send: vi.fn(),
        on: vi.fn(),
        removeAllListeners: vi.fn(),
        invoke: vi.fn()
      },
      process: {
        versions: {
          electron: '38.0.0',
          chrome: '128.0.0.0',
          node: '20.0.0'
        }
      }
    },
    writable: true,
    configurable: true
  })

  Object.defineProperty(window, 'api', {
    value: {
      invoke: vi.fn(),
      on: vi.fn(),
      off: vi.fn(),
      websocket: {
        call: vi.fn(),
        // 订阅类的桩必须**回一个退订函数**，和真 preload 一样。回 undefined 的话，
        // 「卸载时退订」这种用例分不清「退订了」和「压根没东西可退」—— 恰恰是
        // 这些订阅要防的那个泄漏，桩自己看不见
        getProjects: vi.fn(async () => []),
        onProjectsChanged: vi.fn(() => vi.fn()),
        // 这两个是 preload 里的必填成员。桩里缺了的话，任何挂载常驻横幅或
        // 插件设置页的测试都会走进「preload 坏了」那条路，还看不出来
        getStatus: vi.fn(async () => ({ state: 'listening', port: 0 })),
        onStatusChanged: vi.fn(() => vi.fn())
      },
      database: {
        assetData: {
          getAssetDependencyGraph: vi.fn()
        }
      },
      notebook: {
        get: vi.fn()
      },
      bilibili: {
        // 同上：回一个退订函数。NoteSourcePanel 在 onMounted 里订阅分析进度，
        // 桩里缺了这个命名空间，lifecycle hook 抛错会让整个 mount() 失败
        onAnalyzeProgress: vi.fn(() => vi.fn())
      }
    },
    writable: true,
    configurable: true
  })

  Object.defineProperty(navigator, 'clipboard', {
    value: {
      writeText: vi.fn()
    },
    writable: true
  })

  // 模拟环境变量
  Object.defineProperty(import.meta, 'env', {
    value: {
      VITE_APP_ENV: 'test',
      VITE_APP_BASE_URL: 'http://test-api.example.com/api',
      VITE_APP_NAME: 'Unreal Agent Test'
    },
    writable: true
  })

  // 全局组件注册（如果需要）
} // end if (hasDom)

config.global.components = {
  // 在这里注册全局组件
}

// 模拟 CSS 模块
vi.mock('*.module.css', () => ({
  default: {}
}))

vi.mock('*.module.less', () => ({
  default: {}
}))

// 模拟图片和静态资源
vi.mock('*.png', () => 'test-file-stub')
vi.mock('*.jpg', () => 'test-file-stub')
vi.mock('*.jpeg', () => 'test-file-stub')
vi.mock('*.gif', () => 'test-file-stub')
vi.mock('*.svg', () => 'test-file-stub')
vi.mock('*.ico', () => 'test-file-stub')

vi.mock('ant-design-vue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ant-design-vue')>()
  return {
    ...actual,
    message: {
      ...actual.message,
      config: vi.fn(),
      destroy: vi.fn(),
      error: vi.fn(),
      info: vi.fn(),
      loading: vi.fn(),
      open: vi.fn(),
      success: vi.fn(),
      warning: vi.fn()
    },
    Modal: {
      ...actual.Modal,
      confirm: vi.fn((options: { onOk?: () => void | Promise<void> }) => options.onOk?.())
    }
  }
})

const testI18n = createI18n({
  legacy: false,
  locale: 'zh-CN',
  fallbackLocale: 'zh-CN',
  missingWarn: false,
  fallbackWarn: false,
  messages: { 'zh-CN': zhCN }
})

beforeEach(() => {
  const pinia = createPinia()
  setActivePinia(pinia)
  config.global.plugins = [testI18n]
})

// 清理函数
afterEach(() => {
  vi.clearAllMocks()
})
