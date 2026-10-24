import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { api, type UserPreset } from '../api.ts';
import { useApp } from '../app.tsx';
import { compareHref, navigate, providerHref, useRoute } from '../router.ts';
import { getOperation, getProvider, modelsFor, presetsFor } from '../../shared/catalog.ts';
import { genericInsights, reduceEvents } from '../../shared/protocols.ts';
import { initialParamState, type ParamState } from '../../shared/util.ts';
import type { ConnectionInfo, Insight, ModelDef, OperationDef, ProviderDef } from '../../shared/types.ts';
import {
  Chip,
  COST_LABEL,
  EvidenceChip,
  InsightList,
  JsonBlock,
  Modal,
  Spinner,
  Tabs,
  VerificationChip,
  WORKBENCH_LABEL,
  EmptyHint,
  CopyButton,
} from '../ui.tsx';
import { useRunner } from './useRunner.ts';
import { ParamsPanel, enabledParams } from './params.tsx';
import { RequestPreview, buildPreview } from './preview.tsx';
import { EventList, MetricsPanel } from './inspector.tsx';
import { WORKBENCH_DEFAULTS, WorkbenchInput } from './inputs.tsx';
import { OutputView } from './outputs.tsx';
import { RealtimeLab } from './realtime.tsx';
import type { RemoteModel } from '../../shared/models.ts';
import { validateOperationInput } from '../../shared/validate.ts';
import { usePersistentDraft } from '../workspace-state.ts';
import { configurationSignature } from './input-state.ts';

type Tab = 'output' | 'insights' | 'sent' | 'response' | 'events' | 'extras' | 'metrics';

const remoteModelCache = new Map<string, RemoteModel[]>();
function modelCacheKey(conn: ConnectionInfo | undefined) {
  return conn
    ? JSON.stringify([
        conn.id,
        conn.revision,
        conn.baseUrl,
        conn.keyPreview,
        conn.extra,
        conn.network,
        conn.lastTest?.at,
      ])
    : '';
}

export function useRemoteModels(conn: ConnectionInfo | undefined, provider: ProviderDef | undefined) {
  const cacheKey = modelCacheKey(conn);
  const currentKey = useRef(cacheKey);
  currentKey.current = cacheKey;
  const sequence = useRef(0);
  const [models, setModels] = useState<RemoteModel[] | null>(remoteModelCache.get(cacheKey) ?? null);
  const [error, setError] = useState('');
  const load = useCallback(
    async (refresh = false) => {
      if (!conn || !provider?.modelsPath) return;
      const request = ++sequence.current;
      const key = cacheKey;
      try {
        const r = await api.remoteModels(conn.id, { refresh });
        remoteModelCache.set(key, r.models);
        if (key !== currentKey.current || request !== sequence.current) return;
        setModels(r.models);
        setError('');
      } catch (e: any) {
        if (key !== currentKey.current || request !== sequence.current) return;
        setError(e.message);
      }
    },
    [cacheKey, provider?.modelsPath],
  );
  useEffect(() => {
    setModels(remoteModelCache.get(cacheKey) ?? null);
    setError('');
    if (conn && provider?.modelsPath && !remoteModelCache.has(cacheKey)) void load();
    return () => {
      sequence.current++;
    };
  }, [cacheKey, provider?.modelsPath, load]);
  return { models, error, load };
}

export function ModelPicker({
  op,
  value,
  onChange,
  remote,
  listId,
  disabled = false,
}: {
  op: OperationDef;
  value: string;
  onChange: (v: string) => void;
  remote: RemoteModel[] | null;
  listId: string;
  disabled?: boolean;
}) {
  const catalogModels = modelsFor(op);
  const remoteOnly = (remote ?? []).filter((m) => !catalogModels.some((c) => c.id === m.id));
  if (op.models && op.models.length === 0) return <span className="text-xs text-zinc-500">（该接口不需要模型）</span>;
  return (
    <>
      <input
        className="input mono w-full max-w-full sm:w-64"
        aria-label="模型 ID"
        disabled={disabled}
        list={listId}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="模型 ID"
      />
      <datalist id={listId}>
        {catalogModels.map((m) => (
          <option key={m.id} value={m.id}>
            {m.label && m.label !== m.id ? m.label : ''}
            {m.deprecated ? '（旧）' : ''}
          </option>
        ))}
        {remoteOnly.slice(0, 400).map((m) => (
          <option key={m.id} value={m.id}>
            账号可见
          </option>
        ))}
      </datalist>
    </>
  );
}

