import { createSessionRecorder } from '../voice/capture/session-recorder.mjs';

export class LearnerSession {
  constructor(api, renderStatus) {
    this.api = api;
    this.renderStatus = renderStatus;
    this.active = null;
  }

  async start({ exerciseId, expectedPhrases, adultConsent }) {
    if (this.active) throw new Error('A session is already active. Finish it before starting another.');
    if (adultConsent !== true) throw new Error('Adult consent is required before recording.');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    try {
      const session = await this.api.createSession({
        exercise_id: exerciseId,
        expected_phrases: expectedPhrases,
        recording_consent: true,
        adult_consent: true,
      });
      const recorder = await createSessionRecorder({
        stream,
        onChunk: chunk => this.api.uploadPcmChunk(
          session.id,
          chunk.sequence,
          chunk.sampleRate,
          chunk.channels,
          chunk.pcm,
        ),
      });
      this.active = { session, stream, recorder, transcriptSequence: 0 };
      this.renderStatus('Recording. Read the passage at your natural pace.');
      return { session, sharedMicrophoneStream: stream };
    } catch (error) {
      stopStream(stream);
      throw error;
    }
  }

  async ingestAgoraTranscript({ text, startMs, endMs }) {
    if (!this.active) throw new Error('There is no active practice session.');
    await this.api.addAgoraTranscript(this.active.session.id, {
      sequence: this.active.transcriptSequence++,
      text,
      start_ms: startMs,
      end_ms: endMs,
    });
  }

  async finish() {
    if (!this.active) throw new Error('There is no active practice session.');
    const active = this.active;
    this.active = null;
    try {
      await active.recorder.stop();
    } finally {
      stopStream(active.stream);
    }
    this.renderStatus('Recording finished. The session is being submitted to the backend…');
    const result = await this.api.finalizeSession(active.session.id);
    this.renderStatus(renderSessionStatus(result.status));
    return result;
  }

  async cancel() {
    if (!this.active) return;
    const active = this.active;
    this.active = null;
    try {
      await active.recorder.stop();
    } finally {
      stopStream(active.stream);
    }
    this.renderStatus('Recording and microphone access stopped.');
  }
}

export function renderSessionStatus(status) {
  const labels = {
    capturing: 'The recording session is still active.',
    queued: 'The session is safely queued for private background analysis.',
    preprocessing: 'The backend is preparing the session audio.',
    review_ready: 'The evidence is ready for authorized human review.',
    pending_manual_inference: 'The backend received the audio and is running background analysis.',
    analysis_unavailable: 'Analysis did not finish within the bounded window; temporary audio was removed.',
    model_unavailable: 'The private model worker is unavailable. Processing stopped safely.',
    failed: 'Processing did not complete. Ask an administrator to check server diagnostics.',
  };
  return labels[status] ?? 'The session status was updated.';
}

function stopStream(stream) {
  stream.getTracks().forEach(track => track.stop());
}
