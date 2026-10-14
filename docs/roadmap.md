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
