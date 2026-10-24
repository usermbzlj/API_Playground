import { useMemo, useState } from 'react';
import type { RunMetrics, TraceEvent } from '../../shared/types.ts';
import { formatCost } from '../../shared/cost.ts';
import { reasoningTokens, cacheHitTokens } from '../../shared/protocols.ts';
import { Chip, EmptyHint, JsonBlock, fmtMs } from '../ui.tsx';

const TYPE_TONE: Record<string, string> = {
  error: 'red',
  done: 'green',
  request: 'violet',
  'response-head': 'blue',
  artifact: 'yellow',
  'ws-send': 'violet',
  'ws-recv': 'blue',
};

export function EventList({ events }: { events: TraceEvent[] }) {
  const [filter, setFilter] = useState<string>('');
  const [limit, setLimit] = useState(150);
  const types = useMemo(() => [...new Set(events.map((e) => e.type))], [events]);
  const filtered = filter ? events.filter((e) => e.type === filter) : events;
  const shown = filtered.slice(-limit);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <button
          className={!filter ? 'btn-primary px-2 py-0.5 text-[11px]' : 'btn-ghost px-2 py-0.5 text-[11px]'}
          onClick={() => setFilter('')}
        >
          全部 {events.length}
        </button>
        {types.map((t) => (
          <button
            key={t}
            className={filter === t ? 'btn-primary px-2 py-0.5 text-[11px]' : 'btn-ghost px-2 py-0.5 text-[11px]'}
            onClick={() => setFilter(t)}
          >
            {t} {events.filter((e) => e.type === t).length}
          </button>
        ))}
      </div>
      {shown.length < filtered.length && (
        <p className="text-[11px] text-zinc-600">
          仅显示最近 {shown.length} / {filtered.length} 条
          <button className="btn-ghost ml-2 px-1.5 py-0 text-[11px]" onClick={() => setLimit((l) => l + 500)}>
            再多显示 500 条
          </button>
        </p>
      )}
      {shown.length === 0 && <EmptyHint>没有事件</EmptyHint>}
      {shown.map((ev, i) => (
        <div key={i} className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2">
          <div className="mb-1 flex items-center gap-2 text-[11px]">
            <Chip tone={TYPE_TONE[ev.type] ?? 'zinc'}>{ev.type}</Chip>
            {ev.data?.event && <span className="mono text-sky-300">event: {ev.data.event}</span>}
            <span className="mono text-zinc-500">+{ev.t} ms</span>
          </div>
          <JsonBlock value={ev.type === 'chunk' && ev.data?.data !== undefined ? ev.data.data : ev.data} max={6000} />
        </div>
      ))}
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-950/40 px-3 py-2" title={hint}>
      <div className="text-[11px] text-zinc-500">{label}</div>
      <div className="mono mt-0.5 text-sm text-zinc-100">{value}</div>
    </div>
  );
}

export function MetricsPanel({ metrics, view }: { metrics: RunMetrics | null; view?: any }) {
  if (!metrics) return <EmptyHint>运行后显示耗时、用量与费用估算</EmptyHint>;
  const u: any = metrics.usage ?? view?.usage;
  const outTokens = Number(u?.completion_tokens ?? u?.output_tokens ?? u?.candidatesTokenCount);
  const genMs =
    metrics.totalMs != null && metrics.firstTokenMs != null ? metrics.totalMs - metrics.firstTokenMs : undefined;
  const speed =
    Number.isFinite(outTokens) && genMs && genMs > 0 ? `${((outTokens / genMs) * 1000).toFixed(1)} tok/s` : '—';
  const rt = reasoningTokens(u);
  const hit = cacheHitTokens(u);
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-2 md:grid-cols-4">
        <Stat label="首字节 TTFB" value={fmtMs(metrics.ttfbMs)} hint="从发出请求到收到响应头" />
        <Stat label="首个内容块" value={fmtMs(metrics.firstTokenMs)} hint="流式首个数据块到达时间（可能是思考内容）" />
        <Stat
          label="思考 → 正文"
          value={view?.firstTextMs != null ? fmtMs(view.firstTextMs) : '—'}
          hint="首个正文 Token 到达时间"
        />
        <Stat label="总耗时" value={fmtMs(metrics.totalMs)} />
        <Stat label="输出速度" value={speed} hint="输出 Token ÷（总耗时 − 首块时间），仅在厂商返回用量时可算" />
        <Stat label="分块数" value={String(metrics.chunks ?? '—')} />
        <Stat label="推理 / 缓存命中 Token" value={`${rt ?? '—'} / ${hit ?? '—'}`} />
        <Stat
          label="费用（估算）"
          value={formatCost(metrics.cost)}
          hint={metrics.cost?.basis ?? '目录中没有该模型的可信定价，或厂商未返回用量'}
        />
      </div>
      {metrics.cost && <p className="text-[11px] text-zinc-500">费用依据：{metrics.cost.basis}。以厂商账单为准。</p>}
      {u && (
        <div>
          <h4 className="label mb-1">usage（厂商原样返回）</h4>
          <JsonBlock value={u} max={6000} />
        </div>
      )}
    </div>
  );
}
