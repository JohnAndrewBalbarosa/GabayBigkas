# Canonical Module Map

## Source tree

```text
backend/
├── api/                         Rust product backend
├── lab/                         Transitional Node Agora lab
└── model/
    ├── api/                     Optional local gateway experiment
    ├── inference/               Python-only BuzzASR inference
    ├── modal/                   Private single-job T4 endpoint
    ├── deployment/aws/          Post-MVP GPU deferral notice
    └── experiments/colab/       Deprecated historical experiment; not runtime-connected
backend/deployment/lightsail/    Rust backend service guidance
frontend/
├── shell/                       Product composition
├── learner/                     Guided-session state
├── annotator/                   Review queue
├── voice/capture/               PCM capture
├── transport/                   Product HTTP client
└── lab/                         Agora developer UI
docs/ · tests/ · scripts/ · data/
.artifacts/                      Ignored generated/private runtime data
```

## Ownership

| Module | Owns | Must not own |
| --- | --- | --- |
| `api/routes` | HTTP parsing, auth invocation, response mapping | Password algorithms, CUDA |
| `api/request_admission` | Bounded fair FIFO lanes for auth, writes, reads, and polling reads | Durable inference state, provider calls |
| `api/auth` | Argon2, session tokens/cookies, login throttling | SQLite schema, audio |
| `api/store` | SQLite schema and repositories | HTTP, inference |
| `api/audio` | PCM validation, preprocessing, windows, clips, cleanup | Transcript meaning |
| `api/inference_bundle` | Manifest, ZIP, import validation, private-audio adapter | Model loading, identities |
| `api/model` | Timestamped inference data contract | Model loading, provider calls |
| `api/comparison` | Deterministic candidate evidence | Pronunciation verdicts |
| `api/coach_feedback` | Agora history retrieval and one-result YouTube discovery | Browser rendering, audio transcription |
| `api/coach_session` | Owned agent lifecycle, grounded request, feedback/result orchestration | HTTP parsing, provider transport |
| `api/coach_routes` | Authenticated coach HTTP interfaces | Provider calls |
| `api/agora_agent` | Agora join/leave adapter | Session authorization |
| `api/agora_tokens` + commit-pinned official Rust token crate | Bounded AccessToken2 issuance | Public signing secrets |
| `api/inference_workflow` | Durable FIFO consumption, background preparation, Modal execution, transactional result import | DOM, provider retry |
| `model/api` | Optional local gateway experiment | Canonical MVP orchestration |
| `model/inference` | BuzzASR model loading and GPU inference only | Auth, annotation, persistence |
| `model/modal` | Private Modal T4 lifecycle, bundle checks, pinned inference | Browser auth, persistence, pronunciation judgments |
| `model/experiments/colab` | Deprecated historical experiment only | Runtime integration, secrets, public serving, remote control |
| `learner/session` | One capture/finalize lifecycle | RTC credentials |
| `learner/feedback` | Strict learner feedback validation at safe DOM rendering | Provider calls, API keys, result generation |
| `annotator/review` | One pending review queue | Persistence |
| `lab` | Existing Agora developer workflow | Product identity/state |

## Dependency direction

```text
frontend feature → frontend transport → Rust HTTP interface
Rust route → application/domain step → store/audio/inference-bundle/comparison adapter
claimed bundle → private Modal T4 endpoint → validated result import
Agora history adapter → coach response; YouTube adapter → first practice resource
Node lab route → existing lab adapters
```

## Runtime data

| Data | Owner | Retention |
| --- | --- | --- |
| Accounts/session metadata | SQLite | Operator policy |
| PCM chunks/full processed WAV | Private audio adapter | Chunks after finalize; WAV after import or bounded expiry/failure |
| Sentence clips | Private audio adapter | Consent-bounded review retention |
| Agora snapshots | `data/` | Versioned input |
| Builds/tests/logs | `.artifacts/` | Regenerable |
