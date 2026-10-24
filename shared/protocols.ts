// Response reducers: turn raw trace events (SSE chunks or a JSON body) into a view the
// workbenches render. Anything a vendor returns that is not part of the common view is
// kept verbatim in `extras` so that native behaviour stays visible.
import type { Insight, InsightContext, ProtocolId, TraceEvent } from './types.ts';
import { reduceGemini } from './providers/gemini.ts';

export interface TokenProb {
  token: string;
  logprob: number;
  top: { token: string; logprob: number }[];
}

export interface ToolCallView {
  index: number;
  id?: string;
  type?: string;
  name: string;
  args: string;
  /** server-side tools (anthropic server_tool_use, vendor builtin functions) */
  builtin?: boolean;
}

export interface Citation {
  url?: string;
  title?: string;
  snippet?: string;
  index?: number;
}

export interface ChatView {
  kind: 'chat';
  text: string;
  reasoning: string;
  toolCalls: ToolCallView[];
  logprobs: TokenProb[];
  citations: Citation[];
  usage?: Record<string, any>;
  finishReason?: string;
  responseModel?: string;
  responseId?: string;
  extras: Record<string, any>;
  firstReasoningMs?: number;
  firstTextMs?: number;
  lastMs?: number;
  chunks: number;
  /** anthropic content blocks in order */
  blocks: { type: string; text: string; data?: any }[];
}

export interface AudioView {
  kind: 'audio';
  /** hex audio assembled from stream chunks (MiniMax) */
  hex: string;
  extras: Record<string, any>;
  firstAudioMs?: number;
  chunks: number;
}

export interface JsonView {
  kind: 'json';
  body: any;
  extras: Record<string, any>;
}

export type View = ChatView | AudioView | JsonView;

function payloadOf(ev: TraceEvent): any {
  if (ev.type === 'chunk') return ev.data?.data !== undefined ? ev.data.data : ev.data;
  return ev.data;
}

function mergeExtra(extras: Record<string, any>, key: string, value: any) {
  if (value == null) return;
  const prev = extras[key];
  if (typeof value === 'string' && typeof prev === 'string') extras[key] = prev + value;
  else if (Array.isArray(value) && Array.isArray(prev)) extras[key] = [...prev, ...value];
  else extras[key] = value;
}

const STD_CHUNK_KEYS = new Set([
  'id',
  'object',
  'created',
  'model',
  'choices',
  'usage',
  'system_fingerprint',
  'service_tier',
]);
const STD_DELTA_KEYS = new Set([
  'role',
  'content',
  'reasoning_content',
  'reasoning',
  'tool_calls',
  'function_call',
  'refusal',
]);
const STD_CHOICE_KEYS = new Set(['index', 'delta', 'message', 'finish_reason', 'logprobs', 'text']);

function emptyChat(): ChatView {
  return {
    kind: 'chat',
    text: '',
    reasoning: '',
    toolCalls: [],
    logprobs: [],
    citations: [],
    extras: {},
    chunks: 0,
    blocks: [],
  };
}

function pushLogprobs(view: ChatView, lp: any) {
  // chat format: { content: [{ token, logprob, top_logprobs: [{ token, logprob }] }] }
  for (const t of lp?.content ?? []) {
    view.logprobs.push({
      token: String(t.token ?? ''),
      logprob: Number(t.logprob),
      top: (t.top_logprobs ?? []).map((x: any) => ({ token: String(x.token ?? ''), logprob: Number(x.logprob) })),
    });
  }
  // completions format: { tokens: [], token_logprobs: [], top_logprobs: [{ token: logprob }] }
  if (Array.isArray(lp?.tokens)) {
    lp.tokens.forEach((tok: string, i: number) => {
      const top = lp.top_logprobs?.[i] ?? {};
      view.logprobs.push({
        token: String(tok),
        logprob: Number(lp.token_logprobs?.[i]),
        top: Object.entries(top).map(([token, logprob]) => ({ token, logprob: Number(logprob) })),
      });
    });
  }
}

