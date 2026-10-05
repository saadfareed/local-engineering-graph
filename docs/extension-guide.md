# Extending the graph

1. Copy a graph into a new versioned file; keep existing versions available.
2. Add nodes with type agent, approval or terminal, a role, and distinct outcomes. Add the corresponding role document for agents.
3. Give every outcome exactly one edge. Every edge needs a positive maxTraversals value. Terminal nodes have no outcomes; successful terminals set success=true.
4. Preserve requiredGates. Add new mandatory checks there. Ensure rejected and blocked outcomes terminate or have deliberate recovery paths.
5. Document inputs, outputs, allowed tools, evidence requirements and failure behavior for the new role. Update policies when capabilities change.
6. Run graph validation and add behavioral tests for the new route, bypass prevention and retries.

Example: insert security_review between review and validation; route passed to validation, findings to implementation and blocked to blocked. Add security_review to requiredGates if mandatory.

Task schema version and graph version are separate. No migration command exists yet. New graphs can opt into evidenceMode="structured" and declare submissionOutcome on work nodes for retry admission checks. Old tasks keep their embedded graph; for changed execution semantics create a superseding task and link the old task in its brief. Never silently mutate its snapshot.
