<script setup lang="ts">
/**
 * Box Plan 卡片：连接、导入预览、套餐状态、断开。
 *
 * 没连接时打开设置页不会联网 —— 主进程的 state 在没有套餐来源时直接返回。
 * 应用、断开之后发 `changed`，由父组件重读模型配置（来源列表和角色绑定都变了）。
 *
 * 额度显示百分比；动态线路单价在卡片及导入预览展示，确认导入才接受该版本。
 * 细账去「管理订阅」的网页端看。怎么从清单 quotas 算出这个数见 shared 的 planUsage。
 * 续费失败（past_due）常驻一条提醒；清单说要下线的模型正在用时列出来。
 * 断开时服务端没吊销成功，留一句话和去网页端的链接。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import AppButton from '@renderer/components/AppButton.vue'
import AppCheckbox from '@renderer/components/AppCheckbox.vue'
import AppModal from '@renderer/components/AppModal.vue'
import CreatorPlanStorageRow from './CreatorPlanStorageRow.vue'
import CreatorPlanPrices from './CreatorPlanPrices.vue'
import { Z_CONFIRM } from './modalLayers'
import { message } from '@renderer/utils/messageManager'
import { creatorPlanAPI } from '@renderer/api/creatorPlan'
import type { ModelRole } from '@core/shared/aiProvider'
import {
  formatPlanResetTime,
  planUsage,
  type CreatorPlanCampaign,
  type CreatorPlanDeprecationHit,
  type CreatorPlanDevicePrompt,
  type CreatorPlanErrorCode,
  type CreatorPlanPreview,
  type CreatorPlanState
} from '@core/shared/creatorPlan'

const emit = defineEmits<{ (e: 'changed'): void }>()

const { t, locale } = useI18n()

const state = ref<CreatorPlanState | null>(null)
const connecting = ref(false)
const prompt = ref<CreatorPlanDevicePrompt | null>(null)
const preview = ref<CreatorPlanPreview | null>(null)
const selected = ref<ModelRole[]>([])
/** 预览里「对象存储」勾没勾。套餐不带存储时预览里没有这一行，也就不传 */
const storageSelected = ref(false)
const applying = ref(false)
const confirmingDisconnect = ref(false)
/** 断开时服务端没吊销成功：网页端 Key 列表的地址，提示用户手动吊销 */
const revokeFailedUrl = ref<string | null>(null)

function errorText(code: CreatorPlanErrorCode, raw: string): string {
  if (code === 'unknown') return t('aiProvider.creatorPlan.errors.unknown', { error: raw })
  // 连不上时带上地址和原因，一眼看出是服务挂了还是地址不对
  if (code === 'network' && raw)
    return t('aiProvider.creatorPlan.errors.networkDetail', { error: raw })
  return t(`aiProvider.creatorPlan.errors.${code}`)
}

async function load(): Promise<void> {
  const result = await creatorPlanAPI.state()
  if (result.ok) state.value = result.data
  await loadCampaign()
}

/**
 * MegaJam 活动：连着 Box Plan 时问服务端开没开。能登记、没登记过显示登记那一行，
 * 登记过显示试用到期时间；能交卷时显示交卷那一行。拿不到状态（老服务端、断网）就什么都不显示。
 */
const campaign = ref<CreatorPlanCampaign | null>(null)
const itchUrl = ref('')
const claiming = ref(false)
const claimError = ref('')
const entryUrl = ref('')
const submitting = ref(false)
/** 交过的作品页、能不能交卷。模板里事件处理之后 campaign 的非空收窄会丢，单独算出来 */
const submittedEntry = computed(() => campaign.value?.entryUrl ?? null)
const canSubmit = computed(() => campaign.value?.submitOpen === true)

async function loadCampaign(): Promise<void> {
  if (!state.value?.connected) {
    campaign.value = null
    return
  }
  const result = await creatorPlanAPI.campaign()
  campaign.value = result.ok ? result.data : null
}

