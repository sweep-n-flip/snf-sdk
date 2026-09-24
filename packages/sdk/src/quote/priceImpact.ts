import { bpsToPercent } from '../format'
import { ONE_E18 } from '../math/quoteMath'
import { spotPrice } from '../math/nftPricing'
import type { Reserves } from '../math/nftPricing.types'

/**
 * Cross-pool / single-pool price impact (docs/NFT_SWAP_RULES.md).
 *
 * THE NOMINAL BASELINE IS THE SPOT (MID) PRICE — `reserveBase / reserveWnft` per pool,
 * no fees, no curve. The active fee policy (marketplace + royalty, when on) is layered
 * onto the nominal AND the actual side identically (`× (1 ± mpFee ± royaltyIfOn)`), so
 * toggling the royalty policy moves both sides by the same factor and the reported
 * impact does not change:
 *
 * priceImpact = clamp[0,100]((1 − actualReceive / nominalReceive) × 100)
 *
 * Two rejected alternatives (docs/NFT_SWAP_RULES.md):
 * 1. "Percentage of pool consumed" — exceeded 1000% on small pools; it measures pool
 * depth, not price impact, and was never a meaningful number.
 * 2. The atomic-unit curve estimate helpers (`math/nftPricing.ts`) as the nominal —
 * those already include the pool fee, the 1-unit curve impact, and a rounding
 * offset that can dominate the ratio on an asymmetric pool. Using either as
 * "nominal" double-counts the very curve effect this metric measures.
 *
 * The clamp is defence-in-depth, not cosmetics: impact cannot exceed 100% by
 * definition (you cannot receive less than nothing), so a value outside [0,100] means
 * an input was wrong — clamping and reporting stays honest; nothing upstream is ever
 * "corrected".
 */

/** The active fee policy layered onto both the nominal and the actual side
 * identically. `royaltyOn` gates whether `sellRoyaltyE18`/`buyRoyaltyE18` are added at
 * all — toggling it moves nominal and actual by the same factor (policy-neutrality). */
export interface FeePolicy {
  readonly marketplaceFeeE18: bigint
  readonly royaltyOn: boolean
  readonly sellRoyaltyE18?: bigint
  readonly buyRoyaltyE18?: bigint
}

export interface SpotNominalArgs {
  readonly sellReserves: Reserves
  readonly buyReserves: Reserves
  /** Whole-NFT count being sold — a small bigint, never wrapper-unit-scaled. */
  readonly sellCount: bigint
  readonly feePolicy: FeePolicy
}

export interface SpotNominalResult {
  /** The nominal receive amount, in wrapper-unit scale (`ONE_E18` per whole NFT) — the
   * same scale `crossPoolPriceImpact`'s `actualReceive` must be expressed in. */
  readonly nominalReceive: bigint
  readonly warning?: string
}

/**
 * The fee-adjusted mid-price nominal — no curve term. `spotSellPrice × sellFeeMul` on
 * one side, `spotBuyPrice × buyFeeMul` on the other, then a whole-count → wrapper-unit
 * conversion. Either pool empty, or `sellCount <= 0` ⇒ `nominalReceive: 0n` with a
 * warning, never a division by zero.
 */
