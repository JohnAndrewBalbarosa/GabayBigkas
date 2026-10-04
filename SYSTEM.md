# GabayBigkas — Canonical System Specification

## Purpose

Ang GabayBigkas ay local-first guided English-learning system. Kinokolekta nito ang independent learner session audio at timestamped Agora transcript events, pinoproseso ang buong session pagkatapos ng finalize, at gumagawa ng sentence-level evidence para sa human annotation.

Ang transcript disagreement ay review signal lamang. Hindi ito automatic pronunciation diagnosis.

## Implemented boundaries

- Rust/Axum product API sa `backend/api`: local authentication, authorization, guided sessions, PCM chunk ingestion, transcript events, batch finalization, annotation, at private clip streaming.
- SQLite metadata at private filesystem audio sa `.artifacts/` by default.
- Argon2 password hashes; opaque, hashed, revocable session tokens; `learner` at `annotator` backend roles.
- Duration-preserving mono conversion, 16 kHz resampling, DC removal, bounded normalization, 30-second windows, at 5-second overlap.
- Temporary full-session audio cleanup pagkatapos ng successful import o 24-hour bounded expiry.
- Browser learner/annotator shell at independent PCM `AudioWorklet` recorder.
- Private Modal T4 endpoint is the primary MVP GPU boundary. Finalize persists a bounded FIFO entry; one Rust worker claims each session, builds one inference bundle, sends it with server-held proxy credentials, and validates the returned result before import. No auto-retry.
- The authenticated backend creates a session-owned Agora agent, mints bounded RTC/RTM credentials using the official token library, reads only the assistant reply after that session's transcript-grounded request, and performs one YouTube Data API search. BuzzASR is transcription-only. The frontend receives bounded coach-feedback JSON.
- Manual Modal controls and interactive Colab transfer are deprecated and absent from the product HTTP contract.
- Native Rust backend deployment contract para sa Lightsail. Zero-charge use requires account-specific active credit confirmation.
- AWS GPU deployment and lifecycle scaling are post-MVP TODO documentation only.
- Existing Node Agora lab sa `backend/lab` at developer UI sa `frontend/lab`.

## Not yet runtime-verified

- Live Lightsail deployment and account-specific credit verification.
- One real private Modal T4 inference → validated import run.
- Live Agora-to-product transcript forwarding.
- Same-stream Agora custom-track wiring sa learner shell. Recorder accepts one shared `MediaStream`, pero ang verified lab still owns its existing RTC mic lifecycle.
- Real-device learner-to-annotator end-to-end run.
- Model accuracy o pronunciation-improvement claims.

## Runtime topology

```text
Browser learner
  ├─ shared microphone → Agora RTC
  ├─ PCM AudioWorklet → Rust API idempotent chunks
  └─ finalize → Rust API acknowledged response (fire-and-forget)

Agora timestamped transcript events → Rust API

Rust API
  ├─ auth + roles + SQLite
  ├─ private audio preprocessing
  ├─ finalize → durable FIFO acknowledgment → one-at-a-time Modal T4 inference
  ├─ Agora agent history → latest AI coach response
  ├─ backend YouTube search → first embeddable practice video
  └─ comparison → sentence clips → annotation queue

Browser annotator → authorized metadata + private clip stream
```

## Dependency rules

1. Rust owns product orchestration, auth, persistence, audio policy, and model supervision.
2. Python owns model loading and inference only.
3. Browser modules own capture and presentation; secrets never enter frontend bundles.
4. Rust owns product orchestration. Node owns the existing Agora lab and a bounded private adapter around the official Agora token library; it is not a second product HTTP server.
5. Provider/model calls stay behind adapters.
6. Logs contain IDs, states, durations, and bounded errors—never passwords, tokens, raw audio, or transcript bodies.
7. Generated output belongs under `.artifacts/`.
8. Public Home/About/Login/Sign-up pages and role-specific workspaces stay presentation-only. Public sign-up is unavailable in the POC.
9. Learner feedback accepts only bounded structured data. Agora history and YouTube discovery stay in authenticated backend adapters; provider credentials never enter frontend bundles.

## Product HTTP contract

```text
POST /api/auth/local/login
GET  /api/auth/session
POST /api/auth/logout
POST /api/coaching/sessions
GET  /api/coaching/sessions/{id}
POST /api/coaching/sessions/{id}/audio/chunks
POST /api/coaching/sessions/{id}/agora-transcript-events
POST /api/coaching/sessions/{id}/finalize
POST /api/coaching/sessions/{id}/coach-feedback
POST /api/coaching/sessions/{id}/agent
POST /api/coaching/sessions/{id}/agent/stop
GET  /api/coaching/sessions/{id}/result
GET  /api/annotation/queue
GET  /api/annotation/items/{id}
GET  /api/annotation/items/{id}/audio
POST /api/annotation/items/{id}/decision
```