async function claimCampaign(): Promise<void> {
  if (claiming.value || !itchUrl.value.trim()) return
  claiming.value = true
  claimError.value = ''
  try {
    const result = await creatorPlanAPI.claimCampaign(itchUrl.value)
    if (!result.ok) {
      claimError.value = errorText(result.code, result.error)
      return
    }
    message.success(t('aiProvider.creatorPlan.campaign.claimed'))
    itchUrl.value = ''
    await load()
    emit('changed')
    // 套餐变了，模型清单跟着变：直接弹导入预览，让用户把新模型接上
    await reimport()
  } finally {
    claiming.value = false
  }
}

async function submitEntry(): Promise<void> {
  if (submitting.value || !entryUrl.value.trim()) return
  submitting.value = true
  claimError.value = ''
  try {
    const result = await creatorPlanAPI.submitCampaignEntry(entryUrl.value)
    if (!result.ok) {
      claimError.value = errorText(result.code, result.error)
      return
    }
    message.success(t('aiProvider.creatorPlan.campaign.submitted'))
    entryUrl.value = ''
    await loadCampaign()
  } finally {
    submitting.value = false
  }
}

function openPreview(data: CreatorPlanPreview): void {
  preview.value = data
  selected.value = data.changes.filter((c) => c.defaultSelected).map((c) => c.role)
  storageSelected.value = data.storage?.defaultSelected ?? false
}

async function connect(): Promise<void> {
  connecting.value = true
  const result = await creatorPlanAPI.connect()
  connecting.value = false
  prompt.value = null
  if (result.ok) openPreview(result.data)
  else if (result.code !== 'cancelled') message.error(errorText(result.code, result.error))
}

async function cancel(): Promise<void> {
  await creatorPlanAPI.cancel()
}

async function reimport(): Promise<void> {
  const result = await creatorPlanAPI.preview()
  if (result.ok) openPreview(result.data)
  else message.error(errorText(result.code, result.error))
}

function toggle(role: ModelRole, checked: boolean): void {
  selected.value = checked
    ? [...selected.value, role]
    : selected.value.filter((item) => item !== role)
}

const allSelected = computed(
  () =>
    !!preview.value &&
    preview.value.changes.every((c) => selected.value.includes(c.role)) &&
    (!preview.value.storage || storageSelected.value)
)

function toggleAll(checked: boolean): void {
  selected.value = checked && preview.value ? preview.value.changes.map((c) => c.role) : []
  if (preview.value?.storage) storageSelected.value = checked
}

async function apply(): Promise<void> {
  applying.value = true
  const result = await creatorPlanAPI.apply(
    selected.value,
    preview.value?.storage ? { storage: storageSelected.value } : undefined
  )
  applying.value = false
  if (!result.ok) {
    message.error(errorText(result.code, result.error))
    return
  }
  state.value = result.data
  preview.value = null
  message.success(t('aiProvider.creatorPlan.applied'))
  emit('changed')
}

async function disconnect(): Promise<void> {
  confirmingDisconnect.value = false
  const result = await creatorPlanAPI.disconnect()
  if (!result.ok) {
    message.error(errorText(result.code, result.error))
    return
  }
  revokeFailedUrl.value = result.data.revoked ? null : result.data.keysUrl
  await load()
  emit('changed')
}

async function openManage(): Promise<void> {
  if (summary.value) await window.api.shell.openExternal(summary.value.manageUrl)
}

async function openKeys(): Promise<void> {
  if (revokeFailedUrl.value) await window.api.shell.openExternal(revokeFailedUrl.value)
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    message.success(t('common.copied'))
  } catch {
    message.error(t('common.copyFailed'))
  }
}

async function copyCode(): Promise<void> {
  if (prompt.value) await copyText(prompt.value.userCode)
}

async function openVerification(): Promise<void> {
  if (prompt.value) await window.api.shell.openExternal(prompt.value.verificationUri)
}

async function copyVerification(): Promise<void> {
  if (prompt.value) await copyText(prompt.value.verificationUri)
}

