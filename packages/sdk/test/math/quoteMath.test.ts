import { describe, expect, it } from 'vitest'

import {
  applyMarketplaceFee,
  getAmountIn,
  getAmountOut,
  getAmountsInChain,
  getAmountsOutChain,
  ONE_E18,
  reconstructRoyalty,
  SNF_NFT_FEE_DENOM,
  SNF_NFT_NET_FEE,
} from '../../src/math/quoteMath'

// Six rows hand-evaluated independently against UniswapV2Library.sol's own formula
// (amountInWithFee = amountIn*netFee; out = amountInWithFee*reserveOut /
// (reserveIn*10000 + amountInWithFee)) — see the plan's SUMMARY for the derivation
// script. Row 2 is a dust amountIn where the floor bites all the way to zero output.
const AMOUNT_OUT_ROWS: readonly {
  readonly amountIn: bigint
  readonly reserveIn: bigint
  readonly reserveOut: bigint
  readonly netFee: bigint
  readonly expectedOut: bigint
}[] = [
  { amountIn: 1000n, reserveIn: 1_000_000n, reserveOut: 1_000_000n, netFee: 9800n, expectedOut: 979n },
  { amountIn: 1n, reserveIn: 1_000_000n, reserveOut: 1_000_000n, netFee: 9800n, expectedOut: 0n },
  { amountIn: 500_000n, reserveIn: 1_000_000n, reserveOut: 1_000_000n, netFee: 9800n, expectedOut: 328_859n },
  {
    amountIn: 50_000_000n,
    reserveIn: 500_000_000n,
    reserveOut: 500_000_000n,
    netFee: 9800n,
    expectedOut: 44_626_593n,
  },
  { amountIn: 1000n, reserveIn: 1_000_000n, reserveOut: 1_000_000n, netFee: 9970n, expectedOut: 996n },
  { amountIn: 7n, reserveIn: 300n, reserveOut: 300n, netFee: 9800n, expectedOut: 6n },
]

describe('getAmountOut', () => {
  it.each(AMOUNT_OUT_ROWS)(
    'amountIn=$amountIn reserveIn=$reserveIn reserveOut=$reserveOut netFee=$netFee -> $expectedOut',
    ({ amountIn, reserveIn, reserveOut, netFee, expectedOut }) => {
      expect(getAmountOut(amountIn, reserveIn, reserveOut, netFee)).toBe(expectedOut)
    },
  )

  it('the floor bites: a dust amountIn can round all the way to zero output', () => {
    expect(getAmountOut(1n, 1_000_000n, 1_000_000n, 9800n)).toBe(0n)
  })

  it('returns undefined for amountIn <= 0, reserveIn <= 0 or reserveOut <= 0', () => {
    expect(getAmountOut(0n, 1000n, 1000n, 9800n)).toBeUndefined()
    expect(getAmountOut(-1n, 1000n, 1000n, 9800n)).toBeUndefined()
    expect(getAmountOut(1000n, 0n, 1000n, 9800n)).toBeUndefined()
    expect(getAmountOut(1000n, 1000n, 0n, 9800n)).toBeUndefined()
  })
})

describe('getAmountIn', () => {
  it('returns exactly numerator/denominator + 1n (the Router rounding-safety wei)', () => {
    const reserveIn = 1_000_000n
    const reserveOut = 1_000_000n
    const amountOut = 979n
    const numerator = reserveIn * amountOut * SNF_NFT_FEE_DENOM
    const denominator = (reserveOut - amountOut) * SNF_NFT_NET_FEE
    expect(getAmountIn(amountOut, reserveIn, reserveOut, SNF_NFT_NET_FEE)).toBe(
      numerator / denominator + 1n,
    )
  })

  it.each(AMOUNT_OUT_ROWS.filter((r) => r.expectedOut > 0n))(
    'round trip never under-charges: getAmountIn(getAmountOut(x)) >= x',
    ({ amountIn, reserveIn, reserveOut, netFee, expectedOut }) => {
      const back = getAmountIn(expectedOut, reserveIn, reserveOut, netFee)
      expect(back).toBeDefined()
      expect(back! >= amountIn).toBe(true)
    },
  )

  it('returns undefined for amountOut <= 0, empty reserves, or amountOut >= reserveOut', () => {
    expect(getAmountIn(0n, 1000n, 1000n, 9800n)).toBeUndefined()
    expect(getAmountIn(500n, 0n, 1000n, 9800n)).toBeUndefined()
    expect(getAmountIn(500n, 1000n, 0n, 9800n)).toBeUndefined()
    expect(getAmountIn(1000n, 1000n, 1000n, 9800n)).toBeUndefined() // amountOut >= reserveOut
    expect(getAmountIn(1500n, 1000n, 1000n, 9800n)).toBeUndefined()
  })
})

