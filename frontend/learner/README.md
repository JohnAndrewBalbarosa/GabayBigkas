# Learner

Owns guided-session consent, independent PCM capture, finalize acknowledgment, backend status presentation, and practice-guide rendering. The post-session Agora coach streams one spoken guide over RTC while the learner publishes no second microphone. Human annotation remains a separate reviewer workflow.

The Rust backend owns private Modal orchestration, claims, import validation, retries, failure state, and cleanup. The learner UI never exposes provider controls or credentials.
