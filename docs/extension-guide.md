# Extending the graph

1. Copy a graph into a new versioned file; keep existing versions available.
2. Add nodes with type agent, approval or terminal, a role, and distinct outcomes. Add the corresponding role document for agents.
3. Give every outcome exactly one edge. Every edge needs a positive maxTraversals value. Terminal nodes have no outcomes; successful terminals set success=true. At least one successful terminal is required, and every node must have a path to a terminal. Success markers are valid only on terminal nodes.
4. Preserve requiredGates. Add new mandatory checks there. Ensure rejected and blocked outcomes terminate or have deliberate recovery paths.
5. Document inputs, outputs, allowed tools, evidence requirements and failure behavior for the new role. Update policies when capabilities change.
6. Run graph validation and add behavioral tests for the new route, bypass prevention and retries.

Example: insert security_review between review and validation; route passed to validation, findings to implementation and blocked to blocked. Add security_review to requiredGates if mandatory.

Task schema version and graph version are separate. No migration command exists yet. New graphs can opt into evidenceMode="structured" and declare submissionOutcome on work nodes for retry admission checks. Old tasks keep their embedded graph; for changed execution semantics create a superseding task and link the old task in its brief. Never silently mutate its snapshot.

Preparation checks recognize the destination worker role rather than requiring a node named `implementation`. Role names still define evidence contracts; retain the documented planner, worker, reviewer and validator roles when renaming nodes. New tasks use schema 3; existing task graphs and legacy evidence semantics remain pinned.

Structured graphs must preserve evidence contracts on every path to success: `user.approved`, `worker.completed`, `reviewer.passed`, and `validator.passed`. Engineering quality additionally requires `planner.ready`; critical planning requires `supreme-coordinator.ready`; product preparation requires `domain-coordinator.allowed`. Agent nodes need a nonempty role; user decisions belong to approval nodes. Node IDs and outcomes cannot contain colons, and `cancelled` is reserved for the administrative cancellation command. Prototype-reserved node IDs are rejected. Invalid custom graphs must be corrected before starting a new task.
