import { test } from 'node:test';
import assert from 'node:assert/strict';
import { float32ToPcm16 } from '../frontend/voice/capture/pcm.mjs';
import { CoachApi } from '../frontend/transport/coach-api.mjs';

test('PCM conversion clamps browser samples to signed 16-bit values', () => {
  const pcm = float32ToPcm16(new Float32Array([-2, -1, 0, 1, 2]));
  assert.deepEqual([...pcm], [-32768, -32768, 0, 32767, 32767]);
});

test('POC ticket request is scoped to exactly one encoded inference job', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ job_id: 'job/1', token: 'secret', expires_at: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  try {
    await new CoachApi('https://api.example').createInferencePocTicket('job/1');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(request.url, 'https://api.example/api/inference/jobs/job%2F1/poc-ticket');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.credentials, 'include');
});
