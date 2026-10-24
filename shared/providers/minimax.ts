import type { ArtifactRef, OperationDef, ParamSpec, ProviderDef, Verification } from '../types.ts';
import { TOOLS, chatOperation, today } from './_common.ts';
import { applyParams } from '../util.ts';

const DOCS = 'https://platform.minimax.cn/docs/api-reference/text-chat-openai';

const V = (note?: string): Verification => ({
  status: 'documented',
  date: today,
  source: DOCS,
  note: note ?? '依据官方文档定义；尚未使用真实 Key 实测',
});

export const minimaxProvider: ProviderDef = {
  id: 'minimax',
  name: 'MiniMax',
  kind: 'official',
  description:
    'MiniMax 官方 API：M3 原生思考参数、多模型语音合成与流式语音、Hailuo 视频；国内站与国际站 Key 体系不同。',
  baseUrls: [
    { id: 'cn', label: '国内站', url: 'https://api.minimaxi.com', note: '国内控制台创建的 Key' },
    {
      id: 'cn-current',
      label: '国内新域名',
      url: 'https://api.minimax.cn',
      note: '当前官方文档域名；旧连接仍可保留原端点',
    },
    { id: 'intl', label: '国际站', url: 'https://api.minimax.io', note: '国际站 Key 与国内不通用' },
  ],
  auth: {
    type: 'bearer',
    extraFields: [{ key: 'GroupId', label: 'GroupId', placeholder: '仅历史接口需要时填写', required: false }],
  },
  docsUrl: DOCS,
  consoleUrl: 'https://www.minimaxi.com/user-center/basic-information',
  modelsPath: undefined,
  highlights: ['M3.1 Flash 推理强度', 'M3 思考开关', 'TTS 音色控制', '流式语音', 'Hailuo 视频生成'],
  notes: [
    '国内站（minimaxi.com）与国际站（minimax.io）的 API Key 不通用，选错域名会返回鉴权错误。',
    '当前视频与语音接口按 Bearer Key 鉴权；GroupId 仅为历史连接保留。声音设计/复刻尚未适配。',
  ],
  models: [
    ...['MiniMax-M3.1-Flash', 'MiniMax-M3'].map((id) => ({
      id,
      context: 1000000,
      modalities: ['text-in', 'image-in', 'text-out'],
      verification: V(),
    })),
    {
      id: 'speech-02-turbo',
      label: 'speech-02-turbo',
      modalities: ['text-in', 'audio-out'],
      notes: 'TTS，延迟优先',
      verification: V(),
    },
    {
      id: 'speech-02-hd',
      label: 'speech-02-hd',
      modalities: ['text-in', 'audio-out'],
      notes: 'TTS，质量优先',
      verification: V(),
    },
    { id: 'speech-01-turbo', label: 'speech-01-turbo', modalities: ['text-in', 'audio-out'], verification: V() },
    { id: 'speech-01-hd', label: 'speech-01-hd', modalities: ['text-in', 'audio-out'], verification: V() },
    {
      id: 'MiniMax-M2',
      label: 'MiniMax-M2',
      context: 200000,
      modalities: ['text-in', 'text-out'],
      verification: { status: 'unverified', date: today, note: '模型名与可用性以控制台「模型列表」为准' },
    },
    {
      id: 'MiniMax-M1',
      label: 'MiniMax-M1',
      context: 1000000,
      modalities: ['text-in', 'text-out'],
      verification: { status: 'unverified', date: today, note: '长上下文模型；以控制台为准' },
    },
  ],
};

