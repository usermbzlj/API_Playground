/* 在已打开的页面里执行一段 JS 并打印结果（调试用）。
   用法：node tools/cdp_eval.mjs "<js>" [url] [hash]
   前提：已有带 --remote-debugging-port 的浏览器在跑（默认 9222，可用 CDP_PORT 覆盖）。 */
const PORT = process.env.CDP_PORT || 9222;
const SCRIPT = process.argv[2] || '1';
const URL = process.argv[3] || 'http://127.0.0.1:8766/';
const HASH = process.argv[4] || '';

const sleep = ms => new Promise(r => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find(t => t.type === 'page');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

let seq = 0;
const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });

await send('Page.enable', {});
/* 页面一加载就挂错误捕获，window.__errs 里能拿到全部未捕获异常 */
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__errs=[];addEventListener('error',e=>window.__errs.push(String(e.message||e.error)));addEventListener('unhandledrejection',e=>window.__errs.push('rej: '+String(e.reason&&e.reason.message||e.reason)));`
});
if (process.env.CDP_SET_SIZE !== '0') {
  const [vw, vh] = (process.env.CDP_WH || '1920x1080').split('x').map(Number);
  await send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: 1, mobile: process.env.CDP_MOBILE === '1' });
}
await send('Page.navigate', { url: URL });
await sleep(4000);
if (HASH) { await send('Runtime.evaluate', { expression: `location.hash=${JSON.stringify(HASH)}` }); await sleep(6000); }

const r = await send('Runtime.evaluate', { expression: SCRIPT, returnByValue: true, awaitPromise: true });
if (r.result?.exceptionDetails) {
  console.log('EXCEPTION:', JSON.stringify(r.result.exceptionDetails, null, 1));
} else {
  console.log(JSON.stringify(r.result?.result?.value ?? null, null, 1));
}
const e = await send('Runtime.evaluate', { expression: 'window.__errs||[]', returnByValue: true });
console.log('page errors:', JSON.stringify(e.result?.result?.value || []));
ws.close();
