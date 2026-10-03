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

test('LearnerSession finishes and sequentially triggers private Modal T4 inference', async () => {
  const statuses = [];
  const calls = [];
  const fakeApi = {
    finalizeSession: async id => {
      calls.push(['finalize', id]);
      return { session_id: id, status: 'pending_manual_inference', inference_job_id: 'job-123' };
    },
    runInferenceOnModal: async jobId => {
      calls.push(['modal-run', jobId]);
      return { job_id: jobId, status: 'review_ready', review_items: 3 };
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
  assert.deepEqual(calls, [['finalize', 'sess-1'], ['modal-run', 'job-123']]);
  assert.equal(result.status, 'review_ready');
  assert.equal(result.review_items, 3);
  assert.ok(statuses.includes('Pinoproseso ang session.'));
  assert.ok(statuses.includes('Pinoproseso sa private Modal T4…'));
  assert.ok(statuses.some(status => status.includes('Modal complete') && status.includes('3 review item(s)')));
});

test('LearnerSession handles Modal failure gracefully without throwing and leaves safe status', async () => {
  const statuses = [];
  const fakeApi = {
    finalizeSession: async id => ({ session_id: id, status: 'pending_manual_inference', inference_job_id: 'job-123' }),
    runInferenceOnModal: async () => { throw new Error('Worker offline'); },
  };
  const session = new LearnerSession(fakeApi, status => statuses.push(status));
  session.active = {
    session: { id: 'sess-1' },
    stream: { getTracks: () => [] },
    recorder: { stop: async () => {} },
    transcriptSequence: 0,
  };

  const result = await session.finish();
  assert.equal(result.status, 'pending_manual_inference');
  assert.ok(statuses.some(status => status.includes('Hindi natapos ang automatic Modal inference')));
});

test('renderSessionStatus reflects Modal and human review without Google Colab assumptions', () => {
  const pendingStatus = renderSessionStatus('pending_manual_inference');
  const exportedStatus = renderSessionStatus('exported');
  const readyStatus = renderSessionStatus('review_ready');
  const unavailableStatus = renderSessionStatus('model_unavailable');

  assert.doesNotMatch(pendingStatus, /colab/i);
  assert.match(pendingStatus, /Modal/i);
  assert.doesNotMatch(exportedStatus, /colab/i);
  assert.match(readyStatus, /human review/i);
  assert.match(unavailableStatus, /Modal/i);
});