const TTS_PARAMS: ParamSpec[] = [
  {
    key: 'voice_setting.voice_id',
    label: 'voice_id',
    type: 'string',
    default: 'male-qn-qingse',
    group: '音色',
    description: '系统预置音色 ID，或音色复刻得到的 voice_id',
  },
  {
    key: 'voice_setting.speed',
    label: '语速 speed',
    type: 'number',
    min: 0.5,
    max: 2,
    step: 0.1,
    default: 1,
    group: '音色',
  },
  {
    key: 'voice_setting.vol',
    label: '音量 vol',
    type: 'number',
    min: 0.1,
    max: 10,
    step: 0.1,
    default: 1,
    group: '音色',
    advanced: true,
  },
  {
    key: 'voice_setting.pitch',
    label: '音调 pitch',
    type: 'integer',
    min: -12,
    max: 12,
    default: 0,
    group: '音色',
    advanced: true,
  },
  {
    key: 'voice_setting.emotion',
    label: '情绪 emotion',
    type: 'enum',
    options: ['happy', 'sad', 'angry', 'fear', 'hate', 'surprise', 'neutral'].map((v) => ({ value: v })),
    group: '音色',
    advanced: true,
    models: 'speech-2\\.\\d+-hd',
    native: true,
    verification: V('情绪参数仅部分模型支持（官方文档：speech-2.6-hd 等），不支持时接口会报参数错误'),
  },
  {
    key: 'audio_setting.format',
    label: '音频格式',
    type: 'enum',
    options: ['mp3', 'wav', 'flac', 'opus'].map((v) => ({ value: v })),
    default: 'mp3',
    group: '音频',
  },
  {
    key: 'audio_setting.sample_rate',
    label: '采样率',
    type: 'enum',
    options: [16000, 22050, 24000, 32000, 44100].map((v) => ({ value: v })),
    default: 32000,
    group: '音频',
    advanced: true,
  },
  {
    key: 'audio_setting.bitrate',
    label: '码率',
    type: 'enum',
    options: [32000, 64000, 128000, 256000].map((v) => ({ value: v })),
    default: 128000,
    group: '音频',
    advanced: true,
  },
  {
    key: 'audio_setting.channel',
    label: '声道',
    type: 'enum',
    options: [{ value: 1 }, { value: 2 }],
    default: 1,
    group: '音频',
    advanced: true,
  },
  {
    key: 'language_boost',
    label: 'language_boost',
    type: 'enum',
    options: [
      'auto',
      'Chinese',
      'English',
      'Japanese',
      'Korean',
      'Russian',
      'Spanish',
      'French',
      'German',
      'Italian',
      'Portuguese',
      'Arabic',
    ].map((v) => ({ value: v })),
    default: 'auto',
    group: '语言',
    advanced: true,
    description: '增强指定语言的发音表现',
  },
  {
    key: 'stream',
    label: '流式返回',
    type: 'boolean',
    default: false,
    group: '音频',
    description: '开启后音频分多段返回，可测量首包延迟',
  },
];

const CHAT_PARAMS: ParamSpec[] = [
  {
    key: 'max_completion_tokens',
    label: '总输出上限（含思考）',
    type: 'integer',
    min: 1,
    max: 524288,
    default: 2048,
    enabledByDefault: true,
    group: '长度',
  },
  {
    key: 'thinking.type',
    label: '思考开关（仅 M3）',
    type: 'enum',
    options: [{ value: 'adaptive' }, { value: 'disabled' }],
    default: 'adaptive',
    models: '^MiniMax-M3$',
    native: true,
    group: '思考',
  },
  {
    key: 'reasoning_effort',
    label: '推理强度（仅 Flash）',
    type: 'enum',
    options: ['low', 'medium', 'high', 'xhigh', 'max'].map((value) => ({ value })),
    default: 'low',
    models: '^MiniMax-M3\\.1-Flash$',
    native: true,
    group: '思考',
  },
  {
    key: 'reasoning_split',
    label: '分离思考内容',
    type: 'boolean',
    default: true,
    enabledByDefault: true,
    native: true,
    group: '思考',
  },
  {
    key: 'service_tier',
    label: '服务等级',
    type: 'enum',
    options: [{ value: 'standard' }, { value: 'priority' }],
    default: 'standard',
    models: '^MiniMax-M3$',
    group: '服务',
    description: 'priority 按标准价 1.5 倍计费。',
  },
  TOOLS,
];

