import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getOperation, getProvider, presetsFor } from '../shared/catalog.ts';
import { reduceEvents } from '../shared/protocols.ts';
import { buildGeminiContents, geminiArtifacts, geminiPcmToWav } from '../shared/providers/gemini.ts';
import type { BuildContext, TraceEvent } from '../shared/types.ts';

const chat = getOperation('gemini.chat')!;
const speech = getOperation('gemini.tts')!;
function ctx(input: Record<string, unknown> = {}, values: Record<string, unknown> = {}): BuildContext {
  return {
    model: chat.defaultModel!,
    input,
    extra: {},
    params: Object.fromEntries(Object.entries(values).map(([k, value]) => [k, { enabled: true, value }])),
  };
}
const event = (data: any, t = 1, type: TraceEvent['type'] = 'chunk'): TraceEvent => ({
  t,
  type,
  data: type === 'chunk' ? { data } : data,
});
function chatView(events: TraceEvent[]) {
  const view = reduceEvents('gemini-generate', events);
  assert.equal(view.kind, 'chat');
  if (view.kind !== 'chat') throw new Error('Expected chat view');
  return view;
}

test('Gemini provider is native, header-authenticated, editable and documented rather than tested', () => {
  const p = getProvider('gemini')!;
  assert.deepEqual(p.auth, { type: 'header', header: 'x-goog-api-key' });
  assert.deepEqual(p.keyEnv, ['GEMINI_API_KEY', 'GOOGLE_API_KEY']);
  assert.equal(chat.protocol, 'gemini-generate');
  assert.equal(chat.freeModel, true);
  assert.equal(speech.freeModel, true);
  assert.ok(p.models.every((m) => m.verification?.status === 'documented'));
  assert.ok(presetsFor(chat.id).length >= 4);
  assert.ok(presetsFor(speech.id).length >= 2);
});

test('native request keeps system instruction, real asset placeholder and exact generation fields', () => {
  const request = chat.build(
    ctx(
      { system: '简明中文', messages: [{ role: 'user', content: '看图', images: ['png-asset'] }] },
      {
        'generationConfig.maxOutputTokens': 512,
        'generationConfig.thinkingConfig.thinkingLevel': 'LOW',
        'generationConfig.thinkingConfig.includeThoughts': true,
        'generationConfig.responseFormat.text': { mimeType: 'APPLICATION_JSON', schema: { type: 'object' } },
      },
    ),
  );
  assert.equal(request.path, '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse');
  assert.equal(request.stream, true);
  const body: any = request.body;
  assert.deepEqual(body.systemInstruction, { parts: [{ text: '简明中文' }] });
  assert.deepEqual(body.contents[0], {
    role: 'user',
    parts: [{ text: '看图' }, { inlineData: { $asset: 'png-asset', as: 'geminiInlineData' } }],
  });
  assert.deepEqual(body.generationConfig.thinkingConfig, { thinkingLevel: 'LOW', includeThoughts: true });
  assert.equal(body.generationConfig.maxOutputTokens, 512);
  assert.equal(body.model, undefined);
  assert.equal(body.stream, undefined);
  assert.equal(body.config, undefined);
  assert.equal(body.generationConfig.responseFormat.text.mimeType, 'APPLICATION_JSON');
});

test('non-streaming and models/ prefix produce unary endpoint without duplicate prefix', () => {
  const request = chat.build({ ...ctx({ stream: false }), model: 'models/custom-model' });
  assert.equal(request.path, '/v1beta/models/custom-model:generateContent');
  assert.equal(request.stream, false);
});

test('disabled params stay absent, mutually exclusive thinking and dependent logprobs fail locally', () => {
  const c = ctx({}, { 'generationConfig.temperature': 0.2 });
  c.params['generationConfig.temperature'].enabled = false;
  assert.equal((chat.build(c).body as any).generationConfig, undefined);
  assert.throws(
    () =>
      chat.build(
        ctx(
          {},
          {
            'generationConfig.thinkingConfig.thinkingLevel': 'LOW',
            'generationConfig.thinkingConfig.thinkingBudget': 100,
          },
        ),
      ),
    /只能启用一个/,
  );
  assert.throws(() => chat.build(ctx({}, { 'generationConfig.logprobs': 5 })), /responseLogprobs/);
});

