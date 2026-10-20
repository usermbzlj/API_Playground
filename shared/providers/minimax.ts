import type { ArtifactRef, OperationDef, ParamSpec, ProviderDef, Verification } from '../types.ts';
import { RESPONSE_FORMAT, SAMPLING, chatOperation, today } from './_common.ts';
import { applyParams } from '../util.ts';

const DOCS = 'https://www.minimaxi.com/document/';

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
    'MiniMax 官方 API。特色能力：多模型语音合成与情绪控制、声音设计/音色复刻、流式语音、Hailuo 视频生成；国内站与国际站域名与 Key 体系不同。',
  baseUrls: [
    { id: 'cn', label: '国内站', url: 'https://api.minimaxi.com', note: '国内控制台创建的 Key' },
    { id: 'intl', label: '国际站', url: 'https://api.minimax.io', note: '国际站 Key 与国内不通用' },
  ],
  auth: {
    type: 'bearer',
    extraFields: [{ key: 'GroupId', label: 'GroupId', placeholder: '视频等接口需要（控制台账户页查看）', required: false }],
  },
  docsUrl: DOCS,
  consoleUrl: 'https://www.minimaxi.com/user-center/basic-information',
  modelsPath: undefined,
  highlights: ['TTS 情绪与音色控制', '声音设计 / 音色复刻', '流式语音', 'Hailuo 视频生成', 'MiniMax-M2 模型'],
  notes: [
    '国内站（minimaxi.com）与国际站（minimax.io）的 API Key 不通用，选错域名会返回鉴权错误。',
    '视频生成（Hailuo）等接口需要 GroupId；语音合成 t2a_v2 不需要。',
  ],
  models: [
    { id: 'speech-02-turbo', label: 'speech-02-turbo', modalities: ['text-in', 'audio-out'], notes: 'TTS，延迟优先', verification: V() },
    { id: 'speech-02-hd', label: 'speech-02-hd', modalities: ['text-in', 'audio-out'], notes: 'TTS，质量优先', verification: V() },
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
  { key: 'voice_setting.voice_id', label: 'voice_id', type: 'string', default: 'male-qn-qingse', group: '音色', description: '系统预置音色 ID，或音色复刻得到的 voice_id' },
  { key: 'voice_setting.speed', label: '语速 speed', type: 'number', min: 0.5, max: 2, step: 0.1, default: 1, group: '音色' },
  { key: 'voice_setting.vol', label: '音量 vol', type: 'number', min: 0.1, max: 10, step: 0.1, default: 1, group: '音色', advanced: true },
  { key: 'voice_setting.pitch', label: '音调 pitch', type: 'integer', min: -12, max: 12, default: 0, group: '音色', advanced: true },
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
  { key: 'audio_setting.channel', label: '声道', type: 'enum', options: [{ value: 1 }, { value: 2 }], default: 1, group: '音频', advanced: true },
  {
    key: 'language_boost',
    label: 'language_boost',
    type: 'enum',
    options: ['auto', 'Chinese', 'English', 'Japanese', 'Korean', 'Russian', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Arabic'].map((v) => ({ value: v })),
    default: 'auto',
    group: '语言',
    advanced: true,
    description: '增强指定语言的发音表现',
  },
  { key: 'stream', label: '流式返回', type: 'boolean', default: false, group: '音频', description: '开启后音频分多段返回，可测量首包延迟' },
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
    features: ['tts', 'voice-design'],
    workbench: 'tts',
    lifecycle: 'http',
    models: ['speech-02-turbo', 'speech-02-hd', 'speech-01-turbo', 'speech-01-hd'],
    defaultModel: 'speech-02-turbo',
    stream: 'minimax-t2a',
    params: TTS_PARAMS,
    artifacts: ttsArtifacts,
    costTier: 'low',
    verification: V('hex 音频字段为 data.audio；官方文档示例模型为 speech-02 系列'),
    docsUrl: 'https://www.minimaxi.com/document/T2A%20V2',
    notes: [
      '情绪（emotion）参数只有部分模型支持；不支持时会报参数错误，属于正常现象。',
      '音色复刻与声音设计需要额外接口（voice_cloning / voice_design），后续适配。',
    ],
    build: (ctx) => {
      const input = ctx.input as { text?: string };
      const streamEnabled = ctx.params.stream?.enabled === true && (ctx.params.stream.value === true || ctx.params.stream.value === 'true');
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
    summary: 'OpenAI 兼容 /v1/text/chatcompletion_v2。注意国内站与国际站域名不同。',
    path: '/v1/text/chatcompletion_v2',
    features: ['chat'],
    models: ['MiniMax-M2', 'MiniMax-M1'],
    defaultModel: 'MiniMax-M2',
    params: [...SAMPLING, RESPONSE_FORMAT],
    verification: {
      status: 'unverified',
      date: today,
      note: '端点依据官方文档；模型名与参数支持以控制台可用列表为准，调用前请先确认',
    },
    baseUrlIds: ['cn', 'intl'],
    docsUrl: 'https://www.minimaxi.com/document/Platform%20introduction',
  }),
];
