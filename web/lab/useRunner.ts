import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { streamRun, type RunRequestBody } from '../api.ts';
import type { AssetInfo, TraceEvent } from '../../shared/types.ts';
import type { View } from '../../shared/protocols.ts';

export interface RunState {
  running: boolean;
  events: TraceEvent[];
  request: any;
  response: any;
  artifacts: AssetInfo[];
  error: any;
  metrics: any;
  runId?: string;
  taskId?: string;
  status?: string;
  costPrompt?: any;
  view?: View;
  /** Immutable configuration associated with the displayed response. */
  inputSnapshot?: RunRequestBody;
  executionId?: number;
}
export interface RunSessionInfo {
  sessionKey: string;
  runId?: string;
  running: boolean;
  title: string;
  href: string;
  operationId?: string;
  startedAt: number;
  body?: RunRequestBody;
}
interface RunSession {
  key: string;
  state: RunState;
  listeners: Set<() => void>;
  controller: AbortController | null;
  queue: TraceEvent[];
  timer: ReturnType<typeof setTimeout> | null;
  generation: number;
  info: RunSessionInfo;
  onFinished?: (state: RunState) => void;
  externalCancel?: () => void;
}
const EMPTY: RunState = {
  running: false,
  events: [],
  request: null,
  response: null,
  artifacts: [],
  error: null,
  metrics: null,
};
const sessions = new Map<string, RunSession>();
const sessionListeners = new Set<() => void>();
let sessionSnapshot: RunSessionInfo[] = [];
let anonymousSequence = 0;

function announce() {
  sessionSnapshot = [...sessions.values()]
    .filter((s) => s.info.startedAt > 0)
    .map((s) => ({ ...s.info, runId: s.state.runId, running: s.state.running }))
    .sort((a, b) => b.startedAt - a.startedAt);
  for (const listener of sessionListeners) listener();
}
function pruneSessions() {
  const completed = [...sessions.values()]
    .filter((session) => !session.state.running && session.listeners.size === 0)
    .sort((a, b) => b.info.startedAt - a.info.startedAt);
  for (const session of completed.slice(8)) sessions.delete(session.key);
  if (completed.length > 8) announce();
}
function getSession(key: string) {
  let session = sessions.get(key);
  if (!session) {
    session = {
      key,
      state: EMPTY,
      listeners: new Set(),
      controller: null,
      queue: [],
      timer: null,
      generation: 0,
      info: { sessionKey: key, running: false, title: '', href: '#/explore', startedAt: 0 },
    };
    sessions.set(key, session);
  }
  return session;
}
function publish(session: RunSession, state: RunState) {
  const before = session.state;
  session.state = state;
  for (const listener of session.listeners) listener();
  if (before.running !== state.running || before.runId !== state.runId) announce();
}
function applyEvent(state: RunState, event: TraceEvent): RunState {
  const next = { ...state };
  switch (event.type) {
    case 'request':
      next.request = event.data;
      next.runId = event.data?.runId ?? next.runId;
      break;
    case 'body':
      next.response = event.data;
      if (event.data?.view) next.view = event.data.view;
      break;
    case 'artifact':
      next.artifacts = [...state.artifacts, event.data];
      break;
    case 'error':
      next.error = event.data;
      if (event.data?.costConfirm) next.costPrompt = event.data;
      break;
    case 'info':
      if (event.data?.taskId) next.taskId = event.data.taskId;
      break;
    case 'done':
      next.metrics = event.data?.metrics ?? null;
      next.status = event.data?.status;
      next.runId = event.data?.runId ?? next.runId;
      if (event.data?.taskId) next.taskId = event.data.taskId;
      if (event.data?.view) next.view = event.data.view;
      break;
  }
  return next;
}
function flush(session: RunSession) {
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;
  const batch = session.queue.splice(0);
  if (!batch.length) return;
  const state = batch.reduce(applyEvent, session.state);
  publish(session, { ...state, events: [...session.state.events, ...batch] });
}

