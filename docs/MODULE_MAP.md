# Canonical Module Map

## Source tree

```text
backend/
├── api/                         Rust product backend
├── lab/                         Transitional Node Agora lab
└── model/
    ├── api/                     Optional local gateway experiment
    ├── inference/               Python-only BuzzASR inference
    ├── deployment/aws/          Post-MVP GPU deferral notice
    └── experiments/colab/       Interactive MVP GPU notebook
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
| `api/auth` | Argon2, session tokens/cookies, login throttling | SQLite schema, audio |
| `api/store` | SQLite schema and repositories | HTTP, inference |
| `api/audio` | PCM validation, preprocessing, windows, clips, cleanup | Transcript meaning |
| `api/inference_bundle` | Manifest, ZIP, import validation, private-audio adapter | Model loading, identities |
| `api/model` | Timestamped inference data contract | Model loading, provider calls |
| `api/comparison` | Deterministic candidate evidence | Pronunciation verdicts |
| `model/api` | Optional local gateway experiment | Canonical MVP orchestration |
| `model/inference` | BuzzASR model loading and GPU inference only | Auth, annotation, persistence |
| `model/experiments/colab` | Interactive bundle validation and inference | Secrets, public serving, remote control |
| `learner/session` | One capture/finalize lifecycle | RTC credentials |
| `annotator/review` | One pending review queue | Persistence |
| `lab` | Existing Agora developer workflow | Product identity/state |

## Dependency direction

```text
frontend feature → frontend transport → Rust HTTP interface
Rust route → application/domain step → store/audio/inference-bundle/comparison adapter
authorized bundle → interactive Colab notebook → validated result import
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
