import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type Dispatch,
  type SetStateAction,
} from 'react';
import { useApp } from '../app.tsx';
import { providerHref, useRoute } from '../router.ts';
import { modelsFor, presetsFor } from '../../shared/catalog.ts';
import { api } from '../api.ts';
import { RealtimeRecording } from './recording.tsx';
import { initialParamState, type ParamState } from '../../shared/util.ts';
import type { OperationDef, ProviderDef, TraceEvent } from '../../shared/types.ts';
import { Chip, EvidenceChip, JsonBlock, Modal, VerificationChip } from '../ui.tsx';
import { validateOperationInput } from '../../shared/validate.ts';
import { ParamsPanel } from './params.tsx';
import { ModelPicker, useRemoteModels } from './LabPage.tsx';
import { usePersistentDraft } from '../workspace-state.ts';
import { setExternalRunSession } from './useRunner.ts';

interface RealtimeStore {
  values: Map<string, unknown>;
  refs: Map<string, { current: any }>;
  listeners: Set<() => void>;
  mounted: number;
  accessedAt: number;
}
const realtimeStores = new Map<string, RealtimeStore>();
function getRealtimeStore(key: string): RealtimeStore {
  let store = realtimeStores.get(key);
  if (!store) {
    store = { values: new Map(), refs: new Map(), listeners: new Set(), mounted: 0, accessedAt: Date.now() };
    realtimeStores.set(key, store);
  }
  store.accessedAt = Date.now();
  return store;
}
function pruneRealtimeStores() {
  const inactive = [...realtimeStores.entries()]
    .filter(([, store]) => store.mounted === 0 && !store.refs.get('socket')?.current)
    .sort((a, b) => b[1].accessedAt - a[1].accessedAt);
  for (const [key] of inactive.slice(4)) realtimeStores.delete(key);
}
function realtimeRef<T>(store: RealtimeStore, name: string, initial: T): { current: T } {
  if (!store.refs.has(name)) store.refs.set(name, { current: initial });
  return store.refs.get(name)!;
}
function useRealtimeValue<T>(store: RealtimeStore, name: string, initial: T): [T, Dispatch<SetStateAction<T>>] {
  if (!store.values.has(name)) store.values.set(name, initial);
  const get = useCallback(() => store.values.get(name) as T, [store, name]);
  const value = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        store.listeners.add(listener);
        return () => store.listeners.delete(listener);
      },
      [store],
    ),
    get,
    get,
  );
  const set: Dispatch<SetStateAction<T>> = useCallback(
    (next) => {
      const previous = store.values.get(name) as T;
      const resolved = typeof next === 'function' ? (next as (value: T) => T)(previous) : next;
      if (Object.is(previous, resolved)) return;
      store.values.set(name, resolved);
      for (const listener of store.listeners) listener();
    },
    [store, name],
  );
  return [value, set];
}

const WORKLET = `
class PgCapture extends AudioWorkletProcessor {
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (ch && ch.length) this.port.postMessage(ch.slice(0));
    return true;
  }
}
registerProcessor('pg-capture', PgCapture);
`;

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

function floatToPcm16(chunks: Float32Array[]): Uint8Array {
  const total = chunks.reduce((s, c) => s + c.length, 0);
  const out = new DataView(new ArrayBuffer(total * 2));
  let o = 0;
  for (const c of chunks) {
    for (let i = 0; i < c.length; i++) {
      const s = Math.max(-1, Math.min(1, c[i]));
      out.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      o += 2;
    }
  }
  return new Uint8Array(out.buffer);
}

interface Turn {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  /** ms from end of user speech to first audio of the reply */
  latencyMs?: number;
  interrupted?: boolean;
}

interface LogEntry {
  t: number;
  dir: 'in' | 'out' | 'sys';
  type: string;
  data?: any;
}

const AUDIO_DELTA = new Set(['response.audio.delta', 'response.output_audio.delta']);
const TRANSCRIPT_DELTA = new Set([
  'response.audio_transcript.delta',
  'response.output_audio_transcript.delta',
  'response.text.delta',
  'response.output_text.delta',
]);

