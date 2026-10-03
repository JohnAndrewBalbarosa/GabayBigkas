# GabayBigkas

**Makinig. Magpraktis. Magsalita nang may kumpiyansa.**

Local-first guided English-learning MVP foundation gamit ang Agora RTC at reviewable dual-ASR evidence. Ang mismatch ng transcripts ay candidate para sa human review—hindi automatic pronunciation verdict.

## Canonical boundaries

- [`backend/api`](backend/api/README.md): Rust product API, auth, sessions, audio, comparison, annotation.
- [`backend/model`](backend/model/README.md): interactive Colab notebook, pinned Python BuzzASR inference, at deferred experiments.
- [`backend/lab`](backend/lab): existing Node Agora event lab.
- [`frontend`](frontend/README.md): learner, annotator, capture, transport, at lab views.
- [`SYSTEM.md`](SYSTEM.md): canonical contracts at truth boundary.
- [`docs/MODULE_MAP.md`](docs/MODULE_MAP.md): ownership at dependencies.
- [`docs/BUILD_PLAN.md`](docs/BUILD_PLAN.md): remaining live-demo gates.

## Local setup

Prerequisites: Node.js 24+ at Rust 1.98+. Python, CUDA, at model dependencies ay kailangan lang sa interactive Colab inference.

```powershell
npm ci
Copy-Item .env.example .env
npm run build
npm run verify
```

Maglagay ng strong local passwords sa `.env` bago gamitin ang product API:

```text
COACH_LEARNER_PASSWORD=
COACH_ANNOTATOR_PASSWORD=
```

## Run

```powershell
npm start             # Agora lab: http://127.0.0.1:4317
npm run start:coach   # Product:   http://127.0.0.1:4320
npm run start:model   # Optional local model-gateway experiment
```

Ang product finalization ay gumagawa ng durable `pending_manual_inference` job. Authorized annotators may use the bounded ZIP flow or issue one short-lived ticket for a single interactive Colab HTTPS run. Isang job lang ang puwedeng active at walang loop, batch, automatic retry, o always-on Colab endpoint.

## Hosting status

Lightsail ang target host ng Rust backend lamang. Walang AWS GPU sa MVP at hindi ipinapalagay ng repository na permanente o universally free ang Lightsail; dapat i-verify ng operator ang account-specific credit eligibility bago mag-deploy.

Nasa [`docs/POST_MVP_AWS_GPU_PLAN.md`](docs/POST_MVP_AWS_GPU_PLAN.md) ang paid AWS GPU design bilang post-MVP TODO. Walang AWS resource na ginagawa ng repository implementation.

## Privacy at evidence

- Consenting adults at fixed guided English phrases lamang ang MVP.
- Temporary full-session PCM/processed WAV is deleted after derivation or bounded failure.
- Annotators receive only derived private sentence clips.
- Tagalog/code-switching becomes `out_of_scope_language` or `insufficient_evidence`.
- `BuzzASR/filipino` is empirically useful in the prototype but not a validated Filipino-accented-English pronunciation assessor.
