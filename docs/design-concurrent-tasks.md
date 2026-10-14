# Design: Concurrent Independent Tasks (Finer-Grained Product-Map Locking)

Status: Design proposal (no code changes). Target plugin version: 0.10.0 → 0.11.0.
Scope decided in advance (do not reopen): concurrent **independent tasks in the same project**; finer-grained product-map locking; backward-compatible and opt-in; preserve every current guarantee. Multi-worker-within-a-task, per-worker git branches, and merge/integration gating are **out of scope** (future work).

---

## 1. Summary answer (read this first)

Today, every product-map mutation and every product-map read that happens during task advancement serializes on a **single exclusive file lock** at `<root>/.product-map.lock` (`locked()` in `src/product.js`, opened `'wx'`). Two independent tasks in the same project that both touch the product map therefore block each other hard, and a long write (e.g. `prepareProduct`, `releaseFeature`) stalls unrelated tasks that only need to *read* the map during review/validation.

The brief asks whether per-feature locking is feasible. **It is not the right primary approach, and the reason is structural, not incidental.** Every mutating function in `src/product.js` rewrites the shared registry `PRODUCT.json` and regenerates the shared indexes `PRODUCT.md` (and `FEATURES.md` for schema 2) via `writeIndexes()`. `addFeature`, `syncFeature`, `prepareProduct`, `releaseFeature`, `migrateProduct`, and `initProduct` all call `atomic(join(root,'PRODUCT.json'), ...)` and/or `writeIndexes(...)`. Because `index(model)` is computed from the **entire** feature set (`loadProduct` builds the full `features` Map and `index()` iterates `model.features.values()`), any single-feature write still needs a consistent read of all features and an exclusive write of the shared index files. Per-feature locks cannot make two writers to disjoint features safe, because both writers contend on `PRODUCT.json` and `PRODUCT.md` anyway. True per-feature *parallel writes* would require splitting the registry and the generated index per feature — a breaking on-disk format change, explicitly disallowed.

**Recommended primary approach: a shared/exclusive (reader/writer) lock split.** Allow many concurrent *readers* (`loadProduct`, `checkProduct`, `checkProductPrepared`, `featureContext`, `checkFeatureSync`) to proceed in parallel, and keep writes *exclusive* and serialized exactly as today. This directly removes the dominant real-world contention: unrelated tasks advancing through review/validation (which only read the map) no longer block on each other or on a running writer's read phase, and only genuinely conflicting *writes* serialize. Writes remain single-writer, so the undo journal, `recoverProduct`, atomic rename, and index consistency are preserved **unchanged**. This is the smallest change that delivers real concurrency benefit and is the recommended first implementation slice (§7).

The whole design is gated behind an **opt-in product-map metadata field** (`concurrency: "rw"`), absent by default. When absent, `locked()` behaves byte-for-byte as it does today (single exclusive lock), so existing maps, the 7 shipped graphs, and all existing tasks are unaffected.

---

## 2. Current-state analysis (evidence)

### 2.1 How `locked()` works today (`src/product.js`)

```
async function locked(root,fn){
  const path=join(root,'.product-map.lock');let handle;
  try{handle=await open(path,'wx');}catch(e){if(e.code==='EEXIST')throw Error('Product map is locked; ...');throw e;}
  const transaction={path:join(root,'.product-map.journal'),entries:[]};
  let release=true;
  try {
    await handle.writeFile(json({pid:process.pid,host:hostname(),time:...}));await handle.sync();
    const result=await transactions.run(transaction,fn);
    await unlink(transaction.path)...;                      // success: drop journal
    return result;
  } catch(e) {
    try { await rollback(root,transaction.entries); }       // failure: undo
    catch(rollbackError){release=false;throw new Error('Product rollback failed; use product-recover ...')}
    await unlink(transaction.path)...;
    throw e;
  } finally {await handle.close();if(release)await unlink(path);}  // drop lock unless rollback failed
}
```

