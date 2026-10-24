// Credentialed WebSocket relay. Payloads remain native; only secrets are removed from text and traces.
import { WebSocketServer, WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { getConnection, applyAuth, connectionExtra, buildUrl } from './connections.ts';
import { redactText, redactHeaders, redactValue } from './secrets.ts';
import { insertRun, finishRun } from './runs.ts';
import { wsAgent, describeRoute } from './net.ts';
import { requireCostConfirmation } from './execute.ts';
import { db } from './db.ts';
import { getOperation } from '../shared/catalog.ts';
import { extractVendorError } from '../shared/diagnose.ts';
import { validateOperationInput } from '../shared/validate.ts';
import { hostAllowed, isLoopback, originAllowed } from './guard.ts';
import { fillTemplate, shortId } from '../shared/util.ts';
import type { TraceEvent, LabState } from '../shared/types.ts';

const MAX_BUFFER = 8 * 1024 * 1024;
const MAX_TRACE = 64 * 1024 * 1024;
const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });

export function handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
  let url: URL;
  try {
    url = new URL(req.url || '/', 'http://localhost');
  } catch {
    socket.destroy();
    return;
  }
  if (
    url.pathname !== '/api/ws' ||
    !hostAllowed(req.headers.host) ||
    !originAllowed(req.headers.origin) ||
    !isLoopback((socket as any).remoteAddress)
  ) {
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (client) => relay(client, url.searchParams));
}

