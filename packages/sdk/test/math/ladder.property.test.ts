import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { estimateLadder, nftBuyCost } from '../../src/math/nftPricing'
import { getAmountIn, ONE_E18, SNF_NFT_NET_FEE } from '../../src/math/quoteMath'

/**
 * The two `🧪 backstop` properties `54-SPEC.md`'s Edge Coverage rows `adjacency | R12`
 * and `precision | R12` require — property-based, not example-based, so they catch a
 * class of regression a fixture table cannot. Both use a FIXED seed (`FIXED_SEED`
 * below) so a failure is reproducible; any shrunk counterexample must be pasted into
 * the plan's SUMMARY.md, never silently re-seeded away.
 *
 * Generator ranges verified empirically this session (5000 trials, 0 violations of
 * strict monotonicity) before being locked in — see `math/nftPricing.ts`'s header for
 * why `estimateLadder` telescopes atomic `nftBuyCost` calls instead of simulating a
 * sequence of real trades against depleting reserves (the latter design was measured
 * to diverge from `nftBuyCost` by far more than a few wei on a shallow pool, which is
 * exactly the false-negative this backstop exists to catch on any future refactor).
 */
const FIXED_SEED = 20260921

const baseArb = fc.bigInt({ min: 10n ** 6n, max: 10n ** 24n })
const wnftArb = fc.bigInt({ min: 2n * 10n ** 18n, max: 500n * 10n ** 18n })
const nArb = fc.integer({ min: 2, max: 20 })

function bigintAbsDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a
}

describe('R12 backstop 1: the ladder marginal unit price is strictly increasing', () => {
  it('for any reserves > 0, the k-th unit costs strictly more than the (k-1)-th', () => {
    let runs = 0
    fc.assert(
      fc.property(baseArb, wnftArb, nArb, (base, wnft, n) => {
        runs++
        const result = estimateLadder({ base, wnft }, n)
        for (let i = 1; i < result.points.length; i++) {
          const current = result.points[i]!
          const previous = result.points[i - 1]!
          if (!(current.unitCost > previous.unitCost)) {
            return false
          }
        }
        return true
      }),
      { numRuns: 500, seed: FIXED_SEED },
    )
    expect(runs).toBeGreaterThanOrEqual(500)
    // eslint-disable-next-line no-console
    console.log(`R12 backstop 1 (monotonic marginal price): ${runs} fast-check runs, seed ${FIXED_SEED}`)
  })
})

describe('R12 backstop 2: estimateLadder(reserves, n).total tracks nftBuyCost(reserves, n)', () => {
  it('differs from the atomic nftBuyCost by at most n wei (n = the actual point count reached)', () => {
    let runs = 0
    fc.assert(
      fc.property(baseArb, wnftArb, nArb, (base, wnft, n) => {
        runs++
        const reserves = { base, wnft }
        const result = estimateLadder(reserves, n)
        const actualCount = result.points.length
        if (actualCount === 0) return result.total === 0n

        const atomic = getAmountIn(BigInt(actualCount) * ONE_E18, base, wnft, SNF_NFT_NET_FEE)
        if (atomic === undefined) return false
        const diff = bigintAbsDiff(result.total, atomic)
        return diff <= BigInt(actualCount)
      }),
      { numRuns: 500, seed: FIXED_SEED },
    )
    expect(runs).toBeGreaterThanOrEqual(500)
    // eslint-disable-next-line no-console
    console.log(`R12 backstop 2 (ladder-vs-nftBuyCost drift): ${runs} fast-check runs, seed ${FIXED_SEED}`)
  })

  it('sanity: nftBuyCost(reserves, n) itself agrees with the same atomic formula used above', () => {
    const reserves = { base: 10n ** 18n, wnft: 10n * ONE_E18 }
    const atomic = getAmountIn(5n * ONE_E18, reserves.base, reserves.wnft, SNF_NFT_NET_FEE)
    expect(nftBuyCost(reserves, 5)).toBe(atomic)
  })
})