function ttsArtifacts(response: any): ArtifactRef[] {
  const hex = response?.data?.audio;
  if (typeof hex !== 'string' || !hex) return [];
  return [{ kind: 'audio', mime: 'audio/mpeg', hex, filename: 'minimax-tts.mp3' }];
}

export const minimaxOps: OperationDef[] = [
  {
    id: 'minimax.tts',
    providerId: 'minimax',
    title: 'MiniMax 语音合成',
    summary: 'POST /v1/t2a_v2：文字转语音，支持音色、语速、音调、情绪与音频参数；音频以 hex 形式返回。',
    features: ['tts', 'tts-stream'],
    workbench: 'tts',
    lifecycle: 'http',
    models: ['speech-02-turbo', 'speech-02-hd', 'speech-01-turbo', 'speech-01-hd'],
    defaultModel: 'speech-02-turbo',
    protocol: 'minimax-t2a',
    params: TTS_PARAMS,
    artifacts: ttsArtifacts,
    streamArtifacts: (view) =>
      view?.hex ? [{ kind: 'audio', mime: 'audio/mpeg', hex: view.hex, filename: 'minimax-tts.mp3' }] : [],
    costTier: 'low',
    verification: V('hex 音频字段为 data.audio；官方文档示例模型为 speech-02 系列'),
    docsUrl: 'https://www.minimaxi.com/document/T2A%20V2',
    notes: [
      '情绪（emotion）参数只有部分模型支持；不支持时会报参数错误，属于正常现象。',
      '音色复刻与声音设计需要额外接口（voice_cloning / voice_design），后续适配。',
    ],
    build: (ctx) => {
      const input = ctx.input as { text?: string };
      const streamEnabled =
        ctx.params.stream?.enabled === true && (ctx.params.stream.value === true || ctx.params.stream.value === 'true');
      const body: Record<string, unknown> = { model: ctx.model, text: input.text ?? '' };
      applyParams(body, TTS_PARAMS, ctx.params, ctx.model);
      body.stream = streamEnabled;
      return { method: 'POST', path: '/v1/t2a_v2', body, stream: streamEnabled };
    },
  },
  chatOperation({
    id: 'minimax.chat',
    providerId: 'minimax',
    title: 'MiniMax 对话',
    summary: '原生 /v1/chat/completions：M3.1 Flash 推理强度、M3 思考开关；temperature/top_p 固定，不展示无效旋钮。',
    path: '/v1/chat/completions',
    features: ['chat', 'reasoning', 'tools', 'vision'],
    models: ['MiniMax-M3.1-Flash', 'MiniMax-M3', 'MiniMax-M2', 'MiniMax-M1'],
    defaultModel: 'MiniMax-M3.1-Flash',
    params: CHAT_PARAMS,
    verification: {
      status: 'partial',
      date: '2026-10-22',
      source: DOCS,
      note: '真实 M3.1-Flash SSE、low、reasoning_split、输出上限与用量通过；返回 1 个推理 Token 但无推理正文，不冒称推理正文验证。第二账户成功，第一账户余额不足。其他模型/工具/视觉未实测。证据 docs/text-verification.json。',
    },
    extend: (body, ctx) => {
      if (ctx.model === 'MiniMax-M3.1-Flash' && body.reasoning_split === false)
        throw new Error('MiniMax-M3.1-Flash 不支持关闭 reasoning_split');
    },
    notes: [
      'Flash 始终思考；M3 可 disabled。max_completion_tokens 包括思考，过小可能没有最终正文。',
      '当前 M3 系列 temperature 固定 1、top_p 固定 0.95；旧模型仅保留供历史记录参考。',
    ],
    baseUrlIds: ['cn', 'cn-current', 'intl'],
    docsUrl: DOCS,
  }),
];
