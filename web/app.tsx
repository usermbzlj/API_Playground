import {
  Component,
  Suspense,
  createContext,
  lazy,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api } from './api.ts';
import type { ConnectionInfo, EvidenceRow } from '../shared/types.ts';
import { useRoute, href } from './router.ts';
import {
  Activity,
  ArrowRightLeft,
  Braces,
  Compass,
  FlaskConical,
  History,
  KeyRound,
  Settings2,
  Gauge,
  X,
  Menu,
  FolderOpen,
} from 'lucide-react';
import { cancelRunSession, useRunSessions } from './lab/useRunner.ts';

const ExplorePage = lazy(() => import('./pages/explore.tsx').then((m) => ({ default: m.ExplorePage })));
const ProviderPage = lazy(() => import('./pages/provider.tsx').then((m) => ({ default: m.ProviderPage })));
const FeaturePage = lazy(() => import('./pages/feature.tsx').then((m) => ({ default: m.FeaturePage })));
const ConnectionsPage = lazy(() => import('./pages/connections.tsx').then((m) => ({ default: m.ConnectionsPage })));
const RunsPage = lazy(() => import('./pages/runs.tsx').then((m) => ({ default: m.RunsPage })));
const RunDetailPage = lazy(() => import('./pages/runs.tsx').then((m) => ({ default: m.RunDetailPage })));
const TasksPage = lazy(() => import('./pages/tasks.tsx').then((m) => ({ default: m.TasksPage })));
const RawPage = lazy(() => import('./pages/raw.tsx').then((m) => ({ default: m.RawPage })));
const SettingsPage = lazy(() => import('./pages/settings.tsx').then((m) => ({ default: m.SettingsPage })));
const ComparePage = lazy(() => import('./pages/compare.tsx').then((m) => ({ default: m.ComparePage })));
const LabPage = lazy(() => import('./lab/LabPage.tsx').then((m) => ({ default: m.LabPage })));
const BenchmarkPage = lazy(() => import('./pages/benchmark.tsx').then((m) => ({ default: m.BenchmarkPage })));
const AssetsPage = lazy(() => import('./pages/assets.tsx').then((m) => ({ default: m.AssetsPage })));

interface Toast {
  id: number;
  msg: string;
  tone: 'ok' | 'err';
}

interface AppCtx {
  connections: ConnectionInfo[];
  refreshConnections: () => Promise<void>;
  evidence: EvidenceRow[];
  refreshEvidence: () => Promise<void>;
  toast: (msg: string, tone?: 'ok' | 'err') => void;
}

const Ctx = createContext<AppCtx>({
  connections: [],
  refreshConnections: async () => {},
  evidence: [],
  refreshEvidence: async () => {},
  toast: () => {},
});

export function useApp() {
  return useContext(Ctx);
}

const NAV = [
  { to: '/explore', label: '能力探索', icon: Compass },
  { to: '/compare', label: '并排对比', icon: ArrowRightLeft },
  { to: '/bench', label: '性能评测', icon: Gauge },
  { to: '/runs', label: '实验记录', icon: History },
  { to: '/tasks', label: '异步任务', icon: Activity },
  { to: '/assets', label: '素材与产物', icon: FolderOpen },
  { to: '/raw', label: '原始请求', icon: Braces },
  { to: '/connections', label: '连接与 Key', icon: KeyRound },
  { to: '/settings', label: '设置', icon: Settings2 },
];