/** 「今天 17:00」「明天 08:00」，再远的带日期。按本机时区 */
const formatTime = (iso: string): string =>
  formatPlanResetTime(iso, locale.value, {
    today: (time) => t('aiProvider.creatorPlan.time.today', { time }),
    tomorrow: (time) => t('aiProvider.creatorPlan.time.tomorrow', { time })
  })
const formatDate = (iso: string | null): string =>
  iso ? new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }).format(new Date(iso)) : ''

/**
 * 本月已用百分比。今天的每日上限用完了，百分比再低也用不了，补一句什么时候恢复（本机时间）
 */
const usage = computed(() => (summary.value ? planUsage(summary.value.quotas) : null))
const usedText = computed(() => {
  if (!usage.value) return ''
  const used = t('aiProvider.creatorPlan.used', { percent: usage.value.usedPercent })
  const resetsAt = summary.value?.quotaResetsAt
  return resetsAt
    ? `${used} · ${t('aiProvider.creatorPlan.resetsOn', { date: formatDate(resetsAt) })}`
    : used
})
const dailyDoneText = computed(() => {
  const until = usage.value?.dailyExhaustedUntil
  return until ? t('aiProvider.creatorPlan.dailyDone', { time: formatTime(until) }) : ''
})

function deprecationText(hit: CreatorPlanDeprecationHit): string {
  const role = t(`aiProvider.roles.${hit.role}`)
  const parts = [
    hit.removedAt
      ? t('aiProvider.creatorPlan.deprecatedUntil', {
          role,
          model: hit.model,
          date: formatDate(hit.removedAt)
        })
      : t('aiProvider.creatorPlan.deprecated', { role, model: hit.model })
  ]
  if (hit.replacedBy) {
    parts.push(t('aiProvider.creatorPlan.deprecatedReplace', { replacement: hit.replacedBy }))
  }
  // 嵌入换模型，向量空间就变了，旧索引会悄悄失效
  if (hit.role === 'embedding') parts.push(t('aiProvider.creatorPlan.deprecatedReindex'))
  return parts.join(' ')
}

const summary = computed(() => state.value?.summary ?? null)
const deprecations = computed(() => state.value?.deprecations ?? [])
const tierLine = computed(() => {
  const s = summary.value
  if (!s?.tierName) return ''
  const interval =
    s.interval === 'year'
      ? t('aiProvider.creatorPlan.intervalYear')
      : t('aiProvider.creatorPlan.intervalMonth')
  return t('aiProvider.creatorPlan.tier', { tier: s.tierName, interval })
})

let unsubscribe: (() => void) | null = null
onMounted(() => {
  unsubscribe = creatorPlanAPI.onDeviceCode((next) => (prompt.value = next))
  void load()
})
onUnmounted(() => unsubscribe?.())
</script>

