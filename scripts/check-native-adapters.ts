// Offline request-contract checks. These do not attest to paid API availability.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getOperation, OPERATIONS, BUILTIN_PRESETS } from '../shared/catalog.ts';
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
