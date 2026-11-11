/**
 * 共享技能的服务地址 —— 共享功能里唯一写着官方域名的地方。
 *
 * 官方端点门禁（`scripts/check-official-endpoints.mjs`）把这个文件归在「用户主动使用的
 * 官方服务」一类：只有用户在网页上点「装到盒子」、对 Agent 说「装上 …/s/xxx」、
 * 跑 `uebox skills add`，或在技能页点「分享」时才会请求；启动和打开任何页面都不发请求。
 * 请求代码在 shareClient.ts，从这里拿地址。
 *
 * 开发联调时用 UEBOX_SHARE_URL 指到本机服务（如 http://localhost:4321）。
 */

export const SHARE_ORIGIN = (process.env.UEBOX_SHARE_URL || 'https://uebox.ai').replace(/\/+$/, '')

/**
 * 分享用账户的设备授权和账户名（/v1/connect/*、/v1/plan）。账户归 uebox.ai，服务在 plan.uebox.ai；
 * 模型连接已经换到中转站（creatorPlan/endpoint.ts），两边的 Key 不通用。
 * 开发联调时用 UEBOX_SHARE_ACCOUNT_URL 指到本机服务。
 */
export const SHARE_ACCOUNT_ORIGIN = (
  process.env.UEBOX_SHARE_ACCOUNT_URL || 'https://plan.uebox.ai'
).replace(/\/+$/, '')

/** 用户口头或网页上给的技能地址长这样：uebox.ai/s/<id> */
export const SHARE_HOST = 'uebox.ai'

export const SHARE_API = `${SHARE_ORIGIN}/api/share`

export const skillPageUrl = (id: string): string => `${SHARE_ORIGIN}/s/${encodeURIComponent(id)}`

export const submissionStatusUrl = (sid: string): string =>
  `${SHARE_ORIGIN}/share/submit/?sid=${encodeURIComponent(sid)}`
