import type {
  AssetInfo,
  AssetLibraryResponse,
  ConnectionInfo,
  ConnectionImportResult,
  EvidenceRow,
  LabState,
  NativeRequest,
  RunRecord,
  TaskRecord,
  TraceEvent,
} from '../shared/types.ts';
import type { RemoteModel } from '../shared/models.ts';
import { SSEDecoder } from '../shared/sse.ts';

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
    const msg =
      typeof data?.error === 'string'
        ? data.error
        : data?.error?.title
          ? `${data.error.title}${data.error.vendorMessage ? `：${data.error.vendorMessage}` : ''}`
          : `HTTP ${res.status}`;
    const err: any = new Error(msg);
    err.data = data;
    throw err;
  }
  return data as T;
}

function qs(q: Record<string, string | number | undefined | null>) {
  const s = new URLSearchParams(
    Object.entries(q).filter(([, v]) => v !== undefined && v !== null && v !== '') as any,
  ).toString();
  return s ? `?${s}` : '';
}

export interface EnvKeyInfo {
  envName: string;
  providerId: string;
  providerName: string;
  preview: string;
  source: 'env' | '.env.local';
  imported: boolean;
}

export interface NetworkInfo {
  proxyUrl: string | null;
  effectiveProxy: string | null;
  source: 'settings' | 'env' | 'none';
  hasCredentials: boolean;
  effectiveHasCredentials: boolean;
}

export interface UserPreset {
  id: string;
  operationId: string;
  title: string;
  description?: string;
  model?: string | null;
  input: any;
  params?: any;
  createdAt: string;
  user: true;
}

