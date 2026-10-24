# 扩展原生 API

先阅读 [产品需求](requirements.md) 与 [现有适配](provider-coverage.md)。新增模型名称不等于新增能力：以服务商、端点、模型、地域与账户开放范围为单位记录事实。

## 新增一个操作

1. 在 `shared/providers/` 定义 `ProviderDef` 与 `OperationDef[]`，在 `shared/catalog.ts` 注册。模型记录开发方、模态、官方来源、日期和验证限制。
2. `build(ctx)` 生成原生 `NativeRequest`。只发送启用的参数，使用 `applyParams` / `applyRequestParams`；不要把 SDK 的 `extra_body` 放进原生 HTTP 请求。有实际参数冲突时抛出可读错误，不静默丢弃。
3. 复用合适的 `workbench`；媒体输入通过 `inputFields` 声明。普通对话、FIM、TTS、ASR、图像、视频、3D、Embedding、Rerank 已有输入与输出组件。新的专用输入应在 `web/lab/inputs.tsx` 增加，并提供匹配结果视图。
4. 为特殊响应在 `shared/protocols.ts` 增加 reducer 与相应 `ProtocolId`。保留原生字段、工具参数、思考签名和实际用量；不要用通用文本调用伪装非文本能力。
5. 在 `shared/presets.ts` 添加有意义的示例。必需用户提供的图片或录音保持空值并提示添加，不使用假链接、假生成结果。
6. 扩展 `scripts/check-native-adapters.ts` 的请求契约检查，需要新生命周期行为时补充隔离的后端检查；运行 `npm run check`。

## 媒体与生命周期

- JSON 媒体：`{ $asset: id, as: 'dataUrl' | 'base64' | 'remoteUrl' | 'anthropicSource' }` 由服务端解析。URL 引用没有本地字节；需要字节的接口必须拒绝此类素材，或明确完成下载流程。限制、格式、长度在服务端校验。
- Multipart：`bodyType: 'multipart'`，请求体为 `{ fields: {...}, files: { file: {$asset: id} } }`。需要同名多文件时，值可为素材引用数组。
- 同步产物：`artifacts(response)` 提取真实 URL / Base64 / hex；流式产物使用 `streamArtifacts(view)`。文件保存后通过同源资产接口查看，音视频支持 Range。
- 异步：`async` 定义任务 ID、状态映射、查询和产物提取。需要用 file_id 再换下载地址时使用 `resolve` / `resolveResults`。没有官方取消端点就不要编造；本地停止跟踪不代表远程停止计费。下载失败允许重新查询取回结果，不重新创建付费任务。
- 实时：中继保留二进制与 JSON 消息。当前专用工作台支持 OpenAI 类音频事件；`realtime.session(ctx)` 保留厂商会话结构及输入/输出采样率。新协议不能只改模型名套入旧 session。客户端等 `session.updated` 后才接受输入。

## 验证与费用

`documented` 只表示有官方依据；`tested` 必须有真实账户、模型、端点、日期与具体能力证据。一次对话成功不能自动验证全部模型、工具、Logprobs 或缓存行为。模拟服务器检查应与真实 API 验收分别列出。

没有可信定价或用量就显示未知。地域价格不同，不能把某地域数值当作全球价格。运行前的费用确认是防误操作措施，不是厂商账单硬限额。不要把真实付费验证放入默认检查命令。

## 数据与兼容

原始请求在服务端构建、鉴权、调用和脱敏。任何新增导出都应经过 `redactSensitive`；服务端还会擦除已知密钥字面值和请求覆盖凭据。普通 `logprobs.token` 与思考 `signature` 是协议数据，不能当作凭据一律删除。

实验的 `state` 保存模型、输入、素材引用与参数开关；新操作不要只保存最终文本。运行记录包含实际脱敏请求，历史恢复使用完整状态并保留 `parentId`；比较使用 `groupId`。旧记录可以缺少新字段，页面应给出可恢复的提示。
## 融合模块入口

Gemini 的原生协议归约器通过 `ProtocolId=gemini-generate` 接入，素材解析器支持 `geminiInlineData`，会话保留完整 parts 与签名。新增请求字段同时检查 UI 预览、服务端构建、历史和下一轮工具回传。

性能评测类型在 `shared/bench.ts`，API 生命周期在 `server/bench.ts`，界面在 `web/pages/benchmark.tsx`，保留的 Python 引擎及桥接在 `integrations/llm-bench/`。不要用前端循环近似替换引擎，也不要直接修改上游快照后仍宣称字节未改；扩展通过桥接适配，并用隔离回环服务验证。样本导入是惰性数据，不执行其中的指令或代码。费用确认、Token 上限、代理规则、目标核验、停止与重启恢复必须一起保持。
