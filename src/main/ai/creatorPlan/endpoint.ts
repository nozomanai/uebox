/**
 * Box Plan 的服务地址（中转站 token.uebox.ai） —— 全仓唯一写着官方域名的地方。
 *
 * 官方端点门禁（`scripts/check-official-endpoints.mjs`）把这个文件归在
 * 「用户主动开通的官方付费服务」一类：地址写在这里，但只有用户在设置里点「连接」之后
 * 才会被用到；没连接时，应用启动、打开设置页都不会发出任何请求。
 * 其余 creatorPlan 代码一律从参数拿地址，不许再写域名。
 *
 * 开发联调时用 UEBOX_CREATOR_PLAN_URL 指到本机服务（如 http://localhost:5173）。
 */

export const CREATOR_PLAN_ORIGIN = (
  process.env.UEBOX_CREATOR_PLAN_URL || 'https://token.uebox.ai'
).replace(/\/+$/, '')

/** 网页端的 API Key 列表。断开时服务端没吊销成功，引导用户来这里手动吊销 */
export const CREATOR_PLAN_KEYS_URL = `${CREATOR_PLAN_ORIGIN}/keys`
