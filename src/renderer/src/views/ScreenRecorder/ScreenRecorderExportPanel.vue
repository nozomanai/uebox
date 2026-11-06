<template>
  <div class="recording-export-panel">
    <header class="panel-header">
      <div class="title-group">
        <div class="title">{{ $t('screenRecorderExportPanel.title') }}</div>
        <div v-if="recordingName" class="subtitle">{{ recordingName }}</div>
      </div>
      <div class="header-actions">
        <AppButton @click="handleReset">{{
          $t('screenRecorderExportPanel.resetButton')
        }}</AppButton>
        <AppButton variant="primary" :disabled="!canExport" @click="handleExport">
          {{ $t('screenRecorderExportPanel.exportButton') }}
        </AppButton>
      </div>
    </header>

    <div class="panel-body">
      <section class="preview-area">
        <div class="section-header">
          <div class="section-title">{{ $t('screenRecorderExportPanel.previewSectionTitle') }}</div>
          <div class="section-meta">{{ durationText }}</div>
        </div>

        <div class="video-card" :class="{ 'is-empty': !sourceUrl }">
          <template v-if="sourceUrl">
            <video
              ref="videoRef"
              class="preview-video"
              controls
              :src="sourceUrl"
              @loadedmetadata="handleLoadedMetadata"
            />
          </template>
          <div v-else class="empty-state">
            <div class="empty-title">{{ $t('screenRecorderExportPanel.noFileTitle') }}</div>
          </div>
        </div>

        <div class="timeline-card">
          <div class="timeline-header">
            <div class="timeline-title">{{ $t('screenRecorderExportPanel.trimRangeTitle') }}</div>
            <div class="timeline-value">
              {{ formatTime(trimRange[0]) }} - {{ formatTime(trimRange[1]) }}
            </div>
          </div>
          <a-slider
            v-model:value="trimRange"
            range
            :min="0"
            :max="duration"
            :step="0.1"
            :disabled="!sourceUrl"
          />
          <div class="trim-inputs">
            <div class="field">
              <label>{{ $t('screenRecorderExportPanel.startLabel') }}</label>
              <a-input-number
                v-model:value="trimStart"
                :min="0"
                :max="trimEnd"
                :step="0.1"
                :disabled="!sourceUrl"
              />
            </div>
            <div class="field">
              <label>{{ $t('screenRecorderExportPanel.endLabel') }}</label>
              <a-input-number
                v-model:value="trimEnd"
                :min="trimStart"
                :max="duration"
                :step="0.1"
                :disabled="!sourceUrl"
              />
            </div>
            <div class="field">
              <label>{{ $t('screenRecorderExportPanel.trimDurationLabel') }}</label>
              <div class="value">{{ formatTime(trimDuration) }}</div>
            </div>
          </div>
        </div>
      </section>

      <section class="settings-area">
        <div class="section-card">
          <div class="card-title">{{ $t('screenRecorderExportPanel.exportFormatTitle') }}</div>
          <a-radio-group v-model:value="format" class="format-group">
            <a-radio-button value="mp4">MP4</a-radio-button>
            <a-radio-button value="gif">GIF</a-radio-button>
          </a-radio-group>
        </div>

        <div class="section-card grid">
          <div class="field">
            <label>{{ $t('screenRecorderExportPanel.qualityLabel') }}</label>
            <a-select v-model:value="quality" class="full-width" :disabled="format === 'gif'">
              <a-select-option value="high">
                {{ $t('screenRecorderExportPanel.qualityOptions.high') }}
              </a-select-option>
              <a-select-option value="balanced">
                {{ $t('screenRecorderExportPanel.qualityOptions.balanced') }}
              </a-select-option>
              <a-select-option value="fast">
                {{ $t('screenRecorderExportPanel.qualityOptions.fast') }}
              </a-select-option>
            </a-select>
          </div>
          <div class="field">
            <label>{{ $t('screenRecorderExportPanel.fpsLabel') }}</label>
            <a-input-number v-model:value="fps" :min="6" :max="60" :step="1" />
          </div>
          <div class="field">
            <label>{{ $t('screenRecorderExportPanel.resolutionLabel') }}</label>
            <a-select v-model:value="resolution" class="full-width">
              <a-select-option value="original">
                {{ $t('screenRecorderExportPanel.resolutionOptions.original') }}
              </a-select-option>
              <a-select-option value="1080p">1080p</a-select-option>
              <a-select-option value="720p">720p</a-select-option>
            </a-select>
          </div>
          <div class="field">
            <label>{{ $t('screenRecorderExportPanel.bitrateLabel') }}</label>
            <a-input-number
              v-model:value="bitrate"
              :min="2"
              :max="50"
              :step="1"
              :disabled="format === 'gif'"
            />
          </div>
        </div>

        <div class="section-card">
          <div class="card-title">{{ $t('screenRecorderExportPanel.advancedSettingsTitle') }}</div>
          <div class="switch-row">
            <div class="switch-title">{{ $t('screenRecorderExportPanel.includeAudioTitle') }}</div>
            <!--
              旁边那行 .switch-title 只是个 div，和开关没有程序化关联，
              读屏软件停在开关上时念不出它是干什么的 —— 把同一个键再给 aria-label。
            -->
            <AppSwitch
              v-model:checked="includeAudio"
              :aria-label="$t('screenRecorderExportPanel.includeAudioTitle')"
              :disabled="format === 'gif'"
            />
          </div>
          <!--
            「高质量缩放」只在真的缩放时才进 ffmpeg 滤镜（见主进程 getScaleFilter：
            分辨率为「原始」时整条 scale 滤镜都不生成，lanczos 跟着一起没了）。
            所以分辨率是「原始」时把它置灰，别让用户以为开着就有效。
          -->
          <div class="switch-row">
            <div class="switch-title">
              {{ $t('screenRecorderExportPanel.highQualityScaleTitle') }}
            </div>
            <AppSwitch
              v-model:checked="highQualityScale"
              :aria-label="$t('screenRecorderExportPanel.highQualityScaleTitle')"
              :disabled="resolution === 'original'"
            />
          </div>
        </div>

        <div class="section-card summary">
          <div class="card-title">{{ $t('screenRecorderExportPanel.summaryTitle') }}</div>
          <div class="summary-row">
            <span>{{ $t('screenRecorderExportPanel.summaryFormat') }}</span>
            <span>{{ format.toUpperCase() }}</span>
          </div>
          <div class="summary-row">
            <span>{{ $t('screenRecorderExportPanel.summaryDuration') }}</span>
            <span>{{ formatTime(trimDuration) }}</span>
          </div>
          <div class="summary-row">
            <span>{{ $t('screenRecorderExportPanel.summaryFps') }}</span>
            <span>{{ fps }} fps</span>
          </div>
          <div class="summary-row">
            <span>{{ $t('screenRecorderExportPanel.summaryResolution') }}</span>
            <span>{{ resolutionLabel }}</span>
          </div>
          <div v-if="format === 'mp4'" class="summary-row">
            <span>{{ $t('screenRecorderExportPanel.summaryQuality') }}</span>
            <span>{{ qualityLabel }}</span>
          </div>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import AppButton from '@renderer/components/AppButton.vue'
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  Slider as ASlider,
  InputNumber as AInputNumber,
  Select as ASelect,
  SelectOption as ASelectOption,
  RadioGroup as ARadioGroup,
  RadioButton as ARadioButton
} from 'ant-design-vue'
import AppSwitch from '@renderer/components/AppSwitch.vue'