function relay(client: WebSocket, params: URLSearchParams) {
  const conn = getConnection(params.get('connectionId') || '');
  const op = getOperation(params.get('operationId') || '');
  const model = params.get('model') || '';
  const sendControl = (value: any) => {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(redactValue(value)));
  };
  let stateParams: LabState['params'] = {};
  let target: string;
  let headers: Record<string, string>;
  try {
    if (!conn || !op?.realtime || conn.providerId !== op.providerId)
      throw new Error('连接或实时操作不存在，或厂商不一致');
    requireCostConfirmation(op.costTier, params.get('confirmCost') === '1', op.costHint);
    const rawParams = params.get('params');
    if (rawParams) stateParams = JSON.parse(rawParams);
    validateOperationInput(
      { ...op, workbench: 'realtime' },
      { model, input: {}, params: stateParams, extra: connectionExtra(conn) },
    );
    const vars = { ...connectionExtra(conn), model };
    const spec = op.realtime;
    target = spec.url
      ? fillTemplate(spec.url, vars)
      : buildUrl(conn.baseUrl, fillTemplate(spec.path, vars), conn.providerId).replace(/^http/, 'ws');
    if (!/^wss?:\/\//.test(target)) throw new Error('实时操作必须使用 ws(s) 地址');
    if (op.id === 'qwen.realtime' && !new URL(target).hostname.endsWith('.maas.aliyuncs.com'))
      throw new Error(
        'Qwen Realtime 需要控制台分配的 Workspace 专属域名（*.maas.aliyuncs.com），不能使用公共 DashScope 地址；请修改此连接的 Base URL',
      );
    const auth = applyAuth(conn, target.replace(/^ws/, 'http'), { method: 'GET' });
    headers = auth.headers;
    target = auth.url.replace(/^http/, 'ws');
  } catch (e: any) {
    sendControl({
      type: 'playground.error',
      message: e.message,
      costConfirm: e.constructor?.name === 'CostConfirmationRequired',
    });
    client.close(1008);
    return;
  }
  // The validated operation and connection remain available throughout this session.
  const connection = conn!;
  const operation = op!;
  const runId = shortId();
  const started = performance.now();
  const events: TraceEvent[] = [];
  let traceBytes = 0;
  let omitted = false;
  let failure = false;
  let closed = false;
  let remoteClosed = false;
  let sent = 0;
  let received = 0;
  let firstRecv: number | undefined;
  let pendingBytes = 0;
  const usage: Record<string, any> = {};
  const usageResponses = new Set<string>();
  const accumulate = (total: Record<string, any>, value: Record<string, any>) => {
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === 'number' && Number.isFinite(item))
        total[key] = (typeof total[key] === 'number' ? total[key] : 0) + item;
      else if (item && typeof item === 'object' && !Array.isArray(item)) accumulate((total[key] ??= {}), item);
      else total[key] = item;
    }
  };
  const pending: { payload: string | Buffer; binary: boolean }[] = [];
  const { agent, route } = wsAgent(target, connection.network);
  const log = (type: TraceEvent['type'], data: any) => {
    if (type === 'error') failure = true;
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data);
      } catch {
        /* native text */
      }
    }
    const safe = redactValue(data);
    traceBytes += Buffer.byteLength(JSON.stringify(safe) ?? '');
    if (traceBytes <= MAX_TRACE) events.push({ t: Math.round(performance.now() - started), type, data: safe });
    else if (!omitted) {
      omitted = true;
      const message = '实时记录超过 64 MB，后续媒体消息继续转发但不再记录；本会话不支持完整回放';
      events.push({ t: Math.round(performance.now() - started), type: 'info', data: { message } });
      sendControl({ type: 'playground.trace_limit', message });
    }
  };
  const state: LabState = {
    connectionId: connection.id,
    operationId: operation.id,
    model,
    input: {},
    params: stateParams,
  };
  insertRun({
    id: runId,
    providerId: connection.providerId,
    connectionId: connection.id,
    operationId: operation.id,
    model,
    title: `${operation.title} · ${model}`,
    lifecycle: 'ws',
    input: { model },
    parentId: params.get('parentId'),
    groupId: params.get('groupId'),
    request: {
      url: redactText(target),
      headers: redactHeaders(headers),
      route: describeRoute(route),
      connectionSnapshot: {
        id: connection.id,
        label: connection.label,
        baseUrl: connection.baseUrl,
        network: connection.network,
        keyPreview: connection.keyPreview,
      },
    },
    state,
  });
  sendControl({ type: 'playground.run', runId, url: redactText(target), route: describeRoute(route) });
  let upstream: WebSocket;
  try {
    upstream = new WebSocket(target, { headers, agent, handshakeTimeout: 30_000, maxPayload: 16 * 1024 * 1024 });
  } catch (e: any) {
    log('error', { message: e.message });
    finish();
    client.close(1011);
    return;
  }

  function finish(cancelled = false) {
    if (closed) return;
    closed = true;
    finishRun(runId, {
      status: failure ? 'error' : cancelled ? 'cancelled' : 'ok',
      events,
      metrics: {
        totalMs: Math.round(performance.now() - started),
        firstTokenMs: firstRecv,
        chunks: sent + received,
        usage: Object.keys(usage).length ? usage : undefined,
      },
      summary: `实时会话：发送 ${sent} 条、接收 ${received} 条消息${omitted ? '（记录达到上限）' : ''}`,
      error: failure ? { title: '实时会话出现错误', hints: ['查看事件流中的 error 事件'] } : undefined,
    });
  }
  function fail(message: string) {
    log('error', { message });
    sendControl({ type: 'playground.error', message });
    finish();
    client.close(1011);
    upstream.terminate();
  }
  upstream.on('open', () => {
    if (closed || client.readyState !== WebSocket.OPEN) {
      upstream.close();
      return;
    }
    log('info', { message: 'upstream connected' });
    sendControl({ type: 'playground.upstream_open', t: Math.round(performance.now() - started) });
    for (const m of pending.splice(0)) upstream.send(m.payload, { binary: m.binary });
    pendingBytes = 0;
  });
  upstream.on('message', (data, isBinary) => {
    if (closed) return;
    received++;
    if (firstRecv === undefined) firstRecv = Math.round(performance.now() - started);
    if (client.bufferedAmount > MAX_BUFFER) {
      fail('浏览器接收缓冲区已满，会话已终止');
      return;
    }
    if (isBinary) {
      log('ws-recv', { binary: true, bytes: (data as Buffer).length, base64: (data as Buffer).toString('base64') });
      if (client.readyState === WebSocket.OPEN) client.send(data, { binary: true });
    } else {
      let value: any = data.toString();
      try {
        value = JSON.parse(value);
      } catch {
        /* native text frame */
      }
      if (value?.type === 'response.done' && value.response?.usage) {
        const responseId = value.response.id;
        if (!responseId || !usageResponses.has(responseId)) {
          accumulate(usage, value.response.usage);
          if (responseId) usageResponses.add(responseId);
          sendControl({ type: 'playground.usage', usage });
        }
      }
      if (value?.type === 'response.done' && value.response?.status === 'failed')
        log('error', value.response.status_details ?? value.response);
      if (extractVendorError(value) || value?.type === 'error') log('error', value);
      log('ws-recv', value);
      const safe = redactValue(value);
      if (client.readyState === WebSocket.OPEN) client.send(typeof safe === 'string' ? safe : JSON.stringify(safe));
    }
  });
  upstream.on('unexpected-response', (_req, res) => {
    let body = '';
    res.on('data', (chunk) => {
      if (body.length < 64_000) body += chunk.toString();
    });
    res.on('error', (e) => fail(`上游握手响应中断：${e.message}`));
    res.on('end', () => fail(`上游拒绝连接：HTTP ${res.statusCode} ${redactText(body).slice(0, 2000)}`));
  });
  upstream.on('error', (e) => fail(`上游错误：${redactText(e.message)}`));
  upstream.on('close', (code, reason) => {
    remoteClosed = true;
    if (closed) return;
    if (code !== 1000 && code !== 1001) log('error', { message: '上游异常关闭', code, reason: reason.toString() });
    else log('info', { message: 'upstream closed', code, reason: reason.toString() });
    sendControl({ type: 'playground.upstream_closed', code, reason: reason.toString() });
    finish();
    client.close();
  });
  client.on('message', (data, isBinary) => {
    if (closed) return;
    sent++;
    const payload = isBinary ? (data as Buffer) : data.toString();
    if (!isBinary) {
      try {
        const value = JSON.parse(payload as string);
        if (value?.type === 'session.update' && value.session && typeof value.session === 'object') {
          state.input.session = value.session;
          db.prepare('UPDATE runs SET state_json = ? WHERE id = ?').run(JSON.stringify(redactValue(state)), runId);
        }
      } catch {
        /* native non-JSON text frames remain valid */
      }
    }
    log(
      'ws-send',
      isBinary
        ? { binary: true, bytes: (data as Buffer).length, base64: (data as Buffer).toString('base64') }
        : payload,
    );
    if (upstream.bufferedAmount > MAX_BUFFER) {
      fail('上游发送缓冲区已满，会话已终止');
      return;
    }
    if (upstream.readyState === WebSocket.OPEN) upstream.send(payload, { binary: isBinary });
    else if (upstream.readyState === WebSocket.CONNECTING) {
      pendingBytes += Buffer.byteLength(payload);
      if (pendingBytes > MAX_BUFFER) {
        fail('等待上游连接的消息超过 8 MB，会话已终止');
        return;
      }
      pending.push({ payload, binary: isBinary });
    }
  });
  client.on('error', (e) => fail(`浏览器连接错误：${e.message}`));
  client.on('close', () => {
    finish(!remoteClosed);
    if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    else if (upstream.readyState === WebSocket.OPEN) upstream.close();
  });
}
