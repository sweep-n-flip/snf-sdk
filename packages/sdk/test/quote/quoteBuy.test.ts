import { describe, expect, it } from 'vitest'

import { isSnfError } from '../../src/errors'
import { quoteBuy } from '../../src/quote/quoteBuy'
import { buildQuoteEnv, ZERO_ADDRESS } from './testHelpers'

/**
 * `quoteBuy` — gross from the Router, reconstructed additively, reconciled with
 * `===` (Task 2). Every `<behavior>` bullet is one `it`
 * below.
 */

const PAIR = '0x000000000000000000000000000000000000FA17' as `0x${string}`
const WRAPPER = '0x000000000000000000000000000000000000BAD1' as `0x${string}`
const COLLECTION = '0x000000000000000000000000000000000000c011' as `0x${string}`
const RECEIVER = '0x1111111111111111111111111111111111111111' as `0x${string}`

const DEMON_RESERVES = { base: 1_297_217_522_559_477n, wnft: 11_883_323_065_263_036_728n }
const DEMON_POOL_LEG_1 = 121_625_659_884_654n
const DEMON_MARKETPLACE_FEE_E18 = 25n * 10n ** 15n
const DEMON_MARKETPLACE_1 = 3_040_641_497_116n
const DEMON_ROYALTY_1 = 6_081_282_994_232n
const DEMON_GROSS_1 = 130_747_584_376_002n

function demonEnv(overrides: Partial<Parameters<typeof buildQuoteEnv>[0]> = {}) {
  return buildQuoteEnv({
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
    ...overrides,
  })
}

