import type {
  BuildContext,
  Insight,
  InsightContext,
  NativeRequest,
  OperationDef,
  ParamSpec,
  Verification,
} from '../types.ts';
import { applyParams, applyRequestParams } from '../util.ts';

export const today = '2026-10-21';

export interface ChatMessageInput {
  role: 'system' | 'developer' | 'user' | 'assistant' | 'tool';
  content: string;
  /** asset ids */
  images?: string[];
  videos?: string[];
  reasoning_content?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
  /** raw anthropic content blocks of an assistant turn (thinking signatures must round-trip) */
  blocks?: unknown[];
}

export interface ChatInput {
  system?: string;
  messages: ChatMessageInput[];
  /** assistant prefix for continuation */
  prefix?: string;
  stream?: boolean;
  /** keep reasoning_content of earlier assistant turns in the request */
  keepReasoning?: boolean;
}

export interface ChatBuildOptions {
  /** how assistant prefix continuation is expressed */
  prefixStyle?: 'deepseek' | 'partial' | 'none';
  /** where the system prompt goes */
  systemRole?: 'system' | 'developer';
  /** add stream_options.include_usage when streaming */
  includeUsage?: boolean;
  /** path used when an assistant prefix is set (e.g. a vendor beta endpoint) */
  prefixPath?: string;
  /** how videos are attached: OpenAI-compatible video_url part (Qwen / Kimi / GLM) */
  videoStyle?: 'video_url' | 'none';
}

export function buildChatMessages(input: ChatInput, opts: ChatBuildOptions = {}): any[] {
  const msgs: any[] = [];
  if (input.system?.trim()) msgs.push({ role: opts.systemRole ?? 'system', content: input.system });
  for (const m of input.messages ?? []) {
    if (m.role === 'assistant' && !m.content && !m.tool_calls?.length) continue;
    const out: any = { role: m.role };
    const media =
      m.role === 'user' ? [...(m.images ?? []), ...(opts.videoStyle === 'video_url' ? (m.videos ?? []) : [])] : [];
    if (media.length) {
      out.content = [
        ...(m.images ?? []).map((id) => ({ type: 'image_url', image_url: { url: { $asset: id, as: 'dataUrl' } } })),
        ...(opts.videoStyle === 'video_url' ? (m.videos ?? []) : []).map((id) => ({
          type: 'video_url',
          video_url: { url: { $asset: id, as: 'dataUrl' } },
        })),
        { type: 'text', text: m.content },
      ];
    } else {
      out.content = m.content;
    }
    if (m.role === 'assistant' && input.keepReasoning && m.reasoning_content)
      out.reasoning_content = m.reasoning_content;
    if (m.tool_calls?.length) out.tool_calls = m.tool_calls;
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id;
    if (m.name) out.name = m.name;
    msgs.push(out);
  }
  if (input.prefix && opts.prefixStyle && opts.prefixStyle !== 'none') {
    msgs.push(
      opts.prefixStyle === 'deepseek'
        ? { role: 'assistant', content: input.prefix, prefix: true }
        : { role: 'assistant', content: input.prefix, partial: true },
    );
  }
  return msgs;
}

/** Common OpenAI-style sampling params. Vendors add their native ones on top. */
export const SAMPLING: ParamSpec[] = [
  { key: 'temperature', label: 'temperature', type: 'number', min: 0, max: 2, step: 0.05, default: 0.7, group: '采样' },
  { key: 'top_p', label: 'top_p', type: 'number', min: 0, max: 1, step: 0.01, default: 1, group: '采样' },
  { key: 'max_tokens', label: 'max_tokens', type: 'integer', min: 1, default: 2048, group: '长度' },
  { key: 'stop', label: 'stop', type: 'string-list', default: [], group: '长度', advanced: true },
  {
    key: 'presence_penalty',
    label: 'presence_penalty',
    type: 'number',
    min: -2,
    max: 2,
    step: 0.1,
    default: 0,
    group: '采样',
    advanced: true,
  },
  {
    key: 'frequency_penalty',
    label: 'frequency_penalty',
    type: 'number',
    min: -2,
    max: 2,
    step: 0.1,
    default: 0,
    group: '采样',
    advanced: true,
  },
  { key: 'seed', label: 'seed', type: 'integer', group: '采样', advanced: true },
];

