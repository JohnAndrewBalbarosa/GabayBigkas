# Learner

Owns guided-session consent, independent PCM capture, finalize acknowledgment, backend status presentation, and reviewed feedback rendering. One microphone source is reserved for Agora RTC and the independent PCM session recorder.

The Rust backend owns private Modal orchestration, claims, import validation, retries, failure state, and cleanup. The learner UI never exposes provider controls or credentials.
