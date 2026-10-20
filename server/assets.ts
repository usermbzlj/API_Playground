import { writeFileSync, readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join, extname } from 'node:path';
import { db, ASSET_DIR, now } from './db.ts';
import { shortId } from '../shared/util.ts';
import type { AssetInfo, ArtifactRef } from '../shared/types.ts';

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
  const id = shortId();
  const ext = EXT_BY_MIME[opts.mime] || extname(opts.filename || '') || '.bin';
  const file = `${id}${ext}`;
  writeFileSync(join(ASSET_DIR, file), opts.data);
  const filename = opts.filename || file;
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
  const r = db.prepare('SELECT * FROM assets WHERE id = ?').get(id) as any;
  if (!r) return undefined;
  const p = join(ASSET_DIR, r.path);
  return existsSync(p) ? { path: p, mime: r.mime, filename: r.filename } : undefined;
}

export function listAssets(opts: { runId?: string; kind?: string; limit?: number }): AssetInfo[] {
  const where: string[] = [];
  const args: any[] = [];
  if (opts.runId) {
    where.push('run_id = ?');
    args.push(opts.runId);
  }
  if (opts.kind) {
    where.push('kind = ?');
    args.push(opts.kind);
  }
  const sql = `SELECT * FROM assets ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`;
  args.push(opts.limit ?? 200);
  return (db.prepare(sql).all(...args) as any[]).map(rowToInfo);
}

export function deleteAsset(id: string) {
  const f = getAssetFile(id);
  db.prepare('DELETE FROM assets WHERE id = ?').run(id);
  if (f) {
    try {
      unlinkSync(f.path);
    } catch {
      /* ignore */
    }
  }
}

export async function downloadToAsset(url: string, runId: string | null, kind?: string, label?: string): Promise<AssetInfo> {
  const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
  if (!res.ok) throw new Error(`下载产物失败：HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  let mime = (res.headers.get('content-type') || '').split(';')[0].trim();
  if (!mime || mime === 'application/octet-stream' || mime === 'binary/octet-stream') {
    mime = mimeFromName(new URL(url).pathname) || (kind === 'video' ? 'video/mp4' : kind === 'image' ? 'image/png' : 'application/octet-stream');
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

export async function storeArtifact(a: ArtifactRef, runId: string | null): Promise<AssetInfo> {
  if (a.url) return downloadToAsset(a.url, runId, a.kind, a.filename);
  const mime = a.mime || DEFAULT_MIME[a.kind];
  let data: Buffer;
  if (a.hex) data = Buffer.from(a.hex, 'hex');
  else if (a.base64) data = Buffer.from(a.base64.replace(/^data:[^,]+,/, ''), 'base64');
  else throw new Error('产物缺少数据');
  return saveAsset({ data, mime, filename: a.filename, kind: a.kind, runId, source: 'artifact' });
}

/**
 * Replace {"$asset": id, "as": "dataUrl" | "base64" | "localUrl"} placeholders in a request body.
 * Keeps the visible/recorded request compact while sending real bytes upstream.
 */
export function resolveAssetRefs(value: any): any {
  if (Array.isArray(value)) return value.map(resolveAssetRefs);
  if (value && typeof value === 'object') {
    if (typeof value.$asset === 'string') {
      const f = getAssetFile(value.$asset);
      if (!f) throw new Error(`素材不存在：${value.$asset}`);
      const b64 = readFileSync(f.path).toString('base64');
      if (value.as === 'base64') return b64;
      return `data:${f.mime};base64,${b64}`;
    }
    const out: any = {};
    for (const [k, v] of Object.entries(value)) out[k] = resolveAssetRefs(v);
    return out;
  }
  return value;
}

export function assetBlob(id: string): { blob: Blob; filename: string } {
  const f = getAssetFile(id);
  if (!f) throw new Error(`素材不存在：${id}`);
  return { blob: new Blob([readFileSync(f.path)], { type: f.mime }), filename: f.filename };
}
