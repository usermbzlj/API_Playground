import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AssetInfo, AssetLibraryResponse } from '../../shared/types.ts';
import { api } from '../api.ts';
import { useApp } from '../app.tsx';
import { CopyButton, EmptyHint, ErrorBox, Modal, Spinner, fmtBytes, fmtTime } from '../ui.tsx';
import { Page } from './common.tsx';
import { ModelPreview } from '../lab/model3d.tsx';
import { useDrafts, listDrafts, readDraft } from '../workspace-state.ts';

const KIND_LABELS: Record<string, string> = {
  image: '图片',
  audio: '音频',
  video: '视频',
  model3d: '3D 模型',
  file: '文件',
  text: '文本',
};
const PAGE_SIZE = 36;

export function AssetsPage() {
  const { toast } = useApp();
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('');
  const [unused, setUnused] = useState(false);
  const [offset, setOffset] = useState(0);
  const [library, setLibrary] = useState<AssetLibraryResponse | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [deleting, setDeleting] = useState<AssetInfo[] | null>(null);
  const [preview, setPreview] = useState<AssetInfo | null>(null);
  const revision = useRef(0);
  const busyRef = useRef(false);
  const drafts = useDrafts();
  const load = useCallback(
    async (preserveSelection = false) => {
      const current = ++revision.current;
      setLoading(true);
      try {
        const result = await api.assetLibrary({ q: query, kind: kind || undefined, unused, offset, limit: PAGE_SIZE });
        if (current !== revision.current) return;
        if (offset && offset >= result.total) {
          setOffset(Math.max(0, Math.ceil(result.total / PAGE_SIZE) - 1) * PAGE_SIZE);
          return;
        }
        setLibrary(result);
        setError('');
        if (!preserveSelection) setSelected(new Set());
      } catch (e: any) {
        if (current === revision.current) setError(e.message);
      } finally {
        if (current === revision.current) setLoading(false);
      }
    },
    [query, kind, unused, offset],
  );
  useEffect(() => {
    const timer = setTimeout(() => void load(), 200);
    return () => {
      clearTimeout(timer);
      revision.current++;
    };
  }, [load]);

  async function upload(files: FileList | null) {
    if (!files?.length || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    let uploaded = 0;
    try {
      for (const file of Array.from(files)) {
        await api.uploadAsset(file);
        uploaded++;
      }
      toast(`已添加 ${uploaded} 个素材`);
    } catch (e: any) {
      toast(`已添加 ${uploaded} 个；${e.message}`, 'err');
    } finally {
      busyRef.current = false;
      setBusy(false);
      await load();
    }
  }
  async function removeConfirmed() {
    if (!deleting?.length || busyRef.current) return;
    const currentDrafts = listDrafts().map((draft) => JSON.stringify(readDraft(draft.key)) ?? '');
    if (deleting.some((asset) => currentDrafts.some((draft) => draft.includes(asset.id)))) {
      toast('所选素材仍在当前标签页的实验草稿中使用，请先回到草稿移除引用。', 'err');
      return;
    }
    busyRef.current = true;
    setBusy(true);
    try {
      const result = await api.cleanupAssets(deleting.map((a) => a.id));
      toast(`已删除 ${result.deleted} 个素材，释放 ${fmtBytes(result.bytes)}`);
      setDeleting(null);
      await load();
    } catch (e: any) {
      toast(`未完成清理：${e.message}。已保留选择，可重新核对。`, 'err');
      await load(true);
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }
  const items = library?.items ?? [];
  const draftUsage = useMemo(() => {
    const values = drafts.map((draft) => ({ ...draft, text: JSON.stringify(readDraft(draft.key)) ?? '' }));
    return new Map(items.map((asset) => [asset.id, values.filter((draft) => draft.text.includes(asset.id))]));
  }, [drafts, library]);
  const deletable = items.filter((a) => !a.referenceCount && !draftUsage.get(a.id)?.length);
  const selectedItems = items.filter((a) => selected.has(a.id) && !a.referenceCount && !draftUsage.get(a.id)?.length);
  return (
    <Page
      title="素材库"
      description="上传素材和生成产物集中保存在本机，可直接选入实验。清理前会检查已保存实验与模板的引用。"
      actions={
        <label className={`btn-primary cursor-pointer ${busy ? 'opacity-50' : ''}`}>
          {busy ? <Spinner /> : '＋ 添加文件'}
          <input
            className="sr-only"
            type="file"
            multiple
            disabled={busy}
            onChange={(e) => {
              const files = e.target.files;
              void upload(files);
              e.target.value = '';
            }}
          />
        </label>
      }
    >
      {library && (
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
          <div className="card p-4">
            <p className="text-xs text-zinc-500">本地文件占用</p>
            <p className="mt-1 text-xl text-zinc-100">{fmtBytes(library.totalBytes)}</p>
          </div>
          <div className="card p-4">
            <p className="text-xs text-zinc-500">未被已保存记录或模板引用</p>
            <p className="mt-1 text-xl text-zinc-100">
              {library.unusedCount} 个 · {fmtBytes(library.unusedBytes)}
            </p>
          </div>
          <div className="card col-span-2 p-4 text-xs leading-6 text-zinc-400 lg:col-span-1">
            移除缩略图或删除实验历史都会保留文件。需要释放空间时，在这里明确选择未引用素材清理。
          </div>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <input
          className="input min-w-0 basis-full md:basis-56 md:flex-1"
          value={query}
          aria-label="搜索素材"
          placeholder="搜索文件名或素材 ID"
          onChange={(e) => {
            setQuery(e.target.value);
            setOffset(0);
          }}
        />
        <select
          className="input w-36"
          aria-label="素材类型"
          value={kind}
          onChange={(e) => {
            setKind(e.target.value);
            setOffset(0);
          }}
        >
          <option value="">所有类型</option>
          {Object.entries(KIND_LABELS).map(([id, label]) => (
            <option value={id} key={id}>
              {label}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-xs text-zinc-300">
          <input
            type="checkbox"
            checked={unused}
            onChange={(e) => {
              setUnused(e.target.checked);
              setOffset(0);
            }}
          />
          仅看未引用
        </label>
        <button className="btn-outline" disabled={busy || loading} onClick={() => void load()}>
          刷新
        </button>
      </div>
      {error && <ErrorBox error={{ title: '素材库未能载入', hints: [error] }} />}
      <div className="flex flex-wrap items-center gap-3 text-xs text-zinc-400">
        <button
          className="btn-ghost"
          disabled={!deletable.length || loading || busy}
          onClick={() => setSelected(selected.size ? new Set() : new Set(deletable.map((a) => a.id)))}
        >
          {selected.size ? '取消选择' : '选择本页未引用素材'}
        </button>
        <span>
          当前找到 {library?.total ?? 0} 个 · 已选择 {selected.size} 个
        </span>
        <button
          className="btn-outline text-rose-300"
          disabled={!selectedItems.length || busy || loading}
          onClick={() => setDeleting(selectedItems)}
        >
          清理所选未引用素材
        </button>
      </div>
      <p className="text-xs leading-relaxed text-zinc-500">
        当前标签页草稿使用中的素材也会保留。其他标签页的未保存草稿无法自动核对，请在清理前检查；程序不会自动清理。
      </p>
      {loading ? (
        <Spinner />
      ) : !items.length ? (
        <EmptyHint>
          {query || kind || unused
            ? '没有符合条件的素材，可清空筛选或添加文件。'
            : '还没有素材。上传文件或完成媒体实验后，可在这里管理和复用。'}
        </EmptyHint>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((asset) => (
            <article className="card min-w-0 space-y-3 p-4" key={asset.id}>
              <div className="flex items-start gap-2">
                <input
                  aria-label={`选择 ${asset.filename}`}
                  type="checkbox"
                  disabled={!!asset.referenceCount || !!draftUsage.get(asset.id)?.length || busy}
                  checked={selected.has(asset.id)}
                  onChange={(e) =>
                    setSelected((prev) => {
                      const next = new Set(prev);
                      e.target.checked ? next.add(asset.id) : next.delete(asset.id);
                      return next;
                    })
                  }
                />
                <div className="min-w-0 flex-1">
                  <h2 className="break-all text-sm font-medium text-zinc-100">{asset.filename}</h2>
                  <p className="mt-1 text-xs text-zinc-500">
                    {KIND_LABELS[asset.kind] ?? '文件'} ·{' '}
                    {asset.remoteUrl && !asset.size ? '远程链接' : fmtBytes(asset.size)} ·{' '}
                    {asset.source === 'artifact' ? '生成产物' : '已上传'}
                  </p>
                </div>
              </div>
              <div className="flex min-h-24 items-center justify-center rounded-lg bg-zinc-950 p-2">
                {asset.kind === 'image' ? (
                  <button className="w-full" aria-label={`预览 ${asset.filename}`} onClick={() => setPreview(asset)}>
                    <img
                      src={asset.url}
                      loading="lazy"
                      alt={asset.filename}
                      className="mx-auto max-h-40 max-w-full object-contain"
                    />
                  </button>
                ) : asset.kind === 'audio' ? (
                  <audio src={asset.url} controls preload="none" className="max-w-full" />
                ) : asset.kind === 'video' ? (
                  <video src={asset.url} controls preload="metadata" className="max-h-40 max-w-full" />
                ) : (
                  <button className="btn-outline" onClick={() => setPreview(asset)}>
                    {asset.kind === 'model3d' ? '预览 3D 模型' : '查看文件'}
                  </button>
                )}
              </div>
              <div className="flex flex-wrap gap-2 text-xs">
                <CopyButton text={asset.id} label="复制 ID" />
                <CopyButton text={JSON.stringify({ $asset: asset.id, as: 'dataUrl' })} label="复制引用" />
                <a className="btn-ghost" href={asset.url} download={asset.filename}>
                  下载
                </a>
              </div>
              <p className="text-[11px] text-zinc-500">
                {fmtTime(asset.createdAt)} ·{' '}
                {asset.referenceCount ? `${asset.referenceCount} 处引用` : '尚无已保存引用'}
              </p>
              {!!draftUsage.get(asset.id)?.length && (
                <div className="space-y-1 text-xs text-amber-200">
                  <p>草稿使用中</p>
                  {draftUsage.get(asset.id)?.map((draft) => (
                    <a className="block text-violet-300" key={draft.key} href={draft.href}>
                      返回「{draft.title}」
                    </a>
                  ))}
                </div>
              )}
              {!!asset.referenceCount && (
                <details className="text-xs text-zinc-400">
                  <summary className="cursor-pointer">查看引用，防止误删</summary>
                  <div className="mt-2 space-y-2">
                    {asset.runReferences?.map((ref) => (
                      <a
                        className="block break-all text-violet-300"
                        key={ref.id}
                        href={`#/runs/${encodeURIComponent(ref.id)}`}
                      >
                        {ref.title}
                      </a>
                    ))}
                    {asset.presetReferences?.map((ref) => (
                      <p key={ref.id}>模板：{ref.title}</p>
                    ))}
                  </div>
                </details>
              )}
              <button
                className="btn-ghost text-xs text-rose-300"
                disabled={busy || !!asset.referenceCount || !!draftUsage.get(asset.id)?.length}
                title={
                  asset.referenceCount || draftUsage.get(asset.id)?.length
                    ? '请先移除实验、模板或草稿中的引用'
                    : '删除本地文件与素材记录'
                }
                onClick={() => setDeleting([asset])}
              >
                删除素材
              </button>
            </article>
          ))}
        </div>
      )}
      {library && library.total > PAGE_SIZE && (
        <div className="flex items-center justify-center gap-4 text-xs text-zinc-400">
          <button
            className="btn-outline"
            disabled={!offset || loading}
            onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
          >
            上一页
          </button>
          <span>
            第 {Math.floor(offset / PAGE_SIZE) + 1} / {Math.ceil(library.total / PAGE_SIZE)} 页
          </span>
          <button
            className="btn-outline"
            disabled={offset + PAGE_SIZE >= library.total || loading}
            onClick={() => setOffset(offset + PAGE_SIZE)}
          >
            下一页
          </button>
        </div>
      )}
      {deleting && (
        <Modal
          title={`删除 ${deleting.length} 个未引用素材`}
          onClose={() => {
            if (!busy) setDeleting(null);
          }}
        >
          <p className="text-sm text-zinc-300">
            将删除这些素材记录和本地文件，预计释放 {fmtBytes(deleting.reduce((sum, a) => sum + a.size, 0))}
            。请先确认未保存的实验草稿不再需要它们。
          </p>
          <ul className="my-4 max-h-52 space-y-1 overflow-auto text-xs text-zinc-400">
            {deleting.map((a) => (
              <li key={a.id}>{a.filename}</li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <button className="btn-outline" disabled={busy} onClick={() => setDeleting(null)}>
              保留素材
            </button>
            <button className="btn-primary" disabled={busy} onClick={() => void removeConfirmed()}>
              {busy ? <Spinner /> : '确认删除所选素材'}
            </button>
          </div>
        </Modal>
      )}
      {preview && (
        <Modal wide title={preview.filename} onClose={() => setPreview(null)}>
          {preview.kind === 'image' ? (
            <img src={preview.url} alt={preview.filename} className="mx-auto max-h-[70vh] max-w-full object-contain" />
          ) : preview.kind === 'model3d' ? (
            <ModelPreview src={preview.url} name={preview.filename} />
          ) : (
            <a className="btn-primary" href={preview.url} target="_blank" rel="noreferrer">
              打开文件
            </a>
          )}
        </Modal>
      )}
    </Page>
  );
}
