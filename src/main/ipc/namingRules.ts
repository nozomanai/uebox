/**
 * 命名规则配置 IPC 处理
 */
import { ipcMain } from 'electron'
import {
  loadNamingRulesConfig,
  saveNamingRulesConfig,
  resetNamingRulesConfig
} from '../utils/namingRulesConfig'
import type { NamingRulesSavePayload } from '../utils/namingRulesConfig'
import type { NamingRulesConfig } from '../../renderer/src/types/namingRules'

/**
 * 注册命名规则相关 IPC
 */
export function registerNamingRulesIPC(): void {
  // 加载配置
  ipcMain.handle('namingRules:loadConfig', async (): Promise<NamingRulesConfig> => {
    try {
      return loadNamingRulesConfig()
    } catch (error) {
      console.error('[NamingRulesIPC] 加载配置失败:', error)
      throw error
    }
  })

  // 保存配置。交上来的是完整配置 + 这一轮点掉的出厂键（removedKeys），
  // 后者是删除能存下来的唯一依据 —— 别把参数退回成 NamingRulesConfig，
  // 那样它会悄悄从类型上消失，只剩结构化克隆在运行期把它带过去
  ipcMain.handle(
    'namingRules:saveConfig',
    async (_event, config: NamingRulesSavePayload): Promise<boolean> => {
      try {
        return saveNamingRulesConfig(config)
      } catch (error) {
        console.error('[NamingRulesIPC] 保存配置失败:', error)
        return false
      }
    }
  )

  // 重置配置
  ipcMain.handle('namingRules:resetConfig', async (): Promise<boolean> => {
    try {
      return resetNamingRulesConfig()
    } catch (error) {
      console.error('[NamingRulesIPC] 重置配置失败:', error)
      return false
    }
  })
}