export const api = {
  health: () => req<{ ok: boolean; proxy: string | null }>('GET', '/api/health'),
  connections: () => req<ConnectionInfo[]>('GET', '/api/connections'),
  importConnections: (text: string, apply = false) =>
    req<ConnectionImportResult>('POST', '/api/connections/import', { text, apply }),
  createConnection: (b: any) => req<ConnectionInfo>('POST', '/api/connections', b),
  updateConnection: (id: string, b: any) => req<ConnectionInfo>('PATCH', `/api/connections/${id}`, b),
  deleteConnection: (id: string) => req('DELETE', `/api/connections/${id}`),
  testConnection: (id: string) =>
    req<{ ok: boolean | null; verified?: boolean; message: string }>('POST', `/api/connections/${id}/test`),
  remoteModels: (id: string, opts: { refresh?: boolean; path?: string } = {}) =>
    req<{ raw: any; models: RemoteModel[]; ms: number; at: string }>(
      'GET',
      `/api/connections/${id}/models${qs({ refresh: opts.refresh ? 1 : undefined, path: opts.path })}`,
    ),
  balance: (id: string) => req<{ ok: boolean; status: number; body: any }>('GET', `/api/connections/${id}/balance`),

  envKeys: () => req<EnvKeyInfo[]>('GET', '/api/env-keys'),
  importEnvKey: (b: { envName: string; providerId: string; baseUrlId?: string }) =>
    req<ConnectionInfo>('POST', '/api/env-keys/import', b),

  runs: (
    q: {
      limit?: number;
      offset?: number;
      q?: string;
      operationId?: string;
      providerId?: string;
      groupId?: string;
      ids?: string[];
      starred?: boolean;
    } = {},
  ) => req<RunRecord[]>('GET', `/api/runs${qs({ ...q, ids: q.ids?.join(','), starred: q.starred ? 1 : undefined })}`),
  run: (id: string) => req<RunRecord>('GET', `/api/runs/${id}`),
  updateRun: (id: string, b: any) => req<RunRecord>('PATCH', `/api/runs/${id}`, b),
  deleteRun: (id: string) => req('DELETE', `/api/runs/${id}`),
  evidence: () => req<EvidenceRow[]>('GET', '/api/evidence'),

  assets: (q: { runId?: string; kind?: string; q?: string; offset?: number; limit?: number } = {}) =>
    req<AssetInfo[]>('GET', `/api/assets${qs(q)}`),
  assetLibrary: (q: { kind?: string; q?: string; unused?: boolean; offset?: number; limit?: number } = {}) =>
    req<AssetLibraryResponse>('GET', `/api/assets/library${qs({ ...q, unused: q.unused ? 1 : undefined })}`),
  deleteAsset: (id: string) => req<{ ok: boolean }>('DELETE', `/api/assets/${encodeURIComponent(id)}`),
  cleanupAssets: (ids: string[]) => req<{ deleted: number; bytes: number }>('POST', '/api/assets/cleanup', { ids }),
  uploadAsset: async (file: File): Promise<AssetInfo> => {
    const fd = new FormData();
    fd.append('file', file);
    const res = await fetch('/api/assets', { method: 'POST', body: fd });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(
        `上传失败：${(() => {
          try {
            return JSON.parse(t).error;
          } catch {
            return `HTTP ${res.status}`;
          }
        })()}`,
      );
    }
    return res.json();
  },
  assetFromUrl: (url: string, kind: string) => req<AssetInfo>('POST', '/api/assets/url', { url, kind }),
  asset: (id: string) => req<AssetInfo>('GET', `/api/assets/${id}`),

  tasks: (q: { limit?: number; offset?: number } = {}) => req<TaskRecord[]>('GET', `/api/tasks${qs(q)}`),
  task: (id: string) => req<TaskRecord & { lastResponse?: any }>('GET', `/api/tasks/${id}`),
  pollTask: (id: string) => req<TaskRecord>('POST', `/api/tasks/${id}/poll`),
  cancelTask: (id: string) => req<{ ok: boolean; message: string }>('POST', `/api/tasks/${id}/cancel`),

  presets: () => req<UserPreset[]>('GET', '/api/presets'),
  savePreset: (b: {
    operationId: string;
    title: string;
    description?: string;
    model?: string;
    input: any;
    params?: any;
  }) => req<{ id: string }>('POST', '/api/presets', b),
  deletePreset: (id: string) => req('DELETE', `/api/presets/${id}`),

  settings: () => req<{ confirmTier: 'medium' | 'high' | 'all' }>('GET', '/api/settings'),
  saveSettings: (b: any) => req('PUT', '/api/settings', b),
  network: () => req<NetworkInfo>('GET', '/api/settings/network'),
  saveNetwork: (proxyUrl?: string | null) => req<NetworkInfo>('PUT', '/api/settings/network', { proxyUrl }),
  savePreferences: (confirmTier: string, network?: { proxyUrl: string | null }) =>
    req<{ settings: { confirmTier: 'medium' | 'high' | 'all' }; network: NetworkInfo }>(
      'PUT',
      '/api/settings/preferences',
      { confirmTier, network },
    ),
};

export interface RunRequestBody {
  connectionId: string;
  operationId?: string | null;
  model?: string | null;
  title?: string;
  input?: unknown;
  /** prebuilt native request (raw console); mutually exclusive with operationId */
  request?: NativeRequest;
  parentId?: string | null;
  groupId?: string | null;
  confirmCost?: boolean;
  params?: LabState['params'];
}

/** Execute through the local server and stream trace events back. */
export async function streamRun(
  body: RunRequestBody,
  onEvent: (ev: TraceEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch('/api/run', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok || !res.body) {
    const text = await res.text();
    let msg: string = text;
    try {
      const error = JSON.parse(text).error;
      msg = typeof error === 'string' ? error : (error?.title ?? text);
    } catch {
      /* text */
    }
    onEvent({ t: 0, type: 'error', data: { title: `本地服务拒绝了请求（HTTP ${res.status}）`, hints: [msg] } });
    onEvent({ t: 0, type: 'done', data: { status: 'error' } });
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let completed = false;
  const parser = new SSEDecoder(({ data }) => {
    let event: TraceEvent;
    try {
      event = JSON.parse(data);
    } catch {
      throw new Error('本地服务返回了无法解析的事件，请检查服务日志');
    }
    if (event.type === 'done') completed = true;
    onEvent(event);
  });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(dec.decode(value, { stream: true }));
    }
    parser.feed(dec.decode(), true);
    if (!completed) throw new Error('事件流在结束事件到达前中断，已保存的部分结果可在实验记录中查看');
  } finally {
    reader.releaseLock();
  }
}
