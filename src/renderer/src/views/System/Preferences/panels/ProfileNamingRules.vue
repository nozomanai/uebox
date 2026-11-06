<script setup lang="ts">
import AppSpin from '@renderer/components/AppSpin.vue'
import AppButton from '@renderer/components/AppButton.vue'
/**
 * 命名规则设置组件
 */
import { computed, ref, watch, onMounted, onUnmounted } from 'vue'
import { PhArrowClockwise, PhCaretRight, PhPlus, PhTrash } from '@phosphor-icons/vue'
import { message } from '@renderer/utils/messageManager'
import { confirmDialog } from '@renderer/utils/dialog'
import { useI18n } from '@renderer/hooks/useI18n'
import {
  refreshNamingRulesConfig,
  saveNamingRulesConfig,
  resetNamingRulesConfig,
  getNamingRulesConfig
} from '@renderer/services/namingRulesService'
import type { RemovedNamingKeys } from '@renderer/services/namingRulesService'
import type { NamingRulesConfig, TextureSuffixPattern } from '@renderer/types/namingRules'
import AppSwitch from '@renderer/components/AppSwitch.vue'

const { t } = useI18n()

// 配置数据
const config = ref<NamingRulesConfig>(getNamingRulesConfig())
const loading = ref(false)
const saving = ref(false)
const autoSaving = ref(false)
const lastSavedTime = ref<Date | null>(null)

// 自动保存定时器
let autoSaveTimer: number | null = null
const AUTO_SAVE_DELAY = 2000 // 2秒防抖，减少保存频率
let lastConfigSnapshot: string | null = null // 用于检测配置是否真的变化了

/**
 * 每一行编辑状态里都带一个 `savedKey`：**这一行上一次落盘时用的键**，
 * 新加的还没存过的行是空串。
 *
 * 它是「就地改键名」唯一的线索。用户把 `SoundWave` 这一行的类型改成 `SoundWaveSFX`，
 * 交上去的表里只有新键，老键既不在表里也没进删除列表 —— 下次读盘出厂值把它垫回来，
 * 他看到两行。`savedKey` 让 `syncEditingToConfig` 能把老键报进删除列表。
 */
const editingAssetPrefixes = ref<
  Record<string, { assetType: string; prefix: string; savedKey: string }>
>({})
const editingDirectories = ref<
  Record<string, { assetType: string; directory: string; savedKey: string }>
>({})
// 「从资产库导入的目录」（libraryAssetTypeToDirectory）没有编辑入口，是有意的：
// 那张表目前**没有任何代码路径读得到**。projectImport 只在 destinationPath 不以 /Game/
// 开头时才走资产库映射，而现有调用方（ImportToProjectModal）一律传 '/Game/Imported'，
// 所以那个分支永远进不去。给一张读不到的表配编辑器，用户改完发现毫无效果。
// 等真的有资产库导入入口了再把编辑器加回来。
const editingExtensions = ref<
  Record<string, { extension: string; assetType: string; savedKey: string }>
>({})

/**
 * 这一轮点掉了哪些出厂键。只由三个删除按钮写入。
 *
 * **删除不能从「交上去的表里缺了哪个键」倒推。** 用户把 `SoundWave` 的前缀
 * 从 `A_` 改成 `SFX_` 时会先把输入框清空，而清空超过 AUTO_SAVE_DELAY 就自动保存了一次 ——
 * 倒推的话这一刻就把 `SoundWave` 永久记成已删除，他打完字也救不回来
 * （只剩「恢复默认」，代价是抹掉他其他所有自定义）。所以清空只是「这一刻没值」，
 * 删除另外显式报。
 *
 * 不必攒全历史：主进程会把这份和盘上已经记着的合并，重复报同一个键是幂等的。
 */
const removedKeys = ref<RemovedNamingKeys>({})

const recordRemovedKey = (field: keyof RemovedNamingKeys, key: string): void => {
  if (!key) return
  const list = removedKeys.value[field] ?? []
  if (!list.includes(key)) removedKeys.value[field] = [...list, key]
}

/**
 * 就地改一行的键 = 老键那一行没了，得报上去。
 *
 * 键格空着的不算改名 —— 那是「这一刻没值」，`savedKey` 继续生效。
 * 打字半途（`SoundW`）新键在表里、老键不在，语义正好对；用户撤回改名、键格回到老键时，
 * 主进程那条「这张表里还在的键一定没被删掉」会自动把它解开。
 */
const recordRenamedKey = (
  field: keyof RemovedNamingKeys,
  savedKey: string,
  currentKey: string
): void => {
  if (!savedKey || !currentKey || savedKey === currentKey) return
  recordRemovedKey(field, savedKey)
}

