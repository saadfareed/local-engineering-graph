# Policy documentation

policies/defaults.json identifies each rule and its enforcement owner. Host restrictions remain binding. Project policies can narrow behavior; authorized user decisions can override project defaults where host rules allow it. If precedence is ambiguous, ask a focused question.

For additional project policies record ID, version, scope, trigger, decision (allowed, approval_required, prohibited), enforcement owner and exception procedure. Record approvals with task ID, plan version, exact action and user response. Do not infer approval from a domain agent's recommendation.

Instructional rules are not a sandbox. This MVP's runner enforces transitions, stale-write rejection and edge budgets only. Token usage is not available through every host; use bounded context and attempts rather than claiming hard token enforcement.
