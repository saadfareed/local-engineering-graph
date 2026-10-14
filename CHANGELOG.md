# Changelog

## 0.1.0

Local graph runner, project task persistence, role instructions, workflow skill, policy guidance and extension documentation.

## 0.2.0

Added v2 structured evidence and declared code-file checks, scope replanning, retry admission checks, lock recovery with backups, cancellation, superseding links, and reliability tests. V1 tasks remain compatible.

## 0.3.0

Added the product feature graph, generated root index, feature scopes/policies, component and unit-test mappings, dependency impact lookup, per-feature version evidence, and the v3 implementation workflow. Updated the skill and user guides; v1/v2 tasks remain compatible.

## 0.4.0

Added product schema 2 and v4 planning readiness, root roadmaps/scope/domains/feature list/user flows/user guide, feature documentation/flows, synchronization with assessments and test evidence, and upstream change invalidation. Updated skill, roles and manuals; previous graph versions and schema-1 maps remain readable.

## 0.5.0

Added v5 engineering design/reuse/slice plans, implementation decision/performance assessments and engineering review gates. Added the productive engineering playbook and evidence examples; existing graph versions remain supported.

## 0.6.0

Added v6 reasoned proposal assessments and design analyses with options, pros/cons/risks, lifecycle costing, confidence and recommendations. Updated skill, roles and manuals; earlier graph versions retain their behavior.

## 0.7.0

- Replay task history to reject inconsistent revisions, nodes and traversal counts.
- Record structured evidence hashes and report historical artifact drift in status.
- Bind schema-3 approvals to artifact hashes and distinct criterion IDs; require complete validation coverage.
- Snapshot the project tree to detect undeclared file changes, additions and deletions.
- Enforce real-path containment for task code and evidence files.
- Reject nonterminal success markers and graphs without a successful terminal; preparation checks follow worker roles rather than a fixed node ID.
- Add product undo journaling, automatic rollback and dead-writer recovery with backups.
- Reuse the loaded product model when checking feature synchronization.
- Add CLI argument/revision checks, help, automatic graph discovery and CI.
- Preserve legacy evidence behavior for schema-1/2 tasks; new tasks use schema 3.

### Audit follow-up

- Preserve existing initialization targets, symlinks and permission modes during rollback.
- Require structured role/evidence contracts on every successful graph route.
- Reserve administrative cancellation outcomes and reject ambiguous traversal keys.
- Include prototype-named paths in task and product snapshots.
- Restore legacy artifact and declared-code path behavior.
- Enforce initial preparation through intermediate nodes and reject malformed recovery journals before applying undo entries.
- Add targeted regression tests for each confirmed finding.

### User documentation and examples

Historical intermediate work: the demos, evidence templates and runner manual described here were subsequently removed in the Cleanup entry below. They are not included in the current repository.

- Rewrite the user manual for version 0.7.0 with setup, all CLI commands, approval/criterion contracts, product lifecycle, repair and recovery instructions.
- Add a working in-memory task tracker, criterion tests and a complete V2 walkthrough with editable evidence files.
- Add V6 proposal, design, implementation, review, synchronization and release templates.
- Update product-map recovery guidance and README navigation.

### Coding-agent user guide

- Make the user manual focus on conversational agent use, onboarding, real-world prompts, expected results, practical impact and limitations.
- Clarify that native plugin packaging is not yet included and setup depends on the host.
- Move direct CLI instructions into a separate runner manual and label code/evidence examples as maintainer resources.

### Cleanup

- Remove standalone developer demos, evidence templates and the redundant runner manual; retain agent-facing prompt examples and technical contracts.
- Remove duplicate product rollback cleanup and unused CLI test-output collection.
- Correct the skill reference to use V6 for new product work and refresh documentation links.

## 0.7.1

- Merge the separate main/master histories to bring the latest implementation into the default branch.
- Correct declared-code containment checks to allow valid in-project filenames beginning with two dots.
- Report current declared-code and project drift in status, including snapshot scan errors and accurate check availability.
- Track file types, permission modes, empty directories and internal symlink targets in version-2 project snapshots; limit workflow runtime exclusions to the project root.
- Preserve existing unversioned schema-3 snapshot comparisons until implementation resubmission, and reject unsupported snapshot versions.
- Add regression coverage and a real subprocess-driven task-tracker acceptance test with repair, resume, criterion execution and immutable evidence.
- Clarify historical removed resources, current snapshot behavior, and remaining host integration boundaries; inspect both Node.js CI matrix jobs.

## 0.9.0

- Add an incremental content-hash cache for project snapshots, keyed by absolute path plus file size and mtime, so unchanged files are not re-hashed on repeated walks.
- Reuse a single version-2 project snapshot within worker completion instead of recomputing the same tree state twice.
- Preserve byte-identical snapshot hashes for versions 1 and 2, all task/graph schemas and on-disk formats; the cache is in-process only.
- Keep every integrity guarantee: realpath containment, approval, code and project drift detection, historical check drift and pass/review gates fail exactly when they did before. Symlinks are always re-read so their resolved-target content is never served stale.

## 0.8.0

- Add the backward-compatible V7 workflow with explicit user approval of the completed plan.
- Require runnable planning, implementation and review feedback protocols with recorded environments.
- Require isolated sandbox setup, start, readiness, focused checks and shutdown evidence before implementation completion.
- Add contract-first backend/consumer planning with versioned demo output, provider checks, per-consumer verification and sandbox end-to-end evidence.
- Add regression validation for incomplete integration coverage and incomplete sandbox evidence.
- Keep 10× productivity as a measured target based on feedback latency, rework and verified delivery rather than an unsupported claim.
