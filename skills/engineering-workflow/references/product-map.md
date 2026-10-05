# Product implementation map

Read docs/product-lifecycle.md for preparation and per-change synchronization, then docs/product-map.md from the package root for command syntax, manifest fields, and version evidence. Use graphs/product-build.v6.json for new product tasks; existing task graphs remain pinned.

At planning, create and populate root architecture/product roadmaps, scope, domain definitions, feature list, user flows and user guide. Record domain IDs in the registry and feature assignments. Save planning evidence and run product-ready before entering implementation. At planning, initialize the target's product map if absent and register the scoped features. Translate the approved plan into feature scopes with stable acceptance criterion IDs. Record product architecture and shared policies, feature rules, component ownership and public contracts. Preserve existing project layout; src/features/<id> is an example, not a required refactor.

Before changing a feature, run feature-context. Read its policies, scope, and relevant dependency contracts. Inspect real imports/callers to find missing map edges. Keep feature and component dependencies directed and acyclic; shared interfaces should have explicit ownership.

Implement actual components and associated unit tests. Map source/test paths and commands, update status, then product-sync, feature-sync with documentation/user-flow/unit-test assessments and real passing test evidence, and product-check. Do not treat scaffold text, empty arrays, or a readable test file as completed implementation or proof of coverage. Include featureIds in implementation evidence; include relevant additional code files not covered by the map.

Review code, scope, policy compliance, dependency declarations, and test coverage together. Run appropriate mapped tests, including downstream tests for contract changes. Record actual results and criterion evidence. New scope still requires the task's replan route and renewed approval.

After a task completes, append each affected feature's version using feature-release with real changes, a code revision, validation artifacts and passing results for every mapped test. Preserve old history records. Check and refresh PRODUCT.md as part of the change. Report unverified behavior honestly; do not create a passing version record for it.

Treat each edit as affecting its declared feature and downstream graph. Update related docs, roadmap status, root/feature flows and tests in the same work. When an item remains applicable, record unchanged with a concrete reason. Shared root changes invalidate multiple feature synchronization records; rerun relevant tests and refresh those records. Hash freshness is a gate, not proof of semantic consistency.