export function ModelInfo({ model, remote }: { model?: ModelDef; remote?: RemoteModel | null }) {
  if (!model && !remote) return null;
  return (
    <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-zinc-500">
      {model?.developer && <span>开发方 {model.developer}</span>}
      {model?.context && (
        <Chip>
          上下文{' '}
          {model.context >= 1e6 ? `${(model.context / 1e6).toFixed(1)}M` : `${Math.round(model.context / 1000)}K`}
        </Chip>
      )}
      {(model?.capabilities ?? []).map((c) => (
        <Chip key={c}>{c}</Chip>
      ))}
      {model?.pricing?.text && (
        <span className="max-w-full text-xs leading-relaxed break-words text-amber-300">{model.pricing.text}</span>
      )}
      {model?.pricing && model.pricing.input !== undefined && (
        <Chip tone="yellow" title={`来源：${model.pricing.source ?? '—'}（${model.pricing.date ?? ''}）`}>
          {model.pricing.currency === 'CNY' ? '¥' : '$'}
          {model.pricing.input}/{model.pricing.output ?? '?'} 每百万 Token
        </Chip>
      )}
      {model?.verification && <VerificationChip v={model.verification} />}
      {model?.deprecated && <Chip tone="orange">旧版 / 可能下线</Chip>}
      {remote && (
        <Chip tone="green" title="出现在当前连接的 /models 列表中">
          账号可见
        </Chip>
      )}
      {model?.notes && <span>{model.notes}</span>}
    </div>
  );
}

export function LabPage({
  operationId,
  runId,
  presetId,
}: {
  operationId: string;
  runId?: string | null;
  presetId?: string | null;
}) {
  const route = useRoute();
  const op = getOperation(operationId);
  const provider = getProvider(op?.providerId);
  if (!op || !provider) return <div className="p-10 text-zinc-500">操作不存在：{operationId}</div>;
  if (op.workbench === 'realtime') return <RealtimeLab op={op} provider={provider} runId={runId} presetId={presetId} />;
  return (
    <Lab
      key={`${op.id}:${runId ?? ''}:${presetId ?? ''}:${route.query.get('connection') ?? ''}:${route.query.get('model') ?? ''}`}
      op={op}
      provider={provider}
      runId={runId}
      presetId={presetId}
    />
  );
}

