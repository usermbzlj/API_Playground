import { useCallback, useEffect, useRef, useState } from 'react';
import { api, streamRun } from './api.ts';
import { useApp } from './app.tsx';
import type { AssetInfo, TraceEvent } from '../shared/types.ts';
import { Chip, CodeInput, EmptyHint, JsonBlock, Spinner } from './ui.tsx';
import { EventList } from './pages.tsx';

/**
 * 通用原始请求调试台：对任意已配置连接直接发原生请求。
 * 用于尝鲜尚未适配的端点 / 参数，也作为厂商调试入口。
 */
export function RawPage() {
  const { connections, toast } = useApp();
  const [connectionId, setConnectionId] = useState('');
  const [method, setMethod] = useState('POST');
  const [path, setPath] = useState('/chat/completions');
  const [headersText, setHeadersText] = useState('{}');
  const [bodyText, setBodyText] = useState('{\n  "model": "deepseek-v4-pro",\n  "messages": [\n    { "role": "user", "content": "用一句话介绍你自己" }\n  ],\n  "stream": false\n}');
  const [stream, setStream] = useState(false);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [artifacts, setArtifacts] = useState<AssetInfo[]>([]);
  const [running, setRunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!connectionId && connections.length > 0) setConnectionId(connections[0].id);
  }, [connections, connectionId]);

  const run = useCallback(async () => {
    if (!connectionId) {
      toast('请先在「连接」页面添加 API Key', 'err');
      return;
    }
    let headers: Record<string, string> = {};
    let body: unknown;
    try {
      headers = headersText.trim() ? JSON.parse(headersText) : {};
    } catch (e: any) {
      toast(`Headers 不是合法 JSON：${e.message}`, 'err');
      return;
    }
    try {
      body = bodyText.trim() ? JSON.parse(bodyText) : undefined;
    } catch (e: any) {
      toast(`请求体不是合法 JSON：${e.message}`, 'err');
      return;
    }
    setRunning(true);
    setEvents([]);
    setArtifacts([]);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      await streamRun(
        {
          connectionId,
          title: `RAW ${method} ${path}`,
          request: { method: method as any, path, headers, body, stream },
        },
        (ev) => {
          setEvents((prev) => (prev.length > 800 ? prev : [...prev, ev]));
          if (ev.type === 'artifact') setArtifacts((prev) => [...prev, ev.data]);
        },
        ctrl.signal,
      );
    } catch (e: any) {
      if (e.name !== 'AbortError') toast(e.message, 'err');
    } finally {
      setRunning(false);
    }
  }, [connectionId, method, path, headersText, bodyText, stream, toast]);

  const response = [...events].reverse().find((e) => e.type === 'body')?.data;
  const error = [...events].reverse().find((e) => e.type === 'error')?.data;

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-5">
      <header>
        <h1 className="text-lg font-semibold text-zinc-100">原始请求调试台</h1>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">
          对任意连接直接发送原生 HTTP 请求：路径相对于所选连接的 Base URL（完整 URL 只允许同一域名，防止密钥外泄）。
          适合尝鲜尚未适配的端点与参数。Headers 与请求体都会经过脱敏后记录。
        </p>
      </header>

      <div className="card space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <select className="input w-48" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
            {connections.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label}
              </option>
            ))}
          </select>
          <select className="input w-24" value={method} onChange={(e) => setMethod(e.target.value)}>
            {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
          <input className="input mono min-w-64 flex-1" value={path} onChange={(e) => setPath(e.target.value)} placeholder="/chat/completions" />
          <label className="flex items-center gap-1.5 text-xs text-zinc-400">
            <input type="checkbox" checked={stream} onChange={(e) => setStream(e.target.checked)} />
            SSE 流式
          </label>
          {running && (
            <button className="btn-outline" onClick={() => abortRef.current?.abort()}>
              中止
            </button>
          )}
          <button className="btn-primary" onClick={run} disabled={running}>
            {running ? <Spinner /> : '▶ 发送'}
          </button>
        </div>
        <div>
          <span className="label">Headers（JSON，可留空）</span>
          <div className="mt-1">
            <CodeInput value={headersText} onChange={setHeadersText} minHeight={56} />
          </div>
        </div>
        <div>
          <span className="label">请求体（JSON，GET 可留空）</span>
          <div className="mt-1">
            <CodeInput value={bodyText} onChange={setBodyText} minHeight={200} />
          </div>
        </div>
      </div>

      {events.length > 0 && (
        <div className="card space-y-3 p-4">
          <div className="flex items-center gap-2">
            <h2 className="label">结果</h2>
            {[...events].reverse().find((e) => e.type === 'done')?.data?.status && (
              <Chip tone={[...events].reverse().find((e) => e.type === 'done')?.data?.status === 'ok' ? 'green' : 'red'}>
                {String([...events].reverse().find((e) => e.type === 'done')?.data?.status)}
              </Chip>
            )}
          </div>
          {response && <JsonBlock value={response} />}
          {!response && <EmptyHint>流式或空响应，请查看下方事件流</EmptyHint>}
          {error && (
            <div className="rounded-md border border-rose-800 bg-rose-950/40 p-3 text-xs text-rose-200">
              <p className="font-medium">{error.title}</p>
              <ul className="mt-1 list-disc pl-5">
                {(error.hints ?? []).map((h: string) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            </div>
          )}
          {artifacts.length > 0 && (
            <div className="space-y-2">
              <h3 className="label">产物</h3>
              {artifacts.map((a) => (
                <div key={a.id} className="flex items-center gap-3 text-xs text-zinc-300">
                  {a.kind === 'image' && <img src={a.url} className="max-h-40 rounded" alt="" />}
                  {a.kind === 'audio' && <audio controls src={a.url} />}
                  {a.kind === 'video' && <video controls src={a.url} className="max-h-60 rounded" />}
                  <a className="text-violet-400 underline" href={a.url} download={a.filename}>
                    {a.filename}（{(a.size / 1024).toFixed(1)} KB）
                  </a>
                </div>
              ))}
            </div>
          )}
          <div>
            <h3 className="label mb-2">事件流（{events.length}）</h3>
            <EventList events={events} />
          </div>
        </div>
      )}
    </div>
  );
}