describe('getAmountsOutChain / getAmountsInChain', () => {
  it('applies a per-hop netFee: a delegate hop then an SnF hop, in one chain', () => {
    const amounts = getAmountsOutChain(
      1_000_000n,
      [
        [5_000_000n, 8_000_000n],
        [3_000_000n, 2_000_000n],
      ],
      [9970n, 9800n],
    )
    expect(amounts).toEqual([1_000_000n, 1_329_998n, 605_752n])
  })

  it('getAmountsInChain walks the same two-hop path backwards', () => {
    const amounts = getAmountsInChain(
      100_000n,
      [
        [5_000_000n, 8_000_000n],
        [3_000_000n, 2_000_000n],
      ],
      [9970n, 9800n],
    )
    expect(amounts).toEqual([103_078n, 161_118n, 100_000n])
  })

  it('returns undefined on a mismatched reserves/netFees length or an empty chain', () => {
    expect(getAmountsOutChain(1000n, [], [])).toBeUndefined()
    expect(getAmountsOutChain(1000n, [[1000n, 1000n]], [])).toBeUndefined()
  })
})

describe('reconstructRoyalty', () => {
  const NO_CAP = ONE_E18 // capRoyaltyFee pinned false -> "100e16" = ONE_E18

  it('reproduces the Base DEMON fixture exactly: pool 121625659884654, marketplace 3040641497116, royalty 6081282994232, gross 130747584376002', () => {
    const poolCost = getAmountIn(ONE_E18, 1_297_217_522_559_477n, 11_883_323_065_263_036_728n, SNF_NFT_NET_FEE)
    expect(poolCost).toBe(121_625_659_884_654n)

    const result = reconstructRoyalty({
      totalAmount: poolCost!,
      tokenIds: ['245830'],
      perIdRoyalty: [{ receiver: '0x1111111111111111111111111111111111111111', royaltyE18: 5n * 10n ** 16n }],
      capE18: NO_CAP,
      marketplaceFeeE18: 25n * 10n ** 15n, // 2.5%
    })

    expect(result.marketplace).toBe(3_040_641_497_116n)
    expect(result.perId.reduce((a, b) => a + b, 0n)).toBe(6_081_282_994_232n)
    expect(result.total).toBe(9_121_924_491_348n) // marketplace + royalty
    expect(poolCost! + result.total).toBe(130_747_584_376_002n)
    expect(result.capApplied).toBe(false)
    expect(result.unpayable).toBe(0n)
  })

  it('capRoyaltyFee=true with an unset (0) cap zeroes the royalty but not the marketplace fee (the "cap 0" footgun)', () => {
    const poolCost = 121_625_659_884_654n
    const result = reconstructRoyalty({
      totalAmount: poolCost,
      tokenIds: ['245830'],
      perIdRoyalty: [{ receiver: '0x1111111111111111111111111111111111111111', royaltyE18: 5n * 10n ** 16n }],
      capE18: 0n,
      marketplaceFeeE18: 25n * 10n ** 15n,
    })
    expect(result.perId).toEqual([0n])
    expect(result.marketplace).toBe(3_040_641_497_116n)
    expect(result.capApplied).toBe(true)
    expect(poolCost + result.total).toBe(124_666_301_381_770n)
  })

  it('a flat 5% rate over 3 ids equals floor(totalAmount/3) * 5% * 3, NOT totalAmount * 5%', () => {
    const rate = 5n * 10n ** 16n
    const result = reconstructRoyalty({
      totalAmount: 100n,
      tokenIds: ['1', '2', '3'],
      perIdRoyalty: [
        { receiver: '0x1111111111111111111111111111111111111111', royaltyE18: rate },
        { receiver: '0x1111111111111111111111111111111111111111', royaltyE18: rate },
        { receiver: '0x1111111111111111111111111111111111111111', royaltyE18: rate },
      ],
      capE18: NO_CAP,
      marketplaceFeeE18: 0n,
    })
    const royaltyTotal = result.perId.reduce((a, b) => a + b, 0n)
    expect(royaltyTotal).toBe(3n) // floor(100/3)=33; 33*5%=1 per id; 1*3=3
    expect(royaltyTotal).not.toBe((100n * rate) / ONE_E18) // naive shortcut would give 5n
  })

  it('variable per-id rates sum the TRUE per-id amounts, never an average', () => {
    const result = reconstructRoyalty({
      totalAmount: 101n,
      tokenIds: ['1', '2', '3'],
      perIdRoyalty: [
        { receiver: '0x1111111111111111111111111111111111111111', royaltyE18: 10n * 10n ** 16n },
        { receiver: '0x1111111111111111111111111111111111111111', royaltyE18: 20n * 10n ** 16n },
        { receiver: '0x1111111111111111111111111111111111111111', royaltyE18: 33n * 10n ** 16n },
      ],
      capE18: NO_CAP,
      marketplaceFeeE18: 0n,
    })
    expect(result.perId).toEqual([3n, 6n, 10n])
    expect(result.perId.reduce((a, b) => a + b, 0n)).toBe(19n)
  })

  it('when the cap bites, every per-id amount is re-floored and the summed total lands strictly below maxRoyaltyAmount', () => {
    const rate = 50n * 10n ** 16n
    const result = reconstructRoyalty({
      totalAmount: 100n,
      tokenIds: ['1', '2', '3'],
      perIdRoyalty: [
        { receiver: '0x1111111111111111111111111111111111111111', royaltyE18: rate },
        { receiver: '0x1111111111111111111111111111111111111111', royaltyE18: rate },
        { receiver: '0x1111111111111111111111111111111111111111', royaltyE18: rate },
      ],
      capE18: 20n * 10n ** 16n, // 20% cap
      marketplaceFeeE18: 0n,
    })
    const maxRoyaltyAmount = (100n * (20n * 10n ** 16n)) / ONE_E18 // 20n
    const royaltyTotal = result.perId.reduce((a, b) => a + b, 0n)
    expect(result.capApplied).toBe(true)
    expect(result.perId).toEqual([6n, 6n, 6n])
    expect(royaltyTotal).toBe(18n)
    expect(royaltyTotal < maxRoyaltyAmount).toBe(true) // strictly below, not equal
  })

  it('a zero-address receiver is reported as unpayable but still counted in total (Arc adjusts it downstream, not here)', () => {
    const result = reconstructRoyalty({
      totalAmount: 100n,
      tokenIds: ['1'],
      perIdRoyalty: [{ receiver: '0x0000000000000000000000000000000000000000', royaltyE18: 5n * 10n ** 16n }],
      capE18: NO_CAP,
      marketplaceFeeE18: 0n,
    })
    expect(result.perId).toEqual([5n]) // floor(100/1)*5% = 5
    expect(result.unpayable).toBe(5n)
    expect(result.total).toBe(5n)
  })

  it('an empty tokenIds list applies only the marketplace fee', () => {
    const result = reconstructRoyalty({
      totalAmount: 1000n,
      tokenIds: [],
      perIdRoyalty: [],
      capE18: NO_CAP,
      marketplaceFeeE18: 25n * 10n ** 15n,
    })
    expect(result.perId).toEqual([])
    expect(result.marketplace).toBe(25n)
    expect(result.total).toBe(25n)
  })
})

