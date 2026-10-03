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
    if (result.status === 'pending_manual_inference' && result.inference_job_id && typeof this.api.runInferenceOnModal === 'function') {
      this.renderStatus('Pinoproseso sa private Modal T4…');
      try {
        const modalResult = await this.api.runInferenceOnModal(result.inference_job_id);
        const finalStatus = modalResult.status ?? 'review_ready';
        const message = modalResult.review_items !== undefined
          ? `Modal complete: ${modalResult.review_items} review item(s) ang handa para sa review.`
          : renderSessionStatus(finalStatus);
        this.renderStatus(message);
        return { ...result, ...modalResult, status: finalStatus };
      } catch {
        this.renderStatus('Naka-save ang audio. Hindi natapos ang automatic Modal inference; handa para sa manual review o retry.');
        return result;
      }
    }
    this.renderStatus(renderSessionStatus(result.status));
    return result;
  }
}

export function renderSessionStatus(status) {
  const labels = {
    review_ready: 'Handa na para sa human review.',
    pending_manual_inference: 'Naka-save ang audio. Naka-standby para sa private Modal T4 inference o review.',
    exported: 'Na-export na ang bundle para sa manual fallback processing.',
    analysis_unavailable: 'Hindi natapos ang model processing bago ang expiry; nilinis na ang temporary audio.',
    model_unavailable: 'Hindi available ang Modal model worker. Ligtas na itinigil ang processing.',
    failed: 'Hindi natapos ang processing. Tingnan ang bounded server error event.',
  };
  return labels[status] ?? `Session status: ${status}`;
}
