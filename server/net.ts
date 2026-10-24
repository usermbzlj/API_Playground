// Outbound networking: every upstream call (HTTP, SSE, WebSocket, artifact download)
// goes through here so that proxy routing is consistent and visible in traces.
// Node's built-in fetch and `ws` ignore HTTP(S)_PROXY, so routing is explicit.
import { fetch as undiciFetch, Agent, ProxyAgent, FormData as UndiciFormData, type Dispatcher } from 'undici';
import { HttpsProxyAgent } from 'https-proxy-agent';
import type { Agent as HttpAgent } from 'node:http';
import { getSetting, setSetting } from './db.ts';

export type NetworkMode = 'auto' | 'direct' | 'proxy';

export interface NetworkSettings {
  /** null = follow HTTPS_PROXY / HTTP_PROXY / ALL_PROXY; '' = no proxy */
  proxyUrl: string | null;
}

export const FormData = UndiciFormData;

// Hosts that are normally reachable without a proxy from mainland China.
// `auto` routes everything else through the proxy when one is configured.
const DIRECT_HOST_SUFFIXES = [
  '.cn',
  'aliyuncs.com',
  'aliyun.com',
  'alibabacloud.com',
  'volces.com',
  'volcengine.com',
  'volccdn.com',
  'bytedance.com',
  'bytedanceapi.com',
  'byteimg.com',
  'bigmodel.cn',
  'deepseek.com',
  'minimaxi.com',
  'minimax.chat',
  'stepfun.com',
  'baidubce.com',
  'bcebos.com',
  'tencentcloudapi.com',
  'tencent.com',
  'myqcloud.com',
  'qq.com',
  'xfyun.cn',
  'klingai.com',
  'kuaishou.com',
  'xiaomimimo.com',
  'xiaomi.com',
  'mi.com',
  'antgroup.com',
  'alipay.com',
  'longcat.chat',
  'meituan.com',
  'sankuai.com',
  'sensenova.cn',
  'sensetime.com',
  'baichuan-ai.com',
  '360.cn',
  'localhost',
  '127.0.0.1',
];

export function getNetworkSettings(): NetworkSettings {
  return getSetting<NetworkSettings>('network', { proxyUrl: null });
}

export function setNetworkSettings(s: NetworkSettings) {
  validateNetworkSettings(s);
  setSetting('network', { proxyUrl: s.proxyUrl === undefined ? null : s.proxyUrl });
}

export function validateNetworkSettings(s: NetworkSettings) {
  if (s.proxyUrl !== null && typeof s.proxyUrl !== 'string') throw new Error('代理地址格式不正确');
  if (s.proxyUrl) {
    const url = new URL(s.proxyUrl);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('代理只支持 HTTP(S) 协议');
    if (url.username.includes('*') || url.password.includes('*'))
      throw new Error('请重新输入真实代理凭据，不能保存脱敏占位符');
  }
}

