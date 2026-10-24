import type { ArtifactRef, BuildContext, OperationDef, ParamSpec, ProviderDef } from '../types.ts';
import { embeddingOperation, type ChatInput, type ChatMessageInput } from './_common.ts';
import { applyParams } from '../util.ts';
import { documented, enumOptions } from './native-evidence.ts';

const ASR = 'https://developers.openai.com/api/docs/guides/speech-to-text';
const REALTIME = 'https://developers.openai.com/api/docs/guides/voice-websockets?voice-api=realtime';
const IMAGES = 'https://developers.openai.com/api/reference/resources/images';
const EMBEDDINGS = 'https://developers.openai.com/api/reference/resources/embeddings/methods/create';
const RESPONSES = 'https://developers.openai.com/api/reference/resources/responses/methods/create';

const responsesModels = ['gpt-6-astra', 'gpt-6.1-sol', 'gpt-6-luna'];
export const openaiNativeProvider: ProviderDef = {
  id: 'openai',
  name: 'OpenAI 原生',
  kind: 'official',
  region: 'global',
  description:
    'OpenAI 原生 Responses 对话、图像、向量、文件转写与 Realtime 双向语音；国际账户、可用地区及计费条件需单独确认。',
  baseUrls: [{ id: 'official', label: '官方', url: 'https://api.openai.com' }],
  auth: { type: 'bearer' },
  keyEnv: ['OPENAI_API_KEY'],
  docsUrl: REALTIME,
  consoleUrl: 'https://platform.openai.com/api-keys',
  pricingUrl: 'https://developers.openai.com/api/docs/pricing',
  modelsPath: '/v1/models',
  highlights: [
    'Responses 原生对话与工具',
    'GPT Image 2.5 生成与编辑',
    '原生 Embeddings',
    'multipart 文件转写',
    '24kHz PCM 双向音频与 VAD',
  ],
  models: [
    ...responsesModels.map((id) => ({
      id,
      modalities: ['text-in', 'image-in', 'text-out'],
      capabilities: ['chat', 'reasoning', 'tools', 'json-output', 'vision', 'mcp'],
      verification: documented(RESPONSES),
    })),
    { id: 'gpt-transcribe', modalities: ['audio-in', 'text-out'], verification: documented(ASR) },
    {
      id: 'gpt-realtime-2.1',
      modalities: ['audio-in', 'text-in', 'audio-out', 'text-out'],
      verification: documented(REALTIME),
    },
    ...['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'].map((id) => ({
      id,
      modalities: ['text-in', 'image-in', 'image-out'],
      verification: documented(IMAGES),
    })),
    ...['text-embedding-3-large', 'text-embedding-3-small'].map((id) => ({
      id,
      modalities: ['text-in'],
      verification: documented(EMBEDDINGS),
    })),
  ],
  notes: [
    '依据 2026-10-22 official OpenAI documentation，文件转写使用当前 gpt-transcribe；旧 Whisper/4o 转写模型已在文档标记弃用。',
    'gpt-image-1 已于 2026-10-23 下线；此适配使用 GPT Image 2.5 系列，图像生成恒返回 b64_json。',
    'TTS 的 tts-1 / tts-1-hd / gpt-4o-mini-tts 将于 2027-01-06 关停，本适配没有把即将停用的语音合成为新能力。',
  ],
};
const asrParams: ParamSpec[] = [
  {
    key: 'prompt',
    label: '转写上下文',
    type: 'text',
    default: '这是一段中文技术讨论。',
    group: '识别',
    description: '帮助识别人名、缩写或领域术语；不是让模型执行指令的聊天提示。',
  },
];
const realtimeParams: ParamSpec[] = [
  {
    key: 'instructions',
    label: '语音会话指令',
    type: 'text',
    default: '用简洁中文回答，每次最多两句话。',
    enabledByDefault: true,
    group: '会话',
  },
  {
    key: 'audio.output.voice',
    label: '音色',
    type: 'enum',
    options: enumOptions(['marin', 'cedar', 'alloy', 'coral']),
    default: 'marin',
    enabledByDefault: true,
    group: '声音',
  },
  {
    key: 'audio.input.turn_detection',
    label: 'VAD 配置',
    type: 'json',
    default: {
      type: 'server_vad',
      threshold: 0.5,
      prefix_padding_ms: 300,
      silence_duration_ms: 600,
      create_response: true,
      interrupt_response: true,
    },
    enabledByDefault: true,
    native: true,
    group: '回合检测',
    description: 'server_vad 可调静音阈值；设 null 关闭自动回合，需手动提交音频与 response.create。',
  },
  {
    key: 'max_output_tokens',
    label: '每次回复 Token 上限',
    type: 'integer',
    min: 1,
    max: 4096,
    default: 512,
    enabledByDefault: true,
    group: '费用',
  },
];
function session(ctx: BuildContext): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: 'realtime',
    output_modalities: ['audio'],
    audio: {
      input: { format: { type: 'audio/pcm', rate: 24000 } },
      output: { format: { type: 'audio/pcm', rate: 24000 } },
    },
  };
  applyParams(out, realtimeParams, ctx.params, ctx.model);
  return out;
}
const imageParams: ParamSpec[] = [
  { key: 'n', label: '图片数量', type: 'integer', min: 1, max: 10, default: 1, enabledByDefault: true, group: '画面' },
  {
    key: 'size',
    label: '输出尺寸',
    type: 'enum',
    options: enumOptions(['1024x1024', '1536x1024', '1024x1536', '2048x2048']),
    default: '1024x1024',
    enabledByDefault: true,
    group: '画面',
    description: 'GPT Image 2.5 的完整尺寸集合以官方页面为准；这里只列出常见方形与横竖尺寸。',
  },
  {
    key: 'quality',
    label: '质量',
    type: 'enum',
    options: enumOptions(['low', 'medium', 'high', 'xhigh', 'max', 'auto']),
    default: 'high',
    enabledByDefault: true,
    group: '质量',
  },
  {
    key: 'output_format',
    label: '输出格式',
    type: 'enum',
    options: enumOptions(['png', 'jpeg', 'webp']),
    default: 'png',
    enabledByDefault: true,
    group: '格式',
  },
];

