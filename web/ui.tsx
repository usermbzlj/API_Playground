import { Suspense, lazy, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import type { EvidenceRow, Insight, Verification } from '../shared/types.ts';

const CodeEditor = lazy(() => import('./components/code-editor.tsx'));

export function Chip({
  children,
  tone = 'zinc',
  title,
  onClick,
}: {
  children: ReactNode;
  tone?: string;
  title?: string;
  onClick?: () => void;
}) {
  const tones: Record<string, string> = {
    zinc: 'border-zinc-700 text-zinc-300',
    violet: 'border-violet-700 text-violet-300',
    green: 'border-emerald-700 text-emerald-300',
    yellow: 'border-amber-700 text-amber-300',
    blue: 'border-sky-700 text-sky-300',
    orange: 'border-orange-700 text-orange-300',
    red: 'border-rose-700 text-rose-300',
  };
  const className = `chip ${tones[tone] ?? tones.zinc} ${onClick ? 'cursor-pointer hover:bg-zinc-800' : ''}`;
  return onClick ? (
    <button type="button" title={title} onClick={onClick} className={className}>
      {children}
    </button>
  ) : (
    <span title={title} className={className}>
      {children}
    </span>
  );
}

export const VERIF: Record<string, { label: string; tone: string; title: string }> = {
  tested: { label: '已实测', tone: 'green', title: '本项目用真实 Key 调用成功，表现符合文档' },
  partial: { label: '部分可用', tone: 'yellow', title: '实测部分可用，或与文档描述不一致' },
  documented: { label: '文档声称', tone: 'blue', title: '官方文档声称支持，尚未用真实 Key 实测' },
  restricted: { label: '需开通', tone: 'orange', title: '需要白名单 / 单独开通 / 特定套餐或地域' },
  failed: { label: '不可用', tone: 'red', title: '实测失败或已停服' },
  unverified: { label: '待确认', tone: 'zinc', title: '线索，尚未确认' },
};

export function VerificationChip({ v }: { v?: Verification }) {
  if (!v) return null;
  const m = VERIF[v.status] ?? VERIF.unverified;
  const tip = `${m.title}${v.date ? `（${v.date}）` : ''}${v.note ? `\n${v.note}` : ''}${v.source ? `\n来源：${v.source}` : ''}`;
  return (
    <Chip tone={m.tone} title={tip}>
      {m.label}
    </Chip>
  );
}

/** Local evidence from this machine's runs, kept separate from catalog claims. */
export function EvidenceChip({ rows }: { rows: EvidenceRow[] }) {
  if (!rows.length) return null;
  const ok = rows.reduce((s, r) => s + r.ok, 0);
  const err = rows.reduce((s, r) => s + r.error, 0);
  const lastOk = rows
    .map((r) => r.lastOkAt)
    .filter(Boolean)
    .sort()
    .pop();
  const lastErr = rows.find((r) => r.lastError)?.lastError;
  const tone = ok > 0 ? 'green' : err > 0 ? 'red' : 'zinc';
  const tip = `本机实验记录：成功 ${ok} 次，失败 ${err} 次${lastOk ? `\n最近成功：${fmtTime(lastOk)}` : ''}${lastErr ? `\n最近错误：${lastErr}` : ''}`;
  return (
    <Chip tone={tone} title={tip}>
      本机 {ok > 0 ? `✓${ok}` : ''}
      {err > 0 ? ` ✗${err}` : ''}
    </Chip>
  );
}

export const COST_LABEL: Record<string, { label: string; tone: string }> = {
  free: { label: '免费', tone: 'green' },
  low: { label: '低成本', tone: 'green' },
  medium: { label: '中成本', tone: 'yellow' },
  high: { label: '高成本 · 需确认', tone: 'red' },
};

export const WORKBENCH_LABEL: Record<string, string> = {
  chat: '对话',
  fim: 'FIM 补全',
  tts: '语音合成',
  music: '音乐生成',
  asr: '语音识别',
  image: '图像',
  video: '视频任务',
  realtime: '实时语音',
  embedding: '向量',
  rerank: '重排',
  model3d: '3D',
  raw: '原始请求',
};

export const KIND_LABEL: Record<string, string> = {
  official: '官方',
  aggregator: '聚合',
  cloud: '云平台',
  generic: '通用协议',
};

export function JsonBlock({
  value,
  max = 30000,
  className = '',
}: {
  value: unknown;
  max?: number;
  className?: string;
}) {
  let text: string;
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    text = String(value);
  }
  if (text.length > max) text = `${text.slice(0, max)}\n…[已截断，完整内容共 ${text.length} 字符]`;
  return (
    <pre
      className={`mono overflow-x-auto rounded-md bg-zinc-950 p-3 text-xs leading-relaxed break-all whitespace-pre-wrap text-zinc-300 ${className}`}
    >
      {text}
    </pre>
  );
}

