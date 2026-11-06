/**
 * scanHandlerWiring.test.ts — 远程扫描这条路径
 *
 * @vitest-environment node
 *
 * 修复前：扫描实现只在 `networkVaultV2:startServer` 这条 IPC 通道里注入，而那条通道
 * 不在 preload 白名单里、永远不会被调用；真实的启动路径是 VaultManager（它在
 * `initDatabase()` 阶段就把 Server 拉起来，比 `registerAllIPC()` 早）。结果是
 * 盒子当主机时 POST /scan 恒回 501「扫描功能未配置」，可写客户端点「刷新」扫不动。
 *
 * 这条路径活过来之后，它和本机那条路径共用的那些前置条件也必须跟着共用。
 * 所以这里钉五件事：
 *  1. 扫描实现在 Server 启动**之后**注册也照样生效（启动顺序不能决定能不能扫）；
 *  2. 注册真的发生在应用启动会走到的那一处，而不是又一条死通道里；
 *  3. 共享盘不可达时扫描报错，不报「扫描完成」；
 *  4. 本机与远程两条路径共用同一把互斥锁，并发时同一个文件只入一条资产；
 *  5. 结果带 partial 时，界面报的是「部分目录未读取」而不是「扫描完成」——
 *     主进程把 partial 透出来、渲染层不读，用户看到的还是同一个假成功。
 */
import Database from 'better-sqlite3'
import * as http from 'http'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { parse as parseSfc } from '@vue/compiler-sfc'
import ts from 'typescript'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.unmock('better-sqlite3')

// 真实注册路径住在 IPC 模块里，它静态引了 electron
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getName: () => 'uebox', getVersion: () => '0.0.0' },
  ipcMain: { handle: vi.fn(), on: vi.fn(), removeHandler: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] },
  safeStorage: { isEncryptionAvailable: () => false },
  nativeImage: { createFromPath: () => null }
}))

import { initAssetDataModel } from '../sqliteDataBase/models/assetData'
import { initAssetFolderModel } from '../sqliteDataBase/models/assetFolder'
import {
  AssetServer,
  VaultScanBusyError,
  getVaultScanHandler,
  registerVaultScanHandler,
  withVaultScanLock
} from './AssetServer'
import type { VaultEntry } from './AssetServer'
import { registerNetworkVaultV2Handlers } from '../ipc/networkVaultV2'

const READ_KEY = 'AAAA-BBBB-CCCC-DDDD'
const WRITE_KEY = 'EEEE-FFFF-GGGG-HHHH'
const HOST_NAME = 'scan-wiring-host'

let server: AssetServer
let port: number
let tmpRoot: string

/** 带资产表和根文件夹的空库（`ALL` 是 assetData.folderKey 的外键目标） */
function newVaultDb(): Database.Database {
  const db = new Database(':memory:')
  initAssetFolderModel(db)
  initAssetDataModel(db)
  db.prepare(
    `INSERT INTO assetFolder (folderKey, fatherKey, type, folderName) VALUES ('ALL', NULL, 'folder', 'ALL')`
  ).run()
  return db
}

function assetCount(db: Database.Database): number {
  const row = db.prepare(`SELECT COUNT(*) AS n FROM assetData`).get() as { n: number }
  return row.n
}

function entryOf(vaultId: string): VaultEntry {
  const entry = server.getVaultEntry(vaultId)
  if (!entry) throw new Error(`测试里没注册 vault: ${vaultId}`)
  return entry
}

function request(path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { host: `${HOST_NAME}:${port}`, 'x-api-key': WRITE_KEY }
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk) => chunks.push(chunk as Buffer))
        res.on('end', () =>
          resolve({
            status: res.statusCode || 0,
            body: Buffer.concat(chunks).toString('utf-8')
          })
        )
      }
    )
    req.on('error', reject)
    req.end()
  })
}

