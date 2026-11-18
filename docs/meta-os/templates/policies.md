# Policies — orders.create

| Policy | Value |
|---|---|
| rbac | roles: customer, admin; scope: orders:write; customer may only reference own cart |
| idempotency | header Idempotency-Key; window 24h; replay returns original 201; mismatched body -> 409 |
| transaction | one transaction spanning OrderRepository.insert and OutboxRepository.insert |
| queries | max 4 statements; N+1 banned; cart lines loaded with a single join |
| latency_p95_ms | 120 |
| rate_limit | 60/min per user |
| pii | shippingAddressId only; never log address payloads |

## Invariants

- An order is never persisted without its `order.created` outbox event in the same transaction.
- `totalCents` equals `PricingService.quote` for the cart snapshot at creation time.
- A replayed request never re-prices the cart or touches the outbox.
- The endpoint never returns 500 for client-caused states listed in the scenario table.

## Notes

- Keys in the policy table are fixed vocabulary consumed by adapters: `rbac`, `idempotency`,
  `transaction`, `queries`, `latency_p95_ms`, `rate_limit`, `pii`. Add project-specific keys
  freely; adapters ignore keys they do not understand and the reviewer still sees them.
