import { getConnection, authHeaders, buildUrl } from './connections.ts';
import { redactHeaders, redactValue, redactText } from './secrets.ts';
import { resolveAssetRefs, storeArtifact, assetBlob, saveAsset } from './assets.ts';
import { insertRun, finishRun } from './runs.ts';
import { createTask } from './tasks.ts';
import { getOperation, getProvider } from '../shared/catalog.ts';
import { diagnose, extractVendorError } from '../shared/diagnose.ts';
import { getPath, shortId, truncateDeep } from '../shared/util.ts';
import type { NativeRequest, TraceEvent, RunMetrics, AssetInfo } from '../shared/types.ts';

export class CostConfirmationRequired extends Error {
  hint?: string;
  constructor(hint?: string) {
    super('此操作可能产生较高费用，需要确认后再执行');
    this.hint = hint;
  }
}

export interface ExecuteInput {
  connectionId: string;
  operationId?: string | null;
  model?: string | null;
  title?: string;
  input?: unknown;
  request: NativeRequest;
  parentId?: string | null;
  confirmCost?: boolean;
}

const MAX_EVENTS = 4000;

function isBinaryType(ct: string) {
  return /^(audio|image|video)\//.test(ct) || ct.includes('octet-stream') || ct.includes('model/');
}

export async function executeRun(
  input: ExecuteInput,
  emit: (ev: TraceEvent) => void,
  signal: AbortSignal,
): Promise<{ runId: string; status: string }> {
  const conn = getConnection(input.connectionId);
  if (!conn) throw new Error('连接不存在，请先在「连接」中添加 API Key');
  const provider = getProvider(conn.providerId);
  const op = input.operationId ? getOperation(input.operationId) : undefined;
  if (op && op.costTier === 'high' && !input.confirmCost) throw new CostConfirmationRequired(op.costHint);

  const req = input.request;
  const url = buildUrl(conn.baseUrl, req.path);
  const runId = shortId();
  const started = performance.now();
  const events: TraceEvent[] = [];
  const push = (type: TraceEvent['type'], data: any) => {
    const ev: TraceEvent = { t: Math.round(performance.now() - started), type, data };
    // 存储与实时推送使用同一份脱敏 + 截断数据，避免浏览器里看到未脱敏内容。
    const safe = redactValue(truncateDeep(data, 6000));
    if (events.length < MAX_EVENTS) events.push({ ...ev, data: safe });
    emit({ ...ev, data: safe });
  };

  const headers: Record<string, string> = { ...authHeaders(conn), ...(req.headers ?? {}) };
  let body: BodyInit | undefined;
  const bodyType = req.bodyType ?? (req.body === undefined ? 'none' : 'json');
  if (bodyType === 'json' && req.body !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    body = JSON.stringify(resolveAssetRefs(req.body));
  } else if (bodyType === 'multipart' && req.body) {
    const form = new FormData();
    const b = req.body as { fields?: Record<string, unknown>; files?: Record<string, { $asset: string }> };
    for (const [k, v] of Object.entries(b.fields ?? {})) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    for (const [k, v] of Object.entries(b.files ?? {})) {
      const { blob, filename } = assetBlob(v.$asset);
      form.append(k, blob, filename);
    }
    body = form;
  }

  const recordedRequest = {
    method: req.method,
    url: redactText(url),
    headers: redactHeaders(headers),
    body: req.body,
    bodyType,
  };

  insertRun({
    id: runId,
    providerId: conn.providerId,
    connectionId: conn.id,
    operationId: op?.id ?? input.operationId ?? null,
    model: input.model ?? null,
    title: input.title || op?.title || `${req.method} ${req.path}`,
    lifecycle: op?.lifecycle ?? (req.stream ? 'sse' : 'http'),
    input: input.input,
    request: recordedRequest,
    parentId: input.parentId ?? null,
  });
  push('request', { runId, ...recordedRequest });

  const metrics: RunMetrics = { chunks: 0 };
  let httpStatus: number | null = null;
  let responseBody: any = null;
  let status: 'ok' | 'error' | 'cancelled' = 'ok';
  let error: any;
  let taskId: string | null = null;
  const artifacts: AssetInfo[] = [];

  try {
    const res = await fetch(url, { method: req.method, headers, body, signal });
    httpStatus = res.status;
    metrics.ttfbMs = Math.round(performance.now() - started);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => (respHeaders[k] = v));
    push('response-head', { status: res.status, statusText: res.statusText, headers: redactHeaders(respHeaders) });

    if (ct.includes('text/event-stream') && res.body) {
      const decoder = new TextDecoder();
      let buf = '';
      let lastData: any;
      const reader = res.body.getReader();
      const handleBlock = (block: string) => {
        if (!block.trim()) return;
        let event: string | undefined;
        const data: string[] = [];
        const comments: string[] = [];
        for (const line of block.split(/\r?\n/)) {
          if (line.startsWith(':')) comments.push(line.slice(1).trim());
          else if (line.startsWith('event:')) event = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (!data.length && comments.length) {
          push('chunk', { comment: comments.join('\n') });
          return;
        }
        const raw = data.join('\n');
        let parsed: any = raw;
        try {
          parsed = raw === '[DONE]' ? '[DONE]' : JSON.parse(raw);
        } catch {
          /* keep raw text */
        }
        metrics.chunks!++;
        if (metrics.firstTokenMs === undefined && raw !== '[DONE]') metrics.firstTokenMs = Math.round(performance.now() - started);
        if (parsed && typeof parsed === 'object') {
          lastData = parsed;
          if (parsed.usage) metrics.usage = parsed.usage;
        }
        push('chunk', event ? { event, data: parsed } : { data: parsed });
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.search(/\r?\n\r?\n/)) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx).replace(/^\r?\n\r?\n/, '');
          handleBlock(block);
        }
      }
      if (buf.trim()) handleBlock(buf);
      responseBody = { streamed: true, chunks: metrics.chunks, last: lastData };
      if (!res.ok) responseBody = lastData ?? responseBody;
    } else if (isBinaryType(ct) && res.ok) {
      const buf = Buffer.from(await res.arrayBuffer());
      metrics.bytes = buf.length;
      const asset = saveAsset({ data: buf, mime: ct.split(';')[0], runId, source: 'artifact' });
      artifacts.push(asset);
      push('artifact', asset);
      responseBody = { binary: true, mime: ct, bytes: buf.length, assetId: asset.id };
    } else {
      const text = await res.text();
      metrics.bytes = text.length;
      try {
        responseBody = JSON.parse(text);
      } catch {
        responseBody = text;
      }
      push('body', truncateDeep(responseBody, 20000));
      if (responseBody?.usage) metrics.usage = responseBody.usage;
    }

    const vendorErr = res.ok ? extractVendorError(responseBody) : undefined;
    if (!res.ok || vendorErr) {
      status = 'error';
      error = diagnose({ providerId: conn.providerId, httpStatus: res.status, body: responseBody });
      push('error', error);
    } else if (op?.artifacts && responseBody && typeof responseBody === 'object') {
      for (const a of op.artifacts(responseBody)) {
        try {
          const asset = await storeArtifact(a, runId);
          artifacts.push(asset);
          push('artifact', asset);
        } catch (e: any) {
          push('info', { message: `产物保存失败：${e.message}` });
        }
      }
    }

    if (status === 'ok' && op?.async) {
      const remoteId = getPath(responseBody, op.async.idPath);
      if (!remoteId) {
        status = 'error';
        error = { title: '未取得任务 ID', hints: [`响应中没有 ${op.async.idPath} 字段，请查看原始响应。`] };
        push('error', error);
      } else {
        taskId = createTask({
          runId,
          connectionId: conn.id,
          operationId: op.id,
          remoteId: String(remoteId),
          title: input.title || op.title,
        });
        push('info', { message: `已创建异步任务 ${remoteId}，后台将持续跟踪`, taskId, remoteId });
      }
    }
  } catch (e: any) {
    if (signal.aborted) {
      status = 'cancelled';
      push('info', { message: '已取消' });
    } else {
      status = 'error';
      const cause = e?.cause?.code || e?.cause?.message || '';
      error = diagnose({ providerId: conn.providerId, networkError: `${e.message}${cause ? ` (${cause})` : ''}` });
      push('error', error);
    }
  }

  metrics.totalMs = Math.round(performance.now() - started);
  push('done', { runId, status, httpStatus, metrics, taskId, provider: provider?.id });
  // 异步任务刚创建成功时不算「完成」：保持 running，由轮询器终态化，避免误导用户。
  finishRun(runId, {
    status: taskId ? 'running' : status,
    httpStatus,
    response: redactValue(truncateDeep(responseBody, 200000)),
    events,
    metrics,
    error,
    taskId,
  });
  return { runId, status };
}
