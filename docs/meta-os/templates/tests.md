# Tests — orders.create

## T1 creates an order (S1)

- Given: an authenticated customer whose cart `c-1` has two priced lines
- When: POST /v1/orders with body `{"cartId":"c-1","shippingAddressId":"a-1"}` and a fresh Idempotency-Key
- Then: status 201 and the body carries a pending order with the quoted total

```json assert
{
  "request": {"headers": {"Idempotency-Key": "k-1"}, "body": {"cartId": "c-1", "shippingAddressId": "a-1"}},
  "status": 201,
  "body": {"status": "pending", "currency": "USD"},
  "jsonpath": {"$.id": {"type": "string"}, "$.totalCents": {"minimum": 1}},
  "sideEffects": {"Order": 1, "OutboxEvent": 1}
}
```

## T2 replays idempotently (S2)

- Given: T1 has completed with Idempotency-Key `k-1`
- When: the same request is sent again with Idempotency-Key `k-1`
- Then: status 201 with an identical body and no new rows

```json assert
{"request": {"headers": {"Idempotency-Key": "k-1"}, "body": {"cartId": "c-1", "shippingAddressId": "a-1"}}, "status": 201, "sameBodyAs": "T1", "sideEffects": {"Order": 0, "OutboxEvent": 0}}
```

## T3 rejects an empty cart (S3)

- Given: an authenticated customer whose cart `c-empty` has no lines
- When: POST /v1/orders with `{"cartId":"c-empty","shippingAddressId":"a-1"}`
- Then: status 400 with problem code EMPTY_CART

```json assert
{"request": {"body": {"cartId": "c-empty", "shippingAddressId": "a-1"}}, "status": 400, "body": {"code": "EMPTY_CART"}}
```

## T4 rejects an unknown cart (S4)

- Given: an authenticated customer
- When: POST /v1/orders with a cartId that does not belong to the caller
- Then: status 404 with problem code CART_NOT_FOUND

```json assert
{"request": {"body": {"cartId": "c-unknown", "shippingAddressId": "a-1"}}, "status": 404, "body": {"code": "CART_NOT_FOUND"}}
```

## T5 detects idempotency-key reuse with a different body (S5)

- Given: T1 has completed with Idempotency-Key `k-1`
- When: a request with a different body is sent with Idempotency-Key `k-1`
- Then: status 409 with problem code IDEMPOTENCY_MISMATCH

```json assert
{"request": {"headers": {"Idempotency-Key": "k-1"}, "body": {"cartId": "c-2", "shippingAddressId": "a-1"}}, "status": 409, "body": {"code": "IDEMPOTENCY_MISMATCH"}}
```

## Notes

- Heading format is fixed: `## T<n> <title> (S<n>)` binds each behavioural test to a scenario
  row in `spec.md`. The exporter refuses tests that reference a scenario the spec does not define.
- Assertion keys: `request` (`headers`, `path`, `body` actually sent), `status`, `body` (subset
  match), `jsonpath` (per-path JSON-schema fragment), `sameBodyAs`, `sideEffects` (row deltas per model). Adapters translate these into framework
  tests; the Apidog exporter translates `status`, `body` and `jsonpath` into Apidog assertions.
