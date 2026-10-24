import { getProvider, listOperations, presetsFor } from '../../shared/catalog.ts';
import { ModelInfo } from '../lab/LabPage.tsx';
import { Chip, EmptyHint, KIND_LABEL, EvidenceChip } from '../ui.tsx';
import { FeatureLinks, OperationCard, Page } from './common.tsx';
import { useApp } from '../app.tsx';
import { ArrowRight, Layers3 } from 'lucide-react';
import { labHref } from '../router.ts';
export function ProviderPage({ id }: { id: string }) {
  const { connections, evidence } = useApp();
  const p = getProvider(id);
  if (!p)
    return (
      <Page title="未找到该服务">
        <EmptyHint>
          <a href="#/explore">返回探索目录</a>
        </EmptyHint>
      </Page>
    );
  const ops = listOperations(id);
  const localConnections = connections.filter((c) => c.providerId === id);
  const localEvidence = evidence.filter((e) => ops.some((o) => o.id === e.operationId));
  const presets = ops.flatMap((o) => presetsFor(o.id));
  return (
    <Page
      title={p.name}
      description={p.description}
      actions={
        <a className="btn-primary" href={`#/connections?provider=${encodeURIComponent(id)}`}>
          配置此服务的连接
        </a>
      }
    >
      <a href="#/explore" className="inline-flex items-center gap-1 text-xs text-zinc-500 hover:text-violet-300">
        ← 返回能力图谱
      </a>
      <section className="card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-zinc-800 px-5 py-4">
          <h2 className="flex items-center gap-2 text-sm font-medium text-zinc-200">
            <Layers3 size={16} className="text-violet-300" />
            先看清这次调用经过谁
          </h2>
          <EvidenceChip rows={localEvidence} />
        </div>
        <dl className="model-matrix-grid grid gap-5 p-5 sm:grid-cols-2 xl:grid-cols-4">
          <div>
            <dt className="eyebrow text-zinc-500">01 / 模型研发方</dt>
            <dd className="mt-2 text-sm text-zinc-300">
              {[...new Set(p.models.map((m) => m.developer).filter(Boolean))].join(' / ') || '按各模型目录记录确认'}
              <p className="mt-1 text-xs text-zinc-500">服务商与研发方可能不同</p>
            </dd>
          </div>
          <div>
            <dt className="eyebrow text-zinc-500">02 / 实际 API 服务商</dt>
            <dd className="mt-2 text-sm text-zinc-300">
              {p.name}
              <p className="mt-1 text-xs text-zinc-500">
                {KIND_LABEL[p.kind]} · {ops.length} 个操作适配
              </p>
            </dd>
          </div>
          <div>
            <dt className="eyebrow text-zinc-500">03 / 端点与模型快照</dt>
            <dd className="mt-2 text-sm text-zinc-300">
              {p.models.length ? `${p.models.length} 个目录模型` : '支持自定义模型 ID'}
              <p className="mt-1 text-xs text-zinc-500">{p.baseUrls.length} 个端点选项 · 详见下方</p>
            </dd>
          </div>
          <div>
            <dt className="eyebrow text-zinc-500">04 / 账户与地域</dt>
            <dd className="mt-2 text-sm text-zinc-300">
              {localConnections.length} 个本机连接
              <p className="mt-1 text-xs leading-5 text-zinc-500">
                {p.region === 'cn'
                  ? '服务面向中国市场'
                  : p.region === 'global'
                    ? '服务面向全球市场'
                    : '地域取决于实际端点'}{' '}
                · 权限与额度需在账户核查
              </p>
            </dd>
          </div>
        </dl>
      </section>
      <div className="flex flex-wrap gap-3">
        <Chip>{KIND_LABEL[p.kind]}</Chip>
        {[
          [p.docsUrl, '官方文档'],
          [p.consoleUrl, '账户控制台'],
          [p.pricingUrl, '官方定价'],
        ]
          .filter(([u]) => u)
          .map(([url, label]) => (
            <a key={label} className="btn-outline" href={url} target="_blank" rel="noreferrer">
              {label} ↗
            </a>
          ))}
      </div>
      {!!p.notes?.length && (
        <ul className="card list-disc space-y-2 py-4 pr-5 pl-9 text-sm text-amber-200/90">
          {p.notes.map((n) => (
            <li key={n}>{n}</li>
          ))}
        </ul>
      )}
      {presets.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-base font-semibold text-zinc-100">先做一个小实验</h2>
          <div className="grid gap-3 md:grid-cols-2">
            {presets.slice(0, 4).map((preset) => (
              <a
                key={preset.id}
                href={labHref(preset.operationId, { preset: preset.id })}
                className="card interactive-card p-4"
              >
                <h3 className="flex items-center justify-between gap-2 text-sm text-zinc-200">
                  {preset.title}
                  <ArrowRight size={14} className="shrink-0 text-violet-300" />
                </h3>
                <p className="mt-2 text-xs leading-6 text-zinc-500">{preset.description}</p>
              </a>
            ))}
          </div>
          <p className="text-[11px] text-zinc-500">预设只载入输入与参数，点击运行后才会调用 API。</p>
        </section>
      )}
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-zinc-100">原生实验</h2>
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {ops.map((o) => (
            <OperationCard op={o} key={o.id} />
          ))}
        </div>
      </section>
      <section className="card space-y-4 p-5">
        <h2 className="text-lg font-semibold text-zinc-100">模型与访问条件</h2>
        <p className="text-xs text-zinc-500">
          开发方与 API 服务提供方可能不同。目录信息不代表当前账户权限；在连接页查询账户模型列表。
        </p>
        {p.models.length ? (
          p.models.map((m) => (
            <div className="space-y-2 border-t border-zinc-800 pt-3" key={m.id}>
              <h3 className="mono text-sm text-zinc-100">
                {m.id} {m.label && m.label !== m.id ? `· ${m.label}` : ''}
              </h3>
              <ModelInfo model={m} />
            </div>
          ))
        ) : (
          <EmptyHint>此协议支持自定义模型 ID，请以实际服务商文档为准。</EmptyHint>
        )}
      </section>
      <section className="space-y-3">
        <h2 className="text-lg font-semibold text-zinc-100">相关玩法</h2>
        <FeatureLinks ids={[...new Set(ops.flatMap((o) => o.features))]} />
      </section>
      <section className="card space-y-3 p-5">
        <h2 className="text-base font-semibold text-zinc-100">端点</h2>
        {p.baseUrls.map((b) => (
          <div key={b.id} className="text-xs text-zinc-400">
            <b>{b.label}</b>
            <p className="mono mt-1 break-all">{b.url}</p>
            {b.note && <p className="mt-1 text-amber-200/80">{b.note}</p>}
          </div>
        ))}
      </section>
    </Page>
  );
}