function toResponsesTools(tools: unknown): any[] {
  return (Array.isArray(tools) ? tools : []).map((t: any) => {
    if (t?.type === 'function' && t.function)
      return {
        type: 'function',
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
        ...(t.function.strict !== undefined ? { strict: t.function.strict } : {}),
      };
    return t;
  });
}

function buildResponsesInput(messages: ChatMessageInput[]): any[] {
  const items: any[] = [];
  for (const m of messages) {
    if (m.role === 'system' || m.role === 'developer') continue;
    if (m.role === 'tool') {
      items.push({ type: 'function_call_output', call_id: m.tool_call_id, output: m.content ?? '' });
      continue;
    }
    if (m.role === 'assistant') {
      if (m.content?.trim()) items.push({ role: 'assistant', content: m.content });
      for (const tc of (m.tool_calls ?? []) as any[])
        items.push({
          type: 'function_call',
          call_id: tc.id,
          name: tc.function?.name,
          arguments: tc.function?.arguments ?? '{}',
        });
      continue;
    }
    const parts: any[] = [];
    if (m.content?.trim()) parts.push({ type: 'input_text', text: m.content });
    for (const id of m.images ?? []) parts.push({ type: 'input_image', image_url: { $asset: id, as: 'dataUrl' } });
    items.push({ role: 'user', content: parts });
  }
  return items;
}

const responsesParams: ParamSpec[] = [
  {
    key: 'max_output_tokens',
    label: '输出上限（含推理）',
    type: 'integer',
    min: 1,
    max: 128_000,
    default: 4096,
    enabledByDefault: true,
    group: '长度',
  },
  {
    key: 'reasoning.effort',
    label: '推理档位',
    type: 'enum',
    options: enumOptions(['minimal', 'low', 'medium', 'high', 'max']),
    default: 'medium',
    enabledByDefault: true,
    native: true,
    group: '思考',
    description: '不同模型支持的档位不同；none/minimal 等值以官方模型页为准。',
  },
  {
    key: 'reasoning.summary',
    label: '推理摘要',
    type: 'enum',
    options: enumOptions(['auto', 'concise', 'detailed']),
    default: 'auto',
    native: true,
    group: '思考',
    advanced: true,
  },
  {
    key: 'temperature',
    label: 'temperature',
    type: 'number',
    min: 0,
    max: 2,
    step: 0.05,
    default: 0.7,
    group: '采样',
    advanced: true,
  },
  {
    key: 'tools',
    label: '工具声明',
    type: 'json',
    default: [
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: '查询城市天气',
          parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
        },
      },
    ],
    group: '工具',
    description:
      '可写函数工具（Chat 格式，会转换为 Responses 的扁平结构），也可直接写 {type:"web_search"} 或 {type:"mcp",...} 原生工具。',
  },
  {
    key: 'tool_choice',
    label: 'tool_choice',
    type: 'enum',
    options: enumOptions(['auto', 'none', 'required']),
    default: 'auto',
    group: '工具',
    advanced: true,
  },
  {
    key: 'parallel_tool_calls',
    label: '并行工具调用',
    type: 'boolean',
    default: true,
    group: '工具',
    advanced: true,
  },
  {
    key: 'text.format',
    label: '结构化输出',
    type: 'json',
    default: {
      type: 'json_schema',
      name: 'result',
      strict: true,
      schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    },
    group: '输出格式',
    advanced: true,
  },
  {
    key: 'store',
    label: '服务端存储响应',
    type: 'boolean',
    default: false,
    enabledByDefault: true,
    group: '隐私',
    description: '默认 store:false，避免 OpenAI 保留对话用于后续 previous_response_id；需要续聊时再开启。',
  },
];

