import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.ts';
import type { RemoteModel } from '../../shared/models.ts';
import type { ConnectionInfo, ProviderDef } from '../../shared/types.ts';

const remoteModelCache = new Map<string, RemoteModel[]>();

function modelCacheKey(conn: ConnectionInfo | undefined) {
  return conn
    ? JSON.stringify([
        conn.id,
        conn.revision,
        conn.baseUrl,
        conn.keyPreview,
        conn.extra,
        conn.network,
        conn.lastTest?.at,
      ])
    : '';
}

export function useRemoteModels(conn: ConnectionInfo | undefined, provider: ProviderDef | undefined) {
  const cacheKey = modelCacheKey(conn);
  const currentKey = useRef(cacheKey);
  currentKey.current = cacheKey;
  const sequence = useRef(0);
  const [models, setModels] = useState<RemoteModel[] | null>(remoteModelCache.get(cacheKey) ?? null);
  const [error, setError] = useState('');
  const load = useCallback(
    async (refresh = false) => {
      if (!conn || !provider?.modelsPath) return;
      const request = ++sequence.current;
      const key = cacheKey;
      try {
        const r = await api.remoteModels(conn.id, { refresh });
        remoteModelCache.set(key, r.models);
        if (key !== currentKey.current || request !== sequence.current) return;
        setModels(r.models);
        setError('');
      } catch (e: any) {
        if (key !== currentKey.current || request !== sequence.current) return;
        setError(e.message);
      }
    },
    [cacheKey, provider?.modelsPath],
  );
  useEffect(() => {
    setModels(remoteModelCache.get(cacheKey) ?? null);
    setError('');
    if (conn && provider?.modelsPath && !remoteModelCache.has(cacheKey)) void load();
    return () => {
      sequence.current++;
    };
  }, [cacheKey, provider?.modelsPath, load]);
  return { models, error, load };
}
