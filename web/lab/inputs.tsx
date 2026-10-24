import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { api } from '../api.ts';
import { useApp } from '../app.tsx';
import type { AssetInfo, InputField, OperationDef } from '../../shared/types.ts';
import { CodeInput, EmptyHint, Field, Modal, Spinner, fmtBytes } from '../ui.tsx';
import { appendMessageAsset } from './input-state.ts';

export const WORKBENCH_DEFAULTS: Record<string, Record<string, unknown>> = {
  chat: { system: '', messages: [{ role: 'user', content: '' }], prefix: '', stream: true, keepReasoning: false },
  fim: { prefix: '', suffix: '', stream: true, lang: 'js' },
  tts: { text: '' },
  asr: { audio: null },
  image: { prompt: '', negative: '', images: [] },
  video: { prompt: '', negative: '', firstFrame: null, lastFrame: null, references: [] },
  embedding: { texts: ['', '', ''] },
  rerank: { query: '', documents: ['', '', ''] },
  model3d: { prompt: '', images: [] },
  realtime: {},
};

const assetCache = new Map<string, AssetInfo>();

function useAsset(id: string | null | undefined) {
  const [a, setA] = useState<AssetInfo | undefined>(id ? assetCache.get(id) : undefined);
  useEffect(() => {
    let active = true;
    if (!id) return setA(undefined);
    if (assetCache.has(id)) return setA(assetCache.get(id));
    api
      .asset(id)
      .then((x) => {
        assetCache.set(id, x);
        if (active) setA(x);
      })
      .catch(() => {
        if (active) setA(undefined);
      });
    return () => {
      active = false;
    };
  }, [id]);
  return a;
}

function AssetThumb({ id, onRemove }: { id: string; onRemove?: () => void }) {
  const a = useAsset(id);
  const src = `/api/assets/${id}/raw`;
  return (
    <span className="relative inline-block">
      {a?.kind === 'video' ? (
        <video src={src} className="h-16 rounded border border-zinc-700" muted />
      ) : a?.kind === 'audio' ? (
        <audio src={src} controls className="h-8 w-56" />
      ) : (
        <img
          src={src}
          className="h-16 rounded border border-zinc-700 object-cover"
          alt={a?.filename ?? ''}
          title={a?.remoteUrl ?? a?.filename}
        />
      )}
      {onRemove && (
        <button
          className="absolute -top-2 -right-2 flex h-7 w-7 items-center justify-center rounded-full border border-zinc-700 bg-zinc-900 text-xs text-rose-300 shadow"
          aria-label={`移除素材 ${a?.filename ?? id}`}
          onClick={onRemove}
        >
          ✕
        </button>
      )}
    </span>
  );
}

/** Upload a file or register a URL; returns asset ids. */
export function AssetPicker({
  accept,
  kind,
  onAdd,
  label = '添加',
}: {
  accept: string;
  kind: 'image' | 'video' | 'audio';
  onAdd: (id: string) => void;
  label?: string;
}) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const onAddRef = useRef(onAdd);
  onAddRef.current = onAdd;
  const fileInput = useRef<HTMLInputElement>(null);
  const [library, setLibrary] = useState(false);
  async function upload(file: File) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const a = await api.uploadAsset(file);
      assetCache.set(a.id, a);
      onAddRef.current(a.id);
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }
  async function byUrl() {
    if (busyRef.current) return;
    const url = prompt('输入可公开访问的链接（部分接口只接受 URL，不接受上传的文件）');
    if (!url) return;
    busyRef.current = true;
    setBusy(true);
    try {
      const a = await api.assetFromUrl(url.trim(), kind);
      assetCache.set(a.id, a);
      onAddRef.current(a.id);
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  return (
    <span className="inline-flex flex-wrap gap-1">
      <button
        type="button"
        className="btn-outline min-h-9 px-2 py-1 text-xs"
        disabled={busy}
        onClick={() => fileInput.current?.click()}
      >
        {busy ? '上传中…' : `${label}文件`}
      </button>
      <input
        ref={fileInput}
        type="file"
        accept={accept}
        className="hidden"
        disabled={busy}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) upload(f);
          e.target.value = '';
        }}
      />
      <button type="button" className="btn-ghost min-h-9 px-2 py-1 text-xs" disabled={busy} onClick={byUrl}>
        链接
      </button>
      <button
        type="button"
        className="btn-ghost min-h-9 px-2 py-1 text-xs"
        disabled={busy}
        onClick={() => setLibrary(true)}
      >
        素材库
      </button>
      {library && (
        <AssetLibraryPicker
          kind={kind}
          onClose={() => setLibrary(false)}
          onSelect={(asset) => {
            assetCache.set(asset.id, asset);
            onAddRef.current(asset.id);
            setLibrary(false);
          }}
        />
      )}
    </span>
  );
}

