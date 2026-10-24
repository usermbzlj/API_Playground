// Detect API keys in environment variables or a local .env.local file and offer them as
// one-click connections. Values never leave the server; the UI only sees a masked preview.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDERS, getProvider } from '../shared/catalog.ts';
import { createConnection, listConnections } from './connections.ts';
import { getSecret, maskKey } from './secrets.ts';
import type { ConnectionInfo } from '../shared/types.ts';

const ENV_FILE = join(process.cwd(), '.env.local');

function readEnvFile(): Record<string, string> {
  if (!existsSync(ENV_FILE)) return {};
  const out: Record<string, string> = {};
  for (const line of readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (v) out[m[1]] = v;
  }
  return out;
}

function lookup(name: string): { value: string; source: 'env' | '.env.local' } | undefined {
  const file = readEnvFile();
  if (file[name]) return { value: file[name], source: '.env.local' };
  const v = process.env[name]?.trim();
  return v ? { value: v, source: 'env' } : undefined;
}

export interface EnvKeyInfo {
  envName: string;
  providerId: string;
  providerName: string;
  preview: string;
  source: 'env' | '.env.local';
  imported: boolean;
}

function alreadyImported(providerId: string, value: string): boolean {
  return listConnections().some((c) => c.providerId === providerId && getSecret(c.id)?.key === value);
}

export function detectEnvKeys(): EnvKeyInfo[] {
  const out: EnvKeyInfo[] = [];
  for (const p of PROVIDERS) {
    for (const name of p.keyEnv ?? []) {
      const hit = lookup(name);
      if (!hit) continue;
      out.push({
        envName: name,
        providerId: p.id,
        providerName: p.name,
        preview: maskKey(hit.value),
        source: hit.source,
        imported: alreadyImported(p.id, hit.value),
      });
    }
  }
  return out;
}

export function importEnvKey(envName: string, providerId: string, baseUrlId?: string): ConnectionInfo {
  const p = getProvider(providerId);
  if (!p || !(p.keyEnv ?? []).includes(envName)) throw new Error('该环境变量不属于此厂商');
  const hit = lookup(envName);
  if (!hit) throw new Error(`没有找到环境变量 ${envName}`);
  if (alreadyImported(providerId, hit.value)) throw new Error('这个 Key 已经导入过了');
  const base = p.baseUrls.find((b) => b.id === baseUrlId) ?? p.baseUrls[0];
  return createConnection({ providerId, label: `${p.name}（${envName}）`, baseUrl: base?.url, apiKey: hit.value });
}