Key facts:
- The lock is a **single file** `<root>/.product-map.lock`, created with `open(path,'wx')` (exclusive create). It is a pure mutual-exclusion primitive; there is no shared/read mode. It carries `{pid, host, time}`.
- The write-ahead undo journal lives at `<root>/.product-map.journal`. `journalPath()` records a `{path, previous, directory, mode?, link?}` entry (base64 previous contents, permission mode, or symlink target) **before** the first mutation of each path, writing the journal atomically (tmp + rename) via an `AsyncLocalStorage` transaction store (`transactions`).
- `atomic(path,value)` calls `journalPath(path)` then writes tmp + `rename` (preserving file mode). `rollback()` replays entries in reverse, restoring previous content/mode/symlink, deleting created files (`previous===null`), and `rm -rf`-ing created directories.
- On success the journal is unlinked; on failure `rollback` runs and the journal is unlinked; **if rollback itself fails, `release=false`** so the lock and journal are intentionally left behind for `recoverProduct`.

### 2.2 How `recoverProduct(root)` works today (`src/product.js`)

- Takes a separate recovery mutex `<root>/.product-map.recover` (`open 'wx'`), preventing two recoveries racing.
- Reads `.product-map.lock`, parses `{pid,host}`; refuses if host differs or metadata is incomplete (`Cannot establish local product lock ownership` / `Incomplete product lock`).
- `process.kill(owner.pid,0)` — if the writer is alive, **refuses** (`Writer is still active`); only an `ESRCH` (dead) writer proceeds.
- Validates the **entire** undo journal before touching anything: each entry must have an absolute in-project path, unique, boolean `directory`, valid base64 `previous`, valid `mode`/`link` shapes.
- Backs up the journal to `.product-map.backup.<uuid>.json`, re-checks the lock inode and raw bytes are unchanged (`Lock changed during recovery`), then `rollback()`s, unlinks the journal and the lock.

> architecture.md states the contract verbatim (paraphrased for compliance): a failed operation rolls back; if rollback fails, its lock and journal remain for recovery; `product-recover ROOT` refuses a live or foreign-host writer, backs up the journal, restores previous files, then releases a dead writer's lock; the journal is replaced atomically; full power-loss durability across all files is not guaranteed. *(Content rephrased for licensing compliance.)*

### 2.3 Every call site that acquires `.product-map.lock` (i.e. calls `locked()`)

All in `src/product.js`:

| Function | Line (approx) | Shared files it writes |
| --- | --- | --- |
| `initProduct` | `return locked(root,...)` ~179 | creates `PRODUCT.json`, `PRODUCT.md`, `FEATURES.md`, policy/architecture/template docs |
| `migrateProduct` | ~195 | rewrites every `feature.json`, `PRODUCT.json`, then `writeIndexes` |
| `addFeature` | ~236 | creates `features/<id>/*`, pushes to `PRODUCT.json`, `writeIndexes` |
| `syncProduct` | ~253 | `writeIndexes` only (regenerate `PRODUCT.md`/`FEATURES.md`) |
| `syncFeature` | ~285 | writes `features/<id>/synchronization.json` (per-feature; **no index/registry write**) |
| `prepareProduct` | ~298 | rewrites `PRODUCT.json` preparation block, `writeIndexes` |
| `releaseFeature` | ~329 | writes `features/<id>/history.json`, `writeIndexes` |

**Pure readers (never call `locked()`):** `loadProduct`, `checkProduct`, `checkProductPrepared`, `featureContext`, `checkFeatureSync`. These read `PRODUCT.json`, every `feature.json`, docs, and `history.json` **with no lock at all today.** This is important for §4 and §5: readers already run concurrently with each other and with a writer *without any coordination*; they rely solely on `atomic()`'s tmp+rename to never observe a half-written single file.

Observation worth flagging: `syncFeature` is the one mutation that writes only a per-feature file (`synchronization.json`) and does **not** touch `PRODUCT.json` or the indexes. It is the single realistic candidate for genuine per-feature write parallelism — but see §3.3 for why it is not worth special-casing in the first slice.

### 2.4 Every `state.js` path that reads the product map during task advancement

All inside `checkEvidence()` / `advance()` in `src/state.js`, gated by graph flags:

1. **Worker completion** (`role==='worker' && outcome==='completed'`, when `t.graph.productMap`), ~line 269:
   ```
   await checkProduct(t.root);const model=await loadProduct(t.root);
   ```
   Reads the full map twice to validate `featureIds` and compute `mapped` paths.
2. **Review/validate passing** (`['reviewer','validator'].includes(role) && outcome==='passed'`, when `t.graph.productMap`), ~line 290:
   ```
   if(t.graph.productMap&&['reviewer','validator'].includes(role)&&outcome==='passed')await checkProduct(t.root);
   ```