Audio chunks require `X-Audio-Sequence`, `X-Sample-Rate`, at `X-Channels`; body is little-endian PCM16, maximum 2 MiB.

Exact chunk duplicates return `{accepted:true,idempotent:true}`; a reused sequence with different content/format returns 409. Capture is bounded to 128 MiB and five minutes. Finalize atomically appends to a durable 16-item SQLite FIFO and acknowledges `queued` before audio preparation or provider work. One worker claims sessions in enqueue order and runs one Modal request at a time. Retries acknowledge the existing state, never create another inference job.

`GET /result` returns `{session_id,status,transcription,practice_words,coach_feedback,audio_items}` to the owning learner or annotator. `/agent` is learner-owned and requires `review_ready`; it returns short-lived client credentials and `coach_request`. The browser renders `practice_words`, waits for the owned agent's RTC `user-joined` event, then delivers the request through client RTM `sendText`; this keeps spoken TTS behind visible word evidence. `/coach-feedback` accepts `{}` (optional `agent_id` must match the stored binding), reads the session-specific reply, persists the coach paragraph plus first YouTube result, and best-effort stops the agent. An explicit retry may replace only a terminal agent binding. See `backend/api/README.md` for the exact handoff.

Allowed annotation decisions: `confirmed_transcript`, `corrected_transcript`, `insufficient_evidence`, `out_of_scope_language`.

## Model contract

Ang export ZIP ay eksaktong `manifest.json` at `audio.wav`. Kasama lamang sa manifest ang schema version, opaque job ID, audio SHA-256, sample rate, channel count, pinned model ID/revision, creation time, at 24-hour expiry. Ang imported JSON carries the same bounded identity plus transcript timestamps; Rust validates it before comparison.

## Lifecycle

```text
capturing → queued → preprocessing → pending_manual_inference → exported → importing → review_ready
failure: analysis_unavailable | failed
```

Only the owning consenting-adult learner may append/finalize a capturing session. Modal export/import is internal backend orchestration: no Colab fallback, manual import endpoint, or browser inference control. Export bundles never contain learner identity, credentials, cookies, Agora secrets, or unrestricted transcripts.

Modal processes the full session in 30-second windows with five-second overlap and deterministic timestamp ownership. Imported transcription is persisted atomically with review items; a full-session review clip remains available even without Agora transcript events or disagreements. On restart, unclaimed queued work remains FIFO-eligible, while already-processing inference becomes explicit `analysis_unavailable`/`failed` rather than replaying a paid provider call. Pending coach claims are released without replaying provider create calls. Raw capture expires after 24 hours; successful preprocessing removes chunks and successful import removes the processed WAV, retaining private review clips.

## Capacity and scheduling contract

Status: bounded FIFO admission and durable inference FIFO are implemented but not yet benchmarked on the target VPS. Hierarchical rate limits and measured capacity budgets remain planned.

### Two-vCPU execution model

- Tokio uses a two-worker multi-thread runtime on the target two-vCPU VPS. Both workers remain eligible for all asynchronous work; Tokio work stealing redistributes ready tasks when one worker becomes idle.
- CPU affinity MUST NOT permanently reserve one vCPU for reads/auth and one for writes. The application instead reserves admission capacity for latency-sensitive work so idle capacity remains shareable.
- `express` work includes health, authenticated session lookup, authorization checks, and bounded non-stale reads.
- `durable` work includes metadata writes, audio-chunk persistence, finalize requests, and model-job state transitions.
- Blocking filesystem, SQLite, hashing, and CPU-heavy audio work MUST NOT block an async worker. Each class needs a bounded semaphore or bounded blocking executor.

### Admission and queue model

```text
HTTP request
  → route lane classification
  → bounded accepted-request permit
  → fair FIFO active permit with two-second deadline
  → shared Tokio workers

finalize
  → durable 16-item SQLite FIFO
  → one inference worker
  → private Modal T4
```

- HTTP lanes are auth (`2 active / 16 accepted`), writes (`1 / 16`), ordinary reads (`4 / 32`), and polling reads (`1 / 8`). Tokio semaphores release permits fairly in waiter order within each lane.
- Result and annotation-queue polling use the polling-read lane. The name does not imply cached or stale response data; each admitted request still reads current persisted state.
- Accepted HTTP waiters remain in memory for at most two seconds. Durable inference stores only the session reference and queue sequence in SQLite; audio remains in private storage.
- A `BinaryHeap` is not part of the runtime. Cross-lane priority, borrowing, hierarchical token buckets, and measured per-lane budgets remain future work.
- “Swapping” means application-controlled spill-to-disk or durable job persistence. OS swap is only a last-resort host safety net and MUST NOT be presented as the queue or RAM strategy.
- When memory, queue, concurrency, or deadline limits are exhausted, the API MUST apply backpressure or return bounded `429`/`503` responses with `Retry-After`; it MUST NOT accept work it cannot retain safely.

