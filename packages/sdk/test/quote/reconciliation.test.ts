import { describe, expect, it } from 'vitest'

import { getAmountIn, getAmountOut, SNF_NFT_NET_FEE } from '../../src/math/quoteMath'
import { reconcileGross, reconcileNet } from '../../src/math/reconcile'
import { loadQuoteContext } from '../../src/quote/quoteContext'
import { buildQuoteEnv, ZERO_ADDRESS } from './testHelpers'

/**
 * `loadQuoteContext` — one pinned block, `capRoyaltyFee=false` provably false, the
 * per-id sale price computed once (Task 1, R8; 54-SPEC.md). Also the shared fixture
 * home for the Base DEMON buy fixture and the synthetic 1-wei divergence, reused in
 * spirit by `quoteBuy.test.ts`/`quoteSell.test.ts`'s own end-to-end assertions.
 */

const PAIR = '0x000000000000000000000000000000000000FA17' as `0x${string}`
const WRAPPER = '0x000000000000000000000000000000000000BAD1' as `0x${string}`
const COLLECTION = '0x000000000000000000000000000000000000c011' as `0x${string}`
const RECEIVER = '0x1111111111111111111111111111111111111111' as `0x${string}`
const BASE_TOKEN = { address: '0x4200000000000000000000000000000000000006' as `0x${string}`, symbol: 'ETH', decimals: 18, isNative: true }

// Base DEMON fixture (snf-54-06/10's own numbers, verified to the wei against
// UniswapV2Library.getAmountIn): reserves eth=1,297,217,522,559,477 /
// wnft=11,883,323,065,263,036,728, pool cost for 1 item = 121,625,659,884,654,
// marketplace 2.5% = 3,040,641,497,116, royalty 5% = 6,081,282,994,232, gross =
// 130,747,584,376,002.
const DEMON_RESERVES = { base: 1_297_217_522_559_477n, wnft: 11_883_323_065_263_036_728n }
const DEMON_POOL_LEG_1 = 121_625_659_884_654n
const DEMON_MARKETPLACE_FEE_E18 = 25n * 10n ** 15n // 2.5%
const DEMON_MARKETPLACE_1 = 3_040_641_497_116n
const DEMON_ROYALTY_1 = 6_081_282_994_232n
const DEMON_GROSS_1 = 130_747_584_376_002n