3. **Entering a worker** (`advance()`, when `t.graph.productPreparation`), ~line 310:
   ```
   if(t.graph.productPreparation&&t.graph.nodes[edge.to].role==='worker'&&(!t.code||...))await checkProductPrepared(t.root);
   ```

All three are **reads** (`checkProduct`→`loadProduct`+index compare; `checkProductPrepared`→`loadProduct`+snapshot compare). They acquire no product-map lock today. They are the paths the brief refers to as "reads the product map while another task may hold the lock for a write."

### 2.5 Which operations actually conflict vs. are independent

- **Reader vs reader** (two tasks both advancing review/validation): independent today (no locks), must stay independent. ✅ already fine; the RW design keeps it so under the shared lock.
- **Reader vs writer** (task A reviewing while task B runs `addFeature`/`prepareProduct`): today the reader takes no lock and can observe the map *mid-write* across multiple files. `atomic()` guarantees each *single* file is never half-written, but a multi-file write (e.g. `addFeature` writes `PRODUCT.json` then `writeIndexes`) is **not atomic across files** — a concurrent reader can see new `PRODUCT.json` with stale `PRODUCT.md`. `checkProduct` would then throw `PRODUCT.md is stale` spuriously. **This is a pre-existing latent hazard** (see §5.3); the RW design is the opportunity to fix it.
- **Writer vs writer**: fully serialized today and must remain serialized because they all rewrite `PRODUCT.json`/indexes. The only disjoint-write candidate is `syncFeature` (§2.3).

---

## 3. Core hazard analysis & recommendation

### 3.1 The shared-registry coupling (the decisive constraint)

`PRODUCT.json` is one file registering all features; `PRODUCT.md`/`FEATURES.md` are single generated indexes built from the full model:

- `index(model)` iterates `model.features.values()` — it needs **every** feature to render a correct table.
- `writeIndexes(model)` writes `PRODUCT.md` and (schema 2) `FEATURES.md` from that full model.
- `loadProduct` reads and cross-validates the whole registry (feature dependency acyclicity via `acyclic(...)`, cross-feature component dependency rules).

Therefore any write that adds/removes/retitles a feature, or changes status/version, must update the shared index — which depends on all features. **Per-feature locking cannot prevent two feature-writers from contending on `PRODUCT.json` and `PRODUCT.md`.** The brief's hypothesis is correct to be skeptical: per-feature parallel *writes* are not achievable without splitting the registry/index on disk, which is a breaking format change and is out of scope.

### 3.2 Recommendation: shared/exclusive (reader/writer) lock

The realistic and high-value win is **many concurrent readers, single exclusive writer**:

- `loadProduct`, `checkProduct`, `checkProductPrepared`, `featureContext`, `checkFeatureSync` acquire a **shared** lock.
- All mutating functions acquire an **exclusive** lock (unchanged single-writer semantics).

Why this is the right call:
- It removes the dominant contention identified in §2.4 — unrelated tasks advancing review/validation read concurrently and are never blocked by each other.
- A writer still excludes all readers, so a reader can **never** observe a half-applied multi-file index update (this also *closes the pre-existing hazard in §2.5/§5.3*, because today readers take no lock at all).
- Writers remain fully serialized, so the undo journal, `recoverProduct`, atomic rename, and `index()` consistency are preserved **verbatim** — no change to the hardest-to-get-right code.

### 3.3 Why not special-case `syncFeature` for per-feature parallel writes (yet)

`syncFeature` is the only mutation that writes a single per-feature file. In principle two `syncFeature` calls on disjoint features could run in parallel. But: (a) it is a narrow case, (b) it still *reads* the whole model via `loadProduct` and computes `featurePaths` across upstream dependencies, and (c) adding a second lock tier multiplies the failure/recovery matrix. Recommendation: **defer**. Note it as future work; the RW split already lets `syncFeature`'s read phase run concurrently with other readers. Promote it only if measurement shows `syncFeature` write contention is real.

---

## 4. Proposed design

### 4.1 Locking model

Introduce a shared/exclusive lock **implemented on top of the existing exclusive lock file**, so the current recovery contract is reused as-is.