<template>
  <div class="plan-card">
    <div class="plan-head">
      <div class="plan-info">
        <span class="plan-title">{{ $t('aiProvider.creatorPlan.title') }}</span>
        <span v-if="!state?.connected" class="plan-desc">
          {{ $t('aiProvider.creatorPlan.desc') }}
        </span>
        <template v-else-if="summary">
          <span class="plan-desc">
            <span v-if="tierLine">{{ tierLine }} · </span>
            <span :class="{ 'plan-warn': summary.status !== 'active' }">
              {{ $t(`aiProvider.creatorPlan.status.${summary.status}`) }}
            </span>
          </span>
          <div v-if="usage" class="plan-usage">
            <div
              class="plan-bar"
              :class="{ 'plan-bar-full': usage.usedPercent >= 100 || !!dailyDoneText }"
              role="progressbar"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="usage.usedPercent"
              :aria-label="$t('aiProvider.creatorPlan.usageLabel')"
            >
              <span class="plan-bar-fill" :style="{ width: `${usage.usedPercent}%` }" />
            </div>
            <span class="plan-desc plan-used">{{ usedText }}</span>
            <span v-if="dailyDoneText" class="plan-desc plan-warn plan-daily-done">
              {{ dailyDoneText }}
            </span>
          </div>
        </template>
        <span v-else-if="state.error" class="plan-desc plan-warn">
          {{ errorText(state.error, '') }}
        </span>
        <span v-if="!state?.connected && revokeFailedUrl" class="plan-desc plan-warn">
          {{ $t('aiProvider.creatorPlan.revokeFailed') }}
          <AppButton variant="link" size="small" class="plan-link" @click="openKeys">
            {{ $t('aiProvider.creatorPlan.revokeOpen') }}
          </AppButton>
        </span>
      </div>

      <div class="plan-actions">
        <template v-if="!state?.connected || state.error === 'unauthorized'">
          <AppButton v-if="connecting" variant="default" @click="cancel">
            {{ $t('aiProvider.creatorPlan.cancel') }}
          </AppButton>
          <AppButton variant="primary" :loading="connecting" @click="connect">
            {{
              connecting
                ? $t('aiProvider.creatorPlan.connecting')
                : $t('aiProvider.creatorPlan.connect')
            }}
          </AppButton>
        </template>
        <template v-else>
          <AppButton v-if="summary" variant="soft" @click="openManage">
            {{ $t('aiProvider.creatorPlan.manage') }}
          </AppButton>
          <AppButton variant="soft" @click="reimport">
            {{ $t('aiProvider.creatorPlan.reimport') }}
          </AppButton>
        </template>
        <!-- Key 失效了也得能断开：不然要移除套餐、还原原绑定，只能先重新授权一遍 -->
        <AppButton
          v-if="state?.connected && !connecting"
          variant="text"
          danger
          @click="confirmingDisconnect = true"
        >
          {{ $t('aiProvider.creatorPlan.disconnect') }}
        </AppButton>
      </div>
    </div>

    <CreatorPlanPrices
      v-if="
        summary?.videoPricing || (summary?.routePricing && Object.keys(summary.routePricing).length)
      "
      :prices="summary?.routePricing"
      :video="summary?.videoPricing"
    />
    <p v-if="state?.pricingNeedsAcceptance" class="plan-desc plan-warn" role="alert">
      {{ $t('aiProvider.creatorPlan.pricing.changed') }}
    </p>

    <!-- 续费失败：本期只给 20% 的额度，过了宽限期就停，所以常驻提醒，不收起来 -->
    <div v-if="state?.connected && summary?.status === 'past_due'" class="plan-alert" role="alert">
      <span>{{ $t('aiProvider.creatorPlan.pastDue') }}</span>
      <AppButton variant="primary" size="small" @click="openManage">
        {{ $t('aiProvider.creatorPlan.pastDueAction') }}
      </AppButton>
    </div>

    <!-- MegaJam 活动：能登记、没登记过时可登记，登记过显示试用到期时间；能交卷时可交卷 -->
    <div
      v-if="
        state?.connected && campaign && (campaign.claimed || campaign.open || campaign.submitOpen)
      "
      class="plan-campaign"
    >
      <span class="plan-desc">
        {{ $t('aiProvider.creatorPlan.campaign.title') }}
        <template v-if="campaign.claimed">
          ·
          {{
            campaign.expiresAt
              ? $t('aiProvider.creatorPlan.campaign.expires', {
                  date: formatTime(campaign.expiresAt)
                })
              : $t('aiProvider.creatorPlan.campaign.claimedShort')
          }}
        </template>
      </span>
      <form
        v-if="!campaign.claimed && campaign.open"
        class="plan-campaign-form"
        @submit.prevent="claimCampaign"
      >
        <a-input
          v-model:value="itchUrl"
          class="plan-campaign-input"
          :aria-label="$t('aiProvider.creatorPlan.campaign.itchLabel')"
          placeholder="https://yourname.itch.io"
          :disabled="claiming"
        />
        <AppButton
          variant="primary"
          size="small"
          :disabled="claiming || !itchUrl.trim()"
          @click="claimCampaign"
        >
          {{ $t('aiProvider.creatorPlan.campaign.claim') }}
        </AppButton>
      </form>
      <span v-if="submittedEntry" class="plan-desc">
        {{ $t('aiProvider.creatorPlan.campaign.entry', { url: submittedEntry }) }}
      </span>
      <form v-if="canSubmit" class="plan-campaign-form" @submit.prevent="submitEntry">
        <a-input
          v-model:value="entryUrl"
          class="plan-campaign-input"
          :aria-label="$t('aiProvider.creatorPlan.campaign.entryLabel')"
          placeholder="https://yourname.itch.io/game"
          :disabled="submitting"
        />
        <AppButton
          :variant="submittedEntry ? 'default' : 'primary'"
          size="small"
          :disabled="submitting || !entryUrl.trim()"
          @click="submitEntry"
        >
          {{
            submittedEntry
              ? $t('aiProvider.creatorPlan.campaign.resubmit')
              : $t('aiProvider.creatorPlan.campaign.submit')
          }}
        </AppButton>
      </form>
      <span v-if="claimError" class="plan-desc plan-warn" role="alert">{{ claimError }}</span>
    </div>

    <!-- 清单说要下线、而且正在用的模型 -->
    <ul v-if="state?.connected && deprecations.length > 0" class="plan-deprecations">
      <li v-for="hit in deprecations" :key="hit.role" class="plan-desc plan-warn">
        {{ deprecationText(hit) }}
      </li>
    </ul>

    <!-- 设备授权：浏览器已自动打开，这里显示码供核对 -->
    <AppModal
      :z-index="Z_CONFIRM"
      :open="prompt !== null"
      :title="$t('aiProvider.creatorPlan.codeTitle')"
      hide-footer
      centered
      @cancel="cancel"
    >
      <div v-if="prompt" class="code-box">
        <p class="plan-desc">{{ $t('aiProvider.creatorPlan.codeDesc') }}</p>
        <button
          type="button"
          class="code"
          :title="$t('aiProvider.creatorPlan.codeCopy')"
          @click="copyCode"
        >
          {{ prompt.userCode }}
        </button>
        <p class="plan-desc">{{ $t('aiProvider.creatorPlan.notOpened') }}</p>
        <div class="verify-url">
          <a
            :href="prompt.verificationUri"
            class="verify-link"
            :title="$t('aiProvider.creatorPlan.openLink')"
            @click.prevent="openVerification"
          >
            {{ prompt.verificationUri }}
          </a>
          <AppButton size="small" @click="copyVerification">
            {{ $t('aiProvider.creatorPlan.copyLink') }}
          </AppButton>
        </div>
      </div>
    </AppModal>

    <!-- 导入预览：选哪些角色交给套餐 -->
    <AppModal
      :z-index="Z_CONFIRM"
      :open="preview !== null"
      :title="$t('aiProvider.creatorPlan.previewTitle')"
      :ok-text="
        $t(
          preview?.summary.videoPricing ||
            (preview?.summary.routePricing && Object.keys(preview.summary.routePricing).length)
            ? 'aiProvider.creatorPlan.pricing.accept'
            : 'aiProvider.creatorPlan.apply'
        )
      "
      :ok-disabled="!!preview && preview.changes.length === 0 && !preview.storage"
      :confirm-loading="applying"
      centered
      @ok="apply"
      @cancel="preview = null"
    >
      <div v-if="preview" class="preview">
        <p class="plan-desc">{{ $t('aiProvider.creatorPlan.previewDesc') }}</p>
        <CreatorPlanPrices
          v-if="
            preview.summary.videoPricing ||
            (preview.summary.routePricing && Object.keys(preview.summary.routePricing).length)
          "
          :prices="preview.summary.routePricing"
          :video="preview.summary.videoPricing"
        />
        <AppCheckbox :checked="allSelected" @update:checked="toggleAll">
          {{ $t('common.selectAll') }}
        </AppCheckbox>
        <div v-for="change in preview.changes" :key="change.role" class="preview-row">
          <AppCheckbox
            :checked="selected.includes(change.role)"
            @update:checked="(value: boolean) => toggle(change.role, value)"
          >
            {{ $t(`aiProvider.roles.${change.role}`) }}
          </AppCheckbox>
          <span class="preview-meta">
            <span v-if="change.managed">{{ $t('aiProvider.creatorPlan.previewManaged') }}</span>
            <span v-else-if="change.current">
              {{
                $t('aiProvider.creatorPlan.previewCurrent', {
                  name: `${change.current.modelId} · ${change.current.providerName}`
                })
              }}
            </span>
            <span v-else>{{ $t('aiProvider.creatorPlan.previewUnset') }}</span>
            <!-- 嵌入换模型，向量空间就变了：知识库要按新模型重建 -->
            <span
              v-if="
                change.role === 'embedding' &&
                change.current &&
                !change.managed &&
                selected.includes(change.role)
              "
              class="plan-warn"
            >
              {{ $t('aiProvider.creatorPlan.previewReindex') }}
            </span>
          </span>
        </div>
        <CreatorPlanStorageRow
          v-if="preview.storage"
          v-model:checked="storageSelected"
          :storage="preview.storage"
        />
      </div>
    </AppModal>

    <AppModal
      :z-index="Z_CONFIRM"
      :open="confirmingDisconnect"
      :title="$t('aiProvider.creatorPlan.disconnect')"
      :ok-text="$t('aiProvider.creatorPlan.disconnect')"
      ok-danger
      centered
      @ok="disconnect"
      @cancel="confirmingDisconnect = false"
    >
      <p class="plan-desc">{{ $t('aiProvider.creatorPlan.disconnectConfirm') }}</p>
    </AppModal>
  </div>