export const RESPONSE_FORMAT: ParamSpec = {
  key: 'response_format',
  label: 'response_format',
  type: 'json',
  default: { type: 'json_object' },
  description: '结构化输出。json_object 通常要求提示词中出现 "json" 字样。',
  group: '输出格式',
  advanced: true,
};

export const TOOLS: ParamSpec = {
  key: 'tools',
  label: 'tools',
  type: 'json',
  default: [
    {
      type: 'function',
      function: {
        name: 'get_weather',
        description: '查询城市天气',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string', description: '城市名' } },
          required: ['city'],
        },
      },
    },
  ],
  group: '工具',
  description: '函数声明（OpenAI 格式）。模型调用后，可在结果区填写工具返回值并继续对话。',
};

export const TOOL_CHOICE: ParamSpec = {
  key: 'tool_choice',
  label: 'tool_choice',
  type: 'enum',
  options: [{ value: 'auto' }, { value: 'none' }, { value: 'required' }],
  default: 'auto',
  group: '工具',
  advanced: true,
};

export const PARALLEL_TOOL_CALLS: ParamSpec = {
  key: 'parallel_tool_calls',
  label: 'parallel_tool_calls',
  type: 'boolean',
  default: true,
  group: '工具',
  advanced: true,
};

export const LOGPROBS: ParamSpec[] = [
  { key: 'logprobs', label: 'logprobs', type: 'boolean', default: true, group: 'Token 概率' },
  { key: 'top_logprobs', label: 'top_logprobs', type: 'integer', min: 0, max: 20, default: 5, group: 'Token 概率' },
];

export function V(source: string, note?: string, status: Verification['status'] = 'documented'): Verification {
  return {
    status,
    date: today,
    source,
    note: note ?? (status === 'documented' ? '依据官方文档定义，尚未用真实 Key 实测' : undefined),
  };
}

export function chatOperation(def: {
  id: string;
  providerId: string;
  title: string;
  path: string;
  summary?: string;
  features?: string[];
  params: ParamSpec[];
  models?: string[];
  defaultModel?: string;
  verification: Verification;
  build?: ChatBuildOptions;
  notes?: string[];
  docsUrl?: string;
  costTier?: OperationDef['costTier'];
  baseUrlIds?: string[];
  headers?: Record<string, string>;
  extend?: (body: any, ctx: BuildContext) => void;
  insights?: (ctx: InsightContext) => Insight[];
  estimateCost?: OperationDef['estimateCost'];
}): OperationDef {
  const opts = { includeUsage: true, ...def.build };
  return {
    id: def.id,
    providerId: def.providerId,
    title: def.title,
    summary: def.summary,
    features: def.features ?? ['chat'],
    workbench: 'chat',
    lifecycle: 'sse',
    models: def.models,
    defaultModel: def.defaultModel,
    freeModel: true,
    params: def.params,
    protocol: 'openai-chat',
    costTier: def.costTier ?? 'low',
    verification: def.verification,
    notes: def.notes,
    docsUrl: def.docsUrl,
    baseUrlIds: def.baseUrlIds,
    insights: def.insights,
    estimateCost: def.estimateCost,
    build: (ctx) => {
      const input = ctx.input as unknown as ChatInput;
      const stream = input.stream !== false;
      const body: any = { model: ctx.model, messages: buildChatMessages(input, opts) };
      applyParams(body, def.params, ctx.params, ctx.model);
      body.stream = stream;
      if (stream && opts.includeUsage && body.stream_options === undefined)
        body.stream_options = { include_usage: true };
      def.extend?.(body, ctx);
      const usePrefixPath = !!opts.prefixPath && !!input.prefix?.trim();
      const req: NativeRequest = {
        method: 'POST',
        path: usePrefixPath ? opts.prefixPath! : def.path,
        body,
        stream,
        headers: def.headers ? { ...def.headers } : undefined,
      };
      applyRequestParams(req, def.params, ctx.params, ctx.model);
      return req;
    },
  };
}

// ---------------------------------------------------------------- Anthropic Messages

