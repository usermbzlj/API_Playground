import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { streamSSE } from 'hono/streaming';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { db, json, now, getSetting, setSetting } from './db.ts';
import {
  listConnections,
  getConnection,
  createConnection,
  updateConnection,
  removeConnection,
  setLastTest,
  authHeaders,
  connectionExtra,
  buildUrl,
} from './connections.ts';
import { executeRun, CostConfirmationRequired } from './execute.ts';
import { listRuns, getRun, updateRunMeta, deleteRun } from './runs.ts';
import { saveAsset, getAsset, getAssetFile, listAssets, deleteAsset, mimeFromName } from './assets.ts';
import { listTasks, getTaskDetail, pollTask, cancelTask, startTaskPoller } from './tasks.ts';
import { handleUpgrade } from './ws.ts';
import { redactValue } from './secrets.ts';
import { hostAllowed, isLoopback, originAllowed } from './guard.ts';
import { catalogSnapshot, getOperation, getProvider, BUILTIN_PRESETS } from '../shared/catalog.ts';
import { diagnose } from '../shared/diagnose.ts';
import { shortId } from '../shared/util.ts';

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || '127.0.0.1';

const app = new Hono();

// Block cross-site requests and DNS rebinding: credentials must only be usable from the local UI.
app.use('/api/*', async (c, next) => {
  if (!hostAllowed(c.req.header('host'))) return c.json({ error: '仅允许本机访问' }, 403);
  if (!originAllowed(c.req.header('origin'))) return c.json({ error: '跨站请求被拒绝' }, 403);
  // 绑定 0.0.0.0 时 Host 头可被伪造，用真实对端地址兜底。
  const remote = (c.req.raw as any).socket?.remoteAddress as string | undefined;
  if (!isLoopback(remote)) return c.json({ error: '仅允许本机访问' }, 403);
  await next();
});

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

// ---- connections ----
app.get('/api/connections', (c) => c.json(listConnections()));
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
    return c.json(updateConnection(c.req.param('id'), await c.req.json()));
  } catch (e: any) {
    return c.json({ error: e.message }, 400);
  }
});
app.delete('/api/connections/:id', (c) => {
  removeConnection(c.req.param('id'));
  return c.json({ ok: true });
});

async function connectionGet(connId: string, path: string, method: 'GET' | 'POST' = 'GET', baseOverride?: string) {
  const conn = getConnection(connId);
  if (!conn) throw new Error('连接不存在');
  // baseOverride only comes from the built-in provider catalog, never from the request.
  const url = baseOverride ? baseOverride + path : buildUrl(conn.baseUrl, path);
  const started = performance.now();
  const res = await fetch(url, { method, headers: authHeaders(conn), signal: AbortSignal.timeout(20_000) });
  const text = await res.text();
  let body: any = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* text */
  }
  return { conn, status: res.status, ok: res.ok, body, ms: Math.round(performance.now() - started) };
}

app.get('/api/connections/:id/models', async (c) => {
  const conn = getConnection(c.req.param('id'));
  if (!conn) return c.json({ error: '连接不存在' }, 404);
  const provider = getProvider(conn.providerId);
  const path = c.req.query('path') || provider?.modelsPath;
  if (!path) return c.json({ error: '该厂商未提供模型列表接口' }, 400);
  try {
    const r = await connectionGet(conn.id, path);
    if (!r.ok) return c.json({ error: diagnose({ providerId: conn.providerId, httpStatus: r.status, body: r.body }), raw: r.body }, 502);
    return c.json({ raw: redactValue(r.body), ms: r.ms });
  } catch (e: any) {
    return c.json({ error: diagnose({ providerId: conn.providerId, networkError: e.message }) }, 502);
  }
});

