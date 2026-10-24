import type { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { spawn, execFile, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { promisify } from 'node:util';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db, now, pagination } from './db.ts';
import { getConnection, applyAuth, buildUrl } from './connections.ts';
import { getProvider, listOperations } from '../shared/catalog.ts';
import { describeRoute, resolveRoute } from './net.ts';
import { redactText, redactValue, getSecret } from './secrets.ts';
import type { BenchConfig, BenchRecord, BenchRuntime, BenchStage, BenchStatus } from '../shared/bench.ts';
import { benchLimits } from '../shared/bench.ts';

const ROOT = fileURLToPath(new URL('../integrations/llm-bench/', import.meta.url));
const BRIDGE = join(ROOT, 'bridge.py');
const runFile = promisify(execFile);
const ACTIVE = new Set<BenchStatus>(['starting', 'running', 'cancelling']);
const live = new Map<
  string,
  {
    child: ChildProcessWithoutNullStreams;
    record: BenchRecord;
    secrets: string[];
    timer: NodeJS.Timeout;
    killTimer?: NodeJS.Timeout;
  }
>();
let runtimeCache: { at: number; value: BenchRuntime; command?: string; args?: string[] } | undefined;

db.exec(`CREATE TABLE IF NOT EXISTS benchmark_runs (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  record_json TEXT NOT NULL
); CREATE INDEX IF NOT EXISTS benchmark_created ON benchmark_runs(created_at DESC);`);

function cleanEnv() {
  return {
    ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !/api.?key|secret|token|password/i.test(k))),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONDONTWRITEBYTECODE: '1',
  };
}

export async function benchRuntime(): Promise<BenchRuntime> {
  if (runtimeCache && Date.now() - runtimeCache.at < 30_000) return runtimeCache.value;
  const local = join(ROOT, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const candidates = process.env.LLM_BENCH_PYTHON
    ? [{ command: process.env.LLM_BENCH_PYTHON, args: [] }]
    : [
        ...(existsSync(local) ? [{ command: local, args: [] }] : []),
        { command: 'python', args: [] },
        ...(process.platform === 'win32' ? [{ command: 'py', args: ['-3'] }] : [{ command: 'python3', args: [] }]),
      ];
  for (const candidate of candidates) {
    try {
      const result = await runFile(candidate.command, [...candidate.args, BRIDGE, '--probe'], {
        timeout: 10_000,
        windowsHide: true,
        env: cleanEnv(),
        maxBuffer: 64 * 1024,
      });
      const data = JSON.parse(result.stdout.trim());
      if (data.available) {
        const value: BenchRuntime = { available: true, engine: 'llm-bench', version: data.version };
        runtimeCache = { at: Date.now(), value, ...candidate };
        return value;
      }
    } catch {
      /* try the next installed interpreter; never install during a paid run */
    }
  }
  const value: BenchRuntime = {
    available: false,
    engine: 'llm-bench',
    error: '未找到 Python 3.11+ 与 httpx[http2]。请按 integrations/llm-bench/README.md 安装本地无界面运行环境。',
  };
  runtimeCache = { at: Date.now(), value };
  return value;
}

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
function mergeBody(base: Record<string, unknown>, extra: Record<string, unknown>): Record<string, unknown> {
  for (const [key, value] of Object.entries(extra)) {
    if (['__proto__', 'prototype', 'constructor'].includes(key)) throw new Error('请求体包含保留字段');
    if (object(value)) base[key] = mergeBody(object(base[key]) ? base[key] : {}, value);
    else if (Array.isArray(value)) base[key] = value.map((item) => (object(item) ? mergeBody({}, item) : item));
    else base[key] = value;
  }
  return base;
}
function number(v: unknown, fallback: number, min: number, max: number, name: string, integer = true): number {
  const n = v === undefined ? fallback : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n)))
    throw new Error(`${name} 必须为 ${min}–${max} 范围内的${integer ? '整数' : '数值'}`);
  return n;
}
function bool(v: unknown, fallback = false): boolean {
  if (v === undefined) return fallback;
  if (typeof v !== 'boolean') throw new Error('布尔参数必须为 true 或 false');
  return v;
}

