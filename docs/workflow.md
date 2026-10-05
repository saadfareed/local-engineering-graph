# Workflow

Discovery → scope approval → planning → domain assessment → implementation → review → validation → complete.

Use product-build.v2.json for new tasks. Existing v1 graphs and tasks remain readable and keep their original free-text evidence behavior; they are not silently migrated.

Domain questions return through clarification to planning. Implementation's replan outcome returns to scope approval, clears its code snapshot, and requires a new user decision before planning. Save the revised brief before requesting renewed approval. Blocked and rejected tasks terminate; cancel or create a superseding task to stop or restart work.

Pass structured evidence using `advance TASK_FILE OUTCOME REVISION @EVIDENCE_JSON_FILE`. Paths in artifacts resolve relative to the task directory. Each referenced artifact must exist and be readable. Minimal discovery evidence:

```json
{"summary":"Brief recorded","artifacts":["brief.md"]}
```

Approval additionally requires `approval` with `decision` matching the outcome, a nonempty `scope` identifying the brief/plan version, and `response` containing the actual user response. The runner validates fields, not human authenticity.

Implementation completion additionally requires `codeFiles`, an array of project-relative file paths covering the implementation and relevant callers/configuration. The runner hashes their contents and stores the snapshot. Review and validation passes recheck those files; changes require returning through changes_required or failed to implementation. These checks cover declared files only, not an entire repository or undeclared new files. The host remains responsible for selecting complete coverage and checking artifacts against the work.

Validation passes additionally require a nonempty `criteria` array, with each entry containing `id`, `status: "verified"`, `command`, and `result`. Save full check output in a referenced artifact. The runner checks the record, not command execution or whether all approved criteria were listed.

`status` reports remaining traversal counts for current outcomes. V2 refuses repair routes into implementation when no completion submissions remain. Use cancel or supersede rather than performing a repair that cannot be submitted. Edge budgets remain authoritative; policy limits may stop work sooner.

Resume by reading status, referenced artifacts and code snapshots. Node work remains dispatched manually by the host. External actions must not be repeated on resume.
