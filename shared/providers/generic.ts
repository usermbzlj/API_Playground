// Generic adapters: try any vendor that speaks a common protocol before it gets a native adapter.
// The connection supplies the base URL; models are typed in or pulled from the vendor's /models.
import type { OperationDef, ParamSpec, ProviderDef } from '../types.ts';
import { applyParams } from '../util.ts';
import {
  ANTHROPIC_PARAMS,
  LOGPROBS,
  PARALLEL_TOOL_CALLS,
  RESPONSE_FORMAT,
  SAMPLING,
  TOOLS,
  TOOL_CHOICE,
  anthropicOperation,
  chatOperation,
  embeddingOperation,
  rerankOperation,
  today,
} from './_common.ts';

const G = {
  status: 'unverified' as const,
  date: today,
  note: '通用协议适配：能否工作取决于目标服务对该协议的兼容程度',
};

export const customOpenAIProvider: ProviderDef = {
  id: 'custom-openai',
  name: '自定义 · OpenAI 兼容',
  kind: 'generic',
  generic: true,
  description:
    '任意兼容 OpenAI 接口的服务（小众厂商、自建 vLLM / SGLang / Ollama、企业网关）。Base URL 填到 /v1 这一级，例如 https://api.example.com/v1。适合在专门适配之前先试一试。',
  baseUrls: [{ id: 'custom', label: '自定义', url: 'https://api.example.com/v1', note: '添加连接时填写真实地址' }],
  auth: {
    type: 'bearer',
    extraFields: [
      { key: 'authHeader', label: '鉴权 Header 名', placeholder: '默认 Authorization（Bearer），也可填 x-api-key 等' },
      { key: 'authPrefix', label: 'Header 值前缀', placeholder: '默认 "Bearer "；填 none 表示无前缀' },
    ],
  },
  modelsPath: '/models',
  models: [],
  highlights: ['任意 OpenAI 兼容端点', '自动拉取模型列表', '保留厂商返回的非标准字段'],
  notes: ['兼容层通常只实现了一部分参数：未被支持的参数可能被静默忽略，结果区的「洞察」会提示可疑之处。'],
};

export const customAnthropicProvider: ProviderDef = {
  id: 'custom-anthropic',
  name: '自定义 · Anthropic 兼容',
  kind: 'generic',
  generic: true,
  description:
    '任意兼容 Anthropic Messages 接口的服务。许多国内厂商为 Claude Code 等工具提供了 Anthropic 兼容端点，可以用它对照同一模型在两种协议下的行为差异。Base URL 填到 /v1/messages 之前的部分。',
  baseUrls: [
    { id: 'custom', label: '自定义', url: 'https://api.example.com/anthropic', note: '添加连接时填写真实地址' },
  ],
  auth: {
    type: 'header',
    header: 'x-api-key',
    staticHeaders: { 'anthropic-version': '2023-06-01' },
    extraFields: [
      { key: 'authHeader', label: '鉴权 Header 名', placeholder: '默认 x-api-key；部分兼容端点要求 Authorization' },
      { key: 'authPrefix', label: 'Header 值前缀', placeholder: '默认无前缀；Authorization 时通常填 "Bearer "' },
    ],
  },
  models: [],
  highlights: ['Messages 协议', 'thinking / tool_use 内容块', '与 OpenAI 兼容端点对照'],
};

const COMPLETION_PARAMS: ParamSpec[] = [
  { key: 'max_tokens', label: 'max_tokens', type: 'integer', min: 1, default: 256, group: '长度' },
  { key: 'temperature', label: 'temperature', type: 'number', min: 0, max: 2, step: 0.05, default: 0.2, group: '采样' },
  { key: 'stop', label: 'stop', type: 'string-list', default: [], group: '长度', advanced: true },
  {
    key: 'logprobs',
    label: 'logprobs',
    type: 'integer',
    min: 0,
    max: 20,
    default: 5,
    group: 'Token 概率',
    advanced: true,
    description: 'completions 接口里 logprobs 是整数（候选数）',
  },
];

export const genericOps: OperationDef[] = [
  chatOperation({
    id: 'custom-openai.chat',
    providerId: 'custom-openai',
    title: '通用对话（OpenAI 兼容）',
    summary: 'POST {Base URL}/chat/completions。流式、工具、结构化输出、Logprobs 是否可用取决于目标服务。',
    path: '/chat/completions',
    features: ['chat', 'tools', 'json-output', 'logprobs', 'vision'],
    params: [...SAMPLING, RESPONSE_FORMAT, ...LOGPROBS, TOOLS, TOOL_CHOICE, PARALLEL_TOOL_CALLS],
    verification: G,
  }),
  {
    id: 'custom-openai.completion',
    providerId: 'custom-openai',
    title: '通用文本续写 / FIM（OpenAI completions）',
    summary: 'POST {Base URL}/completions：传 prompt（可选 suffix）。支持 suffix 的服务即可做中间补全。',
    features: ['fim'],
    workbench: 'fim',
    lifecycle: 'sse',
    freeModel: true,
    protocol: 'openai-completion',
    params: COMPLETION_PARAMS,
    costTier: 'low',
    verification: G,
    build: (ctx) => {
      const input = ctx.input as { prefix?: string; suffix?: string; stream?: boolean };
      const stream = input.stream !== false;
      const body: Record<string, unknown> = { model: ctx.model, prompt: input.prefix ?? '' };
      if (input.suffix) body.suffix = input.suffix;
      applyParams(body, COMPLETION_PARAMS, ctx.params, ctx.model);
      body.stream = stream;
      return { method: 'POST', path: '/completions', body, stream };
    },
  },
  embeddingOperation({
    id: 'custom-openai.embedding',
    providerId: 'custom-openai',
    title: '通用向量（OpenAI embeddings）',
    path: '/embeddings',
    verification: G,
  }),
  rerankOperation({
    id: 'custom-openai.rerank',
    providerId: 'custom-openai',
    title: '通用重排（/rerank，Jina / Cohere 风格）',
    path: '/rerank',
    verification: G,
  }),
  anthropicOperation({
    id: 'custom-anthropic.messages',
    providerId: 'custom-anthropic',
    title: '通用 Messages（Anthropic 兼容）',
    summary: 'POST {Base URL}/v1/messages。观察 thinking / text / tool_use 内容块如何按顺序流式返回。',
    features: ['chat', 'reasoning', 'tools', 'anthropic-compat'],
    params: ANTHROPIC_PARAMS,
    verification: G,
  }),
];
