import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import {
  addLiquidityAmounts,
  floorSqrt,
  minErc20Desired,
  ONE_WNFT,
  requiredBase,
  routerQuote,
} from '../../src/liquidity/liquidityMath'

/**
 * Property tests for the ceil-vs-floor rounding rule on the ERC-20-base desired amount
 * and the exact-floor guarantee of `floorSqrt`. Both run at >= 2000 trials — the same
 * numeric trap the research verified empirically (2000/2000 reverts using the floor,
 * 0/2000 using the ceil) is re-proven here on every CI run, not trusted from a
 * one-time simulation log.
 */
const FIXED_SEED = 20260926

const nArb = fc.integer({ min: 1, max: 50 })
const rWnftArb = fc.bigInt({ min: 10n ** 18n, max: 10n ** 24n })
const rBaseArb = fc.bigInt({ min: 1n, max: 10n ** 30n })

describe('minErc20Desired is the ceil that never reverts, the floor reverts whenever it differs', () => {
  it('requiredBase(n, rWnft, rBase) === routerQuote(n * ONE_WNFT, rWnft, rBase) for every input', () => {
    let runs = 0
    fc.assert(
      fc.property(nArb, rWnftArb, rBaseArb, (n, rWnft, rBase) => {
        runs++
        return requiredBase(n, rWnft, rBase) === routerQuote(BigInt(n) * ONE_WNFT, rWnft, rBase)
      }),
      { numRuns: 2000, seed: FIXED_SEED },
    )
    expect(runs).toBeGreaterThanOrEqual(2000)
  })

  // `amountAMin: 0n` isolates exactly the claim under test — whether the WNFT-side
  // (`amountBMin`) check ever fails as `INSUFFICIENT_B_AMOUNT` — from the unrelated,
  // base-side `INSUFFICIENT_A_AMOUNT` a real caller's own slippage-derived `amountAMin`
  // could independently trigger on the rare reserve ratio where the ceil overshoots
  // into branch 2 (a real `buildAddLiquidity` sets `amountAMin` from a fresh re-quote,
  // never 0 — that concern belongs to `deriveBounds`/the builder, not this pure
  // rounding-direction proof).
  it('feeding the ceil as amountADesired into the _addLiquidity mirror never yields INSUFFICIENT_B_AMOUNT', () => {
    let runs = 0
    fc.assert(
      fc.property(nArb, rWnftArb, rBaseArb, (n, rWnft, rBase) => {
        runs++
        const wnftDesired = BigInt(n) * ONE_WNFT
        const ceil = minErc20Desired(n, rWnft, rBase)
        const result = addLiquidityAmounts({
          amountADesired: ceil,
          amountBDesired: wnftDesired,
          amountAMin: 0n,
          amountBMin: wnftDesired,
          reserveA: rBase,
          reserveB: rWnft,
        })
        return !(result.ok === false && result.revert === 'INSUFFICIENT_B_AMOUNT')
      }),
      { numRuns: 2000, seed: FIXED_SEED },
    )
    expect(runs).toBeGreaterThanOrEqual(2000)
  })

  // The property every quote, reconciliation and seed walk relies on: with the
  // desired amount this module computes, the Router settles at EXACTLY requiredBase
  // (never one wei more), so an exact minimum equal to requiredBase never reverts.
  it('with minErc20Desired as amountADesired the Router pulls exactly requiredBase, exact minimums included', () => {
    let runs = 0
    let priced = 0
    fc.assert(
      fc.property(nArb, rWnftArb, rBaseArb, (n, rWnft, rBase) => {
        runs++
        const wnftDesired = BigInt(n) * ONE_WNFT
        const required = requiredBase(n, rWnft, rBase)
        if (required === 0n) return true // degenerate ratio; the Router rejects a zero amount first
        if (rBase >= rWnft) priced++
        const result = addLiquidityAmounts({
          amountADesired: minErc20Desired(n, rWnft, rBase),
          amountBDesired: wnftDesired,
          amountAMin: required,
          amountBMin: wnftDesired,
          reserveA: rBase,
          reserveB: rWnft,
        })
        return result.ok === true && result.amountA === required && result.amountB === wnftDesired
      }),
      { numRuns: 2000, seed: FIXED_SEED },
    )
    expect(runs).toBeGreaterThanOrEqual(2000)
    // The previously failing region (a pool priced at or above 1 token per NFT) must
    // actually be exercised, so this cannot pass vacuously.
    expect(priced).toBeGreaterThan(200)
  })

  it('feeding the floor (Router.quote) as amountADesired reverts INSUFFICIENT_B_AMOUNT whenever floor !== ceil', () => {
    let runs = 0
    let divergent = 0
    fc.assert(
      fc.property(nArb, rWnftArb, rBaseArb, (n, rWnft, rBase) => {
        runs++
        const wnftDesired = BigInt(n) * ONE_WNFT
        const floor = requiredBase(n, rWnft, rBase)
        const ceil = (BigInt(n) * ONE_WNFT * rBase + rWnft - 1n) / rWnft // the plain ceil
        if (floor === ceil) return true // exact division — no rounding trap to trigger
        // floor === 0n is a degenerate reserve ratio (reserveBase negligible next to
        // reserveWnft) where `amountADesired` itself would be 0 — the Router's own
        // `quote()` rejects a zero `amountA` with INSUFFICIENT_AMOUNT before the
        // INSUFFICIENT_B_AMOUNT branch this property targets is even reached; not the
        // rounding trap under test.
        if (floor === 0n) return true
        divergent++
        const result = addLiquidityAmounts({
          amountADesired: floor,
          amountBDesired: wnftDesired,
          amountAMin: 0n,
          amountBMin: wnftDesired,
          reserveA: rBase,
          reserveB: rWnft,
        })
        return result.ok === false && result.revert === 'INSUFFICIENT_B_AMOUNT'
      }),
      { numRuns: 2000, seed: FIXED_SEED },
    )
    expect(runs).toBeGreaterThanOrEqual(2000)
    // Assert we actually exercised the divergent (floor !== ceil, floor > 0) branch a
    // meaningful number of times, so this test cannot pass vacuously by skipping every
    // trial as an exact division or a degenerate zero-floor reserve ratio.
    expect(divergent).toBeGreaterThan(1000)
  })
})

describe('floorSqrt: exact floor for any non-negative bigint up to 2^200', () => {
  it('floorSqrt(x)^2 <= x < (floorSqrt(x)+1)^2', () => {
    let runs = 0
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 2n ** 200n }), (x) => {
        runs++
        const s = floorSqrt(x)
        return s * s <= x && x < (s + 1n) * (s + 1n)
      }),
      { numRuns: 2000, seed: FIXED_SEED },
    )
    expect(runs).toBeGreaterThanOrEqual(2000)
  })
})
