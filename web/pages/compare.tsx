import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getOperation, getProvider, modelsFor, OPERATIONS } from '../../shared/catalog.ts';
import { initialParamState, type ParamState } from '../../shared/util.ts';
import { validateOperationInput } from '../../shared/validate.ts';
import { reduceEvents } from '../../shared/protocols.ts';
import type { LabState, RunRecord } from '../../shared/types.ts';
import { api, type RunRequestBody } from '../api.ts';
import { useApp } from '../app.tsx';
import { compareHref, labHref, useRoute } from '../router.ts';
import { cancelRunSession, useRunner } from '../lab/useRunner.ts';
import { usePersistentDraft } from '../workspace-state.ts';
import { configurationSignature } from '../lab/input-state.ts';
import { WORKBENCH_DEFAULTS, WorkbenchInput } from '../lab/inputs.tsx';
import { ParamsPanel } from '../lab/params.tsx';
import { OutputView } from '../lab/outputs.tsx';
import { buildPreview, RequestPreview } from '../lab/preview.tsx';
import { ModelPicker, ModelInfo } from '../lab/LabPage.tsx';
import { useRemoteModels } from '../lab/remote-models.ts';
import { EventList, MetricsPanel } from '../lab/inspector.tsx';
import {
  Chip,
  EmptyHint,
  ErrorBox,
  JsonBlock,
  Modal,
  Spinner,
  StatusBadge,
  Tabs,
  VerificationChip,
  fmtTime,
} from '../ui.tsx';
import { Page, downloadJson } from './common.tsx';
import { auditComparison, auditRecordedComparison } from '../../shared/comparison.ts';

interface LaneDef {
  id: string;
  operationId: string;
  seed?: Partial<LabState>;
  parentId?: string;
}
interface Handle {
  prepare: () => RunRequestBody | null;
  execute: (body: RunRequestBody) => Promise<void>;
  abort: () => void;
  input: Record<string, unknown>;
  setInput: (v: Record<string, unknown>) => void;
  workbench: string;
  running: boolean;
  snapshot: () => Partial<LabState>;
}
interface Batch {
  bodies: { id: string; body: RunRequestBody }[];
  groupId: string;
}
const laneId = () => `lane-${crypto.randomUUID()}`;
const eligible = () => OPERATIONS.filter((o) => o.lifecycle !== 'ws' && o.workbench !== 'raw');
function seedFingerprint(value: string) {
  let a = 2166136261;
  let b = 5381;
  for (const c of value) {
    a = Math.imul(a ^ c.charCodeAt(0), 16777619);
    b = Math.imul(b, 33) ^ c.charCodeAt(0);
  }
  return `${value.length}-${a >>> 0}-${b >>> 0}`;
}

