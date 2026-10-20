// Isomorphic definitions shared by the local server and the web UI.
// Operation definitions live in shared code so the server can run async polling,
// artifact extraction and validation with exactly the same logic the UI previews.

export type VerificationStatus =
  | 'tested' // 本项目真实调用成功
  | 'partial' // 实测部分可用或与文档不符
  | 'documented' // 官方文档声称支持，尚未实测
  | 'restricted' // 需要白名单 / 开通 / 特定套餐或地域
  | 'failed' // 实测失败
  | 'unverified'; // 线索，未确认

export interface Verification {
  status: VerificationStatus;
  date?: string;
  source?: string;
  note?: string;
}

export type Lifecycle = 'http' | 'sse' | 'ws' | 'async-task';

export type FeatureCategory =
  | 'text'
  | 'code'
  | 'reasoning'
  | 'tools'
  | 'vision'
  | 'image'
  | 'audio'
  | 'realtime'
  | 'video'
  | 'embedding'
  | 'meta';

export interface FeatureDef {
  id: string;
  name: string;
  category: FeatureCategory;
  summary: string;
  useCases: string[];
  tips?: string[];
}

export interface BaseUrlOption {
  id: string;
  label: string;
  url: string;
  protocol?: 'openai' | 'anthropic' | 'native';
  note?: string;
}

export interface AuthSpec {
  /** bearer: Authorization: Bearer <key>; header: custom header name */
  type: 'bearer' | 'header';
  header?: string;
  /** Extra non-secret connection fields (e.g. GroupId) */
  extraFields?: { key: string; label: string; placeholder?: string; required?: boolean; secret?: boolean }[];
}

export interface Pricing {
  currency: 'CNY' | 'USD';
  /** per 1M tokens */
  input?: number;
  output?: number;
  cacheHit?: number;
  /** free text for media pricing, e.g. "¥0.2/万字符" */
  text?: string;
  source?: string;
  date?: string;
}

export interface ModelDef {
  id: string;
  label?: string;
  developer?: string;
  context?: number;
  modalities?: string[];
  notes?: string;
  pricing?: Pricing;
  deprecated?: boolean;
  verification?: Verification;
}

export interface ProviderDef {
  id: string;
  name: string;
  kind: 'official' | 'aggregator' | 'cloud';
  description: string;
  baseUrls: BaseUrlOption[];
  auth: AuthSpec;
  docsUrl?: string;
  consoleUrl?: string;
  pricingUrl?: string;
  /** relative path returning a model list in OpenAI format (data[].id) */
  modelsPath?: string;
  balance?: { method: 'GET' | 'POST'; path: string; baseUrlOverride?: string };
  models: ModelDef[];
  highlights?: string[];
  notes?: string[];
}

export type ParamType =
  | 'number'
  | 'integer'
  | 'boolean'
  | 'string'
  | 'text'
  | 'enum'
  | 'json'
  | 'string-list';

export interface ParamSpec {
  /** dotted path into the native request body, e.g. "thinking.type" */
  key: string;
  label: string;
  type: ParamType;
  options?: { value: string | number | boolean; label?: string }[];
  min?: number;
  max?: number;
  step?: number;
  default?: unknown;
  /** enabled on first load; disabled params are not sent at all */
  enabledByDefault?: boolean;
  description?: string;
  advanced?: boolean;
  /** non-standard, vendor-specific parameter */
  native?: boolean;
  /** limit to models whose id matches this regex */
  models?: string;
  group?: string;
  verification?: Verification;
}

export type WorkbenchKind =
  | 'chat'
  | 'fim'
  | 'tts'
  | 'image'
  | 'video-task'
  | 'realtime'
  | 'embedding'
  | 'rerank'
  | 'raw';

export type CostTier = 'free' | 'low' | 'medium' | 'high';

/** Values collected by a workbench before native params are applied. */
export interface WorkbenchInput {
  [key: string]: unknown;
}

export interface BuildContext {
  model: string;
  input: WorkbenchInput;
  /** connection extras like GroupId (non-secret) */
  extra: Record<string, string>;
  /** UI param state; only enabled params end up in the request */
  params: Record<string, { enabled: boolean; value: unknown }>;
}

export interface NativeRequest {
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  /** relative to the connection base URL (may contain query string) */
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  bodyType?: 'json' | 'multipart' | 'none';
  /** SSE upstream expected */
  stream?: boolean;
}

