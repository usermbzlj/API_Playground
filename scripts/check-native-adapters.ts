// Offline request-contract checks. These do not attest to paid API availability.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getOperation, OPERATIONS, BUILTIN_PRESETS } from '../shared/catalog.ts';
import { reduceOpenAIResponses } from '../shared/protocols.ts';
import { initialParamState, fillTemplate } from '../shared/util.ts';

const build = (
  id: string,
  input: Record<string, unknown> = {},
  overrides: Record<string, unknown> = {},
  model?: string,
) => {
  const op = getOperation(id)!;
  assert.ok(op, `missing operation ${id}`);
  return op.build({
    model: model ?? op.defaultModel ?? '',
    input,
    params: initialParamState(op.params, overrides),
    extra: {},
  });
};

test('DeepSeek current thinking controls preserve tool reasoning and diagnose ignored sampling', () => {
  const op = getOperation('deepseek.chat')!;
  const req = build(
    op.id,
    { messages: [{ role: 'assistant', content: 'x', reasoning_content: 'native history' }] },
    {
      tools: [{ type: 'function', function: { name: 'f', parameters: {} } }],
      'thinking.type': 'enabled',
      reasoning_effort: 'low',
      temperature: 0.2,
    },
  );
  assert.equal((req.body as any).thinking.type, 'enabled');
  assert.equal((req.body as any).reasoning_effort, 'low');
  assert.equal((req.body as any).messages[0].reasoning_content, 'native history');
  assert.ok(op.insights!({ request: req, model: 'deepseek-flash' } as any).some((i) => /忽略/.test(i.text)));
  assert.equal(getOperation('deepseek.fim')!.defaultModel, 'deepseek-flash');
});

test('MiniMax current endpoint bounds thinking and excludes ineffective sampling', () => {
  const op = getOperation('minimax.chat')!;
  const req = build(op.id, {}, { reasoning_effort: 'low', max_completion_tokens: 512 });
  assert.equal(req.path, '/v1/chat/completions');
  assert.equal((req.body as any).reasoning_effort, 'low');
  assert.equal((req.body as any).max_completion_tokens, 512);
  assert.equal((req.body as any).max_tokens, undefined);
  assert.ok(!op.params.some((p) => ['temperature', 'top_p'].includes(p.key)));
  assert.throws(() => build(op.id, {}, { reasoning_split: false }), /不支持关闭/);
  const nonthinking = build(op.id, {}, { 'thinking.type': 'disabled' }, 'MiniMax-M3');
  assert.equal((nonthinking.body as any).thinking.type, 'disabled');
});

