# Using Local Engineering Graph in your coding agent

Local Engineering Graph gives your coding agent a structured way to plan, implement, review and verify software work, while keeping a record you can resume later. You describe the goal in chat, decide the scope, and inspect the results. The agent manages the workflow files and runner commands.

This manual is for people using the workflow through a coding agent. It covers version 0.7.0 and includes prompts you can adapt to your own project.

## What is available today

The repository currently provides an **agent skill and local workflow runner**. It does not yet include a native plugin manifest, marketplace installer or automatic agent dispatcher. You can use it through a coding agent that can read the skill, access your local project, and run Node.js commands. A host-specific plugin installation must be added or configured separately.

You do not need to operate the CLI or write evidence JSON yourself when your agent can do those tasks. The agent needs access to the complete package, including its graphs, role instructions and documentation; copying only the skill text is insufficient.

## Connect it to your agent

1. Make this repository available locally and note its absolute path.
2. Open your target project in a coding agent with permission to read and edit that project and run local commands. The workflow runner requires Node.js 22 or later; it needs no dependency installation or model API key of its own.
3. Have the agent load `skills/engineering-workflow/SKILL.md` from the package. If your agent supports installed skills, use its supported installation mechanism and retain access to the full package root. The exact mechanism depends on your coding agent.
4. Give the agent a first request using the prompt below. Ask it to verify setup before beginning the feature.

Replace both example paths:

> Load the engineering-workflow skill from `/absolute/path/to/plugins/skills/engineering-workflow/SKILL.md`. Its package root is `/absolute/path/to/plugins`. Use it for `/absolute/path/to/my-project`. Check that you can read the package, access the project and run the workflow runner. Explain any setup issue before starting work.

**Expected result:** the agent confirms the available workflow and project location, or explains a specific missing capability. Reading the skill is not the same as installing a native plugin.

If your host cannot load skills directly, ask it to read and follow the skill file for this task. Whether those instructions persist into another session depends on the host; provide the package and saved task location again when resuming.

## Your first request

Be concrete about the user problem, project, constraints and desired behavior. You can leave implementation choices open.

> Use engineering-workflow for this project. Add task creation, completion and deletion. Users should be able to create a task with a title, mark it complete and remove it. Preserve the existing UI and storage approach. Exclude notifications and collaboration. Inspect the project, propose measurable acceptance criteria and a small implementation plan, and present the scope for my approval before implementation.

**What the agent should return before implementing:**

- Its understanding of the objective and included/excluded behavior.
- Acceptance criteria you can use to judge success.
- Material questions, dependencies and risks.
- A recommended approach, with reasons and alternatives for important choices.
- A concrete scope for your approval and a saved task location.

For example, it might propose: C1 creates and displays a task; C2 marks an existing task complete; C3 removes the selected task while preserving others. These are illustrative criteria—the agent should adapt them to your actual application.

You can respond:

> Approve the proposed scope and C1–C3 in brief version 1. Proceed with that implementation plan.

Or revise it:

> Before I approve, include keyboard access in the acceptance criteria and exclude changes to the database schema. Update the scope and explain the impact.

Approval applies to the presented scope. A substantial scope change during implementation should return for a new decision. The workflow records your actual response; elapsed time and an agent recommendation are not approval.

## What happens while the agent works

| Stage | What the agent does | What you receive or decide |
| --- | --- | --- |
| Discovery | Inspects relevant context and defines measurable success | A clear scope, recommendation and material questions |
| Scope approval | Records your decision against the saved brief | Approve, reject or request revisions |
| Planning and domain assessment | Checks architecture, policies, reuse and dependencies | An implementation plan and unresolved constraints |
| Implementation | Changes approved code and keeps relevant docs, flows and tests aligned | Progress, scope-change requests and implementation evidence |
| Review | Inspects the result against scope and engineering decisions | Findings and repairs, or a recorded review pass |
| Validation | Runs available checks and records each approved criterion | Actual commands/results and any unverified behavior |
| Completion | Preserves the task and product records | Changed behavior, verification, limitations and a handoff location |

The graph advances only when the agent submits valid records. It cannot judge whether an agent's claims are true; the quality of inspection and actual check execution still matters.

## Different ways to use it

### 1. Build a new product in small slices

> Use engineering-workflow to build an appointment-booking product in this repository. Start with one user journey: view available slots and request an appointment. Compare suitable approaches against our small-team constraints. Define the product scope, domains, feature list, technical/product roadmaps and acceptance criteria. Present the first slice for approval before implementation. Keep payments and reminders outside the initial scope.

