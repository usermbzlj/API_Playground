// Local-only import. No model query or inference request is made.
import { readFileSync } from 'node:fs';
const path = process.argv[2];
if (!path || path.startsWith('--'))
  throw new Error('用法：node scripts/import-connections.ts 文件路径 [--apply] [--port=8787]');
const port = Number(process.argv.find((a) => a.startsWith('--port='))?.slice(7) ?? 8787);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('本地端口无效');
const text = readFileSync(path, 'utf8');
const r = await fetch(`http://127.0.0.1:${port}/api/connections/import`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text, apply: process.argv.includes('--apply') }),
});
const result = (await r.json()) as any;
if (!r.ok) throw new Error(typeof result.error === 'string' ? result.error : `本机导入失败 HTTP ${r.status}`);
console.log(JSON.stringify(result, null, 2));
