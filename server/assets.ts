import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, extname, basename, resolve, sep } from 'node:path';
import { db, ASSET_DIR, now, json, pagination } from './db.ts';
import { shortId } from '../shared/util.ts';
import { netFetch, readResponseBuffer } from './net.ts';
import type { AssetInfo, AssetLibraryResponse, ArtifactRef, NetworkMode } from '../shared/types.ts';

const ASSET_KINDS = new Set(['image', 'audio', 'video', 'model3d', 'file', 'text']);
export function validateAssetKind(kind: unknown): string {
  if (typeof kind !== 'string' || !ASSET_KINDS.has(kind)) throw new Error('素材类型无效');
  return kind;
}

function validateAssetId(id: unknown): asserts id is string {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(id)) throw new Error('素材 ID 无效');
}

const EXT_BY_MIME: Record<string, string> = {
  'audio/mpeg': '.mp3',
  'audio/mp3': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/pcm': '.pcm',
  'audio/flac': '.flac',
  'audio/ogg': '.ogg',
  'audio/opus': '.opus',
  'audio/aac': '.aac',
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'image/gif': '.gif',
  'video/mp4': '.mp4',
  'video/webm': '.webm',
  'model/gltf-binary': '.glb',
  'application/json': '.json',
  'text/plain': '.txt',
};

const MIME_BY_EXT = Object.fromEntries(Object.entries(EXT_BY_MIME).map(([m, e]) => [e, m]));

export function mimeFromName(name: string): string | undefined {
  return MIME_BY_EXT[extname(name).toLowerCase()];
}

function kindFromMime(mime: string): string {
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('model/')) return 'model3d';
  return 'file';
}

function rowToInfo(r: any): AssetInfo {
  return {
    id: r.id,
    kind: r.kind,
    mime: r.mime,
    filename: r.filename,
    size: r.size,
    url: `/api/assets/${r.id}/raw`,
    createdAt: r.created_at,
    runId: r.run_id,
    remoteUrl: r.remote_url,
    source: r.source,
  };
}

