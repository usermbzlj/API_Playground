# Gemini 原生能力与验收边界

2026-10-24 核对官方文档；没有使用真实 Key，也没有发起计费请求。模型和操作均标为 `documented`，没有继承其他源码中的 `live_verified` 声明。

## 已实现

- `gemini.chat` 使用原生 `generateContent` / `streamGenerateContent?alt=sse`，支持系统提示、上传图片、文本历史、原生工具声明和 JSON 输出参数。模型 ID 可手动填写。
- 解析实际返回的 `thought` 文本、`functionCall`、Token 概率、`groundingMetadata`、`usageMetadata`、安全反馈、结束原因和模型版本。没有返回时保持为空。额外候选和原生元数据可以检查。
- 工具回合保留完整 `content.parts`，包括 `thoughtSignature`。本地只收集手动工具返回，不自动执行函数，也不切换成另一个模型。原生 parts 与可编辑正文不同步时，界面应保留 parts 的完整性。
- `gemini.tts` 将实际朗读稿、`speechMetadata.style`、`speaker` 和声音配置分开发送；提供单人和双人预设。保存真实内联音频；WAV 原样保存，明确标为 PCM/L16 的音频才按 MIME 采样率封装 WAV。
- API Key 通过本地连接的 `x-goog-api-key` 注入；环境变量名称为 `GEMINI_API_KEY` / `GOOGLE_API_KEY`。图片通过本地素材引用解析为包含真实 MIME 和 Base64 的 `inlineData`，远程链接不能冒充上传数据。

## 与 PrismLab 源码的取舍

保留其原生 Google 内容生成、搜索接地、结构化输出与多人语音方向，接入现有的请求预览、运行记录、SSE、素材与产物保存流程。

源码 `server.ts` 把部分首 Token 时间计算为总时长固定比例，并构造概率、缓存命中和部分用量兜底；这些不构成真实厂商证据，因此没有迁入。普通生成也没有套用 Gemini 来模拟其他厂商的成功调用。没有直接照搬 `includeServerSideToolInvocations` 等在当前 REST 参考中未核实的字段。

## 官方依据

- [生成接口与原生 REST 字段](https://ai.google.dev/api/generate-content)：端点、Content/Part、SpeechMetadata、ThinkingConfig、FunctionCall/FunctionResponse、`responseFormat.text` / `responseFormat.audio`。
- [模型目录](https://ai.google.dev/gemini-api/docs/models)：预置 `gemini-3.8-flash`、`gemini-4-argon`、`gemini-3.8-flash-tts` 和 `gemini-3.8-flash-lite-tts`。目录不等于账户权限。
- [语音生成与迁移说明](https://ai.google.dev/gemini-api/docs/speech-generation)：3.8 系列将风格和说话人放入元数据；普通请求默认 WAV，明确请求 L16 时返回 PCM。按返回 MIME 处理，避免重复增加文件头。
- [思考与签名](https://ai.google.dev/gemini-api/docs/thinking)：摘要是否出现取决于实际响应，签名属于会话状态。当前文档优先展示 Interactions；本项目适配的是仍有独立 REST 参考的 generateContent。

## 自动验证与手工验收

`node --disable-warning=ExperimentalWarning --test scripts/test-gemini.ts` 使用确定性本地响应样本，覆盖请求体、禁用参数、公共协议入口、SSE/普通响应、真实字段缺失、安全反馈、签名和并行同名工具续传、多说话人配置、PCM/WAV 文件头及缺失语音错误；不进行网络调用。

亲测时添加 Gemini 连接，依次运行思考、工具、搜索、JSON、单人和双人语音预设。核对实际模型权限、引用、工具续聊、中文声音和 WAV 播放。搜索、思考与语音可能计费；价格没有在本项目核验，成本保持未知。

未声明完成：Vertex AI OAuth、Interactions、Live WebSocket、流式语音播放、声音设计/复刻、URI 产物授权下载、Google Embeddings、图像生成和视频生成。模型与工具组合的实际接受情况、地区和账户限制，以及真实网络响应，仍需真实 Key 验收。