/** 这一刻的删除列表快照：数组也拷一份，否则后续 recordRemovedKey 会写进同一个对象 */
const snapshotRemovedKeys = (): RemovedNamingKeys => {
  const copy: RemovedNamingKeys = {}
  for (const [field, keys] of Object.entries(removedKeys.value) as [
    keyof RemovedNamingKeys,
    string[]
  ][]) {
    if (keys?.length) copy[field] = [...keys]
  }
  return copy
}

/**
 * 存成功之后，把**这一次交出去的**那些键从列表里去掉。
 *
 * 盘上那份已经记住了历史删除（主进程把两份合并），渲染层不需要攒着。攒着的后果是
 * 「删掉又手打回来」会被重新删掉一次：盘上的删除被「表里还在」解开了，可这边列表里
 * 那条还在 —— 他接着改这一行的前缀、清空输入框、自动保存，它又落盘成已删除。
 *
 * 只清交出去的那些，不整份清空：保存是异步的，用户可能在等响应的空档里又点了一个
 * 垃圾桶，那一条还没落盘，一把清空等于把它吞掉。
 */
const dropSubmittedRemovedKeys = (submitted: RemovedNamingKeys): void => {
  const pending: RemovedNamingKeys = {}
  for (const [field, keys] of Object.entries(removedKeys.value) as [
    keyof RemovedNamingKeys,
    string[]
  ][]) {
    const sent = new Set(submitted[field] ?? [])
    const rest = keys.filter((key) => !sent.has(key))
    if (rest.length > 0) pending[field] = rest
  }
  removedKeys.value = pending
}

/**
 * 自动保存的比较基准。
 *
 * 删除列表也算在里面：清空了值的那一行再点删除，配置本身不变
 * （那个键早就不在表里了），只有删除列表变 —— 不比这一份的话这次删除永远存不下去。
 */
const changeSnapshot = (): string =>
  JSON.stringify({ config: config.value, removedKeys: removedKeys.value })

// 折叠状态（默认收起）
const collapsedSections = ref({
  assetPrefixes: true,
  textureSuffixPatterns: true,
  assetTypeToDirectory: true,
  extensionToAssetType: true,
  namingConvention: false,
  advanced: true,
  customRules: true
})

/**
 * 初始化编辑状态
 */
const initEditingState = (): void => {
  // 初始化资产前缀编辑状态
  editingAssetPrefixes.value = {}
  for (const [assetType, prefix] of Object.entries(config.value.assetPrefixes)) {
    editingAssetPrefixes.value[assetType] = { assetType, prefix, savedKey: assetType }
  }

  // 初始化目录映射编辑状态
  editingDirectories.value = {}
  for (const [assetType, directory] of Object.entries(config.value.assetTypeToDirectory)) {
    editingDirectories.value[assetType] = { assetType, directory, savedKey: assetType }
  }

  // 初始化扩展名映射编辑状态
  editingExtensions.value = {}
  for (const [extension, assetType] of Object.entries(config.value.extensionToAssetType)) {
    editingExtensions.value[extension] = { extension, assetType, savedKey: extension }
  }
}

/**
 * 存盘成功之后，把每一行的 `savedKey` 对齐到刚存进去的那个键。
 *
 * 只动真的写进配置的行（两格都填了的）：半填的行这次压根没落盘，它在盘上还是老键。
 * 不更新的话第二次改名就报错了对象 —— 用户把 `SoundWave` 改成 `A` 存下、再改成 `B`，
 * 报上去的还是 `SoundWave`，盘上那条 `A` 没人删，于是多出一个幽灵行。
 */
const commitSavedKeys = (): void => {
  for (const item of Object.values(editingAssetPrefixes.value)) {
    if (item.assetType && item.prefix) item.savedKey = item.assetType
  }
  for (const item of Object.values(editingDirectories.value)) {
    if (item.assetType && item.directory) item.savedKey = item.assetType
  }
  for (const item of Object.values(editingExtensions.value)) {
    if (item.extension && item.assetType) item.savedKey = item.extension.toLowerCase()
  }
}

/**
 * 同步编辑状态到配置。
 *
 * 值填了一半（类型或值其中一格是空的）的行**跳过不写**，但它仍留在编辑状态里，
 * 也不会被当成删除 —— 用户正在改这一行，不是在删它。主进程那边同样按
 * 「表里没有这个键」= 这一刻没值来处理，删除只认 `removedKeys`。
 *
 * 顺便认一件事：**键格被改成另一个名字的行，老键报进删除列表**（见 `recordRenamedKey`）。
 */