export function validateBenchConfig(value: unknown): BenchConfig {
  if (!object(value)) throw new Error('压测配置必须为 JSON 对象');
  const v = value;
  if (v.confirmedCost !== true) throw new Error('压测会多次调用并可能计费，请明确确认费用后开始');
  if (typeof v.connectionId !== 'string' || !v.connectionId || v.connectionId.length > 100)
    throw new Error('请选择连接');
  if (typeof v.model !== 'string' || !v.model.trim() || v.model.length > 256) throw new Error('请填写模型');
  if (!['total', 'duration', 'rps', 'sweep'].includes(String(v.mode))) throw new Error('不支持的压测模式');
  if (v.endpoint !== undefined && !['chat', 'responses'].includes(String(v.endpoint)))
    throw new Error('不支持的接口协议');
  if (
    v.path !== undefined &&
    v.path !== '' &&
    (typeof v.path !== 'string' ||
      v.path.length > 2000 ||
      !v.path.startsWith('/') ||
      v.path.startsWith('//') ||
      /[\\\r\n#]/.test(v.path))
  )
    throw new Error('自定义路径必须为同一连接内的绝对路径');
  if (v.path) {
    const p = new URL(String(v.path), 'https://placeholder.invalid');
    if (
      p.origin !== 'https://placeholder.invalid' ||
      [...p.searchParams.keys()].some((k) => /key|token|secret|signature|password/i.test(k))
    )
      throw new Error('路径不得携带凭据，请使用连接中保存的鉴权');
  }
  const cfg: BenchConfig = {
    connectionId: v.connectionId,
    model: v.model.trim(),
    endpoint: (v.endpoint ?? 'chat') as 'chat' | 'responses',
    path: v.path ? (v.path as string) : undefined,
    mode: v.mode as BenchConfig['mode'],
    concurrency: number(v.concurrency, 2, 1, 64, '并发'),
    totalRequests: number(v.totalRequests, 20, 1, 10000, '请求数'),
    durationSeconds: number(v.durationSeconds, 10, 0.1, 600, '运行秒数', false),
    targetRps: number(v.targetRps, 1, 0.01, 100, '目标 RPS', false),
    warmup: number(v.warmup, 0, 0, 100, '预热数'),
    retries429: number(v.retries429, 0, 0, 3, '429 重试'),
    retriesNetwork: number(v.retriesNetwork, 0, 0, 3, '网络重试'),
    retries5xx: number(v.retries5xx, 0, 0, 3, '5xx 重试'),
    timeoutSeconds: number(v.timeoutSeconds, 60, 0.1, 300, '单次超时', false),
    maxTokens: number(v.maxTokens, 128, 1, 32768, '最大输出 Token'),
    temperature: number(v.temperature, 0.2, 0, 2, 'Temperature', false),
    stream: bool(v.stream),
    http2: bool(v.http2),
    confirmedCost: true,
    promptStrategy: (v.promptStrategy ?? 'sequential') as BenchConfig['promptStrategy'],
  };
  if (v.clientRequestId !== undefined) {
    if (typeof v.clientRequestId !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(v.clientRequestId))
      throw new Error('启动标识无效，请重新审核配置');
    cfg.clientRequestId = v.clientRequestId;
  }
  if (!['sequential', 'random', 'weighted'].includes(cfg.promptStrategy!)) throw new Error('不支持的提示词轮换策略');
  if (
    v.prompts !== undefined &&
    (!Array.isArray(v.prompts) ||
      (!v.prompts.length && !v.customBody) ||
      v.prompts.length > 100 ||
      v.prompts.some((p) => typeof p !== 'string' || !p.trim() || p.length > 32000))
  )
    throw new Error('提示词需要 1–100 条，每条不超过 32000 字符；自定义请求体可留空');
  cfg.prompts = (v.prompts ?? (v.customBody ? [] : ['请用一句话介绍你自己。'])) as string[];
  if (v.promptWeights !== undefined) {
    if (
      !Array.isArray(v.promptWeights) ||
      v.promptWeights.length !== cfg.prompts.length ||
      v.promptWeights.some((w) => typeof w !== 'number' || !Number.isFinite(w) || w <= 0 || w > 10000)
    )
      throw new Error('权重必须与提示词一一对应且大于 0');
    cfg.promptWeights = v.promptWeights;
  }
  if (cfg.promptStrategy === 'weighted' && !cfg.promptWeights) throw new Error('加权轮换需要提供提示词权重');
  if (cfg.mode === 'sweep') {
    if (!Array.isArray(v.sweepConcurrency) || !v.sweepConcurrency.length || v.sweepConcurrency.length > 8)
      throw new Error('并发阶梯需要 1–8 个档位');
    cfg.sweepConcurrency = [...new Set(v.sweepConcurrency.map((n) => number(n, 1, 1, 64, '阶梯并发')))];
  }
  for (const key of ['customBody', 'extraBody'] as const) {
    if (v[key] !== undefined) {
      if (!object(v[key]) || JSON.stringify(v[key]).length > 64000)
        throw new Error('自定义请求体必须为不超过 64 KB 的 JSON 对象');
      cfg[key] = mergeBody({}, JSON.parse(JSON.stringify(v[key])));
    }
  }
  const stages = cfg.sweepConcurrency?.length ?? 1;
  const count = cfg.mode === 'total' || cfg.mode === 'sweep' ? cfg.totalRequests! * stages : 0;
  const factor = 1 + cfg.retries429! + cfg.retriesNetwork! + cfg.retries5xx!;
  if (count > 10000 || (count + cfg.warmup! * stages) * factor > 20000)
    throw new Error('本轮总量超过 10000 个逻辑请求或 20000 次 HTTP 尝试上限，请降低请求数、重试或阶梯数');
  if (cfg.mode === 'rps' && cfg.targetRps! * cfg.durationSeconds! > 10000) throw new Error('RPS × 秒数不能超过 10000');
  return cfg;
}

export function allowedBenchAddress(address: string): boolean {
  let a = address.toLowerCase().split('%')[0];
  if (isIP(a) === 6) a = new URL(`http://[${a}]`).hostname.slice(1, -1);
  if (a.startsWith('::ffff:')) {
    const tail = a.slice(7);
    if (tail.includes('.')) a = tail;
    else {
      const pair = tail.split(':');
      if (pair.length === 2) {
        const n = parseInt(pair[0], 16) * 65536 + parseInt(pair[1], 16);
        a = `${n >>> 24}.${(n >>> 16) & 255}.${(n >>> 8) & 255}.${n & 255}`;
      }
    }
  }
  if (isIP(a) === 4) {
    const p = a.split('.').map(Number);
    return p[0] !== 0 && p[0] < 224 && !(p[0] === 169 && p[1] === 254) && a !== '100.100.100.200';
  }
  return isIP(a) === 6 && a !== '::' && !/^fe[89ab]/.test(a) && !a.startsWith('ff') && a !== 'fd00:ec2::254';
}

function persist(record: BenchRecord, secrets: string[] = []) {
  record.updatedAt = now();
  const safe = redactValue(record, secrets);
  db.prepare(
    `INSERT INTO benchmark_runs(id,status,created_at,updated_at,record_json) VALUES(?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at,record_json=excluded.record_json`,
  ).run(record.id, record.status, record.createdAt, record.updatedAt, JSON.stringify(safe));
}
export function getBenchmark(id: string): BenchRecord | undefined {
  const row = db.prepare('SELECT record_json FROM benchmark_runs WHERE id=?').get(id) as
    { record_json: string } | undefined;
  return row ? redactValue(JSON.parse(row.record_json)) : undefined;
}

export function recoverInterruptedBenchmarks() {
  for (const row of db
    .prepare("SELECT record_json FROM benchmark_runs WHERE status IN ('starting','running','cancelling')")
    .all() as { record_json: string }[]) {
    const record = JSON.parse(row.record_json) as BenchRecord;
    if (live.has(record.id)) continue;
    record.status = 'interrupted';
    record.error = '服务已重启，压测已中断；已保留进度和已完成阶段，不会自动重发计费请求。';
    persist(record);
  }
}

export async function startBenchmark(input: unknown): Promise<BenchRecord> {
  const cfg = validateBenchConfig(input);
  if (cfg.clientRequestId) {
    const prior = db
      .prepare(
        "SELECT record_json FROM benchmark_runs WHERE json_extract(record_json, '$.config.clientRequestId')=? AND status<>'imported' LIMIT 1",
      )
      .get(cfg.clientRequestId) as { record_json: string } | undefined;
    if (prior) return redactValue(JSON.parse(prior.record_json));
  }
  if (live.size >= 1) throw new Error('已有压测正在运行，请完成或停止后再开始');
  const connection = getConnection(cfg.connectionId);
  if (!connection) throw new Error('连接不存在');
  if (getProvider(connection.providerId)?.auth.type === 'signer')
    throw new Error('此连接需要逐次签名，压测当前支持 Bearer、Header、Query 与免密鉴权；请选用兼容连接');
  const suffix = cfg.endpoint === 'responses' ? '/responses' : '/chat/completions';
  const nativeChat = listOperations(connection.providerId).find((op) => op.protocol === 'openai-chat');
  const nativePath =
    cfg.endpoint !== 'responses' && nativeChat
      ? nativeChat.build({
          model: cfg.model,
          input: { messages: [{ role: 'user', content: cfg.prompts![0] ?? '' }], stream: cfg.stream },
          extra: connection.extra,
          params: {},
        }).path
      : cfg.endpoint === 'responses' && connection.providerId === 'openai'
        ? '/v1/responses'
        : suffix;
  const url =
    !cfg.path && new URL(connection.baseUrl).pathname.replace(/\/$/, '').endsWith(suffix)
      ? connection.baseUrl.replace(/\/$/, '')
      : buildUrl(connection.baseUrl, cfg.path || nativePath, connection.providerId);
  const target = new URL(url);
  // Preserve the actual native route for exact replay, including an inferred /v1 prefix.
  cfg.path = target.pathname + target.search;
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
    throw new Error('压测仅支持 HTTP(S) 无内嵌凭据的地址');
  const host = target.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true })).map((a) => a.address);
  if (!addresses.length || addresses.some((a) => !allowedBenchAddress(a)))
    throw new Error('拒绝云元数据、链路本地、组播或未指定的目标地址');
  const body: Record<string, unknown> = cfg.customBody
    ? structuredClone(cfg.customBody)
    : cfg.endpoint === 'responses'
      ? { model: cfg.model, input: cfg.prompts![0], max_output_tokens: cfg.maxTokens, temperature: cfg.temperature }
      : {
          model: cfg.model,
          messages: [{ role: 'user', content: cfg.prompts![0] }],
          max_tokens: cfg.maxTokens,
          temperature: cfg.temperature,
        };
  mergeBody(body, cfg.extraBody ?? {});
  body.model = cfg.model;
  body.stream = cfg.stream;
  const tokenFields = ['max_output_tokens', 'max_completion_tokens', 'max_tokens'];
  const explicitField = tokenFields.find(
    (field) => Object.hasOwn(cfg.extraBody ?? {}, field) || Object.hasOwn(cfg.customBody ?? {}, field),
  );
  const tokenField =
    cfg.endpoint === 'responses'
      ? 'max_output_tokens'
      : explicitField === 'max_completion_tokens' || nativeChat?.params.some((p) => p.key === 'max_completion_tokens')
        ? 'max_completion_tokens'
        : 'max_tokens';
  for (const field of tokenFields) if (field !== tokenField) delete body[field];
  body[tokenField] = cfg.maxTokens;
  if (cfg.stream && cfg.endpoint !== 'responses')
    body.stream_options = { ...(object(body.stream_options) ? body.stream_options : {}), include_usage: true };
  if (JSON.stringify(body).length > 128 * 1024) throw new Error('合并后的请求体不能超过 128 KB');
  const auth = applyAuth(connection, url, { method: 'POST', body: JSON.stringify(body) });
  const route = resolveRoute(auth.url, connection.network);
  const secret = getSecret(connection.id);
  const secrets = [
    secret?.key ?? '',
    ...Object.values(secret?.extra ?? {}),
    route.proxy ?? '',
    ...Object.values(auth.headers),
  ].filter(Boolean);
  const runtime = await benchRuntime();
  if (!runtime.available || !runtimeCache?.command) throw new Error(runtime.error || '压测运行环境不可用');
  // The awaits above permit interleaving starts. Reserve the slot only after all prerequisites pass.
  // A second start can have finished its prerequisite awaits while the first start
  // completed; preserve idempotency even across that interleaving.
  if (cfg.clientRequestId) {
    const prior = db
      .prepare(
        "SELECT record_json FROM benchmark_runs WHERE json_extract(record_json, '$.config.clientRequestId')=? AND status<>'imported' LIMIT 1",
      )
      .get(cfg.clientRequestId) as { record_json: string } | undefined;
    if (prior) return redactValue(JSON.parse(prior.record_json));
  }
  if (live.size >= 1) throw new Error('已有压测正在运行，请完成或停止后再开始');
  const id = randomUUID();
  const limits = benchLimits(cfg);
  const record: BenchRecord = {
    id,
    status: 'starting',
    createdAt: now(),
    updatedAt: now(),
    config: redactValue(cfg, secrets),
    connectionLabel: connection.label,
    connectionSnapshot: redactValue(
      {
        providerId: connection.providerId,
        label: connection.label,
        baseUrl: connection.baseUrl,
        url,
        network: connection.network,
        route: describeRoute(route),
      },
      secrets,
    ),
    limits,
    stages: [],
    source: 'usermbzlj/llm-bench@480148e3',
  };
  persist(record, secrets);
  const child = spawn(runtimeCache.command, [...(runtimeCache.args ?? []), BRIDGE], {
    cwd: ROOT,
    windowsHide: true,
    env: cleanEnv(),
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const stages = cfg.mode === 'sweep' ? cfg.sweepConcurrency! : [cfg.concurrency!];
  const maxMs = limits.maxRuntimeSeconds * 1000;
  const timer = setTimeout(() => cancelBenchmark(id, '已达到压测最长运行时间，自动停止'), maxMs);
  timer.unref();
  const entry = { child, record, secrets, timer };
  live.set(id, entry);
  let buffer = '';
  let stderr = '';
  let finished = false;
  const finish = (status: BenchStatus, error?: string) => {
    if (finished) return;
    finished = true;
    clearTimeout(entry.timer);
    const current = live.get(id);
    if (current?.killTimer) clearTimeout(current.killTimer);
    record.status = status;
    if (error) record.error = redactText(error, secrets);
    persist(record, secrets);
    live.delete(id);
    child.stdin.end();
  };
  child.on('error', (e) => finish('failed', e.message));
  child.on('close', (code) => {
    if (!finished)
      finish(record.status === 'cancelling' ? 'cancelled' : 'failed', stderr || `压测进程意外退出（${code}）`);
  });
  child.stderr.on('data', (chunk) => {
    stderr = redactText((stderr + chunk.toString('utf8')).slice(-4000), secrets);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    if (Buffer.byteLength(buffer) > 24 * 1024 * 1024) {
      child.kill();
      finish('failed', '压测输出超过 24 MB 安全上限');
      return;
    }
    let at: number;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      try {
        const event = redactValue(JSON.parse(line), secrets);
        if (event.type === 'progress') {
          record.progress = event.progress;
          if (record.status !== 'cancelling') record.status = 'running';
          persist(record, secrets);
        } else if (event.type === 'stage') {
          record.stages.push(event.stage as BenchStage);
          persist(record, secrets);
        } else if (event.type === 'done')
          finish(
            event.cancelled || record.status === 'cancelling' ? 'cancelled' : 'completed',
            event.budgetReached ? '已达到本轮请求或 HTTP 尝试上限，已保存结果。' : undefined,
          );
        else if (event.type === 'error') {
          child.kill();
          finish('failed', String(event.error));
        }
      } catch {
        child.kill();
        finish('failed', '压测进程输出格式异常');
      }
    }
  });
  child.stdin.on('error', () => {
    /* close/error handlers preserve the final state */
  });
  child.stdin.write(
    `${JSON.stringify({
      config: cfg,
      url: auth.url,
      headers: { 'Content-Type': 'application/json', ...auth.headers },
      body,
      addresses,
      proxy: route.proxy,
      concurrencies: stages,
      maxRequests: limits.maxRequests,
      maxAttempts: limits.maxAttempts,
    })}\n`,
  );
  return redactValue(record, secrets);
}

