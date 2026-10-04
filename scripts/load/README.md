# Learner read benchmark

## Scope

Import `learner-read.postman_collection.json` into Postman. Run only the **Learner reads** folder with the **Performance** run type. Each iteration sends three authenticated `GET` requests: auth session, owned coaching session, and owned result. It never creates a session, calls Agora/Modal, or writes audio. Postman virtual users repeat the folder in parallel; the request scripts assert status and ownership without printing response bodies.

## Fixture and target

1. Start with a disposable, consenting-adult learner account and an owned session. Use a dedicated test database or a backed-up local copy; do not use real learner data.
2. Set `sessionId` to that session's UUID and `sessionToken` to its current `coach_session` cookie value in a **local, secret Postman environment**. Both fields are intentionally blank in the collection. Never export or commit the populated environment, cookie, response bodies, or raw runner logs.
3. Keep `baseUrl=http://127.0.0.1:4320` for local runs. A remote run requires `approvedBaseUrl` to equal `baseUrl` exactly. That setting is a guard against mistakes, not authorization to load a live host. Use the Postman desktop **App** run method so the load generator and sensitive fixture remain local.
4. Confirm one manual pass of the folder before selecting Performance. An expired cookie, unowned session, or non-200 response is a failed run, not successful throughput.

## Profiles

Use fixed virtual users (VUs) for comparable tests. Begin with `1 VU × 1 min`, then `10 VUs × 3 min`; continue to `25`, `50`, and `100` only while the prior profile is healthy. Record a `5 min` burst and a `30 min` soak separately. Keep the same fixture, build, network path, and Postman machine for comparisons. Stop if error/rejection rate or host resource pressure breaches the budget established from the first baseline. Do not run the higher profiles against the public VPS without a separately approved live-run window and host recovery owner.

| Record per profile | Source |
| --- | --- |
| Requests/s, completed iterations, p50/p95/p99 latency, HTTP errors, assertion failures | Postman Performance summary |
| CPU, peak RSS, swap in/out, disk I/O/latency, SQLite busy time | VPS/system and app metrics |
| Instance region, bundle, RAM/storage, OS, build commit, SQLite settings, network path | Host inventory |

An iteration is **three reads**, not one completed learner coaching session. Shared session tokens emphasize a hot auth/SQLite path; a privacy-safe temporary dataset with distinct test accounts/sessions is needed to claim multi-user capacity. Postman client saturation can cap throughput, so record its CPU and memory too. Preserve only bounded aggregate results and screenshot/crop any slide evidence to omit IDs, tokens, and bodies.

## Interpretation

Use [the cost worksheet](../../docs/SMALL_CASE_COST_BENCHMARK.md) for cost per successful read and cost per **completed learner session**. The read-only run measures API capacity; it cannot establish GPU inference cost, end-to-end session cost, priority-queue behavior, SSD spill, or OS swap benefits. Those need a separate consented end-to-end run and host instrumentation.

Postman reference: [Performance Runner configuration](https://learning.postman.com/docs/tests-and-scripts/performance-testing/performance-test-configuration/).
