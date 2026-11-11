import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'

import { writeSessionFile } from './atomicSessionFile'
import { goalCheckSchema } from './goalLoop'
import { safeSessionFileBase, sessionsDir } from './transcriptStore'

const optionsSchema = z.object({
  mode: z.enum(['agent', 'ask']),
  thinkingLevel: z
    .enum(['auto', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    .optional(),
  /** 「快速」开关，续跑沿用这一轮的。见 `supportsFastMode` */
  fastMode: z.boolean().optional(),
  skillLearning: z.enum(['off', 'ask', 'auto']).optional(),
  /**
   * 这条会话绑定的模型。第一轮开始时记下，之后一直用它 —— 用户在别的会话里
   * 切模型只改那条会话和全局默认，回到这条会话模型不变。
   *
   * 缺省是本次改动之前的存量会话：下一轮按当时的全局默认补上。
   * 「从断点继续」和后台任务不经过渲染层，只能靠这一份认回原模型。
   */
  model: z.object({ providerId: z.string(), modelId: z.string() }).optional(),
  /**
   * 用户允不允许 agent 拍编辑器画面。
   *
   * 落盘是给「从断点继续」用的：那条路不经过渲染层，拿不到这一档，
   * 不记下来的话续跑那半程就重新长出了用户关掉的能力。
   *
   * 缺省（本次改动之前的存量记录、或者调用方没传）由读取方按
   * `EDITOR_SCREENSHOT_DEFAULT` 兜底 —— **三层的兜底必须是同一个值**，
   * 所以这里不写 `.default()`：写了就等于在 zod 里再抄一份默认，
   * 和主进程、渲染层那两份迟早漂移。
   */
  editorScreenshotEnabled: z.boolean().optional(),
  notebook: z.object({ id: z.string(), title: z.string().optional() }).nullable().optional(),
  /**
   * 这一轮**钉住的**目标工程。续跑靠它认回同一个工程。
   *
   * 没有它的话，续跑会拿渲染层传来的会话戳重新算一遍 —— 而没盖过戳的会话
   * 算出来的是「当前工程」，也就是**最近连上的那个**。于是：任务在 A 上跑到
   * 一半失败，用户顺手把 B 也连上，再点「从断点继续」，半途的任务就换到 B 上
   * 接着跑了，而且一句话都不会说。
   *
   * 半途换工程比停下来危险得多，所以这一档按原工程走，会话戳只在没有这条
   * 记录时（存量会话）才用。
   */
  project: z.object({ projectName: z.string(), projectPath: z.string().optional() }).optional(),
  /**
   * 这条会话**归属**的工程，只有模型调 `set_session_project` 才会写。
   *
   * 和上面的 `project` 分开是必须的：那个记的是「这一轮打到了哪个工程」，
   * 挤在一起会出两种错 —— 从没绑过、只是恰好在某个工程上跑过的会话，续跑时
   * 看起来像被钉住了；而模型明确解除归属之后字段被删掉，续跑的 `??` 就顺着
   * 掉回渲染层那份旧戳，把刚解除的归属原样复活。
   *
   * 所以是三态：**缺省** = 模型没动过，续跑照旧看 `project` 和渲染层的戳；
   * **对象** = 模型绑到了这个工程；**`null`** = 模型明确解除了，续跑必须当纯对话，
   * 不许再回头去看渲染层那份戳。
   */
  sessionProject: z
    .object({
      projectName: z.string(),
      projectPath: z.string().optional(),
      // 带上引擎版本：归属表里有它、胶囊上渲得出来，schema 装不下的话冷启动
      // 一灌回来就没了 —— `<environment>` 里没有版本而界面上写着 5.5，模型只能猜
      engineVersion: z.string().optional()
    })
    .nullable()
    .optional(),
  /**
   * 目标模式（`/goal`）。跨轮：定下之后一直在，用户在界面上点掉才删。
   * 每条新的真人消息把复核进度清零重来，见 `agent-v3:execute`。
   */
  goal: z
    .object({
      objective: z.string().min(1),
      /**
       * 定下目标之后用户又说的那句话，复核和续跑拿它压过老目标（见 `GoalLoopDeps`）。
       * 落盘是给「从断点继续」用的；`/goal` 那一轮和老记录里没有
       */
      latestRequest: z.string().optional(),
      rounds: z.number().int().min(0),
      // 复核清单，见 `goalLoop.ts` 文件头。老记录里是一句 `lastFailReason`，读回来丢掉、清单从空开始
      checklist: z.array(goalCheckSchema).default([]),
      mutations: z.array(z.string()),
      settled: z.boolean()
    })
    .optional(),
  /**
   * 工作室模式（`/team`）。和 `goal` 一样**跨轮**：用户在团队干活途中插一句
   * 「主角换成猫」，这条会话还是工作室，不能一句普通消息就把团队解散了。
   * 见 `core/team/teamSession.ts`。
   */
  team: z
    .object({
      objective: z.string().min(1),
      // 开团之后用户最近那句话，见 `TeamState.latestRequest`。`/team` 那一轮和老记录里没有
      latestRequest: z.string().optional(),
      verdict: z.enum(['pass', 'fail', 'blocked']).nullable(),
      deliveries: z.number().int().min(0),
      nudges: z.number().int().min(0),
      // 下面四项是后加的（任务板旧账、验收过期，见 `team/boardRecap.ts`），老记录里没有
      verdictAt: z.number().optional(),
      roundStartedAt: z.number().optional(),
      lastWriteAt: z.number().optional(),
      boardNudged: z.boolean().optional()
    })
    .optional()
})

/** 只保存执行配置，不保存凭据；续跑沿用这一轮，而不是重新猜默认值。 */
export type SessionExecutionOptions = z.infer<typeof optionsSchema>

function optionsPath(sessionId: string): string {
  return join(sessionsDir(), `${safeSessionFileBase(sessionId)}.execution.json`)
}

export async function loadExecutionOptions(
  sessionId: string
): Promise<SessionExecutionOptions | undefined> {
  try {
    return optionsSchema.parse(JSON.parse(await fs.readFile(optionsPath(sessionId), 'utf8')))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    // 损坏的权限配置不能悄悄降级为普通模式。
    throw error
  }
}

export async function saveExecutionOptions(
  sessionId: string,
  options: SessionExecutionOptions
): Promise<void> {
  await writeSessionFile(optionsPath(sessionId), JSON.stringify(optionsSchema.parse(options)))
}

export async function deleteExecutionOptions(sessionId: string): Promise<void> {
  await fs.rm(optionsPath(sessionId), { force: true })
}

export async function copyExecutionOptions(source: string, target: string): Promise<void> {
  const options = await loadExecutionOptions(source)
  if (!options) return
  // 分支、侧边问一句都不带走目标：目标是原会话那条主线的，分支可能切在定目标之前，
  // 侧边问一句是只读的，带过去每句都会报「目标不可能达成」
  const rest = { ...options }
  delete rest.goal
  await saveExecutionOptions(target, rest)
}

export function resumeExecutionOptions(
  saved: SessionExecutionOptions | undefined,
  mode?: 'agent' | 'ask'
): SessionExecutionOptions {
  return {
    ...saved,
    // 续跑不能放宽原任务的只读约束。没有旧配置也没有显式模式时按只读恢复。
    mode: saved?.mode === 'ask' || mode === 'ask' ? 'ask' : (saved?.mode ?? mode ?? 'ask')
  }
}