function displayProxy(value: string | null | undefined): string | null {
  if (!value) return value ?? null;
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** Display-only addresses are never accepted as a silent replacement for stored credentials. */
export function getNetworkInfo() {
  const saved = getNetworkSettings();
  const effective = proxyUrl();
  const hasCredentials = (value: string | null | undefined) => {
    try {
      const url = new URL(value || '');
      return !!(url.username || url.password);
    } catch {
      return false;
    }
  };
  return {
    proxyUrl: saved.proxyUrl === null ? null : (displayProxy(saved.proxyUrl) ?? ''),
    effectiveProxy: displayProxy(effective),
    source: proxySource(),
    hasCredentials: hasCredentials(saved.proxyUrl),
    effectiveHasCredentials: hasCredentials(effective),
  };
}

function envProxy(): string | undefined {
  for (const k of ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy']) {
    const v = process.env[k]?.trim();
    if (v && /^https?:\/\//i.test(v)) return v;
  }
  return undefined;
}

/** The effective proxy URL (undefined = none configured). */
export function proxyUrl(): string | undefined {
  const s = getNetworkSettings();
  if (s.proxyUrl === '') return undefined;
  return s.proxyUrl || envProxy();
}

export function proxySource(): 'settings' | 'env' | 'none' {
  const s = getNetworkSettings();
  if (s.proxyUrl === '') return 'none';
  if (s.proxyUrl) return 'settings';
  return envProxy() ? 'env' : 'none';
}

export function isDirectHost(host: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return DIRECT_HOST_SUFFIXES.some((s) => (s.startsWith('.') ? h.endsWith(s) : h === s || h.endsWith(`.${s}`)));
}

export interface Route {
  via: 'direct' | 'proxy';
  proxy?: string;
  reason: string;
}

export function resolveRoute(url: string, mode: NetworkMode = 'auto'): Route {
  const p = proxyUrl();
  if (mode === 'direct') return { via: 'direct', reason: '连接设置为直连' };
  if (mode === 'proxy') {
    if (!p) throw new Error('此连接要求走代理，但尚未配置代理地址；请先在设置中配置，或明确将连接改为直连');
    return { via: 'proxy', proxy: p, reason: '连接设置为走代理' };
  }
  const host = new URL(url).host;
  if (isDirectHost(host)) return { via: 'direct', reason: '国内域名，自动直连' };
  if (!p) return { via: 'direct', reason: '未配置代理，直连' };
  return { via: 'proxy', proxy: p, reason: '海外域名，自动走代理' };
}

const dispatchers = new Map<string, Dispatcher>();

function dispatcherFor(route: Route): Dispatcher {
  const key = route.proxy ?? 'direct';
  let d = dispatchers.get(key);
  if (!d) {
    // Generation endpoints can take minutes before the first byte; SSE can idle between chunks.
    const opts = { headersTimeout: 600_000, bodyTimeout: 600_000, connectTimeout: 20_000 };
    d = route.proxy ? new ProxyAgent({ uri: route.proxy, ...opts }) : new Agent(opts);
    dispatchers.set(key, d);
  }
  return d;
}

export type NetInit = RequestInit & { network?: NetworkMode; artifactDownload?: boolean };

/** Bound vendor-controlled bodies before converting them into in-memory JSON or media. */
export async function readResponseBuffer(res: Response, maxBytes = 128 * 1024 * 1024): Promise<Buffer> {
  const length = Number(res.headers.get('content-length'));
  if (Number.isFinite(length) && length > maxBytes) {
    await res.body?.cancel();
    throw new Error(`上游响应超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`);
  }
  if (!res.body) return Buffer.alloc(0);
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) return Buffer.concat(chunks, total);
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`上游响应超过 ${Math.round(maxBytes / 1024 / 1024)} MB 上限`);
      chunks.push(Buffer.from(value));
    }
  } catch (e) {
    await reader.cancel().catch(() => {});
    throw e;
  } finally {
    reader.releaseLock();
  }
}

export async function netFetch(url: string, init: NetInit = {}): Promise<Response> {
  const { network, artifactDownload, ...rest } = init;
  let route = resolveRoute(url, network);
  try {
    const canFollow = artifactDownload && ['GET', 'HEAD'].includes(rest.method ?? 'GET') && !rest.headers && !rest.body;
    let current = url;
    for (let redirects = 0; ; redirects++) {
      route = resolveRoute(current, network);
      const res = await undiciFetch(current, {
        ...(rest as any),
        redirect: rest.redirect ?? 'manual',
        dispatcher: dispatcherFor(route),
      });
      // Never forward custom auth headers or request bodies through a cross-origin redirect.
      if (rest.redirect === undefined && [301, 302, 303, 307, 308].includes(res.status)) {
        const location = res.headers.get('location');
        if (!location) return res as unknown as Response;
        const next = new URL(location, current);
        if (canFollow) {
          await res.body?.cancel();
          if (redirects >= 10) throw new Error('产物下载重定向次数超过上限');
          if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password)
            throw new Error('产物重定向地址必须为不含账号密码的 HTTP(S) URL');
          if (new URL(current).protocol === 'https:' && next.protocol !== 'https:')
            throw new Error('已拒绝将产物下载从 HTTPS 降级到 HTTP');
          current = next.toString();
          continue;
        }
        if (next.origin !== new URL(current).origin) {
          await res.body?.cancel();
          if (rest.headers || rest.body)
            throw new Error('已拒绝跨域重定向，避免向其他域名转发凭据；请使用正确的 Base URL');
          throw new Error('上游返回跨域重定向，请使用正确的地址');
        }
        // Return the original response rather than silently changing a billable native method.
      }
      return res as unknown as Response;
    }
  } catch (e: any) {
    if (
      route.via === 'proxy' &&
      /ECONNREFUSED|UND_ERR_CONNECT|proxy/i.test(`${e?.cause?.code ?? ''} ${e?.cause?.message ?? ''}`)
    ) {
      e.message = `${e.message}（经代理 ${displayProxy(route.proxy)} 连接失败：请确认代理软件正在运行，或在设置中改为直连）`;
    }
    throw e;
  }
}

export function wsAgent(url: string, mode: NetworkMode = 'auto'): { agent?: HttpAgent; route: Route } {
  const httpUrl = url.replace(/^ws/, 'http');
  const route = resolveRoute(httpUrl, mode);
  return { agent: route.proxy ? (new HttpsProxyAgent(route.proxy) as unknown as HttpAgent) : undefined, route };
}

export function describeRoute(route: Route): string {
  return route.via === 'proxy' ? `经代理 ${displayProxy(route.proxy)}（${route.reason}）` : `直连（${route.reason}）`;
}
