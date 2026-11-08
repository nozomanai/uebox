/**
 * V3 的 Skill 层。
 *
 * ## 与 V2 的关系
 *
 * 复用 V2 的 `SkillsService`（frontmatter 解析、目录发现、路径穿越防护、
 * references/scripts/assets 子资源读取）—— 那套是对的，没必要重写。
 *
 * 变的是**怎么用**：
 *
 * | | V2 | V3 |
 * |---|---|---|
 * | 谁能看到 skill | 按 `specialistSkillMap` 绑定到专家 | 全部 skill 对主 agent 可见，由它按 description 自选 |
 * | 工具名 | skill 正文里是 `blueprint.add_node` | 加载时重写成 `blueprint_add_node` |
 * | 旧名兼容 | `LEGACY_SKILL_ALIASES` 映射表 | 不带（V3 是新起点，没有历史调用方） |
 *
 * ## 为什么必须重写工具名
 *
 * 53 个 skill 里有 13 个引用点号工具名（`blueprint.get_graph` 出现 10 次）。
 * V3 把工具名统一成下划线（厂商要求 `^[a-zA-Z0-9_-]+$`），skill 正文不跟着改，
 * 模型会照着 skill 的指示去调一个不存在的工具 —— 而且这是**加载 skill 之后**
 * 才发生，比工具描述里的引用更难查。
 *
 * ## 渐进披露
 *
 * 1. 常驻：全部 skill 的 name + description 进 system prompt（每个约 30 token）
 * 2. 按需：agent 调 `load_skill(name)` 拿 SKILL.md 正文
 * 3. 深挖：agent 调 `read_skill_resource(name, path)` 读 references/ 下的文件
 */

import { basename, dirname, join, resolve, sep } from 'path'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import { app } from 'electron'
import { z } from 'zod'
import { SKILL_CREATOR_NAME } from '../../../shared/skillLearning'
import type { SharedSkillOrigin } from '../../../shared/share'

import {
  discoverSkills,
  loadSkill,
  readSkillResource,
  type SkillMetadata,
  type SkillSource
} from '../../agent-v3/capabilities/skillsService/SkillsService'
import { rewriteCrossReferences } from '../tools/toolNames'
import { defineTool, type ToolOutcome, type UnrealAgentTool } from '../tools/defineTool'

/**
 * skill 搜索路径。**顺序即优先级** —— 同名时先发现的胜出：
 *
 *   0. 当前工程自带的（`<工程根>/.uebox/skills`，见 `projectSkillsDir`）
 *   1. 用户自己写的（可以覆盖内置和插件的同名 skill）
 *   2. 插件带来的
 *   3. 随包内置的
 */
export function skillDirectories(pluginSkillDirs: string[] = [], projectRoot?: string): string[] {
  const builtinSkillsDir = app.isPackaged
    ? join(process.resourcesPath, 'skills')
    : join(app.getAppPath(), 'resources', 'skills')
  const projectDir = projectSkillsDir(projectRoot)
  return [
    ...(projectDir ? [projectDir] : []),
    userSkillsDir(),
    ...pluginSkillDirs,
    builtinSkillsDir
  ]
}

/**
 * 工程自带的 skill 目录：`<工程根>/.uebox/skills`。
 *
 * ## 为什么要有这一层
 *
 * 用户目录和内置目录都是**跨工程**的，而有一类知识只属于某一个工程：
 * 「这个数字人的 13 条动作要这样导、12 条是 additive、导完还要做静止姿势校正」，
 * 连同干这件事的脚本。放内置等于发给所有用户，放用户目录等于在每个工程里都冒出来。
 * 真机上撞到过：工程 `Scripts/` 里明明有 `import_motion_clips.py`，agent 五条导入
 * API 全失败后让用户手动导 —— 它从没想过去翻那个目录。放进 skill 清单，它每轮都看得见。
 *
 * 优先级最高：同一个工程里，团队写下的做法比通用做法更贴近现场。
 *
 * @param projectRoot 工程根目录，或 `.uproject` 文件路径
 */
export function projectSkillsDir(projectRoot?: string): string | undefined {
  if (!projectRoot) return undefined
  const root = projectRoot.toLowerCase().endsWith('.uproject') ? dirname(projectRoot) : projectRoot
  // 防一手：路径说不清就不认，免得在盘根下找 .uebox
  if (!root || basename(root) === '') return undefined
  return join(root, '.uebox', 'skills')
}

