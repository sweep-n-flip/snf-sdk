import { describe, expect, it } from 'vitest'

import { quoteSell } from '../../src/quote/quoteSell'
import { buildQuoteEnv, ZERO_ADDRESS } from './testHelpers'

/**
 * `quoteSell` — the Router's number is already NET, and never re-subtracted
 * (Task 3). Every `<behavior>` bullet is one `it`
 * below.
 *
 * The two Base sell fixtures (`91417099472198` and `237988677509668`) were flagged
 * as "never independently traced to a source". A later fork session closed that
 * assumption: both were re-derived live against the real Base Router
 * (`getAmountsOutCollection`, block 51599577, 2026-09-21) and matched exactly, so
 * the two bottom `it`s below now assert the real numbers (see
 * `test/fork/base.fork.test.ts` and `test/fixtures/collections/base-demon.json`'s
 * `sellFixtures`).
 */

const PAIR = '0x000000000000000000000000000000000000FA17' as `0x${string}`
const WRAPPER = '0x000000000000000000000000000000000000BAD1' as `0x${string}`
const COLLECTION = '0x000000000000000000000000000000000000c011' as `0x${string}`
const RECEIVER = '0x1111111111111111111111111111111111111111' as `0x${string}`

// Synthetic, internally-consistent sell fixture for every OTHER test in this file
// (kept exactly as originally built — a real, deterministic pool shape, but not
// wired to a real Router call). The bottom two `it`s use the SAME reserves, which
// happen to be the DEMON pool's real historical reserves (`base-demon.json`) — that
// coincidence is what let the flagged assumption above be closed by pure
// reconstruction PLUS a live cross-check, both in this file and in
// `test/fork/base.fork.test.ts`.
const RESERVES = { base: 1_297_217_522_559_477n, wnft: 11_883_323_065_263_036_728n }
const MARKETPLACE_FEE_E18 = 25n * 10n ** 15n // 2.5%

function poolLegSell(count: bigint) {
  // getAmountOut(count*1e18, reserveWnft, reserveBase, 9800)
  const amountInWithFee = count * 10n ** 18n * 9800n
  const numerator = amountInWithFee * RESERVES.base
  const denominator = RESERVES.wnft * 10_000n + amountInWithFee
  return numerator / denominator
}

function sellEnv(overrides: Partial<Parameters<typeof buildQuoteEnv>[0]> = {}) {
  return buildQuoteEnv({
    pair: PAIR,
    wrapper: WRAPPER,
    collection: COLLECTION,
    reserves: RESERVES,
    marketplaceFeeE18: MARKETPLACE_FEE_E18,
    side: 'sell',
    units: 10n ** 18n,
    poolLeg: 0n,
    routerTotal: 0n,
    perId: [],
    ...overrides,
  })
}

