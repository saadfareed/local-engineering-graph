# Design: Within-Task Parallel Workers (Sub-Task Fan-Out / Integration Fan-In)

Status: Design proposal (no code changes). Target plugin version: 0.11.0 → 0.12.0.

Scope decided in advance by the user (do NOT reopen — design *within* these):
1. **Model = sub-tasks (1a).** A parent task spawns N child tasks; each child is its own task with its own `.engineering/tasks/<uuid>/` directory, its own worker and its own git branch. A parent integration stage merges/validates them. Reuse per-task machinery. *Not* parallel nodes inside one graph; *not* one task tracking N worker slots.
2. **Git isolation = record branch metadata only (2b).** The plugin MUST NOT drive git (no spawning `git branch`/`worktree`/`merge`). The host performs all git operations; the plugin records which branch each child owns and gates integration on recorded evidence.
3. **Integration gating = per-worker gates + combined integration check (3a).** Each child must pass its own review/validate, AND the parent integration stage must pass a combined check (tests against the merged result) before the parent can reach a successful terminal.
4. **First roadmap slice of "Later: parallel workers with isolated branches and integration checks."** It MUST be backward compatible and OPT-IN: existing single-worker tasks, task schemas v1/v2/v3, and the 7 shipped graphs (`product-build.v1..v7`) are completely unaffected when the feature is not used.

---

## 1. Summary answer (read this first)

The sub-task model (1a) is a near-perfect fit for the existing architecture because **the plugin already has exactly one unit of isolation: the task.** A task owns a directory, an exclusive `<file>.lock`, an immutable embedded graph, strict replay validation, per-task traversal budgets, and (schema 3) a project snapshot. Children are therefore ordinary tasks created with the existing `createTask`, advanced with the existing `advance`, and read back with the existing `readTask` — no new concurrency primitive is required, because children already run concurrently today (each has its own `acquire()` lock in `src/state.js` → `mutate`).

The parent needs only three additive things, each mirroring an existing additive mechanism:

1. **A parent/child linkage field on the task record.** Reuse the exact pattern of the existing `supersedes` link in `createTask` (`src/state.js`): add an optional `parent` pointer on a child and let the parent's integration *evidence* enumerate the child task files. Make the **child-held `parent` pointer plus the integration evidence's declared child list** the authoritative child set; do not add a mutable `children[]` array to the parent task record, because `validateHistory`'s strict replay would have to account for it and it would duplicate state that the integration event already captures immutably.
2. **One additive graph boolean `parallelWorkers`**, validated in `src/graph.js` exactly like `productMap`/`productPreparation`/`engineeringQuality` (additive boolean, default off, requires `evidenceMode:'structured'`), plus one new evidence role `integration-coordinator` with a new structured-evidence contract `integration-coordinator.integrated`. When the flag is off, `validateGraph` is byte-identical to today.
3. **An integration-gate evidence shape** validated in a new `checkEvidence` branch (`src/state.js`), gated on `role==='integration-coordinator' && outcome==='integrated'`, that (a) re-reads each declared child task via `readTask` and asserts it is at a **success terminal** (immutable, because `advance` throws `Task already terminated` on terminal nodes), (b) asserts each child's own `review`/`validation` passed by inspecting the child's replayed event history, (c) runs one **combined integration check** against the merged working tree via the existing `runCheck`/`verifyCheck` from `src/checks.js`, and (d) records branch metadata (branch name, base/head SHAs, merge-target, merge commit) and consistency-checks it, while being explicit that the plugin cannot by itself prove the merge happened — that remains a host responsibility unless a host-provided check command (`git merge-base --is-ancestor`, `git rev-parse`) surfaces it.

This is the smallest change that delivers real parallel-worker value and preserves every current guarantee. The honest trust boundary is identical in spirit to the existing one quoted from `docs/architecture.md`: the runner **verifies recorded claims for internal consistency and re-runs host-provided check commands against the live tree; it does not drive git and cannot establish evidence truth.**

The recommended first implementation slice (§10) is exactly items 1–3 above with branch metadata **recorded and consistency-checked but not git-proven**, and the combined integration check mandatory.

---

## 2. Current-state analysis (evidence)

Every claim below cites `file : symbol` and the specific behavior.

### 2.1 The task is the existing unit of isolation (`src/state.js`)

- `createTask(root,graph,objective,{supersedes})` validates the graph, generates `id=randomUUID()`, makes `<root>/.engineering/tasks/<id>/`, and writes a `schemaVersion:3` record: `{schemaVersion:3,id,objective,root,supersedes,graph,graphHash,node,revision:0,traversals:{},events:[],code:null}`. The embedded `graph` and `graphHash=digest(graph)` pin the graph per task ("later graph edits do not affect running tasks" — `docs/architecture.md`).
- `createTask` already contains the **one existing cross-task link**: `supersedes:supersedes?resolve(supersedes):null`, and `if(supersedes)await readTask(supersedes)` — it *reads and validates* the linked task at creation but stores only an absolute-path pointer. This is the exact pattern the parent/child link should copy (§3.1).
- `mutate(file,expectedRevision,fn)` wraps every write in an exclusive per-task lock via `acquire()` (`open('<file>.lock','wx')`, `EEXIST` ⇒ "Task is locked; use recover"), re-reads under the lock, enforces `t.revision!==expectedRevision ⇒ 'Stale revision'`, and saves atomically (`durableWrite`+`rename`+`syncDirectory`). **Two different task files have two different lock files, so two children never contend** (§5).
- `advance(file,{outcome,evidence,expectedRevision})`: `if(t.graph.nodes[t.node].type==='terminal')throw Error('Task already terminated')`. This is the keystone for child immutability (§5): **once a child reaches any terminal, no further `advance` can mutate it.**

### 2.2 Strict replay validation constrains any new field (`src/state.js` : `validateHistory`)

