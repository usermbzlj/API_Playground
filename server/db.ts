import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const DATA_DIR = process.env.PLAYGROUND_DATA_DIR || join(process.cwd(), 'data');
export const ASSET_DIR = join(DATA_DIR, 'assets');
mkdirSync(ASSET_DIR, { recursive: true });

export const db = new DatabaseSync(join(DATA_DIR, 'playground.db'));
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');

db.exec(`
CREATE TABLE IF NOT EXISTS connections (
  id TEXT PRIMARY KEY,
  provider_id TEXT NOT NULL,
  label TEXT NOT NULL,
  base_url TEXT NOT NULL,
  extra_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  last_test_json TEXT
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  provider_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  operation_id TEXT,
  model TEXT,
  title TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  status TEXT NOT NULL,
  http_status INTEGER,
  input_json TEXT,
  request_json TEXT,
  response_json TEXT,
  events_json TEXT,
  metrics_json TEXT,
  error_json TEXT,
  notes TEXT,
  starred INTEGER NOT NULL DEFAULT 0,
  parent_id TEXT,
  task_id TEXT
);
CREATE INDEX IF NOT EXISTS runs_created ON runs(created_at DESC);
CREATE TABLE IF NOT EXISTS assets (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  mime TEXT NOT NULL,
  filename TEXT NOT NULL,
  path TEXT NOT NULL,
  size INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  run_id TEXT,
  remote_url TEXT,
  source TEXT NOT NULL DEFAULT 'upload'
);
CREATE INDEX IF NOT EXISTS assets_run ON assets(run_id);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  connection_id TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  remote_id TEXT NOT NULL,
  status TEXT NOT NULL,
  remote_status TEXT,
  progress REAL,
  poll_count INTEGER NOT NULL DEFAULT 0,
  last_poll_at TEXT,
  last_response_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  error TEXT,
  title TEXT
);
CREATE TABLE IF NOT EXISTS presets (
  id TEXT PRIMARY KEY,
  operation_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  model TEXT,
  input_json TEXT NOT NULL,
  params_json TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

export function json<T = any>(s: unknown): T | undefined {
  if (typeof s !== 'string' || !s) return undefined;
  try {
    return JSON.parse(s) as T;
  } catch {
    return undefined;
  }
}

export function now(): string {
  return new Date().toISOString();
}

export function getSetting<T>(key: string, fallback: T): T {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as any;
  return row ? (json<T>(row.value) ?? fallback) : fallback;
}

export function setSetting(key: string, value: unknown): void {
  db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}
