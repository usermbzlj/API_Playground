import { getConnection, applyAuth, buildUrl, mergeRequestHeaders } from './connections.ts';
import { redactHeaders, redactValue, redactText, requestSecrets } from './secrets.ts';
import { db, getSetting } from './db.ts';
import { resolveAssetRefs, storeArtifact, assetBlob, saveAsset, validateOperationAssets } from './assets.ts';
import { insertRun, finishRun } from './runs.ts';
import { createTask } from './tasks.ts';
import { netFetch, resolveRoute, describeRoute, FormData, readResponseBuffer } from './net.ts';
import { getOperation, getProvider } from '../shared/catalog.ts';
import { diagnose, extractVendorError } from '../shared/diagnose.ts';
import { reduceEvents, summarizeView } from '../shared/protocols.ts';
import { estimateRunCost } from '../shared/cost.ts';
import { SSEDecoder } from '../shared/sse.ts';
import { getPath, shortId, truncateDeep } from '../shared/util.ts';
import type { NativeRequest, TraceEvent, RunMetrics, AssetInfo, LabState } from '../shared/types.ts';

export class CostConfirmationRequired extends Error {
  hint?: string;
  constructor(hint?: string) {
    super('此操作可能产生较高费用，需要确认后再执行');
    this.hint = hint;
  }
}

export function requireCostConfirmation(tier: string | undefined, confirmed?: boolean, hint?: string) {
  const threshold = getSetting('ui', { confirmTier: 'high' }).confirmTier;
  const rank: Record<string, number> = { free: 0, low: 1, medium: 2, high: 3 };
  if (!confirmed && (tier === undefined || rank[tier] >= (threshold === 'all' ? 1 : (rank[threshold] ?? 3))))
    throw new CostConfirmationRequired(hint ?? (!tier ? '原始请求没有可信费用分类，请确认本次真实调用。' : undefined));
}

export interface ExecuteInput {
  connectionId: string;
  operationId?: string | null;
  model?: string | null;
  title?: string;
  input?: unknown;
  params?: LabState['params'];
  request: NativeRequest;
  parentId?: string | null;
  groupId?: string | null;
  confirmCost?: boolean;
}