/**
 * 用户自己的 skill 目录。
 *
 * 单独导出是因为它有第二个用途：写进 system prompt，让模型知道新 skill 该落在
 * 哪里。原先没有这一条，`ue-skill-creator` 只能让用户去「设置 → AI → 打开
 * Skills 目录」把绝对路径贴回来 —— 一次沉淀要用户手动搬一趟路径，
 * 自动档下更是无人可问。
 *
 * 这个路径不是秘密（用户点一下按钮就能看到），但同层的 `ai-provider-secrets.bin`
 * 是 —— 所以 `tools/builtin/pathBoundary.ts` 只对 `skills/` 这一个子目录开口子。
 */
export function userSkillsDir(): string {
  return join(app.getPath('userData'), 'skills')
}

/**
 * 扫出盘上全部 skill，**不看用户有没有把它关掉**。
 *
 * 只有两个用途：设置页那张清单（关掉的也得列出来，否则没法再打开），
 * 以及按名字找路径（读正文、删除）。**agent 装配一律走
 * `discoverEnabledSkills()`** —— 见那个函数的注释。
 *
 * 失败返回空数组而不是抛 —— skill 是增强能力，目录不存在或某个 SKILL.md
 * 写坏了不该让整个 agent 起不来。
 */
export async function discoverSkillsOnDisk(projectRoot?: string): Promise<SkillMetadata[]> {
  try {
    // 插件的 skill 一并纳入。插件目录读不出来时按「没有插件」继续，
    // 不该让一个坏插件把内置 skill 也一起废掉。
    const { enabledPluginSkillDirs } = await import('./plugins/registry')
    const pluginDirs = await enabledPluginSkillDirs().catch(() => [])
    const sources: SkillSource[] = [
      ...(projectSkillsDir(projectRoot) ? ['project' as const] : []),
      'user',
      ...pluginDirs.map(() => 'plugin' as const),
      'builtin'
    ]
    return await discoverSkills(skillDirectories(pluginDirs, projectRoot), sources)
  } catch (error) {
    console.warn('[AgentV3] Skill 发现失败，按无 skill 继续:', error)
    return []
  }
}

/**
 * agent 该看到的 skill：盘上有的，减去用户关掉的。
 *
 * ## 为什么过滤放在这里，而不是各个装配点
 *
 * 两种放法的失败方向不一样。放在装配点，将来多一条 agent 路径而作者忘了过滤，
 * 结果是「用户明明关了它还在加载」—— 开关形同虚设，而且没有任何报错。
 * 放在这里，新路径默认只拿到开着的那些，想要全量必须显式去要
 * `discoverSkillsOnDisk()`。开关这种东西，失效的方向只能是「多关掉」，
 * 不能是「悄悄还开着」。
 */
export async function discoverEnabledSkills(projectRoot?: string): Promise<SkillMetadata[]> {
  const [skills, disabled] = await Promise.all([
    discoverSkillsOnDisk(projectRoot),
    readDisabledSkills()
  ])
  return skills.filter((skill) => !disabled.has(skill.name))
}

// ── 开关：哪些 skill 不加载 ──────────────────────────────────────────────

const DISABLED_SKILLS_FILE = 'disabled-skills.json'

/** 关掉的 skill 名单存在哪。和插件的 `disabled-plugins.json` 同一套做法 */
export function disabledSkillsPath(): string {
  return join(app.getPath('userData'), DISABLED_SKILLS_FILE)
}

/**
 * 读那份名单。
 *
 * 读不出来一律当成「一个都没关」：这个文件不存在是最常见的情况（没人关过），
 * 而它坏掉时，让全部 skill 照常加载也比让 agent 突然什么都不会要好。
 */
export async function readDisabledSkills(): Promise<Set<string>> {
  try {
    const parsed = JSON.parse(await readFile(disabledSkillsPath(), 'utf8'))
    return new Set(Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : [])
  } catch {
    return new Set()
  }
}

async function writeDisabledSkills(names: Set<string>): Promise<void> {
  await mkdir(app.getPath('userData'), { recursive: true })
  await writeFile(disabledSkillsPath(), JSON.stringify([...names], null, 2), 'utf8')
}

