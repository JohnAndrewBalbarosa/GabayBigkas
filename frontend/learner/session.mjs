import { createSessionRecorder } from '../voice/capture/session-recorder.mjs';

export class LearnerSession {
  constructor(api, renderStatus) {
    this.api = api;
    this.renderStatus = renderStatus;
    this.active = null;
  }

  async start({ exerciseId, expectedPhrases, adultConsent }) {
    if (this.active) throw new Error('May active session na. Tapusin muna ito bago magsimula ulit.');
    if (adultConsent !== true) throw new Error('Kailangan ang adult consent bago mag-record.');
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
      this.renderStatus('Recording na. Basahin ang prompt sa natural mong pace.');
      return { session, sharedMicrophoneStream: stream };
    } catch (error) {
      stopStream(stream);
      throw error;
    }
  }

  async ingestAgoraTranscript({ text, startMs, endMs }) {
    if (!this.active) throw new Error('Walang active practice session.');
    await this.api.addAgoraTranscript(this.active.session.id, {
      sequence: this.active.transcriptSequence++,
      text,
      start_ms: startMs,
      end_ms: endMs,
    });
  }

  async finish() {
    if (!this.active) throw new Error('Walang active practice session.');
    const active = this.active;
    this.active = null;
    try {
      await active.recorder.stop();
    } finally {
      stopStream(active.stream);
    }
    this.renderStatus('Tapos na ang recording. Ipinapasa sa backend ang session…');
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
    this.renderStatus('Itinigil ang recording at microphone access.');
  }
}

export function renderSessionStatus(status) {
  const labels = {
    capturing: 'Aktibo pa ang recording session.',
    preprocessing: 'Inihahanda ng backend ang session audio.',
    review_ready: 'Handa na ang evidence para sa authorized human review.',
    pending_manual_inference: 'Natanggap na ng backend ang audio. Tumatakbo ang background analysis.',
    analysis_unavailable: 'Hindi natapos ang analysis sa bounded window; nilinis na ang temporary audio.',
    model_unavailable: 'Hindi available ang private model worker. Ligtas na itinigil ang processing.',
    failed: 'Hindi nakumpleto ang processing. Ipa-check sa administrator ang server diagnostics.',
  };
  return labels[status] ?? 'Na-update ang session status.';
}

function stopStream(stream) {
  stream.getTracks().forEach(track => track.stop());
}
