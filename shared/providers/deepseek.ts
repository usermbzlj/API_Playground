import type { OperationDef, ParamSpec, ProviderDef, Verification } from '../types.ts';
import { LOGPROBS, RESPONSE_FORMAT, SAMPLING, TOOLS, TOOL_CHOICE, chatOperation, today } from './_common.ts';
import { applyParams } from '../util.ts';

const DOCS = 'https://api-docs.deepseek.com/';

/** 所有 DeepSeek 定义均来自官方文档；标 documented = 尚未用真实 Key 实测。 */
const V = (note?: string): Verification => ({
  status: 'documented',
  date: today,
  source: DOCS,
  note: note ?? '依据官方文档定义；尚未使用真实 Key 实测',
});

export const deepseekProvider: ProviderDef = {
  id: 'deepseek',
  name: 'DeepSeek',
  kind: 'official',
  description:
    'DeepSeek 官方 API（OpenAI 兼容）。特色能力：FIM 中间补全（Beta）、对话前缀续写（Beta）、Logprobs、上下文硬盘缓存、v4 / flash 系列模型。',
  baseUrls: [
    { id: 'official', label: '官方站', url: 'https://api.deepseek.com', note: '国内可直接访问' },
    {
      id: 'beta',
      label: 'Beta 端点',
      url: 'https://api.deepseek.com/beta',
      note: 'FIM / 前缀续写等 Beta 功能需要（官方文档要求）',
    },
  ],
  auth: { type: 'bearer' },
  docsUrl: DOCS,
  consoleUrl: 'https://platform.deepseek.com/api_keys',
  pricingUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
  modelsPath: '/models',
  highlights: ['FIM 中间补全', '前缀续写', 'Logprobs', '缓存命中计费透明', 'v4 / flash 模型系列'],
  notes: [
    'usage 中会分别返回 prompt_cache_hit_tokens / prompt_cache_miss_tokens，可用来观察上下文缓存是否生效。',
    '官方文档示例中的模型名为 deepseek-v4-pro / deepseek-flash；历史上曾用 deepseek-chat / deepseek-reasoner。模型名更新频繁，以 /models 端点或控制台为准。',
    'Beta 功能（FIM、前缀续写）按官方文档要求使用 https://api.deepseek.com/beta 端点。',
  ],
  models: [
    {
      id: 'deepseek-v4-pro',
      label: 'deepseek-v4-pro',
      context: 1000000,
      modalities: ['text-in', 'text-out'],
      notes: '官方文档当前示例模型',
      verification: V('官方文档（2026-10 检索）示例使用该模型名'),
    },
    {
      id: 'deepseek-flash',
      label: 'deepseek-flash',
      context: 1000000,
      modalities: ['text-in', 'text-out'],
      verification: V('官方文档示例出现的模型名，定位以官网为准'),
    },
    {
      id: 'deepseek-chat',
      label: 'DeepSeek Chat（旧别名）',
      context: 128000,
      modalities: ['text-in', 'text-out'],
      notes: '历史别名，曾指向 V3 系列非思考模型',
      verification: { status: 'unverified', date: today, note: '旧版本文档模型名，当前是否仍可用需实测' },
    },
    {
      id: 'deepseek-reasoner',
      label: 'DeepSeek Reasoner（旧别名）',
      context: 128000,
      modalities: ['text-in', 'text-out'],
      notes: '历史别名，思考模型；输出 reasoning_content',
      verification: { status: 'unverified', date: today, note: '旧版本文档模型名，当前是否仍可用需实测' },
    },
  ],
};

const CHAT_PARAMS: ParamSpec[] = [
  ...SAMPLING.filter((p) => p.key !== 'seed').map((p) =>
    p.key === 'max_tokens' ? { ...p, max: 393216, enabledByDefault: true } : p,
  ),
  {
    key: 'thinking.type',
    label: '思考开关',
    type: 'enum',
    options: [{ value: 'enabled' }, { value: 'disabled' }],
    default: 'enabled',
    enabledByDefault: true,
    native: true,
    group: '思考',
    verification: V(),
  },
  {
    key: 'reasoning_effort',
    label: '推理强度',
    type: 'enum',
    options: ['low', 'high', 'max'].map((value) => ({ value })),
    default: 'high',
    native: true,
    group: '思考',
    verification: V(),
  },
  RESPONSE_FORMAT,
  ...LOGPROBS.map((p) => ({
    ...p,
    models: 'deepseek-(chat|flash|v4-pro)',
    verification: V('官方文档：logprobs 仅部分模型支持'),
  })),
  TOOLS,
  TOOL_CHOICE,
];

const FIM_PARAMS: ParamSpec[] = [
  {
    key: 'max_tokens',
    label: 'max_tokens',
    type: 'integer',
    min: 1,
    max: 4096,
    default: 256,
    group: '长度',
    description: '官方文档：FIM 最大补全 4K tokens',
  },
  { key: 'temperature', label: 'temperature', type: 'number', min: 0, max: 2, step: 0.05, default: 0.2, group: '采样' },
  { key: 'top_p', label: 'top_p', type: 'number', min: 0, max: 1, step: 0.01, default: 1, group: '采样' },
  { key: 'stop', label: 'stop', type: 'string-list', default: [], group: '长度', advanced: true },
];