/**
 * 关掉 / 打开一个 skill。
 *
 * 按**名字**记，不按路径：用户今天关掉的内置 skill，明天可能被同名的用户版本
 * 覆盖（发现路径里用户目录优先）。他关的是「这个技能」，不是「这个文件」。
 */
export async function setSkillDisabled(name: string, disabled: boolean): Promise<void> {
  const names = await readDisabledSkills()
  if (disabled) names.add(name)
  else names.delete(name)
  await writeDisabledSkills(names)
}

/**
 * 这个 skill 是不是用户目录里的那一份。
 *
 * 判据走**解析后的绝对路径前缀**，不看 `source` 字段：删除是不可逆的，
 * 而 `source` 是发现时按目录序号推出来的一个标注 —— 它对了不代表路径对。
 * 前缀比对直接回答唯一要紧的那个问题：这个目录在不在用户自己的 skill 目录下。
 */
export function isUserSkillPath(skillPath: string): boolean {
  const root = resolve(userSkillsDir())
  const target = resolve(skillPath)
  return target !== root && target.startsWith(root + sep)
}

/**
 * 删掉用户自己那份 skill 里的若干个。返回真的删掉了几个。
 *
 * ## 为什么按名字进来、按路径删
 *
 * 名字是渲染层给的，不能直接拼进路径 —— `..` 一放进去就删到别处了，而同层
 * 就放着 `ai-provider-secrets.bin`。所以先扫一遍真实的 skill 清单，从里面
 * 按名字找出那一条的**实际路径**，再用 `isUserSkillPath` 确认它在用户目录下。
 * 名字对不上、或者路径不在用户目录（内置和插件带的）一律跳过，不报错 ——
 * 用户要删的东西已经不在了，这跟删成功没有区别。
 *
 * ## 为什么不做「清空整个目录」
 *
 * 那个目录里可能有用户自己手写的 skill，也可能有别的东西。一条条按清单删，
 * 删掉的每一个都是界面上真的列出来过的。
 */
export async function deleteUserSkills(names: readonly string[]): Promise<number> {
  if (names.length === 0) return 0

  const wanted = new Set(names)
  const all = await discoverSkillsOnDisk()
  let deleted = 0

  for (const skill of all) {
    if (!wanted.has(skill.name) || !isUserSkillPath(skill.path)) continue
    try {
      await rm(skill.path, { recursive: true, force: true })
      deleted += 1
      // 顺手从「关掉」名单里划掉。留着的话，将来同名的技能（用户重写一份，
      // 或者删掉的本来就是内置版的覆盖件）一冒出来就是关着的，
      // 而用户从没关过它 —— 他会以为这个技能坏了。
      await setSkillDisabled(skill.name, false)
    } catch (error) {
      console.warn(`[AgentV3] 删除技能 ${skill.name} 失败:`, error)
    }
  }

  return deleted
}

// ── 正文的读与写 ────────────────────────────────────────────────────────

/**
 * 用户 skill 的目录名字符约束。
 *
 * 名字来自渲染层，会成为目录名 —— `..` 一放进去就写到别处了，而
 * 用户数据目录里同层放着 `ai-provider-secrets.bin`。
 */
const VALID_SKILL_DIR = /^[a-zA-Z0-9_-]{1,64}$/

export interface SkillDocument {
  name: string
  source: SkillSource
  /** SKILL.md 的完整内容，**含 frontmatter** —— 见 readSkillDocument 的说明 */
  content: string
  /**
   * 保存会落到哪儿。
   *
   * - `own`：这就是用户自己的文件，原地改
   * - `copy`：内置或插件带的，保存会在用户目录里另存一份**覆盖**它
   */
  savesAs: 'own' | 'copy'
}

/**
 * 读一个 skill 的 SKILL.md，给设置页的编辑框用。
 *
 * ## 为什么连 frontmatter 一起给
 *
 * `load_skill` 给模型的是剥掉 frontmatter 的正文，因为模型不需要那几行元数据。
 * 但用户编辑的是**这个文件**：`description` 那一行正是决定模型什么时候会想起
 * 这个技能的路由信号，藏起来就等于「你可以改内容，但改不了它什么时候被用」。
 * 代价是用户可能把 frontmatter 写坏 —— 所以写回时会校验（见 writeSkillDocument）。
 */
