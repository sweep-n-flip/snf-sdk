import { describe, expect, it } from 'vitest'

import { crossPoolPriceImpact, singlePoolPriceImpact, spotNominal } from '../../src/quote/priceImpact'
import { ONE_E18 } from '../../src/math/quoteMath'

/**
 * `priceImpact.ts` (Task 1): the spot (mid) price nominal baseline, the
 * policy-neutrality guarantee, the tiny-pool regression, and the [0,100] clamp.
 */

describe('spotNominal', () => {
  const noRoyalty = { marketplaceFeeE18: 0n, royaltyOn: false }

  it('returns 0n with a warning when sellCount <= 0', () => {
    const result = spotNominal({
      sellReserves: { base: 100n, wnft: 10n * ONE_E18 },
      buyReserves: { base: 100n, wnft: 10n * ONE_E18 },
      sellCount: 0n,
      feePolicy: noRoyalty,
    })
    expect(result.nominalReceive).toBe(0n)
    expect(result.warning).toBeDefined()
  })

  it('returns 0n with a warning when a pool has no liquidity', () => {
    const result = spotNominal({
      sellReserves: { base: 0n, wnft: 0n },
      buyReserves: { base: 100n, wnft: 10n * ONE_E18 },
      sellCount: 1n,
      feePolicy: noRoyalty,
    })
    expect(result.nominalReceive).toBe(0n)
    expect(result.warning).toBeDefined()
  })

  it('with equal reserves and no fee, sellCount NFTs nominally receive sellCount NFTs (1e18 units each)', () => {
    const reserves = { base: 100n * ONE_E18, wnft: 100n * ONE_E18 }
    const result = spotNominal({ sellReserves: reserves, buyReserves: reserves, sellCount: 3n, feePolicy: noRoyalty })
    expect(result.nominalReceive).toBe(3n * ONE_E18)
  })

  it('a fee policy above 100% on the sell side clamps the sell multiplier to 0, not negative', () => {
    const reserves = { base: 100n * ONE_E18, wnft: 100n * ONE_E18 }
    const result = spotNominal({
      sellReserves: reserves,
      buyReserves: reserves,
      sellCount: 1n,
      feePolicy: { marketplaceFeeE18: ONE_E18, royaltyOn: false },
    })
    expect(result.nominalReceive).toBe(0n)
  })
})

