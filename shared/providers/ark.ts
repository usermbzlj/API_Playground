import type { ArtifactRef, OperationDef, ParamSpec, ProviderDef } from '../types.ts';
import { chatOperation, TOOLS, RESPONSE_FORMAT } from './_common.ts';
import { applyParams } from '../util.ts';
import { documented, enumOptions } from './native-evidence.ts';

const DOC = 'https://api.volcengine.com/api-docs/view?action=DescribeBaasAIModels&serviceCode=aidap&version=2025-10-01';
const PARAMS = 'https://docs.volcengine.com/docs/ark/model-deprecation-migration-guide?lang=en';
const VIDEO = 'https://docs.volcengine.com/docs/ark/create-video-generation-task-api';
const IMAGE = 'https://docs.volcengine.com/docs/ark/image-generation-api';
const models = ['doubao-seed-2-0-pro-260215', 'doubao-seed-2-0-lite-260428'];
const videoModels = ['doubao-seedance-2-5-260628', 'doubao-seedance-2-0-260128'];
const imageModels = ['doubao-seedream-5-0-pro-260628'];
export const arkProvider: ProviderDef = {
  id: 'ark',
  name: '豆包 / 火山方舟',
  kind: 'cloud',
  region: 'cn',
  description: '豆包 Seed 原生推理档位与视觉理解，以及 Seedance 异步视频、Seedream 原生图像生成。',
  baseUrls: [{ id: 'beijing', label: '北京', url: 'https://ark.cn-beijing.volces.com' }],
  auth: { type: 'bearer' },
  keyEnv: ['ARK_API_KEY'],
  docsUrl: DOC,
  consoleUrl: 'https://console.volcengine.com/ark/',
  models: [
    ...models.map((id) => ({ id, modalities: ['text-in', 'image-in', 'text-out'], verification: documented(DOC) })),
    ...videoModels.map((id) => ({
      id,
      modalities: ['text-in', 'image-in', 'video-out'],
      verification: documented(VIDEO),
    })),
    ...imageModels.map((id) => ({
      id,
      modalities: ['text-in', 'image-in', 'image-out'],
      verification: documented(IMAGE),
    })),
  ],
  highlights: ['thinking.type', 'reasoning_effort', '模型 / 接入点区分', 'Seedance 视频', 'Seedream 图像'],
  notes: [
    '模型必须在当前账户开通；接入点 ID 对应的具体模型与参数支持范围由控制台决定。',
    'Seedance 2.5/2.0 通常要求账户余额 >200 元或已购买资源包；提交前请自行确认。',
  ],
};
const videoParams: ParamSpec[] = [
  {
    key: 'resolution',
    label: '分辨率',
    type: 'enum',
    options: enumOptions(['480p', '720p', '1080p']),
    default: '720p',
    enabledByDefault: true,
    group: '视频',
    description: 'Seedance 2.0 还支持 4k；可用范围以模型页为准。',
  },
  {
    key: 'ratio',
    label: '画幅比例',
    type: 'enum',
    options: enumOptions(['16:9', '4:3', '1:1', '3:4', '9:16', '21:9', 'adaptive']),
    default: '16:9',
    enabledByDefault: true,
    group: '画面',
  },
  {
    key: 'duration',
    label: '时长（秒）',
    type: 'integer',
    min: 4,
    max: 30,
    default: 5,
    enabledByDefault: true,
    group: '视频',
    description: 'Seedance 2.5 为 4–30 秒；2.0 为 4–15 秒。',
  },
  {
    key: 'generate_audio',
    label: '生成音频',
    type: 'boolean',
    default: false,
    native: true,
    group: '音频',
    description: '让视频生成匹配音轨；是否支持取决于所选模型。',
  },
  { key: 'watermark', label: '水印', type: 'boolean', default: false, group: '画面', advanced: true },
];

