/* 用 Chrome DevTools Protocol 量页面上若干元素的真实盒子和计算样式。
   用法：先起带 --remote-debugging-port=9225 的无头 Edge（见 SKILL.md），再
       CDP_PORT=9225 node cdp_probe.mjs <url> [hash] <选择器1> [选择器2] ...
       CDP_WH=414x896 CDP_MOBILE=1 CDP_PORT=9225 node cdp_probe.mjs <url> "" .card
   输出 JSON：每个选择器的 border-box 尺寸、占视口百分比、关键计算样式。
*/
const PORT = process.env.CDP_PORT || 9222;
const ARGS = process.argv.slice(2);
const URL = ARGS[0];
const HASH = ARGS[1] || '';
const SELECTORS = ARGS.slice(2);
if (!URL || !SELECTORS.length) {
  console.error('用法：node cdp_probe.mjs <url> [hash] <选择器> [选择器...]');
  process.exit(1);
}
const [VW, VH] = (process.env.CDP_WH || '1920x1080').split('x').map(Number);
const WAIT = Number(process.env.CDP_WAIT || 5000);

const sleep = ms => new Promise(r => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find(t => t.type === 'page');
if (!target) { console.error('没有可用的页面目标'); process.exit(1); }

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.addEventListener('open', res, { once: true });
  ws.addEventListener('error', rej, { once: true });
});

let seq = 0;
const pending = new Map();
ws.addEventListener('message', e => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise(res => {
  const id = ++seq;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});
const evaluate = async expression => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.result?.exceptionDetails) return { error: r.result.exceptionDetails.text };
  return r.result?.result?.value;
};

await send('Page.enable', {});
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `window.__errs=[];addEventListener('error',e=>window.__errs.push(String(e.message||e.error)));addEventListener('unhandledrejection',e=>window.__errs.push('rej: '+String(e.reason&&e.reason.message||e.reason)));`
});
await send('Emulation.setDeviceMetricsOverride', {
  width: VW, height: VH, deviceScaleFactor: 1, mobile: process.env.CDP_MOBILE === '1'
});
await send('Page.navigate', { url: URL });
await sleep(WAIT);
if (HASH) {
  await evaluate(`location.hash=${JSON.stringify(HASH)}`);
  await sleep(WAIT);
}

const probe = `(() => {
  const sels = ${JSON.stringify(SELECTORS)};
  const out = { win: [innerWidth, innerHeight], rootFont: getComputedStyle(document.documentElement).fontSize, els: {} };
  for (const s of sels) {
    const el = document.querySelector(s);
    if (!el) { out.els[s] = null; continue; }
    const r = el.getBoundingClientRect(), cs = getComputedStyle(el);
    out.els[s] = {
      rect: [Math.round(r.width), Math.round(r.height)],
      fillW: Math.round(r.width / innerWidth * 100) + '%',
      fillH: Math.round(r.height / innerHeight * 100) + '%',
      offsetPx: Math.round(r.left) + ',' + Math.round(r.top),
      display: cs.display, position: cs.position,
      padding: cs.paddingTop + ' ' + cs.paddingRight + ' ' + cs.paddingBottom + ' ' + cs.paddingLeft,
      inlineStyle: el.getAttribute('style'),
      client: [el.clientWidth, el.clientHeight],
      kids: el.children.length
    };
  }
  return JSON.stringify(out, null, 1);
})()`;

console.log(await evaluate(probe));
const e = await evaluate('window.__errs||[]');
if (e && e.length) console.log('page errors:', JSON.stringify(e));
ws.close();
