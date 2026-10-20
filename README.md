# API Playground · 多模态 AI API 游乐场

本地优先的 LLM / AI API 游乐场：低门槛接入国内外厂商，深入体验各家**原生特性**（FIM、前缀续写、Logprobs、TTS 情绪、实时语音、异步视频任务……），而不是一个换模型的聊天框。

## 快速开始

```bash
# 要求 Node >= 24（用到 node:sqlite；Node 22 需加 --experimental-sqlite）
npm install
npm run dev          # API 服务 :8787 + Web :5173（Vite HMR）
```

打开 http://localhost:5173 → 「连接」页添加第一个 API Key → 「探索」页选一个实验进入。

生产模式：`npm run build && npm start`（单端口 8787 同时服务 API 与静态页）。

其他命令：

| 命令 | 用途 |
| --- | --- |
| `npm run typecheck` | 全项目 TypeScript 检查 |
| `npm run check:catalog` | 厂商/操作/预设目录结构校验（CI 可用） |

## 数据与安全

- 所有数据在本地 `data/`：`playground.db`（SQLite：连接、实验记录、素材、异步任务）+ `secrets.json`（API Key，0600 权限）+ `assets/`（上传与生成的素材）。`data/` 已在 .gitignore 中。
- Key 只存 `secrets.json`，实验记录/日志/导出中自动脱敏（`***已隐藏***` + 字面量擦除）；实时 SSE 事件同样脱敏。
- 服务默认只绑定 `127.0.0.1`。API 三重本机校验：**Host 头**（容忍 IPv6）+ **Origin 白名单**（仅放行本 UI 端口，可用 `PLAYGROUND_ORIGINS=http://localhost:5173,...` 覆盖）+ **对端回环地址**（绑定 0.0.0.0 时防止 Host 伪造）。WebSocket 升级同样校验。
- 上传大小上限默认 100MB（`PLAYGROUND_MAX_UPLOAD` 字节数可调），超限返回 413。
- 原始请求调试台可以覆盖请求头（含 Authorization）——这是调试所需，请勿把调试用连接共享他人。
- Windows 上 chmod 0600 无效，`secrets.json` 依赖 NTFS 权限与「不分享 data/ 目录」保护。

## 运行环境说明

- `node:sqlite` 需要 Node 22.5+（实验特性，脚本已加 `--disable-warning=ExperimentalWarning`）；推荐 Node 24+。PATH 里的 `node` 若过旧，`npm run dev` 会报 `node:sqlite` 模块错误，换用更新的 Node 即可。
- 经主机名 / 局域网 IP 访问 UI 会被 Origin 白名单拦截（这是有意的防凭证滥用设计）；需要时设置 `PLAYGROUND_ORIGINS`。

## UI 回归工具

`tools/cdp_*.mjs`（来自 cdp-headless-web-check skill）可用无头 Edge 对本地页面做真实渲染校验：量尺寸、截图、捕获页面错误。例：

```bash
node tools/cdp_shot.mjs "http://localhost:5173/#/explore" "" shot.png 1920x1080
```

## 已接入清单（2026-10-21）

状态说明：**文档支持** = 依据官方文档定义、尚未用真实 Key 实测；**未验证** = 线索待确认。用真实 Key 跑通后应在定义里把 `verification.status` 改为 `tested` 并记录日期。

| 厂商 | 操作 | 亮点 | 状态 |
| --- | --- | --- | --- |
| DeepSeek | 对话（`deepseek.chat`） | 前缀续写（自动切 `/beta` 端点）、Logprobs、工具、结构化输出、缓存用量观察 | 文档支持 |
| DeepSeek | FIM 中间补全（`deepseek.fim`） | `/beta/completions`，prompt/suffix 分传，专属前后缀编辑器 | 文档支持 |
| MiniMax | 语音合成（`minimax.tts`） | t2a_v2：音色/语速/音调/情绪/音频参数，hex 音频自动保存为可播放产物，支持流式 | 文档支持 |
| MiniMax | 对话（`minimax.chat`） | chatcompletion_v2，国内/国际双端点 | 未验证 |

