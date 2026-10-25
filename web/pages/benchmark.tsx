import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Activity, ArrowDownToLine, Gauge, Play, Square, Upload, RefreshCw } from 'lucide-react';
import { getProvider, listOperations } from '../../shared/catalog.ts';
import { benchLimits } from '../../shared/bench.ts';
import { auditBenchmarkComparison } from '../../shared/comparison.ts';
import { usePersistentDraft } from '../workspace-state.ts';
import { useApp } from '../app.tsx';
import { benchApi } from '../bench-api.ts';
import { navigate } from '../router.ts';
import { useRemoteModels } from '../lab/remote-models.ts';
import { Page } from './common.tsx';
import { CodeInput, EmptyHint, Field, JsonBlock, Modal, Spinner, Tabs, fmtTime } from '../ui.tsx';

const MODE_LABEL: Record<string, string> = {
  total: '固定请求数',
  duration: '固定时长',
  rps: '固定 RPS',
  sweep: '并发扫描',
};
const STATUS_LABEL: Record<string, string> = {
  running: '运行中',
  starting: '准备中',
  queued: '排队中',
  completed: '已完成',
  succeeded: '已完成',
  cancelled: '已停止',
  interrupted: '服务重启中断',
  error: '失败',
  failed: '失败',
  stopping: '正在停止',
  cancelling: '正在停止',
  imported: '导入记录',
};
const active = (r: any) => ['starting', 'queued', 'running', 'stopping', 'cancelling'].includes(r?.status);
const number = (v: unknown, digits = 1) =>
  typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString('zh-CN', { maximumFractionDigits: digits }) : '—';
const statKeys = [
  'requests_total',
  'requests_success',
  'requests_failed',
  'success_rate_pct',
  'throughput_rps',
  'latency_ms_p50',
  'latency_ms_p95',
  'latency_ms_p99',
  'ttft_ms_p50',
  'tpot_ms_p50',
  'itl_ms_p50',
  'throughput_completion_tok_s',
  'rps_schedule_skipped',
  'http_attempts_total',
];
const METRIC_LABEL: Record<string, string> = {
  requests_total: '已完成逻辑请求',
  requests_success: '成功请求',
  requests_failed: '失败请求',
  success_rate_pct: '成功率 %',
  throughput_rps: '成功吞吐 req/s',
  latency_ms_p50: 'P50 延迟 ms',
  latency_ms_p95: 'P95 延迟 ms',
  latency_ms_p99: 'P99 延迟 ms',
  ttft_ms_p50: 'P50 首内容 TTFT ms',
  tpot_ms_p50: 'P50 TPOT ms',
  itl_ms_p50: 'P50 内容块间隔 ms',
  throughput_completion_tok_s: '输出吞吐 tok/s',
  rps_schedule_skipped: '因并发满载跳过的计划请求',
  http_attempts_total: 'HTTP 尝试（不含预热）',
};

function initialConfig() {
  return {
    connectionId: '',
    model: '',
    endpoint: 'chat',
    path: '',
    mode: 'total',
    totalRequests: 5,
    durationSeconds: 10,
    targetRps: 1,
    concurrency: 1,
    sweepConcurrency: [1, 2, 4],
    warmup: 0,
    retries429: 0,
    retriesNetwork: 0,
    retries5xx: 0,
    timeoutSeconds: 30,
    maxTokens: 128,
    temperature: 0.2,
    stream: true,
    http2: false,
    prompts: ['用一句话解释什么是原生 API。'],
    promptStrategy: 'sequential',
    promptWeights: [] as number[],
  };
}