**Expected result:** a product plan, an initial feature map, explicit exclusions and a proposed first delivery slice. After approval, the agent implements and verifies that slice rather than treating the entire product roadmap as completed.

**Impact:** makes a broad request reviewable and gives later features an existing plan and dependency record. The planning overhead is more worthwhile for a multi-feature product than for a trivial edit.

### 2. Add a feature to an existing application

> Use engineering-workflow to add CSV export to the existing orders screen. Preserve current filters and permissions. Inspect existing export utilities before adding a dependency. Map the affected feature, callers and tests. Propose criteria for exported columns, filtered results, empty states and unauthorized access, then ask for scope approval.

**Expected result:** a feature-specific plan that fits the existing architecture, identifies relevant dependencies and verifies the approved behavior.

**Impact:** reduces the chance of overlooking shared callers, permissions or stale user documentation. The declared feature map helps navigation; the agent must still inspect real imports and behavior.

### 3. Fix a reproducible bug

> Use engineering-workflow to investigate why completing one task marks every task complete. Reproduce the bug first, identify the smallest fix and propose regression criteria. Avoid unrelated refactors. After scope approval, apply the fix, run the regression and relevant existing tests, and report the evidence.

**Expected result:** a recorded reproduction, a bounded fix, meaningful regression coverage and actual check results. If the issue cannot be reproduced, the agent should report what it investigated and what information is missing.

**Impact:** connects the change to the observed failure and makes it easier to assess whether the problem was fixed. For a narrow task without product metadata, the runner supports a simpler V2 workflow; ask the agent to explain whether that is appropriate for your project. The skill's full product workflow normally uses V6.

### 4. Refactor without changing behavior

> Use engineering-workflow to simplify the checkout validation code. Preserve all public behavior, error messages and interfaces. Assess existing abstractions and callers, define behavior-preservation checks, and propose a small refactor scope. Explain which documentation and user flows remain unchanged and why.

**Expected result:** a justified refactor with compatibility checks and explicit assessments of affected documentation, flows and tests.

**Impact:** discourages abstractions without a demonstrated need and gives reviewers a concrete behavior-preservation target. Unchanged documentation needs a reason, not meaningless edits to satisfy a process.

### 5. Evaluate an architectural proposal

> Assess my proposal to split the application into services using engineering-workflow. Compare it with keeping a modular application. Consider our team size, current bottlenecks, deployment needs and build/operate/maintain/migrate costs. Distinguish measured evidence from assumptions, state uncertainty, and recommend an approach. Do not change application code during this assessment.

**Expected result:** a reasoned agreement, disagreement or conditional recommendation, realistic alternatives and explicit unknowns. Ask for a planning-only assessment rather than implementation; it should not be reported as a completed implementation task.

**Impact:** helps you make an informed decision before committing to an expensive change. Cost records are estimates unless supported by measurements or current sources; the runner does not fetch or certify prices.

### 6. Resume work in another session

> Resume engineering-workflow for `/absolute/path/to/my-project`. The package is at `/absolute/path/to/plugins`, and the saved task is `/absolute/path/to/my-project/.engineering/tasks/TASK_ID/task.json`. Read the current state, approved brief, design decisions, evidence and affected feature context. Check for changed files or artifacts, summarize the remaining work, then continue within the approved scope. Do not repeat completed external actions.

**Expected result:** a status summary grounded in saved state and a continuation from the current stage. If the implementation or approved artifacts changed, the agent should explain the required repair or replanning route.

**Impact:** reduces reliance on remembered chat history. It does not automatically restore your coding agent's conversation or resolve changes made outside the workflow.

### 7. Change the scope during implementation

> Add recurring tasks to the current request. Before implementing that change, explain its impact on storage, user flows, tests and the delivery plan. Save a revised brief and use the workflow's replanning route. Present the revised scope and criteria for approval.

**Expected result:** a revised proposal and a new approval decision before implementing the material scope change.

**Impact:** preserves a clear boundary between the originally approved work and the new request. Existing implementation may need revision; prior approvals are not automatically transferred.

### 8. Review progress or hand off the task

> Give me the engineering-workflow status: approved scope, current stage, delivered behavior, remaining work, review findings, actual tests run, unverified criteria and blockers. Include the task location and affected feature documents. Separate observed results from estimates.

**Expected result:** a useful handoff with evidence locations and an honest account of unfinished or unverified work.

**Impact:** makes progress assessable without reading every internal record. The runner tracks state and evidence; it does not automatically measure active work time, costs or productivity gains.

### 9. Stop or replace a task

> Cancel the current engineering-workflow task and record that this feature is no longer needed. Explain which application changes already exist and what follow-up would be required if we want to revert them.