function collectCitations(view: ChatView, obj: any) {
  // Perplexity-style / OpenRouter passthrough: citations: string[] ; search_results: [{title,url}]
  if (Array.isArray(obj?.citations)) {
    for (const c of obj.citations) {
      if (typeof c === 'string') view.citations.push({ url: c });
      else if (c && typeof c === 'object')
        view.citations.push({ url: c.url, title: c.title, snippet: c.snippet ?? c.text });
    }
  }
  if (Array.isArray(obj?.search_results)) {
    for (const r of obj.search_results) view.citations.push({ url: r.url, title: r.title, snippet: r.snippet });
  }
  // Zhipu: web_search: [{ title, link, content, refer, media }]
  if (Array.isArray(obj?.web_search)) {
    for (const r of obj.web_search)
      view.citations.push({
        url: r.link ?? r.url,
        title: r.title,
        snippet: r.content,
        index: r.refer ? Number(String(r.refer).replace(/\D/g, '')) || undefined : undefined,
      });
  }
  // DashScope native / compatible: search_info.search_results: [{ index, title, url, site_name }]
  if (Array.isArray(obj?.search_info?.search_results)) {
    for (const r of obj.search_info.search_results) view.citations.push({ url: r.url, title: r.title, index: r.index });
  }
  // OpenAI-style annotations on the message
  for (const a of obj?.annotations ?? []) {
    if (a?.type === 'url_citation')
      view.citations.push({ url: a.url_citation?.url ?? a.url, title: a.url_citation?.title ?? a.title });
  }
}

function applyChoiceMessage(view: ChatView, msg: any) {
  if (!msg) return;
  if (typeof msg.content === 'string') view.text += msg.content;
  else if (Array.isArray(msg.content)) {
    for (const part of msg.content) if (part?.type === 'text' && typeof part.text === 'string') view.text += part.text;
  }
  const r = msg.reasoning_content ?? msg.reasoning;
  if (typeof r === 'string') view.reasoning += r;
  (msg.tool_calls ?? []).forEach((tc: any, i: number) => {
    view.toolCalls.push({
      index: tc.index ?? i,
      id: tc.id,
      type: tc.type,
      name: tc.function?.name ?? '',
      args: tc.function?.arguments ?? '',
    });
  });
  collectCitations(view, msg);
  for (const [k, v] of Object.entries(msg)) {
    if (!STD_DELTA_KEYS.has(k) && k !== 'annotations') mergeExtra(view.extras, `message.${k}`, v);
  }
}

export function reduceOpenAIChat(events: TraceEvent[]): ChatView {
  const view = emptyChat();
  for (const ev of events) {
    if (ev.type !== 'chunk' && ev.type !== 'body') continue;
    const p = payloadOf(ev);
    if (!p || typeof p !== 'object') continue;
    if (ev.type === 'chunk') view.chunks++;
    view.lastMs = ev.t;
    if (p.model) view.responseModel = p.model;
    if (p.id) view.responseId = p.id;
    if (p.usage) view.usage = p.usage;
    collectCitations(view, p);
    for (const [k, v] of Object.entries(p)) if (!STD_CHUNK_KEYS.has(k)) mergeExtra(view.extras, k, v);
    for (const choice of p.choices ?? []) {
      if ((choice.index ?? 0) !== 0) continue; // n > 1 is shown in the raw response
      if (choice.finish_reason) view.finishReason = choice.finish_reason;
      if (choice.logprobs) pushLogprobs(view, choice.logprobs);
      for (const [k, v] of Object.entries(choice))
        if (!STD_CHOICE_KEYS.has(k)) mergeExtra(view.extras, `choice.${k}`, v);
      if (ev.type === 'body') {
        applyChoiceMessage(view, choice.message);
        continue;
      }
      const d = choice.delta;
      if (!d) continue;
      if (typeof d.content === 'string' && d.content) {
        if (view.firstTextMs === undefined) view.firstTextMs = ev.t;
        view.text += d.content;
      }
      const r = d.reasoning_content ?? d.reasoning;
      if (typeof r === 'string' && r) {
        if (view.firstReasoningMs === undefined) view.firstReasoningMs = ev.t;
        view.reasoning += r;
      }
      for (const tc of d.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        let cur = view.toolCalls.find((x) => x.index === idx);
        if (!cur) {
          cur = { index: idx, name: '', args: '' };
          view.toolCalls.push(cur);
        }
        if (tc.id) cur.id = tc.id;
        if (tc.type) cur.type = tc.type;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
      }
      for (const [k, v] of Object.entries(d)) if (!STD_DELTA_KEYS.has(k)) mergeExtra(view.extras, `delta.${k}`, v);
    }
  }
  return view;
}