`readTask` calls `validateHistory(t)`, which replays from `t.graph.start`:
- Each event must satisfy `event.revision===index+1` and `event.node===node`.
- Edge/traversal replay: for every non-cancel event it finds `edge=edges.find(e=>e.from===node&&e.outcome===event.outcome)`, increments `counts[key(edge)]`, rejects `counts>edge.maxTraversals`, advances `node=edge.to`.
- Terminal checks: `if(t.graph.nodes[node].type==='terminal')throw 'Corrupted terminal history'` at the top of each iteration (no event may follow a terminal).
- Final equality: `node!==t.node || t.revision!==t.events.length || traversal-count mismatch ⇒ 'Corrupted task state'`.
- Approval digests: `digest(t.approvedScope??null)` and `digest(t.approvedPlan??null)` must equal the replay-derived values ⇒ `'Corrupted approval state'`/`'Corrupted plan approval state'`.
- Root/ID: schema 3 requires `isAbsolute(t.root)` and string `t.id`.

**Design implication (critical):** `validateHistory` recomputes a fixed set of derived fields and compares them against stored copies. Any **new task field that is NOT recomputed by `validateHistory`** is simply ignored by replay — it does not break the chain. So an optional `parent` pointer (never recomputed, like `supersedes`, which `validateHistory` never touches) is safe. A **mutable `children[]` array would be dangerous** only if we tried to make replay derive/verify it; keeping child enumeration inside the integration *event's evidence* (which replay already treats as opaque per-event data) avoids any `validateHistory` change. See §7 for the byte-identical proof.

### 2.3 How existing additive graph flags are gated (`src/graph.js` : `validateGraph`)

The precedent for an opt-in feature is a top-level additive boolean validated with a `!==undefined && typeof!=='boolean' ⇒ throw` guard, plus a dependency rule:
```
if (g.productMap !== undefined && typeof g.productMap !== 'boolean') throw Error('Invalid product map setting');
if (g.productMap && g.evidenceMode !== 'structured') throw Error('Product map requires structured evidence');
```
`productPreparation`, `engineeringQuality`, `criticalPlanning`, `productivityProtocols` follow the identical shape. **A graph with none of these flags set behaves exactly as a plain structured/text graph** — the flags are read with `??`/truthy checks everywhere.

The structured-evidence **contract set** is also extended additively:
```
const contracts=[['worker','completed'],['reviewer','passed'],['validator','passed'],['user','approved']];
if(g.engineeringQuality)contracts.push(['planner','ready']);
if(g.criticalPlanning)contracts.push(['supreme-coordinator','ready']);
if(g.productPreparation)contracts.push(['domain-coordinator','allowed']);
```
Each contract requires at least one `role.outcome` node that **dominates every successful terminal** (the `while(stack.length)` dominator walk: "Success bypasses evidence contract"). The role whitelist for `type==='agent'` is `['worker','reviewer','validator','planner','supreme-coordinator','domain-coordinator']`. **Adding `integration-coordinator` here is the additive extension needed** (§3.2).

### 2.4 How `checkEvidence` dispatches by role/outcome (`src/state.js` : `checkEvidence`)

`checkEvidence(file,t,outcome,e)` is a sequence of **independent, flag-gated branches**:
- Non-structured mode returns early after a text check.
- Structured mode requires `summary`, nonempty `artifacts[]`, resolves each artifact under task-dir containment (`safeFile`), then sets `e.artifactSnapshot=await artifactSnapshot(...)`.
- Then a cascade of `if(t.graph.<flag> && role===X && outcome===Y)` branches (engineering quality, productivity protocols, product map, approval binding, reviewer/validator snapshot re-checks). Each only fires when its flag + role + outcome match.

**Design implication:** an integration branch gated on `if(t.graph.parallelWorkers && role==='integration-coordinator' && outcome==='integrated')` is a natural, isolated addition that cannot affect any existing path when `parallelWorkers` is false.

The reviewer/validator **snapshot re-check** branch is the exact precedent for the drift problem (§4): on `['reviewer','validator'].includes(role) && outcome==='passed'` it recomputes `snapshots(t.root,Object.keys(t.code))` and `projectSnapshot(t.root,...)` and throws `'Code changed since implementation…'` / `'Code changed in project since implementation…'` if the live tree diverges from the recorded one. Integration re-verification must decide analogously what it re-checks live vs trusts from the child (§4.4).

### 2.5 Check execution to reuse for the combined integration check (`src/checks.js`)

- `runCheck(taskFile,task,spec)`: validates `spec.argv` (nonempty string array, no NULs), resolves `spec.cwd` under project realpath containment (`Check cwd escapes project`), spawns `shell:false` with a small env allowlist, bounds output (`MAX_OUTPUT`, `MAX_LOG_BYTES`), takes a `projectSnapshot` **before and after** and records `projectChangedDuringRun`, writes `checks/<id>.{stdout,stderr,json}` (schemaVersion 4) and returns `{path:'checks/<id>.json',sha256,...report}`.
- `verifyCheck(taskFile,task,ref,currentSnapshot)` → `verifyCheckIntegrity`: validates `ref.path` matches `checks/<uuid>.json`, re-hashes the report (`Check report changed`), asserts `report.taskId===task.id`, `report.taskRevision===revision`, `exitCode===0`, `signal===null`, `!timedOut`, `!outputLimitExceeded`, `!projectChangedDuringRun`, re-hashes both logs, and finally re-compares the current project snapshot against the bound one (`Project changed since check ran`).
- The existing `verifyRecordedChecks(file,t,checks,getSnapshot)` in `src/state.js` already loops `verifyCheck` and asserts `report.argv.join(' ')===check.command`. **The integration check should reuse this exact helper** so the integration evidence's check records are validated identically to productivity-protocol checks.

**Design implication:** the combined integration check is `runCheck` executed by the host against the **merged** working tree, then its `run` reference verified in `checkEvidence` via `verifyCheck`/`verifyRecordedChecks`. `verifyCheck` already binds the check to the *current* `t.root` tree and the task's revision, so a passing integration check proves "this command exited 0 against the parent's project tree, unchanged across the run, at this revision" — exactly the combined gate 3a wants, scoped honestly to what a check command can observe.

### 2.6 CLI surface (`src/cli.js`)

