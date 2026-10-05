# Workflow

Discovery → scope approval → planning → domain assessment → implementation → review → validation → complete.

Use product-build.v6.json for new product tasks; see [product map](product-map.md) for feature setup, component/test mapping and version records. V2 remains available for tasks without a product map. Existing v1 graphs and tasks remain readable and keep their original free-text evidence behavior; they are not silently migrated.

Domain questions return through clarification to planning. Implementation's replan outcome returns to scope approval, clears its code snapshot, and requires a new user decision before planning. Save the revised brief before requesting renewed approval. Blocked and rejected tasks terminate; cancel or create a superseding task to stop or restart work.

Pass structured evidence using `advance TASK_FILE OUTCOME REVISION @EVIDENCE_JSON_FILE`. Paths in artifacts resolve relative to the task directory. Each referenced artifact must exist and be readable. Minimal discovery evidence:

```json
{"summary":"Brief recorded","artifacts":["brief.md"]}
```

Approval additionally requires `approval` with `decision` matching the outcome, a nonempty `scope` identifying the brief/plan version, and `response` containing the actual user response. The runner validates fields, not human authenticity.

Implementation completion additionally requires `codeFiles`, an array of project-relative file paths covering the implementation and relevant callers/configuration. The runner hashes their contents and stores the snapshot. Review and validation passes recheck those files; changes require returning through changes_required or failed to implementation. Legacy schema-1/2 tasks cover declared files only. Schema-3 tasks additionally check the project tree as described below. The host remains responsible for selecting complete coverage and checking artifacts against the work.

Validation passes additionally require a nonempty `criteria` array, with each entry containing `id`, `status: "verified"`, `command`, and `result`. Save full check output in a referenced artifact. The runner checks the record, not command execution. Schema-3 structured tasks also require complete approved criterion coverage.

`status` reports remaining traversal counts for current outcomes. V2 refuses repair routes into implementation when no completion submissions remain. Use cancel or supersede rather than performing a repair that cannot be submitted. Edge budgets remain authoritative; policy limits may stop work sooner.

Resume by reading status, referenced artifacts and code snapshots. Node work remains dispatched manually by the host. External actions must not be repeated on resume.

V3 implementation completion requires featureIds naming registered implemented features. The runner checks the product map and adds their scope, policies, manifests, mapped components/tests and product documents to the implementation snapshot. Review/validation passes check the current map. Record feature version history after the task completes.

V4 requires current planning readiness before domain assessment can allow initial implementation. Product schema 2 adds root roadmaps/scope/domains/flows/documentation and feature synchronization. See [product lifecycle](product-lifecycle.md). Product checks reject stale feature and upstream snapshots, changed validation artifacts, or missing synchronization assessments/results.

V5 requires engineeringPlan on planning ready, engineering on implementation completed, and engineeringReview on review passed. See [engineering quality](engineering-quality.md). Replan clears the design plan and implementation assessment.

V6 requires proposalAssessment on discovery ready and implementation replan, plus matching analysis on each engineeringPlan design decision. Comparisons include reasoned stance, criteria/constraints, evidence, options and lifecycle cost estimates/basis/confidence. See [critical planning](critical-planning.md).

New tasks use task schema 3. Structured approval for `approved` additionally requires `approval.criteriaIds`: a nonempty list of distinct acceptance criterion IDs. Validation must cover exactly that list, once per ID. Approval binds the scope to the contents of its referenced task artifacts. Editing an approved artifact requires replanning before implementation or a passing review/validation. Keep approved briefs immutable; save revised briefs under new filenames.

Every schema-3 structured event stores artifact hashes. `status` reports historical artifacts whose contents changed or disappeared in `evidenceIntegrity.changedArtifacts`. It also compares current declared code and project snapshots, reporting `codeIntegrity.changedFiles` and `projectIntegrity.changedPaths`. Each section's `checked` flag indicates whether a baseline was available and checked; `projectIntegrity.error` reports an unreadable or unsupported project entry, so an empty changed-path list with an error is not a clean result. Before implementation there is no code/project baseline. Status reports drift without mutating the task or preventing repair; passing review and validation still enforce snapshot comparisons. These hashes detect accidental changes; they do not authenticate a user or protect against deliberate edits to task JSON.

Schema-3 structured implementation captures project files, including undeclared additions and deletions, subject to exclusions. New submissions use `projectSnapshotVersion: 2`, tracking file contents and types, permission modes, directories (including empty ones), and internal symlink targets. `.git` and `node_modules` entries are excluded at every level; `.engineering`, `.product-map.lock`, and `.product-map.recover` are excluded only at the project root. Nested application directories with those runtime names are tracked. File timestamps, ownership and extended attributes are not tracked. Existing schema-3 snapshots without a version retain their original content-only comparisons and exclusions until the next implementation submission upgrades them. Test output and task evidence should live under the root `.engineering` directory so check execution does not alter the implementation snapshot. Preserve historical evidence files; save each new test run under a new filename. External symlinks, symlinks to directories, and special filesystem entries are rejected. Code paths must be project-relative; artifact paths must remain inside the task directory, including after resolving symlinks.

Task history is replayed on load to check revisions, transitions, traversal budgets, and the current node. Existing schema-1/2 tasks retain their original evidence and snapshot behavior; start a superseding task to adopt schema 3. V1 graphs still use text evidence and do not gain structured approval checks.
