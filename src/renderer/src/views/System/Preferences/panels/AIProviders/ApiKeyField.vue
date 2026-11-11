<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import AppModal from '@renderer/components/AppModal.vue'
/**
 * 密钥字段 —— 一个输入框，四种来源，外加账号登录。
 *
 * 单独成一个组件是因为它自己就有一整套规则：三种形态靠**输入的形状**区分
 * （与 pi-web 一致），第四种是 OAuth 换来的令牌（根本不进这个框）。
 * 这些判断混在 Provider 表单里，那个表单就没法读了。
 *
 *   `!op read op://vault/openai/key`  → 执行命令取
 *   `OPENAI_API_KEY`                  → 读环境变量
 *   `sk-proj-...`                     → 密钥本身，加密存起来
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { message } from '@renderer/utils/messageManager'
import { PhEye, PhEyeSlash } from '@phosphor-icons/vue'
import type { AiProvidersState } from './useAiProviders'

const props = defineProps<{ state: AiProvidersState }>()

const { t } = useI18n()
const { draft, providers, catalog, selectedId, authorizing } = props.state

const showApiKey = ref(false)

/** 当前这条是不是已经用账号登录过 */
const savedOAuth = computed(() => {
  const saved = providers.value.find((item) => item.id === selectedId.value)
  return saved?.apiKey.kind === 'oauth' && saved.apiKey.hasKey
})

/** 已保存的那条是不是 literal 且已配置 —— 决定「留空」是沿用还是清空 */
const savedLiteralKey = computed(() => {
  const saved = providers.value.find((item) => item.id === selectedId.value)
  return saved?.apiKey.kind === 'literal' && saved.apiKey.hasKey
})

/**
 * 实时回显当前输入被判成哪一档。
 *
 * 三种形态共用一个框，靠形状区分，用户没有别的办法确认自己写对了 ——
 * 把 `!` 漏掉就会把整条命令当成密钥原样加密存起来，直到调用时才报错。
 * 判据必须与主进程 parseApiKeyInput 保持一致。
 */
const apiKeyKind = computed<'none' | 'shell' | 'env' | 'literal' | 'keep' | 'oauth'>(() => {
  const raw = (draft.value?.apiKeyInput || '').trim()
  if (!raw) {
    if (savedOAuth.value) return 'oauth'
    return savedLiteralKey.value ? 'keep' : 'none'
  }
  if (raw.startsWith('!')) return 'shell'
  if (/^[A-Z][A-Z0-9_]*$/.test(raw)) return 'env'
  return 'literal'
})

/** literal 才需要打码；env 变量名和取密钥的命令都不是机密 */
const apiKeyIsSecret = computed(() => apiKeyKind.value === 'literal')

/**
 * 当前草稿对应的目录条目支不支持账号登录。
 *
 * 按**目录 id** 匹配而不是草稿 id —— 草稿 id 可能因为撞车被改成 openrouter-2，
 * 但它仍然是同一家，登录方式不变。
 */
const oauthEntry = computed(() => {
  const draftId = draft.value?.id || ''
  if (!draftId) return undefined
  return catalog.value.find((entry) => entry.supportsOAuth && draftId.startsWith(entry.id))
})

/**
 * 同一个账号已经在别的来源登录过：保存时主进程会直接共用那份登录（ipc.ts 的 sharedOAuthKey），
 * 这里先说出来，免得用户以为还得再授权一遍。判据与主进程一致：按草稿的目录条目认账号。
 */
const sharedLogin = computed(() => {
  if (savedOAuth.value || (draft.value?.apiKeyInput || '').trim()) return undefined
  const entry = catalog.value.find((item) => item.id === draft.value?.catalogId)
  if (!entry?.supportsOAuth) return undefined
  const account = entry.oauthProvider ?? entry.id
  return providers.value.find(
    (item) =>
      item.id !== selectedId.value &&
      item.apiKey.kind === 'oauth' &&
      item.apiKey.provider === account &&
      item.apiKey.hasKey
  )
})

/** 「去获取 API Key」的地址。同样按目录 id 前缀匹配 */
const apiKeyUrl = computed(() => {
  const draftId = draft.value?.id || ''
  if (!draftId) return ''
  return catalog.value.find((entry) => draftId.startsWith(entry.id))?.apiKeyUrl || ''
})