export function CopyButton({
  text,
  label = '复制',
  className = '',
}: {
  text: string;
  label?: string;
  className?: string;
}) {
  const [ok, setOk] = useState(false);
  const [failed, setFailed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  async function copy() {
    let copied = false;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        copied = true;
      }
    } catch {
      /* use a selectable fallback when clipboard permission is unavailable */
    }
    if (!copied) {
      const active = document.activeElement as HTMLElement | null;
      const area = document.createElement('textarea');
      area.value = text;
      area.style.cssText = 'position:fixed;left:0;top:0;opacity:0;pointer-events:none';
      (active?.closest('dialog') ?? document.body).append(area);
      area.select();
      try {
        copied = document.execCommand('copy');
      } catch {
        /* show an actionable failure */
      }
      area.remove();
      active?.focus({ preventScroll: true });
    }
    setOk(copied);
    setFailed(!copied);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      setOk(false);
      setFailed(false);
    }, 2500);
    if (!copied)
      window.dispatchEvent(
        new CustomEvent('workspace-notice', {
          detail: { message: '复制未成功，请允许剪贴板权限，或选中文字手动复制。', tone: 'err' },
        }),
      );
  }
  return (
    <button
      className={`btn-ghost text-xs ${className}`}
      type="button"
      onClick={copy}
      aria-label={ok ? '已复制' : failed ? '复制失败，检查剪贴板权限' : label}
    >
      {ok ? '已复制' : failed ? '复制失败' : label}
    </button>
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const id = useId();
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const el = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    el.showModal();
    return () => {
      el.close();
      previous?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      aria-labelledby={id}
      className={`card fixed inset-0 m-auto max-h-[90dvh] w-[calc(100%-2rem)] ${wide ? 'max-w-3xl' : 'max-w-lg'} overflow-auto p-5 text-zinc-200 shadow-2xl backdrop:bg-black/75 backdrop:backdrop-blur-sm`}
      onCancel={(event) => {
        event.preventDefault();
        close.current();
      }}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const rect = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < rect.left ||
          event.clientX > rect.right ||
          event.clientY < rect.top ||
          event.clientY > rect.bottom
        )
          close.current();
      }}
    >
      <div className="mb-4 flex items-center justify-between">
        <h2 id={id} className="text-base font-semibold text-zinc-100">
          {title}
        </h2>
        <button className="btn-ghost" onClick={onClose} aria-label="关闭">
          ✕
        </button>
      </div>
      {children}
    </dialog>
  );
}

export function Spinner() {
  return (
    <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-500 border-t-transparent" />
  );
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-zinc-700 p-6 text-center text-sm text-zinc-400">
      {children}
    </div>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const map: Record<string, { label: string; tone: string }> = {
    ok: { label: '成功', tone: 'green' },
    running: { label: '进行中', tone: 'blue' },
    error: { label: '失败', tone: 'red' },
    cancelled: { label: '已取消', tone: 'zinc' },
    pending: { label: '排队中', tone: 'zinc' },
    succeeded: { label: '成功', tone: 'green' },
    failed: { label: '失败', tone: 'red' },
    unknown: { label: '未知', tone: 'yellow' },
  };
  const m = map[status] ?? { label: status, tone: 'zinc' };
  return <Chip tone={m.tone}>{m.label}</Chip>;
}

