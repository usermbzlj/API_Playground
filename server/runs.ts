import { db, json, now, pagination } from './db.ts';
import { listAssets, removeRunAssets } from './assets.ts';
import { redactValue } from './secrets.ts';
import type { EvidenceRow, LabState, RunRecord } from '../shared/types.ts';

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
    state: json<LabState>(r.state_json) ?? null,
    summary: r.summary ?? null,
    groupId: r.group_id ?? null,
  };
  if (full) {
    run.request = json(r.request_json);
    run.response = json(r.response_json);
    run.events = json(r.events_json) ?? [];
    run.artifacts = listAssets({ runId: r.id });
  }
  return redactValue(run);
}

export function insertRun(
  run: Partial<RunRecord> & Pick<RunRecord, 'id' | 'providerId' | 'connectionId' | 'title' | 'lifecycle'>,
) {
  run = redactValue(run);
  db.prepare(
    `INSERT INTO runs(id, created_at, provider_id, connection_id, operation_id, model, title, lifecycle, status, input_json, request_json, parent_id, state_json, group_id)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?)`,
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
    run.state ? JSON.stringify(run.state) : null,
    run.groupId ?? null,
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
    summary?: string | null;
  },
) {
  patch = redactValue(patch);
  db.prepare(
    `UPDATE runs SET status = ?, http_status = ?, response_json = ?, events_json = ?, metrics_json = ?, error_json = ?,
       task_id = COALESCE(?, task_id), summary = COALESCE(?, summary) WHERE id = ?`,
  ).run(
    patch.status,
    patch.httpStatus ?? null,
    JSON.stringify(patch.response ?? null),
    JSON.stringify(patch.events ?? []),
    JSON.stringify(patch.metrics ?? {}),
    patch.error === undefined ? null : JSON.stringify(patch.error),
    patch.taskId ?? null,
    patch.summary ?? null,
    id,
  );
}

export function getRun(id: string): RunRecord | undefined {
  const r = db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
  return r ? rowToRun(r, true) : undefined;
}

const LIST_COLUMNS =
  'id, created_at, provider_id, connection_id, operation_id, model, title, lifecycle, status, http_status, metrics_json, error_json, notes, starred, parent_id, task_id, input_json, state_json, summary, group_id';

export function listRuns(opts: {
  limit?: number;
  offset?: number;
  operationId?: string;
  providerId?: string;
  starred?: boolean;
  q?: string;
  groupId?: string;
  ids?: string[];
}): RunRecord[] {
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
  if (opts.groupId) {
    where.push('group_id = ?');
    args.push(opts.groupId);
  }
  if (opts.ids?.length) {
    where.push(`id IN (${opts.ids.map(() => '?').join(',')})`);
    args.push(...opts.ids);
  }
  if (opts.starred) where.push('starred = 1');
  if (opts.q) {
    where.push('(title LIKE ? OR model LIKE ? OR notes LIKE ? OR input_json LIKE ? OR summary LIKE ?)');
    const like = `%${opts.q}%`;
    args.push(like, like, like, like, like);
  }
  const page = pagination(opts.limit ?? 100, opts.offset ?? 0);
  const sql = `SELECT ${LIST_COLUMNS} FROM runs ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
  args.push(page.limit, page.offset);
  return (db.prepare(sql).all(...args) as any[]).map((r) => rowToRun(r, false));
}

export function updateRunMeta(id: string, patch: { notes?: string; starred?: boolean; title?: string }) {
  patch = redactValue(patch);
  if (patch.notes !== undefined) db.prepare('UPDATE runs SET notes = ? WHERE id = ?').run(patch.notes, id);
  if (patch.starred !== undefined)
    db.prepare('UPDATE runs SET starred = ? WHERE id = ?').run(patch.starred ? 1 : 0, id);
  if (patch.title !== undefined) db.prepare('UPDATE runs SET title = ? WHERE id = ?').run(patch.title, id);
}

export function setRunStatus(id: string, status: RunRecord['status']) {
  db.prepare('UPDATE runs SET status = ? WHERE id = ?').run(status, id);
}

/** HTTP/WS sessions cannot resume after a process exit; durable async tasks can. */
export function recoverInterruptedRuns() {
  db.prepare(
    `UPDATE runs SET status = 'error', error_json = ?, summary = COALESCE(summary, '服务重启，先前连接已中断')
    WHERE status = 'running' AND NOT EXISTS (SELECT 1 FROM tasks WHERE tasks.run_id = runs.id AND (tasks.status IN ('pending','running') OR (tasks.status = 'succeeded' AND tasks.error IS NOT NULL AND tasks.next_poll_at IS NOT NULL)))`,
  ).run(
    JSON.stringify({
      title: '服务重启，先前连接已中断',
      hints: ['HTTP/SSE/实时会话不能跨服务重启恢复，请检查记录后手动重试；未自动重发以避免重复扣费。'],
    }),
  );
}

export function deleteRun(id: string) {
  // Outputs become library assets; file deletion is a separate, explicit library action.
  removeRunAssets(id);
  db.prepare('DELETE FROM tasks WHERE run_id = ?').run(id);
  db.prepare('DELETE FROM runs WHERE id = ?').run(id);
}

/** Local evidence: success / failure counts per operation and model on this machine. */
export function evidence(): EvidenceRow[] {
  const rows = db
    .prepare(
      `SELECT operation_id, model,
         SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok,
         SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS err,
         MAX(CASE WHEN status = 'ok' THEN created_at END) AS last_ok,
         MAX(CASE WHEN status = 'error' THEN created_at END) AS last_err,
         MAX(created_at) AS last_at
       FROM runs WHERE operation_id IS NOT NULL GROUP BY operation_id, model`,
    )
    .all() as any[];
  const lastErrStmt = db.prepare(
    `SELECT id, error_json FROM runs WHERE operation_id = ? AND model IS ? AND status = 'error' ORDER BY created_at DESC LIMIT 1`,
  );
  const lastRunStmt = db.prepare(
    `SELECT id FROM runs WHERE operation_id = ? AND model IS ? ORDER BY created_at DESC LIMIT 1`,
  );
  return rows.map((r) => {
    const le = r.err ? (lastErrStmt.get(r.operation_id, r.model) as any) : undefined;
    const lr = lastRunStmt.get(r.operation_id, r.model) as any;
    const e = le ? json<any>(le.error_json) : undefined;
    return {
      operationId: r.operation_id,
      model: r.model,
      ok: Number(r.ok) || 0,
      error: Number(r.err) || 0,
      lastOkAt: r.last_ok,
      lastErrorAt: r.last_err,
      lastRunId: lr?.id ?? null,
      lastError: e ? [e.title, e.vendorMessage].filter(Boolean).join('：').slice(0, 200) : null,
    };
  });
}
