import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { spawnSync } from 'node:child_process';
import { toCurl, toPowerShell } from '../web/lab/request-code.ts';
import {
  startRunSession,
  readRunSession,
  listRunSessions,
  cancelRunSession,
  setExternalRunSession,
} from '../web/lab/useRunner.ts';
import type { RunRequestBody } from '../web/api.ts';
import { appendMessageAsset, configurationSignature } from '../web/lab/input-state.ts';
import { getOperation } from '../shared/catalog.ts';

const stored = new Map<string, string>();
Object.defineProperty(globalThis, 'sessionStorage', {
  configurable: true,
  value: {
    get length() {
      return stored.size;
    },
    key: (index: number) => [...stored.keys()][index] ?? null,
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => stored.set(key, value),
    removeItem: (key: string) => stored.delete(key),
    clear: () => stored.clear(),
  },
});
const { writeDraft, readDraft, listDrafts, clearDraft, clearAllDrafts, sanitizeDraftForStorage } =
  await import('../web/workspace-state.ts');
const originalFetch = globalThis.fetch;
after(() => {
  clearAllDrafts();
  globalThis.fetch = originalFetch;
});

test('draft restores exact input and disabled parameters without persisting serialized credentials', async () => {
  const draft = {
    input: { messages: [{ role: 'user', content: '保留这段输入🙂' }] },
    params: { temperature: { enabled: false, value: 0.7 } },
    headers: JSON.stringify({ Authorization: 'Bearer private-fixture', 'x-api-key': 'private-key', 'x-test': 'keep' }),
    body: JSON.stringify({ api_key: 'body-private-key', thoughtSignature: 'native-signature', prompt: 'keep' }),
  };
  writeDraft('workspace-test', draft, { title: '续接实验', href: '#/lab/example', operationId: 'example' });
  assert.deepEqual(readDraft('workspace-test'), draft, 'active editor retains its exact in-memory value');
  assert.equal(listDrafts().find((row) => row.key === 'workspace-test')?.href, '#/lab/example');
  await pause(300);
  const persisted = [...stored.values()].join('');
  for (const secret of ['private-fixture', 'private-key', 'body-private-key'])
    assert.equal(persisted.includes(secret), false);
  const restored = JSON.parse(stored.get('prismlab:draft:v1:workspace-test')!).value;
  assert.deepEqual(restored.input, draft.input);
  assert.deepEqual(restored.params, draft.params);
  assert.equal(JSON.parse(restored.headers)['x-test'], 'keep');
  assert.equal(JSON.parse(restored.body).thoughtSignature, 'native-signature');
  assert.equal(sanitizeDraftForStorage({ headers: '{"Authorization":"unfinished' }).headers, '');
  clearDraft('workspace-test');
  assert.equal(readDraft('workspace-test'), undefined);
  assert.equal(stored.has('prismlab:draft:v1:workspace-test'), false);
});

test('hidden editor state stays recoverable without creating duplicate home cards', () => {
  writeDraft('bench:tab', 'monitor', { hidden: true });
  assert.equal(readDraft('bench:tab'), 'monitor');
  assert.equal(
    listDrafts().some((row) => row.key === 'bench:tab'),
    false,
  );
  clearDraft('bench:tab');
});

test('upload completion merges into the latest message and cannot resurrect a removed message', () => {
  const latest = {
    system: 'new system',
    messages: [{ _id: 'message-a', role: 'user', content: 'typed while uploading', images: ['first'] }],
  };
  const merged = appendMessageAsset(latest, 'message-a', 'images', 'second');
  assert.equal((merged.messages as any[])[0].content, 'typed while uploading');
  assert.equal(merged.system, 'new system');
  assert.deepEqual((merged.messages as any[])[0].images, ['first', 'second']);
  const removed = { system: 'new system', messages: [] };
  assert.equal(appendMessageAsset(removed, 'message-a', 'images', 'late-upload'), removed);
});

test('restoring historical results ignores disabled defaults and detects actual new input', () => {
  const op = getOperation('custom-openai.embedding')!;
  const saved = { connectionId: 'fixture', model: 'embedding-fixture', input: { texts: ['A', 'B'] }, params: {} };
  const editor = { ...saved, params: { dimensions: { enabled: false, value: 128 } } };
  assert.equal(configurationSignature(op, saved), configurationSignature(op, editor));
  assert.notEqual(
    configurationSignature(op, saved),
    configurationSignature(op, { ...editor, input: { texts: ['C', 'B'] } }),
  );
});