export function cancelBenchmark(id: string, reason?: string): BenchRecord | undefined {
  const entry = live.get(id);
  if (!entry) return getBenchmark(id);
  entry.record.status = 'cancelling';
  if (reason) entry.record.error = reason;
  persist(entry.record, entry.secrets);
  entry.child.stdin.write('cancel\n');
  if (!entry.killTimer) {
    entry.killTimer = setTimeout(() => entry.child.kill(), 3000);
    entry.killTimer.unref();
  }
  return redactValue(entry.record, entry.secrets);
}

/** Root server calls this before shutdown; child EOF is a second orphan safeguard. */
export function shutdownBenchmarks() {
  for (const [id, entry] of live) {
    cancelBenchmark(id, '服务正在关闭，压测已停止');
    entry.child.kill();
  }
}

function csvCell(value: unknown): string {
  let s = value == null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[\s]*[=+\-@]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}
export function benchmarkCsv(record: BenchRecord): string {
  const fields = [
    'stage',
    'concurrency',
    'ok',
    'status_code',
    'latency_ms',
    'final_attempt_latency_ms',
    'ttft_ms',
    'ttfb_ms',
    'tpot_ms',
    'tokens_per_sec',
    'attempt_count',
    'retry_sleep_ms',
    'prompt_tokens',
    'completion_tokens',
    'total_tokens',
    'response_text',
    'error_kind',
    'error',
  ];
  const lines = [fields.join(',')];
  record.stages.forEach((stage, index) =>
    stage.results.forEach((row) => {
      const values = { ...row, stage: index + 1, concurrency: stage.concurrency };
      lines.push(fields.map((f) => csvCell(values[f as keyof typeof values])).join(','));
    }),
  );
  return '\uFEFF' + lines.join('\r\n');
}