test('SSE reducer separates actual thought/text, usage, citations and genuine token logprobs', () => {
  const view = chatView([
    event(
      {
        candidates: [
          { index: 0, content: { parts: [{ thought: true, text: '真实摘要', thoughtSignature: 'opaque' }] } },
        ],
        modelVersion: 'native-snapshot',
      },
      10,
    ),
    event(
      {
        candidates: [
          {
            index: 0,
            content: { parts: [{ text: '答案' }] },
            finishReason: 'STOP',
            groundingMetadata: {
              groundingChunks: [
                { web: { uri: 'https://example.org/source', title: '来源' } },
                { web: { uri: 'https://example.org/source' } },
              ],
              groundingSupports: [{ segment: { text: '答案' } }],
            },
            logprobsResult: {
              chosenCandidates: [{ token: '答案', logProbability: -0.5 }],
              topCandidates: [{ candidates: [{ token: '答案', logProbability: -0.5 }] }],
            },
          },
        ],
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 5,
          totalTokenCount: 32,
          thoughtsTokenCount: 7,
          cachedContentTokenCount: 4,
        },
      },
      25,
    ),
  ]);
  assert.equal(view.text, '答案');
  assert.equal(view.reasoning, '真实摘要');
  assert.equal(view.firstReasoningMs, 10);
  assert.equal(view.firstTextMs, 25);
  assert.equal(view.responseModel, 'native-snapshot');
  assert.equal(view.finishReason, 'STOP');
  assert.equal(view.usage?.prompt_tokens, 20);
  assert.equal(view.usage?.completion_tokens, 5);
  assert.equal(view.usage?.reasoning_tokens, 7);
  assert.equal(view.usage?.prompt_cache_hit_tokens, 4);
  assert.equal(view.usage?.total_tokens, 32);
  assert.equal(view.citations.length, 1);
  assert.equal(view.logprobs[0].logprob, -0.5);
  assert.equal(view.blocks[0].data.thoughtSignature, 'opaque');
  assert.ok(view.extras['candidate.groundingMetadata'].groundingSupports);
});

test('missing vendor evidence remains absent and safety feedback remains observable', () => {
  const view = chatView([
    event({ promptFeedback: { blockReason: 'SAFETY', safetyRatings: [{ category: 'test' }] } }, 5, 'body'),
  ]);
  assert.equal(view.text, '');
  assert.equal(view.reasoning, '');
  assert.equal(view.usage, undefined);
  assert.equal(view.firstTextMs, undefined);
  assert.deepEqual(view.logprobs, []);
  assert.deepEqual(view.toolCalls, []);
  assert.equal(view.extras.promptFeedback.blockReason, 'SAFETY');
  assert.ok(
    chat.insights!({ view, request: undefined, input: {}, model: chat.defaultModel! }).some((i) => i.level === 'warn'),
  );
});

test('unary reducer shows first candidate only and retains other candidates as evidence', () => {
  const view = chatView([
    event(
      {
        candidates: [
          { index: 0, content: { parts: [{ text: 'A' }] } },
          { index: 1, content: { parts: [{ text: 'B' }] } },
        ],
        responseId: 'response-123',
      },
      4,
      'body',
    ),
  ]);
  assert.equal(view.text, 'A');
  assert.equal(view.extras.candidates.length, 2);
  assert.equal(view.responseId, 'response-123');
});

test('native thought signatures and function ids round-trip into tool responses', () => {
  const parts = [
    { thought: true, text: '摘要', thoughtSignature: 'never-rebuild-this' },
    {
      functionCall: { id: 'native-call', name: 'get_weather', args: { city: '邵阳' } },
      thoughtSignature: 'call-signature',
    },
  ];
  const view = chatView([event({ candidates: [{ content: { parts } }] })]);
  const built = buildGeminiContents({
    keepReasoning: false,
    messages: [
      {
        role: 'assistant',
        content: '',
        blocks: view.blocks,
        tool_calls: view.toolCalls.map((tc) => ({ id: tc.id, function: { name: tc.name, arguments: tc.args } })),
      },
      { role: 'tool', tool_call_id: 'native-call', content: '{"weather":"rain"}' },
    ],
  });
  assert.deepEqual(built.contents[0], { role: 'model', parts });
  assert.deepEqual(built.contents[1].parts[0], {
    functionResponse: { name: 'get_weather', id: 'native-call', response: { weather: 'rain' } },
  });
});

test('parallel same-name calls without native ids use independent UI ids but never invent upstream ids', () => {
  const parts = [
    { functionCall: { name: 'get_weather', args: { city: 'A' } } },
    { functionCall: { name: 'get_weather', args: { city: 'B' } } },
  ];
  const view = chatView([event({ candidates: [{ content: { parts } }] })]);
  const messages = [
    {
      role: 'assistant',
      content: '',
      blocks: view.blocks,
      tool_calls: view.toolCalls.map((t) => ({ id: t.id, function: { name: t.name, arguments: t.args } })),
    },
    ...view.toolCalls.map((t, i) => ({ role: 'tool', tool_call_id: t.id, content: String(i + 1) })),
  ];
  const built = buildGeminiContents({ messages });
  assert.equal(built.contents.length, 2);
  assert.equal(built.contents[1].parts.length, 2);
  assert.deepEqual(
    built.contents[1].parts.map((p: any) => p.functionResponse.response),
    [{ result: 1 }, { result: 2 }],
  );
  assert.ok(built.contents[1].parts.every((p: any) => !('id' in p.functionResponse)));
  assert.throws(
    () => buildGeminiContents({ messages: [{ role: 'tool', tool_call_id: 'lost', content: '{}' }] }),
    /缺少对应函数名称/,
  );
});

