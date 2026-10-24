/** The engine is the vendored usermbzlj/llm-bench Python runner, not a JS approximation. */
export type BenchStatus =
  'starting' | 'running' | 'cancelling' | 'completed' | 'cancelled' | 'failed' | 'interrupted' | 'imported';
export interface BenchConfig {
  connectionId: string;
  model: string;
  endpoint?: 'chat' | 'responses';
  path?: string;
  mode: 'total' | 'duration' | 'rps' | 'sweep';
  totalRequests?: number;
  durationSeconds?: number;
  targetRps?: number;
  concurrency?: number;
  sweepConcurrency?: number[];
  warmup?: number;
  retries429?: number;
  retriesNetwork?: number;
  retries5xx?: number;
  timeoutSeconds?: number;
  maxTokens?: number;
  temperature?: number;
  stream?: boolean;
  http2?: boolean;
  prompts?: string[];
  promptStrategy?: 'sequential' | 'random' | 'weighted';
  promptWeights?: number[];
  customBody?: Record<string, unknown>;
  extraBody?: Record<string, unknown>;
  confirmedCost?: boolean;
  /** A retry of an ambiguous start must reuse this id rather than bill twice. */
  clientRequestId?: string;
}
export interface BenchStats {
  requests_total: number;
  requests_success: number;
  requests_failed: number;
  wall_seconds: number;
  [metric: string]: unknown;
}
export interface BenchStage {
  concurrency: number;
  stats: BenchStats;
  results: Record<string, unknown>[];
}
export interface BenchProgress {
  stage: number;
  stages: number;
  concurrency: number;
  stats: BenchStats;
  message?: string;
  elapsedSeconds?: number;
}
export interface BenchLimits {
  stages: number;
  estimatedRequests: number | null;
  warmupRequests: number;
  maxRequests: number;
  maxAttempts: number;
  maxRuntimeSeconds: number;
}
export interface BenchRecord {
  id: string;
  status: BenchStatus;
  createdAt: string;
  updatedAt: string;
  config: BenchConfig;
  connectionLabel?: string;
  connectionSnapshot?: {
    providerId: string;
    label: string;
    baseUrl: string;
    url: string;
    network: string;
    route: string;
  };
  limits?: BenchLimits;
  importedAt?: string;
  progress?: BenchProgress;
  stages: BenchStage[];
  error?: string;
  source?: string;
}

/** Shared by confirmation and execution so the visible budget matches the enforced limits. */
export function benchLimits(config: Partial<BenchConfig>): BenchLimits {
  const levels = config.mode === 'sweep' ? [...new Set(config.sweepConcurrency ?? [1])] : [config.concurrency ?? 2];
  const stages = levels.length;
  const duration = config.durationSeconds ?? 10;
  const estimatedRequests =
    config.mode === 'duration'
      ? null
      : config.mode === 'rps'
        ? Math.ceil(duration * (config.targetRps ?? 1))
        : (config.totalRequests ?? 20) * stages;
  const warmupRequests = (config.warmup ?? 0) * stages;
  const attemptsPerRequest = 1 + (config.retries429 ?? 0) + (config.retriesNetwork ?? 0) + (config.retries5xx ?? 0);
  // Total/sweep have an explicit 30-minute ceiling, independent of the hidden duration field.
  // Timed modes also allow warmup and already-dispatched requests to drain before their ceiling.
  const attemptWindow = (config.timeoutSeconds ?? 60) * 4 * attemptsPerRequest + 2 ** (attemptsPerRequest - 1);
  const timedWindow = 30 + duration + (Math.ceil((config.warmup ?? 0) / Math.max(1, levels[0])) + 1) * attemptWindow;
  return {
    stages,
    estimatedRequests,
    warmupRequests,
    maxRequests: 10000,
    maxAttempts: Math.min(
      20000,
      estimatedRequests == null ? 20000 : (estimatedRequests + warmupRequests) * attemptsPerRequest,
    ),
    maxRuntimeSeconds:
      config.mode === 'total' || config.mode === 'sweep' ? 1800 : Math.min(1800, Math.ceil(timedWindow)),
  };
}
export interface BenchRuntime {
  available: boolean;
  engine: string;
  version?: string;
  error?: string;
}