function mockStream(mode: 'complete' | 'hold' | 'truncated', dispatches: { count: number }) {
  globalThis.fetch = async (_url, options) => {
    dispatches.count++;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          const emit = (type: string, data: unknown) =>
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ t: 1, type, data })}\n\n`));
          emit('request', { runId: `fixture-${dispatches.count}` });
          emit('chunk', { data: { choices: [{ delta: { content: 'partial' } }] } });
          if (mode === 'complete') {
            emit('done', { status: 'ok' });
            controller.close();
          } else if (mode === 'truncated') controller.close();
          else
            options?.signal?.addEventListener(
              'abort',
              () => controller.error(new DOMException('cancelled', 'AbortError')),
              { once: true },
            );
        },
      }),
      { headers: { 'content-type': 'text/event-stream' } },
    );
  };
}

test('background run has one dispatch, immutable result input, and explicit cancellation', async () => {
  const counter = { count: 0 };
  mockStream('hold', counter);
  const input: RunRequestBody = {
    connectionId: 'fixture',
    operationId: 'custom-openai.embedding',
    title: '后台实验',
    input: { texts: ['A', 'B'] },
  };
  const pending = startRunSession('workspace-running', input, '#/lab/custom-openai.embedding');
  await pause(0);
  await startRunSession('workspace-running', input);
  assert.equal(counter.count, 1, 'a second click cannot dispatch another billable request');
  (input.input as any).texts[0] = 'C';
  assert.equal((readRunSession('workspace-running')?.inputSnapshot?.input as any).texts[0], 'A');
  assert.ok(listRunSessions().some((session) => session.sessionKey === 'workspace-running' && session.running));
  cancelRunSession('workspace-running');
  await pending;
  assert.equal(readRunSession('workspace-running')?.status, 'cancelled');
  assert.equal(readRunSession('workspace-running')?.running, false);
  assert.ok(
    readRunSession('workspace-running')?.events.some((event) => event.type === 'chunk'),
    'partial events survive stopping',
  );
});

test('dropped local stream becomes an actionable terminal failure', async () => {
  mockStream('truncated', { count: 0 });
  await startRunSession('workspace-dropped', { connectionId: 'fixture', title: '中断实验' });
  const run = readRunSession('workspace-dropped');
  assert.equal(run?.status, 'error');
  assert.equal(run?.running, false);
  assert.match(run?.error?.hints.join(' '), /记录/);
  assert.ok(run?.events.some((event) => event.type === 'chunk'));
});

test('global stop also disconnects an external realtime session', () => {
  let stopped = false;
  setExternalRunSession('workspace-realtime', { title: '实时会话', href: '#/lab/realtime' }, true, () => {
    stopped = true;
  });
  cancelRunSession('workspace-realtime');
  assert.equal(stopped, true);
  setExternalRunSession('workspace-realtime', { title: '实时会话', href: '#/lab/realtime' }, false, () => {});
});

test('completed background sessions are bounded while active sessions remain available', async () => {
  mockStream('complete', { count: 0 });
  for (let i = 0; i < 12; i++)
    await startRunSession(`workspace-completed-${i}`, { connectionId: 'fixture', title: `实验 ${i}` });
  assert.ok(listRunSessions().filter((session) => !session.running).length <= 8);
  assert.equal(readRunSession('workspace-completed-11')?.status, 'ok');
});

test('PowerShell and Bash exports preserve quotes, Unicode and environment-key substitution without invoking an API', () => {
  const request = {
    method: 'POST',
    url: 'https://example.invalid/v1/chat?key=$API_KEY',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer $API_KEY' },
    bodyType: 'json',
    body: { messages: [{ role: 'user', content: "O'Brien\n中文🙂 $literal `literal" }] },
  };
  const ps = toPowerShell(request);
  const bash = toCurl(request);
  assert.match(ps, /EscapeDataString\(\$env:API_KEY\)/);
  assert.match(bash, /\$\{API_KEY\}/);
  assert.match(ps, /O''Brien/);
  assert.match(bash, /O'\\''Brien/);
  if (process.platform === 'win32') {
    const check = spawnSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$source=[Console]::In.ReadToEnd(); $tokens=$null; $errors=$null; [System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors) | Out-Null; if($errors.Count){ $errors | ForEach-Object {$_.Message}; exit 1 }',
      ],
      { input: ps, encoding: 'utf8', windowsHide: true },
    );
    assert.equal(check.status, 0, check.stdout + check.stderr);
  }
});