type ExportFormat = 'mp4' | 'gif'
type ExportQuality = 'high' | 'balanced' | 'fast'
type ExportResolution = 'original' | '1080p' | '720p'

interface Props {
  sourceUrl?: string
  recordingName?: string
}

interface ExportOptions {
  format: ExportFormat
  quality: ExportQuality
  resolution: ExportResolution
  fps: number
  bitrate: number
  includeAudio: boolean
  highQualityScale: boolean
  trimStart: number
  trimEnd: number
}

const props = defineProps<Props>()
const emit = defineEmits<{
  (e: 'export', payload: ExportOptions): void
}>()

const { t } = useI18n()

const videoRef = ref<HTMLVideoElement | null>(null)
const duration = ref(0)
const trimStart = ref(0)
const trimEnd = ref(0)
const format = ref<ExportFormat>('mp4')
const quality = ref<ExportQuality>('balanced')
const resolution = ref<ExportResolution>('original')
const fps = ref(30)
const bitrate = ref(12)
const includeAudio = ref(true)
const highQualityScale = ref(true)

const trimRange = computed<[number, number]>({
  get: () => [trimStart.value, trimEnd.value] as [number, number],
  set: ([start, end]) => {
    const max = Math.max(0, duration.value)
    const nextStart = Math.max(0, Math.min(start, max))
    const nextEnd = Math.max(0, Math.min(end, max))
    trimStart.value = Math.min(nextStart, nextEnd)
    trimEnd.value = Math.max(nextStart, nextEnd)
  }
})

