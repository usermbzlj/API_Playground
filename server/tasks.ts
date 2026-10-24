import { db, json, now, pagination } from './db.ts';
import { getConnection, applyAuth, connectionExtra, buildUrl, mergeRequestHeaders } from './connections.ts';
import { netFetch, readResponseBuffer } from './net.ts';
import { storeArtifact, listAssets } from './assets.ts';
import { redactValue } from './secrets.ts';
import { getOperation } from '../shared/catalog.ts';
import { extractVendorError } from '../shared/diagnose.ts';
import { getPath, fillTemplate, shortId, truncateDeep } from '../shared/util.ts';
import type { TaskRecord, NativeRequest } from '../shared/types.ts';

type Listener = (t: TaskRecord) => void;
const listeners = new Set<Listener>();
export function onTaskUpdate(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function rowToTask(r: any): TaskRecord {
  return redactValue({
    id: r.id,
    runId: r.run_id,
    connectionId: r.connection_id,
    operationId: r.operation_id,
    remoteId: r.remote_id,
    status: r.status,
    remoteStatus: r.remote_status,
    progress: r.progress,
    pollCount: r.poll_count,
    lastPollAt: r.last_poll_at,
    nextPollAt: r.next_poll_at,
    retryCount: r.retry_count ?? 0,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    error: r.error,
    title: r.title,
    artifacts: listAssets({ runId: r.run_id }),
  });
}

export function createTask(t: {
  runId: string;
  connectionId: string;
  operationId: string;
  remoteId: string;
  title?: string;
}): string {
  const id = shortId();
  const ts = now();
  db.prepare(
    `INSERT INTO tasks(id, run_id, connection_id, operation_id, remote_id, status, created_at, updated_at, title)
     VALUES(?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(id, t.runId, t.connectionId, t.operationId, t.remoteId, ts, ts, t.title ?? null);
  setTimeout(() => pollTask(id).catch(() => {}), 2000).unref();
  return id;
}

export function getTask(id: string): TaskRecord | undefined {
  const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return r ? rowToTask(r) : undefined;
}

export function getTaskDetail(id: string) {
  const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
  return r ? redactValue({ ...rowToTask(r), lastResponse: json(r.last_response_json) }) : undefined;
}

export function listTasks(limit = 100, offset = 0): TaskRecord[] {
  const page = pagination(limit, offset);
  return (
    db
      .prepare('SELECT * FROM tasks ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?')
      .all(page.limit, page.offset) as any[]
  ).map(rowToTask);
}

async function send(connId: string, req: NativeRequest) {
  const conn = getConnection(connId);
  if (!conn) throw new Error('连接已删除');
  let body: string | undefined;
  const headers: Record<string, string> = {};
  if (req.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.body);
  }
  const auth = applyAuth(conn, buildUrl(conn.baseUrl, req.path, conn.providerId), { method: req.method, body });
  const finalHeaders = mergeRequestHeaders(headers, auth.headers, req.headers);
  const res = await netFetch(auth.url, {
    method: req.method,
    headers: finalHeaders,
    body,
    signal: AbortSignal.timeout(60_000),
    network: conn.network,
  });
  const text = (await readResponseBuffer(res)).toString('utf8');
  let parsed: any = text;
  try {
    parsed = JSON.parse(text);
  } catch {
    /* text */
  }
  return { status: res.status, body: parsed };
}

function appendRunEvent(runId: string, type: string, data: any) {
  const r = db.prepare('SELECT events_json, created_at FROM runs WHERE id = ?').get(runId) as any;
  if (!r) return;
  const events = json<any[]>(r.events_json) ?? [];
  if (events.length > 3000) return;
  events.push({ t: Date.now() - new Date(r.created_at).getTime(), type, data: redactValue(truncateDeep(data, 6000)) });
  db.prepare('UPDATE runs SET events_json = ? WHERE id = ?').run(JSON.stringify(events), runId);
}

const inFlight = new Set<string>();

function finishTracking(id: string, status: 'cancelled' | 'unknown', message: string) {
  const row = db.prepare('SELECT run_id FROM tasks WHERE id = ?').get(id) as any;
  if (!row) return;
  const safe = redactValue(message);
  db.prepare('UPDATE tasks SET status = ?, error = ?, next_poll_at = NULL, updated_at = ? WHERE id = ?').run(
    status,
    safe,
    now(),
    id,
  );
  db.prepare('UPDATE runs SET status = ?, summary = ?, error_json = ? WHERE id = ?').run(
    status === 'cancelled' ? 'cancelled' : 'error',
    safe,
    JSON.stringify({ title: safe, hints: [] }),
    row.run_id,
  );
  appendRunEvent(row.run_id, 'info', { message: safe, taskStatus: status });
}

function retryTask(row: any, message: string) {
  const retries = (row.retry_count ?? 0) + 1;
  const delay = Math.min(120_000, 3000 * 2 ** Math.min(retries - 1, 6));
  const next = new Date(Date.now() + delay).toISOString();
  const safe = redactValue(
    `${message}；远程结果尚未确定，将在 ${Math.round(delay / 1000)} 秒后自动重试，请勿重复创建任务。`,
  );
  db.prepare(
    `UPDATE tasks SET poll_count = poll_count + 1, last_poll_at = ?, error = ?, updated_at = ?, next_poll_at = ?, retry_count = ?
    WHERE id = ? AND status NOT IN ('cancelled','failed') AND (status != 'succeeded' OR error IS NOT NULL)`,
  ).run(now(), safe, now(), next, retries, row.id);
  const current = getTask(row.id);
  if (current && !['cancelled', 'failed'].includes(current.status)) {
    db.prepare("UPDATE runs SET status = 'running', error_json = ?, summary = ? WHERE id = ?").run(
      JSON.stringify({ title: safe, hints: [] }),
      '等待恢复任务跟踪',
      row.run_id,
    );
    if (retries === 1 || retries % 5 === 0)
      appendRunEvent(row.run_id, 'info', { message: safe, nextPollAt: next, retryCount: retries });
    for (const listener of listeners) listener(current);
  }
  return current;
}

export async function pollTask(id: string): Promise<TaskRecord | undefined> {
  if (inFlight.has(id)) return getTask(id);
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
  if (!row || ['failed', 'cancelled'].includes(row.status) || (row.status === 'succeeded' && !row.error))
    return row ? rowToTask(row) : undefined;
  const op = getOperation(row.operation_id);
  const conn = getConnection(row.connection_id);
  if (!op?.async || !conn) {
    finishTracking(id, 'unknown', '操作定义或连接已不存在，已停止跟踪');
    return getTask(id);
  }
  inFlight.add(id);
  try {
    const extra = { ...connectionExtra(conn), id: row.remote_id };
    const spec = op.async;
    const res = await send(conn.id, {
      method: spec.poll.method,
      path: fillTemplate(spec.poll.path, extra),
      body: spec.poll.body,
    });
    if (getTask(id)?.status === 'cancelled' || !getTask(id)) return getTask(id);
    if ([408, 425, 429].includes(res.status) || res.status >= 500)
      return retryTask(row, `轮询服务暂不可用（HTTP ${res.status}）`);
    const remoteStatus = String(getPath(res.body, spec.statusPath) ?? '');
    const mapped = Object.prototype.hasOwnProperty.call(spec.statusMap, remoteStatus)
      ? spec.statusMap[remoteStatus]
      : undefined;
    const status: TaskRecord['status'] =
      mapped ?? (res.status >= 400 || extractVendorError(res.body) ? 'unknown' : 'running');
    const progressRaw = spec.progressPath ? getPath(res.body, spec.progressPath) : undefined;
    const progress = progressRaw == null ? null : Number(String(progressRaw).replace('%', ''));
    let err: string | null = null;
    const prevStatus = row.remote_status;
    if (prevStatus !== remoteStatus || res.status >= 400) {
      appendRunEvent(row.run_id, 'task-poll', { httpStatus: res.status, remoteStatus, body: res.body });
    }

    if (status === 'succeeded') {
      let refs = spec.results(res.body);
      if (spec.resolve) {
        const rreq = spec.resolve(res.body, extra);
        if (rreq) {
          const rres = await send(conn.id, rreq);
          if (rres.status >= 400 || extractVendorError(rres.body))
            throw new Error(`结果解析接口失败：HTTP ${rres.status}`);
          appendRunEvent(row.run_id, 'task-poll', { resolve: true, httpStatus: rres.status, body: rres.body });
          refs = spec.resolveResults ? spec.resolveResults(rres.body) : refs;
        }
      }
      const existing = listAssets({ runId: row.run_id });
      {
        for (const ref of refs) {
          const previous = existing.some(
            (asset) => (asset.remoteUrl === ref.url && !!ref.url) || (ref.filename && asset.filename === ref.filename),
          );
          if (previous) continue;
          try {
            const a = await storeArtifact(ref, row.run_id, { network: conn.network });
            appendRunEvent(row.run_id, 'artifact', a);
          } catch (e: any) {
            err = `结果下载失败：${e.message}（远程链接可能已过期）`;
            appendRunEvent(row.run_id, 'error', { title: '结果下载失败', hints: [e.message] });
          }
        }
        if (!refs.length) err = '任务成功但未解析到结果链接，请查看原始轮询响应';
      }
    } else if (status === 'failed') {
      err = String((spec.errorPath && getPath(res.body, spec.errorPath)) || JSON.stringify(res.body).slice(0, 500));
    }

    const update = db
      .prepare(
        `UPDATE tasks SET status = ?, remote_status = ?, progress = ?, poll_count = poll_count + 1, last_poll_at = ?,
        last_response_json = ?, updated_at = ?, error = ?, next_poll_at = ?, retry_count = ? WHERE id = ? AND status NOT IN ('cancelled','failed') AND (status != 'succeeded' OR error IS NOT NULL)`,
      )
      .run(
        status,
        remoteStatus,
        Number.isFinite(progress as number) ? progress : null,
        now(),
        JSON.stringify(redactValue(res.body)),
        now(),
        err ? redactValue(err) : null,
        status === 'succeeded' && err
          ? new Date(Date.now() + Math.min(120_000, 3000 * 2 ** Math.min(row.retry_count ?? 0, 6))).toISOString()
          : null,
        status === 'succeeded' && err ? (row.retry_count ?? 0) + 1 : 0,
        id,
      );
    if (!update.changes) return getTask(id);
    if (status === 'succeeded' || status === 'failed') {
      const assets = listAssets({ runId: row.run_id });
      const summary =
        status === 'succeeded'
          ? err
            ? '远程任务已成功，正在自动重试获取结果'
            : assets.map((a) => `${a.kind} ${(a.size / 1024 / 1024).toFixed(1)}MB`).join('，') || '任务成功'
          : `任务失败：${err ?? remoteStatus}`;
      db.prepare('UPDATE runs SET status = ?, summary = ?, error_json = ? WHERE id = ?').run(
        status === 'succeeded' ? (err ? 'running' : 'ok') : 'error',
        redactValue(summary.slice(0, 280)),
        err ? JSON.stringify(redactValue({ title: err, hints: [] })) : null,
        row.run_id,
      );
    }
    if (status === 'cancelled') finishTracking(id, 'cancelled', '远程任务已取消');
    if (status === 'unknown')
      finishTracking(
        id,
        'unknown',
        `无法继续自动跟踪任务（HTTP ${res.status}，远程状态 ${remoteStatus || '缺失'}），可手动刷新`,
      );
    const t = getTask(id)!;
    for (const l of listeners) l(t);
    return t;
  } catch (e: any) {
    return retryTask(row, `轮询暂时失败：${e.message}`);
  } finally {
    inFlight.delete(id);
  }
}

export async function cancelTask(id: string): Promise<{ ok: boolean; message: string }> {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
  if (!row) return { ok: false, message: '任务不存在' };
  if (['failed', 'cancelled'].includes(row.status) || (row.status === 'succeeded' && !row.error))
    return { ok: true, message: '任务已结束' };
  if (row.status === 'succeeded') {
    finishTracking(id, 'unknown', '远程任务已成功，已停止本地结果下载重试；仍可手动刷新找回结果');
    return { ok: true, message: '已停止结果下载重试；远程任务已成功' };
  }
  const op = getOperation(row.operation_id);
  if (!op?.async?.cancel) {
    finishTracking(id, 'cancelled', '已停止本地跟踪（该厂商未提供取消接口，远程任务可能仍在执行并计费）');
    return { ok: true, message: '已停止本地跟踪；该厂商未提供取消接口' };
  }
  const res = await send(row.connection_id, {
    method: op.async.cancel.method,
    path: fillTemplate(op.async.cancel.path, { id: row.remote_id }),
  });
  appendRunEvent(row.run_id, 'task-poll', { cancel: true, httpStatus: res.status, body: res.body });
  if (res.status < 300 && !extractVendorError(res.body)) {
    finishTracking(id, 'cancelled', '已提交远程取消请求');
    return { ok: true, message: '已提交取消' };
  }
  return { ok: false, message: redactValue(`取消失败：HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}`) };
}

let timer: NodeJS.Timeout | undefined;
export async function pollDueTasks() {
  const rows = db
    .prepare(
      "SELECT id, operation_id, last_poll_at, next_poll_at, created_at FROM tasks WHERE status IN ('pending','running') OR (status = 'succeeded' AND error IS NOT NULL AND next_poll_at IS NOT NULL)",
    )
    .all() as any[];
  for (const r of rows) {
    const op = getOperation(r.operation_id);
    const interval = op?.async?.intervalMs ?? 8000;
    const last = r.last_poll_at ? new Date(r.last_poll_at).getTime() : 0;
    const age = Date.now() - new Date(r.created_at).getTime();
    if (age > 6 * 3600_000) {
      finishTracking(r.id, 'unknown', '超过 6 小时未完成，已停止自动轮询（可手动刷新）');
      continue;
    }
    if (r.next_poll_at ? Date.now() >= new Date(r.next_poll_at).getTime() : Date.now() - last >= interval)
      pollTask(r.id).catch(() => {});
  }
}
export function startTaskPoller() {
  if (timer) return;
  timer = setInterval(() => pollDueTasks().catch(() => {}), 3000);
  timer.unref();
  void pollDueTasks();
}
