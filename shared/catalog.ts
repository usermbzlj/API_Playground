// Central registry: providers, operations, features and built-in presets.
// Adding a vendor = one file under shared/providers/ plus one line in PROVIDER_MODULES.
import type { AsyncSpec, FeatureDef, OperationDef, PresetDef, ProviderDef } from './types.ts';
import { FEATURES } from './features.ts';
import { BUILTIN_PRESETS } from './presets.ts';
import { deepseekOps, deepseekProvider } from './providers/deepseek.ts';
import { minimaxOps, minimaxProvider } from './providers/minimax.ts';
import { customAnthropicProvider, customOpenAIProvider, genericOps } from './providers/generic.ts';
import { kimiOps, kimiProvider } from './providers/kimi.ts';
import { mimoOps, mimoProvider } from './providers/mimo.ts';
import { qwenOps, qwenProvider } from './providers/qwen.ts';
import { arkOps, arkProvider } from './providers/ark.ts';
import { minimaxVideoModels, minimaxVideoOps } from './providers/minimax-video.ts';
import { openaiNativeOps, openaiNativeProvider } from './providers/openai-native.ts';
import { tripoOps, tripoProvider } from './providers/tripo.ts';
import { geminiOps, geminiProvider } from './providers/gemini.ts';

const PROVIDER_MODULES: { provider: ProviderDef; ops: OperationDef[] }[] = [
  { provider: deepseekProvider, ops: deepseekOps },
  {
    provider: { ...minimaxProvider, models: [...minimaxProvider.models, ...minimaxVideoModels] },
    ops: [...minimaxOps, ...minimaxVideoOps],
  },
  { provider: kimiProvider, ops: kimiOps },
  { provider: mimoProvider, ops: mimoOps },
  { provider: qwenProvider, ops: qwenOps },
  { provider: arkProvider, ops: arkOps },
  { provider: openaiNativeProvider, ops: openaiNativeOps },
  { provider: geminiProvider, ops: geminiOps },
  { provider: tripoProvider, ops: tripoOps },
  { provider: customOpenAIProvider, ops: genericOps.filter((o) => o.providerId === customOpenAIProvider.id) },
  { provider: customAnthropicProvider, ops: genericOps.filter((o) => o.providerId === customAnthropicProvider.id) },
];

export const PROVIDERS: ProviderDef[] = PROVIDER_MODULES.map((m) => m.provider);
export const OPERATIONS: OperationDef[] = PROVIDER_MODULES.flatMap((m) => m.ops);
export { BUILTIN_PRESETS };

const PROVIDER_MAP = new Map(PROVIDERS.map((p) => [p.id, p]));
const OPERATION_MAP = new Map(OPERATIONS.map((o) => [o.id, o]));

export function getProvider(id: string | undefined | null): ProviderDef | undefined {
  return id ? PROVIDER_MAP.get(id) : undefined;
}

export function getOperation(id: string | undefined | null): OperationDef | undefined {
  return id ? OPERATION_MAP.get(id) : undefined;
}

export function listOperations(providerId?: string): OperationDef[] {
  return providerId ? OPERATIONS.filter((o) => o.providerId === providerId) : OPERATIONS;
}

export function operationsForFeature(featureId: string): OperationDef[] {
  return OPERATIONS.filter((o) => o.features.includes(featureId));
}

export function getFeature(id: string): FeatureDef | undefined {
  return FEATURES.find((f) => f.id === id);
}

export function presetsFor(operationId: string): PresetDef[] {
  return BUILTIN_PRESETS.filter((p) => p.operationId === operationId);
}

/** Model ids an operation offers in its picker. */
export function modelsFor(op: OperationDef) {
  const p = getProvider(op.providerId);
  if (!p) return [];
  return op.models ? p.models.filter((m) => op.models!.includes(m.id)) : p.models;
}

/** Operation definition without function fields, for consumers outside this codebase. */
export type SerializedOperation = Omit<
  OperationDef,
  'build' | 'artifacts' | 'streamArtifacts' | 'async' | 'insights' | 'estimateCost' | 'realtime'
> & {
  async?: Omit<AsyncSpec, 'results' | 'resolve' | 'resolveResults'>;
  realtime?: Omit<NonNullable<OperationDef['realtime']>, 'session'>;
};

export function serializeOperation(op: OperationDef): SerializedOperation {
  const out: any = {
    ...op,
    async: op.async ? { ...op.async } : undefined,
    realtime: op.realtime ? { ...op.realtime } : undefined,
  };
  for (const k of ['build', 'artifacts', 'streamArtifacts', 'insights', 'estimateCost']) delete out[k];
  if (out.async) for (const k of ['results', 'resolve', 'resolveResults']) delete out.async[k];
  if (out.realtime) delete out.realtime.session;
  return out as SerializedOperation;
}

export function catalogSnapshot() {
  return {
    providers: PROVIDERS,
    operations: OPERATIONS.map(serializeOperation),
    features: FEATURES,
    presets: BUILTIN_PRESETS,
  };
}