export function reduceOpenAICompletion(events: TraceEvent[]): ChatView {
  const view = emptyChat();
  for (const ev of events) {
    if (ev.type !== 'chunk' && ev.type !== 'body') continue;
    const p = payloadOf(ev);
    if (!p || typeof p !== 'object') continue;
    if (ev.type === 'chunk') view.chunks++;
    view.lastMs = ev.t;
    if (p.model) view.responseModel = p.model;
    if (p.usage) view.usage = p.usage;
    for (const [k, v] of Object.entries(p)) if (!STD_CHUNK_KEYS.has(k)) mergeExtra(view.extras, k, v);
    const c = p.choices?.[0];
    if (!c) continue;
    if (typeof c.text === 'string' && c.text) {
      if (view.firstTextMs === undefined) view.firstTextMs = ev.t;
      view.text += c.text;
    }
    if (c.finish_reason) view.finishReason = c.finish_reason;
    if (c.logprobs) pushLogprobs(view, c.logprobs);
  }
  return view;
}

/** OpenAI Responses API: typed SSE events plus the final response object. */
export function reduceOpenAIResponses(events: TraceEvent[]): ChatView {
  const view = emptyChat();
  const toolByItem = new Map<string, ToolCallView>();
  const streamedItems = new Set<string>();
  const absorbItem = (item: any, index = view.toolCalls.length) => {
    if (!item || typeof item !== 'object') return;
    if (item.type === 'message') {
      if (item.id && streamedItems.has(item.id)) return;
      if (item.id) streamedItems.add(item.id);
      for (const part of item.content ?? []) {
        if (part?.type === 'output_text') {
          view.text += part.text ?? '';
          collectCitations(view, part);
        } else if (part?.type === 'refusal') {
          view.text += part.refusal ?? '';
        }
      }
      return;
    }
    if (item.type === 'reasoning') {
      if (item.id && streamedItems.has(item.id)) return;
      if (item.id) streamedItems.add(item.id);
      for (const s of item.summary ?? []) view.reasoning += s?.text ?? '';
      if (item.encrypted_content) mergeExtra(view.extras, 'reasoning.encrypted_content', item.encrypted_content);
      return;
    }
    if (item.type === 'function_call') {
      let tc = toolByItem.get(item.id ?? item.call_id ?? '');
      if (!tc) {
        tc = { index, id: item.call_id ?? item.id, type: 'function', name: item.name ?? '', args: '' };
        view.toolCalls.push(tc);
        if (item.id) toolByItem.set(item.id, tc);
        if (item.call_id) toolByItem.set(item.call_id, tc);
      }
      tc.name = item.name ?? tc.name;
      if (typeof item.arguments === 'string' && item.arguments) tc.args = item.arguments;
      return;
    }
    if (item.type) mergeExtra(view.extras, `item.${item.type}`, item);
  };
  const absorbResponse = (resp: any) => {
    if (!resp || typeof resp !== 'object') return;
    if (resp.id) view.responseId = resp.id;
    if (resp.model) view.responseModel = resp.model;
    if (resp.status) view.finishReason = resp.status;
    const u = resp.usage;
    if (u && typeof u === 'object') {
      view.usage = {
        ...u,
        prompt_tokens: u.input_tokens,
        completion_tokens: u.output_tokens,
        total_tokens: u.total_tokens,
        prompt_cache_hit_tokens: u.input_tokens_details?.cached_tokens,
        reasoning_tokens: u.output_tokens_details?.reasoning_tokens,
      };
    }
    const output = Array.isArray(resp.output) ? resp.output : [];
    output.forEach((item: any, i: number) => absorbItem(item, i));
    for (const [k, v] of Object.entries(resp))
      if (
        !['id', 'object', 'created_at', 'model', 'output', 'usage', 'status', 'error', 'incomplete_details'].includes(k)
      )
        mergeExtra(view.extras, k, v);
    if (resp.error) mergeExtra(view.extras, 'error', resp.error);
    if (resp.incomplete_details) mergeExtra(view.extras, 'incomplete_details', resp.incomplete_details);
  };
  for (const ev of events) {
    if (ev.type !== 'chunk' && ev.type !== 'body') continue;
    const p = payloadOf(ev);
    if (!p || typeof p !== 'object') continue;
    view.chunks++;
    view.lastMs = ev.t;
    if (ev.type === 'body') {
      absorbResponse(p);
      continue;
    }
    switch (p.type) {
      case 'response.created':
        if (p.response) {
          view.responseId = p.response.id ?? view.responseId;
          view.responseModel = p.response.model ?? view.responseModel;
        }
        break;
      case 'response.output_item.added': {
        const item = p.item ?? {};
        if ((item.type === 'message' || item.type === 'reasoning') && item.id) streamedItems.add(item.id);
        absorbItem(item, p.output_index ?? view.toolCalls.length);
        break;
      }
      case 'response.output_text.delta':
        if (typeof p.delta === 'string') {
          view.text += p.delta;
          if (view.firstTextMs === undefined) view.firstTextMs = ev.t;
        }
        break;
      case 'response.refusal.delta':
        if (typeof p.delta === 'string') {
          view.text += p.delta;
          if (view.firstTextMs === undefined) view.firstTextMs = ev.t;
        }
        break;
      case 'response.reasoning_summary_text.delta':
        if (typeof p.delta === 'string') {
          view.reasoning += p.delta;
          if (view.firstReasoningMs === undefined) view.firstReasoningMs = ev.t;
        }
        break;
      case 'response.reasoning_summary_text.done':
        if (!view.reasoning && typeof p.text === 'string') view.reasoning = p.text;
        break;
      case 'response.function_call_arguments.delta': {
        const tc = toolByItem.get(p.item_id ?? '');
        if (tc) tc.args += p.delta ?? '';
        break;
      }
      case 'response.function_call_arguments.done': {
        const tc = toolByItem.get(p.item_id ?? '');
        if (tc && typeof p.arguments === 'string') tc.args = p.arguments;
        break;
      }
      case 'response.completed':
        absorbResponse(p.response);
        break;
      case 'response.failed':
        mergeExtra(view.extras, 'failed', p.response ?? p);
        break;
      case 'error':
        mergeExtra(view.extras, 'error', p.error ?? p);
        break;
      default:
        mergeExtra(view.extras, p.type ?? 'event', p);
    }
  }
  return view;
}

