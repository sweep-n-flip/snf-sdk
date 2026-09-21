/**
 * Types for the offline estimate layer (`math/nftPricing.ts`) — R12; 54-SPEC.md.
 *
 * Every result this layer produces is labelled `kind: 'estimate'` at the top level,
 * with no variant that omits it. See `nftPricing.ts`'s own header for why: this layer
 * is derived from a point-in-time `reserves` read and must never feed a transaction
 * bound (`build/`'s `Bounds`/`amountOutMin`/`amountInMax` always come from a fresh
 * on-chain re-quote — RESEARCH § "Anti-Patterns to Avoid").
 */

/** Pool-side reserves as read from `Pair.getReserves()`, already resolved to the
 * wrapper/base side (never assume token0/token1 — CLAUDE.md). */
export interface Reserves {
  readonly base: bigint
  readonly wnft: bigint
}

/** One unit's position in an `estimateLadder` result. `unitCost` is the marginal cost
 * of THIS unit (the atomic k-unit cost minus the atomic (k-1)-unit cost, both from the
 * same untouched `reserves` — never a sequentially-depleted simulation, see
 * `nftPricing.ts`'s header for why). `cumulative` is the running total through this
 * point, always equal to `nftBuyCost(reserves, index)`. */
export interface LadderPoint {
  readonly index: number
  readonly unitCost: bigint
  readonly cumulative: bigint
}

/** Output of `estimateLadder`. `kind: 'estimate'` on every path — there is no variant
 * that omits it. `reason: 'no-liquidity'` marks an empty pool (`points: []`, distinct
 * from `n === 0`, which is also `points: []` but carries no `reason`). `truncated` is
 * true when `n` exceeded the available count (the curve's own limit, or the caller's
 * `availableCount` override) and the ladder was cut short. */
export interface LadderResult {
  readonly points: readonly LadderPoint[]
  readonly total: bigint
  readonly kind: 'estimate'
  readonly truncated: boolean
  readonly reason?: 'no-liquidity'
}
