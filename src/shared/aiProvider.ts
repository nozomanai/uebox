/**
 * 本地直连 Provider 的**共享词汇表与 IPC 线格式**。
 *
 * 这里是主进程与渲染层的公共上游：`src/main/ai/types.ts` 从这里取基础类型
 * 再补上只有主进程才需要的部分（密钥引用、回落链）。方向不能反过来 ——
 * `tsconfig.web.json` 不含 `src/main/**`，shared 反向依赖 main 会让渲染层
 * 整个项目编不过。
 *
 * 主进程与渲染层看到的 provider 差别只有一处，但很关键：**明文密钥单向流动**。
 * 渲染层可以提交 `apiKeyValue`，但拿回来的永远只是 `hasKey: boolean`。
 */

/**
 * 厂商接口协议。
 *
 * 决定用哪个 AI SDK provider 去构造模型，而不是决定「哪家厂商」——
 * 同一家厂商可能同时提供多种协议（如 OpenAI 既有 completions 也有 responses），
 * 不同厂商也可能共用一种协议（绝大多数国产厂商都是 openai-completions）。
 */
export type ProviderProtocol =
  | 'openai-completions'
  | 'openai-responses'
  /**
   * ChatGPT 订阅账号背后的 Codex 后端（`chatgpt.com/backend-api/codex`）。
   *
   * 长得像 Responses，但不是同一个接口：它**必须**带上从令牌里解出来的
   * `chatgpt-account-id`，**只**接受流式（`stream: true`）且不允许落库
   * （`store: false`）。少任何一样都是一句没有正文的 400 Bad Request。
   * 所以它必须是独立的一档，不能复用 openai-responses。
   */
  | 'openai-codex-responses'
  /**
   * Cursor 订阅的 AgentService（`api2.cursor.sh` 上的 Connect / HTTP/2）。
   *
   * 不是 API Key，也不是 OpenAI 兼容接口：登录走 CLI 那条浏览器授权，
   * 对话必须带流式 protobuf。思考增量、工具调用都从这帧流里拆出来。
   * 不能复用上面任何一档。
   */
  | 'cursor-agent'
  | 'anthropic-messages'
  | 'google-generative-ai'

/**
 * 生图接口的形状。
 *
 * **「这个模型的请求长什么样」是数据，不是代码里的 if。** 这条是照着 pi-ai 学的：
 * 它每条模型都自带一个 `api` 字段，请求怎么发由那个字段决定。
 *
 * 反面教材就在手边：AI SDK 判断「哪些模型不接受 response_format」靠的是一份
 * 写死在请求构造函数里的名单，`gpt-image-2` 比那个版本新、不在名单里，
 * 于是参数照发、请求照死（400 Unknown parameter）。名单散在代码里必然过期，
 * 而过期时**不报错，只是行为变错**。
 *
 * 每个值对应的具体字段名见 `src/main/ai/imageGeneration.ts` 的 `IMAGE_API_SPECS`。
 * 加一家新厂商时，先看能不能复用现有的值；真的不一样再加一个 —— 加值要连着
 * 那张表一起加，不要回到「在代码里按模型名判断」。
 */
export type ImageApi =
  /** OpenAI 的 `/images/generations` 标准形状：`n` / `size` / `response_format` */
  | 'openai-images'
  /** 同上，但**不发** `response_format` —— gpt-image 全家永远回 base64，给了就 400 */
  | 'gpt-images'
  /** 同上，但**不发** `size` —— xAI 只认自己的比例参数，给了尺寸会被打回 */
  | 'grok-images'
  /** 硅基流动自成一套：`batch_size` / `image_size`，也不认 `response_format` */
  | 'siliconflow-images'
  /**
   * 火山方舟 Seedream：字段与 OpenAI 一样，但**只有 `/images/generations` 一个端点**。
   * 参考图内联在 `image` 字段里（data URI 或图片直链），没有 `/images/edits` 这回事 ——
   * 按 OpenAI 那套发 multipart 过去，方舟会回一个空 body 的 404。
   */
  | 'ark-images'
  /**
   * Google 的 Nano Banana，走 Interactions API：提示词和参考图同在一个 `input`
   * 数组里，尺寸是 `image_size` 档位 + `aspect_ratio`，密钥在 `x-goog-api-key`。
   * 与这里其余每一家的 `/images/generations` 没有一处相同。
   */
  | 'gemini-images'
  /**
   * Box Plan（`POST /images/generations`，见 Box Plan 协议 04-images）。
   *
   * 形状贴近 OpenAI，但参考图放 JSON 的 `image_urls`（https 链接或 data URI），不走
   * multipart、也不先上传；`size` 收 `1K`/`2K`/`4K` 档位或像素值，比例单给 `aspect_ratio`。
   * 慢的请求回 202 任务单，轮询 `GET /images/generations/{id}`，10 分钟内必定结束。
   * 只由套餐导入写进来，用户不会手选。
   */
  | 'uebox-images'
  /**
   * MiniMax：端点是 `POST /v1/image_generation`，**不是 `/images/generations`**，
   * 请求体里张数虽然也叫 `n`，尺寸却只有 `aspect_ratio` 八档或 `width`/`height`
   * （512–2048、8 的倍数、必须成对给，且 `aspect_ratio` 优先）。参考图放
   * `subject_reference`，一次只收一张、只认 `type: "character"`（保人物一致，
   * 不是通用重绘）。失败走 **HTTP 200 + `base_resp.status_code`**，不是 4xx。
   *
   * @see https://platform.minimax.io/docs/api-reference/image-generation-t2i
   */
  | 'minimax-images'
  /**
   * ChatGPT 订阅的 Codex 后端（`openai-codex-responses` 协议）。没有 `/images/*` 端点：
   * 出图是 Responses 里的 `image_generation` 工具，强制调用一次、从事件流里取图。
   * 模型 id 是**驱动工具的那个对话模型**，画图的模型由后端定。一次请求一张。
   */
  | 'codex-images'

/**
 * 结构化输出的能力档位。
 *
 * 同一个 `response_format` 字段，各家认的程度不一样，而认不认**不是可选行为，
 * 是硬规则**：DeepSeek 只认 `{ type: 'json_object' }`，给它 OpenAI 那套
 * `json_schema` 一律 400 `This response_format type is unavailable now`
 * （官方文档只列了 json_object 一种）。
 *
 * 所以这一位和 `ImageApi` 是同一个思路：**发什么是数据，不是代码里的 if**。
 * 差别在于降级的代价很小 —— 拿不到强约束时把 schema 写进提示词，模型照样能回
 * 可解析的 JSON，渲染层那边本来就是宽容解析。
 *
 * @see https://api-docs.deepseek.com/guides/json_mode
 */
export type StructuredOutputApi =
  /** OpenAI 的严格模式：`response_format: { type: 'json_schema', json_schema: {…} }` */
  | 'json-schema'
  /** 只认 `{ type: 'json_object' }`。**提示词里必须出现 “json” 这个词**，否则同样是 400 */
  | 'json-object'
  /** 完全不认这个字段，只能靠提示词要 JSON */
  | 'none'

