# Productivity protocols

Use these protocols to shorten feedback loops and prevent late integration and release rework. The goal is higher verified throughput; a 10x gain remains a target until a comparable baseline and result are measured.

## Every active stage has a feedback command

Planning, implementation, review and validation evidence must identify commands or deterministic checks appropriate to the product. Commands must be safe for the current environment and must not imply permission for deployment, publication or destructive actions.

- Planning: inspect the repository, validate assumptions, lint machine-readable plans/contracts and record unresolved questions. Obtain explicit user approval for the completed plan and its acceptance criteria before implementation.
- Implementation: provide setup, sandbox start, health/readiness, focused test and debug commands. Run the product in an isolated local/test environment when the stack permits it. Record why execution is unavailable instead of claiming success.
- Review: run diff/static analysis, contract compatibility and focused regression checks. Reviewers do not repair code during the review pass.
- Validation: run each approved criterion with an actual command or deterministic protocol and record its result and environment.
- Release/operations: use preflight, migration dry-run or disposable-database checks, packaging checks, security scans and rollback/restore drills when applicable. Distinguish local, sandbox, device, staging and production evidence.

Prefer the fastest relevant feedback first, followed by integration and broader checks. A command that only compiles a test does not prove the test executed.

## Sandbox execution contract

Before implementation is submitted, record:

- environment and isolation boundary;
- setup command;
- start command;
- health/readiness command and observed result;
- focused test/debug commands and results;
- shutdown/cleanup command;
- unavailable external services or substituted fakes.

Use `check-run` for setup, start, health, focused checks and shutdown; attach its references as `setupRun`, `startRun`, `healthRun`, entries in `checks`, and `shutdownRun`. Each run must pass on the same task revision and tracked project state. Start should launch a disposable service and return so the health command can inspect it. Run the focused and contract checks before shutdown.

Use disposable databases/accounts and non-production credentials where practical. Never silently point a sandbox command at production. If the product cannot run in the available host, record the blocker and validate the largest safe subset.

## Contract-first multi-surface development

When a backend and one or more frontend/mobile clients exchange data, the backend owns a versioned integration contract before parallel component work begins. Store it as a project artifact in a technology-appropriate form such as OpenAPI, GraphQL schema, protobuf, JSON Schema plus examples, or an equivalent interface definition.

The contract must describe:

- endpoint/message identity and versioning strategy;
- request, success response and error shapes;
- authentication/authorization expectations;
- field nullability, defaults, units, time zones and pagination;
- idempotency, ordering, retry and concurrency behavior where relevant;
- representative success, empty, validation, authorization and failure examples;
- compatibility/deprecation rules.

The runner hashes the contract file when planning becomes ready. Plan approval, implementation and passing transitions reject a changed contract until replanning. The implementation `contractHash` must equal the actual SHA-256 of that file.

The backend supplies deterministic demo output through a sandbox service, fixture server, generated examples or contract-backed mock. Frontend and mobile components build against the same versioned contract and fixtures rather than independently guessed response shapes.

Before integration is accepted:

1. Validate the contract syntax and examples.
2. Run backend provider/contract tests.
3. Run each consumer's parsing and component tests against the shared fixtures or mock.
4. Run at least one end-to-end sandbox path against the real backend implementation when feasible.
5. Record the contract revision/hash and results for every participating surface.

If end-to-end verification is blocked, record the blocker and use a blocked workflow outcome. A blocked result cannot accompany an implementation `completed` transition.

Contract changes after plan approval require compatibility assessment. Breaking or material behavioral changes require replanning and renewed user approval.

## Productivity measurement

Optimize feedback latency, rework and verified delivery—not raw output volume. When measuring improvement, record a comparable baseline and result for useful metrics such as time to first runnable slice, failed integration cycles, escaped defects, lead time to verified criterion, or manual steps removed. Do not claim 10x from code volume, parallel activity or estimates alone.
