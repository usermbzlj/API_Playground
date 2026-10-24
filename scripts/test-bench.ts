/** Deterministic local-only tests: never use a saved connection or external API. */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { createServer as createSecureServer } from 'node:https';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { gzipSync } from 'node:zlib';
import { benchLimits } from '../shared/bench.ts';
import { auditRecordedComparison, auditBenchmarkComparison } from '../shared/comparison.ts';
const directory = mkdtempSync(join(tmpdir(), 'playground-bench-'));
process.env.PLAYGROUND_DATA_DIR = directory;
const {
  validateBenchConfig,
  allowedBenchAddress,
  benchRuntime,
  startBenchmark,
  getBenchmark,
  cancelBenchmark,
  shutdownBenchmarks,
  benchmarkCsv,
  importBenchmark,
  recoverInterruptedBenchmarks,
  registerBenchRoutes,
} = await import('../server/bench.ts');
const { createConnection, updateConnection } = await import('../server/connections.ts');
const { setNetworkSettings } = await import('../server/net.ts');
const { db } = await import('../server/db.ts');
const { PROVIDERS } = await import('../shared/catalog.ts');
const { Hono } = await import('hono');
const provider = PROVIDERS.find((p) => p.generic)!;
assert.ok(provider, 'generic test provider must exist');
const requests: { path: string; body: any; auth: string | undefined }[] = [];
let slow = false;
let redirect = false;
let failOnce = false;
let semanticFailure = '';
const mock = createServer(async (req, res) => {
  let raw = '';
  for await (const part of req) raw += part.toString();
  const body = JSON.parse(raw);
  requests.push({ path: req.url!, body, auth: req.headers.authorization });
  if (redirect) {
    res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
    return;
  }
  if (failOnce) {
    failOnce = false;
    res.writeHead(429);
    res.end('retry locally');
    return;
  }
  if (slow) await new Promise((r) => setTimeout(r, 60));
  if (res.destroyed) return;
  if (semanticFailure) {
    if (semanticFailure === 'empty-json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
      return;
    }
    if (semanticFailure === 'gzip-limit') {
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' });
      res.end(
        gzipSync(Buffer.from(JSON.stringify({ choices: [{ message: { content: 'x'.repeat(5 * 1024 * 1024) } }] }))),
      );
      return;
    }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      if (semanticFailure === 'chat-partial' || semanticFailure === 'responses-partial') {
        res.end(
          semanticFailure === 'chat-partial'
            ? 'data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'
            : 'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
        );
        return;
      }
      if (semanticFailure === 'trailing-failure') {
        res.write('data: {"type":"response.output_text.delta","delta":"appears successful"}\n\n');
        res.end('data: {"type":"response.completed","response":{"status":"incomplete"}}');
        return;
      }
      res.end(
        `data: ${JSON.stringify(semanticFailure === 'heartbeat' ? { ping: true } : semanticFailure === 'chat-error' ? { error: { message: 'local vendor error' } } : { type: semanticFailure, response: { error: { message: 'local vendor error' } } })}\n\n`,
      );
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"local vendor error"}}');
    }
    return;
  }
  if (body.stream) {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    if (req.url?.includes('responses')) {
      res.write('data: {"type":"response.output_text.delta","delta":"hello"}\n\n');
      res.end(
        'data: {"type":"response.completed","response":{"usage":{"input_tokens":2,"output_tokens":1,"total_tokens":3}}}\n\n',
      );
    } else {
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      res.end('data: {"usage":{"prompt_tokens":2,"completion_tokens":1,"total_tokens":3}}\n\ndata: [DONE]\n\n');
    }
  } else {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify(
        req.url?.includes('responses')
          ? { output_text: 'hello', usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 } }
          : {
              choices: [{ message: { content: 'hello' } }],
              usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
            },
      ),
    );
  }
});
mock.listen(0, '127.0.0.1');
await once(mock, 'listening');
const port = (mock.address() as { port: number }).port;
const key = 'bench-local-secret-DO-NOT-EXPORT';
const connection = createConnection({
  providerId: provider.id,
  label: 'local mock',
  apiKey: key,
  baseUrl: `http://127.0.0.1:${port}/v1`,
  network: 'direct',
});
const base = {
  connectionId: connection.id,
  model: 'deterministic-test',
  mode: 'total',
  totalRequests: 4,
  concurrency: 2,
  confirmedCost: true,
};
async function done(id: string, timeout = 15000) {
  const at = Date.now();
  while (Date.now() - at < timeout) {
    const record = getBenchmark(id)!;
    if (!['starting', 'running', 'cancelling'].includes(record.status)) return record;
    await new Promise((r) => setTimeout(r, 30));
  }
  throw new Error('Local benchmark did not terminate');
}
try {
  assert.equal(
    benchLimits({ mode: 'total', totalRequests: 1000, concurrency: 1, durationSeconds: 1 }).maxRuntimeSeconds,
    1800,
  );
  assert.equal(
    benchLimits({ mode: 'total', totalRequests: 1000, concurrency: 1, durationSeconds: 600 }).maxRuntimeSeconds,
    1800,
  );
  assert.equal(
    benchLimits({ mode: 'sweep', totalRequests: 5, sweepConcurrency: [1, 4], warmup: 2, retries429: 1 }).maxAttempts,
    28,
  );
  assert.throws(() => validateBenchConfig({ ...base, confirmedCost: false }), /确认费用/);
  assert.throws(
    () => validateBenchConfig({ ...base, mode: 'sweep', totalRequests: 9000, sweepConcurrency: [1, 2] }),
    /上限/,
  );
  assert.throws(() => validateBenchConfig({ ...base, concurrency: '64' }), /并发/);
  assert.throws(() => validateBenchConfig({ ...base, path: '//evil.invalid/chat' }), /路径/);
  assert.throws(() => validateBenchConfig({ ...base, path: '/v1/chat?api_key=oops' }), /凭据/);
  for (const ip of [
    '169.254.169.254',
    '100.100.100.200',
    '::',
    'fe80::1',
    'ff02::1',
    '::ffff:169.254.169.254',
    'fd00:ec2::254',
    '0.0.0.0',
  ])
    assert.equal(allowedBenchAddress(ip), false, ip);
  for (const ip of ['127.0.0.1', '192.168.1.10', '10.0.0.1', '::1', '8.8.8.8'])
    assert.equal(allowedBenchAddress(ip), true, ip);
  assert.equal(
    (await benchRuntime()).available,
    true,
    'Install the headless runtime per integrations/llm-bench/README.md',
  );
  const app = new Hono();
  registerBenchRoutes(app);
  assert.equal((await app.request('/api/bench/runtime')).status, 200);
  assert.equal(
    (
      await app.request('/api/bench/start', {
        method: 'POST',
        body: JSON.stringify({ ...base, confirmedCost: false }),
        headers: { 'Content-Type': 'application/json' },
      })
    ).status,
    400,
  );
  let record = await done((await startBenchmark({ ...base, warmup: 1, prompts: ['alpha', 'beta'] })).id);
  assert.equal(record.status, 'completed');
  assert.equal(record.stages[0].stats.requests_total, 4);
  assert.equal(record.stages[0].stats.warmup_requests, 1);
  assert.equal(record.stages[0].stats.completion_tokens_total, 4);
  assert.equal(record.connectionSnapshot?.baseUrl, connection.baseUrl);
  assert.equal(record.limits?.maxRuntimeSeconds, 1800);
  assert.equal(requests.length, 5);
  assert.equal(requests[0].auth, `Bearer ${key}`);
  assert.equal(JSON.stringify(record).includes(key), false);
  assert.equal(benchmarkCsv(record).includes(key), false);
  const idempotent = await startBenchmark({ ...base, totalRequests: 1, clientRequestId: 'isolated-start-retry-test' });
  const sameStart = await startBenchmark({ ...base, totalRequests: 1, clientRequestId: 'isolated-start-retry-test' });
  assert.equal(sameStart.id, idempotent.id, 'ambiguous start retries reuse the existing run');
  await done(idempotent.id);
  failOnce = true;
  record = await done((await startBenchmark({ ...base, totalRequests: 1, retries429: 1 })).id);
  assert.equal(record.stages[0].stats.http_attempts_total, 2);
  assert.equal(record.stages[0].results[0].attempt_count, 2);
  record = await done(
    (await startBenchmark({ ...base, mode: 'sweep', totalRequests: 2, sweepConcurrency: [1, 3] })).id,
  );
  assert.deepEqual(
    record.stages.map((s) => s.concurrency),
    [1, 3],
  );
  record = await done(
    (
      await startBenchmark({
        ...base,
        endpoint: 'responses',
        stream: true,
        prompts: ['rotated input'],
        totalRequests: 2,
      })
    ).id,
  );
  assert.equal(record.stages[0].stats.requests_success, 2);
  assert.equal(record.stages[0].stats.completion_tokens_total, 2);
  assert.equal(record.stages[0].stats.output_chars_total, 10);
  assert.equal(requests.at(-1)!.body.input, 'rotated input');
  assert.equal(requests.at(-1)!.body.messages, undefined);
  assert.deepEqual(
    record.stages[0].results[0].request_body,
    requests.at(-1)!.body,
    'Responses replay body matches the actual wire body',
  );
  record = await done((await startBenchmark({ ...base, endpoint: 'responses', stream: false, totalRequests: 1 })).id);
  assert.equal(record.stages[0].stats.prompt_tokens_total, 2);
  record = await done((await startBenchmark({ ...base, mode: 'rps', targetRps: 5, durationSeconds: 0.3 })).id);
  assert.equal(record.status, 'completed');
  assert.ok(record.stages[0].stats.requests_total >= 1);
  record = await done(
    (
      await startBenchmark({
        ...base,
        totalRequests: 1,
        customBody: {
          model: 'ignored',
          messages: [{ role: 'user', content: 'preserve custom prompt' }],
          metadata: { custom: true },
        },
      })
    ).id,
  );
  assert.equal(requests.at(-1)!.body.messages[0].content, 'preserve custom prompt');
  for (const providerId of ['mimo', 'minimax']) {
    const native = createConnection({
      providerId,
      apiKey: key,
      baseUrl: `http://127.0.0.1:${port}`,
      network: 'direct',
    });
    record = await done((await startBenchmark({ ...base, connectionId: native.id, totalRequests: 1 })).id);
    assert.equal(record.config.path, '/v1/chat/completions', 'native inferred path is preserved for raw replay');
    assert.equal(record.stages[0].stats.requests_success, 1);
    assert.equal(requests.at(-1)!.path, '/v1/chat/completions');
    assert.equal(requests.at(-1)!.body.max_completion_tokens, 128);
    assert.equal(requests.at(-1)!.body.max_tokens, undefined);
  }
  for (const kind of [
    'response.failed',
    'response.incomplete',
    'error',
    'chat-error',
    'heartbeat',
    'trailing-failure',
    'chat-partial',
    'responses-partial',
  ]) {
    semanticFailure = kind;
    record = await done(
      (
        await startBenchmark({
          ...base,
          endpoint: kind.startsWith('response.') || kind === 'responses-partial' ? 'responses' : 'chat',
          totalRequests: 1,
          stream: true,
        })
      ).id,
    );
    assert.equal(record.stages[0].stats.requests_success, 0, kind);
    assert.equal(record.stages[0].stats.requests_failed, 1, kind);
  }
  semanticFailure = 'unary-error';
  record = await done((await startBenchmark({ ...base, totalRequests: 1 })).id);
  assert.equal(record.stages[0].stats.requests_failed, 1, 'HTTP 200 vendor errors are failures');
  semanticFailure = 'empty-json';
  record = await done((await startBenchmark({ ...base, totalRequests: 1 })).id);
  assert.equal(record.stages[0].stats.requests_failed, 1, 'HTTP 200 empty JSON is not a successful model result');
  semanticFailure = 'gzip-limit';
  record = await done((await startBenchmark({ ...base, totalRequests: 1 })).id);
  assert.equal(record.stages[0].stats.requests_failed, 1, 'decoded response size is bounded');
  assert.match(JSON.stringify(record), /4 MiB limit/);
  semanticFailure = '';
  const secure = createSecureServer(
    {
      key: readFileSync('integrations/llm-bench/tests/localhost-key.pem'),
      cert: readFileSync('integrations/llm-bench/tests/localhost-cert.pem'),
    },
    (req, res) => mock.emit('request', req, res),
  );
  // Dual-stack listener: localhost resolves to ::1 before 127.0.0.1 on this host,
  // and the pinned-IP transport must still complete the localhost TLS handshake.
  secure.listen(0, '::');
  await once(secure, 'listening');
  const securePort = (secure.address() as { port: number }).port;
  const priorCert = process.env.SSL_CERT_FILE;
  try {
    process.env.SSL_CERT_FILE = join(process.cwd(), 'integrations/llm-bench/tests/localhost-cert.pem');
    const tlsConnection = createConnection({
      providerId: provider.id,
      apiKey: key,
      baseUrl: `https://localhost:${securePort}/v1`,
      network: 'direct',
    });
    record = await done((await startBenchmark({ ...base, connectionId: tlsConnection.id, totalRequests: 1 })).id);
    assert.equal(
      record.stages[0].stats.requests_success,
      1,
      'pinned IP keeps original localhost TLS SNI and certificate validation',
    );
    const mismatch = createConnection({
      providerId: provider.id,
      apiKey: key,
      baseUrl: `https://127.0.0.1:${securePort}/v1`,
      network: 'direct',
    });
    record = await done((await startBenchmark({ ...base, connectionId: mismatch.id, totalRequests: 1 })).id);
    assert.equal(record.stages[0].stats.requests_failed, 1, 'TLS hostname mismatch is not bypassed');
  } finally {
    if (priorCert === undefined) delete process.env.SSL_CERT_FILE;
    else process.env.SSL_CERT_FILE = priorCert;
    secure.closeAllConnections();
    secure.close();
  }
  const proxyTargets: string[] = [];
  const proxy = createServer((req, res) => {
    const url = new URL(req.url!);
    proxyTargets.push(url.hostname);
    assert.equal(url.hostname, '127.0.0.1', 'proxy receives a pinned IP, never a hostname to resolve again');
    const out = httpRequest(url, { method: req.method, headers: req.headers }, (response) => {
      res.writeHead(response.statusCode!, response.headers);
      response.pipe(res);
    });
    out.on('error', (e) => {
      res.writeHead(502);
      res.end(e.message);
    });
    req.pipe(out);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  try {
    setNetworkSettings({ proxyUrl: `http://127.0.0.1:${(proxy.address() as { port: number }).port}` });
    const viaProxy = createConnection({
      providerId: provider.id,
      apiKey: key,
      baseUrl: `http://localhost:${port}/v1`,
      network: 'proxy',
    });
    record = await done((await startBenchmark({ ...base, connectionId: viaProxy.id, totalRequests: 1 })).id);
    assert.equal(record.stages[0].stats.requests_success, 1);
    assert.equal(proxyTargets.length, 1);
  } finally {
    setNetworkSettings({ proxyUrl: '' });
    proxy.closeAllConnections();
    proxy.close();
  }
  slow = true;
  const running = await startBenchmark({ ...base, mode: 'duration', durationSeconds: 5 });
  await assert.rejects(() => startBenchmark(base), /已有压测/);
  const progressDeadline = Date.now() + 15000;
  while ((getBenchmark(running.id)?.progress?.stats.requests_total ?? 0) < 1) {
    assert.ok(
      Date.now() < progressDeadline,
      'local benchmark must produce a completed request before partial cancellation',
    );
    await new Promise((r) => setTimeout(r, 30));
  }
  cancelBenchmark(running.id);
  record = await done(running.id);
  assert.equal(record.status, 'cancelled');
  assert.ok(
    (record.stages[0]?.stats.requests_total ?? record.progress?.stats.requests_total ?? 0) > 0,
    'cancellation preserves partial statistics',
  );
  const beforeFirstResult = await startBenchmark({ ...base, totalRequests: 100 });
  cancelBenchmark(beforeFirstResult.id);
  const earlyCancelled = await done(beforeFirstResult.id);
  assert.equal(earlyCancelled.status, 'cancelled', 'cancellation before the first response is a valid empty result');
  assert.ok((earlyCancelled.stages[0]?.stats.requests_total ?? 0) >= 0);
  slow = false;
  redirect = true;
  record = await done((await startBenchmark({ ...base, totalRequests: 1 })).id);
  assert.equal(record.stages[0].stats.requests_failed, 1);
  assert.match(JSON.stringify(record), /redirects refused/);
  redirect = false;
  const imported = importBenchmark({ ...record.stages[0].stats, api_key: key });
  assert.equal(imported.status, 'imported');
  assert.equal(JSON.stringify(imported).includes(key), false);
  const importedSweep = importBenchmark({
    ...record,
    createdAt: '2025-01-02T03:04:05.000Z',
    source: 'original-engine-version',
    config: { ...record.config, mode: 'sweep', sweepConcurrency: [1, 4] },
    stages: [record.stages[0], { ...record.stages[0], concurrency: 4 }],
  });
  assert.equal(importedSweep.config.mode, 'sweep');
  assert.equal(importedSweep.createdAt, '2025-01-02T03:04:05.000Z');
  assert.equal(importedSweep.source, 'original-engine-version');
  assert.ok(importedSweep.importedAt);
  const benchmarkAudit = auditBenchmarkComparison([
    { record: importedSweep, stageIndex: 0 },
    { record: importedSweep, stageIndex: 1 },
  ]);
  assert.ok(benchmarkAudit.differences.some((d) => d.axis === '所选档位并发'));
  const historical = [
    {
      model: 'model',
      request: { method: 'POST', url: 'https://old.invalid/v1/chat', route: 'direct', body: { prompt: 'a' } },
    },
    {
      model: 'model',
      request: { method: 'POST', url: 'https://new.invalid/v1/chat', route: 'proxy', body: { prompt: 'b' } },
    },
  ];
  const historyAudit = auditRecordedComparison(historical as any);
  assert.equal(
    historyAudit.ready,
    true,
    'historical auditing does not require a current connection or catalog operation',
  );
  assert.ok(historyAudit.differences.some((d) => d.axis === '实际请求地址'));
  assert.ok(historyAudit.differences.some((d) => d.axis === '已发送请求体'));
  const csv = benchmarkCsv({
    ...record,
    stages: [{ concurrency: 1, stats: record.stages[0].stats, results: [{ response_text: '=HYPERLINK("evil")' }] }],
  });
  assert.match(csv, /'=HYPERLINK/);
  const stale = { ...record, id: 'stale-interrupted-test', status: 'running' };
  db.prepare('INSERT INTO benchmark_runs(id,status,created_at,updated_at,record_json) VALUES(?,?,?,?,?)').run(
    stale.id,
    stale.status,
    stale.createdAt,
    stale.updatedAt,
    JSON.stringify(stale),
  );
  recoverInterruptedBenchmarks();
  assert.equal(getBenchmark(stale.id)!.status, 'interrupted');
  assert.equal(
    (await app.request(`/api/bench/${record.id}/export?format=csv`)).headers.get('content-type'),
    'text/csv; charset=utf-8',
  );
  assert.equal((await app.request(`/api/bench/${imported.id}`, { method: 'DELETE' })).status, 200);
  console.log(
    'PASS benchmark validation, local Python runner, retries, warmup, sweep, Responses SSE + usage, RPS, custom body, cancellation, redirects, redaction, imports, exports, restart recovery and API routes',
  );
  const python = join(
    process.cwd(),
    process.platform === 'win32'
      ? 'integrations/llm-bench/.venv/Scripts/python.exe'
      : 'integrations/llm-bench/.venv/bin/python',
  );
  const upstream = spawnSync(
    python,
    ['-m', 'pytest', '-q', 'tests/test_runner.py', 'tests/test_models.py', 'tests/test_config.py', 'tests/test_cli.py'],
    {
      cwd: join(process.cwd(), 'integrations/llm-bench/upstream'),
      env: { ...process.env, PYTHONPATH: '.', PYTHONDONTWRITEBYTECODE: '1' },
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  // Resolve interpreter from repository root while pytest cwd points at preserved source.
  if (upstream.error) throw upstream.error;
  process.stdout.write(upstream.stdout);
  process.stderr.write(upstream.stderr);
  assert.equal(upstream.status, 0, 'preserved upstream engine tests must pass');
} finally {
  shutdownBenchmarks();
  mock.closeAllConnections();
  mock.close();
  db.close();
  rmSync(directory, { recursive: true, force: true });
}
