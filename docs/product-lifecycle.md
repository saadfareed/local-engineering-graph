# Plan first, keep every change synchronized

For new product work, use product-build.v6.json. V6 adds [reasoned planning and cost comparison](critical-planning.md). V5 includes the v4 lifecycle gates plus [engineering quality evidence](engineering-quality.md). Before the first implementation, the assistant creates and fills the product's root planning documents. During implementation, it maintains code, documentation, user flows and associated tests together.

## Root documents

| File | Purpose |
| --- | --- |
| PRODUCT.md | Generated navigation page linking the product documents and feature directories |
| PRODUCT.json | Machine-readable feature registry, domains, document paths and preparation record |
| ARCHITECTURE-ROADMAP.md | Technical milestones, component boundaries, dependencies, risks and architectural decisions |
| PRODUCT-ARCHITECTURE.md | Current implemented architecture and public contracts; distinguish planned changes |
| PRODUCT-ROADMAP.md | Product milestones, priorities, feature IDs and delivery status |
| FEATURES.md | Generated feature list, statuses, dependencies and version references |
| PRODUCT-SCOPE.md | Problem, target users, included/excluded work, success criteria and approved scope reference |
| PRODUCT-DOMAINS.md | Domain responsibilities, ownership, data and cross-domain interfaces |
| PRODUCT-POLICIES.md | Rules inherited by features and their enforcement owners |
| USER-FLOWS.md | End-to-end journeys with flow IDs, actors, feature links and success/failure paths |
| USER-GUIDE.md | Setup, usage, examples, limitations and troubleshooting |

Each feature also has SCOPE.md, POLICIES.md, README.md, USER-FLOWS.md, feature.json, history.json and, after synchronization, synchronization.json. Components and tests can remain in the framework's existing source layout.

Initialization creates draft documents. The assistant must replace instructional scaffold text with the actual plan and initial user-flow descriptions before marking preparation ready. In the initial user guide, clearly identify planned behavior and unavailable features. The runner checks records and hashes; it cannot determine whether prose is complete or correct.

## Prepare before implementation

Run commands from this package's root, passing the target product root:

```sh
node src/cli.js product-init /absolute/product/path "Booking app"
node src/cli.js feature-add /absolute/product/path booking "Appointment booking"
```

Fill the root documents and feature scope, policies, README and flows from the approved plan. Assign stable feature, domain, flow and acceptance-criterion IDs. Map each feature to its domainIds. Add domain definitions to PRODUCT.json:

```json
[
  {"id": "appointments", "description": "Appointment availability and booking"}
]
```

The JSON above is the value of PRODUCT.json's domains array. In the booking feature manifest, set domainIds to ["appointments"]. The readable domain document should explain the same domain boundaries and ownership.

Create a planning record, for example planning-record.json:

```json
{
  "summary": "Reviewed approved scope, domain boundaries, technical/product milestones and initial journeys",
  "artifacts": ["docs/planning/approved-plan.md"]
}
```

Artifacts must exist and use product-relative paths. Then:

```sh
node src/cli.js product-sync /absolute/product/path
node src/cli.js product-ready /absolute/product/path /absolute/path/planning-record.json
```

Preparation requires at least one domain and feature, domain assignments for each feature, the required documents, and a planning record. It stores hashes of the planning documents and artifacts. A v4 task cannot advance from domain assessment into implementation until preparation is current. If the planning documents, domain assignments, feature list, or planning artifacts change before that transition, review them and record readiness again. This records planning readiness, not a new user approval; the task's scope-approval stage still requires the actual user decision.

For each new task or material scope change, refresh the plan, architecture/product roadmaps and journeys first. The assistant must still use replan for a changed implementation scope.

## Change code, documents, flows and tests together

For every feature change:

