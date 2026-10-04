# Pronunciation Coach Architecture

## Canonical workflow

```text
one browser microphone stream
  ├─ Agora RTC/transcript path
  └─ independent PCM capture → temporary Rust storage

session finalize
  → duration-preserving preprocessing
  → durable background-inference job
  → private Modal T4 BuzzASR inference
  → validated result import
  → expected/Agora/Buzz comparison
  → processed sentence clip + focused mismatch range
  → annotator decision
  → reviewed learner feedback
```

## Evidence boundary

- ASR disagreement is a review candidate, not proof of incorrect pronunciation.
- `BuzzASR/filipino` remains an experimental Whisper-large-v3-derived comparator.
- Noise, vocabulary, accent, and code-switching can cause mismatches.
- Unsupported language is marked `out_of_scope_language`; weak evidence is `insufficient_evidence`.

## Audio policy

- Browser sends ordered little-endian PCM16 chunks while capturing.
- Model processing starts only after session finalize.
- Pre-ASR processing preserves duration: mono, resample, DC removal, bounded normalization.
- No aggressive denoise, band-pass, time-stretch, or VAD silence deletion in the MVP.
- Annotation stores the whole sentence clip plus `focus_start_ms`/`focus_end_ms`.
- Full temporary audio is deleted after successful import or bounded expiry/failure cleanup.

## MVP hosting

- AWS Lightsail hosts only the Rust product backend, auth/roles, SQLite, private audio preprocessing, durable inference metadata, comparison, at annotation.
- Historical Colab files are deprecated and have no runtime, endpoint, or fallback role.
- Inference bundles contain only `manifest.json` and processed `audio.wav`; the manifest uses an opaque job ID and no learner identity or credentials.
- Agora RTC remains independent from the private BuzzASR transcription path.
- Paid AWS GPU deployment and automatic lifecycle scaling are post-MVP TODOs in `POST_MVP_AWS_GPU_PLAN.md`.

## Claims

Allowed: “Whisper-large-v3-derived model, working in our prototype.”

Not allowed without benchmark evidence: “validated for Filipino-accented English,” “2.8× more accurate,” or “pronunciation error detected.”
