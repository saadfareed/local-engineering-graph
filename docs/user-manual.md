# Local Engineering Graph: user manual

Local Engineering Graph helps you take a software request from an agreed brief to implementation, review, and recorded validation. It keeps the task's progress and supporting documents in your project so you can resume work in a later session.

This manual covers version 0.6.0. V6 adds reasoned proposal assessments and option/cost comparisons to the engineering workflow.

## The problem we are fixing

Software work conducted through an assistant can lose important context between sessions: what was agreed, which files changed, what was reviewed, and which checks actually ran. Scope changes can slip into implementation without a fresh decision. Repeated repair attempts can consume time without a clear stopping point.

This package gives that work a persistent sequence, a record of decisions, and explicit completion requirements. It also addresses operational interruptions: stale writers, conflicting updates, exhausted retries, and tasks that need to be cancelled or replaced.

## Scope and intended users

Use it for a scoped software feature, bug fix, or small product build where you want an assistant to maintain a brief, plan, review, and validation record. It suits developers and technical product owners who can provide a local project and an assistant with filesystem and command access.

The current package contains a host-neutral assistant skill, role instructions, workflow graphs, and a local command-line runner. Host integration varies: there is no native plugin manifest or universal one-click installation yet. The assistant performs the work; the runner records and checks transitions. You can also operate the runner yourself.

Automatic agent dispatch, parallel workers, hosted background execution, publishing, and connector integrations are future work. Your host's permissions and tools determine which implementation and validation actions are available.

## Approach and benefits

| Approach | What it gives you |
| --- | --- |
| Save a brief with measurable acceptance criteria | A shared definition of what should be built |
| Record scope approval before implementation | A visible decision about the work being authorized |
| Plan and assess affected domains | Earlier identification of dependencies and constraints |
| Save implementation evidence and declared file snapshots | A basis for detecting code changes before checks pass |
| Require review and validation stages | Separate opportunities to inspect the change and test its behavior |
| Persist state, artifacts, and revision numbers | Work that can be resumed and updates that reject stale revisions |
| Bound transitions and check repair capacity | A stopping point before another repair cannot be submitted |
| Provide recovery, cancellation, and superseding links | A practical way to handle interrupted or obsolete tasks |

These are process checks. The runner verifies record structure and selected file contents; the assistant remains responsible for the quality and truth of the work.

## Setup

1. Have Node.js 22 or later available.
2. Open a terminal in this package's root directory, where package.json lives.
3. Run the package checks:

```sh
node --version
npm test
npm run validate
```

No dependency installation is needed.

For assistant use, ask your host to read `skills/engineering-workflow/SKILL.md` from this package. If your host supports installed skills, copy that skill folder to its supported location and preserve access to this package's root. Tell the assistant where both the package and target project are located. There is no global installation performed by these commands.

Example request to your assistant:

> Use the engineering-workflow skill from /absolute/path/to/local-engineering-graph for /absolute/path/to/my-project. Add a task list with create, complete, and delete actions. Save the brief and acceptance criteria, then present the scope for my approval. Record implementation, review, and validation evidence as the task progresses.

Replace the paths and feature description with your own. The host must load the skill instructions for this request to work.

## What you do during a task

Provide an objective and any constraints, answer material questions, and approve or reject a concrete scope. The assistant saves the supporting documents, performs each role, and submits the transitions.

| Stage | Expected work | What happens next |
| --- | --- | --- |
| Discovery | Save brief and criterion IDs | Scope approval |
| Scope approval | Record your actual decision and brief version | Approved goes to planning; rejected ends blocked |
| Planning | Save steps, dependencies, and criterion checks | Domain assessment |
| Domain assessment | Check policies and shared interfaces | Implementation, clarification, or blocked |
| Clarification | Record your answer to a domain question | Planning, or blocked if rejected |
| Implementation | Make the change and record affected code files | Review, renewed scope approval, or blocked |
| Review | Inspect the change and save findings | Validation or implementation for repairs |
| Validation | Run checks and record criterion results | Complete or implementation for repairs |

If scope changes during implementation, the assistant saves a revised brief and uses `replan` to return to scope approval. Review or validation findings can return the task to implementation while submission capacity remains. All normal transitions need supporting evidence.

When one assistant performs both implementation and review, that review is not independent. Separate reviewers depend on your host's capabilities and your authorization.

## Planning recommendations

Codex explains why it agrees, disagrees or agrees conditionally. Important choices include options, pros/cons, risks and build/operating/maintenance/migration costs with evidence and uncertainty. It recommends an approach for your priorities and respects your informed scope decision. See [critical planning](critical-planning.md) for v6 discovery and planning fields.

