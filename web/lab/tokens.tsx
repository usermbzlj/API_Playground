import { useMemo, useState } from 'react';
import type { TokenProb } from '../../shared/protocols.ts';

function probColor(p: number): string {
  // high confidence = transparent, low = warm highlight
  if (p >= 0.9) return 'transparent';
  if (p >= 0.7) return 'rgba(250, 204, 21, 0.18)';
  if (p >= 0.5) return 'rgba(251, 146, 60, 0.28)';
  if (p >= 0.3) return 'rgba(244, 63, 94, 0.32)';
  return 'rgba(225, 29, 72, 0.5)';
}

function show(tok: string) {
  return tok.replace(/\n/g, '↵\n').replace(/ /g, '·');
}

/** Token microscope: every generated token coloured by its probability, alternatives on hover. */
export function TokenMicroscope({ tokens }: { tokens: TokenProb[] }) {
  const [active, setActive] = useState<number | null>(null);
  const [showSpaces, setShowSpaces] = useState(false);
  const stats = useMemo(() => {
    const ps = tokens.map((t) => Math.exp(t.logprob)).filter((p) => Number.isFinite(p));
    const avg = ps.reduce((a, b) => a + b, 0) / (ps.length || 1);
    const low = ps.filter((p) => p < 0.5).length;
    const min = Math.min(...ps);
    const forks = tokens.filter((t) => t.top.length > 1 && Math.exp(t.top[1].logprob) > 0.2).length;
    return { avg, low, min, forks };
  }, [tokens]);
  if (!tokens.length) return null;
  const cur = active != null ? tokens[active] : null;
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
        <span>{tokens.length} 个 Token</span>
        <span>平均概率 {(stats.avg * 100).toFixed(1)}%</span>
        <span>最低 {(stats.min * 100).toFixed(1)}%</span>
        <span>低于 50%：{stats.low} 个</span>
        <span title="第二候选概率 > 20% 的位置，即模型明显在两个选项间犹豫">岔路口：{stats.forks} 处</span>
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={showSpaces} onChange={(e) => setShowSpaces(e.target.checked)} />
          显示空格与换行
        </label>
        <span className="flex items-center gap-1">
          图例
          {[0.95, 0.75, 0.55, 0.35, 0.1].map((p) => (
            <span
              key={p}
              className="mono rounded px-1"
              style={{ background: probColor(p) === 'transparent' ? 'rgba(255,255,255,0.06)' : probColor(p) }}
            >
              {Math.round(p * 100)}%
            </span>
          ))}
        </span>
      </div>
      <div className="mono rounded-md bg-zinc-950 p-3 text-sm leading-7 break-words whitespace-pre-wrap text-zinc-100">
        {tokens.map((t, i) => (
          <span
            key={i}
            onMouseEnter={() => setActive(i)}
            onClick={() => setActive(i)}
            className={`cursor-default rounded-sm ${active === i ? 'outline outline-1 outline-violet-400' : ''}`}
            style={{ background: probColor(Math.exp(t.logprob)) }}
          >
            {showSpaces ? show(t.token) : t.token}
          </span>
        ))}
      </div>
      {cur && (
        <div className="rounded-md border border-zinc-800 bg-zinc-900/80 p-2 text-xs">
          <div className="mb-1 text-zinc-400">
            第 {active! + 1} 个 Token：<span className="mono text-zinc-100">{JSON.stringify(cur.token)}</span> · 概率{' '}
            {(Math.exp(cur.logprob) * 100).toFixed(2)}% · logprob {cur.logprob.toFixed(4)}
          </div>
          {cur.top.length > 0 ? (
            <div className="space-y-0.5">
              {cur.top.map((alt, k) => {
                const p = Math.exp(alt.logprob);
                return (
                  <div key={k} className="flex items-center gap-2">
                    <span
                      className={`mono w-40 truncate ${alt.token === cur.token ? 'text-violet-300' : 'text-zinc-300'}`}
                    >
                      {JSON.stringify(alt.token)}
                    </span>
                    <span className="h-2 rounded bg-violet-500/70" style={{ width: `${Math.max(2, p * 240)}px` }} />
                    <span className="mono text-zinc-400">{(p * 100).toFixed(2)}%</span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="text-zinc-400">该 Token 没有返回候选（把 top_logprobs 设为大于 0 可查看候选）。</p>
          )}
        </div>
      )}
    </div>
  );
}
