import type {
  ArtifactRef,
  BuildContext,
  OperationDef,
  ParamSpec,
  ProviderDef,
  TraceEvent,
  Verification,
} from '../types.ts';
import type { ChatView } from '../protocols.ts';
import { applyParams } from '../util.ts';

const API = 'https://ai.google.dev/api/generate-content';
const MODELS = 'https://ai.google.dev/gemini-api/docs/models';
const SPEECH = 'https://ai.google.dev/gemini-api/docs/speech-generation';
const IMAGE = 'https://ai.google.dev/gemini-api/docs/image-generation';
const EMBED = 'https://ai.google.dev/api/embeddings';
const verifiedDocs = (source: string): Verification => ({
  status: 'documented',
  date: '2026-10-24',
  source,
  note: '已核对官方文档；没有用真实 Key 调用，账户、地区、模型权限与参数组合待实测。',
});
const choices = (values: string[]) => values.map((value) => ({ value }));
const chatModels = ['gemini-3.8-flash', 'gemini-4-argon'];
const ttsModels = ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'];
const imageModels = ['gemini-3.1-flash-image', 'gemini-3-pro-image', 'gemini-nano-banana-2.1'];
const embeddingModels = ['gemini-embedding-2', 'gemini-embedding-001'];

export const geminiProvider: ProviderDef = {
  id: 'gemini',
  name: 'Google Gemini',
  kind: 'official',
  region: 'global',
  description: '原生 generateContent：多模态对话、思考摘要、函数工具、搜索接地，以及带说话人元数据的语音合成。',
  baseUrls: [{ id: 'official', label: 'Gemini Developer API', url: 'https://generativelanguage.googleapis.com' }],
  auth: { type: 'header', header: 'x-goog-api-key' },
  keyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  docsUrl: API,
  consoleUrl: 'https://aistudio.google.com/api-keys',
  pricingUrl: 'https://ai.google.dev/gemini-api/docs/pricing',
  modelsPath: '/v1beta/models',
  models: [
    ...chatModels.map((id) => ({
      id,
      developer: 'Google',
      modalities: ['text-in', 'image-in', 'text-out'],
      capabilities: ['chat', 'vision', 'reasoning', 'tools', 'builtin-search', 'json-output'],
      verification: verifiedDocs(MODELS),
    })),
    ...ttsModels.map((id) => ({
      id,
      developer: 'Google',
      modalities: ['text-in', 'audio-out'],
      capabilities: ['tts'],
      verification: verifiedDocs(SPEECH),
    })),
    ...imageModels.map((id) => ({
      id,
      developer: 'Google',
      modalities: ['text-in', 'image-in', 'image-out'],
      capabilities: ['image-gen', 'image-edit'],
      verification: verifiedDocs(IMAGE),
    })),
    ...embeddingModels.map((id) => ({
      id,
      developer: 'Google',
      modalities: ['text-in'],
      capabilities: ['embedding'],
      verification: verifiedDocs(EMBED),
    })),
  ],
  highlights: [
    '原生 SSE 与非流式响应',
    'thoughtSignature 原样续传',
    '真实 groundingMetadata 引用',
    '单人 / 多人 TTS 与 WAV 产物',
  ],
  notes: [
    '模型 ID 可以手动输入；目录只是文档线索，不代表本账户已开通。',
    '使用 Gemini Developer API Key；此入口没有适配 Vertex AI OAuth、Interactions 或 Live WebSocket。',
  ],
};