export function buildAnthropicMessages(input: ChatInput): { system?: string; messages: any[] } {
  const messages: any[] = [];
  const push = (role: 'user' | 'assistant', blocks: any[]) => {
    const last = messages[messages.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else messages.push({ role, content: blocks });
  };
  for (const m of input.messages ?? []) {
    if (m.role === 'system' || m.role === 'developer') continue;
    if (m.role === 'tool') {
      push('user', [{ type: 'tool_result', tool_use_id: m.tool_call_id, content: m.content }]);
      continue;
    }
    if (m.role === 'assistant') {
      if (Array.isArray(m.blocks) && m.blocks.length) {
        push('assistant', m.blocks as any[]);
        continue;
      }
      const blocks: any[] = [];
      if (m.content) blocks.push({ type: 'text', text: m.content });
      for (const tc of (m.tool_calls ?? []) as any[]) {
        let args: any = {};
        try {
          args = JSON.parse(tc.function?.arguments || '{}');
        } catch {
          args = {};
        }
        blocks.push({ type: 'tool_use', id: tc.id, name: tc.function?.name, input: args });
      }
      if (blocks.length) push('assistant', blocks);
      continue;
    }
    const blocks: any[] = (m.images ?? []).map((id) => ({
      type: 'image',
      source: { $asset: id, as: 'anthropicSource' },
    }));
    blocks.push({ type: 'text', text: m.content });
    push('user', blocks);
  }
  // Prefill: a trailing assistant turn makes the model continue from it.
  if (input.prefix) push('assistant', [{ type: 'text', text: input.prefix }]);
  const system = [
    input.system,
    ...(input.messages ?? []).filter((m) => m.role === 'system' || m.role === 'developer').map((m) => m.content),
  ]
    .filter((s) => s && s.trim())
    .join('\n\n');
  return { system: system || undefined, messages };
}

export const ANTHROPIC_PARAMS: ParamSpec[] = [
  {
    key: 'max_tokens',
    label: 'max_tokens',
    type: 'integer',
    min: 1,
    default: 2048,
    enabledByDefault: true,
    group: '长度',
    description: 'Messages API 必填。',
  },
  { key: 'temperature', label: 'temperature', type: 'number', min: 0, max: 1, step: 0.05, default: 0.7, group: '采样' },
  {
    key: 'top_p',
    label: 'top_p',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    default: 1,
    group: '采样',
    advanced: true,
  },
  { key: 'top_k', label: 'top_k', type: 'integer', min: 1, default: 40, group: '采样', advanced: true },
  { key: 'stop_sequences', label: 'stop_sequences', type: 'string-list', default: [], group: '长度', advanced: true },
  {
    key: 'thinking',
    label: 'thinking',
    type: 'json',
    default: { type: 'enabled', budget_tokens: 2048 },
    group: '思考',
    description:
      'Anthropic 风格的思考开关与预算；budget_tokens 需小于 max_tokens。兼容端点是否真的遵守预算，请对照用量观察。',
  },
  {
    key: 'tools',
    label: 'tools',
    type: 'json',
    default: [
      {
        name: 'get_weather',
        description: '查询城市天气',
        input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
      },
    ],
    group: '工具',
    description: 'Anthropic 格式工具声明（input_schema）。',
  },
  { key: 'tool_choice', label: 'tool_choice', type: 'json', default: { type: 'auto' }, group: '工具', advanced: true },
];

export function anthropicOperation(def: {
  id: string;
  providerId: string;
  title: string;
  summary?: string;
  path?: string;
  features?: string[];
  params?: ParamSpec[];
  models?: string[];
  defaultModel?: string;
  verification: Verification;
  notes?: string[];
  docsUrl?: string;
  baseUrlIds?: string[];
  headers?: Record<string, string>;
}): OperationDef {
  const params = def.params ?? ANTHROPIC_PARAMS;
  return {
    id: def.id,
    providerId: def.providerId,
    title: def.title,
    summary: def.summary,
    features: def.features ?? ['chat', 'anthropic-compat'],
    workbench: 'chat',
    lifecycle: 'sse',
    models: def.models,
    defaultModel: def.defaultModel,
    freeModel: true,
    params,
    protocol: 'anthropic-messages',
    costTier: 'low',
    verification: def.verification,
    notes: def.notes,
    docsUrl: def.docsUrl,
    baseUrlIds: def.baseUrlIds,
    build: (ctx) => {
      const input = ctx.input as unknown as ChatInput;
      const stream = input.stream !== false;
      const { system, messages } = buildAnthropicMessages(input);
      const body: any = { model: ctx.model, messages };
      if (system) body.system = system;
      applyParams(body, params, ctx.params, ctx.model);
      if (body.max_tokens === undefined) body.max_tokens = 2048;
      body.stream = stream;
      const req: NativeRequest = {
        method: 'POST',
        path: def.path ?? '/v1/messages',
        body,
        stream,
        headers: { 'anthropic-version': '2023-06-01', ...(def.headers ?? {}) },
      };
      applyRequestParams(req, params, ctx.params, ctx.model);
      return req;
    },
  };
}

// ---------------------------------------------------------------- embeddings / rerank

export interface EmbeddingInput {
  texts: string[];
}

export function embeddingOperation(def: {
  id: string;
  providerId: string;
  title: string;
  summary?: string;
  path: string;
  models?: string[];
  defaultModel?: string;
  params?: ParamSpec[];
  verification: Verification;
  notes?: string[];
  docsUrl?: string;
  extend?: (body: any, ctx: BuildContext) => void;
}): OperationDef {
  const params = def.params ?? [
    {
      key: 'dimensions',
      label: 'dimensions',
      type: 'integer',
      min: 1,
      default: 1024,
      group: '向量',
      description: '输出维度（仅部分模型支持可变维度）',
    },
    {
      key: 'encoding_format',
      label: 'encoding_format',
      type: 'enum',
      options: [{ value: 'float' }, { value: 'base64' }],
      default: 'float',
      group: '向量',
      advanced: true,
    },
  ];
  return {
    id: def.id,
    providerId: def.providerId,
    title: def.title,
    summary: def.summary,
    features: ['embedding'],
    workbench: 'embedding',
    lifecycle: 'http',
    models: def.models,
    defaultModel: def.defaultModel,
    freeModel: true,
    params,
    protocol: 'json',
    costTier: 'low',
    verification: def.verification,
    notes: def.notes,
    docsUrl: def.docsUrl,
    build: (ctx) => {
      const input = ctx.input as unknown as EmbeddingInput;
      const body: any = { model: ctx.model, input: (input.texts ?? []).filter((t) => t.trim()) };
      applyParams(body, params, ctx.params, ctx.model);
      def.extend?.(body, ctx);
      return { method: 'POST', path: def.path, body };
    },
  };
}

export interface RerankInput {
  query: string;
  documents: string[];
}

export function rerankOperation(def: {
  id: string;
  providerId: string;
  title: string;
  summary?: string;
  path: string;
  models?: string[];
  defaultModel?: string;
  params?: ParamSpec[];
  verification: Verification;
  notes?: string[];
  docsUrl?: string;
  build?: (input: RerankInput, ctx: BuildContext) => any;
}): OperationDef {
  const params = def.params ?? [
    { key: 'top_n', label: 'top_n', type: 'integer', min: 1, default: 5, group: '排序' },
    {
      key: 'return_documents',
      label: 'return_documents',
      type: 'boolean',
      default: true,
      group: '排序',
      advanced: true,
    },
  ];
  return {
    id: def.id,
    providerId: def.providerId,
    title: def.title,
    summary: def.summary,
    features: ['rerank'],
    workbench: 'rerank',
    lifecycle: 'http',
    models: def.models,
    defaultModel: def.defaultModel,
    freeModel: true,
    params,
    protocol: 'json',
    costTier: 'low',
    verification: def.verification,
    notes: def.notes,
    docsUrl: def.docsUrl,
    build: (ctx) => {
      const input = ctx.input as unknown as RerankInput;
      const docs = (input.documents ?? []).filter((t) => t.trim());
      const body: any = def.build
        ? def.build({ query: input.query ?? '', documents: docs }, ctx)
        : { model: ctx.model, query: input.query ?? '', documents: docs };
      applyParams(body, params, ctx.params, ctx.model);
      return { method: 'POST', path: def.path, body };
    },
  };
}

/** Parse rerank results across dialects into [{ index, score }]. */
export function parseRerank(body: any): { index: number; score: number }[] {
  const list = body?.results ?? body?.output?.results ?? body?.data ?? [];
  return (Array.isArray(list) ? list : [])
    .map((r: any) => ({ index: Number(r.index ?? r.document_index), score: Number(r.relevance_score ?? r.score) }))
    .filter((r) => Number.isFinite(r.index));
}

/** Parse embedding vectors across dialects. */
export function parseEmbeddings(body: any): number[][] {
  const list = body?.data ?? body?.output?.embeddings ?? body?.embeddings ?? [];
  return (Array.isArray(list) ? list : [])
    .map((d: any) => d?.embedding ?? d?.values ?? d)
    .filter((v: any) => Array.isArray(v));
}
