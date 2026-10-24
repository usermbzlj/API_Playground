import { useEffect, useMemo, useState } from 'react';
import {
  ArrowRight,
  ArrowUpRight,
  AudioLines,
  Box,
  Braces,
  BrainCircuit,
  Check,
  ChevronRight,
  Database,
  Image,
  Layers3,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react';
import { PROVIDERS, OPERATIONS, BUILTIN_PRESETS, getProvider } from '../../shared/catalog.ts';
import { FEATURES } from '../../shared/features.ts';
import type { ModelDef, ProviderDef } from '../../shared/types.ts';
import { providerHref, featureHref, labHref, useRoute } from '../router.ts';
import { useApp } from '../app.tsx';
import { Chip, EmptyHint, EvidenceChip, KIND_LABEL, Tabs, VerificationChip, WORKBENCH_LABEL } from '../ui.tsx';
import { OperationCard, Page } from './common.tsx';
import { ATLAS_ROUTES, routeMatchesOperation } from '../components/atlas.ts';
import { WorkspaceResume } from '../components/workspace-resume.tsx';

const ROUTE_ICONS = [BrainCircuit, Braces, AudioLines, Image, Box, Database];
const CATEGORY_MAP = new Map(FEATURES.map((f) => [f.id, f.category]));
type DiscoveryTab = 'atlas' | 'operations' | 'models' | 'providers' | 'connections';

export function ExplorePage() {
  const { connections, evidence } = useApp();
  const route = useRoute();
  const validTab = (value: string | null): DiscoveryTab =>
    ['atlas', 'operations', 'models', 'providers', 'connections'].includes(value ?? '')
      ? (value as DiscoveryTab)
      : 'atlas';
  const [tab, setTab] = useState<DiscoveryTab>(() => validTab(route.query.get('tab')));
  const [q, setQ] = useState(() => route.query.get('q') ?? '');
  const [modality, setModality] = useState(() => route.query.get('route') ?? '');
  const [kind, setKind] = useState(() => route.query.get('kind') ?? '');
  const [providerKind, setProviderKind] = useState(() => route.query.get('providerKind') ?? '');
  const [connectedOnly, setConnectedOnly] = useState(() => route.query.get('connected') === '1');
  useEffect(() => {
    const query = new URLSearchParams();
    if (tab !== 'atlas') query.set('tab', tab);
    for (const [key, value] of Object.entries({ q, route: modality, kind, providerKind }))
      if (value) query.set(key, value);
    if (connectedOnly) query.set('connected', '1');
    const suffix = query.toString();
    window.history.replaceState(window.history.state, '', `#/explore${suffix ? `?${suffix}` : ''}`);
  }, [tab, q, modality, kind, providerKind, connectedOnly]);
  useEffect(() => {
    const onHash = () => {
      const [path, search = ''] = window.location.hash.slice(1).split('?');
      if (path !== '/explore') return;
      const query = new URLSearchParams(search);
      setTab(validTab(query.get('tab')));
      setQ(query.get('q') ?? '');
      setModality(query.get('route') ?? '');
      setKind(query.get('kind') ?? '');
      setProviderKind(query.get('providerKind') ?? '');
      setConnectedOnly(query.get('connected') === '1');
    };
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  const search = q.trim().toLocaleLowerCase();
  const selectedRoute = ATLAS_ROUTES.find((r) => r.id === modality);
  const matchesSearch = (text: string) => !search || text.toLocaleLowerCase().includes(search);
  const scopedOps = useMemo(
    () =>
      OPERATIONS.filter(
        (o) =>
          (!kind || o.workbench === kind) &&
          (!selectedRoute || routeMatchesOperation(selectedRoute, o, CATEGORY_MAP)) &&
          (!connectedOnly || connections.some((c) => c.providerId === o.providerId)),
      ),
    [kind, selectedRoute, connectedOnly, connections],
  );
  const ops = scopedOps.filter((o) =>
    matchesSearch(`${o.title} ${o.summary} ${o.providerId} ${o.features.join(' ')} ${o.defaultModel ?? ''}`),
  );
  const providers = PROVIDERS.filter(
    (p) =>
      (!providerKind || p.kind === providerKind) &&
      (!connectedOnly || connections.some((c) => c.providerId === p.id)) &&
      matchesSearch(`${p.name} ${p.description} ${p.models.map((m) => `${m.id} ${m.developer ?? ''}`).join(' ')}`),
  );
  const modelRows = PROVIDERS.flatMap((provider) => provider.models.map((model) => ({ provider, model }))).filter(
    ({ provider, model }) =>
      (!providerKind || provider.kind === providerKind) &&
      (!connectedOnly || connections.some((c) => c.providerId === provider.id)) &&
      (!selectedRoute ||
        OPERATIONS.some(
          (o) =>
            o.providerId === provider.id &&
            (!o.models || o.models.includes(model.id)) &&
            routeMatchesOperation(selectedRoute, o, CATEGORY_MAP),
        )) &&
      matchesSearch(
        `${provider.name} ${model.id} ${model.label ?? ''} ${model.developer ?? ''} ${model.capabilities?.join(' ') ?? ''}`,
      ),
  );
  const connected = connections.filter((c) =>
    matchesSearch(`${c.label} ${c.baseUrl} ${c.extra.sourceTitle ?? ''} ${c.extra.defaultModel ?? ''}`),
  );
  const atlasRoutes = ATLAS_ROUTES.filter(
    (r) =>
      (!modality || r.id === modality) &&
      (!search ||
        `${r.title} ${r.description} ${r.features.join(' ')}`.toLowerCase().includes(search) ||
        ops.some((o) => routeMatchesOperation(r, o, CATEGORY_MAP))) &&
      (!connectedOnly || scopedOps.some((o) => routeMatchesOperation(r, o, CATEGORY_MAP))),
  );
  const evidenceOps = new Set(evidence.filter((e) => e.ok > 0).map((e) => e.operationId)).size;
  const filteredFeatures = FEATURES.filter(
    (f) =>
      (!selectedRoute || (selectedRoute.categories as readonly string[]).includes(f.category)) &&
      matchesSearch(`${f.name} ${f.id} ${f.summary}`),
  );
  const reset = () => {
    setQ('');
    setModality('');
    setKind('');
    setProviderKind('');
    setConnectedOnly(false);
  };

  return (
    <Page title="实验工作区" description="继续上次实验，或从一个原生能力开始。">
      <WorkspaceResume />
      <details className="atlas-hero overflow-hidden rounded-xl border border-zinc-700/60">
        <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-5 py-4 text-xs text-zinc-400">
          <span>
            探索 {OPERATIONS.length} 个原生操作 · {PROVIDERS.length} 个服务适配
          </span>
          <span>
            {connections.length} 个本机连接 · {evidenceOps} 个操作有成功记录{' '}
            <span className="ml-2 text-violet-300">了解工作区 ▾</span>
          </span>
        </summary>
        <section className="relative px-5 py-5 md:px-6">
          <div className="prism-orbit" aria-hidden="true">
            <span />
            <span />
            <span />
          </div>
          <div className="relative z-10 max-w-3xl">
            <p className="eyebrow mb-3 flex items-center gap-2 text-violet-300">
              <span className="h-1.5 w-1.5 rounded-full bg-violet-300" /> PRISMLAB · NATIVE API PLAYGROUND
            </p>
            <h2 className="max-w-xl text-xl font-semibold leading-tight tracking-tight text-white md:text-2xl">
              探索模型的原生能力
            </h2>
            <p className="mt-4 max-w-xl text-sm leading-7 text-zinc-400">
              从代码中间补全到声音、视频与 3D，把每家 API
              值得玩的特性展开。保留原生参数，追溯每次请求，让实验可以重做、可以比较。
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <a className="btn-primary min-h-10 px-4" href="#/connections">
                添加 API 连接 <ArrowUpRight size={15} />
              </a>
              <a className="btn-outline min-h-10 border-zinc-600/70 px-4" href="#/bench">
                性能评测 <ArrowRight size={15} />
              </a>
            </div>
          </div>
          <div className="relative z-10 mt-8 grid grid-cols-2 gap-y-5 border-t border-zinc-700/50 pt-5 sm:grid-cols-4">
            {[
              [OPERATIONS.length, '原生操作'],
              [PROVIDERS.length, '服务适配'],
              [connections.length, '本机连接'],
              [evidenceOps, '有本机成功记录的操作'],
            ].map(([value, label]) => (
              <div key={label} className="pr-3">
                <strong className="block text-2xl font-medium tabular-nums text-zinc-100">{value}</strong>
                <span className="mt-1 block text-[11px] text-zinc-500">{label}</span>
              </div>
            ))}
          </div>
        </section>
      </details>

      <div className="atlas-discovery space-y-4">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={[
            ['atlas', '能力图谱'],
            ['operations', '全部实验'],
            ['models', '四层模型矩阵'],
            ['providers', 'API 服务商'],
            ['connections', `我的账户 · ${connections.length}`],
          ]}
        />
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 flex-1 basis-64">
            <Search
              size={16}
              className="pointer-events-none absolute top-1/2 left-3.5 -translate-y-1/2 text-zinc-500"
            />
            <input
              type="search"
              className="input min-h-11 pl-10"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="搜索 FIM、推理、语音、模型或服务商…"
              aria-label="搜索探索目录"
            />
          </div>
          {(tab === 'providers' || tab === 'models') && (
            <select
              aria-label="筛选服务类型"
              className="input min-h-11 w-auto max-w-full"
              value={providerKind}
              onChange={(e) => setProviderKind(e.target.value)}
            >
              <option value="">全部服务类型</option>
              {Object.entries(KIND_LABEL).map(([id, label]) => (
                <option key={id} value={id}>
                  {label}
                </option>
              ))}
            </select>
          )}
          {tab === 'operations' && (
            <select
              aria-label="筛选实验类型"
              className="input min-h-11 w-auto max-w-full"
              value={kind}
              onChange={(e) => setKind(e.target.value)}
            >
              <option value="">全部实验类型</option>
              {[...new Set(OPERATIONS.map((o) => o.workbench))].map((k) => (
                <option key={k} value={k}>
                  {WORKBENCH_LABEL[k] ?? k}
                </option>
              ))}
            </select>
          )}
          {tab !== 'connections' && (
            <label className="flex min-h-11 shrink-0 cursor-pointer items-center gap-2 text-xs text-zinc-400">
              <input type="checkbox" checked={connectedOnly} onChange={(e) => setConnectedOnly(e.target.checked)} />
              只看已有连接
            </label>
          )}
          {(q || modality || kind || providerKind || connectedOnly) && (
            <button className="btn-ghost text-xs" onClick={reset}>
              <X size={14} />
              重置筛选
            </button>
          )}
        </div>
        {tab !== 'connections' && tab !== 'providers' && (
          <div role="group" aria-label="按能力路线筛选" className="flex flex-wrap gap-2">
            <button
              aria-pressed={!modality}
              className={`atlas-filter ${!modality ? 'is-active' : ''}`}
              onClick={() => setModality('')}
            >
              <SlidersHorizontal size={13} />
              全部能力
            </button>
            {ATLAS_ROUTES.map((r, i) => {
              const Icon = ROUTE_ICONS[i];
              return (
                <button
                  key={r.id}
                  aria-pressed={modality === r.id}
                  onClick={() => setModality(r.id)}
                  className={`atlas-filter ${modality === r.id ? 'is-active' : ''}`}
                >
                  <Icon size={13} />
                  {r.title}
                </button>
              );
            })}
          </div>
        )}
      </div>

      {tab === 'atlas' && (
        <>
          <div className="flex flex-wrap items-end justify-between gap-3">
            <div>
              <p className="eyebrow text-zinc-500">CHOOSE AN EXPERIMENT</p>
              <h2 className="mt-2 text-lg font-semibold text-zinc-100">从一个好奇的问题开始</h2>
            </div>
            <button className="btn-ghost text-xs text-violet-300" onClick={() => setTab('operations')}>
              查看全部 {ops.length} 个实验 <ArrowRight size={14} />
            </button>
          </div>
          {atlasRoutes.length ? (
            <div className="grid gap-4 xl:grid-cols-2">
              {atlasRoutes.map((route) => {
                const index = ATLAS_ROUTES.indexOf(route);
                const Icon = ROUTE_ICONS[index];
                const routeSearchMatch = matchesSearch(
                  `${route.title} ${route.description} ${route.features.join(' ')}`,
                );
                const routeOps = (routeSearchMatch ? scopedOps : ops).filter((o) =>
                  routeMatchesOperation(route, o, CATEGORY_MAP),
                );
                const rankedOps = [...routeOps].sort((a, b) => {
                  const score = (id: string, providerId: string) =>
                    (connections.some((c) => c.providerId === providerId) ? 10 : 0) +
                    (evidence.some((e) => e.operationId === id && e.ok > 0) ? 1 : 0);
                  return score(b.id, b.providerId) - score(a.id, a.providerId);
                });
                const preset = rankedOps.flatMap((op) => BUILTIN_PRESETS.filter((p) => p.operationId === op.id))[0];
                const presetOp = preset ? OPERATIONS.find((op) => op.id === preset.operationId) : undefined;
                const presetConnection = connections.find((c) => c.providerId === presetOp?.providerId);
                const routeEvidence = evidence.filter((e) => routeOps.some((o) => o.id === e.operationId));
                return (
                  <article
                    key={route.id}
                    className={`atlas-route card flex flex-col p-5 md:p-6 atlas-route-${route.id}`}
                  >
                    <div className="mb-5 flex items-start justify-between gap-3">
                      <div className="atlas-route-icon">
                        <Icon size={23} strokeWidth={1.5} />
                      </div>
                      <span className="mono pt-1 text-[10px] tracking-widest text-zinc-500">
                        0{index + 1} / {route.subtitle}
                      </span>
                    </div>
                    <h3 className="text-xl font-semibold tracking-tight text-zinc-100">{route.title}</h3>
                    <p className="mt-2 min-h-12 text-sm leading-6 text-zinc-400">{route.description}</p>
                    <div className="mt-4 flex flex-wrap items-center gap-2 border-y border-zinc-800 py-3 text-[11px]">
                      <span className="text-zinc-400">{route.input}</span>
                      <ArrowRight size={12} className="text-zinc-600" />
                      <span className="text-zinc-200">{route.output}</span>
                    </div>
                    <div className="my-4 flex flex-wrap gap-x-4 gap-y-2">
                      {route.features.slice(0, 4).map((id) => (
                        <a key={id} href={featureHref(id)} className="text-xs text-violet-300 hover:text-violet-100">
                          {FEATURES.find((f) => f.id === id)?.name.split(' / ')[0]}{' '}
                          <ChevronRight size={11} className="inline" />
                        </a>
                      ))}
                    </div>
                    <p className="mb-4 flex-1 text-xs leading-5 text-zinc-500">{route.note}</p>
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 pt-4">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-xs text-zinc-400">{routeOps.length} 个实验入口</span>
                        <EvidenceChip rows={routeEvidence} />
                      </div>
                      {preset ? (
                        <a
                          className="btn-outline text-xs"
                          href={labHref(preset.operationId, { preset: preset.id, connection: presetConnection?.id })}
                          title={preset.description}
                        >
                          载入{getProvider(presetOp?.providerId)?.name}预设 <ArrowUpRight size={14} />
                        </a>
                      ) : (
                        <button
                          className="btn-outline text-xs"
                          onClick={() => {
                            setModality(route.id);
                            setTab('operations');
                          }}
                        >
                          查看可用入口 <ArrowRight size={14} />
                        </button>
                      )}
                    </div>
                    {preset && (
                      <p className="mt-2 text-right text-[10px] text-zinc-500">{preset.title} · 载入后手动运行</p>
                    )}
                  </article>
                );
              })}
            </div>
          ) : (
            <EmptyHint>没有符合筛选的能力路线。试试其他关键词，或重置筛选。</EmptyHint>
          )}
          <section className="card space-y-4 p-5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-semibold text-zinc-200">继续探索能力线索</h2>
              <span className="text-[11px] text-zinc-500">有实验入口与尚未适配的能力分别标记</span>
            </div>
            <div className="flex flex-wrap gap-2">
              {filteredFeatures.map((f) => {
                const implemented =
                  OPERATIONS.some((o) => o.features.includes(f.id)) ||
                  f.id === 'raw' ||
                  (f.id === 'model-discovery' && PROVIDERS.some((p) => p.modelsPath));
                return (
                  <a
                    key={f.id}
                    href={featureHref(f.id)}
                    className={`atlas-filter ${implemented ? 'text-zinc-300' : 'text-zinc-500'}`}
                    title={f.summary}
                  >
                    {implemented && <span className="h-1 w-1 rounded-full bg-violet-400" />}
                    {f.name}
                    {!implemented && <span className="text-[10px]">· 线索</span>}
                  </a>
                );
              })}
              {!filteredFeatures.length && <p className="text-xs text-zinc-500">没有匹配的能力线索。</p>}
            </div>
          </section>
        </>
      )}

      {tab === 'operations' &&
        (ops.length ? (
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {ops.map((o) => (
              <OperationCard key={o.id} op={o} />
            ))}
          </div>
        ) : (
          <EmptyHint>没有匹配的实验。试试其他关键词，或使用原始请求台。</EmptyHint>
        ))}
      {tab === 'models' && (
        <>
          <section className="flex gap-3 rounded-xl border border-sky-900/60 bg-sky-950/15 p-4">
            <Layers3 size={19} className="mt-0.5 shrink-0 text-sky-300" />
            <div>
              <h2 className="text-sm font-medium text-sky-100">同一个模型名称，不代表同一种 API 行为。</h2>
              <p className="mt-1 text-xs leading-6 text-zinc-400">
                区分研发方、实际服务商、端点与模型
                ID、账户和地域。下面是目录快照；实际可用模型请在连接页查询，具体能力以原生操作和真实响应为准。
              </p>
            </div>
          </section>
          <p className="text-xs text-zinc-500">{modelRows.length} 条模型目录记录 · 文档核验与本机实验分开显示</p>
          {modelRows.length ? (
            <div className="space-y-4">
              {modelRows.map(({ provider, model }) => (
                <ModelMatrixRow key={`${provider.id}:${model.id}`} provider={provider} model={model} />
              ))}
            </div>
          ) : (
            <EmptyHint>没有匹配的模型目录记录。通用协议连接可在实验台输入自定义模型 ID。</EmptyHint>
          )}
        </>
      )}
      {tab === 'providers' &&
        (providers.length ? (
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {providers.map((p) => (
              <a className="card interactive-card flex flex-col gap-4 p-5" key={p.id} href={providerHref(p.id)}>
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <span className="provider-monogram">{p.name.slice(0, 1)}</span>
                    <h2 className="text-base font-semibold text-zinc-100">{p.name}</h2>
                  </div>
                  <ArrowUpRight size={16} className="text-zinc-500" />
                </div>
                <p className="flex-1 text-sm leading-6 text-zinc-400">{p.description}</p>
                <div className="flex flex-wrap gap-2">
                  <Chip>{KIND_LABEL[p.kind]}</Chip>
                  {connections.some((c) => c.providerId === p.id) && <Chip tone="violet">已有连接</Chip>}
                </div>
                <div className="flex justify-between border-t border-zinc-800 pt-3 text-xs text-zinc-500">
                  <span>{OPERATIONS.filter((o) => o.providerId === p.id).length} 个原生操作</span>
                  <span>{p.models.length ? `${p.models.length} 个目录模型` : '自定义模型 ID'}</span>
                </div>
              </a>
            ))}
          </div>
        ) : (
          <EmptyHint>没有匹配的服务商。</EmptyHint>
        ))}
      {tab === 'connections' &&
        (connected.length ? (
          <div className="grid gap-4 md:grid-cols-2 2xl:grid-cols-3">
            {connected.map((c) => {
              const op =
                OPERATIONS.find((o) => o.providerId === c.providerId && o.workbench === 'chat') ??
                OPERATIONS.find((o) => o.providerId === c.providerId);
              return (
                <article className="card flex min-w-0 flex-col gap-3 p-5" key={c.id}>
                  <div className="flex items-center gap-3">
                    <span className="provider-monogram">
                      <Check size={17} />
                    </span>
                    <h2 className="text-base font-semibold text-zinc-100">{c.label}</h2>
                  </div>
                  <p className="mono break-all text-xs text-zinc-500">{c.baseUrl}</p>
                  <div className="flex flex-wrap gap-2">
                    <Chip>{c.extra.protocol || (c.providerId.startsWith('custom-') ? '通用协议' : '原生适配')}</Chip>
                    {c.lastTest ? (
                      <Chip
                        tone={
                          c.lastTest.ok === null || c.lastTest.verified === false
                            ? 'zinc'
                            : c.lastTest.ok
                              ? 'green'
                              : 'orange'
                        }
                        title={`${c.lastTest.at} · ${c.lastTest.message}`}
                      >
                        {c.lastTest.ok === null || c.lastTest.verified === false
                          ? '连接尚未验证'
                          : c.lastTest.ok
                            ? '最近连接检查成功'
                            : '最近连接检查失败'}
                      </Chip>
                    ) : (
                      <Chip>尚无连接检查记录</Chip>
                    )}
                  </div>
                  {c.extra.defaultModel && (
                    <p className="mono break-all text-xs text-violet-300">起始模型：{c.extra.defaultModel}</p>
                  )}
                  {c.extra.sourceNotes && (
                    <p className="line-clamp-3 text-xs leading-6 text-zinc-400" title={c.extra.sourceNotes}>
                      资料备注：{c.extra.sourceNotes}
                    </p>
                  )}
                  <p className="mt-auto text-[11px] leading-5 text-zinc-500">
                    连接检查只验证对应检查端点；具体操作的成功记录在实验卡片显示。
                  </p>
                  <div className="flex flex-wrap gap-2">
                    {op && (
                      <a
                        className="btn-primary"
                        href={labHref(op.id, { connection: c.id, model: c.extra.defaultModel || undefined })}
                      >
                        进入实验 <ArrowUpRight size={14} />
                      </a>
                    )}
                    <a
                      className="btn-ghost"
                      href={`#/connections?q=${encodeURIComponent(c.extra.sourceTitle || c.label)}`}
                    >
                      配置与限制
                    </a>
                  </div>
                </article>
              );
            })}
          </div>
        ) : (
          <EmptyHint>
            <p>还没有匹配的账户。添加一个 API 连接，就能从预设开始真实实验。</p>
            <a href="#/connections" className="btn-primary mt-4">
              添加或导入连接 <ArrowRight size={14} />
            </a>
          </EmptyHint>
        ))}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-zinc-800 pt-5 text-xs text-zinc-500">
        <p>目录信息来自适配器记录；本机证据来自实际运行。预设载入不会发送请求。</p>
        <a className="flex items-center gap-1 text-zinc-300 hover:text-violet-300" href="#/raw">
          探索未适配的端点 <ArrowUpRight size={13} />
        </a>
      </div>
    </Page>
  );
}

function ModelMatrixRow({ provider, model }: { provider: ProviderDef; model: ModelDef }) {
  const { connections, evidence } = useApp();
  const matchingConnections = connections.filter((c) => c.providerId === provider.id);
  const op = OPERATIONS.find((o) => o.providerId === provider.id && (!o.models || o.models.includes(model.id)));
  const rows = evidence.filter(
    (e) => e.model === model.id && OPERATIONS.some((o) => o.id === e.operationId && o.providerId === provider.id),
  );
  return (
    <article className="card overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 p-5">
        <div className="min-w-0">
          <a href={providerHref(provider.id)} className="mb-1 block text-xs text-violet-300">
            {provider.name}
          </a>
          <h3 className="mono break-all text-sm font-medium text-zinc-100">{model.label || model.id}</h3>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <VerificationChip v={model.verification} />
          <EvidenceChip rows={rows} />
          {model.deprecated && <Chip tone="orange">已弃用</Chip>}
          {op && (
            <a className="btn-outline text-xs" href={labHref(op.id, { model: model.id })}>
              进入原生实验 <ArrowUpRight size={13} />
            </a>
          )}
        </div>
      </div>
      <dl className="model-matrix-grid grid gap-5 p-5 sm:grid-cols-2 xl:grid-cols-4">
        <div>
          <dt className="eyebrow text-zinc-500">01 / 模型研发方</dt>
          <dd className="mt-2 text-sm text-zinc-200">{model.developer || '目录未单独标注'}</dd>
        </div>
        <div>
          <dt className="eyebrow text-zinc-500">02 / API 服务商</dt>
          <dd className="mt-2 text-sm text-zinc-200">
            {provider.name}
            <span className="mt-1 block text-xs text-zinc-500">{KIND_LABEL[provider.kind]}</span>
          </dd>
        </div>
        <div>
          <dt className="eyebrow text-zinc-500">03 / 端点与模型 ID</dt>
          <dd className="mt-2 space-y-1">
            <p className="mono break-all text-xs text-zinc-200">{model.id}</p>
            <p className="mono break-all text-[11px] leading-5 text-zinc-500">
              {provider.baseUrls[0]?.url || '由连接指定'}
            </p>
            {provider.baseUrls.length > 1 && (
              <a className="text-[11px] text-violet-300" href={providerHref(provider.id)}>
                另有 {provider.baseUrls.length - 1} 个端点选项
              </a>
            )}
          </dd>
        </div>
        <div>
          <dt className="eyebrow text-zinc-500">04 / 账户与地域</dt>
          <dd className="mt-2 text-xs leading-5 text-zinc-400">
            {provider.region === 'cn'
              ? '服务面向中国市场'
              : provider.region === 'global'
                ? '服务面向全球市场'
                : '地域以连接端点为准'}
            <span className="mt-1 block">
              {matchingConnections.length
                ? `${matchingConnections.length} 个本机连接 · 模型权限待实际查询`
                : '尚无本机连接 · 未确认账户权限'}
            </span>
          </dd>
        </div>
      </dl>
      {(model.modalities?.length || model.notes || model.verification?.date) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-zinc-800/70 px-5 py-3 text-[11px] leading-5 text-zinc-500">
          <span>
            {model.modalities?.join(' · ')}
            {model.notes ? `${model.modalities?.length ? ' · ' : ''}${model.notes}` : ''}
          </span>
          {model.verification?.date && <span>目录核验：{model.verification.date}</span>}
        </div>
      )}
    </article>
  );
}
