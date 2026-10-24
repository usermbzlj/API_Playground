import type { ArtifactRef, BuildContext, OperationDef, ParamSpec, ProviderDef } from '../types.ts';
import { chatOperation, RESPONSE_FORMAT, TOOLS } from './_common.ts';
import { applyParams } from '../util.ts';
import { documented, enumOptions } from './native-evidence.ts';

const THINK = 'https://help.aliyun.com/zh/model-studio/deep-thinking';
const IMAGE = 'https://help.aliyun.com/en/model-studio/qwen-image-generation-and-editing-api-reference';
const PRICE = 'https://help.aliyun.com/zh/model-studio/model-pricing';
const REALTIME = 'https://help.aliyun.com/en/model-studio/realtime';
const REALTIME_EVENTS = 'https://help.aliyun.com/en/model-studio/client-events';
const WAN = 'https://help.aliyun.com/zh/model-studio/wan3-video-generation-api-reference';
const ASR = 'https://help.aliyun.com/zh/model-studio/qwen-asr-api-reference';
const textModels = ['qwen3.8-flash', 'qwen3.8-max', 'qwen3.7-plus', 'qwen3.6-plus'];
const imageModels = ['qwen-image-3.0', 'qwen-image-3.0-pro'];
const videoModels = ['wan3.0-video', 'wan3.0-video-prime'];
const asrModels = ['qwen3-asr-flash'];
export const qwenProvider: ProviderDef = {
  id: 'qwen',
  name: 'Qwen / 阿里云百炼',
  kind: 'cloud',
  region: 'cn',
  description: '百炼原生思考预算与 DashScope 图像生成/编辑，保留 input.messages 与 parameters 结构。',
  baseUrls: [
    {
      id: 'cn',
      label: '北京（旧公共域名）',
      url: 'https://dashscope.aliyuncs.com',
      note: '官方现推荐工作空间专属域名：请在连接中改为 https://真实WorkspaceId.cn-beijing.maas.aliyuncs.com。',
    },
    {
      id: 'intl',
      label: '新加坡（旧公共域名）',
      url: 'https://dashscope-intl.aliyuncs.com',
      note: '须使用新加坡 Key；可改为工作空间专属域名。',
    },
  ],
  auth: { type: 'bearer' },
  keyEnv: ['DASHSCOPE_API_KEY'],
  docsUrl: THINK,
  consoleUrl: 'https://bailian.console.aliyun.com/',
  pricingUrl: 'https://help.aliyun.com/zh/model-studio/model-pricing',
  highlights: ['enable_thinking / thinking_budget', '原生图像 input.messages', '提示词扩写与思考', '多参考图片编辑'],
  models: [
    ...textModels.map((id) => ({
      id,
      modalities: ['text-in', 'text-out'],
      verification: documented(THINK),
      ...(id === 'qwen3.8-flash'
        ? {
            pricing: {
              currency: 'CNY' as const,
              text: '北京：输入 ¥0.8 / 输出 ¥2.7 每百万 Token（含思考）；新加坡：¥1.094 / ¥3.427。按连接地域与实际账单为准。',
              source: PRICE,
              date: '2026-10-22',
            },
          }
        : {}),
    })),
    ...imageModels.map((id) => ({
      id,
      modalities: ['text-in', 'image-in', 'image-out'],
      verification: documented(IMAGE),
    })),
    ...videoModels.map((id) => ({
      id,
      modalities: ['text-in', 'image-in', 'video-out'],
      verification: documented(WAN),
    })),
    { id: 'qwen3-asr-flash', modalities: ['audio-in', 'text-out'], verification: documented(ASR) },
    {
      id: 'qwen3.8-omni-flash-realtime',
      modalities: ['audio-in', 'text-in', 'audio-out', 'text-out'],
      verification: documented(REALTIME),
      pricing: {
        currency: 'CNY',
        text: '北京每百万Token：文本等输入 ¥1.5、音频输入 ¥6、文本输出 ¥4.5、音频输出 ¥12；文本和音频分别计费。',
        source: PRICE,
        date: '2026-10-22',
      },
    },
  ],
  notes: [
    'Key、模型开放范围和工作空间域名按地域区分。默认域名保留旧公共入口，可直接编辑连接 Base URL 使用官方新域名。',
    '不将旧 qwen-image-plus 的固定图片价套用到 3.0 模型；当前估价未知，请看账户定价。',
  ],
};
const thinkingParams: ParamSpec[] = [
  {
    key: 'enable_thinking',
    label: '启用思考',
    type: 'boolean',
    default: true,
    enabledByDefault: true,
    native: true,
    group: '思考',
  },
  {
    key: 'thinking_budget',
    label: '思考 Token 预算',
    type: 'integer',
    min: 1,
    max: 32768,
    default: 1024,
    native: true,
    group: '思考',
    description: '不是总输出上限；预算耗尽后模型转为输出答案。模型上限以官方模型卡为准。',
  },
  {
    key: 'max_tokens',
    label: '输出上限',
    type: 'integer',
    min: 1,
    default: 2048,
    enabledByDefault: true,
    group: '长度',
  },
  RESPONSE_FORMAT,
  TOOLS,
];
const imageParams: ParamSpec[] = [
  {
    key: 'parameters.size',
    label: '输出尺寸',
    type: 'string',
    default: '1024*1024',
    group: '画面',
    description: 'width*height；像素面积 512²～2048²，宽高比 1:8～8:1。',
  },
  {
    key: 'parameters.n',
    label: '图片数量',
    type: 'integer',
    min: 1,
    max: 6,
    default: 1,
    enabledByDefault: true,
    group: '画面',
  },
  {
    key: 'parameters.seed',
    label: '随机种子',
    type: 'integer',
    min: 0,
    max: 2147483647,
    default: 42,
    native: true,
    group: '复现',
  },
  {
    key: 'parameters.prompt_extend',
    label: '提示词智能扩写',
    type: 'boolean',
    default: true,
    enabledByDefault: true,
    native: true,
    group: '原生策略',
  },
  {
    key: 'parameters.prompt_extend_mode',
    label: '扩写方式',
    type: 'enum',
    options: enumOptions(['direct', 'agent']),
    default: 'direct',
    native: true,
    group: '原生策略',
    description: 'agent 仅用于文生图；参考图片编辑不能使用 agent。',
  },
  {
    key: 'parameters.enable_thinking',
    label: '图像推理',
    type: 'boolean',
    default: true,
    native: true,
    group: '原生策略',
    description: '要求 prompt_extend=true，增加生成时间。',
  },
  { key: 'parameters.watermark', label: '水印', type: 'boolean', default: false, group: '画面', advanced: true },
];
const realtimeParams: ParamSpec[] = [
  {
    key: 'instructions',
    label: '实时会话指令',
    type: 'text',
    default: '用简洁中文回答，每次最多两句话。',
    enabledByDefault: true,
    group: '会话',
  },
  {
    key: 'audio.output.voice',
    label: '输出音色',
    type: 'enum',
    options: enumOptions(['Tina', 'longanlingxin']),
    default: 'Tina',
    enabledByDefault: true,
    native: true,
    group: '声音',
  },
  {
    key: 'turn_detection',
    label: '原生 VAD 配置',
    type: 'json',
    default: { type: 'server_vad', threshold: 0.5, silence_duration_ms: 800 },
    enabledByDefault: true,
    native: true,
    group: '回合检测',
    description: 'type 可选 server_vad / semantic_vad；后者按语义过滤附和与背景声。null 为手动提交。',
  },
  {
    key: 'input_audio_transcription',
    label: '用户音频转写',
    type: 'json',
    default: { model: 'qwen3-asr-flash-realtime' },
    enabledByDefault: true,
    native: true,
    group: '转写',
    description: '仅允许这个固定模型，null 关闭输入转写；不是 SDK 的 enable_input_audio_transcription 字段。',
  },
];
function realtimeSession(ctx: BuildContext): Record<string, unknown> {
  const out: Record<string, unknown> = {
    modalities: ['text', 'audio'],
    audio: {
      input: {
        format: {
          type: 'pcm',
          sample_rate: 16000,
          sample_format: 's16le',
          channels: 1,
          packing: 'interleaved',
          channel_layout: 'mono',
        },
      },
      output: { format: { type: 'pcm', sample_rate: 24000 } },
    },
  };
  applyParams(out, realtimeParams, ctx.params, ctx.model);
  return out;
}
const wanParams: ParamSpec[] = [
  {
    key: 'parameters.resolution',
    label: '分辨率',
    type: 'enum',
    options: enumOptions(['480P', '720P', '1080P']),
    default: '1080P',
    enabledByDefault: true,
    group: '视频',
  },
  {
    key: 'parameters.ratio',
    label: '画幅比例',
    type: 'enum',
    options: enumOptions(['adaptive', '21:9', '16:9', '4:3', '1:1', '3:4', '9:16']),
    default: '16:9',
    enabledByDefault: true,
    group: '画面',
    description: '图生视频可选 adaptive；首/尾帧存在时以素材为准。',
  },
  {
    key: 'parameters.duration',
    label: '时长（秒）',
    type: 'integer',
    min: 2,
    max: 30,
    default: 5,
    enabledByDefault: true,
    group: '视频',
    description: '2–30 秒；官方还支持 -1 自动时长，本适配不开放自动值。',
  },
  {
    key: 'parameters.prompt_extend',
    label: '提示词智能扩写',
    type: 'boolean',
    default: true,
    native: true,
    group: '原生策略',
  },
  {
    key: 'parameters.audio',
    label: '生成音频',
    type: 'boolean',
    default: false,
    native: true,
    group: '音频',
    description: '是否生成与画面匹配的音频；费用与模型支持范围以官方页面为准。',
  },
  {
    key: 'parameters.seed',
    label: '随机种子',
    type: 'integer',
    min: 0,
    default: 42,
    native: true,
    group: '复现',
    advanced: true,
  },
  { key: 'parameters.watermark', label: '水印', type: 'boolean', default: false, group: '画面', advanced: true },
];