/**
 * 向量化接口的形状。
 *
 * 和 `ImageApi` 同一个思路：**请求长什么样是数据，不是代码里的 if。**
 *
 * 好消息是这一类的分歧比生图小得多 —— `/embeddings` 是事实标准，
 * OpenAI、Ollama、LM Studio、硅基流动、百炼、智谱、Voyage 全都是同一个形状。
 * 真正的差异只有一处：**有没有「这段文本是文档还是查询」这个参数**。
 *
 * 那个参数不是可有可无的。Jina v3/v4 和 Voyage 用不同的向量空间分别编码文档与
 * 查询（非对称检索），漏了它检索质量会明显下降 —— 而且**不报错**，只是搜不准。
 */
export type EmbeddingApi =
  /** OpenAI 形状：`{ model, input: string[] }`，可选 `dimensions` */
  | 'openai-embeddings'
  /** 同上，另发 `task: 'retrieval.passage' | 'retrieval.query'`（Jina v3/v4） */
  | 'jina-embeddings'
  /** 同上，另发 `input_type: 'document' | 'query'`（Voyage、Cohere 兼容层） */
  | 'voyage-embeddings'

/**
 * 生成视频接口的形状。
 *
 * 与 3D 同属「异步任务式」，但**只有两段**：提交 → 轮询，视频地址就在轮询响应里，
 * 没有单独的取文件那一步。
 *
 * 好消息是这一类比 3D 收敛得多 —— 方舟和 MiniMax 的请求体几乎是同一个形状
 * （`model` + `content[]`，元素按 `type` 分 text / image_url，附一个 `role`），
 * 真正的差异只在端点路径、响应字段的层级、以及哪些参数是必填。
 *
 * ⚠️ 视频地址同样**有时效**：方舟 24 小时，MiniMax 的旧版是 9 小时。拿到就该落盘。
 */
export type VideoApi =
  /**
   * 火山方舟内容生成任务（Seedance）：`POST /contents/generations/tasks` 提交，
   * `GET /contents/generations/tasks/{id}` 轮询，地址在 `content.video_url`。
   *
   * 提交响应的任务号在**顶层 `id`**，状态是扁平的 `status`
   * （`queued` / `running` / `succeeded` / `failed`）。
   *
   * @see https://www.volcengine.com/docs/82379/1520757
   */
  | 'ark-video'
  /**
   * MiniMax v2：`POST /video_generation` 提交，
   * `GET /query/video_generation/{id}` 轮询，地址在 `task.content.url`。
   *
   * 与方舟的三处不同，每一处踩错都是一次失败：
   * 1. 提交响应的任务号叫 `task_id`，不是 `id`
   * 2. 轮询响应**多包一层 `task`**，状态在 `task.status`
   * 3. `resolution` 与 `duration` 是**必填**（方舟可以不给，用模型缺省）
   *
   * @see https://platform.minimax.io/docs/api-reference/video-generation-v2-create
   */
  | 'minimax-video'
  /**
   * Box Plan 的异步任务接口（`/tasks`，见 Box Plan 协议 05-tasks）。
   * 视频、3D、音乐共用一个客户端：`src/main/ai/creatorPlan/tasks.ts`。
   */
  | 'uebox-tasks'

/**
 * 生成 3D 网格接口的形状。
 *
 * 与视频同属异步任务式，但**是三段**（提交 → 轮询 → 取文件），因为 Rodin 的
 * 文件要单独再请求一次。另两家其实两段就够，适配器里 `files` 那一段是可选的。
 *
 * 这一类的分歧是所有模态里最大的：三家的端点、任务号、状态词、文件位置**没有
 * 一处相同**。所以它没有「猜一个通用值」的回落 —— 猜只会得到一串 404。
 */
export type Model3dApi =
  /**
   * Hyper3D Rodin：`POST /rodin`（multipart）提交，`POST /status` 轮询，
   * `POST /download` 取文件。提交响应里有**两个不能混用的 id** ——
   * `jobs.subscription_key` 给 status，顶层 `uuid` 给 download。
   *
   * @see https://docs.hyper3d.ai/en/get-started/quick-start
   */
  | 'rodin'
  /**
   * Tripo（VAST AI）：`POST /task` 提交，`GET /task/{id}` 轮询，
   * **文件就在轮询响应的 `data.output` 里**，没有第三段。
   *
   * @see https://docs.tripo3d.ai/get-started/quick-start.html
   */
  | 'tripo'
  /**
   * Meshy：与 Tripo 同构的两段式，但**端点按任务类型分叉**
   * （`/openapi/v1/text-to-3d` 与 `/openapi/v1/image-to-3d`），
   * 文件在轮询响应的 `model_urls` 里。
   *
   * @see https://docs.meshy.ai/en/api/image-to-3d
   */
  | 'meshy'
  /** Box Plan 的异步任务接口，与视频、音乐共用（见 VideoApi 同名值） */
  | 'uebox-tasks'

/** 豆包 Seeduplex 3.0 当前开放给实时对话使用的音色。 */
export const DOUBAO_REALTIME_VOICE_IDS = Object.freeze([
  'zh_female_vv_jupiter_bigtts',
  'zh_female_xiaohe_jupiter_bigtts',
  'zh_male_yunzhou_jupiter_bigtts',
  'zh_male_xiaotian_jupiter_bigtts'
] as const)

export type DoubaoRealtimeVoiceId = (typeof DOUBAO_REALTIME_VOICE_IDS)[number]

/** 老配置没有音色字段时的兼容默认值。 */
export const DOUBAO_DEFAULT_REALTIME_VOICE: DoubaoRealtimeVoiceId = 'zh_female_vv_jupiter_bigtts'

/** 主进程和设置页共用同一个判断，避免一边能选音色、另一边却走错适配器。 */
export function isDoubaoRealtimeBaseUrl(baseUrl: string): boolean {
  return /openspeech\.bytedance\.com/i.test(baseUrl)
}

/**
 * 从 Base URL 认出这是哪家 3D 厂商。
 *
 * 与生图那一位不同，3D 的接口形状**由厂商唯一决定**：同一个 Provider 下不可能
 * 有两种形状，因为 Rodin / Tripo / Meshy 是三家公司、三个域名。所以这一位其实
 * 是 Provider 级的信息，被放在模型上只是为了和 `imageApi` / `embeddingApi` 保持
 * 同一个位置。
 *
 * 既然它是 Provider 级的，就不该让用户在每个模型上再选一遍 —— 选错了
 * （在 Tripo 的 Provider 下选了 Meshy）是一串谁也看不懂的 404。这里按域名
 * 认出来自动填上，下拉框只留给自建网关和以后新加的厂商。
 *
 * 与 `isDoubaoRealtimeBaseUrl` 是同一个套路，就在上面几行。
 */
