# Local Engineering Graph

Local Engineering Graph is a Codex plugin and local workflow runner for software work. It helps a coding agent turn a feature, bug or design question into a reviewable plan, preserve your approval and evidence, and check the change before calling the work complete.

## The problem it addresses

Coding agents can start implementation before the request is clear, miss affected features or tests, lose decisions between sessions, and report checks without useful evidence. This plugin provides a saved, stage-based workflow for scoping, planning, implementation, review and validation, plus a product feature map for tracking related documentation, user flows, code and tests. It makes progress and gaps easier to inspect; it does not guarantee that the agent's claims are correct or that work is faster.

## Install and connect

The plugin package needs its manifest and supporting files together. Do not install only the skill file. You need Node.js 22 or later to run the local workflow; there are no npm dependencies to install and no MCP server or separate model API key is required by this plugin.

### Use as a Codex plugin

1. Get the latest plugin release or download its complete package. When a newer plugin release is published, install or upload that latest release again to update your existing installation; an installed copy does not update itself.
2. Install or upload it using the plugin installation flow available in your Codex host. Include the hidden `.codex-plugin/` directory along with `skills/`, `src/`, `graphs/`, `agents/`, `docs/` and `policies/`.
3. Open the project you want to work on in Codex and ensure Codex can read and edit that project and run local commands.
4. Start a new session after installing or updating the package, then invoke `local-engineering-graph` or its `engineering-workflow` skill.

The exact UI for installing a local plugin or ZIP depends on your Codex host. The package does not install itself globally. After installing the latest release, start a new session so Codex loads its updated skill snapshot. Changing this checkout does not update an already installed snapshot. `product-build.v7.json` is the current workflow graph format, not the plugin release number; use the newest plugin release even when its graph format version stays the same.

### Load the skill from a local checkout

If you are not installing a native plugin, provide the agent the absolute path to this checkout and ask it to read the skill. For example:

> Load `/absolute/path/to/local-engineering-graph/skills/engineering-workflow/SKILL.md` and use its package root at `/absolute/path/to/local-engineering-graph` for `/absolute/path/to/my-project`. Verify you can read the package, access the project and run Node.js 22+ commands before starting.

Keep the entire package available to the agent. The skill uses the bundled graph definitions, role instructions, policies and local CLI. Loading the skill text alone without access to those files is not a complete setup.

## How to use it

Describe the outcome and constraints in chat. For example:

> Use engineering-workflow to fix the bug where completing one task marks every task complete. Reproduce it, identify the smallest fix, and propose measurable regression criteria. Avoid unrelated refactors. Show me the scope and acceptance criteria for approval before implementing.

For a new feature, include the user problem, expected behavior, relevant constraints and exclusions. For a product with multiple features, ask it to initialize the product map and propose a first delivery slice. For a small isolated fix, the agent can use a lighter task workflow when appropriate.

The usual flow is:

1. **Discover and scope:** inspect the project and describe the problem, criteria, risks and proposed scope.
2. **Approve:** review and explicitly approve the plan before implementation. Revise it if needed.
3. **Plan and implement:** assess design choices, reuse and dependencies; implement within the agreed scope.
4. **Review and validate:** inspect the changes and run relevant checks, recording actual results and unverified items.
5. **Resume or hand off:** task state and evidence are saved in the project so a later session can inspect what remains.

Approval applies to the presented scope. A material scope change should be replanned and approved. Ask for a final report with changes, check commands/results, remaining limitations and the saved task path.

## What it adds to your project

- Task records and evidence under `.engineering/tasks/`.
- For product work, a product index and feature metadata, with feature scope, policies, user flows, documentation, component/test links and change history.
- A local Node.js runner that records transitions and checks reported evidence and project state.

Product metadata may be committed with your code. Task records can contain project details, so follow your team's source-control and data-retention policy. The runner works locally; your coding-agent host's own data handling is separate.

## Troubleshooting

| Problem | What to check or ask |
| --- | --- |
| The agent cannot find the plugin or skill | Start a new session; verify the full package was installed, including `.codex-plugin/` and `skills/`. For a checkout, provide the absolute path to the package root and skill. |
| The agent sees the skill but cannot run the workflow | Confirm it can read `src/`, `graphs/`, `agents/`, `policies/` and `docs/`, and that Node.js 22+ is available. |
| `node` is missing or too old | Install/use Node.js 22 or later, then retry. This repository has no dependency installation step. |
| The task is locked after an interruption | Ask the agent to inspect whether the local writer is still running, then use the documented recovery command only if the writer exited. See [workflow recovery](docs/workflow.md). |
| Files changed after review or validation | Ask the agent to inspect the reported drift, refresh relevant checks/evidence and repeat review or validation as required. |
| The agent cannot verify a criterion | Ask it to report the criterion as unverified and state what environment, access or information is missing. |
| The scope changed during implementation | Ask it to save a revised brief, explain the impact and request approval before continuing with the changed scope. |
| Work needs to continue in a new session | Provide the project path and saved `.engineering/tasks/.../task.json` path; ask the agent to inspect status and evidence before resuming. |

Do not treat a saved “passed” state as proof by itself. Review the evidence and whether the checks were actually run.

## Requirements and limits

- Node.js 22 or newer for the local runner.
- A coding-agent host that can read the package, access the target project and run local commands.
- No hosted backend, MCP connection, external service or npm dependencies are required by the workflow runner.
- The host agent performs the reasoning and implementation; this package is not an autonomous dispatcher and cannot independently establish that its submitted claims are true.
- Product maps are declared metadata and must be kept in sync with the actual application. Review and validation depend on real checks and evidence.

## CLI and maintainer use

Most users can ask their coding agent to operate the workflow. For direct CLI use, run from the package root:

```sh
node src/cli.js --help
```

For contributors, run the repository checks with `npm run check`. This runs the test suite and validator. To start a task directly:

```sh
node src/cli.js start /absolute/project/path graphs/product-build.v7.json "Build a task tracker"
```

The [user manual](docs/user-manual.md) has more prompts, expected outcomes and impact details. Maintainer references: [workflow contracts](docs/workflow.md), [product lifecycle](docs/product-lifecycle.md), [product map](docs/product-map.md), [architecture](docs/architecture.md), [extension guide](docs/extension-guide.md), [policy guide](docs/policy-guide.md), [critical planning](docs/critical-planning.md) and [engineering quality](docs/engineering-quality.md).
