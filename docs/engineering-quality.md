# Design quality and productive implementation

Use product-build.v7.json for new skill-led product work. V7 adds stage checks and plan approval; V6 adds [critical planning](critical-planning.md) and decision/cost comparisons to the v5 contract below. It adds recorded engineering decisions and review checks to v4's planning, feature mapping and synchronization gates.

The goal is faster delivery of verified user value through reuse, clear boundaries, smaller changes and less rework. A 10× improvement is an aspiration that needs a measured baseline; the package does not guarantee or report that speedup automatically.

## Choose patterns for the problem

Start with the product's framework conventions and existing components. Record important decisions in PRODUCT-ARCHITECTURE.md and their sequencing in ARCHITECTURE-ROADMAP.md. Give each decision an ID, affected feature/component paths, reason, alternatives and tradeoffs. A simple module or composition can be the chosen design.

| Situation | Design to consider | Evidence for using it |
| --- | --- | --- |
| A focused feature with straightforward behavior | A cohesive module with explicit inputs/outputs | Small surface, clear ownership, easy behavioral tests |
| UI pieces share behavior or presentation | Component composition | Reuse without coupling unrelated features |
| A third-party service has a different interface | An adapter at the integration boundary | Domain code is isolated from provider-specific details |
| Multiple actual algorithms or policies are interchangeable | Strategy | Real variability with a common contract |
| Storage behavior needs separation from business rules | A persistence interface/repository | Test isolation or supported backend variation; reuse framework facilities where sufficient |
| A workflow has constrained states, retries and decisions | An explicit state machine | Defined legal transitions, failure paths and bounded retries |

Choose a pattern only when it resolves a demonstrated constraint. Keep business rules in components with explicit dependencies and contracts. Introduce abstractions when they express a real boundary or repeated behavior. Compare their maintenance cost with a simpler implementation. Follow the existing architecture unless the approved work calls for changing it.

## Work for high productivity

1. **Find existing solutions first.** Inspect the product map, framework utilities, shared components and relevant callers. Reuse approved dependencies and existing interfaces. Record what was reused and any reason a new component was needed.
2. **Build a small vertical slice.** Deliver one testable user journey across the necessary layers. Define observable acceptance checks before writing code. Sequence later slices through the roadmap.
3. **Keep context focused.** Read feature-context, affected contracts and relevant code. Reuse saved briefs and decisions on resume. Batch independent reads and checks; use additional agents only when authorized.
4. **Make boundaries testable.** Keep responsibilities cohesive, make dependencies explicit, and cover behavior at appropriate unit/integration boundaries. Add regression tests for the actual change.
5. **Run fast feedback first.** Run the relevant feature checks, then downstream checks when contracts change, and required project checks. Repeat tests when new edits or failures warrant it. Save results for review and synchronization.
6. **Update the product record in the same change.** Keep documentation, flows, components, tests and version records consistent. Use the existing generated index and synchronization commands instead of maintaining duplicate lists.
7. **Optimize observed bottlenecks.** For performance-sensitive paths, define a target and profile/benchmark representative behavior before changing it. Record the command, workload and results. For an ordinary change without a performance concern, record why profiling is not applicable.
8. **Stop avoidable rework.** Resolve material scope/contract questions early, keep changes scoped, use the retry limits, and preserve a usable handoff record when blocked.

For a productivity claim, compare similar work using recorded baseline and observed results: time to a verified slice, repair cycles, relevant check duration and user acceptance criteria delivered. Separate waiting time from active work where you can actually measure it. Save the comparison in a validation artifact; do not infer productivity from line count, agent count or an unmeasured estimate. The runner stores events but does not collect active-work timing or compute a 10× metric.

## V5 planning evidence

Add engineeringPlan to planning's ready evidence, alongside the normal summary and artifact references:

```json
{
  "slice": "Create an appointment end to end",
  "reuse": "Reuse existing form components and the persistence interface",
  "decisions": [
    {
      "id": "D1",
      "pattern": "Simple feature module",
      "reason": "A focused use case can use the existing interfaces directly",
      "alternatives": ["A separate service hierarchy"],
      "tradeoffs": "Extract a provider boundary when a second actual provider is needed",
      "paths": ["src/features/booking/service.js"]
    }
  ],
  "validationCommands": ["node --test tests/booking/service.test.js"]
}
```

The example is the value of engineeringPlan. Save full design reasoning in a referenced plan artifact and the root architecture document. Planned paths may not exist yet. The runner validates record structure, not whether the pattern is suitable.

## V5 implementation evidence

Add engineering to implementation's completed evidence, alongside featureIds, codeFiles and normal artifacts:

```json
{
  "summary": "Implemented the approved appointment-creation slice",
  "reuseResult": "Reused the form and persistence interface; added only booking behavior",
  "decisionIds": ["D1"],
  "performance": {
    "status": "not-applicable",
    "reason": "No performance-sensitive path or stated latency requirement changed"
  }
}
```

Cover every decision in the current engineering plan. For an applicable performance check, use status measured with reason, command and result. Reference the actual benchmark output in the normal artifacts. A performance concern that cannot be verified should remain unresolved; report it through the appropriate failed/blocked outcome.

## V5 review evidence

For a passed review, add engineeringReview:

```json
{
  "decisionIds": ["D1"],
  "checks": {
    "simplicity": {"status": "passed", "evidence": "The feature uses one cohesive module with no unnecessary abstraction"},
    "boundaries": {"status": "passed", "evidence": "Provider access follows the existing persistence interface and declared dependencies"},
    "testability": {"status": "passed", "evidence": "Behavioral unit tests and the relevant integration check cover the changed journey"},
    "performance": {"status": "passed", "evidence": "Reviewed the documented reason that profiling is not applicable"},
    "scopeAndReuse": {"status": "passed", "evidence": "Change implements the approved slice and reuses the existing form component"}
  }
}
```

Record real observations, not the illustrative claims above. Failed checks should produce actionable findings and changes_required or blocked. Replanning clears the saved design plan and implementation assessment, requiring new planning evidence. Validation still needs actual criterion results and current synchronized feature records.

V1–v4 remain available for pinned tasks. Quality fields are mandatory for v5, and the graph is not silently upgraded. These records make engineering choices reviewable; they cannot prove design quality, benchmark authenticity or productivity improvement.
