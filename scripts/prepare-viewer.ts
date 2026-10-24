// Keep optional model compression decoders local; opening an artifact never needs a CDN.
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
const require = createRequire(import.meta.url);
const threeRoot = dirname(dirname(require.resolve('three')));
const source = join(threeRoot, 'examples', 'jsm', 'libs');
const target = join(process.cwd(), 'public', 'vendor');
for (const [folder, files] of [
  ['draco', ['draco_decoder.js', 'draco_decoder.wasm', 'draco_wasm_wrapper.js']],
  ['basis', ['basis_transcoder.js', 'basis_transcoder.wasm']],
] as const) {
  mkdirSync(join(target, folder), { recursive: true });
  for (const file of files)
    copyFileSync(join(source, folder, ...(folder === 'draco' ? ['gltf'] : []), file), join(target, folder, file));
}
// model-viewer loads this URL with a classic script element, not import().
const meshopt = readFileSync(join(source, 'meshopt_decoder.module.js'), 'utf8');
if (!meshopt.includes('export { MeshoptDecoder };')) throw new Error('Meshopt 模块格式变化，请更新本地解码器打包规则');
writeFileSync(
  join(target, 'meshopt_decoder.js'),
  meshopt.replace('export { MeshoptDecoder };', 'globalThis.MeshoptDecoder = MeshoptDecoder;'),
);
console.log('3D 解码器已准备为本地资源');