function AssetLibraryPicker({
  kind,
  onClose,
  onSelect,
}: {
  kind: 'image' | 'video' | 'audio';
  onClose: () => void;
  onSelect: (asset: AssetInfo) => void;
}) {
  const [query, setQuery] = useState('');
  const [offset, setOffset] = useState(0);
  const [items, setItems] = useState<AssetInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setLoading(true);
    const timer = setTimeout(() => {
      api
        .assets({ kind, q: query, limit: 25, offset })
        .then((rows) => {
          if (active) {
            setItems(rows);
            setError('');
          }
        })
        .catch((failure: any) => {
          if (active) setError(failure.message);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    }, 180);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [kind, query, offset, retry]);
  return (
    <Modal wide title="选择已有素材" onClose={onClose}>
      <div className="space-y-4">
        <input
          type="search"
          className="input"
          aria-label="搜索已有素材"
          placeholder="按文件名搜索…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setOffset(0);
          }}
        />
        {error ? (
          <div role="alert" className="space-y-2 text-sm text-rose-300">
            <p>{error}</p>
            <button className="btn-outline" onClick={() => setRetry((value) => value + 1)}>
              重新加载
            </button>
          </div>
        ) : loading ? (
          <Spinner />
        ) : !items.length ? (
          <EmptyHint>没有匹配的素材。上传文件后可以在这里复用。</EmptyHint>
        ) : (
          <div className="grid max-h-[55dvh] grid-cols-2 gap-3 overflow-auto sm:grid-cols-3">
            {items.slice(0, 24).map((asset) => (
              <button
                type="button"
                key={asset.id}
                className="card min-w-0 space-y-2 p-3 text-left hover:border-violet-500"
                onClick={() => onSelect(asset)}
              >
                {asset.kind === 'image' ? (
                  <img className="h-24 w-full rounded object-contain" src={asset.url} alt="" loading="lazy" />
                ) : (
                  <span className="block py-5 text-center text-sm text-violet-300">
                    {asset.kind === 'audio' ? '音频' : '视频'}
                  </span>
                )}
                <span className="block break-all text-xs text-zinc-200">{asset.filename}</span>
                <span className="block text-[11px] text-zinc-500">{fmtBytes(asset.size)} · 选择</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex justify-between gap-3">
          <button
            className="btn-outline"
            disabled={loading || offset === 0}
            onClick={() => setOffset((value) => Math.max(0, value - 24))}
          >
            上一页
          </button>
          <button
            className="btn-outline"
            disabled={loading || items.length <= 24}
            onClick={() => setOffset((value) => value + 24)}
          >
            下一页
          </button>
        </div>
      </div>
    </Modal>
  );
}

function AssetSlot({
  label,
  hint,
  value,
  onChange,
  kind = 'image',
}: {
  label: string;
  hint?: string;
  value: string | null | undefined;
  onChange: (v: string | null) => void;
  kind?: 'image' | 'video' | 'audio';
}) {
  return (
    <div>
      <span className="label">{label}</span>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {value ? (
          <AssetThumb id={value} onRemove={() => onChange(null)} />
        ) : (
          <AssetPicker accept={`${kind}/*`} kind={kind} onAdd={(id) => onChange(id)} />
        )}
      </div>
      {hint && <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p>}
    </div>
  );
}

function AssetList({
  label,
  hint,
  value,
  onChange,
  kind = 'image',
  max,
}: {
  label: string;
  hint?: string;
  value: string[];
  onChange: (v: string[]) => void;
  kind?: 'image' | 'video' | 'audio';
  max?: number;
}) {
  return (
    <div>
      <span className="label">
        {label}
        {max ? `（最多 ${max}）` : ''}
      </span>
      <div className="mt-1 flex flex-wrap items-center gap-2">
        {value.map((id) => (
          <AssetThumb key={id} id={id} onRemove={() => onChange(value.filter((x) => x !== id))} />
        ))}
        {(!max || value.length < max) && (
          <AssetPicker accept={`${kind}/*`} kind={kind} onAdd={(id) => onChange([...value, id])} />
        )}
      </div>
      {hint && <p className="mt-0.5 text-[11px] text-zinc-500">{hint}</p>}
    </div>
  );
}

type SetInput = Dispatch<SetStateAction<Record<string, unknown>>>;

export function WorkbenchInput({
  op,
  input,
  setInput,
}: {
  op: OperationDef;
  input: Record<string, unknown>;
  setInput: SetInput;
}) {
  switch (op.workbench) {
    case 'chat':
      return <ChatInputEditor op={op} input={input} setInput={setInput} />;
    case 'fim':
      return <FimInput input={input} setInput={setInput} />;
    case 'tts':
      return <TtsInput op={op} input={input} setInput={setInput} />;
    case 'image':
    case 'video':
    case 'model3d':
    case 'asr':
      return <MediaInput op={op} input={input} setInput={setInput} />;
    case 'embedding':
      return (
        <ListInput
          label="文本（每项一条，计算两两相似度）"
          items={(input.texts as string[]) ?? []}
          onChange={(texts) => setInput({ ...input, texts })}
        />
      );
    case 'rerank':
      return (
        <div className="space-y-3">
          <Field label="查询 query">
            <textarea
              className="input min-h-14"
              value={String(input.query ?? '')}
              onChange={(e) => setInput({ ...input, query: e.target.value })}
            />
          </Field>
          <ListInput
            label="候选文档 documents"
            items={(input.documents as string[]) ?? []}
            onChange={(documents) => setInput({ ...input, documents })}
          />
        </div>
      );
    default:
      return <p className="text-xs text-zinc-500">该工作台没有输入项。</p>;
  }
}

function ListInput({ label, items, onChange }: { label: string; items: string[]; onChange: (v: string[]) => void }) {
  return (
    <div>
      <div className="flex items-center justify-between">
        <span className="label">{label}</span>
        <button className="btn-ghost px-2 py-0.5 text-xs" onClick={() => onChange([...items, ''])}>
          + 添加
        </button>
      </div>
      <div className="mt-1 space-y-1.5">
        {items.map((t, i) => (
          <div key={i} className="flex gap-1.5">
            <span className="mono w-5 pt-1.5 text-right text-[11px] text-zinc-600">{i}</span>
            <textarea
              className="input min-h-10 flex-1"
              aria-label={`${label} ${i + 1}`}
              value={t}
              onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
            />
            <button
              className="btn-ghost px-1.5 text-xs text-zinc-600"
              aria-label={`移除${label} ${i + 1}`}
              onClick={() => onChange(items.filter((_, j) => j !== i))}
            >
              ✕
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

interface Msg {
  _id?: string;
  role: string;
  content: string;
  images?: string[];
  videos?: string[];
  reasoning_content?: string;
  tool_calls?: any[];
  tool_call_id?: string;
  name?: string;
  blocks?: unknown[];
}

function ChatInputEditor({
  op,
  input,
  setInput,
}: {
  op: OperationDef;
  input: Record<string, unknown>;
  setInput: SetInput;
}) {
  const messages = (input.messages as Msg[]) ?? [];
  const setMessages = (msgs: Msg[]) => setInput((previous) => ({ ...previous, messages: msgs }));
  useEffect(() => {
    if (messages.some((message) => !message._id))
      setInput((previous) => ({
        ...previous,
        messages: ((previous.messages as Msg[]) ?? []).map((message) =>
          message._id ? message : { ...message, _id: crypto.randomUUID() },
        ),
      }));
  }, [messages, setInput]);
  function addMessageAsset(messageId: string | undefined, kind: 'images' | 'videos', assetId: string) {
    if (!messageId) return;
    setInput((previous) => appendMessageAsset(previous, messageId, kind, assetId));
  }
  const allowVideo = op.features.includes('video-understanding');
  return (
    <div className="space-y-3">
      <Field label="系统指令（可选）">
        <textarea
          className="input min-h-12"
          value={String(input.system ?? '')}
          onChange={(e) => setInput({ ...input, system: e.target.value })}
          placeholder="例如：你是一个简洁的助手"
        />
      </Field>
      <div>
        <div className="flex items-center justify-between">
          <span className="label">对话消息（{messages.length}）</span>
          <div className="flex gap-1">
            <button
              className="btn-ghost px-2 py-0.5 text-xs"
              onClick={() => setMessages([...messages, { role: 'user', content: '' }])}
            >
              + 用户消息
            </button>
            <button
              className="btn-ghost px-2 py-0.5 text-xs"
              onClick={() => setMessages([...messages, { role: 'assistant', content: '' }])}
            >
              + 助手消息
            </button>
            {messages.length > 1 && (
              <button
                className="btn-ghost px-2 py-0.5 text-xs text-zinc-500"
                onClick={() => setMessages([{ role: 'user', content: '' }])}
              >
                清空
              </button>
            )}
          </div>
        </div>
        <div className="mt-1.5 space-y-2">
          {messages.map((m, i) => (
            <div
              key={m._id ?? i}
              className={`rounded-md border p-2 ${m.role === 'user' ? 'border-violet-900/60 bg-violet-950/20' : m.role === 'tool' ? 'border-amber-900/60 bg-amber-950/10' : 'border-zinc-800 bg-zinc-950/40'}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <select
                  className="input w-28 py-1 text-xs"
                  value={m.role}
                  onChange={(e) => setMessages(messages.map((x, j) => (j === i ? { ...x, role: e.target.value } : x)))}
                >
                  {['user', 'assistant', 'system', 'tool'].map((r) => (
                    <option key={r} value={r}>
                      {r}
                    </option>
                  ))}
                </select>
                {m.role === 'tool' && (
                  <input
                    className="input mono w-48 py-1 text-xs"
                    placeholder="tool_call_id"
                    value={m.tool_call_id ?? ''}
                    onChange={(e) =>
                      setMessages(messages.map((x, j) => (j === i ? { ...x, tool_call_id: e.target.value } : x)))
                    }
                  />
                )}
                {m.role === 'tool' && m.name && <span className="mono text-[11px] text-amber-300">{m.name}</span>}
                {m.role === 'user' && (
                  <AssetPicker
                    accept="image/*"
                    kind="image"
                    label="图片"
                    onAdd={(id) => addMessageAsset(m._id, 'images', id)}
                  />
                )}
                {m.role === 'user' && allowVideo && (
                  <AssetPicker
                    accept="video/*"
                    kind="video"
                    label="视频"
                    onAdd={(id) => addMessageAsset(m._id, 'videos', id)}
                  />
                )}
                <span className="flex-1" />
                <button
                  className="btn-ghost px-1.5 py-0.5 text-xs text-zinc-600"
                  onClick={() => setMessages(messages.filter((_, j) => j !== i))}
                >
                  删除
                </button>
              </div>
              {m.reasoning_content && (
                <details className="mt-1.5 text-[11px] text-zinc-500">
                  <summary className="cursor-pointer">
                    附带的思考内容（{m.reasoning_content.length} 字符，勾选「回传历史思考」时会随请求发出）
                  </summary>
                  <div className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap">{m.reasoning_content}</div>
                </details>
              )}
              {!!m.tool_calls?.length && (
                <div className="mono mt-1.5 space-y-0.5 text-[11px] text-violet-300">
                  {m.tool_calls.map((tc: any, k: number) => (
                    <div key={k}>
                      🔧 {tc.function?.name}({tc.function?.arguments}) <span className="text-zinc-600">{tc.id}</span>
                    </div>
                  ))}
                </div>
              )}
              <textarea
                className="input mt-1.5 min-h-12"
                value={m.content}
                readOnly={op.protocol === 'gemini-generate' && m.role === 'assistant' && !!m.blocks?.length}
                onChange={(e) => setMessages(messages.map((x, j) => (j === i ? { ...x, content: e.target.value } : x)))}
                placeholder={
                  m.role === 'user' ? '用户消息…' : m.role === 'tool' ? '工具返回结果（通常是 JSON）…' : '消息内容…'
                }
              />
              {op.protocol === 'gemini-generate' && m.role === 'assistant' && !!m.blocks?.length && (
                <p className="mt-1 text-[11px] text-zinc-500">
                  已保留原生 parts 与思考签名，供下一轮原样回传。要改写此回答，请删除此条并添加新的 assistant 消息。
                </p>
              )}
              {m.images?.length || m.videos?.length ? (
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {(m.images ?? []).map((id) => (
                    <AssetThumb
                      key={id}
                      id={id}
                      onRemove={() =>
                        setMessages(
                          messages.map((x, j) =>
                            j === i ? { ...x, images: (x.images ?? []).filter((g) => g !== id) } : x,
                          ),
                        )
                      }
                    />
                  ))}
                  {(m.videos ?? []).map((id) => (
                    <AssetThumb
                      key={id}
                      id={id}
                      onRemove={() =>
                        setMessages(
                          messages.map((x, j) =>
                            j === i ? { ...x, videos: (x.videos ?? []).filter((g) => g !== id) } : x,
                          ),
                        )
                      }
                    />
                  ))}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      {op.features.includes('prefix') && (
        <Field
          label="Assistant 前缀（前缀续写）"
          hint="会作为最后一条 assistant 消息发出，强制模型从这里接着写；留空则不使用。"
        >
          <textarea
            className="input mono min-h-12"
            value={String(input.prefix ?? '')}
            onChange={(e) => setInput({ ...input, prefix: e.target.value })}
            placeholder={'例如：```json\n{'}
          />
        </Field>
      )}
      <div className="flex flex-wrap gap-4 text-xs text-zinc-400">
        <label className="flex items-center gap-1.5">
          <input
            type="checkbox"
            checked={input.stream !== false}
            onChange={(e) => setInput({ ...input, stream: e.target.checked })}
          />
          流式输出
        </label>
        {(op.features.includes('reasoning') || op.features.includes('reasoning-history')) && (
          <label
            className="flex items-center gap-1.5"
            title="多轮对话时，把历史 assistant 消息里的 reasoning_content 一并发出（部分厂商在工具调用中要求回传，部分厂商要求不回传）"
          >
            <input
              type="checkbox"
              checked={input.keepReasoning === true}
              onChange={(e) => setInput({ ...input, keepReasoning: e.target.checked })}
            />
            回传历史思考内容
          </label>
        )}
      </div>
    </div>
  );
}

function FimInput({ input, setInput }: { input: Record<string, unknown>; setInput: SetInput }) {
  const lang = (input.lang as 'js' | 'python' | 'text') ?? 'js';
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        语法高亮：
        {(['js', 'python', 'text'] as const).map((l) => (
          <button
            key={l}
            className={lang === l ? 'btn-primary px-2 py-0.5 text-xs' : 'btn-ghost px-2 py-0.5 text-xs'}
            onClick={() => setInput({ ...input, lang: l })}
          >
            {l === 'js' ? 'TS/JS' : l === 'python' ? 'Python' : '纯文本'}
          </button>
        ))}
      </div>
      <Field label="前缀 prefix（光标之前）">
        <CodeInput
          lang={lang}
          value={String(input.prefix ?? '')}
          onChange={(v) => setInput({ ...input, prefix: v })}
          minHeight={120}
        />
      </Field>
      <div className="rounded-md border border-dashed border-violet-700/70 bg-violet-950/20 px-3 py-2 text-center text-[11px] text-violet-300">
        ▼ 模型要补全的空缺 ▼
      </div>
      <Field label="后缀 suffix（光标之后）">
        <CodeInput
          lang={lang}
          value={String(input.suffix ?? '')}
          onChange={(v) => setInput({ ...input, suffix: v })}
          minHeight={100}
        />
      </Field>
      <label className="flex items-center gap-1.5 text-xs text-zinc-400">
        <input
          type="checkbox"
          checked={input.stream !== false}
          onChange={(e) => setInput({ ...input, stream: e.target.checked })}
        />
        流式输出
      </label>
    </div>
  );
}

function TtsInput({ op, input, setInput }: { op: OperationDef; input: Record<string, unknown>; setInput: SetInput }) {
  return (
    <div className="space-y-3">
      <Field label="要合成的文字" hint={op.inputHints?.prompt}>
        <textarea
          className="input min-h-32"
          value={String(input.text ?? '')}
          onChange={(e) => setInput({ ...input, text: e.target.value })}
          placeholder="输入要转成语音的文字…"
        />
      </Field>
      {op.inputFields?.includes('voicePrompt') && (
        <Field
          label="语气 / 风格指令"
          hint={op.inputHints?.voicePrompt ?? '用自然语言描述语气、情绪、语速，例如「用温柔、略带笑意的语气慢慢读」'}
        >
          <textarea
            className="input min-h-14"
            value={String(input.instructions ?? '')}
            onChange={(e) => setInput({ ...input, instructions: e.target.value })}
          />
        </Field>
      )}
      <p className="text-[11px] leading-relaxed text-zinc-500">
        音色、语速、情绪、音频格式等在右侧「原生参数」里调整。想听同一句话的不同情绪，用「加入对比」开多条通道一起跑。
      </p>
    </div>
  );
}

const FIELD_LABEL: Record<InputField, string> = {
  prompt: '提示词 prompt',
  negative: '反向提示词',
  images: '参考图',
  firstFrame: '首帧图',
  lastFrame: '尾帧图',
  references: '参考素材（主体 / 风格）',
  audio: '音频',
  video: '视频',
  mask: '蒙版',
  voicePrompt: '语气指令',
};

function MediaInput({ op, input, setInput }: { op: OperationDef; input: Record<string, unknown>; setInput: SetInput }) {
  const fields: InputField[] = op.inputFields ?? (op.workbench === 'asr' ? ['audio'] : ['prompt']);
  const hint = (f: InputField) => op.inputHints?.[f];
  return (
    <div className="space-y-3">
      {fields.includes('prompt') && (
        <Field label={FIELD_LABEL.prompt} hint={hint('prompt')}>
          <textarea
            className="input min-h-24"
            value={String(input.prompt ?? '')}
            onChange={(e) => setInput({ ...input, prompt: e.target.value })}
            placeholder="描述画面、主体、动作、镜头、风格…"
          />
        </Field>
      )}
      {fields.includes('negative') && (
        <Field label={FIELD_LABEL.negative} hint={hint('negative')}>
          <textarea
            className="input min-h-12"
            value={String(input.negative ?? '')}
            onChange={(e) => setInput({ ...input, negative: e.target.value })}
            placeholder="不希望出现的内容"
          />
        </Field>
      )}
      <div className="flex flex-wrap gap-4">
        {fields.includes('firstFrame') && (
          <AssetSlot
            label={FIELD_LABEL.firstFrame}
            hint={hint('firstFrame')}
            value={input.firstFrame as string}
            onChange={(v) => setInput((previous) => ({ ...previous, firstFrame: v }))}
          />
        )}
        {fields.includes('lastFrame') && (
          <AssetSlot
            label={FIELD_LABEL.lastFrame}
            hint={hint('lastFrame')}
            value={input.lastFrame as string}
            onChange={(v) => setInput((previous) => ({ ...previous, lastFrame: v }))}
          />
        )}
      </div>
      {fields.includes('images') && (
        <AssetList
          label={FIELD_LABEL.images}
          hint={hint('images')}
          value={(input.images as string[]) ?? []}
          onChange={(v) => setInput((previous) => ({ ...previous, images: v }))}
        />
      )}
      {fields.includes('references') && (
        <AssetList
          label={FIELD_LABEL.references}
          hint={hint('references')}
          value={(input.references as string[]) ?? []}
          onChange={(v) => setInput((previous) => ({ ...previous, references: v }))}
        />
      )}
      {fields.includes('mask') && (
        <AssetSlot
          label={FIELD_LABEL.mask}
          hint={hint('mask') ?? '白色区域为要重绘的部分'}
          value={input.mask as string}
          onChange={(v) => setInput((previous) => ({ ...previous, mask: v }))}
        />
      )}
      {fields.includes('audio') && (
        <AssetSlot
          kind="audio"
          label={FIELD_LABEL.audio}
          hint={hint('audio')}
          value={input.audio as string}
          onChange={(v) => setInput((previous) => ({ ...previous, audio: v }))}
        />
      )}
      {fields.includes('video') && (
        <AssetSlot
          kind="video"
          label={FIELD_LABEL.video}
          hint={hint('video')}
          value={input.video as string}
          onChange={(v) => setInput((previous) => ({ ...previous, video: v }))}
        />
      )}
    </div>
  );
}
