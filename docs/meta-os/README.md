# Engineering Meta-OS — Architecture Package

A framework-independent, neuro-symbolic engineering operating system layered on the existing
Local Engineering Graph (Node.js 22+, zero npm dependencies). Agents (neural) propose plans,
contracts and code; deterministic runners, call-graph checkers, test suites and the Apidog CLI
(symbolic) produce proof before any graph transition unlocks. All truth lives on disk.

This package is implementation-ready: the kernel modules listed in section 4 exist under `src/`,
are covered by `tests/meta-os-*.test.js`, and pass `npm run check` alongside the existing runner.
The task briefs in section 6 integrate and harden them slice by slice.

| Section | Where |
|---|---|
| 1. System topology & directory layout | this file, below |
| 2. Core data contracts & schemas | [schemas/memory.sql](schemas/memory.sql), [../../src/schema/*.schema.json](../../src/schema/), [templates/](templates/) |
| 3. End-to-end state-machine lifecycle | this file, below |
| 4. Kernel code | [../../src/memory/store.js](../../src/memory/store.js), [compiler.js](../../src/memory/compiler.js), [consolidate.js](../../src/memory/consolidate.js), [../../src/daemon/bus.js](../../src/daemon/bus.js), [../../src/exporters/apidog-sync.js](../../src/exporters/apidog-sync.js), supporting [contracts/spec.js](../../src/contracts/spec.js), [intent/selector.js](../../src/intent/selector.js), [schema/validate.js](../../src/schema/validate.js), [kernel/util.js](../../src/kernel/util.js), CLI [os.js](../../src/os.js) |
| 5. Reference framework adapters | [adapters/README.md](adapters/README.md), [adapters/fastapi/adapter.json](adapters/fastapi/adapter.json), [adapters/nestjs/adapter.json](adapters/nestjs/adapter.json) |
| 6. Phased Claude Code execution plan | [briefs/README.md](briefs/README.md) |

Design stance in one paragraph: the existing runner already enforces the hard invariants this OS
needs (replayed task history, revision-checked writes, budgeted edges, required gates, artifact
hash binding, check-run evidence, parent/child tasks). The Meta-OS does not replace any of that.
It adds four things around it: a contract layer (`docs/api/**`) that makes endpoints the unit of
work, a memory layer (SQLite + JSONL, commit-anchored) that makes endpoint 950 as cheap as endpoint
1, an active bus that turns "the host drives every node" into "a daemon drives swarms of Claude
Code workers in worktrees and signs what they produced", and a HITL loop that turns every human
intervention into durable policy. `AWAITING_HUMAN` is not a new node type: it is the existing
`approval` node type carrying a structured decision card as its artifact, so every existing gate
proof still holds.

---

## 1. System topology & directory layout

```
~/.engineering-os/                       Global OS home (ENGINEERING_OS_HOME overrides)
├── keys/
│   ├── evidence.key                     Ed25519 private key (0600) used by the bus to sign evidence
│   └── evidence.pub                     public key; fingerprint recorded in every signed record
├── adapters/                            installed framework adapters (override package defaults)
│   ├── fastapi/adapter.json             manifest (schema: src/schema/adapter-manifest.schema.json)
│   ├── fastapi/templates/*.tmpl         layer templates (models, schemas, service, router, tests…)
│   ├── nestjs/adapter.json
│   ├── nestjs/templates/*.tmpl
│   └── <django-drf|go-fiber|spring-boot|laravel>/   extensible; same schema
├── procedural/                          Tier 4 memory (global, reusable)
│   ├── blueprints/<adapter>/<endpoint>.json   extracted from merged, verified swarm units
│   └── scripts/                         callgraph-python.mjs, callgraph-ts.mjs, openapi-diff.mjs, query-count…
├── alignment/                           Tier 5 memory (global taste + learned rules)
│   ├── rules.jsonl                      promoted rules (also mirrored into project policies/learned.json)
│   └── preferences.jsonl                stated/observed preferences, adapter biases
└── ui/                                  optional static shell assets (subsystem 7); kernel serves JSON only

<project>/                               One repository (multi-repo: one .engineering per repo, shared OS home)
├── .engineering/                        Project state (gitignored, see root .gitignore)
│   ├── tasks/<uuid>/                    Local Engineering Graph task (unchanged)
│   │   ├── task.json                    replayed state machine; swarm/apidog evidence referenced from here
│   │   ├── brief.md, plan.md, …         stage artifacts bound by approval hashes
│   │   ├── checks/<id>.json|.stdout|.stderr   check-run records (existing contract)
│   │   ├── cards/<cardId>.json          AWAITING_HUMAN decision cards (schema: decision-card)
│   │   ├── context/<endpoint>.md|.json  compiled <4k context bundles + manifests (Tier 1)
│   │   ├── swarm/
│   │   │   ├── <unit>/brief.md, context.md, worker.stdout|stderr, verify-<id>.stdout|stderr
│   │   │   ├── <unit>/evidence.json     signed unit evidence {record, sha256, signature}
│   │   │   ├── integration/verify-*.…   integration verifier logs
│   │   │   └── swarm-report.json        signed fan-in report
│   │   └── apidog/run-<n>/              apidog-cli json report + summary.json per validation gate
│   ├── worktrees/<taskId>/<unit>/       git worktrees for swarm units (removed on merge, kept on failure)
│   ├── apidog/openapi.json, collection.json, manifest.json   compiled contract bundle
│   ├── memory/memory.sqlite             5-tier store (node:sqlite, WAL); episodes.jsonl is the log truth
│   ├── memory/episodes.jsonl            Tier 2 append-only log
│   ├── human-overrides.jsonl            HITL deltas (schema: hitl-delta); consolidator input
│   ├── consolidations/<runId>.json      sleep-cycle summaries
│   ├── events.jsonl                     bus event log (SSE replays from here)
│   └── stack.json                       locked adapter after the stack-selection gate
├── docs/api/                            Universal API contracts (committed; the unit of work)
│   ├── INDEX.md                         master table of contents (generated by `os.js api-index`)
│   └── <domain>/<endpoint>/{spec.md,policies.md,tests.md}
├── docs/adr/ADR-NNNN-*.md               ADRs generated from decision-card answers
├── policies/learned.json                rules promoted from repeated human review feedback
└── (framework code laid out by the adapter: app/… or src/…)

<package>/                               This plugin (kernel source)
├── src/cli.js, state.js, graph.js, checks.js, product.js, quality.js   existing runner (unchanged)
├── src/os.js                            Meta-OS CLI (api-index|api-export|api-push|api-verify|memory-sync|context|select-stack|delta|swarm|consolidate)
├── src/kernel/util.js                   canonical JSON, sha256, token estimate, tokenizer
├── src/schema/validate.js + *.schema.json   JSON-schema subset validator and the four contracts
├── src/contracts/spec.js                Markdown bundle parser, INDEX renderer, structural-edge derivation
├── src/memory/store.js                  5-tier SQLite store + dependency graph + HITL index
├── src/memory/compiler.js               context compiler (<4k tokens, deterministic manifests)
├── src/memory/consolidate.js            HITL delta capture + sleep-cycle consolidator
├── src/daemon/bus.js                    worktree swarm dispatcher, Ed25519 evidence, SSE
├── src/exporters/apidog-sync.js         Markdown -> OpenAPI 3.1 + collection; Apidog push + CLI gate
├── src/intent/selector.js               stack selector -> decision card
├── graphs/api-platform.v1.json          the dynamic backend graph (validated by the existing validator)
├── docs/meta-os/                        this package (templates, schemas, adapters, briefs)
└── tests/meta-os-*.test.js              kernel tests
```

### Subsystem map

| # | Subsystem | Kernel modules | Persistent truth |
|---|---|---|---|
| 1 | Intent compiler & stack selector | `intent/selector.js` (+ brief 09 compiles graphs/agents/policies) | `.engineering/stack.json`, `tasks/<id>/cards/` |
| 2 | Universal API contract & call-graph engine | `contracts/spec.js`, templates | `docs/api/**`, `INDEX.md` |
| 3 | Pluggable adapters | adapter manifests + brief 07 compiler | `~/.engineering-os/adapters/` |
| 4 | Swarm bus & evidence verifier | `daemon/bus.js` | `tasks/<id>/swarm/`, `events.jsonl`, worktrees |
| 5 | 5-tier memory & context compiler | `memory/store.js`, `memory/compiler.js` | `memory.sqlite`, `episodes.jsonl`, OS home tiers |
| 6 | HITL delta & sleep-cycle | `memory/consolidate.js`, decision-card schema | `human-overrides.jsonl`, `docs/adr/`, `policies/learned.json` |
| 7 | Generative workspace | `bus.serve()` + ui-layout schema (shell in brief 10) | `/layout`, `/events`, `/state` |

### Trust boundaries (unchanged from docs/architecture.md, extended)

- Local files are trusted input; there is no multi-user security boundary.
- A signature on evidence proves the record was produced by the holder of the local key and not
  edited since. It does not prove the worker's claims. Verifier exit codes and hashed logs are the
  proof; the existing `check-run` contract remains the way validation binds to a task revision.
- The bus runs git and worker/verifier commands without a shell with a small env allowlist. Host
  permissions still apply to whatever the worker (Claude Code) does inside its worktree.
- Apidog push and CLI require `APIDOG_ACCESS_TOKEN` from the environment; the token is never
  written to evidence (the recorded command redacts it).

---

## 2. Core data contracts & schemas

| Contract | File | Notes |
|---|---|---|
| 5-tier memory store + cross-API dependency graph DDL | [schemas/memory.sql](schemas/memory.sql) | generated from `src/memory/store.js` (`node scripts/meta-os-ddl.js`); a test fails if it drifts |
| AWAITING_HUMAN decision card | [../../src/schema/decision-card.schema.json](../../src/schema/decision-card.schema.json) | emitted by agents, stored under `tasks/<id>/cards/`, referenced in approval evidence `artifacts` |
| HITL delta record | [../../src/schema/hitl-delta.schema.json](../../src/schema/hitl-delta.schema.json) | one JSONL line per human intervention; `kind` selects `card`/`edit`/`review`/`preference` |
| Framework adapter manifest | [../../src/schema/adapter-manifest.schema.json](../../src/schema/adapter-manifest.schema.json) | layers, type map, policy bindings, verifiers, selection profile |
| Declarative UI layout | [../../src/schema/ui-layout.schema.json](../../src/schema/ui-layout.schema.json) | fixed component vocabulary; `bus.layout()` is a producer |
| `docs/api/INDEX.md` | [templates/INDEX.md](templates/INDEX.md) | generated; columns ID, Method, Path, Use case, Adapter, Spec hash, Status, Apidog |
| `spec.md` | [templates/spec.md](templates/spec.md) | metadata table, Auth & Headers, Request/Responses JSON schemas, Scenario Call Graph table |
| `policies.md` | [templates/policies.md](templates/policies.md) | fixed policy keys consumed by adapters + free invariants |
| `tests.md` | [templates/tests.md](templates/tests.md) | `## T<n> title (S<n>)` Given/When/Then + `json assert` block |

Memory tiers map onto tables as follows. Tier 1 (working) and Tier 2 (episodic) are rows in
`memories` with `task_id` set, plus `episodes` as the query index over `episodes.jsonl`. Tier 3
(structural) is `api_nodes`/`api_edges`, derived from every scenario's `Calls` and `Mutations`
columns by `structuralEdges()` and refreshed by `os.js memory-sync`. Tier 4 (procedural) and Tier 5
(alignment) are `memories` rows with `repo IS NULL` (global) mirrored to JSONL/JSON files in the OS
home. Every memory may carry `memory_files` anchors; `invalidateStale()` flips `valid=0` the moment
an anchored file's hash differs from the current tree, so a memory derived from an old `spec.md`
can never reach a worker.

---

## 3. End-to-end state-machine lifecycle

Graph: [graphs/api-platform.v1.json](../../graphs/api-platform.v1.json). Required gates:
`stack_selection`, `spec_approval`, `domain_check`, `review`, `validation`. Both human gates are
`approval` nodes whose artifact is a decision card, which is what "AWAITING_HUMAN" means at runtime.

```
intake ──ready──▶ stack_selection ──approved──▶ contract_design ──ready──▶ spec_approval ──approved──▶ domain_check
  (supreme-        (AWAITING_HUMAN:              (planner writes             (AWAITING_HUMAN:            │ allowed
   coordinator)     framework card)               docs/api bundles)           spec card per domain)      ▼
                                                                                              swarm_implementation ──completed──▶ review ──passed──▶ validation ──passed──▶ consolidation ──▶ complete
                                                                                              (bus: worktrees +                    (reviewer)         (validator +           (memory-curator:
                                                                                               signed evidence)                                        Apidog CLI gate)       sleep cycle)
```

Trace for "Build the orders + billing backend (≈400 endpoints), team is TypeScript-first":

1. **Raw intent → `intake`.** The coordinator writes `brief.md`, derives an intent profile
   (`{needs:{typeSafety:.9,asyncIo:.6,enterprise:.6}, team:{typescript:.9}, endpoints:400}`) and
   runs `os.js select-stack ROOT TASK intent.json`. The selector loads every adapter manifest,
   scores them per dimension (alignment memory can bias: `data.adapterBias`), and emits a
   schema-valid `framework_selection` card to `tasks/<id>/cards/card-stack-<task>.json`.
   Evidence: `{summary, artifacts:["brief.md","cards/card-stack-<task>.json"]}` → `advance ready`.
2. **Stack Selection Gate (`AWAITING_HUMAN`).** The UI renders the card (`layout: cards`). The
   human picks NestJS, overriding the FastAPI recommendation with a rationale. The shell appends a
   `decision_card_answer` delta (`os.js delta`), writes `.engineering/stack.json`, and the host
   advances `approved` with `approval.scope`, `approval.criteriaIds` and the card in `artifacts`
   (the existing structured-approval contract binds the card's hash). `rejected` loops to intake
   with budget 2.
3. **`contract_design`.** The planner compiles bespoke `graphs/<dynamic>.json` (brief 09) or
   keeps `api-platform.v1`, then writes one bundle per endpoint from the templates. For each
   bundle `os.js api-index` regenerates `INDEX.md` (status `draft`, Apidog `unsynced`) and
   `os.js memory-sync` rebuilds structural memory from the scenario tables. Planning evidence
   lists `docs/api/INDEX.md` and every `spec.md` as artifacts.
4. **`spec_approval` (`AWAITING_HUMAN`).** A `spec_approval` card per domain summarizes
   endpoints, impacted shared models (from `store.impacted()`), and policy exceptions. Any manual
   edit of a `spec.md` in the UI is captured as a `spec_edit` delta with exact before/after. On
   `approved`, the hashes of every listed spec are bound; editing one later forces a replan
   (existing `verifyApproval` behaviour).
5. **`domain_check`.** Unchanged: product-map/domain assessment; `question` → `clarification`
   card → back to contract design.
6. **`swarm_implementation` (worker role, executed by the bus).** The host builds a swarm plan:
   one unit per endpoint (or per independent DAG node), `endpointId` set, `verifiers` taken from
   the adapter manifest (`tests`, `typecheck`, `call-graph`, `openapi-diff`, `query-count`),
   `integrationVerifiers` = full test suite + `openapi-diff` for the whole document.
   `os.js swarm ROOT TASK_DIR plan.json --serve 7331` then, per unit and under the concurrency
   limit: creates `swarm/<task>/<unit>` branch + worktree from the base SHA; compiles the
   `<4k` context (`context.md`: objective, INDEX rows, condensed spec/policies/tests, alignment
   rules, adapter-filtered blueprints, impacted endpoints, past failures); spawns
   `claude --print --permission-mode acceptEdits … "<context + brief>"` in the worktree; commits
   the worker's output; runs every verifier capturing hashed logs; signs `evidence.json`
   (Ed25519) with base/head SHAs, changed files, verifier results and `passed`. Units that pass
   merge `--no-ff` into `swarm/<task>/integration` in plan order; conflicts are recorded, never
   forced. Integration verifiers run on the merged tree; `swarm-report.json` is signed. The worker
   transition evidence then lists `swarm/swarm-report.json` in `artifacts`, `codeFiles` = union of
   changed files, and the sandbox/contract records required by V7 (brief 05 maps them).
7. **`review`.** The reviewer reads the evidence matrix layout (`evidence-matrix` + `diff`
   regions sourced from `swarm/*/evidence.json`). Rejections are captured as `review_rejection`
   deltas with a reusable `rule` sentence; `changes_required` re-dispatches only failed units.
8. **`validation` (deterministic + Apidog CLI).** `os.js api-export` compiles OpenAPI 3.1 +
   collection; `os.js api-push ROOT PROJECT_ID` imports it into Apidog (overwrite behaviour,
   `X-Apidog-Api-Version: 2024-03-28`); the adapter's `serve` starts the service in the sandbox;
   `os.js api-verify ROOT .engineering/tasks/<id>/apidog/run-1 -t <scenarioId> -e <envId>` runs
   `apidog run … -r cli,json` and maps every `<endpointId>::<testId>` item back onto the
   `tests.md` matrix; `INDEX.md` flips to `verified` / `synced <time>` only for fully passing
   endpoints. Each criterion in the validation evidence references a `check-run` of these
   commands, so the existing runner binds them to the task revision and the project snapshot.
9. **`consolidation` (sleep cycle).** `os.js consolidate ROOT --swarm tasks/<id>/swarm/swarm-report.json`:
   card answers → `docs/adr/ADR-NNNN-*.md` + episodic memory; spec/plan edits → episodic diffs;
   review rules recurring across ≥3 tasks → `policies/learned.json` + alignment memory (candidates
   below the threshold are reinforced, not promoted); merged units → procedural blueprints under
   `~/.engineering-os/procedural/blueprints/<adapter>/`; stale memories invalidated by hash. The
   run is idempotent and logged to `.engineering/consolidations/<runId>.json`.
10. **`complete`.** The task is immutable; the next task's workers start with richer procedural
    and alignment tiers, which is the mechanism that keeps endpoint 950 as fast as endpoint 1.

Failure routes: a failed unit fails the swarm (`validation failed` → `swarm_implementation`
re-dispatches failed units only); a changed approved spec blocks implementation until replanned;
`blocked` terminals require a superseding task, as today.

---

## 4. Kernel code

All modules are ES modules on Node 22 built-ins only (`node:sqlite`, `node:fs`, `node:path`,
`node:child_process`, `node:crypto`, `node:http`, `node:events`, `node:os`). Behaviour is
documented in each file header; tests are the executable specification:

| Module | Test |
|---|---|
| `src/memory/store.js`, `src/memory/compiler.js` | `tests/meta-os-memory.test.js` |
| `src/daemon/bus.js` | `tests/meta-os-bus.test.js` (real git worktrees, fake worker, signature tamper check, SSE/layout) |
| `src/exporters/apidog-sync.js`, `src/contracts/spec.js` | `tests/meta-os-apidog.test.js` (OpenAPI/collection compile, report mapping, push with injected fetch, CLI run with a stub binary) |
| `src/memory/consolidate.js` | `tests/meta-os-consolidate.test.js` (ADR, promotion threshold, idempotency, blueprints) |
| `src/schema/validate.js`, `src/intent/selector.js`, schemas, adapter manifests | `tests/meta-os-schema.test.js` |

Run: `npm run check` (135 tests + graph validation). `node --no-warnings` silences the one
`node:sqlite` ExperimentalWarning Node 22 still prints.

Worker command template (`plan.worker.argv`, default
`["claude","--print","--permission-mode","acceptEdits","--output-format","json","{briefText}"]`)
supports `{briefText}`, `{brief}`, `{context}`, `{worktree}`, `{unit}`, `{taskDir}`, `{root}`,
`{endpointId}`; verifiers get the same substitutions. Workers receive
`ENGINEERING_OS_UNIT|WORKTREE|BRIEF|CONTEXT|TASK_DIR` in their environment plus an allowlist.

---

## 5. Reference adapters

See [adapters/README.md](adapters/README.md) for the FastAPI and NestJS manifests and the worked
compilation of the `orders.create` bundle into both frameworks.

## 6. Phased execution plan

See [briefs/README.md](briefs/README.md). Each brief is a self-contained `engineering-workflow`
task with scope, acceptance criteria and `check-run` specs.
