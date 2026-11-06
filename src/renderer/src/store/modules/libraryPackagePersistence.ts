/**
 * 蓝图库 / 材质库的持久化底座 —— 包目录版。
 *
 * 取代 `libraryPersistence.ts`（SQLite 版）。两者接口一样，所以两个 store 的
 * 调用点几乎不用改；变的是**东西存在哪**：
 *
 * | | 存在哪 | 为什么 |
 * |---|---|---|
 * | 条目 | 保管库里的包目录 | 硬规则第 9 条：用户创作的东西，唯一真相源是磁盘上的文件 |
 * | 封面 | 包里的 `cover.png` | 原来是 base64 塞在条目 JSON 里，正是撑爆 localStorage 的那一坨 |
 * | 分组 | 保管库根目录的 `.library-meta.json` | 它不属于任何单个条目，但也得跟着保管库走 |
 * | 界面偏好 | localStorage | 排序、视图模式这些**本来就该**放 localStorage |
 *
 * ## 为什么封面走 `local-resource://` 而不是读成 base64
 *
 * 读回来时如果把 `cover.png` 转成 data URL，五百个条目就是五百次 IPC 往返，
 * 而且内存里又躺回一堆 base64 —— 等于换个地方重犯原来的错。
 * `local-resource://` 是这个应用加载本地图片的既有通道，`<img src>` 直接给它路径就行。
 *
 * ## 写盘为什么仍然是「同步标脏 + 防抖」
 *
 * 两个 store 里的 `persistState()` 被二十多处同步调用。这一层保持 `persist()`
 * 同步、只标脏，真正落盘排在防抖之后 —— 上层代码一行不用改。
 */

import { ref } from 'vue'

import {
  libraryPackageAPI,
  type LibraryKind,
  type LibraryPackageDto
} from '@renderer/api/libraryPackage'
import { toLocalResourceUrl } from '@renderer/utils/localResource'
import type { LibraryPersistence, LibrarySaveState, LibrarySnapshot } from './libraryPersistence'

/** 落盘防抖：连续操作只写一次 */
const FLUSH_DEBOUNCE_MS = 200
/** 防抖上限：持续不断的操作（比如连着拖节点）也至少每 1s 落一次盘 */
const FLUSH_MAX_WAIT_MS = 1000

/** 包里封面的固定文件名 */
const COVER_FILE_NAME = 'cover.png'

/** 条目必须有的形状。两个库的领域模型各不相同，但这几个字段是共同的。 */
export interface PackageEntryShape {
  id: string
  name: string
  /** 封面。可能是 data URL（要抽成文件）、也可能已经是 `local-resource://` */
  thumbnail?: string
}

/** `.library-meta.json` 的结构 */
interface LibraryMetaFile {
  /** 两个库各一份分组列表 */
  collections?: Partial<Record<LibraryKind, unknown[]>>
  /** 哪些库已经从旧存储搬过来了。搬过就别再搬第二次。 */
  migrated?: Partial<Record<LibraryKind, boolean>>
}

/**
 * 解析存在 localStorage 里的界面偏好。坏了就当没存过 ——
 * 一份读不出来的排序偏好不该把整个库拦在门外。
 *
 * `localStorage.getItem/setItem` 本身留在各个 store 里，因为
 * `scripts/check-local-storage.mjs` 要能看见字面量键名。
 */