export function spotNominal(args: SpotNominalArgs): SpotNominalResult {
  const { sellReserves, buyReserves, sellCount, feePolicy } = args
  if (sellCount <= 0n) {
    return { nominalReceive: 0n, warning: 'sellCount is not positive — no nominal baseline.' }
  }
  const spotSell = spotPrice(sellReserves)
  const spotBuy = spotPrice(buyReserves)
  if (spotSell === undefined || spotBuy === undefined) {
    return { nominalReceive: 0n, warning: 'One of the two pools has no liquidity — no nominal baseline.' }
  }

  const royaltyOn = feePolicy.royaltyOn
  const sellRoyaltyE18 = royaltyOn ? (feePolicy.sellRoyaltyE18 ?? 0n) : 0n
  const buyRoyaltyE18 = royaltyOn ? (feePolicy.buyRoyaltyE18 ?? 0n) : 0n
  const sellFeeE18 = feePolicy.marketplaceFeeE18 + sellRoyaltyE18
  // A combined fee at or above 100% would invert the sign — clamp at 0 (the seller
  // nets nothing), never go negative.
  const sellFeeMulE18 = sellFeeE18 >= ONE_E18 ? 0n : ONE_E18 - sellFeeE18
  const buyFeeMulE18 = ONE_E18 + feePolicy.marketplaceFeeE18 + buyRoyaltyE18

  // sellCount whole NFTs at the sell pool's spot price, fee-adjusted.
  const nominalSellProceeds = (sellCount * spotSell * sellFeeMulE18) / ONE_E18
  // The buy pool's spot price for ONE whole NFT, fee-adjusted.
  const nominalBuyPricePerNft = (spotBuy * buyFeeMulE18) / ONE_E18
  if (nominalBuyPricePerNft <= 0n) {
    return { nominalReceive: 0n, warning: 'Buy-side nominal price is zero — no nominal baseline.' }
  }

  // Whole-count → wrapper-unit scale (ONE_E18 per NFT), so this lines up with the
  // actual receive amount `crossPoolPriceImpact` compares it against.
  const nominalReceive = (nominalSellProceeds * ONE_E18) / nominalBuyPricePerNft
  return { nominalReceive }
}

export interface CrossPoolPriceImpactArgs {
  readonly nominalReceive: bigint
  readonly actualReceive: bigint
}
function clampedImpactBps(actualReceive: bigint, nominalReceive: bigint): bigint {
  if (nominalReceive <= 0n) return 0n
  if (actualReceive <= 0n) return 10_000n
  if (actualReceive >= nominalReceive) return 0n
  const impactBps = 10_000n - (actualReceive * 10_000n) / nominalReceive
  if (impactBps < 0n) return 0n
  if (impactBps > 10_000n) return 10_000n
  return impactBps
}

/**
 * `(1 − actual/nominal) × 100`, computed entirely in bigint basis points; the
 * bigint→number narrowing itself lives in `format.ts`'s `bpsToPercent` (this
 * directory's static scan forbids `Number(` even for one guarded final narrowing —
 * see that function's own doc comment). `nominalReceive <= 0n` returns `0` (never a
 * division by zero); `actualReceive >= nominalReceive` returns `0` (the trade matched
 * or beat the nominal baseline); `actualReceive <= 0n` with a positive nominal
 * returns `100`.
 */
export function crossPoolPriceImpact(args: CrossPoolPriceImpactArgs): number {
  return bpsToPercent(clampedImpactBps(args.actualReceive, args.nominalReceive))
}

export interface SinglePoolPriceImpactArgs {
  readonly reserveIn: bigint
  readonly reserveOut: bigint
  readonly amountIn: bigint
  readonly actualOut: bigint
}

/**
 * The single-pool counterpart — `reserveOut/reserveIn` is the spot ratio, `amountIn ×
 * spot` is the no-fee, no-curve nominal receive; `actualOut` is what the AMM curve (and
 * any fee already layered by the caller) actually returns. Same clamp, same spot
 * baseline as `crossPoolPriceImpact`, so a partner sees ONE consistent metric across
 * every quote kind — cross-pool NFT×NFT and single-pool buy/sell/swap alike.
 */
export function singlePoolPriceImpact(args: SinglePoolPriceImpactArgs): number {
  const { reserveIn, reserveOut, amountIn, actualOut } = args
  if (reserveIn <= 0n || reserveOut <= 0n || amountIn <= 0n) return 0
  const nominalReceive = (amountIn * reserveOut) / reserveIn
  return crossPoolPriceImpact({ nominalReceive, actualReceive: actualOut })
}