### Rate-limit model

- Normal API traffic SHOULD use hierarchical token buckets keyed by global service, source IP, authenticated principal, and route-cost class. Bucket tokens are capacity credits and are unrelated to authentication/session tokens.
- Login protection MUST remain account-aware and add IP/device signals plus bounded exponential delay or lockout. A per-IP token bucket alone is insufficient for credential stuffing; account lockout MUST avoid becoming an account-denial primitive.
- Expensive operations such as audio upload, finalize, model inference, and annotation writes MUST consume weighted capacity and have separate concurrency limits; request frequency alone does not bound request cost.
- Rejections MUST be observable without logging credentials, raw audio, transcript bodies, session cookies, or bearer tokens.

### Required evidence before efficiency claims

- Benchmark on a constrained two-vCPU target with an explicit RAM limit and the GPU worker outside the API host.
- Publish throughput, p50/p95/p99 latency, error/rejection rate, CPU, peak/resident memory, queue depth/age, spill bytes, SQLite busy time, and per-lane completion share.
- Compare baseline FIFO/unbounded behavior against bounded priority/admission behavior using the same workload and data.
- Prove no durable-work starvation, bounded memory under burst/soak load, deterministic overload responses, and recovery after the load stops.
- Rust hosting MAY support a cost-efficiency claim only after measured Lightsail usage and account-specific credit evidence exists.

Design references: [Tokio runtime scheduling](https://docs.rs/tokio/latest/tokio/runtime/), [Tokio bounded synchronization](https://docs.rs/tokio/latest/tokio/sync/), [Rust `BinaryHeap`](https://doc.rust-lang.org/std/collections/struct.BinaryHeap.html), [Tower concurrency limits](https://docs.rs/tower/latest/tower/limit/concurrency/), [OWASP REST assessment](https://cheatsheetseries.owasp.org/cheatsheets/REST_Assessment_Cheat_Sheet.html), and [OWASP authentication guidance](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html).

## Configuration

- Agora lab: existing `AGORA_*`, `LAB_SECRET_*`, `AGORA_LIVE_ENABLED`, `PORT`.
- Product: `COACH_BIND`, `COACH_DATABASE_PATH`, `COACH_AUDIO_ROOT`, `COACH_SECURE_COOKIE`, `COACH_ALLOWED_ORIGIN`.
- Static build: `COACH_PUBLIC_API_BASE_URL` injects the exact public API origin without embedding secrets.
- Seeds: `COACH_LEARNER_EMAIL`, `COACH_LEARNER_PASSWORD`, `COACH_ANNOTATOR_EMAIL`, `COACH_ANNOTATOR_PASSWORD`.
- Experimental model tools: `BUZZASR_MODEL_ID`, `BUZZASR_MODEL_REVISION`. The MVP notebook pins both values in its validated bundle contract.

Passwords have no repository default. HTTPS deployments require `COACH_SECURE_COOKIE=true`.

## Commands

```powershell
npm ci
npm run build
npm start
npm run start:coach
npm run start:model
npm run doctor
npm run verify
```

`npm run start:model` is an experimental local gateway command, not the canonical MVP inference path. `npm run modal:deploy` is an explicit operator action and requires an authenticated Modal CLI.

## Safety boundaries

- Modal Web Function MUST require proxy authentication, use one T4 container, and accept one claimed job per Rust request. The browser MUST NOT receive Modal credentials.
- Rust MUST NOT automatically retry Modal inference. Failure becomes an explicit terminal status; no browser or annotator retry endpoint is exposed.
- Historical Colab experiments are not connected to the runtime and MUST NOT be exposed as a fallback, endpoint, worker, or operator control.
- Lightsail hosts only the native Rust product backend; no GPU or Python model runtime.
- No model output becomes a pronunciation verdict.
- MVP data is consenting-adult, fixed guided English only.
- Scraped audio, minors, external auth, and automatic AWS resource creation remain out of scope.
- The approved public deployment is limited to GitHub Pages plus the existing `54.179.89.16` Lightsail host.
- Actual Lightsail mutation requires a separate gate covering account credits, instance billing, secrets, TLS, backups, and deletion cleanup.
- Paid AWS GPU families and automated GPU scaling remain post-MVP TODOs.

## Source-of-truth order

1. Accepted executable tests.
2. This document.
3. `docs/MODULE_MAP.md`.
4. `docs/BUILD_PLAN.md`.
5. Runbooks and onboarding docs.