export function BenchmarkPage() {
  const { connections, toast } = useApp();
  const [config, setConfig] = usePersistentDraft<any>('bench:config', initialConfig, {
    title: '性能评测配置',
    href: '#/bench',
  });
  const [prompts, setPrompts] = usePersistentDraft('bench:prompts', initialConfig().prompts.join('\n'), {
    hidden: true,
  });
  const [sweep, setSweep] = usePersistentDraft('bench:sweep', '1,2,4', { hidden: true });
  const [weights, setWeights] = usePersistentDraft('bench:weights', '', { hidden: true });
  const [bodyDraft, setBodyDraft] = usePersistentDraft(
    'bench:body-editors',
    { body: '{}', customBody: '' },
    { hidden: true },
  );
  const extra = bodyDraft.body;
  const custom = bodyDraft.customBody;
  const setExtra = (body: string) => setBodyDraft((v) => ({ ...v, body }));
  const setCustom = (customBody: string) => setBodyDraft((v) => ({ ...v, customBody }));
  const [runtime, setRuntime] = useState<any>(null);
  const [records, setRecords] = useState<any[]>([]);
  const [selected, setSelected] = useState<any>(null);
  const [selectedId, setSelectedId] = usePersistentDraft('bench:selected', '', { hidden: true });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<any>(null);
  const [tab, setTab] = usePersistentDraft('bench:tab', 'monitor', { hidden: true });
  const [sample, setSample] = useState<number | null>(null);
  const [compared, setCompared] = usePersistentDraft<string[]>('bench:compared', [], { hidden: true });
  const [comparisonStages, setComparisonStages] = usePersistentDraft<Record<string, number>>(
    'bench:comparison-stages',
    {},
    { hidden: true },
  );
  const [comparisons, setComparisons] = useState<any[]>([]);
  const [stageIndex, setStageIndex] = useState(0);
  const [hasMore, setHasMore] = useState(true);
  const [removing, setRemoving] = useState<any>(null);
  const [deleting, setDeleting] = useState(false);
  const startLock = useRef(false);
  const importInput = useRef<HTMLInputElement>(null);
  const compatible = connections.filter((c) => {
    const provider = getProvider(c.providerId);
    if (!provider || provider.auth.type === 'signer') return false;
    return listOperations(c.providerId).some(
      (op) => op.protocol === 'openai-chat' || op.protocol === 'openai-responses',
    );
  });
  const conn = connections.find((c) => c.id === config.connectionId);
  const provider = conn ? getProvider(conn.providerId) : undefined;
  const remote = useRemoteModels(conn, provider);
  const [modelRefreshing, setModelRefreshing] = useState(false);
  const allowChat = !conn || conn.providerId !== 'openai';
  const allowResponses = !conn || conn.providerId === 'openai' || !!provider?.generic;
  const allowedEndpoints = [...(allowChat ? ['chat'] : []), ...(allowResponses ? ['responses'] : [])];
  const catalogModels = provider?.models ?? [];
  const recentModels = records
    .filter((r) => r?.config?.connectionId === config.connectionId && typeof r.config.model === 'string')
    .map((r) => r.config.model as string);
  const modelOptions = [
    ...new Set(
      [
        conn?.extra.defaultModel,
        ...catalogModels.map((m) => m.id),
        ...(remote.models ?? []).map((m) => m.id),
        ...recentModels,
      ].filter((id): id is string => typeof id === 'string' && !!id.trim()),
    ),
  ].slice(0, 400);
  const modelLabels = new Map<string, string>();
  if (conn?.extra.defaultModel) modelLabels.set(conn.extra.defaultModel, '连接默认模型');
  for (const m of catalogModels) if (m.label && m.label !== m.id) modelLabels.set(m.id, m.label);
  for (const m of remote.models ?? []) if (m.name && m.name !== m.id) modelLabels.set(m.id, m.name);
  const modelHint = !conn
    ? '选择连接后读取账号模型，也可直接输入模型 ID。'
    : provider?.modelsPath
      ? '从当前连接的 /models 读取；也可直接输入模型 ID。'
      : '该连接没有模型目录，可直接输入模型 ID。';
  const patch = (key: string, value: unknown) => setConfig((v: any) => ({ ...v, [key]: value }));

  useEffect(() => {
    if (conn && !allowedEndpoints.includes(config.endpoint))
      setConfig((v: any) => ({ ...v, endpoint: allowedEndpoints[0] ?? 'chat', path: '' }));
  }, [conn?.id, allowedEndpoints.join(','), config.endpoint, setConfig]);

  async function refreshModels() {
    if (modelRefreshing) return;
    setModelRefreshing(true);
    try {
      await remote.load(true);
    } finally {
      setModelRefreshing(false);
    }
  }

  useEffect(() => {
    let disposed = false;
    Promise.all([benchApi.runtime(), benchApi.list()])
      .then(([rt, rs]) => {
        if (disposed) return;
        setRuntime(rt);
        setRecords(rs);
        setHasMore(rs.length === 50);
        const running = rs.find(active);
        if (running && !selectedId) setSelectedId(running.id);
      })
      .catch((e) => {
        if (!disposed) setError(e.message);
      });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    try {
      const value = sessionStorage.getItem('bench-seed');
      if (!value) return;
      sessionStorage.removeItem('bench-seed');
      const seed = JSON.parse(value);
      if (seed && typeof seed === 'object' && typeof seed.connectionId === 'string') loadConfig(seed);
    } catch {
      setError('无法读取实验台的评测配置，请重新载入。');
    }
  }, []);

  useEffect(() => {
    if (!selectedId) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    async function load() {
      try {
        const r = await benchApi.get(selectedId);
        if (disposed) return;
        setSelected(r);
        setError('');
        if (active(r)) timer = setTimeout(load, 1000);
        else
          setRecords((previous) =>
            previous.map((item) =>
              item.id === r.id ? { ...r, stages: r.stages.map((stage: any) => ({ ...stage, results: [] })) } : item,
            ),
          );
      } catch (e: any) {
        if (!disposed) {
          setError(e.message);
          if (e.status === 404) {
            setSelectedId('');
            setSelected(null);
          } else timer = setTimeout(load, 3000);
        }
      }
    }
    void load();
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [selectedId]);

  // A background run remains observable even while an older record is selected.
  const backgroundRunning = records.some(active);
  useEffect(() => {
    if (!backgroundRunning) return;
    let disposed = false;
    const timer = setInterval(() => {
      benchApi
        .list()
        .then((fresh) => {
          if (!disposed)
            setRecords((old) => [...fresh, ...old.filter((item) => !fresh.some((r: any) => r.id === item.id))]);
        })
        .catch(() => {
          /* selected record polling or manual refresh displays connection errors */
        });
    }, 2000);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [backgroundRunning]);

  useEffect(() => {
    let disposed = false;
    Promise.all(compared.map((id) => benchApi.get(id)))
      .then((rs) => {
        if (!disposed) setComparisons(rs);
      })
      .catch((e) => toast(e.message, 'err'));
    return () => {
      disposed = true;
    };
  }, [compared.join(',')]);

  function chooseConnection(id: string) {
    const c = connections.find((c) => c.id === id);
    const nextProvider = getProvider(c?.providerId);
    const nextAllowChat = !c || c.providerId !== 'openai';
    const nextAllowResponses = !c || c.providerId === 'openai' || !!nextProvider?.generic;
    const nextEndpoints = [...(nextAllowChat ? ['chat'] : []), ...(nextAllowResponses ? ['responses'] : [])];
    setConfig((v: any) => ({
      ...v,
      connectionId: id,
      model: c?.extra.defaultModel || nextProvider?.models[0]?.id || '',
      endpoint: nextEndpoints.includes(v.endpoint) ? v.endpoint : (nextEndpoints[0] ?? 'chat'),
      path: '',
    }));
  }
  function loadConfig(c: any) {
    const merged = { ...initialConfig(), ...c };
    merged.prompts = Array.isArray(c?.prompts)
      ? c.prompts.filter((p: unknown) => typeof p === 'string')
      : initialConfig().prompts;
    merged.sweepConcurrency = Array.isArray(c?.sweepConcurrency)
      ? c.sweepConcurrency.filter((p: unknown) => typeof p === 'number' && Number.isFinite(p))
      : [1, 2, 4];
    merged.promptWeights = Array.isArray(c?.promptWeights)
      ? c.promptWeights.filter((p: unknown) => typeof p === 'number')
      : [];
    if (!Object.hasOwn(MODE_LABEL, merged.mode)) merged.mode = 'total';
    delete merged.confirmedCost;
    delete merged.clientRequestId;
    setConfig(merged);
    setPrompts((merged.prompts ?? []).join('\n'));
    setSweep((merged.sweepConcurrency ?? [1, 2, 4]).join(','));
    setWeights((merged.promptWeights ?? []).join(','));
    setExtra(JSON.stringify(merged.extraBody ?? {}, null, 2));
    setCustom(merged.customBody ? JSON.stringify(merged.customBody, null, 2) : '');
    setTab('monitor');
    toast('已载入配置，尚未发起请求；请确认当前账户和模型');
  }
  function prepare() {
    try {
      if (!conn) throw new Error('先选择可用的 Chat Completions / Responses 连接');
      if (!config.model.trim()) throw new Error('请填写模型 ID');
      const ranges = [
        ['concurrency', 1, 64, true],
        ['totalRequests', 1, 10000, true],
        ['durationSeconds', 0.1, 600, false],
        ['targetRps', 0.01, 100, false],
        ['warmup', 0, 100, true],
        ['timeoutSeconds', 0.1, 300, false],
        ['maxTokens', 1, 32768, true],
        ['temperature', 0, 2, false],
        ['retries429', 0, 3, true],
        ['retriesNetwork', 0, 3, true],
        ['retries5xx', 0, 3, true],
      ] as const;
      for (const [key, min, max, integer] of ranges) {
        const value = config[key];
        if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value)))
          throw new Error(
            `请检查${({ concurrency: '并发', totalRequests: '请求数', durationSeconds: '持续秒数', targetRps: '目标 RPS', warmup: '预热', timeoutSeconds: '超时', maxTokens: '输出上限', temperature: '温度', retries429: '429 重试', retriesNetwork: '网络重试', retries5xx: '5xx 重试' } as Record<string, string>)[key]}：须为 ${min}–${max} 范围内的${integer ? '整数' : '数值'}`,
          );
      }
      const ps = prompts
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
      if (!ps.length && !custom.trim()) throw new Error('至少填写一条提示词，或提供完整自定义请求体');
      const extraBody = JSON.parse(extra || '{}');
      const customBody = custom.trim() ? JSON.parse(custom) : undefined;
      for (const b of [extraBody, customBody])
        if (b !== undefined && (!b || Array.isArray(b) || typeof b !== 'object'))
          throw new Error('请求体必须是 JSON 对象');
      const levels = [
        ...new Set(
          sweep
            .split(/[,，\s]+/)
            .filter(Boolean)
            .map(Number),
        ),
      ];
      if (
        config.mode === 'sweep' &&
        (!levels.length || levels.length > 8 || levels.some((n) => !Number.isInteger(n) || n < 1 || n > 64))
      )
        throw new Error('并发档位需要 1–8 个档，每档为 1–64 的整数');
      if (ps.length > 100 || ps.some((p) => p.length > 32000))
        throw new Error('提示词最多 100 条，每条最多 32000 字符');
      if ([extraBody, customBody].some((b) => b && JSON.stringify(b).length > 64000))
        throw new Error('请求体 JSON 最多 64 KB');
      const stages = config.mode === 'sweep' ? levels.length : 1;
      const count = config.totalRequests * stages;
      const attempts =
        (count + config.warmup * stages) * (1 + config.retries429 + config.retriesNetwork + config.retries5xx);
      if (['total', 'sweep'].includes(config.mode) && (count > 10000 || attempts > 20000))
        throw new Error('本轮最多 10000 个逻辑请求、20000 次 HTTP 尝试，请降低请求数、档位或重试');
      if (config.mode === 'rps' && config.targetRps * config.durationSeconds > 10000)
        throw new Error('目标 RPS × 秒数不能超过 10000');
      const ws = weights
        .split(/[,，\s]+/)
        .filter(Boolean)
        .map(Number);
      if (
        config.promptStrategy === 'weighted' &&
        (ws.length !== ps.length || ws.some((n) => !Number.isFinite(n) || n <= 0))
      )
        throw new Error('权重数量须与提示词相同，且全部大于零');
      setPending({
        ...config,
        path: config.path?.trim() || undefined,
        model: config.model.trim(),
        prompts: ps,
        sweepConcurrency: levels,
        promptWeights: config.promptStrategy === 'weighted' ? ws : undefined,
        extraBody,
        customBody,
        confirmedCost: true,
        clientRequestId: crypto.randomUUID(),
      });
      setError('');
    } catch (e: any) {
      setError(e.message);
    }
  }
  async function launch() {
    if (!pending || startLock.current) return;
    startLock.current = true;
    setBusy(true);
    const snapshot = pending;
    setPending(null);
    try {
      const r = await benchApi.start(snapshot);
      setSelected(r);
      setSelectedId(r.id);
      setStageIndex(0);
      setSample(null);
      setTab('monitor');
      setRecords(await benchApi.list());
    } catch (e: any) {
      setError(`${e.message}。若启动结果未确认，请重试本次配置；沿用同一启动标识可避免重复启动。`);
      setPending(snapshot);
    } finally {
      startLock.current = false;
      setBusy(false);
    }
  }
  async function importFile(file: File) {
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('导入文件不能超过 20 MB');
      const imported = await benchApi.import(JSON.parse(await file.text()));
      setRecords(await benchApi.list());
      setHasMore(true);
      setSelectedId(imported.id);
      setStageIndex(0);
      setTab('monitor');
      toast('已导入脱敏历史；不会执行文件中的请求或代码');
    } catch (e: any) {
      toast(e.message, 'err');
    }
  }

  const stages = selected?.stages ?? [];
  const stage = stages[Math.min(stageIndex, Math.max(0, stages.length - 1))];
  const progress = selected?.progress;
  useEffect(() => {
    if (active(selected) && progress?.stage) {
      setStageIndex(progress.stage - 1);
      setSample(null);
    }
  }, [selectedId, progress?.stage]);
  const stageOptions = stages.map((s: any) => ({ concurrency: s.concurrency }));
  if (active(selected) && progress?.stage > stageOptions.length)
    stageOptions.push({ concurrency: progress.concurrency });
  const stats =
    active(selected) && progress?.stage === stageIndex + 1
      ? (progress.stats ?? {})
      : (stage?.stats ?? progress?.stats ?? {});
  const rows = stage?.results ?? [];
  const running = records.some(active) || active(selected);
  const comparedEntries = comparisons.map((record) => ({
    record,
    stageIndex: Math.min(comparisonStages[record.id] ?? 0, Math.max(0, record.stages.length - 1)),
  }));
  const comparisonAudit = auditBenchmarkComparison(comparedEntries);

  return (
    <Page
      title="性能评测"
      description="从一个原生实验，走向可复现的性能观察。使用 LLM Bench 引擎，保留逻辑请求、HTTP 尝试、流式时延与失败的不同口径。"
      actions={
        <span className="chip border-sky-800 text-sky-300">
          <Gauge size={13} /> LLM Bench
        </span>
      }
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            ['monitor', '控制与监看'],
            ['history', `评测记录 (${records.length})`],
            ['compare', `结果对照 (${compared.length})`],
          ]}
        />
        <div className="flex gap-2">
          <button
            className="btn-ghost text-xs"
            onClick={async () => {
              try {
                const [rt, rs] = await Promise.all([benchApi.runtime(), benchApi.list()]);
                setRuntime(rt);
                setRecords(rs);
                setHasMore(rs.length === 50);
                setError('');
              } catch (e: any) {
                setError(e.message);
              }
            }}
          >
            <RefreshCw size={14} />
            刷新
          </button>
          <button className="btn-outline text-xs" onClick={() => importInput.current?.click()}>
            <Upload size={14} />
            导入 JSON
          </button>
          <input
            className="hidden"
            type="file"
            accept=".json,application/json"
            ref={importInput}
            onChange={(e) => {
              if (e.target.files?.[0]) void importFile(e.target.files[0]);
              e.target.value = '';
            }}
          />
        </div>
      </div>
      {error && (
        <div role="alert" className="rounded-lg border border-rose-900 bg-rose-950/25 p-4 text-sm text-rose-200">
          {error}
        </div>
      )}
      {runtime && (
        <div
          className={`rounded-lg border px-4 py-3 text-xs ${runtime.available ? 'border-emerald-900/70 text-emerald-300' : 'border-amber-900 text-amber-200'}`}
        >
          {runtime.available ? '● 评测引擎已就绪' : '评测引擎尚未就绪'} ·{' '}
          {runtime.message ?? runtime.version ?? runtime.error ?? '本机 Python'}
          {!runtime.available && (
            <p className="mt-2">
              在项目目录运行 <code className="mono">npm run setup:bench</code> 后刷新。浏览能力与已有记录不需要 Python。
            </p>
          )}
        </div>
      )}

      {tab === 'monitor' && (
        <div className="grid min-w-0 items-start gap-5 xl:grid-cols-[minmax(330px,0.85fr)_minmax(0,1.4fr)]">
          <section className="card min-w-0 space-y-4 p-5">
            <div>
              <p className="text-xs tracking-[0.2em] text-sky-400">CONTROL</p>
              <h2 className="mt-1 text-lg font-semibold">配置评测</h2>
            </div>
            <Field label="账户与端点">
              <select className="input" value={config.connectionId} onChange={(e) => chooseConnection(e.target.value)}>
                <option value="">选择兼容协议连接</option>
                {compatible.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} · {getProvider(c.providerId)?.name}
                  </option>
                ))}
              </select>
            </Field>
            {conn && <p className="mono break-all text-xs text-zinc-400">{conn.baseUrl}</p>}
            {config.connectionId && !conn && (
              <p className="text-xs text-amber-200">草稿中的连接已失效，请重新选择账户后再运行。</p>
            )}
            {!compatible.length && (
              <EmptyHint>
                先到{' '}
                <a href="#/connections" className="text-sky-300">
                  连接与 Key
                </a>{' '}
                添加 Chat Completions / Responses 兼容连接。
              </EmptyHint>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="模型 ID" hint={modelHint}>
                <div className="flex gap-2">
                  <input
                    className="input mono min-w-0 flex-1"
                    value={config.model}
                    onChange={(e) => patch('model', e.target.value)}
                    list="bench-models"
                    placeholder="选择或输入模型 ID"
                    aria-label="模型 ID"
                  />
                  {conn && provider?.modelsPath && (
                    <button
                      type="button"
                      className="btn-ghost shrink-0 px-2 text-xs"
                      disabled={modelRefreshing}
                      onClick={() => void refreshModels()}
                      title="从当前连接的 /models 刷新模型列表"
                      aria-label="刷新账号模型"
                    >
                      {modelRefreshing ? <Spinner /> : <RefreshCw size={14} />}
                      刷新
                    </button>
                  )}
                </div>
                {conn && provider?.modelsPath && !remote.models && !remote.error && (
                  <p className="mt-1 text-xs text-zinc-400">正在读取账号模型…</p>
                )}
                {conn && remote.error && (
                  <p className="mt-1 text-xs text-amber-300">模型列表加载失败：{remote.error}；仍可手动输入。</p>
                )}
                {remote.models && (
                  <p className="mt-1 text-xs text-zinc-400">
                    {remote.models.length
                      ? `账号可见 ${remote.models.length} 个模型，点击输入框选择。`
                      : '账号模型列表为空，可手动输入。'}
                  </p>
                )}
                <datalist id="bench-models">
                  {modelOptions.map((id) => (
                    <option key={id} value={id}>
                      {modelLabels.get(id) ?? ''}
                    </option>
                  ))}
                </datalist>
              </Field>
              <Field label="协议">
                <select
                  className="input"
                  value={config.endpoint}
                  onChange={(e) => setConfig((v: any) => ({ ...v, endpoint: e.target.value, path: '' }))}
                >
                  {allowChat && <option value="chat">Chat Completions</option>}
                  {allowResponses && <option value="responses">Responses</option>}
                </select>
              </Field>
            </div>
            <Field label="模式">
              <select className="input" value={config.mode} onChange={(e) => patch('mode', e.target.value)}>
                {Object.entries(MODE_LABEL).map(([v, label]) => (
                  <option key={v} value={v}>
                    {label}
                  </option>
                ))}
              </select>
            </Field>
            <div className="grid grid-cols-2 gap-3">
              {['total', 'sweep'].includes(config.mode) ? (
                <Numeric
                  label={config.mode === 'sweep' ? '每档逻辑请求数' : '逻辑请求总数'}
                  value={config.totalRequests}
                  min={1}
                  max={10000}
                  onChange={(v) => patch('totalRequests', v)}
                />
              ) : (
                <Numeric
                  label="持续秒数"
                  value={config.durationSeconds}
                  min={0.1}
                  max={600}
                  step={0.1}
                  onChange={(v) => patch('durationSeconds', v)}
                />
              )}
              {config.mode !== 'sweep' && (
                <Numeric
                  label="最大在飞并发"
                  value={config.concurrency}
                  min={1}
                  max={64}
                  onChange={(v) => patch('concurrency', v)}
                />
              )}
              {config.mode === 'rps' && (
                <Numeric
                  label="目标请求 / 秒"
                  value={config.targetRps}
                  min={0.01}
                  max={100}
                  step={0.01}
                  onChange={(v) => patch('targetRps', v)}
                />
              )}
              <Numeric
                label="每请求输出上限"
                value={config.maxTokens}
                min={1}
                max={32768}
                onChange={(v) => patch('maxTokens', v)}
              />
            </div>
            {config.mode === 'sweep' && (
              <Field label="并发档位（逗号分隔）">
                <input className="input mono" value={sweep} onChange={(e) => setSweep(e.target.value)} />
              </Field>
            )}
            <Field label="提示词集合" hint="每行一条。多行或复杂消息可放入下方全自定义请求体。">
              <textarea className="input min-h-28" value={prompts} onChange={(e) => setPrompts(e.target.value)} />
            </Field>
            <div className="flex flex-wrap items-center gap-4 text-xs">
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={config.stream} onChange={(e) => patch('stream', e.target.checked)} />
                SSE 流式指标
              </label>
              <label className="flex items-center gap-2">
                <input type="checkbox" checked={config.http2} onChange={(e) => patch('http2', e.target.checked)} />
                HTTP/2
              </label>
            </div>
            <details className="rounded-lg border border-zinc-800 p-3">
              <summary className="text-sm text-zinc-300">请求、重试与预热</summary>
              <div className="mt-4 space-y-4">
                <div className="grid grid-cols-2 gap-3">
                  <Numeric
                    label="预热次数 / 档"
                    value={config.warmup}
                    min={0}
                    max={100}
                    onChange={(v) => patch('warmup', v)}
                  />
                  <Numeric
                    label="超时 / 秒"
                    value={config.timeoutSeconds}
                    min={0.1}
                    max={300}
                    step={0.1}
                    onChange={(v) => patch('timeoutSeconds', v)}
                  />
                  <Numeric
                    label="温度"
                    value={config.temperature}
                    min={0}
                    max={2}
                    step={0.1}
                    onChange={(v) => patch('temperature', v)}
                  />
                  {[
                    ['retries429', '429 重试'],
                    ['retriesNetwork', '网络重试'],
                    ['retries5xx', '5xx 重试'],
                  ].map(([k, label]) => (
                    <Numeric key={k} label={label} value={config[k]} min={0} max={3} onChange={(v) => patch(k, v)} />
                  ))}
                </div>
                <Field label="提示词策略">
                  <select
                    className="input"
                    value={config.promptStrategy}
                    onChange={(e) => patch('promptStrategy', e.target.value)}
                  >
                    <option value="sequential">顺序循环</option>
                    <option value="random">均匀随机</option>
                    <option value="weighted">按权重随机</option>
                  </select>
                </Field>
                {config.promptStrategy === 'weighted' && (
                  <Field label="每条提示词权重（逗号分隔）">
                    <input className="input" value={weights} onChange={(e) => setWeights(e.target.value)} />
                  </Field>
                )}
                <Field label="自定义相对路径" hint="留空使用所选协议的标准端点；不会换用其他域名。">
                  <input
                    className="input mono"
                    placeholder="/chat/completions"
                    value={config.path}
                    onChange={(e) => patch('path', e.target.value)}
                  />
                </Field>
                <Field label="附加请求体 JSON" hint="递归合并原生参数，如 thinking；全自定义请求体启用时仍合并此字段。">
                  <CodeInput value={extra} onChange={setExtra} minHeight={80} />
                </Field>
                <Field
                  label="全自定义请求体（可选）"
                  hint="保留厂商字段；提示词集合替换第一个 user 消息或 Responses input。模型、输出上限和 stream 以表单为准；清空提示词集合可保留完整对话。"
                >
                  <CodeInput value={custom} onChange={setCustom} minHeight={100} />
                </Field>
              </div>
            </details>
            <p className="text-xs leading-relaxed text-zinc-400">
              预热和重试也可能计费。此处复用兼容协议的性能引擎；Gemini、实时语音、视频与 3D
              请在原生实验台体验。所有评测均需逐次确认。
            </p>
            <button
              className="btn-primary w-full"
              disabled={busy || running || !conn || runtime?.available !== true}
              onClick={prepare}
            >
              {busy ? <Spinner /> : <Play size={15} />}审核并启动评测
            </button>
          </section>
          <section className="min-w-0 space-y-4">
            <div className="card space-y-4 p-5">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div>
                  <p className="text-xs tracking-[0.2em] text-emerald-400">MONITOR</p>
                  <h2 className="mt-1 text-lg font-semibold">
                    {selected ? (STATUS_LABEL[selected.status] ?? selected.status) : '等待第一次评测'}
                  </h2>
                  {selected && (
                    <p className="mt-1 break-all text-xs text-zinc-400">
                      {selected.config?.model} · {MODE_LABEL[selected.config?.mode]} · {fmtTime(selected.createdAt)}
                    </p>
                  )}
                </div>
                {active(selected) && (
                  <button
                    className="btn-outline text-rose-300"
                    onClick={async () => {
                      try {
                        await benchApi.cancel(selected.id);
                        const r = await benchApi.get(selected.id);
                        setSelected(r);
                        setRecords(await benchApi.list());
                      } catch (e: any) {
                        toast(e.message, 'err');
                      }
                    }}
                  >
                    <Square size={13} />
                    停止评测
                  </button>
                )}
              </div>
              {selected?.error && (
                <p className="rounded border border-rose-900 p-3 text-xs text-rose-200">{selected.error}</p>
              )}
              {!selected ? (
                <EmptyHint>
                  <Activity className="mx-auto mb-3 text-sky-400" size={26} />
                  先以低并发和少量请求建立基线，再逐步扫描。这里的图表只显示真实结果。
                </EmptyHint>
              ) : (
                <>
                  {active(selected) && (
                    <p className="text-xs text-sky-300" role="status">
                      <Spinner /> 正在运行，离开此页后本机服务继续评测；服务重启会中断。{progress?.message ?? ''}
                    </p>
                  )}
                  {selected.connectionSnapshot && (
                    <p className="mono break-all text-xs text-zinc-400">
                      {selected.connectionSnapshot.label} · {selected.connectionSnapshot.url} ·{' '}
                      {selected.connectionSnapshot.route}
                    </p>
                  )}
                  {selected.limits && (
                    <p className="text-xs text-zinc-400">
                      本轮上限 {number(selected.limits.maxRuntimeSeconds, 0)} 秒 ·{' '}
                      {number(selected.limits.maxAttempts, 0)} 次 HTTP 尝试（含预热与重试）
                      {progress?.elapsedSeconds != null ? ` · 已运行 ${number(progress.elapsedSeconds, 0)} 秒` : ''}
                    </p>
                  )}
                  {stageOptions.length > 1 && (
                    <Field label="查看并发档位">
                      <select
                        className="input"
                        value={stageIndex}
                        onChange={(e) => {
                          setStageIndex(Number(e.target.value));
                          setSample(null);
                        }}
                      >
                        {stageOptions.map((s: any, i: number) => (
                          <option key={i} value={i}>
                            并发 {s.concurrency}
                            {active(selected) && progress?.stage === i + 1 ? ' · 正在运行' : ''}
                          </option>
                        ))}
                      </select>
                    </Field>
                  )}
                  <div className="grid grid-cols-2 gap-2 lg:grid-cols-3">
                    <Kpi
                      label="成功 / 请求"
                      value={`${number(stats.requests_success, 0)} / ${number(stats.requests_total, 0)}`}
                    />
                    <Kpi label="成功率" value={`${number(stats.success_rate_pct)} %`} />
                    <Kpi label="成功吞吐" value={`${number(stats.throughput_rps, 2)} req/s`} />
                    <Kpi
                      label="P50 / P95 延迟"
                      value={`${number(stats.latency_ms_p50, 0)} / ${number(stats.latency_ms_p95, 0)} ms`}
                    />
                    <Kpi label="首内容 TTFT P50" value={`${number(stats.ttft_ms_p50, 0)} ms`} />
                    <Kpi label="输出吞吐" value={`${number(stats.throughput_completion_tok_s)} tok/s`} />
                    {selected.config.mode === 'rps' && (
                      <Kpi label="计划请求被跳过" value={number(stats.rps_schedule_skipped, 0)} />
                    )}
                    <Kpi label="本档 HTTP 尝试（含预热）" value={number(stats.http_attempts_including_warmup, 0)} />
                  </div>
                  {Number(stats.rps_schedule_skipped) > 0 && (
                    <p className="rounded border border-amber-900 p-3 text-xs text-amber-200">
                      在飞并发已满，部分计划请求没有发出。本轮未达到全部目标负载；可增加并发，或降低目标 RPS
                      后重新观察。
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <ExportLinks id={selected.id} />
                    <button
                      className="btn-ghost text-xs"
                      disabled={active(selected)}
                      onClick={() => loadConfig(selected.config)}
                    >
                      复用配置
                    </button>
                  </div>
                  <p className="text-xs leading-relaxed text-zinc-400">
                    TTFT 仅在引擎识别到流式内容时出现；ITL
                    是内容块间隔。用量缺失时保持未知。延迟包含逻辑请求的重试与等待，HTTP 尝试单独统计。
                  </p>
                </>
              )}
            </div>
            {selected && (
              <>
                <Chart
                  title="成功吞吐时间线"
                  values={(Array.isArray(stats.timeline) ? stats.timeline : [])
                    .filter((p: unknown) => p && typeof p === 'object')
                    .map((p: any) => ({
                      label: `${number(p.t_start_s ?? p.start_s ?? p.t_s ?? p.second ?? p.bucket_start_s ?? 0)}s`,
                      value: Number.isFinite(Number(p.rps_success)) ? Math.max(0, Number(p.rps_success)) : 0,
                    }))}
                  unit="req/s"
                />
                {stages.length > 1 && (
                  <Chart
                    title="并发扫描 · 成功吞吐"
                    values={stages.map((s: any) => ({
                      label: `c=${s.concurrency}`,
                      value: s.stats?.throughput_rps ?? 0,
                    }))}
                    unit="req/s"
                  />
                )}
                <details className="card p-5">
                  <summary className="font-medium">完整指标与错误分类</summary>
                  <div className="mt-3">
                    <JsonBlock value={stats} />
                  </div>
                </details>
                <div className="card min-w-0 space-y-3 p-5">
                  <h3 className="font-medium">请求样本 · {rows.length} 条</h3>
                  {!rows.length ? (
                    <p className="text-xs text-zinc-400">请求结束后显示样本及实际发送的请求体。</p>
                  ) : (
                    <>
                      <div className="max-h-72 overflow-auto">
                        <table className="w-full text-left text-xs">
                          <thead className="text-zinc-400">
                            <tr>
                              <th className="p-2">#</th>
                              <th>状态</th>
                              <th>耗时 ms</th>
                              <th>TTFT ms</th>
                              <th>尝试</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.slice(0, 200).map((r: any, i: number) => (
                              <tr
                                key={i}
                                className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-800/50"
                                onClick={() => setSample(i)}
                                tabIndex={0}
                                onKeyDown={(e) => {
                                  if (e.key === 'Enter') setSample(i);
                                }}
                              >
                                <td className="p-2">{i + 1}</td>
                                <td className={r.ok ? 'text-emerald-300' : 'text-rose-300'}>
                                  {r.status_code ?? r.error_kind ?? '—'}
                                </td>
                                <td>{number(r.latency_ms, 0)}</td>
                                <td>{number(r.ttft_ms, 0)}</td>
                                <td>{r.attempt_count ?? 1}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      {rows.length > 200 && (
                        <p className="text-xs text-zinc-400">页面展示前 200 条；完整数据可导出。</p>
                      )}
                      {sample != null && rows[sample] && (
                        <div>
                          <h4 className="mb-2 text-xs text-sky-300">样本 {sample + 1}</h4>
                          <JsonBlock value={rows[sample]} max={30000} />
                          {rows[sample].request_body && (
                            <button
                              className="btn-outline mt-2 text-xs"
                              onClick={() => {
                                sessionStorage.setItem(
                                  'raw-bench-seed',
                                  JSON.stringify({
                                    connectionId: selected.config.connectionId,
                                    request: {
                                      method: 'POST',
                                      path:
                                        selected.config.path ||
                                        (selected.config.endpoint === 'responses' ? '/responses' : '/chat/completions'),
                                      body: rows[sample].request_body,
                                      stream: selected.config.stream,
                                      bodyType: 'json',
                                    },
                                  }),
                                );
                                navigate('/raw?from=bench');
                              }}
                            >
                              载入原始请求台（不发送）
                            </button>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              </>
            )}
          </section>
        </div>
      )}

      {tab === 'history' && (
        <section className="card min-w-0 space-y-4 p-5">
          <p className="text-xs text-zinc-400">
            选择 2–6 条结果进入对照。导入记录保留来源标识，不作为本机真实调用证据。
          </p>
          {!records.length ? (
            <EmptyHint>尚无评测记录。</EmptyHint>
          ) : (
            records.map((r) => (
              <article key={r.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-zinc-800 p-4">
                <input
                  aria-label={`对照 ${r.config?.model ?? r.id}`}
                  type="checkbox"
                  checked={compared.includes(r.id)}
                  disabled={active(r) || (!compared.includes(r.id) && compared.length >= 6)}
                  onChange={(e) =>
                    setCompared((v) => (e.target.checked ? [...v, r.id] : v.filter((id) => id !== r.id)))
                  }
                />
                <div className="min-w-0 flex-1">
                  <p className="break-all text-sm font-medium">
                    {r.config?.model ?? '导入结果'} · {MODE_LABEL[r.config?.mode] ?? r.config?.mode}
                  </p>
                  <p className="mt-1 text-xs text-zinc-400">
                    {fmtTime(r.createdAt)} · {STATUS_LABEL[r.status] ?? r.status}
                    {r.status === 'imported' ? ' · 导入记录' : ''}
                  </p>
                  <p className="mt-1 break-all text-xs text-zinc-400">
                    {r.connectionLabel ?? '来源账户未记录'}
                    {r.importedAt ? ` · 导入于 ${fmtTime(r.importedAt)}` : ''}
                  </p>
                </div>
                <button
                  className="btn-outline text-xs"
                  onClick={() => {
                    setSelectedId(r.id);
                    if (selected?.id !== r.id) setSelected(null);
                    setStageIndex(0);
                    setSample(null);
                    setTab('monitor');
                  }}
                >
                  查看
                </button>
                <button className="btn-ghost text-xs" onClick={() => loadConfig(r.config)}>
                  复用配置
                </button>
                <ExportLinks id={r.id} />
                <button className="btn-ghost text-xs text-rose-300" disabled={active(r)} onClick={() => setRemoving(r)}>
                  删除
                </button>
              </article>
            ))
          )}
          {records.length >= 50 && hasMore && (
            <button
              className="btn-outline"
              onClick={async () => {
                try {
                  const more = await benchApi.list(records.length);
                  setRecords((prev) => [...prev, ...more]);
                  setHasMore(more.length === 50);
                } catch (e: any) {
                  toast(e.message, 'err');
                }
              }}
            >
              加载更多记录
            </button>
          )}
        </section>
      )}

      {tab === 'compare' && (
        <section className="space-y-4">
          <p className="rounded-lg border border-amber-900/70 p-4 text-xs leading-relaxed text-amber-200">
            仅在账户路由、协议、提示词、输出上限、流式、预热和重试一致时，性能结果才适合直接比较。并发与 RPS
            模式回答不同问题；少量请求的尾延迟不能代表长期服务水平。
          </p>
          {comparisons.length < 2 ? (
            <EmptyHint>在「评测记录」勾选 2–6 条结果。</EmptyHint>
          ) : (
            <div className="card overflow-auto p-4">
              <table className="w-full text-left text-xs">
                <thead>
                  <tr>
                    <th className="p-3">指标</th>
                    {comparisons.map((r) => (
                      <th key={r.id} className="min-w-48 p-3 align-top">
                        <span className="break-all text-sky-300">{r.config?.model}</span>
                        <p className="mt-2 font-normal text-zinc-400">
                          {MODE_LABEL[r.config?.mode]} · {r.config?.endpoint} · {r.connectionLabel ?? '账户未记录'}
                        </p>
                        <select
                          className="input mt-2 text-xs"
                          aria-label={`${r.config?.model} 对照并发档位`}
                          value={comparedEntries.find((e) => e.record.id === r.id)?.stageIndex ?? 0}
                          onChange={(e) => setComparisonStages((old) => ({ ...old, [r.id]: Number(e.target.value) }))}
                        >
                          {r.stages.map((s: any, i: number) => (
                            <option key={i} value={i}>
                              第 {i + 1} 档 · 并发 {s.concurrency}
                            </option>
                          ))}
                        </select>
                        <p className="mt-1 font-normal text-zinc-400">{fmtTime(r.createdAt)}</p>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {statKeys.map((k) => (
                    <tr key={k} className="border-t border-zinc-800">
                      <th className="p-3 font-normal text-zinc-400">{METRIC_LABEL[k] ?? k}</th>
                      {comparisons.map((r) => (
                        <td key={r.id} className="mono p-3">
                          {number(
                            r.stages?.[comparedEntries.find((e) => e.record.id === r.id)?.stageIndex ?? 0]?.stats?.[k],
                            2,
                          )}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {comparisons.length >= 2 && (
            <div className="card space-y-3 p-4">
              <h3 className="text-sm font-medium">所选档位的条件差异</h3>
              <div className="flex flex-wrap gap-2">
                {comparisonAudit.shared.map((axis) => (
                  <span className="chip text-emerald-300" key={axis}>
                    相同 · {axis}
                  </span>
                ))}
              </div>
              {!!comparisonAudit.differences.length && (
                <div className="overflow-auto">
                  <table className="w-full text-left text-xs">
                    <tbody>
                      {comparisonAudit.differences.map((difference) => (
                        <tr key={difference.axis} className="border-t border-zinc-800">
                          <th className="p-2 font-normal text-amber-200">{difference.axis}</th>
                          {difference.lanes.map((value, i) => (
                            <td className="max-w-64 break-all p-2 text-zinc-400" key={i}>
                              <span className="line-clamp-4" title={value}>
                                {value}
                              </span>
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {comparisonAudit.notes.map((note) => (
                <p className="text-xs text-zinc-400" key={note}>
                  {note}
                </p>
              ))}
            </div>
          )}
        </section>
      )}

      {pending && (
        <Modal title="确认本次性能评测" onClose={() => setPending(null)}>
          <div className="space-y-4 text-sm text-zinc-300">
            <p>
              向「{connections.find((c) => c.id === pending.connectionId)?.label}」运行 {MODE_LABEL[pending.mode]}，模型{' '}
              <b className="break-all text-sky-200">{pending.model}</b>。
            </p>
            <div className="rounded-lg border border-zinc-700 bg-zinc-950 p-4 leading-7">
              <p>逻辑请求：{benchLimits(pending).estimatedRequests ?? '按时长持续发出，最多 10000 个逻辑请求'}</p>
              <p>
                预热：{benchLimits(pending).warmupRequests} 次；最大并发：
                {pending.mode === 'sweep' ? Math.max(...pending.sweepConcurrency) : pending.concurrency}
              </p>
              <p>含预热与重试最多尝试：{benchLimits(pending).maxAttempts} 次</p>
              <p>单次输出上限：{pending.maxTokens} Token（由服务端统一限制）</p>
              <p>本轮最长运行：{benchLimits(pending).maxRuntimeSeconds} 秒；到达后保存已有结果并停止</p>
            </div>
            {error && (
              <p role="alert" className="text-xs text-rose-200">
                {error}
              </p>
            )}
            <p className="text-xs leading-relaxed text-amber-200">
              预热、重试和已发出的请求都可能计费；停止只中止本机请求，不能追回上游消耗。没有可信模型定价时无法自动给出金额硬上限。请核对账户额度与请求配置。
            </p>
            <details>
              <summary className="text-xs">核对配置快照</summary>
              <JsonBlock value={pending} />
            </details>
            <div className="flex justify-end gap-3">
              <button className="btn-ghost" onClick={() => setPending(null)}>
                返回编辑
              </button>
              <button className="btn-primary" onClick={() => void launch()}>
                确认并开始
              </button>
            </div>
          </div>
        </Modal>
      )}
      {removing && (
        <Modal
          title="删除评测记录"
          onClose={() => {
            if (!deleting) setRemoving(null);
          }}
        >
          <div className="space-y-4">
            <p className="text-sm text-zinc-300">
              删除「{removing.config?.model} · {fmtTime(removing.createdAt)}
              」及其样本？删除后无法恢复，请先导出需要保留的数据。
            </p>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" disabled={deleting} onClick={() => setRemoving(null)}>
                保留记录
              </button>
              <button
                className="btn-outline text-rose-300"
                disabled={deleting}
                onClick={async () => {
                  setDeleting(true);
                  try {
                    await benchApi.remove(removing.id);
                    setRecords((old) => old.filter((r) => r.id !== removing.id));
                    setCompared((old) => old.filter((id) => id !== removing.id));
                    if (selectedId === removing.id) {
                      setSelectedId('');
                      setSelected(null);
                    }
                    setRemoving(null);
                    toast('已删除评测记录');
                  } catch (e: any) {
                    toast(e.message, 'err');
                  } finally {
                    setDeleting(false);
                  }
                }}
              >
                {deleting ? '正在删除…' : '确认删除'}
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Page>
  );
}

function Numeric({
  label,
  value,
  onChange,
  min,
  max,
  step = 1,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min: number;
  max: number;
  step?: number;
}) {
  return (
    <Field label={label}>
      <input
        className="input mono"
        type="number"
        min={min}
        max={max}
        step={step}
        value={Number.isNaN(value) ? '' : value}
        onChange={(e) => onChange(e.target.valueAsNumber)}
      />
    </Field>
  );
}
function Kpi({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-950/50 p-3">
      <p className="text-xs text-zinc-400">{label}</p>
      <p className="mono mt-2 text-sm text-zinc-100">{value}</p>
    </div>
  );
}
function ExportLinks({ id }: { id: string }) {
  return (
    <>
      {['json', 'csv'].map((format) => (
        <a
          key={format}
          className="btn-outline text-xs"
          href={`/api/bench/${encodeURIComponent(id)}/export?format=${format}`}
          download
        >
          <ArrowDownToLine size={12} />
          {format.toUpperCase()}
        </a>
      ))}
    </>
  );
}
function Chart({ title, values, unit }: { title: string; values: { label: string; value: number }[]; unit: string }) {
  const max = Math.max(1, ...values.map((v) => v.value));
  const shown = values.slice(-60);
  return (
    <div className="card min-w-0 p-5">
      <div className="mb-4 flex justify-between text-xs">
        <h3 className="font-medium text-zinc-200">{title}</h3>
        <span className="text-zinc-400">{unit}</span>
      </div>
      {!shown.length ? (
        <p className="py-5 text-center text-xs text-zinc-400">等待真实时间线数据</p>
      ) : (
        <div
          className="flex h-36 min-w-0 items-end gap-1 border-b border-zinc-700"
          role="img"
          aria-label={`${title}：${shown.map((v) => `${v.label} ${number(v.value)}`).join('，')}`}
        >
          {shown.map((v, i) => (
            <div
              key={i}
              className="group relative flex h-full min-w-0 flex-1 items-end"
              title={`${v.label} · ${number(v.value, 2)} ${unit}`}
            >
              <div
                className="w-full rounded-t-sm bg-sky-400/70 transition-[height] group-hover:bg-sky-300"
                style={{ height: `${Math.max(v.value ? 2 : 0, (v.value / max) * 95)}%` }}
              />
            </div>
          ))}
        </div>
      )}
      <p className="mt-2 text-xs text-zinc-400">
        {shown[0]?.label} {shown.length > 1 && `→ ${shown.at(-1)?.label}`} · 悬停查看数值
      </p>
    </div>
  );
}