export function reduceAnthropic(events: TraceEvent[]): ChatView {
  const view = emptyChat();
  const byIndex = new Map<number, { type: string; text: string; data: any }>();
  const absorbBlock = (b: any, idx: number) => {
    const block = { type: String(b?.type ?? 'unknown'), text: '', data: { ...b } };
    if (b?.type === 'text') block.text = b.text ?? '';
    if (b?.type === 'thinking') block.text = b.thinking ?? '';
    if (b?.type === 'tool_use' || b?.type === 'server_tool_use')
      block.text = b.input && Object.keys(b.input).length ? JSON.stringify(b.input) : '';
    byIndex.set(idx, block);
    view.blocks.push(block);
    return block;
  };
  for (const ev of events) {
    if (ev.type !== 'chunk' && ev.type !== 'body') continue;
    const p = payloadOf(ev);
    if (!p || typeof p !== 'object') continue;
    view.lastMs = ev.t;
    if (ev.type === 'body') {
      if (p.model) view.responseModel = p.model;
      if (p.id) view.responseId = p.id;
      if (p.usage) view.usage = p.usage;
      if (p.stop_reason) view.finishReason = p.stop_reason;
      (p.content ?? []).forEach((b: any, i: number) => absorbBlock(b, i));
      for (const [k, v] of Object.entries(p))
        if (!['id', 'type', 'role', 'model', 'content', 'usage', 'stop_reason', 'stop_sequence'].includes(k))
          mergeExtra(view.extras, k, v);
      continue;
    }
    view.chunks++;
    switch (p.type) {
      case 'message_start':
        view.responseModel = p.message?.model;
        view.responseId = p.message?.id;
        if (p.message?.usage) view.usage = { ...p.message.usage };
        break;
      case 'content_block_start':
        absorbBlock(p.content_block, p.index ?? byIndex.size);
        break;
      case 'content_block_delta': {
        const b = byIndex.get(p.index) ?? absorbBlock({ type: 'text' }, p.index);
        const d = p.delta ?? {};
        if (d.type === 'text_delta') {
          if (view.firstTextMs === undefined) view.firstTextMs = ev.t;
          b.text += d.text ?? '';
        } else if (d.type === 'thinking_delta') {
          if (view.firstReasoningMs === undefined) view.firstReasoningMs = ev.t;
          b.text += d.thinking ?? '';
        } else if (d.type === 'input_json_delta') b.text += d.partial_json ?? '';
        else if (d.type === 'signature_delta') b.data.signature = (b.data.signature ?? '') + (d.signature ?? '');
        else if (d.type === 'citations_delta') (b.data.citations ??= []).push(d.citation);
        break;
      }
      case 'message_delta':
        if (p.delta?.stop_reason) view.finishReason = p.delta.stop_reason;
        if (p.usage) view.usage = { ...(view.usage ?? {}), ...p.usage };
        break;
      case 'error':
        mergeExtra(view.extras, 'error', p.error);
        break;
    }
  }
  for (const b of view.blocks) {
    if (b.type === 'text') {
      view.text += b.text;
      for (const c of b.data?.citations ?? [])
        view.citations.push({ url: c.url, title: c.title ?? c.document_title, snippet: c.cited_text });
    } else if (b.type === 'thinking') view.reasoning += b.text;
    else if (b.type === 'tool_use' || b.type === 'server_tool_use') {
      view.toolCalls.push({
        index: view.toolCalls.length,
        id: b.data?.id,
        type: b.type,
        name: b.data?.name ?? '',
        args: b.text,
        builtin: b.type === 'server_tool_use',
      });
    } else if (/_tool_result$/.test(b.type)) {
      for (const r of Array.isArray(b.data?.content) ? b.data.content : [])
        if (r?.url) view.citations.push({ url: r.url, title: r.title });
    }
  }
  return view;
}