1. Read feature-context and identify affected features, downstream contracts, user flows and checks.
2. Make the authorized code change and update the affected scope, architecture, roadmaps, user guide and feature documentation.
3. Update the root and feature user flows for changed steps, outcomes, permissions, errors and recovery paths.
4. Add or update meaningful unit tests for changed behavior. Run mapped tests and relevant downstream checks. Record actual command results and supporting artifacts.
5. Refresh the generated indexes, then record synchronization for every affected implemented feature.
6. Check the whole product map before implementation completion, review, validation or version recording.

A small refactor may leave a flow or existing test valid. Review it and record unchanged with a specific reason instead of adding meaningless edits. Behavioral changes need updated behavior documentation, flow descriptions and adequate regression tests. The host and reviewer determine that requirement; field validation does not establish correctness.

Create a synchronization record such as booking-sync.json:

```json
{
  "assessments": {
    "documentation": {"status": "updated", "reason": "Documented cancellation behavior and milestone status"},
    "userFlows": {"status": "updated", "reason": "Added cancellation success and failure paths to booking flow"},
    "unitTests": {"status": "updated", "reason": "Added cancellation regression tests"}
  },
  "tests": [
    {
      "id": "booking-unit",
      "status": "passed",
      "command": "node --test tests/booking/service.test.js",
      "result": "Use the actual check result here"
    }
  ],
  "artifacts": ["docs/validation/booking-cancellation.md"]
}
```

Map the test in feature.json first and replace the illustrative result with actual output. Include matching passing results for every test mapped to that feature. The first synchronization establishes a baseline. Later records must use updated when the corresponding mapped files changed, and unchanged with a reason when they did not. Both statuses need a reason.

```sh
node src/cli.js product-sync /absolute/product/path
node src/cli.js feature-sync /absolute/product/path booking /absolute/path/booking-sync.json
node src/cli.js product-check /absolute/product/path
```

Synchronization saves content hashes for the feature's code, tests, documents and flows, upstream feature files, shared root documents and registry. It also hashes the validation artifacts and saves review assessments and test results. Any later change to these files invalidates the record. Run the relevant checks and record synchronization again before advancing. Upstream changes invalidate downstream records, so downstream tests must be reassessed and their results recorded too.

Shared root document or registry changes can invalidate several implemented features. Resynchronize those features after updating the shared plan. PRODUCT.md and FEATURES.md are derived indexes; product-check verifies they match the current manifests/history instead of requiring their hashes in each synchronization record.

The runner does not watch files or automatically rewrite prose or tests. Codex performs those updates as part of the skill. The gates detect stale tracked content and incomplete records; semantic consistency and actual test execution remain the host's responsibility.

## Review, validation and version history

V4 implementation completion requires featureIds, implemented features with mapped components/unit tests, and current synchronization records for all implemented features in the product map. It snapshots the root documents, feature documentation/flows, and synchronization records along with the mapped files. Review and validation passes repeat product checks and compare the implementation snapshot.

If a file changes after implementation completion, route through changes_required or failed, update/review the related material, synchronize and submit implementation again. Scope changes require replan and renewed approval. Do not mark failed or unverified checks passed to satisfy synchronization.

After task completion, use feature-release to append version changes and preserve documentation/flow/test snapshots in history. Version records need current feature synchronization and actual passing test records. Release recording updates the derived version links without modifying the stored synchronization baseline.

## Existing products and compatibility

Existing task graphs and schema-1 product maps are not silently migrated. V1–v3 remain available. Product schema 2 enables the new documents and synchronization checks; v4 additionally gates initial implementation on planning readiness.

To adopt an existing schema-1 map, back it up, add the missing root and feature documents without overwriting existing content, and update the registry to schemaVersion 2 with documents, domains and preparation: {"status":"draft"}. The documents mapping must contain scope, architectureRoadmap, roadmap, domains, userFlows, documentation and features keys pointing to the corresponding files in the table above. Add domainIds, documentation and userFlows to each feature manifest. Preserve features, components, tests and history. Populate the plan, then run product-sync, product-ready and feature-sync for implemented features. There is no automatic migration command.
