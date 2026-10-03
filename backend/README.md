# Backend

Canonical server-side boundary. Rust owns product APIs, authentication, session orchestration, persistence, audio processing, and model supervision. The Node lab remains an isolated compatibility tool under `lab/`.

Dependency direction: entrypoint → interface → application → domain → adapters.