const syncEditingToConfig = (): void => {
  // 同步资产前缀
  config.value.assetPrefixes = {}
  for (const item of Object.values(editingAssetPrefixes.value)) {
    recordRenamedKey('assetPrefixes', item.savedKey, item.assetType)
    if (item.assetType && item.prefix) {
      config.value.assetPrefixes[item.assetType] = item.prefix
    }
  }

  // 同步目录映射
  config.value.assetTypeToDirectory = {}
  for (const item of Object.values(editingDirectories.value)) {
    recordRenamedKey('assetTypeToDirectory', item.savedKey, item.assetType)
    if (item.assetType && item.directory) {
      config.value.assetTypeToDirectory[item.assetType] = item.directory
    }
  }

  // 同步扩展名映射
  config.value.extensionToAssetType = {}
  for (const item of Object.values(editingExtensions.value)) {
    // 扩展名一律按小写比，`TGA` 和 `tga` 不是改名
    recordRenamedKey('extensionToAssetType', item.savedKey, item.extension.toLowerCase())
    if (item.extension && item.assetType) {
      config.value.extensionToAssetType[item.extension.toLowerCase()] = item.assetType
    }
  }
}

/**
 * 键格填成同一个值的那些行。
 *
 * `syncEditingToConfig` 按「后者覆盖前者」落盘，所以键重复时只有最后一行真的生效，
 * 而存完又不重建编辑行（否则正在输入的那一行焦点会丢），两行在界面上长得一模一样 ——
 * 用户看不出哪一行算数。给它们一个底色，至少看得出这两行在打架。
 */
const duplicatedIn = (keys: string[]): Set<string> => {
  const seen = new Set<string>()
  const duplicated = new Set<string>()
  for (const key of keys) {
    if (!key) continue
    if (seen.has(key)) duplicated.add(key)
    seen.add(key)
  }
  return duplicated
}

const duplicatePrefixKeys = computed(() =>
  duplicatedIn(Object.values(editingAssetPrefixes.value).map((item) => item.assetType))
)
const duplicateDirectoryKeys = computed(() =>
  duplicatedIn(Object.values(editingDirectories.value).map((item) => item.assetType))
)
const duplicateExtensionKeys = computed(() =>
  duplicatedIn(Object.values(editingExtensions.value).map((item) => item.extension.toLowerCase()))
)

/**
 * 加载配置。
 *
 * 走 `refreshNamingRulesConfig` 而不是 `loadNamingRulesConfig`：后者命中缓存就直接返回，
 * 而这一页任何一次自动保存都会写缓存 —— 于是「重新加载」按钮在第一次保存之后
 * 就只是把内存里那份原样交回来，看不出盘上到底存成了什么样。删除现在是真的落盘，
 * 这个按钮更得老老实实回去读一次。
 */
const loadConfig = async (): Promise<void> => {
  try {
    loading.value = true
    config.value = await refreshNamingRulesConfig()
  } catch (error) {
    console.error('加载配置失败:', error)
    message.error(t('profile.namingRules.loadFailed'))
  } finally {
    // 编辑行无论成败都要和 config 对齐
    initEditingState()
    // 盘上那份已经带着之前的删除了，这一轮的列表从头开始
    removedKeys.value = {}
    lastConfigSnapshot = changeSnapshot()
    loading.value = false
  }
}

/**
 * 保存配置（内部方法）
 */
const doSave = async (showMessage = false): Promise<boolean> => {
  try {
    autoSaving.value = true
    // 先同步编辑状态到配置
    syncEditingToConfig()
    // 交出去的那一份要先拍下来：服务层在第一个 await 之前就把它序列化走了，
    // 等响应期间新点的删除不在这次的 payload 里（见 dropSubmittedRemovedKeys）
    const submitted = snapshotRemovedKeys()
    const success = await saveNamingRulesConfig(config.value, submitted)
    if (success) {
      // 这一轮的键已经落盘，列表里把它们去掉；每一行的 savedKey 跟着对齐到刚存的键
      commitSavedKeys()
      dropSubmittedRemovedKeys(submitted)
      // 存完**不重建编辑行**。编辑状态本来就是这几张表的真相源（config 是从它同步出来的），
      // 重建一次没有新信息，却会把用户正在输入的那一行从 DOM 上换掉：值填了一半的行
      // 不写进 config，于是重建时整行消失、焦点丢失 —— 自动保存是 2 秒防抖，
      // 这正好发生在他打字的停顿里
      // 更新配置快照
      lastConfigSnapshot = changeSnapshot()
      lastSavedTime.value = new Date()
      if (showMessage) {
        message.success(t('profile.namingRules.saveSuccess'))
      }
      return true
    } else {
      if (showMessage) {
        message.error(t('profile.namingRules.saveFailed'))
      }
      return false
    }
  } catch (error) {
    console.error('保存配置失败:', error)
    if (showMessage) {
      message.error(t('profile.namingRules.saveFailed'))
    }
    return false
  } finally {
    autoSaving.value = false
  }
}

/**
 * 手动保存（显示提示）
 */
const handleSave = async (): Promise<void> => {
  saving.value = true
  await doSave(true)
  saving.value = false
}

/**
 * 自动保存（防抖）
 */
