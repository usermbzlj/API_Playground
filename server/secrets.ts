import { readFileSync, writeFileSync, existsSync, chmodSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './db.ts';

// API keys are kept in a separate file (never in the run database) so that
// sharing playground.db or exported experiments cannot leak credentials.
const FILE = join(DATA_DIR, 'secrets.json');

type SecretStore = Record<string, { key: string; extra?: Record<string, string> }>;

function load(): SecretStore {
  if (!existsSync(FILE)) return {};
  try {
    const value = JSON.parse(readFileSync(FILE, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid secret store');
    for (const secret of Object.values(value) as any[]) {
      if (!secret || typeof secret !== 'object' || typeof secret.key !== 'string')
        throw new Error('invalid secret entry');
      if (
        secret.extra !== undefined &&
        (!secret.extra ||
          typeof secret.extra !== 'object' ||
          Array.isArray(secret.extra) ||
          Object.values(secret.extra).some((v) => typeof v !== 'string'))
      )
        throw new Error('invalid extra credentials');
    }
    return value;
  } catch {
    throw new Error('本地 secrets.json 无法读取，请先恢复备份；已停止启动以避免覆盖现有凭据');
  }
}

let cache: SecretStore = load();

function persist(next: SecretStore) {
  const temporary = `${FILE}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    chmodSync(temporary, 0o600);
  } catch {
    /* windows: best effort */
  }
  try {
    renameSync(temporary, FILE);
  } catch (e) {
    try {
      unlinkSync(temporary);
    } catch {
      /* best effort cleanup */
    }
    throw e;
  }
  cache = next;
}

export function getSecret(connectionId: string): { key: string; extra: Record<string, string> } | undefined {
  const s = cache[connectionId];
  return s ? { key: s.key, extra: s.extra ?? {} } : undefined;
}

export function setSecret(connectionId: string, key: string | undefined, extra?: Record<string, string>) {
  const prev = cache[connectionId];
  persist({ ...cache, [connectionId]: { key: key ?? prev?.key ?? '', extra: extra ?? prev?.extra ?? {} } });
}

export function deleteSecret(connectionId: string) {
  if (!cache[connectionId]) return;
  const next = { ...cache };
  delete next[connectionId];
  persist(next);
}

export function allSecretValues(): string[] {
  const out: string[] = [];
  for (const s of Object.values(cache)) {
    if (s.key && s.key.length >= 8) out.push(s.key);
    for (const v of Object.values(s.extra ?? {})) if (v && v.length >= 12) out.push(v);
  }
  return out;
}

export function maskKey(key: string): string {
  if (!key) return '（未设置）';
  if (key.length <= 8) return '****';
  return `${key.slice(0, 3)}…${key.slice(-4)}`;
}

const SENSITIVE_HEADERS =
  /^(authorization|x-api-key|api-key|x-goog-api-key|cookie|set-cookie|proxy-authorization|x-api-resource-id|x-api-app-key|x-api-access-key)$/i;
const SENSITIVE_FIELDS =
  /^(?:secret|api[_-]?key|access[_-]?token|refresh[_-]?token|secret[_-]?key|password|client[_-]?secret)$/i;

export function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] =
      SENSITIVE_HEADERS.test(k) || SENSITIVE_FIELDS.test(k) || /^(token|key|signature)$/i.test(k)
        ? '***已隐藏***'
        : redactText(v);
  }
  return out;
}

/** Remove any literal secret value from arbitrary text/JSON before persisting. */
export function redactText(text: string, extraSecrets: string[] = []): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const s of [...allSecretValues(), ...extraSecrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    if (out.includes(s)) out = out.split(s).join('***');
  }
  return out
    .replace(/([?&](?:key|api[_-]?key|access[_-]?token|token|secret|signature)=)[^&#\s"']*/gi, '$1***')
    .replace(/((?:https?|wss?):\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1***@');
}

export function redactValue<T>(value: T, extraSecrets: string[] = []): T {
  if (typeof value === 'string') return redactText(value, extraSecrets) as T;
  if (Array.isArray(value)) return value.map((v) => redactValue(v, extraSecrets)) as T;
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const name = k.split('.').pop()!;
    if (SENSITIVE_HEADERS.test(name) || SENSITIVE_FIELDS.test(name)) {
      out[k] =
        v && typeof v === 'object' && 'enabled' in v && 'value' in v ? { ...v, value: '***已隐藏***' } : '***已隐藏***';
    } else if (/headers$/i.test(k) && v && typeof v === 'object' && !Array.isArray(v))
      out[k] = redactValue(redactHeaders(v as Record<string, string>), extraSecrets);
    else out[k] = redactValue(v, extraSecrets);
  }
  return out as T;
}

/** Request overrides may contain credentials not saved in secrets.json. Scope them to this run. */
export function requestSecrets(headers: Record<string, string> = {}, path = ''): string[] {
  const values = Object.entries(headers)
    .filter(([k]) => SENSITIVE_HEADERS.test(k) || SENSITIVE_FIELDS.test(k) || /^(token|key|signature)$/i.test(k))
    .flatMap(([, v]) => [v, v.replace(/^(Bearer|Basic)\s+/i, '')]);
  try {
    for (const [k, v] of new URL(path, 'http://localhost').searchParams)
      if (/^(key|api[_-]?key|access[_-]?token|token|secret|signature)$/i.test(k)) values.push(v);
  } catch {
    /* path validation happens before sending */
  }
  return values.filter((v) => v.length >= 4 && !v.includes('***'));
}
