# Local Engineering Graph

A host-neutral skill package and dependency-free local workflow runner. No hosted backend, model API, MCP server, or native plugin manifest is included. The host assistant executes role instructions; the runner persists and validates its reported transitions.

Start with the [user manual](docs/user-manual.md) to use this workflow through your coding agent: setup, example prompts, expected results, impact and troubleshooting. The package currently provides a skill and local runner; native plugin installation is host-specific and is not included.

For direct CLI operation or package maintenance, see the [workflow contracts](docs/workflow.md), [product lifecycle](docs/product-lifecycle.md) and [product map](docs/product-map.md). Run `node src/cli.js --help` for the command reference.

Requires Node.js 22+. No dependency installation is needed.

```sh
npm run check
node src/cli.js start /absolute/project/path graphs/product-build.v6.json "Build a task tracker"
node src/cli.js status /absolute/project/path/.engineering/tasks/TASK_ID/task.json
node src/cli.js advance /absolute/project/path/.engineering/tasks/TASK_ID/task.json ready 0 @/absolute/path/evidence.json
```

For product implementation, first initialize the [product map](docs/product-map.md):

```sh
node src/cli.js product-init /absolute/project/path "My product"
node src/cli.js feature-add /absolute/project/path booking "Appointment booking"
```

This creates a root feature index plus feature scope, policies and version history. Populate root scope, domains, architecture/product roadmaps, flows and user documentation before implementation; record product-ready. Map actual components/unit tests and record feature-sync after each change before implementation completion. See the [product lifecycle guide](docs/product-lifecycle.md). Use product-sync, product-check and feature-context to maintain and navigate the graph.

Start creates a UUID task directory in the selected project. Each advance requires its current revision and structured evidence in v2–v6. New tasks bind approval artifacts and criterion IDs, report evidence drift, and check the project file tree (see docs/workflow.md). This is a manual host-driven workflow, not an autonomous agent runtime.

Load skills/engineering-workflow/SKILL.md in your host, or copy its folder into your host's supported skill location and preserve access to this package's root. Native installation must be adapted after choosing the host. Nothing is installed globally by this repository.

Documentation: [critical planning](docs/critical-planning.md), [engineering quality](docs/engineering-quality.md), [product lifecycle](docs/product-lifecycle.md), [product map](docs/product-map.md), [user manual](docs/user-manual.md), [architecture](docs/architecture.md), [workflow](docs/workflow.md), [extension guide](docs/extension-guide.md), [policy guide](docs/policy-guide.md), [roadmap](docs/roadmap.md).

Product recovery: `node src/cli.js product-recover /absolute/project/path` restores interrupted product mutations after the local writer exits.

Recovery: `node src/cli.js recover TASK_FILE` backs up state and removes a lock only when its local writer is dead. Cancellation: `node src/cli.js cancel TASK_FILE REVISION "reason"`. Add an existing task file as the final `start` argument to record a superseding task.

V5 adds justified design decisions, a reuse/slice plan and engineering review evidence. The [engineering quality guide](docs/engineering-quality.md) explains the approach to productive implementation and measured performance.

V6 adds independent proposal assessment, pros/cons and lifecycle cost comparisons with explicit confidence. See [critical planning](docs/critical-planning.md).