app.post('/api/connections/:id/test', async (c) => {
  const conn = getConnection(c.req.param('id'));
  if (!conn) return c.json({ error: '连接不存在' }, 404);
  const provider = getProvider(conn.providerId);
  const probe = provider?.balance ?? (provider?.modelsPath ? { method: 'GET' as const, path: provider.modelsPath } : undefined);
  if (!probe) {
    const result = { ok: true, message: '该厂商没有无副作用的测试接口；请在工作台中直接试用' };
    setLastTest(conn.id, result);
    return c.json(result);
  }
  try {
    const r = await connectionGet(conn.id, probe.path, probe.method, probe.baseUrlOverride);
    const d = r.ok ? undefined : diagnose({ providerId: conn.providerId, httpStatus: r.status, body: r.body });
    const result = {
      ok: r.ok && !d?.vendorCode,
      message: r.ok ? `连接正常（${r.ms} ms）` : `${d!.title}：${d!.vendorMessage ?? ''} ${d!.hints[0] ?? ''}`.trim(),
      body: redactValue(r.body),
    };
    setLastTest(conn.id, result);
    return c.json(result);
  } catch (e: any) {
    const d = diagnose({ providerId: conn.providerId, networkError: e.message });
    const result = { ok: false, message: `${d.title}：${d.hints[0]}` };
    setLastTest(conn.id, result);
    return c.json(result);
  }
});

app.get('/api/connections/:id/balance', async (c) => {
  const conn = getConnection(c.req.param('id'));
  if (!conn) return c.json({ error: '连接不存在' }, 404);
  const provider = getProvider(conn.providerId);
  if (!provider?.balance) return c.json({ error: '该厂商未提供余额接口' }, 400);
  try {
    const r = await connectionGet(conn.id, provider.balance.path, provider.balance.method, provider.balance.baseUrlOverride);
    return c.json({ ok: r.ok, status: r.status, body: redactValue(r.body) });
  } catch (e: any) {
    return c.json({ error: e.message }, 502);
  }
});

// ---- catalog ----
app.get('/api/catalog', (c) => c.json(catalogSnapshot()));

// ---- runs ----
app.post('/api/run', async (c) => {
  const input = await c.req.json();
  let request = input.request;
  // 有 operationId 时由服务端用同一份定义构建原生请求，保证与 UI 预览一致。
  if (!request && input.operationId) {
    const conn = getConnection(input.connectionId);
    const op = getOperation(input.operationId);
    if (!conn) return c.json({ error: '连接不存在，请先在「连接」中添加 API Key' }, 400);
    if (!op) return c.json({ error: '操作不存在' }, 400);
    // 防止把 A 厂商的操作发到 B 厂商的连接上（UI 已过滤，API 层必须强制）。
    if (conn.providerId !== op.providerId) {
      return c.json({ error: `操作 ${op.id} 属于厂商 ${op.providerId}，与所选连接（${conn.providerId}）不一致` }, 400);
    }
    try {
      request = op.build({
        model: input.model ?? op.defaultModel ?? '',
        input: input.input ?? {},
        extra: connectionExtra(conn),
        params: input.params ?? {},
      });
    } catch (e: any) {
      // 参数非法（如 JSON 参数解析失败）在此转成可读错误，而不是裸 500。
      return c.json({ error: `构建请求失败：${e.message}` }, 400);
    }
  }
  if (!request) return c.json({ error: '缺少请求定义（request 或 operationId）' }, 400);
  const controller = new AbortController();
  c.req.raw.signal.addEventListener('abort', () => controller.abort());
  return streamSSE(c, async (stream) => {
    stream.onAbort(() => controller.abort());
    try {
      await executeRun(
        { ...input, request },
        (ev) => {
          stream.writeSSE({ data: JSON.stringify(ev) }).catch(() => {});
        },
        controller.signal,
      );
    } catch (e: any) {
      const payload =
        e instanceof CostConfirmationRequired
          ? { type: 'error', t: 0, data: { title: '需要确认费用', costConfirm: true, hints: [e.message, e.hint].filter(Boolean) } }
          : { type: 'error', t: 0, data: { title: '无法执行', hints: [e.message] } };
      await stream.writeSSE({ data: JSON.stringify(payload) });
      await stream.writeSSE({ data: JSON.stringify({ type: 'done', t: 0, data: { status: 'error' } }) });
    }
  });
});

