import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, rmdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { WebSocketServer, WebSocket } from 'ws';

// No production data or credentials: this process imports server modules only after isolation.
const temp = mkdtempSync(join(tmpdir(), 'api-playground-backend-'));
process.env.PLAYGROUND_DATA_DIR = temp;
process.env.PLAYGROUND_ORIGINS = 'http://localhost:5173';
let tests = 0;
const check = (name: string, fn: () => void) => {
  fn();
  tests++;
  console.log(`✓ ${name}`);
};
const modules = await Promise.all([
  import('../server/connections.ts'),
  import('../server/execute.ts'),
  import('../server/runs.ts'),
  import('../server/assets.ts'),
  import('../server/db.ts'),
  import('../shared/catalog.ts'),
  import('../server/tasks.ts'),
  import('../server/ws.ts'),
  import('../server/secrets.ts'),
  import('../server/net.ts'),
]);
const [connections, execution, runs, assets, storage, catalog, tasks, relay, secrets, network] = modules;
storage.setSetting('network', { proxyUrl: '' });
const storedKey = 'isolated-stored-secret-123456';
const overrideKey = 'isolated-override-secret-56789';
const longText = '正文🙂'.repeat(5000);
const hex = Buffer.from('RIFF' + 'a'.repeat(17000)).toString('hex');
let capturedAuth = '';
let capturedMultipart = '';
let artifactAttempts = 0;
let transientPollAttempts = 0;
const upstream = createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  capturedAuth = String(req.headers.authorization ?? '');
  if (req.url === '/poll/transient-task') {
    transientPollAttempts++;
    res.writeHead(transientPollAttempts === 1 ? 503 : 200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify(transientPollAttempts === 1 ? { error: { message: 'temporary outage' } } : { status: 'running' }),
    );
    return;
  }
  if (req.url === '/same-origin-redirect') {
    res.writeHead(302, { location: '/image-bytes' });
    res.end();
    return;
  }
  if (req.url === '/image-bytes') {
    res.writeHead(200, { 'content-type': 'image/png' });
    res.end('local-artifact-fixture');
    return;
  }
  if (req.url === '/redirect-loop') {
    res.writeHead(302, { location: '/redirect-loop' });
    res.end();
    return;
  }
  if (req.url === '/slow') {
    setTimeout(() => {
      if (!res.destroyed) {
        res.writeHead(200);
        res.end('{}');
      }
    }, 150).unref();
    return;
  }
  if (req.url === '/multipart') {
    capturedMultipart = Buffer.concat(chunks).toString();
    res.setHeader('content-type', 'application/json');
    res.end('{}');
    return;
  }
  if (req.url === '/sse') {
    res.setHeader('content-type', 'text/event-stream');
    res.write(
      `data: ${JSON.stringify({ choices: [{ delta: { content: longText } }], usage: { prompt_tokens: 4 } })}\r`,
    );
    res.write('\n\r\n');
    res.end(`data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 5 } })}\r\r`);
    return;
  }
  if (req.url === '/tts') {
    res.setHeader('content-type', 'text/event-stream');
    res.end(`data: ${JSON.stringify({ data: { audio: hex, status: 2 }, base_resp: { status_code: 0 } })}\n\n`);
    return;
  }
  if (req.url === '/stream-error') {
    res.setHeader('content-type', 'text/event-stream');
    res.end(
      `event: error\ndata: ${JSON.stringify({ type: 'error', error: { message: 'mock vendor rejection' } })}\n\n`,
    );
    return;
  }
  if (req.url === '/create') {
    res.setHeader('content-type', 'application/json');
    res.end('{"id":"mock-task"}');
    return;
  }
  if (req.url === '/poll/download-task') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'success', url: `http://${req.headers.host}/download-artifact` }));
    return;
  }
  if (req.url === '/download-artifact') {
    artifactAttempts++;
    if (artifactAttempts === 1) {
      res.writeHead(503);
      res.end('temporarily unavailable');
    } else {
      res.setHeader('content-type', 'video/mp4');
      res.end('actual-local-fixture-bytes');
    }
    return;
  }
  if (req.url === '/poll/slow-task') {
    setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end('{"status":"running"}');
    }, 60).unref();
    return;
  }
  if (req.url === '/poll/mock-task') {
    res.setHeader('content-type', 'application/json');
    res.end('{"status":"cancelled"}');
    return;
  }
  if (req.url === '/redirect') {
    res.writeHead(302, { location: 'http://127.0.0.1:1/blocked' });
    res.end();
    return;
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ echoed: overrideKey, body: Buffer.concat(chunks).toString(), usage: { prompt_tokens: 1 } }));
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');
const upstreamBase = `http://127.0.0.1:${(upstream.address() as any).port}`;
const deep = connections.createConnection({
  providerId: 'deepseek',
  baseUrl: upstreamBase,
  apiKey: storedKey,
  network: 'direct',
});
const tts = connections.createConnection({
  providerId: 'minimax',
  baseUrl: upstreamBase,
  apiKey: storedKey,
  network: 'direct',
});
const chat = catalog.getOperation('deepseek.chat')!;
const savedAsync = chat.async;
const savedRealtime = chat.realtime;
let child: ReturnType<typeof spawn> | undefined;
let relayServer: ReturnType<typeof createServer> | undefined;
let upstreamWS: WebSocketServer | undefined;
try {
  const original = connections.getConnection(deep.id)!;
  check('credential revisions invalidate account model caches even when key masks are identical', () => {
    const account = connections.createConnection({
      providerId: 'deepseek',
      apiKey: 'same-prefix-1111-same-ending',
      network: 'direct',
    });
    const updated = connections.updateConnection(account.id, { apiKey: 'same-prefix-2222-same-ending' });
    assert.equal(updated.keyPreview, account.keyPreview);
    assert.equal(updated.revision, (account.revision ?? 0) + 1);
    assert.equal(connections.updateConnection(account.id, { label: 'renamed' }).revision, updated.revision);
  });
  check('invalid connection patches validate every field before any write', () => {
    assert.throws(() => connections.updateConnection(deep.id, { label: 'must-not-stick', baseUrl: 'not a URL' }));
    assert.equal(connections.getConnection(deep.id)?.label, original.label);
    assert.equal(connections.getConnection(deep.id)?.baseUrl, original.baseUrl);
    assert.throws(() => connections.updateConnection(deep.id, { network: 'invalid' as any }));
    assert.throws(() => connections.createConnection({ providerId: 'deepseek', apiKey: '   ' }));
  });
  const blockedSecretTemporary = join(temp, `secrets.json.${process.pid}.tmp`);
  mkdirSync(blockedSecretTemporary);
  try {
    check('credential persistence errors leave the database and in-memory credentials unchanged', () => {
      assert.throws(() =>
        connections.updateConnection(deep.id, { label: 'also-must-not-stick', apiKey: 'replacement-dummy-key' }),
      );
      assert.equal(connections.getConnection(deep.id)?.label, original.label);
      assert.equal(secrets.getSecret(deep.id)?.key, storedKey);
      const count = connections.listConnections().length;
      assert.throws(() => connections.createConnection({ providerId: 'deepseek', apiKey: 'new-dummy-key' }));
      assert.equal(connections.listConnections().length, count);
    });
  } finally {
    rmdirSync(blockedSecretTemporary);
  }
  check('explicit proxy routing refuses a missing proxy instead of silently exposing direct traffic', () => {
    assert.throws(() => network.resolveRoute('https://example.invalid', 'proxy'), /尚未配置/);
    assert.throws(
      () => connections.buildUrl('https://api.deepseek.com', 'http://api.deepseek.com/chat/completions', 'deepseek'),
      /降级/,
    );
  });
  check('Beta URL joining avoids duplicated /beta', () =>
    assert.equal(
      connections.buildUrl('https://api.deepseek.com/beta', '/beta/completions', 'deepseek'),
      'https://api.deepseek.com/beta/completions',
    ),
  );
  check('recursive redaction keeps param shape and ordinary native fields', () => {
    const value = secrets.redactValue({
      Authorization: { enabled: true, value: overrideKey },
      password: 'private',
      api_key: 'private',
      cacheKey: 'retain',
      token: 'word',
      signature: 'native-thinking-signature',
      url: 'https://example.org/?api_key=private',
    });
    assert.equal(value.Authorization.value, '***已隐藏***');
    assert.equal(value.cacheKey, 'retain');
    assert.equal(value.token, 'word');
    assert.equal(value.signature, 'native-thinking-signature');
    assert.ok(!JSON.stringify(value).includes('private'));
  });
  check('cost thresholds medium/high/all are enforced centrally', () => {
    storage.setSetting('ui', { confirmTier: 'medium' });
    assert.throws(() => execution.requireCostConfirmation('medium'), execution.CostConfirmationRequired);
    execution.requireCostConfirmation('low');
    storage.setSetting('ui', { confirmTier: 'all' });
    assert.throws(() => execution.requireCostConfirmation('low'), execution.CostConfirmationRequired);
    storage.setSetting('ui', { confirmTier: 'high' });
    execution.requireCostConfirmation('medium');
  });
  await assert.rejects(
    execution.executeRun(
      { connectionId: deep.id, request: { method: 'GET', path: '/' } },
      () => {},
      new AbortController().signal,
    ),
    execution.CostConfirmationRequired,
  );
  tests++;
  console.log('✓ raw calls require explicit cost confirmation');
  const rawEvents: any[] = [];
  const raw = await execution.executeRun(
    {
      connectionId: deep.id,
      request: {
        method: 'POST',
        path: '/echo?api_key=' + overrideKey,
        headers: { Authorization: 'Bearer ' + overrideKey },
        body: { content: 'keep me' },
      },
      confirmCost: true,
    },
    (e) => rawEvents.push(e),
    new AbortController().signal,
  );
  check('raw override credentials reach mock upstream but never events/records', () => {
    assert.equal(capturedAuth, 'Bearer ' + overrideKey);
    const record = runs.getRun(raw.runId)!;
    const text = JSON.stringify([record, rawEvents]);
    assert.ok(!text.includes(overrideKey));
    assert.ok(!text.includes(storedKey));
    assert.equal(record.input.request.headers.Authorization, '***已隐藏***');
    assert.equal(record.request.headers.authorization, '***已隐藏***');
    assert.equal(record.response.echoed, '***');
  });
  const events: any[] = [];
  const streamed = await execution.executeRun(
    {
      connectionId: deep.id,
      operationId: chat.id,
      model: 'deepseek-chat',
      input: { messages: [{ role: 'user', content: storedKey }] },
      params: { Authorization: { enabled: true, value: overrideKey } },
      request: { method: 'POST', path: '/sse', body: {} },
    },
    (e) => events.push(e),
    new AbortController().signal,
  );
  check('long SSE content is intact live, in final view and history; usage merges', () => {
    const record = runs.getRun(streamed.runId)!;
    assert.equal(events.find((e) => e.type === 'chunk').data.data.choices[0].delta.content, longText);
    assert.equal(events.find((e) => e.type === 'done').data.view.text, longText);
    assert.equal(record.response.view.text, longText);
    assert.equal(record.metrics?.usage?.prompt_tokens, 4);
    assert.equal(record.metrics?.usage?.completion_tokens, 5);
    assert.ok(!JSON.stringify(record.state).includes(storedKey));
    assert.ok(!JSON.stringify(record.state).includes(overrideKey));
  });
  const err = await execution.executeRun(
    {
      connectionId: deep.id,
      operationId: chat.id,
      model: 'deepseek-chat',
      request: { method: 'POST', path: '/stream-error' },
    },
    () => {},
    new AbortController().signal,
  );
  check('HTTP 200 SSE vendor errors are failed runs', () => assert.equal(runs.getRun(err.runId)?.status, 'error'));
  const audioEvents: any[] = [];
  const audio = await execution.executeRun(
    {
      connectionId: tts.id,
      operationId: 'minimax.tts',
      model: 'speech-02-turbo',
      request: { method: 'POST', path: '/tts', body: { audio_setting: { format: 'wav' } } },
    },
    (e) => audioEvents.push(e),
    new AbortController().signal,
  );
  check('large streamed TTS persists exact WAV bytes and playable artifact', () => {
    const record = runs.getRun(audio.runId)!;
    assert.equal(record.artifacts?.length, 1);
    const asset = record.artifacts![0];
    assert.equal(asset.mime, 'audio/wav');
    assert.ok(asset.filename.endsWith('.wav'));
    assert.deepEqual(readFileSync(assets.getAssetFile(asset.id)!.path), Buffer.from(hex, 'hex'));
    assert.equal(audioEvents.find((e) => e.type === 'chunk').data.data.data.audio, hex);
    assert.equal(record.response.view.hex, '');
  });
  const first = assets.saveAsset({ data: Buffer.from('first'), mime: 'image/png' });
  const second = assets.saveAsset({ data: Buffer.from('second'), mime: 'image/png' });
  await execution.executeRun(
    {
      connectionId: deep.id,
      confirmCost: true,
      request: {
        method: 'POST',
        path: '/multipart',
        bodyType: 'multipart',
        body: { files: { 'image[]': [{ $asset: first.id }, { $asset: second.id }] } },
      },
    },
    () => {},
    new AbortController().signal,
  );
  check('multipart supports repeated files in a native field', () => {
    assert.equal(capturedMultipart.match(/name="image\[\]"/g)?.length, 2);
    assert.ok(capturedMultipart.includes('first'));
    assert.ok(capturedMultipart.includes('second'));
  });
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 20);
  const stopped = await execution.executeRun(
    { connectionId: deep.id, confirmCost: true, request: { method: 'POST', path: '/slow' } },
    () => {},
    controller.signal,
  );
  check('aborted HTTP execution persists cancelled terminal state', () =>
    assert.equal(runs.getRun(stopped.runId)?.status, 'cancelled'),
  );
  const redirect = await execution.executeRun(
    { connectionId: deep.id, confirmCost: true, request: { method: 'POST', path: '/redirect', body: {} } },
    () => {},
    new AbortController().signal,
  );
  check('credentialed requests refuse cross-origin redirects', () => {
    assert.equal(runs.getRun(redirect.runId)?.status, 'error');
    assert.match(JSON.stringify(runs.getRun(redirect.runId)?.error), /跨域重定向/);
  });
  chat.async = {
    idPath: 'id',
    poll: { method: 'GET', path: '/poll/{id}' },
    statusPath: 'status',
    statusMap: { cancelled: 'cancelled' },
    results: () => [],
  };
  const pending = await execution.executeRun(
    {
      connectionId: deep.id,
      operationId: chat.id,
      model: 'deepseek-chat',
      request: { method: 'POST', path: '/create' },
    },
    () => {},
    new AbortController().signal,
  );
  await tasks.cancelTask(runs.getRun(pending.runId)!.taskId!);
  check('local task cancellation also ends its run', () =>
    assert.equal(runs.getRun(pending.runId)?.status, 'cancelled'),
  );
  const remote = await execution.executeRun(
    {
      connectionId: deep.id,
      operationId: chat.id,
      model: 'deepseek-chat',
      request: { method: 'POST', path: '/create' },
    },
    () => {},
    new AbortController().signal,
  );
  await tasks.pollTask(runs.getRun(remote.runId)!.taskId!);
  check('remote task cancellation also ends its run', () =>
    assert.equal(runs.getRun(remote.runId)?.status, 'cancelled'),
  );
  const expiring = await execution.executeRun(
    {
      connectionId: deep.id,
      operationId: chat.id,
      model: 'deepseek-chat',
      request: { method: 'POST', path: '/create' },
    },
    () => {},
    new AbortController().signal,
  );
  const expiryTask = runs.getRun(expiring.runId)!.taskId!;
  storage.db
    .prepare('UPDATE tasks SET created_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 7 * 3600_000).toISOString(), expiryTask);
  await tasks.pollDueTasks();
  check('task expiry stops automatic polling and ends its run', () => {
    assert.equal(tasks.getTask(expiryTask)?.status, 'unknown');
    assert.equal(runs.getRun(expiring.runId)?.status, 'error');
  });
  const racing = await execution.executeRun(
    {
      connectionId: deep.id,
      operationId: chat.id,
      model: 'deepseek-chat',
      request: { method: 'POST', path: '/create' },
    },
    () => {},
    new AbortController().signal,
  );
  const racingTask = runs.getRun(racing.runId)!.taskId!;
  storage.db.prepare('UPDATE tasks SET remote_id = ? WHERE id = ?').run('slow-task', racingTask);
  const polling = tasks.pollTask(racingTask);
  await new Promise((r) => setTimeout(r, 10));
  await tasks.cancelTask(racingTask);
  await polling;
  check('a late poll response cannot overwrite local cancellation', () => {
    assert.equal(tasks.getTask(racingTask)?.status, 'cancelled');
    assert.equal(runs.getRun(racing.runId)?.status, 'cancelled');
  });
  const remoteRef = assets.saveRemoteRef('https://example.invalid/audio.wav', 'audio', 'audio/wav');
  check('ASR rejects remote-only input and unsupported formats', () => {
    assert.throws(() => assets.validateOperationAssets('mimo.asr', { audio: remoteRef.id }), /本地音频/);
    assert.throws(() => assets.validateOperationAssets('mimo.asr', { audio: first.id }), /WAV/);
    storage.db.prepare('UPDATE assets SET size = ? WHERE id = ?').run(26 * 1024 * 1024, first.id);
    assert.throws(() => assets.validateOperationAssets('openai.asr', { audio: first.id }), /25 MB/);
    storage.db.prepare('UPDATE assets SET size = ? WHERE id = ?').run(5, first.id);
  });
  await assert.rejects(network.readResponseBuffer(new Response('oversized'), 3), /上限/);
  tests++;
  console.log('✓ upstream body size is bounded before buffering');
  check('header overrides are case-insensitive', () =>
    assert.deepEqual(connections.mergeRequestHeaders({ Authorization: 'old' }, { authorization: 'new' }), {
      authorization: 'new',
    }),
  );
  runs.insertRun({
    id: 'interrupted-http',
    providerId: deep.providerId,
    connectionId: deep.id,
    title: 'interrupted',
    lifecycle: 'http',
  });
  runs.recoverInterruptedRuns();
  check('interrupted HTTP sessions become actionable errors after restart', () =>
    assert.equal(runs.getRun('interrupted-http')?.status, 'error'),
  );
  chat.async = {
    idPath: 'id',
    poll: { method: 'GET', path: '/poll/{id}' },
    statusPath: 'status',
    statusMap: { success: 'succeeded' },
    results: (body) => [{ kind: 'video', url: body.url, filename: 'retry-result.mp4' }],
  };
  runs.insertRun({
    id: 'artifact-retry-run',
    providerId: 'deepseek',
    connectionId: deep.id,
    operationId: chat.id,
    title: 'isolated download retry',
    lifecycle: 'async-task',
  });
  const retryTask = tasks.createTask({
    runId: 'artifact-retry-run',
    connectionId: deep.id,
    operationId: chat.id,
    remoteId: 'download-task',
    title: 'download retry',
  });
  await tasks.pollTask(retryTask);
  check('a failed artifact download stays recoverable and schedules an automatic retry', () => {
    assert.equal(runs.getRun('artifact-retry-run')?.status, 'running');
    assert.ok(tasks.getTask(retryTask)?.error);
    assert.ok(tasks.getTask(retryTask)?.nextPollAt);
    runs.recoverInterruptedRuns();
    assert.equal(runs.getRun('artifact-retry-run')?.status, 'running');
  });
  await tasks.pollTask(retryTask);
  check('manual artifact retry recovers the file without creating another paid generation', () => {
    assert.equal(runs.getRun('artifact-retry-run')?.status, 'ok');
    assert.equal(runs.getRun('artifact-retry-run')?.artifacts?.length, 1);
    assert.equal(artifactAttempts, 2);
  });
  runs.insertRun({
    id: 'transient-poll-run',
    providerId: 'deepseek',
    connectionId: deep.id,
    operationId: chat.id,
    title: 'isolated transient poll',
    lifecycle: 'async-task',
  });
  const transientTask = tasks.createTask({
    runId: 'transient-poll-run',
    connectionId: deep.id,
    operationId: chat.id,
    remoteId: 'transient-task',
  });
  await tasks.pollTask(transientTask);
  check('temporary HTTP 503 keeps the task live with bounded backoff and remote uncertainty', () => {
    assert.equal(tasks.getTask(transientTask)?.status, 'pending');
    assert.equal(runs.getRun('transient-poll-run')?.status, 'running');
    assert.equal(tasks.getTask(transientTask)?.retryCount, 1);
    assert.match(tasks.getTask(transientTask)?.error ?? '', /远程结果尚未确定/);
    assert.ok(new Date(tasks.getTask(transientTask)!.nextPollAt!).getTime() > Date.now());
  });
  await tasks.pollDueTasks();
  assert.equal(transientPollAttempts, 1);
  storage.db
    .prepare('UPDATE tasks SET next_poll_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1000).toISOString(), transientTask);
  await tasks.pollDueTasks();
  for (let attempt = 0; attempt < 50 && tasks.getTask(transientTask)?.retryCount; attempt++)
    await new Promise((r) => setTimeout(r, 5));
  check('due retry recovers polling automatically without recreating a paid task', () => {
    assert.equal(transientPollAttempts, 2);
    assert.equal(tasks.getTask(transientTask)?.status, 'running');
    assert.equal(tasks.getTask(transientTask)?.retryCount, 0);
    assert.equal(tasks.getTask(transientTask)?.error, null);
  });
  await tasks.cancelTask(transientTask);
  const redirectedArtifact = await assets.downloadToAsset(
    upstreamBase + '/same-origin-redirect',
    null,
    'image',
    'same-origin-result.png',
    { network: 'direct' },
  );
  check('safe same-origin artifact redirects preserve the final file', () =>
    assert.equal(readFileSync(assets.getAssetFile(redirectedArtifact.id)!.path, 'utf8'), 'local-artifact-fixture'),
  );
  await assert.rejects(
    assets.downloadToAsset(upstreamBase + '/redirect-loop', null, 'image', undefined, { network: 'direct' }),
    /重定向次数/,
  );
  tests++;
  console.log('✓ artifact redirect loops stop at a bounded limit');

  runs.insertRun({
    id: 'source-asset-run',
    providerId: 'deepseek',
    connectionId: deep.id,
    title: 'source',
    lifecycle: 'http',
  });
  const sharedAsset = assets.saveAsset({
    data: Buffer.from('shared-input-fixture'),
    mime: 'image/png',
    filename: 'shared-image.png',
    runId: 'source-asset-run',
    source: 'artifact',
  });
  const sharedRequest = { method: 'POST', path: '/unused', body: { image: { $asset: sharedAsset.id, as: 'base64' } } };
  runs.insertRun({
    id: 'consumer-asset-run',
    providerId: 'deepseek',
    connectionId: deep.id,
    title: 'consumer',
    lifecycle: 'http',
    input: { request: sharedRequest },
  });
  storage.db
    .prepare('INSERT INTO presets(id, operation_id, title, input_json, created_at) VALUES(?,?,?,?,?)')
    .run('shared-asset-preset', 'raw', 'shared template', JSON.stringify({ request: sharedRequest }), storage.now());
  check('asset deletion refuses durable run and template references', () => {
    assert.throws(() => assets.deleteAsset(sharedAsset.id), /仍被/);
    const item = assets.assetLibrary({ q: 'shared-image' }).items[0];
    assert.equal(item.referenceCount, 3);
    assert.equal(item.runReferences?.length, 2);
    assert.equal(item.presetReferences?.length, 1);
  });
  runs.deleteRun('source-asset-run');
  check('deleting a source history preserves shared artifacts and downstream replay', () => {
    assert.ok(assets.getAsset(sharedAsset.id));
    assert.equal(assets.getAsset(sharedAsset.id)?.runId, null);
    assert.equal(
      assets.resolveAssetRefs(sharedRequest.body).image,
      Buffer.from('shared-input-fixture').toString('base64'),
    );
    assert.equal(assets.assetLibrary({ q: 'shared-image' }).items[0].referenceCount, 2);
  });
  runs.insertRun({
    id: 'unshared-output-run',
    providerId: 'deepseek',
    connectionId: deep.id,
    title: 'unshared output',
    lifecycle: 'http',
  });
  const retainedOutput = assets.saveAsset({
    data: Buffer.from('retained-output'),
    mime: 'image/png',
    runId: 'unshared-output-run',
    source: 'artifact',
  });
  runs.deleteRun('unshared-output-run');
  check('deleting history never silently deletes an existing output file', () => {
    assert.ok(assets.getAssetFile(retainedOutput.id));
    assert.equal(assets.getAsset(retainedOutput.id)?.runId, null);
  });
  runs.deleteRun('consumer-asset-run');
  storage.db.prepare('DELETE FROM presets WHERE id=?').run('shared-asset-preset');
  check('unused cleanup only deletes explicitly selected unreferenced assets', () => {
    assert.ok(assets.assetLibrary({ unused: true, q: 'shared-image' }).items.length);
    const other = assets.getAsset(redirectedArtifact.id);
    assert.equal(assets.cleanupAssets([sharedAsset.id]).deleted, 1);
    assert.equal(assets.getAsset(sharedAsset.id), undefined);
    assert.ok(other && assets.getAsset(other.id));
    assert.throws(
      () => assets.saveRemoteRef('https://user:password@example.invalid/image', 'image', 'image/png'),
      /账号密码/,
    );
    assert.throws(() => assets.cleanupAssets(['../outside']), /ID/);
    assert.throws(() => assets.assetLibrary({ kind: 'invalid' }), /类型/);
  });
  chat.async = savedAsync;

  check('pagination clamps negative/NaN/oversized arguments', () => {
    assert.deepEqual(storage.pagination(-10, -3), { limit: 1, offset: 0 });
    assert.deepEqual(storage.pagination(NaN, NaN), { limit: 100, offset: 0 });
    assert.deepEqual(storage.pagination(Infinity, Infinity), { limit: 100, offset: 0 });
    assert.deepEqual(storage.pagination(999999, 999999999999), { limit: 500, offset: 1000000000 });
    assert.equal(runs.listRuns({ limit: -1, offset: -1 }).length, 1);
    assert.equal(tasks.listTasks(-1, -1).length, 1);
  });
  check('run and task pagination has stable non-overlapping pages', () => {
    const firstRuns = runs.listRuns({ limit: 2 });
    const nextRuns = runs.listRuns({ limit: 2, offset: 2 });
    assert.equal(firstRuns.length, 2);
    assert.equal(nextRuns.length, 2);
    assert.ok(!nextRuns.some((r) => firstRuns.some((p) => p.id === r.id)));
    const firstTasks = tasks.listTasks(2);
    const nextTasks = tasks.listTasks(2, 2);
    assert.equal(firstTasks.length, 2);
    assert.equal(nextTasks.length, 2);
    assert.ok(!nextTasks.some((t) => firstTasks.some((p) => p.id === t.id)));
  });

  // Actual loopback WebSocket handshakes and byte-for-byte binary relay.
  upstreamWS = new WebSocketServer({ server: upstream });
  upstreamWS.on('connection', (ws) => ws.on('message', (data, binary) => ws.send(data, { binary })));
  chat.realtime = { path: '/native-ws', protocol: 'openai-realtime', inputRate: 24000, outputRate: 24000 };
  relayServer = createServer();
  relayServer.on('upgrade', relay.handleUpgrade);
  relayServer.listen(0, '127.0.0.1');
  await once(relayServer, 'listening');
  const relayPort = (relayServer.address() as any).port;
  let wsRunId = '';
  const client = new WebSocket(
    `ws://127.0.0.1:${relayPort}/api/ws?connectionId=${deep.id}&operationId=${chat.id}&model=deepseek-chat&confirmCost=1`,
    { headers: { Origin: 'http://localhost:5173' } },
  );
  const bytes = Buffer.from([0, 255, 1, 2, 128]);
  const echoed = new Promise<Buffer>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS relay timed out')), 5000);
    client.on('error', reject);
    client.on('message', (data, binary) => {
      if (binary) {
        clearTimeout(timer);
        resolve(data as Buffer);
        return;
      }
      const value = JSON.parse(data.toString());
      if (value.type === 'playground.run') wsRunId = value.runId;
      if (value.type === 'playground.upstream_open') {
        client.send(
          JSON.stringify({
            type: 'session.update',
            session: { instructions: 'remember native session', output_modalities: ['audio'] },
          }),
        );
        client.send(
          JSON.stringify({
            type: 'response.done',
            response: { id: 'first', usage: { input_tokens: 2, output_tokens: 3 } },
          }),
        );
        client.send(
          JSON.stringify({
            type: 'response.done',
            response: { id: 'second', usage: { input_tokens: 4, output_tokens: 5 } },
          }),
        );
        client.send(
          JSON.stringify({
            type: 'response.done',
            response: { id: 'first', usage: { input_tokens: 2, output_tokens: 3 } },
          }),
        );
        client.send(bytes, { binary: true });
      }
    });
  });
  const received = await echoed;
  client.close();
  await once(client, 'close');
  await new Promise((r) => setTimeout(r, 20));
  check('WS relay preserves binary type/bytes and persists cancelled local close', () => {
    assert.deepEqual(received, bytes);
    assert.equal(runs.getRun(wsRunId)?.status, 'cancelled');
    assert.ok(
      runs.getRun(wsRunId)?.events?.some((e) => e.type === 'ws-recv' && e.data.base64 === bytes.toString('base64')),
    );
  });
  check('WS persists native session config and sums actual usage once per response', () => {
    const record = runs.getRun(wsRunId)!;
    assert.equal(
      record.state?.input.session && (record.state.input.session as any).instructions,
      'remember native session',
    );
    assert.equal(record.metrics?.usage?.input_tokens, 6);
    assert.equal(record.metrics?.usage?.output_tokens, 8);
  });
  const qwenOp = catalog.getOperation('qwen.realtime');
  if (qwenOp) {
    const qwen = connections.createConnection({
      providerId: qwenOp.providerId,
      baseUrl: upstreamBase,
      apiKey: storedKey,
      network: 'direct',
    });
    const badQwen = new WebSocket(
      `ws://127.0.0.1:${relayPort}/api/ws?connectionId=${qwen.id}&operationId=${qwenOp.id}&model=${qwenOp.defaultModel}&confirmCost=1`,
      { headers: { Origin: 'http://localhost:5173' } },
    );
    const message = await new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Qwen endpoint validation timed out')), 2000);
      badQwen.on('message', (data) => {
        clearTimeout(timer);
        resolve(JSON.parse(data.toString()));
      });
      badQwen.on('error', reject);
    });
    check('Qwen realtime refuses a non-Workspace endpoint before using credentials', () =>
      assert.match(message.message, /Workspace/),
    );
    badQwen.close();
    await once(badQwen, 'close');
  }
  storage.setSetting('ui', { confirmTier: 'all' });
  const rejected = new WebSocket(
    `ws://127.0.0.1:${relayPort}/api/ws?connectionId=${deep.id}&operationId=${chat.id}&model=deepseek-chat`,
    { headers: { Origin: 'http://localhost:5173' } },
  );
  const rejection = await new Promise<any>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('WS confirmation timed out')), 2000);
    rejected.on('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
    rejected.on('error', reject);
  });
  check('WS enforces the configured cost confirmation threshold', () => {
    assert.equal(rejection.type, 'playground.error');
    assert.equal(rejection.costConfirm, true);
  });
  rejected.close();
  await once(rejected, 'close');
  storage.setSetting('ui', { confirmTier: 'high' });
  chat.realtime = savedRealtime;

  // Route integration in a separate server process, still using this new temp directory.
  const childEnv = {
    ...process.env,
    PORT: '0',
    HOST: '127.0.0.1',
    PLAYGROUND_MAX_UPLOAD: '32',
    PLAYGROUND_ORIGINS: 'http://localhost:5173',
  };
  child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'server/index.ts'], {
    cwd: resolve('.'),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  const port = await new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server startup timed out: ' + logs)), 5000);
    child!.stderr!.on('data', (b) => {
      logs += b.toString();
    });
    child!.stdout!.on('data', (b) => {
      logs += b.toString();
      const match = /http:\/\/127\.0\.0\.1:(\d+)/.exec(logs);
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    });
    child!.on('exit', (code) => {
      if (code) {
        clearTimeout(timer);
        reject(new Error('server exited: ' + logs));
      }
    });
  });
  const base = `http://127.0.0.1:${port}`;
  const unsupportedProbeProvider = catalog.PROVIDERS.find(
    (provider) =>
      !provider.modelsPath && !provider.balance && !(provider.auth.extraFields ?? []).some((field) => field.required),
  );
  if (unsupportedProbeProvider) {
    const created = await fetch(base + '/api/connections', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        providerId: unsupportedProbeProvider.id,
        baseUrl: upstreamBase,
        apiKey: 'isolated-unverified-key',
      }),
    });
    assert.equal(created.status, 200);
    const unverifiedConnection = (await created.json()) as any;
    const unverified = (await (
      await fetch(base + `/api/connections/${unverifiedConnection.id}/test`, { method: 'POST' })
    ).json()) as any;
    check('providers without a safe probe are marked unverified rather than successful', () => {
      assert.equal(unverified.ok, null);
      assert.equal(unverified.verified, false);
      assert.match(unverified.message, /尚未验证/);
    });
  }
  const invalidAssetKind = await fetch(base + '/api/assets?kind=invalid');
  check('invalid asset filters return an actionable client error', () => assert.equal(invalidAssetKind.status, 400));
  const protectedAsset = assets.saveAsset({
    data: Buffer.from('must-not-delete'),
    mime: 'image/png',
    filename: 'protected-file.png',
  });
  runs.insertRun({
    id: 'protected-asset-run',
    providerId: 'deepseek',
    connectionId: deep.id,
    title: 'protected input',
    lifecycle: 'http',
    input: { image: protectedAsset.id },
  });
  const protectedDeletion = await fetch(base + `/api/assets/${protectedAsset.id}`, { method: 'DELETE' });
  const libraryResponse = await fetch(base + '/api/assets/library?q=protected-file&limit=1');
  const libraryBody = (await libraryResponse.json()) as any;
  check('asset library HTTP search exposes references and blocks deletion of in-use files', () => {
    assert.equal(protectedDeletion.status, 409);
    assert.equal(libraryResponse.status, 200);
    assert.equal(libraryBody.total, 1);
    assert.equal(libraryBody.items[0].referenceCount, 1);
    assert.ok(assets.getAssetFile(protectedAsset.id));
  });
  const savedProxy = 'http://fixture-user:fixture-password@127.0.0.1:7890';
  const proxyResponse = await fetch(base + '/api/settings/network', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proxyUrl: savedProxy }),
  });
  const visibleProxy = (await proxyResponse.json()) as any;
  check('network settings expose a display address without returning proxy credentials', () => {
    assert.equal(proxyResponse.status, 200);
    assert.equal(visibleProxy.hasCredentials, true);
    assert.ok(!JSON.stringify(visibleProxy).includes('fixture-user'));
    assert.ok(!JSON.stringify(visibleProxy).includes('fixture-password'));
  });
  const preserveProxy = await fetch(base + '/api/settings/preferences', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmTier: 'medium' }),
  });
  check('saving unrelated preferences retains proxy authentication', () => {
    assert.equal(preserveProxy.status, 200);
    assert.equal(network.getNetworkSettings().proxyUrl, savedProxy);
  });
  const invalidPreferences = await fetch(base + '/api/settings/preferences', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmTier: 'all', network: { proxyUrl: 'not-a-url' } }),
  });
  check('preferences validate before atomically writing network or cost policy', () => {
    assert.equal(invalidPreferences.status, 400);
    assert.equal(storage.getSetting('ui', { confirmTier: 'high' }).confirmTier, 'medium');
    assert.equal(network.getNetworkSettings().proxyUrl, savedProxy);
  });
  await fetch(base + '/api/settings/network', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ proxyUrl: '' }),
  });
  const missingApi = await fetch(base + '/api/not-an-endpoint');
  check('unknown local API routes return JSON 404 rather than the HTML shell', () => {
    assert.equal(missingApi.status, 404);
    assert.match(missingApi.headers.get('content-type') ?? '', /json/);
  });
  const missingChunk = await fetch(base + '/assets/not-a-current-build.js');
  check('missing frontend chunks return 404 instead of an HTML module response', () => {
    assert.equal(missingChunk.status, 404);
    assert.doesNotMatch(missingChunk.headers.get('content-type') ?? '', /text\/html/);
  });
  const invalidSetting = await fetch(base + '/api/settings', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ confirmTier: 'never' }),
  });
  check('invalid cost policy is rejected rather than weakening the configured threshold', () =>
    assert.equal(invalidSetting.status, 400),
  );
  const file = assets.saveAsset({ data: Buffer.from('0123456789'), mime: 'video/mp4' });
  const partial = await fetch(base + file.url, { headers: { Range: 'bytes=2-5' } });
  const partialBody = await partial.text();
  check('media Range returns correct bytes and headers', () => {
    assert.equal(partial.status, 206);
    assert.equal(partialBody, '2345');
    assert.equal(partial.headers.get('content-range'), 'bytes 2-5/10');
    assert.equal(partial.headers.get('accept-ranges'), 'bytes');
  });
  const suffix = await fetch(base + file.url, { headers: { Range: 'bytes=-3' } });
  const suffixBody = await suffix.text();
  check('media suffix Range works', () => {
    assert.equal(suffix.status, 206);
    assert.equal(suffixBody, '789');
  });
  const invalid = await fetch(base + file.url, { headers: { Range: 'bytes=99-' } });
  check('invalid media Range returns 416', () => assert.equal(invalid.status, 416));
  const head = await fetch(base + file.url, { method: 'HEAD' });
  check('media HEAD includes length and no bytes', () => {
    assert.equal(head.status, 200);
    assert.equal(head.headers.get('content-length'), '10');
  });
  const forbidden = await fetch(base + '/api/health', { headers: { Origin: 'https://untrusted.invalid' } });
  check('cross-site API requests are rejected', () => assert.equal(forbidden.status, 403));
  const form = new FormData();
  form.append('file', new File([Buffer.alloc(33)], 'too-large.bin'));
  const oversized = await fetch(base + '/api/assets', { method: 'POST', body: form });
  check('file upload size limit returns 413', () => assert.equal(oversized.status, 413));
  const missing = await fetch(base + '/api/run', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      connectionId: deep.id,
      operationId: chat.id,
      model: 'deepseek-chat',
      input: {},
      params: {},
    }),
  });
  check('server validates operation input before any upstream call', () => assert.equal(missing.status, 400));
  const importKey = 'fixture-only-import-secret';
  const importDoc = `## Local fixture | 通\nurl: ${upstreamBase}/v1\nkey: ${importKey}\nnote: echo ${importKey}`;
  const importRequest = (apply: boolean) =>
    fetch(base + '/api/connections/import', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: importDoc, apply }),
    });
  const previewResponse = await importRequest(false);
  const previewImport = (await previewResponse.json()) as any;
  const appliedImport = (await (await importRequest(true)).json()) as any;
  const repeatedImport = (await (await importRequest(true)).json()) as any;
  check('HTTP credential import previews safely and persists idempotently without credential echoes', () => {
    assert.equal(previewResponse.status, 200);
    assert.equal(previewImport.created, 0);
    assert.equal(appliedImport.created, 1);
    assert.equal(repeatedImport.created, 0);
    assert.equal(repeatedImport.reused, 1);
    assert.ok(!JSON.stringify([previewImport, appliedImport, repeatedImport]).includes(importKey));
  });
  const invalidImport = await fetch(base + '/api/connections/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: importDoc, apply: 'yes' }),
  });
  const largeImport = await fetch(base + '/api/connections/import', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'x'.repeat(601 * 1024) }),
  });
  check('HTTP credential import rejects malformed approval flags and oversized files', () => {
    assert.equal(invalidImport.status, 400);
    assert.equal(largeImport.status, 413);
  });
  console.log(`Backend checks passed: ${tests}; all HTTP/WS traffic used isolated loopback mocks.`);
} finally {
  chat.async = savedAsync;
  chat.realtime = savedRealtime;
  if (child && child.exitCode === null) {
    child.kill();
    await once(child, 'exit');
  }
  upstreamWS?.clients.forEach((ws) => ws.terminate());
  upstreamWS?.close();
  relayServer?.close();
  upstream.closeAllConnections();
  await new Promise<void>((resolve) => upstream.close(() => resolve()));
  storage.db.close();
  rmSync(temp, { recursive: true, force: true });
}
