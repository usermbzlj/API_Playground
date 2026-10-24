import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SSEDecoder } from '../shared/sse.ts';
import { coerceParam, initialParamState, joinApiUrl, setPath } from '../shared/util.ts';
import { redactSensitive, omitRedactedHeaders } from '../shared/redact.ts';
import { getOperation } from '../shared/catalog.ts';
import { validateOperationInput } from '../shared/validate.ts';
import { reduceEvents, promptTokens } from '../shared/protocols.ts';
import { estimateTokenCost } from '../shared/cost.ts';
import { streamRun } from '../web/api.ts';
import { pcm16Wave, recordedTurns } from '../shared/realtime-recording.ts';
import { diagnose } from '../shared/diagnose.ts';
import type { TraceEvent } from '../shared/types.ts';

test('SSE survives every CRLF boundary, comments, multiline data and final EOF', () => {
  const source = ': ping\r\nevent: native\r\ndata: {"text":\r\ndata: "正文🙂"}\r\n\r\nid: end\ndata: final';
  const expected = [
    { event: 'native', data: '{"text":\n"正文🙂"}', id: undefined },
    { event: undefined, data: 'final', id: 'end' },
  ];
  for (let split = 0; split <= source.length; split++) {
    const messages: any[] = [];
    const parser = new SSEDecoder((m) => messages.push(m));
    parser.feed(source.slice(0, split));
    parser.feed(source.slice(split), true);
    assert.deepEqual(messages, expected, `split ${split}`);
  }
});

test('API URL composition does not duplicate version roots or lose query strings', () => {
  assert.equal(
    joinApiUrl('https://api.deepseek.com/beta', '/beta/completions'),
    'https://api.deepseek.com/beta/completions',
  );
  assert.equal(
    joinApiUrl('https://example.com/v1/', '/v1/chat/completions?x=1'),
    'https://example.com/v1/chat/completions?x=1',
  );
  assert.equal(joinApiUrl('https://example.com/api', '/tasks/123'), 'https://example.com/api/tasks/123');
  assert.throws(() => joinApiUrl('https://user:secret@example.com', '/call'), /账号密码/);
});

test('export redaction keeps model parameters but hides credentials and signed URLs', () => {
  const safe = redactSensitive({
    headers: { Authorization: 'Bearer fake-secret', 'x-api-key': 'fake-key' },
    max_tokens: 12,
    input: { password: 'pw', url: 'https://example.com/x?token=private&size=1' },
    proxy: 'http://user:pass@localhost:7890',
    params: { api_key: { enabled: true, value: 'fake' } },
  });
  assert.equal(safe.max_tokens, 12);
  assert.equal(safe.params.api_key.value, '***已隐藏***');
  assert.ok(!JSON.stringify(safe).match(/fake-secret|fake-key|private|user:pass/));
  assert.equal(redactSensitive({ Authorization: 'Bearer $API_KEY' }).Authorization, 'Bearer $API_KEY');
  const native = { logprobs: [{ token: 'hello' }], blocks: [{ type: 'thinking', signature: 'opaque-roundtrip' }] };
  assert.deepEqual(redactSensitive(native), native);
  assert.equal(redactSensitive({ headers: { token: 'hidden' } }).headers.token, '***已隐藏***');
  assert.deepEqual(omitRedactedHeaders({ Authorization: '***已隐藏***', Accept: 'application/json' }), {
    Accept: 'application/json',
  });
});

