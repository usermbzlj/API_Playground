import { db, json, now } from './db.ts';
import { getSecret, setSecret, deleteSecret, maskKey } from './secrets.ts';
import { shortId, joinApiUrl } from '../shared/util.ts';
import { getProvider } from '../shared/catalog.ts';
import { sign } from './signers.ts';
import type { ConnectionInfo, NetworkMode } from '../shared/types.ts';

function rowToInfo(r: any): ConnectionInfo {
  const s = getSecret(r.id);
  const lastTest = json<NonNullable<ConnectionInfo['lastTest']>>(r.last_test_json);
  if (lastTest?.message.includes('没有无副作用')) {
    lastTest.ok = null;
    lastTest.verified = false;
  }
  return {
    id: r.id,
    revision: Number(r.revision) || 0,
    providerId: r.provider_id,
    label: r.label,
    baseUrl: r.base_url,
    extra: json(r.extra_json) ?? {},
    keyPreview: maskKey(s?.key ?? ''),
    network: (r.network as NetworkMode) || 'auto',
    createdAt: r.created_at,
    lastTest,
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
  if (typeof url !== 'string' || !url.trim() || url.length > 4096) throw new Error('请输入有效的 Base URL');
  const u = new URL(url.trim());
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Base URL 必须是 http(s) 地址');
  if (u.username || u.password) throw new Error('Base URL 不允许包含用户名或密码，请通过鉴权配置');
  return u.toString().replace(/\/+$/, '');
}

function normalizeNetwork(n: unknown): NetworkMode {
  if (n === undefined || n === 'auto') return 'auto';
  if (n !== 'direct' && n !== 'proxy') throw new Error('网络路由须为 auto、direct 或 proxy');
  return n;
}

function normalizeLabel(value: unknown, fallback: string): string {
  if (value !== undefined && typeof value !== 'string') throw new Error('连接名称必须是文本');
  const label = (value as string | undefined)?.trim() || fallback;
  if (label.length > 200) throw new Error('连接名称不能超过 200 字');
  return label;
}

function validateCredentials(providerId: string, key: unknown, extra: Record<string, string>) {
  const provider = getProvider(providerId)!;
  if (typeof key !== 'string' || (!key.trim() && provider.auth.type !== 'none')) throw new Error('请填写 API Key');
  if (/[\r\n\0]/.test(key) || key.length > 16_384) throw new Error('API Key 含无效字符或过长，请重新填写');
  if (provider.generic && extra.authHeader && !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(extra.authHeader.trim()))
    throw new Error('自定义鉴权 Header 名称无效');
  if (provider.generic && /[\r\n\0]/.test(extra.authPrefix ?? '')) throw new Error('自定义鉴权前缀不能换行');
  for (const field of provider.auth.extraFields ?? [])
    if (field.required && !extra[field.key]?.trim()) throw new Error(`请填写 ${field.label}`);
}

// Validate everything before writing; roll credentials back if a SQLite commit fails.
function commitConnection(
  id: string,
  write: () => void,
  secret?: { key: string; extra: Record<string, string> } | null,
) {
  const previous = getSecret(id);
  let changedSecret = false;
  db.exec('BEGIN IMMEDIATE');
  try {
    write();
    if (secret === null) {
      deleteSecret(id);
      changedSecret = true;
    } else if (secret) {
      setSecret(id, secret.key, secret.extra);
      changedSecret = true;
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    if (changedSecret) {
      if (previous) setSecret(id, previous.key, previous.extra);
      else deleteSecret(id);
    }
    throw error;
  }
}

/** Split submitted extras into plain (db) and secret (secrets.json) according to the provider's field spec. */
function splitExtras(providerId: string, extra: Record<string, string> = {}) {
  if (!extra || typeof extra !== 'object' || Array.isArray(extra)) throw new Error('附加字段必须是对象');
  const fields = getProvider(providerId)?.auth.extraFields ?? [];
  const plain: Record<string, string> = {};
  const secret: Record<string, string> = {};
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' || v.length > 16_384 || ['__proto__', 'constructor', 'prototype'].includes(k))
      throw new Error(`附加字段 ${k} 无效`);
    if (fields.find((f) => f.key === k)?.secret) secret[k] = v;
    else plain[k] = String(v);
  }
  return { plain, secret };
}

export function createConnection(input: {
  providerId: string;
  label?: string;
  baseUrl?: string;
  apiKey: string;
  extra?: Record<string, string>;
  network?: NetworkMode;
}): ConnectionInfo {
  const provider = getProvider(input.providerId);
  if (!provider) throw new Error(`未知厂商：${input.providerId}`);
  if (provider.generic && !input.baseUrl) throw new Error('自定义厂商需要填写 Base URL');
  const baseUrl = normalizeBaseUrl(input.baseUrl || provider.baseUrls[0]?.url || '');
  const { plain, secret } = splitExtras(input.providerId, input.extra);
  validateCredentials(input.providerId, input.apiKey, { ...plain, ...secret });
  const label = normalizeLabel(input.label, provider.name);
  const network = normalizeNetwork(input.network);
  const id = shortId();
  commitConnection(
    id,
    () =>
      db
        .prepare(
          'INSERT INTO connections(id, provider_id, label, base_url, extra_json, created_at, network) VALUES(?, ?, ?, ?, ?, ?, ?)',
        )
        .run(id, input.providerId, label, baseUrl, JSON.stringify(plain), now(), network),
    { key: input.apiKey.trim(), extra: secret },
  );
  return getConnection(id)!;
}

export function updateConnection(
  id: string,
  patch: { label?: string; baseUrl?: string; apiKey?: string; extra?: Record<string, string>; network?: NetworkMode },
): ConnectionInfo {
  const cur = getConnection(id);
  if (!cur) throw new Error('连接不存在');
  if (patch.apiKey !== undefined && typeof patch.apiKey !== 'string') throw new Error('API Key 必须是文本');
  const label = normalizeLabel(patch.label ?? cur.label, getProvider(cur.providerId)!.name);
  const baseUrl = patch.baseUrl === undefined ? cur.baseUrl : normalizeBaseUrl(patch.baseUrl);
  const network = patch.network === undefined ? cur.network : normalizeNetwork(patch.network);
  const previous = getSecret(id);
  const key = patch.apiKey?.trim() || previous?.key || '';
  let plain = cur.extra;
  let secretExtra = previous?.extra ?? {};
  if (patch.extra !== undefined) {
    const split = splitExtras(cur.providerId, patch.extra);
    plain = split.plain;
    // Empty secret fields mean "unchanged" so editing a connection does not wipe stored secrets.
    secretExtra = { ...secretExtra, ...Object.fromEntries(Object.entries(split.secret).filter(([, v]) => v !== '')) };
  }
  validateCredentials(cur.providerId, key, { ...plain, ...secretExtra });
  const changed =
    baseUrl !== cur.baseUrl ||
    network !== cur.network ||
    key !== previous?.key ||
    JSON.stringify(plain) !== JSON.stringify(cur.extra) ||
    JSON.stringify(secretExtra) !== JSON.stringify(previous?.extra ?? {});
  commitConnection(
    id,
    () =>
      db
        .prepare(
          'UPDATE connections SET label = ?, base_url = ?, network = ?, extra_json = ?, revision = revision + ?, last_test_json = CASE WHEN ? THEN NULL ELSE last_test_json END WHERE id = ?',
        )
        .run(label, baseUrl, network, JSON.stringify(plain), changed ? 1 : 0, changed ? 1 : 0, id),
    { key, extra: secretExtra },
  );
  return getConnection(id)!;
}

export function removeConnection(id: string) {
  if (
    db
      .prepare(
        "SELECT id FROM tasks WHERE connection_id = ? AND (status IN ('pending','running') OR (status = 'succeeded' AND error IS NOT NULL)) LIMIT 1",
      )
      .get(id)
  )
    throw new Error('该连接仍有未完成任务，请先取消任务或停止本地跟踪');
  if (db.prepare("SELECT id FROM runs WHERE connection_id = ? AND status = 'running' LIMIT 1").get(id))
    throw new Error('该连接仍有执行中的实验，请先停止执行');
  commitConnection(id, () => db.prepare('DELETE FROM connections WHERE id = ?').run(id), null);
}

export function setLastTest(id: string, result: { ok: boolean | null; message: string; verified?: boolean }) {
  db.prepare('UPDATE connections SET last_test_json = ? WHERE id = ?').run(
    JSON.stringify({ ...result, at: now() }),
    id,
  );
}

export function connectionExtra(conn: ConnectionInfo): Record<string, string> {
  return { ...conn.extra, ...(getSecret(conn.id)?.extra ?? {}) };
}

/** HTTP header names are case-insensitive; an override must replace, never append auth. */
export function mergeRequestHeaders(...sources: (Record<string, string> | undefined)[]): Record<string, string> {
  const headers = new Headers();
  for (const source of sources) for (const [name, value] of Object.entries(source ?? {})) headers.set(name, value);
  return Object.fromEntries(headers.entries());
}

export function hasKey(conn: ConnectionInfo): boolean {
  return !!getSecret(conn.id)?.key;
}

/**
 * Credentials for one upstream request. Returns headers to add and the final URL
 * (query-string auth and signers may rewrite it).
 */
export function applyAuth(
  conn: ConnectionInfo,
  url: string,
  req: { method: string; body?: string },
): { headers: Record<string, string>; url: string } {
  const provider = getProvider(conn.providerId);
  const secret = getSecret(conn.id);
  const auth = provider?.auth ?? { type: 'bearer' as const };
  if (auth.type === 'none') return { headers: { ...(auth.staticHeaders ?? {}) }, url };
  if (!secret?.key) throw new Error('该连接尚未设置 API Key');
  const headers: Record<string, string> = { ...(auth.staticHeaders ?? {}) };
  const extra = connectionExtra(conn);
  // Generic providers let each connection choose the header style.
  if (provider?.generic && extra.authHeader?.trim()) {
    const prefix =
      extra.authPrefix === 'none'
        ? ''
        : (extra.authPrefix ?? (extra.authHeader.toLowerCase() === 'authorization' ? 'Bearer ' : ''));
    headers[extra.authHeader.trim()] = `${prefix}${secret.key}`;
    return { headers, url };
  }
  switch (auth.type) {
    case 'header': {
      const prefix =
        provider?.generic && extra.authPrefix !== undefined
          ? extra.authPrefix === 'none'
            ? ''
            : extra.authPrefix
          : (auth.prefix ?? '');
      headers[auth.header || 'Authorization'] = `${prefix}${secret.key}`;
      return { headers, url };
    }
    case 'query': {
      const u = new URL(url);
      u.searchParams.set(auth.query || 'key', secret.key);
      return { headers, url: u.toString() };
    }
    case 'signer': {
      const signed = sign(auth.signer!, { key: secret.key, extra, url, method: req.method, body: req.body });
      return { headers: { ...headers, ...signed.headers }, url: signed.url ?? url };
    }
    default:
      headers.Authorization = `Bearer ${secret.key}`;
      return { headers, url };
  }
}

/** Only the connection's own host (or hosts the provider explicitly lists) may receive its credentials. */
export function buildUrl(baseUrl: string, path: string, providerId?: string): string {
  if (/^[a-z]+:\/\//i.test(path)) {
    const target = new URL(path);
    const base = new URL(baseUrl);
    if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password)
      throw new Error('请求地址必须为不含账号密码的 HTTP(S) URL');
    if (base.protocol === 'https:' && target.protocol !== 'https:')
      throw new Error('不能将已配置的 HTTPS 连接降级到 HTTP');
    const allowed = new Set([base.host]);
    for (const b of getProvider(providerId)?.baseUrls ?? []) {
      try {
        allowed.add(new URL(b.url).host);
      } catch {
        /* ignore */
      }
    }
    if (!allowed.has(target.host)) throw new Error(`为保护密钥，只允许请求连接所配置的域名（${base.host}）`);
    return target.toString();
  }
  return joinApiUrl(baseUrl, path);
}
