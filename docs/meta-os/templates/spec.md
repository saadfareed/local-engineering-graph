# orders.create — POST /v1/orders

| Field | Value |
|---|---|
| id | orders.create |
| domain | orders |
| method | POST |
| path | /v1/orders |
| summary | Create an order from a priced cart |
| adapter | fastapi |
| version | 1 |
| owner | billing-team |
| tags | orders, checkout, idempotent |

## Use case

A customer confirms checkout. The endpoint prices the cart, persists the order inside one
transaction and emits an `order.created` outbox event. Replays with the same `Idempotency-Key`
return the original response without side effects.

## Auth & Headers

| Header | Required | Description |
|---|---|---|
| Authorization | yes | Bearer JWT carrying scope `orders:write` |
| Idempotency-Key | yes | UUIDv4; replay window 24h |
| X-Request-Id | no | Propagated to logs and outbox event |

## Request

```json schema
{
  "type": "object",
  "required": ["cartId", "shippingAddressId"],
  "additionalProperties": false,
  "properties": {
    "cartId": {"type": "string", "format": "uuid"},
    "shippingAddressId": {"type": "string", "format": "uuid"},
    "couponCode": {"type": "string", "maxLength": 32}
  }
}
```

## Responses

### 201 Created

```json schema
{
  "type": "object",
  "required": ["id", "status", "totalCents", "currency"],
  "properties": {
    "id": {"type": "string", "format": "uuid"},
    "status": {"type": "string", "enum": ["pending"]},
    "totalCents": {"type": "integer", "minimum": 0},
    "currency": {"type": "string", "pattern": "^[A-Z]{3}$"}
  }
}
```

### 400 Bad Request

```json schema
{"$ref": "#/components/schemas/Problem"}
```

### 404 Not Found

```json schema
{"$ref": "#/components/schemas/Problem"}
```

### 409 Conflict

```json schema
{"$ref": "#/components/schemas/Problem"}
```

## Scenario Call Graph

| Scenario | Trigger | Calls | Mutations | Status | Response |
|---|---|---|---|---|---|
| S1 happy-path | valid cart, fresh Idempotency-Key | OrderService.create -> CartRepository.get -> PricingService.quote -> OrderRepository.insert -> OutboxRepository.insert | Order(INSERT); OutboxEvent(INSERT order.created) | 201 | Order |
| S2 idempotent-replay | same Idempotency-Key within 24h | IdempotencyStore.lookup | none | 201 | Order (original) |
| S3 empty-cart | cart has no lines | OrderService.create -> CartRepository.get | none | 400 | Problem(code=EMPTY_CART) |
| S4 missing-cart | cartId unknown for caller | OrderService.create -> CartRepository.get | none | 404 | Problem(code=CART_NOT_FOUND) |
| S5 key-reuse-conflict | same Idempotency-Key, different body | IdempotencyStore.lookup | none | 409 | Problem(code=IDEMPOTENCY_MISMATCH) |

## Notes

- Placeholders for a new endpoint: replace the H1, every metadata row, both schema blocks and
  the scenario table. Keep the heading names exactly; the kernel parser keys on them.
- `Calls` is an ordered chain separated by `->`. Use `Class.method` names that exist in the
  adapter's generated layers so the AST/call-graph checker can verify them.
- `Mutations` lists `Model(OPERATION ...)` entries separated by `;`, or `none`.