- **Opt-in gate:** a product-map metadata field `product.concurrency` with value `"rw"`. Absent (or any non-`"rw"` value under old maps) ⇒ **legacy single-exclusive behavior, byte-identical to today.**
- **Writers (`concurrency==="rw"`):** unchanged. Acquire the exclusive lock `<root>/.product-map.lock` with `open 'wx'` exactly as `locked()` does now, including the journal and rollback. A writer's exclusive create fails (`EEXIST`) if **any** lock holder — reader or writer — is present (see 4.3), so writers still fully exclude everyone.
- **Readers (`concurrency==="rw"`):** acquire a **shared** lock via a reader-count mechanism that still blocks writers.

### 4.2 On-disk lock representation (additive only)

Keep the existing exclusive write lock file name and semantics. Add a **separate, additive** shared-lock representation so nothing about the existing file changes:

- **Reader registry directory:** `<root>/.product-map.readers/` containing one file per live reader, named `<uuid>` with contents `{pid, host, acquiredAt}`.
- A **reader** acquires as follows (classic "write-lock to mutate the reader set" pattern):
  1. Briefly take the exclusive `.product-map.lock` (`open 'wx'`, same as a writer) — this proves no writer is active.
  2. While holding it, create its own reader file `<root>/.product-map.readers/<uuid>` (`open 'wx'`).
  3. Release `.product-map.lock` immediately (close + unlink). The reader file remains, marking an active reader.
  4. Run `fn` (the read).
  5. On completion, unlink its reader file.