const imageParams: ParamSpec[] = [
  {
    key: 'size',
    label: '输出尺寸',
    type: 'enum',
    options: enumOptions(['1K', '1.5K', '2K']),
    default: '2K',
    enabledByDefault: true,
    group: '画面',
    description: '也可在原始请求中填写具体宽高；此适配只开放 1K/1.5K/2K。',
  },
  {
    key: 'response_format',
    label: '返回格式',
    type: 'enum',
    options: enumOptions(['url', 'b64_json']),
    default: 'url',
    enabledByDefault: true,
    group: '产物',
    description: 'url 约 24 小时有效；b64_json 直接返回图像字节。',
  },
  { key: 'watermark', label: '水印', type: 'boolean', default: true, group: '画面', advanced: true },
];

export const arkOps: OperationDef[] = [
  chatOperation({
    id: 'ark.chat',
    providerId: 'ark',
    title: '豆包 Seed 推理档位 / 视觉',
    path: '/api/v3/chat/completions',
    summary: '保留原生 thinking.type、reasoning_effort 与 reasoning_content；可观察实际思考 Token 用量。',
    models,
    defaultModel: models[0],
    features: ['chat', 'reasoning', 'vision', 'tools', 'json-output', 'cache'],
    params: [
      {
        key: 'thinking.type',
        label: '思考开关',
        type: 'enum',
        options: enumOptions(['enabled', 'disabled']),
        default: 'enabled',
        native: true,
        enabledByDefault: true,
        group: '思考',
        verification: documented(PARAMS),
      },
      {
        key: 'reasoning_effort',
        label: '推理档位',
        type: 'enum',
        options: enumOptions(['minimal', 'low', 'medium', 'high']),
        default: 'medium',
        enabledByDefault: true,
        native: true,
        group: '思考',
        description: 'minimal 为不思考；模型/接入点支持范围以控制台为准。',
      },
      {
        key: 'max_completion_tokens',
        label: '总输出上限（含推理）',
        type: 'integer',
        min: 1,
        max: 65536,
        default: 2048,
        group: '长度',
        description: '含回答与思维链；不可和 max_tokens 同时设置。',
      },
      TOOLS,
      RESPONSE_FORMAT,
    ],
    verification: documented(DOC),
    docsUrl: DOC,
    build: { includeUsage: true },
    notes: [
      'Seed 2.0 Pro 文档指定采样固定为 temperature=1、top_p=0.95，本适配不显示无效采样旋钮。',
      '输入自定义 ep- 接入点后，先核对其模型版本，避免误用档位。',
    ],
  }),
  {
    id: 'ark.video',
    providerId: 'ark',
    title: 'Seedance 异步视频',
    summary:
      '方舟内容生成任务：content 数组里放文本与首/尾帧，按 Seedance 2.5 的分辨率、比例和时长创建任务，完成后保存 MP4。',
    features: ['video-gen', 'video-keyframes'],
    workbench: 'video',
    lifecycle: 'async-task',
    protocol: 'json',
    models: videoModels,
    defaultModel: videoModels[0],
    inputFields: ['prompt', 'firstFrame', 'lastFrame'],
    inputHints: {
      prompt: '与首/尾帧至少提供一个；Seedance 2.5 支持 4–30 秒。',
      firstFrame: '可选首帧；图片以 Base64 data URL 进入 content。',
      lastFrame: '可选尾帧。',
    },
    params: videoParams,
    async: {
      idPath: 'id',
      poll: { method: 'GET', path: '/api/v3/contents/generations/tasks/{id}' },
      statusPath: 'status',
      statusMap: {
        queued: 'pending',
        running: 'running',
        succeeded: 'succeeded',
        failed: 'failed',
        cancelled: 'cancelled',
        expired: 'failed',
      },
      intervalMs: 10000,
      errorPath: 'error',
      results: (poll) => {
        const url = poll?.content?.video_url;
        return typeof url === 'string' && url
          ? [{ kind: 'video', url, mime: 'video/mp4', filename: 'seedance.mp4' }]
          : [];
      },
      resultTtlNote: 'video_url 约 24 小时有效；任务结果保留 7 天。成功后立即下载到本地素材库。',
    },
    costTier: 'high',
    costHint: '按分辨率与时长计费；Seedance 2.5/2.0 常要求余额 >200 元或资源包，提交前请确认。',
    verification: documented(VIDEO, '2026-10-25 核对方舟视频任务文档；未真实调用，开通与计费待确认'),
    docsUrl: VIDEO,
    build: (ctx) => {
      const prompt = String(ctx.input.prompt ?? '');
      const content: any[] = [];
      if (prompt.trim()) content.push({ type: 'text', text: prompt });
      if (ctx.input.firstFrame)
        content.push({
          type: 'image_url',
          image_url: { url: { $asset: String(ctx.input.firstFrame), as: 'dataUrl' } },
          role: 'first_frame',
        });
      if (ctx.input.lastFrame)
        content.push({
          type: 'image_url',
          image_url: { url: { $asset: String(ctx.input.lastFrame), as: 'dataUrl' } },
          role: 'last_frame',
        });
      const body: any = { model: ctx.model, content };
      applyParams(body, videoParams, ctx.params, ctx.model);
      return { method: 'POST', path: '/api/v3/contents/generations/tasks', body };
    },
    notes: [
      'content 使用 type=text / image_url；参考图角色是 first_frame、last_frame 或 reference_image。',
      'seed / camera_fixed 属于 Seedance 1.0 的参数，2.5 不在目录中显示这两个旋钮。',
      '任务状态 queued / running / cancelled / succeeded / failed / expired；没有伪造取消接口。',
    ],
  },
  {
    id: 'ark.image',
    providerId: 'ark',
    title: 'Seedream 原生图像生成',
    summary: '方舟同步图像接口：提示词与参考图进入原生 image 字段，可选 1K/1.5K/2K、URL 或 Base64 产物与水印。',
    features: ['image-gen', 'image-edit'],
    workbench: 'image',
    lifecycle: 'http',
    protocol: 'json',
    models: imageModels,
    defaultModel: imageModels[0],
    inputFields: ['prompt', 'images'],
    inputHints: {
      prompt: '描述要生成的画面；参考图进入 image 字段。',
      images: '参考图支持 URL 或 Base64；本地图片会以内联数据发送。',
    },
    params: imageParams,
    costTier: 'medium',
    costHint: '按尺寸/张数计费；账户实际价格未核验。',
    verification: documented(IMAGE, '2026-10-25 核对 Seedream 5.0 图像文档；未真实调用'),
    docsUrl: IMAGE,
    build: (ctx) => {
      const images = (ctx.input.images ?? []) as string[];
      const body: any = { model: ctx.model, prompt: String(ctx.input.prompt ?? '') };
      if (images.length) body.image = images.map((id) => ({ $asset: String(id), as: 'dataUrl' }));
      applyParams(body, imageParams, ctx.params, ctx.model);
      return { method: 'POST', path: '/api/v3/images/generations', body };
    },
    artifacts: (response): ArtifactRef[] => {
      const list = Array.isArray(response?.data) ? response.data : [];
      return list.flatMap((d: any, i: number) => {
        if (typeof d?.b64_json === 'string' && d.b64_json)
          return [{ kind: 'image' as const, base64: d.b64_json, mime: 'image/png', filename: `seedream-${i + 1}.png` }];
        if (typeof d?.url === 'string' && d.url)
          return [{ kind: 'image' as const, url: d.url, mime: 'image/png', filename: `seedream-${i + 1}.png` }];
        return [];
      });
    },
    notes: [
      'response_format 为 url 时链接约 24 小时失效；成功后立即保存到本地素材库。',
      '官方文档未列出 Seedream 5.0 的 seed 字段，本适配不显示随机种子。',
      '水印默认开启，可在参数中关闭；是否允许关闭以账户与官方策略为准。',
    ],
  },
];
