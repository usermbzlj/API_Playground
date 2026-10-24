import type { BuildContext, OperationDef, ParamSpec, ProviderDef } from '../types.ts';
import { applyParams } from '../util.ts';
import { documented, enumOptions } from './native-evidence.ts';

const ASR = 'https://developers.openai.com/api/docs/guides/speech-to-text';
const REALTIME = 'https://developers.openai.com/api/docs/guides/voice-websockets?voice-api=realtime';
export const openaiNativeProvider: ProviderDef = {
  id: 'openai',
  name: 'OpenAI 原生音频',
  kind: 'official',
  region: 'global',
  description: '文件转写与 Realtime 双向语音的原生接口；国际账户、可用地区及计费条件需单独确认。',
  baseUrls: [{ id: 'official', label: '官方', url: 'https://api.openai.com' }],
  auth: { type: 'bearer' },
  keyEnv: ['OPENAI_API_KEY'],
  docsUrl: REALTIME,
  consoleUrl: 'https://platform.openai.com/api-keys',
  pricingUrl: 'https://developers.openai.com/api/docs/pricing',
  modelsPath: '/v1/models',
  highlights: ['原生 multipart 转写', '24kHz PCM 双向音频', '服务端 VAD 与打断', 'WebSocket 事件观察'],
  models: [
    { id: 'gpt-transcribe', modalities: ['audio-in', 'text-out'], verification: documented(ASR) },
    {
      id: 'gpt-realtime-2.1',
      modalities: ['audio-in', 'text-in', 'audio-out', 'text-out'],
      verification: documented(REALTIME),
    },
  ],
  notes: [
    '依据 2026-10-22 official OpenAI documentation，文件转写使用当前 gpt-transcribe；旧 Whisper/4o 转写模型已在文档标记弃用。',
    '普通文本可使用既有通用 OpenAI 协议入口，本条目只声明已经适配的原生音频能力。',
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
];
