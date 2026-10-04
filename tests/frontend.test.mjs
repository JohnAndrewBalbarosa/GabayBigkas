import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { float32ToPcm16 } from '../frontend/voice/capture/pcm.mjs';
import { CoachApi } from '../frontend/transport/coach-api.mjs';
import { normalizeLearnerFeedback, youtubeEmbedUrl } from '../frontend/learner/feedback.mjs';
import { LearnerSession, renderSessionStatus } from '../frontend/learner/session.mjs';

test('PCM conversion clamps browser samples to signed 16-bit values', () => {
  const pcm = float32ToPcm16(new Float32Array([-2, -1, 0, 1, 2]));
  assert.deepEqual([...pcm], [-32768, -32768, 0, 32767, 32767]);
});

test('learner feedback accepts the bounded Rust response shape', () => {
  const feedback = normalizeLearnerFeedback({
    status: 'ready',
    words_to_practice: ['think', 'fifty'],
    coach_message: 'Practice slowly before increasing speed.',
    youtube_resources: [{ title: 'TH practice', video_id: 'abcdefghijk' }],
  });

  assert.deepEqual(feedback.words, ['think', 'fifty']);
  assert.equal(feedback.resources[0].videoId, 'abcdefghijk');
  assert.equal(youtubeEmbedUrl('abcdefghijk'), 'https://www.youtube-nocookie.com/embed/abcdefghijk');
});

test('learner feedback rejects object-shaped words, untrusted video IDs, and malformed output', () => {
  assert.equal(youtubeEmbedUrl('https://evil.example'), null);
  assert.equal(normalizeLearnerFeedback({ status: 'ready', coach_message: 'Missing arrays.' }), null);
  assert.equal(normalizeLearnerFeedback({
    status: 'ready',
    words_to_practice: [{ word: 'think' }],
    coach_message: 'Message',
    youtube_resources: [],
  }), null);
  assert.equal(normalizeLearnerFeedback({
    status: 'ready',
    words_to_practice: [],
    coach_message: 'Message',
    youtube_resources: [{ title: 'Unsafe', video_id: '<script>x' }],
  }), null);
});

test('product transport uses only canonical backend routes', async () => {
  const source = await readFile(new URL('../frontend/transport/coach-api.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\/api\/inference|poc-ticket|modal-run|\/export|\/import/);
  assert.match(source, /\/api\/coaching\/sessions\/\$\{encodeURIComponent\(sessionId\)\}\/coach-feedback/);
  assert.match(source, /\/api\/annotation\/items\/\$\{encodeURIComponent\(id\)\}\/decision/);
});

test('session lookup encodes the ID and includes the secure session cookie', async () => {
  const request = await captureRequest(
    () => new CoachApi('https://api.example').coachingSession('session/1'),
    { id: 'session/1', status: 'review_ready' },
  );
  assert.equal(request.url, 'https://api.example/api/coaching/sessions/session%2F1');
  assert.equal(request.options.credentials, 'include');
});

test('coach feedback sends only the backend-owned agent identifier', async () => {
  const request = await captureRequest(
    () => new CoachApi('https://api.example').createCoachFeedback('session/1', 'agent-7'),
    { status: 'ready', words_to_practice: [], youtube_resources: [], coach_message: 'Ready.' },
  );
  assert.equal(request.url, 'https://api.example/api/coaching/sessions/session%2F1/coach-feedback');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), { agent_id: 'agent-7' });
});

test('annotation decision preserves the four-field backend payload', async () => {
  const decision = {
    decision: 'corrected_transcript',
    corrected_text: 'Fifty people think clearly.',
    notes: 'Reviewed with full sentence context.',
  };
  const request = await captureRequest(
    () => new CoachApi('https://api.example').decideAnnotation('item/1', decision),
    null,
    204,
  );
  assert.equal(request.url, 'https://api.example/api/annotation/items/item%2F1/decision');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.credentials, 'include');
  assert.deepEqual(JSON.parse(request.options.body), decision);
});

test('LearnerSession finalizes once and always stops the microphone tracks first', async () => {
  const statuses = [];
  const calls = [];
  const fakeApi = {
    finalizeSession: async id => {
      calls.push(['finalize', id]);
      return { session_id: id, status: 'pending_manual_inference', acknowledged: true, inference_job_id: 'job-123' };
    },
  };
  const session = new LearnerSession(fakeApi, status => statuses.push(status));
  let stoppedTrack = false;
  let stoppedRecorder = false;
  session.active = {
    session: { id: 'sess-1' },
    stream: { getTracks: () => [{ stop: () => { stoppedTrack = true; } }] },
    recorder: { stop: async () => { stoppedRecorder = true; } },
    transcriptSequence: 0,
  };

  const result = await session.finish();

  assert.equal(stoppedTrack, true);
  assert.equal(stoppedRecorder, true);
  assert.deepEqual(calls, [['finalize', 'sess-1']]);
  assert.equal(result.status, 'pending_manual_inference');
  assert.ok(statuses.some(status => status.includes('backend')));
});

test('renderSessionStatus reflects backend-managed inference without deprecated browser controls', () => {
  assert.match(renderSessionStatus('pending_manual_inference'), /backend/i);
  assert.match(renderSessionStatus('review_ready'), /human review/i);
  assert.doesNotMatch(renderSessionStatus('pending_manual_inference'), /colab|export|manual/i);
  assert.doesNotMatch(renderSessionStatus('model_unavailable'), /token|credential/i);
});

test('uploadPcmChunk transmits bounded audio metadata and returns idempotent acceptance', async () => {
  const bytes = new Uint8Array([0, 1, 2, 3]);
  const request = await captureRequest(
    () => new CoachApi('https://api.example').uploadPcmChunk('sess/42', 3, 16000, 1, bytes),
    { accepted: true, idempotent: true },
  );
  assert.equal(request.url, 'https://api.example/api/coaching/sessions/sess%2F42/audio/chunks');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['X-Audio-Sequence'], '3');
  assert.equal(request.options.headers['X-Sample-Rate'], '16000');
  assert.equal(request.options.headers['X-Channels'], '1');
  assert.equal(request.options.headers['Content-Type'], 'application/octet-stream');
});

async function captureRequest(action, payload, status = 200) {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(status === 204 ? null : JSON.stringify(payload), {
      status,
      headers: status === 204 ? undefined : { 'Content-Type': 'application/json' },
    });
  };
  try {
    await action();
    return request;
  } finally {
    globalThis.fetch = originalFetch;
  }
}
