import { db, json, now } from './db.ts';
import { getSecret, setSecret, deleteSecret, maskKey } from './secrets.ts';
import { shortId } from '../shared/util.ts';
import { getProvider } from '../shared/catalog.ts';
import type { ConnectionInfo } from '../shared/types.ts';

function rowToInfo(r: any): ConnectionInfo {
  const s = getSecret(r.id);
  return {
    id: r.id,
    providerId: r.provider_id,
    label: r.label,
    baseUrl: r.base_url,
    extra: json(r.extra_json) ?? {},
    keyPreview: maskKey(s?.key ?? ''),
    createdAt: r.created_at,
    lastTest: json(r.last_test_json),
  };
}

export function listConnections(): ConnectionInfo[] {
  return (db.prepare('SELECT * FROM connections ORDER BY created_at').all() as any[]).map(rowToInfo);
}

export function getConnection(id: string): ConnectionInfo | undefined {
  const r = db.prepare('SELECT * FROM connections WHERE id = ?').get(id);
  return r ? rowToInfo(r) : undefined;
}

function normalizeBaseUrl(url: string): string {
  const u = new URL(url.trim());
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Base URL 必须是 http(s) 地址');
  return u.toString().replace(/\/+$/, '');
}

export function createConnection(input: {
  providerId: string;
  label?: string;
  baseUrl?: string;
  apiKey: string;
  extra?: Record<string, string>;
  secretExtra?: Record<string, string>;
}): ConnectionInfo {
  const provider = getProvider(input.providerId);
  if (!provider) throw new Error(`未知厂商：${input.providerId}`);
  const baseUrl = normalizeBaseUrl(input.baseUrl || provider.baseUrls[0]?.url || '');
  const id = shortId();
  db.prepare('INSERT INTO connections(id, provider_id, label, base_url, extra_json, created_at) VALUES(?, ?, ?, ?, ?, ?)').run(
    id,
    input.providerId,
    input.label?.trim() || provider.name,
    baseUrl,
    JSON.stringify(input.extra ?? {}),
    now(),
  );
  setSecret(id, input.apiKey.trim(), input.secretExtra);
  return getConnection(id)!;
}

export function updateConnection(
  id: string,
  patch: { label?: string; baseUrl?: string; apiKey?: string; extra?: Record<string, string>; secretExtra?: Record<string, string> },
): ConnectionInfo {
  const cur = getConnection(id);
  if (!cur) throw new Error('连接不存在');
  if (patch.label !== undefined) db.prepare('UPDATE connections SET label = ? WHERE id = ?').run(patch.label, id);
  if (patch.baseUrl !== undefined) db.prepare('UPDATE connections SET base_url = ? WHERE id = ?').run(normalizeBaseUrl(patch.baseUrl), id);
  if (patch.extra !== undefined) db.prepare('UPDATE connections SET extra_json = ? WHERE id = ?').run(JSON.stringify(patch.extra), id);
  if (patch.apiKey || patch.secretExtra) setSecret(id, patch.apiKey?.trim() || undefined, patch.secretExtra);
  return getConnection(id)!;
}

export function removeConnection(id: string) {
  db.prepare('DELETE FROM connections WHERE id = ?').run(id);
  deleteSecret(id);
}

export function setLastTest(id: string, result: { ok: boolean; message: string }) {
  db.prepare('UPDATE connections SET last_test_json = ? WHERE id = ?').run(JSON.stringify({ ...result, at: now() }), id);
}

export function authHeaders(conn: ConnectionInfo): Record<string, string> {
  const provider = getProvider(conn.providerId);
  const secret = getSecret(conn.id);
  if (!secret?.key) throw new Error('该连接尚未设置 API Key');
  const auth = provider?.auth ?? { type: 'bearer' as const };
  if (auth.type === 'header' && auth.header) return { [auth.header]: secret.key };
  return { Authorization: `Bearer ${secret.key}` };
}

/** Only the connection's own host may receive its credentials. */
export function buildUrl(baseUrl: string, path: string): string {
  if (/^[a-z]+:\/\//i.test(path)) {
    const target = new URL(path);
    const base = new URL(baseUrl);
    if (target.host !== base.host) throw new Error(`为保护密钥，只允许请求连接所配置的域名（${base.host}）`);
    return target.toString();
  }
  return baseUrl.replace(/\/+$/, '') + (path.startsWith('/') ? path : `/${path}`);
}

export function connectionExtra(conn: ConnectionInfo): Record<string, string> {
  return { ...conn.extra, ...(getSecret(conn.id)?.extra ?? {}) };
}