export interface ArtifactRef {
  kind: 'audio' | 'image' | 'video' | 'model3d' | 'file' | 'text';
  mime?: string;
  /** one of the following */
  url?: string;
  base64?: string;
  hex?: string;
  filename?: string;
  label?: string;
}

export interface AsyncSpec {
  /** JSON path in create response for the remote task id */
  idPath: string;
  poll: { method: 'GET' | 'POST'; path: string; body?: unknown };
  /** JSON path in poll response for status string */
  statusPath: string;
  statusMap: Record<string, 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled'>;
  intervalMs?: number;
  /** extract results from a succeeded poll response */
  results: (poll: any) => ArtifactRef[];
  /** some vendors need an extra call to resolve file ids into URLs */
  resolve?: (poll: any, extra: Record<string, string>) => NativeRequest | null;
  resolveResults?: (resolved: any) => ArtifactRef[];
  progressPath?: string;
  errorPath?: string;
  cancel?: { method: 'POST' | 'DELETE'; path: string };
}

export interface OperationDef {
  id: string;
  providerId: string;
  title: string;
  summary?: string;
  features: string[];
  workbench: WorkbenchKind;
  lifecycle: Lifecycle;
  /** base URL ids this operation works with (default: first) */
  baseUrlIds?: string[];
  /** model ids applicable; omit = all provider models; [] = no model field */
  models?: string[];
  defaultModel?: string;
  /** allow typing an arbitrary model id */
  freeModel?: boolean;
  params: ParamSpec[];
  build: (ctx: BuildContext) => NativeRequest;
  /** how the UI should interpret responses */
  stream?: 'openai-chat' | 'openai-completion' | 'minimax-t2a' | 'none';
  /** artifacts in a synchronous response */
  artifacts?: (response: any) => ArtifactRef[];
  async?: AsyncSpec;
  costTier: CostTier;
  costHint?: string;
  verification: Verification;
  notes?: string[];
  docsUrl?: string;
  /** realtime/ws operations */
  ws?: { path: string; protocol?: 'openai-realtime' | 'stepfun-realtime' | 'qwen-omni-realtime' | 'raw' };
}

export interface PresetDef {
  id: string;
  operationId: string;
  title: string;
  description: string;
  model?: string;
  input: WorkbenchInput;
  params?: Record<string, unknown>;
  tags?: string[];
}

// ---- runtime records (server <-> web) ----

export interface ConnectionInfo {
  id: string;
  providerId: string;
  label: string;
  baseUrl: string;
  extra: Record<string, string>;
  keyPreview: string;
  createdAt: string;
  lastTest?: { ok: boolean; at: string; message: string };
}

export interface TraceEvent {
  /** ms since run start */
  t: number;
  type:
    | 'request'
    | 'response-head'
    | 'chunk'
    | 'body'
    | 'artifact'
    | 'ws-send'
    | 'ws-recv'
    | 'task-poll'
    | 'error'
    | 'info'
    | 'done';
  data: any;
}

export interface RunMetrics {
  ttfbMs?: number;
  firstTokenMs?: number;
  totalMs?: number;
  chunks?: number;
  usage?: Record<string, unknown>;
  bytes?: number;
}

export interface RunRecord {
  id: string;
  createdAt: string;
  providerId: string;
  connectionId: string;
  operationId: string | null;
  model: string | null;
  title: string;
  lifecycle: Lifecycle;
  status: 'running' | 'ok' | 'error' | 'cancelled';
  httpStatus?: number | null;
  input?: any;
  request?: any;
  response?: any;
  events?: TraceEvent[];
  metrics?: RunMetrics;
  artifacts?: AssetInfo[];
  error?: any;
  notes?: string;
  starred?: boolean;
  parentId?: string | null;
  taskId?: string | null;
}

export interface AssetInfo {
  id: string;
  kind: string;
  mime: string;
  filename: string;
  size: number;
  url: string;
  createdAt: string;
  runId?: string | null;
  remoteUrl?: string | null;
}

export interface TaskRecord {
  id: string;
  runId: string;
  connectionId: string;
  operationId: string;
  remoteId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'unknown';
  remoteStatus?: string;
  progress?: number | null;
  pollCount: number;
  lastPollAt?: string | null;
  createdAt: string;
  updatedAt: string;
  error?: string | null;
  artifacts?: AssetInfo[];
  title?: string;
}
