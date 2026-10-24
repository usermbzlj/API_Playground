// Explicitly invoked only with the user's authorization. Never part of npm run check.
// Scope: two tiny Qwen TEXT calls, total task budget CNY 2. No media or tool execution.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, existsSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { SSEDecoder } from '../shared/sse.ts';
import { redactSensitive } from '../shared/redact.ts';

if (!process.argv.includes('--authorized-text-cny2'))
  throw new Error('需当前用户明确授权文本实测及预算后，传入 --authorized-text-cny2');
if (!process.env.DASHSCOPE_API_KEY) throw new Error('未找到 DASHSCOPE_API_KEY，不进行付费请求');
const ledgerPath = join(process.cwd(), '.agent', 'text-budget.json');
mkdirSync(dirname(ledgerPath), { recursive: true });
const ledger = existsSync(ledgerPath)
  ? JSON.parse(readFileSync(ledgerPath, 'utf8'))
  : { capCny: 2, reservedCny: 0, calls: [] };
// Each request contains fewer than 2048 input tokens, <=256 total output tokens.
// Conservative reserve: input CNY 1.1/M + output CNY 3.5/M < CNY .004 per call.
// Reserve CNY .02/call before dispatch, retained even on timeout. Never auto-retry.
const calls = [
  {
    name: 'nonthinking-http',
    input: { messages: [{ role: 'user', content: '请只回答：连接成功' }], stream: false },
    params: { enable_thinking: { enabled: true, value: false }, max_tokens: { enabled: true, value: 64 } },
  },
  {
    name: 'thinking-sse',
    input: { messages: [{ role: 'user', content: '计算17×19，用一句话给出结果。' }], stream: true },
    params: {
      enable_thinking: { enabled: true, value: true },
      thinking_budget: { enabled: true, value: 128 },
      max_tokens: { enabled: true, value: 256 },
    },
  },
];
if (ledger.reservedCny + 0.04 > ledger.capCny) throw new Error('本任务累计预算预留不足，停止实测');
const tempRoot = resolve(tmpdir());
const temporary = mkdtempSync(join(tempRoot, 'api-playground-real-text-'));
const portProbe = createServer();
portProbe.listen(0, '127.0.0.1');
await once(portProbe, 'listening');
const port = (portProbe.address() as any).port;
await new Promise<void>((done) => portProbe.close(() => done()));
const processHandle = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, PLAYGROUND_DATA_DIR: temporary, PORT: String(port), HOST: '127.0.0.1' },
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let diagnostics = '';
processHandle.stdout.on('data', () => {});
processHandle.stderr.on('data', (b) => {
  diagnostics += b.toString();
});
const origin = `http://127.0.0.1:${port}`;
const results: any[] = [];
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    if (processHandle.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw new Error('隔离测试服务未就绪');
  const imported = await fetch(`${origin}/api/env-keys/import`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envName: 'DASHSCOPE_API_KEY', providerId: 'qwen', baseUrlId: 'cn' }),
  });
  if (!imported.ok) throw new Error('无法在隔离服务导入已授权 Key');
  const connection = (await imported.json()) as any;
  for (const call of calls) {
    const reservation = { name: call.name, date: new Date().toISOString(), reserveCny: 0.02, status: 'dispatched' };
    ledger.calls.push(reservation);
    ledger.reservedCny = Number((ledger.reservedCny + 0.02).toFixed(2));
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    const events: any[] = [];
    const response = await fetch(`${origin}/api/run`, {
      method: 'POST',
      signal: AbortSignal.timeout(60_000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        connectionId: connection.id,
        operationId: 'qwen.chat',
        model: 'qwen3.8-flash',
        title: `授权文本实测 · ${call.name}`,
        input: call.input,
        params: call.params,
        confirmCost: true,
      }),
    });
    const parser = new SSEDecoder(({ data }) => events.push(JSON.parse(data)));
    parser.feed(await response.text(), true);
    const done = events.findLast((e) => e.type === 'done')?.data;
    const error = events.find((e) => e.type === 'error')?.data;
    const record = done?.runId ? await fetch(`${origin}/api/runs/${done.runId}`).then((r) => r.json()) : null;
    const usage = done?.metrics?.usage;
    // Upper-bound price across the verified Beijing/Singapore Flash price rows.
    const estimate = usage
      ? (Number(usage.prompt_tokens ?? 0) * 1.1 + Number(usage.completion_tokens ?? 0) * 3.5) / 1e6
      : undefined;
    const result = {
      test: call.name,
      model: 'qwen3.8-flash',
      httpStatus: done?.httpStatus ?? response.status,
      status: done?.status ?? 'incomplete',
      error,
      metrics: done?.metrics,
      conservativeCostCny: estimate,
      record,
    };
    results.push(result);
    reservation.status = result.status;
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    console.log(
      JSON.stringify({
        test: call.name,
        status: result.status,
        httpStatus: result.httpStatus,
        usage,
        conservativeCostCny: estimate,
        error,
      }),
    );
    if (result.status !== 'ok') break;
  }
} finally {
  const exited = processHandle.exitCode === null ? once(processHandle, 'exit') : Promise.resolve();
  processHandle.kill();
  await exited;
  if (dirname(resolve(temporary)) !== tempRoot || !basename(temporary).startsWith('api-playground-real-text-'))
    throw new Error('临时目录边界不符，保留数据');
  rmSync(temporary, { recursive: true, force: true });
  const report = {
    date: new Date().toISOString(),
    scope: '只实测文本 LLM，预算上限 CNY 2；未调用媒体与实时 API',
    officialPriceSource: 'https://help.aliyun.com/zh/model-studio/model-pricing',
    priceNote: '保守按输入1.1/输出3.5元每百万Token估计，覆盖核对的北京/新加坡Flash价；实际扣费以账单为准。',
    reservedCny: ledger.reservedCny,
    results,
  };
  writeFileSync(
    join(process.cwd(), 'docs', 'text-verification.json'),
    JSON.stringify(redactSensitive(report), null, 2),
  );
}
if (results.length !== 2 || results.some((r) => r.status !== 'ok')) process.exitCode = 1;
