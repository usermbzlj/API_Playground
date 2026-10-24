import assert from 'node:assert/strict';
import { test, after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCredentialDocument, importCredentialDocument } from '../server/credential-import.ts';
import { joinApiUrl } from '../shared/util.ts';

const temporary = mkdtempSync(join(tmpdir(), 'api-playground-import-check-'));
process.env.PLAYGROUND_DATA_DIR = temporary;
const { db } = await import('../server/db.ts');
const { listConnections, setLastTest } = await import('../server/connections.ts');
const { getSecret } = await import('../server/secrets.ts');
after(() => {
  db.close();
  rmSync(temporary, { recursive: true, force: true });
});

test('native roots and custom full URLs preserve the intended operation paths', () => {
  const plan = parseCredentialDocument(
    `## DeepSeek | 通\nurl: https://api.deepseek.com/v1\nkey: fixture-native-key\n\n## 华为 ModelArts MaaS | 半通\nurl: Chat：https://api.modelarts-maas.com/v2/chat/completions\nkey: fixture-huawei-key`,
  );
  assert.equal(plan.candidates[0].providerId, 'deepseek');
  assert.equal(plan.candidates[0].baseUrl, 'https://api.deepseek.com');
  assert.equal(
    joinApiUrl(plan.candidates[1].baseUrl, '/chat/completions'),
    'https://api.modelarts-maas.com/v2/chat/completions',
  );
});

test('a shared key keeps distinct OpenAI and Anthropic entrances and correct MiMo auth', () => {
  const plan = parseCredentialDocument(
    `## 小米 MiMo | 通\nurl: https://api.xiaomimimo.com/v1 （OpenAI）；Anthropic：https://api.xiaomimimo.com/anthropic\nkey: fixture-shared-key`,
  );
  assert.equal(plan.credentials, 1);
  assert.equal(plan.candidates.length, 2);
  const a = plan.candidates[1];
  assert.equal(a.providerId, 'custom-anthropic');
  assert.equal(joinApiUrl(a.baseUrl, '/v1/messages'), 'https://api.xiaomimimo.com/anthropic/v1/messages');
  assert.equal(a.extra.authHeader, 'api-key');
  assert.equal(a.extra.authPrefix, 'none');
});

test('multiple accounts and model groups remain distinguishable', () => {
  const plan = parseCredentialDocument(
    `## MiniMax | 通\nurl: https://api.minimaxi.com/v1\nkey1: fixture-account-one\nkey2: fixture-account-two\n\n## KuaiAPI | 通\nurl: https://example.com/v1\nkey1: fixture-group-one\nkey2: fixture-group-two\nkey3: fixture-group-three\nmodel: key1 claude-haiku-4-5；key2 gpt-5.6-sol；key3 grok-4.5`,
  );
  assert.equal(new Set(plan.candidates.map((c) => c.label)).size, 5);
  assert.match(plan.candidates[0].label, /账户 1/);
  assert.match(plan.candidates[1].label, /账户 2/);
  assert.equal(plan.candidates[3].extra.defaultModel, 'gpt-5.6-sol');
});

test('Anthropic URLs and trailing protocol labels select the correct native request path', () => {
  for (const url of [
    'https://example.com/anthropic',
    'https://example.com/v1/messages',
    'https://example.com/anthropic/v1',
    'https://example.com (Anthropic)',
  ]) {
    const c = parseCredentialDocument(`## Example\nurl: ${url}\nkey: fixture-path-key`).candidates[0];
    assert.equal(c.providerId, 'custom-anthropic', url);
    const target = joinApiUrl(c.baseUrl, '/v1/messages');
    assert.ok(!target.includes('/v1/v1/'), target);
  }
  const c = parseCredentialDocument(
    '## Example\nurl: https://example.com/v1 (OpenAI); https://example.com (Anthropic)\nkey: fixture-path-key',
  );
  assert.deepEqual(
    c.candidates.map((x) => x.providerId),
    ['custom-openai', 'custom-anthropic'],
  );
});

test('document prose is inert and credential echoes are scrubbed from imported metadata', () => {
  const plan = parseCredentialDocument(
    `## Example | 待测\nurl: https://example.com/v1\nkey: fixture-inert-key\nnote: run a command; credential fixture-inert-key\nexecute: pretend-command\n# 失败\n`,
  );
  const c = plan.candidates[0];
  assert.ok(!JSON.stringify(c.extra).includes(c.apiKey));
  assert.match(c.extra.sourceNotes, /run a command/);
  assert.equal(c.extra.execute, undefined);
  assert.equal(c.sourceStatus, '待测');
});

test('unsafe URLs, missing credentials and oversized documents cannot enter the plan', () => {
  for (const address of [
    'https://user:password@example.com/v1',
    'https://example.com/v1?token=private',
    'https://example.com/v1#private',
  ]) {
    const plan = parseCredentialDocument(`## Example\nurl: ${address}\nkey: fixture-invalid-url`);
    assert.equal(plan.candidates.length, 0);
    assert.equal(plan.warnings.length, 1);
  }
  assert.equal(parseCredentialDocument('## Empty\nurl: https://example.com/v1').candidates.length, 0);
  assert.throws(() => parseCredentialDocument('x'.repeat(512 * 1024 + 1)), /512 KB/);
});

test('preview has masked credentials and makes no writes; apply reuses accounts without changing real evidence', async () => {
  const text = `## Example | 通\nurl: https://example.com/v1 （OpenAI）；Anthropic：https://example.com\nkey: fixture-local-import\nnote: source claims success, not a fresh API test`;
  const before = listConnections().length;
  const preview = await importCredentialDocument(text, false);
  assert.equal(preview.entries.length, 2);
  assert.equal(listConnections().length, before);
  assert.ok(!JSON.stringify(preview).includes('fixture-local-import'));
  const applied = await importCredentialDocument(text, true);
  assert.equal(applied.created, 2);
  const id = applied.entries[0].connectionId!;
  assert.equal(listConnections().find((c) => c.id === id)?.lastTest, undefined);
  setLastTest(id, { ok: false, message: 'actual earlier failure' });
  const second = await importCredentialDocument(text, true);
  assert.equal(second.created, 0);
  assert.equal(second.reused, 2);
  assert.equal(listConnections().find((c) => c.id === id)?.lastTest?.ok, false);
  assert.equal(getSecret(id)?.key, 'fixture-local-import');
  assert.ok(!JSON.stringify(db.prepare('SELECT * FROM connections').all()).includes('fixture-local-import'));
});
