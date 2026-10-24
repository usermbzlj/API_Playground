import { useMemo, useState } from 'react';
import type { ParamSpec } from '../../shared/types.ts';
import { paramApplies, type ParamState } from '../../shared/util.ts';
import { Chip, CodeInput, VerificationChip } from '../ui.tsx';

export function ParamsPanel({
  specs,
  state,
  setState,
  model,
  compact,
}: {
  specs: ParamSpec[];
  state: Record<string, ParamState>;
  setState: (fn: (prev: Record<string, ParamState>) => Record<string, ParamState>) => void;
  model: string;
  compact?: boolean;
}) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [onlyEnabled, setOnlyEnabled] = useState(false);
  const [query, setQuery] = useState('');
  const search = query.trim().toLowerCase();
  const groups = useMemo(() => {
    const map = new Map<string, ParamSpec[]>();
    for (const s of specs) {
      const list = map.get(s.group ?? '参数') ?? [];
      list.push(s);
      map.set(s.group ?? '参数', list);
    }
    return [...map.entries()];
  }, [specs]);

  if (specs.length === 0) return <p className="text-xs text-zinc-600">该操作没有可调的原生参数。</p>;
  const enabledCount = specs.filter((s) => state[s.key]?.enabled).length;
  const hiddenAdvanced = specs.filter((s) => s.advanced).length;

  return (
    <div className="space-y-3">
      {specs.length > 8 && (
        <input
          type="search"
          className="input text-xs"
          aria-label="搜索原生参数"
          placeholder="搜索参数名称、含义或说明…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      )}
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-zinc-500">
        <span>
          已启用 {enabledCount} / {specs.length}
        </span>
        {hiddenAdvanced > 0 && (
          <label className="flex items-center gap-1.5">
            <input type="checkbox" checked={showAdvanced} onChange={(e) => setShowAdvanced(e.target.checked)} />
            显示高级参数（{hiddenAdvanced}）
          </label>
        )}
        <label className="flex items-center gap-1.5">
          <input type="checkbox" checked={onlyEnabled} onChange={(e) => setOnlyEnabled(e.target.checked)} />
          只看已启用
        </label>
      </div>
      {groups.map(([group, list]) => {
        const items = list.filter(
          (s) =>
            (showAdvanced || !!search || !s.advanced || state[s.key]?.enabled) &&
            (!onlyEnabled || state[s.key]?.enabled) &&
            (!search || `${s.key} ${s.label} ${s.description ?? ''}`.toLowerCase().includes(search)),
        );
        if (items.length === 0) return null;
        return (
          <div key={group}>
            <h3 className="mb-1.5 text-[11px] font-semibold text-zinc-400">{group}</h3>
            <div className="space-y-2">
              {items.map((s) => {
                const st = state[s.key] ?? { enabled: false, value: s.default };
                const applies = !model || paramApplies(s, model);
                return (
                  <div
                    key={s.key}
                    className={`flex items-start gap-2 ${applies ? '' : 'opacity-40'}`}
                    title={applies ? undefined : `该参数只适用于匹配 /${s.models}/ 的模型`}
                  >
                    <input
                      type="checkbox"
                      className="mt-1.5"
                      aria-label={`随请求发送 ${s.label || s.key}`}
                      disabled={!applies}
                      checked={st.enabled}
                      onChange={(e) => setState((prev) => ({ ...prev, [s.key]: { ...st, enabled: e.target.checked } }))}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className={`mono text-xs ${st.enabled ? 'text-zinc-100' : 'text-zinc-400'}`}>
                          {s.key}
                        </span>
                        {s.label !== s.key && <span className="text-[11px] text-zinc-500">{s.label}</span>}
                        {s.in && s.in !== 'body' && <Chip tone="blue">{s.in === 'header' ? '请求头' : '查询串'}</Chip>}
                        {s.native && <Chip tone="violet">原生</Chip>}
                        {s.verification && <VerificationChip v={s.verification} />}
                        {!applies && <span className="text-[11px] text-amber-300">当前模型不适用，不会发送</span>}
                      </div>
                      {(st.enabled || !compact) && (
                        <ParamControl
                          spec={s}
                          value={st.value}
                          onChange={(v) => setState((prev) => ({ ...prev, [s.key]: { enabled: true, value: v } }))}
                        />
                      )}
                      {s.description && !compact && (
                        <p className="mt-0.5 text-[11px] leading-relaxed text-zinc-500">{s.description}</p>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ParamControl({
  spec,
  value,
  onChange,
}: {
  spec: ParamSpec;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  switch (spec.type) {
    case 'number':
    case 'integer':
      return (
        <div className="mt-1 flex items-center gap-2">
          <input
            type="number"
            className="input w-32"
            aria-label={spec.label || spec.key}
            value={value == null ? '' : String(value)}
            min={spec.min}
            max={spec.max}
            step={spec.step ?? (spec.type === 'integer' ? 1 : 0.1)}
            onChange={(e) => onChange(e.target.value === '' ? undefined : Number(e.target.value))}
          />
          {spec.min != null && spec.max != null && spec.max - spec.min <= 100 && (
            <input
              type="range"
              className="flex-1 accent-violet-500"
              aria-label={`${spec.label || spec.key} 滑块`}
              min={spec.min}
              max={spec.max}
              step={spec.step ?? (spec.type === 'integer' ? 1 : 0.01)}
              value={value == null ? Number(spec.default ?? spec.min) : Number(value)}
              onChange={(e) => onChange(Number(e.target.value))}
            />
          )}
        </div>
      );
    case 'boolean':
      return (
        <label className="mt-1 flex items-center gap-1.5 text-xs text-zinc-300">
          <input
            type="checkbox"
            aria-label={spec.label || spec.key}
            checked={value === true || value === 'true'}
            onChange={(e) => onChange(e.target.checked)}
          />
          {String(value === true || value === 'true')}
        </label>
      );
    case 'enum':
      return (
        <select
          className="input mt-1 w-full max-w-full sm:w-56"
          aria-label={spec.label || spec.key}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        >
          {(spec.options ?? []).map((o) => (
            <option key={String(o.value)} value={String(o.value)}>
              {o.label ? `${o.value} · ${o.label}` : String(o.value)}
            </option>
          ))}
        </select>
      );
    case 'string-list':
      return (
        <textarea
          className="input mono mt-1 min-h-14 text-xs"
          aria-label={spec.label || spec.key}
          value={Array.isArray(value) ? value.join('\n') : String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
          placeholder="每行一个"
        />
      );
    case 'text':
      return (
        <textarea
          className="input mt-1 min-h-16"
          aria-label={spec.label || spec.key}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      );
    case 'json':
      return (
        <div className="mt-1">
          <CodeInput
            value={typeof value === 'string' ? value : JSON.stringify(value ?? null, null, 2)}
            onChange={onChange}
            minHeight={80}
          />
        </div>
      );
    default:
      return (
        <input
          className="input mono mt-1"
          aria-label={spec.label || spec.key}
          value={String(value ?? '')}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}

/** Collapse a param state into the "enabled key → value" form used by presets. */
export function enabledParams(state: Record<string, ParamState>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(state)
      .filter(([, s]) => s.enabled)
      .map(([k, s]) => [k, s.value]),
  );
}

/** Describe the difference between two param states, for compare fairness notes. */
export function diffParams(a: Record<string, ParamState>, b: Record<string, ParamState>): string[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: string[] = [];
  for (const k of keys) {
    const x = a[k]?.enabled ? JSON.stringify(a[k].value) : '（未发送）';
    const y = b[k]?.enabled ? JSON.stringify(b[k].value) : '（未发送）';
    if (x !== y) out.push(`${k}: ${x} → ${y}`);
  }
  return out;
}