export function model3dApiFromBaseUrl(baseUrl: string): Model3dApi | undefined {
  if (/hyper3d\.com|hyper3d\.ai/i.test(baseUrl)) return 'rodin'
  if (/tripo3d\.ai/i.test(baseUrl)) return 'tripo'
  if (/meshy\.ai/i.test(baseUrl)) return 'meshy'
  return undefined
}

/** OpenAI Realtime 首批接入的高质量内置音色。 */
export const OPENAI_REALTIME_VOICE_IDS = Object.freeze(['marin', 'cedar'] as const)

export type OpenAiRealtimeVoiceId = (typeof OPENAI_REALTIME_VOICE_IDS)[number]

/** 老配置没有音色字段时，升级后默认使用 OpenAI 官方优先推荐的 Marin。 */
export const OPENAI_DEFAULT_REALTIME_VOICE: OpenAiRealtimeVoiceId = 'marin'

/**
 * 识别已经落盘、但还没有能力位的 OpenAI Realtime 模型。
 *
 * 这里只列真实接通过的型号，不用宽泛的 `gpt-realtime-*` 猜：翻译、转写等同前缀
 * 模型不一定能承担双向语音前台，把它们误放进角色下拉会到握手后才报错。
 */
export function isOpenAiRealtimeModelId(modelId: string): boolean {
  return modelId === 'gpt-realtime' || modelId === 'gpt-realtime-2.1'
}

/**
 * 这个 Provider 是用来干什么的。
 *
 * ## 为什么这一位在 Provider 上而不是模型上
 *
 * 在这之前，「这个模型是生图/向量化/3D/实时语音」是**模型上的一排复选框**，
 * 每加一种模态就要加一位 `supportsXxx`。那套做法有两个走不通的地方：
 *
 * 1. **它问了用户一个用户答不上来的问题。** 「接口协议」和「3D 接口」都是在问
 *    「这个端点长什么样」—— 那是关于厂商的事实，不是偏好。用户看着两个下拉框，
 *    不知道该填什么，填错了得到的是一串 404。
 * 2. **目录里早就不是这么组织的。** `siliconflow` 与 `siliconflow-image` 是两条
 *    记录、**同一个 baseUrl、同一个密钥入口**，区别只有「这条是拿来生图的」。
 *    方舟豆包与 Seedream 也一样。也就是说：真实的分界线一直画在 Provider 上，
 *    只是类型系统还停在模型上，两套模型互相打架。
 *
 * 所以现在：**一个 Provider = 一个地址 + 一套凭据 + 一种用途**。模型上只保留
 * 真正因模型而异的那几位（视觉、工具、推理）—— 那些确实是同一个 Provider 下
 * 不同模型不一样的东西。
 *
 * 代价是：一个网关同时代理对话+生图+语音时要添加多次。这正是目录现在已经在做的。
 */
export type ProviderKind =
  /** 对话 / 视觉 / 总结。**唯一需要 `protocol` 的一档** */
  | 'chat'
  | 'embedding'
  | 'image'
  | 'video'
  | 'model3d'
  /** 双向实时语音连接（常驻 WebSocket） */
  | 'realtime'
  | 'tts'
  /**
   * 语音识别。**只出文字，一个音都不出。**
   *
   * 它和 `realtime` 的区别不是「实时不实时」—— 豆包、百炼的识别和 `realtime` 一样
   * 是常驻 WebSocket、边说边出字（另有一类整段转写，见 `ai/stt/transcriptionStt.ts`）。
   * 区别是**会不会回话**：`realtime` 那一档的端点判停之后要生成
   * 回答（豆包全双工的上行事件表里根本没有关掉它的开关），而听写要的只有
   * 转写结果，模型一张嘴就全是多余的。
   *
   * 这一档存在之前，Spotlight 的听写是借 `realtime` 跑的（OpenAI 那家能用
   * `create_response: false` 把嘴堵上），代价是：绑豆包的用户按热键只能得到
   * 一句「这会儿用不了语音」，而豆包自己是有纯识别接口的，同一个域名、
   * 同一把密钥。
   */
  | 'stt'
  | 'music'
  /**
   * 音效。和音乐分开：接口不同（同步回音频字节，没有任务），而且没绑也能用 ——
   * 那时 Agent 用本机 FFmpeg 合成，见 sound-effects 技能。
   */
  | 'sfx'
  /**
   * 网页检索。
   *
   * 这一档里的「模型」不是模型 —— 是**去哪儿搜**（Jina 的搜索接口、
   * 自建的 SearXNG、内置的真浏览器）。放进同一套 Provider 体系是刻意的：
   * 用户配豆包生图、豆包视频、豆包语音时本来就是各配各的，检索没有理由
   * 单开一套只有它自己遵守的规矩。
   *
   * 代价是这一档里有条目没有 baseUrl 也没有密钥（内置浏览器就是）。
   * 那是真实情况，不是建模失误 —— 界面按 `requiresApiKey` 和空 baseUrl
   * 自然就不问了。
   */
  | 'search'
  /**
   * 结构化判定。**不生成文本，只回答带类型的问题。**
   *
   * 发一份 state 和一组问题，拿回每个问题的答案外加一个概率分布：
   * 是非题回 0~1，多选题回选中项 + 每项概率，评分题回档位 + 分布。
   * 代表实现是 TypeSafe 的 Jev（约 100ms、输入 $0.042/M、输出免费）。
   *
   * 它为什么不能塞进 `chat`：那一档的每条路径 —— pi 构造模型、
   * `completeText`、探测用的对话 ping、`/models` 拉取 —— 全都假设端点吃
   * messages 吐 token。这一档的端点收 `{ state, questions }` 吐
   * `{ answers }`，一条都对不上，混进去只会拿到一串 400。
   *
   * 它也不是 `embedding`：向量化返回的是坐标，怎么用由调用方决定；
   * 这一档返回的**就是结论本身**，代码拿到就能分支。
   */
  | 'judge'

/**
 * 内置浏览器检索。它不需要地址、不需要密钥，**也不需要用户添加** ——
 * 不进服务商列表、不进「添加服务商」目录，`search` 角色直接就能选它；
 * 角色绑定指向它时不要求 providers 里有这一条。
 */
export const BUILTIN_BROWSER_PROVIDER_ID = 'builtin-browser'

export const PROVIDER_KINDS: readonly ProviderKind[] = Object.freeze([
  'chat',
  'embedding',
  'image',
  'video',
  'model3d',
  'realtime',
  'tts',
  'stt',
  'music',
  'sfx',
  'search',
  'judge'
])

/** 这一档的请求形状由 Provider 唯一决定，界面上不该再问一遍模型 */
export function kindNeedsProtocol(kind: ProviderKind): boolean {
  return kind === 'chat'
}

