---
name: engineering-workflow
description: Build or extend a product using this repository's versioned local engineering graph, with persisted plans, decisions, review, and validation. Use when the user requests this workflow.
---

Locate the package root containing graphs/product-build.v2.json. Read docs/workflow.md and policies/defaults.json before starting. Use the CLI from that root; pass the target project's absolute path to start.

The host assistant dispatches the current node. Read the matching agents/<role>.md. Use separate agents only when the host supports delegation and the user has authorized it; otherwise perform the roles sequentially. Do not simulate independent review when one assistant performs both roles.

Persist substantive artifacts under the task directory and reference them in transition evidence. Retrieve relevant files and policies rather than forwarding full histories. Ask only questions that affect scope or implementation.

Approval outcomes require an actual user decision scoped to the proposed plan; elapsed time is not approval. Before implementation, inspect the saved approved plan and domain assessment. If scope changes during implementation, save the revised brief and use replan to return to scope approval. For v1 or terminal tasks, start a superseding task.

Run the current node, record structured evidence per docs/workflow.md, then advance using the current revision. Check remaining attempts before repairs. Never mark validation passed without check evidence tied to the code revision. For resume, inspect task state and verify artifact and code revisions before acting. See docs/extension-guide.md when modifying the graph.
