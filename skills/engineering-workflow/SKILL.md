---
name: engineering-workflow
description: Build or extend a product using this repository's versioned local engineering graph, with a product feature map, component/test links, version history, root planning documents and synchronized flows/docs/tests, and persisted review and validation. Use when the user requests this workflow.
---

Locate the package root containing graphs/product-build.v6.json. Read docs/workflow.md and policies/defaults.json before starting. Use the CLI from that root; pass the target project's absolute path to start.

The host assistant dispatches the current node. Read the matching agents/<role>.md. Use separate agents only when the host supports delegation and the user has authorized it; otherwise perform the roles sequentially. Do not simulate independent review when one assistant performs both roles.

Persist substantive artifacts under the task directory and reference them in transition evidence. Retrieve relevant files and policies rather than forwarding full histories. Ask only questions that affect scope or implementation.

Approval outcomes require an actual user decision scoped to the proposed plan; elapsed time is not approval. Before implementation, inspect the saved approved plan and domain assessment. If scope changes during implementation, save the revised brief and use replan to return to scope approval. For v1 or terminal tasks, start a superseding task.

Run the current node, record structured evidence per docs/workflow.md, then advance using the current revision. Check remaining attempts before repairs. Never mark validation passed without check evidence tied to the code revision. For resume, inspect task state and verify artifact and code revisions before acting. See docs/extension-guide.md when modifying the graph.

For product implementation, read [references/product-map.md](references/product-map.md). Maintain the root product index and feature graph alongside code, scope, policies, tests and per-feature change records. Read the product map on resume before retrieving feature-specific context.

Before implementation, follow [references/product-map.md](references/product-map.md) to prepare root scope, domains, architecture/product roadmaps, feature list, user flows and user documentation. After every change, update affected documentation, flows and tests together; record justified unchanged assessments where appropriate, run actual checks, and refresh synchronization before review or validation.

For planning, implementation and review, read [references/engineering-quality.md](references/engineering-quality.md). Justify problem-appropriate design patterns, assess reuse and choose a small vertical slice. V5 requires engineeringPlan, engineering and engineeringReview evidence at their respective transitions. Use measured productivity comparisons when available; do not promise a 10× improvement.

For discovery, planning and material replanning, read [references/critical-planning.md](references/critical-planning.md). Give reasoned agreement/disagreement, compare realistic options and lifecycle costs, and recommend against stated constraints with explicit uncertainty. V6 requires proposalAssessment and an analysis for each material engineering decision. Preserve the user's informed, authorized choice.
