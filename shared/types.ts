// Isomorphic definitions shared by the local server and the web UI.
// Operation definitions live in shared code so that the server builds the exact
// request the UI previews, and both sides interpret responses with the same reducers.

export type VerificationStatus =
  | 'tested' // 本项目用真实 Key 调用成功，特性表现符合文档
  | 'partial' // 实测部分可用，或与文档描述不一致
  | 'documented' // 官方文档声称支持，尚未实测
  | 'restricted' // 需要白名单 / 单独开通 / 特定套餐或地域
  | 'failed' // 实测失败或已停服
  | 'unverified'; // 线索，尚未确认

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
  | '3d'
  | 'embedding'
  | 'meta';

export interface FeatureDef {
  id: string;
  name: string;
  category: FeatureCategory;
  summary: string;
  useCases: string[];
  tips?: string[];
  /** how to compare implementations fairly, shown on the feature page */
  compareNotes?: string;
}

export interface BaseUrlOption {
  id: string;
  label: string;
  url: string;
  note?: string;
}

export interface ExtraField {
  key: string;
  label: string;
  placeholder?: string;
  required?: boolean;
  /** stored in secrets.json and redacted like the API key */
  secret?: boolean;
}

export interface AuthSpec {
  /**
   * bearer: Authorization: Bearer <key>
   * header: <header>: <prefix><key>
   * query: ?<query>=<key>
   * signer: request is signed server-side by a named signer (JWT, HMAC …)
   */
  type: 'bearer' | 'header' | 'query' | 'signer' | 'none';
  header?: string;
  prefix?: string;
  query?: string;
  signer?: string;
  /** label for the main secret input, e.g. "AccessKey" */
  keyLabel?: string;
  /** non-secret headers every request needs (e.g. anthropic-version) */
  staticHeaders?: Record<string, string>;
  extraFields?: ExtraField[];
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
  /** who built the model (may differ from the API provider) */
  developer?: string;
  context?: number;
  /** e.g. text-in, image-in, audio-out */
  modalities?: string[];
  /** feature ids this model is known to support (drives hints, not hard limits) */
  capabilities?: string[];
  notes?: string;
  pricing?: Pricing;
  deprecated?: boolean;
  verification?: Verification;
}

export interface ProviderDef {
  id: string;
  name: string;
  kind: 'official' | 'aggregator' | 'cloud' | 'generic';
  /** market the service mainly targets; informational */
  region?: 'cn' | 'global';
  description: string;
  baseUrls: BaseUrlOption[];
  auth: AuthSpec;
  docsUrl?: string;
  consoleUrl?: string;
  pricingUrl?: string;
  /** relative path returning a model list (OpenAI-style data[].id unless modelsParse says otherwise) */
  modelsPath?: string;
  balance?: { method: 'GET' | 'POST'; path: string; baseUrlOverride?: string };
  /** env var names that commonly hold this provider's key */
  keyEnv?: string[];
  models: ModelDef[];
  highlights?: string[];
  notes?: string[];
  /** generic providers have no fixed host; the connection supplies the base URL */
  generic?: boolean;
}

export type ParamType = 'number' | 'integer' | 'boolean' | 'string' | 'text' | 'enum' | 'json' | 'string-list';

