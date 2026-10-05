# Reasoned planning and cost comparison

New skill-led tasks use product-build.v6.json. V6 adds proposal and design comparisons to the v5 engineering workflow. Codex should help you choose a suitable solution by evaluating your proposal, rather than automatically endorsing it.

## What you receive

For a material proposal, Codex presents:

1. A recommendation and stance: agree, disagree or conditional.
2. The objective, constraints and decision criteria used to assess it.
3. Reasons grounded in project evidence, with assumptions and uncertainty identified.
4. A comparison of realistic options: pros, cons, risks and lifecycle costs.
5. The selected approach, why it fits better, and conditions that would change the recommendation.

Agreement requires useful reasons and acknowledgement of drawbacks. Disagreement requires useful reasons and a practical alternative. Conditional agreement identifies the conditions. Codex should reconsider when new evidence warrants it and respect your informed, authorized choice.

## Depth at each level

| Level | Evaluate |
| --- | --- |
| Product | User problem, value, scope, roadmap, budget and acceptance criteria |
| Domain | Ownership, data boundaries, policy constraints and shared contracts |
| Architecture | Component/service boundaries, integration, dependency direction and deployment complexity |
| Feature | User flows, scope, usability, acceptance coverage and feature dependencies |
| Component | Interfaces, patterns, reuse, testability, performance and maintenance burden |
| Delivery / operations | Rollout, ongoing infrastructure/workload, observability, recovery and migration |

Use deeper comparison for costly, uncertain or hard-to-reverse decisions. Routine low-impact edits can use a short explanation within the existing plan. The runner does not require a separate debate for every line of code.

## Costing and uncertainty

Every compared option records build, operate, maintain and migrate costs. Estimates can include engineering effort, recurring money or team workload, with units/periods where available. Record the estimate's basis and confidence: high, medium, low or unknown. Unknown is valid and must be explained. Identify the information or small experiment needed to improve it.

Use comparable scope and workloads. Distinguish estimates from measured results, include total lifecycle cost, and identify delivery and failure risks. When external prices or specifications affect the choice, verify current primary sources and record the source/date. The runner does not obtain quotes or certify costs.

The recommended option should meet the user's stated priorities and constraints. Lowest initial cost is one criterion; reliability, delivery speed, maintainability and user value can change the result. Explain the tradeoff rather than giving an unsupported universal “best” claim.

## V6 evidence format

Discovery ready requires proposalAssessment, an array of decision analyses with at least one product-level entry. Replan requires a refreshed proposalAssessment before returning for scope approval. This example describes an illustrative comparison; replace its evidence and costs with the actual project's findings:

```json
{
  "id": "P1",
  "level": "product",
  "proposal": "Split the first product version into independently deployed services",
  "stance": "disagree",
  "decisionCriteria": ["Deliver the first user journey", "Lifecycle cost", "Operational simplicity"],
  "constraints": ["One small team", "No established independent-scaling requirement"],
  "confidence": "medium",
  "reasons": ["The stated first-version requirements can be delivered within one modular application"],
  "evidence": ["Approved brief: one initial journey and one team"],
  "assumptions": ["There is no additional independent deployment requirement"],
  "options": [
    {
      "id": "services",
      "description": "Several independently deployed services",
      "pros": ["Independent deployment boundaries"],
      "cons": ["Additional deployment and integration work for this scope"],
      "risks": ["Distributed failure paths need additional validation"],
      "costs": {
        "build": {"estimate": "Unknown", "basis": "Service boundaries and existing infrastructure need inspection", "confidence": "unknown"},
        "operate": {"estimate": "Unknown recurring cost", "basis": "Provider/workload choices are unresolved", "confidence": "unknown"},
        "maintain": {"estimate": "Unknown team workload", "basis": "Need to assess integration and deployment support", "confidence": "unknown"},
        "migrate": {"estimate": "Unknown", "basis": "No existing deployment/data inventory has been supplied", "confidence": "unknown"}
      }
    },
    {
      "id": "modules",
      "description": "One application with explicit feature boundaries",
      "pros": ["Can deliver the stated journey with a shared deployment"],
      "cons": ["Deployment remains shared between features"],
      "risks": ["Weak boundaries could make future separation harder"],
      "costs": {
        "build": {"estimate": "Unknown", "basis": "Inspect existing framework and feature complexity first", "confidence": "unknown"},
        "operate": {"estimate": "Unknown recurring cost", "basis": "Provider/workload choices are unresolved", "confidence": "unknown"},
        "maintain": {"estimate": "Unknown team workload", "basis": "Validate component boundaries and support needs", "confidence": "unknown"},
        "migrate": {"estimate": "Unknown", "basis": "Future separation requirements are unconfirmed", "confidence": "unknown"}
      }
    }
  ],
  "proposedOptionId": "services",
  "recommendedOptionId": "modules",
  "recommendationReason": "A modular application meets the stated first-version requirements with fewer deployment boundaries; actual cost remains to be established",
  "revisitWhen": "Independent deployment, ownership or scaling becomes a demonstrated requirement"
}
```

Place that object in proposalAssessment alongside the normal summary and artifact references. Supported levels are product, domain, architecture, feature, component, delivery and operations. For conditional stance, add a nonempty conditions array.

At planning ready, each engineeringPlan.decisions entry additionally has analysis containing the same fields; analysis.id must match the design decision ID. Its level should match the decision being evaluated. Pattern/reason/tradeoff fields and the chosen option should describe the same implementation choice. Save the actual comparison artifact, and update the root architecture/roadmaps and relevant feature scope for significant decisions.

The runner checks option IDs, required records, recommendation consistency and complete lifecycle costing. It cannot prove that alternatives are realistic, sources are correct, estimates are accurate or recommendations are optimal. Those judgments belong to the assistant and reviewer.

## User decisions and scope changes

Codex recommends; you decide the authorized scope. If you choose another reasonable option, it records the decision and tradeoffs and implements within that scope. If the choice exposes a material unknown, Codex explains what needs resolution. Host permissions remain binding.

When new evidence changes a recommendation, record the new assessment. Material scope changes follow replan and renewed approval. Existing v1–v5 task graphs remain pinned and readable; the new evidence requirements apply to v6.
