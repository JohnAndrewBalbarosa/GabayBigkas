# Product API

Canonical Axum backend for local accounts, coaching sessions, private audio ingestion, batch model orchestration, transcript comparison, and annotation.

Default bind: `127.0.0.1:4320`. Runtime state stays under `.artifacts/` unless explicitly overridden.

## MVP provider configuration

- `AGORA_APP_ID` + `AGORA_APP_CERTIFICATE`: server-held signing inputs; generate fresh session-scoped tokens with existing official `agora-token@2.0.6`. No manually pasted `AGORA_CONVO_TOKEN` is required for this flow.
- Node 24+ must be on the Rust host's PATH. `COACH_AGORA_TOKEN_SCRIPT` points to `adapters/agora-tokens.mjs`; use an absolute path when the service working directory differs from the repository root. Install production npm dependencies alongside the helper (`npm ci --omit=dev`).
- `YOUTUBE_API_KEY`: backend-only YouTube Data API v3 search key. A missing key disables feedback without breaking local authentication/audio flows.
- `COACH_MODAL_ENABLED=true`, HTTPS inference URL and both Modal proxy credentials: private T4 transcription. Missing/failed inference produces an explicit failure, never a Colab fallback.
- `/api/health` reports adapter configuration, not provider reachability or a successful paid inference.

## Frontend handoff

1. Capture consented PCM; exact duplicate chunks are acknowledged, conflicting duplicates are rejected.
2. `POST /api/coaching/sessions/{id}/finalize`: immediate `{acknowledged:true,status:"preprocessing"}`. No inference job ID is required to poll.
3. Poll authenticated `GET /api/coaching/sessions/{id}/result` until `review_ready`, `failed`, or `analysis_unavailable`. Render `transcription.text`; audio URLs are `/api/annotation/items/{audio_items[n].id}/audio` using the session cookie.
4. `POST /api/coaching/sessions/{id}/agent`: returns `{app_id,agent_id,agent_uid,client_uid,channel,rtc_token,rtm_token,expires_at,coach_request,delivery:"client_rtm_send_text"}`. Only client tokens leave the backend; App Certificate and agent/server tokens never do.
5. The learner bundle uses `agora-rtc-sdk-ng@4.24.8`, `agora-rtm@2.3.0`, and `agora-agent-client-toolkit@2.9.1`. It joins RTC with `Number(client_uid)` without publishing another microphone, subscribes only to the session agent's audio for a spoken guide, logs in to RTM with `client_uid` and `rtm_token`, subscribes before sending, and sends the exact `coach_request` to `agent_uid` through toolkit `sendText`. Agora TTS is streamed for this one response; it is not stored as a replayable recording and may incur provider charges.
6. Once the matching assistant response arrives, `POST /api/coaching/sessions/{id}/coach-feedback` with `{}`. 409 means the matching response is not ready; use a bounded wait, not unbounded retries. Backend owns history retrieval, one safe YouTube search, persistence, and best-effort agent stop.
7. Parse `{session_id,status:"ready",coach_message,words_to_practice:[word],youtube_resources:[{title,video_id,url}],idempotent}`. The bounded focus word is derived from transcript comparison and falls back to a longer passage word; it is a practice suggestion, not a pronunciation grade. Subsequent reads return the persisted result without another search. `GET /result` also includes `coach_feedback`.
8. On abandonment, explicitly `POST /agent/stop` and leave RTC/RTM. Provider create/start/stop calls are never automatically retried. Ambiguous creation is terminal locally; idle timeout bounds an orphaned provider runtime.

Agora `/history` retrieves conversations; `/speak` synthesizes speech. Neither is a supported headless LLM prompt endpoint. Therefore this implementation requires the client RTM handoff in step 5. Backend-only autonomous generation is **not implemented** and must not be represented as working.

## Recovery and verification

SQLite changes are additive (`CREATE TABLE IF NOT EXISTS`). Back up the SQLite database and private review clips before deploying a new binary; rollback restores the prior binary and its matching backup. Interrupted jobs are marked terminal on startup instead of silently replaying a paid inference. Uploads are bounded; blocking audio/password work runs outside Tokio workers.

`npm run verify` includes static checks, Node tests, Rust tests (backend HTTP flow with local Modal mock; Agora-history/YouTube mocks), Python full-session window tests, and browser E2E. Mock success does not prove live Modal, Agora managed-provider billing/configuration, RTM delivery, or YouTube quota. Live MVP sign-off requires one consented recording through those real boundaries and successful private playback + coach paragraph + YouTube link.
