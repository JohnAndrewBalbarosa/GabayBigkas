import { test } from 'node:test';
import assert from 'node:assert/strict';
import { float32ToPcm16 } from '../frontend/voice/capture/pcm.mjs';
import { CoachApi } from '../frontend/transport/coach-api.mjs';
import { normalizeLearnerFeedback, youtubeEmbedUrl } from '../frontend/learner/feedback.mjs';
import { LearnerSession, renderSessionStatus } from '../frontend/learner/session.mjs';

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

test('learner feedback accepts bounded structured output and constructs a privacy-enhanced embed', () => {
  const feedback = normalizeLearnerFeedback({
    status: 'ready',
    words_to_practice: [{ word: 'think', reason: 'Unclear consonant.', pronunciation_tip: 'Keep the tongue forward.' }],
    coach_message: 'Practice slowly before increasing speed.',
    youtube_resources: [{ title: 'TH practice', video_id: 'abcdefghijk' }],
  });

  assert.equal(feedback.words[0].word, 'think');
  assert.equal(feedback.resources[0].videoId, 'abcdefghijk');
  assert.equal(youtubeEmbedUrl('abcdefghijk'), 'https://www.youtube-nocookie.com/embed/abcdefghijk');
});

test('learner feedback rejects untrusted video URLs and malformed tool output', () => {
  assert.equal(youtubeEmbedUrl('https://evil.example'), null);
  assert.equal(normalizeLearnerFeedback({ status: 'ready', coach_message: 'Missing arrays.' }), null);
  assert.equal(normalizeLearnerFeedback({
    status: 'ready',
    words_to_practice: [],
    coach_message: 'Message',
    youtube_resources: [{ title: 'Unsafe', video_id: '<script>x' }],
  }), null);
});

test('Modal execution request is authenticated by the Rust session and scoped to one encoded job', async () => {
  const originalFetch = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, options };
    return new Response(JSON.stringify({ job_id: 'job/1', status: 'review_ready', review_items: 1 }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    await new CoachApi('https://api.example').runInferenceOnModal('job/1');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(request.url, 'https://api.example/api/inference/jobs/job%2F1/modal-run');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.credentials, 'include');
  assert.equal(request.options.headers, undefined);
});

test('LearnerSession finishes with fire-and-forget finalize and does not trigger Modal inference', async () => {
  const statuses = [];
  const calls = [];
  const fakeApi = {
    finalizeSession: async id => {
      calls.push(['finalize', id]);
      return { session_id: id, status: 'pending_manual_inference', acknowledged: true, inference_job_id: 'job-123' };
    },
    runInferenceOnModal: async () => {
      calls.push(['modal-run']);
      return { status: 'review_ready' };
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
  assert.equal(result.acknowledged, true);
  assert.ok(statuses.includes('Processing session audio...'));
  assert.ok(statuses.some(s => s.includes('Audio received')));
});

test('renderSessionStatus reflects backend-managed inference without frontend Modal assumptions', () => {
  const pendingStatus = renderSessionStatus('pending_manual_inference');
  const exportedStatus = renderSessionStatus('exported');
  const readyStatus = renderSessionStatus('review_ready');
  const unavailableStatus = renderSessionStatus('model_unavailable');

  assert.match(pendingStatus, /backend/i);
  assert.doesNotMatch(pendingStatus, /colab/i);
  assert.doesNotMatch(exportedStatus, /colab/i);
  assert.match(readyStatus, /human review/i);
  assert.match(unavailableStatus, /Modal/i);
});

test('uploadPcmChunk transmits audio chunk headers and returns idempotent acceptance', async () => {
  const originalFetch = globalThis.fetch;
  let captured;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ accepted: true, idempotent: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };

  try {
    const api = new CoachApi('https://api.example');
    const bytes = new Uint8Array([0, 1, 2, 3]);
    const res = await api.uploadPcmChunk('sess-42', 3, 16000, 1, bytes);
    assert.deepEqual(res, { accepted: true, idempotent: true });
    assert.equal(captured.url, 'https://api.example/api/coaching/sessions/sess-42/audio/chunks');
    assert.equal(captured.options.method, 'POST');
    assert.equal(captured.options.headers['X-Audio-Sequence'], '3');
    assert.equal(captured.options.headers['X-Sample-Rate'], '16000');
    assert.equal(captured.options.headers['X-Channels'], '1');
    assert.equal(captured.options.headers['Content-Type'], 'application/octet-stream');
  } finally {
    globalThis.fetch = originalFetch;
  }
});