- `start ROOT GRAPH OBJECTIVE [SUPERSEDED_TASK_FILE]` → `createTask(args[0],graph,args[2],{supersedes:args[3]})`. The optional 4th positional is the existing linkage input — the natural slot shape to copy for a parent pointer.
- `advance TASK_FILE OUTCOME REVISION EVIDENCE_OR_@JSON` passes evidence as an inline string or `@file` JSON. The integration evidence (child list + branch metadata + check refs) is a JSON object passed via `@file`, needing **no new verb**.
- `check-run TASK_FILE SPEC_JSON` → `runCheck(args[0], await readTask(args[0]), spec)` — the host runs the integration check through this existing verb against the parent task.

### 2.7 Product-map rw lock already enables concurrent child reads (`src/product.js`)

The v0.11.0 opt-in `product.concurrency:'rw'` (`loadProduct`→`reader()`, `.product-map.readers/`, `recoverProduct` reaping) lets many readers run in parallel while writers stay single. Children that advance through `role==='worker'` product-map reads (`checkProduct`/`loadProduct` in `checkEvidence`) and `checkProductPrepared` (in `advance`) will each take a *shared* read when `rw` is enabled, so **N children reading the map concurrently do not serialize** (`docs/architecture.md`: "many concurrent readers run against a reader-registry while every mutation stays single-writer"). Parallel workers should therefore recommend enabling `concurrency:'rw'` when the parent graph also sets `productMap`.

### 2.8 Where the brief and the code agree / diverge

- **Confirmed:** `supersedes` stores only an absolute path and reads the target at creation (`createTask`). ✅ The symmetric link should copy this.
- **Confirmed:** `advance` throws `Task already terminated` on terminals, so a completed child is immutable. ✅ This is the honest, code-grounded basis for the integration gate (§5).
- **Confirmed:** `runCheck` binds pre/post `projectSnapshot` and `verifyCheck` re-compares the live tree. ✅ The combined check reuses this.
- **Refinement to brief option 2(a) vs 2(b):** the brief offers "new role + contract" (2a) OR "new boolean flag" (2b) as alternatives. The code shows they are **not alternatives but complements**: `validateGraph`'s structured contract list is itself gated by the boolean flags. The minimal correct design is **both** — a boolean `parallelWorkers` that, when set, pushes `['integration-coordinator','integrated']` into the contract list (§3.2). A role with no flag could not be required on the success route; a flag with no role/contract would have nothing to validate.
- **New finding not in the brief:** `validateHistory` never inspects `supersedes`, and would never inspect a new optional `parent` pointer, so the linkage is replay-invisible and cannot corrupt history (§2.2, §7). The brief's worry about "breaking validateHistory's strict replay" is answered by keeping child enumeration in integration *evidence* (opaque to replay) rather than in a replay-derived field.

---

## 3. Recommended design

### 3.1 Task-record linkage — child-held `parent` pointer + integration-evidence child list

**Decision:** add one optional field to the task record, created the same way `supersedes` is:
- On a **child**: `parent` = absolute path to the parent `task.json` (or `null`). Set at `createTask` time: `start ROOT GRAPH OBJECTIVE --parent PARENT_TASK_FILE` (new optional flag; see §3.5). `createTask` does `if(parent)await readTask(parent)` (validate it loads), stores `parent:parent?resolve(parent):null`, nothing else.
- On the **parent**: **no new persistent field.** The authoritative child set is the list declared in the parent's **integration event evidence** (`evidence.children[]`), which replay already stores immutably per event.

**Why child-held + evidence-declared, not a mutable parent `children[]`:**
- `validateHistory` recomputes `node`, `revision`, `traversals`, `approvedScope`, `approvedPlan` and compares them to stored copies. A mutable `children[]` on the parent would be *either* ignored (then it is not authoritative and can drift from reality) *or* replay-verified (then `validateHistory` must change, risking the byte-identical guarantee in §7). Putting the child list in the integration *evidence* object means replay treats it as opaque event data (it already stores arbitrary `evidence` per event and only hashes declared `artifacts`), so **no `validateHistory` change is needed.**
- The child `parent` pointer gives a cheap, replay-invisible back-reference (symmetric to `supersedes`) useful for `status`/tooling, and is validated for *loadability* at creation exactly like `supersedes`.
- Authoritativeness: the integration gate (§4) does not trust a stored list; it reads each declared child file fresh via `readTask` and re-verifies its terminal/history. So the "source of truth" for *whether integration may pass* is the live child task files, enumerated by the integration evidence, cross-checked against each child's `parent===resolve(parentFile)` back-pointer. This is consistent with the plugin's "verify recorded claims" posture.

### 3.2 Parent graph fan-out / fan-in using the existing vocabulary

**Decision:** one additive boolean `parallelWorkers`, one new agent role `integration-coordinator`, one new contract `['integration-coordinator','integrated']`.

`validateGraph` changes (all additive, mirroring §2.3):
```
if (g.parallelWorkers !== undefined && typeof g.parallelWorkers !== 'boolean') throw Error('Invalid parallel workers setting');
if (g.parallelWorkers && g.evidenceMode !== 'structured') throw Error('Parallel workers require structured evidence');
```
In the structured-contract block:
```
if(g.parallelWorkers)contracts.push(['integration-coordinator','integrated']);
```
And add `'integration-coordinator'` to the agent-role whitelist:
```
if(['worker','reviewer','validator','planner','supreme-coordinator','domain-coordinator','integration-coordinator'].includes(n.role)&&n.type!=='agent')throw Error(`Evidence role requires agent node: ${id}`);
```

**Fan-out and fan-in are expressed with ordinary nodes/edges — no new node *type* is required.** Fan-out is a modeling convention: an agent node (role `supreme-coordinator` or a dedicated `integration-coordinator` dispatch node) whose `ready`/dispatch outcome means "the host has created the declared child tasks." Fan-in is the `integration-coordinator` node whose `integrated` outcome carries the integration evidence. The parent's graph is a normal linear graph; the parallelism lives entirely in the *child tasks the host spawns*, not in the parent graph's shape. This is the whole point of model 1a: the parent graph does not need to represent N slots.