const autoSave = (): void => {
  // 清除之前的定时器
  if (autoSaveTimer !== null) {
    clearTimeout(autoSaveTimer)
  }

  // 设置新的定时器
  autoSaveTimer = window.setTimeout(() => {
    // 先同步编辑状态到配置
    syncEditingToConfig()

    // 序列化当前配置用于比较
    const currentConfigStr = changeSnapshot()

    // 只有当配置真的变化了才保存
    if (currentConfigStr !== lastConfigSnapshot) {
      lastConfigSnapshot = currentConfigStr
      void doSave(false)
    }

    autoSaveTimer = null
  }, AUTO_SAVE_DELAY)
}

/**
 * 重置配置
 */
const handleReset = (): void => {
  confirmDialog({
    title: t('profile.namingRules.reset'),
    content: t('profile.namingRules.resetConfirm'),
    onOk: async () => {
      try {
        const success = await resetNamingRulesConfig()
        if (success) {
          config.value = getNamingRulesConfig()
          initEditingState()
          // 出厂条目全回来了，这一轮的删除列表跟着清空
          removedKeys.value = {}
          // 更新配置快照
          lastConfigSnapshot = changeSnapshot()
          message.success(t('profile.namingRules.resetSuccess'))
        } else {
          message.error(t('profile.namingRules.resetFailed'))
        }
      } catch (error) {
        console.error('重置配置失败:', error)
        message.error(t('profile.namingRules.resetFailed'))
      }
    }
  })
}

/**
 * 添加资产前缀
 */
const handleAddAssetPrefix = (): void => {
  const newKey = `new_${Date.now()}`
  editingAssetPrefixes.value[newKey] = { assetType: '', prefix: '', savedKey: '' }
}

/**
 * 删一行要报的键：这一行在盘上可能叫过的每一个名字。
 *
 * 三个都报 —— 编辑行的内部 key（读上来那一刻的键）、`savedKey`（上次落盘用的键，
 * 改过名又存过的行和内部 key 不一样）、键格现在填的值。空串和重复由
 * `recordRemovedKey` 挡掉；内部 key 是新加行的 `new_<时间戳>` 时，主进程那道
 * 「只记出厂键」的过滤天然会把它丢掉。
 *
 * 只报键格那一个值不够：用户先清空「资产类型」那一格（清整行是很自然的动作）
 * 再点垃圾桶，报上去的是空串 —— 一条删除都没记，重开页面这行又被出厂值垫回来，
 * 点垃圾桶等于没点。
 */
const recordRemovedRow = (field: keyof RemovedNamingKeys, keys: string[]): void => {
  for (const key of keys) recordRemovedKey(field, key)
}

/**
 * 删除资产前缀
 */
const handleRemoveAssetPrefix = (key: string): void => {
  const item = editingAssetPrefixes.value[key]
  recordRemovedRow('assetPrefixes', [key, item?.savedKey ?? '', item?.assetType ?? ''])
  delete editingAssetPrefixes.value[key]
}

/**
 * 添加纹理后缀模式
 */
const handleAddTexturePattern = (): void => {
  const newPattern: TextureSuffixPattern = {
    pattern: '',
    suffix: '',
    type: '',
    enabled: true
  }
  config.value.textureSuffixPatterns.push(newPattern)
}

/**
 * 删除纹理后缀模式
 */
const handleRemoveTexturePattern = (index: number): void => {
  config.value.textureSuffixPatterns.splice(index, 1)
}

/**
 * 添加目录映射
 */
const handleAddDirectoryMapping = (): void => {
  const newKey = `new_${Date.now()}`
  editingDirectories.value[newKey] = { assetType: '', directory: '', savedKey: '' }
}

/**
 * 删除目录映射
 */
const handleRemoveDirectoryMapping = (key: string): void => {
  const item = editingDirectories.value[key]
  recordRemovedRow('assetTypeToDirectory', [key, item?.savedKey ?? '', item?.assetType ?? ''])
  delete editingDirectories.value[key]
}

/**
 * 添加自定义改名规则。
 *
 * 这一块以前只在配置结构和语言包里存在，页面从来没渲染过，导入流程也没接 ——
 * 一份彻底的死代码。现在它有了明确用途：**整理工程时的改名依据**
 * （`main/agent-v3/tools/ue-content/namingPolicy.ts`）。前缀表按类型给前缀，
 * 这里管前缀表表达不了的那些：去掉 `_FINAL` / `_v2`、`Temp_` 换成 `WIP_` 之类。
 *
 * 导入时**不生效**，只在整理时生效 —— 这是 2026-09-10 定的分工，不是漏接。
 */
const handleAddCustomRule = (): void => {
  config.value.customRules = [
    ...(config.value.customRules ?? []),
    { name: '', match: 'endsWith', text: '', replacement: '', enabled: true }
  ]
}

/**
 * 删除自定义改名规则
 */
const handleRemoveCustomRule = (index: number): void => {
  const rules = [...(config.value.customRules ?? [])]
  rules.splice(index, 1)
  config.value.customRules = rules
}

