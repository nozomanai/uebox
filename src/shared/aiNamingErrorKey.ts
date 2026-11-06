/**
 * AI 智能命名失败的可枚举原因。主进程在 `error`（给日志的原文）之外附带这个码，
 * 渲染层拿它去语言包查译文 —— 界面文案归界面管，主进程只管事实。
 * 值与 `assetManagement.aiNaming.*` 一一对应。
 *
 * 同一个字面量曾在主进程和界面各写一份，改了一边另一边不报错、提示静悄悄不弹，
 * 所以收在这里由两边 import。
 */
/** `noVisionModel`：用户没在 设置 → 模型 里绑看得懂图的模型 */
export type AiNamingErrorKey = 'noVisionModel'

/** 没绑视觉模型 */
export const NO_VISION_MODEL_ERROR_KEY: AiNamingErrorKey = 'noVisionModel'
