# Shop Purchases Runbook

Operational runbook for shop purchase writes. This document reflects ADR-001
(shop-api is the authoritative write store; the backend is a BFF that proxies
purchase writes) and ADR-003 (identity translation between backend users and
shop-api users).

## Ownership model (ADR-001)

- `shop-api` owns the purchase ledger and inventory. It is the single source of
  truth for purchase writes.
- The backend `POST /shop/purchase` endpoint is a BFF: it performs authz, then
  proxies the write to shop-api. It does **not** insert a local purchase row on
  the success path when the proxy flag is enabled.
- Field mapping between backend and shop-api payloads lives in
  `docs/SHOP_ARCHITECTURE.md` and ADR-003. Do not duplicate that mapping here.

## Authoritative write path (ADR-001 / ADR-003)

Purchase writes flow through exactly one path:

the single source of
  truth for purchase writes.
- The backend `POST /shop/purchase` endpoint is a BFF: it performs authz, then
  proxies the write to shop-api. It does **not** insert a local purchase row on
  the success path when the proxy flag is enabled.
- Field mapping between backend and shop-api payloads lives in
  `docs/SHOP_ARCHITECTURE.md` and ADR-003. Do not duplicate that mapping here.

## Authoritative write path (ADR-001 / ADR-003)

Purchase writes flow through exactly one path:

1. Client → backend `POST /shop/purchase` (authz + DTO validation).
2. Backend → shop-api `POST /purchases` (authoritative write).
3. shop-api validates, adjusts inventory atomically, and returns the purchase.
4. Backend returns the shop-api response to the client unchanged.

There is no backend read model for purchases; reads are proxied to shop-api so
inventory and ledger never diverge. When `SHOP_PROXY_WRITES=false`, the legacy
local write path is used instead and shop-api is not consulted for writes.

### 4. Duplicate Purchase Reports (Idempotency)
`POST /shop/purchase` **requires** an `Idempotency-Key` header and is wrapped with
`IdempotencyInterceptor` (`src/modules/redis/idempotency.interceptor.ts`) to ensure
exactly-once semantics matching `shop-api`'s implementation:

#### Idempotency Header
-   **Header Name**: `Idempotency-Key` (case-insensitive for `idempotency-key` and `x-idempotency-key`)
-   **Requirement**: Required for all purchase requests
-   **Format**: Any unique string, typically UUID (e.g., `550e8400-e29b-41d4-a716-446655440000`)
-   **Max Length**: 255 characters

#### State Machine
-   **Claim**: On a new key, the request is marked `processing` in Redis (`idempotency:<key>`, 24h TTL) before the handler runs.
-   **Complete**: On success, the response is cached and replayed (with `X-Idempotency-Replayed: true` header) for any repeat request using the same key.
-   **Fail**: If the handler throws, the key is deleted so the client can safely retry with the same key.

#### Response Scenarios

| Scenario | Status | Header | Behavior |
|----------|--------|--------|----------|
| **First request** | 201 | None | Purchase processed; item added to inventory |
| **Duplicate (completed)** | 201 | `X-Idempotency-Replayed: true` | Cached response replayed; no new charge |
| **Duplicate (in-flight)** | 409 | None | Original request still processing; client must retry |
| **No Idempotency-Key** | 201 | None | Not deduplicated; each request processes independently |

#### Examples

**First purchase request** (success):
```bash
curl -X POST http://localhost:3000/shop/purchase \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -H "Content-Type: application/json" \
  -d '{
    "shop_item_id": 42,
    "quantity": 1,
    "coupon_code": "SAVE10"
  }'
```

Response (201 Created):
```json
{
  "id": 123,
  "user_id": 456,
  "shop_item_id": 42,
  "quantity": 1,
  "final_price": "9.99",
  "status": "completed",
  "created_at": "2026-08-26T10:30:00Z"
}
```

