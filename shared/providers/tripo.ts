import type { OperationDef, ParamSpec, ProviderDef } from '../types.ts';
import { applyParams } from '../util.ts';

const docs = 'https://developers.tripo3d.ai/en/docs/generation-text-to-model/standard';
const verification = {
  status: 'documented' as const,
  date: '2026-10-22',
  source: docs,
  note: '已核对原生 V3 文档；未进行付费 3D 实测。',
};

export const tripoProvider: ProviderDef = {
  id: 'tripo',
  name: 'Tripo',
  kind: 'official',
  region: 'global',
  description: '原生文本到 3D：网格面数、几何种子与 PBR 材质独立控制，异步产物保存后可在本机旋转查看。',
  baseUrls: [{ id: 'v3', label: 'V3 API', url: 'https://openapi.tripo3d.ai/v3' }],
  auth: { type: 'bearer' },
  keyEnv: ['TRIPO_API_KEY'],
  docsUrl: docs,
  consoleUrl: 'https://developers.tripo3d.ai/en/keys',
  models: [{ id: 'v3.1-20260211', modalities: ['text-in', 'model3d-out'], developer: 'Tripo', verification }],
  highlights: ['几何 / 纹理种子', '网格面数', 'PBR 材质', '本地 GLB 预览'],
  notes: ['需 Tripo API 额度。模型下载 URL 有时效，任务完成后会立即保存到本地。'],
};

const params: ParamSpec[] = [
  {
    key: 'face_limit',
    label: '目标网格面数',
    type: 'integer',
    min: 500,
    max: 1500000,
    default: 30000,
    native: true,
    group: '几何',
  },
  { key: 'model_seed', label: '几何种子', type: 'integer', min: 0, default: 42, native: true, group: '几何' },
  {
    key: 'geometry_quality',
    label: '几何质量',
    type: 'enum',
    options: [{ value: 'standard' }, { value: 'detailed', label: 'Ultra，成本更高' }],
    default: 'standard',
    native: true,
    group: '几何',
  },
  { key: 'texture', label: '生成纹理', type: 'boolean', default: true, native: true, group: '材质' },
  {
    key: 'pbr',
    label: 'PBR 材质',
    type: 'boolean',
    default: true,
    native: true,
    description: '启用 PBR 会由服务端强制启用 texture。',
    group: '材质',
  },
  { key: 'texture_seed', label: '纹理种子', type: 'integer', min: 0, default: 42, native: true, group: '材质' },
  {
    key: 'texture_quality',
    label: '纹理质量',
    type: 'enum',
    options: ['standard', 'detailed', 'extreme'].map((value) => ({ value })),
    default: 'standard',
    native: true,
    group: '材质',
  },
];

export const tripoOps: OperationDef[] = [
  {
    id: 'tripo.text-to-model',
    providerId: 'tripo',
    title: '文本到 3D · 网格与材质实验',
    summary: '从描述创建真实 GLB 模型；控制面数与几何 / 纹理种子，观察 PBR 材质。',
    features: ['model3d'],
    workbench: 'model3d',
    lifecycle: 'async-task',
    protocol: 'json',
    models: ['v3.1-20260211'],
    defaultModel: 'v3.1-20260211',
    freeModel: true,
    inputFields: ['prompt', 'negative'],
    inputHints: { prompt: '最多 1024 字符；描述物体形状、材质与风格。' },
    params,
    verification,
    docsUrl: docs,
    costTier: 'high',
    costHint: '消耗 Tripo 账户积分，几何与纹理质量会影响费用；本项目不将积分伪装成人民币报价。确认后才创建任务。',
    notes: [
      '下载结果按官方 output.model_url 保存。GLB 支持本地旋转、缩放与动画；其他格式可下载查看。',
      '取消仅停止本地跟踪，远程任务可能继续计费。',
    ],
    build(ctx) {
      const prompt = String(ctx.input.prompt ?? '');
      const negative = String(ctx.input.negative ?? '');
      if (prompt.length > 1024 || negative.length > 255)
        throw new Error('Tripo 描述最多 1024 字符，反向提示词最多 255 字符');
      const body: Record<string, unknown> = { model: ctx.model, prompt };
      if (negative) body.negative_prompt = negative;
      applyParams(body, params, ctx.params, ctx.model);
      return { method: 'POST', path: '/generation/text-to-model', body };
    },
    async: {
      idPath: 'data.task_id',
      poll: { method: 'GET', path: '/tasks/{id}' },
      statusPath: 'data.status',
      statusMap: {
        queued: 'pending',
        running: 'running',
        success: 'succeeded',
        failed: 'failed',
        cancelled: 'cancelled',
        banned: 'failed',
        expired: 'failed',
      },
      intervalMs: 5000,
      progressPath: 'data.progress',
      errorPath: 'data.error',
      resultTtlNote: '下载链接约 5 分钟过期；完成后自动保存到本机。',
      results: (body) => [
        ...(body?.data?.output?.model_url
          ? [
              {
                kind: 'model3d' as const,
                url: body.data.output.model_url,
                mime: 'model/gltf-binary',
                filename: 'tripo-model.glb',
              },
            ]
          : []),
        ...(body?.data?.output?.rendered_image_url
          ? [{ kind: 'image' as const, url: body.data.output.rendered_image_url, filename: 'tripo-preview.png' }]
          : []),
      ],
    },
  },
];
