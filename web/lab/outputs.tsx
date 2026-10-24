import { useEffect, useMemo, useState } from 'react';
import { api } from '../api.ts';
import type { AssetInfo, OperationDef, TaskRecord } from '../../shared/types.ts';
import type { AudioView, ChatView, View } from '../../shared/protocols.ts';
import { parseEmbeddings, parseRerank } from '../../shared/providers/_common.ts';
import { cosine } from '../../shared/util.ts';
import {
  Chip,
  CopyButton,
  EmptyHint,
  ErrorBox,
  JsonBlock,
  Markdown,
  Spinner,
  StatusBadge,
  fmtBytes,
  fmtMs,
  hexToBase64,
} from '../ui.tsx';
import { TokenMicroscope } from './tokens.tsx';
import { ModelPreview } from './model3d.tsx';

export interface OutputProps {
  op: OperationDef;
  input: Record<string, unknown>;
  view: View;
  response: any;
  artifacts: AssetInfo[];
  running: boolean;
  error: any;
  taskId?: string;
  hasEvents: boolean;
  /** chat: append messages to the conversation, optionally run again */
  onAppend?: (msgs: any[], runAgain: boolean) => void;
  compact?: boolean;
  resultKey?: string;
}

export function OutputView(p: OutputProps) {
  if (!p.hasEvents && !p.response && !p.running && !p.error && !p.taskId && !p.artifacts.length)
    return <EmptyHint>点击「▶ 运行」发起真实调用</EmptyHint>;
  return (
    <div className="space-y-3">
      {p.running && !p.hasEvents && (
        <div className="flex items-center gap-2 text-xs text-zinc-400">
          <Spinner /> 正在请求…
        </div>
      )}
      {renderBody(p)}
      {p.error && !p.error.costConfirm && <ErrorBox error={p.error} />}
    </div>
  );
}

function renderBody(p: OutputProps) {
  switch (p.op.workbench) {
    case 'chat':
      return <ChatOutput {...p} />;
    case 'fim':
      return <FimOutput {...p} />;
    case 'tts':
    case 'music':
      return <AudioOutput {...p} />;
    case 'image':
      return <ImageOutput {...p} />;
    case 'video':
    case 'model3d':
      return <TaskOutput {...p} />;
    case 'embedding':
      return <EmbeddingOutput {...p} />;
    case 'rerank':
      return <RerankOutput {...p} />;
    case 'asr':
      return <AsrOutput {...p} />;
    default:
      return p.response ? <JsonBlock value={p.response} /> : null;
  }
}

// ------------------------------------------------------------------ chat

