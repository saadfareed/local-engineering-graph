# Product map and feature engineering

The workflow graph tracks the stages of a task. The product graph tracks what the product contains and how its features and components depend on one another. Use both during implementation. Start with the [product lifecycle guide](product-lifecycle.md) for root planning documents and per-change synchronization.

## Product layout

```text
my-product/
├── PRODUCT.md                    Generated feature table of contents
├── PRODUCT.json                  Registry of feature IDs and directories
├── PRODUCT-POLICIES.md            Product-wide rules inherited by features
├── PRODUCT-ARCHITECTURE.md        Component boundaries and shared contracts
├── ARCHITECTURE-ROADMAP.md        Technical delivery plan
├── PRODUCT-ROADMAP.md             Feature milestones and priorities
├── PRODUCT-SCOPE.md               Approved product boundaries
├── PRODUCT-DOMAINS.md             Domain ownership and contracts
├── FEATURES.md                   Generated feature list
├── USER-FLOWS.md                  End-to-end journeys
├── USER-GUIDE.md                  Usage and troubleshooting
├── features/
│   └── booking/
│       ├── feature.json          Status, dependencies, components and tests
│       ├── SCOPE.md              Purpose, boundaries and acceptance criteria
│       ├── POLICIES.md           Feature rules and exception procedure
│       ├── README.md             Feature user documentation
│       ├── USER-FLOWS.md         Feature journeys and failure paths
│       ├── synchronization.json Docs/flows/tests review and hashes
│       └── history.json          Version records with changes and evidence
├── src/features/booking/          Example component/code location
├── tests/booking/                 Example unit-test location
└── .engineering/tasks/           Task decisions, reviews and validation
```

The tool creates metadata, not application code or passing tests. Component and test paths can point to your existing framework layout; metadata and source do not need to share a directory. Keep product metadata in version control. Task artifacts can stay local according to your project's data policy.

## Start after planning

From the workflow package root:

```sh
node src/cli.js product-init /absolute/product/path "Booking app"
node src/cli.js feature-add /absolute/product/path booking "Appointment booking"
```

Initialization refuses to overwrite existing product files. Feature creation refuses duplicate IDs and existing feature directories. It creates a planned feature with empty component/test lists; fill the scope and policies before implementation. Generated instructional headings are not an approved specification.

Populate PRODUCT-ARCHITECTURE.md with the chosen architecture, shared component ownership, interface contracts, data ownership, dependency direction, and testing conventions. Record product rules in PRODUCT-POLICIES.md, then feature-specific rules in each POLICIES.md. Policies are instructions for the host, not execution permissions enforced by the CLI.

For an existing product, map existing files first and preserve its layout. Avoid moving code just to fit an example directory structure.

## Feature manifest

Edit features/booking/feature.json as the feature evolves. This example assumes the listed files have been implemented:

```json
{
  "schemaVersion": 1,
  "id": "booking",
  "title": "Appointment booking",
  "status": "implemented",
  "domainIds": ["appointments"],
  "documentation": "features/booking/README.md",
  "userFlows": "features/booking/USER-FLOWS.md",
  "scope": "features/booking/SCOPE.md",
  "policies": "features/booking/POLICIES.md",
  "dependsOn": ["accounts"],
  "components": [
    {
      "id": "booking-service",
      "path": "src/features/booking/service.js",
      "dependsOn": ["accounts-service"]
    }
  ],
  "tests": [
    {
      "id": "booking-unit",
      "type": "unit",
      "path": "tests/booking/service.test.js",
      "command": "node --test tests/booking/service.test.js"
    }
  ]
}
```

Define appointments in PRODUCT.json domains. Register accounts and its accounts-service component before using this example. For a standalone feature, use empty dependency arrays.

- Feature IDs are unique lowercase kebab-case identifiers.
- Status is planned, implementing, implemented, or retired. Set it manually to reflect the work.
- Component IDs are unique across the product. Map each relevant source file as a component entry; a component may be a UI element, service, adapter, or shared module. Keep IDs stable when paths change.
- Test IDs are unique within a feature. Supported types are unit, integration, and e2e. Commands run from the product root and are recorded, not executed by these map commands.
- Implemented features need at least one component and one unit-test mapping. Test file existence does not establish coverage or a passing result.
- All document, code, test, and version-artifact paths are project-relative. References must exist and stay inside the project, including through symlinks.
- Feature and component dependency graphs must be acyclic. A cross-feature component dependency requires a matching direct feature dependency. Runtime bidirectional communication can use a shared interface component instead of a circular implementation dependency.

For shared code, register a shared feature with an owner and stable public interfaces. Other features explicitly depend on it. Document architectural decisions and contract changes in PRODUCT-ARCHITECTURE.md and the relevant scope/version records.

