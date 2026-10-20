import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { getConnection, authHeaders, connectionExtra } from './connections.ts';
import { redactText, redactHeaders, redactValue } from './secrets.ts';
import { insertRun, finishRun } from './runs.ts';
import { getOperation } from '../shared/catalog.ts';
import { hostAllowed, isLoopback, originAllowed } from './guard.ts';
import { fillTemplate, shortId, truncateDeep } from '../shared/util.ts';
import type { TraceEvent } from '../shared/types.ts';

const wss = new WebSocketServer({ noServer: true });

// Audio payloads dominate realtime traffic; keep traces readable.
function summarize(data: any): any {
  if (typeof data === 'string') {
    try {
      return summarize(JSON.parse(data));
    } catch {
      return data.length > 2000 ? `${data.slice(0, 200)}…(${data.length})` : data;
    }
  }
  if (data && typeof data === 'object') {
    const out: any = Array.isArray(data) ? [] : {};
    for (const [k, v] of Object.entries(data)) {
      if (typeof v === 'string' && v.length > 300 && /audio|delta|data|image/i.test(k)) out[k] = `[base64 ${v.length} 字符]`;
      else out[k] = summarize(v);
    }
    return out;
  }
  return data;
}

export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  const u = new URL(req.url || '/', 'http://localhost');
  if (u.pathname !== '/api/ws') {
    socket.destroy();
    return;
  }
  // Same-origin guard: only the local UI may open credentialed upstream sockets.
  const remoteAddr = (socket as any).remoteAddress as string | undefined;
  if (!hostAllowed(req.headers.host) || !originAllowed(req.headers.origin) || !isLoopback(remoteAddr)) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => relay(client, u.searchParams));
}

function relay(client: WebSocket, params: URLSearchParams) {
  const connectionId = params.get('connectionId') || '';
  const operationId = params.get('operationId') || '';
  const model = params.get('model') || '';
  const conn = getConnection(connectionId);
  const op = getOperation(operationId);
  if (!conn || !op?.ws) {
    client.send(JSON.stringify({ type: 'playground.error', message: '连接或操作不存在' }));
    client.close();
    return;
  }
  const extra = { ...connectionExtra(conn), model };
  const base = new URL(conn.baseUrl);
  const path = fillTemplate(op.ws.path, extra);
  const target = new URL(path, `${base.protocol === 'http:' ? 'ws:' : 'wss:'}//${base.host}`);
  let headers: Record<string, string>;
  try {
    headers = authHeaders(conn);
  } catch (e: any) {
    client.send(JSON.stringify({ type: 'playground.error', message: e.message }));
    client.close();
    return;
  }

  const runId = shortId();
  const started = performance.now();
  const events: TraceEvent[] = [];
  const log = (type: TraceEvent['type'], data: any) => {
    if (events.length < 4000) events.push({ t: Math.round(performance.now() - started), type, data: redactValue(truncateDeep(summarize(data), 4000)) });
  };
  insertRun({
    id: runId,
    providerId: conn.providerId,
    connectionId: conn.id,
    operationId: op.id,
    model,
    title: op.title,
    lifecycle: 'ws',
    input: { model },
    request: { url: redactText(target.toString()), headers: redactHeaders(headers) },
  });
  client.send(JSON.stringify({ type: 'playground.run', runId, url: redactText(target.toString()) }));

  const upstream = new WebSocket(target, { headers });
  const pending: any[] = [];
  let firstRecv: number | undefined;
  let closed = false;

  upstream.on('open', () => {
    log('info', { message: 'upstream connected' });
    client.send(JSON.stringify({ type: 'playground.upstream_open', t: Math.round(performance.now() - started) }));
    for (const m of pending.splice(0)) upstream.send(m);
  });
  upstream.on('message', (data, isBinary) => {
    if (firstRecv === undefined) firstRecv = Math.round(performance.now() - started);
    if (isBinary) {
      log('ws-recv', { binary: true, bytes: (data as Buffer).length });
      client.send(data, { binary: true });
    } else {
      const text = data.toString();
      log('ws-recv', text);
      client.send(text);
    }
  });
  upstream.on('unexpected-response', (_req, res) => {
    let body = '';
    res.on('data', (c) => (body += c));
    res.on('end', () => {
      log('error', { status: res.statusCode, body });
      client.send(JSON.stringify({ type: 'playground.error', message: `上游拒绝连接：HTTP ${res.statusCode} ${body.slice(0, 500)}` }));
      client.close();
    });
  });
  upstream.on('error', (e) => {
    log('error', { message: e.message });
    client.send(JSON.stringify({ type: 'playground.error', message: `上游错误：${e.message}` }));
    // 必须收尾，否则实验记录会永远停留在 running。
    if (client.readyState === WebSocket.OPEN) client.close();
    finish();
  });
  upstream.on('close', (code, reason) => {
    log('info', { message: 'upstream closed', code, reason: reason.toString() });
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({ type: 'playground.upstream_closed', code, reason: reason.toString() }));
      client.close();
    }
    finish();
  });

  client.on('message', (data, isBinary) => {
    const payload = isBinary ? data : data.toString();
    log('ws-send', isBinary ? { binary: true, bytes: (data as Buffer).length } : payload);
    if (upstream.readyState === WebSocket.OPEN) upstream.send(payload);
    else if (upstream.readyState === WebSocket.CONNECTING) pending.push(payload);
    // 上游已关闭时丢弃，避免 pending 无限增长。
  });
  client.on('close', () => {
    if (upstream.readyState === WebSocket.OPEN || upstream.readyState === WebSocket.CONNECTING) upstream.close();
    finish();
  });

  function finish() {
    if (closed) return;
    closed = true;
    const hasError = events.some((e) => e.type === 'error');
    finishRun(runId, {
      status: hasError ? 'error' : 'ok',
      events,
      metrics: { totalMs: Math.round(performance.now() - started), firstTokenMs: firstRecv, chunks: events.length },
    });
  }
}
