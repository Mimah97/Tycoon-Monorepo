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

## Failure modes

- **shop-api 409 replay**: treated as a successful idempotent replay; the
  existing purchase is returned.
- **Timeout after client retry**: surfaced as an error with `requestId`; the
  write is not retried locally.
- **Amount unit mismatch**: rejected by shop-api validation; the backend does
  not coerce client amounts.
- **Canary sticky by userId**: canary routing is sticky per `userId` so a user
  consistently hits the same path.
- **shop-api down**: with `SHOP_PROXY_WRITES=true`, the request fails closed.

## Security

- The backend ↔ shop-api API key is server-side only and never exposed to
  clients.
- Client-supplied prices are never trusted as final.
- Writes fail closed when the flag is on and shop-api is unavailable.

## Rollback notes

1. Set `SHOP_PROXY_WRITES=false`.
2. Restart/redeploy the backend to pick up the flag.
3. Confirm `dual_write_blocked_total` stops increasing and legacy writes resume.
4. Investigate shop-api health before re-enabling the proxy.