/**
 * 添加扩展名映射
 */
const handleAddExtensionMapping = (): void => {
  const newKey = `new_${Date.now()}`
  editingExtensions.value[newKey] = { extension: '', assetType: '', savedKey: '' }
}

/**
 * 删除扩展名映射
 */
const handleRemoveExtensionMapping = (key: string): void => {
  const item = editingExtensions.value[key]
  // 扩展名落盘前统一转小写（见 syncEditingToConfig），删除列表也得按小写记，否则对不上
  recordRemovedRow('extensionToAssetType', [
    key.toLowerCase(),
    (item?.savedKey ?? '').toLowerCase(),
    (item?.extension ?? '').toLowerCase()
  ])
  delete editingExtensions.value[key]
}

// 监听编辑状态变化，自动保存
watch(
  () => editingAssetPrefixes.value,
  () => {
    autoSave()
  },
  { deep: true }
)

watch(
  () => editingDirectories.value,
  () => {
    autoSave()
  },
  { deep: true }
)

watch(
  () => editingExtensions.value,
  () => {
    autoSave()
  },
  { deep: true }
)

// 监听配置中的其他字段变化（纹理模式、命名约定等）
watch(
  () => [
    config.value.textureSuffixPatterns,
    config.value.customRules,
    config.value.namingConvention,
    config.value.autoAddPrefix,
    config.value.autoDetectTextureType
  ],
  () => {
    autoSave()
  },
  { deep: true }
)

onMounted(() => {
  loadConfig()
})

// 组件卸载时清理定时器
onUnmounted(() => {
  if (autoSaveTimer !== null) {
    clearTimeout(autoSaveTimer)
    autoSaveTimer = null
  }
})
</script>