export function parseUiPrefs(raw: string | null): Record<string, unknown> {
  if (!raw) return {}
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/**
 * data URL 转字节。不是 data URL 就返回 null（调用方据此判断「不用抽成文件」）。
 */
export function dataUrlToBytes(value: string | undefined): Uint8Array | null {
  const raw = String(value ?? '')
  const match = /^data:[^;,]*;base64,(.*)$/is.exec(raw)
  if (!match) return null

  try {
    const binary = atob(match[1])
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
    return bytes
  } catch {
    // 坏掉的 base64 不该让整次落盘失败，当作「没有封面要抽」
    console.warn('[LibraryPackage] 封面 base64 解不开，这次不抽成文件')
    return null
  }
}

/**
 * 条目 → 写进清单 `payload` 的东西。
 *
 * 封面被抽成文件之后，`thumbnail` 就不该再留在 payload 里 —— 留着等于同一张图
 * 存两份，而且下次读回来会拿旧的那份盖掉文件里的新的。
 */
function toPayload<TEntry extends PackageEntryShape>(
  entry: TEntry,
  coverExtracted: boolean
): unknown {
  if (!coverExtracted) return entry
  const { thumbnail: _thumbnail, ...rest } = entry
  void _thumbnail
  return rest
}

/** 内存里一条记录当前落盘成什么样，用来算增量 */
interface FlushedEntry {
  dirPath: string
  /** 条目内容的指纹。变了才重写清单。 */
  fingerprint: string
  /** 封面的指纹。变了才重写 cover.png。 */
  coverFingerprint: string
  /** 上次落盘时用的名字。变了要改目录名。 */
  name: string
}

/**
 * 内容指纹。
 *
 * 故意**不包含** `thumbnail` —— 封面单独算指纹、单独落盘。
 * 混在一起的话，换一张封面会顺带把整份图表重新序列化写一遍。
 */
function entryFingerprint<TEntry extends PackageEntryShape>(entry: TEntry): string {
  const { thumbnail: _thumbnail, ...rest } = entry
  void _thumbnail
  return JSON.stringify(rest)
}

function coverFingerprint<TEntry extends PackageEntryShape>(entry: TEntry): string {
  return String(entry.thumbnail ?? '')
}

export interface CreateLibraryPackagePersistenceOptions<
  TEntry extends PackageEntryShape,
  TCollection extends { id: string }
> {
  library: LibraryKind
  /**
   * 界面偏好的读写。由调用方自己碰 localStorage —— 这一层拿到的只是两个函数。
   *
   * 不在这里直接 `localStorage.setItem(someKey, ...)` 是有意的：
   * `scripts/check-local-storage.mjs` 要逐个 key 核对用途，一个变量当键名
   * 就等于让那道门禁失效（它没法知道你到底存了什么）。
   */
  readUi: () => Record<string, unknown>
  writeUi: (ui: Record<string, unknown>) => void
  /** 读当前内存状态 */
  getSnapshot: () => LibrarySnapshot<TEntry, TCollection>
  /** 把读到的快照写回内存状态 */
  applySnapshot: (snapshot: LibrarySnapshot<TEntry, TCollection>) => void
  /**
   * 从旧存储（SQLite / localStorage）里把老用户那份读出来。
   * 返回 null 表示没有旧数据。只在这个保管库还没迁移过时调用一次。
   */
  readLegacy?: () => Promise<LibrarySnapshot<TEntry, TCollection> | null>
  /** 迁移成功之后调用，用来清掉旧存储 */
  onMigrated?: () => Promise<void> | void
  /**
   * 从磁盘读回来的 payload → 内存里的条目。
   *
   * 默认是原样展开 payload，那对老形态（payload 就是完整条目）刚好合适。
   * 但片段仓库的新形态 payload 是 `{ form: "graph", graph: {...} }` ——
   * 展开之后 `graphs` / `functions` / `macros` 一个都没有，而详情页会直接
   * 去读它们，读到 undefined 就崩。
   *
   * 领域侧在这里把缺的字段补齐。放在这一层是因为**这一层不认识蓝图**，
   * 补什么字段是领域的事。
   */
  normalizeEntry?: (payload: Record<string, unknown>) => Record<string, unknown>
}

export function createLibraryPackagePersistence<
  TEntry extends PackageEntryShape,
  TCollection extends { id: string }
>(options: CreateLibraryPackagePersistenceOptions<TEntry, TCollection>): LibraryPersistence {
  const {
    library,
    readUi,
    writeUi,
    getSnapshot,
    applySnapshot,
    readLegacy,
    onMigrated,
    normalizeEntry
  } = options

  /** 上一次成功落盘的状态，按条目 id 索引 */
  let flushed = new Map<string, FlushedEntry>()
  /** 上一次落盘的分组 JSON，没变就不重写元信息文件 */
  let flushedCollections: string | null = null

  let dirty = false
  let hydrated = false

  /**
   * 落盘状态。
   *
   * 写盘失败原来只有一行 console.warn，而失败在真机上不是罕见事：用户在资产库切了
   * 保管库（条目路径属于上一个库，主进程一律拒绝），或者在资源管理器里改了包目录名。
   * 之后他的每一次编辑都「看起来成功」，关掉应用就没了。界面必须能看见这件事。
   */
  const saveStatus = ref<'idle' | 'saving' | 'error'>('idle')
  const saveLastError = ref('')
  const saveFailedCount = ref(0)
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  let maxWaitTimer: ReturnType<typeof setTimeout> | null = null
  let inFlight: Promise<void> = Promise.resolve()

  // ========== 元信息：分组 + 迁移标记 ==========

  async function readMeta(): Promise<LibraryMetaFile> {
    try {
      const text = await libraryPackageAPI.readMeta()
      if (!text) return {}
      const parsed = JSON.parse(text)
      return parsed && typeof parsed === 'object' ? (parsed as LibraryMetaFile) : {}
    } catch (error) {
      console.warn(`[LibraryPackage] 元信息读不出来（${library}）:`, error)
      return {}
    }
  }

  /**
   * 只改这个库那一格，其余原样带回去 ——
   * 两个库共用一份元信息文件，整份覆盖会把另一个库的分组抹掉。
   */
  async function patchMeta(patch: (meta: LibraryMetaFile) => void): Promise<void> {
    const meta = await readMeta()
    patch(meta)
    await libraryPackageAPI.writeMeta(JSON.stringify(meta, null, 2))
  }

  // ========== 读 ==========

  /** 把磁盘上的一个包还原成内存里的条目 */
  function fromPackage(pkg: LibraryPackageDto): TEntry | null {
    const payload = pkg.manifest.payload
    if (!payload || typeof payload !== 'object') return null

    const normalized = normalizeEntry
      ? normalizeEntry(payload as Record<string, unknown>)
      : (payload as Record<string, unknown>)

    const entry = { ...(normalized as TEntry) }
    // 清单里的 id / name 是权威的：用户可能在磁盘上改过名字
    entry.id = pkg.manifest.id
    entry.name = pkg.manifest.name

    if (pkg.manifest.cover) {
      // 走既有的本地图片通道，不读成 base64
      entry.thumbnail = toLocalResourceUrl(`${pkg.dirPath}/${pkg.manifest.cover}`)
    }

    return entry
  }

  /** 记住这份状态就是「已落盘」，之后的增量以它为基准 */
  function seedFlushed(entries: TEntry[], dirPathById: Map<string, string>): void {
    flushed = new Map()
    for (const entry of entries) {
      const dirPath = dirPathById.get(entry.id)
      if (!dirPath) continue
      flushed.set(entry.id, {
        dirPath,
        fingerprint: entryFingerprint(entry),
        coverFingerprint: coverFingerprint(entry),
        name: entry.name
      })
    }
  }

  async function hydrate(): Promise<void> {
    try {
      // 没有 preload（浏览器调试、单元测试）就没有保管库可写。但旧存储里那份
      // 还是要读出来给用户看 —— 显示一个空库比显示旧数据更糟，用户会以为东西没了。
      // 这条路上 writeOnce() 同样会早退，所以只读不写。
      if (!libraryPackageAPI.isAvailable()) {
        const legacy = await readLegacy?.()
        if (legacy) applySnapshot({ ...legacy, ui: readUi() })
        return
      }

      const meta = await readMeta()
      const scanned = await libraryPackageAPI.scan()

      if (scanned.problems.length > 0) {
        // 坏包不能默默消失 —— 用户得知道哪个包读不了，否则会以为是自己删的
        console.warn(
          `[LibraryPackage] ${scanned.problems.length} 个包读不了（${library}）:`,
          scanned.problems
        )
      }

      const mine = scanned.entries.filter((pkg) => pkg.library === library)

      // 保管库里还一个包都没有、而且这个库没迁移过 —— 去看看旧存储里有没有东西
      if (mine.length === 0 && !meta.migrated?.[library] && readLegacy) {
        const legacy = await readLegacy()
        if (legacy && legacy.entries.length > 0) {
          await migrate(legacy)
          return
        }
        // 旧存储也是空的：记上「看过了」，免得每次启动都去问一遍
        await patchMeta((m) => {
          m.migrated = { ...m.migrated, [library]: true }
        })
      }

      const dirPathById = new Map<string, string>()
      const entries: TEntry[] = []
      for (const pkg of mine) {
        const entry = fromPackage(pkg)
        if (!entry) continue
        dirPathById.set(entry.id, pkg.dirPath)
        entries.push(entry)
      }

      const collections = (meta.collections?.[library] ?? []) as TCollection[]
      applySnapshot({ entries, collections, ui: readUi() })
      seedFlushed(entries, dirPathById)
      flushedCollections = JSON.stringify(collections)
    } catch (error) {
      // 读不出来就当空库开，不要把整个页面卡死在这里
      console.warn(`[LibraryPackage] 读取失败（${library}）:`, error)
    } finally {
      hydrated = true
    }
  }

  /**
   * 把旧存储里那份一次性搬成包目录。
   *
   * 顺序很重要：**先把包全部写完，再置迁移标记**。中途崩了标记还没置上，
   * 下次启动会原样重来；反过来的话用户的数据就悬空了。
   */
  async function migrate(legacy: LibrarySnapshot<TEntry, TCollection>): Promise<void> {
    console.log(`[LibraryPackage] 开始迁移 ${legacy.entries.length} 个条目到包目录（${library}）`)

    const dirPathById = new Map<string, string>()
    const migrated: TEntry[] = []

    for (const entry of legacy.entries) {
      try {
        const created = await writeEntry(entry, null)
        if (!created) continue
        dirPathById.set(entry.id, created)
        migrated.push(entry)
      } catch (error) {
        // 一条搬不过去不该让整批停下 —— 其余的先落地，坏的那条留在旧存储里
        console.error(`[LibraryPackage] 条目迁移失败，已跳过: ${entry.id}`, error)
      }
    }

    await patchMeta((m) => {
      m.collections = { ...m.collections, [library]: legacy.collections }
      m.migrated = { ...m.migrated, [library]: true }
    })

    // 确认落盘之后才动旧存储
    try {
      await onMigrated?.()
    } catch (error) {
      console.warn(`[LibraryPackage] 清理旧存储失败（不影响正确性）（${library}）:`, error)
    }

    applySnapshot({ entries: migrated, collections: legacy.collections, ui: readUi() })
    seedFlushed(migrated, dirPathById)
    flushedCollections = JSON.stringify(legacy.collections)

    console.log(
      `[LibraryPackage] 迁移完成：${migrated.length}/${legacy.entries.length}（${library}）`
    )
  }

  // ========== 写 ==========

  /**
   * 把一个条目写进磁盘。
   *
   * @param dirPath 已有的包目录；传 null 表示新建
   * @returns 落盘后的包目录路径（改名后可能变），失败返回 null
   */
  async function writeEntry(entry: TEntry, dirPath: string | null): Promise<string | null> {
    const coverBytes = dataUrlToBytes(entry.thumbnail)

    if (!dirPath) {
      const created = await libraryPackageAPI.create({
        library,
        id: entry.id,
        name: entry.name,
        payload: toPayload(entry, coverBytes !== null)
      })
      if (!created) return null
      if (coverBytes) await attachCover(created.dirPath, coverBytes)
      return created.dirPath
    }

    const previous = flushed.get(entry.id)
    let target = dirPath

    // 改名要移动目录，之后所有操作都得用新路径 —— 旧的已经不存在了
    if (previous && previous.name !== entry.name) {
      const renamed = await libraryPackageAPI.rename(dirPath, entry.name)
      if (renamed) target = renamed.dirPath
    }

    if (coverBytes) await attachCover(target, coverBytes)

    /*
     * 封面被清掉时要**显式**告诉磁盘「现在没有封面了」。
     *
     * 主进程那边 `cover: patch.cover !== undefined ? patch.cover : current.cover` ——
     * 不传就保留原值。所以「重置封面」原来是这样的：内存里 thumbnail 清了、界面弹
     * 「封面已重置」，磁盘上的 cover.png 和清单里的指向一个字都没动；下次启动从磁盘
     * 读回来，封面又回来了。用户重置了个寂寞，还以为自己记错了。
     *
     * 不看 `previous?.coverFingerprint`：老包（写入时还没记指纹的）和指纹算失败的包
     * 磁盘上照样有封面，拿指纹当前提的话，恰恰是这些包重置不掉。清就是清，
     * 本来没有封面时多传一个空字符串也不会有事。
     */
    const clearingCover = coverBytes === null

    const updated = await libraryPackageAPI.update(target, {
      name: entry.name,
      payload: toPayload(entry, coverBytes !== null),
      ...(clearingCover ? { cover: '' } : {})
    })

    // 包里那个 cover.png 就留着：清单已经不指向它，读回来时不会再当封面用，
    // 下次设新封面会原地覆盖。为了删一个几十 KB 的孤儿文件再开一条 IPC 不划算

    return updated ? updated.dirPath : target
  }

  /** 封面落成包里的 cover.png，并把清单的 cover 字段指向它 */
  async function attachCover(dirPath: string, bytes: Uint8Array): Promise<void> {
    const written = await libraryPackageAPI.writeFile(dirPath, COVER_FILE_NAME, bytes)
    if (written) await libraryPackageAPI.update(dirPath, { cover: COVER_FILE_NAME })
  }

  async function writeOnce(): Promise<void> {
    // 还没读完就写，等于把空的内存状态盖到磁盘上
    if (!hydrated || !dirty) return
    dirty = false

    const snapshot = getSnapshot()

    // 界面偏好走 localStorage，跟有没有保管库无关 —— 先存，再看条目能不能落盘
    writeUi(snapshot.ui)

    if (!libraryPackageAPI.isAvailable()) return

    const next = new Map<string, FlushedEntry>()
    let failed = false
    let failedCount = 0
    let lastError = ''
    saveStatus.value = 'saving'

    for (const entry of snapshot.entries) {
      const previous = flushed.get(entry.id)
      const fingerprint = entryFingerprint(entry)
      const cover = coverFingerprint(entry)

      // 没变就跳过 —— 这是「不再整库重写」的关键
      if (previous && previous.fingerprint === fingerprint && previous.coverFingerprint === cover) {
        next.set(entry.id, previous)
        continue
      }

      try {
        const dirPath = await writeEntry(entry, previous?.dirPath ?? null)
        if (!dirPath) {
          failed = true
          failedCount += 1
          // 主进程拒绝时不抛，只回 null（路径越界、包不存在都是这一档）
          lastError = lastError || `${entry.name}`
          if (previous) next.set(entry.id, previous)
          continue
        }
        next.set(entry.id, { dirPath, fingerprint, coverFingerprint: cover, name: entry.name })
      } catch (error) {
        // 单条写失败保留它的旧快照，下次落盘会重试这一条
        failed = true
        failedCount += 1
        lastError = error instanceof Error ? error.message : String(error)
        if (previous) next.set(entry.id, previous)
        console.warn(`[LibraryPackage] 条目存盘失败（${library}）: ${entry.id}`, error)
      }
    }

    // 内存里没有了的，从磁盘删掉
    for (const [id, record] of flushed) {
      if (next.has(id)) continue
      try {
        await libraryPackageAPI.delete(record.dirPath)
      } catch (error) {
        // 删不掉就留着，下次落盘会再试。宁可留一个孤儿包，也不能把状态记成已删。
        failed = true
        failedCount += 1
        lastError = error instanceof Error ? error.message : String(error)
        next.set(id, record)
        console.warn(`[LibraryPackage] 删除失败（${library}）: ${id}`, error)
      }
    }

    flushed = next

    const collections = JSON.stringify(snapshot.collections)
    if (collections !== flushedCollections) {
      try {
        await patchMeta((m) => {
          m.collections = { ...m.collections, [library]: snapshot.collections }
        })
        flushedCollections = collections
      } catch (error) {
        failed = true
        failedCount += 1
        lastError = error instanceof Error ? error.message : String(error)
        console.warn(`[LibraryPackage] 分组存盘失败（${library}）:`, error)
      }
    }

    // 有失败的就保持脏，下一次防抖会把这批重试一遍
    if (failed) dirty = true

    /*
     * 把结果说出去。
     *
     * 「保持脏 + 下次重试」只在用户**继续操作**时才会再触发一次落盘 —— 他要是
     * 正好写完最后一笔就走开，这批东西就一直躺在内存里，直到应用关掉。
     * 所以状态得摆到界面上，让他知道有东西没存上、可以点重试。
     */
    saveFailedCount.value = failedCount
    saveLastError.value = failed ? lastError : ''
    saveStatus.value = failed ? 'error' : 'idle'
  }

  function clearTimers(): void {
    if (debounceTimer) {
      clearTimeout(debounceTimer)
      debounceTimer = null
    }
    if (maxWaitTimer) {
      clearTimeout(maxWaitTimer)
      maxWaitTimer = null
    }
  }

  function flush(): Promise<void> {
    clearTimers()
    inFlight = inFlight.then(writeOnce, writeOnce)
    return inFlight
  }

  function persist(): void {
    dirty = true
    // 还没读完就先别排落盘，等 hydrate 完成后统一补一次
    if (!hydrated) return
    if (debounceTimer) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      debounceTimer = null
      void flush()
    }, FLUSH_DEBOUNCE_MS)
    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(() => {
        maxWaitTimer = null
        void flush()
      }, FLUSH_MAX_WAIT_MS)
    }
  }

  /**
   * 把磁盘上**某一条**新写入的条目并进内存，用来接住不经过这个 store 的写入。
   *
   * 片段仓库的 `blueprint_library_save` 是主进程工具直接写包目录的 ——
   * 渲染层完全不知情，而 `hydrate()` 只在创建时跑一次，
   * 于是「AI 说存好了，库列表里没有」。
   *
   * ## 为什么是「并一条」而不是「整库重读」
   *
   * 整库重读（先 flush 再 hydrate）有两个会**丢用户正在编辑的东西**的窗口，
   * 两个都实测复现过：
   *
   * 1. **重读期间继续编辑。** 扫盘是异步的，扫的那几百毫秒里用户改了某个条目，
   *    `applySnapshot()` 一上来就用磁盘那份盖掉他的改动 —— 而且
   *    `seedFlushed()` 会把新基线也记成磁盘那份，于是下一次落盘看不出有改动，
   *    这条编辑再也找不回来。
   * 2. **flush 失败了还照读。** `writeOnce()` 里单条写失败是 `catch` 住、
   *    只把 `dirty` 置回 true，**不抛**。所以 `await flush()` 照样 resolve，
   *    然后 hydrate 把那条没存上的改动盖掉。
   *
   * 并一条就没有这两个问题：不动其它条目、不重置整份基线、不需要先 flush。
   * 通知里本来就带着 `entryId`，用它。
   *
   * @returns 真的并进来了返回 true；没找到那个包（还没落盘完、或者被删了）返回 false
   */
  async function mergeEntryFromDisk(entryId: string): Promise<boolean> {
    if (!entryId || !libraryPackageAPI.isAvailable()) return false

    const scanned = await libraryPackageAPI.scan()
    const pkg = scanned.entries.find(
      (item) => item.library === library && item.manifest.id === entryId
    )
    if (!pkg) return false

    const entry = fromPackage(pkg)
    if (!entry) return false

    // 只动这一条。**故意读的是当前快照而不是扫描结果** ——
    // 用户在扫盘那几百毫秒里改的其它条目原样留着。
    const snapshot = getSnapshot()
    const index = snapshot.entries.findIndex((item) => item.id === entry.id)
    const entries =
      index >= 0
        ? snapshot.entries.map((item, i) => (i === index ? entry : item))
        : [...snapshot.entries, entry]

    applySnapshot({ ...snapshot, entries })

    // 基线也只补这一条：它此刻和磁盘一致，别的条目的基线不能动，
    // 否则那些「内存改了但还没落盘」的条目会被记成已落盘。
    flushed.set(entry.id, {
      dirPath: pkg.dirPath,
      fingerprint: entryFingerprint(entry),
      coverFingerprint: coverFingerprint(entry),
      name: entry.name
    })

    return true
  }

  const ready = hydrate().then(() => {
    // 读取期间用户可能已经动过，补一次落盘
    if (dirty) persist()
  })

  // 关窗前把最后 200ms 的改动尽量送出去
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', () => {
      void flush()
    })
  }

  const saveState: LibrarySaveState = {
    status: saveStatus,
    lastError: saveLastError,
    failedCount: saveFailedCount,
    /**
     * 再试一次。
     *
     * 重新标脏再 flush —— 上一轮失败的条目在 `flushed` 里还留着旧快照，
     * 指纹对不上，所以它们会被重新写一遍；已经写成功的那些指纹没变，照样跳过。
     */
    async retry(): Promise<void> {
      dirty = true
      await flush()
    }
  }

  return { ready, persist, flush, mergeEntryFromDisk, saveState }
}
