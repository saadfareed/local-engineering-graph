# Productive engineering

Read docs/engineering-quality.md in the package root for the v5 evidence contract. Prefer the product's existing conventions and the simplest cohesive design that meets the approved requirements. Record design decision IDs, pattern (including simple modules/composition), rationale, alternatives, tradeoffs and affected paths in the plan and root architecture document.

Before implementation, inspect reuse opportunities and select a small end-to-end user slice with observable checks. Keep business responsibilities and external integration boundaries explicit. Use a pattern to solve a demonstrated problem; assess the cost of added abstraction. Preserve approved scope and existing architecture unless a change is necessary and authorized.

Use feature-context for targeted retrieval and downstream impact. Batch independent reads/checks, reuse approved components and utilities, run relevant feedback early, and keep documents/flows/tests synchronized. Additional agents still require authorization. Repeated tasks can justify a small deterministic helper; one-off behavior does not require another framework.

For performance-sensitive work, record a representative workload, target, profiling/benchmark command and result. Otherwise give a reason profiling is not applicable. Review simplicity, boundaries, testability, performance and scope/reuse using actual evidence. Unresolved quality findings must return for repair or report a blocker.

Treat 10× as a measurable goal, never a promise. Record a comparable baseline and observed delivery/check/rework metrics only when available. Do not invent active-work timing, savings, benchmark results or independent review. Persist the comparison in validation artifacts if measured.