app.get('/api/runs', (c) =>
  c.json(
    listRuns({
      limit: Number(c.req.query('limit') || 100),
      operationId: c.req.query('operationId'),
      providerId: c.req.query('providerId'),
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
  deleteRun(c.req.param('id'));
  return c.json({ ok: true });
});

// ---- assets ----
const MAX_UPLOAD_BYTES = Number(process.env.PLAYGROUND_MAX_UPLOAD || 100 * 1024 * 1024);
app.post('/api/assets', async (c) => {
  const form = await c.req.formData();
  const file = form.get('file');
  if (!(file instanceof File)) return c.json({ error: '缺少文件' }, 400);
  if (file.size > MAX_UPLOAD_BYTES) {
    const limit = MAX_UPLOAD_BYTES >= 1024 * 1024 ? `${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB` : `${Math.round(MAX_UPLOAD_BYTES / 1024)} KB`;
    return c.json({ error: `文件超过大小上限（${limit}）` }, 413);
  }
  const data = Buffer.from(await file.arrayBuffer());
  const mime = file.type || mimeFromName(file.name) || 'application/octet-stream';
  return c.json(saveAsset({ data, mime, filename: file.name, source: 'upload' }));
});
app.get('/api/assets', (c) => c.json(listAssets({ runId: c.req.query('runId'), kind: c.req.query('kind'), limit: Number(c.req.query('limit') || 200) })));
app.get('/api/assets/:id', (c) => {
  const a = getAsset(c.req.param('id'));
  return a ? c.json(a) : c.json({ error: '素材不存在' }, 404);
});
app.get('/api/assets/:id/raw', (c) => {
  const f = getAssetFile(c.req.param('id'));
  if (!f) return c.text('not found', 404);
  const data = readFileSync(f.path);
  return c.body(data, 200, {
    'Content-Type': f.mime,
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(f.filename)}`,
    'Cache-Control': 'private, max-age=31536000, immutable',
  });
});
app.delete('/api/assets/:id', (c) => {
  deleteAsset(c.req.param('id'));
  return c.json({ ok: true });
});

// ---- tasks ----
app.get('/api/tasks', (c) => c.json(listTasks(Number(c.req.query('limit') || 100))));
app.get('/api/tasks/:id', (c) => {
  const t = getTaskDetail(c.req.param('id'));
  return t ? c.json(t) : c.json({ error: '任务不存在' }, 404);
});
app.post('/api/tasks/:id/poll', async (c) => {
  const t = await pollTask(c.req.param('id'));
  return t ? c.json(t) : c.json({ error: '任务不存在' }, 404);
});
app.post('/api/tasks/:id/cancel', async (c) => c.json(await cancelTask(c.req.param('id'))));

// ---- user presets ----
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
  return c.json([...BUILTIN_PRESETS.map((p) => ({ ...p, user: false })), ...user]);
});
app.post('/api/presets', async (c) => {
  const b = await c.req.json();
  if (!b.operationId || !getOperation(b.operationId)) return c.json({ error: 'operationId 不存在于目录中' }, 400);
  if (!b.title) return c.json({ error: '缺少标题' }, 400);
  const id = shortId();
  db.prepare('INSERT INTO presets(id, operation_id, title, description, model, input_json, params_json, created_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?)').run(
    id,
    b.operationId,
    b.title,
    b.description ?? '',
    b.model ?? null,
    JSON.stringify(b.input ?? {}),
    JSON.stringify(b.params ?? {}),
    now(),
  );
  return c.json({ id });
});
app.delete('/api/presets/:id', (c) => {
  db.prepare('DELETE FROM presets WHERE id = ?').run(c.req.param('id'));
  return c.json({ ok: true });
});

// ---- settings ----
app.get('/api/settings', (c) => c.json(getSetting('ui', { confirmMedium: false })));
app.put('/api/settings', async (c) => {
  setSetting('ui', await c.req.json());
  return c.json({ ok: true });
});

app.get('/api/health', (c) => c.json({ ok: true, time: now() }));

// ---- static (production build) ----
const DIST = join(process.cwd(), 'dist');
if (existsSync(DIST)) {
  app.use('/*', serveStatic({ root: './dist' }));
  app.get('*', (c) => c.html(readFileSync(join(DIST, 'index.html'), 'utf8')));
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`API Playground 本地服务已启动：http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${info.port}`);
  if (HOST === '0.0.0.0' || HOST === '::') {
    console.warn('⚠ HOST 已设为 0.0.0.0：服务暴露给局域网。API 仅放行本机回环地址，但请勿在不可信网络中使用。');
  }
});
(server as any).on('upgrade', handleUpgrade);
startTaskPoller();
