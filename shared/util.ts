import type { ParamSpec } from './types.ts';

/** Join an API root and native path, accepting either /v1 or /v1/operation conventions. */
export function joinApiUrl(baseUrl: string, path: string): string {
  if (/^[a-z]+:\/\//i.test(path)) return path;
  const base = new URL(baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password)
    throw new Error('API 地址须为不含账号密码的 HTTP(S) URL');
  const prefix = base.pathname.replace(/\/+$/, '');
  const relative = path.startsWith('/') ? path : `/${path}`;
  const suffix =
    prefix && (relative === prefix || relative.startsWith(`${prefix}/`) || relative.startsWith(`${prefix}?`))
      ? relative.slice(prefix.length)
      : relative;
  base.search = '';
  base.hash = '';
  return base.toString().replace(/\/+$/, '') + suffix;
}

export function getPath(obj: any, path: string): any {
  if (!path) return obj;
  let cur = obj;
  for (const part of path.split('.')) {
    if (cur == null) return undefined;
    cur = Array.isArray(cur) && /^\d+$/.test(part) ? cur[Number(part)] : cur[part];
  }
  return cur;
}

export function setPath(obj: any, path: string, value: unknown): void {
  const parts = path.split('.');
  if (parts.some((p) => ['__proto__', 'prototype', 'constructor'].includes(p))) throw new Error('参数路径包含保留字段');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const p = parts[i];
    if (cur[p] == null || typeof cur[p] !== 'object') cur[p] = /^\d+$/.test(parts[i + 1]) ? [] : {};
    cur = cur[p];
  }
  cur[parts[parts.length - 1]] = value;
}

export interface ParamState {
  enabled: boolean;
  value: unknown;
}

export function paramApplies(spec: ParamSpec, model: string): boolean {
  if (!spec.models) return true;
  try {
    return new RegExp(spec.models, 'i').test(model);
  } catch {
    return true;
  }
}

export function coerceParam(spec: ParamSpec, value: unknown): unknown {
  switch (spec.type) {
    case 'number':
    case 'integer': {
      if (value === '' || value == null) return undefined;
      const n = Number(value);
      if (!Number.isFinite(n)) throw new Error(`参数 ${spec.key} 必须是有效数字`);
      if (spec.type === 'integer' && !Number.isInteger(n)) throw new Error(`参数 ${spec.key} 必须是整数`);
      if ((spec.min !== undefined && n < spec.min) || (spec.max !== undefined && n > spec.max))
        throw new Error(`参数 ${spec.key} 超出允许范围 ${spec.min ?? '不限'}～${spec.max ?? '不限'}`);
      return n;
    }
    case 'boolean':
      return value === true || value === 'true';
    case 'json':
      if (typeof value === 'string') {
        if (!value.trim()) return undefined;
        try {
          return JSON.parse(value);
        } catch {
          // 由调用方转成对用户可读的错误，而不是把堆栈抛到 500。
          throw new Error(`参数不是合法 JSON：${value.slice(0, 80)}${value.length > 80 ? '…' : ''}`);
        }
      }
      return value;
    case 'string-list':
      if (Array.isArray(value)) return value;
      return String(value ?? '')
        .split(/\r?\n|,/)
        .map((s) => s.trim())
        .filter(Boolean);
    case 'enum': {
      const opt = spec.options?.find((o) => String(o.value) === String(value));
      if (!opt) throw new Error(`参数 ${spec.key} 的值不在可选范围内`);
      return opt.value;
    }
    default:
      return value;
  }
}

/** Apply enabled body params onto a native body (mutates). Returns list of applied keys. */
export function applyParams(
  body: Record<string, unknown>,
  specs: ParamSpec[],
  state: Record<string, ParamState>,
  model: string,
): string[] {
  const applied: string[] = [];
  for (const spec of specs) {
    if (spec.in && spec.in !== 'body') continue;
    const st = state[spec.key];
    if (!st?.enabled || !paramApplies(spec, model)) continue;
    const v = coerceParam(spec, st.value);
    if (v === undefined) continue;
    setPath(body, spec.key, v);
    applied.push(spec.key);
  }
  return applied;
}

/** Apply header / query params onto a request (mutates headers and path). */
export function applyRequestParams(
  req: { path: string; headers?: Record<string, string> },
  specs: ParamSpec[],
  state: Record<string, ParamState>,
  model: string,
): void {
  for (const spec of specs) {
    if (spec.in !== 'header' && spec.in !== 'query') continue;
    const st = state[spec.key];
    if (!st?.enabled || !paramApplies(spec, model)) continue;
    const v = coerceParam(spec, st.value);
    if (v === undefined) continue;
    const s = typeof v === 'string' ? v : JSON.stringify(v);
    if (spec.in === 'header') req.headers = { ...(req.headers ?? {}), [spec.key]: s };
    else req.path += `${req.path.includes('?') ? '&' : '?'}${encodeURIComponent(spec.key)}=${encodeURIComponent(s)}`;
  }
}

/** Effective value of one param (undefined when disabled or not applicable). */
export function paramValue(specs: ParamSpec[], state: Record<string, ParamState>, key: string, model: string): unknown {
  const spec = specs.find((s) => s.key === key);
  const st = state[key];
  if (!spec || !st?.enabled || !paramApplies(spec, model)) return undefined;
  return coerceParam(spec, st.value);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

export function initialParamState(specs: ParamSpec[], overrides?: Record<string, unknown>): Record<string, ParamState> {
  const out: Record<string, ParamState> = {};
  for (const s of specs) {
    const has = overrides && Object.prototype.hasOwnProperty.call(overrides, s.key);
    out[s.key] = {
      enabled: has ? overrides![s.key] !== undefined : !!s.enabledByDefault,
      value: has
        ? overrides![s.key]
        : s.type === 'json' && s.default !== undefined && typeof s.default !== 'string'
          ? JSON.stringify(s.default, null, 2)
          : s.default,
    };
  }
  return out;
}

export function fillTemplate(path: string, vars: Record<string, string>): string {
  return path.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(vars[k] ?? ''));
}

export function shortId(): string {
  const t = Date.now().toString(36);
  const r = Math.random().toString(36).slice(2, 8);
  return `${t}${r}`;
}

export function truncateDeep(value: any, maxString = 4000): any {
  if (typeof value === 'string') {
    return value.length > maxString ? `${value.slice(0, 200)}…[已截断 ${value.length} 字符]` : value;
  }
  if (Array.isArray(value)) return value.map((v) => truncateDeep(v, maxString));
  if (value && typeof value === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(value)) out[k] = truncateDeep(v, maxString);
    return out;
  }
  return value;
}
