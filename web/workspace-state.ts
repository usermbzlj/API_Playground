import { useCallback, useRef, useSyncExternalStore, type Dispatch, type SetStateAction } from 'react';
import { redactSensitive } from '../shared/redact.ts';

const PREFIX = 'prismlab:draft:v1:';
export interface DraftMetadata {
  key: string;
  title: string;
  href: string;
  operationId?: string;
  hidden?: boolean;
  updatedAt: number;
}
interface DraftRecord extends DraftMetadata {
  value: unknown;
}
const drafts = new Map<string, DraftRecord>();
const listeners = new Set<() => void>();
const pending = new Map<string, ReturnType<typeof setTimeout>>();
let scanned = false;
let snapshot: DraftMetadata[] = [];

/** Editors may contain serialized JSON; redact its fields before writing browser storage. */
export function sanitizeDraftForStorage<T>(value: T): T {
  const visit = (item: unknown, key = ''): unknown => {
    if (typeof item === 'string' && /^(headers|body|customBody)$/i.test(key)) {
      if (!item.trim()) return item;
      try {
        const parsed = JSON.parse(item);
        if (/^headers$/i.test(key) && (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))) return '';
        return JSON.stringify(redactSensitive(parsed, /^headers$/i.test(key)), null, 2);
      } catch {
        // A partially typed credential field cannot be safely serialized yet.
        return '';
      }
    }
    if (Array.isArray(item)) return item.map((child) => visit(child));
    if (!item || typeof item !== 'object') return redactSensitive(item);
    const safe = Object.fromEntries(Object.entries(item).map(([name, child]) => [name, visit(child, name)]));
    return redactSensitive(safe, /^headers$/i.test(key));
  };
  return visit(value) as T;
}

function scan() {
  if (scanned) return;
  scanned = true;
  try {
    for (let i = 0; i < sessionStorage.length; i++) {
      const name = sessionStorage.key(i);
      if (!name?.startsWith(PREFIX)) continue;
      try {
        const record = JSON.parse(sessionStorage.getItem(name) ?? 'null') as DraftRecord;
        if (record && typeof record.key === 'string' && typeof record.updatedAt === 'number')
          drafts.set(record.key, record);
      } catch {
        // A damaged draft must not prevent other experiments from opening.
      }
    }
  } catch {
    // Private browsing/storage limits still allow in-memory drafts.
  }
  rebuild();
}
function rebuild() {
  snapshot = [...drafts.values()]
    .filter((record) => !record.hidden)
    .map(({ value: _value, ...meta }) => meta)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}
function emit() {
  rebuild();
  for (const listener of listeners) listener();
}
function subscribe(listener: () => void) {
  scan();
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function persist(key: string) {
  const timer = pending.get(key);
  if (timer) clearTimeout(timer);
  pending.delete(key);
  const record = drafts.get(key);
  try {
    if (record)
      sessionStorage.setItem(PREFIX + key, JSON.stringify({ ...record, value: sanitizeDraftForStorage(record.value) }));
    else sessionStorage.removeItem(PREFIX + key);
  } catch {
    // The current tab retains the draft even when browser storage is full.
  }
}
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => {
    for (const key of pending.keys()) persist(key);
  });
}

export function listDrafts(): DraftMetadata[] {
  scan();
  return snapshot;
}
export function useDrafts() {
  return useSyncExternalStore(subscribe, listDrafts, listDrafts);
}
export function readDraft<T>(key: string): T | undefined {
  scan();
  return drafts.get(key)?.value as T | undefined;
}
export function writeDraft<T>(key: string, value: T, meta: Partial<Omit<DraftMetadata, 'key' | 'updatedAt'>> = {}) {
  scan();
  const previous = drafts.get(key);
  drafts.set(key, {
    key,
    title: meta.title ?? previous?.title ?? '未命名实验',
    href: meta.href ?? previous?.href ?? (typeof location === 'undefined' ? '#/explore' : location.hash),
    operationId: meta.operationId ?? previous?.operationId,
    hidden: meta.hidden ?? previous?.hidden,
    updatedAt: Date.now(),
    value,
  });
  const timer = pending.get(key);
  if (timer) clearTimeout(timer);
  pending.set(
    key,
    setTimeout(() => persist(key), 250),
  );
  emit();
}
export function clearDraft(key: string) {
  scan();
  drafts.delete(key);
  persist(key);
  emit();
}
export function clearAllDrafts() {
  scan();
  for (const key of [...drafts.keys()]) {
    drafts.delete(key);
    persist(key);
  }
  emit();
}

/** Session-local experiment input. Connection credentials never belong in this value. */
export function usePersistentDraft<T>(
  key: string,
  initial: T | (() => T),
  meta: Partial<Omit<DraftMetadata, 'key' | 'updatedAt'>> = {},
): [T, Dispatch<SetStateAction<T>>, { reset: () => void; clear: () => void; restored: boolean }] {
  const initialRef = useRef<{ key: string; value: T } | null>(null);
  if (!initialRef.current || initialRef.current.key !== key)
    initialRef.current = { key, value: typeof initial === 'function' ? (initial as () => T)() : initial };
  const restoredRef = useRef(readDraft<T>(key) !== undefined);
  const fallback = initialRef.current.value;
  const getSnapshot = useCallback(() => readDraft<T>(key) ?? fallback, [key, fallback]);
  const value = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const metadata = useRef(meta);
  metadata.current = meta;
  const setValue: Dispatch<SetStateAction<T>> = useCallback(
    (next) => {
      const current = readDraft<T>(key) ?? fallback;
      const resolved = typeof next === 'function' ? (next as (previous: T) => T)(current) : next;
      if (!Object.is(current, resolved)) writeDraft(key, resolved, metadata.current);
    },
    [key, fallback],
  );
  return [
    value,
    setValue,
    { reset: () => setValue(structuredClone(fallback)), clear: () => clearDraft(key), restored: restoredRef.current },
  ];
}
