import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../integrations/llm-bench/', import.meta.url));
const env = join(root, '.venv');
const python = join(env, process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
function run(command: string, args: string[]) {
  const r = spawnSync(command, args, { stdio: 'inherit', windowsHide: true });
  if (r.error) {
    console.error(`无法执行 ${command}：${r.error.message}。需要 uv 与 Python 3.11+。`);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status ?? 1);
}
if (!existsSync(python)) run('uv', ['venv', '--python', '>=3.11', env]);
run('uv', ['pip', 'install', '--python', python, '-r', join(root, 'requirements.txt')]);
run(python, [join(root, 'bridge.py'), '--probe']);
console.log('性能评测环境已准备好。启动应用后，在「性能评测」刷新引擎状态。');
