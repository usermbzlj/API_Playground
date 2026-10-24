import type { FeatureCategory, OperationDef } from '../../shared/types.ts';

/** Discovery routes describe experiments, not additional adapter support. */
export const ATLAS_ROUTES = [
  {
    id: 'language',
    title: '拆开语言与推理',
    subtitle: 'THINK · GENERATE',
    description: '控制思考预算、观察候选 Token，再试试结构化输出和前缀续写。',
    input: '提示词 / 上下文',
    output: '正文 / 推理 / 概率',
    categories: ['text', 'reasoning'] as FeatureCategory[],
    features: ['reasoning', 'logprobs', 'prefix', 'json-output'],
    note: '固定提示词与输出上限，再比较推理强度。部分参数会被模型忽略。',
  },
  {
    id: 'code',
    title: '走进代码的中间',
    subtitle: 'COMPLETE · EDIT',
    description: '给代码一个前缀和后缀，让原生补全接口填上缺口；与普通对话做对照。',
    input: '代码前缀 + 后缀',
    output: '中间补全 / 编辑',
    categories: ['code'] as FeatureCategory[],
    features: ['fim', 'next-edit', 'predicted-output'],
    note: 'FIM 与 Assistant 预填是两种协议；请查看实验台的原生请求。',
  },
  {
    id: 'voice',
    title: '让声音有表现力',
    subtitle: 'SPEAK · LISTEN',
    description: '尝试音色、韵律和情绪控制，或从一段音频开始识别、实时对话。',
    input: '文本 / 音频 / 麦克风',
    output: '音频 / 转写 / 语音流',
    categories: ['audio', 'realtime'] as FeatureCategory[],
    features: ['tts', 'asr', 'realtime-voice', 'voice-design', 'tts-stream'],
    note: '音色权限、音频格式和采样率依服务而异；实时接口需麦克风授权。',
  },
  {
    id: 'visual',
    title: '读懂与创作图像',
    subtitle: 'SEE · CREATE',
    description: '从图片问答进入视觉理解，再探索文字生图、参考图和局部编辑。',
    input: '文字 / 图片 / 蒙版',
    output: '视觉回答 / 图像',
    categories: ['vision', 'image'] as FeatureCategory[],
    features: ['vision', 'image-gen', 'image-edit'],
    note: '视觉理解和图像生成需要不同入口；输入字段以每个适配器为准。',
  },
  {
    id: 'spatial',
    title: '从一帧走向时空',
    subtitle: 'MOVE · BUILD',
    description: '比较首尾帧视频与文生视频，跟踪异步任务，或生成可以旋转查看的 3D 资产。',
    input: '提示词 / 首尾帧 / 参考图',
    output: '视频 / 3D 资产',
    categories: ['video', '3d'] as FeatureCategory[],
    features: ['video-gen', 'video-keyframes', 'model3d'],
    note: '这类接口通常异步且成本较高；产物链接可能过期，请及时保存。',
  },
  {
    id: 'tools',
    title: '连接工具与知识',
    subtitle: 'CALL · RETRIEVE',
    description: '检查函数调用的参数与回合，观察搜索引用，或用向量和重排理解检索。',
    input: '工具声明 / 文档 / 查询',
    output: '工具调用 / 引用 / 向量',
    categories: ['tools', 'embedding', 'meta'] as FeatureCategory[],
    features: ['tools', 'builtin-search', 'embedding', 'rerank'],
    note: '声明工具不会自动执行本地函数；使用工具结果继续回合时检查真实返回。',
  },
] as const;

export type AtlasRoute = (typeof ATLAS_ROUTES)[number];

export function routeMatchesOperation(
  route: AtlasRoute,
  op: OperationDef,
  featureCategories: Map<string, FeatureCategory>,
) {
  const ids: readonly string[] = route.features;
  const categories: readonly FeatureCategory[] = route.categories;
  return op.features.some(
    (id) => ids.includes(id) || (featureCategories.has(id) && categories.includes(featureCategories.get(id)!)),
  );
}