test('native realtime history preserves response audio, final transcript and interruption', () => {
  const events: TraceEvent[] = [
    {
      t: 1,
      type: 'ws-send',
      data: {
        type: 'conversation.item.create',
        item: { role: 'user', content: [{ type: 'input_text', text: '你好' }] },
      },
    },
    { t: 2, type: 'ws-recv', data: { type: 'response.created', response: { id: 'r1' } } },
    { t: 3, type: 'ws-recv', data: { type: 'response.output_audio.delta', response_id: 'r1', delta: 'AAABAA==' } },
    { t: 4, type: 'ws-recv', data: { type: 'response.output_audio_transcript.delta', response_id: 'r1', delta: '你' } },
    {
      t: 5,
      type: 'ws-recv',
      data: { type: 'response.output_audio_transcript.done', response_id: 'r1', transcript: '你好！' },
    },
    { t: 6, type: 'ws-send', data: { type: 'response.cancel' } },
  ];
  const turns = recordedTurns(events);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].text, '你好');
  assert.equal(turns[1].text, '你好！');
  assert.equal(turns[1].interrupted, true);
  assert.deepEqual(turns[1].audio, ['AAABAA==']);
  const wave = pcm16Wave([Uint8Array.of(0, 0, 1, 0)], 24000);
  assert.equal(new TextDecoder().decode(wave.slice(0, 4)), 'RIFF');
  assert.equal(new DataView(wave.buffer).getUint32(24, true), 24000);
  assert.deepEqual([...wave.slice(44)], [0, 0, 1, 0]);
  assert.throws(() => pcm16Wave([Uint8Array.of(1)], 24000), /PCM/);
});

test('account errors use the actual provider alias rather than only generic HTTP advice', () => {
  const result = diagnose({
    providerId: 'qwen',
    httpStatus: 400,
    body: { error: { code: 'Arrearage', message: 'overdue' } },
  });
  assert.ok(result.hints.some((hint) => hint.includes('欠费')));
  assert.match(result.title, /欠费/);
  assert.ok(!result.hints.some((hint) => hint.includes('参数')));
});

test('invalid numeric, enum and prototype parameters fail before a request', () => {
  const integer = { key: 'max_tokens', label: '', type: 'integer' as const, min: 1, max: 128 };
  assert.throws(() => coerceParam(integer, 0), /范围/);
  assert.throws(() => coerceParam(integer, 1.4), /整数/);
  assert.throws(() => coerceParam(integer, Infinity), /数字/);
  assert.throws(() => coerceParam({ key: 'mode', label: '', type: 'enum', options: [{ value: 'a' }] }, 'bad'), /可选/);
  assert.throws(() => setPath({}, '__proto__.polluted', true), /保留/);
  assert.equal(({} as any).polluted, undefined);
});

test('billable operation validation rejects empty input and missing keyframes', () => {
  const op = getOperation('deepseek.chat')!;
  assert.throws(
    () => validateOperationInput(op, { model: op.defaultModel!, input: {}, params: {}, extra: {} }),
    /消息/,
  );
  const video = getOperation('minimax.video-keyframes')!;
  assert.throws(
    () =>
      validateOperationInput(video, {
        model: video.defaultModel!,
        input: { prompt: 'a scene' },
        params: {},
        extra: {},
      }),
    /首帧/,
  );
  const original = initialParamState(op.params);
  const override = initialParamState(op.params, { temperature: 0.2 });
  assert.equal(override.temperature.enabled, true);
  assert.equal(override.temperature.value, 0.2);
  assert.notEqual(original.temperature, override.temperature);
});

test('OpenAI reducer preserves reasoning, partial tools, native fields and final usage', () => {
  const events: TraceEvent[] = [
    {
      t: 2,
      type: 'chunk',
      data: {
        data: {
          model: 'actual-snapshot',
          choices: [
            {
              delta: {
                reasoning_content: '想',
                tool_calls: [{ index: 0, id: 'c1', function: { name: 'weather', arguments: '{"city":' } }],
              },
            },
          ],
        },
      },
    },
    {
      t: 5,
      type: 'chunk',
      data: {
        choices: [
          {
            delta: {
              content: '晴',
              tool_calls: [{ index: 0, function: { arguments: '"北京"}' } }],
              native_trace: 'kept',
            },
            finish_reason: 'tool_calls',
          },
        ],
        usage: { prompt_tokens: 20, completion_tokens: 5, prompt_cache_hit_tokens: 10 },
      },
    },
  ];
  const view = reduceEvents('openai-chat', events);
  assert.equal(view.kind, 'chat');
  if (view.kind !== 'chat') return;
  assert.equal(view.text, '晴');
  assert.equal(view.reasoning, '想');
  assert.equal(view.toolCalls[0].args, '{"city":"北京"}');
  assert.equal(view.extras['delta.native_trace'], 'kept');
  assert.equal(view.firstTextMs, 5);
  assert.equal(view.usage?.completion_tokens, 5);
});

