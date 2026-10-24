import type { AsyncSpec, ModelDef, OperationDef, ParamSpec } from '../types.ts';
import { applyParams } from '../util.ts';
import { documented, enumOptions } from './native-evidence.ts';

// MiniMax 视频 v2（Hailuo H3 系列）。旧的 /v1/video_generation 与 Hailuo 2.3 / 02 仍保留在
// minimax-video.ts；这里是独立的新端点与内容结构，不能只替换模型名就当成 v2。
const DOC = 'https://platform.minimax.io/docs/api-reference/video-generation-v2-create';

const resolutions = ['480P', '768P', '2K'];
const allowedResolutions: Record<string, string[]> = {
  'MiniMax-H3': ['768P', '2K'],
  'MiniMax-H3-Highspeed': ['768P'],
  'MiniMax-H3-Lite': ['480P', '768P'],
  'MiniMax-H3-Max': ['480P', '768P'],
};

export const minimaxMediaModels: ModelDef[] = [
  {
    id: 'MiniMax-H3',
    modalities: ['text-in', 'image-in', 'video-out'],
    verification: documented(DOC),
    notes: '768P/2K，4–15 秒；首尾帧与参考素材互斥。',
  },
  {
    id: 'MiniMax-H3-Highspeed',
    modalities: ['text-in', 'image-in', 'video-out'],
    verification: documented(DOC),
    notes: '仅 768P，速度优先。',
  },
  {
    id: 'MiniMax-H3-Lite',
    modalities: ['text-in', 'image-in', 'video-out'],
    verification: documented(DOC),
    notes: '480P/768P，成本优先。',
  },
  {
    id: 'MiniMax-H3-Max',
    modalities: ['text-in', 'image-in', 'video-out'],
    verification: documented(DOC),
    notes: '480P/768P，5–15 秒，质量优先。',
  },
];

const params: ParamSpec[] = [
  {
    key: 'resolution',
    label: '分辨率',
    type: 'enum',
    options: enumOptions(resolutions),
    default: '768P',
    enabledByDefault: true,
    group: '视频',
    description: '各型号可选范围不同：H3 支持 768P/2K，Highspeed 仅 768P，Lite/Max 支持 480P/768P。',
  },
  {
    key: 'duration',
    label: '时长（秒）',
    type: 'integer',
    min: 4,
    max: 15,
    default: 6,
    enabledByDefault: true,
    group: '视频',
    description: 'H3 / Highspeed / Lite 为 4–15 秒；H3-Max 为 5–15 秒。以官方模型页为准。',
  },
  {
    key: 'ratio',
    label: '画幅比例',
    type: 'enum',
    options: enumOptions(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9']),
    default: '16:9',
    enabledByDefault: true,
    group: '画面',
    description: '仅文生视频需要；传入首帧/尾帧时由上游固定为 adaptive，本适配不会发送 ratio。',
  },
  {
    key: 'callback_url',
    label: '回调地址',
    type: 'string',
    default: '',
    advanced: true,
    group: '异步',
    description: '可选：任务状态回调。留空则只使用本地轮询。',
  },
];

const asyncSpec: AsyncSpec = {
  idPath: 'task_id',
  poll: { method: 'GET', path: '/v2/query/video_generation/{id}' },
  statusPath: 'task.status',
  statusMap: {
    queued: 'pending',
    running: 'running',
    succeeded: 'succeeded',
    failed: 'failed',
    cancelled: 'cancelled',
  },
  intervalMs: 10000,
  errorPath: 'task.error',
  results: (poll) => {
    const url = poll?.task?.content?.url;
    return typeof url === 'string' && url ? [{ kind: 'video', url, mime: 'video/mp4', filename: 'hailuo-h3.mp4' }] : [];
  },
  resultTtlNote:
    'v2 产物是限时直链，且任务仅在创建后 7 天内可查询；服务端成功后立即下载到本地。停止本地跟踪不等于取消远端生成。',
};

export const minimaxMediaOps: OperationDef[] = [
  {
    id: 'minimax.video-v2',
    providerId: 'minimax',
    title: 'Hailuo H3 视频（v2 内容结构）',
    summary:
      '原生 POST /v2/video_generation：content 里放文本与首/尾帧，支持 H3 系列分辨率与 4–15 秒时长；异步查询任务直链后保存视频。',
    features: ['video-gen', 'video-keyframes'],
    workbench: 'video',
    lifecycle: 'async-task',
    protocol: 'json',
    models: minimaxMediaModels.map((m) => m.id),
    defaultModel: 'MiniMax-H3',
    inputFields: ['prompt', 'firstFrame', 'lastFrame'],
    inputHints: {
      prompt: '必填，最多 7000 字符。v2 没有独立 camera 字段，运镜写在提示词里，例如 [pan]、[zoom]、[static]。',
      firstFrame: '可选。图片必须是本地文件（Base64 data URI）或公网 URL；与参考素材互斥。',
      lastFrame: '可选。与首帧同时使用构成首尾帧；具体型号支持范围以官方文档为准。',
    },
    params,
    async: asyncSpec,
    costTier: 'high',
    costHint: '提交即可能计费；H3 系列按分辨率与时长计价，账户实际价格未核验，显示未知。',
    verification: documented(DOC, '2026-10-25 核对 v2 官方文档；未使用真实 Key 实测，型号权限与计费待确认'),
    docsUrl: DOC,
    build: (ctx) => {
      const prompt = String(ctx.input.prompt ?? '');
      if (prompt.length > 7000) throw new Error('Hailuo H3 视频提示词最多 7000 字符');
      const first = ctx.input.firstFrame ? String(ctx.input.firstFrame) : '';
      const last = ctx.input.lastFrame ? String(ctx.input.lastFrame) : '';
      const content: any[] = [{ type: 'text', text: prompt }];
      if (first)
        content.push({ type: 'image_url', image_url: { url: { $asset: first, as: 'dataUrl' } }, role: 'first_frame' });
      if (last)
        content.push({ type: 'image_url', image_url: { url: { $asset: last, as: 'dataUrl' } }, role: 'last_frame' });
      const body: any = { model: ctx.model, content, resolution: '768P', duration: 6 };
      applyParams(body, params, ctx.params, ctx.model);
      const allowed = allowedResolutions[ctx.model];
      if (allowed && !allowed.includes(String(body.resolution)))
        throw new Error(`${ctx.model} 不支持 ${body.resolution}，可选：${allowed.join(' / ')}`);
      if (ctx.model === 'MiniMax-H3-Max' && Number(body.duration) < 5) throw new Error('H3-Max 最短 5 秒');
      if (body.callback_url === '') delete body.callback_url;
      // 图生视频时上游把比例固定为 adaptive；不发送 ratio，避免伪造一个被忽略的参数。
      if (first || last) delete body.ratio;
      return { method: 'POST', path: '/v2/video_generation', body };
    },
    notes: [
      'v2 与 v1 的内容结构不同：文本与图片在 content 数组里，图片用 role 标注 first_frame / last_frame。',
      'v2 没有单独的 camera 参数；[Push in] 等运镜指令属于旧版提示词语法，v2 请使用官方当前运镜写法。',
      '首尾帧与 reference_image / reference_video / reference_audio 互斥，本操作只开放首尾帧。',
      '任务创建后 7 天内可查询；产物直链有时效，成功后本项目立即保存到本地素材。',
    ],
  },
];