function importedStats(v: unknown) {
  return (
    object(v) &&
    ['requests_total', 'requests_success', 'requests_failed', 'wall_seconds'].every(
      (k) => typeof v[k] === 'number' && Number.isFinite(v[k]) && Number(v[k]) >= 0,
    ) &&
    Number(v.requests_success) + Number(v.requests_failed) === Number(v.requests_total)
  );
}
export function importBenchmark(value: unknown): BenchRecord {
  if (!object(value) || JSON.stringify(value).length > 20 * 1024 * 1024)
    throw new Error('导入 JSON 对象不能超过 20 MB');
  let stages: BenchStage[];
  if (Array.isArray(value.stages) && value.stages.length <= 8 && value.stages.length > 0) {
    if (
      value.stages.some(
        (s) =>
          !object(s) ||
          !importedStats(s.stats) ||
          !Array.isArray(s.results) ||
          s.results.length > 10000 ||
          !s.results.every(object),
      )
    )
      throw new Error('压测报告的阶段、统计或逐请求记录格式无效');
    stages = value.stages.map((s) => ({
      concurrency: number(s.concurrency, 1, 1, 100000, '报告并发'),
      stats: s.stats,
      results: s.results,
    }));
  } else {
    const stats = importedStats(value.stats) ? value.stats : importedStats(value.summary) ? value.summary : value;
    if (!importedStats(stats))
      throw new Error('不支持的报告：需要 llm-bench requests_total/success/failed/wall_seconds 统计');
    const results = Array.isArray(value.results)
      ? value.results
      : Array.isArray(value.raw_results)
        ? value.raw_results
        : [];
    if (results.length > 10000 || !results.every(object)) throw new Error('逐请求结果格式无效');
    stages = [{ concurrency: 1, stats: stats as any, results }];
  }
  const config = object(value.config) ? redactValue(value.config) : {};
  const originalDate =
    typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt))
      ? new Date(value.createdAt).toISOString()
      : now();
  const snapshotFields = ['providerId', 'label', 'baseUrl', 'url', 'network', 'route'] as const;
  const rawSnapshot = object(value.connectionSnapshot) ? value.connectionSnapshot : undefined;
  const snapshot =
    rawSnapshot && snapshotFields.every((field) => typeof rawSnapshot[field] === 'string')
      ? (Object.fromEntries(
          snapshotFields.map((field) => [field, String(rawSnapshot[field]).slice(0, 4000)]),
        ) as unknown as BenchRecord['connectionSnapshot'])
      : undefined;
  const limitFields = ['stages', 'warmupRequests', 'maxRequests', 'maxAttempts', 'maxRuntimeSeconds'] as const;
  const rawLimits = object(value.limits) ? value.limits : undefined;
  const importedLimits =
    rawLimits &&
    limitFields.every(
      (field) =>
        typeof rawLimits[field] === 'number' && Number.isFinite(rawLimits[field]) && Number(rawLimits[field]) >= 0,
    ) &&
    (rawLimits.estimatedRequests === null ||
      (typeof rawLimits.estimatedRequests === 'number' &&
        Number.isFinite(rawLimits.estimatedRequests) &&
        rawLimits.estimatedRequests >= 0))
      ? (rawLimits as unknown as BenchRecord['limits'])
      : undefined;
  // Imported reports are inert evidence: no connection binding, credential import or execution.
  const record: BenchRecord = {
    id: randomUUID(),
    status: 'imported',
    createdAt: originalDate,
    updatedAt: now(),
    importedAt: now(),
    config: {
      ...config,
      connectionId: '',
      model: typeof config.model === 'string' ? config.model.slice(0, 256) : '导入报告',
      mode: ['total', 'duration', 'rps', 'sweep'].includes(String(config.mode)) ? config.mode : 'total',
    } as BenchConfig,
    stages: redactValue(stages),
    connectionLabel: typeof value.connectionLabel === 'string' ? value.connectionLabel.slice(0, 256) : undefined,
    connectionSnapshot: snapshot,
    limits: importedLimits,
    source: typeof value.source === 'string' ? value.source.slice(0, 1000) : 'imported llm-bench report',
  };
  persist(record);
  return record;
}

