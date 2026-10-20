import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, type Catalog } from './api.ts';
import type { ConnectionInfo } from '../shared/types.ts';
import { useRoute, href } from './router.ts';
import { Spinner } from './ui.tsx';

interface Toast {
  id: number;
  msg: string;
  tone: 'ok' | 'err';
}

interface AppCtx {
  catalog: Catalog | null;
  connections: ConnectionInfo[];
  refreshConnections: () => Promise<void>;
  toast: (msg: string, tone?: 'ok' | 'err') => void;
}

const Ctx = createContext<AppCtx>({
  catalog: null,
  connections: [],
  refreshConnections: async () => {},
  toast: () => {},
});

export function useApp() {
  return useContext(Ctx);
}

const NAV = [
  { to: '/explore', label: '🔍 探索' },
  { to: '/connections', label: '🔑 连接' },
  { to: '/raw', label: '🧷 原始请求' },
  { to: '/runs', label: '🧾 实验记录' },
  { to: '/tasks', label: '⏳ 异步任务' },
];

export function App() {
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [bootError, setBootError] = useState('');

  const toast = useCallback((msg: string, tone: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, msg, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 4500);
  }, []);

  const refreshConnections = useCallback(async () => {
    try {
      setConnections(await api.connections());
    } catch (e: any) {
      toast(`加载连接失败：${e.message}`, 'err');
    }
  }, [toast]);

  useEffect(() => {
    (async () => {
      try {
        setCatalog(await api.catalog());
        setBootError('');
      } catch (e: any) {
        setBootError(e.message);
        return;
      }
      await refreshConnections();
    })();
  }, [refreshConnections]);

  return (
    <Ctx.Provider value={{ catalog, connections, refreshConnections, toast }}>
      <div className="flex h-full">
        <aside className="flex w-52 shrink-0 flex-col border-r border-zinc-800 bg-zinc-900/40">
          <div className="px-4 py-4 text-base font-bold tracking-wide text-zinc-100">
            🧪 API Playground
            <div className="mt-0.5 text-[11px] font-normal text-zinc-500">多模态 AI API 游乐场</div>
          </div>
          <nav className="flex-1 space-y-0.5 px-2">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} label={n.label} />
            ))}
          </nav>
          <div className="p-3 text-[11px] leading-relaxed text-zinc-600">本地优先 · 密钥只保存在本机 data/secrets.json</div>
        </aside>
        <main className="flex-1 overflow-auto">
          {bootError ? (
            <div className="m-6 rounded-lg border border-rose-800 bg-rose-950/40 p-4 text-sm text-rose-200">
              <p className="font-medium">无法连接本地服务（:8787）</p>
              <p className="mt-1 text-rose-300/80">{bootError}</p>
              <p className="mt-2 text-rose-300/80">请确认已运行 npm run dev（或 npm start）。</p>
            </div>
          ) : !catalog ? (
            <div className="flex items-center gap-2 p-10 text-sm text-zinc-400">
              <Spinner /> 正在加载厂商目录…
            </div>
          ) : (
            <Routes />
          )}
        </main>
      </div>
      <div className="pointer-events-none fixed bottom-4 right-4 z-50 flex flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-md border px-3 py-2 text-xs shadow-lg ${
              t.tone === 'ok' ? 'border-emerald-800 bg-emerald-950/90 text-emerald-200' : 'border-rose-800 bg-rose-950/90 text-rose-200'
            }`}
          >
            {t.msg}
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

function NavLink({ to, label }: { to: string; label: string }) {
  const route = useRoute();
  const active = route.path === to || (to !== '/explore' && route.path.startsWith(to));
  return (
    <a
      href={href(to)}
      className={`block rounded-md px-3 py-1.5 text-sm transition ${
        active ? 'bg-violet-600/20 text-violet-200' : 'text-zinc-400 hover:bg-zinc-800 hover:text-zinc-100'
      }`}
    >
      {label}
    </a>
  );
}

function Routes() {
  const route = useRoute();
  const [first, second] = route.parts;
  if (!first) return <ExplorePage />;
  if (first === 'explore') return <ExplorePage />;
  if (first === 'connections') return <ConnectionsPage />;
  if (first === 'lab' && second) return <LabPage operationId={second} />;
  if (first === 'raw') return <RawPage />;
  if (first === 'runs') return second ? <RunDetailPage id={second} /> : <RunsPage />;
  if (first === 'tasks') return <TasksPage />;
  return <div className="p-10 text-zinc-500">页面不存在</div>;
}

import { ExplorePage } from './pages.tsx';
import { ConnectionsPage } from './pages.tsx';
import { RunsPage, RunDetailPage } from './pages.tsx';
import { TasksPage } from './pages.tsx';
import { LabPage } from './lab.tsx';
import { RawPage } from './rawpage.tsx';