export interface ModelConfig {
  /** 传给厂商的模型 ID，如 'gpt-4o'、'deepseek-chat' */
  id: string
  /** 界面展示名。缺省时直接显示 id */
  displayName?: string
  /** 是否支持图片输入。决定它能不能承担 vision 角色 */
  supportsVision?: boolean
  /** 是否支持视频输入。与图片能力独立，供视频分析入口筛选模型 */
  supportsVideo?: boolean
  /** 是否支持工具调用。Agent 与各专家都依赖它 */
  supportsTools?: boolean
  /**
   * 这个模型的生图请求走哪种形状。只在 Provider 的 `kind` 是 `image` 时有意义。
   *
   * **这一位留在模型上是有理由的**（而 3D / 视频那两位没有）：OpenAI 同一个
   * `/v1` 下面，`gpt-image-1` 不收 `response_format`、`dall-e-3` 收，
   * 是同一个 Provider 下的两种形状。3D 与视频不存在这种情况。
   *
   * 不填就按 Provider 的协议猜一个通用值（见 imageGeneration.ts 的 resolveImageApi）。
   */
  imageApi?: ImageApi
  /**
   * 这个向量化模型的请求走哪种形状。只在 `kind` 是 `embedding` 时有意义。
   *
   * 不填按 `openai-embeddings` 处理 —— 那是事实标准，绝大多数厂商开箱即用。
   */
  embeddingApi?: EmbeddingApi
  /**
   * 这个模型认哪一档结构化输出。对话类模型（chat / agent / summary）才有意义。
   *
   * 和 `imageApi` 一样留在模型上而不是 Provider 上：聚合网关的同一个 `/v1` 下面
   * 既有认 json_schema 的 OpenAI 系模型，也有只认 json_object 的 DeepSeek，
   * 那是同一个 Provider 下的两种能力。
   *
   * 不填就按厂商硬规则猜，猜错也只是多挨一次 400 —— 主进程会自动降一档重试，
   * 并把结果记住（见 structuredOutput.ts）。
   */
  structuredOutputApi?: StructuredOutputApi
  /**
   * 输出向量的维度。
   *
   * 两个用处：一是给支持降维的模型（OpenAI text-embedding-3、Jina v3/v4）
   * 显式发 `dimensions`，让同一个模型在不同机器上产出的向量维度一致；
   * 二是让界面能在换模型时提示「维度变了，旧向量要重建」。
   *
   * 不填就用厂商默认值，不发这个参数。
   */
  embeddingDimensions?: number
  /**
   * 是否是推理模型（会先思考再回答）。决定输入框里那个「思考程度」开关对它有没有用。
   *
   * 必须显式标注、不能靠猜：给一个不会思考的模型发思考预算，厂商多半直接回
   * 400；反过来漏标，用户调了思考程度却毫无变化，而且没有任何提示。
   */
  supportsReasoning?: boolean
  /**
   * 思考档位阶梯：把通用档位映射成这个模型实际认的值。
   *
   * 三种状态，缺一不可：
   * - **键不存在** —— 没说，按内核缺省行为处理
   * - **值为 `null`** —— 这一档**不存在**，界面上不列出来
   * - **值为字符串** —— 这一档存在，厂商管它叫这个名字（如 `medium` → `high`）
   *
   * 只在**覆盖**内置数据时才写。绝大多数模型走 pi 自带目录里的那份就够了，
   * 这里留空即可 —— 填了就是「我比内置数据更清楚」，会盖掉它。
   *
   * 给两种人用：pi 目录里没有的模型（自建网关、新出的型号），
   * 以及内置数据过期了、但用户等不及升级的情况。
   */
  thinkingLevelMap?: Record<string, string | null>
  /**
   * 这个模型走 Anthropic 的**自适应思考**（`thinking: {type: "adaptive"}` +
   * `output_config.effort`），而不是老式的思考预算（`budget_tokens`）。
   *
   * 只对 `anthropic-messages` 协议有意义，而且**必须标**：不标的话内核走预算那条路，
   * 而预算表只有 minimal/low/medium/high 四档，`xhigh` 和 `max` 会被就地夹成
   * high（pi 的 `clampReasoning`）。表现是界面上列了这两档、选了也不报错，
   * 但发出去的请求和 high 一模一样 —— 用户只会觉得「最高档没用」。
   *
   * 反过来错标也有代价：老型号（Opus 4.5、Haiku 4.5、Sonnet 4.5）不认
   * `output_config.effort`，发过去是一次 400。所以这一位按官方的
   * 「Effort 支持模型」清单逐个写，不按型号名猜。
   *
   * @see https://platform.claude.com/docs/en/build-with-claude/effort
   */
  adaptiveThinking?: boolean
  /**
   * 上下文窗口（token）。内置目录里的模型由 models.dev 提供，用户手填/导入的没有。
   *
   * 缺省时不猜大：这个数同时是**自动压缩的触发线**。写大了会一路喂到厂商
   * 返回 400 context length exceeded，任务在半途硬断；写小了只是压缩得比
   * 必要更早，历史进摘要，任务照跑。所以未知一律回落到保守缺省值。
   */
  contextWindow?: number
  /** 单次回复的最大输出 token。同样只影响估算与压缩留白，不填走缺省 */
  maxOutputTokens?: number
  /**
   * 官方标价，美元 / 百万 token。只有内置目录里的模型有（models.dev 提供），用户手填的没有。
   *
   * 只代表**直连官方端点**的价钱：经第三方网关、订阅套餐卖的同一个模型，价钱是另一回事。
   * 目前只给工作室招人时的简历用（`team/teamModels.ts` 的 `attachPrices`），那里会核对地址。
   */
  cost?: { input: number; output: number }
  /**
   * 实时语音模型使用的音色 ID。
   *
   * 这里保留 string 而不是封死成当前内置清单：models.json 允许用户直接编辑，
   * 厂商新增音色后不该非等客户端发版才能先用上。
   */
  realtimeVoice?: string
  /** Voice ID for Doubao TTS 2.0. */
  ttsVoice?: string
  /**
   * 语音合成单次最多送多少字。不填按 `MAX_SPEECH_CHARS`（600）。
   *
   * 目前只有 Box Plan 写它（清单 `tts.max_input_chars`，导入和刷新清单时更新）：
   * 渲染层按它切段，主进程按它拦。放在模型上而不是另查清单缓存，是因为渲染层只读得到这份配置。
   */
  ttsMaxInputChars?: number
  /**
   * 名字旁的小标签（如「Beta」）。目前只有 Box Plan 写它：清单 `models[].badge` 原样搬过来，
   * 界面原样显示，客户端不认识也不翻译 —— 标什么由服务端定。
   */
  badge?: string
  /** 一句话说明，界面放在悬停提示里。来源同 `badge` */
  description?: string
  /**
   * 这个模型只能绑到这几个角色。不写 = 不限（按来源用途过滤，见 `ROLE_KIND`）。
   *
   * 目前只有 Box Plan 写它（清单 `models[].roles`）：同一个对话来源下，可选的经济线
   * 可能只开放给部分角色，绑到别的角色网关会拒。
   */
  allowedRoles?: ModelRole[]
  /** 上游出错、流中断不扣费（清单 `models[].free_on_failure`）。主进程据此失败后自动重试一次 */
  freeOnFailure?: boolean
}

