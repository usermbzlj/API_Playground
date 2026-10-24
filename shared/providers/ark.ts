import type { OperationDef, ProviderDef } from '../types.ts';
import { chatOperation, TOOLS, RESPONSE_FORMAT } from './_common.ts';
import { documented, enumOptions } from './native-evidence.ts';

const DOC = 'https://api.volcengine.com/api-docs/view?action=DescribeBaasAIModels&serviceCode=aidap&version=2025-10-01';
const PARAMS = 'https://docs.volcengine.com/docs/ark/model-deprecation-migration-guide?lang=en';
const models = ['doubao-seed-2-0-pro-260215', 'doubao-seed-2-0-lite-260428'];
export const arkProvider: ProviderDef = {
  id: 'ark',
  name: '豆包 / 火山方舟',
  kind: 'cloud',
  region: 'cn',
  description: '豆包 Seed 原生推理档位和视觉理解。可直接使用模型 ID，或输入账户自己的 ep- 推理接入点。',
  baseUrls: [{ id: 'beijing', label: '北京', url: 'https://ark.cn-beijing.volces.com' }],
  auth: { type: 'bearer' },
  keyEnv: ['ARK_API_KEY'],
  docsUrl: DOC,
  consoleUrl: 'https://console.volcengine.com/ark/',
  models: models.map((id) => ({ id, modalities: ['text-in', 'image-in', 'text-out'], verification: documented(DOC) })),
  highlights: ['thinking.type', 'reasoning_effort', '模型 / 接入点区分', '视觉推理'],
  notes: [
    '模型必须在当前账户开通；接入点 ID 对应的具体模型与参数支持范围由控制台决定。',
    '此操作未实现 Seedance 视频接口，不将文本模型品牌能力冒充视频能力。',
  ],
};
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
];
