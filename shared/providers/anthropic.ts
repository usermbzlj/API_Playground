import type { OperationDef, ParamSpec, ProviderDef } from '../types.ts';
import { buildAnthropicMessages, type ChatInput } from './_common.ts';
import { applyParams } from '../util.ts';
import { documented, enumOptions } from './native-evidence.ts';

// Anthropic 官方 Messages API。与 generic.ts 里的「Anthropic 兼容」入口不同：
// 这里核对的是 2026-10-21 之后的官方语义——采样参数被移除、思考改为 adaptive、
// 预填 assistant 结尾被拒绝、5.5 系列拒绝强制 tool_choice。兼容端点不要照搬这些限制。
const MESSAGES = 'https://platform.claude.com/docs/en/api/messages/create';
const MODELS = 'https://platform.claude.com/docs/en/models/overview';
const THINKING = 'https://platform.claude.com/docs/en/build-with-claude/thinking';
const CACHING = 'https://platform.claude.com/docs/en/build-with-claude/prompt-caching';
const EFFORT = 'https://platform.claude.com/docs/en/build-with-claude/effort';

const textModels = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5（默认，medium effort）' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-5-5', label: 'Claude Haiku 5.5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1（受限开放）' },
];

export const anthropicProvider: ProviderDef = {
  id: 'anthropic',
  name: 'Anthropic Claude',
  kind: 'official',
  region: 'global',
  description:
    'Claude 官方 Messages API：自适应思考、输出 effort、prompt caching、工具与签名回传。与 Anthropic 兼容入口分开记录，不混用两套参数语义。',
  baseUrls: [{ id: 'official', label: '官方', url: 'https://api.anthropic.com' }],
  auth: {
    type: 'header',
    header: 'x-api-key',
    staticHeaders: { 'anthropic-version': '2023-06-01' },
  },
  keyEnv: ['ANTHROPIC_API_KEY'],
  docsUrl: MESSAGES,
  consoleUrl: 'https://console.anthropic.com/',
  pricingUrl: 'https://platform.claude.com/docs/en/about-claude/pricing',
  modelsPath: '/v1/models',
  highlights: ['adaptive thinking', 'output_config.effort', 'prompt caching', 'tool_use / thinking 签名回传'],
  models: textModels.map(({ id, label }) => ({
    id,
    label,
    developer: 'Anthropic',
    context: 1_000_000,
    modalities: ['text-in', 'image-in', 'text-out'],
    capabilities: ['chat', 'reasoning', 'reasoning-history', 'tools', 'json-output', 'cache', 'vision'],
    verification: documented(MODELS),
  })),
  notes: [
    '2026-10-21 起，官方 Messages API 在任何模型上发送 temperature / top_p / top_k 都会返回 400；此适配不提供这三个旋钮。',
    '思考默认由模型自适应；display=summarized 才返回可读摘要，signature 必须原样回传。',
    'Claude 4.6 及以后拒绝预填 assistant 结尾；5.5 系列拒绝 tool_choice any/tool。兼容端点可能仍接受这些旧写法。',
  ],
};

