# Phased Claude Code Execution Plan

Each brief below is a self-contained task for the `engineering-workflow` skill. Hand one brief at a
time to Claude Code with:

> Use engineering-workflow with graph `graphs/product-build.v7.json` on `<this package root>`.
> Objective: the brief in `docs/meta-os/briefs/README.md` section `<NN>`. Show scope and
> acceptance criteria for approval before implementing; use the listed check-run specs as
> validation criteria; do not widen scope.

Conventions shared by every brief: Node 22 built-ins only; keep `npm run check` green; existing
runner behaviour (`src/state.js`, `src/graph.js`, `src/checks.js`, `src/product.js`,
`src/quality.js`, `src/cli.js`) stays byte-identical unless the brief says otherwise; new
behaviour is opt-in; every criterion is proven by a `check-run` whose spec is given. Baseline
status: briefs 01–06 and 08 already have a reference implementation in `src/` with tests; those
briefs harden and wire it rather than write it from scratch.

| # | Brief | Depends on | Delivers |
|---|---|---|---|
| 01 | Kernel baseline & schema validator | — | `src/kernel`, `src/schema`, `graphs/api-platform.v1.json`, CI green |
| 02 | Contract engine & INDEX generator | 01 | `src/contracts/spec.js`, `os.js api-index`, templates in a sample project |
| 03 | 5-tier memory store | 01 | `src/memory/store.js`, `memory-sync`, stale invalidation on commit hooks |
| 04 | Context compiler | 02, 03 | `src/memory/compiler.js`, `os.js context`, budget tests at 1,000 endpoints |
| 05 | Swarm bus & signed evidence | 01 | `src/daemon/bus.js`, `os.js swarm`, V7 evidence bridge |
| 06 | Apidog exporter & CLI gate | 02 | `src/exporters/apidog-sync.js`, `api-export/push/verify`, live-verified against a real Apidog project |
| 07 | Adapter compiler (FastAPI, NestJS) | 02 | `src/adapters/compile.js`, templates, call-graph + openapi-diff scripts |
| 08 | HITL deltas & sleep-cycle consolidator | 03 | `src/memory/consolidate.js`, `os.js delta/consolidate`, consolidation node |
| 09 | Intent compiler & stack selector | 03, 07 | `src/intent/*`, dynamic graph/agents/policies compilation |
| 10 | Generative workspace shell | 05 | `src/ui/` zero-dependency shell rendering ui-layout specs over SSE |
| 11 | Scale & end-to-end rehearsal | all | 1,000-endpoint synthetic project through the whole lifecycle |

---

## 01 — Kernel baseline & schema validator

**Objective.** Land the shared kernel helpers and the JSON-schema subset validator, register the
four Meta-OS schemas, and add the `api-platform` graph, with CI proving the existing runner is
untouched.

**Scope.** `src/kernel/util.js` (canonical JSON, sha256, tokenizer, token estimate),
`src/schema/validate.js` (type/enum/const/required/properties/additionalProperties/
patternProperties/items/min-max/pattern/uniqueItems/allOf/anyOf/oneOf/if-then-else/$ref),
`src/schema/{decision-card,hitl-delta,adapter-manifest,ui-layout}.schema.json`,
`graphs/api-platform.v1.json`, `tests/meta-os-schema.test.js`.

**Out of scope.** Any CLI wiring, memory, bus.

**Acceptance criteria.**
- C1 `validate()` rejects each of the keyword violations listed above with a path-prefixed message.
- C2 all four schemas parse and the example card/delta/layout/manifests validate.
- C3 `scripts/validate.js` validates `api-platform.v1.json` with the existing graph validator (required gates dominate the success terminal; evidence contracts for worker/reviewer/validator/user present).
- C4 existing test count unchanged and green.

**Checks.** `{"argv":["node","--test","tests/meta-os-schema.test.js"],"timeoutMs":60000}`,
`{"argv":["node","scripts/validate.js"],"timeoutMs":30000}`, `{"argv":["npm","run","check"],"timeoutMs":300000}`.

## 02 — Contract engine & INDEX generator

**Objective.** Make `docs/api/**` bundles machine-readable and keep `INDEX.md` generated.

**Scope.** `src/contracts/spec.js` (`parseMarkdown`, `parseSpec`, `parsePolicies`, `parseTests`,
`parseIndex`, `renderIndex`, `loadBundle`, `loadAllBundles`, `indexRow`, `structuralEdges`),
`os.js api-index`, a `scaffold` subcommand that copies the templates into
`docs/api/<domain>/<endpoint>/` with the id/method/path substituted, templates under
`docs/meta-os/templates/`.

