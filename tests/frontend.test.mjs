import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { float32ToPcm16 } from '../frontend/voice/capture/pcm.mjs';
import { CoachApi } from '../frontend/transport/coach-api.mjs';
import {
  normalizeLearnerFeedback,
  normalizePracticeWords,
  youtubeEmbedUrl,
} from '../frontend/learner/feedback.mjs';
import { LearnerSession, renderSessionStatus } from '../frontend/learner/session.mjs';
import { attachCoachAudio } from '../frontend/learner/coach-audio.mjs';
import { waitForAgentJoin } from '../frontend/learner/coach-handoff.mjs';

test('PCM conversion clamps browser samples to signed 16-bit values', () => {
  const pcm = float32ToPcm16(new Float32Array([-2, -1, 0, 1, 2]));
  assert.deepEqual([...pcm], [-32768, -32768, 0, 32767, 32767]);
});

test('learner feedback accepts the bounded Rust response shape', () => {
  const feedback = normalizeLearnerFeedback({
    status: 'ready',
    words_to_practice: ['think', 'fifty'],
    coach_message: 'Practice slowly before increasing speed.',
    youtube_resources: [
      { title: 'TH practice', video_id: 'abcdefghijk' },
      { title: 'F practice', video_id: '12345678901' },
    ],
  });

  assert.deepEqual(feedback.words, ['think', 'fifty']);
  assert.equal(feedback.resources[0].videoId, 'abcdefghijk');
  assert.equal(feedback.practiceItems[0].word, 'think');
  assert.equal(feedback.practiceItems[0].resource.videoId, 'abcdefghijk');
  assert.equal(feedback.practiceItems[1].resource.videoId, '12345678901');
  assert.equal(youtubeEmbedUrl('abcdefghijk'), 'https://www.youtube-nocookie.com/embed/abcdefghijk');
});

test('learner preview accepts only bounded practice words', () => {
  assert.deepEqual(normalizePracticeWords([' think ', 'fifty']), ['think', 'fifty']);
  assert.deepEqual(normalizePracticeWords([{ word: 'unsafe' }]), []);
  assert.deepEqual(normalizePracticeWords(['a', 'b', 'c', 'd', 'e', 'f']), []);
});

test('coach request waits for the owned agent to join the RTC channel', async () => {
  let joined;
  const calls = [];
  const rtc = {
    remoteUsers: [],
    on: (event, listener) => { calls.push(['on', event]); joined = listener; },
    off: (event, listener) => { calls.push(['off', event, listener === joined]); },
  };
  const ready = waitForAgentJoin(rtc, '1001');
  joined({ uid: 999 });
  joined({ uid: 1001 });
  await ready;
  assert.deepEqual(calls, [['on', 'user-joined'], ['off', 'user-joined', true]]);
});

test('one safe video remains attached to the first focus word', () => {
  const feedback = normalizeLearnerFeedback({
    status: 'ready',
    words_to_practice: ['comfortable', 'presenting'],
    coach_message: 'Read the phrase at a steady pace.',
    youtube_resources: [{ title: 'Practice guide', video_id: 'abcdefghijk' }],
  });
  assert.equal(feedback.practiceItems[0].resource.videoId, 'abcdefghijk');
  assert.equal(feedback.practiceItems[1].resource, null);
});

test('coach audio subscribes only to the session agent and releases its listener', async () => {
  const calls = [];
  let handler;
  const rtc = {
    on: (event, listener) => { assert.equal(event, 'user-published'); handler = listener; },
    off: (event, listener) => { calls.push(['off', event, listener === handler]); },
    subscribe: async (user, mediaType) => { calls.push(['subscribe', user.uid, mediaType]); },
  };
  const release = attachCoachAudio(rtc, '1001', message => calls.push(['stage', message]), error => { throw error; });
  await handler({ uid: 999, audioTrack: { play: () => calls.push(['wrong']) } }, 'audio');
  await handler({ uid: 1001 }, 'video');
  await handler({ uid: 1001, audioTrack: { play: () => calls.push(['play']) } }, 'audio');
  release();
  assert.deepEqual(calls[0], ['subscribe', 1001, 'audio']);
  assert.deepEqual(calls[1], ['play']);
  assert.deepEqual(calls.at(-1), ['off', 'user-published', true]);
});

test('coach audio reports a failed subscription', async () => {
  let handler;
  let failure;
  attachCoachAudio({
    on: (_event, listener) => { handler = listener; },
    off: () => {},
    subscribe: async () => { throw new Error('provider detail'); },
  }, '1001', () => {}, error => { failure = error; });
  await handler({ uid: 1001 }, 'audio');
  assert.match(failure.message, /could not play/i);
  assert.doesNotMatch(failure.message, /provider detail/);
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

test('coach feedback uses the session-owned agent without accepting a browser agent ID', async () => {
  const request = await captureRequest(
    () => new CoachApi('https://api.example').createCoachFeedback('session/1'),
    { status: 'ready', words_to_practice: [], youtube_resources: [], coach_message: 'Ready.' },
  );
  assert.equal(request.url, 'https://api.example/api/coaching/sessions/session%2F1/coach-feedback');
  assert.equal(request.options.method, 'POST');
  assert.deepEqual(JSON.parse(request.options.body), {});
});

test('coach transport exposes result and session-owned agent lifecycle routes', async () => {
  const result = await captureRequest(
    () => new CoachApi('https://api.example').sessionResult('session/1'),
    { status: 'review_ready' },
  );
  assert.equal(result.url, 'https://api.example/api/coaching/sessions/session%2F1/result');

  const start = await captureRequest(
    () => new CoachApi('https://api.example').startCoachAgent('session/1'),
    { agent_id: 'agent-7' },
  );
  assert.equal(start.url, 'https://api.example/api/coaching/sessions/session%2F1/agent');
  assert.equal(start.options.method, 'POST');

  const stop = await captureRequest(
    () => new CoachApi('https://api.example').stopCoachAgent('session/1'),
    null,
    204,
  );
  assert.equal(stop.url, 'https://api.example/api/coaching/sessions/session%2F1/agent/stop');
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

test('queued inference has a specific bounded-wait status message', () => {
  assert.match(renderSessionStatus('queued'), /safely queued/i);
});

test('LearnerSession cancellation releases microphone tracks when recorder shutdown fails', async () => {
  const session = new LearnerSession({}, () => {});
  let stoppedTrack = false;
  session.active = {
    stream: { getTracks: () => [{ stop: () => { stoppedTrack = true; } }] },
    recorder: { stop: async () => { throw new Error('pending upload failed'); } },
  };

  await assert.rejects(() => session.cancel(), /pending upload failed/);
  assert.equal(stoppedTrack, true);
  assert.equal(session.active, null);
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