export async function readSkillDocument(name: string): Promise<SkillDocument | null> {
  const skill = (await discoverSkillsOnDisk()).find((s) => s.name === name)
  if (!skill) return null

  try {
    return {
      name: skill.name,
      source: skill.source ?? 'builtin',
      content: await readFile(join(skill.path, 'SKILL.md'), 'utf8'),
      savesAs: isUserSkillPath(skill.path) ? 'own' : 'copy'
    }
  } catch (error) {
    console.warn(`[AgentV3] 读取技能 ${name} 正文失败:`, error)
    return null
  }
}

/**
 * 写回一个 skill 的正文。
 *
 * ## 内置和插件带的怎么办
 *
 * **不原地改**，在用户目录里另存一份。两个理由：随包发的那份下次更新就被覆盖，
 * 用户的修改无声无息地没了；装出去的应用里 `resources/` 还可能是只读的。
 * 而发现路径本来就是「用户目录优先、同名先到先得」（见 `skillDirectories`），
 * 所以另存一份的效果正好是「从此这个技能用我的版本」，删掉它就退回内置版。
 *
 * ## 为什么要校验 frontmatter
 *
 * 发现流程对写坏的 SKILL.md 是**静默跳过**的（`discoverSkills` 里那个空 catch）。
 * 不校验就存的话，用户改完保存、回到清单，那条技能直接消失了 —— 没有报错，
 * 没有线索。名字对不上也一样：他以为在改 A，实际存出了一个叫 B 的新技能。
 */
export async function writeSkillDocument(
  name: string,
  content: string
): Promise<{ success: true; source: SkillSource } | { success: false; error: string }> {
  if (!VALID_SKILL_DIR.test(name)) {
    return { success: false, error: `技能名 "${name}" 非法：只允许字母、数字、下划线、连字符` }
  }

  const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!frontmatter?.[1]) {
    return {
      success: false,
      error: '开头那段 --- 包起来的 frontmatter 不见了。没有它，这个技能不会被加载。'
    }
  }

  const declared = frontmatter[1].match(/^name:\s*(.+)$/m)?.[1]?.trim()
  if (!declared) {
    return { success: false, error: 'frontmatter 里缺 name 这一行。没有它，这个技能不会被加载。' }
  }
  if (declared !== name) {
    return {
      success: false,
      error: `frontmatter 中的 name 为 ${declared}，与当前编辑的「${name}」不一致。如需改名，请另存为新技能。`
    }
  }

  const existing = (await discoverSkillsOnDisk()).find((s) => s.name === name)

  // 用户自己的就原地改：他的目录名不一定等于技能名（发现是按 frontmatter 认的），
  // 按技能名另写一份会凭空多出一条同名的
  const targetDir =
    existing && isUserSkillPath(existing.path) ? existing.path : join(userSkillsDir(), name)

  // 纵深防御：name 已经过正则，这里再确认一次解析出来的路径没跑出用户技能目录
  const root = resolve(userSkillsDir())
  if (!resolve(targetDir).startsWith(root + sep)) {
    return { success: false, error: `技能 "${name}" 解析出的路径越界` }
  }

  try {
    await mkdir(targetDir, { recursive: true })
    await writeFile(join(targetDir, 'SKILL.md'), content, 'utf8')
    return { success: true, source: 'user' }
  } catch (error) {
    return { success: false, error: `写入失败：${(error as Error).message}` }
  }
}

/**
 * 界面清单项的长度上限。
 *
 * 兜底而已 —— 正常情况 `firstSentence` 已经把长度压下来了，这条是防着
 * 某个 skill 把一整段写成没有句号的一句话。
 */
const MAX_SUMMARY_CHARS = 160

/**
 * 路由清单项的长度上限。
 *
 * 取官方 Agent Skills 规范给 description 的上限（1024 字符），也就是
 * `scripts/check-skills.mjs` 已经在门禁里守着的那个数 —— 合规的 skill 一个都不会被截。
 * 留这条只是防着用户/插件目录里塞进来一段没有上限的描述。
 */
const MAX_ROUTING_CHARS = 1024

