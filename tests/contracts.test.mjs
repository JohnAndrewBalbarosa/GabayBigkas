import { test } from 'node:test';
import assert from 'node:assert/strict';
import { operations, products } from '../backend/lab/catalog.mjs';
import { sampleInput, validateInput, checkSchema } from '../backend/lab/contracts.mjs';
import { buildUrl, executeOperation, redact } from '../backend/lab/transport.mjs';
import { readConfig, publicConfig } from '../backend/lab/config.mjs';

const configured = { ...readConfig({}), liveEnabled: true, AGORA_APP_ID: 'a'.repeat(32), AGORA_CUSTOMER_ID: 'customer-test', AGORA_CUSTOMER_SECRET: 'secret-test-123' };
const channelList = [...operations.values()].find(o => o.path === '/dev/v1/channel/{appid}' && o.method === 'GET');
const input = { path: { appid: configured.AGORA_APP_ID }, query: {} };

test('catalog has provenance, distinct IDs, primary and specialized products', () => {
  assert.equal(operations.size, products.reduce((n, p) => n + p.operations.length, 0));
  for (const id of ['rtc', 'ai', 'chat', 'whiteboard', 'stt', 'recording', 'signaling', 'iot', 'extensions']) assert.ok(products.some(p => p.id === id));
  for (const p of products.filter(p => p.operations.length)) assert.match(p.provenance.sha256, /^[a-f\d]{64}$/);
});

for (const operation of operations.values()) {
  test(`offline contract isolation: ${operation.id}`, async () => {
    let called = false;
    const sample = sampleInput(operation, configured.AGORA_APP_ID);
    const url = buildUrl(operation, sample, configured);
    assert.equal(new URL(url).protocol, 'https:');
    const result = await executeOperation(operation, { ...sample, mode: 'dry-run' }, configured, { fetcher: () => { called = true; throw new Error('No provider traffic allowed'); } });
    assert.equal(called, false);
    assert.ok(['dry-run', 'invalid'].includes(result.status));
    for (const p of operation.parameters.filter(p => p.required)) {
      const missing = structuredClone(sample);
      delete missing[p.in][p.name];
      assert.ok(validateInput(operation, missing).some(issue => issue.includes(p.name)));
    }
    if (operation.bodySchema) assert.doesNotThrow(() => checkSchema(operation.bodySchema, sample.body, 'body'));
  });
}

test('valid read-only request dry-runs without keys', async () => {
  const result = await executeOperation(channelList, { ...input, mode: 'dry-run' }, readConfig({}));
  assert.equal(result.status, 'dry-run');
  assert.equal(result.networkCalled, false);
  assert.equal(result.preview.url, `https://api.agora.io/dev/v1/channel/${configured.AGORA_APP_ID}`);
});

test('live mode is blocked without both environment opt-in and credentials', async () => {
  for (const config of [readConfig({}), { ...readConfig({}), liveEnabled: true }]) {
    const result = await executeOperation(channelList, { ...input, mode: 'live', confirm: channelList.id }, config, { fetcher: () => assert.fail('must not connect') });
    assert.equal(result.status, 'blocked');
    assert.equal(result.networkCalled, false);
  }
});

test('live calls require exact confirmation even for GET', async () => {
  const result = await executeOperation(channelList, { ...input, mode: 'live' }, configured, { fetcher: () => assert.fail('must not connect') });
  assert.equal(result.status, 'blocked');
});

test('transport builds Basic Auth server-side, redacts results, and logs metadata only', async () => {
  const events = [];
  const result = await executeOperation(channelList, { ...input, mode: 'live', confirm: channelList.id }, configured, {
    log: event => events.push(event),
    fetcher: async (url, options) => {
      assert.ok(url.endsWith(configured.AGORA_APP_ID));
      assert.equal(options.method, 'GET');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, `Basic ${Buffer.from('customer-test:secret-test-123').toString('base64')}`);
      return Response.json({ success: true, token: 'provider-secret', nested: { message: configured.AGORA_CUSTOMER_SECRET } });
    },
  });
  assert.equal(result.status, 'live-response');
  assert.equal(result.data.token, '[REDACTED]');
  assert.equal(result.data.nested.message, '[REDACTED]');
  assert.equal(events.length, 1);
  assert.ok(!JSON.stringify(events).includes('secret'));
  assert.equal(events[0].traceId, result.traceId);
});

