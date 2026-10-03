# Build Plan and Remaining Gates

## Implemented foundation

- Curated backend/frontend boundaries and preserved Agora lab.
- Rust auth, roles, SQLite, PCM ingestion, durable manual-inference jobs, bundle validation, comparison, annotation, and bounded cleanup.
- Interactive Colab notebook for pinned Python-only BuzzASR GPU inference.
- Lightsail systemd guidance for the Rust backend only; no AWS GPU resource is part of the MVP.
- Learner capture and annotator browser modules.
- Repository verification passes: lint, contracts, builds, Rust clippy/tests, Node tests, at Agora browser E2E.

## Required before live demo

1. Run the export notebook against the pinned immutable model revision on an available Colab Free GPU.
2. Complete one consenting-adult learner → export → interactive inference → import → annotator run.
3. Wire the shared learner `MediaStreamTrack` into Agora RTC while keeping RTC independent from inference.
4. Verify bounded cleanup after successful import, expiry, and failed import recovery.
5. Measure WER/CER and latency before publishing accuracy claims.

## Server efficiency and security TODO

These items implement the planned contract in `SYSTEM.md`. None is complete until its tests and constrained-host evidence pass.

### P0 — Baseline and budgets

- [ ] Add a reproducible out-of-process load harness with pinned tool/version and redacted fixtures.
- [ ] Record the target VPS shape: two vCPU, explicit RAM/storage limits, OS, Rust build, SQLite settings, and network conditions.
- [ ] Benchmark auth/session reads, owned reads, metadata writes, audio chunks, finalize submission, and a realistic mixed workload.
- [ ] Run steady, burst, and soak profiles at concurrency `1/10/25/50/100`; store only bounded aggregate results.
- [ ] Set measured SLOs and budgets for p95/p99 latency, peak RSS, rejection rate, queue age, recovery time, and cost per completed session. Do not invent targets before the baseline.

### P1 — Layered OWASP resource controls

- [ ] Replace the process-local login-only limiter with a tested limiter boundary.
- [ ] Add hierarchical token buckets for global, IP, principal, and weighted route-cost limits.
- [ ] Keep account-aware login failure windows and add bounded exponential delay/lockout; return generic auth errors.
- [ ] Add body-size, request-timeout, connection/concurrency, audio-duration, upload-byte, and model-job limits.
- [ ] Return consistent `429` or `503` plus `Retry-After`; emit bounded structured rejection metrics.
- [ ] Define single-instance state behavior now and a persistent/distributed limiter migration contract before horizontal scaling.

### P2 — Bounded priority scheduler

- [ ] Introduce explicit `express` and `durable` cost classes without binding either class to a physical vCPU.
- [ ] Run Tokio with two async workers on the target VPS and rely on work stealing for idle-capacity sharing.
- [ ] Reserve permits for express work while allowing unused permits to be borrowed by durable work.
- [ ] Use a bounded `BinaryHeap` of lightweight descriptors with stable ordering, enqueue sequence, deadline, and priority aging.
- [ ] Add durable-work starvation protection and per-class enqueue deadlines.
- [ ] Bound `spawn_blocking`, Argon2, filesystem, SQLite writer, preprocessing, and outbound model concurrency independently.

### P3 — RAM and spill control

- [ ] Define hard queue item/byte budgets from the measured RAM target.
- [ ] Persist audio payloads before enqueue; keep only references and bounded metadata in memory.
- [ ] Add crash-safe recovery evidence for accepted durable work after backend restart or interrupted manual processing.
- [ ] Reject or shed excess work before allocation; never depend on OS swap for normal operation.
- [ ] Measure spill bytes, write amplification, disk latency, cleanup, and orphan recovery.

### P4 — Tests and benchmark gates

- [ ] Unit-test token refill, burst capacity, weighted costs, clock boundaries, key isolation, and `Retry-After`.
- [ ] Unit/property-test heap ordering, FIFO tie-breaks, aging, deadlines, capacity/byte bounds, cancellation, and starvation prevention.
- [ ] Integration-test auth brute force by account and IP, authenticated bypass attempts, oversized/slow bodies, queue saturation, SQLite contention, and model outage.
- [ ] Stress-test mixed reads/writes to prove express latency remains bounded while durable work still progresses.
- [ ] Soak-test until steady-state memory is visible; fail on unbounded RSS, queue growth, leaked files, or unrecovered permits.
- [ ] Interruption-test process restart and abandoned/failed manual inference; accepted jobs must become completed, retryable, expired, or explicitly unavailable—never ambiguous.
- [ ] Compare one-worker and two-worker results, then FIFO and bounded-priority results, using identical workloads.
- [ ] Add CI smoke thresholds and a separate constrained-host benchmark profile; CI success MUST NOT be represented as VPS capacity proof.
- [ ] Publish a judge-ready evidence table with hardware, workload, commit, throughput, tail latency, peak RSS, rejection behavior, recovery, Lightsail account eligibility/cost, and Colab runtime limits.

## Deferred

- [ ] Re-evaluate the paid [AWS GPU deployment plan](POST_MVP_AWS_GPU_PLAN.md) only after MVP evidence exists; do not represent `g4dn`, `g5`, or `g6` as Free Plan resources.
- [ ] Implement the post-MVP [Docker bootstrap and distributed deployment plan](POST_MVP_DOCKER_BOOTSTRAP_PLAN.md) only after the MVP is verified. Docker is initialization-only; native services own runtime, and cleanup must be exact-ID scoped.
- Google/Supabase auth, scraped audio, minors/school production, automatic grading, public ingress, and unattended GPU scaling.
