# 厂商原生适配与验证边界

2026-10-24 融合版新增 [Gemini 原生内容与语音](gemini-coverage.md)，现为 11 个服务入口、24 个原生操作、25 个内置预设。Gemini 为 `documented`，没有继承其他版本的“已验证”声明。性能评测复用兼容协议连接，属于独立的真实性能引擎入口，不计入原生操作数量。

文档核对日期：**2026-10-22（北京时间）**。本文记录当前代码实现，不能代替账户实测。`documented` 表示已核对官方文档并完成请求构建/解析适配，**不表示真实 Key 调用成功**。只有下述具体操作/模型范围有历史文本调用证据；验证方法和待验收范围见 [验证说明](verification.md)，私人账户记录不随源码分发。

## 国内优先的原生切片

| 入口 / 模型 | 原生差异与实际实现 | 生命周期 / 产物 | 验证和限制 | 官方来源 |
|---|---|---|---|---|
| DeepSeek / 目录中模型 | thinking.type、reasoning_effort、工具推理回传、采样生效诊断、原生前缀、FIM、Token 概率；Beta 地址单独处理 | SSE / 文本、候选 Token | partial：deepseek-flash HTTP JSON/Logprobs、思考 SSE、FIM、前缀、重放实测成功；其他模型/工具未测 | [FIM](https://api-docs.deepseek.com/guides/fim_completion)、[前缀](https://api-docs.deepseek.com/guides/chat_prefix_completion) |
| MiniMax / 语音与文本 | M3.1 Flash reasoning_effort、M3 thinking.type、reasoning_split、max_completion_tokens；TTS 原生音色/格式/流式 | HTTP / SSE / 文本与音频 | 文本 partial：M3.1-Flash SSE 有历史成功证据；TTS documented，未付费实测 | [TTS](https://platform.minimax.io/docs/api-reference/speech-t2a-http) |
| `kimi.k3` / `kimi-k3` | `reasoning_effort` 的 low/high/max；始终思考；已有推理内容完整跨轮回传 | SSE / 推理、文本、工具 | documented；不能用 K2 的 thinking 开关；工具由使用者手动回填，不自动执行 | [Thinking models](https://platform.kimi.ai/docs/guide/use-thinking-models)、[Reasoning effort](https://platform.kimi.ai/docs/guide/use-reasoning-effort) |
| `kimi.k26` / `kimi-k2.6` | `thinking.type`、`thinking.keep=all` 与历史 `reasoning_content`；模型采样不伪装可调 | SSE / 推理、文本、工具 | partial：K2.6 非思考 HTTP/SSE 成功；跨轮推理/工具未实测。保留思考时不要删除模型实际返回的上下文 | [Thinking models](https://platform.kimi.ai/docs/guide/use-thinking-models) |
| `mimo.chat` / MiMo 2.6 Flash/Pro/Ultraspeed | `thinking.type`、`max_completion_tokens`；采样被覆盖时给明确诊断；不提供无效的强制 tool_choice | SSE / 推理、文本、工具 | partial：2.6 Flash 非思考 HTTP、思考 SSE 成功，其他模型未测；思考时 temperature/top_p 固定 1/0.95。2.5、2.5-pro 文本模型官方注明 10 月 21 日下线，已从默认模型移除 | [Chat API](https://mimo.mi.com/docs/en-US/api/chat)、[模型目录](https://mimo.mi.com/docs/en-US/quick-start/model) |
| `mimo.asr` / `mimo-v2.5-asr` | 专用 `input_audio` 数据块与 `asr_options.language`；实际语音转写，保留 seconds/audio_tokens | HTTP / 转写文本 | documented；WAV/MP3、本地文件字节、Base64 后不超 10 MB。独立 ASR 模型不属于已下线的 2.5 文本别名 | [ASR API](https://mimo.mi.com/docs/en-US/api/audio/Speech-Recognition) |
| `qwen.chat` / Qwen 3.8 Flash/Max、3.7 Plus、3.6 Plus | 原生 `enable_thinking` 与 `thinking_budget` 顶层字段；没有套入 SDK 专用 extra_body | SSE / 推理、文本、工具 | documented；地域/工作空间 Key 不通用；默认 Flash，提供关闭思考的 128-token 连通预设；Arrearage 表示账户状态问题 | [深度思考](https://help.aliyun.com/zh/model-studio/deep-thinking) |
| `qwen.realtime` / Qwen 3.8 Omni Flash Realtime | 原生单通道音频格式、Tina/longanlingxin 音色、声学/语义 VAD 与固定输入转写模型 | WebSocket / 16kHz 输入与24kHz输出 | documented；必须使用真实工作空间专属域名；不是 OpenAI GA 的 output_modalities/type/audio.input.turn_detection 字段 | [Realtime](https://help.aliyun.com/en/model-studio/realtime)、[客户端事件](https://help.aliyun.com/en/model-studio/client-events) |
| `qwen.image` / Qwen Image 3.0/Pro | DashScope 的 `input.messages[].content` 与 `parameters`；参考图片编辑、negative_prompt、seed、扩写方式和图像思考 | HTTP / 实际图片下载保存 | documented；最多 3 张参考图；编辑不能用 agent 扩写；图像思考要求开启扩写；不伪造蒙版。图片 URL 仅保留 24 小时 | [图像生成编辑 API](https://help.aliyun.com/en/model-studio/qwen-image-generation-and-editing-api-reference) |
| `ark.chat` / Doubao Seed 2.0 Pro/Lite | 原生 thinking.type、reasoning_effort；图像理解与模型/接入点区分 | SSE / 推理、文本、工具 | documented；需开通模型；ep- 接入点的具体版本由控制台决定。Seed 2.0 Pro 的采样固定，因此不显示无效采样旋钮 | [官方模型 API](https://api.volcengine.com/api-docs/view?action=DescribeBaasAIModels&serviceCode=aidap&version=2025-10-01)、[Chat API](https://docs.volcengine.com/docs/ark/chat-api?lang=en) |
| `minimax.video` / Hailuo 2.3 | 原生 `[Push in]` 运镜；可选首帧触发图生视频 | 异步 / 视频保存 | documented；1080P 仅 6 秒，768P 可 6/10 秒。停止本地追踪不等于取消远端计费 | [文生](https://platform.minimax.io/docs/api-reference/video-generation-t2v)、[图生](https://platform.minimax.io/docs/api-reference/video-generation-i2v) |
| `minimax.video-keyframes` / Hailuo 02 | 独立首尾帧接口组合；不把 02 的能力冒充为 2.3 支持 | 异步 / 视频保存 | documented；必须添加首帧、尾帧；未适配 H3 v2，不仅替换模型名 | [首尾帧](https://platform.minimax.io/docs/api-reference/video-generation-fl2v) |

MiniMax 视频采用三段原生流程：创建取得 task_id → [查询状态](https://platform.minimax.io/docs/api-reference/video-generation-query) → 使用 file_id [获取下载 URL](https://platform.minimax.io/docs/api-reference/video-generation-download)。任务数据落本地数据库，可刷新后继续追踪。官方该接口未要求 GroupId，视频适配没有附加猜测参数。

百炼新官方文档推荐工作空间专属域名，如 `https://实际WorkspaceId.cn-beijing.maas.aliyuncs.com`。目录保留旧公共域名作为可编辑起点；请按自己控制台填写实际 Base URL，不要把 `WorkspaceId` 占位文字发给服务器。聊天和图像分别使用 `/compatible-mode/v1/chat/completions`、`/api/v1/services/aigc/multimodal-generation/generation`。

**Qwen 3.8 Omni Realtime 明确要求工作空间专属域名**，不可仅用默认公共入口。音频交互前等待 `session.updated`；目前只适配真实单通道音频/文本，不将模型的多通道、视频、MCP 或声音复刻能力计入已实现清单。

## 国际服务与通用兜底

| 入口 | 已实现内容 | 官方依据与限制 |
|---|---|---|
| `openai.asr` / gpt-transcribe | 原生 multipart 文件上传到 `/v1/audio/transcriptions`，保留实际转写 JSON | [official OpenAI documentation](https://developers.openai.com/api/docs/guides/speech-to-text)。documented；25 MB 文件上限，支持格式以页面为准；没有套用弃用 Whisper 的时间戳参数 |
| `openai.realtime` / gpt-realtime-2.1 | 本地 WebSocket 中继、24kHz PCM 录放、VAD、打断、GA 嵌套音频配置、原始事件 | [Realtime WebSocket](https://developers.openai.com/api/docs/guides/voice-websockets?voice-api=realtime)、[client events](https://developers.openai.com/api/reference/resources/realtime/client-events)。documented；需要可访问地区和账户、麦克风授权；不是另一个 GPT-Live 协议 |
| `tripo.text-to-model` | 原生 V3 文本到 3D，控制几何/纹理种子、面数和 PBR，任务完成后下载 GLB 及预览图 | [Tripo 标准生成](https://developers.tripo3d.ai/en/docs/generation-text-to-model/standard)。documented；消耗账户积分，未进行付费 3D 验证 |
| 通用 OpenAI / Anthropic | 原有对话、补全、Embedding、Rerank、Messages 协议兜底 | 通用入口不意味着任意厂商都兼容；用户自己提供 Base URL 与模型，对方不支持的参数保留真实报错 |

当前未宣布 Gemini 原生 generateContent、Anthropic 官方专属思考新版本、Seedance、下一步编辑等已完成。它们仍是后续适配方向；“按能力探索”中的未接入条目不能被计入可运行覆盖。

## 费用说明

只记录从官方页面确认的价目；没有确认的媒体价格显示未知。价格不是实际账单，也不包含账户折扣、税费和跨区差异。

- Qwen 3.8 Flash：北京输入 **¥0.8 / 百万 Token**，输出 **¥2.7 / 百万 Token**（包含思考）；新加坡分别 **¥1.094 / ¥3.427**。来源：[官方价格表](https://help.aliyun.com/zh/model-studio/model-pricing)，2026-10-22 核对。由于一个连接可切换地域，模型元数据用文字列出区域差异，不把北京单价无条件应用到所有连接。
- Qwen Image 3.0 没有沿用旧 qwen-image-plus 的每图固定价。
- Qwen 3.8 Omni Flash Realtime 北京：每百万 Token 文本等输入 ¥1.5、音频输入 ¥6、文本输出 ¥4.5、音频输出 ¥12；输出文本与音频分别计费，同样来自上述官方价格表。这里只展示参考价，不把多模态 Token 简化成聊天总 Token 估价。
- 视频、语音、实时、3D 的价目与账户积分消耗尚待对应账户核验；不显示“0 元”代替未知。

## 验证如何复现

`npm run check:catalog` 检查目录引用、序列化与构建基本结构。`node --test scripts/check-native-adapters.ts` 检查 Kimi 两代推理契约、MiMo 采样语义/ASR、Qwen 原生字段和冲突、Hailuo 多阶段解析、OpenAI multipart 与 GA 实时会话。它们都不发送公网 API 请求。

有真实账户后，应逐项验证：鉴权与模型可见性 → 短输入/低用量 → 特有参数生效 → 原始事件与用量 → 产物保存 → 异步刷新恢复/失败诊断。媒体与实时使用需要另外获得对应付费验证授权，不能拿文本成功证明非文本能力已实测。

文本价格上界（2026-10-22 核对，元/百万 Token）：DeepSeek Flash 高峰未缓存输入 2 / 输出 8（空闲减半）；MiniMax 国内 M3.1-Flash 输入 1 / 输出 4；MiMo 国内 2.6 Flash 输入 1 / 输出 2；Kimi 国内 K2.6 未缓存输入 6.5 / 输出 27。仅用于本轮短文本预算估计，地区、服务档位、缓存和账户实际账单仍分别判断；官方来源见验证说明。
