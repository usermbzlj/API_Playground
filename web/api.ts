import type { ConnectionInfo, RunRecord, TraceEvent, AssetInfo, TaskRecord, NativeRequest } from '../shared/types.ts';
import type { SerializedOperation } from '../shared/catalog.ts';
import type { FeatureDef, PresetDef, ProviderDef } from '../shared/types.ts';

export interface Catalog {
  providers: ProviderDef[];
  operations: SerializedOperation[];
  features: FeatureDef[];
  presets: PresetDef[];
}

async function req<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    /* text */
  }
  if (!res.ok) {
    const msg = typeof data?.error === 'string' ? data.error : data?.error?.title ?? `HTTP ${res.status}`;
    const err: any = new Error(msg);
    err.data = data;
    throw err;
  }
  return data as T;
}

export const api = {
  catalog: () => req<Catalog>('GET', '/api/catalog'),
  connections: () => req<ConnectionInfo[]>('GET', '/api/connections'),
  createConnection: (b: any) => req<ConnectionInfo>('POST', '/api/connections', b),
  updateConnection: (id: string, b: any) => req<ConnectionInfo>('PATCH', `/api/connections/${id}`, b),
  deleteConnection: (id: string) => req('DELETE', `/api/connections/${id}`),
  testConnection: (id: string) => req<{ ok: boolean; message: string; body?: any }>('POST', `/api/connections/${id}/test`),
  listRemoteModels: (id: string, path?: string) =>
    req<{ raw: any; ms: number }>('GET', `/api/connections/${id}/models${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  balance: (id: string) => req<{ ok: boolean; status: number; body: any }>('GET', `/api/connections/${id}/balance`),

  runs: (q: Record<string, string | number | undefined> = {}) => {
    const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined && v !== '') as any).toString();
    return req<RunRecord[]>('GET', `/api/runs${qs ? `?${qs}` : ''}`);
  },
  run: (id: string) => req<RunRecord>('GET', `/api/runs/${id}`),
  updateRun: (id: string, b: any) => req<RunRecord>('PATCH', `/api/runs/${id}`, b),
  deleteRun: (id: string) => req('DELETE', `/api/runs/${id}`),

  assets: (q: { runId?: string; kind?: string } = {}) => {
    const qs = new URLSearchParams(q as any).toString();
    return req<AssetInfo[]>('GET', `/api/assets${qs ? `?${qs}` : ''}`);
  },
  uploadAsset: async (file: File): Promise<AssetInfo> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/assets', { method: 'POST', body: fd });
    if (!res.ok) throw new Error(`上传失败：HTTP ${res.status}`);
    return res.json();
  },
  asset: (id: string) => req<AssetInfo>('GET', `/api/assets/${id}`),

  tasks: () => req<TaskRecord[]>('GET', '/api/tasks'),
  task: (id: string) => req<TaskRecord & { lastResponse?: any }>('GET', `/api/tasks/${id}`),
  pollTask: (id: string) => req<TaskRecord>('POST', `/api/tasks/${id}/poll`),
  cancelTask: (id: string) => req<{ ok: boolean; message: string }>('POST', `/api/tasks/${id}/cancel`),

  presets: () => req<any[]>('GET', '/api/presets'),
  savePreset: (b: any) => req<{ id: string }>('POST', '/api/presets', b),
  deletePreset: (id: string) => req('DELETE', `/api/presets/${id}`),
};

export interface RunRequestBody {
  connectionId: string;
  operationId?: string | null;
  model?: string | null;
  title?: string;
  input?: unknown;
  /** 已构建好的原生请求（原始请求调试台用）；与 operationId 二选一 */
  request?: NativeRequest;
  parentId?: string | null;
  confirmCost?: boolean;
  /** 原生参数状态：只有 enabled 的参数会进入请求 */
  params?: Record<string, { enabled: boolean; value: unknown }>;
}

/** Execute through the local server and stream trace events back. */
export async function streamRun(body: RunRequestBody, onEvent: (ev: TraceEvent) => void, signal?: AbortSignal): Promise<void> {
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    onEvent({ t: 0, type: 'error', data: { title: `本地服务错误 HTTP ${res.status}`, hints: [await res.text()] } });
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (data) {
        try {
          onEvent(JSON.parse(data));
        } catch {
          /* ignore */
        }
      }
    }
  }
}