const trimDuration = computed(() => Math.max(0, trimEnd.value - trimStart.value))
const canExport = computed(() => !!props.sourceUrl && trimDuration.value > 0)

const durationText = computed(() =>
  duration.value > 0
    ? t('screenRecorderExportPanel.durationTotal', { duration: formatTime(duration.value) })
    : t('screenRecorderExportPanel.durationLoading')
)

const resolutionLabel = computed(() => {
  if (resolution.value === 'original')
    return t('screenRecorderExportPanel.resolutionOptions.original')
  if (resolution.value === '1080p') return '1920 × 1080'
  return '1280 × 720'
})

const qualityLabel = computed(() => {
  if (quality.value === 'high') return t('screenRecorderExportPanel.qualityOptions.high')
  if (quality.value === 'fast') return t('screenRecorderExportPanel.qualityOptions.fast')
  return t('screenRecorderExportPanel.qualityOptions.balanced')
})

watch(
  () => props.sourceUrl,
  () => {
    duration.value = 0
    trimStart.value = 0
    trimEnd.value = 0
  }
)

watch(duration, (value) => {
  if (value > 0) {
    trimStart.value = 0
    trimEnd.value = value
  } else {
    trimStart.value = 0
    trimEnd.value = 0
  }
})

watch([trimStart, trimEnd, duration], ([start, end, max], [, prevEnd]) => {
  const limit = Math.max(0, max)
  let nextStart = Math.max(0, Math.min(start, limit))
  let nextEnd = Math.max(0, Math.min(end, limit))
  if (nextEnd < nextStart) {
    if (end !== prevEnd) {
      nextStart = nextEnd
    } else {
      nextEnd = nextStart
    }
  }
  if (nextStart !== start) trimStart.value = nextStart
  if (nextEnd !== end) trimEnd.value = nextEnd
})

watch(format, (value) => {
  if (value === 'gif') {
    includeAudio.value = false
  }
})

function handleLoadedMetadata(): void {
  const video = videoRef.value
  if (!video) return
  duration.value = Number.isFinite(video.duration) ? video.duration : 0
}

function handleReset(): void {
  format.value = 'mp4'
  quality.value = 'balanced'
  resolution.value = 'original'
  fps.value = 30
  bitrate.value = 12
  includeAudio.value = true
  highQualityScale.value = true
  if (duration.value > 0) {
    trimStart.value = 0
    trimEnd.value = duration.value
  } else {
    trimStart.value = 0
    trimEnd.value = 0
  }
}

function handleExport(): void {
  if (!canExport.value) return
  emit('export', {
    format: format.value,
    quality: quality.value,
    resolution: resolution.value,
    fps: fps.value,
    bitrate: bitrate.value,
    includeAudio: includeAudio.value,
    highQualityScale: highQualityScale.value,
    trimStart: trimStart.value,
    trimEnd: trimEnd.value
  })
}