- A **writer** acquires as follows:
  1. Take the exclusive `.product-map.lock` (`open 'wx'`).
  2. **Check the reader registry is empty.** If any live reader file exists, the writer releases the lock, waits (bounded backoff), and retries; after a bounded number of attempts it throws `Product map has active readers; retry` (surfaced to the caller like today's lock-contention error).
  3. Proceed with the journal + mutations exactly as today, holding `.product-map.lock` for the whole operation (which is what keeps new readers out — step (1) of a reader also needs `.product-map.lock`).

This gives: readers exclude writers (a writer can't pass step 2 while a reader file exists), writers exclude readers (a new reader can't create its file without `.product-map.lock`, which the writer holds), and readers do **not** exclude each other (reader files are independent). The existing exclusive-lock file, journal, and `recoverProduct` are untouched for writes.

Additive guarantee: old maps have no `.product-map.readers/` and no `concurrency` field; `locked()` in legacy mode never creates the directory. New fields/dirs are strictly additive; no existing file's format changes.

### 4.3 How reads and writes coordinate (summary table)

| | Reader present | Writer present |
| --- | --- | --- |
| New reader | allowed (independent reader file) | blocked (writer holds `.product-map.lock`) |
| New writer | blocked (reader registry non-empty) | blocked (exclusive `.product-map.lock`) |

### 4.4 How the undo journal and `recoverProduct` adapt

- **Writers:** no change at all. Same journal, same `rollback`, same `release=false` on rollback failure. `recoverProduct` for a dead writer is unchanged.
- **Readers:** readers never write product files and never create a journal, so **they need no undo journal**. A reader that dies leaves only a stale reader file (see §5).
- **`recoverProduct` extension (additive):** add reaping of **dead reader files**. For each file in `.product-map.readers/`, parse `{pid,host}`; if host matches and `process.kill(pid,0)` throws `ESRCH`, the reader is dead and its file may be removed. A live or foreign-host reader file blocks reaping and is reported for manual inspection (mirroring the existing writer policy). This extension is **purely additive** to the current `recoverProduct` contract: the writer-lock recovery path is unchanged; reader reaping is new behavior that only runs when the directory exists.

### 4.5 How index generation stays atomic and consistent under concurrency

- Each individual file write stays `atomic()` (tmp + rename), unchanged.
- Multi-file index updates (`PRODUCT.json` + `PRODUCT.md` + `FEATURES.md`) occur **only inside an exclusive writer**, which now **excludes all readers** (unlike today, where readers took no lock). Therefore no reader can observe the window between the `PRODUCT.json` write and the `writeIndexes` write. This both preserves the "indexes never observed half-written or stale relative to `PRODUCT.json`" guarantee and **fixes the pre-existing hazard** where an unlocked reader could catch a mid-write state (§2.5).
- `checkProduct`'s staleness assertions (`PRODUCT.md is stale` / `Feature list is stale`) now run under a shared lock, so they compare against a quiescent, fully-written map.

### 4.6 Opt-in surface: why a product-map metadata field

Three candidate surfaces were considered:

1. **Graph boolean flag** (like `productMap`/`evidenceMode` in `graph.js`). Rejected as the *primary* gate: the product map is a project-level shared resource; two concurrent tasks might run under different graphs (e.g. a v3 and a v7). Concurrency safety must be a property of the *map*, agreed by all participants, not of one task's graph. A per-graph flag can't guarantee that every concurrent writer honors RW discipline.
2. **Env/CLI flag.** Rejected as primary: it is per-process and ephemeral; one process could opt in while another doesn't, breaking the invariant that all accessors agree on the locking protocol.
3. **Product-map metadata field `product.concurrency: "rw"`** (recommended). It lives in `PRODUCT.json`, is read by `loadProduct` at the start of every operation, and is therefore seen identically by **every** process touching that map. Enabling it is a one-time, explicit, source-controlled decision. Legacy maps simply lack it. This is the only surface that makes the protocol a property of the shared resource.

`validateGraph` is unaffected; no new graph flag is required. (A convenience CLI command `product-concurrency ROW on|off` that flips the field via a normal exclusive `locked()` write can be added, but the source of truth is the metadata field.)

---

## 5. Backward-compatibility & migration

- **Flag off (default / all existing maps):** `product.concurrency` is absent. `loadProduct` validates the registry as today (`[1,2].includes(product.schemaVersion)` — the new field is ignored because it is not in the validated set and JSON tolerates extra keys). Every mutation and read takes the single exclusive `.product-map.lock` exactly as now; `.product-map.readers/` is never created. **Behavior is byte-identical to 0.10.0.** The 7 shipped graphs (`product-build.v1..v7`) do not reference concurrency and are unaffected; task schemas v1/v2/v3 are unaffected (the change is entirely inside `product.js` locking, which `state.js` calls through unchanged function signatures).
- **Enabling the flag:** a one-time write (through the normal exclusive path) sets `product.concurrency="rw"`. No feature files change, no index format changes. Downgrading (removing the field) returns to legacy behavior with no data migration.
- **Running tasks during enablement:** because enabling is itself an exclusive write, it cannot interleave with another writer. A reader that started under legacy mode and a writer that enabled RW cannot overlap destructively, because legacy readers also went through... — **caveat:** legacy readers take *no* lock. See §6 open question Q1: enabling RW must be done when no legacy readers are mid-flight, or the first-enable write must be treated like any other exclusive write (it is) and the brief's "additive, no running task affected" guarantee holds for the *steady state*, with the enable transition being a normal exclusive operation.
- **No on-disk format break:** proven by (a) `PRODUCT.json`/`feature.json`/index file formats are untouched, (b) the new field is an optional extra key, (c) the reader directory is new and only exists in RW mode.

---

## 6. Failure modes & recovery

| Hazard | Handling |
| --- | --- |
| **Lock starvation (writer starved by readers)** | Readers hold `.product-map.lock` only *briefly* (to register), not for their whole read; the actual read holds only a reader file. A writer waits for the reader *set* to drain. Mitigation: bounded retry with backoff and a `Product map has active readers; retry` error (same UX as today's `Product map is locked`). Open question Q2: optional writer-intent flag to stop admitting new readers once a writer is waiting (anti-starvation); deferred unless measured. |
| **Reader starved by writers** | Writers are short and serialized; a reader simply retries the brief `.product-map.lock` acquisition. Same backoff policy. |
| **Writer dies mid-rollback** | Unchanged from today: `release=false` leaves lock + journal; `recoverProduct` validates and replays the journal for the dead writer. No reader can be mid-observation of the half-applied state because RW writers exclude readers. |
| **Reader observing a half-applied multi-file index update** | Eliminated: multi-file writes run under the exclusive writer which now excludes readers (§4.5). This is strictly better than 0.10.0, where unlocked readers could observe it. |
| **Reader process dies, leaves a stale reader file** | A dead reader file would block all writers forever. `recoverProduct` is extended (§4.4) to reap reader files whose `pid` is dead on the local host (`ESRCH`). A live/foreign reader file blocks reaping and is reported for manual inspection, mirroring the writer policy. |
| **Recovery racing a live reader** | `recoverProduct` already takes the `.product-map.recover` mutex (serializes recoveries). Before reaping a reader file it must re-check liveness (`process.kill(pid,0)`), and only remove `ESRCH` files; a reader that registers after the liveness check holds `.product-map.lock` at registration time — recovery of the *writer* lock already refuses while that is held/changing (`Lock changed during recovery`). Reader-file reaping is idempotent (unlinking an already-gone file is tolerated). |
| **TOCTOU: writer checks "no readers", a reader registers immediately after** | The reader's registration requires `open('.product-map.lock','wx')`, which fails while the writer holds the exclusive lock. So between the writer's empty-registry check and its mutations the lock is continuously held — no new reader can appear. The check-then-hold ordering (writer holds lock across both the check and the whole mutation) closes the window. |

---

## 7. Recommended first implementation slice

**Slice 1 — Reader/writer lock split, opt-in via `product.concurrency: "rw"`, writers unchanged.**

Smallest safe change delivering real benefit: introduce the shared-lock path for the five pure readers and gate it on the metadata field; leave every writer, the journal, and `recoverProduct`'s writer path exactly as-is; add only dead-reader reaping to `recoverProduct`. This alone removes the §2.4 review/validation contention and closes the §2.5/§5 reader-sees-half-write hazard, with the lowest risk because the hardest code (journal/rollback/recovery for writes) is untouched. Defer `syncFeature` per-feature parallelism (§3.3) and the writer-intent anti-starvation flag (Q2).

---

## 8. Phased implementation plan (each phase independently testable)

- **Phase 0 — Introduce the opt-in field (no behavior change).** Add optional `product.concurrency` acceptance to `loadProduct` validation (accept absent or `"rw"`). `locked()` reads it; when not `"rw"`, behave exactly as today. *Test:* existing suite passes unchanged; a map with `concurrency:"rw"` still works via the legacy path (field present but new code not yet wired).
- **Phase 1 — Shared-lock reader path + exclusive-writer reader-set check.** Implement `.product-map.readers/` registration for readers and the empty-registry check + bounded retry for writers, both gated on `concurrency==="rw"`. Route `loadProduct`/`checkProduct`/`checkProductPrepared`/`featureContext`/`checkFeatureSync` through the shared path. *Test:* reader/reader concurrency; reader/writer mutual exclusion; writer/writer serialization.
- **Phase 2 — Extend `recoverProduct` to reap dead reader files.** Additive; writer recovery untouched. *Test:* dead-reader reaping; live/foreign reader file refused; recovery under the `.product-map.recover` mutex.
- **Phase 3 — Docs + optional CLI toggle.** Update `docs/architecture.md`, `docs/product-map.md`, `docs/roadmap.md` ("parallel workers … future work" note), `CHANGELOG.md` (0.11.0), bump `package.json` to 0.11.0. Optional `product-concurrency` CLI command.

### 8.1 Test scenarios required (Node's built-in `node --test`, per `package.json`)

Follow the existing fixture style in `tests/product.test.js` / `tests/integrity.test.js` (`mkdtemp` temp roots, `initProduct`, spawn child processes for cross-process lock tests as `integrity.test.js` already does):

1. **reader/reader:** two concurrent `checkProduct`/`loadProduct` on an RW map both succeed with no `EEXIST`.
2. **reader/writer:** a reader in flight blocks a concurrent `addFeature` until the reader finishes (writer sees `active readers` then succeeds on retry); and a writer in flight blocks a new reader until it finishes.
3. **writer/writer disjoint features:** two `addFeature`/`syncFeature` on different features still serialize (prove no corruption; one may retry).
4. **writer/writer overlapping (same feature):** correct serialization, journal rollback on induced failure leaves the map consistent (extend the existing rollback test in `integrity.test.js`).
5. **recovery under concurrency:** dead reader file reaped by `recoverProduct`; live reader file refused; dead-writer journal still recovered with a live reader present.
6. **backward-compat flag off:** entire existing suite green with no `concurrency` field; a legacy map never creates `.product-map.readers/`.
7. **TOCTOU:** stress loop of interleaved readers/writers asserting no reader ever observes `PRODUCT.md is stale` spuriously (regression guard for §4.5).

---

## 9. Risks, open questions, and decisions needing the user's call

**Genuine design decisions (need user input):**
- **Q1 — Enable-transition semantics.** Legacy readers take no lock. The steady-state RW guarantees are airtight, but the *moment of first enabling* RW on a project that already has legacy readers mid-flight is a normal exclusive write and does not retroactively coordinate those legacy readers. Decision needed: is "enable RW only when the project is quiescent (no running tasks)" an acceptable operational requirement, or must the design add a transitional guard? Recommendation: accept the quiescent-enable requirement; document it.
- **Q2 — Writer-starvation policy.** Do we need a writer-intent flag that stops admitting new readers once a writer is waiting? Adds complexity; only justified if read load is heavy enough to starve writers. Recommendation: defer, revisit with measurement.
- **Q3 — Retry/backoff tuning.** Max attempts, base delay, and whether contention surfaces as a thrown error (today's model) or an internal wait. Recommendation: mirror today's fail-fast error UX with a small bounded retry; make bounds configurable constants.

**Mechanical choices (implementer's discretion, no user call needed):**
- Reader file naming (`<uuid>`) and the exact JSON fields (`{pid,host,acquiredAt}`).
- Backoff curve shape within the agreed bounds.
- Whether to add the optional `product-concurrency` CLI command in Phase 3.

**Risks:**
- Added lock-protocol surface area increases the recovery test matrix (mitigated by Phase 2's dedicated tests and reusing the existing `.product-map.recover` mutex).
- A buggy reader that forgets to unlink its reader file would stall writers — mitigated by `recoverProduct` reaping and by the reader `finally`-unlink discipline (same pattern as `locked()`'s `finally` lock release).
- No multi-user security boundary is added or implied; this preserves architecture.md's "Local files are trusted input; there is no multi-user security boundary" posture. The reader-liveness checks rely on the same trusted-local-host assumption the existing `pid`/`host` lock checks already depend on.

---

## 10. Where the code contradicts or refines the brief

- The brief says per-task locks mean "task.json writes are not the contention point" — confirmed: `state.js` `mutate()`/`acquire()` use per-task `<file>.lock`, independent of the product map. ✅
- The brief lists `checkProduct/loadProduct/checkProductPrepared` as product-map reads during advancement — confirmed at `src/state.js` ~lines 269, 290, 310. ✅
- **Refinement:** the brief frames per-feature locking as one option to "explore." The code shows per-feature *parallel writes* are blocked by the shared `PRODUCT.json`/index coupling (`index()` needs the full feature set), so per-feature locking is **not** viable as a write-parallelism mechanism without a breaking format split. The reader/writer split is the viable primary approach. Stated head-on in §3.
- **New finding not in the brief:** today's readers take **no product-map lock at all**, so a reader can already observe a half-applied multi-file index update (new `PRODUCT.json` vs stale `PRODUCT.md`). The RW design does not merely preserve current guarantees — it **strengthens** this one, because RW readers are excluded during a writer's multi-file update. Flagged in §2.5 and §4.5.

---

### Evidence index (file : symbol)
- `src/product.js` : `locked`, `recoverProduct`, `journalPath`, `atomic`, `rollback`, `index`, `writeIndexes`, `loadProduct`, `initProduct`, `migrateProduct`, `addFeature`, `syncProduct`, `syncFeature`, `prepareProduct`, `releaseFeature`, `checkProduct`, `checkProductPrepared`, `featureContext`, `checkFeatureSync`
- `src/state.js` : `checkEvidence` (worker/review/validate product reads), `advance` (`checkProductPrepared`), `mutate`/`acquire` (per-task lock, for contrast)
- `src/graph.js` : `validateGraph` (existing boolean flags `productMap`, `evidenceMode`, `productPreparation`, `productivityProtocols` — opt-in flag precedent)
- `graphs/product-build.v7.json` : `productMap/productPreparation/productivityProtocols:true`, `evidenceMode:"structured"`
- `docs/architecture.md` : product-mutation journal + `product-recover` contract; "Local files are trusted input; there is no multi-user security boundary"
- `docs/roadmap.md` : "Later: … parallel workers with isolated branches and integration checks" (this work begins addressing the read-contention portion)
- `package.json` : `node --test`, `engines.node >=22`, version `0.10.0`
- `tests/product.test.js`, `tests/integrity.test.js`, `tests/audit-regressions.test.js` : fixture + cross-process lock/recovery test patterns to follow
