import { createSessionRecorder } from '../voice/capture/session-recorder.mjs';

export class LearnerSession {
  constructor(api, renderStatus) {
    this.api = api;
    this.renderStatus = renderStatus;
    this.active = null;
  }

  async start({ exerciseId, expectedPhrases, adultConsent }) {
    if (this.active) throw new Error('May active session na. Tapusin muna ito.');
    if (adultConsent !== true) throw new Error('Para sa MVP, consenting adult lamang ang maaaring mag-record.');
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
    this.renderStatus('Nagre-record ang session.');
    return { session, sharedMicrophoneStream: stream };
  }

  async ingestAgoraTranscript({ text, startMs, endMs }) {
    if (!this.active) throw new Error('Walang active session.');
    await this.api.addAgoraTranscript(this.active.session.id, {
      sequence: this.active.transcriptSequence++,
      text,
      start_ms: startMs,
      end_ms: endMs,
    });
  }

  async finish() {
    if (!this.active) throw new Error('Walang active session.');
    const active = this.active;
    this.active = null;
    await active.recorder.stop();
    active.stream.getTracks().forEach(track => track.stop());
    this.renderStatus('Pinoproseso ang session.');
    const result = await this.api.finalizeSession(active.session.id);
    this.renderStatus(renderSessionStatus(result.status));
    return result;
  }
}

function renderSessionStatus(status) {
  const labels = {
    review_ready: 'Handa na para sa human review.',
    pending_manual_inference: 'Naka-save ang audio. Kailangan itong iproseso nang manual sa Google Colab bago maging handa ang review.',
    exported: 'Na-export na para sa manual Google Colab processing.',
    analysis_unavailable: 'Hindi natapos ang manual model processing bago ang expiry; nilinis na ang temporary audio.',
    model_unavailable: 'Hindi available ang model worker. Ligtas na itinigil ang processing.',
    failed: 'Hindi natapos ang processing. Tingnan ang bounded server error event.',
  };
  return labels[status] ?? `Session status: ${status}`;
}
