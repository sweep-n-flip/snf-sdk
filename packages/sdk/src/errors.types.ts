/**
 * SDK error taxonomy — type-only. See `errors.ts` for the `SnfError` class and the
 * helpers built on this union.
 */

/**
 * The closed, ASCII SCREAMING_SNAKE union every public `SnfError.code` belongs to.
 * Twelve members: DATASHEET §0.4 aligns several of these one-to-one (see each doc line
 * below); `QUOTE_RECONCILIATION_FAILED` and `USER_REJECTED` are a later addendum
 * (a divergence from DATASHEET needs a documented addendum, not a
 * silent extra code) — wallet rejection was split into its own code rather than folding
 * it into `INVALID_PARAMS`. Comparison is always strict string equality (`===`), never a
 * regex or case-fold (Edge `encoding`).
 */
export type SnfErrorCode =
  /** DATASHEET §0.4 `NO_ROUTE` (422) — no viable AMM path for the pay/receive token, or a cross-base NFT×NFT request. */
  | 'NO_ROUTE'
  /** DATASHEET §0.4 `TOKENIDS_UNAVAILABLE` (409) — pre-flight found tokenIds not redeemable/owned, or pool inventory unreadable. */
  | 'TOKENIDS_UNAVAILABLE'
  /** Later addendum (no DATASHEET row) — the Router's own on-chain quote diverges from the SDK's reconstructed breakdown by even 1 wei. Never absorbed silently — see the documented prohibitions table. */
  | 'QUOTE_RECONCILIATION_FAILED'
  /** SDK-only (no DATASHEET row) — the wrapper currently blocks releasing NFTs to a seller (`redemptionLocked`, Sell path). */
  | 'REDEMPTION_LOCKED'
  /** SDK-only (no DATASHEET row) — a wrapper's `collection()` disagrees with the requested address, or (Arc) its `decimals()` isn't 18 (`wrapperVerified`). */
  | 'WRAPPER_UNVERIFIED'
  /** DATASHEET §0.4 `UPSTREAM_DEGRADED` (503) — subgraph/RPC circuit breaker open, or indexer lag exceeds the degraded threshold. The only retryable code. */
  | 'UPSTREAM_DEGRADED'
  /** SDK-only (no DATASHEET row) — the `publicClient`'s chain doesn't match the connected wallet's chain at pre-flight. */
  | 'WRONG_CHAIN'
  /** Named after the Router's own revert string — a swap would execute below its `amountOutMin`/`amountInMax` bound (`parseReceipt`, `describeError`). */
  | 'INSUFFICIENT_OUTPUT_AMOUNT'
  /** DATASHEET §0.4 `PRODUCT_NOT_LIVE` (501) — a draft-gated surface (e.g. multipool `strategy`) requested before its contracts deploy. */
  | 'PRODUCT_NOT_LIVE'
  /** DATASHEET §0.4 `INVALID_PARAMS` (400) — validation failed; `details` names which field/reason. The SDK's most common code — `assertParam` throws it. */
  | 'INVALID_PARAMS'
  /** Later addendum (no DATASHEET row; added when wallet-rejection handling became its own code) — the connected wallet rejected the signature request. */
  | 'USER_REJECTED'
  /** Catch-all, analogous to DATASHEET §0.4 `INTERNAL` (500) — an unrecognised throwable was wrapped by `toSnfError`, or an unimplemented stub function was called. */
  | 'UNKNOWN'

/**
 * Partner-facing diagnostic payload only — chain ids, counts, addresses the caller
 * already supplied. Never wallet-derived data, and never transmitted anywhere:
 * this SDK has no telemetry sink.
 */
export interface SnfErrorDetails {
  readonly [key: string]: unknown
}

/**
 * Options accepted by the `SnfError` constructor beyond `code`/`message`.
 */
export interface SnfErrorOptions {
  readonly details?: SnfErrorDetails
  readonly cause?: unknown
}

/**
 * Whether a caller may reasonably retry the same call unchanged. Only
 * `UPSTREAM_DEGRADED` (an open circuit breaker / stale indexer) is retryable — every
 * other code reflects a request that will fail again unless something about the
 * request itself changes. `SnfError` derives `retryable` from this map; a caller can
 * never pass a conflicting value.
 */
export const SNF_ERROR_RETRYABLE: Readonly<Record<SnfErrorCode, boolean>> = {
  NO_ROUTE: false,
  TOKENIDS_UNAVAILABLE: false,
  QUOTE_RECONCILIATION_FAILED: false,
  REDEMPTION_LOCKED: false,
  WRAPPER_UNVERIFIED: false,
  UPSTREAM_DEGRADED: true,
  WRONG_CHAIN: false,
  INSUFFICIENT_OUTPUT_AMOUNT: false,
  PRODUCT_NOT_LIVE: false,
  INVALID_PARAMS: false,
  USER_REJECTED: false,
  UNKNOWN: false,
}
