<script setup lang="ts">
/**
 * Provider 详情面板 —— 管理弹窗右侧、选中一个 Provider 时显示的内容。
 *
 * 模型清单**不在这里** —— 它在左侧树里，选中某个模型右边就换成 ModelFields。
 * 把清单也画在这一屏，就又回到了「一页装下所有东西」。
 */
import { computed, ref } from 'vue'
import {
  kindNeedsProtocol,
  model3dApiFromBaseUrl,
  PROVIDER_KINDS,
  type Model3dApi,
  type ProviderProtocol,
  type VideoApi
} from '@core/shared/aiProvider'
import type { AiProvidersState } from './useAiProviders'
import ApiKeyField from './ApiKeyField.vue'
import AppButton from '@renderer/components/AppButton.vue'
import AppSwitch from '@renderer/components/AppSwitch.vue'
import AppTooltip from '@renderer/components/AppTooltip.vue'

const props = defineProps<{ state: AiProvidersState }>()

const { draft, importing } = props.state

const PROTOCOLS: ProviderProtocol[] = [
  'openai-completions',
  'openai-responses',
  // ChatGPT 订阅账号专用。列出来是因为用户可能自己新建一个 Provider 指向
  // 同一个后端；从目录里添加 ChatGPT Plus / Pro 时已经预置好了。
  'openai-codex-responses',
  // Cursor 订阅。从目录添加时已经预置；列在这里是为了手建一条指向同一后端。
  'cursor-agent',
  'anthropic-messages',
  'google-generative-ai'
]

/**
 * 3D / 视频的接口形状。取值与 shared 里的联合类型一一对应。
 *
 * 与「接口协议」不同，这两栏**没有「自动判断」那一项** —— 这一类还没有事实标准，
 * 猜错的表现是一串 404，看上去像地址填错了。但认得出域名就自动填好，
 * 所以正常从目录添加的人根本不会看到需要动它。
 */
const MODEL3D_APIS: Model3dApi[] = ['rodin', 'tripo', 'meshy']
const VIDEO_APIS: VideoApi[] = ['ark-video', 'minimax-video']

/** 没填就按 Base URL 认厂商，与存盘时的归一化是同一份判定 */
const model3dApi = computed({
  get: () => draft.value?.model3dApi ?? model3dApiFromBaseUrl(draft.value?.baseUrl || ''),
  set: (api: Model3dApi | undefined) => {
    if (draft.value) draft.value.model3dApi = api
  }
})

const showAdvanced = ref(false)

const headerRows = computed(() =>
  Object.entries(draft.value?.headers ?? {}).map(([key, value]) => ({ key, value }))
)

function addHeader(): void {
  if (!draft.value) return
  draft.value.headers = { ...(draft.value.headers ?? {}), '': '' }
}

function updateHeader(oldKey: string, newKey: string, value: string): void {
  if (!draft.value) return
  const next: Record<string, string> = {}
  for (const [key, existing] of Object.entries(draft.value.headers ?? {})) {
    if (key === oldKey) next[newKey] = value
    else next[key] = existing
  }
  draft.value.headers = next
}

function removeHeader(key: string): void {
  if (!draft.value?.headers) return
  const next = { ...draft.value.headers }
  delete next[key]
  draft.value.headers = Object.keys(next).length > 0 ? next : undefined
}

defineEmits<{ import: [] }>()
</script>

