# Runbook: Infrastructure Deploy Order

Status: deploy-order runbook. The apply order, plan-in-CI / apply-behind-HOLD policy, state-backup procedure, and rollback notes are topology-independent and hold under any ADR-INFRA-008 outcome. The "common-platform" / convergence framing assumes option A and is CONTINGENT on ADR-INFRA-008; under options B or C there is no convergence, each product keeps applying its own stack, and only the shared spine (and optionally AR/KMS) is added. Interim and under B/C: each product applies its own stack in its own project; the ordering below is the dependency order regardless.

## Apply order

Apply in dependency order; never out of order:

1. Foundation (common project): project + services, VPC + networking, KMS, Artifact Registry, DNS, event spine (Pub/Sub topics + schemas), shared state backend.
2. Customer Master (identity plane): consumes foundation by name; issues the machine-auth token.
3. DIS (data plane): consumes foundation + CM token contract by name.
4. Platform services (Cortex): Atlas, intelligence, measurement, experience; consume all of the above by name.

Rationale: downstream layers reference upstream resources by name via `data` sources, so the named resource must exist before a downstream plan can resolve it.

## Policy

- Plan in CI on every PR. Apply only behind an operator HOLD: a human authorizes each specific apply batch. No `terraform apply -auto-approve` without a saved, reviewed plan file (per `docs/claude/terraform.md`).
- No one runs another swimlane's apply. Trust-swimlane stacks (CM) are applied by their owner; value-swimlane stacks (DIS, Cortex platform) by theirs. Cross-swimlane changes are coordinated, never cross-applied.
- After any apply, re-run plan to confirm idempotency. A non-empty re-plan is drift; investigate before anything else.
- Prod applies require `CONFIRM=yes` (per the Makefile `tf-*` targets).

## State backup procedure (before any state mutation)

Mandatory before `terraform state mv`, `state rm`, `import`, or any convergence cutover:

1. Identify the backend bucket and prefix for the stack (see `docs/architecture/infra-shared-resource-register.md`).
2. Download the current state to a timestamped local copy: `terraform state pull > state-backup-<stack>-<UTC-timestamp>.tfstate`.
3. Copy the same to a GCS backup object under a `state-backups/` prefix in the stack's backend bucket.
4. Record both paths in the change ticket / PR before proceeding. Do not mutate state until both backups exist.

## Verification (convergence cutovers)

- After migrating a resource group, `terraform plan` in BOTH the source stack and the destination (foundation/common) stack MUST each show zero changes (no-op).
- Any non-no-op plan means stop and report; do not proceed to the next resource group.

## Rollback

- Pre-mutation: revert the code change and re-run plan; expect no-op against the un-mutated state.
- Post-mutation (state moved): restore the timestamped state backup with `terraform state push <backup>` into the original backend, revert the code, and re-run plan to confirm no-op. Data migrations (Cloud SQL, GCS) roll back by cutting back to the source instance/bucket, which therefore MUST be retained until the cutover is verified and signed off.
- KMS keys and state buckets carry `prevent_destroy`; never force-destroy them during rollback.