describe('applyMarketplaceFee', () => {
  it('is total * feeE18 / 1e18 and is never subject to the royalty cap', () => {
    expect(applyMarketplaceFee(1_000_000n, 25n * 10n ** 15n)).toBe(25_000n) // 2.5%

    const result = reconstructRoyalty({
      totalAmount: 1_000_000n,
      tokenIds: ['1'],
      perIdRoyalty: [{ receiver: '0x1111111111111111111111111111111111111111', royaltyE18: 5n * 10n ** 16n }],
      capE18: 0n, // fully capped -> royalty zeroed, marketplace untouched
      marketplaceFeeE18: 25n * 10n ** 15n,
    })
    expect(result.perId).toEqual([0n])
    expect(result.marketplace).toBe(25_000n)
  })
})

// Sell-side fixtures (RESEARCH Assumption A3, CLOSED by plan 18): "91417099472198"
// for 1 item and "237988677509668" for 3 items were re-derived live this session
// against the real Base Router (`getAmountsOutCollection`, block 51599577,
// mainnet.base.org, 2026-09-21) AND independently reconstructed here from
// `getAmountOut` fed the same pool's real reserves (`base-demon.json`'s `reserves`
// field) — the two match the live Router figure to the wei, which is what converts
// this from an "unsourced `additional_context` number" into a verified fixture. See
// `test/fork/base.fork.test.ts` for the live on-chain read and
// `test/fixtures/collections/base-demon.json`'s `sellFixtures` for the full record.
describe('Base sell-side fixture (RESEARCH Assumption A3, closed by plan 18)', () => {
  const RESERVES = { base: 1_297_217_522_559_477n, wnft: 11_883_323_065_263_036_728n }
  const MARKETPLACE_FEE_E18 = 25n * 10n ** 15n // 2.5%
  const ROYALTY_E18 = 5n * 10n ** 16n // 5% (DEMON collection, confirmed live via royaltyInfo)

  it('1-item sell reconstructs to 91417099472198 — matches the live Router getAmountsOutCollection answer', () => {
    const poolLeg = getAmountOut(1n * ONE_E18, RESERVES.wnft, RESERVES.base, SNF_NFT_NET_FEE)
    expect(poolLeg).toBe(98_829_296_726_700n)
    const marketplace = (poolLeg! * MARKETPLACE_FEE_E18) / ONE_E18
    const royalty = (poolLeg! * ROYALTY_E18) / ONE_E18
    const net = poolLeg! - marketplace - royalty
    expect(net).toBe(91_417_099_472_198n)
  })

  it('3-item sell reconstructs to 237988677509668 — matches the live Router getAmountsOutCollection answer', () => {
    const poolLeg = getAmountOut(3n * ONE_E18, RESERVES.wnft, RESERVES.base, SNF_NFT_NET_FEE)
    expect(poolLeg).toBe(257_285_056_767_207n)
    const marketplace = (poolLeg! * MARKETPLACE_FEE_E18) / ONE_E18
    const salePrice = poolLeg! / 3n
    const royaltyPerId = (salePrice * ROYALTY_E18) / ONE_E18
    const royalty = royaltyPerId * 3n
    const net = poolLeg! - marketplace - royalty
    expect(net).toBe(237_988_677_509_668n)
  })
})