/** 这个模型能不能绑到这个角色。没写 `allowedRoles` 的不限 */
export function modelAllowsRole(
  model: Pick<ModelConfig, 'allowedRoles'> | undefined,
  role: ModelRole
): boolean {
  return !model?.allowedRoles || model.allowedRoles.includes(role)
}

/** 带标签的显示名：「Box-Music (Beta)」。界面上放不下小标签的地方（下拉框选中值、提示）用它 */
export function modelLabelWithBadge(name: string, badge: string | undefined): string {
  return badge ? `${name} (${badge})` : name
}

/**
 * 模型角色。
 *
 * 官方网关原本按 `level` + `agentType` 在服务端做模型路由；直连没有服务端，
 * 所以要由用户显式指定「哪件事用哪个模型」。角色而不是逐个功能绑定，
 * 是为了让用户配四项就能全线跑通，而不是给二十个功能各配一次。
 */
export type ModelRole =
  | 'chat'
  | 'agent'
  | 'vision'
  | 'summary'
  | 'embedding'
  | 'image'
  | 'video'
  | 'model3d'
  | 'realtime'
  | 'tts'
  /**
   * 听写走哪条路（全局热键 → Spotlight）。
   *
   * **绑了就优先走它**，哪怕「实时语音」也绑着：实时那一路要整条对话链路
   * 陪跑一遍才换回一句转写，贵、慢，而且只有 OpenAI 那家关得掉自动应答。
   * 不绑才回落到实时那一路，行为和这一档出现之前一模一样。
   */
  | 'stt'
  | 'music'
  /** 音效。不绑不是不能用：Agent 改用本机 FFmpeg 合成 */
  | 'sfx'
  /** 网页检索走哪条路。不绑就用内置的真浏览器 —— 社区版零配置就靠这条 */
  | 'search'
  /**
   * Agent 执行期的快速判定。
   *
   * **不绑等于不启用**，不是功能坏掉：每一处用到它的地方都保留着原来那条
   * 确定性规则，绑上只是把那条规则从「字面匹配」换成「带概率的判断」。
   * 这是社区版承诺（不依赖官方服务器、本机模型不出机器）与这档云端能力
   * 唯一能共存的形状。
   */
  | 'judge'

export const MODEL_ROLES: readonly ModelRole[] = Object.freeze([
  'chat',
  'agent',
  'vision',
  'summary',
  'embedding',
  'image',
  'video',
  'model3d',
  'realtime',
  'tts',
  'stt',
  'music',
  'sfx',
  'search',
  'judge'
])

/**
 * 角色 ↔ Provider 用途的对应。
 *
 * 只有对话那一组是多对一（chat / agent / vision / summary 都从 `chat` 类的
 * Provider 里选），其余都是一对一。角色候选按这张表过滤，**不再看模型上的
 * 能力位** —— 那些位已经删掉了。
 */
export const ROLE_KIND: Readonly<Record<ModelRole, ProviderKind>> = Object.freeze({
  chat: 'chat',
  agent: 'chat',
  vision: 'chat',
  summary: 'chat',
  embedding: 'embedding',
  image: 'image',
  video: 'video',
  model3d: 'model3d',
  realtime: 'realtime',
  tts: 'tts',
  stt: 'stt',
  music: 'music',
  sfx: 'sfx',
  search: 'search',
  judge: 'judge'
})

/**
 * 嵌入模型是另一类东西。
 *
 * 前五个角色都是对话模型，彼此可以互相顶替；`embedding` 走的是完全不同的
 * 接口（/embeddings 而不是 /chat/completions），返回向量而不是文本。
 * 所以它既不能回落到别的角色，别的角色也不能回落到它 —— 见 ROLE_FALLBACK。
 *
 * 界面上把它单独标出来，避免用户把对话模型绑上去。
 */
export function isEmbeddingRole(role: ModelRole): boolean {
  return role === 'embedding'
}

/**
 * 向量化模型的特征词兜底。
 *
 * 内置目录里的向量化模型带 `supportsEmbedding` 能力位，判定**优先看它**。
 * 但用户手填、或用「导入模型」从厂商 `/models` 拉进来的模型没有这一位 ——
 * 厂商的模型列表接口不返回「这是不是向量化模型」。对这部分只能按 id 里的
 * embed / bge / gte 之类特征词粗筛。
 *
 * 两处共用这一份词表，改一处即两边同步：
 * - 渲染层按它过滤「嵌入」角色的候选 —— 宁可少列，也别让对话模型混进来，
 *   绑错了不报错，只是知识库永远搜不到东西；
 * - 主进程的「测试连接」按它决定发对话 ping 还是 /embeddings ping ——
 *   拿向量化模型去打对话端点，厂商会原样拒绝，配置明明是对的却永远测不过。
 */
export const EMBEDDING_MODEL_HINT = /embed|bge|gte|e5-|text-embedding|jina|voyage/i

/** 模型 id 长得像不像向量化模型（没有显式能力位时的兜底判定） */
export function looksLikeEmbeddingModelId(modelId: string): boolean {
  return EMBEDDING_MODEL_HINT.test(modelId)
}

/** 指向某个 provider 下的某个模型 */
export interface ModelBinding {
  providerId: string
  modelId: string
  /**
   * 这条绑定由谁管。`'plan'` = Box Plan 导入时写的：重新导入会更新它、
   * 断开会清掉它。用户手动改绑定时不带这个字段，那个角色就自动脱离套餐。
   */
  source?: 'plan'
}

export type RoleBindings = Partial<Record<ModelRole, ModelBinding>>

/**
 * 改角色绑定只发改了的那几个：值为 null 表示清空。主进程在最新的配置上合并，
 * 不拿渲染层手里可能已经过期的整张表盖掉后台刚写的（套餐清单对账会改写角色）。
 */
export type RoleBindingsPatch = Partial<Record<ModelRole, ModelBinding | null>>

/**
 * 把渲染层发来的补丁洗干净：只认已知角色；绑定只留 providerId / modelId 两个字符串，
 * 别的（包括 `source: 'plan'` —— 用户手动改的绑定按规矩不带它）一律丢掉；形状不对的整条丢掉
 */
export function sanitizeRolePatch(raw: unknown): RoleBindingsPatch {
  const patch: RoleBindingsPatch = {}
  if (!raw || typeof raw !== 'object') return patch
  for (const [role, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!MODEL_ROLES.includes(role as ModelRole)) continue
    if (value === null) {
      patch[role as ModelRole] = null
      continue
    }
    const binding = value as { providerId?: unknown; modelId?: unknown } | undefined
    if (typeof binding?.providerId === 'string' && typeof binding.modelId === 'string') {
      patch[role as ModelRole] = { providerId: binding.providerId, modelId: binding.modelId }
    }
  }
  return patch
}