export function listRunSessions(): RunSessionInfo[] {
  return sessionSnapshot;
}
export function useRunSessions() {
  return useSyncExternalStore(
    useCallback((listener: () => void) => {
      sessionListeners.add(listener);
      return () => sessionListeners.delete(listener);
    }, []),
    listRunSessions,
    listRunSessions,
  );
}
export function cancelRunSession(sessionKey: string) {
  const session = sessions.get(sessionKey);
  session?.controller?.abort();
  session?.externalCancel?.();
}
export function readRunSession(sessionKey: string): RunState | undefined {
  return sessions.get(sessionKey)?.state;
}
export function setExternalRunSession(
  sessionKey: string,
  info: { title: string; href: string; operationId?: string; runId?: string },
  running: boolean,
  cancel: () => void,
) {
  const session = getSession(sessionKey);
  session.externalCancel = cancel;
  session.info = { ...session.info, ...info, running, startedAt: session.info.startedAt || Date.now() };
  publish(session, { ...session.state, running, runId: info.runId });
  announce();
}

/** Starts once, survives route unmounts, and retains the request that produced its result. */
export async function startRunSession(sessionKey: string, body: RunRequestBody, href?: string) {
  const session = getSession(sessionKey);
  if (session.controller) return;
  const generation = ++session.generation;
  const controller = new AbortController();
  const frozen = structuredClone(body);
  session.controller = controller;
  session.queue = [];
  if (session.timer) clearTimeout(session.timer);
  session.timer = null;
  session.info = {
    sessionKey,
    running: true,
    title: body.title ?? body.operationId ?? '原始请求',
    operationId: body.operationId ?? undefined,
    startedAt: Date.now(),
    href: href ?? (typeof location === 'undefined' ? '#/explore' : location.hash),
    body: frozen,
  };
  publish(session, { ...EMPTY, running: true, inputSnapshot: frozen, executionId: generation });
  const enqueue = (event: TraceEvent) => {
    if (session.generation !== generation) return;
    session.queue.push(event);
    if (!session.timer) session.timer = setTimeout(() => flush(session), 50);
  };
  try {
    await streamRun(frozen, enqueue, controller.signal);
  } catch (error: any) {
    if (session.generation !== generation) return;
    if (error?.name === 'AbortError') enqueue({ t: 0, type: 'done', data: { status: 'cancelled' } });
    else {
      enqueue({
        t: 0,
        type: 'error',
        data: {
          title: '与本地服务的连接中断',
          hints: [error.message, '先查看已保存记录确认本次状态，再决定是否重新运行。'],
        },
      });
      enqueue({ t: 0, type: 'done', data: { status: 'error' } });
    }
  } finally {
    if (session.generation === generation) {
      flush(session);
      session.controller = null;
      publish(session, { ...session.state, running: false });
      session.onFinished?.(session.state);
      pruneSessions();
    }
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', (event) => {
    if (![...sessions.values()].some((session) => session.state.running)) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

/** Passing a sessionKey keeps a run alive when its page is temporarily left. */
export function useRunner(onFinished?: (state: RunState) => void, sessionKey?: string) {
  const anonymous = useRef<string | null>(null);
  if (!anonymous.current) anonymous.current = `anonymous:${++anonymousSequence}`;
  const key = sessionKey ?? anonymous.current;
  const session = getSession(key);
  const finished = useRef(onFinished);
  finished.current = onFinished;
  session.onFinished = (state) => finished.current?.(state);
  const state = useSyncExternalStore(
    useCallback(
      (listener: () => void) => {
        session.listeners.add(listener);
        return () => session.listeners.delete(listener);
      },
      [session],
    ),
    useCallback(() => session.state, [session]),
    useCallback(() => session.state, [session]),
  );
  useEffect(
    () => () => {
      if (sessionKey) {
        pruneSessions();
        return;
      }
      session.onFinished = undefined;
      session.controller?.abort();
      if (!session.controller) sessions.delete(key);
    },
    [session, sessionKey, key],
  );
  const start = useCallback((body: RunRequestBody) => startRunSession(key, body), [key]);
  const abort = useCallback(() => cancelRunSession(key), [key]);
  const reset = useCallback(() => {
    if (!session.controller) publish(session, EMPTY);
  }, [session]);
  const clearCostPrompt = useCallback(() => publish(session, { ...session.state, costPrompt: undefined }), [session]);
  const load = useCallback(
    (loaded: Partial<RunState>) => {
      // A restored record must not overwrite a newer result already held by this route.
      if (session.controller || session.state.inputSnapshot || session.state.runId) return;
      publish(session, { ...EMPTY, ...loaded });
    },
    [session],
  );
  return { ...state, start, abort, reset, clearCostPrompt, load };
}