export function ComparePage() {
  const route = useRoute();
  const { toast, connections } = useApp();
  const sourceSeed = route.query.get('from') === 'lab' ? (sessionStorage.getItem('compare-seed') ?? '') : '';
  const draftToken = route.query.get('draft') || (sourceSeed ? seedFingerprint(sourceSeed) : '');
  const workspaceKey = draftToken ? `compare:draft:${draftToken}` : `compare:${route.query.toString() || 'workspace'}`;
  const workspaceHref = draftToken
    ? `#/compare?draft=${encodeURIComponent(draftToken)}`
    : `#/compare${route.query.toString() ? `?${route.query}` : ''}`;
  const handles = useRef(new Map<string, Handle>());
  const [snapshots, setSnapshots] = useState<Record<string, Partial<LabState>>>({});
  const [mode, setMode] = usePersistentDraft<'new' | 'history'>(
    `${workspaceKey}:mode`,
    route.query.has('runs') || route.query.has('group') ? 'history' : 'new',
    { hidden: true },
  );
  const [lanes, setLanes] = usePersistentDraft<LaneDef[]>(
    `${workspaceKey}:lanes`,
    () => {
      let seed: Partial<LabState> | undefined;
      if (route.query.get('from') === 'lab') {
        try {
          const s = JSON.parse(sessionStorage.getItem('compare-seed') ?? 'null');
          if (getOperation(s?.operationId)) seed = s;
        } catch {}
      }
      const ids = (route.query.get('ops') ?? '')
        .split(',')
        .filter((id) => eligible().some((o) => o.id === id))
        .slice(0, 4);
      const list = ids.length ? ids : [seed?.operationId ?? eligible()[0]?.id, seed?.operationId ?? eligible()[0]?.id];
      return list
        .filter((id): id is string => !!id)
        .map((id) => ({ id: laneId(), operationId: id, seed: seed?.operationId === id ? seed : undefined }));
    },
    { title: '对比实验', href: workspaceHref },
  );
  useEffect(() => {
    // Save generated lane ids before navigating away so child drafts and active
    // runs reconnect to the same lanes on return.
    setLanes((current) => [...current]);
    if (sourceSeed && !route.query.has('draft')) {
      window.history.replaceState(null, '', workspaceHref);
      window.dispatchEvent(new HashChangeEvent('hashchange'));
    }
  }, [workspaceKey]);
  const [confirming, setConfirming] = useState<Batch | null>(null);
  const pending = useRef<Batch | null>(null);
  const launching = useRef(false);
  const [group, setGroup] = usePersistentDraft(`${workspaceKey}:group`, '', { hidden: true });
  const [records, setRecords] = useState<RunRecord[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const register = useCallback((id: string, h: Handle | null) => {
    if (h) handles.current.set(id, h);
    else handles.current.delete(id);
    if (h) {
      const snapshot = h.snapshot();
      setSnapshots((prev) =>
        JSON.stringify(prev[id]) === JSON.stringify(snapshot) ? prev : { ...prev, [id]: snapshot },
      );
    }
  }, []);
  const audit =
    mode === 'new'
      ? auditComparison(
          lanes.map((l) => snapshots[l.id] ?? {}),
          connections,
        )
      : auditRecordedComparison(records);
  useEffect(() => {
    if (!route.query.has('runs') && !route.query.has('group')) return;
    let disposed = false;
    setLoading(true);
    const ids = (route.query.get('runs') ?? '').split(',').filter(Boolean).slice(0, 4);
    const p = route.query.get('group')
      ? api
          .runs({ groupId: route.query.get('group')!, limit: 4 })
          .then((rs) => Promise.all(rs.map((r) => api.run(r.id))))
      : Promise.all(ids.map((id) => api.run(id)));
    p.then((rs) => {
      if (!disposed) {
        setRecords(rs);
        setError('');
      }
    })
      .catch((e) => {
        if (!disposed) setError(e.message);
      })
      .finally(() => {
        if (!disposed) setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [route.query.toString()]);
  function prepareBatch(ids: string[]) {
    if (pending.current || launching.current) return;
    const running = [...handles.current.values()].some((h) => h.running);
    if (running) {
      toast('先等待当前运行结束，或中止当前请求。', 'err');
      return;
    }
    const bodies: Batch['bodies'] = [];
    for (const id of ids) {
      const h = handles.current.get(id);
      if (!h) {
        toast('实验通道尚未就绪', 'err');
        return;
      }
      const body = h.prepare();
      if (!body) return;
      bodies.push({ id, body });
    }
    const batch = { bodies, groupId: crypto.randomUUID() };
    pending.current = batch;
    setConfirming(batch);
  }
  function closeConfirmation() {
    pending.current = null;
    setConfirming(null);
  }
  function launchBatch() {
    const batch = pending.current;
    if (!batch || launching.current) return;
    pending.current = null;
    launching.current = true;
    setConfirming(null);
    setGroup(batch.groupId);
    void Promise.allSettled(
      batch.bodies.map((item) =>
        handles.current.get(item.id)?.execute({ ...item.body, groupId: batch.groupId, confirmCost: true }),
      ),
    ).finally(() => {
      launching.current = false;
    });
  }
  function copyFirstInput() {
    const first = handles.current.get(lanes[0]?.id);
    if (!first) return;
    let n = 0;
    for (const lane of lanes.slice(1)) {
      const h = handles.current.get(lane.id);
      if (h?.workbench === first.workbench) {
        h.setInput(structuredClone(first.input));
        n++;
      }
    }
    toast(
      n ? `已将 A 的输入复制到 ${n} 个同类通道；各自原生参数保留。` : '其他通道与 A 的输入类型不同，无法直接复制。',
      n ? 'ok' : 'err',
    );
  }
  return (
    <Page
      title="对比实验"
      description="并排研究不同模型、服务或原生参数的表现。输入可以相同，接口与参数语义仍可能不同；不把不同能力强行视为等价。"
      actions={
        <Tabs
          value={mode}
          onChange={setMode}
          tabs={[
            ['new', `新建对比${[...handles.current.values()].some((h) => h.running) ? ' · 运行中' : ''}`],
            ['history', '记录对比'],
          ]}
        />
      }
    >
      <div className="rounded-lg border border-amber-800/60 bg-amber-950/20 p-4 text-xs leading-relaxed text-amber-200/90">
        公平比较建议：先复制同一输入，检查系统提示词、思考模式、最大输出和采样参数。Token
        计数器、区域、路由、缓存命中与异步生命周期可能不同；未提供的指标保持未知，速度与单次结果不足以构成排名。
      </div>
      <section className="card space-y-3 p-4" aria-label="对照条件审计">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="text-sm font-semibold text-sky-200">对照条件审计</h2>
          <span className="text-xs text-zinc-400">
            {mode === 'new' ? '核对待运行配置；各通道输出保留运行时快照' : '核对当时实际发送的请求与路由'}
          </span>
        </div>
        {audit.shared.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {audit.shared.map((axis) => (
              <Chip key={axis} tone="green">
                相同 · {axis}
              </Chip>
            ))}
          </div>
        )}
        {audit.differences.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead>
                <tr className="text-zinc-400">
                  <th className="p-2">存在差异</th>
                  {(mode === 'new' ? lanes : records).map((_, i) => (
                    <th key={i} className="p-2">
                      {String.fromCharCode(65 + i)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {audit.differences.map((d) => (
                  <tr key={d.axis} className="border-t border-zinc-800">
                    <th className="p-2 font-normal whitespace-nowrap text-amber-200">{d.axis}</th>
                    {d.lanes.map((v, i) => (
                      <td key={i} className="mono max-w-64 p-2 align-top break-all text-zinc-400">
                        <span className="line-clamp-3" title={v}>
                          {v}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {audit.notes.map((n) => (
          <p key={n} className="text-xs leading-relaxed text-zinc-400">
            {n}
          </p>
        ))}
        {!audit.shared.length && !audit.differences.length && (
          <p className="text-xs text-zinc-400">载入至少两个通道后显示配置差异。</p>
        )}
      </section>
      <div hidden={mode !== 'new'} className="space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <button
            className="btn-primary"
            disabled={lanes.length < 2}
            onClick={() => prepareBatch(lanes.map((l) => l.id))}
          >
            运行全部 {lanes.length} 个通道
          </button>
          <button
            className="btn-outline"
            disabled={lanes.length >= 4}
            onClick={() => {
              const first = lanes[0];
              const h = first ? handles.current.get(first.id) : undefined;
              const seed = h?.snapshot();
              const op = first?.operationId ?? eligible()[0]?.id;
              if (!op) return;
              setLanes((ls) => [...ls, { id: laneId(), operationId: op, seed }]);
            }}
          >
            ＋ 通道（最多 4 个）
          </button>
          <button className="btn-ghost" onClick={copyFirstInput}>
            复制 A 的输入至同类通道
          </button>
          <button className="btn-ghost text-rose-300" onClick={() => handles.current.forEach((h) => h.abort())}>
            中止全部请求
          </button>
          {group && (
            <a className="text-xs text-violet-300" href={compareHref({ group })}>
              本次分组记录 →
            </a>
          )}
        </div>
        <div className="grid items-start gap-4 xl:grid-cols-2">
          {lanes.map((lane, i) => (
            <section className="card min-w-0 space-y-4 p-4" key={lane.id}>
              <div className="flex items-center gap-3">
                <h2 className="text-lg font-semibold text-violet-300">{String.fromCharCode(65 + i)}</h2>
                <select
                  className="input min-w-0 flex-1"
                  value={lane.operationId}
                  disabled={handles.current.get(lane.id)?.running}
                  onChange={(e) =>
                    setLanes((ls) =>
                      ls.map((l) =>
                        l.id === lane.id
                          ? { ...l, operationId: e.target.value, seed: undefined, parentId: undefined }
                          : l,
                      ),
                    )
                  }
                >
                  {eligible().map((o) => (
                    <option key={o.id} value={o.id}>
                      {getProvider(o.providerId)?.name} · {o.title}
                    </option>
                  ))}
                </select>
                <button
                  className="btn-ghost text-rose-300"
                  disabled={lanes.length <= 2}
                  aria-label={`移除通道 ${String.fromCharCode(65 + i)}`}
                  onClick={() => {
                    handles.current.get(lane.id)?.abort();
                    cancelRunSession(`${workspaceKey}:${lane.id}:${lane.operationId}:run`);
                    handles.current.delete(lane.id);
                    setLanes((ls) => ls.filter((l) => l.id !== lane.id));
                  }}
                >
                  ✕
                </button>
              </div>
              <CompareLane
                key={`${lane.id}:${lane.operationId}`}
                lane={lane}
                workspaceKey={workspaceKey}
                index={i}
                register={register}
                requestRun={() => prepareBatch([lane.id])}
              />
            </section>
          ))}
        </div>
      </div>
      <div hidden={mode !== 'history'} className="space-y-4">
        <div className="flex flex-wrap items-center gap-3">
          <p className="flex-1 text-sm text-zinc-400">
            从实验记录中选择 2–4 条，或打开一次对比分组。此视图不会请求上游 API。
          </p>
          <a className="btn-outline" href="#/runs">
            选择实验记录
          </a>
          {records.length > 0 && (
            <>
              <button className="btn-outline" onClick={() => downloadJson(records, `compare-${Date.now()}.json`)}>
                导出脱敏对比
              </button>
              <button
                className="btn-primary"
                disabled={records.filter((r) => r.state && eligible().some((o) => o.id === r.operationId)).length < 2}
                onClick={() => {
                  const next = records
                    .filter((r) => r.state && eligible().some((o) => o.id === r.operationId))
                    .slice(0, 4)
                    .map((r) => ({ id: laneId(), operationId: r.operationId!, seed: r.state!, parentId: r.id }));
                  setLanes(next);
                  setMode('new');
                  toast('已载入记录中的输入与参数，尚未调用 API');
                }}
              >
                复制为新对比
              </button>
            </>
          )}
        </div>
        {error && <ErrorBox error={{ title: '加载对比失败', hints: [error] }} />}
        {loading ? (
          <Spinner />
        ) : !records.length ? (
          <EmptyHint>尚未选择记录。到实验记录勾选 2–4 条，点击“并排查看”。</EmptyHint>
        ) : (
          <div className="grid items-start gap-4 xl:grid-cols-2">
            {records.map((r, i) => (
              <RecordedLane key={r.id} record={r} index={i} />
            ))}
          </div>
        )}
      </div>
      {confirming && (
        <Modal title={`确认运行 ${confirming.bodies.length} 个实验`} onClose={closeConfirmation}>
          <div className="space-y-4">
            <p className="text-sm leading-relaxed text-zinc-400">
              以下通道将分别发起 1
              次真实请求，并保存到同一对比分组。并发会累计消耗各自账户额度；视频、语音等模型费用可能明显高于文本。费用未知时请先查询服务商定价。
            </p>
            <ul className="space-y-2 text-xs text-zinc-300">
              {confirming.bodies.map(({ id, body }) => (
                <li className="rounded bg-zinc-950 p-3" key={id}>
                  {getOperation(body.operationId)?.title} · {body.model ?? '默认模型'}
                  <br />
                  <span className="text-zinc-400">
                    {getOperation(body.operationId)?.costHint ?? '价格请以实际账户与服务商账单为准'}
                  </span>
                </li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <button className="btn-ghost" onClick={closeConfirmation}>
                返回检查
              </button>
              <button className="btn-primary" onClick={launchBatch}>
                确认调用 {confirming.bodies.length} 次
              </button>
            </div>
          </div>
        </Modal>
      )}
    </Page>
  );
}

function CompareLane({
  lane,
  workspaceKey,
  index,
  register,
  requestRun,
}: {
  lane: LaneDef;
  workspaceKey: string;
  index: number;
  register: (id: string, h: Handle | null) => void;
  requestRun: () => void;
}) {
  const op = getOperation(lane.operationId)!;
  const provider = getProvider(op.providerId)!;
  const { connections, toast, refreshEvidence } = useApp();
  const own = connections.filter((c) => c.providerId === op.providerId);
  const draftKey = `${workspaceKey}:${lane.id}:${op.id}`;
  const [connectionId, setConnectionId] = usePersistentDraft(`${draftKey}:connection`, lane.seed?.connectionId ?? '', {
    hidden: true,
  });
  const [model, setModel] = usePersistentDraft(
    `${draftKey}:model`,
    lane.seed?.model ?? op.defaultModel ?? modelsFor(op)[0]?.id ?? '',
    { hidden: true },
  );
  const [input, setInput] = usePersistentDraft<Record<string, unknown>>(
    `${draftKey}:input`,
    () => structuredClone(lane.seed?.input ?? WORKBENCH_DEFAULTS[op.workbench] ?? {}),
    { hidden: true },
  );
  const [params, setParams] = usePersistentDraft<Record<string, ParamState>>(
    `${draftKey}:params`,
    () => ({
      ...initialParamState(op.params),
      ...lane.seed?.params,
    }),
    { hidden: true },
  );
  const [tab, setTab] = useState('output');
  const [editTab, setEditTab] = useState('input');
  const runner = useRunner(() => {
    void refreshEvidence();
  }, `${draftKey}:run`);
  const conn = own.find((c) => c.id === connectionId);
  const remote = useRemoteModels(conn, provider);
  const preview = useMemo(
    () => buildPreview(op, provider, conn, model, input, params),
    [op, provider, conn, model, input, params],
  );
  const view = runner.view ?? runner.response?.view ?? reduceEvents(op.protocol, runner.events);
  const sent = runner.inputSnapshot;
  const changedSinceRun =
    sent &&
    configurationSignature(
      op,
      {
        connectionId: sent.connectionId,
        model: sent.model ?? undefined,
        input: sent.input as Record<string, unknown>,
        params: sent.params,
      },
      connections,
    ) !== configurationSignature(op, { connectionId, model, input, params }, connections);
  useEffect(() => {
    if (!connectionId && own.length) setConnectionId(own[0].id);
  }, [connectionId, own]);
  useEffect(() => {
    register(lane.id, {
      snapshot: () => ({
        connectionId,
        operationId: op.id,
        model,
        input: structuredClone(input),
        params: structuredClone(params),
      }),
      running: runner.running,
      workbench: op.workbench,
      input,
      setInput,
      abort: runner.abort,
      execute: async (b) => {
        setTab('output');
        await runner.start(b);
      },
      prepare: () => {
        if (runner.running) {
          toast(`通道 ${String.fromCharCode(65 + index)} 正在运行`, 'err');
          return null;
        }
        if (!conn) {
          toast(`通道 ${String.fromCharCode(65 + index)} 请先选择 ${provider.name} 的连接`, 'err');
          return null;
        }
        try {
          validateOperationInput(op, { model, input, params, extra: conn.extra });
        } catch (e: any) {
          toast(`通道 ${String.fromCharCode(65 + index)}：${e.message}`, 'err');
          return null;
        }
        if (preview.error) {
          toast(`通道 ${String.fromCharCode(65 + index)} 请求无效：${preview.error}`, 'err');
          return null;
        }
        return {
          connectionId,
          operationId: op.id,
          model,
          input: structuredClone(input),
          params: structuredClone(params),
          parentId: lane.parentId,
          title: `对比 ${String.fromCharCode(65 + index)} · ${op.title} · ${model}`,
        };
      },
    });
    return () => register(lane.id, null);
  }, [
    lane.id,
    lane.parentId,
    register,
    runner.running,
    runner.start,
    runner.abort,
    op,
    provider.name,
    conn,
    model,
    input,
    params,
    preview.error,
    connectionId,
    index,
    toast,
  ]);
  return (
    <>
      <div className="flex flex-wrap gap-2">
        <VerificationChip v={op.verification} />
        <Chip>{op.lifecycle}</Chip>
        <Chip>{op.costTier}</Chip>
      </div>
      <select
        className="input"
        aria-label={`通道 ${index + 1} 连接`}
        value={connectionId}
        onChange={(e) => setConnectionId(e.target.value)}
      >
        <option value="">选择连接</option>
        {connectionId && !conn && <option value={connectionId}>历史连接已失效，请重新选择</option>}
        {own.map((c) => (
          <option key={c.id} value={c.id}>
            {c.label}
          </option>
        ))}
      </select>
      {!own.length && (
        <a href={`#/connections?provider=${encodeURIComponent(op.providerId)}`} className="text-xs text-violet-300">
          先配置 {provider.name} 连接 →
        </a>
      )}
      {connectionId && !conn && (
        <p className="text-xs text-amber-300">原连接已删除或不属于此服务。请选择当前有效连接后再运行。</p>
      )}
      <ModelPicker op={op} value={model} onChange={setModel} remote={remote.models} listId={`models-${lane.id}`} />
      <ModelInfo model={provider.models.find((m) => m.id === model)} />
      {remote.error && <p className="text-xs text-amber-300">模型查询失败：{remote.error}，仍可手动输入模型 ID。</p>}
      <Tabs
        value={editTab}
        onChange={setEditTab}
        tabs={[
          ['input', '输入'],
          ['params', '原生参数'],
          ['preview', '请求预览'],
        ]}
      />
      {editTab === 'input' && <WorkbenchInput op={op} input={input} setInput={setInput} />}{' '}
      {editTab === 'params' && (
        <ParamsPanel specs={op.params} state={params} setState={setParams} model={model} compact />
      )}{' '}
      {editTab === 'preview' && <RequestPreview preview={preview} />}
      <div className="flex flex-wrap items-center gap-2">
        <button className="btn-primary" disabled={runner.running || !conn} onClick={requestRun}>
          {runner.running ? <Spinner /> : `运行 ${String.fromCharCode(65 + index)}`}
        </button>
        {runner.running && (
          <button className="btn-outline" onClick={runner.abort}>
            中止
          </button>
        )}
        {runner.status && <StatusBadge status={runner.status} />}{' '}
        {runner.runId && (
          <a className="text-xs text-violet-300" href={`#/runs/${runner.runId}`}>
            记录 →
          </a>
        )}
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['output', '输出'],
          ['metrics', '指标'],
          ['request', '实际请求'],
          ['events', '事件'],
        ]}
      />
      {changedSinceRun && (
        <div className="rounded border border-amber-800/60 p-3 text-xs text-amber-200" role="status">
          配置已修改。下方仍是上次运行结果；重新运行后更新。
          <button
            className="btn-ghost ml-2 text-xs"
            onClick={() => {
              setConnectionId(sent.connectionId);
              setModel(sent.model ?? '');
              setInput(structuredClone((sent.input ?? {}) as Record<string, unknown>));
              setParams(structuredClone(sent.params ?? {}));
            }}
          >
            恢复该结果的配置
          </button>
        </div>
      )}
      {tab === 'output' && (
        <OutputView
          op={op}
          input={(sent?.input ?? input) as Record<string, unknown>}
          view={view}
          response={runner.response}
          artifacts={runner.artifacts}
          running={runner.running}
          error={runner.error}
          taskId={runner.taskId}
          hasEvents={!!runner.events.length}
          compact
          resultKey={`${runner.executionId ?? ''}:${runner.runId ?? ''}`}
        />
      )}{' '}
      {tab === 'metrics' && <MetricsPanel metrics={runner.metrics} view={view} />}{' '}
      {tab === 'request' && <JsonBlock value={runner.request} />}{' '}
      {tab === 'events' && <EventList events={runner.events} />}
    </>
  );
}

function RecordedLane({ record: r, index }: { record: RunRecord; index: number }) {
  const [tab, setTab] = useState('output');
  const op = getOperation(r.operationId);
  const view = r.response?.view ?? reduceEvents(op?.protocol, r.events ?? []);
  return (
    <article className="card min-w-0 space-y-4 p-5">
      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="flex-1 text-base font-semibold text-zinc-100">
            {String.fromCharCode(65 + index)} · {r.title}
          </h2>
          <StatusBadge status={r.status} />
        </div>
        <p className="mono break-all text-xs text-zinc-400">
          {r.providerId} · {r.model ?? '—'} · {fmtTime(r.createdAt)}
        </p>
        <div className="flex gap-2">
          <a className="text-xs text-violet-300" href={`#/runs/${r.id}`}>
            完整记录 →
          </a>
          {op && (
            <a className="text-xs text-violet-300" href={labHref(op.id, { run: r.id })}>
              复用此配置 →
            </a>
          )}
        </div>
      </header>
      <MetricsPanel metrics={r.metrics ?? null} view={view} />
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['output', '输出'],
          ['state', '输入 / 参数'],
          ['request', '原生请求'],
          ['events', '事件'],
        ]}
      />
      {tab === 'output' &&
        (op ? (
          <OutputView
            op={op}
            input={r.state?.input ?? r.input ?? {}}
            view={view}
            response={r.response}
            artifacts={r.artifacts ?? []}
            running={false}
            error={r.error}
            taskId={r.taskId ?? undefined}
            hasEvents={!!r.events?.length}
            compact
            resultKey={r.id}
          />
        ) : (
          <>
            <JsonBlock value={r.response} />
            <ErrorBox error={r.error} />
          </>
        ))}
      {tab === 'state' && <JsonBlock value={r.state ?? r.input} />}{' '}
      {tab === 'request' && <JsonBlock value={r.request} />} {tab === 'events' && <EventList events={r.events ?? []} />}
    </article>
  );
}
