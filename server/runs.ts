import { db, json, now } from './db.ts';
import { listAssets, getAssetFile } from './assets.ts';
import { unlinkSync } from 'node:fs';
import type { RunRecord } from '../shared/types.ts';

function rowToRun(r: any, full: boolean): RunRecord {
  const run: RunRecord = {
    id: r.id,
    createdAt: r.created_at,
    providerId: r.provider_id,
    connectionId: r.connection_id,
    operationId: r.operation_id,
    model: r.model,
    title: r.title,
    lifecycle: r.lifecycle,
    status: r.status,
    httpStatus: r.http_status,
    metrics: json(r.metrics_json),
    error: json(r.error_json),
    notes: r.notes ?? undefined,
    starred: !!r.starred,
    parentId: r.parent_id,
    taskId: r.task_id,
    input: json(r.input_json),
  };
  if (full) {
    run.request = json(r.request_json);
    run.response = json(r.response_json);
    run.events = json(r.events_json) ?? [];
    run.artifacts = listAssets({ runId: r.id });
  }
  return run;
}

export function insertRun(run: Partial<RunRecord> & Pick<RunRecord, 'id' | 'providerId' | 'connectionId' | 'title' | 'lifecycle'>) {
  db.prepare(
    `INSERT INTO runs(id, created_at, provider_id, connection_id, operation_id, model, title, lifecycle, status, input_json, request_json, parent_id)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?)`,
  ).run(
    run.id,
    now(),
    run.providerId,
    run.connectionId,
    run.operationId ?? null,
    run.model ?? null,
    run.title,
    run.lifecycle,
    JSON.stringify(run.input ?? null),
    JSON.stringify(run.request ?? null),
    run.parentId ?? null,
  );
}

export function finishRun(
  id: string,
  patch: {
    status: RunRecord['status'];
    httpStatus?: number | null;
    response?: unknown;
    events?: unknown;
    metrics?: unknown;
    error?: unknown;
    taskId?: string | null;
  },
) {
  db.prepare(
    `UPDATE runs SET status = ?, http_status = ?, response_json = ?, events_json = ?, metrics_json = ?, error_json = ?, task_id = COALESCE(?, task_id) WHERE id = ?`,
  ).run(
    patch.status,
    patch.httpStatus ?? null,
    JSON.stringify(patch.response ?? null),
    JSON.stringify(patch.events ?? []),
    JSON.stringify(patch.metrics ?? {}),
    patch.error === undefined ? null : JSON.stringify(patch.error),
    patch.taskId ?? null,
    id,
  );
}

export function getRun(id: string): RunRecord | undefined {
  const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
  return r ? rowToRun(r, true) : undefined;
}

export function listRuns(opts: { limit?: number; operationId?: string; providerId?: string; starred?: boolean; q?: string }): RunRecord[] {
  const where: string[] = [];
  const args: any[] = [];
  if (opts.operationId) {
    where.push('operation_id = ?');
    args.push(opts.operationId);
  }
  if (opts.providerId) {
    where.push('provider_id = ?');
    args.push(opts.providerId);
  }
  if (opts.starred) where.push('starred = 1');
  if (opts.q) {
    where.push('(title LIKE ? OR model LIKE ? OR notes LIKE ? OR input_json LIKE ?)');
    const like = `%${opts.q}%`;
    args.push(like, like, like, like);
  }
  const sql = `SELECT id, created_at, provider_id, connection_id, operation_id, model, title, lifecycle, status, http_status, metrics_json, error_json, notes, starred, parent_id, task_id, input_json
    FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  args.push(opts.limit ?? 100);
  return (db.prepare(sql).all(...args) as any[]).map((r) => rowToRun(r, false));
}

export function updateRunMeta(id: string, patch: { notes?: string; starred?: boolean; title?: string }) {
  if (patch.notes !== undefined) db.prepare('UPDATE runs SET notes = ? WHERE id = ?').run(patch.notes, id);
  if (patch.starred !== undefined) db.prepare('UPDATE runs SET starred = ? WHERE id = ?').run(patch.starred ? 1 : 0, id);
  if (patch.title !== undefined) db.prepare('UPDATE runs SET title = ? WHERE id = ?').run(patch.title, id);
}

export function deleteRun(id: string) {
  // 级联清理：素材文件 + 行、关联异步任务，避免磁盘与数据库残留。
  for (const a of listAssets({ runId: id, limit: 1000 })) {
    const f = getAssetFile(a.id);
    if (f) {
      try {
        unlinkSync(f.path);
      } catch {
        /* ignore */
      }
    }
  }
  db.prepare('DELETE FROM assets WHERE run_id = ?').run(id);
  db.prepare('DELETE FROM tasks WHERE run_id = ?').run(id);
  db.prepare('DELETE FROM runs WHERE id = ?').run(id);
}