const asrParams: ParamSpec[] = [
  {
    key: 'parameters.asr_options.language',
    label: '识别语言',
    type: 'enum',
    options: enumOptions(['auto', 'zh', 'en', 'yue', 'ja', 'ko']),
    default: 'auto',
    native: true,
    group: '识别',
  },
  {
    key: 'parameters.asr_options.enable_itn',
    label: '逆文本归一化',
    type: 'boolean',
    default: true,
    native: true,
    group: '识别',
    advanced: true,
    description: '把口语数字转为数字写法；不同语种的实际行为以厂商为准。',
  },
];

export const qwenOps: OperationDef[] = [
  chatOperation({
    id: 'qwen.chat',
    providerId: 'qwen',
    title: 'Qwen 思考预算实验',
    path: '/compatible-mode/v1/chat/completions',
    summary: '原生 enable_thinking / thinking_budget；独立观察推理正文、答案、缓存和用量。',
    models: textModels,
    defaultModel: 'qwen3.8-flash',
    params: thinkingParams,
    features: ['chat', 'reasoning', 'tools', 'json-output', 'cache'],
    verification: documented(THINK),
    docsUrl: THINK,
    notes: [
      'enable_thinking 和 thinking_budget 在原始 HTTP 请求中是顶层字段；不发送 SDK 专用 extra_body。',
      '关闭思考时，thinking_budget 没有实际意义；服务端如何处理请观察原始响应。',
    ],
  }),
  {
    id: 'qwen.realtime',
    providerId: 'qwen',
    title: 'Qwen 实时双向语音 / 语义 VAD',
    summary: '国内原生实时语音；16kHz 输入、24kHz 输出、语义/声学 VAD、音频转写与原生事件。',
    features: ['realtime-voice'],
    workbench: 'realtime',
    lifecycle: 'ws',
    protocol: 'json',
    models: ['qwen3.8-omni-flash-realtime'],
    defaultModel: 'qwen3.8-omni-flash-realtime',
    params: realtimeParams,
    costTier: 'high',
    costHint: '实时文本和音频分别产生费用；请结束后立即断开。北京音频输入/输出每百万Token ¥6/¥12，另计文本。',
    realtime: {
      path: '/api-ws/v1/realtime?model={model}',
      protocol: 'openai-realtime',
      inputRate: 16000,
      outputRate: 24000,
      session: realtimeSession,
    },
    build: (ctx) => ({
      method: 'GET',
      path: `/api-ws/v1/realtime?model=${encodeURIComponent(ctx.model)}`,
      body: { type: 'session.update', session: realtimeSession(ctx) },
    }),
    verification: documented(REALTIME_EVENTS),
    docsUrl: REALTIME,
    notes: [
      '必须将连接 Base URL 改为 https://真实WorkspaceId.cn-beijing.maas.aliyuncs.com（或新加坡对应域名）；该模型不接受旧公共 dashscope 域名。',
      '收到 session.updated 后才发送音频；采用 PCM16 单声道，不能将 WAV 文件头混入原始音频。',
      'UI 适配语音/文本，不宣称已经支持该模型理论上的多通道空间音频、视频、MCP 或声音克隆。',
    ],
  },
  {
    id: 'qwen.image',
    providerId: 'qwen',
    title: 'Qwen 原生文生图 / 参考图编辑',
    summary: 'DashScope 同步原生接口；中文文字渲染、多图参考、固定种子与提示词扩写。',
    features: ['image-gen', 'image-edit'],
    workbench: 'image',
    lifecycle: 'http',
    protocol: 'json',
    models: imageModels,
    defaultModel: 'qwen-image-3.0',
    inputFields: ['prompt', 'negative', 'images'],
    inputHints: { images: '3.0 系列最多 3 张；每张不超过 10 MB，JPG/PNG/WEBP 等。可上传本地文件或使用公开链接。' },
    params: imageParams,
    costTier: 'medium',
    costHint: '图片生成按模型/分辨率计费；当前未核验账户实际价格，估价未知。',
    verification: documented(IMAGE),
    docsUrl: IMAGE,
    build: (ctx) => {
      const images = (ctx.input.images ?? []) as string[];
      if (images.length > 3) throw new Error('Qwen Image 3.0 最多支持 3 张参考图');
      const body: any = {
        model: ctx.model,
        input: {
          messages: [
            {
              role: 'user',
              content: [
                ...images.map((id) => ({ image: { $asset: id, as: 'dataUrl' } })),
                { text: String(ctx.input.prompt ?? '') },
              ],
            },
          ],
        },
        parameters: {},
      };
      if (ctx.input.negative) body.parameters.negative_prompt = String(ctx.input.negative);
      applyParams(body, imageParams, ctx.params, ctx.model);
      if (images.length && body.parameters.prompt_extend_mode === 'agent')
        throw new Error('Qwen 图像编辑不支持 agent 扩写，请选择 direct');
      if (body.parameters.enable_thinking === true && body.parameters.prompt_extend === false)
        throw new Error('Qwen 图像推理要求开启提示词智能扩写');
      return { method: 'POST', path: '/api/v1/services/aigc/multimodal-generation/generation', body };
    },
    artifacts: (response): ArtifactRef[] =>
      (response?.output?.choices ?? []).flatMap((c: any) =>
        (c?.message?.content ?? [])
          .filter((p: any) => typeof p.image === 'string')
          .map((p: any) => ({ kind: 'image', url: p.image, mime: 'image/png' })),
      ),
    notes: [
      '有参考图时自动进入编辑模式；无参考图为文生图。没有伪造蒙版或局部编辑参数。',
      '返回图片链接仅保留 24 小时；运行成功后本项目尝试下载到本地素材库。',
    ],
  },
  {
    id: 'qwen.video',
    providerId: 'qwen',
    title: '万相 Wan 3.0 异步视频',
    summary: 'DashScope 原生异步视频：input.media 首/尾帧、分辨率、时长与提示词扩写；任务直链在本地保存为 MP4。',
    features: ['video-gen', 'video-keyframes'],
    workbench: 'video',
    lifecycle: 'async-task',
    protocol: 'json',
    models: videoModels,
    defaultModel: 'wan3.0-video',
    inputFields: ['prompt', 'firstFrame', 'lastFrame'],
    inputHints: {
      prompt: '与首/尾帧至少提供一个；长度限制以官方页面为准。',
      firstFrame: '可选首帧。3.0 使用 input.media，不是旧版 input.img_url。',
      lastFrame: '可选尾帧，与首帧一起构成首尾帧视频。',
    },
    params: wanParams,
    async: {
      idPath: 'output.task_id',
      poll: { method: 'GET', path: '/api/v1/tasks/{id}' },
      statusPath: 'output.task_status',
      statusMap: {
        PENDING: 'pending',
        RUNNING: 'running',
        SUCCEEDED: 'succeeded',
        FAILED: 'failed',
        CANCELED: 'cancelled',
      },
      intervalMs: 10000,
      errorPath: 'output.message',
      results: (poll) => {
        const url = poll?.output?.video_url;
        return typeof url === 'string' && url
          ? [{ kind: 'video', url, mime: 'video/mp4', filename: 'wan3-video.mp4' }]
          : [];
      },
      resultTtlNote: 'video_url 与 task_id 约 24 小时有效；服务端成功后立即下载到本地素材库。',
    },
    costTier: 'high',
    costHint: '按分辨率、时长与音频选项计价；未核验账户实际价格，确认后才提交。',
    verification: documented(WAN, '2026-10-25 核对 Wan 3.0 REST 文档；未真实调用，模型开通与计费待确认'),
    docsUrl: WAN,
    build: (ctx) => {
      const prompt = String(ctx.input.prompt ?? '');
      const first = ctx.input.firstFrame ? String(ctx.input.firstFrame) : '';
      const last = ctx.input.lastFrame ? String(ctx.input.lastFrame) : '';
      const media: any[] = [];
      if (first) media.push({ type: 'first_frame', url: { $asset: first, as: 'dataUrl' } });
      if (last) media.push({ type: 'last_frame', url: { $asset: last, as: 'dataUrl' } });
      const body: any = {
        model: ctx.model,
        input: { ...(prompt.trim() ? { prompt } : {}), ...(media.length ? { media } : {}) },
        parameters: {},
      };
      applyParams(body, wanParams, ctx.params, ctx.model);
      return {
        method: 'POST',
        path: '/api/v1/services/aigc/video-generation/video-synthesis',
        headers: { 'X-DashScope-Async': 'enable' },
        body,
      };
    },
    notes: [
      'Wan 2.7/3.0 的图生视频使用 input.media 数组；input.img_url 只属于 ≤2.6 的旧协议。',
      '模型、域名与 Key 必须同地域；跨地域调用会失败。',
      '异步任务状态是 PENDING / RUNNING / SUCCEEDED / FAILED / CANCELED / UNKNOWN；没有官方取消端点的声明，本项目不伪造取消。',
    ],
  },
  {
    id: 'qwen.asr',
    providerId: 'qwen',
    title: 'Qwen3-ASR 同步转写',
    summary: 'DashScope 原生多模态接口：音频以 Base64/URL 送入 qwen3-asr-flash，保留真实 JSON 与识别选项。',
    features: ['asr'],
    workbench: 'asr',
    lifecycle: 'http',
    protocol: 'json',
    models: asrModels,
    defaultModel: 'qwen3-asr-flash',
    inputFields: ['audio'],
    inputHints: {
      audio: '同步接口要求音频不超过 5 分钟、10 MB；更长音频应使用官方异步文件转写（本适配尚未接入）。',
    },
    params: asrParams,
    costTier: 'low',
    costHint: '按音频时长/Token 计费；未核验账户价格。',
    verification: documented(ASR, '2026-10-25 核对 Qwen-ASR REST 文档；未真实调用'),
    docsUrl: ASR,
    build: (ctx) => {
      const audio = ctx.input.audio ? String(ctx.input.audio) : '';
      const body: any = {
        model: ctx.model,
        input: {
          messages: [
            {
              role: 'user',
              content: audio ? [{ audio: { $asset: audio, as: 'dataUrl' } }] : [],
            },
          ],
        },
        parameters: {},
      };
      applyParams(body, asrParams, ctx.params, ctx.model);
      return { method: 'POST', path: '/api/v1/services/aigc/multimodal-generation/generation', body };
    },
    notes: [
      '同步接口适合短音频；异步长音频（filetrans / paraformer-v2）需要公网 URL 与任务查询，本适配尚未声明支持。',
      '识别文本在 output.choices[].message.content；结果区同时保留厂商原始 JSON。',
      'SenseVoice 是否仍可用未确认，此适配不把它列为当前能力。',
    ],
  },
];
