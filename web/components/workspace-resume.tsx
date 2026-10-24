import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowRight, Clock3, FilePenLine, History, KeyRound, RefreshCw } from 'lucide-react';
import type { RunRecord } from '../../shared/types.ts';
import { api } from '../api.ts';
import { useApp } from '../app.tsx';
import { useDrafts } from '../workspace-state.ts';
import { fmtTime, StatusBadge } from '../ui.tsx';
import { runLink } from '../pages/common.tsx';

export function WorkspaceResume() {
  const { evidence, connections } = useApp();
  const allDrafts = useDrafts();
  const drafts = useMemo(() => {
    const groups = new Map<string, (typeof allDrafts)[number]>();
    for (const draft of allDrafts) {
      if (
        !draft.href ||
        /^bench:(tab|selected|compared|comparison-stages)$/.test(draft.key) ||
        draft.key.endsWith(':mode')
      )
        continue;
      const title = draft.key.startsWith('bench:')
        ? '性能评测配置'
        : draft.key.startsWith('compare:')
          ? '并排对比实验'
          : draft.title;
      if (!groups.has(draft.href)) groups.set(draft.href, { ...draft, title });
    }
    return [...groups.values()].slice(0, 3);
  }, [allDrafts]);
  const [recent, setRecent] = useState<RunRecord[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setRecent(await api.runs({ limit: 3 }));
      setError('');
    } catch {
      setError('暂时无法读取实验记录');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load, evidence]);
  return (
    <section aria-label="继续工作" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">继续你的实验</h2>
          <p className="mt-1 text-xs text-zinc-400">从草稿或最近记录接着做，也可以在下方探索新的能力。</p>
        </div>
        <a href="#/assets" className="btn-outline text-xs">
          打开素材库 <ArrowRight size={14} />
        </a>
      </div>
      {drafts.length > 0 && (
        <div className="grid gap-3 md:grid-cols-3">
          {drafts.map((draft) => (
            <a
              key={draft.key}
              href={draft.href}
              className="resume-card rounded-xl border border-violet-800/60 bg-violet-950/20 p-4 hover:border-violet-500"
            >
              <span className="mb-2 flex items-center gap-2 text-[11px] text-violet-300">
                <FilePenLine size={14} /> 浏览器草稿
              </span>
              <strong className="block truncate text-sm font-medium text-zinc-100">
                {draft.title || '未完成的实验'}
              </strong>
              <span className="mt-2 block text-xs text-zinc-400">
                继续编辑 <ArrowRight size={12} className="inline" />
              </span>
            </a>
          ))}
        </div>
      )}
      {recent.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-3">
          {recent.map((run) => (
            <a key={run.id} href={runLink(run)} className="resume-card card min-w-0 p-4 hover:border-zinc-600">
              <span className="mb-2 flex items-center justify-between gap-2 text-[11px] text-zinc-400">
                <span className="flex items-center gap-1.5">
                  <Clock3 size={13} /> {fmtTime(run.createdAt)}
                </span>
                <StatusBadge status={run.status} />
              </span>
              <strong className="block truncate text-sm font-medium text-zinc-100">{run.title}</strong>
              <span className="mt-2 block truncate text-xs text-zinc-500">{run.model || run.providerId}</span>
            </a>
          ))}
        </div>
      ) : !error && !drafts.length ? (
        <div className="card flex flex-wrap items-center justify-between gap-4 p-5">
          <p className="text-sm text-zinc-300">
            {connections.length ? '连接已就绪。选一个预设，开始第一次实验。' : '先添加一个 API 连接，再从预设开始。'}
          </p>
          <a href={connections.length ? '#/explore?tab=connections' : '#/connections'} className="btn-primary text-xs">
            <KeyRound size={14} /> {connections.length ? '选择已有账户' : '添加 API 连接'}
          </a>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-zinc-500">
        {error ? (
          <button onClick={load} className="btn-ghost px-0 text-xs">
            <RefreshCw size={13} /> {error} · 重试
          </button>
        ) : (
          <span>草稿保留在当前浏览器标签页；已运行的实验保存在本机。</span>
        )}
        <a className="flex items-center gap-1.5 text-violet-300 hover:underline" href="#/runs">
          <History size={13} /> 全部实验记录
        </a>
      </div>
    </section>
  );
}
