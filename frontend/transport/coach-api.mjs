export class CoachApi {
  constructor(baseUrl = '') {
    this.baseUrl = baseUrl;
  }

  async login(email, password) {
    return this.#json('/api/auth/local/login', { method: 'POST', body: { email, password } });
  }

  async session() {
    return this.#json('/api/auth/session');
  }

  async logout() {
    await this.#json('/api/auth/logout', { method: 'POST' });
  }

  async createSession(input) {
    return this.#json('/api/coaching/sessions', { method: 'POST', body: input });
  }

  async uploadPcmChunk(sessionId, sequence, sampleRate, channels, bytes) {
    const response = await fetch(`${this.baseUrl}/api/coaching/sessions/${sessionId}/audio/chunks`, {
      method: 'POST',
      credentials: 'include',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Audio-Sequence': String(sequence),
        'X-Sample-Rate': String(sampleRate),
        'X-Channels': String(channels),
      },
      body: bytes,
    });
    await ensureSuccess(response);
    return response.json();
  }

  async addAgoraTranscript(sessionId, event) {
    await this.#json(`/api/coaching/sessions/${sessionId}/agora-transcript-events`, {
      method: 'POST',
      body: event,
    });
  }

  async finalizeSession(sessionId) {
    return this.#json(`/api/coaching/sessions/${sessionId}/finalize`, { method: 'POST' });
  }

  async inferenceJobs() {
    return this.#json('/api/inference/jobs');
  }

  async downloadInferenceBundle(jobId) {
    const response = await fetch(`${this.baseUrl}/api/inference/jobs/${encodeURIComponent(jobId)}/export`, {
      credentials: 'include',
    });
    await ensureSuccess(response);
    return response.blob();
  }

  async createInferencePocTicket(jobId) {
    return this.#json(`/api/inference/jobs/${encodeURIComponent(jobId)}/poc-ticket`, {
      method: 'POST',
    });
  }

  async runInferenceOnModal(jobId) {
    return this.#json(`/api/inference/jobs/${encodeURIComponent(jobId)}/modal-run`, {
      method: 'POST',
    });
  }

  async importInferenceResult(jobId, result) {
    return this.#json(`/api/inference/jobs/${encodeURIComponent(jobId)}/import`, {
      method: 'POST',
      body: result,
    });
  }

  async annotationQueue() {
    return this.#json('/api/annotation/queue');
  }

  async decideAnnotation(id, decision) {
    await this.#json(`/api/annotation/items/${id}/decision`, { method: 'POST', body: decision });
  }

  async #json(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      credentials: 'include',
      headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    await ensureSuccess(response);
    return response.status === 204 ? null : response.json();
  }
}

async function ensureSuccess(response) {
  if (response.ok) return;
  const body = await response.json().catch(() => ({}));
  throw new Error(body.message ?? `Request failed (${response.status})`);
}