test('Anthropic signatures, redacted thinking and tool blocks survive reduction', () => {
  const events = [
    {
      t: 0,
      type: 'chunk',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '' } },
    },
    {
      t: 1,
      type: 'chunk',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: '实际思考' } },
    },
    {
      t: 2,
      type: 'chunk',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'signature-data' } },
    },
    {
      t: 3,
      type: 'chunk',
      data: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'c2', name: 'get_data', input: {} },
      },
    },
    {
      t: 4,
      type: 'chunk',
      data: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"x":1}' } },
    },
  ] as TraceEvent[];
  const view = reduceEvents('anthropic-messages', events);
  assert.equal(view.kind, 'chat');
  if (view.kind !== 'chat') return;
  assert.equal(view.blocks[0].data.signature, 'signature-data');
  assert.equal(view.toolCalls[0].args, '{"x":1}');
  assert.equal(view.reasoning, '实际思考');
});

test('MiniMax final repeated audio replaces rather than duplicates fragments', () => {
  const view = reduceEvents('minimax-t2a', [
    { t: 1, type: 'chunk', data: { data: { data: { audio: 'aabb', status: 1 } } } },
    { t: 2, type: 'chunk', data: { data: { data: { audio: 'ccdd', status: 1 } } } },
    { t: 3, type: 'chunk', data: { data: { data: { audio: 'aabbccdd', status: 2 } } } },
  ]);
  assert.equal(view.kind, 'audio');
  if (view.kind === 'audio') assert.equal(view.hex, 'aabbccdd');
});

test('cost never invents currency, missing rates or negative cache use', () => {
  assert.equal(estimateTokenCost(undefined, { cost: 2 }), undefined);
  assert.equal(estimateTokenCost(undefined, { cost: 2, currency: 'CNY' })?.currency, 'CNY');
  const model: any = { id: 'x', pricing: { currency: 'CNY', input: 1, output: 2 } };
  assert.ok(
    Math.abs(estimateTokenCost(model, { prompt_tokens: 100, completion_tokens: 100 })!.amount - 0.0003) < 1e-12,
  );
  assert.equal(estimateTokenCost(model, { prompt_tokens: 1, prompt_cache_hit_tokens: 20 }), undefined);
  assert.equal(promptTokens({ input_tokens: 10, cache_read_input_tokens: 20, cache_creation_input_tokens: 30 }), 60);
});

test('browser stream adapter decodes fragmented UTF8 and a terminal frame, detects dropped streams', async () => {
  const original = globalThis.fetch;
  try {
    const bytes = new TextEncoder().encode(
      'data: {"type":"chunk","t":1,"data":"你好🙂"}\r\n\r\ndata: {"type":"done","t":2,"data":{"status":"ok"}}',
    );
    globalThis.fetch = async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const b of bytes) controller.enqueue(Uint8Array.of(b));
            controller.close();
          },
        }),
        { headers: { 'Content-Type': 'text/event-stream' } },
      );
    const got: TraceEvent[] = [];
    await streamRun({ connectionId: 'local-test' }, (event) => got.push(event));
    assert.equal(got[0].data, '你好🙂');
    assert.equal(got[1].type, 'done');
    globalThis.fetch = async () => new Response('data: {"type":"chunk","t":1,"data":"partial"}\n\n');
    await assert.rejects(() => streamRun({ connectionId: 'local-test' }, () => {}), /中断/);
  } finally {
    globalThis.fetch = original;
  }
});
