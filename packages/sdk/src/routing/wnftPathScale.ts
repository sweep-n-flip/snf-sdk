import { ONE_E18 } from '../math/quoteMath'
import type { WnftScaleResult } from './routing.types'

/**
 * wNFT fractional-amount path scaling. Ported from the production AMM client's own
 * scaling logic, which scales a `number` display amount by whichever
 * decimal axis applies to each side of a path (`wnftPathDecimals`); this SDK layer
 * is the exact-`bigint` counterpart that turns a whole-NFT count into wrapper units
 * and back, since every SDK-internal amount is a `bigint`, never a display `number`.
 *
 * 1 NFT = 1e18 wrapper units (`10n ** 18n`, the same `ONE_E18` from
 * `math/quoteMath.ts`) — on EVERY chain, including Arc. This is the wrapper
 * (WERC721) contract's own `decimals()`, a fixed axis distinct from the pool's
 * *quote*-side decimals (`chains/units.ts`'s `getQuoteDecimals`, 6 on Arc, 18
 * elsewhere). Conflating the two axes is the 1e12 bug class `chains/units.ts`'s
 * header documents — this module only ever touches the wrapper's own fixed axis,
 * never the quote side.
 */

/** `BigInt(n) * 10n**18n` — the exact wrapper-unit amount for `n` whole NFTs.
 * Negative or non-finite `n` is clamped to `0` rather than thrown (this module has
 * no `SnfError` boundary of its own; a caller-side `assertParam` guards the public
 * quote/build args before `n` ever reaches here). */
export function wnftUnitsFromCount(n: number): bigint {
  const safeCount = Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0
  return BigInt(safeCount) * ONE_E18
}

/** `floor(units / 1e18)` — the whole-NFT count `units` wrapper-units represent.
 * `bigint` division already truncates toward zero, which is floor for any
 * non-negative `units` (the only domain this function is ever called with). */
export function countFromWnftUnits(units: bigint): number {
  if (units <= 0n) return 0
  return Number(units / ONE_E18)
}

/**
 * Splits a wrapper-unit amount into its whole-NFT count and the fractional
 * wrapper-unit remainder — the pair a "N NFTs + X wNFT remainder" display needs.
 * `wholeCount + remainderUnits` round-trips back to `units` exactly (no wei lost).
 */
export function scaleWnftAmount(units: bigint): WnftScaleResult {
  const wholeCount = countFromWnftUnits(units)
  const remainderUnits = units - wnftUnitsFromCount(wholeCount)
  return { wholeCount, remainderUnits }
}