export function saveAsset(opts: {
  data: Buffer;
  mime: string;
  filename?: string;
  kind?: string;
  runId?: string | null;
  remoteUrl?: string | null;
  source?: 'upload' | 'artifact';
}): AssetInfo {
  if (!Buffer.isBuffer(opts.data)) throw new Error('素材数据无效');
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(opts.mime)) throw new Error('素材 MIME 类型无效');
  if (opts.kind !== undefined) validateAssetKind(opts.kind);
  const id = shortId();
  const originalExt = extname(opts.filename || '');
  const ext = EXT_BY_MIME[opts.mime] || (/^\.[a-zA-Z0-9]{1,12}$/.test(originalExt) ? originalExt : '.bin');
  const file = `${id}${ext}`;
  writeFileSync(join(ASSET_DIR, file), opts.data);
  const filename = opts.filename
    ? basename(opts.filename.replace(/\\/g, '/'))
        .replace(/[\x00-\x1f\x7f]/g, '')
        .slice(0, 240) || file
    : file;
  db.prepare(
    `INSERT INTO assets(id, kind, mime, filename, path, size, created_at, run_id, remote_url, source)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    opts.kind || kindFromMime(opts.mime),
    opts.mime,
    filename,
    file,
    opts.data.length,
    now(),
    opts.runId ?? null,
    opts.remoteUrl ?? null,
    opts.source ?? 'upload',
  );
  return getAsset(id)!;
}

export function getAsset(id: string): AssetInfo | undefined {
  const r = db.prepare('SELECT * FROM assets WHERE id = ?').get(id);
  return r ? rowToInfo(r) : undefined;
}

export function getAssetFile(id: string): { path: string; mime: string; filename: string } | undefined {
  validateAssetId(id);
  const r = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as any;
  if (!r) return undefined;
  const p = resolve(ASSET_DIR, r.path);
  if (!p.startsWith(resolve(ASSET_DIR) + sep)) throw new Error('素材文件路径越界');
  return existsSync(p) ? { path: p, mime: r.mime, filename: r.filename } : undefined;
}

export function listAssets(opts: {
  runId?: string;
  kind?: string;
  q?: string;
  limit?: number;
  offset?: number;
}): AssetInfo[] {
  const where: string[] = [];
  const args: any[] = [];
  if (opts.runId) {
    where.push('run_id = ?');
    args.push(opts.runId);
  }
  if (opts.kind) {
    validateAssetKind(opts.kind);
    where.push('kind = ?');
    args.push(opts.kind);
  }
  if (opts.q) {
    where.push('(filename LIKE ? OR id LIKE ?)');
    args.push(`%${opts.q.slice(0, 200)}%`, `%${opts.q.slice(0, 200)}%`);
  }
  const page = pagination(opts.limit ?? 200, opts.offset ?? 0, 200);
  const sql = `SELECT * FROM assets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`;
  args.push(page.limit, page.offset);
  return (db.prepare(sql).all(...args) as any[]).map(rowToInfo);
}

type References = { runs: Map<string, string>; presets: Map<string, string> };

/** Existing histories and templates are the durable reference owners; drafts are not deleted automatically. */
export function assetUsage(excludeRunId?: string): Map<string, References> {
  const assets = db.prepare('SELECT id, run_id FROM assets').all() as { id: string; run_id: string | null }[];
  const usage = new Map(
    assets.map((a) => [a.id, { runs: new Map<string, string>(), presets: new Map<string, string>() }]),
  );
  const collect = (value: unknown, found: Set<string>) => {
    const stack: unknown[] = [value];
    while (stack.length) {
      const item = stack.pop();
      if (typeof item === 'string') {
        if (usage.has(item)) found.add(item);
        for (const match of item.matchAll(/\/api\/assets\/([a-zA-Z0-9_-]+)(?:\/raw)?/g))
          if (usage.has(match[1])) found.add(match[1]);
      } else if (item && typeof item === 'object') for (const child of Object.values(item)) stack.push(child);
    }
  };
  const runTitles = new Map<string, string>();
  for (const run of db.prepare('SELECT id, title, input_json, state_json, request_json FROM runs').all() as any[]) {
    if (run.id === excludeRunId) continue;
    runTitles.set(run.id, run.title);
    const found = new Set<string>();
    for (const field of ['input_json', 'state_json', 'request_json']) collect(json(run[field]), found);
    for (const id of found) usage.get(id)!.runs.set(run.id, run.title);
  }
  for (const asset of assets) {
    if (asset.run_id && runTitles.has(asset.run_id))
      usage.get(asset.id)!.runs.set(asset.run_id, runTitles.get(asset.run_id)!);
  }
  for (const preset of db.prepare('SELECT id, title, input_json, params_json FROM presets').all() as any[]) {
    const found = new Set<string>();
    collect(json(preset.input_json), found);
    collect(json(preset.params_json), found);
    for (const id of found) usage.get(id)!.presets.set(preset.id, preset.title);
  }
  return usage;
}

function withUsage(asset: AssetInfo, refs?: References): AssetInfo {
  return {
    ...asset,
    referenceCount: (refs?.runs.size ?? 0) + (refs?.presets.size ?? 0),
    runReferences: Array.from(refs?.runs ?? [], ([id, title]) => ({ id, title })),
    presetReferences: Array.from(refs?.presets ?? [], ([id, title]) => ({ id, title })),
  };
}

export function assetLibrary(
  opts: { kind?: string; q?: string; unused?: boolean; limit?: number; offset?: number } = {},
): AssetLibraryResponse {
  if (opts.kind) validateAssetKind(opts.kind);
  const usage = assetUsage();
  const all = (db.prepare('SELECT * FROM assets ORDER BY created_at DESC, id DESC').all() as any[]).map((r) =>
    withUsage(rowToInfo(r), usage.get(r.id)),
  );
  const q = opts.q?.trim().toLowerCase().slice(0, 200);
  const matching = all.filter(
    (a) =>
      (!opts.kind || a.kind === opts.kind) &&
      (!q || `${a.filename} ${a.id}`.toLowerCase().includes(q)) &&
      (!opts.unused || !a.referenceCount),
  );
  const page = pagination(opts.limit ?? 48, opts.offset ?? 0, 48);
  return {
    items: matching.slice(page.offset, page.offset + page.limit),
    total: matching.length,
    totalBytes: all.reduce((sum, a) => sum + a.size, 0),
    unusedCount: all.filter((a) => !a.referenceCount).length,
    unusedBytes: all.filter((a) => !a.referenceCount).reduce((sum, a) => sum + a.size, 0),
    ...page,
  };
}

export function deleteAsset(id: string, options: { excludeRunId?: string; usage?: Map<string, References> } = {}) {
  validateAssetId(id);
  const refs = (options.usage ?? assetUsage(options.excludeRunId)).get(id);
  if (refs && (refs.runs.size || refs.presets.size))
    throw new Error('素材仍被实验记录或模板引用，请先移除相关引用；不会删除共享文件');
  const f = getAssetFile(id);
  if (f) unlinkSync(f.path);
  db.prepare('DELETE FROM assets WHERE id = ?').run(id);
}

export function cleanupAssets(ids: unknown) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 500) throw new Error('请选择 1–500 个待清理素材');
  for (const id of ids) validateAssetId(id);
  const unique = [...new Set(ids as string[])];
  const usage = assetUsage();
  for (const id of unique) {
    const refs = usage.get(id);
    if (!refs) throw new Error('所选素材已经变化，请重新载入');
    if (refs.runs.size || refs.presets.size) throw new Error('所选素材出现新的引用，请重新载入后确认清理');
  }
  let bytes = 0;
  for (const id of unique) {
    bytes += getAsset(id)?.size ?? 0;
    deleteAsset(id, { usage });
  }
  return { deleted: unique.length, bytes };
}

export function removeRunAssets(runId: string) {
  // Deleting history is not file cleanup. A browser draft or external tool may still use an output.
  // Keep bytes in the library until the user explicitly selects unreferenced assets for deletion.
  db.prepare('UPDATE assets SET run_id = NULL WHERE run_id = ?').run(runId);
}

export async function downloadToAsset(
  url: string,
  runId: string | null,
  kind?: string,
  label?: string,
  opts: { network?: NetworkMode; signal?: AbortSignal } = {},
): Promise<AssetInfo> {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
    throw new Error('产物下载地址必须为不含账号密码的 HTTP(S) URL');
  const signal = opts.signal
    ? AbortSignal.any([opts.signal, AbortSignal.timeout(300_000)])
    : AbortSignal.timeout(300_000);
  const res = await netFetch(url, { signal, network: opts.network, artifactDownload: true });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`下载产物失败：HTTP ${res.status}`);
  }
  const buf = await readResponseBuffer(res, 512 * 1024 * 1024);
  let mime = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream') {
    mime =
      mimeFromName(new URL(url).pathname) ||
      (kind === 'video' ? 'video/mp4' : kind === 'image' ? 'image/png' : 'application/octet-stream');
  }
  return saveAsset({ data: buf, mime, filename: label, kind, runId, remoteUrl: url, source: 'artifact' });
}

const DEFAULT_MIME: Record<string, string> = {
  audio: 'audio/mpeg',
  image: 'image/png',
  video: 'video/mp4',
  model3d: 'model/gltf-binary',
  text: 'text/plain',
  file: 'application/octet-stream',
};

export async function storeArtifact(
  a: ArtifactRef,
  runId: string | null,
  opts: { network?: NetworkMode; signal?: AbortSignal } = {},
): Promise<AssetInfo> {
  if (a.url) return downloadToAsset(a.url, runId, a.kind, a.filename, opts);
  const mime = a.mime || DEFAULT_MIME[a.kind];
  let data: Buffer;
  if (a.hex) {
    if (a.hex.length % 2 || !/^[0-9a-f]+$/i.test(a.hex)) throw new Error('厂商返回的音频 hex 不完整或无效');
    data = Buffer.from(a.hex, 'hex');
  } else if (a.base64) data = Buffer.from(a.base64.replace(/^data:[^,]+,/, ''), 'base64');
  else throw new Error('产物缺少数据');
  return saveAsset({ data, mime, filename: a.filename, kind: a.kind, runId, source: 'artifact' });
}

/**
 * Replace {"$asset": id, "as": "dataUrl" | "base64" | "anthropicSource" | "remoteUrl"} placeholders in a request body.
 * Keeps the visible/recorded request compact while sending real bytes upstream.
 */
export function resolveAssetRefs(value: any): any {
  if (Array.isArray(value)) return value.map(resolveAssetRefs);
  if (value && typeof value === 'object') {
    if (typeof value.$asset === 'string') {
      const f = getAssetFile(value.$asset);
      const info = getAsset(value.$asset);
      if (!f || !info) throw new Error(`素材不存在：${value.$asset}`);
      // URL-only references (no local bytes) are passed through as links.
      if (info.size === 0 && info.remoteUrl) {
        if (value.as === 'base64' || value.as === 'geminiInlineData')
          throw new Error(`素材 ${info.filename} 只有链接没有本地文件，该接口需要上传文件本身`);
        return value.as === 'anthropicSource' ? { type: 'url', url: info.remoteUrl } : info.remoteUrl;
      }
      if (value.as === 'remoteUrl') {
        if (!info.remoteUrl)
          throw new Error(`素材 ${f.filename} 没有公网 URL：该接口要求可公开访问的链接，请改用「添加图片链接」`);
        return info.remoteUrl;
      }
      const b64 = readFileSync(f.path).toString('base64');
      if (value.as === 'base64') return b64;
      if (value.as === 'geminiInlineData') return { mimeType: f.mime, data: b64 };
      if (value.as === 'anthropicSource') return { type: 'base64', media_type: f.mime, data: b64 };
      return `data:${f.mime};base64,${b64}`;
    }
    const out: any = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveAssetRefs(v);
    return out;
  }
  return value;
}

/** Register an external URL as an asset reference without downloading it (for URL-only vendor inputs). */
export function saveRemoteRef(url: string, kind: string, mime: string): AssetInfo {
  const target = new URL(url);
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
    throw new Error('素材链接须为不含账号密码的 HTTP(S) 地址');
  validateAssetKind(kind);
  return saveAsset({
    data: Buffer.alloc(0),
    mime,
    filename: url.split('/').pop()?.split('?')[0] || 'remote',
    kind,
    remoteUrl: url,
    source: 'upload',
  });
}

export function assetBlob(id: string): { blob: Blob; filename: string } {
  const info = getAsset(id);
  if (info?.size === 0 && info.remoteUrl) throw new Error('该素材只有远程链接，上传文件接口需要本地文件');
  const f = getAssetFile(id);
  if (!f) throw new Error(`素材不存在：${id}`);
  return { blob: new Blob([readFileSync(f.path)], { type: f.mime }), filename: f.filename };
}

export function validateOperationAssets(operationId: string | undefined | null, input: any) {
  if (operationId !== 'mimo.asr' && operationId !== 'openai.asr') return;
  const asset = getAsset(String(input?.audio ?? ''));
  if (!asset || (asset.size === 0 && asset.remoteUrl))
    throw new Error('此语音转写接口需要上传本地音频文件，不能只提供远程链接');
  if (asset.size === 0) throw new Error('音频文件为空');
  if (operationId === 'openai.asr' && asset.size > 25 * 1024 * 1024)
    throw new Error('OpenAI 语音转写文件不能超过 25 MB');
  if (operationId === 'mimo.asr') {
    if (!['audio/mpeg', 'audio/mp3', 'audio/wav', 'audio/x-wav'].includes(asset.mime))
      throw new Error('MiMo 语音转写只支持 WAV 或 MP3 文件');
    if (Math.ceil(asset.size / 3) * 4 > 10 * 1024 * 1024)
      throw new Error('MiMo 音频 Base64 编码后不能超过 10 MB，请先压缩或截短音频');
  }
}