已实测通过的链路（冒烟测试，非厂商能力验证）：服务端按操作定义构建原生请求 → SSE 流式转发 → 401 等错误诊断 → 实验记录完整落库 → 密钥脱敏。

内置预设：FIM 补全 TS 函数、前缀续写强制 JSON、Reasoner 思考对比、TTS 有声书、TTS 同句双情绪。

## 页面导览

- **探索**：按厂商（模型表 + 实验入口）或按能力/玩法（20 个特性）浏览；每条能力标注验证状态与来源。
- **连接**：多 Key / 多 Base URL / 区域端点管理；一键测试（自动选择厂商无副作用探测接口）；拉取远程模型列表。
- **实验台**（`#/lab/<操作ID>`）：工作台输入 + 原生参数面板（勾选才发出）+ 运行/中止 + 结果/事件流/原生请求/原始响应/指标五个标签。
- **原始请求**：任意连接直接发原生 HTTP（路径限同域名，防密钥外泄），尝鲜未适配端点。
- **实验记录**：全部调用可回看、加星、写备注、再次运行。
- **异步任务**：后台轮询不丢（视频类任务的接入点，任务超 6 小时停止自动轮询并标注）。

## 架构

```
shared/            前后端同构定义（单一事实来源）
  types.ts         核心类型：ProviderDef / OperationDef / ParamSpec / AsyncSpec …
  catalog.ts       注册表 + getProvider/getOperation + catalogSnapshot()
  features.ts      能力目录（按特性浏览的数据源）
  providers/       每个厂商一个文件：ProviderDef + OperationDef[]
    _common.ts     对话操作构建器、通用参数（采样/工具/logprobs…）
server/            Hono + node:sqlite
  index.ts         REST/SSE 路由（含本机访问校验）
  execute.ts       执行引擎：SSE/JSON/二进制、事件追踪、诊断、产物抽取
  tasks.ts         异步任务轮询器（重启后自动恢复）
  ws.ts            WebSocket 中继（实时语音接入点）
  secrets.ts       密钥存储与脱敏
web/               React 19 + Tailwind 4 + hash 路由
  lab.tsx          实验台（工作台/参数面板/输出/Inspector）
  pages.tsx        连接/探索/记录/任务
  rawpage.tsx      原始请求调试台
```

**请求构建在服务端**：UI 只提交 `operationId + model + input + params`，由服务端调用同一份 `op.build()` 生成原生请求，保证「看到的参数」与「发出的请求」一致。

**扩展一个新厂商**（纵向切片约 200 行）：

1. `shared/providers/<vendor>.ts`：定义 `ProviderDef`（Base URL、鉴权、模型）与 `OperationDef[]`（params + build + 验证状态）。
2. `shared/catalog.ts` 注册两行 import。
3. `npm run check:catalog` 校验（含 build() 冒烟）。
4. 需要专属交互时在 `web/lab.tsx` 的 `WorkbenchInput`/`OutputPane` 加一个 workbench 分支；`server/execute.ts` 已支持 http/sse/二进制/异步任务，`server/ws.ts` 已支持 WebSocket。

## 已知限制 / 下一步

- 实时语音（WS 中继已就绪）、视频/3D 异步任务、Embedding/Rerank 工作台尚未接入厂商定义。
- 费用估算未内置（目录未收录可信定价）；`metrics.usage` 原样展示，不伪装精确成本。
- 「再次运行」复用输入与模型，参数回到默认值（参数未单独持久化）。
- MiniMax 模型名与情绪参数支持范围需真实 Key 验证；DeepSeek 旧模型别名（deepseek-chat/reasoner）可用性待实测。
- 需要真实 Key 才能继续验证的：全部 4 个操作的 `tested` 状态、MiniMax emotion、DeepSeek logprobs/缓存命中字段。

## 设计原则（来自需求文档）

原生优先、通用兜底；能力驱动而非名称驱动；原始与标准化并存；真实失败可解释；不过度工程化。**不要把厂商特色统一掉**——统一的是使用成本，不是能力。
