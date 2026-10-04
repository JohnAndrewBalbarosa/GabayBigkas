# Frontend

Browser-owned experiences. `lab/` contains the existing Agora developer lab; learner and annotator modules are added as separate views without sharing mutable feature state.

Frontend code never receives Agora App Certificates, model gateway credentials, or private filesystem paths.

## Product shell contract

- `shell/` owns navigation, authenticated role presentation, and accessible page state.
- `transport/coach-api.mjs` mirrors only the canonical routes in `SYSTEM.md` and always uses the backend session cookie.
- `learner/` owns consent, independent PCM capture, finalize acknowledgment, and backend status presentation.
- `annotator/` owns private sentence playback and the four backend-supported review decisions.
- Modal execution, inference export/import, provider credentials, and retry orchestration remain server-owned and MUST NOT appear as browser controls.
- Transcript disagreement is presented as review evidence and MUST NOT be labeled an automatic pronunciation verdict.
