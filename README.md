# Local Engineering Graph

A host-neutral skill package and dependency-free local workflow runner. No hosted backend, model API, MCP server, or native plugin manifest is included. The host assistant executes role instructions; the runner persists and validates its reported transitions.

Start with the [user manual](docs/user-manual.md) for scope, benefits, setup, everyday use, and troubleshooting.

Requires Node.js 22+. No dependency installation is needed.

```sh
npm test
npm run validate
node src/cli.js start /absolute/project/path graphs/product-build.v2.json "Build a task tracker"
node src/cli.js status /absolute/project/path/.engineering/tasks/TASK_ID/task.json
node src/cli.js advance /absolute/project/path/.engineering/tasks/TASK_ID/task.json ready 0 @/absolute/path/evidence.json
```

Start creates a UUID task directory in the selected project. Each advance requires its current revision and structured evidence in v2 (see docs/workflow.md). This is a manual host-driven workflow, not an autonomous agent runtime.

Load skills/engineering-workflow/SKILL.md in your host, or copy its folder into your host's supported skill location and preserve access to this package's root. Native installation must be adapted after choosing the host. Nothing is installed globally by this repository.

Documentation: [user manual](docs/user-manual.md), [architecture](docs/architecture.md), [workflow](docs/workflow.md), [extension guide](docs/extension-guide.md), [policy guide](docs/policy-guide.md), [roadmap](docs/roadmap.md).

Recovery: `node src/cli.js recover TASK_FILE` backs up state and removes a lock only when its local writer is dead. Cancellation: `node src/cli.js cancel TASK_FILE REVISION "reason"`. Add an existing task file as the final `start` argument to record a superseding task.