export function reduceMinimaxT2A(events: TraceEvent[]): AudioView {
  const view: AudioView = { kind: 'audio', hex: '', extras: {}, chunks: 0 };
  let full = '';
  for (const ev of events) {
    if (ev.type !== 'chunk' && ev.type !== 'body') continue;
    const p = payloadOf(ev);
    if (!p || typeof p !== 'object') continue;
    if (ev.type === 'chunk') view.chunks++;
    const audio = p.data?.audio;
    if (typeof audio === 'string' && audio) {
      if (view.firstAudioMs === undefined) view.firstAudioMs = ev.t;
      // In stream mode the final chunk (status 2) repeats the complete audio.
      if (p.data?.status === 2 || ev.type === 'body') full = audio;
      else view.hex += audio;
    }
    for (const [k, v] of Object.entries(p)) if (k !== 'data') view.extras[k] = v;
    if (p.data) for (const [k, v] of Object.entries(p.data)) if (k !== 'audio') view.extras[`data.${k}`] = v;
  }
  if (full) view.hex = full;
  return view;
}

export function reduceJson(events: TraceEvent[]): JsonView {
  let body: any;
  for (const ev of events) {
    if (ev.type === 'body') body = ev.data;
    else if (ev.type === 'chunk') body = payloadOf(ev);
  }
  return { kind: 'json', body, extras: {} };
}

