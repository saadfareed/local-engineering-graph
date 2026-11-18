# Reference Framework Adapters

An adapter translates one universal bundle (`spec.md` + `policies.md` + `tests.md`) into idiomatic
framework files without touching the OS core or the Apidog pipeline. Manifests follow
[`src/schema/adapter-manifest.schema.json`](../../../src/schema/adapter-manifest.schema.json); the
stack selector reads their `selection.strengths`, the bus reads their `verifiers`, and the adapter
compiler (brief 07) reads `layers` + `policyBindings` + `typeMap`.

| Adapter | Manifest | Layout | Verifiers |
|---|---|---|---|
| FastAPI | [fastapi/adapter.json](fastapi/adapter.json) | `app/<domain>/{models,schemas,repository,service,router}.py`, `tests/<domain>/test_<endpoint>.py` | pytest, mypy, call-graph (python AST), openapi-diff, query-count |
| NestJS | [nestjs/adapter.json](nestjs/adapter.json) | `src/<domain>/{<resource>.entity,dto/<endpoint>.dto,<resource>.repository,<resource>.service,<resource>.controller,<domain>.module}.ts`, `src/<domain>/__tests__/<endpoint>.spec.ts` | jest, tsc, call-graph (TS AST), openapi-diff, query-count |

Adding Django/DRF, Go/Fiber, Spring Boot or Laravel means writing one manifest with the same
seven roles (`model`, `schema`, `repository`, `service`, `controller`, `wiring`, `test`) and the
seven policy keys; nothing else changes. Install-time location is `~/.engineering-os/adapters/<id>/`
(overrides the package copies under `docs/meta-os/adapters/`).

## Compilation contract

Template variables available to every layer template:

| Variable | Example (orders.create) |
|---|---|
| `{domain}` / `{Domain}` | `orders` / `Orders` |
| `{endpoint}` / `{Endpoint}` | `create` / `Create` (the part after the last `.` in the id) |
| `{resource}` / `{Resource}` | `order` / `Order` (singular of the domain unless `spec.meta.resource` overrides) |
| `{endpointId}`, `{method}`, `{path}` | `orders.create`, `POST`, `/v1/orders` |
| `{requestFields}` / `{responseFields:<status>}` | typed field lists from the JSON schemas through `typeMap` |
| `{scenarios}` | the parsed Scenario Call Graph rows |
| `{policy:<key>}` | the raw `policies.md` value for that key |
| `{tests}` | parsed `tests.md` cases with assertions |

`mergeStrategy: regenerate-block` means the compiler owns a region delimited by
`# >>> engineering-os:<endpointId> >>>` / `# <<< engineering-os:<endpointId> <<<` (or `//` for
TypeScript) inside a shared file and leaves hand-written code outside the markers untouched.
`overwrite` is used for per-endpoint test files, which are always regenerated from `tests.md`.

The call-graph verifier reads `callGraphSymbols` of every layer, expands the templates, and
checks that each `Calls` chain in `spec.md` resolves to symbols that exist in the generated code
and that the actual call order inside the service matches the chain. The `Mutations` column is
checked against repository/ORM writes inside the declared transaction boundary.

## Worked example: `orders.create` compiled twice

Source bundle: [`../templates/spec.md`](../templates/spec.md),
[`policies.md`](../templates/policies.md), [`tests.md`](../templates/tests.md).

### FastAPI output

`app/orders/schemas.py` (layer `schema`, regenerate-block)

```python
# >>> engineering-os:orders.create >>>
import uuid
from pydantic import BaseModel, Field, ConfigDict

class CreateIn(BaseModel):
    model_config = ConfigDict(extra="forbid")
    cartId: uuid.UUID
    shippingAddressId: uuid.UUID
    couponCode: str | None = Field(default=None, max_length=32)

class CreateOut(BaseModel):
    id: uuid.UUID
    status: Literal["pending"]
    totalCents: int = Field(ge=0)
    currency: str = Field(pattern=r"^[A-Z]{3}$")
# <<< engineering-os:orders.create <<<
```

`app/orders/service.py` (layer `service`; policies `transaction` + `idempotency` bound)

```python
# >>> engineering-os:orders.create >>>
class OrderService:
    def __init__(self, session, carts: CartRepository, pricing: PricingService,
                 orders: OrderRepository, outbox: OutboxRepository, idempotency: IdempotencyStore): ...

    async def create(self, actor: Actor, body: CreateIn, idempotency_key: str) -> CreateOut:
        # S2/S5: IdempotencyStore.lookup
        replay = await self.idempotency.lookup(actor.id, idempotency_key, body_hash(body))
        if replay.hit:
            return replay.response                      # S2 -> 201 (original)
        if replay.mismatch:
            raise Problem(409, "IDEMPOTENCY_MISMATCH")  # S5
        cart = await self.carts.get(actor.id, body.cartId)   # CartRepository.get
        if cart is None:
            raise Problem(404, "CART_NOT_FOUND")        # S4
        if not cart.lines:
            raise Problem(400, "EMPTY_CART")            # S3
        quote = await self.pricing.quote(cart)          # PricingService.quote
        async with self.session.begin():                # policy: transaction
            order = await self.orders.insert(Order.from_cart(cart, quote))      # Order(INSERT)
            await self.outbox.insert(OutboxEvent.order_created(order))          # OutboxEvent(INSERT)
        out = CreateOut.model_validate(order, from_attributes=True)
        await self.idempotency.store(actor.id, idempotency_key, body_hash(body), 201, out)
        return out
# <<< engineering-os:orders.create <<<
```

`app/orders/router.py` (layer `controller`; policies `rbac`, `idempotency`, `rate_limit` bound)