**Validating parent graph sketch** (passes the extended `validateGraph`; `integration` dominates the success terminal, so the new contract is satisfied):
```json
{
  "id": "parallel-build",
  "version": 1,
  "start": "dispatch",
  "requiredGates": ["integration"],
  "nodes": {
    "dispatch":    {"type":"agent","role":"supreme-coordinator","outcomes":["ready","blocked"]},
    "integration": {"type":"agent","role":"integration-coordinator","outcomes":["integrated","blocked"]},
    "complete":    {"type":"terminal","role":null,"outcomes":[],"success":true},
    "blocked":     {"type":"terminal","role":null,"outcomes":[]}
  },
  "edges": [
    {"from":"dispatch","outcome":"ready","to":"integration","maxTraversals":3},
    {"from":"dispatch","outcome":"blocked","to":"blocked","maxTraversals":1},
    {"from":"integration","outcome":"integrated","to":"complete","maxTraversals":1},
    {"from":"integration","outcome":"blocked","to":"blocked","maxTraversals":3}
  ],
  "evidenceMode": "structured",
  "parallelWorkers": true
}
```
Notes on why it validates: successful terminal exists; `dispatch` reachable from start, all nodes reach a terminal; `integration` dominates `complete` (the only path to `complete` goes through it) so `requiredGates:["integration"]` and the `integration-coordinator.integrated` contract both pass the dominator walk. The base contracts `worker.completed`/`reviewer.passed`/`validator.passed`/`user.approved` are **not** required here because this parent graph does not itself employ those roles — but note `validateGraph` *always* pushes those four into `contracts` and requires each to dominate the success terminal. **This is a real constraint (see §9 Q1):** the current `validateGraph` unconditionally requires `worker.completed`, `reviewer.passed`, `validator.passed`, `user.approved` contracts on every structured graph. A pure parent graph has none of those roles, so it would currently fail `Required evidence contract missing: worker.completed`. Two honest options:

- **(Recommended) Make the four base contracts conditional on NOT being a parallel-parent**, i.e. when `g.parallelWorkers` the base worker/reviewer/validator contracts move to the *children's* graphs (which are ordinary v2/v3/v7 graphs that already satisfy them), and the parent requires only `integration-coordinator.integrated` (+ `user.approved` if the parent keeps an approval node). This is a small, additive conditional in the contract-building block and is backward compatible because it only changes behavior when `parallelWorkers` is true.
- (Alternative) Keep all base contracts and force every parent graph to also contain worker/reviewer/validator nodes. Rejected: it forces redundant structure into the parent and contradicts model 1a (the parent does not do the work).

The recommended parent graph for the first slice therefore keeps `user.approved` **off** at the parent (approval happens per child) unless a product owner wants a parent-level approval; a slightly richer parent may add a `scope_approval` (role `user`) before `dispatch` and list `user.approved` in contracts — both validate.

### 3.3 Opt-in flag semantics summary

| Flag state | `validateGraph` | `checkEvidence` | child linkage |
| --- | --- | --- | --- |
| `parallelWorkers` absent/false | byte-identical to today | integration branch never fires | `parent` field absent (same as `supersedes` absent) |
| `parallelWorkers` true | adds the `integration-coordinator.integrated` contract and (recommended) relaxes base contracts for the parent | integration branch validates child set + branch metadata + combined check | child tasks carry `parent`; parent integration evidence lists children |

### 3.4 Branch-metadata evidence schema (host-driven git; plugin records + consistency-checks)

Each child's integration-evidence entry records what the host declares about that child's branch, plus the parent merge facts. **Shape (recorded, consistency-checked, NOT git-proven unless a check command surfaces it):**
```json
{
  "summary": "Integrated 3 child workers into main",
  "artifacts": ["integration-report.md"],
  "children": [
    {
      "taskFile": ".engineering/tasks/<child-uuid>/task.json",
      "branch": "feat/worker-a",
      "baseCommit": "<40-hex sha>",
      "headCommit": "<40-hex sha>",
      "mergedInto": "main",
      "mergeCommit": "<40-hex sha>"
    }
  ],
  "integrationChecks": [
    {"command":"node --test tests/", "run": {"path":"checks/<uuid>.json","sha256":"<64-hex>"}}
  ],
  "ancestryChecks": [
    {"command":"git merge-base --is-ancestor <headCommit> HEAD", "run": {"path":"checks/<uuid>.json","sha256":"<64-hex>"}}
  ]
}
```
Validation performed by the plugin (all honest, all code-reuse):
- **Shape/format:** each `children[i].taskFile` resolves inside the project (reuse `safeFile`/containment), each SHA matches `/^[0-9a-f]{7,40}$/`, `branch`/`mergedInto` nonempty strings, `children` distinct by `taskFile`. Distinct non-empty set (mirror `criteriaIds` distinctness checks in `checkEvidence`).
- **Internal consistency:** `baseCommit !== headCommit` is NOT required (a worker may do zero commits), but if `mergeCommit` is present it must differ from `baseCommit`. All children should declare the same `mergedInto` target (one merge target per integration) unless the design later allows staged targets — enforce single target in the first slice.
- **Combined integration check:** `integrationChecks` verified via the existing `verifyRecordedChecks(file,t,e.integrationChecks,getSnapshot)` — each `run` ref must be a passing `runCheck` report bound to the **parent** task's current revision and tree (§2.5). This is the mandatory 3a combined gate.
- **Optional ancestry proof:** `ancestryChecks` are *also* verified via `verifyRecordedChecks`, but their `argv` is a host-provided git command (`git merge-base --is-ancestor <headCommit> HEAD`, exit 0 ⇒ ancestor; or `git rev-parse --verify <branch>`). **If present, they raise verification from "declared" to "a git command observed this ancestry at this revision."** They are optional in the first slice precisely because the plugin must not *drive* git; the host chooses to supply them.

### 3.5 Integration-gate evidence validation (`checkEvidence` new branch)