describe('quoteBuy (Task 2)', () => {
  it('reproduces the Base DEMON fixture to the wei: pool 121625659884654, marketplace 3040641497116, royalty 6081282994232, gross 130747584376002', async () => {
    const { ctx } = demonEnv()
    const quote = await quoteBuy(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['245830'] })
    expect(quote.totalCost?.value).toBe(DEMON_GROSS_1)
    expect(quote.fees.marketplace.value).toBe(DEMON_MARKETPLACE_1)
    expect(quote.fees.royalty.value).toBe(DEMON_ROYALTY_1)
    expect(quote.reconciled).toBe(true)
    expect(quote.deliverable).toBe(1)
    expect(quote.bestEffort).toBe(false)
  })

  it('a 3-item buy reconciles the same way, royalty computed per id at the truncated salePrice', async () => {
    const { getAmountIn, SNF_NFT_NET_FEE } = await import('../../src/math/quoteMath')
    const poolLeg3 = getAmountIn(3n * 10n ** 18n, DEMON_RESERVES.base, DEMON_RESERVES.wnft, SNF_NFT_NET_FEE)!
    const marketplace3 = (poolLeg3 * DEMON_MARKETPLACE_FEE_E18) / 10n ** 18n
    const salePrice = poolLeg3 / 3n
    const perId = [5n, 7n, 10n].map((pct) => (salePrice * pct * 10n ** 16n) / 10n ** 18n)
    const royalty3 = perId.reduce((a, b) => a + b, 0n)
    const gross3 = poolLeg3 + marketplace3 + royalty3
    const { ctx } = demonEnv({
      units: 3n * 10n ** 18n,
      poolLeg: poolLeg3,
      routerTotal: gross3,
      perId: [
        { tokenId: '1', receiver: RECEIVER, amount: perId[0]! },
        { tokenId: '2', receiver: RECEIVER, amount: perId[1]! },
        { tokenId: '3', receiver: RECEIVER, amount: perId[2]! },
      ],
    })
    const quote = await quoteBuy(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['1', '2', '3'] })
    expect(quote.totalCost?.value).toBe(gross3)
    expect(quote.fees.royalty.value).toBe(royalty3)
    expect(quote.deliverable).toBe(3)
  })

  it('mutating the Router gross by +1n throws QUOTE_RECONCILIATION_FAILED with details.deltaWei === 1n, no Quote returned', async () => {
    const { ctx } = demonEnv({ routerTotal: DEMON_GROSS_1 + 1n })
    let threw = false
    try {
      await quoteBuy(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['245830'] })
    } catch (e) {
      threw = true
      expect(isSnfError(e)).toBe(true)
      expect((e as { code: string }).code).toBe('QUOTE_RECONCILIATION_FAILED')
      expect((e as { details?: { deltaWei?: bigint } }).details?.deltaWei).toBe(1n)
    }
    expect(threw).toBe(true)
  })

  it('mutating the Router gross by -1n throws the same way (symmetric)', async () => {
    const { ctx } = demonEnv({ routerTotal: DEMON_GROSS_1 - 1n })
    await expect(quoteBuy(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['245830'] })).rejects.toMatchObject({
      code: 'QUOTE_RECONCILIATION_FAILED',
      details: { deltaWei: 1n },
    })
  })

  it('count === availableCount yields bestEffort:false', async () => {
    // reserveWnft = 12e18 -> availableCountFromReserve = floor(12) - 1 = 11
    const { ctx } = demonEnv({
      reserves: { base: 5n * 10n ** 18n, wnft: 12n * 10n ** 18n },
      units: 11n * 10n ** 18n,
      poolLeg: 1_000_000n,
      routerTotal: 1_025_000n,
      perId: Array.from({ length: 11 }, (_u, i) => ({ tokenId: String(i + 1), receiver: RECEIVER, amount: 0n })),
      candidateTokenIds: Array.from({ length: 11 }, (_u, i) => String(i + 1)),
    })
    const quote = await quoteBuy(ctx, { chainId: 8453, collection: COLLECTION, count: 11 })
    expect(quote.deliverable).toBe(11)
    expect(quote.bestEffort).toBe(false)
  })

  it('count === availableCount + 1 yields bestEffort:true, deliverable === availableCount, and prices only the deliverable amount', async () => {
    const { ctx } = demonEnv({
      reserves: { base: 5n * 10n ** 18n, wnft: 12n * 10n ** 18n },
      units: 11n * 10n ** 18n,
      poolLeg: 1_000_000n,
      routerTotal: 1_025_000n,
      perId: Array.from({ length: 11 }, (_u, i) => ({ tokenId: String(i + 1), receiver: RECEIVER, amount: 0n })),
      candidateTokenIds: Array.from({ length: 11 }, (_u, i) => String(i + 1)),
    })
    const quote = await quoteBuy(ctx, { chainId: 8453, collection: COLLECTION, count: 12 })
    expect(quote.deliverable).toBe(11)
    expect(quote.bestEffort).toBe(true)
    expect(quote.legs[0]?.count).toBe(11)
  })

  it('count: 0 throws INVALID_PARAMS', async () => {
    const { ctx } = demonEnv()
    await expect(quoteBuy(ctx, { chainId: 8453, collection: COLLECTION, count: 0 })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    })
  })

  it('tokenIds: [] throws INVALID_PARAMS', async () => {
    const { ctx } = demonEnv()
    await expect(quoteBuy(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: [] })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    })
  })

  it('more than 50 tokenIds throws INVALID_PARAMS', async () => {
    const { ctx } = demonEnv()
    const tokenIds = Array.from({ length: 51 }, (_u, i) => String(i + 1))
    await expect(quoteBuy(ctx, { chainId: 8453, collection: COLLECTION, tokenIds })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    })
  })

  it('args.amount (fractional wNFT) routes through the fungible leg, kind: "wnft", no *Collection call', async () => {
    const { ctx, multicall } = demonEnv()
    const amount = 5n * 10n ** 17n // 0.5 NFT
    const { getAmountIn } = await import('../../src/math/quoteMath')
    const localCost = getAmountIn(amount, DEMON_RESERVES.base, DEMON_RESERVES.wnft, 9800n)!
    const quote = await quoteBuy(ctx, { chainId: 8453, collection: COLLECTION, amount })
    expect(quote.legs[0]?.kind).toBe('wnft')
    expect(quote.totalCost?.value).toBe(localCost)
    for (const call of multicall.mock.calls) {
      const fns = (call[0] as { contracts: readonly { functionName: string }[] }).contracts.map((c) => c.functionName)
      expect(fns.includes('getAmountsInCollection')).toBe(false)
    }
  })

  it('a per-token-royalty collection sums the true per-id reads — an averaged rate would differ', async () => {
    // Hand-verified: salePrice=109, rateA=7%, rateB=13% -> amountA=7, amountB=14,
    // trueSum=21; the naive "one averaged 10% rate applied per id, twice" would
    // give floor(109*0.10)*2 = 20 — a real, non-coincidental difference.
    const poolLeg2 = 218n
    const marketplace2 = 0n
    const salePrice = poolLeg2 / 2n
    const rateA = 7n * 10n ** 16n // 7%
    const rateB = 13n * 10n ** 16n // 13%
    const amountA = (salePrice * rateA) / 10n ** 18n
    const amountB = (salePrice * rateB) / 10n ** 18n
    const trueSum = amountA + amountB
    const avgRate = (rateA + rateB) / 2n
    const averagedTotal = ((salePrice * avgRate) / 10n ** 18n) * 2n
    expect(trueSum).not.toBe(averagedTotal)

    const gross2 = poolLeg2 + marketplace2 + trueSum
    const { ctx } = demonEnv({
      marketplaceFeeE18: 0n,
      units: 2n * 10n ** 18n,
      poolLeg: poolLeg2,
      routerTotal: gross2,
      perId: [
        { tokenId: '1', receiver: RECEIVER, amount: amountA },
        { tokenId: '2', receiver: RECEIVER, amount: amountB },
      ],
    })
    const quote = await quoteBuy(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['1', '2'] })
    expect(quote.fees.royalty.value).toBe(trueSum)
    expect(quote.fees.royalty.value).not.toBe(averagedTotal)
  })

  it('priceImpact is a number in [0,100] and expiresAt is ~30s in the future', async () => {
    const { ctx } = demonEnv()
    const before = Date.now()
    const quote = await quoteBuy(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['245830'] })
    expect(quote.priceImpact).toBeGreaterThanOrEqual(0)
    expect(quote.priceImpact).toBeLessThanOrEqual(100)
    const expiresAtMs = new Date(quote.expiresAt).getTime()
    expect(expiresAtMs - before).toBeGreaterThan(25_000)
    expect(expiresAtMs - before).toBeLessThan(35_000)
  })

  it('every monetary field is an Amount with value and formatted', async () => {
    const { ctx } = demonEnv()
    const quote = await quoteBuy(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['245830'] })
    expect(typeof quote.totalCost?.value).toBe('bigint')
    expect(typeof quote.totalCost?.formatted).toBe('string')
    expect(typeof quote.fees.marketplace.value).toBe('bigint')
    expect(typeof quote.fees.marketplace.formatted).toBe('string')
    expect(typeof quote.fees.royalty.value).toBe('bigint')
    expect(typeof quote.fees.royalty.formatted).toBe('string')
  })

  it('on Arc, formatted amounts use 6 decimals with the Arc quote symbol', async () => {
    const { ctx } = demonEnv({
      chainId: 5042,
      reserves: { base: 2_000_000n, wnft: 500n * 10n ** 18n },
      poolLeg: 2_000_000n,
      routerTotal: 2_050_000n,
      perId: [{ tokenId: '1', receiver: ZERO_ADDRESS, amount: 0n }],
    })
    const quote = await quoteBuy(ctx, { chainId: 5042, collection: COLLECTION, tokenIds: ['1'] })
    expect(quote.totalCost?.decimals).toBe(6)
    expect(quote.totalCost?.symbol).toBe('USDC')
  })

  it('no pool for the collection throws NO_ROUTE', async () => {
    const { ctx, multicall } = demonEnv()
    multicall.mockImplementationOnce(async () => [
      { status: 'success', result: '0x0000000000000000000000000000000000000000' },
      { status: 'success', result: 'X' },
      { status: 'success', result: 'X' },
    ])
    await expect(quoteBuy(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['1'] })).rejects.toMatchObject({
      code: 'NO_ROUTE',
    })
  })

  it('exactly one of tokenIds/count/amount is enforced — passing both throws INVALID_PARAMS', async () => {
    const { ctx } = demonEnv()
    await expect(
      quoteBuy(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['1'], count: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
  })

  it('a chainId matching the client\'s own chain behaves identically to chainId omitted', async () => {
    const { ctx: ctxMatching } = demonEnv()
    const quoteMatching = await quoteBuy(ctxMatching, { chainId: 8453, collection: COLLECTION, tokenIds: ['245830'] })
    const { ctx: ctxOmitted } = demonEnv()
    const quoteOmitted = await quoteBuy(ctxOmitted, { collection: COLLECTION, tokenIds: ['245830'] })
    // expiresAt is wall-clock-derived (Date.now() + QUOTE_TTL_MS) so it is compared
    // separately rather than via a blanket toEqual, which would be flaky across a
    // millisecond boundary between the two calls.
    const { expiresAt: expiresAtMatching, ...restMatching } = quoteMatching
    const { expiresAt: expiresAtOmitted, ...restOmitted } = quoteOmitted
    expect(restMatching).toEqual(restOmitted)
    expect(typeof expiresAtMatching).toBe('string')
    expect(typeof expiresAtOmitted).toBe('string')
  })

  it('a chainId mismatched against the client\'s own chain throws WRONG_CHAIN before any on-chain read', async () => {
    const { ctx, multicall } = demonEnv()
    await expect(
      quoteBuy(ctx, { chainId: 1, collection: COLLECTION, tokenIds: ['245830'] }),
    ).rejects.toMatchObject({ code: 'WRONG_CHAIN' })
    expect(multicall).not.toHaveBeenCalled()
  })
})
