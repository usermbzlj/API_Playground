import { useCallback, useEffect, useRef, useState } from 'react';
import type { TaskRecord } from '../../shared/types.ts';
import { getOperation } from '../../shared/catalog.ts';
import { api } from '../api.ts';
import { useApp } from '../app.tsx';
import { Chip, EmptyHint, ErrorBox, JsonBlock, Modal, Spinner, StatusBadge, fmtTime } from '../ui.tsx';
import { Page } from './common.tsx';
import { ModelPreview } from '../lab/model3d.tsx';
export function TasksPage() {
  const { toast } = useApp();
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const [detail, setDetail] = useState<unknown>(null);
  const [offset, setOffset] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const sequence = useRef(0);
  const load = useCallback(async () => {
    const current = ++sequence.current;
    try {
      const rows = await api.tasks({ limit: 51, offset });
      if (current !== sequence.current) return;
      if (!rows.length && offset > 0) {
        setOffset(Math.max(0, offset - 50));
        return;
      }
      setTasks(rows.slice(0, 50));
      setHasNext(rows.length > 50);
      setError('');
    } catch (e: any) {
      if (current === sequence.current) setError(e.message);
    } finally {
      if (current === sequence.current) setLoading(false);
    }
  }, [offset]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 5000);
    return () => {
      sequence.current++;
      clearInterval(t);
    };
  }, [load]);
  async function action(id: string, fn: () => Promise<void>) {
    if (busy) return;
    setBusy(id);
    try {
      await fn();
      await load();
    } catch (e: any) {
      toast(e.message, 'err');
    } finally {
      setBusy('');
    }
  }
  return (
    <Page
      title="异步任务"
      description="创建后的长任务由本机服务跟踪，刷新页面后仍可继续查询。上游取消能力因厂商而异；本地停止轮询不一定能停止服务商计费。"
      actions={
        <button className="btn-outline" onClick={load}>
          刷新列表
        </button>
      }
    >
      {error && <ErrorBox error={{ title: '任务列表加载失败', hints: [error] }} />}
      {loading ? (
        <Spinner />
      ) : !tasks.length ? (
        <EmptyHint>还没有异步任务。视频或 3D 等异步实验创建后会显示在这里。</EmptyHint>
      ) : (
        <div className="space-y-4">
          {tasks.map((t) => {
            const retrying = !!t.nextPollAt;
            const retrieving = t.status === 'succeeded' && !!t.error;
            const active = ['pending', 'running', 'unknown'].includes(t.status) || retrying;
            const op = getOperation(t.operationId);
            return (
              <article className="card space-y-3 p-5" key={t.id}>
                <div className="flex flex-wrap items-center gap-3">
                  <h2 className="flex-1 text-base font-semibold text-zinc-100">
                    {t.title ?? op?.title ?? t.operationId}
                  </h2>
                  <StatusBadge status={t.status} />
                  {retrying && <Chip tone="yellow">{retrieving ? '正在取回产物' : '等待自动重试'}</Chip>}
                  {t.remoteStatus && <Chip>{t.remoteStatus}</Chip>}
                  <a className="btn-outline" href={`#/runs/${t.runId}`}>
                    查看实验
                  </a>
                </div>
                <p className="mono break-all text-xs text-zinc-500">远程 ID {t.remoteId}</p>
                {t.progress != null && (
                  <div>
                    <div className="mb-1 text-xs text-zinc-400">服务商进度 {t.progress}%</div>
                    <progress
                      className="h-2 w-full accent-violet-500"
                      value={Math.max(0, Math.min(100, t.progress))}
                      max={100}
                    />
                  </div>
                )}
                {t.error &&
                  (retrying ? (
                    <p
                      role="status"
                      className="rounded-lg border border-amber-800/60 bg-amber-950/20 p-3 text-xs text-amber-200"
                    >
                      {t.error} · 下次重试 {fmtTime(t.nextPollAt)}，无需重新提交生成任务。
                    </p>
                  ) : (
                    <ErrorBox error={{ title: '任务诊断', hints: [t.error] }} />
                  ))}
                <p className="text-xs text-zinc-500">
                  创建 {fmtTime(t.createdAt)} · 最近轮询 {fmtTime(t.lastPollAt)} · {t.pollCount} 次
                </p>
                {op?.async?.resultTtlNote && <p className="text-xs text-amber-300">{op.async.resultTtlNote}</p>}
                <div className="flex flex-wrap gap-2">
                  <button
                    className="btn-outline"
                    disabled={!!busy}
                    onClick={() =>
                      action(t.id, async () => {
                        await api.pollTask(t.id);
                      })
                    }
                  >
                    {retrieving ? '立即重试取回产物' : '立即查询上游状态'}
                  </button>
                  <button
                    className="btn-ghost"
                    disabled={!!busy}
                    onClick={() => action(t.id, async () => setDetail(await api.task(t.id)))}
                  >
                    原始状态详情
                  </button>
                  {active && (
                    <button
                      className="btn-ghost text-rose-300"
                      disabled={!!busy}
                      onClick={() => {
                        if (
                          confirm(
                            retrieving
                              ? '停止本机下载重试？远程生成已完成，之后仍可手动查询取回结果。'
                              : op?.async?.cancel
                                ? '向厂商申请取消此任务？已产生的费用可能无法退还。'
                                : '此服务未提供取消接口，将停止本机轮询。远端任务可能继续执行并计费。继续？',
                          )
                        )
                          action(t.id, async () => {
                            const r = await api.cancelTask(t.id);
                            toast(r.message, r.ok ? 'ok' : 'err');
                          });
                      }}
                    >
                      {retrieving ? '停止下载重试' : op?.async?.cancel ? '取消任务' : '停止本机跟踪'}
                    </button>
                  )}
                </div>
                {t.artifacts?.map((a) => (
                  <div className="space-y-2 border-t border-zinc-800 pt-3" key={a.id}>
                    {a.kind === 'video' && <video className="max-h-80 max-w-full rounded-lg" controls src={a.url} />}{' '}
                    {a.kind === 'image' && (
                      <img className="max-h-80 max-w-full rounded-lg" src={a.url} alt={a.filename} />
                    )}
                    {a.kind === 'model3d' && <ModelPreview src={a.url} name={a.filename} />}
                    <a className="text-xs text-violet-300" download={a.filename} href={a.url}>
                      {a.filename} · 下载产物
                    </a>
                  </div>
                ))}
              </article>
            );
          })}
        </div>
      )}
      <div className="flex items-center gap-3 text-xs text-zinc-400">
        <button
          className="btn-outline"
          disabled={loading || offset === 0}
          onClick={() => setOffset(Math.max(0, offset - 50))}
        >
          上一页
        </button>
        <span>第 {Math.floor(offset / 50) + 1} 页</span>
        <button className="btn-outline" disabled={loading || !hasNext} onClick={() => setOffset(offset + 50)}>
          下一页
        </button>
      </div>
      {detail !== null && (
        <Modal wide title="任务原始状态" onClose={() => setDetail(null)}>
          <JsonBlock value={detail} />
        </Modal>
      )}
    </Page>
  );
}