**Acceptance criteria.**
- C1 the four templates parse to the documented object shapes; missing `id|method|path`, invalid JSON schema blocks and tests referencing undefined scenarios fail with file-qualified errors.
- C2 `api-index` is deterministic (same bundles → identical bytes) and preserves prior Status/Apidog cells unless the spec hash changed.
- C3 `structuralEdges()` classifies repository `insert|create|save|update|delete|upsert` as `writes` and everything else as `reads`/`calls`/`serializes`; `none` mutations produce no edge.
- C4 scaffolding 1,000 synthetic endpoints then `api-index` completes in under 5 s on a laptop (record the measurement).

**Checks.** `{"argv":["node","--test","tests/meta-os-apidog.test.js","--test-name-pattern","contract|INDEX"],"timeoutMs":60000}`,
`{"argv":["node","src/os.js","api-index","tests/fixtures/thousand"],"timeoutMs":30000}`.

## 03 — 5-tier memory store

**Objective.** Persist the five tiers in `node:sqlite` with commit/file-hash anchoring and a
deterministic inverted index.

**Scope.** `src/memory/store.js` as shipped; `os.js memory-sync` (structural rebuild from bundles,
stale invalidation by hash); `scripts/meta-os-ddl.js` keeping `docs/meta-os/schemas/memory.sql`
in sync; a `post-commit` hook snippet (documented, not installed) that runs `memory-sync`.

**Acceptance criteria.**
- C1 remember/recall/reinforce/invalidate behave per `tests/meta-os-memory.test.js`; recall order is stable across runs.
- C2 `invalidateStale()` flips exactly the memories whose anchored file hash differs; untouched tiers unaffected.
- C3 `impacted()` returns transitive dependents ordered by depth then id; `memory-sync` on the 1,000-endpoint fixture builds ≥ 5,000 edges in under 3 s.
- C4 docs DDL matches the kernel DDL (test enforced).

**Checks.** `{"argv":["node","--test","tests/meta-os-memory.test.js"],"timeoutMs":60000}`,
`{"argv":["node","src/os.js","memory-sync","tests/fixtures/thousand"],"timeoutMs":30000}`.

## 04 — Context compiler

**Objective.** Guarantee every worker starts from a verified, budgeted, auditable context bundle.

**Scope.** `src/memory/compiler.js` as shipped; `os.js context`; a `--budget` flag; manifest written
beside the bundle; integration with the bus (`contextCompiler` hook already exists).

**Acceptance criteria.**
- C1 for budgets 300/800/4,000 the compiled bundle never exceeds the budget (headings included) and the second pass fills spare budget in priority order.
- C2 identical inputs produce identical `markdownSha256`; the manifest lists every section's source hash and memory ids.
- C3 adapter-filtered procedural recall; global alignment rules included even with no term overlap; stale memories never appear.
- C4 compiling context for endpoint #1 and endpoint #1,000 of the fixture differ in wall time by less than 20%.

**Checks.** `{"argv":["node","--test","tests/meta-os-memory.test.js","--test-name-pattern","context compiler"],"timeoutMs":60000}`,
`{"argv":["node","src/os.js","context","tests/fixtures/thousand","catalog.item999","Implement per spec","--budget","4000"],"timeoutMs":30000}`.

## 05 — Swarm bus & signed evidence

**Objective.** Dispatch isolated Claude Code workers per unit, verify deterministically, sign
evidence, merge only what passed, and bridge to the V7/parallel-workers evidence contracts.

**Scope.** `src/daemon/bus.js` as shipped; `os.js swarm` with `--serve`; an `evidence-bridge`
helper that converts `swarm-report.json` into (a) a worker `completed` evidence object (artifacts,
`codeFiles` = union of changed files, `sandboxExecution` from the adapter's install/serve/health/
shutdown verifiers recorded through `check-run`) and (b) for `parallelWorkers` graphs, the
`integration-coordinator.integrated` evidence (`children`, `integrationChecks`, `ancestryChecks`
derived from base/head/merge SHAs). Documentation of the worker argv template and env.

**Acceptance criteria.**
- C1 real-git test: 2 passing + 1 failing + 1 no-output unit → exactly the passing units merge, in plan order, into `swarm/<task>/integration`; failed worktrees retained; main checkout untouched.
- C2 every `evidence.json` and `swarm-report.json` verifies with the OS public key; a single-field edit fails verification.
- C3 merge conflicts are reported as `conflict` and never force-merged; `git merge --abort` leaves the integration tree clean.
- C4 the bridge output passes `advance` on a V7 task (worker completed) and on a `parallel-build.v1` parent (integrated) using `check-run` records for the integration verifier.
- C5 SSE `/events` replays history and streams live events; `/layout` validates against the ui-layout schema.