function Lab({
  op,
  provider,
  runId,
  presetId,
}: {
  op: OperationDef;
  provider: ProviderDef;
  runId?: string | null;
  presetId?: string | null;
}) {
  const route = useRoute();
  const { connections, toast, evidence, refreshEvidence } = useApp();
  const ownConnections = useMemo(() => connections.filter((c) => c.providerId === op.providerId), [connections, op]);
  const sessionKey = `lab:${op.id}:${runId ?? ''}:${presetId ?? ''}:${route.query.get('connection') ?? ''}:${route.query.get('model') ?? ''}`;
  const [draft, setDraft, draftControl] = usePersistentDraft(
    sessionKey,
    () => ({
      connectionId: route.query.get('connection') ?? '',
      model: route.query.get('model') ?? op.defaultModel ?? modelsFor(op)[0]?.id ?? '',
      input: structuredClone(WORKBENCH_DEFAULTS[op.workbench] ?? {}) as Record<string, unknown>,
      params: initialParamState(op.params),
    }),
    { title: op.title, href: window.location.hash, operationId: op.id },
  );
  const { connectionId, model, input, params } = draft;
  const setConnectionId = useCallback(
    (value: string) => setDraft((previous) => ({ ...previous, connectionId: value })),
    [setDraft],
  );
  const setModel = useCallback((value: string) => setDraft((previous) => ({ ...previous, model: value })), [setDraft]);
  const setInput: Dispatch<SetStateAction<Record<string, unknown>>> = useCallback(
    (next) =>
      setDraft((previous) => ({
        ...previous,
        input: typeof next === 'function' ? next(previous.input) : next,
      })),
    [setDraft],
  );
  const setParams: Dispatch<SetStateAction<Record<string, ParamState>>> = useCallback(
    (next) =>
      setDraft((previous) => ({
        ...previous,
        params: typeof next === 'function' ? next(previous.params) : next,
      })),
    [setDraft],
  );
  const [tab, setTab] = useState<Tab>('output');
  const [rightTab, setRightTab] = useState<'params' | 'preview'>('params');
  const [userPresets, setUserPresets] = useState<UserPreset[]>([]);
  const [savingPreset, setSavingPreset] = useState(false);
  const [loadedFrom, setLoadedFrom] = useState('');
  const runAgain = useRef(false);
  const previousPreset = useRef<typeof draft | null>(null);
  const runner = useRunner(() => refreshEvidence(), sessionKey);
  const [restoring, setRestoring] = useState(!!(runId || presetId) && !draftControl.restored && !runner.inputSnapshot);
  const outputRef = useRef<HTMLDivElement>(null);

  const conn = ownConnections.find((c) => c.id === connectionId);
  const { models: remoteModels, error: remoteError, load: reloadModels } = useRemoteModels(conn, provider);

  useEffect(() => {
    if (!connectionId && ownConnections.length > 0 && !runId && !restoring) {
      setConnectionId(ownConnections[0].id);
      if (!runId && !presetId && !route.query.has('model') && provider.generic)
        setModel(ownConnections[0].extra.defaultModel ?? '');
    }
  }, [ownConnections, connectionId, runId, restoring]);

  useEffect(() => {
    api
      .presets()
      .then((list) => setUserPresets(list.filter((p) => p.operationId === op.id)))
      .catch(() => {});
  }, [op.id]);

  // Restore from a recorded run or a preset.
  useEffect(() => {
    if (runner.inputSnapshot || (draftControl.restored && !runId)) {
      setRestoring(false);
      return;
    }
    let cancelled = false;
    (async () => {
      if (runId) {
        try {
          const r = await api.run(runId);
          if (cancelled) return;
          if (r.state && !draftControl.restored) {
            setConnectionId(r.state.connectionId);
            setModel(r.state.model);
            setInput({ ...(WORKBENCH_DEFAULTS[op.workbench] ?? {}), ...r.state.input });
            setParams({ ...initialParamState(op.params), ...r.state.params });
          } else if (r.input && !draftControl.restored) {
            setInput({ ...(WORKBENCH_DEFAULTS[op.workbench] ?? {}), ...r.input });
            if (r.model) setModel(r.model);
          }
          runner.load({
            events: r.events ?? [],
            request: r.request,
            response: r.response,
            artifacts: r.artifacts ?? [],
            metrics: r.metrics ?? null,
            error: r.error,
            runId: r.id,
            taskId: r.taskId ?? undefined,
            status: r.status,
            inputSnapshot: {
              connectionId: r.state?.connectionId ?? r.connectionId,
              operationId: op.id,
              model: r.state?.model ?? r.model,
              input: r.state?.input ?? r.input,
              params: r.state?.params,
            },
          });
          setLoadedFrom(
            draftControl.restored
              ? `已恢复编辑草稿，并载入「${r.title}」的历史结果。下方结果保留原调用输入。`
              : `已载入实验记录「${r.title}」的完整参数与结果，可以修改后再次运行。`,
          );
        } catch (e: any) {
          toast(`载入实验记录失败：${e.message}`, 'err');
        }
        if (!cancelled) setRestoring(false);
        return;
      }
      if (presetId) {
        const builtin = presetsFor(op.id).find((p) => p.id === presetId);
        const user = builtin ? undefined : (await api.presets().catch(() => [])).find((p) => p.id === presetId);
        const p = builtin ?? user;
        if (p && !cancelled) applyPreset(p);
        else if (!cancelled) toast('预设不存在或暂时无法载入，请重试。', 'err');
      }
      if (!cancelled) setRestoring(false);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, presetId]);

  function applyPreset(p: { title: string; input: any; params?: any; model?: string | null }, reversible = false) {
    if (reversible) previousPreset.current = structuredClone(draft);
    setInput({ ...(WORKBENCH_DEFAULTS[op.workbench] ?? {}), ...(p.input ?? {}) });
    setParams(initialParamState(op.params, p.params ?? {}));
    if (p.model) setModel(p.model);
    setLoadedFrom(`已载入预设「${p.title}」`);
  }

  const view = useMemo(
    () => runner.view ?? runner.response?.view ?? reduceEvents(op.protocol, runner.events),
    [op.protocol, runner.events, runner.view, runner.response],
  );
  const insights: Insight[] = useMemo(() => {
    if (runner.running || !runner.events.length) return [];
    const ctx = {
      request: runner.request ?? undefined,
      view,
      input: (runner.inputSnapshot?.input ?? input) as Record<string, unknown>,
      model: runner.inputSnapshot?.model ?? model,
    };
    try {
      return [...genericInsights(op.protocol, ctx), ...(op.insights?.(ctx) ?? [])];
    } catch {
      return [];
    }
  }, [runner.running, runner.events.length, runner.request, runner.inputSnapshot, view, op, input, model]);
  const resultInput = (runner.inputSnapshot?.input ?? input) as Record<string, unknown>;
  const resultChanged =
    !!runner.inputSnapshot &&
    configurationSignature(op, { connectionId, model, input, params }, connections) !==
      configurationSignature(
        op,
        {
          connectionId: runner.inputSnapshot.connectionId,
          model: runner.inputSnapshot.model ?? undefined,
          input: runner.inputSnapshot.input as Record<string, unknown>,
          params: runner.inputSnapshot.params,
        },
        connections,
      );
  const preview = useMemo(
    () => buildPreview(op, provider, conn, model, input, params),
    [op, provider, conn, model, input, params],
  );
  const extras = (view as any).extras ?? {};
  const opEvidence = evidence.filter((e) => e.operationId === op.id);
  const modelDef = provider.models.find((m) => m.id === model);
  const remoteHit = remoteModels?.find((m) => m.id === model) ?? null;

  const run = useCallback(
    (confirmCost = false) => {
      if (runner.running || restoring) return;
      if (!conn) {
        toast(`请先添加「${provider.name}」的连接`, 'err');
        return;
      }
      try {
        validateOperationInput(op, { model, input, params, extra: conn?.extra ?? {} });
      } catch (e: any) {
        toast(e.message, 'err');
        return;
      }
      for (const [key, st] of Object.entries(params)) {
        if (!st.enabled || typeof st.value !== 'string') continue;
        if (op.params.find((s) => s.key === key)?.type !== 'json') continue;
        try {
          if (st.value.trim()) JSON.parse(st.value);
        } catch (e: any) {
          toast(`参数 ${key} 不是合法 JSON：${e.message}`, 'err');
          return;
        }
      }
      setTab('output');
      setLoadedFrom('');
      requestAnimationFrame(() => outputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      runner.start({
        connectionId,
        operationId: op.id,
        model,
        title: `${op.title} · ${model || '默认'}`,
        input,
        params,
        confirmCost,
        parentId: runId,
      });
    },
    [connectionId, op, model, input, params, provider.name, runner, toast, conn, runId, restoring],
  );

  useEffect(() => {
    if (runAgain.current) {
      runAgain.current = false;
      run();
    }
  }, [input, run]);

  function appendToConversation(msgs: any[], again: boolean) {
    runAgain.current = again;
    setInput((previous) => {
      const current = ((previous.messages as any[]) ?? []).filter(
        (m, i, arr) => !(i === arr.length - 1 && m.role === 'user' && !m.content && !m.images?.length),
      );
      return { ...previous, prefix: '', messages: [...current, ...msgs] };
    });
    if (!again) toast('已追加到对话，在左侧继续编辑下一轮');
  }

  function goCompare() {
    sessionStorage.setItem('compare-seed', JSON.stringify({ operationId: op.id, connectionId, model, input, params }));
    navigate(compareHref({ from: 'lab' }));
  }
  function goBenchmark() {
    if (!conn) return;
    try {
      const request = op.build({ model, input, params, extra: conn.extra });
      const body = request.body as any;
      sessionStorage.setItem(
        'bench-seed',
        JSON.stringify({
          connectionId: conn.id,
          model,
          path: request.path,
          endpoint: 'chat',
          prompts: [],
          customBody: body,
          stream: request.stream ?? false,
          maxTokens: Math.min(8192, Number(body?.max_completion_tokens ?? body?.max_tokens ?? 128)),
        }),
      );
      navigate('/bench');
    } catch (e: any) {
      toast(e.message, 'err');
    }
  }

  const cost = COST_LABEL[op.costTier] ?? COST_LABEL.low;
  const presets = [...presetsFor(op.id).map((p) => ({ ...p, user: false })), ...userPresets];

  return (
    <div className="mx-auto max-w-[1400px] space-y-3 p-4 pb-24 sm:p-5 xl:pb-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-lg font-semibold text-zinc-100">{op.title}</h1>
            <a href={providerHref(provider.id)}>
              <Chip tone="violet">{provider.name}</Chip>
            </a>
            <Chip>{WORKBENCH_LABEL[op.workbench] ?? op.workbench}</Chip>
            <Chip tone={cost.tone} title={op.costHint}>
              {cost.label}
            </Chip>
            <VerificationChip v={op.verification} />
            <EvidenceChip rows={opEvidence} />
          </div>
          {op.summary && <p className="mt-1 max-w-4xl text-xs leading-relaxed text-zinc-400">{op.summary}</p>}
          <div className="mt-1 flex gap-3 text-[11px]">
            {op.docsUrl && (
              <a className="text-violet-400 underline" href={op.docsUrl} target="_blank" rel="noreferrer">
                官方文档 ↗
              </a>
            )}
            {op.costHint && <span className="text-amber-300/80">💰 {op.costHint}</span>}
          </div>
        </div>
      </header>

      {(op.notes ?? []).length > 0 && (
        <details
          className="rounded-md border border-zinc-800 bg-zinc-900/40 px-3 py-2 text-[11px] text-zinc-400"
          open={op.verification.status !== 'tested'}
        >
          <summary className="cursor-pointer text-zinc-300">使用说明与已知限制（{op.notes!.length}）</summary>
          <ul className="mt-1.5 list-disc space-y-1 pl-5 leading-relaxed">
            {op.notes!.map((n) => (
              <li key={n}>{n}</li>
            ))}
            {op.verification.note && <li className="text-sky-300/80">验证状态：{op.verification.note}</li>}
          </ul>
        </details>
      )}

      <div className="card flex flex-wrap items-center gap-2 p-3">
        <select
          className="input w-full sm:w-56"
          aria-label="实验连接"
          disabled={runner.running || restoring}
          value={connectionId}
          onChange={(e) => {
            setConnectionId(e.target.value);
            if (provider.generic)
              setModel(ownConnections.find((c) => c.id === e.target.value)?.extra.defaultModel ?? '');
          }}
        >
          {ownConnections.length === 0 && <option value="">（没有 {provider.name} 的连接）</option>}
          {connectionId && !conn && ownConnections.length > 0 && (
            <option value={connectionId}>原连接已失效，请重新选择账户</option>
          )}
          {ownConnections.map((c) => (
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
          listId={`models-${op.id}`}
          disabled={runner.running || restoring}
        />
        {provider.modelsPath && conn && (
          <button
            className="btn-ghost px-2 text-xs"
            title={remoteError || '从厂商 /models 接口刷新账号可见的模型'}
            onClick={() => reloadModels(true)}
          >
            {remoteModels ? `账号模型 ${remoteModels.length}` : remoteError ? '模型列表失败' : '加载账号模型'}
          </button>
        )}
        {presets.length > 0 && (
          <select
            className="input w-48"
            disabled={runner.running || restoring}
            aria-label="载入实验预设"
            value=""
            onChange={(e) =>
              e.target.value &&
              applyPreset(
                presets.find((p) => p.id === e.target.value)!,
                true,
              )
            }
          >
            <option value="">载入预设（{presets.length}）…</option>
            {presets.map((p) => (
              <option key={p.id} value={p.id}>
                {p.user ? '★ ' : ''}
                {p.title}
              </option>
            ))}
          </select>
        )}
        <span className="flex-1" />
        <button className="btn-ghost text-xs" disabled={restoring} onClick={() => setSavingPreset(true)}>
          保存为预设
        </button>
        <button className="btn-outline text-xs" onClick={goCompare} title="把当前配置复制成多条通道，并排运行比较">
          ⚖️ 加入对比
        </button>
        {op.protocol === 'openai-chat' && (
          <button className="btn-outline text-xs" disabled={!conn || runner.running} onClick={goBenchmark}>
            性能评测 →
          </button>
        )}
        {runner.running && (
          <button className="btn-outline" onClick={runner.abort}>
            中止
          </button>
        )}
        <button className="btn-primary" onClick={() => run(false)} disabled={runner.running || !conn || restoring}>
          {runner.running ? <Spinner /> : '▶ 运行'}
        </button>
      </div>
      <p className="text-[11px] text-zinc-500" role="status">
        {restoring
          ? '正在恢复实验配置，请稍候…'
          : draftControl.restored
            ? '已恢复本页草稿，输入会在此浏览器标签页中自动保留。'
            : '输入会自动保留；切换页面时，正在运行的请求继续执行。'}
      </p>
      {connectionId && !conn && (
        <div role="alert" className="rounded-lg border border-amber-800/60 bg-amber-950/20 p-3 text-xs text-amber-200">
          原实验使用的连接已不存在。请在上方明确选择一个账户后再运行，当前不会自动更换账户。
        </div>
      )}

      {conn?.extra.sourceNotes && (
        <p className="rounded-lg border border-amber-900/50 bg-amber-950/10 p-3 text-xs leading-relaxed text-amber-200">
          连接资料备注（未在本次导入中复核）：{conn.extra.sourceNotes}
        </p>
      )}

      <ModelInfo model={modelDef} remote={remoteHit} />

      {ownConnections.length === 0 && (
        <div className="rounded-md border border-amber-800/60 bg-amber-950/30 p-3 text-xs text-amber-200">
          还没有「{provider.name}」的连接。
          <a
            className="ml-1 underline"
            href={`#/connections?provider=${encodeURIComponent(provider.id)}&returnTo=${encodeURIComponent(window.location.hash)}`}
          >
            去添加 API Key
          </a>
          {provider.consoleUrl && (
            <>
              {' '}
              ·{' '}
              <a className="underline" href={provider.consoleUrl} target="_blank" rel="noreferrer">
                去厂商控制台创建 Key ↗
              </a>
            </>
          )}
        </div>
      )}
      {loadedFrom && (
        <div className="rounded-md border border-sky-900/60 bg-sky-950/20 px-3 py-2 text-xs text-sky-200">
          {loadedFrom}
          {previousPreset.current && (
            <button
              className="btn-ghost ml-2 text-xs"
              onClick={() => {
                setDraft(previousPreset.current!);
                previousPreset.current = null;
                setLoadedFrom('已撤销预设载入，恢复之前的输入。');
              }}
            >
              撤销载入
            </button>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <div className="card p-4">
          <h2 className="label mb-3">输入</h2>
          <fieldset disabled={runner.running || restoring}>
            <WorkbenchInput op={op} input={input} setInput={setInput} />
          </fieldset>
        </div>
        <div className="card">
          <Tabs
            tabs={[
              ['params', `原生参数（${Object.values(params).filter((p) => p.enabled).length} 个启用）`],
              ['preview', '请求预览'],
            ]}
            value={rightTab}
            onChange={setRightTab}
          />
          <div className="max-h-[640px] overflow-auto p-4">
            {rightTab === 'params' ? (
              <>
                <p className="mb-3 text-[11px] text-zinc-600">
                  勾选后才会随请求发出；未勾选的参数完全不出现在请求体里，由厂商使用默认值。
                </p>
                <fieldset disabled={runner.running || restoring}>
                  <ParamsPanel specs={op.params} state={params} setState={setParams} model={model} />
                </fieldset>
              </>
            ) : (
              <RequestPreview preview={preview} />
            )}
          </div>
        </div>
      </div>

      <div className="card scroll-mt-20" ref={outputRef}>
        {resultChanged && (
          <p role="status" className="border-b border-amber-900/60 bg-amber-950/20 px-4 py-3 text-xs text-amber-200">
            当前输入或参数已修改，尚未运行。下方仍显示上一次调用的结果与原始输入。
          </p>
        )}
        <Tabs
          tabs={[
            ['output', '结果'],
            ['insights', `洞察${insights.length ? ` (${insights.length})` : ''}`],
            ['sent', '已发送请求'],
            ['response', '原始响应'],
            ['events', `事件流 (${runner.events.length})`],
            ['extras', `原生字段${Object.keys(extras).length ? ` (${Object.keys(extras).length})` : ''}`],
            ['metrics', '指标与费用'],
          ]}
          value={tab}
          onChange={setTab}
        />
        <div className="p-4">
          {tab === 'output' && (
            <>
              <OutputView
                key={`${runner.executionId ?? ''}:${runner.runId ?? ''}`}
                resultKey={`${runner.executionId ?? ''}:${runner.runId ?? ''}`}
                op={op}
                input={resultInput}
                view={view}
                response={runner.response}
                artifacts={runner.artifacts}
                running={runner.running}
                error={runner.error}
                taskId={runner.taskId}
                hasEvents={runner.events.length > 0}
                onAppend={op.workbench === 'chat' && !resultChanged ? appendToConversation : undefined}
              />
              {insights.length > 0 && (
                <div className="mt-4 rounded-md border border-zinc-800 bg-zinc-950/30 p-3">
                  <InsightList items={insights} />
                </div>
              )}
              {runner.runId && !runner.running && (
                <p className="mt-3 text-[11px] text-zinc-600">
                  已保存为实验记录{' '}
                  <a className="text-violet-400 underline" href={`#/runs/${runner.runId}`}>
                    {runner.runId}
                  </a>
                </p>
              )}
            </>
          )}
          {tab === 'insights' && <InsightList items={insights} />}
          {tab === 'sent' &&
            (runner.request ? (
              <div className="space-y-2">
                <div className="flex justify-end">
                  <CopyButton text={JSON.stringify(runner.request?.body ?? {}, null, 2)} label="复制请求体（已脱敏）" />
                </div>
                <JsonBlock value={runner.request} />
              </div>
            ) : (
              <EmptyHint>运行后显示实际发出的请求（密钥已隐藏）。发送前的实时预览在右上角「请求预览」。</EmptyHint>
            ))}
          {tab === 'response' &&
            (runner.response ? (
              <JsonBlock value={runner.response} />
            ) : (
              <EmptyHint>
                {runner.events.length > 0
                  ? '流式响应请查看「事件流」，汇总后的厂商特有字段在「原生字段」'
                  : '运行后显示原始响应'}
              </EmptyHint>
            ))}
          {tab === 'events' && <EventList events={runner.events} />}
          {tab === 'extras' &&
            (Object.keys(extras).length ? (
              <div className="space-y-2">
                <p className="text-[11px] text-zinc-500">
                  以下是厂商返回、但不属于通用视图（正文 / 思考 / 工具 / 用量）的字段，原样保留：
                </p>
                <JsonBlock value={extras} />
              </div>
            ) : (
              <EmptyHint>这次响应没有通用格式之外的字段</EmptyHint>
            ))}
          {tab === 'metrics' && <MetricsPanel metrics={runner.metrics} view={view} />}
        </div>
      </div>
      <div className="lab-mobile-controls fixed right-0 bottom-0 left-0 z-20 flex items-center gap-2 border-t border-zinc-700 bg-zinc-950/95 p-3 backdrop-blur md:left-60 xl:hidden">
        <button
          className="btn-outline flex-1"
          onClick={() => outputRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })}
        >
          查看结果{runner.running ? ' · 运行中' : ''}
        </button>
        {runner.running ? (
          <button className="btn-danger flex-1" onClick={runner.abort}>
            停止本次调用
          </button>
        ) : (
          <button className="btn-primary flex-1" disabled={!conn || restoring} onClick={() => run(false)}>
            运行实验
          </button>
        )}
      </div>

      {runner.costPrompt && (
        <Modal title="确认费用" onClose={runner.clearCostPrompt}>
          <p className="text-sm text-zinc-300">这个操作可能产生较高费用。</p>
          <p className="mt-2 text-xs leading-relaxed text-amber-200/90">{op.costHint ?? '请确认后再执行。'}</p>
          <div className="mt-4 flex justify-end gap-2">
            <button className="btn-ghost" onClick={runner.clearCostPrompt}>
              取消
            </button>
            <button
              className="btn-primary"
              onClick={() => {
                runner.clearCostPrompt();
                run(true);
              }}
            >
              确认并运行
            </button>
          </div>
        </Modal>
      )}
      {savingPreset && (
        <SavePresetModal
          onClose={() => setSavingPreset(false)}
          onSave={async (title, description) => {
            await api.savePreset({
              operationId: op.id,
              title,
              description,
              model,
              input,
              params: enabledParams(params),
            });
            setUserPresets(await api.presets().then((l) => l.filter((p) => p.operationId === op.id)));
            setSavingPreset(false);
            toast('已保存为预设');
          }}
        />
      )}
    </div>
  );
}

function SavePresetModal({
  onClose,
  onSave,
}: {
  onClose: () => void;
  onSave: (title: string, description: string) => Promise<void>;
}) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const saving = useRef(false);
  return (
    <Modal
      title="保存为预设"
      onClose={() => {
        if (!saving.current) onClose();
      }}
    >
      <div className="space-y-3">
        <input
          className="input"
          placeholder="标题"
          aria-label="预设标题"
          disabled={busy}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          autoFocus
        />
        <textarea
          className="input min-h-16"
          placeholder="说明（可选）"
          aria-label="预设说明"
          disabled={busy}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
        <p className="text-[11px] text-zinc-500">保存当前输入、模型与已启用的参数（不含连接与密钥）。</p>
        {error && (
          <p role="alert" className="text-xs text-rose-300">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2">
          <button className="btn-ghost" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button
            className="btn-primary"
            disabled={!title.trim() || busy}
            onClick={async () => {
              if (saving.current) return;
              saving.current = true;
              setBusy(true);
              setError('');
              try {
                await onSave(title.trim(), description.trim());
              } catch (failure: any) {
                setError(`保存失败：${failure.message}。输入已保留，可以重试。`);
              } finally {
                saving.current = false;
                setBusy(false);
              }
            }}
          >
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
