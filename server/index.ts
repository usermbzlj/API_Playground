import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { bodyLimit } from 'hono/body-limit';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { readFileSync, existsSync, statSync, createReadStream } from 'node:fs';
import { Readable } from 'node:stream';
import { join } from 'node:path';
import { db, json, now, getSetting, setSetting } from './db.ts';
import {
  listConnections,
  getConnection,
  createConnection,
  updateConnection,
  removeConnection,
  setLastTest,
  applyAuth,
  connectionExtra,
  buildUrl,
} from './connections.ts';
import { executeRun, CostConfirmationRequired, requireCostConfirmation } from './execute.ts';
import { listRuns, getRun, updateRunMeta, deleteRun, evidence, recoverInterruptedRuns } from './runs.ts';
import {
  saveAsset,
  getAsset,
  getAssetFile,
  listAssets,
  deleteAsset,
  mimeFromName,
  saveRemoteRef,
  assetLibrary,
  cleanupAssets,
  validateAssetKind,
} from './assets.ts';
import { listTasks, getTaskDetail, pollTask, cancelTask, startTaskPoller } from './tasks.ts';
import { handleUpgrade } from './ws.ts';
import { redactValue, redactText } from './secrets.ts';
import { hostAllowed, isLoopback, originAllowed } from './guard.ts';
import {
  netFetch,
  getNetworkSettings,
  getNetworkInfo,
  validateNetworkSettings,
  setNetworkSettings,
  proxyUrl,
  proxySource,
  resolveRoute,
  describeRoute,
  readResponseBuffer,
} from './net.ts';
import { detectEnvKeys, importEnvKey } from './envkeys.ts';
import { importCredentialDocument } from './credential-import.ts';
import { registerBenchRoutes, shutdownBenchmarks } from './bench.ts';
import { catalogSnapshot, getOperation, getProvider } from '../shared/catalog.ts';
import { diagnose, extractVendorError } from '../shared/diagnose.ts';
import { parseModelList } from '../shared/models.ts';
import { shortId } from '../shared/util.ts';
import { validateOperationInput } from '../shared/validate.ts';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

const app = new Hono();

// Block cross-site requests and DNS rebinding: credentials must only be usable from the local UI.
app.use('/api/*', async (c, next) => {
  if (!hostAllowed(c.req.header('host'))) return c.json({ error: '仅允许本机访问' }, 403);
  if (!originAllowed(c.req.header('origin'))) return c.json({ error: '跨站请求被拒绝' }, 403);
  // With HOST=0.0.0.0 the Host header can be forged; fall back to the real peer address.
  const remote = getConnInfo(c).remote.address;
  if (!isLoopback(remote)) return c.json({ error: '仅允许本机访问' }, 403);
  await next();
  // Also protect responses from older local records and accidental upstream credential echoes.
  if (c.res.headers.get('content-type')?.includes('application/json')) {
    const value = await c.res.json();
    c.res = new Response(JSON.stringify(redactValue(value)), { status: c.res.status, headers: c.res.headers });
    c.res.headers.delete('content-length');
  }
});

app.onError((err, c) => {
  console.error(redactText(err.message));
  return c.json({ error: redactText(err.message) }, 500);
});