Or:

> Start a replacement engineering-workflow task for the revised objective, link the old task, and propose a fresh scope. Do not carry over the old approval as approval of the new work.

**Expected result:** an ended task or a linked replacement with a fresh scope. Cancellation records the decision; it does not undo application changes or external actions.

## How this changes the work

| Capability | Practical effect | Limit or cost |
| --- | --- | --- |
| Scope and acceptance criteria | Makes the requested outcome explicit before implementation | You need to review and decide the scope |
| Reasoned design comparisons | Makes important tradeoffs visible | Requires investigation; unknown costs remain unknown |
| Reuse and small slices | Encourages focused implementation and earlier feedback | Does not guarantee faster delivery |
| Product and feature context | Provides navigation and declared change impact | Metadata must be maintained and checked against real code |
| Documentation/flow/test synchronization | Detects stale records after tracked changes | Content freshness does not prove semantic correctness |
| Review and criterion validation | Provides evidence you can inspect | A single-agent review is a self-review; field checks cannot prove execution |
| Saved state and content snapshots | Supports resume and detects changed recorded content | External edits may require repair, synchronization or renewed approval |
| Bounded repair attempts | Gives repeated failures a stopping point | Some tasks need a revised approach or replacement task |

There is no guaranteed 10× speedup. To assess impact in your own team, compare similar work using verified outcomes, repair cycles, handoff effort and measured time. Ask the agent to record only measurements it can actually observe.

## What the agent adds to your project

For full product work, expect root product planning and navigation files, a `features/` metadata directory and local task records under `.engineering/tasks/`. Application code can stay in its existing layout; it does not need to move into the metadata directory.

Ask before first use if you need a clear inventory:

> Explain which workflow files you intend to add, how they fit our current documentation and which records belong in source control. Preserve our application layout and existing documents. Report naming conflicts before initializing metadata.

Product metadata can be committed with the change. Task evidence can remain local under your team's data policy. The runner keeps its own data locally; your coding agent host's processing and retention behavior are separate.

Keep approved briefs immutable and save revisions as new artifacts. Generated test output should go under the task directory so it does not unintentionally change the implementation snapshot. Your agent handles these details, but they explain why an otherwise valid task may need to return for repair.

## What to expect at completion

Ask for a result you can assess:

> Show what changed against the approved criteria, the actual verification commands and results, any remaining limitations, and how to use the new behavior. Include the saved task path and updated feature documentation. State whether the review was independent or a self-review.

A useful completion report describes delivered behavior, actual verification, material limitations and where to find the records. If a required check could not run, expect a blocker or an unverified criterion, not an inferred pass. Feature history records describe a change; they do not publish or deploy it.

Deployment, publishing, messaging and destructive actions still depend on your authorization and the coding agent's permissions. Scope approval is not a substitute for those permissions.

## Troubleshooting through your agent

| Situation | What to ask |
| --- | --- |
| Agent cannot find the workflow | “Read the skill at this path and verify access to the full package root.” |
| Agent is editing before scope is agreed | “Present the saved scope and criteria and record my decision before implementation.” |
| Workflow is locked after an interruption | “Inspect the writer ownership. Use the supported task or product recovery only after confirming the writer exited.” |
| Files changed after review or implementation | “Explain the drift and use the repair route to refresh checks and evidence.” |
| Approved brief changed | “Use a revised brief and renewed approval, or restore the approved artifact.” |
| Product documents or tests are out of sync | “Inspect affected and downstream features, update or justify unchanged records, run checks and refresh synchronization.” |
| A test or criterion cannot be verified | “State what is unverified and what is needed; do not record a pass.” |
| Repair attempts are exhausted | “Summarize the blocker and recommend a revised approach or replacement task.” |
| Terminal task needs more work | “Start a linked replacement task with a fresh scope.” |

Do not ask the agent to bypass a check merely to reach “complete.” Resolve the underlying mismatch or revise the scope openly.

## When to use a lighter approach

This workflow is most useful for meaningful features, cross-cutting changes, uncertain designs and work that spans sessions. A tiny copy edit or disposable experiment may not justify a full product map and repeated evidence records. Agree on the appropriate workflow before starting; avoid silently dropping required stages once a task is active.

Planning-only discussions can stop at a recommendation. Implementation tasks need their review and validation records before completion.

## Technical reference for maintainers

Most users can let the coding agent manage the runner. For direct operation, use CLI help, the [workflow contracts](workflow.md), [product lifecycle](product-lifecycle.md) and [product map](product-map.md). Read [architecture](architecture.md) for persistence details and [graph extensions](extension-guide.md) when changing the package.
