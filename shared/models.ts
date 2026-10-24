// Parse vendor model-list responses into a common shape while keeping vendor metadata.
export interface RemoteModel {
  id: string;
  name?: string;
  ownedBy?: string;
  context?: number;
  /** vendor metadata kept verbatim (pricing, supported_parameters, modalities …) */
  meta: Record<string, any>;
}

export function parseModelList(body: any): RemoteModel[] {
  const list: any[] = Array.isArray(body)
    ? body
    : Array.isArray(body?.data)
      ? body.data
      : Array.isArray(body?.models)
        ? body.models
        : Array.isArray(body?.data?.models)
          ? body.data.models
          : [];
  const out: RemoteModel[] = [];
  for (const m of list) {
    if (typeof m === 'string') {
      out.push({ id: m, meta: {} });
      continue;
    }
    if (!m || typeof m !== 'object') continue;
    const id = String(m.id ?? m.model ?? m.name ?? '').replace(/^models\//, '');
    if (!id) continue;
    out.push({
      id,
      name: m.display_name ?? m.displayName ?? m.name,
      ownedBy: m.owned_by ?? m.ownedBy,
      context: Number(m.context_length ?? m.context_window ?? m.inputTokenLimit ?? m.max_context_length) || undefined,
      meta: m,
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}