export function reduceEvents(protocol: ProtocolId | undefined, events: TraceEvent[]): View {
  switch (protocol) {
    case 'openai-chat':
      return reduceOpenAIChat(events);
    case 'openai-completion':
      return reduceOpenAICompletion(events);
    case 'openai-responses':
      return reduceOpenAIResponses(events);
    case 'anthropic-messages':
      return reduceAnthropic(events);
    case 'gemini-generate':
      return reduceGemini(events);
    case 'minimax-t2a':
      return reduceMinimaxT2A(events);
    default:
      return reduceJson(events);
  }
}

// ---------------------------------------------------------------- insights

function num(v: any): number | undefined {
  if (v === null || v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Cache-hit tokens across vendor dialects. */
export function cacheHitTokens(usage: any): number | undefined {
  if (!usage) return undefined;
  return (
    num(usage.prompt_cache_hit_tokens) ?? // DeepSeek
    num(usage.prompt_tokens_details?.cached_tokens) ?? // OpenAI / Qwen / Kimi / GLM
    num(usage.cache_read_input_tokens) ?? // Anthropic
    num(usage.cached_tokens) ?? // Moonshot legacy
    num(usage.cachedContentTokenCount) // Gemini native
  );
}

export function promptTokens(usage: any): number | undefined {
  if (!usage) return undefined;
  const anthropicIn = num(usage.input_tokens);
  if (anthropicIn !== undefined && usage.prompt_tokens === undefined) {
    return anthropicIn + (num(usage.cache_read_input_tokens) ?? 0) + (num(usage.cache_creation_input_tokens) ?? 0);
  }
  return num(usage.prompt_tokens) ?? num(usage.promptTokenCount);
}

export function reasoningTokens(usage: any): number | undefined {
  return (
    num(usage?.completion_tokens_details?.reasoning_tokens) ??
    num(usage?.reasoning_tokens) ??
    num(usage?.thoughtsTokenCount)
  );
}

export function chatInsights(ctx: InsightContext): Insight[] {
  const out: Insight[] = [];
  const v = ctx.view as ChatView;
  if (!v || v.kind !== 'chat') return out;
  const body: any = ctx.request?.body ?? {};

  if (v.finishReason === 'length' || v.finishReason === 'max_tokens') {
    out.push({
      level: 'warn',
      text: '输出因达到长度上限被截断（finish_reason = ' + v.finishReason + '），可调大 max_tokens。',
    });
  }
  if ((body.logprobs === true || typeof body.logprobs === 'number') && v.logprobs.length === 0) {
    out.push({
      level: 'warn',
      text: '请求开启了 logprobs，但响应里没有 Token 概率——该模型或端点可能静默忽略了这个参数。',
    });
  } else if (v.logprobs.length > 0) {
    const low = v.logprobs.filter((t) => Math.exp(t.logprob) < 0.5).length;
    out.push({
      level: 'ok',
      text: `返回了 ${v.logprobs.length} 个 Token 的概率，其中 ${low} 个 Token 的概率低于 50%（在「Token 显微镜」里查看）。`,
    });
  }
  const hit = cacheHitTokens(v.usage);
  const prompt = promptTokens(v.usage);
  if (hit !== undefined) {
    out.push({
      level: hit > 0 ? 'ok' : 'info',
      text:
        hit > 0
          ? `上下文缓存命中 ${hit} tokens${prompt ? `（占输入 ${Math.round((hit / prompt) * 100)}%）` : ''}。`
          : '本次没有命中上下文缓存（重复发送相同的长前缀再试一次）。',
    });
  }
  const rt = reasoningTokens(v.usage);
  if (v.reasoning) {
    const wait =
      v.firstTextMs !== undefined && v.firstReasoningMs !== undefined ? v.firstTextMs - v.firstReasoningMs : undefined;
    out.push({
      level: 'info',
      text: `返回了思考内容 ${v.reasoning.length} 字符${rt ? `（reasoning tokens ${rt}）` : ''}${wait !== undefined ? `，思考 ${(wait / 1000).toFixed(1)} s 后才开始输出正文` : ''}。`,
    });
  } else if (rt) {
    out.push({ level: 'info', text: `用量显示消耗了 ${rt} 个推理 Token，但响应里没有返回思考原文。` });
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    if (v.toolCalls.length === 0) {
      out.push({
        level: body.tool_choice === 'required' ? 'warn' : 'info',
        text: `声明了 ${body.tools.length} 个工具，但模型这次没有调用任何工具${body.tool_choice === 'required' ? '（tool_choice = required，可能不被支持）' : ''}。`,
      });
    } else {
      const bad = v.toolCalls.filter((tc) => {
        if (!tc.args || tc.builtin) return false;
        try {
          JSON.parse(tc.args);
          return false;
        } catch {
          return true;
        }
      });
      out.push({
        level: bad.length ? 'warn' : 'ok',
        text: `模型调用了 ${v.toolCalls.length} 个工具${bad.length ? `，其中 ${bad.length} 个参数不是合法 JSON` : '，参数均为合法 JSON'}。`,
      });
    }
  }
  if (v.responseModel && ctx.model && v.responseModel !== ctx.model && !v.responseModel.startsWith(ctx.model)) {
    out.push({
      level: 'info',
      text: `响应声明的模型是 ${v.responseModel}（请求的是 ${ctx.model}）——别名或路由可能指向了具体版本。`,
    });
  }
  if (v.citations.length > 0) out.push({ level: 'ok', text: `返回了 ${v.citations.length} 条引用 / 搜索来源。` });
  const extraKeys = Object.keys(v.extras).filter((k) => !/^(choice\.|delta\.)?(stop_reason|matched_stop)$/.test(k));
  if (extraKeys.length > 0)
    out.push({
      level: 'info',
      text: `厂商返回了通用格式之外的字段：${extraKeys.slice(0, 8).join('、')}${extraKeys.length > 8 ? ' …' : ''}（见「原生字段」）。`,
    });
  return out;
}

export function genericInsights(protocol: ProtocolId | undefined, ctx: InsightContext): Insight[] {
  if (
    protocol === 'openai-chat' ||
    protocol === 'openai-completion' ||
    protocol === 'openai-responses' ||
    protocol === 'anthropic-messages'
  )
    return chatInsights(ctx);
  return [];
}

export function summarizeView(view: View): string {
  if (view.kind === 'chat') {
    const t =
      view.text.trim() ||
      (view.toolCalls.length ? `调用工具 ${view.toolCalls.map((t) => t.name).join(', ')}` : '') ||
      (view.reasoning ? `（仅思考）${view.reasoning.slice(0, 120)}` : '');
    return t.slice(0, 280);
  }
  if (view.kind === 'audio') return view.hex ? `音频 ${(view.hex.length / 2 / 1024).toFixed(1)} KB` : '';
  return '';
}
