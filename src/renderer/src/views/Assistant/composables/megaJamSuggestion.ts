/**
 * 欢迎页的 MegaJam 建议卡片：比赛期间顶替第一张建议卡片，截止后换回原来那张。
 *
 * 比赛北京时间 2026-11-16 09:59 截止，这里按本地时间 2026-11-16 10:00 算。
 * 到期后这个文件连同 Welcome.vue 里的一处调用、两个 locale 里的
 * `assistant.suggestions.megaJam` 可以一起删。
 */

/** 本地时间 2026-11-16 10:00（月份从 0 起算） */
const MEGA_JAM_CARD_HIDDEN_FROM = new Date(2026, 10, 16, 10, 0, 0, 0)

export function isMegaJamCardVisible(now: Date = new Date()): boolean {
  return now.getTime() < MEGA_JAM_CARD_HIDDEN_FROM.getTime()
}

/** 截止前用 MegaJam 卡片顶替第一张，卡片总数不变；截止后原样返回 */
export function withMegaJamSuggestion<T>(items: T[], card: T, now: Date = new Date()): T[] {
  return isMegaJamCardVisible(now) ? [card, ...items.slice(1)] : items
}