export function applyRolePatch(roles: RoleBindings, patch: RoleBindingsPatch): RoleBindings {
  const next: RoleBindings = { ...roles }
  for (const [role, binding] of Object.entries(patch) as [ModelRole, ModelBinding | null][]) {
    if (binding) next[role] = binding
    else delete next[role]
  }
  return next
}

/**
 * 补丁里哪些角色绑到了不许绑的模型：来源用途对不上角色（音乐来源绑「音效生成」），
 * 或模型写了 `allowedRoles` 而不含这个角色（见 `modelAllowsRole`）。
 * 界面上的下拉本来就不列它们，走到这里的是过期的界面或手改的请求
 */
export function disallowedRoles(source: RoleBindingSource, patch: RoleBindingsPatch): ModelRole[] {
  return (Object.entries(patch) as [ModelRole, ModelBinding | null][])
    .filter(([role, binding]) => {
      if (!binding) return false
      const provider = source.providers.find((item) => item.id === binding.providerId)
      if (provider?.kind && provider.kind !== ROLE_KIND[role]) return true
      const model = provider?.models.find((item) => item.id === binding.modelId)
      return !modelAllowsRole(model, role)
    })
    .map(([role]) => role)
}

/**
 * 补丁里要设上的角色，落盘之后哪些没留住（指向的来源或模型已经不在了，被归一化丢掉）。
 * 不报出来的话渲染层当成存上了，下拉框照样显示选中的，重开设置页才发现没了
 */
export function unsavedRoles(saved: RoleBindings, patch: RoleBindingsPatch): ModelRole[] {
  return (Object.entries(patch) as [ModelRole, ModelBinding | null][])
    .filter(([role, binding]) => {
      if (!binding) return false
      // 「Agent」已并进「对话」那一格（主进程 `ai/store.ts` 的 mergeMainModel），写进去的在 chat 上
      const stored = role === 'agent' ? (saved.agent ?? saved.chat) : saved[role]
      return stored?.providerId !== binding.providerId || stored?.modelId !== binding.modelId
    })
    .map(([role]) => role)
}

/**
 * 「谁来看这张图」的候选顺序。
 *
 * 「视觉」是**兜底**，不是收费站：主模型自己看得懂图（GPT-5、Claude、Gemini
 * 这些都行）就该直接用主模型 —— 用户是挑着它来干这件事的，为了一张截图把整轮
 * 对话换成另一个模型，工具调用能力和上下文全跟着变。只有主模型是纯文本模型时，
 * 才轮到这里配的视觉模型接手。
 *
 * 排在「视觉」之后的几个是最后一层保险：用户可能只在「轻量任务」上绑了个文本小模型、
 * 却在「Agent」上绑了个看得懂图的 —— 与其报「缺视觉模型」，不如用那个。
 */
export const VISION_FALLBACK_ROLES: readonly ModelRole[] = Object.freeze([
  'vision',
  'agent',
  'chat',
  'summary'
])

/**
 * 查能力位所需的最小形状。
 *
 * 主进程的 `AiProviderSettings` 与渲染层的 `{ providers: ProviderView[] }` 都天然满足它，
 * 于是同一份判定两边共用 —— 界面上「没配视觉会不会出事」的提示，和主进程真正
 * 选模型时的判断，不会各说各话。
 */
export interface RoleBindingSource {
  roles: RoleBindings
  /** `kind` 给了就按它查用途对不对得上角色（见 `disallowedRoles`） */
  providers: readonly { id: string; kind?: ProviderKind; models: readonly ModelConfig[] }[]
}

/** 这条绑定指向的模型声明了「看得懂图」吗。模型不在清单里（用户手改过配置）按不支持算 */
export function bindingSeesImages(source: RoleBindingSource, binding: ModelBinding): boolean {
  const provider = source.providers.find((item) => item.id === binding.providerId)
  return provider?.models.find((model) => model.id === binding.modelId)?.supportsVision === true
}

/**
 * 已绑的角色里，哪一个能看图。都不能则返回 null。
 *
 * 「视觉」这一档不查能力位：那是用户明确指给看图用的，界面上的下拉本来就只列
 * 支持图片输入的模型，走到这里再质疑一次只会把手改过配置的人挡在门外。
 */
export function findVisionCapableRole(source: RoleBindingSource): ModelRole | null {
  for (const role of VISION_FALLBACK_ROLES) {
    const binding = source.roles[role]
    if (!binding) continue
    if (role === 'vision' || bindingSeesImages(source, binding)) return role
  }
  return null
}

/**
 * 拼装通话的「脑子」：对话没单独选过模型时，从这几个角色里取第一个绑了的。
 *
 * 和主进程的 `ROLE_FALLBACK.agent` 是同一串（那边有测试盯着两份对不对得上）——
 * 也就是输入框里显示的那个默认模型。对话自己选过模型就用它，见 `cascadeDeps.resolveBrain`。
 */
export const VOICE_PIPELINE_BRAIN_ROLES: readonly ModelRole[] = Object.freeze(['agent', 'chat'])

/**
 * 没绑「实时语音」时，能不能拼一通电话出来：语音识别当耳朵、对话模型当脑子、
 * 语音合成当嘴。回缺的那几个角色（`chat` 代表对话模型那一组），配齐了回空数组。
 *
 * 主进程开通话、设置页决定「语音通话不可用」那一行要不要显示，用的是同一份判断 ——
 * 理由同 `findVisionCapableRole`：界面说能通、实际打不通（或者反过来）都很糟。
 *
 * `sttUsable` 给主进程用：识别那一路认不认得这个地址只有主进程知道。界面上不传，
 * 按认得算 —— 认不得的那种地址（陌生的 ws://）极少，开通话时会把原因说清楚。
 */
export function missingForVoicePipeline(
  source: {
    roles: RoleBindings
    providers: readonly { id: string; kind: ProviderKind; baseUrl: string }[]
  },
  sttUsable: (provider: { id: string; baseUrl: string }) => boolean = () => true
): ModelRole[] {
  const bound = (
    role: ModelRole
  ): { id: string; kind: ProviderKind; baseUrl: string } | undefined =>
    source.providers.find((item) => item.id === source.roles[role]?.providerId)
  const missing: ModelRole[] = []
  const stt = bound('stt')
  if (!stt || stt.kind !== 'stt' || !sttUsable(stt)) missing.push('stt')
  if (bound('tts')?.kind !== 'tts') missing.push('tts')
  if (!VOICE_PIPELINE_BRAIN_ROLES.some((role) => source.roles[role])) missing.push('chat')
  return missing
}

/**
 * Agent 此刻的默认模型。没单独绑 Agent 时内核沿用 chat 角色，这里给出同一个结果。
 *
 * 只留 providerId / modelId：`source: 'plan'` 是全局绑定的归属标记，
 * 抄进对话记录里没有意义。
 */