**Checks.** `{"argv":["node","--test","tests/meta-os-bus.test.js"],"timeoutMs":120000}`,
`{"argv":["node","--test","tests/parallel-workers.test.js"],"timeoutMs":120000}`.

## 06 — Apidog exporter & CLI gate

**Objective.** Compile contracts to OpenAPI 3.1 + an importable collection, push to Apidog, and make
the Apidog CLI a validation verifier mapped back onto `tests.md`.

**Scope.** `src/exporters/apidog-sync.js` as shipped; `os.js api-export|api-push|api-verify`; a
one-time live verification against a real Apidog project recorded in the task evidence:
confirm the import endpoint options accepted by the current Open API, confirm the JSON reporter
field names (`summarizeReport` is shape-tolerant; tighten it to the confirmed shape), and
document the scenario-naming convention `<endpointId>::<testId>` in Apidog.

**Acceptance criteria.**
- C1 OpenAPI output validates with an external 3.1 validator run through `check-run` (e.g. `npx @redocly/cli lint`, recorded as a one-off tool, not a dependency of the kernel).
- C2 collection import into Apidog succeeds and creates one test case per `tests.md` row with the expected name.
- C3 `api-verify` against the running sample service produces a matrix with every row `passed` and flips `INDEX.md` to `verified`/`synced <time>`; a deliberately broken endpoint flips to `failed` and exits 1.
- C4 no token appears in any file under `.engineering/`.

**Checks.** `{"argv":["node","--test","tests/meta-os-apidog.test.js"],"timeoutMs":60000}`,
`{"argv":["node","src/os.js","api-export","<sample>"],"timeoutMs":30000}`,
`{"argv":["node","src/os.js","api-verify","<sample>",".engineering/apidog/run-1","-t","<scenarioId>","-e","<envId>"],"timeoutMs":600000}`.

## 07 — Adapter compiler (FastAPI, NestJS)

**Objective.** Compile one bundle into idiomatic files for both reference adapters, with the
call-graph and openapi-diff verifiers that prove the result matches the spec.

**Scope.** `src/adapters/compile.js` (template expansion, `regenerate-block` markers, `typeMap`,
policy bindings), templates under `docs/meta-os/adapters/<id>/templates/`, verifier scripts
`procedural/scripts/{callgraph-python,callgraph-ts,openapi-diff}.mjs` (Node-only; Python AST via
`python3 -c` subprocess, TS via a minimal tokenizer sufficient for class/method detection), and the
worked example in `docs/meta-os/adapters/README.md` produced by the compiler itself.

**Acceptance criteria.**
- C1 compiling `orders.create` for FastAPI and NestJS yields files whose symbols cover every `Calls` entry and whose tests carry `T1..T5` names; the generated projects' own test suites pass in a sandbox (record install/start/health/shutdown).
- C2 re-compiling after a hand edit outside the markers preserves the edit byte-for-byte.
- C3 `openapi-diff` reports zero differences for `orders.create` between the framework-exported OpenAPI and `.engineering/apidog/openapi.json`; introducing a response code mismatch is detected.
- C4 manifests for both adapters validate; a third stub manifest (django-drf) validates and is listed by the selector.

**Checks.** `{"argv":["node","--test","tests/meta-os-adapters.test.js"],"timeoutMs":120000}`, sandbox checks per adapter `runtime` (install/test/serve/healthPath).

## 08 — HITL deltas & sleep-cycle consolidator

**Objective.** Capture every human intervention as an exact delta and turn it into ADRs, promoted
policies, alignment memory and blueprints.

**Scope.** `src/memory/consolidate.js` as shipped; `os.js delta|consolidate`; a `memory-curator`
agent file (`agents/memory-curator.md`) for the `consolidation` node describing when to run the
sleep cycle and what to report; capture points in the skill text (answering a card, editing an
approved artifact, rejecting a review) that call `os.js delta`.

**Acceptance criteria.**
- C1 schema-invalid deltas are rejected; agent-authored deltas are ignored by consolidation.
- C2 a card answer produces exactly one ADR with options, chosen/recommended markers, human rationale and impact; re-running produces none.
- C3 the same review rule across 3 distinct tasks promotes into `policies/learned.json` and `~/.engineering-os/alignment/rules.jsonl`; below threshold it only reinforces a candidate; promotion invalidates the candidate.
- C4 merged units from a swarm report become blueprints under `procedural/blueprints/<adapter>/` and are recalled by the compiler for the next endpoint of the same adapter.

