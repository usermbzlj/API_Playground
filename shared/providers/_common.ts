import type { BuildContext, NativeRequest, OperationDef, ParamSpec, Verification } from '../types.ts';
import { applyParams } from '../util.ts';

export interface ChatMessageInput {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: string[]; // asset ids
  reasoning_content?: string;
  tool_calls?: unknown[];
  tool_call_id?: string;
  name?: string;
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
  /** image content part style */
  imageStyle?: 'openai';
  /** add stream_options.include_usage when streaming */
  includeUsage?: boolean;
  /** absolute (same-host) path used when an assistant prefix is set, e.g. a vendor beta endpoint */
  betaPathForPrefix?: string;
}

export function buildChatMessages(input: ChatInput, opts: ChatBuildOptions = {}): any[] {
  const msgs: any[] = [];
  if (input.system?.trim()) msgs.push({ role: opts.systemRole ?? 'system', content: input.system });
  for (const m of input.messages ?? []) {
    if (m.role === 'assistant' && !m.content && !m.tool_calls?.length) continue;
    const out: any = { role: m.role };
    if (m.images?.length && m.role === 'user') {
      out.content = [
        ...m.images.map((id) => ({ type: 'image_url', image_url: { url: { $asset: id, as: 'dataUrl' } } })),
        { type: 'text', text: m.content },
      ];
    } else {
      out.content = m.content;
    }
    if (m.role === 'assistant' && input.keepReasoning && m.reasoning_content) out.reasoning_content = m.reasoning_content;
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
  { key: 'presence_penalty', label: 'presence_penalty', type: 'number', min: -2, max: 2, step: 0.1, default: 0, group: '采样', advanced: true },
  { key: 'frequency_penalty', label: 'frequency_penalty', type: 'number', min: -2, max: 2, step: 0.1, default: 0, group: '采样', advanced: true },
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
  description: '函数声明（OpenAI 格式）。工具结果需要在对话中以 tool 消息回填。',
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

export const LOGPROBS: ParamSpec[] = [
  { key: 'logprobs', label: 'logprobs', type: 'boolean', default: true, group: 'Token 概率' },
  { key: 'top_logprobs', label: 'top_logprobs', type: 'integer', min: 0, max: 20, default: 5, group: 'Token 概率' },
];

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
    stream: 'openai-chat',
    costTier: def.costTier ?? 'low',
    verification: def.verification,
    notes: def.notes,
    docsUrl: def.docsUrl,
    baseUrlIds: def.baseUrlIds,
    build: (ctx) => {
      const input = ctx.input as unknown as ChatInput;
      const stream = input.stream !== false;
      const body: any = { model: ctx.model, messages: buildChatMessages(input, opts) };
      applyParams(body, def.params, ctx.params, ctx.model);
      body.stream = stream;
      if (stream && opts.includeUsage && body.stream_options === undefined) body.stream_options = { include_usage: true };
      def.extend?.(body, ctx);
      // 前缀续写在部分厂商属于 Beta 功能，需要走单独的 beta 端点。
      const useBeta = !!opts.betaPathForPrefix && !!input.prefix?.trim();
      const req: NativeRequest = { method: 'POST', path: useBeta ? opts.betaPathForPrefix! : def.path, body, stream, headers: def.headers };
      return req;
    },
  };
}

export const today = '2026-10-21';