## Design quality and productive implementation

Codex selects patterns that fit the actual problem, reuses existing components, and builds small testable slices. V5 requires design decisions and engineering checks in planning, implementation and review evidence. Follow the [engineering quality guide](engineering-quality.md) for the JSON fields. Productivity improvements require measured comparisons; 10× is a goal rather than a guaranteed result.

## Prepare the product and keep changes synchronized

Follow the [product lifecycle guide](product-lifecycle.md). Before implementation, Codex fills root architecture/product roadmaps, the feature list, scope, domains, user flows and user guide. After every change, it updates affected documentation, flows and tests, runs checks and records synchronization. Gates reject stale tracked content; reviewing accuracy remains Codex's responsibility.

## Product structure during implementation

Use the [product map guide](product-map.md) to initialize PRODUCT.md and PRODUCT.json in the product root, then register features. Each feature has scope, policies, component/test links, dependencies and a version history. Codex maintains these alongside implementation. New v6 tasks require root planning readiness, current synchronization, this map and featureIds at implementation completion. Existing v1/v2 tasks keep their original behavior.

## Start and inspect a task yourself

Run commands from the package root. Paths in these examples are placeholders.

```sh
node src/cli.js start /absolute/project/path graphs/product-build.v6.json "Build a task tracker"
```

The command prints task JSON, including an `id`, the current `node`, and `revision: 0`. Substitute that ID for TASK_ID below. Files are created at:

```text
/absolute/project/path/.engineering/tasks/TASK_ID/
```

Save the brief, plan, decisions, review, and validation reports beside `task.json`.

```sh
node src/cli.js status /absolute/project/path/.engineering/tasks/TASK_ID/task.json
```

Status includes the current revision and `remainingOutcomes`, which reports remaining traversals for the current node's outcomes. It also includes the saved graph, events, and code snapshot. Use the current revision for the next command; do not guess it.

## Record evidence and advance

An advance records finished work. It does not run that work. Save the referenced artifacts before submitting evidence.

For discovery, save `brief.md` in the task directory and create `discovery-evidence.json` there:

```json
{
  "summary": "Brief and acceptance criteria recorded",
  "artifacts": ["brief.md"]
}
```

Then submit discovery's ready outcome:

```sh
node src/cli.js advance /absolute/project/path/.engineering/tasks/TASK_ID/task.json ready 0 @/absolute/project/path/.engineering/tasks/TASK_ID/discovery-evidence.json
```

The `@` prefix tells the CLI to read a JSON evidence file. Artifact paths resolve relative to the task directory. Always use outcomes declared for the current node.

### Scope approval

After the user has actually approved the scope, save their response in `approval.md` and prepare evidence such as:

```json
{
  "summary": "User approved brief version 1",
  "artifacts": ["brief.md", "approval.md"],
  "approval": {
    "decision": "approved",
    "scope": "Brief version 1: create, complete, and delete tasks",
    "response": "Approved: build the three actions in brief version 1."
  }
}
```

Use `approved` with the current revision. Copy the real response; the example is not an approval. Approval-type nodes require a matching decision, a scope, and the actual response, including when recording rejection or clarification.

### Implementation completion

Save implementation notes and list the relevant files relative to the project root:

```json
{
  "summary": "Implemented the approved task actions",
  "artifacts": ["implementation.md"],
  "featureIds": ["tasks"],
  "codeFiles": ["src/tasks.js", "tests/tasks.test.js", "package.json"]
}
```

Use `completed` while at implementation. For v3–v6, first register and mark the tasks feature implemented, with real component and unit-test paths, and refresh the product index. The runner hashes these files. Include all files needed to assess the change, including relevant callers and configuration. Paths must identify readable files within the project. For removed files, document the deletion in an artifact; the current snapshot mechanism cannot hash a deleted path.

Review evidence requires a summary and artifacts, such as `review.md`. A review pass rechecks the implementation's declared files.

### Validation completion

Run the checks first and save their output. Then record criterion evidence:

```json
{
  "summary": "Approved behavior verified",
  "artifacts": ["validation.md"],
  "criteria": [
    {
      "id": "C1",
      "status": "verified",
      "command": "npm test",
      "result": "Task create, complete, and delete tests passed"
    }
  ]
}
```

Use `passed` while at validation only when all approved criteria have evidence. Include a record for each criterion; the example shows one. Failed or unsupported criteria should be documented and routed to `failed` or `blocked` as appropriate. The runner rejects a validation pass containing a criterion with a status other than verified.