const chatParams: ParamSpec[] = [
  {
    key: 'generationConfig.maxOutputTokens',
    label: '输出 Token 上限',
    type: 'integer',
    min: 1,
    default: 2048,
    enabledByDefault: true,
    group: '长度',
  },
  {
    key: 'generationConfig.temperature',
    label: 'temperature',
    type: 'number',
    min: 0,
    max: 2,
    step: 0.05,
    default: 1,
    group: '采样',
  },
  {
    key: 'generationConfig.topP',
    label: 'topP',
    type: 'number',
    min: 0,
    max: 1,
    step: 0.01,
    default: 0.95,
    group: '采样',
  },
  { key: 'generationConfig.topK', label: 'topK', type: 'integer', min: 1, default: 40, group: '采样', advanced: true },
  {
    key: 'generationConfig.stopSequences',
    label: '停止序列',
    type: 'string-list',
    default: [],
    group: '长度',
    advanced: true,
  },
  {
    key: 'generationConfig.thinkingConfig.thinkingLevel',
    label: '原生思考档位',
    type: 'enum',
    options: choices(['MINIMAL', 'LOW', 'MEDIUM', 'HIGH']),
    default: 'LOW',
    group: '思考',
    native: true,
    description: '只在启用时发送；模型支持的档位可能不同。与 thinkingBudget 二选一。',
  },
  {
    key: 'generationConfig.thinkingConfig.thinkingBudget',
    label: '旧模型思考预算',
    type: 'integer',
    min: -1,
    default: 1024,
    group: '思考',
    native: true,
    advanced: true,
    description: '仅供手动输入支持预算的旧模型；不要与 thinkingLevel 同时启用。',
  },
  {
    key: 'generationConfig.thinkingConfig.includeThoughts',
    label: '返回可用思考摘要',
    type: 'boolean',
    default: true,
    group: '思考',
    native: true,
    description: '只显示响应里实际返回的 thought 文本；没有返回时不会生成替代说明。',
  },
  {
    key: 'tools',
    label: '原生工具声明',
    type: 'json',
    default: [
      {
        functionDeclarations: [
          {
            name: 'get_weather',
            description: '查询城市天气',
            parameters: { type: 'OBJECT', properties: { city: { type: 'STRING' } }, required: ['city'] },
          },
        ],
      },
    ],
    group: '工具',
    native: true,
    description:
      'Gemini Tool 数组。搜索使用 [{"googleSearch":{}}]；代码执行使用 [{"codeExecution":{}}]。本地不会自动执行函数。',
  },
  {
    key: 'toolConfig.functionCallingConfig.mode',
    label: '函数调用模式',
    type: 'enum',
    options: choices(['AUTO', 'ANY', 'NONE', 'VALIDATED']),
    default: 'AUTO',
    group: '工具',
    native: true,
    advanced: true,
  },
  {
    key: 'generationConfig.responseFormat.text',
    label: '原生结构化输出',
    type: 'json',
    default: {
      mimeType: 'APPLICATION_JSON',
      schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] },
    },
    group: '输出格式',
    native: true,
    description: '当前 REST responseFormat.text；旧模型若不支持，可在原始请求中使用其文档对应字段。',
  },
  {
    key: 'generationConfig.responseLogprobs',
    label: '返回真实 Token 概率',
    type: 'boolean',
    default: true,
    group: 'Token 概率',
    advanced: true,
  },
  {
    key: 'generationConfig.logprobs',
    label: '候选 Token 数',
    type: 'integer',
    min: 0,
    max: 20,
    default: 5,
    group: 'Token 概率',
    advanced: true,
  },
  {
    key: 'safetySettings',
    label: '原生安全阈值',
    type: 'json',
    default: [],
    native: true,
    advanced: true,
    group: '安全',
    description: '由上游服务核验的 SafetySetting 数组；不会改变本地服务的安全边界。',
  },
];