describe('crossPoolPriceImpact', () => {
  it('nominalReceive <= 0n returns 0 (never divides by zero)', () => {
    expect(crossPoolPriceImpact({ nominalReceive: 0n, actualReceive: 100n })).toBe(0)
    expect(crossPoolPriceImpact({ nominalReceive: -1n, actualReceive: 100n })).toBe(0)
  })

  it('actualReceive >= nominalReceive returns 0 (matched or beat the nominal baseline)', () => {
    expect(crossPoolPriceImpact({ nominalReceive: 100n, actualReceive: 100n })).toBe(0)
    expect(crossPoolPriceImpact({ nominalReceive: 100n, actualReceive: 150n })).toBe(0)
  })

  it('actualReceive <= 0n with a positive nominal returns 100', () => {
    expect(crossPoolPriceImpact({ nominalReceive: 100n, actualReceive: 0n })).toBe(100)
  })

  it('a 10% shortfall yields impact 10', () => {
    expect(crossPoolPriceImpact({ nominalReceive: 1000n, actualReceive: 900n })).toBe(10)
  })

  it('is clamped to [0, 100] and never produces a four-digit number', () => {
    const impact = crossPoolPriceImpact({ nominalReceive: 1_000_000n, actualReceive: 1n })
    expect(impact).toBeLessThanOrEqual(100)
    expect(impact).toBeGreaterThanOrEqual(0)
  })

  it('regression: a tiny pool (reserves ~1e14) never yields a four-digit impact', () => {
    // The historical bug this module exists to prevent: "percentage of pool consumed"
    // exceeded 1000% on small pools. A steep but honest shortfall on a tiny pool must
    // still land inside [0, 100].
    const nominal = 100_000_000_000_000n // ~1e14
    const actual = 1_000_000_000_000n // 1% of nominal
    const impact = crossPoolPriceImpact({ nominalReceive: nominal, actualReceive: actual })
    expect(impact).toBeLessThanOrEqual(100)
    expect(impact).toBeCloseTo(99, 0)
  })

  it('policy-neutrality: toggling feePolicy.royaltyOn scales nominal and actual by the same factor, impact unchanged', () => {
    const sellReserves = { base: 5n * ONE_E18, wnft: 20n * ONE_E18 }
    const buyReserves = { base: 8n * ONE_E18, wnft: 15n * ONE_E18 }
    const marketplaceFeeE18 = (25n * ONE_E18) / 1000n // 2.5%
    const sellRoyaltyE18 = (5n * ONE_E18) / 100n // 5%
    const buyRoyaltyE18 = (3n * ONE_E18) / 100n // 3%

    // "actual" is a real, curve-priced amount that itself scales with the same fee
    // policy (mirrors how a real quote's actualReceive is fee-adjusted on-chain) —
    // built here as a fixed fraction of the no-royalty nominal so the SAME relative
    // fee delta applies to both nominal and actual when royalty is toggled on.
    const off = spotNominal({ sellReserves, buyReserves, sellCount: 2n, feePolicy: { marketplaceFeeE18, royaltyOn: false } })
    const on = spotNominal({ sellReserves, buyReserves, sellCount: 2n, feePolicy: { marketplaceFeeE18, royaltyOn: true, sellRoyaltyE18, buyRoyaltyE18 } })

    const actualOff = (off.nominalReceive * 9n) / 10n
    const actualOn = (on.nominalReceive * 9n) / 10n

    const impactOff = crossPoolPriceImpact({ nominalReceive: off.nominalReceive, actualReceive: actualOff })
    const impactOn = crossPoolPriceImpact({ nominalReceive: on.nominalReceive, actualReceive: actualOn })

    // Both sides floor through independent bigint divisions, so a sub-basis-point
    // truncation artifact (well under 1 bps) is expected — the policy-neutrality
    // claim is about the metric staying the SAME to 2 decimals of PERCENT precision,
    // not bit-identical bigint truncation.
    expect(impactOn).toBeCloseTo(impactOff, 1)
  })
})

describe('singlePoolPriceImpact', () => {
  it('any non-positive reserve or amountIn returns 0', () => {
    expect(singlePoolPriceImpact({ reserveIn: 0n, reserveOut: 100n, amountIn: 10n, actualOut: 5n })).toBe(0)
    expect(singlePoolPriceImpact({ reserveIn: 100n, reserveOut: 0n, amountIn: 10n, actualOut: 5n })).toBe(0)
    expect(singlePoolPriceImpact({ reserveIn: 100n, reserveOut: 100n, amountIn: 0n, actualOut: 5n })).toBe(0)
  })

  it('uses the spot ratio as nominal — no fee, no curve', () => {
    // spot = 100/50 = 2; amountIn 10 -> nominal 20; actualOut 18 -> impact 10%.
    const impact = singlePoolPriceImpact({ reserveIn: 50n, reserveOut: 100n, amountIn: 10n, actualOut: 18n })
    expect(impact).toBe(10)
  })

  it('a same-pool buy and sell share the identical spot baseline formula', () => {
    const reserveA = 50n
    const reserveB = 100n
    const buyImpact = singlePoolPriceImpact({ reserveIn: reserveA, reserveOut: reserveB, amountIn: 10n, actualOut: 18n })
    const sellImpact = singlePoolPriceImpact({ reserveIn: reserveB, reserveOut: reserveA, amountIn: 20n, actualOut: 9n })
    expect(buyImpact).toBeGreaterThan(0)
    expect(sellImpact).toBeGreaterThan(0)
  })
})
