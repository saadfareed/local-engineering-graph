# Architecture

The host assistant provides conversation, model access and tools. The skill routes requests; role documents specify responsibilities. The local CLI stores graph snapshots, revision counters, transition evidence and current nodes. Node handlers are performed by the host, not dispatched automatically by JavaScript.

Task files live in <project>/.engineering/tasks/<uuid>/task.json. Store briefs, plans, domain assessments, diffs, reviews and validation reports beside that file. Each task embeds its graph and a checksum, so later graph edits do not affect running tasks. The checksum detects accidental changes; it is not an authentication mechanism.

Writes use an exclusive lock and atomic rename. Stale revisions are rejected. Locks contain local host, PID and creation time. A crash can leave a lock: use recover to refuse live writers, back up valid state, and remove a dead local writer lock. Incomplete metadata, foreign-host locks and stale recovery mutexes require manual inspection. Recovery assumes no external process replaces lock files outside this protocol. Atomic rename protects readers, but full power-loss durability is not guaranteed. Local files are trusted input; there is no multi-user security boundary. Do not run task files supplied by untrusted users.

The CLI cannot enforce host command permissions, prove approval authenticity, check arbitrary agent output contracts or prove review quality. These remain host/instruction responsibilities. All edges have traversal budgets, bounding loops. Required-gate checks establish structural reachability constraints, not semantic approval correctness.

Schema v2 adds project root, code snapshots and superseding task links. V1 stays readable. Structured graph evidence checks artifact existence, approval fields, declared code-file snapshots and validation fields; it cannot establish evidence truth. Cancellation is a revision-checked administrative event to an unsuccessful terminal.
