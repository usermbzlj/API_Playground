import { useCallback, useEffect, useState } from 'react';
import { api } from './api.ts';
import { useApp } from './app.tsx';
import { labHref } from './router.ts';
import { CATEGORY_LABELS } from '../shared/features.ts';
import type { AssetInfo, ConnectionInfo, FeatureDef, RunRecord, TaskRecord, TraceEvent } from '../shared/types.ts';
import { Chip, CopyButton, EmptyHint, JsonBlock, Modal, Spinner, StatusBadge, VerificationChip, WORKBENCH_LABEL, fmtMs, fmtTime } from './ui.tsx';

// ============================ 连接 ============================

export function ConnectionsPage() {
  const { catalog, connections, refreshConnections, toast } = useApp();
  const [editing, setEditing] = useState<ConnectionInfo | 'new' | null>(null);
  const [modelsFor, setModelsFor] = useState<ConnectionInfo | null>(null);
  const [modelsData, setModelsData] = useState<any>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  async function test(id: string) {
    try {
      const r = await api.testConnection(id);
      toast(r.message, r.ok ? 'ok' : 'err');
      await refreshConnections();
    } catch (e: any) {
      toast(e.message, 'err');
    }
  }

  async function loadModels(conn: ConnectionInfo) {
    setModelsFor(conn);
    setModelsData(null);
    setLoadingModels(true);
    try {
      const r = await api.listRemoteModels(conn.id);
      setModelsData(r.raw);
    } catch (e: any) {
      setModelsData({ error: e.message });
    } finally {
      setLoadingModels(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">连接</h1>
          <p className="mt-1 text-xs text-zinc-500">管理各厂商的 API Key 与 Base URL。密钥保存在本机 data/secrets.json，不会进入实验记录与日志。</p>
        </div>
        <button className="btn-primary" onClick={() => setEditing('new')}>
          + 添加连接
        </button>
      </header>

      {connections.length === 0 ? (
        <EmptyHint>
          还没有连接。添加一个 API Key 后即可在实验台发起真实调用。
          <br />
          没有 Key 也可以先逛「探索」页了解各厂商能力。
        </EmptyHint>
      ) : (
        <div className="space-y-2">
          {connections.map((c) => {
            const provider = catalog?.providers.find((p) => p.id === c.providerId);
            return (
              <div key={c.id} className="card flex flex-wrap items-center gap-3 p-3">
                <div className="min-w-40 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-zinc-100">{c.label}</span>
                    <Chip tone="violet">{provider?.name ?? c.providerId}</Chip>
                  </div>
                  <div className="mono mt-1 text-[11px] text-zinc-500">
                    {c.baseUrl} · Key {c.keyPreview}
                    {Object.keys(c.extra).length > 0 && ` · ${Object.entries(c.extra).map(([k, v]) => `${k}=${v}`).join(' ')}`}
                  </div>
                  {c.lastTest && (
                    <div className={`mt-0.5 text-[11px] ${c.lastTest.ok ? 'text-emerald-400' : 'text-rose-400'}`}>
                      上次测试（{fmtTime(c.lastTest.at)}）：{c.lastTest.message}
                    </div>
                  )}
                </div>
                <div className="flex gap-1.5">
                  <button className="btn-outline text-xs" onClick={() => test(c.id)}>
                    测试
                  </button>
                  {provider?.modelsPath && (
                    <button className="btn-outline text-xs" onClick={() => loadModels(c)}>
                      拉取模型列表
                    </button>
                  )}
                  <button className="btn-outline text-xs" onClick={() => setEditing(c)}>
                    编辑
                  </button>
                  <button
                    className="btn-ghost text-xs text-rose-400"
                    onClick={async () => {
                      if (!confirm(`删除连接「${c.label}」？密钥将一并删除。`)) return;
                      await api.deleteConnection(c.id);
                      toast('已删除');
                      await refreshConnections();
                    }}
                  >
                    删除
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {editing && (
        <ConnectionModal
          conn={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refreshConnections();
            toast('已保存');
          }}
        />
      )}

      {modelsFor && (
        <Modal title={`远程模型列表 · ${modelsFor.label}`} wide onClose={() => setModelsFor(null)}>
          {loadingModels ? (
            <div className="flex items-center gap-2 text-sm text-zinc-400">
              <Spinner /> 正在请求 {modelsFor.baseUrl}
              {catalog?.providers.find((p) => p.id === modelsFor.providerId)?.modelsPath} …
            </div>
          ) : (
            <>
              <p className="mb-2 text-xs text-zinc-500">以下为厂商返回的原始内容（已脱敏）。模型可用性以账号实际权限为准。</p>
              <JsonBlock value={modelsData} max={60000} />
            </>
          )}
        </Modal>
      )}
    </div>
  );
}

function ConnectionModal({ conn, onClose, onSaved }: { conn: ConnectionInfo | null; onClose: () => void; onSaved: () => void }) {
  const { catalog, toast } = useApp();
  const providers = catalog?.providers ?? [];
  const [providerId, setProviderId] = useState(conn?.providerId ?? providers[0]?.id ?? '');
  const provider = providers.find((p) => p.id === providerId);
  // 编辑时如 Base URL 不在厂商预设列表中，按「自定义」展示当前值。
  const matchedBase = conn ? provider?.baseUrls.find((b) => b.url === conn.baseUrl) : undefined;
  const [label, setLabel] = useState(conn?.label ?? '');
  const [baseUrlId, setBaseUrlId] = useState(matchedBase?.id ?? (conn ? '__custom' : provider?.baseUrls[0]?.id ?? ''));
  const [customBase, setCustomBase] = useState(matchedBase ? '' : (conn?.baseUrl ?? ''));
  const [apiKey, setApiKey] = useState('');
  const [extra, setExtra] = useState<Record<string, string>>(conn?.extra ?? {});
  const [saving, setSaving] = useState(false);

  const baseUrl = customBase.trim() || provider?.baseUrls.find((b) => b.id === baseUrlId)?.url || '';

  async function save() {
    if (!providerId) return;
    if (!apiKey && !conn) {
      toast('请输入 API Key', 'err');
      return;
    }
    setSaving(true);
    try {
      const payload: any = { providerId, label: label.trim() || provider?.name, baseUrl, extra };
      if (apiKey) payload.apiKey = apiKey;
      if (conn) await api.updateConnection(conn.id, payload);
      else await api.createConnection(payload);
      onSaved();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={conn ? `编辑连接 · ${conn.label}` : '添加连接'} onClose={onClose}>
      <div className="space-y-3">
        <label className="block">
          <span className="label">厂商</span>
          <select
            className="input mt-1"
            value={providerId}
            onChange={(e) => {
              setProviderId(e.target.value);
              const p = providers.find((x) => x.id === e.target.value);
              setBaseUrlId(p?.baseUrls[0]?.id ?? '');
              setCustomBase(''); // 防止上一个厂商的自定义 Base URL 残留
            }}
            disabled={!!conn}
          >
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}（{p.kind === 'official' ? '官方' : p.kind === 'aggregator' ? '聚合' : '云平台'}）
              </option>
            ))}
          </select>
        </label>
        <label className="block">
          <span className="label">备注名</span>
          <input className="input mt-1" value={label} onChange={(e) => setLabel(e.target.value)} placeholder={provider?.name} />
        </label>
        <label className="block">
          <span className="label">Base URL</span>
          <select className="input mt-1" value={baseUrlId} onChange={(e) => setBaseUrlId(e.target.value)}>
            {(provider?.baseUrls ?? []).map((b) => (
              <option key={b.id} value={b.id}>
                {b.label} · {b.url}
                {b.note ? `（${b.note}）` : ''}
              </option>
            ))}
            <option value="__custom">自定义…</option>
          </select>
          {baseUrlId === '__custom' && (
            <input className="input mt-1 mono" value={customBase} onChange={(e) => setCustomBase(e.target.value)} placeholder="https://…" />
          )}
        </label>
        <label className="block">
          <span className="label">API Key</span>
          <input
            className="input mt-1 mono"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={conn ? '留空表示不修改' : 'sk-…'}
          />
        </label>
        {(provider?.auth.extraFields ?? []).map((f) => (
          <label key={f.key} className="block">
            <span className="label">
              {f.label}
              {f.required ? ' *' : '（可选）'}
            </span>
            <input className="input mt-1" value={extra[f.key] ?? ''} onChange={(e) => setExtra({ ...extra, [f.key]: e.target.value })} placeholder={f.placeholder} />
          </label>
        ))}
        {provider?.docsUrl && (
          <p className="text-[11px] text-zinc-500">
            文档：
            <a className="text-violet-400 underline" href={provider.docsUrl} target="_blank" rel="noreferrer">
              {provider.docsUrl}
            </a>
          </p>
        )}
        <div className="flex justify-end gap-2 pt-2">
          <button className="btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saving ? <Spinner /> : '保存'}
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ============================ 探索 ============================

export function ExplorePage() {
  const { catalog } = useApp();
  const [tab, setTab] = useState<'provider' | 'feature'>('provider');
  if (!catalog) return null;

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-5">
      <header>
        <h1 className="text-lg font-semibold text-zinc-100">探索</h1>
        <p className="mt-1 text-xs text-zinc-500">按厂商逛，或按能力/玩法逛。所有能力标注了验证状态——「文档支持」表示尚未用真实 Key 实测。</p>
      </header>
      <div className="flex gap-2">
        <button className={tab === 'provider' ? 'btn-primary' : 'btn-outline'} onClick={() => setTab('provider')}>
          按厂商 / 模型
        </button>
        <button className={tab === 'feature' ? 'btn-primary' : 'btn-outline'} onClick={() => setTab('feature')}>
          按能力 / 玩法
        </button>
      </div>
      {tab === 'provider' ? <ProviderBrowse /> : <FeatureBrowse />}
    </div>
  );
}

function ProviderBrowse() {
  const { catalog } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="space-y-3">
      {(catalog?.providers ?? []).map((p) => {
        const ops = (catalog?.operations ?? []).filter((o) => o.providerId === p.id);
        const expanded = open === p.id;
        return (
          <div key={p.id} className="card p-4">
            <div className="flex cursor-pointer items-start justify-between gap-3" onClick={() => setOpen(expanded ? null : p.id)}>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-base font-semibold text-zinc-100">{p.name}</span>
                  <Chip tone="violet">{p.kind === 'official' ? '官方' : p.kind === 'aggregator' ? '聚合' : '云平台'}</Chip>
                  <span className="text-[11px] text-zinc-500">{expanded ? '▾' : '▸'}</span>
                </div>
                <p className="mt-1 max-w-3xl text-xs leading-relaxed text-zinc-400">{p.description}</p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {(p.highlights ?? []).map((h) => (
                    <Chip key={h} tone="zinc">
                      {h}
                    </Chip>
                  ))}
                </div>
              </div>
              <div className="text-right text-[11px] text-zinc-500">
                <div>{p.models.length} 个模型</div>
                <div>{ops.length} 个实验</div>
              </div>
            </div>
            {expanded && (
              <div className="mt-4 space-y-4 border-t border-zinc-800 pt-3">
                <div className="flex flex-wrap gap-3 text-[11px] text-zinc-500">
                  {p.baseUrls.map((b) => (
                    <span key={b.id} className="mono">
                      {b.label}: {b.url}
                    </span>
                  ))}
                  {p.docsUrl && (
                    <a className="text-violet-400 underline" href={p.docsUrl} target="_blank" rel="noreferrer">
                      文档
                    </a>
                  )}
                  {p.pricingUrl && (
                    <a className="text-violet-400 underline" href={p.pricingUrl} target="_blank" rel="noreferrer">
                      定价
                    </a>
                  )}
                </div>
                {(p.notes ?? []).length > 0 && (
                  <ul className="list-disc space-y-1 pl-5 text-[11px] leading-relaxed text-amber-200/80">
                    {p.notes!.map((n) => (
                      <li key={n}>{n}</li>
                    ))}
                  </ul>
                )}
                <div>
                  <h3 className="label mb-1.5">模型</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs">
                      <thead className="text-zinc-500">
                        <tr>
                          <th className="py-1 pr-3 font-medium">ID</th>
                          <th className="py-1 pr-3 font-medium">说明</th>
                          <th className="py-1 pr-3 font-medium">上下文</th>
                          <th className="py-1 font-medium">验证</th>
                        </tr>
                      </thead>
                      <tbody className="text-zinc-300">
                        {p.models.map((m) => (
                          <tr key={m.id} className="border-t border-zinc-800/70">
                            <td className="mono py-1 pr-3">{m.id}</td>
                            <td className="py-1 pr-3 text-zinc-400">
                              {m.label}
                              {m.notes && <span className="text-zinc-500"> · {m.notes}</span>}
                            </td>
                            <td className="py-1 pr-3">{m.context ? `${Math.round(m.context / 1024)}K` : '—'}</td>
                            <td className="py-1">
                              <VerificationChip v={m.verification} />
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
                <div>
                  <h3 className="label mb-1.5">实验</h3>
                  <div className="space-y-1.5">
                    {ops.map((o) => (
                      <div key={o.id} className="flex flex-wrap items-center gap-2 rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2">
                        <span className="text-sm text-zinc-100">{o.title}</span>
                        <Chip>{WORKBENCH_LABEL[o.workbench] ?? o.workbench}</Chip>
                        <VerificationChip v={o.verification} />
                        <span className="flex-1 text-[11px] text-zinc-500">{o.summary}</span>
                        <a className="btn-primary text-xs" href={labHref(o.id)}>
                          进入实验台
                        </a>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function FeatureBrowse() {
  const { catalog } = useApp();
  const byCategory = new Map<string, FeatureDef[]>();
  for (const f of catalog?.features ?? []) {
    const list = byCategory.get(f.category) ?? [];
    list.push(f);
    byCategory.set(f.category, list);
  }
  return (
    <div className="space-y-5">
      {[...byCategory.entries()].map(([cat, features]) => (
        <section key={cat}>
          <h2 className="mb-2 text-sm font-semibold text-violet-300">{CATEGORY_LABELS[cat] ?? cat}</h2>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            {features.map((f) => {
              const ops = (catalog?.operations ?? []).filter((o) => o.features.includes(f.id));
              return (
                <div key={f.id} className="card p-3">
                  <div className="text-sm font-medium text-zinc-100">{f.name}</div>
                  <p className="mt-1 text-xs leading-relaxed text-zinc-400">{f.summary}</p>
                  {f.tips?.map((t) => (
                    <p key={t} className="mt-1 text-[11px] text-amber-200/80">
                      ⚠ {t}
                    </p>
                  ))}
                  {ops.length > 0 ? (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {ops.map((o) => (
                        <a key={o.id} href={labHref(o.id)} className="chip border-zinc-600 text-zinc-300 hover:border-violet-500 hover:text-violet-200">
                          {o.title}
                        </a>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-2 text-[11px] text-zinc-600">尚未接入实验（可在原始请求中手动尝试）</p>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ))}
    </div>
  );
}

// ============================ 实验记录 ============================

export function RunsPage() {
  const [runs, setRuns] = useState<RunRecord[]>([]);
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      setRuns(await api.runs({ limit: 200, q: q || undefined }));
    } finally {
      setLoading(false);
    }
  }, [q]);
  useEffect(() => {
    const t = setTimeout(load, 250);
    return () => clearTimeout(t);
  }, [load]);

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-5">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">实验记录</h1>
          <p className="mt-1 text-xs text-zinc-500">所有真实调用都会记录参数、原始请求/响应、事件流与耗时，可回看、加星、写备注。</p>
        </div>
        <input className="input w-56" placeholder="搜索标题 / 模型 / 备注…" value={q} onChange={(e) => setQ(e.target.value)} />
      </header>
      {loading ? (
        <div className="flex items-center gap-2 text-sm text-zinc-400">
          <Spinner /> 加载中…
        </div>
      ) : runs.length === 0 ? (
        <EmptyHint>还没有实验记录。去实验台发起第一次调用吧。</EmptyHint>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className="text-zinc-500">
              <tr>
                <th className="py-1.5 pr-3 font-medium">时间</th>
                <th className="py-1.5 pr-3 font-medium">标题</th>
                <th className="py-1.5 pr-3 font-medium">厂商</th>
                <th className="py-1.5 pr-3 font-medium">模型</th>
                <th className="py-1.5 pr-3 font-medium">状态</th>
                <th className="py-1.5 pr-3 font-medium">耗时</th>
                <th className="py-1.5 pr-3 font-medium">Tokens</th>
                <th className="py-1.5 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-t border-zinc-800/70 hover:bg-zinc-900/50">
                  <td className="py-1.5 pr-3 text-zinc-500">{fmtTime(r.createdAt)}</td>
                  <td className="py-1.5 pr-3">
                    <a className="text-violet-300 hover:underline" href={`#/runs/${r.id}`}>
                      {r.title}
                    </a>
                    {r.starred && <span className="ml-1 text-amber-400">★</span>}
                  </td>
                  <td className="py-1.5 pr-3 text-zinc-400">{r.providerId}</td>
                  <td className="mono py-1.5 pr-3 text-zinc-400">{r.model ?? '—'}</td>
                  <td className="py-1.5 pr-3">
                    <StatusBadge status={r.status} />
                  </td>
                  <td className="py-1.5 pr-3 text-zinc-400">{fmtMs(r.metrics?.totalMs)}</td>
                  <td className="py-1.5 pr-3 text-zinc-400">{String(r.metrics?.usage?.total_tokens ?? '—')}</td>
                  <td className="py-1.5">
                    <button
                      className="btn-ghost text-xs text-rose-400"
                      onClick={async () => {
                        if (!confirm('删除这条实验记录？')) return;
                        await api.deleteRun(r.id);
                        load();
                      }}
                    >
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export function RunDetailPage({ id }: { id: string }) {
  const { catalog } = useApp();
  const [run, setRun] = useState<RunRecord | null>(null);
  const [tab, setTab] = useState('overview');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.run(id);
      setRun(r);
      setNotes(r.notes ?? '');
    } catch (e: any) {
      alert(e.message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 p-10 text-sm text-zinc-400">
        <Spinner /> 加载中…
      </div>
    );
  }
  if (!run) return <div className="p-10 text-zinc-500">记录不存在</div>;

  const op = catalog?.operations.find((o) => o.id === run.operationId);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-lg font-semibold text-zinc-100">{run.title}</h1>
          <p className="mt-1 text-xs text-zinc-500">
            {fmtTime(run.createdAt)} · {run.providerId} · <span className="mono">{run.model ?? '—'}</span> · HTTP {run.httpStatus ?? '—'}
          </p>
        </div>
        <div className="flex gap-1.5">
          <button
            className="btn-outline text-xs"
            onClick={async () => {
              await api.updateRun(run.id, { starred: !run.starred });
              load();
            }}
          >
            {run.starred ? '★ 取消加星' : '☆ 加星'}
          </button>
          {run.operationId && (
            <a className="btn-outline text-xs" href={`${labHref(run.operationId)}${run.model ? `?model=${encodeURIComponent(run.model)}` : ''}`}>
              再次运行
            </a>
          )}
          <button
            className="btn-ghost text-xs text-rose-400"
            onClick={async () => {
              if (!confirm('删除这条实验记录？')) return;
              await api.deleteRun(run.id);
              location.hash = '#/runs';
            }}
          >
            删除
          </button>
        </div>
      </header>

      <div className="flex gap-2 border-b border-zinc-800 pb-2">
        {[
          ['overview', '概览'],
          ['request', '原生请求'],
          ['response', '响应'],
          ['events', `事件流 (${run.events?.length ?? 0})`],
          ['metrics', '指标'],
          ['artifacts', `产物 (${run.artifacts?.length ?? 0})`],
        ].map(([k, label]) => (
          <button key={k} className={tab === k ? 'btn-primary text-xs' : 'btn-ghost text-xs'} onClick={() => setTab(k)}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="space-y-3">
          <div className="card p-3">
            <h3 className="label mb-2">输入</h3>
            <JsonBlock value={run.input} />
          </div>
          <div className="card p-3">
            <h3 className="label mb-2">备注</h3>
            <textarea className="input min-h-20" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="记录一下这次实验的结论…" />
            <button
              className="btn-primary mt-2 text-xs"
              onClick={async () => {
                await api.updateRun(run.id, { notes });
                alert('已保存');
              }}
            >
              保存备注
            </button>
          </div>
          {op && (
            <p className="text-[11px] text-zinc-500">
              操作定义：{op.title}（{op.id}）
            </p>
          )}
        </div>
      )}
      {tab === 'request' && (
        <div className="space-y-2">
          <div className="flex justify-end">
            <CopyButton text={JSON.stringify(run.request?.body ?? {}, null, 2)} label="复制请求体（已脱敏）" />
          </div>
          <JsonBlock value={run.request} />
        </div>
      )}
      {tab === 'response' && <JsonBlock value={run.response} />}
      {tab === 'events' && <EventList events={run.events ?? []} />}
      {tab === 'metrics' && (
        <div className="space-y-3">
          <JsonBlock value={run.metrics} />
          {run.error && (
            <div className="rounded-md border border-rose-800 bg-rose-950/40 p-3 text-xs text-rose-200">
              <p className="font-medium">{run.error.title}</p>
              <ul className="mt-1 list-disc pl-5">
                {(run.error.hints ?? []).map((h: string) => (
                  <li key={h}>{h}</li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
      {tab === 'artifacts' && (
        <div className="space-y-2">
          {(run.artifacts ?? []).length === 0 ? (
            <EmptyHint>这次运行没有产物</EmptyHint>
          ) : (
            (run.artifacts as AssetInfo[]).map((a) => (
              <div key={a.id} className="card flex items-center gap-3 p-3">
                {a.kind === 'image' && <img src={a.url} className="max-h-40 rounded" alt={a.filename} />}
                {a.kind === 'audio' && <audio controls src={a.url} />}
                {a.kind === 'video' && <video controls src={a.url} className="max-h-60 rounded" />}
                <div className="text-xs text-zinc-400">
                  <div className="text-zinc-200">{a.filename}</div>
                  <div>
                    {a.mime} · {(a.size / 1024).toFixed(1)} KB
                  </div>
                  <a className="text-violet-400 underline" href={a.url} download={a.filename}>
                    下载
                  </a>
                </div>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

export function EventList({ events }: { events: TraceEvent[] }) {
  // 只渲染最近 100 条：长流式会话可能有上千条事件，全量渲染会卡死页面。
  const shown = events.slice(-100);
  return (
    <div className="space-y-2">
      {shown.length < events.length && <p className="text-[11px] text-zinc-600">仅显示最近 {shown.length} / {events.length} 条事件（完整记录已存入数据库）</p>}
      {shown.length === 0 && <EmptyHint>没有事件</EmptyHint>}
      {shown.map((ev, i) => (
        <div key={i} className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2">
          <div className="mb-1 flex items-center gap-2 text-[11px]">
            <Chip tone={ev.type === 'error' ? 'red' : ev.type === 'done' ? 'green' : 'zinc'}>{ev.type}</Chip>
            <span className="mono text-zinc-500">{ev.t} ms</span>
          </div>
          <JsonBlock value={ev.data} max={8000} />
        </div>
      ))}
    </div>
  );
}

// ============================ 异步任务 ============================

export function TasksPage() {
  const { toast } = useApp();
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const load = useCallback(async () => {
    try {
      setTasks(await api.tasks());
    } catch {
      /* 服务重启时静默 */
    }
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <div className="mx-auto max-w-5xl space-y-4 p-5">
      <header>
        <h1 className="text-lg font-semibold text-zinc-100">异步任务</h1>
        <p className="mt-1 text-xs text-zinc-500">视频生成等异步任务由本地服务持续轮询，刷新页面不会丢失。完成后产物保存在对应实验记录中。</p>
      </header>
      {tasks.length === 0 ? (
        <EmptyHint>还没有异步任务</EmptyHint>
      ) : (
        <div className="space-y-2">
          {tasks.map((t) => (
            <div key={t.id} className="card p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-zinc-100">{t.title ?? t.operationId}</span>
                <StatusBadge status={t.status} />
                <span className="mono text-[11px] text-zinc-500">远程 ID {t.remoteId}</span>
                {t.remoteStatus && <Chip>{t.remoteStatus}</Chip>}
                <span className="flex-1" />
                <button
                  className="btn-outline text-xs"
                  onClick={async () => {
                    await api.pollTask(t.id);
                    load();
                  }}
                >
                  立即轮询
                </button>
                {['pending', 'running'].includes(t.status) && (
                  <button
                    className="btn-ghost text-xs text-rose-400"
                    onClick={async () => {
                      const r = await api.cancelTask(t.id);
                      toast(r.message, r.ok ? 'ok' : 'err');
                      load();
                    }}
                  >
                    取消
                  </button>
                )}
                <a className="btn-ghost text-xs" href={`#/runs/${t.runId}`}>
                  查看记录
                </a>
              </div>
              {t.progress != null && (
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                  <div className="h-full bg-violet-500" style={{ width: `${Math.min(100, t.progress)}%` }} />
                </div>
              )}
              {t.error && <p className="mt-1 text-[11px] text-rose-300">{t.error}</p>}
              <p className="mt-1 text-[11px] text-zinc-600">
                创建于 {fmtTime(t.createdAt)} · 已轮询 {t.pollCount} 次
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