After code, document, flow or test changes, record feature-sync per the lifecycle guide. After editing manifests or history, refresh and check the table of contents:

```sh
node src/cli.js product-sync /absolute/product/path
node src/cli.js product-check /absolute/product/path
```

PRODUCT.json and feature.json are authoritative. Do not edit generated PRODUCT.md directly. Checking detects dangling paths, dependency cycles, invalid manifests, missing mapped unit tests for implemented features, and a stale index. It does not analyze source imports or execute tests.

## Read context and assess a change

```sh
node src/cli.js feature-context /absolute/product/path accounts
```

The result contains:

- The feature's scope, policies, components, tests, and history.
- Its transitive upstream dependencies.
- Its transitive downstream dependents.
- Product and feature documents to read before implementation.
- Mapped tests for the feature and downstream features that could be affected.

Use those links to retrieve targeted context. Read the downstream contracts when changing a public interface and run affected tests as appropriate. The graph is declared metadata; undeclared source dependencies will not appear. Reviewers must compare it against real imports and callers.

## Use the v6 implementation workflow

```sh
node src/cli.js start /absolute/product/path graphs/product-build.v6.json "Implement appointment booking"
```

Initialize the product map and register the planned features before completing implementation. Existing scope approval still applies. At implementation completion, include featureIds in the normal structured evidence:

```json
{
  "summary": "Implemented appointment booking within the approved scope",
  "artifacts": ["implementation.md"],
  "featureIds": ["booking"],
  "codeFiles": ["src/features/booking/service.js"]
}
```

Each named feature must be registered and marked implemented with mapped components and unit tests. V3/V4 automatically adds its manifest, scope, policies, component and test files, plus the product registry, index, architecture and policies to the implementation snapshot. Additional relevant files belong in codeFiles. Review and validation passes require a valid current map and matching snapshot contents.

During planning, identify the task's affected features and acceptance criteria. During implementation, update code and map documents together. Review architecture and policies along with the diff. During validation, run mapped unit tests and relevant downstream checks, and verify every approved acceptance criterion. Scope changes use replan and renewed approval; a map is not a substitute for that decision.

V1 and v2 tasks remain compatible and do not require a product map. New skill-led product implementations use v6, with root planning readiness and documentation/flow/test synchronization.

## Record what changed in a feature version

After checks have actually passed, feature synchronization is current and the task has completed, save a validation artifact in the product and prepare a release JSON file:

```json
{
  "version": "0.1.0",
  "codeRevision": "actual Git commit or documented build identifier",
  "changes": [
    "Added appointment creation and cancellation",
    "Added unit checks for unavailable slots"
  ],
  "artifacts": ["docs/validation/booking-0.1.0.md"],
  "tests": [
    {
      "id": "booking-unit",
      "status": "passed",
      "command": "node --test tests/booking/service.test.js",
      "result": "Record the actual command result here"
    }
  ]
}
```

Replace the illustrative values with actual results. Include passing results with matching commands for every test mapped to that feature.

```sh
node src/cli.js feature-release /absolute/product/path booking /absolute/path/booking-release.json
```

This appends a version record to features/booking/history.json and updates the index. It records the version, timestamp, code reference, changes, test results, artifacts, and content hashes of the feature and product documents, components, tests, and evidence artifacts. Duplicate versions are refused. Historical hashes remain unchanged when current files change. Record versions after task completion because changing history/index during a task can invalidate its snapshot.

A feature version is an engineering change record. It does not publish a package, tag Git, deploy a product, or authenticate test results. Preserve existing history entries in Git; append new versions for later changes. Product releases may include several separately versioned features. The CLI does not calculate semantic-version increments or enforce version ordering.

## Everyday maintenance

For a change request: find the feature in PRODUCT.md, inspect feature-context, read scope and policies, update the affected components and tests, refresh the map, review and validate, then append the version record. Add a new feature when the responsibility is new. Retire obsolete features explicitly and update dependencies before removing code.

Map writes use a local exclusive .product-map.lock file and a write-ahead undo journal. Failed operations roll back. After a crashed local writer exits, use `node src/cli.js product-recover /absolute/product/path`; it backs up the journal and restores interrupted changes before removing the lock. Recovery refuses live or foreign-host writers. Incomplete metadata and stale recovery mutexes require manual inspection. The task recover command handles task locks separately. Full power-loss durability is not guaranteed.

V5 also requires design/reuse planning, implementation assessment and engineering review evidence; see [engineering quality](engineering-quality.md).

V6 also requires product proposal assessments and material design option/cost comparisons; see [critical planning](critical-planning.md).