function ChatOutput({ view, running, onAppend, op, compact, resultKey }: OutputProps) {
  const v = view as ChatView;
  const [mode, setMode] = useState<'md' | 'raw' | 'tokens'>('md');
  const [toolResults, setToolResults] = useState<Record<string, string>>({});
  const toolKey = (call: ChatView['toolCalls'][number], index: number) =>
    JSON.stringify([resultKey, call.id, call.name, call.args, index]);
  useEffect(() => {
    setToolResults({});
  }, [resultKey]);
  useEffect(() => {
    if (v.logprobs.length && mode === 'md' && !running) setMode('tokens');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v.logprobs.length > 0, running]);
  if (v.kind !== 'chat') return null;
  const anthropic = op.protocol === 'anthropic-messages';
  const gemini = op.protocol === 'gemini-generate';

  function assistantMessage() {
    const msg: any = { role: 'assistant', content: v.text };
    if (v.reasoning) msg.reasoning_content = v.reasoning;
    if (v.toolCalls.length && !anthropic) {
      msg.tool_calls = v.toolCalls
        .filter((t) => !t.builtin)
        .map((t) => ({ id: t.id, type: t.type ?? 'function', function: { name: t.name, arguments: t.args } }));
    }
    if (anthropic) {
      msg.blocks = v.blocks
        .map((b) => {
          if (b.type === 'text') return { type: 'text', text: b.text };
          if (b.type === 'thinking') return { type: 'thinking', thinking: b.text, signature: b.data?.signature };
          if (b.type === 'redacted_thinking') return { type: 'redacted_thinking', data: b.data?.data };
          if (b.type === 'tool_use') {
            let input: any = {};
            try {
              input = JSON.parse(b.text || '{}');
            } catch {
              /* keep empty */
            }
            return { type: 'tool_use', id: b.data?.id, name: b.data?.name, input };
          }
          return null;
        })
        .filter(Boolean);
      msg.tool_calls = v.toolCalls
        .filter((t) => !t.builtin)
        .map((t) => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.args } }));
    }
    if (gemini)
      msg.blocks = v.blocks
        .filter((b) => b.type === 'gemini_part')
        .map((b) => ({ ...b, data: structuredClone(b.data) }));
    return msg;
  }

  const clientTools = v.toolCalls.filter((t) => !t.builtin);
  return (
    <div className="space-y-3">
      {v.reasoning && (
        <details open={running && !v.text} className="rounded-md border border-zinc-800 bg-zinc-950/50 p-2">
          <summary className="cursor-pointer text-[11px] text-zinc-400">
            💭 思考内容 · {v.reasoning.length} 字符
            {v.firstReasoningMs != null && ` · 首个思考块 ${fmtMs(v.firstReasoningMs)}`}
            {v.firstTextMs != null && ` · 正文开始于 ${fmtMs(v.firstTextMs)}`}
          </summary>
          <div className="mt-1.5 max-h-96 overflow-auto text-xs leading-relaxed whitespace-pre-wrap text-zinc-400">
            {v.reasoning}
          </div>
        </details>
      )}
      {(v.text || running) && (
        <div className="rounded-md bg-emerald-950/20 p-3">
          <div className="mb-1.5 flex items-center gap-2 text-[11px] text-zinc-500">
            assistant
            {v.finishReason && (
              <Chip tone={v.finishReason === 'length' || v.finishReason === 'max_tokens' ? 'yellow' : 'zinc'}>
                {v.finishReason}
              </Chip>
            )}
            {v.responseModel && <span className="mono">{v.responseModel}</span>}
            <span className="flex-1" />
            {!compact && (
              <span className="flex gap-1">
                {(['md', 'raw', ...(v.logprobs.length ? ['tokens'] : [])] as const).map((m) => (
                  <button
                    key={m}
                    className={mode === m ? 'btn-primary px-1.5 py-0 text-[11px]' : 'btn-ghost px-1.5 py-0 text-[11px]'}
                    onClick={() => setMode(m as any)}
                  >
                    {m === 'md' ? 'Markdown' : m === 'raw' ? '原文' : 'Token 显微镜'}
                  </button>
                ))}
              </span>
            )}
            <CopyButton text={v.text} label="复制" className="px-1.5 py-0 text-[11px]" />
          </div>
          {mode === 'tokens' && v.logprobs.length ? (
            <TokenMicroscope tokens={v.logprobs} />
          ) : mode === 'raw' || running ? (
            <div className="text-sm leading-relaxed break-words whitespace-pre-wrap text-zinc-100">
              {v.text}
              {running && <span className="caret" />}
            </div>
          ) : (
            <Markdown text={v.text} />
          )}
        </div>
      )}
      {v.toolCalls.length > 0 && (
        <div className="space-y-2 rounded-md border border-violet-900/60 bg-violet-950/20 p-2">
          <div className="text-[11px] text-violet-300">🔧 工具调用 · {v.toolCalls.length} 个</div>
          {v.toolCalls.map((tc, i) => {
            let pretty = tc.args;
            try {
              pretty = JSON.stringify(JSON.parse(tc.args), null, 2);
            } catch {
              /* partial or invalid JSON */
            }
            return (
              <div key={i} className="rounded bg-zinc-950/60 p-2 text-xs">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="mono text-violet-200">{tc.name || '(未命名)'}</span>
                  {tc.builtin && <Chip tone="blue">厂商服务端执行</Chip>}
                  {tc.type && tc.type !== 'function' && <Chip>{tc.type}</Chip>}
                  <span className="mono text-[10px] text-zinc-600">{tc.id}</span>
                </div>
                <pre className="mono mt-1 break-all whitespace-pre-wrap text-zinc-400">{pretty}</pre>
                {!tc.builtin && onAppend && !running && (
                  <div className="mt-1.5 flex gap-1.5">
                    <textarea
                      className="input mono min-h-10 flex-1 text-xs"
                      placeholder="在这里填写工具执行结果（模拟返回值），再提交给模型"
                      aria-label={`${tc.name || '工具'} 的执行结果`}
                      value={toolResults[toolKey(tc, i)] ?? ''}
                      onChange={(e) =>
                        setToolResults((previous) => ({ ...previous, [toolKey(tc, i)]: e.target.value }))
                      }
                    />
                    <button
                      className="btn-ghost px-1.5 text-[11px]"
                      title="把调用参数原样作为结果（Kimi 内置 $web_search 等要求这样回传）"
                      onClick={() => setToolResults((previous) => ({ ...previous, [toolKey(tc, i)]: tc.args }))}
                    >
                      原样回传
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {v.citations.length > 0 && (
        <div className="rounded-md border border-zinc-800 p-2">
          <div className="mb-1 text-[11px] text-zinc-400">📎 引用 / 搜索来源 · {v.citations.length}</div>
          <ol className="list-decimal space-y-0.5 pl-5 text-xs">
            {v.citations.slice(0, 30).map((c, i) => (
              <li key={i} className="text-zinc-400">
                {c.url ? (
                  <a className="text-violet-300 underline" href={c.url} target="_blank" rel="noreferrer">
                    {c.title || c.url}
                  </a>
                ) : (
                  c.title
                )}
                {c.snippet && <span className="text-zinc-600"> — {c.snippet.slice(0, 120)}</span>}
              </li>
            ))}
          </ol>
        </div>
      )}
      {onAppend && !running && (v.text || v.toolCalls.length > 0) && (
        <div className="flex flex-wrap gap-2">
          {clientTools.length > 0 ? (
            <button
              className="btn-primary text-xs"
              disabled={!clientTools.every((tc) => (toolResults[toolKey(tc, v.toolCalls.indexOf(tc))] ?? '').trim())}
              onClick={() =>
                onAppend(
                  [
                    assistantMessage(),
                    ...clientTools.map((tc) => ({
                      role: 'tool',
                      tool_call_id: tc.id ?? '',
                      name: tc.name,
                      content: toolResults[toolKey(tc, v.toolCalls.indexOf(tc))] ?? '',
                    })),
                  ],
                  clientTools.every((tc) => (toolResults[toolKey(tc, v.toolCalls.indexOf(tc))] ?? '').trim() !== ''),
                )
              }
            >
              提交工具结果并继续
            </button>
          ) : (
            <button
              className="btn-outline text-xs"
              onClick={() => onAppend([assistantMessage(), { role: 'user', content: '' }], false)}
            >
              追加到对话，继续下一轮
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ FIM

function FimOutput({ view, input, running }: OutputProps) {
  const v = view as ChatView;
  const [mode, setMode] = useState<'merged' | 'tokens'>('merged');
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-[11px] text-zinc-500">
        补全结果（高亮部分由模型生成）
        {v.finishReason && <Chip>{v.finishReason}</Chip>}
        <span className="flex-1" />
        {v.logprobs.length > 0 && (
          <button
            className="btn-ghost px-1.5 py-0 text-[11px]"
            onClick={() => setMode(mode === 'merged' ? 'tokens' : 'merged')}
          >
            {mode === 'merged' ? 'Token 显微镜' : '合并视图'}
          </button>
        )}
        <CopyButton text={v.text} label="复制补全" className="px-1.5 py-0 text-[11px]" />
      </div>
      {mode === 'tokens' ? (
        <TokenMicroscope tokens={v.logprobs} />
      ) : (
        <pre className="mono overflow-x-auto rounded-md bg-zinc-950 p-3 text-xs leading-relaxed whitespace-pre-wrap">
          <span className="text-zinc-500">{String(input.prefix ?? '')}</span>
          <span className="rounded-sm bg-violet-600/30 text-violet-100">{v.text}</span>
          {running && <span className="caret" />}
          <span className="text-zinc-500">{String(input.suffix ?? '')}</span>
        </pre>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ media

function ArtifactCard({ a }: { a: AssetInfo }) {
  return (
    <div className="space-y-1">
      {a.kind === 'image' && (
        <a href={a.url} target="_blank" rel="noreferrer">
          <img src={a.url} className="max-h-96 rounded-md border border-zinc-800" alt={a.filename} />
        </a>
      )}
      {a.kind === 'audio' && <audio controls src={a.url} className="w-full" />}
      {a.kind === 'video' && (
        <video controls src={a.url} className="max-h-[28rem] w-full rounded-md border border-zinc-800 bg-black" />
      )}
      {a.kind === 'model3d' && <ModelPreview src={a.url} name={a.filename} />}
      <div className="flex items-center gap-2 text-[11px] text-zinc-500">
        <span className="mono">{a.mime}</span>
        <span>{fmtBytes(a.size)}</span>
        <a className="text-violet-400 underline" href={a.url} download={a.filename}>
          下载
        </a>
        {a.remoteUrl && (
          <a
            className="text-zinc-500 underline"
            href={a.remoteUrl}
            target="_blank"
            rel="noreferrer"
            title="厂商返回的原始链接，通常会过期"
          >
            原始链接
          </a>
        )}
      </div>
    </div>
  );
}

function AudioOutput({ view, artifacts, response, running }: OutputProps) {
  const v = view as AudioView;
  const liveSrc = useMemo(
    () => (v.kind === 'audio' && v.hex && !artifacts.length ? `data:audio/mpeg;base64,${hexToBase64(v.hex)}` : null),
    [v, artifacts.length],
  );
  return (
    <div className="space-y-3">
      {artifacts.map((a) => (
        <ArtifactCard key={a.id} a={a} />
      ))}
      {liveSrc && <audio controls src={liveSrc} className="w-full" />}
      {!artifacts.length &&
        !liveSrc &&
        (running ? (
          <p className="text-xs text-zinc-500">等待音频返回…</p>
        ) : (
          <p className="text-xs text-zinc-500">没有收到音频，查看「原始响应」了解原因。</p>
        ))}
      {v.kind === 'audio' && v.firstAudioMs != null && (
        <p className="text-[11px] text-zinc-500">
          首个音频分片：{fmtMs(v.firstAudioMs)} · 共 {v.chunks} 个分片
        </p>
      )}
      {v.kind === 'audio' && Object.keys(v.extras).length > 0 && (
        <details className="text-[11px]">
          <summary className="cursor-pointer text-zinc-500">厂商返回的音频信息</summary>
          <JsonBlock value={v.extras} max={6000} />
        </details>
      )}
      {!v.hex && response && !artifacts.length && <JsonBlock value={response} max={6000} />}
    </div>
  );
}

function ImageOutput({ artifacts, response, running }: OutputProps) {
  return (
    <div className="space-y-3">
      {artifacts.length > 0 ? (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {artifacts.map((a) => (
            <ArtifactCard key={a.id} a={a} />
          ))}
        </div>
      ) : running ? (
        <p className="flex items-center gap-2 text-xs text-zinc-500">
          <Spinner /> 生成中…
        </p>
      ) : (
        response && <JsonBlock value={response} max={8000} />
      )}
    </div>
  );
}

function TaskOutput({ taskId, artifacts, running }: OutputProps) {
  const [task, setTask] = useState<TaskRecord | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setTask(null);
    setError('');
    if (!taskId) return;
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (stop) return;
      try {
        const t = await api.task(taskId);
        if (stop) return;
        setTask(t);
        setError('');
        if (
          ['pending', 'running', 'unknown'].includes(t.status) ||
          t.nextPollAt ||
          (t.status === 'succeeded' && t.error)
        )
          timer = setTimeout(tick, 4000);
      } catch (e: any) {
        if (!stop) {
          setError(`本地任务查询失败：${e.message}`);
          timer = setTimeout(tick, 8000);
        }
      }
    };
    tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [taskId]);
  const results = task?.artifacts?.length ? task.artifacts : artifacts;
  if (!taskId)
    return running ? (
      <p className="flex items-center gap-2 text-xs text-zinc-500">
        <Spinner /> 正在提交任务…
      </p>
    ) : (
      <p className="text-xs text-zinc-500">任务尚未创建（查看错误信息或原始响应）。</p>
    );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="text-zinc-400">异步任务</span>
        {task ? <StatusBadge status={task.status} /> : <Spinner />}
        {task?.remoteStatus && <Chip>{task.remoteStatus}</Chip>}
        <span className="mono text-[11px] text-zinc-500">远程 ID {task?.remoteId}</span>
        {task && ['pending', 'running'].includes(task.status) && (
          <span className="text-[11px] text-zinc-500">已轮询 {task.pollCount} 次 · 关闭页面也会在后台继续跟踪</span>
        )}
        <a className="btn-ghost px-1.5 py-0 text-[11px]" href="#/tasks">
          任务队列 →
        </a>
      </div>
      {task?.progress != null && (
        <div className="h-1.5 overflow-hidden rounded-full bg-zinc-800">
          <div className="h-full bg-violet-500 transition-all" style={{ width: `${Math.min(100, task.progress)}%` }} />
        </div>
      )}
      {task?.error && <p className="text-xs text-rose-300">{task.error}</p>}
      {task?.nextPollAt && (
        <p className="text-xs text-amber-200">
          本机服务将在 {new Date(task.nextPollAt).toLocaleTimeString('zh-CN')} 重试，已重试 {task.retryCount ?? 0} 次。
        </p>
      )}
      {error && (
        <p role="status" className="text-xs text-amber-300">
          {error}
        </p>
      )}
      {results.map((a) => (
        <ArtifactCard key={a.id} a={a} />
      ))}
    </div>
  );
}

function AsrOutput({ response, view }: OutputProps) {
  const nativeContent = response?.output?.choices?.[0]?.message?.content;
  const nativeText =
    typeof nativeContent === 'string'
      ? nativeContent
      : Array.isArray(nativeContent)
        ? nativeContent.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('')
        : undefined;
  const text =
    (view.kind === 'chat' ? view.text : undefined) ??
    nativeText ??
    response?.text ??
    response?.output?.text ??
    response?.result?.text ??
    response?.output?.sentence?.text;
  return (
    <div className="space-y-2">
      {text && <div className="rounded-md bg-zinc-950 p-3 text-sm whitespace-pre-wrap text-zinc-100">{text}</div>}
      {response && <JsonBlock value={response} max={12000} />}
    </div>
  );
}

// ------------------------------------------------------------------ embedding / rerank

function heat(v: number) {
  const x = Math.max(0, Math.min(1, (v + 1) / 2));
  return `rgba(139, 92, 246, ${(x * x * 0.9).toFixed(3)})`;
}

function EmbeddingOutput({ response, input }: OutputProps) {
  const vectors = useMemo(() => parseEmbeddings(response), [response]);
  const texts = ((input.texts as string[]) ?? []).filter((t) => t.trim());
  if (!vectors.length) return response ? <JsonBlock value={response} max={8000} /> : null;
  const dims = vectors[0].length;
  return (
    <div className="space-y-3">
      <p className="text-xs text-zinc-400">
        {vectors.length} 个向量 · 维度 {dims} · 余弦相似度矩阵（颜色越深越相似）
      </p>
      <div className="overflow-x-auto">
        <table className="text-xs">
          <thead>
            <tr>
              <th />
              {vectors.map((_, j) => (
                <th key={j} className="mono px-2 py-1 font-normal text-zinc-500">
                  {j}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {vectors.map((a, i) => (
              <tr key={i}>
                <td className="max-w-60 truncate py-1 pr-2 text-zinc-400" title={texts[i]}>
                  <span className="mono text-zinc-600">{i}</span> {texts[i]}
                </td>
                {vectors.map((b, j) => {
                  const s = cosine(a, b);
                  return (
                    <td key={j} className="mono px-2 py-1 text-center text-zinc-100" style={{ background: heat(s) }}>
                      {s.toFixed(3)}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <details className="text-[11px]">
        <summary className="cursor-pointer text-zinc-500">向量前 8 维</summary>
        <JsonBlock value={vectors.map((v) => v.slice(0, 8).map((x) => Number(x.toFixed(5))))} />
      </details>
    </div>
  );
}

function RerankOutput({ response, input }: OutputProps) {
  const results = useMemo(() => parseRerank(response).sort((a, b) => b.score - a.score), [response]);
  const docs = ((input.documents as string[]) ?? []).filter((t) => t.trim());
  if (!results.length) return response ? <JsonBlock value={response} max={8000} /> : null;
  const max = Math.max(...results.map((r) => r.score), 1e-9);
  return (
    <div className="space-y-1.5">
      {results.map((r, rank) => (
        <div key={r.index} className="rounded-md border border-zinc-800 bg-zinc-950/40 p-2 text-xs">
          <div className="flex items-center gap-2">
            <span className="mono w-6 text-violet-300">#{rank + 1}</span>
            <span className="mono text-zinc-500">原序 {r.index}</span>
            <span
              className="h-2 rounded bg-violet-500/70"
              style={{ width: `${Math.max(3, (r.score / max) * 200)}px` }}
            />
            <span className="mono text-zinc-300">{r.score.toFixed(4)}</span>
          </div>
          <p className="mt-1 text-zinc-300">{docs[r.index] ?? '（文档）'}</p>
        </div>
      ))}
    </div>
  );
}