// ---- connections ----
app.get('/api/connections', (c) => c.json(listConnections()));
app.post(
  '/api/connections/import',
  bodyLimit({ maxSize: 600 * 1024, onError: (c) => c.json({ error: '凭证文件上限为 512 KB' }, 413) }),
  async (c) => {
    try {
      const body = await c.req.json();
      if (typeof body.text !== 'string' || (body.apply !== undefined && typeof body.apply !== 'boolean'))
        return c.json({ error: '需要文本文件内容和布尔 apply 标志' }, 400);
      return c.json(await importCredentialDocument(body.text, body.apply === true));
    } catch {
      return c.json({ error: '无法解析凭证文件，请检查格式与文件大小' }, 400);
    }
  },
);
app.post('/api/connections', async (c) => {
  const b = await c.req.json();
  if (!b.apiKey) return c.json({ error: '缺少 API Key' }, 400);
  try {
    return c.json(createConnection(b));
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});
app.patch('/api/connections/:id', async (c) => {
  try {
    modelCache.delete(c.req.param('id'));
    modelRevisions.set(c.req.param('id'), (modelRevisions.get(c.req.param('id')) ?? 0) + 1);
    return c.json(updateConnection(c.req.param('id'), await c.req.json()));
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});
app.delete('/api/connections/:id', (c) => {
  try {
    removeConnection(c.req.param('id'));
  } catch (e: any) {
    return c.json({ error: e.message }, 409);
  }
  modelCache.delete(c.req.param('id'));
  modelRevisions.set(c.req.param('id'), (modelRevisions.get(c.req.param('id')) ?? 0) + 1);
  return c.json({ ok: true });
});

async function connectionRequest(connId: string, path: string, method: 'GET' | 'POST' = 'GET', baseOverride?: string) {
  const conn = getConnection(connId);
  if (!conn) throw new Error('连接不存在');
  // baseOverride only comes from the built-in provider catalog, never from the request.
  const raw = baseOverride ? baseOverride + path : buildUrl(conn.baseUrl, path, conn.providerId);
  const auth = applyAuth(conn, raw, { method });
  const started = performance.now();
  const res = await netFetch(auth.url, {
    method,
    headers: auth.headers,
    signal: AbortSignal.timeout(20_000),
    network: conn.network,
  });
  const text = (await readResponseBuffer(res)).toString('utf8');
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return {
    conn,
    status: res.status,
    ok: res.ok && !extractVendorError(body),
    body,
    ms: Math.round(performance.now() - started),
    route: describeRoute(resolveRoute(raw, conn.network)),
  };
}

const modelCache = new Map<string, { at: number; data: any }>();
const modelRevisions = new Map<string, number>();

app.get('/api/connections/:id/models', async (c) => {
  const conn = getConnection(c.req.param('id'));
  if (!conn) return c.json({ error: '连接不存在' }, 404);
  const provider = getProvider(conn.providerId);
  const revision = modelRevisions.get(conn.id) ?? 0;
  const path = c.req.query('path') || provider?.modelsPath;
  if (!path) return c.json({ error: '该厂商未提供模型列表接口' }, 400);
  const cached = modelCache.get(conn.id);
  if (cached && !c.req.query('refresh') && !c.req.query('path') && Date.now() - cached.at < 10 * 60_000)
    return c.json(cached.data);
  try {
    const r = await connectionRequest(conn.id, path);
    if (!r.ok)
      return c.json(
        {
          error: diagnose({ providerId: conn.providerId, httpStatus: r.status, body: r.body }),
          raw: redactValue(r.body),
        },
        502,
      );
    const data = { raw: redactValue(r.body), models: parseModelList(r.body), ms: r.ms, at: now() };
    if (!c.req.query('path') && revision === (modelRevisions.get(conn.id) ?? 0))
      modelCache.set(conn.id, { at: Date.now(), data });
    return c.json(data);
  } catch (e: any) {
    return c.json({ error: diagnose({ providerId: conn.providerId, networkError: e.message }) }, 502);
  }
});

app.post('/api/connections/:id/test', async (c) => {
  const conn = getConnection(c.req.param('id'));
  if (!conn) return c.json({ error: '连接不存在' }, 404);
  const provider = getProvider(conn.providerId);
  const revision = modelRevisions.get(conn.id) ?? 0;
  const probe = provider?.modelsPath ? { method: 'GET' as const, path: provider.modelsPath } : provider?.balance;
  if (!probe) {
    const result = {
      ok: null,
      verified: false,
      message: '尚未验证：该厂商没有无副作用的测试接口。请在实验台确认费用后试用一次。',
    };
    setLastTest(conn.id, result);
    return c.json(result);
  }
  try {
    const r = await connectionRequest(
      conn.id,
      probe.path,
      probe.method,
      'baseUrlOverride' in probe ? (probe as any).baseUrlOverride : undefined,
    );
    const d = r.ok ? undefined : diagnose({ providerId: conn.providerId, httpStatus: r.status, body: r.body });
    const models = r.ok ? parseModelList(r.body) : [];
    const result = {
      ok: r.ok && !d?.vendorCode,
      message: r.ok
        ? `连接正常（${r.ms} ms，${r.route}）${models.length ? `，账号可见 ${models.length} 个模型` : ''}`
        : `${d!.title}：${d!.vendorMessage ?? ''} ${d!.hints[0] ?? ''}`.trim(),
    };
    if (r.ok && provider?.modelsPath && revision === (modelRevisions.get(conn.id) ?? 0))
      modelCache.set(conn.id, { at: Date.now(), data: { raw: redactValue(r.body), models, ms: r.ms, at: now() } });
    if (revision === (modelRevisions.get(conn.id) ?? 0)) setLastTest(conn.id, result);
    return c.json(result);
  } catch (e: any) {
    const d = diagnose({
      providerId: conn.providerId,
      networkError: `${e.message}${e?.cause?.code ? ` (${e.cause.code})` : ''}`,
    });
    const result = { ok: false, message: `${d.title}：${d.hints[0]}` };
    if (revision === (modelRevisions.get(conn.id) ?? 0)) setLastTest(conn.id, result);
    return c.json(result);
  }
});

app.get('/api/connections/:id/balance', async (c) => {
  const conn = getConnection(c.req.param('id'));
  if (!conn) return c.json({ error: '连接不存在' }, 404);
  const provider = getProvider(conn.providerId);
  if (!provider?.balance) return c.json({ error: '该厂商未提供余额接口' }, 400);
  try {
    const r = await connectionRequest(
      conn.id,
      provider.balance.path,
      provider.balance.method,
      provider.balance.baseUrlOverride,
    );
    return c.json({ ok: r.ok, status: r.status, body: redactValue(r.body) });
  } catch (e: any) {
    return c.json({ error: e.message }, 502);
  }
});

// ---- env keys ----
app.get('/api/env-keys', (c) => c.json(detectEnvKeys()));
app.post('/api/env-keys/import', async (c) => {
  const b = await c.req.json();
  try {
    return c.json(importEnvKey(String(b.envName), String(b.providerId), b.baseUrlId));
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});

// ---- catalog (for external tools; the web UI imports shared/catalog.ts directly) ----
app.get('/api/catalog', (c) => c.json(catalogSnapshot()));

// ---- runs ----
app.post('/api/run', async (c) => {
  const input = await c.req.json();
  let request = input.request;
  const explicitRequest = !!request;
  if (input.operationId) {
    const conn = getConnection(input.connectionId);
    const op = getOperation(input.operationId);
    if (!conn || !op || conn.providerId !== op.providerId)
      return c.json({ error: '操作与连接不存在或厂商不一致' }, 400);
    input.model ??= op.defaultModel ?? '';
  }
  // With an operationId the server builds the native request from the same definition the UI previews.
  if (!request && input.operationId) {
    const conn = getConnection(input.connectionId);
    const op = getOperation(input.operationId);
    if (!conn) return c.json({ error: '连接不存在，请先在「连接」中添加 API Key' }, 400);
    if (!op) return c.json({ error: '操作不存在' }, 400);
    if (conn.providerId !== op.providerId) {
      return c.json({ error: `操作 ${op.id} 属于厂商 ${op.providerId}，与所选连接（${conn.providerId}）不一致` }, 400);
    }
    try {
      validateOperationInput(op, {
        model: input.model ?? op.defaultModel ?? '',
        input: input.input ?? {},
        params: input.params ?? {},
        extra: connectionExtra(conn),
      });
      request = op.build({
        model: input.model ?? op.defaultModel ?? '',
        input: input.input ?? {},
        extra: connectionExtra(conn),
        params: input.params ?? {},
      });
    } catch (e: any) {
      return c.json({ error: `构建请求失败：${e.message}` }, 400);
    }
  }
  if (!request) return c.json({ error: '缺少请求定义（request 或 operationId）' }, 400);
  const controller = new AbortController();
  if (c.req.raw.signal.aborted) controller.abort();
  c.req.raw.signal.addEventListener('abort', () => controller.abort(), { once: true });
  return streamSSE(c, async (stream) => {
    stream.onAbort(() => controller.abort());
    try {
      if (explicitRequest) requireCostConfirmation(undefined, input.confirmCost);
      let pending = Promise.resolve();
      await executeRun(
        { ...input, request },
        (ev) => {
          pending = pending
            .then(() => stream.writeSSE({ data: JSON.stringify(ev) }))
            .catch(() => {
              controller.abort();
            });
        },
        controller.signal,
      );
      await pending;
    } catch (e: any) {
      const payload =
        e instanceof CostConfirmationRequired
          ? {
              type: 'error',
              t: 0,
              data: { title: '需要确认费用', costConfirm: true, hints: [e.message, e.hint].filter(Boolean) },
            }
          : { type: 'error', t: 0, data: { title: '无法执行', hints: [redactText(e.message)] } };
      await stream.writeSSE({ data: JSON.stringify(payload) });
      await stream.writeSSE({ data: JSON.stringify({ type: 'done', t: 0, data: { status: 'error' } }) });
    }
  });
});

app.get('/api/runs', (c) =>
  c.json(
    listRuns({
      limit: Number(c.req.query('limit') || 100),
      offset: Number(c.req.query('offset') || 0),
      operationId: c.req.query('operationId'),
      providerId: c.req.query('providerId'),
      groupId: c.req.query('groupId'),
      ids: c.req.query('ids')?.split(',').filter(Boolean),
      starred: c.req.query('starred') === '1',
      q: c.req.query('q'),
    }),
  ),
);
app.get('/api/runs/:id', (c) => {
  const r = getRun(c.req.param('id'));
  return r ? c.json(r) : c.json({ error: '记录不存在' }, 404);
});
app.patch('/api/runs/:id', async (c) => {
  const existing = getRun(c.req.param('id'));
  if (!existing) return c.json({ error: '记录不存在' }, 404);
  updateRunMeta(c.req.param('id'), await c.req.json());
  return c.json(getRun(c.req.param('id')));
});
app.delete('/api/runs/:id', (c) => {
  if (getRun(c.req.param('id'))?.status === 'running')
    return c.json({ error: '此记录仍在运行，请先停止执行或取消异步任务' }, 409);
  deleteRun(c.req.param('id'));
  return c.json({ ok: true });
});
app.get('/api/evidence', (c) => c.json(evidence()));

// ---- assets ----
const MAX_UPLOAD_BYTES = Number(process.env.PLAYGROUND_MAX_UPLOAD || 100 * 1024 * 1024);
app.use(
  '/api/assets',
  bodyLimit({
    maxSize: MAX_UPLOAD_BYTES + 1024 * 1024,
    onError: (c) => c.json({ error: '上传请求超过大小上限' }, 413),
  }),
);
app.post('/api/assets', async (c) => {
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ error: '缺少文件' }, 400);
  if (file.size > MAX_UPLOAD_BYTES) {
    const limit =
      MAX_UPLOAD_BYTES >= 1024 * 1024
        ? `${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB`
        : `${Math.round(MAX_UPLOAD_BYTES / 1024)} KB`;
    return c.json({ error: `文件超过大小上限（${limit}）` }, 413);
  }
  const data = Buffer.from(await file.arrayBuffer());
  const mime = file.type || mimeFromName(file.name) || 'application/octet-stream';
  return c.json(saveAsset({ data, mime, filename: file.name, source: 'upload' }));
});
app.post('/api/assets/url', async (c) => {
  const b = await c.req.json();
  let u: URL;
  try {
    u = new URL(String(b.url));
    if (!/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error();
  } catch {
    return c.json({ error: '请输入 http(s) 链接' }, 400);
  }
  let kind: string;
  try {
    kind = validateAssetKind(b.kind || 'image');
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
  const mime =
    mimeFromName(u.pathname) || (kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : 'image/png');
  return c.json(saveRemoteRef(u.toString(), kind, mime));
});
app.get('/api/assets', (c) => {
  try {
    return c.json(
      listAssets({
        runId: c.req.query('runId'),
        kind: c.req.query('kind'),
        q: c.req.query('q'),
        limit: Number(c.req.query('limit') || 200),
        offset: Number(c.req.query('offset') || 0),
      }),
    );
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});
app.get('/api/assets/library', (c) => {
  try {
    return c.json(
      assetLibrary({
        kind: c.req.query('kind'),
        q: c.req.query('q'),
        unused: c.req.query('unused') === '1',
        limit: Number(c.req.query('limit') || 48),
        offset: Number(c.req.query('offset') || 0),
      }),
    );
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});
app.post('/api/assets/cleanup', async (c) => {
  try {
    const body = await c.req.json();
    return c.json(cleanupAssets(body.ids));
  } catch (e: any) {
    return c.json({ error: e.message }, 409);
  }
});
app.get('/api/assets/:id', (c) => {
  const a = getAsset(c.req.param('id'));
  return a ? c.json(a) : c.json({ error: '素材不存在' }, 404);
});
app.get('/api/assets/:id/raw', (c) => {
  const a = getAsset(c.req.param('id'));
  if (a && a.size === 0 && a.remoteUrl) return c.redirect(a.remoteUrl);
  const f = getAssetFile(c.req.param('id'));
  if (!f) return c.text('not found', 404);
  const size = statSync(f.path).size;
  const headers: Record<string, string> = {
    'Content-Type': f.mime,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
    'Cache-Control': 'private, max-age=31536000, immutable',
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "sandbox; default-src 'none'; media-src 'self'; img-src 'self' data:; style-src 'unsafe-inline'",
  };
  const range = c.req.header('range');
  let start = 0;
  let end = size - 1;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!match || (!match[1] && !match[2]) || size === 0)
      return c.body(null, 416, { ...headers, 'Content-Range': `bytes */${size}` });
    if (!match[1]) start = Math.max(0, size - Number(match[2]));
    else start = Number(match[1]);
    if (match[1] && match[2]) end = Math.min(end, Number(match[2]));
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || start >= size)
      return c.body(null, 416, { ...headers, 'Content-Range': `bytes */${size}` });
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }
  headers['Content-Length'] = String(size ? end - start + 1 : 0);
  if (!size || c.req.method === 'HEAD') return c.body(null, range ? 206 : 200, headers);
  return new Response(Readable.toWeb(createReadStream(f.path, { start, end })) as ReadableStream, {
    status: range ? 206 : 200,
    headers,
  });
});
app.delete('/api/assets/:id', (c) => {
  try {
    deleteAsset(c.req.param('id'));
    return c.json({ ok: true });
  } catch (e: any) {
    return c.json({ error: e.message }, 409);
  }
});

// ---- tasks ----
app.get('/api/tasks', (c) =>
  c.json(listTasks(Number(c.req.query('limit') || 100), Number(c.req.query('offset') || 0))),
);
app.get('/api/tasks/:id', (c) => {
  const t = getTaskDetail(c.req.param('id'));
  return t ? c.json(t) : c.json({ error: '任务不存在' }, 404);
});
app.post('/api/tasks/:id/poll', async (c) => {
  const t = await pollTask(c.req.param('id'));
  return t ? c.json(t) : c.json({ error: '任务不存在' }, 404);
});
app.post('/api/tasks/:id/cancel', async (c) => c.json(await cancelTask(c.req.param('id'))));

// ---- user presets (operationId "raw" = raw request templates) ----
app.get('/api/presets', (c) => {
  const user = (db.prepare('SELECT * FROM presets ORDER BY created_at DESC').all() as any[]).map((r) => ({
    id: r.id,
    operationId: r.operation_id,
    title: r.title,
    description: r.description,
    model: r.model,
    input: json(r.input_json),
    params: json(r.params_json),
    createdAt: r.created_at,
    user: true,
  }));
  return c.json(user);
});
app.post('/api/presets', async (c) => {
  const b = await c.req.json();
  if (!b.operationId || (b.operationId !== 'raw' && !getOperation(b.operationId)))
    return c.json({ error: 'operationId 不存在于目录中' }, 400);
  if (!b.title) return c.json({ error: '缺少标题' }, 400);
  const id = shortId();
  db.prepare(
    'INSERT INTO presets(id, operation_id, title, description, model, input_json, params_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(
    id,
    b.operationId,
    b.title,
    b.description ?? '',
    b.model ?? null,
    JSON.stringify(redactValue(b.input ?? {})),
    JSON.stringify(redactValue(b.params ?? {})),
    now(),
  );
  return c.json({ id });
});
app.delete('/api/presets/:id', (c) => {
  db.prepare('DELETE FROM presets WHERE id = ?').run(c.req.param('id'));
  return c.json({ ok: true });
});

// ---- settings ----
app.get('/api/settings', (c) => c.json(getSetting('ui', { confirmTier: 'high' })));
app.put('/api/settings', async (c) => {
  const body = await c.req.json();
  if (!['high', 'medium', 'all'].includes(body?.confirmTier))
    return c.json({ error: '费用确认档位须为 high、medium 或 all' }, 400);
  setSetting('ui', { confirmTier: body.confirmTier });
  return c.json({ ok: true });
});
app.put('/api/settings/preferences', async (c) => {
  const body = await c.req.json();
  if (!['high', 'medium', 'all'].includes(body?.confirmTier)) return c.json({ error: '费用确认档位无效' }, 400);
  const hasNetwork = body.network && Object.prototype.hasOwnProperty.call(body.network, 'proxyUrl');
  try {
    if (hasNetwork) validateNetworkSettings(body.network);
    db.exec('BEGIN IMMEDIATE');
    try {
      setSetting('ui', { confirmTier: body.confirmTier });
      if (hasNetwork) setNetworkSettings(body.network);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    return c.json({ settings: getSetting('ui', { confirmTier: 'high' }), network: getNetworkInfo() });
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});
app.get('/api/settings/network', (c) => c.json(getNetworkInfo()));
app.put('/api/settings/network', async (c) => {
  try {
    const b = await c.req.json();
    if (Object.prototype.hasOwnProperty.call(b, 'proxyUrl'))
      setNetworkSettings({
        proxyUrl: b.proxyUrl === null || b.proxyUrl === undefined ? null : String(b.proxyUrl).trim(),
      });
    return c.json(getNetworkInfo());
  } catch {
    return c.json({ error: '代理地址格式不正确，例如 http://127.0.0.1:7890' }, 400);
  }
});

registerBenchRoutes(app);
app.get('/api/health', (c) => c.json({ ok: true, time: now(), proxy: getNetworkInfo().effectiveProxy }));
app.all('/api/*', (c) => c.json({ error: '本地 API 路由不存在' }, 404));

// ---- static (production build) ----
const DIST = join(process.cwd(), 'dist');
if (existsSync(DIST)) {
  app.use('/*', async (c, next) => {
    await next();
    if (c.res.headers.get('content-type')?.includes('text/html')) c.header('Cache-Control', 'no-cache');
  });
  app.use('/*', serveStatic({ root: './dist' }));
  app.get('/assets/*', (c) => c.text('页面资源已更新，请重新加载应用', 404));
  app.get('*', (c) => c.html(readFileSync(join(DIST, 'index.html'), 'utf8')));
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`API Playground 本地服务已启动：http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${info.port}`);
  const p = proxyUrl();
  console.log(
    p
      ? `出站代理：${redactText(p)}（来源：${proxySource() === 'env' ? '环境变量' : '设置'}；国内域名默认直连）`
      : '出站代理：未配置（全部直连）',
  );
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.warn('⚠ HOST 已设为 0.0.0.0：服务暴露给局域网。API 仅放行本机回环地址，但请勿在不可信网络中使用。');
  }
});
(server as any).on('upgrade', handleUpgrade);
recoverInterruptedRuns();
startTaskPoller();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    shutdownBenchmarks();
    server.close();
    setTimeout(() => process.exit(0), 150).unref();
  });
}
process.once('exit', shutdownBenchmarks);
