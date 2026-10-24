import type { OperationDef, ParamSpec, ProviderDef } from '../types.ts';
import { chatOperation, RESPONSE_FORMAT, TOOLS } from './_common.ts';
import { documented, enumOptions } from './native-evidence.ts';

const DOC = 'https://platform.kimi.ai/docs/guide/use-thinking-models';
const EFFORT = 'https://platform.kimi.ai/docs/guide/use-reasoning-effort';
export const kimiProvider: ProviderDef = {
  id: 'kimi',
  name: 'Kimi / Moonshot',
  kind: 'official',
  region: 'cn',
  description: 'Kimi 官方原生推理实验：K3 推理强度、K2.6 思考开关与 Preserved Thinking。',
  baseUrls: [
    { id: 'cn', label: '国内站', url: 'https://api.moonshot.cn', note: '国内控制台 Key；请确认该账户开放的模型。' },
    {
      id: 'global',
      label: '国际站',
      url: 'https://api.moonshot.ai',
      note: '当前英文文档示例；Key 与国内站账户可能不通用。',
    },
  ],
  auth: { type: 'bearer' },
  docsUrl: DOC,
  consoleUrl: 'https://platform.moonshot.cn/console/api-keys',
  keyEnv: ['MOONSHOT_API_KEY'],
  modelsPath: '/v1/models',
  highlights: ['K3 low / high / max', 'K2.6 思考开关', '保留跨轮推理内容', '原生工具参数'],
  notes: [
    '原 moonshot.ai 文档已迁移到 platform.kimi.ai；模型名和参数按 2026-10-22 官方文档核对。',
    '工具声明只触发模型生成调用；本地不会自动执行外部函数。',
  ],
  models: [
    {
      id: 'kimi-k3',
      modalities: ['text-in', 'image-in', 'text-out'],
      capabilities: ['reasoning', 'reasoning-history', 'tools', 'vision'],
      verification: documented(EFFORT),
    },
    {
      id: 'kimi-k2.6',
      modalities: ['text-in', 'image-in', 'text-out'],
      capabilities: ['reasoning', 'reasoning-history', 'tools', 'vision'],
      verification: documented(DOC),
    },
  ],
};
const common: ParamSpec[] = [
  {
    key: 'max_tokens',
    label: '输出上限（含思考）',
    type: 'integer',
    min: 1,
    default: 2048,
    enabledByDefault: true,
    group: '长度',
  },
  TOOLS,
  RESPONSE_FORMAT,
];
export const kimiOps: OperationDef[] = [
  chatOperation({
    id: 'kimi.k3',
    providerId: 'kimi',
    title: 'Kimi K3 推理强度与跨轮思考',
    path: '/v1/chat/completions',
    summary: '原生 reasoning_effort=low/high/max；思考始终开启，完整保留前轮 reasoning_content。',
    models: ['kimi-k3'],
    defaultModel: 'kimi-k3',
    features: ['chat', 'reasoning', 'reasoning-history', 'tools', 'vision', 'json-output'],
    params: [
      ...common,
      {
        key: 'reasoning_effort',
        label: '推理强度',
        type: 'enum',
        options: enumOptions(['low', 'high', 'max']),
        default: 'low',
        enabledByDefault: true,
        native: true,
        group: '思考',
        verification: documented(EFFORT),
      },
    ],
    verification: documented(EFFORT),
    docsUrl: EFFORT,
    build: { includeUsage: true },
    extend: (body, ctx) => {
      // K3's preserved thinking is always active. Never silently discard a supplied history.
      const histories = ((ctx.input.messages ?? []) as any[]).filter(
        (m) => m.role === 'assistant' && (m.content || m.tool_calls?.length),
      );
      const targets = body.messages.filter((m: any) => m.role === 'assistant');
      histories.forEach((m, i) => {
        if (m.reasoning_content && targets[i]) targets[i].reasoning_content = m.reasoning_content;
      });
    },
    notes: [
      'K3 不接受 K2.x 的 thinking 开关。low 仍会思考；没有“不思考”档位。',
      '工具调用后继续时必须保留模型实际返回的 reasoning_content；没有返回的内容不能伪造。',
    ],
  }),
  chatOperation({
    id: 'kimi.k26',
    providerId: 'kimi',
    title: 'Kimi K2.6 思考开关 / Preserved Thinking',
    path: '/v1/chat/completions',
    summary: '独立控制 thinking.type 与 thinking.keep，观察跨轮推理延续。',
    models: ['kimi-k2.6'],
    defaultModel: 'kimi-k2.6',
    features: ['chat', 'reasoning', 'reasoning-history', 'tools', 'vision', 'json-output'],
    params: [
      ...common,
      {
        key: 'thinking.type',
        label: '思考开关',
        type: 'enum',
        options: enumOptions(['enabled', 'disabled']),
        default: 'enabled',
        enabledByDefault: true,
        group: '思考',
        native: true,
      },
      {
        key: 'thinking.keep',
        label: '保留历史思考',
        type: 'enum',
        options: enumOptions(['all']),
        default: 'all',
        group: '思考',
        native: true,
        description: '启用后设置 keep=all，并完整回传已有 reasoning_content。关闭时不发送此字段（服务端默认 null）。',
      },
    ],
    verification: {
      status: 'partial',
      date: '2026-10-22',
      source: DOC,
      note: '真实 kimi-k2.6 disabled HTTP/SSE、用量与输入恢复通过；思考、跨轮推理、工具与视觉未实测。证据 docs/text-verification.json。',
    },
    docsUrl: DOC,
    extend: (body, ctx) => {
      if (body.thinking?.keep === 'all') {
        const source = (ctx.input.messages ?? []) as any[];
        const histories = source.filter((m) => m.role === 'assistant' && (m.content || m.tool_calls?.length));
        const targets = body.messages.filter((m: any) => m.role === 'assistant');
        histories.forEach((m, i) => {
          if (m.reasoning_content && targets[i]) targets[i].reasoning_content = m.reasoning_content;
        });
      }
    },
    notes: [
      '不提供 temperature/top_p 调节：当前模型由服务端固定采样。',
      'thinking.keep 未启用时，是否回传历史内容仍可通过实验台的“保留推理上下文”控制，便于观察差异。',
    ],
  }),
];