```python
# >>> engineering-os:orders.create >>>
@router.post("/v1/orders", status_code=201, response_model=CreateOut, operation_id="orders.create",
             responses={400: {"model": Problem}, 404: {"model": Problem}, 409: {"model": Problem}})
@rate_limited("60/min")
async def create(body: CreateIn,
                 actor: Actor = Depends(require_scopes("orders:write")),
                 idempotency_key: str = Depends(idempotency_key(window_hours=24)),
                 service: OrderService = Depends(get_order_service)) -> CreateOut:
    return await service.create(actor, body, idempotency_key)
# <<< engineering-os:orders.create <<<
```

`tests/orders/test_create.py` (layer `test`, overwrite; one test per `tests.md` case)

```python
@pytest.mark.query_budget(4)                                   # policy: queries
async def test_T1_creates_an_order(client, seed, query_counter):   # S1
    r = await client.post("/v1/orders", json={"cartId": "c-1", "shippingAddressId": "a-1"},
                          headers={"Idempotency-Key": "k-1", **seed.auth("customer")})
    assert r.status_code == 201
    body = r.json(); assert body["status"] == "pending" and body["currency"] == "USD"
    assert isinstance(body["id"], str) and body["totalCents"] >= 1
    assert seed.count("Order") == 1 and seed.count("OutboxEvent") == 1      # sideEffects

async def test_T2_replays_idempotently(client, seed):          # S2 … sameBodyAs T1, sideEffects 0/0
async def test_T3_rejects_an_empty_cart(client, seed):         # S3 → 400 EMPTY_CART
async def test_T4_rejects_an_unknown_cart(client, seed):       # S4 → 404 CART_NOT_FOUND
async def test_T5_detects_idempotency_key_reuse(client, seed): # S5 → 409 IDEMPOTENCY_MISMATCH
```

### NestJS output

`src/orders/dto/create.dto.ts` (layer `dto`, overwrite)

```ts
export class CreateDto {
  @IsUUID() cartId!: string;
  @IsUUID() shippingAddressId!: string;
  @IsOptional() @IsString() @MaxLength(32) couponCode?: string;
}
export class CreateResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ enum: ['pending'] }) status!: 'pending';
  @ApiProperty({ minimum: 0 }) totalCents!: number;
  @ApiProperty({ pattern: '^[A-Z]{3}$' }) currency!: string;
}
```

`src/orders/order.service.ts` (layer `service`)

```ts
// >>> engineering-os:orders.create >>>
async create(actor: Actor, body: CreateDto, idempotencyKey: string): Promise<CreateResponseDto> {
  const replay = await this.idempotency.lookup(actor.id, idempotencyKey, bodyHash(body)); // S2/S5
  if (replay.hit) return replay.response;
  if (replay.mismatch) throw new ProblemException(409, 'IDEMPOTENCY_MISMATCH');
  const cart = await this.carts.get(actor.id, body.cartId);                              // CartRepository.get
  if (!cart) throw new ProblemException(404, 'CART_NOT_FOUND');                           // S4
  if (cart.lines.length === 0) throw new ProblemException(400, 'EMPTY_CART');             // S3
  const quote = await this.pricing.quote(cart);                                           // PricingService.quote
  const order = await this.dataSource.transaction(async (manager) => {                    // policy: transaction
    const created = await this.orders.insert(manager, Order.fromCart(cart, quote));       // Order(INSERT)
    await this.outbox.insert(manager, OutboxEvent.orderCreated(created));                 // OutboxEvent(INSERT)
    return created;
  });
  const out = CreateResponseDto.from(order);
  await this.idempotency.store(actor.id, idempotencyKey, bodyHash(body), 201, out);
  return out;
}
// <<< engineering-os:orders.create <<<
```

`src/orders/order.controller.ts` (layer `controller`)

```ts
// >>> engineering-os:orders.create >>>
@Post('/v1/orders') @HttpCode(201)
@ApiOperation({ operationId: 'orders.create', summary: 'Create an order from a priced cart' })
@ApiResponse({ status: 201, type: CreateResponseDto }) @ApiResponse({ status: 400, type: ProblemDto })
@ApiResponse({ status: 404, type: ProblemDto }) @ApiResponse({ status: 409, type: ProblemDto })
@Scopes('orders:write') @UseGuards(ScopesGuard, ThrottlerGuard) @Throttle({ default: { limit: 60, ttl: 60_000 } })
@UseInterceptors(IdempotencyInterceptor.withWindow(24 * 3600))
async create(@CurrentActor() actor: Actor, @Body() body: CreateDto,
             @Headers('idempotency-key') idempotencyKey: string): Promise<CreateResponseDto> {
  return this.service.create(actor, body, idempotencyKey);
}
// <<< engineering-os:orders.create <<<
```

`src/orders/__tests__/create.spec.ts` (layer `test`, overwrite) mirrors T1–T5 with supertest,
a `queryBudget(4)` helper around the TypeORM logger and row-count assertions for `sideEffects`.

### What both outputs have in common (and what the verifiers check)

- Every `Calls` chain in the scenario table (`OrderService.create -> CartRepository.get ->
  PricingService.quote -> OrderRepository.insert -> OutboxRepository.insert`) resolves to symbols
  declared by the adapter's `callGraphSymbols` and appears in that order in the service body.
- Both `Mutations` happen inside the transaction boundary named in `policies.md`.
- `operationId` equals the endpoint id, so `openapi-diff` can compare the framework's generated
  OpenAPI against `.engineering/apidog/openapi.json` per operation.
- Test names carry the `T<n>` id, so a failing framework test and a failing Apidog item point at
  the same `tests.md` row and the same scenario `S<n>`.