<template>
  <div v-if="draft" class="pane">
    <div class="pane-head">{{ $t('aiProvider.editor.providerSection') }}</div>

    <label class="field">
      <span class="field-label">{{ $t('aiProvider.field.name') }}</span>
      <input v-model="draft.displayName" type="text" class="field-input" />
    </label>

    <label class="field">
      <span class="field-label">{{ $t('aiProvider.field.baseUrl') }}</span>
      <input
        v-model="draft.baseUrl"
        type="text"
        class="field-input"
        placeholder="https://api.example.com/v1"
      />
    </label>

    <ApiKeyField :state="state" />

    <!--
      用途。这一栏取代了以前散在每个模型上的那一排能力位复选框 ——
      「这个 Provider 是干什么的」问一次就够，不该每个模型再答一遍。
    -->
    <label class="field">
      <span class="field-label">{{ $t('aiProvider.field.kind') }}</span>
      <!--
        从目录添加的锁死：ElevenLabs Music 改成「音效」只会留下一个装着音乐模型的音效来源，
        调用必然被拒。同一家的另一种用途在目录里是单独一条
      -->
      <a-select v-model:value="draft.kind" class="field-select" :disabled="!!draft.catalogId">
        <a-select-option v-for="item in PROVIDER_KINDS" :key="item" :value="item">
          {{ $t(`aiProvider.field.kinds.${item}`) }}
        </a-select-option>
      </a-select>
      <p class="hint">
        {{ $t(draft.catalogId ? 'aiProvider.field.kindLockedDesc' : 'aiProvider.field.kindDesc') }}
      </p>
    </label>

    <!--
      接口协议**只对对话类有意义** —— 它决定用哪套对话接口去构造模型。
      生图/3D/视频/实时语音厂商压根不提供对话，让用户在那儿选一个对不上的值
      来骗过校验，正是这次重构要去掉的那种困惑。
    -->
    <label v-if="kindNeedsProtocol(draft.kind)" class="field">
      <span class="field-label">{{ $t('aiProvider.field.protocol') }}</span>
      <a-select v-model:value="draft.protocol" class="field-select">
        <a-select-option v-for="item in PROTOCOLS" :key="item" :value="item">
          {{ item }}
        </a-select-option>
      </a-select>
      <p class="hint">{{ $t('aiProvider.field.protocolDesc') }}</p>
    </label>

    <label v-if="draft.kind === 'model3d'" class="field">
      <span class="field-label">{{ $t('aiProvider.field.model3dApi') }}</span>
      <a-select v-model:value="model3dApi" class="field-select">
        <a-select-option v-for="item in MODEL3D_APIS" :key="item" :value="item">
          {{ $t(`aiProvider.field.model3dApis.${item}`) }}
        </a-select-option>
      </a-select>
      <p class="hint">{{ $t('aiProvider.field.vendorApiDesc') }}</p>
    </label>

    <label v-if="draft.kind === 'video'" class="field">
      <span class="field-label">{{ $t('aiProvider.field.videoApi') }}</span>
      <a-select v-model:value="draft.videoApi" class="field-select">
        <a-select-option v-for="item in VIDEO_APIS" :key="item" :value="item">
          {{ $t(`aiProvider.field.videoApis.${item}`) }}
        </a-select-option>
      </a-select>
      <p class="hint">{{ $t('aiProvider.field.vendorApiDesc') }}</p>
    </label>

    <label v-if="draft.kind === 'music'" class="field">
      <span class="field-label">{{ $t('aiProvider.field.musicApi') }}</span>
      <a-select v-model:value="draft.musicApi" class="field-select">
        <a-select-option value="elevenlabs-music">ElevenLabs</a-select-option>
        <a-select-option value="mureka-music">Mureka</a-select-option>
        <a-select-option value="sunoapi-music">SUNO (SunoAPI.org)</a-select-option>
      </a-select>
      <p class="hint">{{ $t('aiProvider.field.vendorApiDesc') }}</p>
    </label>

    <!--
      3D 与视频厂商没有 /models 端点，按了必然 404 —— 干脆不摆出来。
      判定这一档同理：可用模型是账号上的常量，没有「列出来」这个动作。
      语音识别也一样，而且它那一栏填的根本不是模型名（豆包那边是资源 ID）。
    -->
    <AppButton
      v-if="
        draft.kind !== 'model3d' &&
        draft.kind !== 'video' &&
        draft.kind !== 'tts' &&
        draft.kind !== 'stt' &&
        draft.kind !== 'music' &&
        draft.kind !== 'sfx' &&
        draft.kind !== 'judge' &&
        draft.kind !== 'realtime' &&
        draft.kind !== 'search'
      "
      variant="soft"
      size="medium"
      class="self-start"
      :loading="importing"
      @click="$emit('import')"
    >
      {{ importing ? $t('aiProvider.field.importing') : $t('aiProvider.field.import') }}
    </AppButton>

    <!-- 附加请求头是给做了 bot 检测的自建网关用的，绝大多数人不会碰 -->
    <section class="fold">
      <button type="button" class="fold-head" @click="showAdvanced = !showAdvanced">
        <span class="fold-arrow" :class="{ open: showAdvanced }">›</span>
        {{ $t('aiProvider.editor.advanced') }}
        <span v-if="headerRows.length" class="fold-badge">{{ headerRows.length }}</span>
      </button>

      <div v-if="showAdvanced" class="fold-body">
        <span class="field-label">{{ $t('aiProvider.field.headers') }}</span>
        <div v-for="row in headerRows" :key="row.key" class="header-row">
          <input
            :value="row.key"
            type="text"
            class="field-input"
            :placeholder="$t('aiProvider.field.headerName')"
            @change="updateHeader(row.key, ($event.target as HTMLInputElement).value, row.value)"
          />
          <input
            :value="row.value"
            type="text"
            class="field-input"
            :placeholder="$t('aiProvider.field.headerValue')"
            @change="updateHeader(row.key, row.key, ($event.target as HTMLInputElement).value)"
          />
          <AppButton
            variant="text"
            size="small"
            danger
            :aria-label="$t('aiProvider.field.removeHeader')"
            @click="removeHeader(row.key)"
          >
            ×
          </AppButton>
        </div>
        <AppButton variant="soft" size="medium" class="self-start" @click="addHeader">
          {{ $t('aiProvider.field.addHeader') }}
        </AppButton>
        <p class="hint">{{ $t('aiProvider.field.headersDesc') }}</p>
        <div v-if="draft.kind === 'image'" class="field">
          <span class="field-label">{{ $t('aiProvider.field.imageResolutionTiers') }}</span>
          <AppSwitch
            v-model:checked="draft.imageResolutionTiers"
            class="self-start"
            :aria-label="$t('aiProvider.field.imageResolutionTiers')"
          />
          <p class="hint">{{ $t('aiProvider.field.imageResolutionTiersDesc') }}</p>
        </div>
        <label v-if="draft.kind === 'image'" class="field">
          <span class="field-label">{{ $t('aiProvider.field.imageUploadUrl') }}</span>
          <input
            v-model.trim="draft.imageUploadUrl"
            type="url"
            class="field-input"
            placeholder="https://api.example.com/v1/uploads/images"
          />
          <AppTooltip :title="$t('aiProvider.field.imageUploadUrlHelp')">
            <span class="hint" tabindex="0">{{ $t('aiProvider.field.imageUploadUrlDesc') }}</span>
          </AppTooltip>
        </label>
      </div>
    </section>
  </div>
</template>

<style scoped>
.pane {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.pane-head {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--color-text-muted);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.field-label {
  font-size: 12px;
  color: var(--color-text-secondary);
}

.field-input {
  width: 100%;
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

.field-select {
  width: 100%;
}

.self-start {
  align-self: flex-start;
}

.fold {
  border-top: 1px solid var(--color-border);
  padding-top: 14px;
}

.fold-head {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 0;
  border: none;
  background: none;
  color: var(--color-text-secondary);
  font-size: 13px;
  cursor: pointer;
}

.fold-arrow {
  display: inline-block;
  transition: transform 0.15s ease;
}

.fold-arrow.open {
  transform: rotate(90deg);
}

.fold-badge {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--color-accent-bg);
  font-size: 11px;
}

.fold-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 14px;
}

.header-row {
  display: flex;
  gap: 8px;
}

.hint {
  margin: 0;
  font-size: 11px;
  line-height: 1.6;
  color: var(--color-text-muted);
}
</style>