export function defaultAgentBinding(roles: RoleBindings): ModelBinding | null {
  const binding = roles.agent ?? roles.chat
  return binding ? { providerId: binding.providerId, modelId: binding.modelId } : null
}

/**
 * 对话钉住的模型还能不能用：来源还在、是对话类来源、模型还在它的清单里。
 *
 * 用户可能在设置页删了那个来源或模型，套餐重新导入也会换掉模型清单。
 * 用不了的时候由调用方退回全局默认，而不是拿一个已经不存在的模型硬打出去。
 */
export function isAgentBindingAvailable(
  source: {
    providers: readonly {
      id: string
      kind: ProviderKind
      models: readonly Pick<ModelConfig, 'id' | 'allowedRoles'>[]
    }[]
  },
  binding: ModelBinding
): boolean {
  const provider = source.providers.find((item) => item.id === binding.providerId)
  if (!provider || provider.kind !== ROLE_KIND.agent) return false
  const model = provider.models.find((item) => item.id === binding.modelId)
  return !!model && modelAllowsRole(model, 'agent')
}

/** 发给渲染层的 provider 形态：不含任何密钥内容 */
export interface ProviderView {
  id: string
  displayName: string
  /**
   * 从目录哪一条添加的。有值时用途（kind）跟着目录走、不许改：ElevenLabs 音乐和音效是
   * 两条目录，把音乐那条改成「音效」留下的是一个只有音乐模型的音效来源，调用必然被拒。
   * 要用同一家的另一种服务，从目录再添加那一条。手工新建的没有这一位，用途随便选
   */
  catalogId?: string
  /** 这个 Provider 是用来干什么的。决定它出现在哪些角色的候选里、界面显示哪些字段 */
  kind: ProviderKind
  /**
   * 3D / 视频的接口形状。**这两位在 Provider 上，而 `imageApi` 在模型上** ——
   * 区别是真实的：OpenAI 一个 `/v1` 下面 gpt-image-1 与 dall-e-3 是两种生图形状，
   * 而 3D 和视频不存在同一个 Provider 下两种形状的情况（各家是各家的域名）。
   */
  model3dApi?: Model3dApi
  videoApi?: VideoApi
  musicApi?: MusicApi
  protocol: ProviderProtocol
  baseUrl: string
  headers?: Record<string, string>
  imageUploadUrl?: string
  /** OpenAI-compatible gateways using aspect ratio size plus a resolution tier. */
  imageResolutionTiers?: boolean
  models: ModelConfig[]
  /**
   * 密钥来源。
   *
   * env / shell 存的是「怎么取」而不是密钥本身，不是机密，所以带着值回显 ——
   * 界面才能把它填回那个单一输入框。literal 只回 hasKey，明文永不回流。
   */
  apiKey:
    | { kind: 'none' }
    | { kind: 'env'; name: string; hasKey: boolean }
    | { kind: 'shell'; command: string; hasKey: boolean }
    | { kind: 'literal'; hasKey: boolean }
    /** 账号登录换来的令牌。令牌本身当然不回显，只说明是哪家登的 */
    | { kind: 'oauth'; provider: string; hasKey: boolean }
}

export interface SettingsView {
  providers: ProviderView[]
  /** 停用的来源。不在 providers 里，只给模型管理弹窗列出来 */
  disabledProviders?: ProviderView[]
  roles: RoleBindings
  /** models.json 的绝对路径，界面上显示给用户 */
  path: string
  /**
   * 系统是否提供安全存储。
   *
   * 为 false 时不能存明文密钥（credentials 会**拒绝落盘**而不是降级），
   * 界面要引导用户改用环境变量。
   */
  encryptionAvailable: boolean
  /** 是否至少有一个可用模型。为 false 时整个 AI 功能面都跑不起来 */
  configured: boolean
}

/**
 * 渲染层提交的 provider 草稿。
 *
 * 密钥是**单个输入框**，三种形态靠形状区分（与 pi-web 一致）：
 *   `!op read op://vault/openai/key`  → 执行命令取
 *   `OPENAI_API_KEY`                  → 读环境变量
 *   `sk-proj-...`                     → 密钥本身，加密存起来
 */
export interface ProviderDraft {
  id: string
  displayName: string
  /**
   * 从目录哪一条添加的。有值时用途（kind）跟着目录走、不许改：ElevenLabs 音乐和音效是
   * 两条目录，把音乐那条改成「音效」留下的是一个只有音乐模型的音效来源，调用必然被拒。
   * 要用同一家的另一种服务，从目录再添加那一条。手工新建的没有这一位，用途随便选
   */
  catalogId?: string
  /** 这个 Provider 是用来干什么的。决定它出现在哪些角色的候选里、界面显示哪些字段 */
  kind: ProviderKind
  /**
   * 3D / 视频的接口形状。**这两位在 Provider 上，而 `imageApi` 在模型上** ——
   * 区别是真实的：OpenAI 一个 `/v1` 下面 gpt-image-1 与 dall-e-3 是两种生图形状，
   * 而 3D 和视频不存在同一个 Provider 下两种形状的情况（各家是各家的域名）。
   */
  model3dApi?: Model3dApi
  videoApi?: VideoApi
  musicApi?: MusicApi
  protocol: ProviderProtocol
  baseUrl: string
  headers?: Record<string, string>
  imageUploadUrl?: string
  imageResolutionTiers?: boolean
  models: ModelConfig[]
  /**
   * 密钥输入框的原文。只在「渲染层 → 主进程」这一个方向出现。
   *
   * 留空的含义**取决于原来是哪一档**：
   * - 原来是 literal：留空 = 沿用已存的那个。明文读不回界面，若把留空当成
   *   清空，用户改个 Base URL 就会把密钥弄丢
   * - 其余情况：留空 = 确实不要密钥。env / shell 会原样回显到框里，
   *   用户是看着它删掉的，那就是真的想删
   */
  apiKeyInput?: string
}

/**
 * 目录里的分组。决定「添加 Provider」弹窗里的排列顺序。
 *
 * **只剩「从哪儿买算力」这一个轴**。以前它还混着 image / embedding / model3d /
 * realtime 这几个按**能力**分的组 —— 一个枚举里两种分类标准，正是那套
 * 「模态既在 Provider 上又在模型上」的设计债留下的化石。
 *
 * 现在能力那一轴由 `ProviderKind` 表达，弹窗里的模态分区直接按 kind 出，
 * 加一种模态（比如视频）不用再回来改这个枚举 —— 那一步以前漏过一次：
 * 向量化整组 7 家 20 个模型全在目录里，界面上一个都找不到。
 */
export type CatalogGroup = 'local' | 'subscription' | 'gateway' | 'cloud' | 'cn'

