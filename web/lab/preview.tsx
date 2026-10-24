import { useMemo, useState } from 'react';
import type { ConnectionInfo, OperationDef, ProviderDef } from '../../shared/types.ts';
import type { ParamState } from '../../shared/util.ts';
import { joinApiUrl } from '../../shared/util.ts';
import { redactSensitive } from '../../shared/redact.ts';
import { CopyButton, JsonBlock } from '../ui.tsx';
import { placeholderize, toCurl, toPowerShell } from './request-code.ts';
export { toCurl, toPowerShell } from './request-code.ts';

export interface PreviewResult {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: unknown;
  bodyType?: string;
  error?: string;
  stream?: boolean;
}

function authHeaderPreview(
  provider: ProviderDef | undefined,
  conn: ConnectionInfo | undefined,
): Record<string, string> {
  const a = provider?.auth;
  const h: Record<string, string> = { ...(a?.staticHeaders ?? {}) };
  if (provider?.generic && conn?.extra?.authHeader) {
    const prefix =
      conn.extra.authPrefix === 'none'
        ? ''
        : (conn.extra.authPrefix ?? (conn.extra.authHeader.toLowerCase() === 'authorization' ? 'Bearer ' : ''));
    h[conn.extra.authHeader] = `${prefix}$API_KEY`;
    return h;
  }
  if (!a || a.type === 'bearer') h.Authorization = 'Bearer $API_KEY';
  else if (a.type === 'header') h[a.header || 'Authorization'] = `${a.prefix ?? ''}$API_KEY`;
  else if (a.type === 'signer') h.Authorization = `（由本地服务按 ${a.signer} 规则签名）`;
  return h;
}

export function buildPreview(
  op: OperationDef,
  provider: ProviderDef | undefined,
  conn: ConnectionInfo | undefined,
  model: string,
  input: any,
  params: Record<string, ParamState>,
): PreviewResult {
  try {
    const req = op.build({ model, input, extra: conn?.extra ?? {}, params });
    const base = (conn?.baseUrl ?? provider?.baseUrls[0]?.url ?? '').replace(/\/+$/, '');
    let url = joinApiUrl(base, req.path);
    if (provider?.auth.type === 'query')
      url += `${url.includes('?') ? '&' : '?'}${provider.auth.query || 'key'}=$API_KEY`;
    const headers: Record<string, string> = { ...authHeaderPreview(provider, conn), ...(req.headers ?? {}) };
    const bodyType = req.bodyType ?? (req.body === undefined ? 'none' : 'json');
    if (bodyType === 'json') headers['Content-Type'] = headers['Content-Type'] ?? 'application/json';
    return redactSensitive({ method: req.method, url, headers, body: req.body, bodyType, stream: req.stream });
  } catch (e: any) {
    return { error: e.message };
  }
}

export function RequestPreview({ preview }: { preview: PreviewResult }) {
  const curl = useMemo(() => toCurl(preview), [preview]);
  const powershell = useMemo(() => toPowerShell(preview), [preview]);
  const [code, setCode] = useState<'bash' | 'powershell'>('powershell');
  if (preview.error)
    return (
      <p className="rounded-md border border-amber-800/60 bg-amber-950/30 p-2 text-xs text-amber-200">
        暂时无法生成请求：{preview.error}
      </p>
    );
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="mono rounded bg-violet-900/40 px-1.5 py-0.5 text-[11px] text-violet-200">
          {preview.method}
        </span>
        <span className="mono flex-1 text-[11px] break-all text-zinc-300">{preview.url}</span>
        <CopyButton text={powershell} label="复制 PowerShell" />
        <CopyButton text={curl} label="复制 Bash curl" />
        <CopyButton text={JSON.stringify(placeholderize(preview.body), null, 2)} label="复制请求体" />
      </div>
      <JsonBlock value={preview.headers} max={4000} />
      {preview.body !== undefined && <JsonBlock value={placeholderize(preview.body)} max={40000} />}
      <details className="rounded-md border border-zinc-800 p-3">
        <summary className="cursor-pointer text-xs text-zinc-300">终端请求示例</summary>
        <div className="my-2 flex flex-wrap gap-2">
          <button
            className="btn-ghost text-xs"
            aria-pressed={code === 'powershell'}
            onClick={() => setCode('powershell')}
          >
            PowerShell
          </button>
          <button className="btn-ghost text-xs" aria-pressed={code === 'bash'} onClick={() => setCode('bash')}>
            Bash
          </button>
        </div>
        <JsonBlock value={code === 'powershell' ? powershell : curl} max={50000} />
      </details>
      <p className="text-[11px] leading-relaxed text-zinc-600">
        这是按当前输入与参数实时生成的原生请求，点击运行时本地服务会用同一份定义构建并发送。$API_KEY
        在应用内由服务端填入真实密钥。终端示例需自行设置 API_KEY，并手动替换素材和已脱敏字段；签名鉴权应使用厂商 SDK。
      </p>
    </div>
  );
}