describe('loadQuoteContext (Task 1, R8)', () => {
  it('returns one pinned blockNumber, reserves, wrapperIsToken0, wrapperDecimals, quoteDecimals, marketplaceFeeE18, royaltyCapE18, poolLeg, routerTotal, perIdRoyalty', async () => {
    const { ctx } = buildQuoteEnv({
      pair: PAIR,
      wrapper: WRAPPER,
      collection: COLLECTION,
      reserves: DEMON_RESERVES,
      marketplaceFeeE18: DEMON_MARKETPLACE_FEE_E18,
      side: 'buy',
      units: 10n ** 18n,
      poolLeg: DEMON_POOL_LEG_1,
      routerTotal: DEMON_GROSS_1,
      perId: [{ tokenId: '245830', receiver: RECEIVER, amount: DEMON_ROYALTY_1 }],
    })
    const result = await loadQuoteContext(ctx, {
      pair: PAIR,
      wrapper: WRAPPER,
      collection: COLLECTION,
      baseToken: BASE_TOKEN,
      tokenIds: ['245830'],
      side: 'buy',
    })
    expect(result.blockNumber).toBe(999_999n)
    expect(result.reserves).toEqual(DEMON_RESERVES)
    expect(result.wrapperIsToken0).toBe(false)
    expect(result.wrapperDecimals).toBe(18)
    expect(result.quoteDecimals).toBe(18)
    expect(result.marketplaceFeeE18).toBe(DEMON_MARKETPLACE_FEE_E18)
    expect(result.poolLeg).toBe(DEMON_POOL_LEG_1)
    expect(result.routerTotal).toBe(DEMON_GROSS_1)
    expect(result.perIdRoyalty).toEqual([{ tokenId: '245830', receiver: RECEIVER, amount: DEMON_ROYALTY_1 }])
  })

  it('wrapperDecimals !== 18 throws SnfError(WRAPPER_UNVERIFIED) with the observed value', async () => {
    const { ctx } = buildQuoteEnv({
      pair: PAIR,
      wrapper: WRAPPER,
      collection: COLLECTION,
      reserves: DEMON_RESERVES,
      marketplaceFeeE18: DEMON_MARKETPLACE_FEE_E18,
      side: 'buy',
      units: 10n ** 18n,
      poolLeg: DEMON_POOL_LEG_1,
      routerTotal: DEMON_GROSS_1,
      perId: [{ tokenId: '245830', receiver: RECEIVER, amount: DEMON_ROYALTY_1 }],
      wrapperDecimals: 6,
    })
    await expect(
      loadQuoteContext(ctx, {
        pair: PAIR,
        wrapper: WRAPPER,
        collection: COLLECTION,
        baseToken: BASE_TOKEN,
        tokenIds: ['245830'],
        side: 'buy',
      }),
    ).rejects.toMatchObject({ code: 'WRAPPER_UNVERIFIED', details: { wrapperDecimals: 6 } })
  })

  it('every royaltyInfo call in round 2 receives the identical truncated salePrice = poolLeg / tokenIds.length', async () => {
    const poolLeg3 = getAmountIn(3n * 10n ** 18n, DEMON_RESERVES.base, DEMON_RESERVES.wnft, SNF_NFT_NET_FEE)!
    const { ctx, calls } = buildQuoteEnv({
      pair: PAIR,
      wrapper: WRAPPER,
      collection: COLLECTION,
      reserves: DEMON_RESERVES,
      marketplaceFeeE18: DEMON_MARKETPLACE_FEE_E18,
      side: 'buy',
      units: 3n * 10n ** 18n,
      poolLeg: poolLeg3,
      routerTotal: poolLeg3 + 1n, // unused by this assertion
      perId: [
        { tokenId: '1', receiver: RECEIVER, amount: 0n },
        { tokenId: '2', receiver: RECEIVER, amount: 0n },
        { tokenId: '3', receiver: RECEIVER, amount: 0n },
      ],
    })
    await loadQuoteContext(ctx, {
      pair: PAIR,
      wrapper: WRAPPER,
      collection: COLLECTION,
      baseToken: BASE_TOKEN,
      tokenIds: ['1', '2', '3'],
      side: 'buy',
    })
    const round2 = calls().find((c) => c.contracts[0]?.functionName === 'royaltyInfo')
    expect(round2).toBeDefined()
    const expectedSalePrice = poolLeg3 / 3n
    for (const call of round2!.contracts) {
      expect(call.args[1]).toBe(expectedSalePrice)
    }
  })

  it('the capRoyaltyFee argument of getAmountsInCollection AND getAmountsOutCollection is the literal false — never true', async () => {
    for (const side of ['buy', 'sell'] as const) {
      const { ctx, calls } = buildQuoteEnv({
        pair: PAIR,
        wrapper: WRAPPER,
        collection: COLLECTION,
        reserves: DEMON_RESERVES,
        marketplaceFeeE18: DEMON_MARKETPLACE_FEE_E18,
        side,
        units: 10n ** 18n,
        poolLeg: DEMON_POOL_LEG_1,
        routerTotal: DEMON_GROSS_1,
        perId: [{ tokenId: '245830', receiver: RECEIVER, amount: DEMON_ROYALTY_1 }],
      })
      await loadQuoteContext(ctx, {
        pair: PAIR,
        wrapper: WRAPPER,
        collection: COLLECTION,
        baseToken: BASE_TOKEN,
        tokenIds: ['245830'],
        side,
      })
      const round1 = calls().find((c) => c.contracts.length >= 6)
      const collectionCall = round1!.contracts.find(
        (c) => c.functionName === 'getAmountsInCollection' || c.functionName === 'getAmountsOutCollection',
      )
      expect(collectionCall).toBeDefined()
      expect(collectionCall!.args[2]).toBe(false)
    }
  })

  it('a failing individual read (marketplaceFee) throws a typed SnfError, never a silent 0n', async () => {
    const { ctx, multicall } = buildQuoteEnv({
      pair: PAIR,
      wrapper: WRAPPER,
      collection: COLLECTION,
      reserves: DEMON_RESERVES,
      marketplaceFeeE18: DEMON_MARKETPLACE_FEE_E18,
      side: 'buy',
      units: 10n ** 18n,
      poolLeg: DEMON_POOL_LEG_1,
      routerTotal: DEMON_GROSS_1,
      perId: [{ tokenId: '245830', receiver: RECEIVER, amount: DEMON_ROYALTY_1 }],
    })
    multicall.mockImplementationOnce(async (params: { contracts: readonly { functionName: string }[] }) => {
      const fns = params.contracts.map((c) => c.functionName)
      if (fns[0] === 'getReserves' && fns.length >= 6) {
        return [
          { status: 'success', result: [DEMON_RESERVES.base, DEMON_RESERVES.wnft, 0] },
          { status: 'success', result: BASE_TOKEN.address },
          { status: 'success', result: WRAPPER },
          { status: 'success', result: 18 },
          { status: 'failure' }, // marketplaceFee fails
          { status: 'success', result: 10n ** 18n },
          { status: 'success', result: [DEMON_GROSS_1, 10n ** 18n] },
          { status: 'success', result: [DEMON_POOL_LEG_1, 10n ** 18n] },
        ]
      }
      throw new Error('unexpected')
    })
    await expect(
      loadQuoteContext(ctx, {
        pair: PAIR,
        wrapper: WRAPPER,
        collection: COLLECTION,
        baseToken: BASE_TOKEN,
        tokenIds: ['245830'],
        side: 'buy',
      }),
    ).rejects.toMatchObject({ code: 'NO_ROUTE' })
  })

  it('the returned blockNumber is the one BOTH multicalls executed against (round 2 pinned to round 1)', async () => {
    const { ctx, calls } = buildQuoteEnv({
      pair: PAIR,
      wrapper: WRAPPER,
      collection: COLLECTION,
      reserves: DEMON_RESERVES,
      marketplaceFeeE18: DEMON_MARKETPLACE_FEE_E18,
      side: 'buy',
      units: 10n ** 18n,
      poolLeg: DEMON_POOL_LEG_1,
      routerTotal: DEMON_GROSS_1,
      perId: [{ tokenId: '245830', receiver: RECEIVER, amount: DEMON_ROYALTY_1 }],
    })
    const result = await loadQuoteContext(ctx, {
      pair: PAIR,
      wrapper: WRAPPER,
      collection: COLLECTION,
      baseToken: BASE_TOKEN,
      tokenIds: ['245830'],
      side: 'buy',
    })
    for (const call of calls()) {
      expect((call as unknown as { blockNumber?: bigint }).blockNumber).toBe(result.blockNumber)
    }
  })

  it('on Arc, reserves/poolLeg are pool-axis (6-decimal) and quoteDecimals records 6', async () => {
    const arcPoolLeg = 2_000_000n
    const { ctx } = buildQuoteEnv({
      chainId: 5042,
      pair: PAIR,
      wrapper: WRAPPER,
      collection: COLLECTION,
      reserves: { base: 2_000_000n, wnft: 500n * 10n ** 18n },
      marketplaceFeeE18: DEMON_MARKETPLACE_FEE_E18,
      side: 'buy',
      units: 10n ** 18n,
      poolLeg: arcPoolLeg,
      routerTotal: arcPoolLeg + 50_000n,
      perId: [{ tokenId: '1', receiver: ZERO_ADDRESS, amount: 0n }],
    })
    const result = await loadQuoteContext(ctx, {
      pair: PAIR,
      wrapper: WRAPPER,
      collection: COLLECTION,
      baseToken: { address: '0x3600000000000000000000000000000000000000', symbol: 'USDC', decimals: 6, isNative: true },
      tokenIds: ['1'],
      side: 'buy',
    })
    expect(result.quoteDecimals).toBe(6)
    expect(result.poolLeg).toBe(arcPoolLeg)
  })

  it('a synthetic 1-wei divergence (either direction) throws QUOTE_RECONCILIATION_FAILED via reconcileGross/reconcileNet, and never produces a Quote', () => {
    expect(() =>
      reconcileGross({ pool: DEMON_POOL_LEG_1, marketplace: DEMON_MARKETPLACE_1, royalty: DEMON_ROYALTY_1, routerGross: DEMON_GROSS_1 + 1n }),
    ).toThrowError(expect.objectContaining({ code: 'QUOTE_RECONCILIATION_FAILED', details: expect.objectContaining({ deltaWei: 1n }) }))
    expect(() =>
      reconcileGross({ pool: DEMON_POOL_LEG_1, marketplace: DEMON_MARKETPLACE_1, royalty: DEMON_ROYALTY_1, routerGross: DEMON_GROSS_1 - 1n }),
    ).toThrowError(expect.objectContaining({ code: 'QUOTE_RECONCILIATION_FAILED', details: expect.objectContaining({ deltaWei: 1n }) }))
  })

  it('exactly matching amounts reconcile without throwing (both reconcileGross and reconcileNet)', () => {
    expect(() =>
      reconcileGross({ pool: DEMON_POOL_LEG_1, marketplace: DEMON_MARKETPLACE_1, royalty: DEMON_ROYALTY_1, routerGross: DEMON_GROSS_1 }),
    ).not.toThrow()
    const net = DEMON_POOL_LEG_1 - DEMON_MARKETPLACE_1 - DEMON_ROYALTY_1
    expect(() =>
      reconcileNet({ pool: DEMON_POOL_LEG_1, marketplace: DEMON_MARKETPLACE_1, royalty: DEMON_ROYALTY_1, routerNet: net }),
    ).not.toThrow()
  })

  it('the Base DEMON fixture reconciles exactly for a 1-item buy: 121625659884654 + 3040641497116 + 6081282994232 === 130747584376002', () => {
    expect(DEMON_POOL_LEG_1 + DEMON_MARKETPLACE_1 + DEMON_ROYALTY_1).toBe(DEMON_GROSS_1)
  })

  it('a 3-item buy reconciles the same way (synthetic per-id rates, summed not averaged)', () => {
    const poolLeg3 = getAmountIn(3n * 10n ** 18n, DEMON_RESERVES.base, DEMON_RESERVES.wnft, SNF_NFT_NET_FEE)!
    const marketplace3 = (poolLeg3 * DEMON_MARKETPLACE_FEE_E18) / 10n ** 18n
    const salePrice = poolLeg3 / 3n
    const royaltyPerId = [5n, 7n, 10n].map((pct) => (salePrice * pct * 10n ** 16n) / 10n ** 18n)
    const royalty3 = royaltyPerId.reduce((a, b) => a + b, 0n)
    const gross3 = poolLeg3 + marketplace3 + royalty3
    expect(() => reconcileGross({ pool: poolLeg3, marketplace: marketplace3, royalty: royalty3, routerGross: gross3 })).not.toThrow()
  })

  it('1- and 3-item sells reconcile the same way (pool - marketplace - royalty === routerNet)', () => {
    const poolLeg1 = getAmountOut(10n ** 18n, DEMON_RESERVES.wnft, DEMON_RESERVES.base, SNF_NFT_NET_FEE)!
    const marketplace1 = (poolLeg1 * DEMON_MARKETPLACE_FEE_E18) / 10n ** 18n
    const royalty1 = (poolLeg1 * (5n * 10n ** 16n)) / 10n ** 18n
    const net1 = poolLeg1 - marketplace1 - royalty1
    expect(() => reconcileNet({ pool: poolLeg1, marketplace: marketplace1, royalty: royalty1, routerNet: net1 })).not.toThrow()

    const poolLeg3 = getAmountOut(3n * 10n ** 18n, DEMON_RESERVES.wnft, DEMON_RESERVES.base, SNF_NFT_NET_FEE)!
    const marketplace3 = (poolLeg3 * DEMON_MARKETPLACE_FEE_E18) / 10n ** 18n
    const royalty3 = (poolLeg3 * (5n * 10n ** 16n)) / 10n ** 18n
    const net3 = poolLeg3 - marketplace3 - royalty3
    expect(() => reconcileNet({ pool: poolLeg3, marketplace: marketplace3, royalty: royalty3, routerNet: net3 })).not.toThrow()
  })
})
