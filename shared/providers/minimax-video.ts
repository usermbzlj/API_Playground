import type { AsyncSpec, ModelDef, OperationDef, ParamSpec } from '../types.ts';
import { applyParams } from '../util.ts';
import { documented, enumOptions } from './native-evidence.ts';

const DOC = 'https://platform.minimax.io/docs/api-reference/video-generation-t2v';
const KEYFRAMES = 'https://platform.minimax.io/docs/api-reference/video-generation-fl2v';
const params: ParamSpec[] = [
  {
    key: 'duration',
    label: '时长（秒）',
    type: 'enum',
    options: enumOptions([6, 10]),
    default: 6,
    enabledByDefault: true,
    group: '视频',
  },
  {
    key: 'resolution',
    label: '分辨率',
    type: 'enum',
    options: enumOptions(['768P', '1080P']),
    default: '768P',
    enabledByDefault: true,
    group: '视频',
  },
  { key: 'prompt_optimizer', label: '自动优化提示词', type: 'boolean', default: true, native: true, group: '原生策略' },
];
const asyncSpec: AsyncSpec = {
  idPath: 'task_id',
  poll: { method: 'GET', path: '/v1/query/video_generation?task_id={id}' },
  statusPath: 'status',
  statusMap: {
    Preparing: 'pending',
    Queueing: 'pending',
    Processing: 'running',
    Success: 'succeeded',
    Fail: 'failed',
    Failed: 'failed',
  },
  intervalMs: 10000,
  errorPath: 'base_resp.status_msg',
  results: () => [],
  resolve: (poll) =>
    poll?.file_id ? { method: 'GET', path: `/v1/files/retrieve?file_id=${encodeURIComponent(poll.file_id)}` } : null,
  resolveResults: (body) =>
    body?.file?.download_url
      ? [
          {
            kind: 'video',
            url: body.file.download_url,
            mime: 'video/mp4',
            filename: body.file.filename ?? 'hailuo.mp4',
          },
        ]
      : [],
  resultTtlNote: '下载链接通常只有有限有效期；服务端会尽快下载到本地。未提供官方取消端点，停止追踪不等于停止计费。',
};
export const minimaxVideoModels: ModelDef[] = [
  { id: 'MiniMax-Hailuo-2.3', modalities: ['text-in', 'image-in', 'video-out'], verification: documented(DOC) },
  { id: 'MiniMax-Hailuo-02', modalities: ['text-in', 'image-in', 'video-out'], verification: documented(KEYFRAMES) },
];
function operation(keyframes: boolean): OperationDef {
  const doc = keyframes ? KEYFRAMES : DOC;
  return {
    id: keyframes ? 'minimax.video-keyframes' : 'minimax.video',
    providerId: 'minimax',
    title: keyframes ? 'Hailuo 首尾帧视频' : 'Hailuo 文生 / 图生视频',
    summary: '原生异步创建 → 查询 → file_id 换下载地址 → 本地视频；支持提示词中的 [Push in] 等运镜指令。',
    features: keyframes ? ['video-gen', 'video-keyframes'] : ['video-gen'],
    workbench: 'video',
    lifecycle: 'async-task',
    protocol: 'json',
    models: [keyframes ? 'MiniMax-Hailuo-02' : 'MiniMax-Hailuo-2.3'],
    defaultModel: keyframes ? 'MiniMax-Hailuo-02' : 'MiniMax-Hailuo-2.3',
    inputFields: keyframes ? ['prompt', 'firstFrame', 'lastFrame'] : ['prompt', 'firstFrame'],
    inputHints: {
      firstFrame: keyframes ? '必填首帧，可上传图片或公开 URL。' : '可选：添加后转为图生视频。',
      lastFrame: '必填尾帧。首尾帧能力使用 Hailuo-02，不能套用到 2.3。',
    },
    params,
    async: asyncSpec,
    costTier: 'high',
    costHint: '提交后厂商可能立即计费；本地取消追踪不能撤销远端生成。未核验当前账户视频价格。',
    verification: documented(doc),
    docsUrl: doc,
    build: (ctx) => {
      const body: any = { model: ctx.model, prompt: String(ctx.input.prompt ?? ''), duration: 6, resolution: '768P' };
      applyParams(body, params, ctx.params, ctx.model);
      if (body.prompt.length > 2000) throw new Error('Hailuo 视频提示词最多 2000 字符');
      if (body.duration === 10 && body.resolution === '1080P')
        throw new Error('Hailuo 1080P 只支持 6 秒；10 秒请选择 768P');
      if (ctx.input.firstFrame) body.first_frame_image = { $asset: String(ctx.input.firstFrame), as: 'dataUrl' };
      if (keyframes && ctx.input.lastFrame)
        body.last_frame_image = { $asset: String(ctx.input.lastFrame), as: 'dataUrl' };
      return { method: 'POST', path: '/v1/video_generation', body };
    },
    notes: [
      'MiniMax 国内与国际站账户分离，请匹配连接域名和 Key。',
      '本适配使用官方仍提供的 Hailuo v1 接口；H3 v2 另有内容结构，没有将模型名称替换成 H3。',
      '官方此接口采用 Bearer 鉴权，没有在文档中要求 GroupId，因此不附加该参数。',
    ],
  };
}
export const minimaxVideoOps = [operation(false), operation(true)];
