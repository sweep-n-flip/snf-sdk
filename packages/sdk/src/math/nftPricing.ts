import { getAmountIn, getAmountOut, ONE_E18, SNF_NFT_NET_FEE } from './quoteMath'
import type { LadderPoint, LadderResult, Reserves } from './nftPricing.types'

/**
 * OFFLINE ESTIMATE LAYER — derived from a `reserves` snapshot only, never from a fresh
 * on-chain read of its own. Every exported result here is `kind: 'estimate'` (R12;
 * 54-SPEC.md) and MUST NEVER be used to derive a transaction bound: `build/`'s
 * `Bounds`/`amountOutMin`/`amountInMax` always come from a fresh on-chain re-quote
 * performed inside `build()`, never from this module's output
 * (RESEARCH § "Anti-Patterns to Avoid"; `test/prohibitions/no-ladder-in-build.test.ts`,
 * plan 17, statically enforces it by scanning `src/build/` for an import of this file).
 *
 * `nftBuyCost`/`nftSellProceeds` mirror the Router's own AMM curve exactly
 * (`SNF_NFT_NET_FEE = 9800`, `math/quoteMath.ts`) — the arithmetic is exact `bigint`,
 * identical to what the Router would return for the SAME reserves at the SAME block.
 * The reason this whole module is still labelled `estimate` is staleness, not
 * imprecision: `reserves` is a point-in-time read, and the pool may have moved by the
 * time a caller signs — never floats, never `+1e-18` fudge factors like the
 * `snf-client` float port this replaces (`snf-client/src/lib/nftPricing.ts`).
 *
 * `estimateLadder`'s per-unit breakdown is built by TELESCOPING the same atomic
 * `nftBuyCost` calls, not by simulating a sequence of real trades against
 * progressively-depleted reserves. The two are NOT the same number: splitting an
 * atomic n-unit purchase into n sequential trades pays the pool's `netFee` n times
 * instead of once, which is a genuine multi-percent economic difference on a shallow
 * pool (verified empirically this session — a 10-unit pool buying 5 diverged by
 * ~0.6%, far more than any rounding bound). Building each `LadderPoint.cumulative` as
 * `nftBuyCost(reserves, k)` on the SAME untouched `reserves` for every `k`, and each
 * `unitCost` as the difference of two consecutive cumulatives, is what makes
 * `estimateLadder(reserves, n).total` land within a few wei of `nftBuyCost(reserves,
 * n)` (R12's fast-check backstop, `test/math/ladder.property.test.ts`) while still
 * reporting a real, strictly-increasing marginal price per unit — verified strictly
 * increasing across 5000 random trials at this session's property-test generator
 * ranges before being locked in as this module's design.
 */

/** `getAmountIn(n * 1e18, reserves.base, reserves.wnft, SNF_NFT_NET_FEE)` — the exact
 * pool-only cost to buy `n` whole NFTs atomically. `undefined` for `n <= 0` or a `n`
 * the pool cannot fill (mirrors `getAmountIn`'s own guards). */
export function nftBuyCost(reserves: Reserves, n: number): bigint | undefined {
  if (!Number.isInteger(n) || n <= 0) return undefined
  return getAmountIn(BigInt(n) * ONE_E18, reserves.base, reserves.wnft, SNF_NFT_NET_FEE)
}

/** `getAmountOut(n * 1e18, reserves.wnft, reserves.base, SNF_NFT_NET_FEE)` — the exact
 * pool-only proceeds from selling `n` whole NFTs atomically. Sell reverses the
 * reserves: the wrapper side is `reserveIn`, the base side is `reserveOut`
 * (CLAUDE.md: "on the sell side the input reserve is the wrapper's"). `undefined` for
 * `n <= 0`. */
export function nftSellProceeds(reserves: Reserves, n: number): bigint | undefined {
  if (!Number.isInteger(n) || n <= 0) return undefined
  return getAmountOut(BigInt(n) * ONE_E18, reserves.wnft, reserves.base, SNF_NFT_NET_FEE)
}

/** `reserves.base * 1e18 / reserves.wnft` — the no-fee, no-curve mid-price (wei of
 * `base` per whole wrapped NFT), the nominal baseline cross-pool price-impact
 * calculations use (`docs/NFT_SWAP_RULES.md`: "spot price... no fees, no curve").
 * `undefined` on an empty pool. */
export function spotPrice(reserves: Reserves): bigint | undefined {
  if (reserves.base <= 0n || reserves.wnft <= 0n) return undefined
  return (reserves.base * ONE_E18) / reserves.wnft
}

/** The largest whole-NFT count the curve itself can ever fill from `wnft` — the pool
 * never sells its last unit (`getAmountIn`'s own `amountOut >= reserveOut` guard). */
function curveAvailableCount(wnft: bigint): number {
  if (wnft <= 0n) return 0
  return Number((wnft - 1n) / ONE_E18)
}

/**
 * The offline, `estimate`-labelled unit-price ladder for `n` NFTs from `reserves` —
 * R12. See this module's header for why each point is a telescoped atomic cost rather
 * than a simulated sequential purchase.
 *
 * `n <= 0` → `{ points: [], total: 0n, kind: 'estimate', truncated: false }`.
 * A pool with no liquidity → `{ points: [], total: 0n, kind: 'estimate',
 * truncated: false, reason: 'no-liquidity' }` — never a throw.
 * `opts.availableCount` overrides the curve's own limit (e.g. a caller who already
 * knows the real on-chain inventory count is smaller); `n` beyond whichever limit
 * applies returns exactly that many points with `truncated: true`.
 */
export function estimateLadder(
  reserves: Reserves,
  n: number,
  opts?: { readonly availableCount?: number },
): LadderResult {
  if (!Number.isInteger(n) || n <= 0) {
    return { points: [], total: 0n, kind: 'estimate', truncated: false }
  }
  if (reserves.base <= 0n || reserves.wnft <= 0n) {
    return { points: [], total: 0n, kind: 'estimate', truncated: false, reason: 'no-liquidity' }
  }

  const naturalAvailable = curveAvailableCount(reserves.wnft)
  const available = opts?.availableCount ?? naturalAvailable
  const cap = Math.min(n, available)

  const points: LadderPoint[] = []
  let cumulative = 0n
  let truncated = n > available
  for (let k = 1; k <= cap; k++) {
    const stepCumulative = nftBuyCost(reserves, k)
    if (stepCumulative === undefined) {
      truncated = true
      break
    }
    points.push({ index: k, unitCost: stepCumulative - cumulative, cumulative: stepCumulative })
    cumulative = stepCumulative
  }

  return { points, total: cumulative, kind: 'estimate', truncated }
}
