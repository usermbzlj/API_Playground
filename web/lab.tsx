import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, streamRun, type RunRequestBody } from './api.ts';
import { useApp } from './app.tsx';
import { labHref } from './router.ts';
import { initialParamState, type ParamState } from '../shared/util.ts';
import type { AssetInfo, TraceEvent } from '../shared/types.ts';
import { Chip, CodeInput, CopyButton, EmptyHint, JsonBlock, Modal, Spinner, VerificationChip, WORKBENCH_LABEL, fmtMs, hexToBase64 } from './ui.tsx';
import { COST_LABEL } from './ui.tsx';
import { EventList } from './pages.tsx';

const WORKBENCH_DEFAULTS: Record<string, Record<string, unknown>> = {
  chat: { system: '', messages: [{ role: 'user', content: '' }], prefix: '', stream: true, keepReasoning: false },
  fim: { prefix: '', suffix: '', stream: true },
  tts: { text: '' },
};

type Tab = 'output' | 'events' | 'request' | 'response' | 'metrics';

export function LabPage({ operationId }: { operationId: string }) {
  const { catalog, connections, toast } = useApp();
  const op = catalog?.operations.find((o) => o.id === operationId);
  const provider = catalog?.providers.find((p) => p.id === op?.providerId);

  const [connectionId, setConnectionId] = useState('');
  const [model, setModel] = useState('');
  const [customModel, setCustomModel] = useState(false);
  const [input, setInput] = useState<Record<string, unknown>>({});
  const [params, setParams] = useState<Record<string, ParamState>>({});
  const [presetId, setPresetId] = useState('');
  const [running, setRunning] = useState(false);
  const [events, setEvents] = useState<TraceEvent[]>([]);
  const [response, setResponse] = useState<any>(null);
  const [request, setRequest] = useState<any>(null);
  const [artifacts, setArtifacts] = useState<AssetInfo[]>([]);
  const [error, setError] = useState<any>(null);
  const [metrics, setMetrics] = useState<any>(null);
  const [tab, setTab] = useState<Tab>('output');
  const [costPrompt, setCostPrompt] = useState<any>(null);
  const abortRef = useRef<AbortController | null>(null);

  const presets = useMemo(() => (catalog?.presets ?? []).filter((p) => p.operationId === op?.id), [catalog, op]);
  const connOptions = useMemo(() => {
    const own = connections.filter((c) => c.providerId === op?.providerId);
    return own.length > 0 ? own : connections;
  }, [connections, op]);
  const models = useMemo(() => {
    if (!provider) return [];
    return op?.models?.length ? provider.models.filter((m) => op.models!.includes(m.id)) : provider.models;
  }, [provider, op]);

  useEffect(() => {
    if (!op) return;
    setInput({ ...(WORKBENCH_DEFAULTS[op.workbench] ?? {}) });
    setParams(initialParamState(op.params));
    setModel(op.defaultModel ?? provider?.models[0]?.id ?? '');
    setCustomModel(false);
    setEvents([]);
    setResponse(null);
    setRequest(null);
    setArtifacts([]);
    setError(null);
    setMetrics(null);
    setPresetId('');
    setTab('output');
  }, [op, provider]);

  useEffect(() => {
    if (!connectionId && connOptions.length > 0) setConnectionId(connOptions[0].id);
  }, [connOptions, connectionId]);

  const run = useCallback(
    async (confirmCost = false) => {
      if (!op) return;
      if (!connectionId) {
        toast('请先在「连接」页面添加 API Key', 'err');
        return;
      }
      // JSON 参数前置校验：非法 JSON 在服务端会构建失败，提前给可读提示。
      for (const [key, st] of Object.entries(params)) {
        if (!st.enabled || typeof st.value !== 'string') continue;
        const spec = op.params.find((s) => s.key === key);
        if (spec?.type !== 'json') continue;
        try {
          if (st.value.trim()) JSON.parse(st.value);
        } catch (e: any) {
          toast(`参数 ${key} 不是合法 JSON：${e.message}`, 'err');
          return;
        }
      }
      setRunning(true);
      setEvents([]);
      setResponse(null);
      setRequest(null);
      setArtifacts([]);
      setError(null);
      setMetrics(null);
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const body: RunRequestBody = {
        connectionId,
        operationId: op.id,
        model,
        title: `${op.title} · ${model || '默认模型'}`,
        input,
        params,
        confirmCost,
      };
      try {
        await streamRun(
          body,
          (ev) => {
            setEvents((prev) => (prev.length > 800 ? prev : [...prev, ev]));
            if (ev.type === 'request') setRequest(ev.data);
            else if (ev.type === 'body') setResponse(ev.data);
            else if (ev.type === 'artifact') setArtifacts((prev) => [...prev, ev.data]);
            else if (ev.type === 'error') {
              setError(ev.data);
              if (ev.data?.costConfirm) setCostPrompt(ev.data);
            } else if (ev.type === 'done') setMetrics(ev.data?.metrics ?? null);
          },
          ctrl.signal,
        );
      } catch (e: any) {
        setError({ title: '本地通信失败', hints: [e.message] });
      } finally {
        setRunning(false);
      }
    },
    [op, connectionId, model, input, params, toast],
  );

  function applyPreset(id: string) {
    setPresetId(id);
    const p = presets.find((x) => x.id === id);
    if (!p || !op) return;
    setInput({ ...(WORKBENCH_DEFAULTS[op.workbench] ?? {}), ...(p.input as Record<string, unknown>) });
    setParams(initialParamState(op.params, p.params));
    if (p.model) setModel(p.model);
    toast(`已载入预设「${p.title}」`);
  }

  if (!op || !provider) {
    return <div className="p-10 text-zinc-500">操作不存在：{operationId}</div>;
  }

  const cost = COST_LABEL[op.costTier] ?? COST_LABEL.low;

  return (
    <div className="mx-auto max-w-7xl space-y-4 p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold text-zinc-100">{op.title}</h1>
            <Chip tone="violet">{provider.name}</Chip>
            <Chip>{WORKBENCH_LABEL[op.workbench] ?? op.workbench}</Chip>
            <Chip tone={cost.tone} title={op.costHint}>
              {cost.label}
            </Chip>
            <VerificationChip v={op.verification} />
          </div>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-zinc-400">{op.summary}</p>
          {op.docsUrl && (
            <a className="text-[11px] text-violet-400 underline" href={op.docsUrl} target="_blank" rel="noreferrer">
              官方文档 ↗
            </a>
          )}
        </div>
        {op.verification && op.verification.status !== 'tested' && (
          <div className="max-w-sm rounded-md border border-amber-800/60 bg-amber-950/30 p-2 text-[11px] leading-relaxed text-amber-200/90">
            本操作尚未用真实 Key 实测：{op.verification.note ?? '调用结果以实际返回为准。'}
          </div>
        )}
      </header>

      {(op.notes ?? []).length > 0 && (
        <ul className="list-disc space-y-1 rounded-md border border-zinc-800 bg-zinc-900/40 px-4 py-2 pl-8 text-[11px] leading-relaxed text-zinc-400">
          {op.notes!.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}

      <div className="card flex flex-wrap items-center gap-2 p-3">
        <select className="input w-48" value={connectionId} onChange={(e) => setConnectionId(e.target.value)}>
          {connOptions.length === 0 && <option value="">（无可用连接）</option>}
          {connOptions.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} · {c.keyPreview}
            </option>
          ))}
        </select>
        {customModel ? (
          <input className="input w-56 mono" value={model} onChange={(e) => setModel(e.target.value)} placeholder="输入模型 ID" autoFocus />
        ) : (
          <select
            className="input w-56"
            value={model}
            onChange={(e) => {
              if (e.target.value === '__custom') {
                setCustomModel(true);
                setModel('');
              } else setModel(e.target.value);
            }}
          >
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label ?? m.id}
              </option>
            ))}
            {op.freeModel && <option value="__custom">自定义模型 ID…</option>}
          </select>
        )}
        {presets.length > 0 && (
          <select className="input w-44" value={presetId} onChange={(e) => applyPreset(e.target.value)}>
            <option value="">载入示例预设…</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
        )}
        <span className="flex-1" />
        {running && (
          <button className="btn-outline" onClick={() => abortRef.current?.abort()}>
            中止
          </button>
        )}
        <button className="btn-primary" onClick={() => run(false)} disabled={running || !connectionId}>
          {running ? <Spinner /> : '▶ 运行'}
        </button>
      </div>

      {connOptions.length === 0 && (
        <div className="rounded-md border border-amber-800/60 bg-amber-950/30 p-3 text-xs text-amber-200">
          还没有「{provider.name}」的连接。
          <a className="ml-1 underline" href="#/connections">
            去添加 API Key
          </a>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="card p-4">
          <h2 className="label mb-3">输入</h2>
          <WorkbenchInput op={op} input={input} setInput={setInput} providerId={provider.id} />
        </div>
        <div className="card p-4">
          <h2 className="label mb-3">
            原生参数
            <span className="ml-2 font-normal text-zinc-600">勾选后才会随请求发出；未勾选的参数完全不会出现在请求体里</span>
          </h2>
          <ParamsPanel specs={op.params} state={params} setState={setParams} model={model} />
        </div>
      </div>

      <div className="card">
        <div className="flex gap-2 border-b border-zinc-800 p-2">
          {(
            [
              ['output', '结果'],
              ['events', `事件流 (${events.length})`],
              ['request', '原生请求'],
              ['response', '原始响应'],
              ['metrics', '指标与费用'],
            ] as [Tab, string][]
          ).map(([k, label]) => (
            <button key={k} className={tab === k ? 'btn-primary text-xs' : 'btn-ghost text-xs'} onClick={() => setTab(k)}>
              {label}
            </button>
          ))}
        </div>
        <div className="p-4">
          {tab === 'output' && (
            <OutputPane op={op} input={input} events={events} response={response} artifacts={artifacts} running={running} error={error} />
          )}
          {tab === 'events' && <EventList events={events} />}
          {tab === 'request' && (
            <div className="space-y-2">
              <div className="flex justify-end">
                <CopyButton text={JSON.stringify(request?.body ?? {}, null, 2)} label="复制请求体（已脱敏）" />
              </div>
              {request ? <JsonBlock value={request} /> : <EmptyHint>运行后显示实际发出的请求（已脱敏）</EmptyHint>}
            </div>
          )}
          {tab === 'response' && (
            <>
              {response ? (
                <JsonBlock value={response} />
              ) : (
                <EmptyHint>{events.length > 0 ? '流式响应请查看「事件流」标签' : '运行后显示原始响应'}</EmptyHint>
              )}
            </>
          )}
          {tab === 'metrics' && (
            <div className="space-y-3">
              <JsonBlock value={metrics ?? {}} />
              {metrics?.usage && (
                <div className="flex flex-wrap gap-1.5">
                  {Object.entries(metrics.usage).map(([k, v]) => (
                    <Chip key={k} title={k}>
                      {k}: {String(v)}
                    </Chip>
                  ))}
                </div>
              )}
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
            </div>
          )}
        </div>
      </div>

      {costPrompt && (
        <Modal title="费用确认" onClose={() => setCostPrompt(null)}>
          <p className="text-sm text-zinc-300">{costPrompt.title}</p>
          <p className="mt-2 text-xs text-zinc-500">{op.costHint ?? '该操作可能产生较高费用，请确认后再执行。'}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn-ghost" onClick={() => setCostPrompt(null)}>
              取消
            </button>
            <button
              className="btn-primary"
              onClick={() => {
                setCostPrompt(null);
                run(true);
              }}
            >
              确认并运行
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ============================ 参数面板 ============================

function ParamsPanel({
  specs,
  state,
  setState,
  model,
}: {
  specs: { key: string; label: string; type: string; options?: { value: string | number | boolean; label?: string }[]; min?: number; max?: number; step?: number; default?: unknown; description?: string; advanced?: boolean; native?: boolean; models?: string; group?: string; verification?: any }[];
  state: Record<string, ParamState>;
  setState: (fn: (prev: Record<string, ParamState>) => Record<string, ParamState>) => void;
  model: string;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const groups = useMemo(() => {
    const map = new Map<string, typeof specs>();
    for (const s of specs) {
      const list = map.get(s.group ?? '参数') ?? [];
      list.push(s);
      map.set(s.group ?? '参数', list);
    }
    return [...map.entries()];
  }, [specs]);

  const visible = (s: any) => !s.advanced || showAdvanced;

  if (specs.length === 0) return <p className="text-xs text-zinc-600">该操作没有可调原生参数。</p>;

  return (
    <div className="space-y-3">
      <label className="flex items-center gap-1.5 text-[11px] text-zinc-500">
        <input type="checkbox" checked={showAdvanced} onChange={(e) => setShowAdvanced(e.target.checked)} />
        显示高级参数
      </label>
      {groups.map(([group, list]) => {
        const items = list.filter(visible);
        if (items.length === 0) return null;
        return (
          <div key={group}>
            <h3 className="mb-1.5 text-[11px] font-semibold text-zinc-400">{group}</h3>
            <div className="space-y-1.5">
              {items.map((s) => {
                const st = state[s.key] ?? { enabled: false, value: s.default };
                const applies = !s.models || (model && new RegExp(s.models, 'i').test(model));
                return (
                  <div key={s.key} className={`flex items-start gap-2 ${applies ? '' : 'opacity-40'}`} title={applies ? undefined : '该参数不适用于当前模型'}>
                    <input
                      type="checkbox"
                      className="mt-1.5"
                      checked={st.enabled}
                      onChange={(e) => setState((prev) => ({ ...prev, [s.key]: { ...st, enabled: e.target.checked } }))}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="mono text-xs text-zinc-200">{s.key}</span>
                        {s.native && <Chip tone="violet">原生</Chip>}
                        {s.verification && <VerificationChip v={s.verification} />}
                      </div>
                      <ParamControl spec={s} value={st.value} onChange={(v) => setState((prev) => ({ ...prev, [s.key]: { ...st, value: v } }))} />
                      {s.description && <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">{s.description}</p>}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ParamControl({
  spec,
  value,
  onChange,
}: {
  spec: { key: string; type: string; options?: { value: string | number | boolean; label?: string }[]; min?: number; max?: number; step?: number };
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  switch (spec.type) {
    case 'number':
    case 'integer':
      return (
        <input
          type="number"
          className="input mt-1 w-40"
          value={value == null ? '' : String(value)}
          min={spec.min}
          max={spec.max}
          step={spec.step}
          onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
        />
      );
    case 'boolean':
      return (
        <label className="mt-1 flex items-center gap-1.5 text-xs text-zinc-300">
          <input type="checkbox" checked={value === true || value === 'true'} onChange={(e) => onChange(e.target.checked)} />
          {String(value)}
        </label>
      );
    case 'enum':
      return (
        <select className="input mt-1 w-52" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)}>
          {(spec.options ?? []).map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label ?? String(o.value)}
            </option>
          ))}
        </select>
      );
    case 'string-list':
      return (
        <textarea
          className="input mt-1 min-h-14 font-mono text-xs"
          value={Array.isArray(value) ? value.join('\n') : String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          placeholder="每行一个"
        />
      );
    case 'text':
      return <textarea className="input mt-1 min-h-16" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
    case 'json':
      return (
        <div className="mt-1">
          <CodeInput
            value={typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2)}
            onChange={onChange}
            minHeight={100}
          />
        </div>
      );
    default:
      return <input className="input mt-1" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />;
  }
}

// ============================ 工作台输入 ============================

function WorkbenchInput({
  op,
  input,
  setInput,
  providerId,
}: {
  op: { workbench: string; features: string[] };
  input: Record<string, unknown>;
  setInput: (v: Record<string, unknown>) => void;
  providerId: string;
}) {
  if (op.workbench === 'chat') return <ChatWorkbench op={op} input={input} setInput={setInput} providerId={providerId} />;
  if (op.workbench === 'fim') return <FimWorkbench input={input} setInput={setInput} />;
  if (op.workbench === 'tts') return <TtsWorkbench input={input} setInput={setInput} />;
  return <p className="text-xs text-zinc-500">该工作台尚未适配，请使用「原始请求」页。</p>;
}

interface Msg {
  role: string;
  content: string;
  images?: string[];
}

function ChatWorkbench({
  op,
  input,
  setInput,
  providerId,
}: {
  op: { features: string[] };
  input: Record<string, unknown>;
  setInput: (v: Record<string, unknown>) => void;
  providerId: string;
}) {
  const { toast } = useApp();
  const messages = (input.messages as Msg[]) ?? [];
  const setMessages = (msgs: Msg[]) => setInput({ ...input, messages: msgs });

  async function uploadImage(idx: number, file: File) {
    try {
      const a = await api.uploadAsset(file);
      const msgs = messages.map((m, i) => (i === idx ? { ...m, images: [...(m.images ?? []), a.id] } : m));
      setMessages(msgs);
    } catch (e: any) {
      toast(`上传失败：${e.message}`, 'err');
    }
  }

  return (
    <div className="space-y-3">
      <label className="block">
        <span className="label">系统指令（可选）</span>
        <textarea
          className="input mt-1 min-h-14"
          value={String(input.system ?? '')}
          onChange={(e) => setInput({ ...input, system: e.target.value })}
          placeholder="例如：你是一个简洁的助手"
        />
      </label>

      <div>
        <div className="flex items-center justify-between">
          <span className="label">对话消息</span>
          <button className="btn-ghost text-xs" onClick={() => setMessages([...messages, { role: 'user', content: '' }])}>
            + 添加消息
          </button>
        </div>
        <div className="mt-1.5 space-y-2">
          {messages.map((m, i) => (
            <div key={i} className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2">
              <div className="flex items-center gap-2">
                <select
                  className="input w-28 py-1 text-xs"
                  value={m.role}
                  onChange={(e) => setMessages(messages.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}
                >
                  <option value="user">user</option>
                  <option value="assistant">assistant</option>
                  <option value="system">system</option>
                  <option value="tool">tool</option>
                </select>
                {m.role === 'user' && (
                  <label className="btn-ghost cursor-pointer text-xs">
                    图片
                    <input
                      type="file"
                      accept="image/*"
                      className="hidden"
                      onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) uploadImage(i, f);
                        e.target.value = '';
                      }}
                    />
                  </label>
                )}
                <span className="flex-1" />
                <button className="btn-ghost text-xs text-zinc-600" onClick={() => setMessages(messages.filter((_, j) => j !== i))}>
                  删除
                </button>
              </div>
              <textarea
                className="input mt-1.5 min-h-14"
                value={m.content}
                onChange={(e) => setMessages(messages.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))}
                placeholder={m.role === 'user' ? '用户消息…' : '消息内容…'}
              />
              {(m.images ?? []).length > 0 && (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {(m.images ?? []).map((id) => (
                    <span key={id} className="relative">
                      <img src={`/api/assets/${id}/raw`} className="h-14 rounded border border-zinc-700" alt="" />
                      <button
                        className="absolute -right-1.5 -top-1.5 rounded-full bg-zinc-900 px-1 text-[10px] text-rose-400 shadow"
                        onClick={() => setMessages(messages.map((x, j) => (j === i ? { ...x, images: (x.images ?? []).filter((g) => g !== id) } : x)))}
                      >
                        ✕
                      </button>
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {op.features.includes('prefix') && (
        <label className="block">
          <span className="label">Assistant 前缀（前缀续写）</span>
          <textarea
            className="input mt-1 mono min-h-14"
            value={String(input.prefix ?? '')}
            onChange={(e) => setInput({ ...input, prefix: e.target.value })}
            placeholder={'留空则不使用。例如：```json\n{'}
          />
          <p className="mt-0.5 text-[11px] text-zinc-600">会作为最后一条 assistant 消息发出，强制模型从这里接着写。</p>
        </label>
      )}

      <div className="flex flex-wrap gap-4 text-xs text-zinc-400">
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={input.stream !== false} onChange={(e) => setInput({ ...input, stream: e.target.checked })} />
          流式输出
        </label>
        {op.features.includes('reasoning') && (
          <label className="flex items-center gap-1.5" title="部分厂商要求多轮对话回传历史 reasoning_content">
            <input type="checkbox" checked={input.keepReasoning === true} onChange={(e) => setInput({ ...input, keepReasoning: e.target.checked })} />
            回传历史 reasoning_content
          </label>
        )}
        <span className="text-[11px] text-zinc-600">厂商：{providerId}</span>
      </div>
    </div>
  );
}

function FimWorkbench({ input, setInput }: { input: Record<string, unknown>; setInput: (v: Record<string, unknown>) => void }) {
  const prefix = String(input.prefix ?? '');
  const suffix = String(input.suffix ?? '');
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="label">前缀（光标之前的代码）</span>
        <textarea
          className="input mt-1 mono min-h-32"
          value={prefix}
          onChange={(e) => setInput({ ...input, prefix: e.target.value })}
          placeholder={'function twoSum(nums: number[], target: number) {\n  '}
        />
      </label>
      <label className="block">
        <span className="label">后缀（光标之后的代码）</span>
        <textarea
          className="input mt-1 mono min-h-32"
          value={suffix}
          onChange={(e) => setInput({ ...input, suffix: e.target.value })}
          placeholder={'\n}\n\ntwoSum([2, 7], 9);'}
        />
      </label>
      <details className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2 text-[11px] text-zinc-500">
        <summary className="cursor-pointer">查看请求体结构</summary>
        <pre className="mono mt-1.5 whitespace-pre-wrap break-all text-zinc-300">{JSON.stringify({ model: '（当前模型）', prompt: prefix, suffix: suffix, max_tokens: '…' }, null, 2)}</pre>
      </details>
      <label className="flex items-center gap-1.5 text-xs text-zinc-400">
        <input type="checkbox" checked={input.stream !== false} onChange={(e) => setInput({ ...input, stream: e.target.checked })} />
        流式输出
      </label>
    </div>
  );
}

function TtsWorkbench({ input, setInput }: { input: Record<string, unknown>; setInput: (v: Record<string, unknown>) => void }) {
  return (
    <div className="space-y-3">
      <label className="block">
        <span className="label">要合成的文字</span>
        <textarea
          className="input mt-1 min-h-32"
          value={String(input.text ?? '')}
          onChange={(e) => setInput({ ...input, text: e.target.value })}
          placeholder="输入要转语音的文字…"
        />
      </label>
      <p className="text-[11px] leading-relaxed text-zinc-500">
        音色、语速、情绪、音频格式等都在右侧「原生参数」面板。voice_id 可填系统预置音色；流式返回可测量首包延迟。
      </p>
    </div>
  );
}

// ============================ 输出 ============================

interface Accum {
  text: string;
  reasoning: string;
  toolCalls: any[];
  audioHex: string;
  usage: any;
  last: any;
}

function accumulate(kind: string | undefined, events: TraceEvent[]): Accum {
  const out: Accum = { text: '', reasoning: '', toolCalls: [], audioHex: '', usage: undefined, last: undefined };
  for (const ev of events) {
    if (ev.type === 'body') {
      out.last = ev.data;
      if (ev.data?.usage) out.usage = ev.data.usage;
      continue;
    }
    if (ev.type !== 'chunk') continue;
    const payload = ev.data?.data ?? ev.data;
    out.last = payload;
    if (payload?.usage) out.usage = payload.usage;
    if (kind === 'openai-chat') {
      const delta = payload?.choices?.[0]?.delta;
      if (delta?.content) out.text += delta.content;
      if (delta?.reasoning_content) out.reasoning += delta.reasoning_content;
      for (const tc of delta?.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        out.toolCalls[idx] = out.toolCalls[idx] ?? { name: '', args: '' };
        if (tc.function?.name) out.toolCalls[idx].name += tc.function.name;
        if (tc.function?.arguments) out.toolCalls[idx].args += tc.function.arguments;
      }
    } else if (kind === 'openai-completion') {
      out.text += payload?.choices?.[0]?.text ?? '';
    } else if (kind === 'minimax-t2a') {
      out.audioHex += payload?.data?.audio ?? '';
    }
  }
  return out;
}

function OutputPane({
  op,
  input,
  events,
  response,
  artifacts,
  running,
  error,
}: {
  op: { workbench: string; stream?: string };
  input: Record<string, unknown>;
  events: TraceEvent[];
  response: any;
  artifacts: AssetInfo[];
  running: boolean;
  error: any;
}) {
  const s = useMemo(() => accumulate(op.stream, events), [op.stream, events]);

  if (events.length === 0 && !response) {
    return <EmptyHint>{running ? '正在调用…' : '点击「▶ 运行」发起真实调用'}</EmptyHint>;
  }

  return (
    <div className="space-y-3">
      {op.workbench === 'chat' && (
        <>
          {!!input.system && (
            <div className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2 text-xs text-zinc-400">
              <span className="text-zinc-600">system：</span>
              {String(input.system)}
            </div>
          )}
          {((input.messages as Msg[]) ?? []).map((m, i) => (
            <div key={i} className={`rounded-md p-2.5 text-sm ${m.role === 'user' ? 'bg-violet-950/40' : 'bg-zinc-800/40'}`}>
              <div className="mb-1 text-[11px] text-zinc-500">{m.role}</div>
              {(m.images ?? []).length > 0 && (
                <div className="mb-1.5 flex flex-wrap gap-1.5">
                  {(m.images ?? []).map((id) => (
                    <img key={id} src={`/api/assets/${id}/raw`} className="max-h-32 rounded border border-zinc-700" alt="" />
                  ))}
                </div>
              )}
              <div className="whitespace-pre-wrap break-words text-zinc-200">{m.content}</div>
            </div>
          ))}
          <div className="rounded-md bg-emerald-950/30 p-2.5 text-sm">
            <div className="mb-1 text-[11px] text-zinc-500">assistant</div>
            {s.reasoning && (
              <details className="mb-1.5">
                <summary className="cursor-pointer text-[11px] text-zinc-500">思考内容（{s.reasoning.length} 字符）</summary>
                <div className="mt-1 whitespace-pre-wrap rounded bg-zinc-950/60 p-2 text-xs leading-relaxed text-zinc-400">{s.reasoning}</div>
              </details>
            )}
            <div className="whitespace-pre-wrap break-words text-zinc-100">
              {s.text}
              {running && <span className="caret" />}
            </div>
            {s.toolCalls.length > 0 && (
              <div className="mt-2 space-y-1">
                {s.toolCalls.map((tc, i) => (
                  <div key={i} className="rounded bg-zinc-950/60 p-2 text-[11px]">
                    <span className="text-violet-300">🔧 {tc.name || '(未命名)'}</span>
                    <pre className="mono mt-1 whitespace-pre-wrap break-all text-zinc-400">{tc.args}</pre>
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {op.workbench === 'fim' && (
        <div className="rounded-md bg-zinc-950/60 p-3">
          <div className="mb-1 text-[11px] text-zinc-500">补全结果（仅中间部分）</div>
          <pre className="mono whitespace-pre-wrap break-all text-sm text-zinc-100">
            {s.text}
            {running && <span className="caret" />}
          </pre>
        </div>
      )}

      {op.workbench === 'tts' && <TtsOutput s={s} response={response} artifacts={artifacts} />}

      {!['chat', 'fim', 'tts'].includes(op.workbench) && <JsonBlock value={response ?? s.last} />}

      {error && !error.costConfirm && (
        <div className="rounded-md border border-rose-800 bg-rose-950/40 p-3 text-xs text-rose-200">
          <p className="font-medium">{error.title}</p>
          <ul className="mt-1 list-disc pl-5">
            {(error.hints ?? []).map((h: string) => (
              <li key={h}>{h}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function TtsOutput({ s, response, artifacts }: { s: Accum; response: any; artifacts: AssetInfo[] }) {
  const hex = s.audioHex || response?.data?.audio || '';
  const src = hex ? `data:audio/mpeg;base64,${hexToBase64(hex)}` : null;
  return (
    <div className="space-y-3">
      {src && (
        <div className="space-y-1.5">
          <div className="text-[11px] text-zinc-500">{s.audioHex ? '流式音频（已拼接）' : '合成音频'}</div>
          <audio controls src={src} className="w-full" />
        </div>
      )}
      {artifacts.map((a) => (
        <div key={a.id} className="space-y-1.5">
          <div className="text-[11px] text-zinc-500">已保存产物 · {(a.size / 1024).toFixed(1)} KB</div>
          <audio controls src={a.url} className="w-full" />
        </div>
      ))}
      {!src && artifacts.length === 0 && <p className="text-xs text-zinc-500">等待音频返回…</p>}
      <details className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2 text-[11px]">
        <summary className="cursor-pointer text-zinc-500">原始响应</summary>
        <div className="mt-1.5">
          <JsonBlock value={response ?? s.last} max={8000} />
        </div>
      </details>
    </div>
  );
}