describe('quoteSell (Task 3)', () => {
  it('totalProceeds equals the Router getAmountsOutCollection answer verbatim — no further subtraction anywhere', async () => {
    const poolLeg1 = poolLegSell(1n)
    const marketplace1 = (poolLeg1 * MARKETPLACE_FEE_E18) / 10n ** 18n
    const royalty1 = (poolLeg1 * (5n * 10n ** 16n)) / 10n ** 18n
    const net1 = poolLeg1 - marketplace1 - royalty1
    const { ctx } = sellEnv({
      poolLeg: poolLeg1,
      routerTotal: net1,
      perId: [{ tokenId: '245830', receiver: RECEIVER, amount: royalty1 }],
    })
    const quote = await quoteSell(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['245830'] })
    expect(quote.totalProceeds?.value).toBe(net1)
  })

  it('fees.marketplace and fees.royalty are the amounts the Router deducted — pool - marketplace - royalty === routerNet holds with ===', async () => {
    const poolLeg1 = poolLegSell(1n)
    const marketplace1 = (poolLeg1 * MARKETPLACE_FEE_E18) / 10n ** 18n
    const royalty1 = (poolLeg1 * (5n * 10n ** 16n)) / 10n ** 18n
    const net1 = poolLeg1 - marketplace1 - royalty1
    const { ctx } = sellEnv({
      poolLeg: poolLeg1,
      routerTotal: net1,
      perId: [{ tokenId: '245830', receiver: RECEIVER, amount: royalty1 }],
    })
    const quote = await quoteSell(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['245830'] })
    expect(quote.fees.marketplace.value).toBe(marketplace1)
    expect(quote.fees.royalty.value).toBe(royalty1)
    expect(poolLeg1 - quote.fees.marketplace.value - quote.fees.royalty.value).toBe(net1)
  })

  it('a synthetic 1-wei divergence throws QUOTE_RECONCILIATION_FAILED and returns no Quote', async () => {
    const poolLeg1 = poolLegSell(1n)
    const marketplace1 = (poolLeg1 * MARKETPLACE_FEE_E18) / 10n ** 18n
    const royalty1 = (poolLeg1 * (5n * 10n ** 16n)) / 10n ** 18n
    const net1 = poolLeg1 - marketplace1 - royalty1
    const { ctx } = sellEnv({
      poolLeg: poolLeg1,
      routerTotal: net1 + 1n,
      perId: [{ tokenId: '245830', receiver: RECEIVER, amount: royalty1 }],
    })
    await expect(quoteSell(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['245830'] })).rejects.toMatchObject({
      code: 'QUOTE_RECONCILIATION_FAILED',
      details: { deltaWei: 1n },
    })
  })

  it('a synthetic 1-wei divergence in the other direction also throws (symmetric)', async () => {
    const poolLeg1 = poolLegSell(1n)
    const marketplace1 = (poolLeg1 * MARKETPLACE_FEE_E18) / 10n ** 18n
    const royalty1 = (poolLeg1 * (5n * 10n ** 16n)) / 10n ** 18n
    const net1 = poolLeg1 - marketplace1 - royalty1
    const { ctx } = sellEnv({
      poolLeg: poolLeg1,
      routerTotal: net1 - 1n,
      perId: [{ tokenId: '245830', receiver: RECEIVER, amount: royalty1 }],
    })
    await expect(quoteSell(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['245830'] })).rejects.toMatchObject({
      code: 'QUOTE_RECONCILIATION_FAILED',
      details: { deltaWei: 1n },
    })
  })

  it('a sell of 3 ids computes royalty per id at the truncated salePrice derived from the pool leg, not the net', async () => {
    const poolLeg3 = poolLegSell(3n)
    const marketplace3 = (poolLeg3 * MARKETPLACE_FEE_E18) / 10n ** 18n
    const salePrice = poolLeg3 / 3n
    const perId = [5n, 7n, 10n].map((pct) => (salePrice * pct * 10n ** 16n) / 10n ** 18n)
    const royalty3 = perId.reduce((a, b) => a + b, 0n)
    const net3 = poolLeg3 - marketplace3 - royalty3
    const { ctx } = sellEnv({
      units: 3n * 10n ** 18n,
      poolLeg: poolLeg3,
      routerTotal: net3,
      perId: [
        { tokenId: '1', receiver: RECEIVER, amount: perId[0]! },
        { tokenId: '2', receiver: RECEIVER, amount: perId[1]! },
        { tokenId: '3', receiver: RECEIVER, amount: perId[2]! },
      ],
    })
    const quote = await quoteSell(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['1', '2', '3'] })
    expect(quote.fees.royalty.value).toBe(royalty3)
    expect(quote.totalProceeds?.value).toBe(net3)
  })

  it('redemptionLocked === true adds a warnings entry and does NOT throw — a wNFT sale is still possible', async () => {
    const poolLeg1 = poolLegSell(1n)
    const net1 = poolLeg1 - (poolLeg1 * MARKETPLACE_FEE_E18) / 10n ** 18n
    const { ctx } = sellEnv({
      poolLeg: poolLeg1,
      routerTotal: net1,
      perId: [{ tokenId: '245830', receiver: ZERO_ADDRESS, amount: 0n }],
      redemptionLocked: true,
      candidateTokenIds: ['245830'],
    })
    const quote = await quoteSell(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['245830'] })
    expect(quote.warnings?.some((w) => /redemption/i.test(w))).toBe(true)
  })

  it('tokenIds: [] throws INVALID_PARAMS', async () => {
    const { ctx } = sellEnv()
    await expect(quoteSell(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: [] })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    })
  })

  it('more than 50 ids throws INVALID_PARAMS', async () => {
    const { ctx } = sellEnv()
    const tokenIds = Array.from({ length: 51 }, (_u, i) => String(i + 1))
    await expect(quoteSell(ctx, { chainId: 8453, collection: COLLECTION, tokenIds })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    })
  })

  it('a wNFT (fractional) sell routes through the fungible leg with kind: "wnft"', async () => {
    const { ctx } = sellEnv()
    const amount = 5n * 10n ** 17n
    const quote = await quoteSell(ctx, { chainId: 8453, collection: COLLECTION, amount })
    expect(quote.legs[0]?.kind).toBe('wnft')
    expect(quote.totalProceeds).toBeDefined()
  })

  it('on Arc, a zero-address EIP-2981 receiver reduces fees.royalty by the unpayable share, with a warning, adjusted BEFORE reconciliation', async () => {
    // Arc: pool 2,000,000 (6-dec quote units). marketplace 2.5% = 50,000. Two ids,
    // one payable (receiver RECEIVER) royalty 40,000, one unpayable (zero address)
    // royalty 30,000. The Router's own net ALREADY reflects the unpayable share
    // being returned to the seller, so it only deducted marketplace + payable
    // royalty: net = 2,000,000 - 50,000 - 40,000 = 1,910,000 (NOT -30,000 more).
    const poolLeg2 = 2_000_000n
    const marketplace2 = (poolLeg2 * MARKETPLACE_FEE_E18) / 10n ** 18n
    const payableRoyalty = 40_000n
    const unpayableRoyalty = 30_000n
    const net2 = poolLeg2 - marketplace2 - payableRoyalty
    const { ctx } = sellEnv({
      chainId: 5042,
      reserves: { base: 2_000_000n, wnft: 500n * 10n ** 18n },
      units: 2n * 10n ** 18n,
      poolLeg: poolLeg2,
      routerTotal: net2,
      perId: [
        { tokenId: '1', receiver: RECEIVER, amount: payableRoyalty },
        { tokenId: '2', receiver: ZERO_ADDRESS, amount: unpayableRoyalty },
      ],
    })
    const quote = await quoteSell(ctx, { chainId: 5042, collection: COLLECTION, tokenIds: ['1', '2'] })
    expect(quote.fees.royalty.value).toBe(payableRoyalty)
    expect(quote.totalProceeds?.value).toBe(net2)
    expect(quote.warnings?.some((w) => /unpayable|zero address/i.test(w))).toBe(true)
  })

  it('every monetary field is an Amount with value and formatted', async () => {
    const poolLeg1 = poolLegSell(1n)
    const net1 = poolLeg1 - (poolLeg1 * MARKETPLACE_FEE_E18) / 10n ** 18n
    const { ctx } = sellEnv({
      poolLeg: poolLeg1,
      routerTotal: net1,
      perId: [{ tokenId: '245830', receiver: ZERO_ADDRESS, amount: 0n }],
    })
    const quote = await quoteSell(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['245830'] })
    expect(typeof quote.totalProceeds?.value).toBe('bigint')
    expect(typeof quote.totalProceeds?.formatted).toBe('string')
  })

  it('priceImpact is a number in [0,100] and expiresAt is ~30s in the future', async () => {
    const poolLeg1 = poolLegSell(1n)
    const net1 = poolLeg1 - (poolLeg1 * MARKETPLACE_FEE_E18) / 10n ** 18n
    const { ctx } = sellEnv({
      poolLeg: poolLeg1,
      routerTotal: net1,
      perId: [{ tokenId: '245830', receiver: ZERO_ADDRESS, amount: 0n }],
    })
    const before = Date.now()
    const quote = await quoteSell(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['245830'] })
    expect(quote.priceImpact).toBeGreaterThanOrEqual(0)
    expect(quote.priceImpact).toBeLessThanOrEqual(100)
    const expiresAtMs = new Date(quote.expiresAt).getTime()
    expect(expiresAtMs - before).toBeGreaterThan(25_000)
    expect(expiresAtMs - before).toBeLessThan(35_000)
  })

  it('a count-only sell (no tokenIds) throws INVALID_PARAMS — there is no owner address to resolve holdings from', async () => {
    const { ctx } = sellEnv()
    await expect(quoteSell(ctx, { chainId: 8453, collection: COLLECTION, count: 1 })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    })
  })

  it('no pool for the collection throws NO_ROUTE', async () => {
    const { ctx, multicall } = sellEnv()
    multicall.mockImplementationOnce(async () => [
      { status: 'success', result: '0x0000000000000000000000000000000000000000' },
      { status: 'success', result: 'X' },
      { status: 'success', result: 'X' },
    ])
    await expect(quoteSell(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['1'] })).rejects.toMatchObject({
      code: 'NO_ROUTE',
    })
  })

  // The previously-flagged assumption is closed: both figures were re-derived live
  // against the real Base Router (getAmountsOutCollection, block 51599577,
  // mainnet.base.org, 2026-09-21) — see test/fork/base.fork.test.ts for the live
  // on-chain read and test/fixtures/collections/base-demon.json's `sellFixtures`.
  // The live Router figures matched the flagged numbers exactly, to
  // the wei, in both directions (raw Router call and local reconstruction).
  it('Base sell-side fixture: selling DEMON tokenId 245830 nets 91417099472198 wei (real reserves, real 2.5%/5% rates)', async () => {
    const poolLeg1 = poolLegSell(1n)
    expect(poolLeg1).toBe(98_829_296_726_700n)
    const marketplace1 = (poolLeg1 * MARKETPLACE_FEE_E18) / 10n ** 18n
    const royalty1 = (poolLeg1 * (5n * 10n ** 16n)) / 10n ** 18n
    const net1 = poolLeg1 - marketplace1 - royalty1
    expect(net1).toBe(91_417_099_472_198n)
    const { ctx } = sellEnv({
      poolLeg: poolLeg1,
      routerTotal: net1,
      perId: [{ tokenId: '245830', receiver: RECEIVER, amount: royalty1 }],
    })
    const quote = await quoteSell(ctx, { chainId: 8453, collection: COLLECTION, tokenIds: ['245830'] })
    expect(quote.totalProceeds?.value).toBe(91_417_099_472_198n)
  })

  it('Base sell-side fixture: selling 3 DEMON ids nets 237988677509668 wei (real reserves, real 2.5%/5% rates)', async () => {
    const poolLeg3 = poolLegSell(3n)
    expect(poolLeg3).toBe(257_285_056_767_207n)
    const marketplace3 = (poolLeg3 * MARKETPLACE_FEE_E18) / 10n ** 18n
    const salePrice = poolLeg3 / 3n
    const perId = [salePrice, salePrice, salePrice].map((sp) => (sp * (5n * 10n ** 16n)) / 10n ** 18n)
    const royalty3 = perId.reduce((a, b) => a + b, 0n)
    const net3 = poolLeg3 - marketplace3 - royalty3
    expect(net3).toBe(237_988_677_509_668n)
    const { ctx } = sellEnv({
      units: 3n * 10n ** 18n,
      poolLeg: poolLeg3,
      routerTotal: net3,
      perId: [
        { tokenId: '246125', receiver: RECEIVER, amount: perId[0]! },
        { tokenId: '246171', receiver: RECEIVER, amount: perId[1]! },
        { tokenId: '245868', receiver: RECEIVER, amount: perId[2]! },
      ],
    })
    const quote = await quoteSell(ctx, {
      chainId: 8453,
      collection: COLLECTION,
      tokenIds: ['246125', '246171', '245868'],
    })
    expect(quote.totalProceeds?.value).toBe(237_988_677_509_668n)
  })

  it('a chainId matching the client\'s own chain behaves identically to chainId omitted', async () => {
    const poolLeg1 = poolLegSell(1n)
    const marketplace1 = (poolLeg1 * MARKETPLACE_FEE_E18) / 10n ** 18n
    const royalty1 = (poolLeg1 * (5n * 10n ** 16n)) / 10n ** 18n
    const net1 = poolLeg1 - marketplace1 - royalty1
    const fixtureOverrides = {
      poolLeg: poolLeg1,
      routerTotal: net1,
      perId: [{ tokenId: '245830', receiver: RECEIVER, amount: royalty1 }],
    }
    const { ctx: ctxMatching } = sellEnv(fixtureOverrides)
    const quoteMatching = await quoteSell(ctxMatching, { chainId: 8453, collection: COLLECTION, tokenIds: ['245830'] })
    const { ctx: ctxOmitted } = sellEnv(fixtureOverrides)
    const quoteOmitted = await quoteSell(ctxOmitted, { collection: COLLECTION, tokenIds: ['245830'] })
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
    const { ctx, multicall } = sellEnv()
    await expect(
      quoteSell(ctx, { chainId: 1, collection: COLLECTION, tokenIds: ['245830'] }),
    ).rejects.toMatchObject({ code: 'WRONG_CHAIN' })
    expect(multicall).not.toHaveBeenCalled()
  })
})