A new branch, gated so it is inert when the flag is off:
```
if(t.graph.parallelWorkers && role==='integration-coordinator' && outcome==='integrated'){
  // 1. shape: distinct children[], SHA formats, nonempty branch/mergedInto, single mergedInto
  // 2. for each child: const c=await readTask(resolve(dirname(file),child.taskFile));
  //    - assert c.parent===resolve(file)            (back-pointer matches this parent)
  //    - assert c.graph.nodes[c.node].type==='terminal' && c.graph.nodes[c.node].success===true
  //    - assert the child's history contains a reviewer.passed and validator.passed event
  //      (replay already guarantees ordering/consistency; here we scan c.events for
  //       {node role==='reviewer',outcome:'passed'} and {role==='validator',outcome:'passed'})
  // 3. combined check: await verifyRecordedChecks(file,t,e.integrationChecks,getSnapshot);
  // 4. optional: await verifyRecordedChecks(file,t,e.ancestryChecks,getSnapshot);
  // 5. record: t.integration={children:e.children, integratedAt:...} (optional convenience,
  //    NOT replay-derived — stored only, like t.featureIds is stored by the worker branch)
}
```
How this composes with existing machinery:
- `readTask(childFile)` runs the child's **full** `validateHistory`, so a child whose JSON was tampered with throws `Corrupted…` and the integration fails. The parent gets the child's integrity for free.
- The success-terminal assertion uses `c.graph.nodes[c.node].success===true` — the same predicate `validateGraph` uses for "successful terminal required." Because `advance` refuses terminals, a child at a success terminal **cannot change under the parent's feet** (§5).
- The reviewer/validator-passed scan is honest: it does not re-prove review quality (the plugin never could — `architecture.md`: "cannot … prove review quality"); it proves the child *recorded* those passing transitions, which is exactly what per-worker gating (3a item ii) means in this architecture.
- `verifyRecordedChecks` reuse means the combined check is validated identically to a productivity-protocol check, including the `report.argv.join(' ')===check.command` binding and the live-tree re-comparison in `verifyCheck`.

**Note on `t.integration` storage:** like `t.featureIds` (set by the worker branch and never recomputed by `validateHistory`), any convenience field the integration branch stores on `t` must be a plain stored field that replay ignores. Confirm it is NOT added to the set `validateHistory` recomputes (it is not), preserving §7.

---

## 4. The honest trust boundary (host-driven git), consistent with architecture.md

`docs/architecture.md` states the posture (rephrased for licensing compliance — *Content was rephrased for compliance with licensing restrictions*): the CLI stores graph snapshots, revisions and evidence; node handlers are performed by the host, not dispatched by JavaScript; the CLI cannot enforce host command permissions, prove approval authenticity, check arbitrary agent output contracts, or prove review quality — these are host/instruction responsibilities; structured evidence checks artifact existence, approval fields, declared snapshots and validation fields but cannot establish evidence truth; and "local files are trusted input; there is no multi-user security boundary."

Mapping that posture onto parallel workers:

| Claim | Who establishes it | How honest the plugin can be |
| --- | --- | --- |
| "Child task X reached a successful terminal" | **Plugin (verified).** `readTask` + `success===true`. | Strong: replay-validated, immutable at terminal. |
| "Child X's review and validation passed" | **Plugin (verified).** Scan child events for reviewer/validator `passed`. | Strong *for the recorded transitions*; the plugin does not and cannot judge review *quality* (architecture.md). |
| "The merged tree passes the combined test suite" | **Plugin (verified via runCheck/verifyCheck).** | Strong: exit 0, unchanged tree, bound to parent revision. This is the real 3a combined gate. |
| "Child X's branch `feat/worker-a` was actually created / contains the child's commits" | **Host (recorded only), unless an ancestryCheck surfaces it.** | Honest limit: the plugin records the branch name/SHAs and checks their *format/consistency*; it does not run `git` to confirm the branch exists or contains commits. If the host supplies `ancestryChecks` (`git merge-base --is-ancestor`, `git rev-parse`), the plugin verifies that command exited 0 — raising the claim from "declared" to "a git command observed it." |
| "The merge commit actually merged exactly those child heads" | **Host responsibility.** | Honest limit: the plugin cannot prove graph topology of a merge without a host-provided check; even then it trusts the host's git. The recorded `mergeCommit`/`mergedInto` are consistency-checked, not proven. |

**Explicit non-overclaim statement for the doc/README:** *The plugin never spawns git. It records each child's declared branch metadata and verifies (a) the child task reached a success terminal with recorded review/validation passes, and (b) a host-provided combined check command exited successfully against the merged tree, bound to the parent's revision. Branch existence and merge topology are the host's responsibility; the plugin can only strengthen those claims when the host supplies check commands that observe them.* This mirrors architecture.md's existing honesty verbatim in spirit.

---

## 5. Concurrency / race analysis and child immutability-at-terminal

### 5.1 Children already run concurrently (confirmed)

Each child is a separate task file with its own `<file>.lock` (`src/state.js` : `acquire`). `mutate` is the only writer and it is per-file. **Two children never contend on a lock**; they only share the project `root` and (if used) the product map. Product-map reads during child advancement go through `checkProduct`/`loadProduct`/`checkProductPrepared`, which under `concurrency:'rw'` take shared reader locks (`src/product.js` : `reader`), so N children reading the map run in parallel (§2.7). **Recommendation:** when the parent graph sets `productMap`, require/recommend `PRODUCT.json` `concurrency:'rw'` so children do not serialize on map reads.

### 5.2 The parent-vs-child integration race, and how immutability closes it

Hazard: the parent runs its integration gate (reads child files via `readTask`) **while a child is still advancing** → the parent could read a non-terminal or an in-flight child.

Resolution (all from existing mechanisms, no new lock needed):
- The integration branch **requires each child to be at a success terminal** (`c.graph.nodes[c.node].success===true`). A child that is still working is not at a terminal, so integration **fails with a clear error** ("child not at success terminal") rather than integrating partial work. This is the §6 "partial fan-out" handling too.
- A child at a success terminal is **immutable**: `advance` throws `Task already terminated` on terminals (`src/state.js`), so no concurrent writer can move it afterward. The parent therefore reads a stable child. (`cancel` also refuses terminals.)
- The parent does **not** need to take the child's lock. It performs a plain `readTask` of a quiescent, terminal child. If a race means the child reaches terminal *just after* the parent's read, the parent simply re-runs integration (bounded by `maxTraversals` on the `integration` edge); it never observes a half-written child file because child writes are atomic (`durableWrite`+`rename`).
- The parent's own integration write is itself under the parent's `<file>.lock` via `mutate`, so two integration attempts on the parent serialize and the `Stale revision` check applies.

