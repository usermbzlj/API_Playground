// Catalog integrity check: run with `npm run check:catalog`.
// Verifies structural consistency of providers/operations/presets and that
// every operation's build() produces a valid NativeRequest with a dummy context.
import {
  BUILTIN_PRESETS,
  OPERATIONS,
  PROVIDERS,
  getOperation,
  getProvider,
  serializeOperation,
} from '../shared/catalog.ts';
import { FEATURES, FEATURE_MAP } from '../shared/features.ts';
import type { NativeRequest } from '../shared/types.ts';

const errors: string[] = [];
const warnings: string[] = [];

function err(msg: string) {
  errors.push(msg);
}
function warn(msg: string) {
  warnings.push(msg);
}

// ---- providers ----
const providerIds = new Set<string>();
for (const p of PROVIDERS) {
  if (providerIds.has(p.id)) err(`厂商 ID 重复：${p.id}`);
  providerIds.add(p.id);
  if (!p.name) err(`${p.id}: 缺少 name`);
  if (!p.baseUrls.length) err(`${p.id}: 没有配置任何 Base URL`);
  for (const b of p.baseUrls) {
    try {
      new URL(b.url);
    } catch {
      err(`${p.id}: Base URL 非法：${b.url}`);
    }
  }
  if (!p.models.length) warn(`${p.id}: 没有模型定义`);
  for (const m of p.models) {
    if (!m.id) err(`${p.id}: 存在没有 id 的模型`);
  }
}

// ---- operations ----
const opIds = new Set<string>();
for (const op of OPERATIONS) {
  if (opIds.has(op.id)) err(`操作 ID 重复：${op.id}`);
  opIds.add(op.id);
  const p = getProvider(op.providerId);
  if (!p) {
    err(`${op.id}: 引用了不存在的厂商 ${op.providerId}`);
    continue;
  }
  if (!op.title) err(`${op.id}: 缺少 title`);
  if (!op.params.length) warn(`${op.id}: 没有可调参数`);
  const keys = new Set<string>();
  for (const spec of op.params) {
    if (keys.has(spec.key)) err(`${op.id}: 参数 key 重复：${spec.key}`);
    keys.add(spec.key);
    if (spec.type === 'enum' && !spec.options?.length) err(`${op.id}: 枚举参数 ${spec.key} 没有 options`);
    if (spec.type === 'number' && spec.min != null && spec.max != null && spec.min > spec.max)
      err(`${op.id}: 参数 ${spec.key} min > max`);
  }
  for (const f of op.features) {
    if (!FEATURE_MAP.has(f)) err(`${op.id}: 引用了未定义的特性 ${f}`);
  }
  for (const b of op.baseUrlIds ?? []) {
    if (!p.baseUrls.some((x) => x.id === b)) err(`${op.id}: baseUrlIds 引用了不存在的端点 ${b}`);
  }
  for (const m of op.models ?? []) {
    if (!p.models.some((x) => x.id === m)) err(`${op.id}: models 引用了厂商未定义的模型 ${m}`);
  }
  if (op.defaultModel && !p.models.some((x) => x.id === op.defaultModel)) {
    err(`${op.id}: defaultModel ${op.defaultModel} 不在厂商模型列表中`);
  }
  if (op.lifecycle === 'async-task' && !op.async) err(`${op.id}: lifecycle 为 async-task 但没有 async 规格`);
  if (op.async && !op.async.idPath) err(`${op.id}: async 规格缺少 idPath`);

  // build() smoke test with a dummy context
  try {
    const req = op.build({
      model: op.defaultModel ?? p.models[0]?.id ?? 'demo-model',
      input: {},
      extra: { GroupId: 'demo' },
      params: {},
    });
    if (!req || typeof req !== 'object') throw new Error('build 没有返回请求对象');
    const r = req as NativeRequest;
    if (!r.method || !r.path) throw new Error(`请求缺少 method/path：${JSON.stringify(r)}`);
    if (typeof r.path !== 'string' || (!r.path.startsWith('/') && !/^https?:\/\//.test(r.path))) {
      throw new Error(`请求路径必须以 / 开头或为绝对 URL：${r.path}`);
    }
    if (r.body !== undefined && r.bodyType !== 'multipart' && typeof r.body === 'object') {
      JSON.stringify(r.body); // must be serializable
    }
  } catch (e: any) {
    err(`${op.id}: build() 失败：${e.message}`);
  }

  // serialization must not throw (sent to the web UI)
  try {
    serializeOperation(op);
  } catch (e: any) {
    err(`${op.id}: 序列化失败：${e.message}`);
  }
}

// ---- presets ----
for (const preset of BUILTIN_PRESETS) {
  const op = getOperation(preset.operationId);
  if (!op) {
    err(`预设 ${preset.id}: 引用了不存在的操作 ${preset.operationId}`);
    continue;
  }
  for (const key of Object.keys(preset.params ?? {})) {
    if (!op.params.some((s) => s.key === key)) warn(`预设 ${preset.id}: 参数 ${key} 不在操作 ${op.id} 的参数表中`);
  }
  if (preset.model && !op.models?.includes(preset.model)) {
    warn(`预设 ${preset.id}: 模型 ${preset.model} 不在操作 ${op.id} 的模型列表中`);
  }
}

// ---- report ----
console.log(
  `目录校验：${PROVIDERS.length} 个厂商，${OPERATIONS.length} 个操作，${BUILTIN_PRESETS.length} 个内置预设，${FEATURES.length} 个特性。`,
);
for (const w of warnings) console.warn(`⚠ ${w}`);
if (errors.length) {
  for (const e of errors) console.error(`✗ ${e}`);
  console.error(`\n共 ${errors.length} 个错误。`);
  process.exit(1);
}
console.log('✓ 全部通过。');
