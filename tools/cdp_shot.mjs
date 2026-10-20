/* 用 CDP 在真实渲染完成后截图（含交互后再截）。
   用法：
     CDP_PORT=9225 node cdp_shot.mjs <url> [hash] <out.png> [宽x高] [点选择器N次] [每次间隔ms]
   环境变量：
     CDP_WH=414x896        视口尺寸（也可用第 4 个位置参数）
     CDP_MOBILE=1          模拟手机
     CDP_WAIT=5000         导航后等待毫秒（等页面渲染/取数）
     CDP_DISMISS=a,b       截图前把这些选择器隐藏掉（开屏层/引导层/迎宾屏）
     CDP_SETTLE=1500       每次点击后的等待毫秒
   前提：已有带 --remote-debugging-port 的无头 Edge 在跑（默认 9222）。
*/
import { writeFileSync } from 'node:fs';

const PORT = process.env.CDP_PORT || 9222;
const URL = process.argv[2] || 'http://127.0.0.1:8766/';
const HASH = process.argv[3] || '';
const OUT = process.argv[4] || 'shot.png';
const [VW, VH] = (process.env.CDP_WH || process.argv[5] || '1920x1080').split('x').map(Number);
const CLICK = process.argv[6] || '';           // 截图前反复点的选择器
const TIMES = Number(process.argv[7] || 1);
const SETTLE = Number(process.env.CDP_SETTLE || 1500);
const WAIT = Number(process.env.CDP_WAIT || 5000);

const sleep = ms => new Promise(r => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.find(t => t.type === 'page');
if (!target) { console.error('没有可用的页面目标'); process.exit(1); }
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });

let seq = 0;
const pending = new Map();
ws.addEventListener('message', e => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise(res => { const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params })); });

await send('Page.enable', {});
await send('Emulation.setDeviceMetricsOverride', { width: VW, height: VH, deviceScaleFactor: 1, mobile: process.env.CDP_MOBILE === '1' });
await send('Page.navigate', { url: URL });
await sleep(WAIT);
if (HASH) { await send('Runtime.evaluate', { expression: `location.hash=${JSON.stringify(HASH)}` }); await sleep(WAIT); }

const dismiss = (process.env.CDP_DISMISS || '').split(',').map(s => s.trim()).filter(Boolean);
if (dismiss.length) {
  await send('Runtime.evaluate', { expression: `(()=>{${JSON.stringify(dismiss)}.forEach(s=>{const el=document.querySelector(s);if(el){el.hidden=true;el.style.display='none';}});return 1})()` });
  await sleep(400);
}
/* 有些应用会把主体设成 inert（不可交互），截图时恢复，否则点不动 */
await send('Runtime.evaluate', { expression: `document.querySelectorAll('[inert]').forEach(el=>el.inert=false)` });

if (CLICK) {
  for (let i = 0; i < TIMES; i++) {
    await send('Runtime.evaluate', { expression: `(()=>{const el=document.querySelector(${JSON.stringify(CLICK)});if(el){el.click();return 1}return 0})()` });
    await sleep(SETTLE);
  }
}

const r = await send('Page.captureScreenshot', { format: 'png' });
writeFileSync(OUT, Buffer.from(r.result.data, 'base64'));
console.log('saved', OUT);
const e = await send('Runtime.evaluate', { expression: 'window.__errs||[]', returnByValue: true });
const errs = e.result?.result?.value || [];
if (errs.length) console.log('page errors:', JSON.stringify(errs));
ws.close();