beforeAll(async () => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'scan-wiring-'))
  server = new AssetServer({ port: 0, allowedHostnames: [HOST_NAME] })

  // v1：接线用，目录空着
  const v1Dir = join(tmpRoot, 'v1')
  mkdirSync(v1Dir)
  server.registerVault('v1', 'V1', v1Dir, newVaultDb(), {
    readKey: READ_KEY,
    writeKey: WRITE_KEY
  })

  // gone：注册的路径根本不存在 —— 主机共享盘掉线时客户端看到的就是这个
  server.registerVault('gone', 'Gone', join(tmpRoot, 'not-there'), newVaultDb(), {
    readKey: READ_KEY,
    writeKey: WRITE_KEY
  })

  // half：注册的路径读不出目录项（readdir 当场 ENOTDIR），模拟一半目录读不到
  const halfPath = join(tmpRoot, 'half-readable')
  writeFileSync(halfPath, 'not a directory')
  server.registerVault('half', 'Half', halfPath, newVaultDb(), {
    readKey: READ_KEY,
    writeKey: WRITE_KEY
  })

  // busy：目录里放一个文件，用来验并发
  const busyDir = join(tmpRoot, 'busy')
  mkdirSync(busyDir)
  writeFileSync(join(busyDir, 'asset-a.txt'), 'a')
  server.registerVault('busy', 'Busy', busyDir, newVaultDb(), {
    readKey: READ_KEY,
    writeKey: WRITE_KEY
  })

  port = await server.start()
})

afterAll(async () => {
  await server.stop()
  rmSync(tmpRoot, { recursive: true, force: true })
})

describe('远程扫描的扫描实现', () => {
  it('Server 先起、扫描实现后注册 —— POST /scan 照样能扫（修复前恒 501）', async () => {
    // 还没注册：和修复前盒子当主机时的处境一样
    expect(getVaultScanHandler()).toBeNull()
    const before = await request('/api/vaults/v1/scan')
    expect(before.status).toBe(501)

    // Server 已经在跑了，这时候才注册 —— 真实启动顺序就是这样
    const seen: VaultEntry[] = []
    registerVaultScanHandler(async (vault) => {
      seen.push(vault)
      return { newAssets: 2, newFolders: 1 }
    })
    expect(getVaultScanHandler()).not.toBeNull()

    const after = await request('/api/vaults/v1/scan')
    expect(after.status).toBe(200)
    expect(JSON.parse(after.body)).toMatchObject({
      success: true,
      data: { newAssets: 2, newFolders: 1 }
    })

    // 扫哪个库由请求决定，不是注册时捕获的某个 vaultId
    expect(seen).toHaveLength(1)
    expect(seen[0].vaultId).toBe('v1')
    expect(seen[0].networkPath).toBe(join(tmpRoot, 'v1'))
  })
})

describe('注册发生在应用启动会走到的那一处', () => {
  it('registerNetworkVaultV2Handlers() 一调就把扫描实现装上了', () => {
    // 前一个 describe 已经注册过 stub，这里断言「非 null」是空断言：
    // networkVaultV2.ts 里的 registerVaultScanHandler(...) 整段删掉也照样绿。
    // 改成比对注册前后的实现：这一调必须把处理器换成它自己那个。
    const before = getVaultScanHandler()
    expect(before).not.toBeNull()
    registerNetworkVaultV2Handlers()
    const after = getVaultScanHandler()
    expect(after).not.toBeNull()
    expect(after).not.toBe(before)
  })

  it('registerAllIPC 里真的调了 registerNetworkVaultV2Handlers', () => {
    // 只断言「注册函数写在 IPC 入口里」还不够：这一行被删掉，扫描就静悄悄退回 501
    const source = readFileSync(join(__dirname, '../ipc/index.ts'), 'utf-8')
    expect(source).toContain('registerNetworkVaultV2Handlers()')
  })
})

describe('共享盘不可达', () => {
  it('路径读不到时扫描报错，不报扫描完成', async () => {
    const handler = getVaultScanHandler()
    expect(handler).not.toBeNull()
    await expect(handler!(entryOf('gone'))).rejects.toThrow('网络路径不可访问')
  })

  it('POST /scan 回 500 —— 修复前是 200 加一个 newAssets: 0 的假成功', async () => {
    const res = await request('/api/vaults/gone/scan')
    expect(res.status).toBe(500)
    expect(res.body).toContain('网络路径不可访问')
  })

  it('有目录读失败时结果带 partial，调用方能和完整扫完分开', async () => {
    const res = await request('/api/vaults/half/scan')
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({
      success: true,
      data: { newAssets: 0, failedDirs: 1, partial: true }
    })
  })
})