function formatTime(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '00:00'
  const minutes = Math.floor(value / 60)
  const seconds = Math.floor(value % 60)
  const millis = Math.floor((value % 1) * 10)
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${millis}`
}
</script>

<style scoped lang="less">
.recording-export-panel {
  width: 100%;
  height: 100%;
  display: flex;
  flex-direction: column;

  color: var(--color-text-primary);

  .panel-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 18px 20px;
    border-bottom: 1px solid var(--color-border-subtle);

    .title-group {
      display: flex;
      flex-direction: column;
      gap: 6px;

      .title {
        font-size: 18px;
        font-weight: 600;
        letter-spacing: 0.02em;
      }

      .subtitle {
        font-size: 12px;
        color: var(--color-text-secondary);
      }
    }

    .header-actions {
      display: flex;
      align-items: center;
      gap: 10px;
    }
  }

  .panel-body {
    flex: 1;
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(280px, 0.8fr);
    gap: 16px;
    padding: 16px 20px 20px;
    overflow: hidden;
  }

  .preview-area {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;

    .section-header {
      display: flex;
      align-items: center;
      justify-content: space-between;

      .section-title {
        font-size: 13px;
        font-weight: 600;
        letter-spacing: 0.12em;
        text-transform: uppercase;
        color: var(--color-text-primary);
      }

      .section-meta {
        font-size: 12px;
        color: var(--color-text-muted);
      }
    }

    .video-card {
      border-radius: 12px;
      border: 1px solid var(--color-border-subtle);
      height: 320px;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;

      .preview-video {
        width: 100%;
        height: 100%;
        object-fit: contain;
      }

      .empty-state {
        text-align: center;

        .empty-title {
          font-size: 14px;
          font-weight: 600;
        }
      }
    }

    .timeline-card {
      border-radius: 12px;
      border: 1px solid var(--color-border-subtle);
      padding: 14px 16px;
      display: flex;
      flex-direction: column;
      gap: 10px;

      .timeline-header {
        display: flex;
        align-items: center;
        justify-content: space-between;

        .timeline-title {
          font-size: 13px;
          font-weight: 600;
        }

        .timeline-value {
          font-size: 12px;
          color: var(--color-text-secondary);
        }
      }

      .trim-inputs {
        display: grid;
        grid-template-columns: repeat(3, minmax(0, 1fr));
        gap: 12px;

        .field {
          display: flex;
          flex-direction: column;
          gap: 6px;

          label {
            font-size: 12px;
            color: var(--color-text-secondary);
          }

          .value {
            font-size: 13px;
            font-weight: 600;
          }
        }
      }
    }
  }

  .settings-area {
    display: flex;
    flex-direction: column;
    gap: 12px;
    min-width: 0;
  }

  .section-card {
    border-radius: 12px;
    border: 1px solid var(--color-border);
    padding: 14px 16px;
    display: flex;
    flex-direction: column;
    gap: 10px;

    &.grid {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px 16px;

      .field {
        display: flex;
        flex-direction: column;
        gap: 6px;

        label {
          font-size: 12px;
          color: var(--color-text-secondary);
        }
      }
    }

    &.summary {
      .summary-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        font-size: 12px;
        color: var(--color-text-primary);
      }
    }

    .card-title {
      font-size: 13px;
      font-weight: 600;
    }
  }

  .switch-row {
    display: flex;
    align-items: center;
    justify-content: space-between;

    .switch-title {
      font-size: 13px;
      font-weight: 600;
    }
  }

  /*
    antd-override.css 给 .ant-input-number / .ant-select-selector 无条件写了
    `color: var(--color-text-primary) !important`，没放过禁用态，而 ant-design-vue
    自己的禁用文字色不带 !important —— 不在这里补一条同样带 !important 的，
    GIF 下置灰的质量和码率只有灰底，里面的值仍是满对比度。
  */
  :deep(.ant-select-disabled .ant-select-selector),
  :deep(.ant-select-disabled .ant-select-selection-item),
  :deep(.ant-input-number-disabled .ant-input-number-input) {
    color: var(--color-text-disabled) !important;
  }

  .format-group {
    width: fit-content;
  }

  .full-width {
    width: 100%;
  }
}
</style>