async function openApiKeyUrl(): Promise<void> {
  if (!apiKeyUrl.value) return
  // 返回值必须看：shell:* 失败时是 return {success:false}，不抛
  const res = await window.api.shell.openExternal(apiKeyUrl.value)
  if (!res?.success) {
    message.error(`无法打开网址：${apiKeyUrl.value}`, 8)
  }
}

/**
 * 刚刚从账号换回了一把密钥、还没保存。
 *
 * OpenRouter 那条路换回来的是**永久 Key**，只是被填进输入框 —— 而输入框里
 * 密钥是打码的，用户看不出多了东西，一个 toast 飘过去就什么线索都没了。
 */
const keyJustFetched = ref(false)
watch(selectedId, () => {
  keyJustFetched.value = false
})

/** 设备码流程要显示给用户的那串码 */
const devicePrompt = ref<{
  userCode: string
  verificationUri: string
  verificationUriComplete?: string
} | null>(null)

let stopDeviceCodeListener: (() => void) | null = null
onMounted(() => {
  // 这里**必须**兜住异常。
  //
  // onMounted 里抛出去会中断 Vue 的 post-flush 队列，后果远不止这个面板打不开：
  // 整个应用的界面都不再更新，看上去像卡死（`onOAuthDeviceCode` 曾经只写在
  // preload 的 .d.ts 里、没有真的实现，就是这个表现 —— 类型检查全绿，
  // 一点开「模型」页整个 APP 就没反应了）。
  try {
    stopDeviceCodeListener =
      window.api.aiProvider.onOAuthDeviceCode?.((prompt) => {
        devicePrompt.value = prompt
      }) ?? null
  } catch (error) {
    console.error('[AI 助手] 设备码事件订阅失败，登录时那串码将不会显示:', error)
  }
})
onUnmounted(() => stopDeviceCodeListener?.())

async function handleOAuthLogin(): Promise<void> {
  const entry = oauthEntry.value
  if (!entry) return

  message.info(t('aiProvider.apiKey.oauthOpening'))
  devicePrompt.value = null
  const result = await props.state.oauthLogin(entry.oauthProvider ?? entry.id)
  devicePrompt.value = null

  if (result.cancelled) return
  if (!result.ok) {
    message.error(result.error || t('aiProvider.messages.oauthFailed'))
    return
  }
  // saved=true 表示令牌已由主进程直接落盘（令牌不能过渲染层），无需再点保存
  keyJustFetched.value = !result.saved
  message.success(
    result.saved ? t('aiProvider.messages.oauthSaved') : t('aiProvider.messages.oauthOk')
  )
}

/** 关掉设备码弹窗、或等待中再点一次按钮，都算放弃这次登录 */
async function cancelOAuthLogin(): Promise<void> {
  devicePrompt.value = null
  await props.state.cancelOAuth()
}

async function copyUserCode(): Promise<void> {
  if (!devicePrompt.value) return
  await navigator.clipboard.writeText(devicePrompt.value.userCode)
  message.success(t('aiProvider.messages.codeCopied'))
}
</script>