## Resume, repair, or stop

### Resume in a new session

Give the assistant the package location and task.json path. Ask it to read status and referenced artifacts, check the code against the saved work, and continue from the current node. External actions already completed must not be repeated.

### Handle review or validation findings

Record findings and use `changes_required` from review or `failed` from validation. Complete the repair and submit new implementation evidence before passing subsequent checks. If declared code files changed since implementation, a pass is rejected until the implementation snapshot is refreshed through that route.

The default graph allows three implementation completion submissions in total, including the first. Repair admission checks prevent returning to implementation once those submissions are used. The instructional policy also says to stop after two unsuccessful repair attempts; the host must follow that policy even if a graph edge still has capacity.

### Cancel

Read status, then use its revision:

```sh
node src/cli.js cancel /absolute/project/path/.engineering/tasks/TASK_ID/task.json 5 "Feature is no longer needed"
```

Cancellation records an event and moves the task to the unsuccessful terminal, `blocked`. It does not undo project changes or external actions. The revision 5 is illustrative.

### Create a replacement task

Blocked and completed tasks cannot advance. Start a new task and link the old task as the final argument:

```sh
node src/cli.js start /absolute/project/path graphs/product-build.v6.json "Revised task tracker scope" /absolute/project/path/.engineering/tasks/OLD_TASK_ID/task.json
```

This records a superseding link; it does not cancel the old task or carry over its approvals and results. Cancel an active old task separately if needed. Explain the relationship in the new brief.

## Troubleshooting

| Message or situation | Action |
| --- | --- |
| Stale revision | Read status and check what changed before resubmitting with the current revision |
| Task is locked | Let the active writer finish; if it has exited, use recovery below |
| Structured evidence requires summary and artifacts | Supply a JSON evidence file with a nonempty summary and artifact list |
| Missing artifact / ENOENT | Check the artifact path and save the file before advancing |
| Approval requires matching decision, scope and actual response | Record the real decision with the exact transition outcome |
| Code changed since implementation | Return through repair routing and record a fresh implementation snapshot |
| No implementation submissions remain | Stop work; cancel or create a superseding task |
| Task already terminated | Inspect the final record; start a linked replacement if more work is needed |

To recover a lock left by an exited writer:

```sh
node src/cli.js recover /absolute/project/path/.engineering/tasks/TASK_ID/task.json
```

Recovery validates the task, backs up task.json, and removes a lock only when its recorded local writer is no longer running. It refuses active writers, foreign-host locks, and incomplete ownership metadata. Those cases require manual inspection. A stale `.recover` mutex also requires manual inspection before another recovery attempt. Retain the reported backup until you have verified the task can resume.

## Current limits and data handling

Task files and artifacts stay in the target project's `.engineering/tasks` directory. The runner has no hosted backend or model API. Your assistant host may process the files you give it according to that host's behavior. If keeping task data out of Git is desired, add `.engineering/` to the target project's ignore file; the runner does not do this automatically.

Use trusted local graphs and task files. The checksum detects accidental graph changes and is not an authentication mechanism. Locks and revision checks protect local updates; they do not create a multi-user security boundary. Atomic replacement protects readers, but full power-loss durability is not guaranteed.

Artifact checks establish readability, not truth or immutability. Approval fields do not authenticate the user or automatically bind approval to a brief's contents. Code checks cover declared file contents, not the whole repository, undeclared files, or file permissions. Validation checks require verified records, but do not execute commands or enforce a complete list of approved criteria. The host is responsible for these judgments and for honoring permissions.

Existing v1 tasks remain supported with their original free-text evidence behavior. New product tasks should use v6; existing task graphs are not silently migrated.

## Further reading

- [Workflow and evidence contract](workflow.md)
- [Architecture and persistence](architecture.md)
- [Policy ownership](policy-guide.md)
- [Extending the graph](extension-guide.md)
- [Roadmap](roadmap.md)

For the complete local verification suite, run `npm run check`. It discovers all graph JSON files automatically. CI runs this check on Node 22 and 24.

Use `node src/cli.js --help` to list commands. Invalid argument counts and malformed revisions fail before any mutation. For a product operation interrupted by a crashed local writer, run `node src/cli.js product-recover /absolute/project/path`. Recovery refuses active writers and retains a backup of the undo journal.

New structured tasks require `approval.criteriaIds`, for example `["C1", "C2"]`. Keep approved artifacts immutable and store new revisions under distinct names. Status reports changed historical artifacts. Keep generated check output under the task's `.engineering` directory; new tasks snapshot the remaining project tree at implementation completion.