export function ErrorBox({ error }: { error: any }) {
  if (!error) return null;
  return (
    <div className="rounded-md border border-rose-800 bg-rose-950/40 p-3 text-xs text-rose-200">
      <p className="font-medium">
        {error.title}
        {error.vendorCode != null && (
          <span className="mono ml-2 text-rose-300/80">code: {String(error.vendorCode)}</span>
        )}
      </p>
      {error.vendorMessage && <p className="mono mt-1 break-all text-rose-300/90">{error.vendorMessage}</p>}
      <ul className="mt-1 list-disc pl-5">
        {(error.hints ?? []).map((h: string) => (
          <li key={h}>{h}</li>
        ))}
      </ul>
    </div>
  );
}

export function InsightList({ items }: { items: Insight[] }) {
  if (!items.length)
    return <p className="text-xs text-zinc-400">运行后会在这里给出观察：参数是否生效、缓存命中、截断、工具调用等。</p>;
  const icon = { ok: '✓', info: 'ℹ', warn: '⚠' } as const;
  const tone = { ok: 'text-emerald-300', info: 'text-sky-300', warn: 'text-amber-300' } as const;
  return (
    <ul className="space-y-1.5">
      {items.map((it, i) => (
        <li key={i} className="flex gap-2 text-xs leading-relaxed text-zinc-300">
          <span className={tone[it.level]}>{icon[it.level]}</span>
          <span>{it.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function Tabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: [T, ReactNode][];
  value: T;
  onChange: (v: T) => void;
}) {
  return (
    <div role="group" className="flex flex-wrap gap-1 border-b border-zinc-800 p-2" aria-label="切换内容视图">
      {tabs.map(([k, label]) => (
        <button
          key={k}
          type="button"
          aria-pressed={value === k}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition ${
            value === k
              ? 'bg-violet-500/15 text-violet-200 ring-1 ring-violet-500/30 ring-inset'
              : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100'
          }`}
          onClick={() => onChange(k)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

export function fmtMs(ms?: number | null) {
  return ms == null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function fmtTime(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

export function fmtBytes(n?: number | null) {
  if (n == null) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export interface CodeInputProps {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minHeight?: number;
  lang?: 'json' | 'js' | 'python' | 'text';
}

export function CodeInput(props: CodeInputProps) {
  return (
    <Suspense
      fallback={
        <textarea
          className="input mono"
          aria-label={`${props.lang ?? 'JSON'} 编辑器`}
          style={{ minHeight: props.minHeight ?? 120 }}
          value={props.value}
          placeholder={props.placeholder}
          onChange={(event) => props.onChange(event.target.value)}
        />
      }
    >
      <CodeEditor {...props} />
    </Suspense>
  );
}

marked.setOptions({ gfm: true, breaks: true });

/** Model output rendered as Markdown; HTML is sanitised because the page can reach the local API. */
export function Markdown({ text }: { text: string }) {
  const html = useMemo(
    () =>
      DOMPurify.sanitize(marked.parse(text, { async: false }) as string, {
        FORBID_TAGS: ['style', 'form', 'input'],
        FORBID_ATTR: ['style'],
      }),
    [text],
  );
  return (
    <div className="md text-sm leading-relaxed break-words text-zinc-100" dangerouslySetInnerHTML={{ __html: html }} />
  );
}

/** hex (MiniMax TTS) to base64 for data URLs. */
export function hexToBase64(hex: string): string {
  const clean = hex.trim();
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}

export function Field({ label, hint, children }: { label: ReactNode; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block">
      <span className="label">{label}</span>
      <div className="mt-1">{children}</div>
      {hint && <p className="mt-0.5 text-xs leading-relaxed text-zinc-400">{hint}</p>}
    </label>
  );
}