export function registerBenchRoutes(app: Hono) {
  recoverInterruptedBenchmarks();
  app.use(
    '/api/bench/start',
    bodyLimit({ maxSize: 1024 * 1024, onError: (c) => c.json({ error: '压测配置不能超过 1 MB' }, 413) }),
  );
  app.use(
    '/api/bench/import',
    bodyLimit({ maxSize: 20 * 1024 * 1024, onError: (c) => c.json({ error: '压测报告不能超过 20 MB' }, 413) }),
  );
  app.get('/api/bench/runtime', async (c) => c.json(await benchRuntime()));
  app.get('/api/bench', (c) => {
    const { limit, offset } = pagination(c.req.query('limit'), c.req.query('offset'), 50);
    const rows = db
      .prepare('SELECT record_json FROM benchmark_runs ORDER BY created_at DESC LIMIT ? OFFSET ?')
      .all(limit, offset) as { record_json: string }[];
    return c.json(
      rows.map((r) => {
        const v = redactValue(JSON.parse(r.record_json)) as BenchRecord;
        return { ...v, stages: v.stages.map((s) => ({ ...s, results: [] })) };
      }),
    );
  });
  app.post('/api/bench/start', async (c) => {
    try {
      return c.json(await startBenchmark(await c.req.json()), 201);
    } catch (e) {
      return c.json({ error: redactText((e as Error).message) }, 400);
    }
  });
  app.post('/api/bench/import', async (c) => {
    try {
      return c.json(importBenchmark(await c.req.json()), 201);
    } catch (e) {
      return c.json({ error: redactText((e as Error).message) }, 400);
    }
  });
  app.get('/api/bench/:id/export', (c) => {
    const record = getBenchmark(c.req.param('id'));
    if (!record) return c.json({ error: '压测不存在' }, 404);
    const csv = c.req.query('format') === 'csv';
    return new Response(csv ? benchmarkCsv(record) : JSON.stringify(record, null, 2), {
      headers: {
        'Content-Type': csv ? 'text/csv; charset=utf-8' : 'application/json; charset=utf-8',
        'Content-Disposition': `attachment; filename="benchmark-${record.id}.${csv ? 'csv' : 'json'}"`,
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
  app.get('/api/bench/:id', (c) => {
    const record = getBenchmark(c.req.param('id'));
    return record ? c.json(record) : c.json({ error: '压测不存在' }, 404);
  });
  app.post('/api/bench/:id/cancel', (c) => {
    const record = cancelBenchmark(c.req.param('id'));
    return record ? c.json(record) : c.json({ error: '压测不存在' }, 404);
  });
  app.delete('/api/bench/:id', (c) => {
    const id = c.req.param('id');
    if (live.has(id)) return c.json({ error: '请先停止正在运行的压测' }, 409);
    if (!getBenchmark(id)) return c.json({ error: '压测不存在' }, 404);
    db.prepare('DELETE FROM benchmark_runs WHERE id=?').run(id);
    return c.json({ ok: true });
  });
}