const MAX_TRACE_BYTES = 128 * 1024 * 1024;

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
  if (input.operationId && !op) throw new Error('操作不存在');
  if (op && op.providerId !== conn.providerId) throw new Error('操作与连接厂商不一致');
  requireCostConfirmation(op?.costTier, input.confirmCost, op?.costHint);

  const req = input.request;
  validateOperationAssets(op?.id, input.input);
  if (!req || !['GET', 'POST', 'DELETE', 'PUT', 'PATCH'].includes(req.method) || typeof req.path !== 'string')
    throw new Error('请求定义无效');
  if (Object.values(req.headers ?? {}).some((v) => typeof v !== 'string' || /[\r\n]/.test(v)))
    throw new Error('请求 Header 无效');
  const secrets = requestSecrets(req.headers, req.path);
  const safeValue = <T>(v: T): T => redactValue(v, secrets);
  const rawUrl = buildUrl(conn.baseUrl, req.path, conn.providerId);
  const runId = shortId();
  const started = performance.now();
  const events: TraceEvent[] = [];
  // Untruncated chunk payloads, used only to reduce the final view server-side.
  const fullEvents: TraceEvent[] = [];
  let traceBytes = 0;
  const push = (type: TraceEvent['type'], data: any, full?: any) => {
    const ev: TraceEvent = { t: Math.round(performance.now() - started), type, data };
    // Payloads must stay intact: reducers, audio players and history replay consume them.
    const safe = safeValue(data);
    if (type === 'chunk' || type === 'body') {
      traceBytes += Buffer.byteLength(JSON.stringify(safe) ?? '');
      if (traceBytes > MAX_TRACE_BYTES)
        throw new Error('本次响应超过 128 MB 记录上限，已终止；请缩小输出或使用异步文件产物接口');
    }
    events.push({ ...ev, data: safe });
    if (type === 'chunk' || type === 'body') fullEvents.push({ ...ev, data: full ?? data });
    emit({ ...ev, data: safe });
  };

  const headers: Record<string, string> = { ...(req.headers ?? {}) };
  let body: any;
  let bodyText: string | undefined;
  const bodyType = req.bodyType ?? (req.body === undefined ? 'none' : 'json');
  if (bodyType === 'json' && req.body !== undefined) {
    headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    bodyText = JSON.stringify(resolveAssetRefs(req.body));
    if (op?.id === 'mimo.asr' && Buffer.byteLength(bodyText) > 10 * 1024 * 1024)
      throw new Error('MiMo 音频请求 Base64 编码后总大小不能超过 10 MB');
    body = bodyText;
  } else if (bodyType === 'multipart' && req.body) {
    const form = new FormData();
    const b = req.body as {
      fields?: Record<string, unknown>;
      files?: Record<string, { $asset: string } | { $asset: string }[]>;
    };
    for (const [k, v] of Object.entries(b.fields ?? {})) form.append(k, typeof v === 'string' ? v : JSON.stringify(v));
    for (const [k, refs] of Object.entries(b.files ?? {})) {
      for (const v of Array.isArray(refs) ? refs : [refs]) {
        const { blob, filename } = assetBlob(v.$asset);
        form.append(k, blob, filename);
      }
    }
    body = form;
  }

  let url = rawUrl;
  const route = resolveRoute(rawUrl, conn.network);
  const state: LabState | null = op
    ? {
        connectionId: conn.id,
        operationId: op.id,
        model: input.model ?? '',
        input: (input.input ?? {}) as any,
        params: input.params ?? {},
      }
    : null;
  const recordedRequest: any = {
    method: req.method,
    url: redactText(rawUrl),
    headers: {},
    body: req.body,
    bodyType,
    route: describeRoute(route),
    connectionSnapshot: {
      id: conn.id,
      label: conn.label,
      baseUrl: conn.baseUrl,
      network: conn.network,
      keyPreview: conn.keyPreview,
    },
  };

  insertRun(
    safeValue({
      id: runId,
      providerId: conn.providerId,
      connectionId: conn.id,
      operationId: op?.id ?? input.operationId ?? null,
      model: input.model ?? null,
      title: input.title || op?.title || `${req.method} ${req.path}`,
      lifecycle: op?.lifecycle ?? (req.stream ? 'sse' : 'http'),
      input: input.input ?? (op ? null : { request: req }),
      request: recordedRequest,
      parentId: input.parentId ?? null,
      groupId: input.groupId ?? null,
      state,
    }),
  );

  const metrics: RunMetrics = { chunks: 0 };
  let httpStatus: number | null = null;
  let responseBody: any = null;
  let status: 'ok' | 'error' | 'cancelled' = 'ok';
  let error: any;
  let taskId: string | null = null;
  const artifacts: AssetInfo[] = [];

  try {
    const auth = applyAuth(conn, rawUrl, { method: req.method, body: bodyText });
    url = auth.url;
    const merged = mergeRequestHeaders(headers, auth.headers, req.headers);
    for (const key of Object.keys(headers)) delete headers[key];
    Object.assign(headers, merged);
    recordedRequest.headers = redactHeaders(headers);
    recordedRequest.url = redactText(url);
    db.prepare('UPDATE runs SET request_json = ? WHERE id = ?').run(JSON.stringify(safeValue(recordedRequest)), runId);
    push('request', { runId, ...recordedRequest });

    const res = await netFetch(url, { method: req.method, headers, body, signal, network: conn.network });
    httpStatus = res.status;
    metrics.ttfbMs = Math.round(performance.now() - started);
    const ct = (res.headers.get('content-type') || '').toLowerCase();
    const respHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => (respHeaders[k] = v));
    push('response-head', { status: res.status, statusText: res.statusText, headers: redactHeaders(respHeaders) });

    if (ct.includes('text/event-stream') && res.body) {
      const decoder = new TextDecoder();
      let lastData: any;
      let streamError: any;
      const reader = res.body.getReader();
      const parser = new SSEDecoder(({ data: raw, event }) => {
        let parsed: any = raw;
        try {
          parsed = raw === '[DONE]' ? '[DONE]' : JSON.parse(raw);
        } catch {
          /* keep raw text */
        }
        metrics.chunks!++;
        if (metrics.firstTokenMs === undefined && raw !== '[DONE]')
          metrics.firstTokenMs = Math.round(performance.now() - started);
        if (parsed && typeof parsed === 'object') {
          lastData = parsed;
          if (extractVendorError(parsed) || parsed.type === 'error') streamError = parsed;
          if (parsed.usage) metrics.usage = { ...(metrics.usage ?? {}), ...parsed.usage };
          else if (parsed.usageMetadata) metrics.usage = { ...(metrics.usage ?? {}), ...parsed.usageMetadata };
          else if (parsed.message?.usage) metrics.usage = { ...(metrics.usage ?? {}), ...parsed.message.usage };
        }
        const payload = event ? { event, data: parsed } : { data: parsed };
        push('chunk', payload, payload);
      });
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          parser.feed(decoder.decode(value, { stream: true }));
        }
        parser.feed(decoder.decode(), true);
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
      responseBody = streamError ?? { streamed: true, chunks: metrics.chunks, last: lastData };
      if (!res.ok) responseBody = lastData ?? responseBody;
    } else if (isBinaryType(ct) && res.ok) {
      const buf = await readResponseBuffer(res, 512 * 1024 * 1024);
      metrics.bytes = buf.length;
      const asset = saveAsset({ data: buf, mime: ct.split(';')[0], runId, source: 'artifact' });
      artifacts.push(asset);
      push('artifact', asset);
      responseBody = { binary: true, mime: ct, bytes: buf.length, assetId: asset.id };
    } else {
      const bytes = await readResponseBuffer(res);
      const text = bytes.toString('utf8');
      metrics.bytes = bytes.length;
      try {
        responseBody = JSON.parse(text);
      } catch {
        responseBody = text;
      }
      push('body', responseBody, responseBody);
      if (responseBody?.usage) metrics.usage = responseBody.usage;
      else if (responseBody?.usageMetadata) metrics.usage = responseBody.usageMetadata;
    }

    const vendorErr = res.ok ? extractVendorError(responseBody) : undefined;
    if (!res.ok || vendorErr) {
      status = 'error';
      error = diagnose({ providerId: conn.providerId, httpStatus: res.status, body: responseBody });
      push('error', error);
    } else {
      const refs = [
        ...(op?.artifacts && responseBody && typeof responseBody === 'object' && !responseBody.streamed
          ? op.artifacts(responseBody)
          : []),
        ...(op?.streamArtifacts && metrics.chunks ? op.streamArtifacts(reduceEvents(op.protocol, fullEvents)) : []),
      ];
      for (const a of refs) {
        try {
          if (op?.id === 'minimax.tts') {
            const format = String((req.body as any)?.audio_setting?.format ?? 'mp3');
            a.mime =
              (
                { mp3: 'audio/mpeg', wav: 'audio/wav', flac: 'audio/flac', opus: 'audio/opus' } as Record<
                  string,
                  string
                >
              )[format] ?? a.mime;
            a.filename = `minimax-tts.${format}`;
          }
          const asset = await storeArtifact(a, runId, { network: conn.network, signal });
          artifacts.push(asset);
          push('artifact', asset);
        } catch (e: any) {
          if (signal.aborted) throw e;
          status = 'error';
          error = {
            title: '产物保存失败',
            hints: [e.message, '厂商调用已返回成功，请先检查原始响应，避免重复调用计费。'],
          };
          push('error', error);
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
        push('info', { message: `已创建异步任务 ${remoteId}，后台将持续跟踪；关闭页面也不会丢失`, taskId, remoteId });
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
      if (route.via === 'proxy')
        error.hints.push(`本次经代理 ${route.proxy} 发出；如代理未运行，可在「连接」里把该连接改为直连。`);
      push('error', error);
    }
  }

  metrics.totalMs = Math.round(performance.now() - started);
  let summary: string | null = null;
  let finalView: any;
  if (op) {
    try {
      const view = reduceEvents(op.protocol, fullEvents);
      finalView = view.kind === 'audio' && artifacts.length ? { ...view, hex: '' } : view;
      summary =
        summarizeView(view) ||
        (artifacts.length ? artifacts.map((a) => `${a.kind} ${(a.size / 1024).toFixed(0)}KB`).join('，') : null);
      if (!metrics.usage && (view as any).usage) metrics.usage = (view as any).usage;
    } catch {
      /* summary is best-effort */
    }
    const model = getProvider(op.providerId)?.models.find((m) => m.id === input.model);
    metrics.cost = estimateRunCost(op, model, { usage: metrics.usage, input: input.input, request: req });
  }
  summary = summary ? safeValue(summary) : null;
  if (responseBody?.streamed && finalView) responseBody.view = safeValue(finalView);
  push('done', {
    runId,
    status: taskId ? 'running' : status,
    httpStatus,
    metrics,
    taskId,
    provider: provider?.id,
    summary,
    view: finalView,
  });
  // A freshly created async task is not "done": the poller finalises the run.
  finishRun(runId, {
    status: taskId ? 'running' : status,
    httpStatus,
    response: safeValue(responseBody),
    events,
    metrics: safeValue(metrics),
    error: safeValue(error),
    taskId,
    summary,
  });
  return { runId, status };
}