/**
 * 运行期能枚举的那份，供界面侧的白名单守门测试核对。
 *
 * 写成 `Record<CatalogGroup, true>` 再取 key，是为了让「类型加了成员、这份清单
 * 忘了加」**直接编译不过**。写成字面量数组的话两边会悄悄分家 —— 而这份清单
 * 正是用来防「一整组厂商在界面上消失且不报错」的，它自己先漏了就全盘落空。
 */
const CATALOG_GROUP_TABLE: Readonly<Record<CatalogGroup, true>> = Object.freeze({
  cn: true,
  cloud: true,
  subscription: true,
  local: true,
  gateway: true
})

export const CATALOG_GROUPS: readonly CatalogGroup[] = Object.freeze(
  Object.keys(CATALOG_GROUP_TABLE) as CatalogGroup[]
)

/** 内置厂商目录条目 */
export interface CatalogEntry {
  id: string
  displayName: string
  /** 这个 Provider 是用来干什么的。决定它出现在哪些角色的候选里、界面显示哪些字段 */
  kind: ProviderKind
  /**
   * 3D / 视频的接口形状。**这两位在 Provider 上，而 `imageApi` 在模型上** ——
   * 区别是真实的：OpenAI 一个 `/v1` 下面 gpt-image-1 与 dall-e-3 是两种生图形状，
   * 而 3D 和视频不存在同一个 Provider 下两种形状的情况（各家是各家的域名）。
   */
  model3dApi?: Model3dApi
  videoApi?: VideoApi
  musicApi?: MusicApi
  protocol: ProviderProtocol
  /**
   * 厂商 API 根地址。
   *
   * 可以为空：Bedrock / Azure / Vertex 这类地址里带账号或区域，没有通用值，
   * 必须由用户自己填。
   */
  baseUrl: string
  group?: CatalogGroup
  /** 官网/控制台地址，界面上给一个「去哪拿 Key」的入口 */
  apiKeyUrl?: string
  /** 本地推理（Ollama、LM Studio）不需要密钥 */
  requiresApiKey: boolean
  /** 环境变量名约定，作为密钥输入框的默认值填入 */
  defaultEnvVar?: string
  /** 是否有随包的品牌图标（src/renderer/src/assets/provider-logos/<id>.svg） */
  hasLogo?: boolean
  /**
   * 支持用账号登录换密钥，不必手工去控制台复制。
   *
   * 只标注**官方文档支持第三方应用**的那些。复用官方客户端 client_id、
   * 打内部接口那种做法不在此列。
   */
  supportsOAuth?: boolean
  /**
   * 登录用哪一家的账号（`oauth.ts` 的 OAUTH_PROVIDERS 键）。不填就是本条的 id。
   *
   * 「Codex 生图」与「Codex」对话是同一个 ChatGPT 账号：填 `chatgpt` 之后，
   * 已经登录过的用户添加生图来源时直接沿用那份登录，不用再走一遍授权。
   */
  oauthProvider?: string
  models: ModelConfig[]
}

/** 统一的 IPC 结果信封 */
export type AiProviderResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * 「测试连接 / 导入模型」失败的归类。
 *
 * ## 为什么是码而不是成品文案
 *
 * 主进程原来直接返回写好的中文（`main/ai/probe.ts`）。于是英文用户在设置页点
 * 「测试连接」，拿到的是一整句中文 —— 而这恰恰是他最需要读懂的一句话：
 * 密钥对不对、地址通不通、协议选没选错，全看它。
 *
 * 现在主进程只判「是哪一种」，措辞归渲染层（`AIProviders/probeCopy.ts` 查
 * `aiProvider.probe.*`）。这是 AGENTS 里「主进程只回错误码 + 参数，渲染层查 i18n」
 * 那条的第一处落地。
 */
export type ProbeErrorCode =
  | 'timeout'
  | 'unauthorized'
  | 'forbidden'
  | 'providerServerError'
  | 'modelNotFound'
  | 'rateLimited'
  | 'badRequest'
  /** 当前协议下被拒，换成 `suggestedProtocol` 就通了（换着发试出来的，不是读报错猜的） */
  | 'protocolMismatch'
  /** 带工具就被拒、不带就通：这个模型或网关不接受工具调用，当不了智能体 */
  | 'toolsRejected'
  | 'unreachable'
  /** 没归上类。原文照带，猜错了反而掩盖真实原因 */
  | 'unknown'
  // ↓ 只在「拉取模型列表」这条路上出现
  /** 3D / 视频厂商压根没有列模型这回事 */
  | 'listUnsupportedGenerative'
  /** 该协议没有通用的 /models */
  | 'listUnsupportedProtocol'
  /** ChatGPT 订阅只有 /responses 一个端点 */
  | 'listUnsupportedCodex'
  /** Cursor 订阅没有 /models，型号用内置清单或手填 */
  | 'listUnsupportedCursor'
  /** /models 回了非 2xx，`raw` 是状态码 */
  | 'listHttpError'
  /** 接通了，但厂商回了个空列表 */
  | 'listEmpty'
  /** 界面上压根没有草稿可测。渲染层自己产生，不来自主进程 */
  | 'noDraft'

/** 跳过探测的理由。同样只回码 */
export type ProbeSkipCode =
  | 'generativeNoCheapCall'
  /** 实时语音、网页检索：端点不吃对话请求，拿 ping 去测只会得到一句误导人的「模型不存在」 */
  | 'noChatEndpoint'

export interface ProbeFailure {
  code: ProbeErrorCode
  /**
   * 厂商原文（已截断）。
   *
   * 只有那几种「翻译过去还是说不清、必须让用户看见原话」的分支才带：
   * 5xx 的服务端错误码、400 / 403 的拒绝理由、以及没归上类的。
   */
  raw?: string
  /** `protocolMismatch` 时：换成哪个协议试通了 */
  suggestedProtocol?: ProviderProtocol
}

/**
 * 通了，但有一项用不了。界面显示成提示而不是绿勾。
 * - `thinkingRejected`：带思考档位被拒、不带就通 ——「自动」能用，开思考会 400
 */
export type ProbeCaveat = 'thinkingRejected'

export type ListModelsResult =
  | { ok: true; models: ModelConfig[] }
  | { ok: false; error: ProbeFailure }

/**
 * `skipped` 有值时表示**根本没发请求**，`ok` 只说明配置形状没问题。
 *
 * 3D 生成走这一档：那类接口只有「提交一次生成」这一个入口，探测一次就扣钱。
 * 界面必须把这句话显示出来 —— 显示成普通的「测试通过」会让用户以为密钥已经
 * 验过了，而实际上第一次真生成才知道对不对。
 */
export type TestProviderResult =
  | { ok: true; skipped?: ProbeSkipCode; caveat?: ProbeCaveat }
  | { ok: false; error: ProbeFailure }

/** Music providers have distinct request and task formats. */
export type MusicApi =
  | 'elevenlabs-music'
  | 'mureka-music'
  | 'sunoapi-music'
  /** Box Plan 的异步任务接口，与视频、3D 共用（见 VideoApi 同名值） */
  | 'uebox-tasks'