**Honest edge:** between the parent's `readTask(child)` and its `save`, nothing can change a *success-terminal* child (immutable). A child that is **not** terminal could still advance; the gate's terminal requirement is exactly what makes the read-without-lock safe. This is a code-grounded argument, not an assumption: it rests on `advance`'s terminal refusal.

---

## 6. Failure modes & recovery (mapped to existing mechanisms)

| Failure | Handling using existing mechanisms |
| --- | --- |
| **A child fails/cancels (unsuccessful terminal)** | Its node is a terminal with `success!==true`. The integration gate's `success===true` assertion fails ⇒ integration cannot pass. Operator **supersedes just that child** (`createTask({supersedes:childFile})` — the existing retry mechanism) producing a new child task, updates the integration evidence's `children[]` to point at the new child file, and re-runs integration (bounded by the `integration` edge `maxTraversals`). No parent change required beyond new evidence. |
| **Parent crashes mid-integration** | The parent write is under `<file>.lock` via `mutate`; a crash leaves a stale lock. `recover(parentFile)` (`src/state.js`) refuses a live writer, backs up state, removes a dead local writer lock — unchanged, reused. The integration event is only appended on a successful `save`, so a crash before `save` leaves the parent at its pre-integration revision (atomic rename). |
| **A child's branch never merged** | The combined `integrationChecks` run against the parent tree; if the merge did not happen, the tests reflect the unmerged tree. If the host *claims* a merge but did not do it, only an `ancestryCheck` (`git merge-base --is-ancestor`) would catch it — and if absent, this is the explicit host responsibility (§4). Honest: the plugin blocks on the combined check result, not on the merge itself. |
| **Partial fan-out (some children not yet terminal)** | The per-child `success===true` assertion fails for any non-terminal child ⇒ integration blocked until all declared children are at success terminals. The operator either waits or supersedes a stuck child. |
| **A child is tampered with (JSON edited)** | `readTask(childFile)` runs full `validateHistory`; corruption throws `Corrupted…` and integration fails. Free integrity inheritance. |
| **Integration keeps failing** | The `integration` edge `maxTraversals` bounds retries; when exhausted, `advance` throws "Traversal budget exhausted; cancel or supersede task" — operator cancels the parent (to its unsuccessful terminal) or supersedes it. Same budget discipline as every other node. |
| **Child mid-advance when parent reads it** | §5.2: terminal requirement + atomic child writes make the read safe without a child lock. |

---

## 7. Backward-compatibility proof (feature OFF ⇒ byte-identical)

Claim: with `parallelWorkers` absent/false and no `parent` field, `createTask`/`readTask`/`validateHistory`/`advance`/`validateGraph` behave byte-identically to today, and the 89-test suite + 7 graphs are unaffected.

- **`validateGraph`:** the new guards are `if (g.parallelWorkers !== undefined && typeof!=='boolean') throw` and `if (g.parallelWorkers && evidenceMode!=='structured') throw`. For every existing graph, `g.parallelWorkers===undefined`, so both guards are no-ops. The contract-list push `if(g.parallelWorkers)contracts.push(...)` does not execute. The agent-role whitelist gains `'integration-coordinator'`, which only *adds* an allowed role — no existing node uses it, so no existing graph's validation changes. The recommended base-contract relaxation is **also** gated `if(g.parallelWorkers)`, so with the flag off the four base contracts are required exactly as today. ⇒ byte-identical for all 7 shipped graphs.
- **`createTask`:** add an optional `{parent}={}` destructure defaulting to `undefined`; `parent:parent?resolve(parent):null` adds a field only when provided — identical to how `supersedes` already conditionally appears. With no `--parent`, the record is byte-identical to today (no `parent` key; `JSON.stringify` omits `undefined`). *(If strict byte-identity of the stored JSON matters, make `parent` present only when non-null, exactly as the field-presence pattern allows; `supersedes` is always present as `null`, so matching that — always-present `parent:null` — is the safest choice and still ignored by replay.)*
- **`readTask`/`validateHistory`:** `validateHistory` recomputes only `node`,`revision`,`traversals`,`approvedScope`,`approvedPlan` and checks `root`/`id`. It **never reads `supersedes`**, and will never read `parent`. A new optional `parent` field is invisible to replay ⇒ no new reject paths for existing tasks. The integration evidence lives inside an event's `evidence` object, which replay already treats opaquely (it only hashes declared `artifacts`), so even a parent task's integration event does not alter replay.
- **`advance`/`checkEvidence`:** the integration branch is gated `if(t.graph.parallelWorkers && role==='integration-coordinator' && outcome==='integrated')`. For every existing task `t.graph.parallelWorkers` is falsy ⇒ the branch is dead code on the existing path. No existing branch is modified.
- **Task schemas v1/v2/v3:** no `schemaVersion` bump is required — `parent` is additive like `supersedes` (which required no bump when added in schema 2; here we reuse the pattern without a version change). v1/v2 tasks never carry the parallel graph flag.
- **Test suite:** the existing 89 tests construct v2/v7 graphs with no `parallelWorkers` and no `parent`; every code path they exercise is on the flag-off branch above. ⇒ unaffected.

### 7.1 Minimal change surface (for the reviewer)

- `src/graph.js`: 2 new validation lines + 1 conditional contract push + 1 whitelist entry (+ 1 conditional base-contract relaxation).
- `src/state.js`: `createTask` optional `parent`; one new `checkEvidence` branch; `readTask` validates `parent` loadability only at creation (not on every read — keep `readTask` unchanged; validate the pointer in `createTask` like `supersedes`).
- `src/cli.js`: one optional `--parent` positional/flag on `start`.
- No change to `validateHistory`, `mutate`, `acquire`, `save`, `recover`, `runCheck`, `verifyCheck`.

---