export const deepseekOps: OperationDef[] = [
  chatOperation({
    id: 'deepseek.chat',
    providerId: 'deepseek',
    title: 'DeepSeek 对话',
    summary: 'OpenAI 兼容 /chat/completions。支持对话前缀续写（最后一条 assistant 消息带 prefix: true）与 Logprobs。',
    path: '/chat/completions',
    features: ['chat', 'reasoning', 'prefix', 'logprobs', 'json-output', 'tools', 'cache'],
    models: ['deepseek-v4-pro', 'deepseek-flash', 'deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-flash',
    params: CHAT_PARAMS,
    verification: {
      status: 'partial',
      date: '2026-10-22',
      source: DOCS,
      note: '真实 deepseek-flash：HTTP JSON/Logprobs、SSE 思考、Beta 前缀与历史重放通过；其余模型、工具未实测。证据 docs/text-verification.json。',
    },
    build: { prefixStyle: 'deepseek', prefixPath: 'https://api.deepseek.com/beta/chat/completions' },
    extend: (body, ctx) => {
      // Tool reasoning must round-trip even if the generic history toggle is off.
      if (body.tools?.length) {
        const history = ((ctx.input.messages ?? []) as any[]).filter(
          (m: any) => m.role === 'assistant' && (m.content || m.tool_calls?.length),
        );
        const assistants = body.messages.filter((m: any) => m.role === 'assistant');
        history.forEach((m: any, i: number) => {
          if (m.reasoning_content && assistants[i]) assistants[i].reasoning_content = m.reasoning_content;
        });
      }
    },
    insights: ({ request, model }) => {
      const b = request?.body as any;
      if (!b) return [];
      const thinking = b.thinking?.type !== 'disabled';
      const notes: { level: 'warn' | 'info'; text: string }[] = [];
      if (thinking && ['temperature', 'presence_penalty', 'frequency_penalty'].some((k) => b[k] !== undefined))
        notes.push({ level: 'warn', text: 'DeepSeek 思考模式忽略 temperature 与频率/存在惩罚；传入不代表生效。' });
      if (b.top_p !== undefined)
        notes.push({
          level: 'info',
          text:
            model === 'deepseek-flash'
              ? 'Flash 的 top_p 仅思考模式生效，低于 0.95 按 0.95；非思考固定 1。'
              : 'V4 Pro 的 top_p 在思考模式被忽略；非思考模式才生效。',
        });
      return notes;
    },
    docsUrl: DOCS,
    notes: [
      '前缀续写：填写「Assistant 前缀」后，会以 { role: "assistant", content: 前缀, prefix: true } 作为最后一条消息发出，并按官方文档切换到 https://api.deepseek.com/beta 端点。',
      '当前默认思考模式 high；带 tools 时须回传历史 reasoning_content，本适配自动保留；不带 tools 时官方忽略历史推理。',
    ],
  }),
  {
    id: 'deepseek.fim',
    providerId: 'deepseek',
    title: 'DeepSeek FIM 中间补全',
    summary: 'Beta 接口 POST /beta/completions：分别传 prompt（前缀）与 suffix（后缀），补出中间缺失部分。',
    features: ['fim'],
    workbench: 'fim',
    lifecycle: 'sse',
    models: ['deepseek-v4-pro', 'deepseek-flash', 'deepseek-chat'],
    defaultModel: 'deepseek-flash',
    protocol: 'openai-completion',
    params: FIM_PARAMS,
    costTier: 'low',
    verification: {
      status: 'partial',
      date: '2026-10-22',
      source: 'https://api-docs.deepseek.com/guides/fim_completion/',
      note: '真实 deepseek-flash Beta FIM SSE 补全与用量/记录恢复通过；其他模型未实测。证据 docs/text-verification.json。',
    },
    docsUrl: 'https://api-docs.deepseek.com/guides/fim_completion',
    notes: [
      '请求体为 OpenAI completions 格式：{ model, prompt, suffix, max_tokens, ... }，无需手工拼接特殊 Token。',
      '与「对话前缀续写」的区别：FIM 同时给前后文，模型只生成中间部分，常用于代码补全插件。',
    ],
    build: (ctx) => {
      const input = ctx.input as { prefix?: string; suffix?: string; stream?: boolean };
      const stream = input.stream !== false;
      const body: Record<string, unknown> = {
        model: ctx.model,
        prompt: input.prefix ?? '',
        suffix: input.suffix ?? '',
      };
      applyParams(body, FIM_PARAMS, ctx.params, ctx.model);
      body.stream = stream;
      return { method: 'POST', path: '/beta/completions', body, stream };
    },
  },
];
