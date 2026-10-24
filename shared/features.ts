import type { FeatureDef } from './types.ts';

// Capabilities / play styles. Operations reference these ids; a feature with no operation
// yet is still listed so the explore page shows what is worth adapting next.
export const FEATURES: FeatureDef[] = [
  // ---- text
  {
    id: 'chat',
    name: '原生对话 / 流式生成',
    category: 'text',
    summary: '用各家原生参数进行多轮对话，逐块观察流式返回、用量与厂商特有字段。',
    useCases: ['快速试新模型', '观察流式分块节奏与首 Token 延迟', '对比同一提示词在不同厂商的表现'],
  },
  {
    id: 'prefix',
    name: '对话前缀续写 / Partial Mode',
    category: 'text',
    summary: '预先写好 Assistant 回复的开头，强制模型从这里接着写，用于控制格式、角色和语气。',
    useCases: ['强制以代码块或 JSON 开头', '让角色保持口吻', '从半截内容继续生成'],
    tips: [
      '各家写法不同：DeepSeek 用 prefix: true（Beta 端点），Kimi / 百炼用 partial: true，Anthropic 协议直接预填 assistant 消息。',
    ],
  },
  {
    id: 'logprobs',
    name: 'Token 概率（Token 显微镜）',
    category: 'text',
    summary: '返回每个输出 Token 的对数概率及候选 Token，直观看到模型「犹豫」的位置。',
    useCases: ['观察置信度热力图', '比较不同温度下的候选分布', '定位幻觉发生的位置'],
    tips: ['思考模型通常不返回 logprobs；部分兼容端点会静默忽略该参数。'],
  },
  {
    id: 'json-output',
    name: '结构化输出 / JSON',
    category: 'text',
    summary: '让模型按 JSON 或指定 Schema 输出，观察各家约束能力的强弱。',
    useCases: ['信息抽取', '表单生成', '对比 json_object 与 json_schema'],
  },
  {
    id: 'cache',
    name: '上下文缓存',
    category: 'text',
    summary: '重复的长前缀命中缓存后，查看命中 Token 数与费用节省；部分厂商需要显式创建缓存。',
    useCases: ['长文档多轮问答', '对比首轮与次轮的命中 Token 与延迟'],
    compareNotes: '缓存通常需要前缀完全一致且超过最小长度；第一次请求不会命中。',
  },
  {
    id: 'long-context',
    name: '长上下文 / 文件问答',
    category: 'text',
    summary: '上传长文档或文件，直接基于全文问答，观察长上下文的召回能力与费用。',
    useCases: ['整本书问答', '合同条款定位'],
  },
  {
    id: 'translate',
    name: '专用翻译模型',
    category: 'text',
    summary: '使用厂商的专用翻译模型与原生翻译参数（术语表、领域提示、翻译记忆）。',
    useCases: ['术语干预', '领域风格翻译'],
  },
  {
    id: 'anthropic-compat',
    name: '跨协议对照（OpenAI ↔ Anthropic）',
    category: 'meta',
    summary: '同一模型经厂商提供的 OpenAI 兼容端点与 Anthropic 兼容端点调用，观察思考、工具、缓存等行为是否一致。',
    useCases: ['同模型不同协议的参数差异', 'Claude Code 类工具接入前的验证'],
  },
  // ---- code
  {
    id: 'fim',
    name: 'FIM 中间补全',
    category: 'code',
    summary: '给出代码前缀和后缀，让模型只补出中间缺失的部分，是代码补全插件的底层机制。',
    useCases: ['补全函数体', '在两段代码之间插入逻辑', '对比 FIM 与普通续写的效果'],
  },
  {
    id: 'next-edit',
    name: '下一步编辑预测 / Apply Edit',
    category: 'code',
    summary: '根据最近的编辑历史预测下一处修改，或把修改建议应用到原文件。',
    useCases: ['光标附近的连续重构', '把对话里的代码片段合并回文件'],
  },
  {
    id: 'predicted-output',
    name: '预测输出（Predicted Outputs）',
    category: 'code',
    summary: '提供大部分不会变的原文作为预测，显著降低改写类任务的延迟。',
    useCases: ['小改动的大文件重写'],
  },
  // ---- reasoning
  {
    id: 'reasoning',
    name: '思考模式与推理控制',
    category: 'reasoning',
    summary: '开关思考、设置推理预算或强度，查看推理内容如何返回，验证预算参数是否真的生效。',
    useCases: ['同一题目对比开 / 关思考', '观察推理 Token 占比与首字延迟', '思考预算扫描'],
    tips: ['不同厂商的开关参数名与语义不同；本项目保留各家原生写法，不做强行统一。'],
    compareNotes: '对比时固定题目与 max_tokens；思考 Token 是否计入 max_tokens 各家不同。',
  },
  {
    id: 'reasoning-history',
    name: '跨轮推理上下文',
    category: 'reasoning',
    summary: '多轮对话（尤其是工具调用中）是否需要、是否允许回传上一轮的思考内容，以及回传后的行为差异。',
    useCases: ['工具调用中的连续思考', '验证厂商对 reasoning_content 回传的要求'],
  },
  // ---- tools
  {
    id: 'tools',
    name: '工具调用',
    category: 'tools',
    summary: '声明函数，观察模型的工具选择、参数生成，手动填写工具结果并继续多轮。',
    useCases: ['观察并行调用', '流式工具参数', '严格 Schema 模式'],
  },
  {
    id: 'builtin-search',
    name: '原生联网搜索',
    category: 'tools',
    summary: '使用厂商内置的联网搜索工具或参数，查看引用来源与搜索过程如何返回。',
    useCases: ['时效性问答', '对比各家搜索结果的引用格式'],
  },
  {
    id: 'builtin-tools',
    name: '厂商内置工具 / 官方工具生态',
    category: 'tools',
    summary: '由厂商服务端执行的工具（代码执行、网页抓取、官方插件等），观察工具调用与结果的事件序列。',
    useCases: ['Agent 工具发现过程', '服务端工具与客户端工具混用'],
  },
  {
    id: 'mcp',
    name: 'MCP / 远程工具',
    category: 'tools',
    summary: '在请求里直接挂载远程 MCP 服务器，由厂商代为发现并调用工具。',
    useCases: ['零代码接入外部工具'],
  },
  {
    id: 'gui-agent',
    name: 'GUI 操作 / 电脑使用',
    category: 'tools',
    summary: '输入屏幕截图，让模型输出点击、输入等界面操作。只做预测与可视化，不在本机执行任何动作。',
    useCases: ['截图上的元素定位', '操作序列规划'],
    tips: ['真实执行界面操作存在副作用，本项目仅展示模型给出的动作。'],
  },
  {
    id: 'deep-research',
    name: '深度研究',
    category: 'tools',
    summary: '厂商托管的多步检索与报告生成，观察阶段性事件与引用。',
    useCases: ['行业调研报告'],
  },
  // ---- vision
  {
    id: 'vision',
    name: '图像理解',
    category: 'vision',
    summary: '上传图片让模型分析，包括图表、截图与细粒度定位。',
    useCases: ['截图问答', '图表解读', '定位框输出'],
  },
  {
    id: 'video-understanding',
    name: '视频理解',
    category: 'vision',
    summary: '上传视频或帧序列，观察抽帧参数（fps 等）对理解与费用的影响。',
    useCases: ['视频摘要', '时间点定位'],
  },
  {
    id: 'ocr',
    name: 'OCR / 文档解析',
    category: 'vision',
    summary: '专用 OCR 与版面解析模型：表格、公式、多栏文档转结构化文本。',
    useCases: ['扫描件转 Markdown', '票据字段抽取'],
  },
  // ---- image
  {
    id: 'image-gen',
    name: '文生图',
    category: 'image',
    summary: '根据文字生成图片，探索尺寸、种子、提示词扩写、组图等原生参数。',
    useCases: ['固定种子对比提示词', '组图生成', '同提示词跨厂商对比'],
  },
  {
    id: 'image-edit',
    name: '图像编辑 / 参考图生成',
    category: 'image',
    summary: '基于参考图做局部编辑、风格迁移、多图融合与主体一致性生成。',
    useCases: ['换背景', '多图参考一致性', '指令式编辑'],
  },
  // ---- audio
  {
    id: 'tts',
    name: '语音合成 TTS',
    category: 'audio',
    summary: '把文字变成语音，调节音色、语速、音调和情绪，比较各家的表现力。',
    useCases: ['同一句台词换不同情绪', '有声书片段', '发音与多音字控制'],
  },
  {
    id: 'tts-stream',
    name: '流式语音 / 首包延迟',
    category: 'audio',
    summary: '流式返回音频分片，测量首包延迟与分片节奏。',
    useCases: ['对话场景的低延迟播报'],
  },
  {
    id: 'voice-design',
    name: '声音设计 / 音色复刻',
    category: 'audio',
    summary: '用文字描述生成新音色，或在获得授权的前提下根据样本复刻音色。',
    useCases: ['给角色设计专属声音', '用自己的声音朗读（需授权）'],
    tips: ['复刻他人声音必须取得本人授权，并遵守厂商规则。'],
  },
  {
    id: 'asr',
    name: '语音识别 ASR',
    category: 'audio',
    summary: '音频转文字，观察时间戳、说话人、标点与语言识别能力。',
    useCases: ['会议录音转写', '字幕对齐'],
  },
  {
    id: 'music',
    name: '音乐 / 音效生成',
    category: 'audio',
    summary: '根据描述或歌词生成音乐与音效。',
    useCases: ['短视频配乐', '游戏音效'],
  },
  // ---- realtime
  {
    id: 'realtime-voice',
    name: '实时双向语音',
    category: 'realtime',
    summary: '通过 WebSocket 与模型实时语音对话，测试打断、VAD 与端到端延迟。',
    useCases: ['抢话 / 打断测试', '测首包音频延迟', '观察事件序列'],
    compareNotes: '延迟受网络与 VAD 静音阈值影响很大，对比时保持同样的说话节奏与静音设置。',
  },
  // ---- video
  {
    id: 'video-gen',
    name: '文生视频 / 图生视频',
    category: 'video',
    summary: '以异步任务提交视频生成，后台持续跟踪进度，刷新页面不丢失。',
    useCases: ['同一参考图不同运镜', '对比各家视频质量与耗时'],
    tips: ['视频生成通常较贵，提交前会显示费用提示并要求确认。'],
  },
  {
    id: 'video-keyframes',
    name: '首尾帧 / 多参考视频',
    category: 'video',
    summary: '指定首帧、尾帧或多张参考图（主体一致性），控制视频的起止与角色外观。',
    useCases: ['首尾帧过渡动画', '角色一致的多镜头'],
  },
  {
    id: 'video-edit',
    name: '视频编辑 / 延长 / 特效',
    category: 'video',
    summary: '对已有视频做延长、局部编辑、对口型或套用特效模板。',
    useCases: ['续写镜头', '特效模板'],
  },
  // ---- 3d
  {
    id: 'model3d',
    name: '3D 生成',
    category: '3d',
    summary: '文本或图片生成 3D 模型，预览网格与贴图，进一步做绑骨与动画。',
    useCases: ['道具建模', '角色绑骨动画'],
  },
  // ---- embedding
  {
    id: 'embedding',
    name: 'Embedding 向量',
    category: 'embedding',
    summary: '把文本转为向量，查看维度与两两相似度矩阵。',
    useCases: ['相似度矩阵', '比较不同模型的语义区分度', '可变维度对效果的影响'],
  },
  {
    id: 'rerank',
    name: 'Rerank 重排序',
    category: 'embedding',
    summary: '给定查询和候选文档，让模型按相关性重新排序。',
    useCases: ['RAG 召回后重排', '比较不同 rerank 模型的排序差异'],
  },
  // ---- meta
  {
    id: 'routing',
    name: '路由与多提供方',
    category: 'meta',
    summary: '同一模型经不同提供方或路由策略调用，比较价格、速度与参数支持。',
    useCases: ['按价格 / 吞吐 / 延迟排序路由', '查看实际服务的提供方与真实成本'],
  },
  {
    id: 'model-discovery',
    name: '模型目录与能力发现',
    category: 'meta',
    summary: '读取厂商的模型列表与元数据接口，发现新模型、对照本项目目录中的能力标注。',
    useCases: ['新模型上线提醒', '按能力筛选模型'],
  },
  {
    id: 'raw',
    name: '自定义原始请求',
    category: 'meta',
    summary: '对任意已配置连接直接编写原生请求，尝鲜尚未适配的端点或参数；可保存为模板。',
    useCases: ['试新发布的接口', '调试厂商特殊字段'],
  },
];

export const FEATURE_MAP = new Map(FEATURES.map((f) => [f.id, f]));

export const CATEGORY_LABELS: Record<string, string> = {
  text: '文本',
  code: '代码',
  reasoning: '推理',
  tools: '工具与 Agent',
  vision: '视觉理解',
  image: '图像生成',
  audio: '音频',
  realtime: '实时交互',
  video: '视频',
  '3d': '3D',
  embedding: '向量与检索',
  meta: '平台与调试',
};