<template>
  <div class="profile-naming-rules">
    <!-- Actions -->
    <div class="actions-bar">
      <div class="save-status">
        <span v-if="autoSaving" class="saving-indicator">
          <AppSpin size="small" style="margin-right: 4px" />
          {{ $t('profile.namingRules.saving') }}
        </span>
        <span v-else-if="lastSavedTime" class="saved-indicator">
          {{ $t('profile.namingRules.autoSaved') }}
        </span>
      </div>
      <div class="actions-buttons">
        <AppButton :loading="loading" @click="loadConfig">
          <template #icon><PhArrowClockwise /></template>
          {{ $t('profile.namingRules.reload') }}
        </AppButton>
        <AppButton danger @click="handleReset">
          <template #icon><PhArrowClockwise /></template>
          {{ $t('profile.namingRules.reset') }}
        </AppButton>
      </div>
    </div>

    <!-- 命名约定 -->
    <div class="settings-group">
      <div
        class="group-title-collapsible"
        @click="collapsedSections.namingConvention = !collapsedSections.namingConvention"
      >
        <PhCaretRight
          weight="fill"
          class="collapse-icon"
          :class="{ collapsed: collapsedSections.namingConvention }"
        />
        <h3 class="group-title">{{ $t('profile.namingRules.namingConvention.title') }}</h3>
      </div>
      <div v-show="!collapsedSections.namingConvention" class="settings-card">
        <div class="setting-row">
          <div class="row-content">
            <div class="row-title">
              {{ $t('profile.namingRules.namingConvention.description') }}
            </div>
          </div>
          <div class="row-control">
            <a-select v-model:value="config.namingConvention" style="width: 200px">
              <a-select-option value="pascalCase">{{
                $t('profile.namingRules.namingConvention.pascalCase')
              }}</a-select-option>
              <a-select-option value="camelCase">{{
                $t('profile.namingRules.namingConvention.camelCase')
              }}</a-select-option>
              <a-select-option value="snake_case">{{
                $t('profile.namingRules.namingConvention.snake_case')
              }}</a-select-option>
              <a-select-option value="kebab-case">{{
                $t('profile.namingRules.namingConvention.kebab-case')
              }}</a-select-option>
            </a-select>
          </div>
        </div>
      </div>
    </div>

    <!-- 资产前缀 -->
    <div class="settings-group">
      <div
        class="group-title-collapsible"
        @click="collapsedSections.assetPrefixes = !collapsedSections.assetPrefixes"
      >
        <PhCaretRight
          weight="fill"
          class="collapse-icon"
          :class="{ collapsed: collapsedSections.assetPrefixes }"
        />
        <h3 class="group-title">{{ $t('profile.namingRules.assetPrefixes.title') }}</h3>
      </div>
      <div v-show="!collapsedSections.assetPrefixes" class="settings-card">
        <div class="setting-row-header">
          <div class="row-title">{{ $t('profile.namingRules.assetPrefixes.assetType') }}</div>
          <div class="row-title">{{ $t('profile.namingRules.assetPrefixes.prefix') }}</div>
          <div class="row-title">{{ $t('common.operation') }}</div>
        </div>
        <div
          v-for="(item, key) in editingAssetPrefixes"
          :key="key"
          class="setting-row editable-row"
          :class="{ 'duplicate-key': duplicatePrefixKeys.has(item.assetType) }"
        >
          <div class="row-content">
            <a-input
              v-model:value="item.assetType"
              :placeholder="$t('profile.namingRules.assetPrefixes.assetType')"
            />
          </div>
          <div class="row-content">
            <a-input
              v-model:value="item.prefix"
              :placeholder="$t('profile.namingRules.assetPrefixes.prefix')"
            />
          </div>
          <div class="row-control">
            <AppButton variant="text" danger size="small" @click="handleRemoveAssetPrefix(key)">
              <template #icon><PhTrash /></template>
            </AppButton>
          </div>
        </div>
        <div class="setting-row">
          <AppButton variant="dashed" block @click="handleAddAssetPrefix">
            <template #icon><PhPlus /></template>
            {{ $t('profile.namingRules.assetPrefixes.add') }}
          </AppButton>
        </div>
      </div>
    </div>

    <!-- 纹理后缀模式 -->
    <div class="settings-group">
      <div
        class="group-title-collapsible"
        @click="collapsedSections.textureSuffixPatterns = !collapsedSections.textureSuffixPatterns"
      >
        <PhCaretRight
          weight="fill"
          class="collapse-icon"
          :class="{ collapsed: collapsedSections.textureSuffixPatterns }"
        />
        <h3 class="group-title">{{ $t('profile.namingRules.textureSuffixPatterns.title') }}</h3>
      </div>
      <div v-show="!collapsedSections.textureSuffixPatterns" class="settings-card">
        <div
          v-for="(pattern, index) in config.textureSuffixPatterns"
          :key="index"
          class="setting-row texture-pattern-row"
        >
          <div class="row-content">
            <a-input
              v-model:value="pattern.pattern"
              :placeholder="$t('profile.namingRules.textureSuffixPatterns.pattern')"
              style="margin-bottom: 8px"
            />
            <a-input
              v-model:value="pattern.suffix"
              :placeholder="$t('profile.namingRules.textureSuffixPatterns.suffix')"
              style="margin-bottom: 8px"
            />
            <a-input
              v-model:value="pattern.type"
              :placeholder="$t('profile.namingRules.textureSuffixPatterns.type')"
            />
          </div>
          <div class="row-control">
            <AppSwitch v-model:checked="pattern.enabled" style="margin-right: 8px" />
            <AppButton
              variant="text"
              danger
              size="small"
              @click="handleRemoveTexturePattern(index)"
            >
              <template #icon><PhTrash /></template>
            </AppButton>
          </div>
        </div>
        <div class="setting-row">
          <AppButton variant="dashed" block @click="handleAddTexturePattern">
            <template #icon><PhPlus /></template>
            {{ $t('profile.namingRules.textureSuffixPatterns.add') }}
          </AppButton>
        </div>
      </div>
    </div>

    <!-- 目录映射 -->
    <div class="settings-group">
      <div
        class="group-title-collapsible"
        @click="collapsedSections.assetTypeToDirectory = !collapsedSections.assetTypeToDirectory"
      >
        <PhCaretRight
          weight="fill"
          class="collapse-icon"
          :class="{ collapsed: collapsedSections.assetTypeToDirectory }"
        />
        <h3 class="group-title">{{ $t('profile.namingRules.assetTypeToDirectory.title') }}</h3>
      </div>
      <div v-show="!collapsedSections.assetTypeToDirectory" class="settings-card">
        <div class="setting-row-header">
          <div class="row-title">
            {{ $t('profile.namingRules.assetTypeToDirectory.assetType') }}
          </div>
          <div class="row-title">
            {{ $t('profile.namingRules.assetTypeToDirectory.directory') }}
          </div>
          <div class="row-title">{{ $t('common.operation') }}</div>
        </div>
        <div
          v-for="(item, key) in editingDirectories"
          :key="key"
          class="setting-row editable-row"
          :class="{ 'duplicate-key': duplicateDirectoryKeys.has(item.assetType) }"
        >
          <div class="row-content">
            <a-input
              v-model:value="item.assetType"
              :placeholder="$t('profile.namingRules.assetTypeToDirectory.assetType')"
            />
          </div>
          <div class="row-content">
            <a-input
              v-model:value="item.directory"
              :placeholder="$t('profile.namingRules.assetTypeToDirectory.directoryPlaceholder')"
            />
          </div>
          <div class="row-control">
            <AppButton
              variant="text"
              danger
              size="small"
              @click="handleRemoveDirectoryMapping(key)"
            >
              <template #icon><PhTrash /></template>
            </AppButton>
          </div>
        </div>
        <div class="setting-row">
          <AppButton variant="dashed" block @click="handleAddDirectoryMapping">
            <template #icon><PhPlus /></template>
            {{ $t('profile.namingRules.assetTypeToDirectory.add') }}
          </AppButton>
        </div>
      </div>
    </div>

    <!-- 扩展名映射 -->
    <div class="settings-group">
      <div
        class="group-title-collapsible"
        @click="collapsedSections.extensionToAssetType = !collapsedSections.extensionToAssetType"
      >
        <PhCaretRight
          weight="fill"
          class="collapse-icon"
          :class="{ collapsed: collapsedSections.extensionToAssetType }"
        />
        <h3 class="group-title">{{ $t('profile.namingRules.extensionToAssetType.title') }}</h3>
      </div>
      <div v-show="!collapsedSections.extensionToAssetType" class="settings-card">
        <div class="setting-row-header">
          <div class="row-title">
            {{ $t('profile.namingRules.extensionToAssetType.extension') }}
          </div>
          <div class="row-title">
            {{ $t('profile.namingRules.extensionToAssetType.assetType') }}
          </div>
          <div class="row-title">{{ $t('common.operation') }}</div>
        </div>
        <div
          v-for="(item, key) in editingExtensions"
          :key="key"
          class="setting-row editable-row"
          :class="{ 'duplicate-key': duplicateExtensionKeys.has(item.extension.toLowerCase()) }"
        >
          <div class="row-content">
            <a-input
              v-model:value="item.extension"
              :placeholder="$t('profile.namingRules.extensionToAssetType.extensionPlaceholder')"
            />
          </div>
          <div class="row-content">
            <a-input
              v-model:value="item.assetType"
              :placeholder="$t('profile.namingRules.extensionToAssetType.assetType')"
            />
          </div>
          <div class="row-control">
            <AppButton
              variant="text"
              danger
              size="small"
              @click="handleRemoveExtensionMapping(key)"
            >
              <template #icon><PhTrash /></template>
            </AppButton>
          </div>
        </div>
        <div class="setting-row">
          <AppButton variant="dashed" block @click="handleAddExtensionMapping">
            <template #icon><PhPlus /></template>
            {{ $t('profile.namingRules.extensionToAssetType.add') }}
          </AppButton>
        </div>
      </div>
    </div>

    <!--
      自定义改名规则。以前配置结构和语言包里都有，页面从来没渲染过 —— 死代码。
      现在它是整理工程时的改名依据（见 namingPolicy.ts），所以得有地方填。
    -->
    <div class="settings-group">
      <div
        class="group-title-collapsible"
        @click="collapsedSections.customRules = !collapsedSections.customRules"
      >
        <PhCaretRight
          weight="fill"
          class="collapse-icon"
          :class="{ collapsed: collapsedSections.customRules }"
        />
        <h3 class="group-title">{{ $t('profile.namingRules.customRules.title') }}</h3>
      </div>
      <div v-show="!collapsedSections.customRules" class="settings-card">
        <div class="setting-row">
          <div class="row-content">
            <div class="row-desc">{{ $t('profile.namingRules.customRules.description') }}</div>
          </div>
        </div>
        <div
          v-for="(rule, index) in config.customRules ?? []"
          :key="index"
          class="setting-row texture-pattern-row"
        >
          <div class="row-content custom-rule-fields">
            <a-input
              v-model:value="rule.name"
              :placeholder="$t('profile.namingRules.customRules.name')"
            />
            <div class="custom-rule-match">
              <a-select v-model:value="rule.match" class="custom-rule-where">
                <a-select-option value="endsWith">
                  {{ $t('profile.namingRules.customRules.endsWith') }}
                </a-select-option>
                <a-select-option value="startsWith">
                  {{ $t('profile.namingRules.customRules.startsWith') }}
                </a-select-option>
                <a-select-option value="contains">
                  {{ $t('profile.namingRules.customRules.contains') }}
                </a-select-option>
              </a-select>
              <a-input
                v-model:value="rule.text"
                :placeholder="$t('profile.namingRules.customRules.textPlaceholder')"
              />
            </div>
            <a-input
              v-model:value="rule.replacement"
              :placeholder="$t('profile.namingRules.customRules.replacementPlaceholder')"
            />
          </div>
          <div class="row-control custom-rule-control">
            <AppSwitch v-model:checked="rule.enabled" />
            <AppButton variant="text" danger size="small" @click="handleRemoveCustomRule(index)">
              <template #icon><PhTrash /></template>
            </AppButton>
          </div>
        </div>
        <div class="setting-row">
          <AppButton variant="dashed" block @click="handleAddCustomRule">
            <template #icon><PhPlus /></template>
            {{ $t('profile.namingRules.customRules.add') }}
          </AppButton>
        </div>
      </div>
    </div>

    <!-- 高级选项 -->
    <div class="settings-group">
      <div
        class="group-title-collapsible"
        @click="collapsedSections.advanced = !collapsedSections.advanced"
      >
        <PhCaretRight
          weight="fill"
          class="collapse-icon"
          :class="{ collapsed: collapsedSections.advanced }"
        />
        <h3 class="group-title">{{ $t('profile.namingRules.advanced.title') }}</h3>
      </div>
      <div v-show="!collapsedSections.advanced" class="settings-card">
        <div class="setting-row">
          <div class="row-content">
            <div class="row-title">{{ $t('profile.namingRules.advanced.autoAddPrefix') }}</div>
            <div class="row-desc">{{ $t('profile.namingRules.advanced.autoAddPrefixDesc') }}</div>
          </div>
          <div class="row-control">
            <AppSwitch v-model:checked="config.autoAddPrefix" />
          </div>
        </div>
        <div class="setting-row">
          <div class="row-content">
            <div class="row-title">
              {{ $t('profile.namingRules.advanced.autoDetectTextureType') }}
            </div>
            <div class="row-desc">
              {{ $t('profile.namingRules.advanced.autoDetectTextureTypeDesc') }}
            </div>
          </div>
          <div class="row-control">
            <AppSwitch v-model:checked="config.autoDetectTextureType" />
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped lang="less">
.profile-naming-rules {
  display: flex;
  flex-direction: column;
  gap: 24px;
  padding: 0 4px;
  animation: fadeIn 0.3s ease;
}