**Checks.** `{"argv":["node","--test","tests/meta-os-consolidate.test.js"],"timeoutMs":60000}`.

## 09 — Intent compiler & stack selector

**Objective.** From raw intent, select the stack with human approval and compile bespoke
graph/agents/policies for the chosen domain and adapter.

**Scope.** `src/intent/selector.js` as shipped plus `src/intent/compile.js`: derive the intent
profile from brief text + repo scan (languages, existing framework, package manifests) + alignment
biases; emit the decision card; after approval write `.engineering/stack.json`, generate
`graphs/<project>-<adapter>.v1.json` from `api-platform.v1.json` (adding per-domain swarm nodes
when the plan has more than one domain), `agents/<role>.md` specialisations with adapter-specific
verifier instructions, and `policies/<project>.json` merging `defaults.json`, `learned.json` and
the adapter's policy bindings.

**Acceptance criteria.**
- C1 selector scores are explainable per dimension and reproducible; `existing.framework` and alignment biases shift scores as documented.
- C2 generated graphs validate with `scripts/validate.js`; required gates still dominate success.
- C3 the card round-trips: answer → `decision_card_answer` delta → ADR (brief 08).
- C4 a TypeScript-heavy intent selects NestJS and a Python/AI intent selects FastAPI on the shipped manifests.

**Checks.** `{"argv":["node","--test","tests/meta-os-schema.test.js","--test-name-pattern","stack selector"],"timeoutMs":60000}`, `{"argv":["node","scripts/validate.js"],"timeoutMs":30000}`.

## 10 — Generative workspace shell

**Objective.** A zero-dependency local web shell that renders whatever ui-layout spec the current
stage emits, over SSE from the bus.

**Scope.** `src/ui/server.js` (node:http static + `/api/*` proxy to bus endpoints and task files),
`src/ui/shell.html` + `shell.js` (vanilla DOM renderers for the fixed component vocabulary: dag,
call-graph, decision-card, diff, evidence-matrix, markdown, table, log-stream, status-banner, form,
api-index, empty), layout producers for each graph stage (`layouts/<node>.js`) e.g. planning →
DAG + call-graph of `structuralEdges`, `AWAITING_HUMAN` → decision card with answer form that
calls `os.js delta`, validation → risk-weighted diff + Apidog evidence matrix. No build step, no
npm packages.

**Acceptance criteria.**
- C1 every producer emits layouts that validate against `ui-layout.schema.json`.
- C2 answering a card from the shell appends a valid delta and the host can advance the approval node with the card in `artifacts`.
- C3 a swarm dispatched with `--serve` streams unit status changes to the open shell within 1 s.
- C4 the shell works with JavaScript-only browsers features available in current Chromium/Firefox; no external requests.

**Checks.** `{"argv":["node","--test","tests/meta-os-ui.test.js"],"timeoutMs":60000}` (server routes + layout validation), manual browser check recorded as a validation protocol with screenshots under the task directory.

## 11 — Scale & end-to-end rehearsal

**Objective.** Prove the whole lifecycle on a synthetic 1,000-endpoint project and record the
numbers that back the "endpoint 950 as fast as endpoint 1" claim.

**Scope.** `tests/fixtures/thousand` generator (10 domains × 100 endpoints, shared models to
exercise structural memory), a scripted run of the `api-platform` graph with a fake worker that
compiles via the adapter compiler, Apidog export/import of the full document, swarm dispatch with
concurrency 8 on 50 units, consolidation, and a report `docs/meta-os/scale-report.md` with
measured times for index, memory-sync, context compile (first vs last endpoint), swarm throughput
and consolidation.

**Acceptance criteria.**
- C1 `api-index`, `memory-sync` and `api-export` on 1,000 endpoints each complete under 10 s.
- C2 context compile time for endpoints #1 and #1,000 differ by less than 20% and both stay under the 4k budget.
- C3 50-unit swarm with 8 workers merges all passing units with signed evidence; event log and report verify.
- C4 consolidation after the run yields blueprints for every merged adapter/endpoint and no duplicate ADRs on re-run.

**Checks.** `{"argv":["node","scripts/meta-os-scale.js","--endpoints","1000","--units","50","--concurrency","8"],"timeoutMs":1800000}`.
