import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { DATA_DIR } from './db.ts';

// API keys are kept in a separate file (never in the run database) so that
// sharing playground.db or exported experiments cannot leak credentials.
const FILE = join(DATA_DIR, 'secrets.json');

type SecretStore = Record<string, { key: string; extra?: Record<string, string> }>;

function load(): SecretStore {
  if (!existsSync(FILE)) return {};
  try {
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}

let cache: SecretStore = load();

function persist() {
  writeFileSync(FILE, JSON.stringify(cache, null, 2), 'utf8');
  try {
    chmodSync(FILE, 0o600);
  } catch {
    /* windows: best effort */
  }
}

export function getSecret(connectionId: string): { key: string; extra: Record<string, string> } | undefined {
  const s = cache[connectionId];
  return s ? { key: s.key, extra: s.extra ?? {} } : undefined;
}

export function setSecret(connectionId: string, key: string | undefined, extra?: Record<string, string>) {
  const prev = cache[connectionId];
  cache[connectionId] = { key: key ?? prev?.key ?? '', extra: extra ?? prev?.extra ?? {} };
  persist();
}

export function deleteSecret(connectionId: string) {
  delete cache[connectionId];
  persist();
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

const SENSITIVE_HEADERS = /^(authorization|x-api-key|api-key|x-goog-api-key|cookie|set-cookie|proxy-authorization|x-api-resource-id|x-api-app-key|x-api-access-key)$/i;

export function redactHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = SENSITIVE_HEADERS.test(k) ? '***已隐藏***' : v;
  }
  return out;
}

/** Remove any literal secret value from arbitrary text/JSON before persisting. */
export function redactText(text: string): string {
  if (typeof text !== 'string' || text.length === 0) return text;
  let out = text;
  for (const s of allSecretValues()) {
    if (out.includes(s)) out = out.split(s).join('***');
  }
  return out;
}

export function redactValue<T>(value: T): T {
  if (value == null) return value;
  const s = JSON.stringify(value);
  const r = redactText(s);
  return r === s ? value : JSON.parse(r);
}
