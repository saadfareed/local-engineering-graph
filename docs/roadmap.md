# Roadmap

Implemented: local graph validation, pinned task state, revision checks, locking, atomic state writes, bounded edges, role instructions, workflow skill, policies and extension documentation.

Implemented in v0.2: local lock recovery with backups, cancellation, superseding links, structured evidence records, declared code-file snapshot checks, renewed approval on replanning, and retry admission checks.

Next: choose a host and add verified native packaging, host-specific dispatch and preview lifecycle. Add task-schema migration tooling and host-backed approval authentication before unattended execution. Product schema-1 to schema-2 migration now has a dry-run CLI. Schema 3 binds approval scope and criterion sets and snapshots the project file tree.

Later: connector adapters for GitHub, Linear and Jira; parallel workers with isolated branches and integration checks; token accounting when supported. A hosted service is optional if independent background execution becomes necessary.

Acceptance verification: `tests/acceptance.test.js` builds a small in-memory task tracker through the V2 CLI workflow, executes real criterion tests, resumes persisted state in fresh processes, detects an external edit, repairs and completes the task with immutable evidence. It uses synthetic approval and scripted self-review, which are explicitly labelled test data. A live host conversation with real user approval and a fresh chat session remains a separate host integration demo; the automated acceptance test does not claim to certify it.

Implemented in v0.3: root product index, feature scopes and policies, component/test mappings, dependency and impact checks, per-feature version records, and v3 task integration. Future: import-aware dependency discovery, richer criterion-to-test mappings, and full repository revision binding.

Implemented in v0.4: root product scope/domains/architecture and product roadmaps/flows/user guide, generated feature list, planning readiness gate, and per-change feature/downstream synchronization assessments and snapshots. Future: richer flow-to-criterion-to-test tracing and host-executed test attestation.

Implemented in v0.5: justified design/reuse/slice plans, implementation performance assessment and engineering review evidence. Productivity metrics remain host-recorded; automated timing and comparative baselines are future work.

Implemented in v0.6: independent proposal/design assessments, stance/evidence, option pros/cons/risks and lifecycle cost/basis/confidence records. Validating external quotes and recommendation semantics remains host work.

Implemented in v0.9: incremental project-snapshot performance work — an in-process content-hash cache keyed by path+size+mtime plus per-operation snapshot reuse, with byte-identical hashes and all integrity guarantees preserved. Parallel snapshot hashing across workers remains future work (see the Later item above).

Implemented in v0.10: incremental cached historical-verification work — in-process caching of fully-passing check-drift verification keyed by report+log stat (size+mtime) and expected sha256, plus `status()` historical artifact-drift reuse through the v0.9 content-hash cache. Drift-detection outcomes stay byte-identical and every integrity guarantee is preserved; `verifyCheck`'s project comparison still runs every call. Parallel workers across isolated branches remain future work (see the Later item above).

Implemented in v0.11: opt-in concurrent independent tasks through a reader/writer product-map lock, gated on `concurrency: "rw"` in `PRODUCT.json`. Many readers run in parallel against a `.product-map.readers/` registry while writers stay single and verify an empty live-reader set under a check-then-hold lock, closing the earlier window where an unlocked reader could observe a half-applied index update. Recovery reaps dead local reader files; legacy maps stay byte-identical. Enable it only while the project is quiescent. The full parallel-workers-with-isolated-branches item above remains future work, as do per-feature write parallelism and a writer-intent anti-starvation flag.

Implemented in v0.12: the first slice of parallel workers with isolated branches, through the sub-task model. An opt-in `parallelWorkers` parent-graph flag relaxes the base evidence contracts for a pure dispatch+integration parent, child tasks link to their parent through an additive always-present `parent` field (set with `start --parent`), and a new `integration-coordinator.integrated` gate inherits each child's own required gates by requiring the child to be at a success terminal with recorded reviewer/validator passes, then runs one mandatory combined integration check. Branch metadata is recorded and consistency-checked; the plugin never spawns git. The example graph is `graphs/parallel-build.v1.json`. Still future work (the broad "parallel workers with isolated branches" item above is only partially shipped): git-proven ancestry made mandatory through required `ancestryChecks`, host-driven dispatch orchestration that creates and drives the child tasks, per-feature product-map write parallelism, and staged or multi-target merges.