test('Kimi generations have distinct reasoning contracts and retain tool history', () => {
  const input = {
    messages: [
      { role: 'assistant', content: '' },
      { role: 'user', content: '天气？' },
      {
        role: 'assistant',
        content: '',
        reasoning_content: 'actual vendor reasoning',
        tool_calls: [{ id: 'c1', type: 'function', function: { name: 'weather', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'c1', content: '晴' },
    ],
    keepReasoning: false,
  };
  const k3 = build('kimi.k3', input).body as any;
  assert.equal(k3.reasoning_effort, 'low');
  assert.equal(k3.thinking, undefined);
  assert.equal(k3.messages.find((m: any) => m.tool_calls)?.reasoning_content, 'actual vendor reasoning');
  const k26 = build('kimi.k26', input, { 'thinking.keep': 'all' }).body as any;
  assert.deepEqual(k26.thinking, { type: 'enabled', keep: 'all' });
  assert.equal(k26.reasoning_effort, undefined);
  assert.equal(k26.messages.find((m: any) => m.tool_calls)?.reasoning_content, 'actual vendor reasoning');
});

test('MiMo uses max_completion_tokens and diagnoses service-enforced sampling', () => {
  const request = build('mimo.chat', { messages: [{ role: 'user', content: 'test' }] }, { temperature: 0.2 });
  const body = request.body as any;
  assert.equal(body.max_completion_tokens, 2048);
  assert.equal(body.max_tokens, undefined);
  assert.equal(body.stream_options, undefined);
  assert.equal(body.thinking.type, 'enabled');
  const insights = getOperation('mimo.chat')!.insights!({ request, view: {}, input: {}, model: 'mimo-v2.6-flash' });
  assert.ok(insights.some((i) => i.level === 'warn' && i.text.includes('覆盖')));
});

test('Qwen sends native fields directly, and nonthinking has no accidental thinking budget', () => {
  const body = build(
    'qwen.chat',
    { messages: [{ role: 'user', content: 'ok' }] },
    { enable_thinking: false, max_tokens: 128 },
  ).body as any;
  assert.equal(body.enable_thinking, false);
  assert.equal(body.thinking_budget, undefined);
  assert.equal(body.extra_body, undefined);
  assert.equal(body.max_tokens, 128);
});

test('Qwen image preserves native multimodal blocks and rejects conflicting modes', () => {
  const request = build(
    'qwen.image',
    { prompt: 'edit image', negative: 'watermark', images: ['asset-a', 'asset-b'] },
    { 'parameters.seed': 42 },
  );
  assert.equal(request.path, '/api/v1/services/aigc/multimodal-generation/generation');
  const body = request.body as any;
  assert.deepEqual(body.input.messages[0].content, [
    { image: { $asset: 'asset-a', as: 'dataUrl' } },
    { image: { $asset: 'asset-b', as: 'dataUrl' } },
    { text: 'edit image' },
  ]);
  assert.equal(body.parameters.negative_prompt, 'watermark');
  assert.equal(body.parameters.seed, 42);
  assert.throws(
    () => build('qwen.image', { images: ['a'] }, { 'parameters.prompt_extend_mode': 'agent' }),
    /不支持 agent/,
  );
  assert.throws(
    () => build('qwen.image', {}, { 'parameters.prompt_extend': false, 'parameters.enable_thinking': true }),
    /要求开启/,
  );
  const artifacts = getOperation('qwen.image')!.artifacts!({
    output: { choices: [{ message: { content: [{ image: 'https://example.com/real-vendor-output.png' }] } }] },
  });
  assert.equal(artifacts[0].kind, 'image');
});

test('Hailuo task lifecycle resolves file ids and does not fake cancellation', () => {
  const op = getOperation('minimax.video-keyframes')!;
  const req = build(op.id, { prompt: 'transition', firstFrame: 'a', lastFrame: 'b' });
  const body = req.body as any;
  assert.equal(body.model, 'MiniMax-Hailuo-02');
  assert.deepEqual(body.first_frame_image, { $asset: 'a', as: 'dataUrl' });
  assert.deepEqual(body.last_frame_image, { $asset: 'b', as: 'dataUrl' });
  assert.equal(fillTemplate(op.async!.poll.path, { id: 'task/123' }), '/v1/query/video_generation?task_id=task%2F123');
  assert.equal(op.async!.statusMap.Success, 'succeeded');
  assert.equal(op.async!.statusMap.Fail, 'failed');
  assert.equal(op.async!.resolve!({ file_id: '123' }, {})!.path, '/v1/files/retrieve?file_id=123');
  assert.equal(
    op.async!.resolveResults!({ file: { download_url: 'https://example.com/output.mp4' } })[0].kind,
    'video',
  );
  assert.equal(op.async!.cancel, undefined);
  assert.throws(() => build('minimax.video', {}, { duration: 10, resolution: '1080P' }), /只支持 6 秒/);
});

test('Hailuo H3 v2 uses the content array and drops ratio for keyframes', () => {
  const op = getOperation('minimax.video-v2')!;
  const text = build(op.id, { prompt: 'river at dawn' }).body as any;
  assert.equal(text.model, 'MiniMax-H3');
  assert.deepEqual(text.content, [{ type: 'text', text: 'river at dawn' }]);
  assert.equal(text.ratio, '16:9');
  assert.equal(text.resolution, '768P');
  assert.equal(text.duration, 6);
  const frames = build(op.id, { prompt: 'transition', firstFrame: 'a', lastFrame: 'b' }).body as any;
  assert.equal(frames.ratio, undefined);
  assert.deepEqual(frames.content[1], {
    type: 'image_url',
    image_url: { url: { $asset: 'a', as: 'dataUrl' } },
    role: 'first_frame',
  });
  assert.equal(frames.content[2].role, 'last_frame');
  assert.equal(fillTemplate(op.async!.poll.path, { id: 'task-1' }), '/v2/query/video_generation/task-1');
  assert.equal(op.async!.statusMap.succeeded, 'succeeded');
  assert.equal(op.async!.statusMap.queued, 'pending');
  const refs = op.async!.results({ task: { content: { url: 'https://example.com/h3.mp4' } } });
  assert.equal(refs[0].kind, 'video');
  assert.throws(() => build(op.id, { prompt: 'x' }, { resolution: '2K' }, 'MiniMax-H3-Lite'), /不支持 2K/);
  assert.throws(() => build(op.id, { prompt: 'x' }, { duration: 4 }, 'MiniMax-H3-Max'), /最短 5 秒/);
});

test('Anthropic official Messages uses adaptive thinking and rejects removed sampling/prefill', () => {
  const op = getOperation('anthropic.messages')!;
  assert.ok(op);
  assert.ok(!op.params.some((p) => ['temperature', 'top_p', 'top_k'].includes(p.key)));
  const request = build(
    op.id,
    { system: 'sys', messages: [{ role: 'user', content: 'hi' }] },
    {
      thinking: { type: 'adaptive', display: 'summarized' },
      'output_config.effort': 'high',
      cache_control: { type: 'ephemeral' },
    },
  );
  assert.equal(request.path, '/v1/messages');
  const body = request.body as any;
  assert.equal(body.system, 'sys');
  assert.deepEqual(body.thinking, { type: 'adaptive', display: 'summarized' });
  assert.equal(body.output_config.effort, 'high');
  assert.deepEqual(body.cache_control, { type: 'ephemeral' });
  assert.equal(body.max_tokens, 4096);
  assert.equal(body.temperature, undefined);
  assert.throws(() => build(op.id, { messages: [], prefix: 'continue' }), /prefill/);
  assert.throws(() => build(op.id, { messages: [] }, { thinking: { type: 'enabled' } }), /adaptive/);
  assert.throws(
    () => build(op.id, { messages: [] }, { thinking: { type: 'disabled' } }, 'claude-opus-5-5'),
    /不接受关闭思考/,
  );
  assert.equal(
    (build(op.id, { messages: [] }, { thinking: { type: 'between_tools' } }, 'claude-sonnet-5-5').body as any).thinking
      .type,
    'between_tools',
  );
  assert.throws(
    () => build(op.id, { messages: [] }, { tool_choice: { type: 'any' } }, 'claude-opus-5-5'),
    /拒绝强制 tool_choice/,
  );
  assert.ok(BUILTIN_PRESETS.some((p) => p.operationId === op.id));
});

test('OpenAI ASR sends multipart and realtime uses GA audio fields', () => {
  const asr = build('openai.asr', { audio: 'recording' }, { prompt: 'vocabulary' });
  assert.equal(asr.bodyType, 'multipart');
  assert.deepEqual((asr.body as any).files, { file: { $asset: 'recording' } });
  assert.equal((asr.body as any).fields.model, 'gpt-transcribe');
  const rt = build('openai.realtime').body as any;
  assert.equal(rt.type, 'session.update');
  assert.equal(rt.session.audio.input.format.rate, 24000);
  assert.equal(rt.session.audio.output.voice, 'marin');
  assert.equal(rt.session.input_audio_format, undefined);
  assert.equal(rt.session.audio.input.turn_detection.interrupt_response, true);
});

test('MiMo ASR uses the dedicated audio model and native language selector', () => {
  const body = build('mimo.asr', { audio: 'actual-recording' }, { 'asr_options.language': 'zh' }).body as any;
  assert.equal(body.model, 'mimo-v2.5-asr');
  assert.equal(body.asr_options.language, 'zh');
  assert.deepEqual(body.messages[0].content, [
    { type: 'input_audio', input_audio: { data: { $asset: 'actual-recording', as: 'dataUrl' } } },
  ]);
  assert.equal(body.stream, false);
  assert.equal(body.thinking, undefined);
});

test('Qwen realtime has a native session contract distinct from OpenAI GA', () => {
  const op = getOperation('qwen.realtime')!;
  const body = build(op.id, {}, { turn_detection: { type: 'semantic_vad' } }).body as any;
  assert.equal(op.realtime!.inputRate, 16000);
  assert.equal(op.realtime!.outputRate, 24000);
  assert.deepEqual(body.session.modalities, ['text', 'audio']);
  assert.equal(body.session.audio.input.format.sample_rate, 16000);
  assert.equal(body.session.audio.input.format.type, 'pcm');
  assert.equal(body.session.audio.output.voice, 'Tina');
  assert.equal(body.session.turn_detection.type, 'semantic_vad');
  assert.equal(body.session.input_audio_transcription.model, 'qwen3-asr-flash-realtime');
  assert.equal(body.session.type, undefined);
  assert.equal(body.session.output_modalities, undefined);
  assert.equal(body.session.audio.input.turn_detection, undefined);
});

test('Qwen Wan 3.0 uses input.media and the DashScope async header', () => {
  const op = getOperation('qwen.video')!;
  const text = build(op.id, { prompt: 'river' });
  assert.equal(text.method, 'POST');
  assert.equal(text.headers!['X-DashScope-Async'], 'enable');
  const body = text.body as any;
  assert.equal(body.model, 'wan3.0-video');
  assert.equal(body.input.prompt, 'river');
  assert.equal(body.parameters.resolution, '1080P');
  assert.equal(body.parameters.duration, 5);
  const frames = build(op.id, { prompt: 'transition', firstFrame: 'a', lastFrame: 'b' }).body as any;
  assert.deepEqual(frames.input.media[0], { type: 'first_frame', url: { $asset: 'a', as: 'dataUrl' } });
  assert.equal(frames.input.media[1].type, 'last_frame');
  assert.equal(op.async!.idPath, 'output.task_id');
  assert.equal(op.async!.statusPath, 'output.task_status');
  assert.equal(op.async!.statusMap.SUCCEEDED, 'succeeded');
  assert.equal(fillTemplate(op.async!.poll.path, { id: 'abc' }), '/api/v1/tasks/abc');
  const refs = op.async!.results({ output: { video_url: 'https://example.com/wan.mp4' } });
  assert.equal(refs[0].kind, 'video');
});

test('Qwen ASR sends native audio parts and options', () => {
  const body = build('qwen.asr', { audio: 'recording' }, { 'parameters.asr_options.language': 'zh' }).body as any;
  assert.equal(body.model, 'qwen3-asr-flash');
  assert.deepEqual(body.input.messages[0].content[0].audio, { $asset: 'recording', as: 'dataUrl' });
  assert.equal(body.parameters.asr_options.language, 'zh');
  assert.equal(body.parameters.asr_options.enable_itn, undefined);
});

test('Ark Seedance keeps content roles and maps task states', () => {
  const op = getOperation('ark.video')!;
  const body = build(op.id, { prompt: 'rain', firstFrame: 'a', lastFrame: 'b' }).body as any;
  assert.equal(body.model, 'doubao-seedance-2-5-260628');
  assert.equal(body.content[0].text, 'rain');
  assert.equal(body.content[1].role, 'first_frame');
  assert.equal(body.content[2].role, 'last_frame');
  assert.equal(op.async!.idPath, 'id');
  assert.equal(op.async!.statusMap.expired, 'failed');
  assert.equal(op.async!.statusMap.succeeded, 'succeeded');
  const refs = op.async!.results({ content: { video_url: 'https://example.com/seedance.mp4' } });
  assert.equal(refs[0].kind, 'video');
});

test('Ark Seedream sends image arrays and extracts both url and b64', () => {
  const op = getOperation('ark.image')!;
  const body = build(op.id, { prompt: 'poster', images: ['a', 'b'] }).body as any;
  assert.equal(body.model, 'doubao-seedream-5-0-pro-260628');
  assert.deepEqual(body.image, [
    { $asset: 'a', as: 'dataUrl' },
    { $asset: 'b', as: 'dataUrl' },
  ]);
  assert.equal(body.size, '2K');
  const fromUrl = op.artifacts!({ data: [{ url: 'https://example.com/p.png' }] });
  assert.equal(fromUrl[0].kind, 'image');
  const fromB64 = op.artifacts!({ data: [{ b64_json: 'AAAA' }] });
  assert.equal(fromB64[0].base64, 'AAAA');
});

test('Gemini image keeps thought images out of artifacts and reports blocks', () => {
  const op = getOperation('gemini.image')!;
  const body = build(op.id, { prompt: 'poster', images: ['a'] }).body as any;
  assert.deepEqual(body.contents[0].parts[0], { inlineData: { $asset: 'a', as: 'geminiInlineData' } });
  assert.equal(body.contents[0].parts[1].text, 'poster');
  assert.deepEqual(body.generationConfig.responseModalities, ['IMAGE']);
  assert.equal(body.generationConfig.imageConfig.aspectRatio, '1:1');
  const artifacts = op.artifacts!({
    candidates: [
      {
        content: {
          parts: [
            { thought: true, inlineData: { mimeType: 'image/png', data: 'THOUGHT' } },
            { inlineData: { mimeType: 'image/png', data: 'FINAL' } },
          ],
        },
      },
    ],
  });
  assert.equal(artifacts.length, 1);
  assert.equal(artifacts[0].base64, 'FINAL');
  assert.throws(() => op.artifacts!({ candidates: [{ finishReason: 'IMAGE_SAFETY' }] }), /IMAGE_SAFETY/);
});

test('Gemini embeddings use batch requests with nested config', () => {
  const body = build('gemini.embedding', { texts: ['a', 'b'] }).body as any;
  assert.equal(body.requests.length, 2);
  assert.equal(body.requests[0].model, 'models/gemini-embedding-2');
  assert.equal(body.requests[0].content.parts[0].text, 'a');
  assert.equal(body.requests[0].embedContentConfig.taskType, 'SEMANTIC_SIMILARITY');
});

test('OpenAI images switch to multipart edits and keep b64 artifacts', () => {
  const op = getOperation('openai.image')!;
  const generated = build(op.id, { prompt: 'cup' });
  assert.equal(generated.path, '/v1/images/generations');
  assert.equal((generated.body as any).model, 'gpt-image-2.5-sunburst');
  const edited = build(op.id, { prompt: 'make it blue', images: ['a', 'b'] });
  assert.equal(edited.path, '/v1/images/edits');
  assert.equal(edited.bodyType, 'multipart');
  const files = (edited.body as any).files;
  assert.equal(files['image[]'].length, 2);
  assert.deepEqual(files['image[]'][0], { $asset: 'a' });
  const artifacts = op.artifacts!({ output_format: 'png', data: [{ b64_json: 'AAAA' }] });
  assert.equal(artifacts[0].kind, 'image');
  assert.equal(artifacts[0].mime, 'image/png');
});

test('OpenAI embeddings post to /v1/embeddings', () => {
  const req = build('openai.embedding', { texts: ['a', 'b'] });
  assert.equal(req.path, '/v1/embeddings');
  assert.deepEqual((req.body as any).input, ['a', 'b']);
  assert.equal((req.body as any).model, 'text-embedding-3-large');
});

test('Tripo image-to-3D keeps the single input source and polls tasks', () => {
  const op = getOperation('tripo.image-to-model')!;
  const req = build(op.id, { images: ['asset-a'] });
  assert.equal(req.path, '/generation/image-to-model');
  assert.deepEqual((req.body as any).input, { $asset: 'asset-a', as: 'remoteUrl' });
  assert.equal(op.async!.idPath, 'data.task_id');
  assert.equal(op.async!.statusMap.success, 'succeeded');
  assert.equal(fillTemplate(op.async!.poll.path, { id: 't1' }), '/tasks/t1');
  assert.equal(op.async!.results({ data: { output: { model_url: 'https://example.com/m.glb' } } })[0].kind, 'model3d');
});

test('OpenAI Responses builds native items and reduces streamed events', () => {
  const op = getOperation('openai.responses')!;
  const request = build(op.id, {
    system: 'sys',
    messages: [{ role: 'user', content: 'hi', images: ['img'] }],
  });
  assert.equal(request.path, '/v1/responses');
  const body = request.body as any;
  assert.equal(body.instructions, 'sys');
  assert.equal(body.model, 'gpt-6-astra');
  assert.equal(body.stream, true);
  assert.equal(body.store, false);
  assert.equal(body.reasoning.effort, 'medium');
  assert.equal(body.max_output_tokens, 4096);
  assert.deepEqual(body.input, [
    {
      role: 'user',
      content: [
        { type: 'input_text', text: 'hi' },
        { type: 'input_image', image_url: { $asset: 'img', as: 'dataUrl' } },
      ],
    },
  ]);
  const withTools = build(
    op.id,
    { messages: [{ role: 'user', content: 'x' }] },
    {
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object' } } }],
      tool_choice: 'required',
      'text.format': { type: 'json_schema', name: 'r', strict: true, schema: { type: 'object' } },
    },
  ).body as any;
  assert.deepEqual(withTools.tools, [
    { type: 'function', name: 'f', description: 'd', parameters: { type: 'object' } },
  ]);
  assert.equal(withTools.tool_choice, 'required');
  assert.equal(withTools.text.format.name, 'r');
  assert.throws(() => build(op.id, { messages: [{ role: 'user', content: 'x' }], prefix: 'p' }), /预填/);

  const view = reduceOpenAIResponses([
    { t: 1, type: 'chunk', data: { type: 'response.created', response: { id: 'resp_1', model: 'gpt-6-astra' } } },
    {
      t: 2,
      type: 'chunk',
      data: { type: 'response.output_item.added', output_index: 0, item: { type: 'message', id: 'msg_1' } },
    },
    { t: 3, type: 'chunk', data: { type: 'response.output_text.delta', delta: 'Hello ' } },
    {
      t: 4,
      type: 'chunk',
      data: { type: 'response.output_item.added', output_index: 1, item: { type: 'reasoning', id: 'rs_1' } },
    },
    { t: 5, type: 'chunk', data: { type: 'response.reasoning_summary_text.delta', delta: 'think' } },
    {
      t: 6,
      type: 'chunk',
      data: {
        type: 'response.output_item.added',
        output_index: 2,
        item: { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'f', arguments: '' },
      },
    },
    {
      t: 7,
      type: 'chunk',
      data: { type: 'response.function_call_arguments.delta', item_id: 'item_1', delta: '{"x":1}' },
    },
    {
      t: 8,
      type: 'chunk',
      data: {
        type: 'response.completed',
        response: {
          id: 'resp_1',
          model: 'gpt-6-astra',
          status: 'completed',
          usage: {
            input_tokens: 10,
            output_tokens: 5,
            total_tokens: 15,
            input_tokens_details: { cached_tokens: 4 },
            output_tokens_details: { reasoning_tokens: 2 },
          },
          output: [
            { type: 'message', id: 'msg_1', content: [{ type: 'output_text', text: 'Hello world' }] },
            { type: 'reasoning', id: 'rs_1', summary: [{ type: 'summary_text', text: 'think' }] },
            { type: 'function_call', id: 'item_1', call_id: 'call_1', name: 'f', arguments: '{"x":1}' },
          ],
        },
      },
    },
  ] as any);
  assert.equal(view.text, 'Hello ');
  assert.equal(view.reasoning, 'think');
  assert.equal(view.toolCalls.length, 1);
  assert.equal(view.toolCalls[0].args, '{"x":1}');
  assert.equal(view.usage?.prompt_tokens, 10);
  assert.equal(view.usage?.prompt_cache_hit_tokens, 4);
  assert.equal(view.usage?.reasoning_tokens, 2);
  assert.equal(view.responseId, 'resp_1');
});

test('MiniMax music sends prompt/lyrics and saves hex or URL audio', () => {
  const op = getOperation('minimax.music')!;
  const body = build(op.id, { prompt: 'rainy jazz', lyrics: '[Verse]\n夜雨落在窗台' }, { output_format: 'hex' })
    .body as any;
  assert.equal(body.model, 'music-3.0');
  assert.equal(body.prompt, 'rainy jazz');
  assert.equal(body.lyrics, '[Verse]\n夜雨落在窗台');
  assert.equal(body.output_format, 'hex');
  const instrumental = build(op.id, { prompt: 'rainy jazz', lyrics: 'ignored' }, { is_instrumental: true }).body as any;
  assert.equal(instrumental.lyrics, undefined);
  const hexArtifacts = op.artifacts!({ data: { status: 2, audio: '00ff' }, extra_info: { format: 'wav' } });
  assert.equal(hexArtifacts[0].kind, 'audio');
  assert.equal(hexArtifacts[0].mime, 'audio/wav');
  const urlArtifacts = op.artifacts!({ data: { status: 2, audio: 'https://example.com/music.mp3' } });
  assert.equal(urlArtifacts[0].url, 'https://example.com/music.mp3');
  const insights = op.insights!({ view: { body: { data: { status: 1 } } } } as any);
  assert.ok(insights.some((i) => i.level === 'warn'));
  assert.ok(BUILTIN_PRESETS.some((p) => p.operationId === op.id));
});

test('every new operation has official documentation, an honest status, and a preset', () => {
  const ops = OPERATIONS.filter((o) => /^(kimi\.|mimo\.|qwen\.|ark\.|openai\.|minimax\.video)/.test(o.id));
  assert.ok(ops.length >= 10);
  for (const op of ops) {
    assert.ok(['documented', 'partial'].includes(op.verification.status), op.id);
    if (op.verification.status === 'partial')
      assert.match(op.verification.note ?? '', /text-verification\.json/, op.id);
    assert.equal(op.verification.date, '2026-10-22', op.id);
    assert.ok(op.verification.source?.startsWith('https://'), op.id);
    assert.ok(
      BUILTIN_PRESETS.some((p) => p.operationId === op.id),
      `${op.id} missing preset`,
    );
  }
});
