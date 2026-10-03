import { createSessionRecorder } from '../voice/capture/session-recorder.mjs';

export class LearnerSession {
  constructor(api, renderStatus) {
    this.api = api;
    this.renderStatus = renderStatus;
    this.active = null;
  }

  async start({ exerciseId, expectedPhrases, adultConsent }) {
    if (this.active) throw new Error('A session is already active. Please finish it first.');
    if (adultConsent !== true) throw new Error('Only consenting adults may record during this trial.');
    const session = await this.api.createSession({
      exercise_id: exerciseId,
      expected_phrases: expectedPhrases,
      recording_consent: true,
      adult_consent: true,
    });
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
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
    this.renderStatus('Recording in progress...');
    return { session, sharedMicrophoneStream: stream };
  }

  async ingestAgoraTranscript({ text, startMs, endMs }) {
    if (!this.active) throw new Error('No active session.');
    await this.api.addAgoraTranscript(this.active.session.id, {
      sequence: this.active.transcriptSequence++,
      text,
      start_ms: startMs,
      end_ms: endMs,
    });
  }

  async finish() {
    if (!this.active) throw new Error('No active session.');
    const active = this.active;
    this.active = null;
    await active.recorder.stop();
    active.stream.getTracks().forEach(track => track.stop());
    this.renderStatus('Processing session audio...');
    const result = await this.api.finalizeSession(active.session.id);
    this.renderStatus(renderSessionStatus(result.status));
    return result;
  }
}

export function renderSessionStatus(status) {
  const labels = {
    review_ready: 'Analysis complete and ready for human review.',
    pending_manual_inference: 'Audio received by backend. Background inference in progress.',
    exported: 'Inference bundle exported for manual processing.',
    analysis_unavailable: 'Processing timed out before expiry; temporary audio safely cleaned up.',
    model_unavailable: 'Modal model worker unavailable. Processing safely halted.',
    failed: 'Processing could not be completed. Check server error log.',
  };
  return labels[status] ?? `Session status: ${status}`;
}
