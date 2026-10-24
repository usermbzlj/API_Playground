import type { OperationDef, ParamSpec, ProviderDef } from '../types.ts';
import { chatOperation, RESPONSE_FORMAT, TOOLS } from './_common.ts';
import { applyParams } from '../util.ts';
import { documented, enumOptions } from './native-evidence.ts';

const DOC = 'https://mimo.mi.com/docs/en-US/api/chat';
const ASR = 'https://mimo.mi.com/docs/en-US/api/audio/Speech-Recognition';
const models = ['mimo-v2.6-flash', 'mimo-v2.6-pro', 'mimo-v2.6-pro-ultraspeed'];
export const mimoProvider: ProviderDef = {
  id: 'mimo',
  name: '小米 MiMo',
  kind: 'official',
  region: 'cn',
  description: '小米官方 API：思考开关、工具推理上下文与被服务端覆盖的采样参数。',
  baseUrls: [{ id: 'official', label: '官方', url: 'https://api.xiaomimimo.com' }],
  auth: { type: 'header', header: 'api-key' },
  keyEnv: ['MIMO_API_KEY'],
  docsUrl: DOC,
  consoleUrl: 'https://mimo.mi.com/',
  highlights: ['thinking.type', '推理上下文回传', 'max_completion_tokens', '参数生效诊断'],
  models: [
    ...models.map((id) => ({ id, modalities: ['text-in', 'text-out'], verification: documented(DOC) })),
    { id: 'mimo-v2.5-asr', modalities: ['audio-in', 'text-out'], verification: documented(ASR) },
  ],
  notes: [
    '只声明已适配的文本与专用 ASR；模型的全模态理论能力不等于文本操作已实现音视频输入。',
    'tool_choice 当前仅 auto 生效，其他值被后端移除，本适配不提供失效的强制选择。',
    '官方模型目录注明 mimo-v2.5 与 mimo-v2.5-pro 文本模型已于 2026-10-21 下线，默认列表已移除；专用 mimo-v2.5-asr 是独立模型。',
  ],
};
const params: ParamSpec[] = [
  {
    key: 'thinking.type',
    label: '思考开关',
    type: 'enum',
    options: enumOptions(['enabled', 'disabled']),
    default: 'enabled',
    enabledByDefault: true,
    native: true,
    group: '思考',
  },
  {
    key: 'max_completion_tokens',
    label: '总输出上限（含思考）',
    type: 'integer',
    min: 1,
    max: 131072,
    default: 2048,
    enabledByDefault: true,
    group: '长度',
  },
  {
    key: 'temperature',
    label: 'temperature（仅非思考生效）',
    type: 'number',
    min: 0,
    max: 1.5,
    default: 0.6,
    step: 0.1,
    group: '采样',
    description: '思考模式即使传入也会被官方服务覆盖为 1.0。',
  },
  {
    key: 'top_p',
    label: 'top_p（仅非思考生效）',
    type: 'number',
    min: 0.01,
    max: 1,
    default: 0.95,
    step: 0.01,
    group: '采样',
    description: '思考模式固定 0.95。',
  },
  RESPONSE_FORMAT,
  TOOLS,
];
const asrParams: ParamSpec[] = [
  {
    key: 'asr_options.language',
    label: '识别语言',
    type: 'enum',
    options: enumOptions(['auto', 'zh', 'en']),
    default: 'auto',
    enabledByDefault: true,
    native: true,
    group: '识别',
    description: '明确语言时建议手动选择；支持中文方言、混合背景声与歌词场景。',
  },
];
export const mimoOps: OperationDef[] = [
  chatOperation({
    id: 'mimo.chat',
    providerId: 'mimo',
    title: 'MiMo 思考参数实验',
    path: '/v1/chat/completions',
    models,
    defaultModel: 'mimo-v2.6-flash',
    summary: '保留原生 thinking.type、reasoning_content 和 max_completion_tokens；主动指出采样参数被覆盖的情况。',
    features: ['chat', 'reasoning', 'reasoning-history', 'tools', 'json-output', 'cache'],
    params,
    build: { includeUsage: false },
    verification: {
      status: 'partial',
      date: '2026-10-22',
      source: DOC,
      note: '真实 mimo-v2.6-flash 非思考 HTTP 与思考 SSE、推理正文、用量与输入恢复通过；其他模型/工具未实测。证据 docs/text-verification.json。',
    },
    docsUrl: DOC,
    insights: ({ request }) => {
      const b = request?.body as any;
      return b?.thinking?.type !== 'disabled' && (b?.temperature !== undefined || b?.top_p !== undefined)
        ? [{ level: 'warn', text: 'MiMo 思考模式会把 temperature/top_p 覆盖为 1.0/0.95；本次传入值不代表实际生效。' }]
        : [{ level: 'info', text: '工具思考跨轮建议保留 reasoning_content；请使用“保留推理上下文”并检查原始请求。' }];
    },
    notes: [
      '思考模式的 temperature/top_p 固定为 1.0/0.95。非思考模式才可调采样。',
      'max_completion_tokens 包括可见回复和思考；过低时可能只有推理而无最终正文。',
    ],
  }),
  {
    id: 'mimo.asr',
    providerId: 'mimo',
    title: 'MiMo 原生音频转写',
    summary: '专用 ASR 模型使用 input_audio 数据块与 asr_options；支持中文方言和语言指定。',
    features: ['asr'],
    workbench: 'asr',
    lifecycle: 'http',
    protocol: 'openai-chat',
    models: ['mimo-v2.5-asr'],
    defaultModel: 'mimo-v2.5-asr',
    inputFields: ['audio'],
    inputHints: {
      audio: '仅 WAV / MP3；Base64 编码后的数据不超过 10 MB（原文件约 7.5 MB）。上传真实文件，不能仅提供公网 URL。',
    },
    params: asrParams,
    costTier: 'medium',
    costHint: '专用语音识别会产生音频用量；未核验当前账户价格。',
    docsUrl: ASR,
    verification: documented(ASR),
    build: (ctx) => {
      const body: any = {
        model: ctx.model,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'input_audio',
                input_audio: { data: ctx.input.audio ? { $asset: String(ctx.input.audio), as: 'dataUrl' } : '' },
              },
            ],
          },
        ],
        stream: false,
      };
      applyParams(body, asrParams, ctx.params, ctx.model);
      return { method: 'POST', path: '/v1/chat/completions', body };
    },
    notes: [
      '保留原生 usage.seconds、audio_tokens 等字段；不把音频时长用猜测换算成费用。',
      '此处使用单次 HTTP 获取最终转写；音频不能由文本模拟。',
    ],
  },
];