.actions-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;

  .save-status {
    display: flex;
    align-items: center;
    font-size: 13px;
    color: var(--color-text-secondary);

    .saving-indicator {
      color: var(--color-accent-text);
      display: flex;
      align-items: center;
    }

    .saved-indicator {
      color: var(--color-success-text);
    }
  }

  .actions-buttons {
    display: flex;
    gap: 12px;
  }
}

.settings-group {
  display: flex;
  flex-direction: column;
  gap: 12px;

  .group-title {
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-medium);
    color: var(--color-text-primary);
    margin: 0;
    padding-bottom: var(--space-2);
    border-bottom: 1px solid var(--color-border-subtle);
    letter-spacing: 0.02em;
    width: 100%;
  }

  .group-title-collapsible {
    display: flex;
    align-items: center;
    gap: 8px;
    cursor: pointer;
    user-select: none;
    padding: 4px;
    margin: 0 0 0 -4px;
    border-radius: 4px;
    transition: background-color 0.2s;

    &:hover {
      background-color: var(--color-bg-surface-hover);
    }

    .collapse-icon {
      font-size: 12px;
      color: var(--color-text-muted);
      transition: transform 0.2s;
      transform: rotate(0deg);

      &:not(.collapsed) {
        transform: rotate(90deg);
      }
    }
  }
}

