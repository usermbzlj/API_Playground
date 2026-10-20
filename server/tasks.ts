import { db, json, now } from './db.ts';
import { getConnection, authHeaders, connectionExtra, buildUrl } from './connections.ts';
import { storeArtifact, listAssets } from './assets.ts';
import { redactValue } from './secrets.ts';
import { getOperation } from '../shared/catalog.ts';
import { getPath, fillTemplate, shortId, truncateDeep } from '../shared/util.ts';
import type { TaskRecord, NativeRequest } from '../shared/types.ts';

type Listener = (t: TaskRecord) => void;
const listeners = new Set<Listener>();
export function onTaskUpdate(fn: Listener) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function rowToTask(r: any): TaskRecord {
  return {
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
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    error: r.error,
    title: r.title,
    artifacts: listAssets({ runId: r.run_id }),
  };
}

export function createTask(t: { runId: string; connectionId: string; operationId: string; remoteId: string; title?: string }): string {
  const id = shortId();
  const ts = now();
  db.prepare(
    `INSERT INTO tasks(id, run_id, connection_id, operation_id, remote_id, status, created_at, updated_at, title)
     VALUES(?, ?, ?, ?, ?, 'pending', ?, ?, ?)`,
  ).run(id, t.runId, t.connectionId, t.operationId, t.remoteId, ts, ts, t.title ?? null);
  setTimeout(() => pollTask(id).catch(() => {}), 2000);
  return id;
}

export function getTask(id: string): TaskRecord | undefined {
  const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id);
  return r ? rowToTask(r) : undefined;
}

export function getTaskDetail(id: string) {
  const r = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
  return r ? { ...rowToTask(r), lastResponse: json(r.last_response_json) } : undefined;
}

export function listTasks(limit = 100): TaskRecord[] {
  return (db.prepare('SELECT * FROM tasks ORDER BY created_at DESC LIMIT ?').all(limit) as any[]).map(rowToTask);
}

async function send(connId: string, req: NativeRequest) {
  const conn = getConnection(connId);
  if (!conn) throw new Error('连接已删除');
  const headers: Record<string, string> = { ...authHeaders(conn), ...(req.headers ?? {}) };
  let body: string | undefined;
  if (req.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(req.body);
  }
  const res = await fetch(buildUrl(conn.baseUrl, req.path), { method: req.method, headers, body, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
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

export async function pollTask(id: string): Promise<TaskRecord | undefined> {
  if (inFlight.has(id)) return getTask(id);
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
  if (!row || ['succeeded', 'failed', 'cancelled'].includes(row.status)) return row ? rowToTask(row) : undefined;
  const op = getOperation(row.operation_id);
  const conn = getConnection(row.connection_id);
  if (!op?.async || !conn) {
    db.prepare("UPDATE tasks SET status = 'unknown', error = ?, updated_at = ? WHERE id = ?").run('操作定义或连接已不存在', now(), id);
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
    const remoteStatus = String(getPath(res.body, spec.statusPath) ?? '');
    let status = spec.statusMap[remoteStatus] ?? (res.status >= 400 ? 'unknown' : 'running');
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
          appendRunEvent(row.run_id, 'task-poll', { resolve: true, httpStatus: rres.status, body: rres.body });
          refs = spec.resolveResults ? spec.resolveResults(rres.body) : refs;
        }
      }
      const existing = listAssets({ runId: row.run_id });
      if (!existing.length) {
        for (const ref of refs) {
          try {
            const a = await storeArtifact(ref, row.run_id);
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

    db.prepare(
      `UPDATE tasks SET status = ?, remote_status = ?, progress = ?, poll_count = poll_count + 1, last_poll_at = ?,
        last_response_json = ?, updated_at = ?, error = COALESCE(?, error) WHERE id = ?`,
    ).run(status, remoteStatus, Number.isFinite(progress as number) ? progress : null, now(), JSON.stringify(redactValue(truncateDeep(res.body, 20000))), now(), err, id);
    if (status === 'succeeded' || status === 'failed') {
      db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status === 'succeeded' && !err ? 'ok' : 'error', row.run_id);
    }
    const t = getTask(id)!;
    for (const l of listeners) l(t);
    return t;
  } catch (e: any) {
    db.prepare('UPDATE tasks SET poll_count = poll_count + 1, last_poll_at = ?, error = ?, updated_at = ? WHERE id = ?').run(
      now(),
      `轮询失败：${e.message}`,
      now(),
      id,
    );
    return getTask(id);
  } finally {
    inFlight.delete(id);
  }
}

export async function cancelTask(id: string): Promise<{ ok: boolean; message: string }> {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as any;
  if (!row) return { ok: false, message: '任务不存在' };
  const op = getOperation(row.operation_id);
  if (!op?.async?.cancel) {
    db.prepare("UPDATE tasks SET status = 'cancelled', error = ?, updated_at = ? WHERE id = ?").run('已停止本地跟踪（该厂商未提供取消接口，远程任务可能仍在执行并计费）', now(), id);
    return { ok: true, message: '已停止本地跟踪；该厂商未提供取消接口' };
  }
  const res = await send(row.connection_id, {
    method: op.async.cancel.method,
    path: fillTemplate(op.async.cancel.path, { id: row.remote_id }),
  });
  appendRunEvent(row.run_id, 'task-poll', { cancel: true, httpStatus: res.status, body: res.body });
  if (res.status < 300) {
    db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now(), id);
    return { ok: true, message: '已提交取消' };
  }
  return { ok: false, message: `取消失败：HTTP ${res.status} ${JSON.stringify(res.body).slice(0, 300)}` };
}

let timer: NodeJS.Timeout | undefined;
export function startTaskPoller() {
  if (timer) return;
  const tick = async () => {
    const rows = db.prepare("SELECT id, operation_id, last_poll_at, created_at FROM tasks WHERE status IN ('pending','running')").all() as any[];
    for (const r of rows) {
      const op = getOperation(r.operation_id);
      const interval = op?.async?.intervalMs ?? 8000;
      const last = r.last_poll_at ? new Date(r.last_poll_at).getTime() : 0;
      const age = Date.now() - new Date(r.created_at).getTime();
      if (age > 6 * 3600_000) {
        db.prepare("UPDATE tasks SET status = 'unknown', error = '超过 6 小时未完成，已停止自动轮询（可手动刷新）', updated_at = ? WHERE id = ?").run(now(), r.id);
        continue;
      }
      if (Date.now() - last >= interval) pollTask(r.id).catch(() => {});
    }
  };
  timer = setInterval(tick, 3000);
  tick();
}
