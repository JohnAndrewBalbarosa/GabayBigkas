import assert from 'node:assert/strict';
import test from 'node:test';
import { mintSessionTokens } from '../backend/api/adapters/agora-tokens.mjs';

const credentials = {
  appId: 'a'.repeat(32), appCertificate: 'b'.repeat(32),
  channel: `coach-${'c'.repeat(32)}`, clientUid: '1002', agentUid: '1001', ttl: 600,
};

test('official token adapter creates scoped credentials without echoing signing secrets', () => {
  const tokens = mintSessionTokens(credentials);
  assert.deepEqual(Object.keys(tokens).sort(), ['agent_token', 'client_rtc_token', 'client_rtm_token', 'server_token']);
  for (const token of Object.values(tokens)) {
    assert.match(token, /^007/);
    assert.equal(token.includes(credentials.appCertificate), false);
  }
  assert.notEqual(tokens.agent_token, tokens.server_token);
  assert.notEqual(tokens.client_rtc_token, mintSessionTokens({ ...credentials, channel: `coach-${'d'.repeat(32)}` }).client_rtc_token);
});

test('token adapter rejects unbounded lifetime and arbitrary channel identities', () => {
  for (const override of [{ ttl: 601 }, { ttl: 59 }, { channel: '../other' }, { clientUid: '0' }, { appCertificate: '' }]) {
    assert.throws(() => mintSessionTokens({ ...credentials, ...override }));
  }
});