export interface ParamSpec {
  /** dotted path into the native request body (or header / query name) */
  key: string;
  label: string;
  type: ParamType;
  /** where the value goes; default body */
  in?: 'body' | 'header' | 'query';
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
  'chat' | 'fim' | 'tts' | 'asr' | 'image' | 'video' | 'realtime' | 'embedding' | 'rerank' | 'model3d' | 'raw';

export type CostTier = 'free' | 'low' | 'medium' | 'high';

export type InputField =
  | 'prompt'
  | 'negative'
  | 'images'
  | 'firstFrame'
  | 'lastFrame'
  | 'references'
  | 'audio'
  | 'video'
  | 'mask'
  | 'voicePrompt';

/** Values collected by a workbench before native params are applied. */
export interface WorkbenchInput {
  [key: string]: unknown;
}

export interface BuildContext {
  model: string;
  input: WorkbenchInput;
  /** connection extras like GroupId (non-secret ones on the client; all on the server) */
  extra: Record<string, string>;
  /** UI param state; only enabled params end up in the request */
  params: Record<string, { enabled: boolean; value: unknown }>;
}

export interface NativeRequest {
  method: 'GET' | 'POST' | 'DELETE' | 'PUT' | 'PATCH';
  /** relative to the connection base URL (may contain query string), or an absolute same-host URL */
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
  /** remote result URLs expire; shown to the user */
  resultTtlNote?: string;
}

/** Realtime (WebSocket) operations. The browser speaks the vendor protocol through a local relay. */
export interface RealtimeSpec {
  /** URL template relative to the connection host, e.g. "/api-ws/v1/realtime?model={model}" */
  path: string;
  /** absolute ws(s) URL template when the realtime host differs from the REST base URL */
  url?: string;
  /** event dialect understood by the realtime workbench */
  protocol: 'openai-realtime';
  /** PCM16 sample rates */
  inputRate: number;
  outputRate: number;
  /** extra session fields merged into session.update */
  session?: (ctx: BuildContext) => Record<string, unknown>;
  /** auth placement for the upgrade request (default: same as REST) */
  auth?: 'header' | 'query';
  notes?: string[];
}

export interface CostEstimate {
  amount: number;
  currency: 'CNY' | 'USD';
  /** how the number was derived, shown next to it */
  basis: string;
}

export interface Insight {
  level: 'ok' | 'info' | 'warn';
  text: string;
}

export type ProtocolId =
  | 'openai-chat'
  | 'openai-completion'
  | 'openai-responses'
  | 'anthropic-messages'
  | 'gemini-generate'
  | 'minimax-t2a'
  | 'json';

export interface InsightContext {
  request: NativeRequest | undefined;
  view: any;
  input: WorkbenchInput;
  model: string;
}

export interface OperationDef {
  id: string;
  providerId: string;
  title: string;
  summary?: string;
  features: string[];
  workbench: WorkbenchKind;
  lifecycle: Lifecycle;
  /** base URL ids this operation works with (default: all) */
  baseUrlIds?: string[];
  /** model ids applicable; omit = all provider models; [] = no model field */
  models?: string[];
  defaultModel?: string;
  /** allow typing an arbitrary model id */
  freeModel?: boolean;
  params: ParamSpec[];
  /** workbench input fields this operation uses (media workbenches); default = all fields of the workbench */
  inputFields?: InputField[];
  /** per-field hints, e.g. size limits */
  inputHints?: Partial<Record<InputField, string>>;
  build: (ctx: BuildContext) => NativeRequest;
  /** how responses / stream events are reduced into a view */
  protocol?: ProtocolId;
  /** artifacts in a synchronous response */
  artifacts?: (response: any) => ArtifactRef[];
  /** artifacts assembled from a streamed response (receives the reduced view of untruncated chunks) */
  streamArtifacts?: (view: any) => ArtifactRef[];
  async?: AsyncSpec;
  realtime?: RealtimeSpec;
  /** vendor-specific observations: did a parameter take effect, cache hits … */
  insights?: (ctx: InsightContext) => Insight[];
  estimateCost?: (ctx: {
    model: string;
    usage?: any;
    input: WorkbenchInput;
    request?: NativeRequest;
  }) => CostEstimate | undefined;
  costTier: CostTier;
  costHint?: string;
  verification: Verification;
  notes?: string[];
  docsUrl?: string;
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

export type NetworkMode = 'auto' | 'direct' | 'proxy';

export interface ConnectionInfo {
  id: string;
  /** Changes when endpoint, route or credentials change; does not expose credential data. */
  revision?: number;
  providerId: string;
  label: string;
  baseUrl: string;
  extra: Record<string, string>;
  keyPreview: string;
  network: NetworkMode;
  createdAt: string;
  lastTest?: { ok: boolean | null; at: string; message: string; verified?: boolean };
}

export interface ConnectionImportResult {
  applied: boolean;
  sections: number;
  credentials: number;
  created: number;
  reused: number;
  warnings: string[];
  entries: {
    sourceTitle: string;
    sourceStatus: string;
    keyField: string;
    label: string;
    providerId: string;
    baseUrl: string;
    keyPreview: string;
    existing: boolean;
    connectionId?: string;
    protocol: string;
    modelHint: string;
    notes: string;
  }[];
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
  cost?: CostEstimate;
}

/** Everything needed to put a run back into the lab. */
export interface LabState {
  connectionId: string;
  operationId: string;
  model: string;
  input: WorkbenchInput;
  params: Record<string, { enabled: boolean; value: unknown }>;
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
  state?: LabState | null;
  summary?: string | null;
  groupId?: string | null;
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
  source?: 'upload' | 'artifact';
  referenceCount?: number;
  runReferences?: { id: string; title: string }[];
  presetReferences?: { id: string; title: string }[];
}

export interface AssetLibraryResponse {
  items: AssetInfo[];
  total: number;
  totalBytes: number;
  unusedCount: number;
  unusedBytes: number;
  offset: number;
  limit: number;
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
  nextPollAt?: string | null;
  retryCount?: number;
  createdAt: string;
  updatedAt: string;
  error?: string | null;
  artifacts?: AssetInfo[];
  title?: string;
}

/** Aggregated local evidence: how this op/model behaved on this machine's accounts. */
export interface EvidenceRow {
  operationId: string;
  model: string | null;
  ok: number;
  error: number;
  lastOkAt?: string | null;
  lastErrorAt?: string | null;
  lastRunId?: string | null;
  lastError?: string | null;
}