test('provider failures, semantic failures, timeout, and oversized responses stay distinguishable', async () => {
  const cases = [
    [async () => Response.json({ error: 'unauthorized' }, { status: 401 }), 'provider-error'],
    [async () => Response.json({ success: false }), 'provider-error'],
    [async () => { throw new DOMException('timeout', 'TimeoutError'); }, 'network-error'],
    [async () => new Response('x'.repeat(270000)), 'network-error'],
  ];
  for (const [fetcher, expected] of cases) {
    let calls = 0;
    const result = await executeOperation(channelList, { ...input, mode: 'live', confirm: channelList.id }, configured, { fetcher: (...args) => { calls++; return fetcher(...args); } });
    assert.equal(result.status, expected);
    assert.equal(calls, 1);
  }
});

test('path traversal, URL injection, SSRF, and unknown query parameters are rejected', () => {
  for (const value of ['..', '.', 'a/b', 'a\\b', '\u0000']) assert.throws(() => buildUrl(channelList, { path: { appid: value } }, configured));
  assert.throws(() => buildUrl({ ...channelList, server: 'https://127.0.0.1' }, input, configured));
  const chat = { ...channelList, server: 'https://CHAT_HOST', product: { auth: 'chat' } };
  for (const host of ['http://a.chat.agora.io', 'https://a.chat.agora.io.evil.test', 'https://127.0.0.1', 'https://a.chat.agora.io/private']) assert.throws(() => buildUrl(chat, input, { ...configured, AGORA_CHAT_HOST: host }));
  assert.ok(validateInput(channelList, { ...input, query: { arbitrary: 'x' } }).length);
});

test('public readiness exposes presence only and redaction handles nested fields', () => {
  const publicData = publicConfig(configured);
  assert.equal(publicData.credentials.AGORA_CUSTOMER_SECRET, true);
  assert.ok(!JSON.stringify(publicData).includes('secret-test-123'));
  assert.deepEqual(redact({ credentials: 'x', list: [{ api_key: 'x', text: 'Basic YWJj' }] }), { credentials: '[REDACTED]', list: [{ api_key: '[REDACTED]', text: 'Basic [REDACTED]' }] });
});

test('schema validation rejects nested missing fields and wrong types', () => {
  const operation = { parameters: [], bodyRequired: true, method: 'POST', bodySchema: { type: 'object', required: ['properties'], properties: { properties: { type: 'object', required: ['uid'], properties: { uid: { type: 'integer', minimum: 1 } } } } } };
  assert.ok(validateInput(operation, { body: {} }).length);
  assert.ok(validateInput(operation, { body: { properties: { uid: 'wrong' } } }).length);
  assert.deepEqual(validateInput(operation, { body: { properties: { uid: 7 } } }), []);
});

test('payload secret references resolve on server only and are redacted from provider echoes', async () => {
  const operation = { ...channelList, id: 'test.secret-body', method: 'POST', bodyRequired: true, bodySchema: { type: 'object' } };
  const data = { ...input, mode: 'live', confirm: operation.id, body: { api_key: '{{LAB_SECRET_LLM_KEY}}' } };
  const missing = await executeOperation(operation, data, configured, { fetcher: () => assert.fail('missing secret must block') });
  assert.equal(missing.status, 'blocked');
  const config = { ...configured, payloadSecrets: { LAB_SECRET_LLM_KEY: 'synthetic-llm-secret' } };
  const result = await executeOperation(operation, data, config, { fetcher: async (_url, options) => {
    assert.equal(JSON.parse(options.body).api_key, 'synthetic-llm-secret');
    return Response.json({ message: 'synthetic-llm-secret' });
  } });
  assert.equal(result.data.message, '[REDACTED]');
  assert.ok(!JSON.stringify(publicConfig(config)).includes('synthetic-llm-secret'));
});
