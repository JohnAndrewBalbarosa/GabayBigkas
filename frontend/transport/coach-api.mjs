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

  async health() {
    return this.#json('/api/health');
  }

  async logout() {
    await this.#json('/api/auth/logout', { method: 'POST' });
  }

  async createSession(input) {
    return this.#json('/api/coaching/sessions', { method: 'POST', body: input });
  }

  async coachingSession(sessionId) {
    return this.#json(`/api/coaching/sessions/${encodeURIComponent(sessionId)}`);
  }

  async sessionResult(sessionId) {
    return this.#json(`/api/coaching/sessions/${encodeURIComponent(sessionId)}/result`);
  }

  async uploadPcmChunk(sessionId, sequence, sampleRate, channels, bytes) {
    const response = await fetch(`${this.baseUrl}/api/coaching/sessions/${encodeURIComponent(sessionId)}/audio/chunks`, {
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
    await this.#json(`/api/coaching/sessions/${encodeURIComponent(sessionId)}/agora-transcript-events`, {
      method: 'POST',
      body: event,
    });
  }

  async finalizeSession(sessionId) {
    return this.#json(`/api/coaching/sessions/${encodeURIComponent(sessionId)}/finalize`, { method: 'POST' });
  }

  async startCoachAgent(sessionId) {
    return this.#json(`/api/coaching/sessions/${encodeURIComponent(sessionId)}/agent`, {
      method: 'POST',
    });
  }

  async stopCoachAgent(sessionId) {
    await this.#json(`/api/coaching/sessions/${encodeURIComponent(sessionId)}/agent/stop`, {
      method: 'POST',
    });
  }

  async createCoachFeedback(sessionId) {
    return this.#json(`/api/coaching/sessions/${encodeURIComponent(sessionId)}/coach-feedback`, {
      method: 'POST',
      body: {},
    });
  }

  async annotationItem(id) {
    return this.#json(`/api/annotation/items/${encodeURIComponent(id)}`);
  }

  async annotationQueue() {
    return this.#json('/api/annotation/queue');
  }

  async decideAnnotation(id, decision) {
    await this.#json(`/api/annotation/items/${encodeURIComponent(id)}/decision`, { method: 'POST', body: decision });
  }

  annotationAudioUrl(id) {
    return `${this.baseUrl}/api/annotation/items/${encodeURIComponent(id)}/audio`;
  }

  async #json(path, options = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method: options.method ?? 'GET',
      credentials: 'include',
      headers: options.body ? { Accept: 'application/json', 'Content-Type': 'application/json' } : { Accept: 'application/json' },
      body: options.body ? JSON.stringify(options.body) : undefined,
    });
    await ensureSuccess(response);
    return response.status === 204 ? null : response.json();
  }
}

async function ensureSuccess(response) {
  if (response.ok) return;
  const body = await response.json().catch(() => ({}));
  throw new CoachApiError(body.message ?? `Request failed (${response.status})`, body.code ?? 'request_failed', response.status);
}

export class CoachApiError extends Error {
  constructor(message, code, status) {
    super(message);
    this.name = 'CoachApiError';
    this.code = code;
    this.status = status;
  }
}
