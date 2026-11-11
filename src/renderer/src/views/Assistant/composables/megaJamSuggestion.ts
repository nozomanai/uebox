/**
 * 欢迎页的 MegaJam 建议卡片：本地时间 2026-12-01 00:00 起不再显示。
 *
 * 到期后这个文件连同 Welcome.vue 里的一处调用、两个 locale 里的
 * `assistant.suggestions.megaJam` 可以一起删。
 */

/** 本地时间 2026-12-01 00:00（月份从 0 起算） */
const MEGA_JAM_CARD_HIDDEN_FROM = new Date(2026, 11, 1, 0, 0, 0, 0)

export function isMegaJamCardVisible(now: Date = new Date()): boolean {
  return now.getTime() < MEGA_JAM_CARD_HIDDEN_FROM.getTime()
}

/** 到期前把 MegaJam 卡片放在第一张，到期后原样返回 */
export function withMegaJamSuggestion<T>(items: T[], card: T, now: Date = new Date()): T[] {
  return isMegaJamCardVisible(now) ? [card, ...items] : items
}