export const openaiNativeOps: OperationDef[] = [
  {
    id: 'openai.asr',
    providerId: 'openai',
    title: 'OpenAI 文件语音转写',
    summary: '上传真实音频，以 multipart/form-data 调用 gpt-transcribe；返回原文与语言检测 JSON。',
    features: ['asr'],
    workbench: 'asr',
    lifecycle: 'http',
    protocol: 'json',
    models: ['gpt-transcribe'],
    defaultModel: 'gpt-transcribe',
    inputFields: ['audio'],
    inputHints: {
      audio: '上传音频文件，最大 25 MB；支持 mp3、mp4、mpeg、mpga、m4a、wav、webm。URL 引用须先下载为本地文件。',
    },
    params: asrParams,
    costTier: 'medium',
    costHint: '音频按官方账户规则计费；此模型价格尚未在项目核验。',
    verification: documented(ASR),
    docsUrl: ASR,
    build: (ctx) => {
      const fields: Record<string, unknown> = { model: ctx.model };
      applyParams(fields, asrParams, ctx.params, ctx.model);
      return {
        method: 'POST',
        path: '/v1/audio/transcriptions',
        bodyType: 'multipart',
        body: { fields, files: ctx.input.audio ? { file: { $asset: String(ctx.input.audio) } } : {} },
      };
    },
    notes: [
      '仅展示厂商实际返回的转写；此模型没有沿用旧 Whisper 的 verbose_json/timestamp_granularities 参数。',
      '不提供纯文字伪装的音频演示，预设需要先添加真实录音。',
    ],
  },
  {
    id: 'openai.realtime',
    providerId: 'openai',
    title: 'OpenAI Realtime 双向语音',
    summary: '原生 WebSocket + 24kHz PCM；麦克风输入、语音播放、服务端 VAD、打断与双向事件。',
    features: ['realtime-voice'],
    workbench: 'realtime',
    lifecycle: 'ws',
    protocol: 'json',
    models: ['gpt-realtime-2.1'],
    defaultModel: 'gpt-realtime-2.1',
    params: realtimeParams,
    costTier: 'high',
    costHint: '实时语音持续产生音频/文本用量；结束后请断开会话。价格未知，未实测费用。',
    realtime: {
      path: '/v1/realtime?model={model}',
      protocol: 'openai-realtime',
      inputRate: 24000,
      outputRate: 24000,
      session,
    },
    build: (ctx) => ({
      method: 'GET',
      path: `/v1/realtime?model=${encodeURIComponent(ctx.model)}`,
      body: { type: 'session.update', session: session(ctx) },
    }),
    verification: documented(REALTIME),
    docsUrl: REALTIME,
    notes: [
      '使用官方 Realtime API，而非另一个 GPT-Live 协议；会话采用 GA 嵌套 audio.input/audio.output 字段。',
      '音色在第一次输出音频后不能更换；改变音色请重新连接。',
      '真实录音需要浏览器麦克风授权。Key 仅在本地服务端升级 WebSocket 时注入。',
    ],
  },
  {
    id: 'openai.image',
    providerId: 'openai',
    title: 'OpenAI 原生图像（GPT Image 2.5）',
    summary:
      '无参考图时走 JSON /v1/images/generations，有参考图时走 multipart /v1/images/edits（image[] + mask 字段）；图像以 b64_json 返回并保存在本地。',
    features: ['image-gen', 'image-edit'],
    workbench: 'image',
    lifecycle: 'http',
    protocol: 'json',
    models: ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare'],
    defaultModel: 'gpt-image-2.5-sunburst',
    freeModel: true,
    inputFields: ['prompt', 'images', 'mask'],
    inputHints: {
      prompt: '描述要生成或修改的画面。',
      images: '参考图最多 16 张；编辑接口使用 multipart 的 image[] 字段。',
      mask: '可选；与原图同尺寸并带 alpha 通道，小于 50 MB。',
    },
    params: imageParams,
    artifacts: (response): ArtifactRef[] => {
      const format = String(response?.output_format ?? 'png').toLowerCase();
      const mime = format === 'jpeg' ? 'image/jpeg' : format === 'webp' ? 'image/webp' : 'image/png';
      const ext = format === 'jpeg' ? 'jpg' : format;
      return (Array.isArray(response?.data) ? response.data : []).flatMap((d: any, i: number) => {
        if (typeof d?.b64_json === 'string' && d.b64_json)
          return [{ kind: 'image' as const, base64: d.b64_json, mime, filename: `openai-image-${i + 1}.${ext}` }];
        if (typeof d?.url === 'string' && d.url)
          return [{ kind: 'image' as const, url: d.url, mime, filename: `openai-image-${i + 1}.${ext}` }];
        return [];
      });
    },
    costTier: 'medium',
    costHint: '图像按质量与尺寸计价，实际价格以账户为准；生成与编辑都会计费。',
    verification: documented(IMAGES, '2026-10-25 核对 Images 参考；未真实调用'),
    docsUrl: IMAGES,
    build: (ctx) => {
      const images = (ctx.input.images ?? []) as string[];
      if (images.length) {
        const fields: Record<string, unknown> = { model: ctx.model, prompt: String(ctx.input.prompt ?? '') };
        applyParams(fields, imageParams, ctx.params, ctx.model);
        const files: Record<string, unknown> = { 'image[]': images.map((id) => ({ $asset: String(id) })) };
        if (ctx.input.mask) files.mask = { $asset: String(ctx.input.mask) };
        return {
          method: 'POST',
          path: '/v1/images/edits',
          bodyType: 'multipart' as const,
          body: { fields, files },
        };
      }
      const body: any = { model: ctx.model, prompt: String(ctx.input.prompt ?? '') };
      applyParams(body, imageParams, ctx.params, ctx.model);
      return { method: 'POST', path: '/v1/images/generations', body };
    },
    notes: [
      'GPT Image 模型不支持 response_format / url 返回；响应里的 data[].b64_json 才是实际图像。',
      '编辑接口的文件字段名是 image[]（可重复），不是 images[]；mask 也是 multipart 文件字段。',
      '流式图像事件 image_generation.partial_image / completed 尚未接入，本操作使用非流式请求。',
    ],
  },
  embeddingOperation({
    id: 'openai.embedding',
    providerId: 'openai',
    title: 'OpenAI 原生 Embeddings',
    summary: 'POST /v1/embeddings：text-embedding-3 系列的原生维度与编码格式；结果区计算两两相似度。',
    path: '/v1/embeddings',
    models: ['text-embedding-3-large', 'text-embedding-3-small'],
    defaultModel: 'text-embedding-3-large',
    verification: documented(EMBEDDINGS, '2026-10-25 核对 Embeddings 参考；未真实调用'),
    docsUrl: EMBEDDINGS,
  }),
  {
    id: 'openai.responses',
    providerId: 'openai',
    title: 'OpenAI Responses 原生对话',
    summary:
      '原生 input 项、instructions、函数/内置/MCP 工具、结构化输出与推理摘要；工具结果以 function_call_output 回传。',
    features: ['chat', 'reasoning', 'tools', 'json-output', 'vision', 'mcp', 'builtin-search'],
    workbench: 'chat',
    lifecycle: 'sse',
    protocol: 'openai-responses',
    models: responsesModels,
    defaultModel: 'gpt-6-astra',
    freeModel: true,
    params: responsesParams,
    costTier: 'medium',
    costHint: '按输入/输出 Token 计费，推理 Token 计入输出；未核验账户价格。',
    verification: documented(RESPONSES, '2026-10-25 核对 Responses 创建与流式事件文档；未真实调用'),
    docsUrl: RESPONSES,
    build: (ctx) => {
      const input = ctx.input as unknown as ChatInput;
      if (input.prefix?.trim())
        throw new Error('Responses API 不支持 assistant 预填；请用 instructions 或结构化输出约束格式。');
      const stream = input.stream !== false;
      const messages = input.messages ?? [];
      const instructions = [
        input.system,
        ...messages.filter((m) => m.role === 'system' || m.role === 'developer').map((m) => m.content),
      ]
        .filter((text) => text && String(text).trim())
        .join('\n\n');
      const body: any = { model: ctx.model, input: buildResponsesInput(messages) };
      if (instructions) body.instructions = instructions;
      applyParams(body, responsesParams, ctx.params, ctx.model);
      if (Array.isArray(body.tools)) body.tools = toResponsesTools(body.tools);
      body.stream = stream;
      return { method: 'POST', path: '/v1/responses', body, stream };
    },
    notes: [
      'Responses 的输入是 item 数组：消息用 input_text / input_image，工具结果用 function_call_output，不再使用 messages 数组。',
      '预测输出（prediction）只在旧 Chat Completions 的 GPT-4o/4.1 系列可用，Responses 不支持；本适配没有伪造该字段。',
      'MCP 工具直接透传到 tools；远程服务器与授权由你自行配置，本项目不会自动执行 MCP 工具。',
      '工具回合的 reasoning item 未做加密内容回传；依赖跨轮推理的 Responses 工具循环仍需在真实账户验证。',
    ],
  },
];
