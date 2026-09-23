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

1. Client → backend `POST /shop/purchase` (authz + DTO validation).
2. Backend → shop-api `POST /purchases` (authoritative write).
3. shop-api validates, adjusts inventory atomically, and returns the purchase.
4. Backend returns the shop-api response to the client unchanged.

There is no backend read model for purchases; reads are proxied to shop-api so
inventory and ledger never diverge. When `SHOP_PROXY_WRITES=false`, the legacy
local write path is used instead and shop-api is not consulted for writes.

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

## Metrics

| Metric                    | Meaning                                              |
| ------------------------- | ---------------------------------------------------- |
| `shop_proxy_latency`      | Latency of backend → shop-api proxy calls.           |
| `shop_proxy_errors`       | Errors from proxy calls, labeled by cause.           |
| `dual_write_blocked_total`| Count of local writes refused by the kill switch.    |
| `shop_purchase_total`     | Purchase writes, labeled by outcome (success/conflict/error). |
| `shop_purchase_idempotent_replay_total` | Replays served from a stored idempotent response. |

## Failure modes

- **shop-api 409 replay**: treated as a successful idempotent replay; the
  existing purchase is returned.
- **shop-api 409 conflict**: same key, different body hash; surfaced as a
  conflict and the original purchase is left untouched.
- **Timeout after client retry**: surfaced as an error with `requestId`; the
  write is not retried locally.
- **Amount unit mismatch**: rejected by shop-api validation; the backend does
  not coerce client amounts.
- **Concurrent checkout, same SKU**: atomic inventory adjustment rejects the
  loser; inventory never goes negative.
- **Idempotency TTL expiry**: a reused key after expiry is a new request; see
  Idempotency above.
- **Canary sticky by userId**: canary routing is sticky per `userId` so a user
  consistently hits the same path.
- **shop-api down**: with `SHOP_PROXY_WRITES=true`, the request fails closed.

## Security

- The backend ↔ shop-api API key is server-side only and never exposed to
  clients.
- Client-supplied prices are never trusted as final.
- Writes fail closed when the flag is on and shop-api is unavailable.
- Admin catalog mutations are audited; new admin/WS surfaces are deny-by-default.

## Rollback notes

1. Set `SHOP_PROXY_WRITES=false`.
2. Restart/redeploy the backend to pick up the flag.
3. Confirm `dual_write_blocked_total` stops increasing and legacy writes resume.
4. Investigate shop-api health before re-enabling the proxy.