.settings-card {
  background: var(--color-bg-surface);
  border: 1px solid var(--color-border-subtle);
  border-radius: 8px;
  overflow: hidden;
  display: flex;
  flex-direction: column;

  .setting-row:not(:last-child) {
    border-bottom: 1px solid var(--color-border-subtle);
  }

  .setting-row-header {
    display: flex;
    align-items: center;
    padding: 12px 20px;
    gap: 16px;
    background: var(--color-bg-surface-hover);
    font-weight: 600;
    font-size: 13px;
    color: var(--color-text-secondary);

    .row-title {
      flex: 1;
    }
  }
}

.setting-row {
  display: flex;
  align-items: center;
  padding: 16px 20px;
  gap: 16px;
  transition: background-color 0.2s;
  min-height: 48px;

  .row-icon {
    font-size: 20px;
    color: var(--color-text-secondary);
    width: 24px;
    display: flex;
    justify-content: center;
  }

  .row-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4px;
    overflow: hidden;

    .row-title {
      font-size: var(--font-size-sm);
      color: var(--color-text-primary);
    }

    .row-desc {
      font-size: 12px;
      color: var(--color-text-muted);
    }
  }

  .row-control {
    display: flex;
    align-items: center;
    gap: 12px;
  }

  &.texture-pattern-row {
    flex-direction: column;
    align-items: stretch;

    .row-content {
      display: flex;
      flex-direction: column;
    }
  }

  // 自定义改名规则那三格。间距走 --space-2（=8px），不写死像素
  .custom-rule-fields {
    gap: var(--space-2);
  }

  .custom-rule-match {
    display: flex;
    gap: var(--space-2);

    .custom-rule-where {
      flex: 0 0 auto;
      min-width: 120px;
    }

    :deep(.ant-input) {
      flex: 1 1 auto;
    }
  }

  .custom-rule-control {
    gap: var(--space-2);
  }

  &.editable-row {
    .row-content {
      min-width: 0;

      :deep(.ant-input) {
        font-size: 13px;
      }
    }
  }

  // 键重复的行：只有最后一行真的生效，所以这几行要能被看出来（见 duplicatedIn）
  &.duplicate-key {
    background: var(--color-warning-bg);
  }
}

@keyframes fadeIn {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
