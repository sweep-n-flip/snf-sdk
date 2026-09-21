import { describe, expect, it } from 'vitest'

import { getAmountIn, ONE_E18, SNF_NFT_NET_FEE } from '../../src/math/quoteMath'
import { estimateLadder, nftBuyCost, nftSellProceeds, spotPrice } from '../../src/math/nftPricing'
import type { Reserves } from '../../src/math/nftPricing.types'

const BASE_DEMON_RESERVES: Reserves = {
  base: 1_297_217_522_559_477n,
  wnft: 11_883_323_065_263_036_728n,
}

describe('nftBuyCost', () => {
  it('mirrors getAmountIn(n*1e18, base, wnft, SNF_NFT_NET_FEE) exactly — the Base DEMON fixture', () => {
    expect(nftBuyCost(BASE_DEMON_RESERVES, 1)).toBe(121_625_659_884_654n)
  })

  it('returns undefined for n <= 0 or a non-integer n', () => {
    expect(nftBuyCost(BASE_DEMON_RESERVES, 0)).toBeUndefined()
    expect(nftBuyCost(BASE_DEMON_RESERVES, -1)).toBeUndefined()
    expect(nftBuyCost(BASE_DEMON_RESERVES, 1.5)).toBeUndefined()
  })
})

describe('nftSellProceeds', () => {
  it('mirrors getAmountOut(n*1e18, wnft, base, SNF_NFT_NET_FEE) — reserves reversed from the buy side', () => {
    const reserves: Reserves = { base: 10n ** 18n, wnft: 10n * ONE_E18 }
    const expected = (10n ** 18n * SNF_NFT_NET_FEE * reserves.base) / (reserves.wnft * 10_000n + ONE_E18 * SNF_NFT_NET_FEE)
    expect(nftSellProceeds(reserves, 1)).toBe(expected)
  })

  it('returns undefined for n <= 0', () => {
    expect(nftSellProceeds(BASE_DEMON_RESERVES, 0)).toBeUndefined()
  })
})

describe('spotPrice', () => {
  it('is base * 1e18 / wnft, no fee and no curve', () => {
    const reserves: Reserves = { base: 10n ** 18n, wnft: 10n * ONE_E18 }
    expect(spotPrice(reserves)).toBe(10n ** 17n) // 1 ETH / 10 NFTs = 0.1 ETH per NFT, scaled 1e18
  })

  it('returns undefined on an empty pool', () => {
    expect(spotPrice({ base: 0n, wnft: 0n })).toBeUndefined()
  })
})

describe('estimateLadder', () => {
  it('n=0 returns { points: [], kind: "estimate", truncated: false } with no reason', () => {
    const result = estimateLadder(BASE_DEMON_RESERVES, 0)
    expect(result.points).toEqual([])
    expect(result.kind).toBe('estimate')
    expect(result.truncated).toBe(false)
    expect(result.reason).toBeUndefined()
  })

  it('n=1 gives one point equal to nftBuyCost(reserves, 1)', () => {
    const result = estimateLadder(BASE_DEMON_RESERVES, 1)
    expect(result.points).toHaveLength(1)
    expect(result.points[0]!.unitCost).toBe(nftBuyCost(BASE_DEMON_RESERVES, 1))
    expect(result.points[0]!.index).toBe(1)
    expect(result.points[0]!.cumulative).toBe(nftBuyCost(BASE_DEMON_RESERVES, 1))
  })

  it('n > availableCount is truncated to exactly availableCount points', () => {
    const result = estimateLadder(BASE_DEMON_RESERVES, 100, { availableCount: 3 })
    expect(result.points).toHaveLength(3)
    expect(result.truncated).toBe(true)
    expect(result.points.map((p) => p.index)).toEqual([1, 2, 3])
  })

  it('a pool with no liquidity returns { points: [], reason: "no-liquidity" }, never a throw', () => {
    const result = estimateLadder({ base: 0n, wnft: 0n }, 3)
    expect(result.points).toEqual([])
    expect(result.kind).toBe('estimate')
    expect(result.reason).toBe('no-liquidity')
  })

  it('points are ordered 1..n, each carrying { index, unitCost, cumulative }', () => {
    const reserves: Reserves = { base: 10n ** 18n, wnft: 10n * ONE_E18 }
    const result = estimateLadder(reserves, 5)
    expect(result.points.map((p) => p.index)).toEqual([1, 2, 3, 4, 5])
    let runningCumulative = 0n
    for (const point of result.points) {
      runningCumulative += point.unitCost
      expect(point.cumulative).toBe(runningCumulative)
    }
    expect(result.total).toBe(runningCumulative)
  })

  it('the marginal unit price is strictly increasing (verified explicitly, in addition to the fast-check backstop)', () => {
    const reserves: Reserves = { base: 10n ** 18n, wnft: 10n * ONE_E18 }
    const result = estimateLadder(reserves, 5)
    for (let i = 1; i < result.points.length; i++) {
      expect(result.points[i]!.unitCost > result.points[i - 1]!.unitCost).toBe(true)
    }
  })

  it('each point telescopes back to nftBuyCost(reserves, k) exactly — the design that keeps the ladder within the property backstop bound', () => {
    const reserves: Reserves = { base: 10n ** 18n, wnft: 10n * ONE_E18 }
    const result = estimateLadder(reserves, 5)
    for (const point of result.points) {
      const atomic = getAmountIn(BigInt(point.index) * ONE_E18, reserves.base, reserves.wnft, SNF_NFT_NET_FEE)
      expect(point.cumulative).toBe(atomic)
    }
    expect(result.total).toBe(nftBuyCost(reserves, 5))
  })
})
