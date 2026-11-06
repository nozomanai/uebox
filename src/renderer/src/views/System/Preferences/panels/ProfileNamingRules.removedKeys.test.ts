/**
 * 设置页「命名规则」：哪些操作算删除，哪些不算。
 *
 * 这一层以前零测试，而「清空输入框不等于删除」的真正机制就在这里 —— 主进程只认
 * 界面显式报上来的 `removedKeys`，所以界面少报一个键，用户删不掉；多报一个键，
 * 他的配置被永久抹掉。两边都是回不来的，只能靠这组用例盯住。
 *
 * 自动保存是 2 秒防抖（`AUTO_SAVE_DELAY`），所以每条用例都靠假定时器走完那一拍。
 */
import { flushPromises, mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import ProfileNamingRules from './ProfileNamingRules.vue'
import { DEFAULT_NAMING_RULES_CONFIG } from '@renderer/types/namingRules'
import type { NamingRulesConfig } from '@renderer/types/namingRules'

type SavedPayload = NamingRulesConfig & { removedKeys?: Record<string, string[]> }

/** 三张表各用一组不重复的键，这样一行可以直接按键格里的值找到 */
const STORED_CONFIG: NamingRulesConfig = {
  ...DEFAULT_NAMING_RULES_CONFIG,
  assetPrefixes: { SoundWave: 'A_', StaticMesh: 'SM_' },
  assetTypeToDirectory: { Blueprint: '/Game/Blueprints' },
  extensionToAssetType: { tga: 'Texture' }
}

const originalApi = window.api
let saveConfig: ReturnType<typeof vi.fn>

/** 输入框的桩：要能读到当前值、也要能打字，所以画一个真的 input */
const AInputStub = {
  name: 'AInput',
  props: { value: { type: String, default: '' } },
  emits: ['update:value'],
  template: `<input :value="value" @input="$emit('update:value', $event.target.value)" />`
}

beforeEach(() => {
  vi.useFakeTimers()
  saveConfig = vi.fn(async () => true)
  window.api = {
    namingRules: {
      // 每次都给一份新的，免得面板改到这个对象之后下一条用例读到被改过的
      loadConfig: vi.fn(async () => structuredClone(STORED_CONFIG)),
      saveConfig,
      resetConfig: vi.fn(async () => true)
    }
  } as unknown as typeof window.api
})

afterEach(() => {
  vi.useRealTimers()
  window.api = originalApi
})

async function mountPanel(): Promise<VueWrapper> {
  const wrapper = mount(ProfileNamingRules, {
    global: {
      stubs: {
        'a-input': AInputStub,
        'a-select': true,
        'a-select-option': true
      }
    }
  })
  // onMounted 里的 loadConfig 走完，编辑行才建出来
  await flushPromises()
  return wrapper
}

/** 键格（每行第一个输入框）填着 `key` 的那一行 */
function rowOf(wrapper: VueWrapper, key: string): DOMWrapper<Element> {
  const row = wrapper
    .findAll('.editable-row')
    .find((candidate) => keyCell(candidate).element.value === key)
  if (!row) throw new Error(`找不到键格填着 ${key} 的那一行`)
  return row
}

function keyCell(row: DOMWrapper<Element>): DOMWrapper<HTMLInputElement> {
  return row.findAll('input')[0] as DOMWrapper<HTMLInputElement>
}

function valueCell(row: DOMWrapper<Element>): DOMWrapper<HTMLInputElement> {
  return row.findAll('input')[1] as DOMWrapper<HTMLInputElement>
}

/** 垃圾桶 */
async function clickRemove(row: DOMWrapper<Element>): Promise<void> {
  await row.find('.row-control button').trigger('click')
}

/** 等自动保存那一拍走完 */
async function flushAutoSave(): Promise<void> {
  await vi.advanceTimersByTimeAsync(2100)
  await flushPromises()
}

function payloads(): SavedPayload[] {
  return saveConfig.mock.calls.map((call) => call[0] as SavedPayload)
}

function lastPayload(): SavedPayload {
  const all = payloads()
  expect(all.length).toBeGreaterThan(0)
  return all[all.length - 1]
}

it('点垃圾桶才报删除，交上去的表里也没有这一行了', async () => {
  const wrapper = await mountPanel()

  await clickRemove(rowOf(wrapper, 'SoundWave'))
  await flushAutoSave()

  const payload = lastPayload()
  expect(payload.removedKeys?.assetPrefixes).toContain('SoundWave')
  expect(payload.assetPrefixes).not.toHaveProperty('SoundWave')
  expect(payload.assetPrefixes.StaticMesh).toBe('SM_') // 同一张表里别的行没受影响
  wrapper.unmount()
})

it('只把前缀输入框清空 —— 一条删除都不报', async () => {
  const wrapper = await mountPanel()

  await valueCell(rowOf(wrapper, 'SoundWave')).setValue('')
  await flushAutoSave()

  const payload = lastPayload()
  expect(payload.removedKeys).toBeUndefined()
  // 这一刻这一行确实不在表里（值填了一半），主进程按「这一刻没值」照搬上次存的
  expect(payload.assetPrefixes).not.toHaveProperty('SoundWave')
  wrapper.unmount()
})

it('先清空键格再点垃圾桶，这条删除照样报得出去', async () => {
  const wrapper = await mountPanel()

  // 行的位置要先拿住：键格清空之后就按值找不到它了
  const row = rowOf(wrapper, 'SoundWave')
  await keyCell(row).setValue('')
  await clickRemove(row)
  await flushAutoSave()

  expect(lastPayload().removedKeys?.assetPrefixes).toContain('SoundWave')
  wrapper.unmount()
})

it('就地改键名：老键报进删除，新键进表，不会多出一个幽灵行', async () => {
  const wrapper = await mountPanel()

  await keyCell(rowOf(wrapper, 'SoundWave')).setValue('SoundWaveSFX')
  await flushAutoSave()

  const payload = lastPayload()
  expect(payload.removedKeys?.assetPrefixes).toContain('SoundWave')
  expect(payload.assetPrefixes.SoundWaveSFX).toBe('A_')
  expect(payload.assetPrefixes).not.toHaveProperty('SoundWave')
  wrapper.unmount()
})

it('一拍之内改名又改回去，压根不保存（配置和删除列表都没变）', async () => {
  const wrapper = await mountPanel()

  const row = rowOf(wrapper, 'SoundWave')
  await keyCell(row).setValue('SoundWaveSFX')
  await keyCell(row).setValue('SoundWave')
  await flushAutoSave()

  expect(saveConfig).not.toHaveBeenCalled()
  wrapper.unmount()
})

/**
 * 改名存下之后再改第二次，报的得是**上次存进去的那个键**。
 *
 * 一直报最初那个键的话，第一次改名留在盘上的 `SoundWaveSFX` 没人删 ——
 * 重开页面就多出一个幽灵行（上一轮正是这么回退的）。
 */
it('连着改两次名，第二次报的是上次存进去的那个键', async () => {
  const wrapper = await mountPanel()

  await keyCell(rowOf(wrapper, 'SoundWave')).setValue('SoundWaveSFX')
  await flushAutoSave()
  await keyCell(rowOf(wrapper, 'SoundWaveSFX')).setValue('SoundWaveFX')
  await flushAutoSave()

  const payload = lastPayload()
  expect(payload.removedKeys?.assetPrefixes).toEqual(['SoundWaveSFX'])
  expect(payload.assetPrefixes.SoundWaveFX).toBe('A_')
  expect(payload.assetPrefixes).not.toHaveProperty('SoundWaveSFX')
  wrapper.unmount()
})

it('存成功之后删除列表清空，下一次保存不再重报', async () => {
  const wrapper = await mountPanel()

  await clickRemove(rowOf(wrapper, 'SoundWave'))
  await flushAutoSave()
  expect(lastPayload().removedKeys?.assetPrefixes).toContain('SoundWave')

  // 用户后悔了，手打回来：这一行回到表里，删除列表里不该还攒着它
  // —— 攒着的话他下次清空这一行的前缀，自动保存会把它重新删掉一次
  await valueCell(rowOf(wrapper, 'StaticMesh')).setValue('MESH_')
  await flushAutoSave()

  expect(payloads()).toHaveLength(2)
  expect(lastPayload().removedKeys).toBeUndefined()
  wrapper.unmount()
})

it('扩展名的删除按小写报，和落盘用的键对得上', async () => {
  const wrapper = await mountPanel()

  await clickRemove(rowOf(wrapper, 'tga'))
  await flushAutoSave()

  expect(lastPayload().removedKeys?.extensionToAssetType).toEqual(['tga'])
  wrapper.unmount()
})

it('目录映射那张表也只在点垃圾桶时报删除', async () => {
  const wrapper = await mountPanel()

  await clickRemove(rowOf(wrapper, 'Blueprint'))
  await flushAutoSave()

  expect(lastPayload().removedKeys?.assetTypeToDirectory).toContain('Blueprint')
  wrapper.unmount()
})