**Duplicate request (replay)** — same Idempotency-Key, original has completed:
```bash
curl -X POST http://localhost:3000/shop/purchase \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -H "Content-Type: application/json" \
  -d '{
    "shop_item_id": 42,
    "quantity": 1,
    "coupon_code": "SAVE10"
  }'
```

Response (201 Created, **X-Idempotency-Replayed: true**):
```
X-Idempotency-Replayed: true
```
```json
{
  "id": 123,
  "user_id": 456,
  "shop_item_id": 42,
  "quantity": 1,
  "final_price": "9.99",
  "status": "completed",
  "created_at": "2026-08-26T10:30:00Z"
}
```
**Note**: Same response body and purchase ID; no new charge; item not added again.

**Concurrent duplicate request** — same Idempotency-Key, original still in-flight:
```bash
curl -X POST http://localhost:3000/shop/purchase \
  -H "Authorization: Bearer <TOKEN>" \
  -H "Idempotency-Key: 550e8400-e29b-41d4-a716-446655440000" \
  -H "Content-Type: application/json" \
  -d '{
    "shop_item_id": 42,
    "quantity": 1
  }'
```

Response (409 Conflict):
```json
{
  "statusCode": 409,
  "message": "Request is still being processed",
  "error": "Conflict"
}
```
**Action**: Client should wait 1–5 seconds and retry, or use a different `Idempotency-Key` for a new purchase.

#### Troubleshooting
If a user reports being charged twice for what they believe was one click:
1.  **Check client logs** for the `Idempotency-Key` sent on both requests.
2.  **If same key**: The second request should have been idempotent. Check audit logs to confirm if two distinct purchase records were created or if the second was a replay.
3.  **If different keys**: This is expected behavior — two independent purchases with two different keys are not deduplicated (see Section 1 for refund procedures).

### 5. Feature Flags: Shop Proxy Games WS & Stellar UI Gate
Feature flags are evaluated **server-side only** and are **deny-by-default**: any flag
that is unknown, unset, or whose backing store (Postgres/Redis) is unreachable
resolves to **disabled**. Clients must never be trusted to decide flag state.

#### Flags
| Flag | Gates | Default |
|------|-------|---------|
| `shop_proxy_games_ws` | Shop proxy games WebSocket surface | `false` |
| `stellar_ui` | Stellar chain UI (per ADR-003) | `false` |

#### ADR-003: NEAR is the only supported chain UI
Until `stellar_ui` is **explicitly enabled** server-side, NEAR remains the only
supported chain UI. Do not surface Stellar wallet/chain affordances in the UI based
on client state, query params, or local storage — always read the server flag.

#### Read path (frontend)
The frontend determines Stellar UI availability via the server read endpoint
(no client-trusted state):
```bash
curl http://localhost:3000/feature-flags \
  -H "Authorization: Bearer <TOKEN>"
```
Response (200 OK):
```json
{
  "shop_proxy_games_ws": false,
  "stellar_ui": false
}
```

#### Fail-closed behavior
-   **Postgres/Redis outage**: flag evaluation returns `false` for every flag; the
    shop proxy games WS surface stays closed and the Stellar UI gate stays hidden.
-   **Unknown flag name**: resolves to `false` (never throws, never defaults to on).
-   **Write paths**: if the flag store is unavailable, writes fail closed rather than
    proceeding with an assumed-enabled state.

#### Troubleshooting
If a flag appears stuck:
1.  **Verify store health**: confirm Postgres and Redis are reachable from the backend.
2.  **Check the read endpoint**: `GET /feature-flags` should reflect the intended state.
3.  **Confirm deny-by-default**: an unreachable store intentionally reports `false`;
    restore the dependency before expecting the flag to flip.
4.  **Never** enable `stellar_ui` without an explicit readiness decision per ADR-003.

## Feature flag: `SHOP_PROXY_WRITES`

| Value   | Behavior                                                                 |
| ------- | ------------------------------------------------------------------------ |
| `true`  | Backend proxies all purchase writes to shop-api. Local purchase insert is skipped on the success path. Fail closed if shop-api is unavailable. |
| `false` | Legacy local write path is used. Proxy client is not consulted for writes. |