<template>
  <div v-if="draft" class="api-key">
    <span class="field-label">{{ $t('aiProvider.field.apiKey') }}</span>

    <div class="secret-wrap">
      <input
        v-model="draft.apiKeyInput"
        :type="apiKeyIsSecret && !showApiKey ? 'password' : 'text'"
        class="field-input"
        :placeholder="
          savedLiteralKey
            ? $t('aiProvider.apiKey.keepPlaceholder')
            : $t('aiProvider.apiKey.placeholder')
        "
      />
      <button
        v-if="apiKeyIsSecret"
        type="button"
        class="visibility-btn"
        @click="showApiKey = !showApiKey"
      >
        <PhEye v-if="showApiKey" />
        <PhEyeSlash v-else />
      </button>
    </div>

    <div class="key-row">
      <span v-if="false" class="key-kind" :class="apiKeyKind">
        {{ $t(`aiProvider.apiKey.kind.${apiKeyKind}`) }}
      </span>
      <AppButton
        v-if="oauthEntry"
        variant="soft"
        size="medium"
        @click="authorizing ? cancelOAuthLogin() : handleOAuthLogin()"
      >
        {{
          authorizing
            ? $t('aiProvider.apiKey.authorizing')
            : savedOAuth
              ? $t('aiProvider.apiKey.oauthRelogin')
              : $t('aiProvider.apiKey.oauthLogin', { name: oauthEntry.displayName })
        }}
      </AppButton>
      <!--
        没有账号登录的厂商，密钥得自己去他们后台拿。目录里本来就存着这个地址，
        不放出来的话用户只能对着一个空输入框自己猜去哪儿找。
      -->
      <AppButton v-else-if="apiKeyUrl" variant="soft" size="medium" @click="openApiKeyUrl">
        {{ $t('aiProvider.apiKey.getKey') }}
      </AppButton>
    </div>

    <!--
      登录成功后界面必须**看得出来**。以前只有一个飘过去的 toast：
      令牌那条路密钥根本不进界面，Key 那条路密钥是打码的 ——
      两种情况用户都看不出发生过什么，只能怀疑是不是没成功。
    -->
    <div v-if="savedOAuth && oauthEntry" class="linked">
      <span class="linked-check">✓</span>
      <span>{{
        $t(
          oauthEntry.id === 'zcode'
            ? 'aiProvider.apiKey.zcodeLinked'
            : oauthEntry.id === 'cursor'
              ? 'aiProvider.apiKey.cursorLinked'
              : 'aiProvider.apiKey.oauthLinked',
          { name: oauthEntry.displayName }
        )
      }}</span>
    </div>
    <div v-else-if="keyJustFetched && oauthEntry" class="linked pending">
      <span class="linked-check">✓</span>
      <span>{{ $t('aiProvider.apiKey.oauthKeyFetched', { name: oauthEntry.displayName }) }}</span>
    </div>
    <div v-else-if="sharedLogin" class="linked pending">
      <span class="linked-check">✓</span>
      <span>{{ $t('aiProvider.apiKey.oauthShared', { name: sharedLogin.displayName }) }}</span>
    </div>

    <p class="hint">{{ $t('aiProvider.apiKey.hint') }}</p>
    <p v-if="oauthEntry?.id === 'zcode'" class="hint">{{ $t('aiProvider.apiKey.zcodeHint') }}</p>
    <p v-else-if="oauthEntry?.id === 'cursor'" class="hint">{{ $t('aiProvider.apiKey.cursorHint') }}</p>

    <!-- 设备码流程：把码显示出来，浏览器已自动打开，输不进去时可手输 -->
    <AppModal
      :open="devicePrompt !== null"
      :title="$t('aiProvider.device.title')"
      hide-footer
      centered
      @cancel="cancelOAuthLogin"
    >
      <div v-if="devicePrompt" class="device-box">
        <p class="hint">{{ $t('aiProvider.device.desc') }}</p>
        <button type="button" class="device-code" @click="copyUserCode">
          {{ devicePrompt.userCode }}
        </button>
        <p class="hint">
          {{ $t('aiProvider.device.uri') }}
          <code>{{ devicePrompt.verificationUri }}</code>
        </p>
        <p class="hint">{{ $t('aiProvider.device.waiting') }}</p>
      </div>
    </AppModal>
  </div>
</template>

<style scoped>
.api-key {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field-label {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.secret-wrap {
  position: relative;
  display: flex;
  align-items: center;
}

.field-input {
  flex: 1;
  padding: 8px 10px;
  border: 1px solid var(--color-border);
  border-radius: 8px;
  background: var(--color-bg-sunken);
  color: var(--color-text-primary);
  font-size: 13px;
}

.field-input:focus {
  outline: none;
  border-color: var(--color-accent-border);
}

.visibility-btn {
  position: absolute;
  right: 8px;
  border: none;
  background: none;
  color: var(--color-text-muted);
  cursor: pointer;
}

.key-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

/* 判成哪一档要看得见：把 `!` 漏掉的后果是整条命令被当成密钥存起来 */
.key-kind {
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--color-bg-sunken);
  color: var(--color-text-muted);
  font-size: 11px;
}

.key-kind.oauth,
.key-kind.keep {
  background: var(--color-success-bg);
  color: var(--color-success-text);
}

.linked {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 8px;
  background: var(--color-success-bg);
  color: var(--color-success-text);
  font-size: 12px;
}

.linked.pending {
  background: var(--color-warning-bg);
  color: var(--color-warning-text);
}

.linked-check {
  font-weight: 600;
}

.hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--color-text-muted);
}

.device-box {
  display: flex;
  flex-direction: column;
  gap: 12px;
  align-items: center;
}

.device-code {
  padding: 12px 24px;
  border: 1px dashed var(--color-border);
  border-radius: 10px;
  background: var(--color-bg-sunken);
  color: var(--color-text-primary);
  font-family: var(--font-mono, monospace);
  font-size: 22px;
  letter-spacing: 4px;
  cursor: pointer;
}
</style>
