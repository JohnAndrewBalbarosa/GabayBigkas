import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { createLabServer } from '../backend/lab/http.mjs';
import { readConfig } from '../backend/lab/config.mjs';
import { issueToken } from '../backend/lab/tokens.mjs';
import { createEventLogger } from '../backend/lab/events.mjs';
import { mkdtempSync, openSync, readSync, closeSync, statSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('HTTP boundary, static UI, dry-run, and blocked live workflow', async () => {
  let upstreamCalls = 0;
  const server = createLabServer(readConfig({}), { fetcher: () => { upstreamCalls++; throw new Error('Unexpected upstream'); } });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const catalog = await (await fetch(`${base}/api/catalog`)).json();
    assert.ok(catalog.products.length >= 17);
    const headers = { 'Content-Type': 'application/json', 'X-Lab-Session': catalog.session };
    const op = catalog.products.find(p => p.id === 'rtc').operations.find(o => o.path === '/dev/v1/channel/{appid}' && o.method === 'GET');
    const payload = { ...op.input, path: { appid: 'a'.repeat(32) }, operationId: op.id, mode: 'dry-run' };
    const post = (body, customHeaders = headers) => fetch(`${base}/api/execute`, { method: 'POST', headers: customHeaders, body: typeof body === 'string' ? body : JSON.stringify(body) });
    assert.equal((await (await post(payload)).json()).status, 'dry-run');
    assert.equal((await (await post({ ...payload, mode: 'live', confirm: op.id })).json()).status, 'blocked');
    assert.equal((await post(payload, { 'Content-Type': 'application/json' })).status, 403);
    assert.equal((await post(payload, { ...headers, Origin: 'https://attacker.invalid' })).status, 403);
    assert.equal((await post('{')).status, 400);
    assert.equal((await post('null')).status, 400);
    assert.equal((await post('[]')).status, 400);
    assert.equal((await post({ ...payload, path: [] })).status, 400);
    assert.equal((await post({ ...payload, operationId: 'missing' })).status, 404);
    assert.equal((await post(payload, { ...headers, 'Content-Type': 'text/plain' })).status, 415);
    assert.equal((await fetch(`${base}/.env`)).status, 404);
    // Node fetch rewrites Host; raw HTTP preserves the hostile header under test.
    const hostileHostStatus = await new Promise((resolve, reject) => {
      const req = request(`${base}/api/health`, { headers: { Host: 'evil.test' } }, response => { response.resume(); resolve(response.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(hostileHostStatus, 403);
    const page = await fetch(base);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(await page.text(), /Agora \/ Event Lab/);
    assert.equal(upstreamCalls, 0);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});

test('official token builder issues bounded RTC, RTM, and Chat tokens using synthetic keys only', () => {
  const config = { ...readConfig({}), liveEnabled: true, AGORA_APP_ID: 'a'.repeat(32), AGORA_APP_CERTIFICATE: 'b'.repeat(32) };
  for (const type of ['rtc', 'rtm', 'chat']) {
    const result = issueToken(config, { type, channel: 'test-room', uid: 1001, ttl: 600 });
    assert.match(result.token, /^007/);
    assert.equal(result.uid, 1001);
    const remaining = Date.parse(result.expiresAt) - Date.now();
    assert.ok(remaining > 590000 && remaining <= 600000);
    assert.ok(!result.token.includes(config.AGORA_APP_CERTIFICATE));
  }
  for (const change of [{ ttl: 86400 }, { ttl: -1 }, { uid: 0 }, { uid: 1.5 }, { channel: '../x' }, { type: 'unknown' }, { role: 'admin' }]) assert.throws(() => issueToken(config, { type: 'rtc', uid: 1001, channel: 'test', ...change }));
  assert.throws(() => issueToken(readConfig({}), { type: 'rtc', uid: 1001 }));
});

test('structured lifecycle log rotates within a bounded size', () => {
  const directory = mkdtempSync(join(tmpdir(), 'agora-log-test-'));
  try {
    const log = createEventLogger(directory);
    for (let i = 0; i < 1900; i++) log({ event: 'test.validation', component: 'test', operation: 'rotation', traceId: String(i), status: 'success' });
    const path = join(directory, 'events.jsonl');
    assert.ok(statSync(path).size < 263000);
    const handle = openSync(path, 'r');
    const tail = Buffer.alloc(1024);
    const size = statSync(path).size;
    const count = readSync(handle, tail, 0, Math.min(size, 1024), Math.max(0, size - 1024));
    closeSync(handle);
    const last = tail.subarray(0, count).toString().trim().split('\n').at(-1);
    assert.equal(JSON.parse(last).traceId, '1899');
    assert.ok(JSON.parse(last).timestamp);
  } finally { assert.ok(directory.startsWith(join(tmpdir(), 'agora-log-test-'))); rmSync(directory, { recursive: true }); }
});