/**
 * 取描述的第一句。
 *
 * skill 的 description 是拿来判断「要不要点进去看」的，不是使用说明 ——
 * 正文本来就在 `load_skill` 里等着。原先整段照搬，50 个 skill 合计 17.8k 字符
 * （约 4.5k token），**占掉整个系统提示词的 97%**，把真正的行为约束淹没了。
 * 只留第一句是 5.4k 字符，砍掉七成。
 *
 * 拉丁文判据要求句号后面跟空格再跟大写字母：有个 skill 的描述里写了
 * `/Game/...`，按「句号即断句」会被砍成半句话。中英各算一次取更短的那个，
 * 免得混排时抓错边界。
 */
function firstSentence(description: string): string {
  const candidates: string[] = []

  const cjk = description.match(/^(.+?[。！？])/)
  if (cjk) candidates.push(cjk[1])

  const latin = description.match(/^(.+?[a-z0-9)\]"'])\.\s+[A-Z]/)
  if (latin) candidates.push(`${latin[1]}.`)

  const picked = candidates.length
    ? candidates.reduce((a, b) => (a.length <= b.length ? a : b))
    : description

  return picked.length > MAX_SUMMARY_CHARS
    ? `${picked.slice(0, MAX_SUMMARY_CHARS - 1).trimEnd()}…`
    : picked
}

/**
 * 路由清单里那一行的文本：整段 description，只在超长时截断。
 *
 * 和 `firstSentence` 的分工：那个给界面（一行菜单，长了排不下），
 * 这个给模型（要靠它决定调不调 `load_skill`，删一个字都是删判据）。
 */
function routingSummary(description: string): string {
  const text = description.trim()
  return text.length > MAX_ROUTING_CHARS
    ? `${text.slice(0, MAX_ROUTING_CHARS - 1).trimEnd()}…`
    : text
}

export interface SkillSummary {
  name: string
  description: string
  source: SkillSource
  /** 用户有没有把它关掉。关掉的仍然要列出来 —— 否则没法再打开 */
  enabled: boolean
  /** 从官网共享库装的：技能页显示「来自共享 · 第 N 版」 */
  shared?: SharedSkillOrigin
}

/**
 * 给界面用的安全清单：不暴露本机目录，只返回搜索和展示所需字段。
 *
 * `disabled` 由调用方传进来而不是在这里读盘：这个函数是纯的（好测），
 * 而且清单和开关状态必须来自同一次读取，否则两者可能对不上。
 */
export function listSkillSummaries(
  skills: SkillMetadata[],
  disabled: ReadonlySet<string> = new Set(),
  shared: ReadonlyMap<string, SharedSkillOrigin> = new Map()
): SkillSummary[] {
  return skills.map((skill) => {
    const origin = shared.get(skill.name)
    return {
      name: skill.name,
      description: firstSentence(skill.description),
      source: skill.source ?? 'builtin',
      enabled: !disabled.has(skill.name),
      ...(origin ? { shared: origin } : {})
    }
  })
}

/**
 * 生成注入 system prompt 的 skill 清单。
 *
 * ## 为什么用 `<available_skills>` 包起来
 *
 * 抄 pi 自己的做法。清单有 50 条，不划出边界的话模型分不清「清单在哪结束、
 * 指令从哪继续」—— 尾部的环境信息很容易被当成又一条 skill。
 *
 * 但**没有**照搬 pi 每条 skill 一个嵌套 `<skill>` 元素：pi 那边通常只有几条，
 * 我们有 50 条，一条 4 行标签要多花约 600 token 换不来额外的可读性。
 * 边界的价值在外层，逐条的价值不抵成本。
 *
 * 也没有 pi 的 `<location>` 绝对路径：pi 是编码 agent，用通用 `read` 工具读文件，
 * 必须知道路径；我们的 `load_skill` 按名字解析，给路径纯属浪费，
 * 而且等于把 skill 目录暴露给模型去自由读取。
 *
 * ## 这里为什么给整段 description，而不是像界面那样只给第一句
 *
 * 曾经这里也走 `firstSentence`，为的是省 token。代价是把**唯一**能分开
 * 相邻 skill 的那段话删掉了：我们的 description 一律写成
 * 「做什么。Use when 用户说……。Do not use for ……」，而句子边界正好落在
 * 「做什么」之后 —— 实测 12 个内置 skill 100% 丢掉 `Use when` 和
 * `Do not use`，其中 4 个连第一句都没说完就被 160 字符切成半句。
 *
 * 丢掉的恰恰是路由信号本身：中文触发语（「走进触发区就开门」）在 `Use when`
 * 里，「这事该找隔壁那个 skill」在 `Do not use` 里。清单只剩一句能力概述时，
 * 十二个高度重叠的 UE skill 在模型眼里几乎没有区别。
 *
 * 代价是 12 个内置 skill 从约 1.9k 字符涨到 4.4k（约 +620 token）。这笔钱要花：
 * 选错 skill 之后走的弯路，比这贵得多。真到了几十个 skill 撑不住的那天，
 * 该做的是压缩「做什么」那半句，不是继续删边界。
 */
export function buildSkillsSection(skills: SkillMetadata[]): string {
  if (skills.length === 0) return ''

  const list = skills
    .map((s) => `- ${s.name}: ${routingSummary(rewriteCrossReferences(s.description))}`)
    .join('\n')

  return `

The following skills are procedures for specific kinds of work.
Before acting in a domain, check this list: when a skill matches, call \`load_skill\` with its
name and follow that procedure rather than improvising.
When the user writes \`$<skill-name>\`, that is an explicit selection: call \`load_skill\` with
that exact skill name before answering or acting.
When a skill body points at a file under \`references/\`, \`scripts/\` or \`assets/\`, call
\`read_skill_resource\` with the skill name and that relative path. A Python script under
\`scripts/\` that the skill tells you to run goes to \`ue_run_python_script\` by \`skill\` +
\`skill_script\` (+ \`args\`) — do not copy its text into \`script\`.

<available_skills>
${list}
</available_skills>
`
}

/**
 * 技能沉淀的三档开关。
 *
 * | 档位 | 模型看得到 `ue-skill-creator` 吗 | 沉淀时的行为 |
 * |---|---|---|
 * | `off` | 看不到（整条从清单里删掉） | 不会自己写 skill |
 * | `ask` | 看得到 | 干完活给一条提案，用户点头才写 |
 * | `auto` | 看得到 | 自己写，写完在交付里说 |
 *
 * 缺省是 `ask`。这是**唯一**能默认开着的档：`off` 等于这个功能不存在，
 * `auto` 会在用户还没建立信任之前就往盘上写东西。
 */
export type SkillLearningMode = 'off' | 'ask' | 'auto'

/**
 * 负责「把经验写成 skill」的那个内置 skill。
 *
 * 定义在 `shared/` 是因为设置页也要认它 —— 关档时这条技能会被整条摘掉，
 * 而它自己的开关仍然显示开着，界面得据此标出来。
 */
export { SKILL_CREATOR_NAME }

/**
 * 按档位裁剪 skill 清单。
 *
 * 关档时是**真的删掉**，不是加一句「别用它」—— 清单里留着而叫模型别看，
 * 既照付 token 又时灵时不灵。代价是用户在关档下明确要求沉淀时，模型只能
 * 自己发挥，写出来的 skill 没有那套方法论。这是「关闭」这个词该有的意思。
 */
export function applySkillLearningMode(
  skills: SkillMetadata[],
  mode: SkillLearningMode
): SkillMetadata[] {
  return mode === 'off' ? skills.filter((s) => s.name !== SKILL_CREATOR_NAME) : skills
}

/**
 * 沉淀相关的提示词补充。关档、或者这台机器上根本没有那个 skill 时是空串。
 *
 * 两档都要给目录：模型不知道用户 skill 存在哪，写出来的文件不会被加载。
 * 自动档还要额外一句 —— `ue-skill-creator` 正文里写死了「先提案，后写入」，
 * 不明说这里覆盖了它，模型会照着正文继续问，用户选的自动档就等于没选。
 */
export function buildSkillLearningSection(
  skills: SkillMetadata[],
  mode: SkillLearningMode = 'ask'
): string {
  if (mode === 'off') return ''
  if (!skills.some((s) => s.name === SKILL_CREATOR_NAME)) return ''

  const lines = [
    '',
    `Skills the user owns live in \`${userSkillsDir()}\`. That is where a new or updated skill goes — one directory per skill, with \`SKILL.md\` inside. It is the only writable place under the app's data folder; everything else there is refused.`
  ]

  if (mode === 'auto') {
    lines.push(
      'The user has turned skill distillation to automatic. When finished, verified work leaves behind a genuinely reusable procedure, follow `ue-skill-creator` and write it out yourself — this replaces that skill\'s "propose first, write after" step. Writing files still goes through the usual approval, and everything that skill refuses to record still applies. Name what you saved in your final answer.'
    )
  }

  return `${lines.join('\n')}\n`
}

const loadSkillInput = z.object({
  name: z.string().describe('技能名称，如 "ue-blueprint-graph-wiring"')
})

const readResourceInput = z.object({
  name: z.string().describe('技能名称'),
  relativePath: z
    .string()
    .describe(
      '技能目录下的相对路径。只允许 references/、scripts/、assets/，' +
        '如 references/graph-mutation-guardrails.md'
    )
})

/**
 * 跟在 skill 正文后面的一句话：照着走发现对不上，回头改它。
 *
 * ## 为什么挂在 `load_skill` 的返回值上
 *
 * `ue-skill-creator` 早就写了「更新」该怎么做，缺的是**有人叫它去做**。
 * skill 的 description 通篇是创建口径（「把这次经验沉淀成技能」），
 * 于是「这条 skill 说的和实际不符」这件事没有任何路由信号 —— agent 照着一条
 * 过时的 skill 干活，撞了墙，绕过去，然后那条 skill 继续错着等下一个人。
 *
 * 挂在返回值上而不是写进系统提示词：只有真加载了 skill 的那几轮才付这个 token，
 * 而且它出现在正文正下方 —— 「这段话说的是刚才那份指引」不需要模型再去推断。
 * 和写文件后面贴体检报告是同一个手法。
 *
 * 门槛写死在「工具结果证伪了」这一档。不设门槛的话，模型会开始为措辞提改进意见，
 * 而那种提议对用户是纯噪音 —— 一条 skill 的价值不在于文笔。
 */
const ITERATION_NUDGE =
  '\n\nThis procedure was distilled from a small number of real runs, so it knows less than it ' +
  'looks like it does. Two things are worth reporting back, and offering to correct rather than ' +
  'silently working around: it was proven wrong (a tool named here does not exist, a step fails, ' +
  'a claim is contradicted by a real result), or it was silent on the case you hit and that cost ' +
  'you real steps. Both need something concrete to have happened — wording you would have phrased ' +
  'differently is not a reason. If it has a Coverage section and you just ran a case listed as ' +
  'not tried, that move is worth reporting too.'

/**
 * 模型刚看到的那份上下文里，这个技能的正文还在不在。
 *
 * 为什么要问：同一个技能重复加载，正文会作为**最新的工具结果**再进一次上下文。
 * 技能写的是一套从头开始的流程，模型拿到它就从第一步重新执行 —— 真机上 game-jam
 * 五轮里加载了四次，每次都把「先问五个问题」的访谈重来一遍，用户答过的全白答。
 *
 * 判据只认「原文还在」：找一条 `load_skill` 的成功结果，技能名对得上、文字以同一份
 * 正文开头。被压缩进摘要的、被大结果存档换成存根的都不算 —— 那时正文确实不在了，
 * 重新加载是对的。
 */
export function skillBodyVisible(
  messages: readonly unknown[],
  name: string,
  content: string
): boolean {
  const head = content.slice(0, 400)
  return messages.some((raw) => {
    const m = raw as {
      role?: string
      toolName?: string
      isError?: boolean
      details?: { skillName?: string }
      content?: unknown
    }
    if (m.role !== 'toolResult' || m.toolName !== 'load_skill' || m.isError) return false
    if (m.details?.skillName !== name) return false
    const blocks = Array.isArray(m.content) ? m.content : []
    const text = blocks
      .map((b) =>
        (b as { type?: string }).type === 'text' ? ((b as { text?: string }).text ?? '') : ''
      )
      .join('')
    return text.startsWith(head)
  })
}

/** `createSkillTools` 的可选接缝，都由持有 Agent 的一方提供 */
export interface SkillToolHooks {
  /**
   * 这个技能的正文是否还在模型刚看到的上下文里（判据见 `skillBodyVisible`）。
   * 不给就当不在 —— 外部 MCP 宿主看不到对话，照旧每次给全文。
   */
  bodyVisible?: (name: string, content: string) => boolean
}

/**
 * 造出 load_skill / read_skill_resource 两个工具。
 *
 * `mode` 决定要不要在正文后面追那句「发现不对就回头改」—— 关档时
 * `ue-skill-creator` 根本不在清单里，叫模型去改它只会让它去手搓一个改法。
 */
export function createSkillTools(
  skills: SkillMetadata[],
  mode: SkillLearningMode = 'ask',
  loadTools?: (content: string) => ToolOutcome,
  hooks: SkillToolHooks = {}
): UnrealAgentTool<unknown>[] {
  if (skills.length === 0) return []

  const nudge = mode === 'off' ? '' : ITERATION_NUDGE

  const loadTool = defineTool({
    name: 'load_skill',
    namespace: 'core',
    // 只读文件，不改任何东西
    risk: 'safe',
    description:
      '加载一个技能的完整指引。做某个领域的事之前先调它 —— ' +
      '技能里写的是这个领域的正确流程和已知的坑，比凭经验试错快得多。',
    input: loadSkillInput,
    execute: async ({ name }) => {
      const result = await loadSkill(skills, name)
      if (!result) {
        // 抛出而不是返回错误对象：pi 只认异常。顺带把可选值给出来，
        // 模型下一次就能选对，而不是反复猜。
        throw new Error(`技能 "${name}" 不存在。可用技能：${skills.map((s) => s.name).join(', ')}`)
      }

      const content = rewriteCrossReferences(result.content)
      const loaded = loadTools?.(content)
      if (hooks.bodyVisible?.(result.name, content)) {
        // 不再贴一遍正文。工具照常补加载（幂等，正文点名的工具这一轮可能还没装上）
        return {
          text:
            `技能 "${result.name}" 已经加载过，正文就在上文那次 load_skill 的结果里，内容没变，这次不再重复。` +
            '接着当前进度往下做：不要从技能的第一步重来，用户已经回答过的问题不要再问。' +
            (loaded?.text ? `\n\n${loaded.text}` : ''),
          details: {
            skillName: result.name,
            skillDirectory: result.skillDirectory,
            source: result.source,
            alreadyLoaded: true,
            ...(loaded?.details ? { toolSearch: loaded.details } : {})
          }
        }
      }
      return {
        // 正文里的工具名同样要重写 —— 否则模型会照着技能的指示
        // 去调 blueprint.add_node，而注册的是 blueprint_add_node
        text: content + nudge + (loaded?.text ? `\n\n${loaded.text}` : ''),
        details: {
          skillName: result.name,
          skillDirectory: result.skillDirectory,
          source: result.source,
          ...(loaded?.details ? { toolSearch: loaded.details } : {})
        }
      }
    }
  })

  const readTool = defineTool({
    name: 'read_skill_resource',
    namespace: 'core',
    risk: 'safe',
    description:
      '读取技能目录下的附带资源（references/、scripts/、assets/）。' +
      '技能正文提到某个文件时用它读取。',
    input: readResourceInput,
    execute: async ({ name, relativePath }) => {
      // readSkillResource 返回的是联合类型：成功分支或 { error, availableResources }，
      // 不是 null。可选文件清单要带给模型，否则它只能反复猜路径。
      const result = await readSkillResource(skills, name, relativePath)
      if ('error' in result) {
        const available = result.availableResources?.length
          ? `可用资源：${result.availableResources.join(', ')}`
          : '该技能没有附带资源'
        throw new Error(`读取 ${name}/${relativePath} 失败：${result.error}。${available}`)
      }
      const content = rewriteCrossReferences(result.content)
      const loaded = loadTools?.(content)
      return {
        text: content + (loaded?.text ? `\n\n${loaded.text}` : ''),
        details: {
          skillDirectory: result.skillDirectory,
          relativePath: result.relativePath,
          ...(loaded?.details ? { toolSearch: loaded.details } : {})
        }
      }
    }
  })

  return [loadTool, readTool] as unknown as UnrealAgentTool<unknown>[]
}