export function App() {
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [evidence, setEvidence] = useState<EvidenceRow[]>([]);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [server, setServer] = useState<'checking' | 'ok' | 'down'>('checking');
  const [retry, setRetry] = useState(0);
  const [navOpen, setNavOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const navToggleRef = useRef<HTMLButtonElement>(null);
  const route = useRoute();
  useEffect(() => {
    setNavOpen(false);
  }, [route.path]);
  useEffect(() => {
    if (!navOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    if (mainRef.current) mainRef.current.inert = true;
    sidebarRef.current?.querySelector<HTMLElement>('a, button')?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        setNavOpen(false);
      }
      if (e.key === 'Tab') {
        const focusables = sidebarRef.current?.querySelectorAll<HTMLElement>('a[href], button:not([disabled])');
        if (!focusables?.length) return;
        const first = focusables[0],
          last = focusables[focusables.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    const onResize = () => {
      if (window.innerWidth >= 768) setNavOpen(false);
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', onResize);
    return () => {
      document.body.style.overflow = oldOverflow;
      if (mainRef.current) mainRef.current.inert = false;
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onResize);
      previous?.focus();
    };
  }, [navOpen]);

  const toast = useCallback((msg: string, tone: 'ok' | 'err' = 'ok') => {
    const id = Date.now() + Math.random();
    setToasts((prev) => [...prev, { id, msg, tone }]);
    setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), 5000);
  }, []);

  useEffect(() => {
    const onNotice = (event: Event) => {
      const detail = (event as CustomEvent<{ message: string; tone?: 'ok' | 'err' }>).detail;
      if (detail?.message) toast(detail.message, detail.tone);
    };
    window.addEventListener('workspace-notice', onNotice);
    return () => window.removeEventListener('workspace-notice', onNotice);
  }, [toast]);

  const refreshConnections = useCallback(async () => {
    try {
      setConnections(await api.connections());
    } catch (e: any) {
      toast(`加载连接失败：${e.message}`, 'err');
    }
  }, [toast]);

  const refreshEvidence = useCallback(async () => {
    try {
      setEvidence(await api.evidence());
    } catch {
      /* non-critical */
    }
  }, []);

  useEffect(() => {
    let active = true;
    let checking = false;
    let wasConnected = false;
    const check = async () => {
      if (checking) return;
      checking = true;
      try {
        const response = await fetch('/api/health', { signal: AbortSignal.timeout(4000) });
        if (!response.ok || !(await response.json()).ok) throw new Error('本地服务未就绪');
        if (active) {
          setServer('ok');
          if (!wasConnected) await Promise.all([refreshConnections(), refreshEvidence()]);
          wasConnected = true;
        }
      } catch {
        if (active) setServer('down');
        wasConnected = false;
      } finally {
        checking = false;
      }
    };
    void check();
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') void check();
    }, 15000);
    const onFocus = () => void check();
    window.addEventListener('focus', onFocus);
    return () => {
      active = false;
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [refreshConnections, refreshEvidence, retry]);

  return (
    <Ctx.Provider value={{ connections, refreshConnections, evidence, refreshEvidence, toast }}>
      <div className="app-shell flex min-h-dvh md:h-dvh">
        <a
          className="skip-link"
          href="#main"
          onClick={(e) => {
            e.preventDefault();
            mainRef.current?.focus();
          }}
        >
          跳到主要内容
        </a>
        {navOpen && (
          <button
            className="fixed inset-0 z-30 bg-black/70 md:hidden"
            aria-label="关闭导航"
            onClick={() => setNavOpen(false)}
          />
        )}
        <aside
          ref={sidebarRef}
          data-open={navOpen}
          id="workspace-navigation"
          aria-label="工作区导航"
          className={`app-sidebar fixed inset-y-0 left-0 z-40 flex w-60 shrink-0 flex-col overflow-y-auto border-r border-zinc-800 transition-transform md:static md:translate-x-0 ${navOpen ? 'translate-x-0' : '-translate-x-full'}`}
        >
          <a
            href="#/explore"
            className="flex items-center gap-2.5 px-5 pt-7 pb-6 text-base font-bold tracking-tight text-zinc-100"
          >
            <span className="rounded-xl border border-violet-500/30 bg-violet-500/15 p-2 text-violet-300">
              <FlaskConical size={21} />
            </span>
            <span>
              PrismLab<span className="ml-1.5 text-[9px] font-medium tracking-widest text-violet-400">LOCAL</span>
              <div className="mt-1 text-[10px] font-normal tracking-widest text-zinc-500">原生多模态 API 实验室</div>
            </span>
          </a>
          <button className="btn-ghost mx-3 mb-3 md:hidden" onClick={() => setNavOpen(false)}>
            <X size={16} />
            关闭导航
          </button>
          <nav aria-label="主导航" className="flex-1 space-y-1 px-3">
            {NAV.map((n, i) => (
              <div key={n.to}>
                {(i === 0 || i === 3 || n.to === '/connections') && (
                  <p className={`eyebrow px-3 pb-2 text-zinc-600 ${i ? 'pt-6' : 'pt-2'}`}>
                    {i === 0 ? '发现与实验' : i === 3 ? '结果与证据' : '本地工作区'}
                  </p>
                )}
                <NavLink to={n.to} label={n.label} icon={<n.icon size={17} strokeWidth={1.7} />} />
              </div>
            ))}
          </nav>
          <div className="m-3 rounded-xl border border-zinc-800 bg-zinc-950/40 p-3 text-[11px] leading-relaxed text-zinc-500">
            <div className="mb-1 flex items-center gap-2 text-zinc-300">
              <span className={`h-1.5 w-1.5 rounded-full ${server === 'ok' ? 'bg-emerald-400' : 'bg-amber-400'}`} />
              {server === 'ok' ? '本地服务已连接' : server === 'checking' ? '正在连接…' : '本地服务未连接'}
            </div>
            Key 保存在本机 · {connections.length} 个连接
          </div>
        </aside>
        <main ref={mainRef} id="main" tabIndex={-1} className="min-w-0 flex-1 outline-none md:overflow-auto">
          <div className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-zinc-800 bg-zinc-950/95 px-4 backdrop-blur md:hidden">
            <button
              ref={navToggleRef}
              className="btn-ghost px-2"
              aria-label={navOpen ? '关闭导航' : '打开导航'}
              aria-expanded={navOpen}
              aria-controls="workspace-navigation"
              onClick={() => setNavOpen(!navOpen)}
            >
              {navOpen ? <X size={20} /> : <Menu size={20} />}
            </button>
            <FlaskConical size={18} className="text-violet-400" />
            <span className="font-semibold">PrismLab</span>
          </div>
          <div className="workspace-topbar hidden h-14 items-center justify-between gap-3 border-b border-zinc-800/70 px-8 md:flex">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-zinc-500">本地工作区</span>
              <span className="text-zinc-700">/</span>
              <span className="text-zinc-300">
                {NAV.find((n) => route.path === n.to)?.label ||
                  (/^\/(lab|provider|feature)\//.test(route.path) ? '原生能力实验' : '能力探索')}
              </span>
            </div>
            <a href="#/connections" className="flex items-center gap-2 text-[11px] text-zinc-400 hover:text-zinc-200">
              <KeyRound size={13} />
              {connections.length} 个本机连接
            </a>
          </div>
          {server === 'down' && (
            <div
              role="status"
              className="m-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-900 bg-amber-950/30 p-3 text-xs text-amber-200"
            >
              <div>
                <p className="font-medium">本地服务未连接</p>
                <p className="mt-1 opacity-80">运行 npm run dev，或构建后 npm start。现在仍可浏览能力与实验示例。</p>
              </div>
              <button
                className="btn-outline text-xs"
                onClick={() => {
                  setServer('checking');
                  setRetry((v) => v + 1);
                }}
              >
                重新连接
              </button>
            </div>
          )}
          <RunningSessions />
          <PageBoundary key={route.path}>
            <Suspense
              fallback={
                <div role="status" className="p-8 text-sm text-zinc-400">
                  正在打开工作区…
                </div>
              }
            >
              <Routes />
            </Suspense>
          </PageBoundary>
        </main>
      </div>
      <div
        aria-live="polite"
        className="pointer-events-none fixed right-4 bottom-4 z-50 flex max-w-[calc(100vw-2rem)] flex-col gap-2 md:max-w-md"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`pointer-events-auto rounded-md border px-3 py-2 text-xs shadow-lg ${
              t.tone === 'ok'
                ? 'border-emerald-800 bg-emerald-950/90 text-emerald-200'
                : 'border-rose-800 bg-rose-950/90 text-rose-200'
            }`}
          >
            <span>{t.msg}</span>
            <button
              className="ml-3 rounded p-1 hover:bg-white/10"
              aria-label="关闭通知"
              onClick={() => setToasts((items) => items.filter((item) => item.id !== t.id))}
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </Ctx.Provider>
  );
}

function RunningSessions() {
  const sessions = useRunSessions().filter((s) => s.running);
  if (!sessions.length) return null;
  return (
    <aside
      aria-label="正在运行的实验"
      className="mx-4 mt-4 rounded-xl border border-violet-700/50 bg-violet-950/30 p-3 md:mx-8"
    >
      <p className="mb-2 text-xs text-violet-200" role="status">
        {sessions.length} 个实验运行中 · 可以切换页面，关闭或刷新网页会中断实时连接
      </p>
      <div className="flex flex-wrap gap-2">
        {sessions.map((session) => (
          <div
            key={session.sessionKey}
            className="flex min-w-0 max-w-full items-center gap-2 rounded-lg bg-zinc-950/60 py-1 pl-3 pr-1 text-xs"
          >
            <span className="h-1.5 w-1.5 shrink-0 animate-pulse rounded-full bg-violet-300" />
            <a href={session.href} className="min-w-0 truncate text-violet-100 hover:underline">
              {session.title || '查看实验'}
            </a>
            <button
              className="btn-ghost shrink-0 px-2 text-xs"
              onClick={() => cancelRunSession(session.sessionKey)}
              aria-label={`停止${session.title}`}
            >
              停止
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}

function NavLink({ to, label, icon }: { to: string; label: string; icon: ReactNode }) {
  const route = useRoute();
  const active =
    route.path === to ||
    route.path.startsWith(`${to}/`) ||
    (to === '/explore' && /^\/(provider|feature|lab)\//.test(route.path)) ||
    (to === '/explore' && route.path === '/');
  return (
    <a
      href={href(to)}
      aria-current={active ? 'page' : undefined}
      className={`flex min-h-11 items-center gap-3 rounded-lg px-3 py-2 text-sm transition ${active ? 'bg-violet-600/15 text-violet-200 ring-1 ring-inset ring-violet-500/20' : 'text-zinc-400 hover:bg-zinc-800/70 hover:text-zinc-100'}`}
    >
      <span className="flex w-5 justify-center">{icon}</span>
      {label}
    </a>
  );
}

class PageBoundary extends Component<{ children: ReactNode }, { error: boolean }> {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    if (this.state.error)
      return (
        <div className="m-5 rounded-xl border border-rose-900 bg-rose-950/20 p-6">
          <h1 className="font-semibold">这个页面遇到了异常</h1>
          <p className="my-3 text-sm text-zinc-400">
            已保存的实验仍在本机，当前标签页的草稿也会保留。若刚更新过应用，请重新加载以取得最新页面资源。
          </p>
          <div className="flex flex-wrap gap-3">
            <button className="btn-outline" onClick={() => window.location.reload()}>
              重新加载页面
            </button>
            <a className="btn-ghost" href="#/explore">
              返回工作区
            </a>
          </div>
        </div>
      );
    return this.props.children;
  }
}

function Routes() {
  const route = useRoute();
  const [first, second] = route.parts;
  switch (first) {
    case undefined:
    case 'explore':
      return <ExplorePage />;
    case 'provider':
      return <ProviderPage id={second ?? ''} />;
    case 'feature':
      return <FeaturePage id={second ?? ''} />;
    case 'lab':
      return second ? (
        <LabPage
          key={`${second}:${route.query.get('run') ?? ''}:${route.query.get('preset') ?? ''}`}
          operationId={second}
          runId={route.query.get('run')}
          presetId={route.query.get('preset')}
        />
      ) : (
        <ExplorePage />
      );
    case 'compare':
      return <ComparePage key={route.query.toString()} />;
    case 'bench':
      return <BenchmarkPage />;
    case 'connections':
      return <ConnectionsPage />;
    case 'runs':
      return second ? <RunDetailPage key={second} id={second} /> : <RunsPage />;
    case 'tasks':
      return <TasksPage />;
    case 'assets':
      return <AssetsPage />;
    case 'raw':
      return <RawPage key={route.query.toString()} />;
    case 'settings':
      return <SettingsPage />;
    default:
      return <div className="p-10 text-zinc-500">页面不存在</div>;
  }
}
