---
name: engineering-workflow
description: Build or extend a product using this repository's versioned local engineering graph, with a product feature map, component/test links, version history, root planning documents and synchronized flows/docs/tests, and persisted review and validation. Use when the user requests this workflow.
---

This is the skill for the local-engineering-graph plugin. It uses packaged files and a local Node.js CLI, not MCP tools. When this plugin is invoked, load this skill and use shell/file capabilities; an empty MCP tool list does not mean the workflow is unavailable. If shell or package access is unavailable, explain that specific limitation and do not claim a plan was persisted.

Resolve the package root relative to this SKILL.md: two directories above skills/engineering-workflow/. Verify it contains graphs/product-build.v7.json and src/cli.js. Resolve referenced docs, policies and agents from that root, including when Codex loads a cached installation. Read docs/workflow.md and policies/defaults.json before starting. Use the CLI from that root; pass the target project's absolute path to start.

For a planning-only request, save the assessment and plan in the target project and report their paths. Do not begin implementation or report an implementation task as completed. Use the current project as the target when appropriate; ask for a target path if none can be determined. A plugin mention authorizes using this workflow, not building an app when the user only requested a plan.

The host assistant dispatches the current node. Read the matching agents/<role>.md. Use separate agents only when the host supports delegation and the user has authorized it; otherwise perform the roles sequentially. Do not simulate independent review when one assistant performs both roles.

Persist substantive artifacts under the task directory and reference them in transition evidence. Retrieve relevant files and policies rather than forwarding full histories. Ask only questions that affect scope or implementation.

Approval outcomes require an actual user decision scoped to the proposed plan; elapsed time is not approval. Before implementation, inspect the saved approved plan and domain assessment. If scope changes during implementation, save the revised brief and use replan to return to scope approval. For v1 or terminal tasks, start a superseding task.

Run the current node, record structured evidence per docs/workflow.md, then advance using the current revision. Check remaining attempts before repairs. Never mark validation passed without check evidence tied to the code revision. For resume, inspect task state and verify artifact and code revisions before acting. See docs/extension-guide.md when modifying the graph.

For product implementation, read [references/product-map.md](references/product-map.md). Maintain the root product index and feature graph alongside code, scope, policies, tests and per-feature change records. Read the product map on resume before retrieving feature-specific context.

Before implementation, follow [references/product-map.md](references/product-map.md) to prepare root scope, domains, architecture/product roadmaps, feature list, user flows and user documentation. After every change, update affected documentation, flows and tests together; record justified unchanged assessments where appropriate, run actual checks, and refresh synchronization before review or validation.

For planning, implementation and review, read [references/engineering-quality.md](references/engineering-quality.md). Justify problem-appropriate design patterns, assess reuse and choose a small vertical slice. V5 requires engineeringPlan, engineering and engineeringReview evidence at their respective transitions. Use measured productivity comparisons when available; do not promise a 10× improvement.

For discovery, planning and material replanning, read [references/critical-planning.md](references/critical-planning.md). Give reasoned agreement/disagreement, compare realistic options and lifecycle costs, and recommend against stated constraints with explicit uncertainty. V6 requires proposalAssessment and an analysis for each material engineering decision. Preserve the user's informed, authorized choice.

For new product work, use V7 and read [references/productivity-protocols.md](references/productivity-protocols.md). Every active stage must have appropriate testing, debugging or deterministic inspection commands. After planning, show the completed plan and acceptance criteria and obtain explicit user confirmation before implementation. During development, run the product in a safe sandbox when the stack permits it and record setup, start, readiness, focused checks and shutdown; never convert unavailable execution into a pass.

When a backend serves frontend, mobile, desktop or service consumers, plan from one versioned integration contract. The backend must provide deterministic demo output through a sandbox endpoint, fixtures, generated examples or a contract-backed mock. Each consumer builds and tests against that same contract and output. Record provider checks, every consumer check and an end-to-end sandbox result or explicit blocker. Material contract changes require compatibility assessment and, when they alter approved behavior, replanning and renewed approval.

Treat 10× productivity as an optimization target: shorten feedback cycles, integration rework and time to verified value through automation and shared contracts. Claim a multiplier only from comparable measured baselines and results.