</template>

<style scoped>
.plan-card {
  margin-top: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-accent-border);
  border-radius: var(--radius-lg);
  background: var(--color-accent-bg);
}

.plan-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-4);
}

.plan-info {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.plan-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--color-text-primary);
}

.plan-desc {
  font-size: 12px;
  line-height: 1.6;
  color: var(--color-text-muted);
}

.plan-warn {
  color: var(--color-warning-text);
}

.plan-usage {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  max-width: 320px;
}

.plan-bar {
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: var(--color-bg-sunken);
}

.plan-bar-fill {
  display: block;
  height: 100%;
  background: var(--color-accent-solid);
}

.plan-bar-full .plan-bar-fill {
  background: var(--color-warning-solid);
}

.plan-deprecations {
  display: flex;
  flex-direction: column;
  margin: 0;
  padding: 0;
  list-style: none;
}

.plan-deprecations {
  margin-top: var(--space-2);
}

.plan-alert {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  margin-top: var(--space-3);
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-warning-border);
  border-radius: var(--radius-md);
  background: var(--color-warning-bg);
  font-size: 12px;
  color: var(--color-warning-text);
}

.plan-link {
  height: auto;
  padding: 0;
}

.plan-actions {
  display: flex;
  flex: none;
  gap: var(--space-2);
}

.code-box {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-3);
  text-align: center;
}

.code {
  padding: var(--space-2) var(--space-4);
  border: 1px dashed var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-bg-sunken);
  font-family: var(--font-mono);
  font-size: 24px;
  letter-spacing: 0.15em;
  color: var(--color-text-primary);
  cursor: pointer;
}

.verify-url {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  max-width: 100%;
}

.verify-link {
  overflow: hidden;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--color-accent-text);
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
}

.verify-link:hover {
  text-decoration: underline;
}

.preview {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  /* 角色多，列表在弹窗内滚动，别把弹窗撑出窗口 */
  max-height: 60vh;
  overflow-y: auto;
}

.preview-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-top: 1px solid var(--color-border-subtle);
}

.preview-meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  font-size: 12px;
  color: var(--color-text-muted);
  text-align: right;
}

.preview-row > :first-child {
  flex-shrink: 0;
  white-space: nowrap;
}

.plan-campaign {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin-top: var(--space-3);
}

.plan-campaign-form {
  display: flex;
  gap: var(--space-2);
  align-items: center;
}

.plan-campaign-input {
  flex: 1;
  min-width: 0;
}
</style>