### Kill switch

When `SHOP_PROXY_WRITE

## Feature flag: `SHOP_PROXY_WRITES`

| Value   | Behavior                                                                 |
| ------- | ------------------------------------------------------------------------ |
| `true`  | Backend proxies all purchase writes to shop-api. Local purchase insert is skipped on the success path. Fail closed if shop-api is unavailable. |
| `false` | Legacy local write path is used. Proxy client is not consulted for writes. |

### Kill switch

When `SHOP_PROXY_WRITES=true`, the backend refuses to fall back to a local
purchase insert. If shop-api is down or the circuit breaker is open, the request
fails closed with an error that includes the `requestId`. This prevents dual
writes and divergent inventory.

To roll back the cutover, set `SHOP_PROXY_WRITES=false` and redeploy/restart the
backend so the flag is re-read. No data migration is required because shop-api
remains authoritative for any writes it already accepted.

## ShopApiClient

- Request timeouts are enforced on every call.
- Retries are limited to safe reads only. Purchase writes are never retried
  blindly; idempotency is handled via the `Idempotency-Key` header.
- A circuit breaker opens after repeated failures and fails closed for writes
  while `SHOP_PROXY_WRITES=true`.

## Service authentication and API-key rotation

- Service-to-service calls to shop-api authenticate with an API key only. No
  user bearer token is ever forwarded to shop-api; the backend translates
  identity per ADR-003 and presents its own service credential.
- The API key is read from configuration/secret storage at call time. It is
  never hard-coded, committed, or logged.
- **Rotation**: shop-api accepts the current key and the previous key during a
  rotation window so the backend can roll without downtime. Rotate by issuing a
  new key, deploying it to the backend, then retiring the old key after the
  window closes.
- If shop-api rejects the key (`401`/`403`), the backend fails closed for
  writes and surfaces the error with the `requestId`; it does not retry with a
  stale key or fall back to a local write.
- Monitor auth failures from the proxy (`shop_proxy_errors` labeled by cause);
  a spike right after a rotation usually means the new key was not deployed
  everywhere.

## Identity translation (ADR-003)

- Backend `userId` strings are translated to shop-api users via the identity
  translator.
- Cross-reference IDs are stored so a backend user can be resolved to its
  shop-api counterpart and vice versa.
- Never trust a client-supplied price as final; shop-api validates amounts.

## Purchase field translation (ADR-003)

Backend and shop-api use different representations for the same purchase
fields. The translator is the only place that converts between them; do not
coerce these fields ad hoc in controllers or clients.

| Field        | Backend representation        | shop-api representation        |
| ------------ | ----------------------------- | ------------------------------ |
| `userId`     | UUID string                   | integer user id                |
| `sku`        | SKU string                    | SKU string (unchanged)         |
| `quantity`   | positive integer              | positive integer (unchanged)   |
| `unitAmount` | integer minor units (cents)   | integer minor units (cents)    |
| `totalAmount`| integer minor units (cents)   | integer minor units (cents)    |

Rules:

- Money is always integer minor units on the wire. Never send floats or
  decimal strings; the backend rejects them before proxying.
- `totalAmount` is derived server-side as `unitAmount * quantity`; a
  client-supplied total is ignored and never trusted.
- UUID↔int translation is deterministic and idempotent: the same backend UUID
  always maps to the same shop-api integer id, and vice versa.
- Unknown fields are rejected by DTO validation (`forbidNonWhitelisted`) so
  spoofed or extra fields cannot reach shop-api.

## Idempotency

- Clients send an `Idempotency-Key` header on every purchase write.
- The backend hashes the request body and forwards both the key and the hash to
  shop-api.
- On replay with the same key and identical body hash, shop-api returns the
  stored response and the backend returns it unchanged (no second purchase).
- On replay with the same key but a different body hash, shop-api returns `409`
  and the backend surfaces the conflict; the original purchase is not modified.
- Idempotency records have a TTL. After expiry, a reused key is treated as a new
  request; clients must not reuse keys across distinct purchases.

### Postgres idempotency store

- shop-api persists idempotency records in Postgres (the authoritative store),
  keyed by `Idempotency-Key` with the request body hash and the stored response.
- A record is written in the same transaction as the purchase insert and the
  inventory adjustment, so a crash cannot leave a purchase without its
  idempotency record (or vice versa).
- The store is the source of truth for replay and conflict decisions; the
  backend does not keep its own idempotency cache for purchase writes.

### Cleanup job

- A scheduled cleanup job removes expired idempotency records so the table does
  not grow unbounded.
- The job deletes only records whose TTL has elapsed; unexpired records are
  never removed, so in-window replays and 409 conflicts keep working.
- Cleanup runs on a fixed interval and is safe to run concurrently with live
  traffic (deletes are scoped to expired rows).
- After a record is cleaned up, a reused key is treated as a new request. This
  is the same behavior as TTL expiry; clients must not reuse keys across
  distinct purchases.
- Monitor cleanup job runs and the idempotency table size; a stalled job is a
  capacity risk, not a correctness risk (expired rows are still ignored on
  read).

## Inventory side-effects

- Inventory is adjusted atomically inside shop-api in the same transaction as
  the purchase insert, so concurrent buys of the same SKU cannot oversell.
- Inventory is never allowed to go negative; a purchase that would drive stock
  below zero is rejected and no ledger row is written.
- A catalog edit during an in-flight purchase does not change the price or
  quantity already validated for that request; the purchase uses the values
  captured at validation time.

## Request correlation

- `Idempotency-Key` is propagated end-to-end so shop-api can replay a 409 for a
  duplicate key instead of creating a second purchase.
- `X-Request-Id` is propagated end-to-end and included in error responses and
  logs for tracing.
- The backend generates a `requestId` when the client does not supply one and
  forwards it to shop-api on every proxy call. shop-api echoes it back and
  includes it in its own error responses, so a single id traces the request
  across both services.
- Error responses follow `docs/API_ERROR_RESPONSE_STANDARDS.md` and always
  carry the `requestId` so operators can correlate a client report with logs.

## Logging and redaction

- Never log secrets: API keys, bearer tokens, `Authorization` headers, and
  `Idempotency-Key` values are redacted before they reach any log sink.
- Redaction is applied centrally (logger/interceptor level) so new call sites
  inherit it; do not log raw request headers ad hoc.
- Avoid PII in telemetry. Metric labels use bounded, non-identifying values
  (outcome, cause, status code) — never user ids, emails, SKUs, or raw URLs.
- `requestId` is safe to log and is the preferred correlation field; it is not
  a secret and carries no PII.

## Metrics

| Metric                    | Meaning                                              |
| ------------------------- | ---------------------------------------------------- |
| `shop_proxy_latency`      | Latency of backend → shop-api proxy calls.           |
| `shop_proxy_errors`       | Errors from proxy calls, labeled by cause.           |
| `dual_write_blocked_total`| Count of local writes refused by the kill switch.    |
| `shop_purchase_total`     | Purchase writes, labeled by outcome (success/conflict/error). |
| `shop_purchase_idempotent_replay_total` | Replays served from a stored idempotent response. |
| `shop_idempotency_cleanup_deleted_total` | Expired idempotency records removed by the cleanup job. |

## Failure modes

- **shop-api 409 replay**: treated as a successful idempotent replay; the
  existing purchase is returned.
- **shop-api 409 conflict**: same key, different body hash; surfaced as a
  conflict and the original purchase is left untouched.
- **shop-api 401/403 (bad or rotated key)**: fail closed for writes; surfaced
  with the `requestId`. Check that the current API key is deployed everywhere.
- **Timeout after client retry**: surfaced as