export function RealtimeLab({
  op,
  provider,
  runId: restoredRunId,
  presetId,
}: {
  op: OperationDef;
  provider: ProviderDef;
  runId?: string | null;
  presetId?: string | null;
}) {
  const { connections, evidence, toast, refreshEvidence } = useApp();
  const route = useRoute();
  const spec = op.realtime!;
  const own = connections.filter((c) => c.providerId === op.providerId);
  const sessionKey = `realtime:${op.id}:${restoredRunId ?? ''}:${presetId ?? ''}:${route.query.get('connection') ?? ''}:${route.query.get('model') ?? ''}`;
  const store = getRealtimeStore(sessionKey);
  const sessionHref = realtimeRef(store, 'href', window.location.hash);
  const [draft, setDraft, draftControl] = usePersistentDraft(
    sessionKey,
    () => ({
      connectionId: route.query.get('connection') ?? '',
      model: route.query.get('model') ?? op.defaultModel ?? modelsFor(op)[0]?.id ?? '',
      params: initialParamState(op.params),
      textMsg: '',
    }),
    { title: op.title, operationId: op.id, href: window.location.hash },
  );
  const { connectionId, model, params, textMsg } = draft;
  const setConnectionId = useCallback(
    (value: string) => setDraft((previous) => ({ ...previous, connectionId: value })),
    [setDraft],
  );
  const setModel = useCallback((value: string) => setDraft((previous) => ({ ...previous, model: value })), [setDraft]);
  const setTextMsg = useCallback(
    (value: string) => setDraft((previous) => ({ ...previous, textMsg: value })),
    [setDraft],
  );
  const setParams = useCallback(
    (next: SetStateAction<Record<string, ParamState>>) =>
      setDraft((previous) => ({
        ...previous,
        params: typeof next === 'function' ? next(previous.params) : next,
      })),
    [setDraft],
  );
  const [status, setStatus] = useRealtimeValue<'idle' | 'connecting' | 'configuring' | 'open' | 'closed'>(
    store,
    'status',
    'idle',
  );
  const [recording, setRecording] = useRealtimeValue<TraceEvent[]>(store, 'recording', []);
  const [loadedFrom, setLoadedFrom] = useRealtimeValue(store, 'loadedFrom', '');
  const [micOn, setMicOn] = useRealtimeValue(store, 'micOn', false);
  const [turns, setTurns] = useRealtimeValue<Turn[]>(store, 'turns', []);
  const [log, setLog] = useRealtimeValue<LogEntry[]>(store, 'log', []);
  const [runId, setRunId] = useRealtimeValue(store, 'runId', '');
  const [routeInfo, setRouteInfo] = useRealtimeValue(store, 'routeInfo', '');
  const [level, setLevel] = useRealtimeValue(store, 'level', 0);
  const [confirmCost, setConfirmCost] = useState(false);
  const [counts, setCounts] = useRealtimeValue(store, 'counts', { audioIn: 0, audioOut: 0, bytesOut: 0 });

  const wsRef = realtimeRef<WebSocket | null>(store, 'socket', null);
  const t0 = realtimeRef(store, 't0', 0);
  const micCtx = realtimeRef<AudioContext | null>(store, 'micCtx', null);
  const micStream = realtimeRef<MediaStream | null>(store, 'micStream', null);
  const outCtx = realtimeRef<AudioContext | null>(store, 'outCtx', null);
  const playhead = realtimeRef(store, 'playhead', 0);
  const sources = realtimeRef(store, 'sources', new Set<AudioBufferSourceNode>());
  const pendingFrames = realtimeRef<Float32Array[]>(store, 'pendingFrames', []);
  const pendingLen = realtimeRef(store, 'pendingLen', 0);
  const speechStoppedAt = realtimeRef<number | null>(store, 'speechStoppedAt', null);
  const turnSeq = realtimeRef(store, 'turnSeq', 0);
  const assistantTurn = realtimeRef<number | null>(store, 'assistantTurn', null);
  const firstAudioSeen = realtimeRef(store, 'firstAudioSeen', false);
  const micPending = realtimeRef(store, 'micPending', false);
  const alive = realtimeRef(store, 'alive', true);
  const visible = realtimeRef(store, 'visible', true);
  const activeGeneration = realtimeRef(store, 'generation', 0);
  const configured = realtimeRef(store, 'configured', false);
  const startingConnection = realtimeRef(store, 'startingConnection', false);
  const configurationTimeout = realtimeRef<ReturnType<typeof setTimeout> | undefined>(
    store,
    'configurationTimeout',
    undefined,
  );
  const transcriptRef = useRef<HTMLDivElement>(null);

  function syncActivity(running = !!wsRef.current) {
    setExternalRunSession(
      sessionKey,
      {
        title: `${op.title}${!visible.current && running ? ' · 麦克风已停' : ''}`,
        href: sessionHref.current,
        operationId: op.id,
        runId: (store.values.get('runId') as string) || undefined,
      },
      running,
      disconnect,
    );
  }

  const conn = own.find((c) => c.id === connectionId);
  const { models: remoteModels } = useRemoteModels(conn, provider);

  useEffect(() => {
    if (!connectionId && own.length && !restoredRunId) setConnectionId(own[0].id);
  }, [own, connectionId]);

  useEffect(() => {
    if (wsRef.current) return;
    let cancelled = false;
    (async () => {
      if (restoredRunId) {
        const record = await api.run(restoredRunId);
        if (cancelled) return;
        if (record.state && !draftControl.restored) {
          setConnectionId(record.state.connectionId);
          setModel(record.state.model);
          setParams({ ...initialParamState(op.params), ...record.state.params });
        }
        setRecording(record.events ?? []);
        setRunId(record.id);
        setLoadedFrom('已恢复历史模型与会话参数。下面的历史回放来自本机记录；重新连接会创建新实验。');
      } else if (presetId && !draftControl.restored) {
        const preset =
          presetsFor(op.id).find((p) => p.id === presetId) ??
          (await api.presets()).find((p) => p.id === presetId && p.operationId === op.id);
        if (!cancelled && preset) {
          if (preset.model) setModel(preset.model);
          setParams(initialParamState(op.params, preset.params));
          setLoadedFrom(`已载入预设「${preset.title}」，尚未连接厂商。`);
        }
      }
    })().catch((error) => {
      if (!cancelled) toast(`载入会话配置失败：${error.message}`, 'err');
    });
    return () => {
      cancelled = true;
    };
  }, [restoredRunId, presetId, op, toast]);

  const now = () => Math.round(performance.now() - t0.current);
  const pushLog = useCallback((e: LogEntry) => setLog((l) => (l.length > 400 ? [...l.slice(-300), e] : [...l, e])), []);

  const sessionEvent = useMemo(() => {
    try {
      return op.build({ model, input: {}, extra: conn?.extra ?? {}, params }).body as any;
    } catch {
      return null;
    }
  }, [op, model, conn, params]);

  function send(obj: any) {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(obj));
    if (obj.type !== 'input_audio_buffer.append') pushLog({ t: now(), dir: 'out', type: obj.type, data: obj });
  }

  function stopPlayback() {
    for (const s of sources.current) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    sources.current.clear();
    playhead.current = outCtx.current?.currentTime ?? 0;
  }

  function playPcm(b64: string) {
    if (!visible.current) return;
    const ctx = outCtx.current;
    if (!ctx) return;
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const samples = new Int16Array(bytes.buffer, 0, Math.floor(bytes.length / 2));
    const f32 = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) f32[i] = samples[i] / 32768;
    const buf = ctx.createBuffer(1, f32.length, spec.outputRate);
    buf.copyToChannel(f32, 0);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.03, playhead.current);
    src.start(at);
    playhead.current = at + buf.duration;
    sources.current.add(src);
    src.onended = () => sources.current.delete(src);
  }

  function onServerEvent(ev: any) {
    const type = String(ev.type ?? 'unknown');
    if (type.startsWith('playground.')) {
      if (type === 'playground.run') {
        setRunId(ev.runId);
        syncActivity();
        setRouteInfo(ev.route ?? '');
      } else if (type === 'playground.upstream_open') {
        setStatus('configuring');
        if (sessionEvent) send(sessionEvent);
      } else if (type === 'playground.error') toast(ev.message, 'err');
      else if (type === 'playground.trace_limit') toast(ev.message, 'err');
      pushLog({ t: now(), dir: 'sys', type, data: ev });
      return;
    }
    if (AUDIO_DELTA.has(type)) {
      setCounts((c) => ({ ...c, audioIn: c.audioIn + 1 }));
      if (!firstAudioSeen.current) {
        firstAudioSeen.current = true;
        const latency = speechStoppedAt.current != null ? now() - speechStoppedAt.current : undefined;
        const id = assistantTurn.current;
        if (id != null) setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, latencyMs: latency } : t)));
        pushLog({
          t: now(),
          dir: 'in',
          type: `${type}（首个音频分片）`,
          data: latency != null ? { latencyFromSpeechEndMs: latency } : undefined,
        });
      }
      if (ev.delta) playPcm(ev.delta);
      return;
    }
    pushLog({ t: now(), dir: 'in', type, data: ev });
    switch (type) {
      case 'session.updated':
        configured.current = true;
        if (configurationTimeout.current) clearTimeout(configurationTimeout.current);
        setStatus('open');
        break;
      case 'input_audio_buffer.speech_started': {
        // Barge-in: stop what the model is saying as soon as the user talks.
        if (sources.current.size > 0) {
          stopPlayback();
          const id = assistantTurn.current;
          if (id != null) setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, interrupted: true } : t)));
        }
        speechStoppedAt.current = null;
        break;
      }
      case 'input_audio_buffer.speech_stopped':
        speechStoppedAt.current = now();
        break;
      case 'conversation.item.input_audio_transcription.completed':
        setTurns((ts) => [...ts, { id: ++turnSeq.current, role: 'user', text: ev.transcript ?? '' }]);
        break;
      case 'response.created': {
        const id = ++turnSeq.current;
        assistantTurn.current = id;
        firstAudioSeen.current = false;
        setTurns((ts) => [...ts, { id, role: 'assistant', text: '' }]);
        break;
      }
      case 'error':
        toast(`厂商返回错误：${ev.error?.message ?? JSON.stringify(ev.error ?? ev)}`, 'err');
        break;
      default:
        if (TRANSCRIPT_DELTA.has(type) && ev.delta) {
          const id = assistantTurn.current;
          setTurns((ts) => ts.map((t) => (t.id === id ? { ...t, text: t.text + ev.delta } : t)));
        }
    }
  }

  async function connect(confirmed = false) {
    if (!conn) {
      toast(`请先添加「${provider.name}」的连接`, 'err');
      return;
    }
    try {
      validateOperationInput(op, { model, input: {}, params, extra: conn.extra });
    } catch (e: any) {
      toast(e.message, 'err');
      return;
    }
    if (!confirmed) {
      setConfirmCost(true);
      return;
    }
    if (startingConnection.current || wsRef.current) return;
    startingConnection.current = true;
    disconnect();
    const generation = ++activeGeneration.current;
    setTurns([]);
    setLog([]);
    setCounts({ audioIn: 0, audioOut: 0, bytesOut: 0 });
    t0.current = performance.now();
    configured.current = false;
    outCtx.current = new AudioContext({ sampleRate: spec.outputRate });
    try {
      await outCtx.current.resume();
    } finally {
      startingConnection.current = false;
    }
    if (!alive.current || generation !== activeGeneration.current) return;
    playhead.current = 0;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(
      `${proto}://${location.host}/api/ws?${new URLSearchParams({ connectionId: conn.id, operationId: op.id, model, params: JSON.stringify(params), confirmCost: '1', ...(restoredRunId ? { parentId: restoredRunId } : {}) })}`,
    );
    wsRef.current = ws;
    setStatus('connecting');
    syncActivity(true);
    configurationTimeout.current = setTimeout(() => {
      if (generation === activeGeneration.current && !configured.current) {
        disconnect();
        toast('未收到厂商 session.updated，已断开以避免空耗。请检查原生会话参数与事件。', 'err');
      }
    }, 30_000);
    ws.onmessage = (m) => {
      if (generation !== activeGeneration.current) return;
      if (typeof m.data !== 'string') return;
      try {
        onServerEvent(JSON.parse(m.data));
      } catch {
        pushLog({ t: now(), dir: 'in', type: 'non-json', data: String(m.data).slice(0, 500) });
      }
    };
    ws.onclose = () => {
      if (!alive.current || generation !== activeGeneration.current) return;
      setStatus('closed');
      configured.current = false;
      if (configurationTimeout.current) clearTimeout(configurationTimeout.current);
      wsRef.current = null;
      stopMic();
      stopPlayback();
      outCtx.current?.close().catch(() => {});
      outCtx.current = null;
      refreshEvidence();
      syncActivity(false);
      pruneRealtimeStores();
    };
    ws.onerror = () => pushLog({ t: now(), dir: 'sys', type: 'socket-error' });
  }

  function disconnect() {
    activeGeneration.current++;
    configured.current = false;
    if (configurationTimeout.current) clearTimeout(configurationTimeout.current);
    stopMic();
    wsRef.current?.close();
    wsRef.current = null;
    stopPlayback();
    outCtx.current?.close().catch(() => {});
    outCtx.current = null;
    if (alive.current) setStatus('closed');
    syncActivity(false);
    refreshEvidence();
    pruneRealtimeStores();
  }

  async function startMic() {
    if (!visible.current || micPending.current || micStream.current || wsRef.current?.readyState !== WebSocket.OPEN)
      return;
    const generation = activeGeneration.current;
    micPending.current = true;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (
        !visible.current ||
        !alive.current ||
        generation !== activeGeneration.current ||
        wsRef.current?.readyState !== WebSocket.OPEN
      ) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      micStream.current = stream;
      const ctx = new AudioContext({ sampleRate: spec.inputRate });
      micCtx.current = ctx;
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      if (!visible.current || !alive.current || generation !== activeGeneration.current) {
        stopMic();
        return;
      }
      const node = new AudioWorkletNode(ctx, 'pg-capture');
      const srcNode = ctx.createMediaStreamSource(stream);
      srcNode.connect(node);
      // The worklet must be part of an active graph; a muted gain prevents feedback.
      const mute = ctx.createGain();
      mute.gain.value = 0;
      node.connect(mute);
      mute.connect(ctx.destination);
      await ctx.resume();
      const frameTarget = Math.round(spec.inputRate / 10); // 100 ms per append
      node.port.onmessage = (e: MessageEvent<Float32Array>) => {
        const f = e.data;
        pendingFrames.current.push(f);
        pendingLen.current += f.length;
        let sum = 0;
        for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
        setLevel(Math.min(1, Math.sqrt(sum / f.length) * 4));
        if (pendingLen.current >= frameTarget) {
          const pcm = floatToPcm16(pendingFrames.current);
          pendingFrames.current = [];
          pendingLen.current = 0;
          const ws = wsRef.current;
          if (ws?.readyState === WebSocket.OPEN) {
            if (ws.bufferedAmount > 1024 * 1024) {
              stopMic();
              toast('网络发送缓冲过大，已停止麦克风；等待连接恢复后再试', 'err');
              return;
            }
            ws.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: toBase64(pcm) }));
            setCounts((c) => ({ ...c, audioOut: c.audioOut + 1, bytesOut: c.bytesOut + pcm.length }));
          }
        }
      };
      setMicOn(true);
    } catch (e: any) {
      stopMic();
      toast(`无法打开麦克风：${e.message}`, 'err');
    } finally {
      micPending.current = false;
    }
  }

  function stopMic() {
    micStream.current?.getTracks().forEach((t) => t.stop());
    micStream.current = null;
    micCtx.current?.close().catch(() => {});
    micCtx.current = null;
    pendingFrames.current = [];
    pendingLen.current = 0;
    setMicOn(false);
    setLevel(0);
  }

  useEffect(() => {
    alive.current = true;
    visible.current = true;
    store.mounted++;
    if (wsRef.current) syncActivity();
    return () => {
      store.mounted--;
      if (store.mounted > 0) return;
      visible.current = false;
      stopMic();
      stopPlayback();
      if (wsRef.current) syncActivity();
      pruneRealtimeStores();
    };
  }, [store]);

  function sendText() {
    if (!textMsg.trim() || wsRef.current?.readyState !== WebSocket.OPEN || !configured.current) return;
    send({
      type: 'conversation.item.create',
      item: { type: 'message', role: 'user', content: [{ type: 'input_text', text: textMsg }] },
    });
    send({ type: 'response.create' });
    setTurns((ts) => [...ts, { id: ++turnSeq.current, role: 'user', text: `⌨ ${textMsg}` }]);
    speechStoppedAt.current = now();
    setTextMsg('');
  }

  const latencies = turns.filter((t) => t.latencyMs != null).map((t) => t.latencyMs!);
  const avgLatency = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : null;
  const manualVad =
    sessionEvent?.session?.audio?.input?.turn_detection === null || sessionEvent?.session?.turn_detection === null;

  return (
    <div className="mx-auto max-w-[1400px] space-y-3 p-4 pb-24 sm:p-5 xl:pb-5">
      <header>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-zinc-100">{op.title}</h1>
          <a href={providerHref(provider.id)}>
            <Chip tone="violet">{provider.name}</Chip>
          </a>
          <Chip>实时语音 · WebSocket</Chip>
          <VerificationChip v={op.verification} />
          <EvidenceChip rows={evidence.filter((e) => e.operationId === op.id)} />
        </div>
        {op.summary && <p className="mt-1 max-w-4xl text-xs leading-relaxed text-zinc-400">{op.summary}</p>}
        <p className="mt-1 text-[11px] text-zinc-500">
          麦克风 PCM16 {spec.inputRate / 1000} kHz 上行 · 模型音频 PCM16 {spec.outputRate / 1000} kHz 下行 ·
          浏览器经本地中继连接厂商（密钥不进浏览器）
        </p>
      </header>

      {(op.notes?.length || spec.notes?.length) && (
        <details className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-[11px] text-zinc-400" open>
          <summary className="cursor-pointer text-zinc-300">使用说明与已知限制</summary>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 leading-relaxed">
            {[...(op.notes ?? []), ...(spec.notes ?? [])].map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
        </details>
      )}

      <div className="card flex flex-wrap items-center gap-2 p-3">
        <select
          className="input w-full sm:w-56"
          aria-label="实时会话连接"
          value={connectionId}
          onChange={(e) => setConnectionId(e.target.value)}
          disabled={!['idle', 'closed'].includes(status)}
        >
          {own.length === 0 && <option value="">（没有 {provider.name} 的连接）</option>}
          {connectionId && !conn && own.length > 0 && (
            <option value={connectionId}>历史连接已失效，请重新选择账户</option>
          )}
          {own.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} · {c.keyPreview}
            </option>
          ))}
        </select>
        <ModelPicker
          op={op}
          value={model}
          onChange={setModel}
          remote={remoteModels}
          listId={`rt-models-${op.id}`}
          disabled={!['idle', 'closed'].includes(status)}
        />
        <span className="flex-1" />
        <span
          className={`text-xs ${status === 'open' ? 'text-emerald-300' : status === 'connecting' ? 'text-sky-300' : 'text-zinc-500'}`}
        >
          {status === 'open'
            ? '● 已连接'
            : status === 'connecting'
              ? '◌ 连接中…'
              : status === 'configuring'
                ? '◌ 等待会话配置确认…'
                : status === 'closed'
                  ? '○ 已断开'
                  : '○ 未连接'}
        </span>
        {status === 'open' || status === 'connecting' || status === 'configuring' ? (
          <>
            {micOn ? (
              <button className="btn-danger" onClick={stopMic}>
                🎙 停止说话
              </button>
            ) : (
              <button className="btn-primary" onClick={startMic} disabled={status !== 'open'}>
                🎙 开始说话
              </button>
            )}
            {manualVad && (
              <button
                className="btn-outline"
                disabled={status !== 'open'}
                onClick={() => (
                  send({ type: 'input_audio_buffer.commit' }),
                  send({ type: 'response.create' }),
                  (speechStoppedAt.current = now())
                )}
              >
                提交这一段
              </button>
            )}
            <button
              className="btn-outline"
              onClick={() => (stopPlayback(), send({ type: 'response.cancel' }))}
              title="手动打断模型当前的回复"
              disabled={status !== 'open'}
            >
              ✋ 打断
            </button>
            <button className="btn-ghost" onClick={disconnect}>
              断开
            </button>
          </>
        ) : (
          <button
            className="btn-primary"
            onClick={() =>
              void connect().catch((e) => {
                disconnect();
                toast(e.message, 'err');
              })
            }
            disabled={!conn}
          >
            ▶ 连接
          </button>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-zinc-500">
        配置自动保存在此浏览器标签页。切换页面会停止麦克风与本地播放，已连接会话继续保留，可在全局运行栏断开。
      </p>
      {(!own.length || (connectionId && !conn)) && (
        <p role="alert" className="rounded-md border border-amber-900/60 p-3 text-xs text-amber-200">
          {own.length ? '原连接已失效，请在上方明确选择账户后再连接。' : `还没有 ${provider.name} 的连接。`}
          <a
            className="ml-2 underline"
            href={`#/connections?provider=${encodeURIComponent(provider.id)}&returnTo=${encodeURIComponent(window.location.hash)}`}
          >
            添加连接后返回
          </a>
        </p>
      )}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
        <div className="card space-y-3 p-4">
          <h2 className="label">会话配置（连接时以 session.update 发送）</h2>
          <fieldset disabled={!['idle', 'closed'].includes(status)}>
            <ParamsPanel specs={op.params} state={params} setState={setParams} model={model} />
          </fieldset>
          <details className="text-[11px]">
            <summary className="cursor-pointer text-zinc-500">将发送的 session.update</summary>
            <JsonBlock value={sessionEvent} max={8000} />
          </details>
        </div>
        <div className="card flex scroll-mt-20 flex-col p-4" ref={transcriptRef}>
          <div className="mb-2 flex flex-wrap items-center gap-3 text-[11px] text-zinc-400">
            <span className="flex items-center gap-1.5">
              麦克风
              <span className="inline-block h-2 w-24 overflow-hidden rounded bg-zinc-800">
                <span
                  className="block h-full bg-emerald-500 transition-all"
                  style={{ width: `${Math.round(level * 100)}%` }}
                />
              </span>
            </span>
            <span>
              上行 {counts.audioOut} 段（{(counts.bytesOut / 1024).toFixed(0)} KB）
            </span>
            <span>下行音频 {counts.audioIn} 片</span>
            <span title="从检测到你停止说话，到收到第一片回复音频">
              平均响应延迟 {avgLatency != null ? `${avgLatency} ms` : '—'}
            </span>
            {routeInfo && <span className="text-zinc-600">{routeInfo}</span>}
            {runId && (
              <a className="text-violet-400 underline" href={`#/runs/${runId}`}>
                实验记录
              </a>
            )}
          </div>
          <div className="min-h-64 flex-1 space-y-2 overflow-auto rounded-md bg-zinc-950/50 p-3">
            {turns.length === 0 && (
              <p className="text-xs text-zinc-600">
                连接后点「开始说话」，直接对着麦克风说话；说话时模型若在回答会被立即打断。
              </p>
            )}
            {turns.map((t) => (
              <div
                key={t.id}
                className={`rounded-md p-2 text-sm ${t.role === 'user' ? 'ml-10 bg-violet-950/40' : 'mr-10 bg-emerald-950/30'}`}
              >
                <div className="mb-0.5 flex gap-2 text-[11px] text-zinc-500">
                  {t.role}
                  {t.latencyMs != null && <span className="text-sky-300">首音频 {t.latencyMs} ms</span>}
                  {t.interrupted && <span className="text-amber-300">被打断</span>}
                </div>
                <div className="whitespace-pre-wrap text-zinc-100">
                  {t.text || <span className="text-zinc-600">…</span>}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <input
              className="input flex-1"
              placeholder="也可以打字发送（conversation.item.create + response.create）"
              aria-label="实时会话文字消息"
              value={textMsg}
              onChange={(e) => setTextMsg(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing && e.keyCode !== 229) {
                  e.preventDefault();
                  sendText();
                }
              }}
              disabled={status !== 'open'}
            />
            <button className="btn-outline" onClick={sendText} disabled={status !== 'open'}>
              发送
            </button>
          </div>
        </div>
      </div>
      <div className="lab-mobile-controls fixed right-0 bottom-0 left-0 z-20 flex items-center gap-2 border-t border-zinc-700 bg-zinc-950/95 p-3 backdrop-blur md:left-60 xl:hidden">
        <button
          className="btn-outline flex-1"
          onClick={() => transcriptRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >
          查看对话
        </button>
        {status === 'open' ? (
          <button className={micOn ? 'btn-danger flex-1' : 'btn-primary flex-1'} onClick={micOn ? stopMic : startMic}>
            {micOn ? '停止说话' : '开始说话'}
          </button>
        ) : (
          <button
            className="btn-primary flex-1"
            disabled={!conn || status === 'connecting' || status === 'configuring'}
            onClick={() => {
              void connect().catch((error) => {
                disconnect();
                toast(error.message, 'err');
              });
            }}
          >
            连接会话
          </button>
        )}
        {['connecting', 'configuring', 'open'].includes(status) && (
          <button className="btn-ghost" onClick={disconnect}>
            断开
          </button>
        )}
      </div>

      <div className="card p-4">
        <h2 className="label mb-2">事件序列（音频分片只计数不逐条显示）</h2>
        <div className="max-h-96 space-y-1 overflow-auto">
          {log.slice(-200).map((e, i) => (
            <details key={i} className="rounded border border-zinc-800/80 bg-zinc-950/40 px-2 py-1 text-[11px]">
              <summary className="mono cursor-pointer">
                <span className="text-zinc-500">+{e.t}ms</span>{' '}
                <span
                  className={e.dir === 'out' ? 'text-violet-300' : e.dir === 'in' ? 'text-sky-300' : 'text-zinc-400'}
                >
                  {e.dir === 'out' ? '→' : e.dir === 'in' ? '←' : '•'}
                </span>{' '}
                {e.type}
              </summary>
              {e.data && <JsonBlock value={e.data} max={4000} />}
            </details>
          ))}
        </div>
      </div>
      {loadedFrom && (
        <p className="rounded-lg border border-sky-900 bg-sky-950/20 p-3 text-xs text-sky-200">{loadedFrom}</p>
      )}
      {!!recording.length && (
        <section className="card space-y-3 p-4">
          <h2 className="label">历史会话回放</h2>
          <RealtimeRecording events={recording} outputRate={spec.outputRate} />
        </section>
      )}
      {confirmCost && (
        <Modal title="开始实时语音会话" onClose={() => setConfirmCost(false)}>
          <p className="text-sm leading-relaxed text-zinc-300">
            {op.costHint ?? '实时音频会话按服务商规则计费，连接后请及时断开。'}
          </p>
          <p className="mt-3 text-xs leading-relaxed text-zinc-500">
            麦克风只在你点击「开始说话」后开启。会话中的声音和文字会发给所选服务商，并在本机保留实验记录。
          </p>
          <div className="mt-5 flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setConfirmCost(false)}>
              返回
            </button>
            <button
              className="btn-primary"
              onClick={() => {
                setConfirmCost(false);
                void connect(true).catch((e) => {
                  disconnect();
                  toast(e.message, 'err');
                });
              }}
            >
              确认费用并连接
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}
