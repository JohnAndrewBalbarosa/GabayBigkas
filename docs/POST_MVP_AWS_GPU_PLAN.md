# Post-MVP AWS GPU Plan

## Status

- **Classification:** post-MVP TODO under the project-wide TODO rule.
- **Current MVP:** Lightsail Rust backend plus private Modal T4 inference.
- **Not implemented:** paid GPU EC2, ECR image runtime, Lambda lifecycle controller, automatic warm/cool scaling, at unattended GPU workers.
- **Cost:** `g4dn`, `g5`, and `g6` are paid GPU families and MUST NOT be represented as AWS Free Plan infrastructure.

## Preserved design direction

If explicitly activated after the MVP is verified, reassess a private,
interruption-tolerant GPU worker with zero default capacity, no public ingress,
durable job leases, bounded scale-down, exact IAM scope, idempotent lifecycle
commands, and measured cost limits. Revalidate current AWS pricing, instance
availability, model licensing, security, and the no-Docker-runtime policy before
implementation.

This document preserves intent only. It is not a deployable template or approval
to create AWS resources.
