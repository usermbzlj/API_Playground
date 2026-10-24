import type { ReactNode } from 'react';
import { getProvider, getFeature, presetsFor } from '../../shared/catalog.ts';
import type { AssetInfo, OperationDef, RunRecord } from '../../shared/types.ts';
import { labHref, providerHref, featureHref } from '../router.ts';
import { Chip, VerificationChip, COST_LABEL, WORKBENCH_LABEL } from '../ui.tsx';
import { useApp } from '../app.tsx';
import { EvidenceChip } from '../ui.tsx';
import { redactSensitive } from '../../shared/redact.ts';
import { ModelPreview } from '../lab/model3d.tsx';
import { ArrowUpRight, ArrowRight, Bookmark, Cable } from 'lucide-react';

export function Page({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto min-w-0 w-full max-w-[1480px] break-words space-y-6 [&_.card]:min-w-0 [&_.input]:min-w-0 p-5 md:p-8">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-100">{title}</h1>
          {description && <p className="mt-2 max-w-3xl text-sm leading-relaxed text-zinc-400">{description}</p>}
        </div>
        {actions}
      </header>
      {children}
    </div>
  );
}

export function OperationCard({ op }: { op: OperationDef }) {
  const { evidence, connections } = useApp();
  const cost = COST_LABEL[op.costTier];
  const provider = getProvider(op.providerId);
  const presets = presetsFor(op.id);
  const rows = evidence.filter((e) => e.operationId === op.id);
  const connected = connections.some((c) => c.providerId === op.providerId);
  const lifecycleLabels = { http: '单次请求', sse: '流式响应', ws: '实时连接', 'async-task': '异步任务' };
  return (
    <article className="card interactive-card flex flex-col gap-3 p-5">
      <div className="flex flex-wrap gap-2">
        <a className="text-xs text-violet-300" href={providerHref(op.providerId)}>
          {provider?.name}
        </a>
        <Chip>{WORKBENCH_LABEL[op.workbench]}</Chip>
        <span className="ml-auto text-[10px] text-zinc-500">{lifecycleLabels[op.lifecycle]}</span>
      </div>
      <h3 className="text-base font-semibold text-zinc-100">{op.title}</h3>
      <p className="flex-1 text-sm leading-relaxed text-zinc-400">{op.summary}</p>
      {op.defaultModel && (
        <p className="mono truncate text-[11px] text-zinc-500" title={op.defaultModel}>
          {op.defaultModel}
        </p>
      )}
      <div className="flex flex-wrap gap-x-3 gap-y-1.5">
        {op.features.slice(0, 3).map((id) => (
          <a key={id} href={featureHref(id)} className="text-[11px] text-violet-300 hover:text-violet-100">
            {getFeature(id)?.name.split(' / ')[0] ?? id}
          </a>
        ))}
      </div>
      <div className="space-y-2 border-y border-zinc-800 py-3">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-12 shrink-0 text-[10px] text-zinc-500">目录说明</span>
          <VerificationChip v={op.verification} />
          <Chip tone={cost.tone} title={op.costHint}>
            {cost.label}
          </Chip>
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="w-12 shrink-0 text-[10px] text-zinc-500">本机运行</span>
          {rows.length ? (
            <EvidenceChip rows={rows} />
          ) : (
            <span className="text-[11px] text-zinc-500">尚无此操作的实验记录</span>
          )}
        </div>
      </div>
      {presets[0] && (
        <a
          className="flex items-start gap-2 text-xs leading-5 text-zinc-400 hover:text-violet-200"
          href={labHref(op.id, { preset: presets[0].id })}
          title={presets[0].description}
        >
          <Bookmark size={13} className="mt-1 shrink-0" />
          <span>{presets[0].title}</span>
          <ArrowUpRight size={13} className="mt-1 shrink-0" />
        </a>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 text-[11px] text-zinc-500">
          <Cable size={12} />
          {connected ? '已有对应连接' : '需要添加连接'}
        </span>
        <a className="btn-primary text-xs" href={labHref(op.id)}>
          进入实验台 <ArrowRight size={13} />
        </a>
      </div>
    </article>
  );
}

export function FeatureLinks({ ids }: { ids: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {ids.map((id) => (
        <a key={id} href={featureHref(id)} className="chip border-zinc-700 text-zinc-300 hover:border-violet-500">
          {getFeature(id)?.name ?? id}
        </a>
      ))}
    </div>
  );
}

/** Defense in depth for user exports; server records are already redacted. */
export function redactExport(value: unknown): unknown {
  const sensitive =
    /^(authorization|proxy-authorization|cookie|set-cookie|.*(?:api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|credential))$/i;
  if (Array.isArray(value)) return value.map(redactExport);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, sensitive.test(k) ? '[REDACTED]' : redactExport(v)]),
    );
  if (typeof value === 'string')
    return value
      .replace(/([?&](?:key|api[_-]?key|token|access_token|signature)=)[^&#\s]+/gi, '$1[REDACTED]')
      .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, 'Bearer [REDACTED]');
  return value;
}

export function downloadJson(value: unknown, filename: string) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(redactSensitive(redactExport(value)), null, 2)], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function runLink(r: RunRecord) {
  return r.operationId ? labHref(r.operationId, { run: r.id }) : `#/raw?run=${encodeURIComponent(r.id)}`;
}

export function ArtifactGallery({ assets }: { assets: AssetInfo[] }) {
  if (!assets.length) return null;
  return (
    <section className="space-y-3">
      <h3 className="label">生成产物</h3>
      {assets.map((a) => (
        <div className="card space-y-2 p-3" key={a.id}>
          {a.kind === 'image' && (
            <img className="max-h-96 max-w-full rounded object-contain" src={a.url} alt={a.filename} />
          )}{' '}
          {a.kind === 'audio' && <audio controls src={a.url} className="max-w-full" />}{' '}
          {a.kind === 'video' && <video controls src={a.url} className="max-h-96 max-w-full rounded" />}
          {a.kind === 'model3d' && <ModelPreview src={a.url} name={a.filename} />}
          <a className="text-xs text-violet-300" href={a.url} download={a.filename}>
            {a.filename} · {a.mime} · 下载
          </a>
        </div>
      ))}
    </section>
  );
}