test('single-speaker TTS sends transcript and style separately with native audio format', () => {
  const request = speech.build({
    ...ctx(
      { text: '只读正文' },
      {
        speechStyle: '温暖',
        'generationConfig.speechConfig': { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
        'generationConfig.responseFormat.audio': { mimeType: 'AUDIO_WAV', delivery: 'INLINE', sampleRate: 24000 },
      },
    ),
    model: speech.defaultModel!,
  });
  const body: any = request.body;
  assert.equal(request.path, '/v1beta/models/gemini-3.8-flash-tts:generateContent');
  assert.deepEqual(body.contents[0].parts, [{ text: '只读正文', speechMetadata: { style: '温暖' } }]);
  assert.deepEqual(body.generationConfig.responseModalities, ['AUDIO']);
  assert.equal(body.speechStyle, undefined);
  assert.equal(body.speechParts, undefined);
});

test('multi-speaker TTS sends exact parts and rejects mismatched/mutually exclusive config', () => {
  const parts = [
    { text: '你好', speechMetadata: { speaker: 'Alex' } },
    { text: '欢迎', speechMetadata: { speaker: 'Sam' } },
  ];
  const multi = {
    multiSpeakerVoiceConfig: {
      speakerVoiceConfigs: ['Alex', 'Sam'].map((speaker) => ({
        speaker,
        voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } },
      })),
    },
  };
  const request = speech.build(
    ctx({ text: '不可读这个' }, { speechParts: parts, 'generationConfig.speechConfig': multi }),
  );
  assert.deepEqual((request.body as any).contents[0].parts, parts);
  assert.throws(
    () => speech.build(ctx({ text: '缺少 speaker' }, { 'generationConfig.speechConfig': multi })),
    /每段必须声明/,
  );
  assert.throws(
    () => speech.build(ctx({}, { 'generationConfig.speechConfig': { ...multi, voiceConfig: {} } })),
    /互斥/,
  );
  assert.throws(() => speech.build(ctx({}, { speechParts: {} })), /非空 Part 数组/);
  assert.throws(
    () => speech.build(ctx({}, { 'generationConfig.responseFormat.audio': { delivery: 'URI' } })),
    /INLINE/,
  );
});

test('PCM conversion creates an actual RIFF header with sample-accurate data lengths', () => {
  const pcm = Buffer.from([0, 0, 255, 127, 0, 128]);
  const wav = Buffer.from(geminiPcmToWav(pcm.toString('base64'), 'audio/L16;codec=pcm;rate=16000'), 'base64');
  assert.equal(wav.toString('ascii', 0, 4), 'RIFF');
  assert.equal(wav.toString('ascii', 8, 12), 'WAVE');
  assert.equal(wav.readUInt32LE(4), wav.length - 8);
  assert.equal(wav.readUInt32LE(24), 16000);
  assert.equal(wav.readUInt16LE(22), 1);
  assert.equal(wav.readUInt16LE(34), 16);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.deepEqual(wav.subarray(44), pcm);
  assert.throws(() => geminiPcmToWav('AA==', 'audio/L16'), /不完整/);
  assert.throws(() => geminiPcmToWav('AAAAAA==', 'audio/L16;channels=3'), /采样参数无效/);
});

test('actual WAV is never wrapped twice; raw L16 is wrapped and image data is preserved', () => {
  const original = geminiPcmToWav('AAAAAA==', 'audio/l16;rate=24000');
  const artifacts = geminiArtifacts({
    candidates: [
      {
        content: {
          parts: [
            { inlineData: { mimeType: 'audio/wav', data: original } },
            { inlineData: { mimeType: 'audio/L16;rate=16000', data: 'AAAAAA==' } },
            { inlineData: { mimeType: 'image/png', data: 'aGVsbG8=' } },
            { text: 'No fake artifact' },
          ],
        },
      },
    ],
  });
  assert.equal(artifacts.length, 3);
  assert.equal(artifacts[0].base64, original);
  assert.equal(artifacts[1].mime, 'audio/wav');
  assert.equal(Buffer.from(artifacts[1].base64!, 'base64').readUInt32LE(24), 16000);
  assert.equal(artifacts[2].kind, 'image');
  assert.equal(artifacts[2].base64, 'aGVsbG8=');
  assert.throws(() => speech.artifacts!({ candidates: [{ finishReason: 'SAFETY' }] }), /未返回可保存的语音数据/);
});
