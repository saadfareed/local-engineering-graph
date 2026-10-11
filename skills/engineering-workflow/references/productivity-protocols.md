# Productivity protocols

Use these controls to reduce feedback latency and integration rework. Treat 10x productivity as a target until comparable measurements demonstrate it.

## Stage feedback

Every active stage records safe commands or deterministic protocols appropriate to the product:

- Planning: repository inspection, assumption checks and plan/contract validation. Present the completed plan and acceptance criteria for explicit user approval before implementation.
- Implementation: isolated setup, start, health/readiness, focused tests/debugging and shutdown. Record unavailable execution as a blocker or limitation, never a pass.
- Review: diff/static analysis, contract compatibility and focused regressions without editing during the review pass.
- Validation: execute every approved criterion and record command, result and environment.

Start with the fastest relevant feedback, then integration and broader checks. Compilation does not prove execution. Never silently point sandbox commands at production.

For V7, run every passing stage check through `check-run` and attach its `run` reference. The runner binds checks to the current project state. Sandbox setup, start, health and shutdown also need runner records, in order, with focused checks between health and shutdown. Put logs under the task's `.engineering` directory.

## Contract-first integration

When a backend serves frontend, mobile, desktop or another service, store one versioned integration contract such as OpenAPI, GraphQL, protobuf or JSON Schema plus examples. Define requests, success/errors, auth, nullability/defaults, time/units, pagination, retries/idempotency, compatibility and representative examples.

The backend provides deterministic demo output through a sandbox endpoint, fixture server, generated examples or contract-backed mock. Every consumer builds and tests against that same contract and output.

Before accepting integration:

1. Validate contract syntax and examples.
2. Run backend provider tests.
3. Run every consumer's parsing/component checks.
4. Run an end-to-end sandbox path against the backend when feasible.
5. Record contract version/hash, commands and results.

Material contract changes after approval require compatibility assessment and, when approved behavior changes, replanning and renewed user approval.

## Measurement

Measure useful throughput such as time to first runnable slice, failed integration cycles, escaped defects, manual steps removed or lead time to a verified criterion. Do not infer a multiplier from code volume, estimates or parallel activity.