## 8. Risks

- **Base-contract requirement on parent graphs (§3.2 Q1).** Without the recommended relaxation, a pure parent graph fails `Required evidence contract missing: worker.completed`. Mitigation: gate the four base contracts to not apply (or apply a parent-specific set) when `parallelWorkers` is true. This is the single most important correctness decision and is additive. Flagged as Q1.
- **Honest overclaim risk on git.** The feature's value depends on operators understanding the plugin does not prove merges. Mitigation: ship the §4 non-overclaim statement in `docs/architecture.md`/README and strongly recommend `ancestryChecks`.
- **Child/parent path portability.** `parent` and `children[].taskFile` store absolute/relative paths; moving a project breaks them (same limitation `supersedes` and project snapshots already have — `docs/workflow.md`: keep the snapshot sidecar with the task). Mitigation: store `children[].taskFile` **relative to the parent task dir** and resolve at integration (`resolve(dirname(parentFile),taskFile)`), matching artifact-path resolution.
- **Product-map write contention among children.** If children *write* the map (e.g. `feature-release`), RW still serializes writers. First slice: children should finish map writes before the parent integrates; recommend children only *read* the map during their worker/review/validate and defer version records to after integration (consistent with `docs/workflow.md`: "Record feature version history after the task completes").
- **Drift between a child's recorded snapshot and the merged parent tree (§4).** A child's `code`/`projectSnapshot` was taken against the child's branch/tree, which differs from the merged parent tree. **What is re-verified vs trusted:** the plugin trusts the child's *own* review/validation (per-worker gate, against the child's tree) and does NOT re-run the child's snapshot comparison against the merged tree (it would spuriously differ). Instead the merged tree is re-verified wholesale by the **combined integration check** against the parent tree. This is the honest division: child-local correctness is the child's gate; merged correctness is the parent's combined check. Documented explicitly so no one assumes the parent re-proves each child's diff.

---

## 9. Open questions (need user decision) vs mechanical choices

**Genuine design decisions (user call):**
- **Q1 — Parent base-contract policy.** Should `parallelWorkers` relax the mandatory `worker.completed`/`reviewer.passed`/`validator.passed` contracts for the *parent* graph (recommended), or must parent graphs still contain those roles? Recommendation: relax for the parent (the children carry them); keep `user.approved` optional via a parent approval node.
- **Q2 — Is the combined integration check always mandatory, or may a graph opt a parent into "children-passed-only" integration?** The user's 3a says combined check required. Recommendation: mandatory (reject integration evidence lacking a passing `integrationChecks` entry), matching 3a literally.
- **Q3 — Do we require `ancestryChecks` (host git proof) in the first slice, or keep them optional?** Recommendation: optional in slice 1 (record + consistency only), strongly recommended in docs; promote to required in a later slice if operators want git-proven integration.
- **Q4 — Should the parent also enforce that each child's graph itself passed its own `requiredGates`?** `readTask` already proves the child reached a *success terminal*, which (by `validateGraph`'s dominator rule) means it passed all its `requiredGates`. So this is **already implied** — confirm we rely on that implication rather than re-encoding it. Recommendation: rely on it; document the inference.