function modelPath(model: string, stream = false) {
  const id = model.replace(/^models\//, '');
  return `/v1beta/models/${encodeURIComponent(id)}:${stream ? 'streamGenerateContent?alt=sse' : 'generateContent'}`;
}

/** Keep native parts intact: signatures and tool results are conversation state. */
export function buildGeminiContents(input: BuildContext['input']): { contents: any[]; systemInstruction?: any } {
  const contents: any[] = [];
  const system: string[] = typeof input.system === 'string' && input.system.trim() ? [input.system] : [];
  const calls = new Map<string, { name: string; id?: string }>();
  for (const m of Array.isArray(input.messages) ? input.messages : []) {
    if (m.role === 'system' || m.role === 'developer') {
      if (m.content) system.push(String(m.content));
      continue;
    }
    if (m.role === 'tool') {
      const call: { name: string; id?: string } = calls.get(m.tool_call_id) ?? { name: m.name };
      if (!call.name) throw new Error('Gemini 工具返回缺少对应函数名称，请保留上一轮工具调用。');
      let response: any;
      try {
        response = JSON.parse(m.content);
      } catch {
        response = { result: String(m.content ?? '') };
      }
      if (!response || typeof response !== 'object' || Array.isArray(response)) response = { result: response };
      const part = { functionResponse: { name: call.name, ...(call.id ? { id: call.id } : {}), response } };
      // Parallel calls belong to the same user turn.
      const prev = contents.at(-1);
      if (prev?.role === 'user' && prev.parts.every((p: any) => p.functionResponse)) prev.parts.push(part);
      else contents.push({ role: 'user', parts: [part] });
      continue;
    }
    let parts: any[];
    if (m.role === 'assistant' && Array.isArray(m.blocks) && m.blocks.length) {
      parts = m.blocks.map((b: any) => (b.type === 'gemini_part' ? b.data : b));
    } else {
      parts = m.content ? [{ text: String(m.content) }] : [];
      if (m.role === 'assistant')
        for (const tc of m.tool_calls ?? []) {
          const fn = tc.function ?? tc;
          let args: any = fn.arguments ?? fn.args ?? {};
          if (typeof args === 'string') args = JSON.parse(args || '{}');
          parts.push({ functionCall: { ...(tc.id ? { id: tc.id } : {}), name: fn.name, args } });
        }
      if (m.role === 'user')
        for (const id of [...(m.images ?? []), ...(m.videos ?? []), ...(m.audio ? [m.audio] : [])])
          parts.push({ inlineData: { $asset: id, as: 'geminiInlineData' } });
    }
    let functionIndex = 0;
    for (const p of parts)
      if (p.functionCall) {
        const fc = p.functionCall;
        const tc = (m.tool_calls ?? [])[functionIndex];
        calls.set(fc.id ?? tc?.id ?? `gemini-tool-${functionIndex}`, {
          name: fc.name,
          ...(fc.id ? { id: fc.id } : {}),
        });
        functionIndex++;
      }
    if (parts.length) contents.push({ role: m.role === 'assistant' ? 'model' : 'user', parts });
  }
  // Empty smoke-test / new conversations remain editable in the workbench.
  if (!contents.length) contents.push({ role: 'user', parts: [{ text: String(input.prompt ?? '') }] });
  return { contents, ...(system.length ? { systemInstruction: { parts: [{ text: system.join('\n\n') }] } } : {}) };
}

/** Reduce only real native fields; there are no estimated timing/probability fallbacks. */
export function reduceGemini(events: TraceEvent[]): ChatView {
  const view: ChatView = {
    kind: 'chat',
    text: '',
    reasoning: '',
    toolCalls: [],
    logprobs: [],
    citations: [],
    extras: {},
    chunks: 0,
    blocks: [],
  };
  const citations = new Set<string>();
  for (const ev of events) {
    if (ev.type !== 'chunk' && ev.type !== 'body') continue;
    const raw = ev.type === 'chunk' ? (ev.data?.data ?? ev.data) : ev.data;
    for (const payload of Array.isArray(raw) ? raw : [raw]) {
      if (!payload || typeof payload !== 'object') continue;
      view.chunks++;
      view.lastMs = ev.t;
      if (payload.modelVersion) view.responseModel = payload.modelVersion;
      if (payload.responseId) view.responseId = payload.responseId;
      if (payload.usageMetadata) {
        const u = payload.usageMetadata;
        view.extras.usageMetadata = { ...(view.extras.usageMetadata ?? {}), ...u };
        const usage: Record<string, any> = { ...(view.usage ?? {}), ...u };
        const mappings = {
          promptTokenCount: 'prompt_tokens',
          candidatesTokenCount: 'completion_tokens',
          totalTokenCount: 'total_tokens',
          cachedContentTokenCount: 'prompt_cache_hit_tokens',
          thoughtsTokenCount: 'reasoning_tokens',
        };
        for (const [native, common] of Object.entries(mappings)) if (u[native] !== undefined) usage[common] = u[native];
        view.usage = usage;
      }
      for (const [k, v] of Object.entries(payload))
        if (!['candidates', 'usageMetadata', 'modelVersion', 'responseId'].includes(k)) view.extras[k] = v;
      const candidates = payload.candidates ?? [];
      // Preserve all candidates in raw extras, but render one coherent conversation.
      if (candidates.length) view.extras.candidates = [...(view.extras.candidates ?? []), ...candidates];
      const candidate = candidates.find((c: any) => c.index === 0) ?? candidates[0];
      if (!candidate) continue;
      if (candidate.finishReason) view.finishReason = candidate.finishReason;
      for (const [k, v] of Object.entries(candidate))
        if (!['content', 'index'].includes(k)) view.extras[`candidate.${k}`] = v;
      for (const part of candidate.content?.parts ?? []) {
        view.blocks.push({ type: 'gemini_part', text: part.text ?? '', data: part });
        if (typeof part.text === 'string') {
          if (part.thought) {
            view.reasoning += part.text;
            view.firstReasoningMs ??= ev.t;
          } else {
            view.text += part.text;
            view.firstTextMs ??= ev.t;
          }
        }
        if (part.functionCall) {
          const fc = part.functionCall;
          const prev = fc.id ? view.toolCalls.find((t) => t.id === fc.id) : undefined;
          if (prev) {
            prev.name = fc.name ?? prev.name;
            prev.args = JSON.stringify(fc.args ?? {});
          } else
            view.toolCalls.push({
              index: view.toolCalls.length,
              id: fc.id ?? `gemini-tool-${view.toolCalls.length}`,
              type: 'function',
              name: fc.name ?? '',
              args: JSON.stringify(fc.args ?? {}),
            });
        }
      }
      const lp = candidate.logprobsResult;
      for (const [i, token] of (lp?.chosenCandidates ?? []).entries())
        view.logprobs.push({
          token: token.token ?? '',
          logprob: token.logProbability,
          top: (lp.topCandidates?.[i]?.candidates ?? []).map((t: any) => ({
            token: t.token,
            logprob: t.logProbability,
          })),
        });
      for (const [i, chunk] of (candidate.groundingMetadata?.groundingChunks ?? []).entries()) {
        const web = chunk.web ?? chunk.retrievedContext;
        if (web?.uri && !citations.has(web.uri)) {
          citations.add(web.uri);
          view.citations.push({ url: web.uri, title: web.title, index: i });
        }
      }
      for (const source of candidate.citationMetadata?.citationSources ?? [])
        if (source.uri && !citations.has(source.uri)) {
          citations.add(source.uri);
          view.citations.push({ url: source.uri, title: source.title });
        }
    }
  }
  return view;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

/** Gemini documents L16 as signed little-endian PCM, unlike generic RFC L16. */
export function geminiPcmToWav(base64: string, mime: string): string {
  const binary = atob(base64);
  if (binary.length % 2) throw new Error('Gemini 返回的 16-bit PCM 字节数不完整。');
  const rate = Number(/(?:^|;)\s*rate=(\d+)/i.exec(mime)?.[1] ?? 24000);
  const channels = Number(/(?:^|;)\s*channels=(\d+)/i.exec(mime)?.[1] ?? 1);
  if (
    !Number.isInteger(rate) ||
    rate < 8000 ||
    rate > 192000 ||
    ![1, 2].includes(channels) ||
    binary.length % (channels * 2)
  )
    throw new Error('Gemini 返回的 PCM 采样参数无效。');
  const bytes = new Uint8Array(44 + binary.length);
  const header = new DataView(bytes.buffer);
  const ascii = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
  };
  ascii(0, 'RIFF');
  header.setUint32(4, bytes.length - 8, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, channels, true);
  header.setUint32(24, rate, true);
  header.setUint32(28, rate * channels * 2, true);
  header.setUint16(32, channels * 2, true);
  header.setUint16(34, 16, true);
  ascii(36, 'data');
  header.setUint32(40, binary.length, true);
  for (let i = 0; i < binary.length; i++) bytes[44 + i] = binary.charCodeAt(i);
  return bytesToBase64(bytes);
}

export function geminiArtifacts(response: any): ArtifactRef[] {
  const out: ArtifactRef[] = [];
  for (const c of response?.candidates ?? [])
    for (const part of c.content?.parts ?? []) {
      const data = part.inlineData;
      if (!data?.data || !data.mimeType) continue;
      const mime = String(data.mimeType);
      if (/^audio\/(?:l16|pcm)(?:;|$)/i.test(mime))
        out.push({
          kind: 'audio',
          mime: 'audio/wav',
          base64: geminiPcmToWav(data.data, mime),
          filename: `gemini-${out.length + 1}.wav`,
        });
      else if (/^audio\//i.test(mime)) out.push({ kind: 'audio', mime: mime.split(';')[0], base64: data.data });
      else if (/^image\//i.test(mime)) out.push({ kind: 'image', mime: mime.split(';')[0], base64: data.data });
    }
  return out;
}

function geminiSpeechArtifacts(response: any): ArtifactRef[] {
  const out = geminiArtifacts(response).filter((a) => a.kind === 'audio');
  if (!out.length)
    throw new Error(
      `Gemini 未返回可保存的语音数据${response?.promptFeedback?.blockReason ? `：${response.promptFeedback.blockReason}` : response?.candidates?.[0]?.finishReason ? `（${response.candidates[0].finishReason}）` : ''}，请检查原生响应，勿直接重复计费调用。`,
    );
  return out;
}

const ttsParams: ParamSpec[] = [
  {
    key: 'generationConfig.speechConfig',
    label: '声音 / 说话人配置',
    type: 'json',
    native: true,
    group: '声音',
    enabledByDefault: true,
    default: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
    description: '单人 voiceConfig 与多人 multiSpeakerVoiceConfig 二选一；多人需配合下方原生分段文本。',
  },
  {
    key: 'speechStyle',
    label: '朗读风格',
    type: 'string',
    group: '声音',
    default: '自然、温暖，语速适中',
    description: '写入每个 text part 的 speechMetadata.style，不混进实际朗读正文。',
  },
  {
    key: 'speechParts',
    label: '多人分段文本',
    type: 'json',
    group: '声音',
    advanced: true,
    default: [
      { text: '你好，欢迎来到音频实验室。', speechMetadata: { speaker: 'Alex', style: '自然开场' } },
      { text: '我们来比较不同的表达方式。', speechMetadata: { speaker: 'Sam', style: '友好接话' } },
    ],
    description: '启用后使用该原生 Part 数组替代正文；每段 speaker 必须与声音配置一致。',
  },
  {
    key: 'generationConfig.responseFormat.audio',
    label: '音频输出',
    type: 'json',
    group: '格式',
    native: true,
    enabledByDefault: true,
    default: { mimeType: 'AUDIO_WAV', sampleRate: 24000, delivery: 'INLINE' },
    description: '内联 WAV 可直接保存播放；原始 L16 返回会依据 MIME 采样率封装 WAV。',
  },
];

const imageParams: ParamSpec[] = [
  {
    key: 'generationConfig.responseModalities',
    label: '输出模态',
    type: 'json',
    default: ['IMAGE'],
    enabledByDefault: true,
    native: true,
    group: '输出',
    description: '图像生成需要包含 IMAGE，例如 ["IMAGE"] 或 ["TEXT","IMAGE"]。',
  },
  {
    key: 'generationConfig.imageConfig.aspectRatio',
    label: '画幅比例',
    type: 'enum',
    options: choices(['1:1', '2:3', '3:2', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9', '21:9']),
    default: '1:1',
    enabledByDefault: true,
    native: true,
    group: '画面',
  },
  {
    key: 'generationConfig.imageConfig.imageSize',
    label: '图像尺寸',
    type: 'enum',
    options: choices(['512', '1K', '2K', '4K']),
    default: '1K',
    enabledByDefault: true,
    native: true,
    group: '画面',
    description: '可用尺寸与模型有关；4K 通常只由更大的图像模型支持。',
  },
  {
    key: 'generationConfig.thinkingConfig.thinkingLevel',
    label: '图像思考档位',
    type: 'enum',
    options: choices(['minimal', 'low', 'medium', 'high']),
    default: 'low',
    native: true,
    group: '思考',
    advanced: true,
    description: '部分图像模型支持；不是所有模型都接受，遇到 400 请关闭。',
  },
];

function geminiImageArtifacts(response: any): ArtifactRef[] {
  const out: ArtifactRef[] = [];
  for (const c of response?.candidates ?? [])
    for (const part of c?.content?.parts ?? []) {
      if (part?.thought) continue;
      const data = part?.inlineData;
      if (!data?.data || !data.mimeType) continue;
      if (!/^image\//i.test(String(data.mimeType))) continue;
      out.push({
        kind: 'image',
        mime: String(data.mimeType).split(';')[0],
        base64: data.data,
        filename: `gemini-image-${out.length + 1}.png`,
      });
    }
  if (!out.length) {
    const reason =
      response?.promptFeedback?.blockReason ?? response?.candidates?.[0]?.finishReason ?? '响应里没有图像 inlineData';
    throw new Error(`Gemini 未返回可保存图像（${reason}）；请查看原生响应，避免重复计费调用。`);
  }
  return out;
}

const embeddingParams: ParamSpec[] = [
  {
    key: 'embedContentConfig.taskType',
    label: '任务类型',
    type: 'enum',
    options: choices(['RETRIEVAL_QUERY', 'RETRIEVAL_DOCUMENT', 'SEMANTIC_SIMILARITY', 'CLASSIFICATION', 'CLUSTERING']),
    default: 'SEMANTIC_SIMILARITY',
    enabledByDefault: true,
    native: true,
    group: '向量',
    description: '不同任务类型会改变向量空间；同一实验里保持一致再比较相似度。',
  },
  {
    key: 'embedContentConfig.outputDimensionality',
    label: '输出维度',
    type: 'integer',
    min: 1,
    max: 3072,
    default: 768,
    native: true,
    group: '向量',
    advanced: true,
  },
  {
    key: 'embedContentConfig.autoTruncate',
    label: '自动截断',
    type: 'boolean',
    default: true,
    native: true,
    group: '向量',
    advanced: true,
  },
];

export const geminiOps: OperationDef[] = [
  {
    id: 'gemini.chat',
    providerId: 'gemini',
    title: 'Gemini 原生多模态对话',
    summary: 'generateContent / streamGenerateContent：保留真实思考摘要、工具、引用和原生响应字段。',
    features: [
      'chat',
      'reasoning',
      'reasoning-history',
      'tools',
      'builtin-search',
      'builtin-tools',
      'vision',
      'video-understanding',
      'json-output',
      'logprobs',
    ],
    workbench: 'chat',
    lifecycle: 'sse',
    protocol: 'gemini-generate',
    models: chatModels,
    defaultModel: chatModels[0],
    freeModel: true,
    params: chatParams,
    costTier: 'medium',
    verification: verifiedDocs(API),
    docsUrl: API,
    artifacts: geminiArtifacts,
    build: (ctx) => {
      const stream = ctx.input.stream !== false;
      const body = buildGeminiContents(ctx.input);
      applyParams(body, chatParams, ctx.params, ctx.model);
      const thinking = (body as any).generationConfig?.thinkingConfig;
      if (thinking?.thinkingBudget !== undefined && thinking?.thinkingLevel !== undefined)
        throw new Error('thinkingLevel 与 thinkingBudget 只能启用一个。');
      if ((body as any).generationConfig?.logprobs !== undefined && !(body as any).generationConfig?.responseLogprobs)
        throw new Error('候选 Token 数需要同时启用 responseLogprobs。');
      return { method: 'POST', path: modelPath(ctx.model, stream), body, stream };
    },
    insights: ({ view }) => {
      const v = view as ChatView;
      if (v.kind !== 'chat') return [];
      const block = v.extras.promptFeedback?.blockReason;
      return [
        ...(block ? [{ level: 'warn' as const, text: `上游拦截输入：${block}。详见原生 promptFeedback。` }] : []),
        ...(v.finishReason && !['STOP', 'MAX_TOKENS'].includes(v.finishReason)
          ? [{ level: 'warn' as const, text: `Gemini 结束原因：${v.finishReason}；请查看安全与候选元数据。` }]
          : []),
        ...(v.finishReason === 'MAX_TOKENS'
          ? [{ level: 'warn' as const, text: '输出达到 maxOutputTokens 上限，正文或工具参数可能不完整。' }]
          : []),
      ];
    },
    notes: [
      '思考栏仅显示实际 thought 摘要，thoughtSignature 保留在原生 parts 中，续聊不可编造或丢弃。',
      '函数工具由用户提供返回值；不会静默替换厂商或自动执行本地函数。内置代码执行结果保留在原生字段。',
      '搜索 / 自定义函数 / JSON 模式是否可组合，由所选模型与账户决定；遇到参数错误请拆开实验。',
      '图片需要上传本地文件；仅保存链接的素材不能伪装为 inlineData。默认展示第一个候选，其余保留于原生字段。',
    ],
  },
  {
    id: 'gemini.tts',
    providerId: 'gemini',
    title: 'Gemini 原生单人 / 多人语音',
    summary: '通过 speechMetadata 分离正文、风格和说话人；保留真实语音响应并保存可播放的 WAV。',
    features: ['tts'],
    workbench: 'tts',
    lifecycle: 'http',
    protocol: 'json',
    models: ttsModels,
    defaultModel: ttsModels[0],
    freeModel: true,
    inputFields: ['prompt'],
    params: ttsParams,
    artifacts: geminiSpeechArtifacts,
    costTier: 'medium',
    verification: verifiedDocs(SPEECH),
    docsUrl: SPEECH,
    build: (ctx) => {
      const configured: any = {};
      applyParams(configured, ttsParams, ctx.params, ctx.model);
      const { speechParts, speechStyle, ...body } = configured;
      const parts: any[] = Array.isArray(speechParts)
        ? speechParts
        : [
            {
              text: String(ctx.input.text ?? ctx.input.prompt ?? ''),
              ...(speechStyle ? { speechMetadata: { style: speechStyle } } : {}),
            },
          ];
      if (speechParts !== undefined && (!Array.isArray(speechParts) || !speechParts.length))
        throw new Error('多人分段文本必须是非空 Part 数组。');
      if (parts.some((p) => typeof p?.text !== 'string')) throw new Error('语音 Part 必须包含字符串 text。');
      const speech = body.generationConfig?.speechConfig;
      if (speech?.voiceConfig && speech?.multiSpeakerVoiceConfig) throw new Error('单人和多人的声音配置互斥。');
      if (
        body.generationConfig?.responseFormat?.audio?.delivery &&
        body.generationConfig.responseFormat.audio.delivery !== 'INLINE'
      )
        throw new Error('当前语音产物流程需要 INLINE 输出，暂未适配 URI 文件授权下载。');
      const speakers = speech?.multiSpeakerVoiceConfig?.speakerVoiceConfigs;
      if (speakers) {
        const names = new Set(speakers.map((s: any) => s.speaker));
        if (!names.size || parts.some((p) => !names.has(p.speechMetadata?.speaker)))
          throw new Error('多人语音每段必须声明与声音配置匹配的 speaker。');
      }
      body.contents = [{ role: 'user', parts }];
      body.generationConfig = { ...(body.generationConfig ?? {}), responseModalities: ['AUDIO'] };
      return { method: 'POST', path: modelPath(ctx.model), body };
    },
    notes: [
      '3.8 TTS 将 text 当作实际朗读稿，风格应放入 speechMetadata；多段文本使用明确 speaker。',
      'WAV 响应直接保存，只有 MIME 声明为 PCM/L16 时才加 WAV 头；没有合成占位音频或虚构时长。',
      '此操作完成普通 HTTP 合成与产物保存，不声明 Live、流式播放、声音复刻或声音设计支持。',
    ],
  },
  {
    id: 'gemini.image',
    providerId: 'gemini',
    title: 'Gemini 原生图像生成 / 参考图编辑',
    summary:
      'generateContent 的 IMAGE 响应模态：提示词与参考图进入 parts，按 imageConfig 控制比例与尺寸，返回的 inlineData 保存为图片。',
    features: ['image-gen', 'image-edit'],
    workbench: 'image',
    lifecycle: 'http',
    protocol: 'json',
    models: imageModels,
    defaultModel: imageModels[0],
    freeModel: true,
    inputFields: ['prompt', 'images'],
    inputHints: {
      prompt: '描述要生成或编辑的画面；参考图会作为 inlineData parts 一起发送。',
      images: '本地图片会以内联数据发送；只有远程链接的素材不能当作 inlineData。',
    },
    params: imageParams,
    artifacts: geminiImageArtifacts,
    costTier: 'medium',
    costHint: '按官方图像模型计价；未核验账户价格，失败或安全拦截也可能计费。',
    verification: verifiedDocs(IMAGE),
    docsUrl: IMAGE,
    build: (ctx) => {
      const images = (ctx.input.images ?? []) as string[];
      const parts: any[] = images.map((id) => ({ inlineData: { $asset: String(id), as: 'geminiInlineData' } }));
      parts.push({ text: String(ctx.input.prompt ?? '') });
      const body: any = {
        contents: [{ role: 'user', parts }],
        generationConfig: { responseModalities: ['IMAGE'] },
      };
      applyParams(body, imageParams, ctx.params, ctx.model);
      const modalities = body.generationConfig?.responseModalities;
      if (Array.isArray(modalities) && !modalities.includes('IMAGE'))
        throw new Error('图像生成需要 responseModalities 包含 IMAGE。');
      return { method: 'POST', path: modelPath(ctx.model), body };
    },
    notes: [
      'Gemini API 侧的 Imagen 已停用，本操作使用官方当前的图像生成模型；不要用 :predict/instances 的旧 Imagen 结构。',
      'part.thought=true 的中间图不会当作最终产物保存；安全拦截会在 artifacts 阶段给出具体 finishReason。',
      '视频 Veo 已从 Gemini API 关闭，本适配没有把旧 predictLongRunning 流程当作可用能力。',
    ],
  },
  {
    id: 'gemini.embedding',
    providerId: 'gemini',
    title: 'Gemini 原生向量（批量）',
    summary:
      'batchEmbedContents：每个文本独立请求，embedContentConfig 控制任务类型、维度与截断；保留真实向量与 usage。',
    features: ['embedding'],
    workbench: 'embedding',
    lifecycle: 'http',
    protocol: 'json',
    models: embeddingModels,
    defaultModel: embeddingModels[0],
    freeModel: true,
    params: embeddingParams,
    costTier: 'low',
    costHint: '按输入 Token 计费；未核验账户价格。',
    verification: verifiedDocs(EMBED),
    docsUrl: EMBED,
    build: (ctx) => {
      const texts = ((ctx.input.texts ?? []) as string[]).filter((t) => String(t).trim());
      const configured: any = {};
      applyParams(configured, embeddingParams, ctx.params, ctx.model);
      const config = configured.embedContentConfig;
      const body: any = {
        requests: texts.map((text) => ({
          model: `models/${ctx.model}`,
          content: { parts: [{ text: String(text) }] },
          ...(config ? { embedContentConfig: config } : {}),
        })),
      };
      return { method: 'POST', path: `/v1beta/models/${encodeURIComponent(ctx.model)}:batchEmbedContents`, body };
    },
    notes: [
      '批量接口返回 embeddings[].values；结果区会把每条文本的向量和两两相似度画出来。',
      'gemini-embedding-2 支持多模态输入聚合；本操作当前只发送文本 parts。',
    ],
  },
];
