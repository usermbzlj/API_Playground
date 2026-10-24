import { useEffect, useState } from 'react';

export interface Route {
  path: string;
  parts: string[];
  query: URLSearchParams;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s; // 畸形编码（如 #/lab/%）不应让整个应用白屏
  }
}

function parse(): Route {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path, parts: path.split('/').filter(Boolean).map(safeDecode), query: new URLSearchParams(qs || '') };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

export function navigate(to: string) {
  window.location.hash = to.startsWith('#') ? to : `#${to}`;
}

export function href(to: string) {
  return `#${to}`;
}

function withQuery(base: string, q: Record<string, string | undefined | null>) {
  const qs = new URLSearchParams(Object.entries(q).filter(([, v]) => v) as [string, string][]).toString();
  return `${base}${qs ? `?${qs}` : ''}`;
}

export function labHref(
  operationId: string,
  q: { run?: string; preset?: string; model?: string; connection?: string } = {},
) {
  return withQuery(`#/lab/${encodeURIComponent(operationId)}`, q);
}

export function providerHref(id: string) {
  return `#/provider/${encodeURIComponent(id)}`;
}

export function featureHref(id: string) {
  return `#/feature/${encodeURIComponent(id)}`;
}

/** Compare page: either lanes from operations (ops=a,b) or recorded runs (runs=x,y). */
export function compareHref(q: { ops?: string[]; runs?: string[]; from?: string; group?: string }) {
  return withQuery('#/compare', { ops: q.ops?.join(','), runs: q.runs?.join(','), from: q.from, group: q.group });
}
