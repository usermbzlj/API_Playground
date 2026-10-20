import { useState, type ReactNode } from 'react';
import CodeMirror from '@uiw/react-codemirror';
import { json as jsonLang } from '@codemirror/lang-json';
import type { Verification } from '../shared/types.ts';

export function Chip({ children, tone = 'zinc', title }: { children: ReactNode; tone?: string; title?: string }) {
  const tones: Record<string, string> = {
    zinc: 'border-zinc-700 text-zinc-300',
    violet: 'border-violet-700 text-violet-300',
    green: 'border-emerald-700 text-emerald-300',
    yellow: 'border-amber-700 text-amber-300',
    blue: 'border-sky-700 text-sky-300',
    orange: 'border-orange-700 text-orange-300',
    red: 'border-rose-700 text-rose-300',
  };
  return (
    <span title={title} className={`chip ${tones[tone] ?? tones.zinc}`}>
      {children}
    </span>
  );
}

const VERIF: Record<string, { label: string; tone: string; title: string }> = {
  tested: { label: '已实测', tone: 'green', title: '本项目用真实 Key 调用成功' },
  partial: { label: '部分可用', tone: 'yellow', title: '实测部分可用或与文档不符' },
  documented: { label: '文档支持', tone: 'blue', title: '官方文档声称支持，尚未实测' },
  restricted: { label: '受限', tone: 'orange', title: '需要白名单 / 开通 / 特定套餐或地域' },
  failed: { label: '实测失败', tone: 'red', title: '本项目实测失败' },
  unverified: { label: '未验证', tone: 'zinc', title: '线索，未确认' },
};

export function VerificationChip({ v }: { v?: Verification }) {
  if (!v) return null;
  const m = VERIF[v.status] ?? VERIF.unverified;
  const tip = `${m.title}${v.date ? `（${v.date}）` : ''}${v.note ? `：${v.note}` : ''}${v.source ? `\n来源：${v.source}` : ''}`;
  return (
    <Chip tone={m.tone} title={tip}>
      {m.label}
    </Chip>
  );
}

export const COST_LABEL: Record<string, { label: string; tone: string }> = {
  free: { label: '免费', tone: 'green' },
  low: { label: '低成本', tone: 'green' },
  medium: { label: '中成本', tone: 'yellow' },
  high: { label: '高成本', tone: 'red' },
};

export const WORKBENCH_LABEL: Record<string, string> = {
  chat: '对话',
  fim: 'FIM 补全',
  tts: '语音合成',
  image: '图像',
  'video-task': '视频任务',
  realtime: '实时语音',
  embedding: '向量',
  rerank: '重排',
  raw: '原始请求',
};

export function JsonBlock({ value, max = 30000 }: { value: unknown; max?: number }) {
  let text: string;
  try {
    text = typeof value === 'string' ? value : (JSON.stringify(value, null, 2) ?? String(value));
  } catch {
    text = String(value);
  }
  if (text.length > max) text = `${text.slice(0, max)}\n…[已截断，完整内容共 ${text.length} 字符]`;
  return (
    <pre className="mono overflow-x-auto rounded-md bg-zinc-950 p-3 text-xs leading-relaxed whitespace-pre-wrap break-all text-zinc-300">
      {text}
    </pre>
  );
}

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [ok, setOk] = useState(false);
  return (
    <button
      className="btn-ghost text-xs"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setOk(true);
            setTimeout(() => setOk(false), 1500);
          })
          .catch(() => {});
      }}
    >
      {ok ? '已复制' : label}
    </button>
  );
}

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className={`card max-h-[90vh] w-full ${wide ? 'max-w-3xl' : 'max-w-lg'} overflow-auto p-5`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-zinc-100">{title}</h2>
          <button className="btn-ghost" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function Spinner() {
  return <span className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-zinc-500 border-t-transparent" />;
}

export function EmptyHint({ children }: { children: ReactNode }) {
  return <div className="rounded-lg border border-dashed border-zinc-700 p-6 text-center text-sm text-zinc-500">{children}</div>;
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

export function fmtMs(ms?: number | null) {
  return ms == null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`;
}

export function fmtTime(iso?: string | null) {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${d.toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })} ${d.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })}`;
}

export function CodeInput({
  value,
  onChange,
  placeholder,
  minHeight = 120,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  minHeight?: number;
}) {
  return (
    <div className="overflow-hidden rounded-md border border-zinc-700 bg-zinc-950">
      <CodeMirror
        value={value}
        onChange={onChange}
        extensions={[jsonLang()]}
        placeholder={placeholder}
        minHeight={`${minHeight}px`}
        theme="dark"
        basicSetup={{ lineNumbers: false, highlightActiveLine: false, foldGutter: false }}
      />
    </div>
  );
}

/** hex（MiniMax TTS 返回格式）转 data URL，供 <audio> 播放。 */
export function hexToBase64(hex: string): string {
  const clean = hex.trim();
  const bytes = new Uint8Array(clean.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.substr(i * 2, 2), 16);
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}