describe('两条扫描路径共用互斥锁', () => {
  it('同一个库并发扫两次：后一次被拒，文件只入一条资产', async () => {
    const handler = getVaultScanHandler()
    expect(handler).not.toBeNull()
    const vault = entryOf('busy')

    const first = handler!(vault)
    const second = handler!(vault)

    await expect(second).rejects.toThrow(VaultScanBusyError)
    await expect(first).resolves.toMatchObject({ newAssets: 1, failedDirs: 0, partial: false })

    // 修复前两次扫描各读一遍去重快照，同一个文件留下两条 assetData
    expect(assetCount(vault.db)).toBe(1)
  })

  it('本机扫描占着锁时，远程 POST /scan 回 409', async () => {
    let release = (): void => {}
    const held = new Promise<void>((resolve) => {
      release = resolve
    })

    // 本机那条路径取的就是这把锁
    const local = withVaultScanLock('v1', () => held)
    const res = await request('/api/vaults/v1/scan')
    release()
    await local

    expect(res.status).toBe(409)
    expect(res.body).toContain('上一次扫描尚未结束')
  })
})

/**
 * 渲染层那一半：`partial` 透出来了，但得有人读。
 *
 * 资产库界面是个 8000 多行的 SFC，整体挂载不起来，所以这里按仓库里现成的办法
 * （`views/AssetManagement/importTreeRefresh.test.ts`）只把 `handleIncrementalScan`
 * 这一个声明从 `<script setup>` 里抠出来编译执行，依赖全部注入。
 */
const assetManagementSetup = parseSfc(
  readFileSync(join(__dirname, '../../renderer/src/views/AssetManagement/index.vue'), 'utf-8')
).descriptor.scriptSetup!.content
const assetManagementAst = ts.createSourceFile(
  'index.ts',
  assetManagementSetup,
  ts.ScriptTarget.Latest,
  true
)

function declarationOf(name: string): ts.VariableDeclaration {
  for (const statement of assetManagementAst.statements) {
    if (!ts.isVariableStatement(statement)) continue
    const match = statement.declarationList.declarations.find(
      (item) => item.name.getText(assetManagementAst) === name
    )
    if (match) return match
  }
  throw new Error(`index.vue 里找不到这个声明: ${name}`)
}

type MessageCall = { level: string; text: string }

/** 把 index.vue 的 handleIncrementalScan 取出来，喂一个扫描结果，收集它弹了什么 */
async function runIncrementalScan(
  invokeResult: Record<string, unknown>
): Promise<{ messages: MessageCall[]; refreshed: string[] }> {
  const messages: MessageCall[] = []
  const refreshed: string[] = []
  const record =
    (level: string) =>
    (text: string): void => {
      messages.push({ level, text })
    }
  const track = (name: string) => async (): Promise<void> => {
    refreshed.push(name)
  }

  const code = ts.transpileModule(
    `const ${declarationOf('handleIncrementalScan').getText(assetManagementAst)}`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }
  ).outputText

  const handler = new Function(
    'currentVault',
    'isScanning',
    'message',
    't',
    'window',
    'vaultStore',
    'loadRootFolders',
    'hydrateExpandedNodes',
    'loadCurrentFolderAssets',
    `${code}; return handleIncrementalScan`
  )(
    { value: { id: 'vault-1' } },
    { value: false },
    {
      success: record('success'),
      warning: record('warning'),
      error: record('error')
    },
    (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
    { api: { invoke: async () => invokeResult } },
    { refreshVaults: track('refreshVaults') },
    track('loadRootFolders'),
    track('hydrateExpandedNodes'),
    track('loadCurrentFolderAssets')
  ) as () => Promise<void>

  await handler()
  return { messages, refreshed }
}

describe('界面怎么报扫描结果', () => {
  it('有目录读不到时报「部分目录未读取」，不报扫描完成', async () => {
    const { messages, refreshed } = await runIncrementalScan({
      success: true,
      data: { newAssets: 0, failedDirs: 2, partial: true }
    })

    // 修复前这里是无条件的 message.success(assetManagement.scan.done)
    expect(messages).toEqual([
      { level: 'warning', text: 'assetManagement.scan.partial:{"count":2}' }
    ])
    // 半个库读不到也要把读到的那半刷出来
    expect(refreshed).toContain('loadCurrentFolderAssets')
  })

  it('全部目录读完才报扫描完成', async () => {
    const { messages } = await runIncrementalScan({
      success: true,
      data: { newAssets: 1, failedDirs: 0, partial: false }
    })

    expect(messages).toEqual([{ level: 'success', text: 'assetManagement.scan.done' }])
  })

  it('旧主进程不回 partial 时按扫描完成报（字段缺失不当成部分失败）', async () => {
    const { messages } = await runIncrementalScan({ success: true, data: { newAssets: 0 } })

    expect(messages).toEqual([{ level: 'success', text: 'assetManagement.scan.done' }])
  })
})
