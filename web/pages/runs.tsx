import { useCallback, useEffect, useRef, useState } from 'react';
import { getOperation, PROVIDERS } from '../../shared/catalog.ts';
import { reduceEvents } from '../../shared/protocols.ts';
import type { RunRecord } from '../../shared/types.ts';
import { api } from '../api.ts';
import { useApp } from '../app.tsx';
import { compareHref, navigate, useRoute } from '../router.ts';
import { EmptyHint, ErrorBox, JsonBlock, Spinner, StatusBadge, Tabs, fmtTime, fmtMs } from '../ui.tsx';
import { EventList, MetricsPanel } from '../lab/inspector.tsx';
import { OutputView } from '../lab/outputs.tsx';
import { RealtimeRecording } from '../lab/recording.tsx';
import { Page, ArtifactGallery, downloadJson, runLink } from './common.tsx';

export function RunsPage() {
  const { toast, refreshEvidence } = useApp();
  const route = useRoute();
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [q, setQ] = useState(() => route.query.get('q') ?? '');
  const [provider, setProvider] = useState(() => route.query.get('provider') ?? '');
  const [starred, setStarred] = useState(() => route.query.get('starred') === '1');
  const [selected, setSelected] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(() => Math.max(0, Math.floor(Number(route.query.get('offset')) || 0)));
  const [hasNext, setHasNext] = useState(false);
  const requestSeq = useRef(0);
  useEffect(() => {
    const query = new URLSearchParams();
    if (q) query.set('q', q);
    if (provider) query.set('provider', provider);
    if (starred) query.set('starred', '1');
    if (offset) query.set('offset', String(offset));
    const suffix = query.toString();
    window.history.replaceState(window.history.state, '', `#/runs${suffix ? `?${suffix}` : ''}`);
  }, [q, provider, starred, offset]);
  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    setLoading(true);
    try {
      const rows = await api.runs({ limit: 51, offset, q, providerId: provider, starred });
      if (seq !== requestSeq.current) return;
      if (!rows.length && offset > 0) {
        setOffset(Math.max(0, offset - 50));
        return;
      }
      setRuns(rows.slice(0, 50));
      setHasNext(rows.length > 50);
      setError('');
    } catch (e: any) {
      if (seq === requestSeq.current) setError(e.message);
    } finally {
      if (seq === requestSeq.current) setLoading(false);
    }
  }, [q, provider, starred, offset]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);
  async function remove(r: RunRecord) {
    if (!confirm(`删除实验记录「${r.title}」？记录无法撤销；素材和生成产物会保留在素材库，可单独清理。`)) return;
    try {
      await api.deleteRun(r.id);
      setSelected((s) => s.filter((id) => id !== r.id));
      await load();
      await refreshEvidence();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  }
  return (
    <Page
      title="实验记录"
      description="真实请求的输入、原生参数、流式事件和产物保存在本机。选择 2–4 条记录可以并排回看，不会重新调用 API。"
      actions={
        <button className="btn-outline" onClick={load}>
          刷新记录
        </button>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="input min-w-56 flex-1"
          value={q}
          onChange={(e) => {
            requestSeq.current++;
            setQ(e.target.value);
            setOffset(0);
          }}
          placeholder="搜索标题 / 模型 / 备注…"
          aria-label="搜索实验记录"
        />
        <select
          className="input w-48"
          value={provider}
          onChange={(e) => {
            requestSeq.current++;
            setProvider(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">所有服务商</option>
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={starred}
            onChange={(e) => {
              requestSeq.current++;
              setStarred(e.target.checked);
              setOffset(0);
            }}
          />
          只看加星
        </label>
      </div>
      {!!selected.length && (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-violet-700 bg-violet-950/20 p-3 text-xs text-zinc-300">
          <span>已选择 {selected.length} / 4 条</span>
          <a
            className={`btn-primary ${selected.length < 2 ? 'pointer-events-none opacity-40' : ''}`}
            href={compareHref({ runs: selected })}
          >
            并排查看
          </a>
          <button
            className="btn-ghost"
            onClick={async () => {
              try {
                const full = await Promise.all(selected.map((id) => api.run(id)));
                downloadJson(full, `experiments-${Date.now()}.json`);
              } catch (e: any) {
                toast(e.message, 'err');
              }
            }}
          >
            导出所选 JSON
          </button>
          <button className="btn-ghost" onClick={() => setSelected([])}>
            清空选择
          </button>
        </div>
      )}
      {error && <ErrorBox error={{ title: '加载记录失败', hints: [error] }} />}
      {loading ? (
        <Spinner />
      ) : !runs.length ? (
        <EmptyHint>
          没有匹配的记录。
          <a className="text-violet-300" href="#/explore">
            进入探索，开始实验。
          </a>
        </EmptyHint>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-zinc-500">
              <tr>
                {['选择', '实验 / 时间', '服务 / 模型', '状态', '总耗时', '分组', '操作'].map((x) => (
                  <th className="px-3 py-3 font-medium" key={x}>
                    {x}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-zinc-800 hover:bg-zinc-900/50">
                  <td className="px-3 py-3">
                    <input
                      type="checkbox"
                      aria-label={`选择 ${r.title}`}
                      checked={selected.includes(r.id)}
                      onChange={(e) => {
                        if (e.target.checked && selected.length >= 4) {
                          toast('最多并排对比 4 条记录', 'err');
                          return;
                        }
                        setSelected((s) => (e.target.checked ? [...s, r.id] : s.filter((id) => id !== r.id)));
                      }}
                    />
                  </td>
                  <td className="max-w-sm px-3 py-3">
                    <a className="text-sm text-violet-300 hover:underline" href={`#/runs/${r.id}`}>
                      {r.starred ? '★ ' : ''}
                      {r.title}
                    </a>
                    <p className="mt-1 text-zinc-500">{fmtTime(r.createdAt)}</p>
                  </td>
                  <td className="mono px-3 py-3 text-zinc-400">
                    {r.providerId}
                    <p className="mt-1 break-all">{r.model ?? '—'}</p>
                  </td>
                  <td className="px-3 py-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="px-3 py-3 text-zinc-400">{fmtMs(r.metrics?.totalMs)}</td>
                  <td className="px-3 py-3">
                    {r.groupId && (
                      <a className="text-violet-300" href={compareHref({ group: r.groupId })}>
                        对比分组 →
                      </a>
                    )}
                  </td>
                  <td className="px-3 py-3">
                    <a className="btn-ghost" href={runLink(r)}>
                      复用
                    </a>
                    <button
                      className="btn-ghost text-rose-300"
                      disabled={r.status === 'running'}
                      onClick={() => remove(r)}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="mt-3 text-xs text-zinc-600">
            显示匹配记录 {offset + 1}–{offset + runs.length}。搜索在所有记录中执行，不限当前页。
          </p>
        </div>
      )}
      <div className="flex items-center gap-3 text-xs text-zinc-400">
        <button
          className="btn-outline"
          disabled={loading || offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 50))}
        >
          上一页
        </button>
        <span>第 {Math.floor(offset / 50) + 1} 页 · 每页 50 条</span>
        <button className="btn-outline" disabled={loading || !hasNext} onClick={() => setOffset(offset + 50)}>
          下一页
        </button>
      </div>
    </Page>
  );
}

export function RunDetailPage({ id }: { id: string }) {
  const { toast, refreshEvidence } = useApp();
  const [run, setRun] = useState<RunRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notes, setNotes] = useState('');
  const [title, setTitle] = useState('');
  const [tab, setTab] = useState('output');
  const load = useCallback(async () => {
    try {
      const r = await api.run(id);
      setRun(r);
      setNotes(r.notes ?? '');
      setTitle(r.title);
      setError('');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [id]);
  useEffect(() => {
    void load();
  }, [load]);
  async function patch(b: any) {
    try {
      const r = await api.updateRun(id, b);
      setRun(r);
      toast('记录已保存');
    } catch (e: any) {
      toast(e.message, 'err');
    }
  }
  if (loading)
    return (
      <Page title="载入实验记录">
        <Spinner />
      </Page>
    );
  if (!run)
    return (
      <Page title="无法加载记录">
        <ErrorBox error={{ title: error || '记录不存在', hints: [] }} />
        <a href="#/runs">返回实验记录</a>
      </Page>
    );
  const op = getOperation(run.operationId);
  const view = run.response?.view ?? reduceEvents(op?.protocol, run.events ?? []);
  return (
    <Page
      title={run.title}
      description={`${fmtTime(run.createdAt)} · ${run.providerId} · ${run.model ?? '无模型'} · HTTP ${run.httpStatus ?? '未知'}`}
      actions={
        <div className="flex flex-wrap gap-2">
          <button className="btn-outline" onClick={() => patch({ starred: !run.starred })}>
            {run.starred ? '★ 已加星' : '☆ 加星'}
          </button>
          <a className="btn-primary" href={runLink(run)}>
            载入为新实验
          </a>
          <button className="btn-outline" onClick={() => downloadJson(run, `experiment-${id}.json`)}>
            导出脱敏 JSON
          </button>
        </div>
      }
    >
      <div className="flex flex-wrap items-center gap-3">
        <StatusBadge status={run.status} />
        <span className="text-xs text-zinc-500 mono">ID {run.id}</span>
        {run.parentId && (
          <a className="text-xs text-violet-300" href={`#/runs/${run.parentId}`}>
            来源实验 →
          </a>
        )}
        {run.groupId && (
          <a className="btn-outline" href={compareHref({ group: run.groupId })}>
            查看整个对比分组
          </a>
        )}
        {run.taskId && (
          <a className="btn-outline" href="#/tasks">
            关联异步任务 →
          </a>
        )}
        {run.status === 'running' && (
          <button className="btn-outline" onClick={load}>
            刷新状态
          </button>
        )}
      </div>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          ['output', '结果'],
          ['input', '输入与参数'],
          ['request', '实际请求'],
          ['response', '原始响应'],
          ['events', `事件 (${run.events?.length ?? 0})`],
          ['metrics', '指标'],
          ['notes', '备注'],
        ]}
      />
      {tab === 'output' &&
        (op?.realtime ? (
          <RealtimeRecording events={run.events ?? []} outputRate={op.realtime.outputRate} />
        ) : op ? (
          <OutputView
            op={op}
            input={run.state?.input ?? run.input ?? {}}
            view={view}
            response={run.response}
            artifacts={run.artifacts ?? []}
            running={false}
            error={run.error}
            taskId={run.taskId ?? undefined}
            hasEvents={!!run.events?.length}
          />
        ) : (
          <>
            <JsonBlock value={run.response} />
            <ArtifactGallery assets={run.artifacts ?? []} />
            <ErrorBox error={run.error} />
          </>
        ))}
      {tab === 'input' && <JsonBlock value={run.state ?? run.input} />}{' '}
      {tab === 'request' && <JsonBlock value={run.request} />}{' '}
      {tab === 'response' && <JsonBlock value={run.response} />}{' '}
      {tab === 'events' && <EventList events={run.events ?? []} />}{' '}
      {tab === 'metrics' && <MetricsPanel metrics={run.metrics ?? null} view={view} />}
      {tab === 'notes' && (
        <div className="card space-y-4 p-5">
          <label className="block">
            <span className="label">实验标题</span>
            <input className="input mt-2" value={title} onChange={(e) => setTitle(e.target.value)} />
          </label>
          <label className="block">
            <span className="label">实验备注</span>
            <textarea
              className="input mt-2 min-h-40"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="观察到的差异、参数效果与后续实验想法…"
            />
          </label>
          <button className="btn-primary" onClick={() => patch({ title, notes })}>
            保存标题与备注
          </button>
          <button
            className="btn-ghost ml-3 text-rose-300"
            disabled={run.status === 'running'}
            onClick={async () => {
              if (!confirm('永久删除这条实验记录？')) return;
              try {
                await api.deleteRun(id);
                await refreshEvidence();
                navigate('/runs');
              } catch (e: any) {
                toast(e.message, 'err');
              }
            }}
          >
            删除记录
          </button>
        </div>
      )}
    </Page>
  );
}
