// Opt-in paid acceptance, never part of npm run check. Credentials stay in the local file.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import assert from 'node:assert/strict';
import { SSEDecoder } from '../shared/sse.ts';
import { initialParamState } from '../shared/util.ts';
import { getOperation } from '../shared/catalog.ts';
import { redactSensitive } from '../shared/redact.ts';

if (!process.argv.includes('--authorized-text-cny2')) throw new Error('需要用户授权的文本测试和累计 CNY2 上限');
const fileArg = process.argv.indexOf('--keys-file');
if (fileArg < 0 || !process.argv[fileArg + 1]) throw new Error('通过 --keys-file 指定本机凭证文件');
const keyFile = readFileSync(resolve(process.argv[fileArg + 1]), 'utf8');
// Markdown is data only: allowlisted headings and key fields; never execute its content.
const sections = keyFile
  .split(/^##\s+/m)
  .slice(1)
  .map((s) => {
    const [heading, ...lines] = s.split(/\r?\n/);
    const fields = Object.fromEntries(
      lines
        .map((l) => l.match(/^([a-zA-Z][\w-]*):\s*(.*)$/))
        .filter(Boolean)
        .map((m) => [m![1], m![2]]),
    );
    return { heading, fields };
  });
const credentials = [
  { id: 'deepseek', match: /^DeepSeek\s*\|/, base: 'https://api.deepseek.com' },
  { id: 'minimax', match: /^MiniMax\s*\|/, base: 'https://api.minimaxi.com' },
  { id: 'minimax2', match: /^MiniMax\s*\|/, base: 'https://api.minimaxi.com' },
  { id: 'mimo', match: /^小米 MiMo/, base: 'https://api.xiaomimimo.com' },
  { id: 'kimi', match: /^Moonshot/, base: 'https://api.moonshot.cn' },
].map((p) => {
  const fields = sections.find((s) => p.match.test(s.heading))?.fields;
  const key = p.id === 'minimax2' ? fields?.key2 : fields?.key || fields?.key1;
  if (!key || /\s/.test(key)) throw new Error(`${p.id} 没有可解析的独立 Key`);
  return { ...p, key };
});
const ledgerPath = join(process.cwd(), '.agent', 'text-budget.json');
mkdirSync(dirname(ledgerPath), { recursive: true });
const ledger = existsSync(ledgerPath)
  ? JSON.parse(readFileSync(ledgerPath, 'utf8'))
  : { capCny: 2, reservedCny: 0, calls: [] };
assert.equal(ledger.capCny, 2);
const chat = (text: string, stream: boolean) => ({ messages: [{ role: 'user', content: text }], stream });
const cases = [
  {
    name: 'minimax-second-account-thinking-sse',
    provider: 'minimax2',
    op: 'minimax.chat',
    model: 'MiniMax-M3.1-Flash',
    input: chat('计算17乘19，只用一句话给出结果。', true),
    params: { max_completion_tokens: 512, reasoning_effort: 'low', reasoning_split: true },
    price: [1, 4],
    source: 'https://platform.minimax.cn/docs/pricing/overview',
  },
  {
    name: 'deepseek-prefix-sse',
    provider: 'deepseek',
    op: 'deepseek.chat',
    model: 'deepseek-flash',
    input: { ...chat('只输出 JSON 对象，字段 ok 的值为 true。', true), prefix: '{"ok":' },
    params: { 'thinking.type': 'disabled', max_tokens: 96 },
    price: [2, 8],
    source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  },
  {
    name: 'deepseek-replay',
    provider: 'deepseek',
    op: 'deepseek.chat',
    model: 'deepseek-flash',
    input: chat('只输出 JSON：{"ok":true}。不要解释。', false),
    params: {
      'thinking.type': 'disabled',
      max_tokens: 96,
      response_format: { type: 'json_object' },
      logprobs: true,
      top_logprobs: 2,
    },
    price: [2, 8],
    source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  },
  {
    name: 'kimi-sse',
    provider: 'kimi',
    op: 'kimi.k26',
    model: 'kimi-k2.6',
    input: chat('计算17乘19，只用一句话给出结果。', true),
    params: { 'thinking.type': 'disabled', max_tokens: 96 },
    price: [6.5, 27],
    source: 'https://platform.kimi.com/docs/pricing/chat',
  },
  {
    name: 'deepseek-http-json-logprobs',
    provider: 'deepseek',
    op: 'deepseek.chat',
    model: 'deepseek-flash',
    input: chat('只输出 JSON：{"ok":true}。不要解释。', false),
    params: {
      'thinking.type': 'disabled',
      max_tokens: 96,
      response_format: { type: 'json_object' },
      logprobs: true,
      top_logprobs: 2,
    },
    price: [2, 8],
    source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  },
  {
    name: 'deepseek-thinking-sse',
    provider: 'deepseek',
    op: 'deepseek.chat',
    model: 'deepseek-flash',
    input: chat('计算17乘19，只用一句话给出结果。', true),
    params: { 'thinking.type': 'enabled', reasoning_effort: 'low', max_tokens: 512 },
    price: [2, 8],
    source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  },
  {
    name: 'deepseek-fim-sse',
    provider: 'deepseek',
    op: 'deepseek.fim',
    model: 'deepseek-flash',
    input: { prefix: 'function add(a, b) {\n  ', suffix: '\n}\nconsole.log(add(2, 3));', stream: true },
    params: { max_tokens: 96, temperature: 0.1 },
    price: [2, 8],
    source: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing/',
  },
  {
    name: 'minimax-thinking-sse',
    provider: 'minimax',
    op: 'minimax.chat',
    model: 'MiniMax-M3.1-Flash',
    input: chat('计算17乘19，只用一句话给出结果。', true),
    params: { max_completion_tokens: 512, reasoning_effort: 'low', reasoning_split: true },
    price: [1, 4],
    source: 'https://platform.minimax.cn/docs/pricing/overview',
  },
  {
    name: 'mimo-http',
    provider: 'mimo',
    op: 'mimo.chat',
    model: 'mimo-v2.6-flash',
    input: chat('请只回答：连接成功', false),
    params: { 'thinking.type': 'disabled', max_completion_tokens: 96 },
    price: [1, 2],
    source: 'https://mimo.mi.com/static/docs/price/pay-as-you-go.md',
  },
  {
    name: 'mimo-thinking-sse',
    provider: 'mimo',
    op: 'mimo.chat',
    model: 'mimo-v2.6-flash',
    input: chat('计算17乘19，只用一句话给出结果。', true),
    params: { 'thinking.type': 'enabled', max_completion_tokens: 512 },
    price: [1, 2],
    source: 'https://mimo.mi.com/static/docs/price/pay-as-you-go.md',
  },
  {
    name: 'kimi-http',
    provider: 'kimi',
    op: 'kimi.k26',
    model: 'kimi-k2.6',
    input: chat('请只回答：连接成功', false),
    params: { 'thinking.type': 'disabled', max_tokens: 96 },
    price: [6.5, 27],
    source: 'https://platform.kimi.com/docs/pricing/chat',
  },
];
const selected = process.argv.includes('--case') ? process.argv[process.argv.indexOf('--case') + 1] : undefined;
const pending = cases.filter(
  (c) => (!selected || selected === c.name) && !ledger.calls.some((r: any) => r.name === c.name),
);
if (!pending.length) throw new Error('没有新测试；已派发的用例不会自动重试');
// Each tiny input <2048 tokens, generated content <=512 tokens including reasoning.
// Most expensive case upper bound 2048*6.5/M + 512*27/M < CNY .028.
const reserve = 0.05;
if (ledger.reservedCny + pending.length * reserve > 2) throw new Error('累计预算预留不足');
const tempRoot = resolve(tmpdir());
const temporary = mkdtempSync(join(tempRoot, 'api-playground-domestic-text-'));
const probe = createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = (probe.address() as any).port;
await new Promise<void>((r) => probe.close(() => r()));
const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.ts'], {
  cwd: process.cwd(),
  env: { ...process.env, PLAYGROUND_DATA_DIR: temporary, PORT: String(port), HOST: '127.0.0.1' },
  windowsHide: true,
  stdio: 'ignore',
});
const origin = `http://127.0.0.1:${port}`;
const reportPath = join(process.cwd(), 'docs', 'text-verification.json');
const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : { results: [] };
const results: any[] = [];
const safe = (value: unknown) => {
  let s = JSON.stringify(redactSensitive(value));
  for (const p of credentials) s = s.replaceAll(p.key, '***已隐藏***');
  return JSON.parse(s);
};
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${origin}/api/health`)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  if (!ready) throw new Error('隔离服务未就绪');
  const connections = new Map<string, string>();
  for (const p of credentials.filter((p) => pending.some((c) => c.provider === p.id))) {
    const r = await fetch(`${origin}/api/connections`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        providerId: p.id === 'minimax2' ? 'minimax' : p.id,
        label: '授权文本实测',
        baseUrl: p.base,
        apiKey: p.key,
      }),
    });
    if (!r.ok) throw new Error(`${p.id} 本地连接创建失败`);
    connections.set(p.id, ((await r.json()) as any).id);
  }
  const failedProviders = new Set<string>();
  for (const c of pending) {
    if (failedProviders.has(c.provider)) continue;
    const reservation = { name: c.name, date: new Date().toISOString(), reserveCny: reserve, status: 'dispatched' };
    ledger.calls.push(reservation);
    ledger.reservedCny = Number((ledger.reservedCny + reserve).toFixed(2));
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    const events: any[] = [];
    let result: any;
    try {
      const params = initialParamState(getOperation(c.op)!.params, c.params);
      const prior =
        c.name === 'deepseek-replay'
          ? report.results.find((r: any) => r.test === 'deepseek-http-json-logprobs')?.record
          : undefined;
      const payload = {
        ...(prior?.state ?? {}),
        connectionId: connections.get(c.provider),
        operationId: c.op,
        model: c.model,
        title: `授权文本实测 · ${c.name}`,
        input: c.input,
        params,
        confirmCost: true,
        groupId: 'authorized-text-comparison',
        parentId: prior?.id,
      };
      const r = await fetch(`${origin}/api/run`, {
        method: 'POST',
        signal: AbortSignal.timeout(60_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      new SSEDecoder(({ data }) => events.push(JSON.parse(data))).feed(await r.text(), true);
      const done = events.findLast((e) => e.type === 'done')?.data;
      const record: any = done?.runId ? await fetch(`${origin}/api/runs/${done.runId}`).then((r) => r.json()) : null;
      const view = done?.view ?? record?.response?.view;
      const usage = done?.metrics?.usage;
      result = {
        test: c.name,
        providerId: getOperation(c.op)!.providerId,
        model: c.model,
        date: reservation.date,
        status: done?.status ?? 'incomplete',
        httpStatus: done?.httpStatus ?? r.status,
        error: events.find((e) => e.type === 'error')?.data,
        metrics: done?.metrics,
        view,
        priceSource: c.source,
        upperPricePerMillionCny: c.price,
        conservativeCostCny: usage
          ? (Number(usage.prompt_tokens ?? usage.input_tokens ?? 0) * c.price[0] +
              Number(usage.completion_tokens ?? usage.output_tokens ?? 0) * c.price[1]) /
            1e6
          : undefined,
        record,
        restoreCheck: !!record?.state && JSON.stringify(record.state.input) === JSON.stringify(c.input),
        replayParentCheck: prior ? record?.parentId === prior.id : undefined,
        streamEventCount: events.filter((e) => e.type === 'chunk').length,
      };
      assert.equal(result.restoreCheck, true, '历史输入应完整恢复');
      if (result.status !== 'ok') failedProviders.add(c.provider);
    } catch (e: any) {
      result = {
        ...result,
        test: c.name,
        providerId: c.provider,
        model: c.model,
        status: 'incomplete',
        error: e.message,
      };
      failedProviders.add(c.provider);
    }
    results.push(safe(result));
    reservation.status = result.status;
    writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2));
    console.log(
      JSON.stringify(
        safe({
          test: c.name,
          status: result.status,
          httpStatus: result.httpStatus,
          usage: result.metrics?.usage,
          conservativeCostCny: result.conservativeCostCny,
          restoreCheck: result.restoreCheck,
          text: result.view?.text?.slice(0, 100),
          reasoningChars: result.view?.reasoning?.length,
          error: result.error,
        }),
      ),
    );
  }
} finally {
  const exited = child.exitCode === null ? once(child, 'exit') : Promise.resolve();
  child.kill();
  await exited;
  assert.equal(dirname(resolve(temporary)), tempRoot);
  assert.ok(basename(temporary).startsWith('api-playground-domestic-text-'));
  rmSync(temporary, { recursive: true, force: true });
  report.results.push(...results);
  report.date = new Date().toISOString();
  report.scope = '用户授权：仅文本 LLM，累计上限 CNY2；无媒体、实时或外部工具执行。';
  report.reservedCny = ledger.reservedCny;
  report.priceNote = '各结果按其国内官方价上界、全部输入按未缓存估计；预算预留保留失败与超时，不等于账单。';
  writeFileSync(reportPath, JSON.stringify(safe(report), null, 2));
}
if (results.some((r) => r.status !== 'ok')) process.exitCode = 1;