**Mechanical choices (implementer's discretion):**
- Exact field names (`parent` vs `parentTask`), whether `parent` is always-present-`null` or omitted-when-absent (recommend always-present-`null` to match `supersedes`).
- SHA regex breadth (`7..40` hex) and whether to accept short SHAs.
- CLI spelling of the parent flag (`--parent FILE` vs a 5th positional).
- Where `t.integration` convenience data is stored (or whether to store it at all vs recompute from the integration event on `status`).

---

## 10. Recommended first implementation slice

**Slice 1 — Opt-in `parallelWorkers` parent graph flag + child `parent` linkage + an integration gate that (a) requires every declared child task to be at a success terminal with recorded review/validation passes and (b) runs one mandatory combined integration check via `runCheck`, with branch metadata RECORDED and consistency-checked but git operations left to the host.**

**In scope:**
- `src/graph.js`: additive `parallelWorkers` boolean (+ `evidenceMode` dependency), the `integration-coordinator.integrated` contract push, the agent-role whitelist entry, and the Q1 base-contract relaxation for parent graphs.
- `src/state.js`: optional `parent` on `createTask` (copy the `supersedes` pattern); one new `checkEvidence` branch for `integration-coordinator.integrated` that reads each declared child via `readTask`, asserts success-terminal + recorded reviewer/validator passes + matching `child.parent` back-pointer, verifies one mandatory combined check via `verifyRecordedChecks`, and shape/consistency-checks branch metadata (branch name, base/head/merge SHAs, single `mergedInto`).
- `src/cli.js`: `--parent PARENT_TASK_FILE` option on `start`.
- A new example parent graph `graphs/parallel-build.v1.json` (the §3.2 sketch, extended with the base-contract policy chosen in Q1).
- Docs: `docs/architecture.md` trust-boundary paragraph (§4 non-overclaim statement), `docs/workflow.md` fan-out/fan-in usage, `docs/roadmap.md` ("parallel workers … first slice shipped; git-proven ancestry and host-driven dispatch orchestration remain future work"), `CHANGELOG.md`, `package.json` → 0.12.0.

**Out of scope (future work, name them explicitly):**
- The plugin driving git in any way (branch/worktree/merge) — permanently out per decision 2b.
- **Required** `ancestryChecks` / git-proven merge topology (Q3) — optional in slice 1.
- Automatic host dispatch/orchestration of child creation (the host still creates children manually, as node handlers are host-performed — `architecture.md`).
- Parent-held mutable `children[]` registry and any `validateHistory` change (deliberately avoided).
- Per-feature product-map write parallelism among children (defer to the v0.11.0 rw follow-ups already listed in `roadmap.md`).
- Staged/multi-target merges (single `mergedInto` enforced in slice 1).

---

## 11. Phased implementation plan (each phase independently testable with `node --test`)

Follow the fixture style of `tests/product.test.js`, `tests/integrity.test.js`, `tests/acceptance.test.js` (`mkdtemp` roots, `createTask`/`advance` directly or via the CLI, child-process spawns for lock/recovery).

- **Phase 0 — Additive graph flag, no behavior change.** Add `parallelWorkers` validation + the `integration-coordinator` whitelist entry to `validateGraph`; do not yet add the contract push. *Test:* the whole existing 89-test suite is green; a graph with `parallelWorkers:true` but `evidenceMode:'text'` throws `Parallel workers require structured evidence`; a graph with `parallelWorkers:'yes'` throws `Invalid parallel workers setting`; all 7 shipped graphs still `validate`.
- **Phase 1 — Parent contract + example graph.** Add the `if(g.parallelWorkers)contracts.push(['integration-coordinator','integrated'])` push and the Q1 base-contract relaxation; add `graphs/parallel-build.v1.json`. *Test:* `parallel-build.v1.json` passes `validateGraph`; a parent graph whose `integration` node does not dominate the success terminal throws `Success bypasses evidence contract: integration-coordinator.integrated`; with the flag off, base contracts still required (regression: a structured graph missing `worker.completed` still throws).
- **Phase 2 — Child linkage.** Add optional `parent` to `createTask` (+ `--parent` in CLI) copying the `supersedes` pattern (`if(parent)await readTask(parent)`). *Test:* `start` with `--parent` pointing at a valid parent records `parent:<abs>`; pointing at a corrupt/missing parent throws (same as `supersedes`); a child created without `--parent` is byte-identical to a normal task (`parent:null`, replay unaffected).
- **Phase 3 — Integration gate (per-child + combined check).** Add the `checkEvidence` branch. *Test (end-to-end, mirroring `acceptance.test.js`):*
  1. Build a parent on `parallel-build.v1.json`; create two children on `product-build.v2.json` with `--parent`; drive each child to its `complete` success terminal with scripted approval + real criterion `check-run`s (as `acceptance.test.js` already does).
  2. Run a combined `check-run` against the parent root, put its `run` ref in `integrationChecks`, and `advance` the parent `integrated` → reaches `complete`. Assert success.
  3. Negative: a child left at `review` (non-terminal) ⇒ integration throws "child not at success terminal".
  4. Negative: a child cancelled to its unsuccessful terminal ⇒ integration throws (not `success===true`).
  5. Negative: integration evidence with no `integrationChecks` ⇒ throws (combined check mandatory, Q2).
  6. Negative: a child whose `task.json` is edited after terminal ⇒ `readTask` throws `Corrupted…` and integration fails (integrity inheritance).
  7. Negative: `children[].taskFile` whose `parent` back-pointer does not match ⇒ throws.
- **Phase 4 — Branch metadata + optional ancestry checks.** Validate SHA/branch shapes, single `mergedInto`, and (optionally) verify `ancestryChecks` via `verifyRecordedChecks`. *Test:* malformed SHA rejected; mismatched `mergedInto` across children rejected; a passing host-provided `git rev-parse` ancestry check verifies; an `ancestryCheck` whose report `projectChangedDuringRun` is true is rejected by `verifyCheck`.
- **Phase 5 — Concurrency + product-map rw.** Spawn two children advancing concurrently against an `rw` product map; assert no `EEXIST`/serialization and that both reach terminals; then integrate. *Test:* mirror the cross-process concurrency tests in `integrity.test.js`/`tests/product.test.js`.
- **Phase 6 — Docs + version bump.** architecture.md trust boundary, workflow.md fan-out/fan-in, roadmap.md note, CHANGELOG, `package.json` 0.12.0. *Test:* `npm run validate` (scripts/validate.js) green; `npm test` green.

---

## Evidence index (file : symbol)

- `src/state.js` : `createTask` (supersedes link pattern, task-record shape), `readTask`+`validateHistory` (strict replay, which fields are recomputed, `supersedes`/`parent` invisibility), `mutate`/`acquire`/`save`/`recover` (per-task lock, atomic write, dead-writer recovery), `advance` (`Task already terminated` terminal refusal — child immutability), `checkEvidence` (role/outcome branch dispatch, reviewer/validator snapshot re-check as the drift precedent, `verifyRecordedChecks` reuse), `cancel` (unsuccessful terminal), `status`, `projectSnapshot`.
- `src/graph.js` : `validateGraph` (additive boolean flags, structured contract list + dominator walk, agent-role whitelist, required-gate dominance).
- `src/checks.js` : `runCheck` (pre/post `projectSnapshot`, `projectChangedDuringRun`, bounded logs), `verifyCheck`/`verifyCheckIntegrity` (bind to task revision + live-tree re-comparison) — the combined integration check reuse.
- `src/product.js` : `reader`/`locked`/`rwMode` (opt-in `concurrency:'rw'` enabling concurrent child map reads), `recoverProduct` (reader reaping).
- `src/cli.js` : `start`/`advance`/`check-run` (existing surface; `@json` evidence; `[SUPERSEDED_TASK_FILE]` positional as the linkage-input precedent).
- `graphs/product-build.v7.json` : current graph format and flag set; children reuse `product-build.v2..v7`.
- `docs/architecture.md` : "Node handlers are performed by the host, not dispatched automatically by JavaScript"; "The CLI cannot enforce host command permissions, prove approval authenticity … prove review quality. These remain host/instruction responsibilities"; "Local files are trusted input; there is no multi-user security boundary"; schema-2 superseding links; rw product-map lock.
- `docs/workflow.md` : evidence `@json` passing, `check-run` contract, "Record feature version history after the task completes."
- `docs/roadmap.md` : "Later: … parallel workers with isolated branches and integration checks" (this is the first slice); v0.11.0 rw entry.
- `docs/design-concurrent-tasks.md` : opt-in-field + phased-plan structure template; confirms per-task locks are independent of the product map.
- `package.json` : `node --test`, `engines.node >=22`, version `0.11.0` (→ 0.12.0).
- `tests/acceptance.test.js`, `tests/integrity.test.js`, `tests/product.test.js` : fixture + CLI-driven + cross-process patterns the new tests follow.

*Content from `docs/architecture.md` was rephrased in prose sections for compliance with licensing restrictions; direct short quotations are preserved verbatim only where attributed above.*