const anthropicParams: ParamSpec[] = [
  {
    key: 'max_tokens',
    label: 'max_tokens（含思考）',
    type: 'integer',
    min: 1,
    max: 128_000,
    default: 4096,
    enabledByDefault: true,
    group: '长度',
    description: 'Messages API 必填，包含思考与正文的硬上限。',
  },
  {
    key: 'thinking',
    label: '自适应思考',
    type: 'json',
    default: { type: 'adaptive', display: 'summarized' },
    group: '思考',
    native: true,
    description:
      '当前 5.x 模型只接受 adaptive；display 可为 summarized / omitted。enabled + budget_tokens 是旧模型写法，这里会明确拒绝。',
  },
  {
    key: 'output_config.effort',
    label: 'effort 档位',
    type: 'enum',
    options: enumOptions(['low', 'medium', 'high', 'xhigh', 'max']),
    default: 'high',
    group: '思考',
    native: true,
    description: '启用后覆盖模型默认。不影响缓存命中时请保持同一档位；Opus 5.5 / Haiku 5.5 默认 medium。',
  },
  {
    key: 'cache_control',
    label: '自动前缀缓存',
    type: 'json',
    default: { type: 'ephemeral' },
    group: '缓存',
    native: true,
    description: '顶层自动缓存：最后可缓存块及其前缀命中缓存。可改为 {type:"ephemeral", ttl:"1h"}。',
  },
  {
    key: 'tools',
    label: '工具声明',
    type: 'json',
    default: [
      {
        name: 'get_weather',
        description: '查询城市天气',
        input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    ],
    group: '工具',
    description: 'Anthropic 原生 input_schema 格式。工具结果由用户填写，不自动执行本地函数。',
  },
  {
    key: 'tool_choice',
    label: 'tool_choice',
    type: 'json',
    default: { type: 'auto' },
    group: '工具',
    advanced: true,
    description: '5.5 系列只接受 auto；any/tool 会被官方拒绝。',
  },
  {
    key: 'output_config.format',
    label: '结构化输出',
    type: 'json',
    default: {
      type: 'json_schema',
      schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    },
    group: '输出格式',
    native: true,
    description: '官方 output_config.format；与启用思考可同时使用，具体支持范围以模型页为准。',
  },
  {
    key: 'stop_sequences',
    label: '停止序列',
    type: 'string-list',
    default: [],
    group: '长度',
    advanced: true,
  },
  {
    key: 'metadata',
    label: 'metadata',
    type: 'json',
    default: { user_id: 'prismlab-local' },
    group: '追踪',
    advanced: true,
  },
];

const forcedChoiceModels = /^claude-(?:opus|sonnet)-5-5$|^claude-fable-5-1$/;

export const anthropicOps: OperationDef[] = [
  {
    id: 'anthropic.messages',
    providerId: 'anthropic',
    title: 'Claude 原生 Messages · 自适应思考',
    summary:
      '官方 Messages API：自适应思考与 effort、prompt caching、工具调用与 thinking 签名回传；不使用已被移除的采样参数。',
    features: ['chat', 'reasoning', 'reasoning-history', 'tools', 'json-output', 'cache'],
    workbench: 'chat',
    lifecycle: 'sse',
    protocol: 'anthropic-messages',
    models: textModels.map((m) => m.id),
    defaultModel: 'claude-opus-5-5',
    freeModel: true,
    params: anthropicParams,
    costTier: 'medium',
    costHint: 'Opus 5.5 官方价 $4 / $20 每百万输入/输出 Token；Fable 5.1 为 $10 / $50。未核验账户折扣与实际账单。',
    verification: documented(MESSAGES, '2026-10-25 核对官方文档；未使用真实 Key 调用，账户权限和计费待确认'),
    docsUrl: MESSAGES,
    build: (ctx) => {
      const input = ctx.input as unknown as ChatInput;
      if (input.prefix?.trim())
        throw new Error('Claude 4.6 及以后拒绝预填 assistant 结尾（prefill），请改用提示词约束输出格式。');
      const stream = input.stream !== false;
      const { system, messages } = buildAnthropicMessages(input);
      const body: any = { model: ctx.model, messages, max_tokens: 4096 };
      if (system) body.system = system;
      applyParams(body, anthropicParams, ctx.params, ctx.model);
      const thinking = body.thinking;
      if (thinking && !['adaptive', 'enabled', 'disabled', 'between_tools'].includes(thinking.type))
        throw new Error('thinking.type 只能是 adaptive / enabled / disabled / between_tools');
      if (thinking?.type === 'enabled')
        throw new Error('当前官方模型只支持 adaptive thinking；budget_tokens 写法在 4.7/5.x 返回 400。');
      if (thinking?.type === 'between_tools' && ctx.model !== 'claude-sonnet-5-5')
        throw new Error('between_tools 目前仅 Sonnet 5.5 支持。');
      if (thinking?.type === 'disabled' && /opus-5-5|sonnet-5-5|fable-5-1/.test(ctx.model))
        throw new Error('该模型不接受关闭思考；请用 output_config.effort 降低思考深度。');
      const effort = body.output_config?.effort;
      if (thinking?.type === 'disabled' && (effort === 'xhigh' || effort === 'max'))
        throw new Error('关闭思考时 effort 不能是 xhigh / max。');
      if (thinking?.type === 'between_tools' && (effort === 'xhigh' || effort === 'max'))
        throw new Error('between_tools 只支持 low / medium / high effort。');
      const choice = body.tool_choice;
      if (choice && ['any', 'tool'].includes(choice.type) && forcedChoiceModels.test(ctx.model))
        throw new Error(`${ctx.model} 拒绝强制 tool_choice；请使用 auto，并在提示词里说明何时调用工具。`);
      body.stream = stream;
      return { method: 'POST', path: '/v1/messages', body, stream };
    },
    notes: [
      'temperature / top_p / top_k 自 2026-10-21 版 API 起在官方模型上出现即 400，本适配有意不展示。',
      '缓存命中看 usage.cache_read_input_tokens；写入看 cache_creation_input_tokens。缓存失效可能因为系统提示、工具或思考配置改变。',
      '工具回合需要把上一轮 thinking / redacted_thinking 块原样放在 assistant 消息开头；本项目保留原生 blocks。',
      '官方 5.x 的输出上限最高 128K；max_tokens 同时包含思考与正文。',
    ],
  },
];
