# Post-MVP Docker Bootstrap and Distributed Deployment Plan

## Status and scheduling

- **Status:** Todo; planning artifact only.
- **Start condition:** The MVP is complete, locally verified, and proven through one real learner-to-annotator workflow.
- **Current prohibition:** Do not add a `Dockerfile`, container registry workflow, bootstrap script, cleanup script, or deployment automation during MVP work.

## Purpose

Use Docker only as an ephemeral bootstrap environment for installing or initializing a native GabayBigkas release on a server or supported device. The installed executable and host service run without a container. This supports separate institutional deployments across the Philippines without making one runtime node carry every institution's traffic.

## Terms

- **Bootstrap image:** Versioned, immutable image containing the release artifact and installer logic.
- **Native release:** Executable, static assets, migrations, service definition, and manifest copied to the host staging directory.
- **Scoped cleanup:** Removal of only the container, image reference, and temporary files created by the same bootstrap execution.
- **Institution node:** Independently operated deployment with its own capacity limits, credentials, storage, health state, and upgrade lifecycle.

## Non-goals

- Docker is not the production process supervisor or application runtime.
- The workflow does not automatically uninstall Docker Engine. An institution may share it with other systems.
- The workflow does not run broad cleanup such as `docker system prune`, delete unrelated images or containers, or remove any volume.
- Bootstrap cleanup never deletes application data, `.env`, credentials, logs required for a failed-install diagnosis, or the previous working release.
- This plan does not authorize public ingress, multi-tenant identity, automatic cloud mutation, or unattended fleet rollout.

## Artifact contract

The future bootstrap image must:

1. Use multi-stage builds so compilers and build dependencies do not enter the exported native release.
2. Be selected by immutable digest, not a mutable tag such as `latest`.
3. Publish a release manifest containing version, target OS/architecture, file hashes, build provenance, schema compatibility, and minimum host requirements.
4. Export only to a dedicated staging directory mounted from the host.
5. Run with the minimum filesystem, network, user, and Linux capability access required by installation.
6. Never contain deployment credentials or institution data.

## Planned lifecycle

```text
host preflight
  → pull pinned bootstrap image
  → create uniquely labeled ephemeral container
  → export native release to isolated staging
  → validate manifest and host compatibility
  → install beside the current release
  → start native service
  → run readiness, restart, and product smoke gates
  → atomically mark the new release active
  → retain bounded rollback release
  → remove only bootstrap-owned Docker artifacts
  → optionally stop/disable Docker by explicit institution policy
```

The bootstrap must be idempotent by `institution_id + release_id`. A retry must resume or replace its own staging state without modifying an unrelated release.

## Verification gates before cleanup

Cleanup may run only after all applicable gates pass:

- Image digest, artifact manifest, and every installed file hash match the authorized release.
- Host OS, CPU architecture, available storage, RAM budget, ports, and required accelerators are compatible.
- Configuration exists with restrictive permissions; secrets never appear in process arguments or logs.
- Native executable self-check exits successfully without Docker.
- Native service starts, reports bounded health/readiness, and owns the expected loopback or configured private interface.
- Service survives one host-service restart while Docker is stopped.
- Database/schema compatibility and rollback checks pass before any migration is committed.
- One synthetic, non-sensitive API workflow completes through the installed native service.
- Critical failure paths emit structured, redacted events with institution, release, phase, duration, and recovery action.
- CPU, memory, file descriptor, disk, and queue checks remain within the institution profile's measured budgets.

Passing health checks proves installation readiness only. It does not prove live Agora interoperability, model accuracy, or production capacity.

## Scoped auto-cleanup contract

The future cleanup script must operate from a recorded bootstrap manifest and exact IDs. It may remove:

- The completed ephemeral container created by this bootstrap run.
- Anonymous volumes created by that container only when the manifest proves they contain no application data.
- The exact bootstrap image digest when no other local container depends on it and local retention policy does not require rollback.
- Bootstrap staging files after native-release verification and atomic activation.
- Build cache entries carrying the exact release/bootstrap labels, if the selected builder supports safe label filtering.

It must not:

- Run `docker system prune`, `docker image prune -a`, or any unscoped delete.
- Use forced image removal to bypass active references.
- Delete named volumes, bind-mounted data, previous working releases, databases, audio evidence, credentials, or unrelated logs.
- Uninstall Docker Engine or alter its startup policy without a separate explicit administrator decision.

If any verification gate fails, the workflow must stop activation, restore or retain the previous release, preserve a bounded diagnostic record, and return a non-zero outcome. Cleanup may remove only known-safe temporary container state; it must retain the pinned image and staging evidence required for an authorized retry or investigation.

## Distributed institutional topology

- Each institution owns an independent node or bounded node group; credentials and learner data do not cross institutions by default.
- Each node enforces its own admission limits, durable queue bounds, storage retention, and model concurrency.
- A deployment registry may distribute signed release metadata, but it must not become the runtime dependency for local sessions.
- Slow or intermittent connectivity must not corrupt installation: download to staging, verify completely, then activate atomically.
- Rollout proceeds `development → one pilot institution → small regional cohort → broader deployment`, with an explicit stop condition at every stage.
- Capacity expansion is based on measured concurrency, p95/p99 latency, queue age, peak RAM, disk growth, and recovery evidence—not institution count alone.
- Cross-node routing, central identity, synchronization, and failover remain separate post-MVP designs with privacy and threat-model review.

## Planned test matrix

| Layer | Required proof |
| --- | --- |
| Unit | Manifest parsing, exact-ID cleanup allowlist, idempotency keys, failure-state transitions, and rollback selection |
| Integration | Export to staging, native install, service start/restart, health gate, cleanup, and retry after partial failure |
| Negative | Digest mismatch, corrupt artifact, low disk/RAM, port collision, invalid config, failed migration, failed smoke test, and image still in use |
| Isolation | Cleanup cannot select unrelated containers, images, volumes, releases, credentials, or institution data |
| Platform | Supported Linux distributions and CPU architectures; Windows only if separately accepted and tested |
| Field pilot | Offline/slow-link installation, power/process interruption, measured host resources, and rollback on the target institution hardware |

## Future deliverables

Do not create these until the todo is explicitly activated after MVP verification:

- Versioned bootstrap image definition and release manifest schema.
- Linux bootstrap and cleanup scripts; another platform requires its own adapter and tests.
- Native service templates and least-privilege installation policy.
- Fake-host integration harness for cleanup and rollback safety.
- Institution deployment profile, operator runbook, upgrade policy, and evidence report.

## Definition of done

- Docker is absent from the application runtime dependency graph.
- The installed native service remains healthy after the bootstrap container is gone and Docker is stopped.
- Cleanup is exact-ID scoped, idempotent, and proven unable to delete unrelated resources or persistent data.
- Failed installation always produces an explicit rollback or recoverable stopped state.
- At least one pilot institution passes install, restart, smoke, cleanup, rollback, and resource-budget evidence on representative hardware.
- No wider rollout begins until the pilot evidence and privacy/security review are accepted.

## References

- [Docker multi-stage builds](https://docs.docker.com/build/building/multi-stage/) — separate build dependencies from exported artifacts.
- [`docker container run --rm`](https://docs.docker.com/reference/cli/docker/container/run/) — automatic removal of an exited container and its anonymous volumes.
- [`docker image rm`](https://docs.docker.com/reference/cli/docker/image/rm/) — exact image-reference removal semantics.
- [`docker system prune`](https://docs.docker.com/reference/cli/docker/system/prune/) — broad deletion scope that this plan explicitly prohibits.
