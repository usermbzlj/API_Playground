// 中央注册表：厂商、操作、特性与内置预设。
// 新增一个厂商 = 在 shared/providers/ 下加一个文件，并在这里注册。
import type { AsyncSpec, FeatureDef, OperationDef, PresetDef, ProviderDef } from './types.ts';
import { FEATURES } from './features.ts';
import { deepseekOps, deepseekProvider } from './providers/deepseek.ts';
import { minimaxOps, minimaxProvider } from './providers/minimax.ts';

export const PROVIDERS: ProviderDef[] = [deepseekProvider, minimaxProvider];

export const OPERATIONS: OperationDef[] = [...deepseekOps, ...minimaxOps];

export const BUILTIN_PRESETS: PresetDef[] = [
  {
    id: 'preset-deepseek-fim-ts',
    operationId: 'deepseek.fim',
    title: '补全 TypeScript 函数体',
    description: '经典 FIM 场景：已知函数签名和调用代码，补出中间实现。',
    input: {
      prefix: 'function twoSum(nums: number[], target: number): number[] | null {\n  ',
      suffix: '\n}\n\nconsole.log(twoSum([2, 7, 11, 15], 9));',
      stream: true,
    },
    params: { max_tokens: 256, temperature: 0.2 },
    tags: ['代码', '入门'],
  },
  {
    id: 'preset-deepseek-prefix-json',
    operationId: 'deepseek.chat',
    title: '前缀续写：强制输出 JSON',
    description: '预先写好 Assistant 开头，强制模型从 "```json\\n{" 接着写。',
    input: {
      system: '你是一个信息抽取助手，只输出 JSON。',
      messages: [{ role: 'user', content: '从下面文本抽取姓名和城市：张三住在邵阳。' }],
      prefix: '```json\n{',
      stream: true,
    },
    params: { temperature: 0.3 },
    tags: ['前缀续写', '入门'],
  },
  {
    id: 'preset-deepseek-reasoner',
    operationId: 'deepseek.chat',
    title: '思考模型对比',
    description: '用 deepseek-reasoner 跑同一道题，再切回 deepseek-chat 跑一次，对比输出、耗时与用量。',
    model: 'deepseek-reasoner',
    input: {
      system: '',
      messages: [
        {
          role: 'user',
          content: '一个水池有甲、乙两根进水管和一根排水管。单开甲管 5 小时注满，单开乙管 10 小时注满，单开排水管 6 小时放完。三管同开，几小时注满？请给出计算过程。',
        },
      ],
      stream: true,
    },
    tags: ['推理', '对比'],
  },
  {
    id: 'preset-minimax-tts-audiobook',
    operationId: 'minimax.tts',
    title: '有声书片段',
    description: '用预置音色朗读一段文字；可在参数面板调整语速、音量与音频格式。',
    input: { text: '夜色像一块深蓝色的丝绒，轻轻盖在小城上方。只有江边的渔火，还醒着。' },
    params: { 'voice_setting.voice_id': 'male-qn-qingse', 'audio_setting.format': 'mp3', stream: false },
    tags: ['语音', '入门'],
  },
  {
    id: 'preset-minimax-tts-emotion',
    operationId: 'minimax.tts',
    title: '同一句话，两种情绪',
    description: '复制本预设运行两次，分别把 emotion 设为 happy 与 sad，对比语音表现（需要支持情绪的模型）。',
    input: { text: '我真的没想到，你会在这里出现。' },
    params: { 'voice_setting.emotion': 'happy' },
    tags: ['语音', '情绪'],
  },
];

const PROVIDER_MAP = new Map(PROVIDERS.map((p) => [p.id, p]));
const OPERATION_MAP = new Map(OPERATIONS.map((o) => [o.id, o]));

export function getProvider(id: string | undefined | null): ProviderDef | undefined {
  return id ? PROVIDER_MAP.get(id) : undefined;
}

export function getOperation(id: string | undefined | null): OperationDef | undefined {
  return id ? OPERATION_MAP.get(id) : undefined;
}

export function listOperations(providerId?: string): OperationDef[] {
  return providerId ? OPERATIONS.filter((o) => o.providerId === providerId) : OPERATIONS;
}

export function operationsForFeature(featureId: string): OperationDef[] {
  return OPERATIONS.filter((o) => o.features.includes(featureId));
}

export function getFeature(id: string): FeatureDef | undefined {
  return FEATURES.find((f) => f.id === id);
}

/** 去掉函数字段的操作定义，用于通过 HTTP 传给前端。 */
export type SerializedOperation = Omit<OperationDef, 'build' | 'artifacts' | 'async'> & {
  async?: Omit<AsyncSpec, 'results' | 'resolve' | 'resolveResults'>;
};

export function serializeOperation(op: OperationDef): SerializedOperation {
  // 函数字段无法序列化，也不会发给前端（请求由服务端用同一份定义构建）。
  const out: any = { ...op, async: op.async ? { ...op.async } : undefined };
  delete out.build;
  delete out.artifacts;
  if (out.async) {
    delete out.async.results;
    delete out.async.resolve;
    delete out.async.resolveResults;
  }
  return out as SerializedOperation;
}

export function catalogSnapshot() {
  return {
    providers: PROVIDERS,
    operations: OPERATIONS.map(serializeOperation),
    features: FEATURES,
    presets: BUILTIN_PRESETS,
  };
}
