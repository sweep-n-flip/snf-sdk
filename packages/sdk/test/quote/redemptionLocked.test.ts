import { describe, expect, it } from 'vitest'

import { quoteBuy } from '../../src/quote/quoteBuy'
import { buildQuoteEnv, ZERO_ADDRESS } from './testHelpers'

// A collection whose wrapper cannot release NFTs (a confirmed transfer-guard revert):
// a whole-NFT buy would revert on-chain and cost gas for nothing, so quoteBuy refuses.
const PAIR = '0x000000000000000000000000000000000000FA17' as `0x${string}`
const WRAPPER = '0x000000000000000000000000000000000000BAD1' as `0x${string}`
const COLLECTION = '0x000000000000000000000000000000000000c011' as `0x${string}`

function lockedEnv() {
  return buildQuoteEnv({
    pair: PAIR,
    wrapper: WRAPPER,
    collection: COLLECTION,
    reserves: { base: 1_297_217_522_559_477n, wnft: 11_883_323_065_263_036_728n },
    marketplaceFeeE18: 25n * 10n ** 15n,
    side: 'buy',
    units: 10n ** 18n,
    poolLeg: 121_625_659_884_654n,
    routerTotal: 130_747_584_376_002n,
    perId: [{ tokenId: '245830', receiver: ZERO_ADDRESS, amount: 0n }],
    redemptionLocked: true,
    candidateTokenIds: ['245830'],
  })
}

describe('quoteBuy refuses a redemption-locked collection', () => {
  it('a tokenIds buy throws REDEMPTION_LOCKED instead of pricing a purchase that would revert', async () => {
    await expect(quoteBuy(lockedEnv().ctx, { collection: COLLECTION, tokenIds: ['245830'] })).rejects.toMatchObject({
      code: 'REDEMPTION_LOCKED',
    })
  })

  it('a count buy throws REDEMPTION_LOCKED too', async () => {
    await expect(quoteBuy(lockedEnv().ctx, { collection: COLLECTION, count: 1 })).rejects.toMatchObject({
      code: 'REDEMPTION_LOCKED',
    })
  })

  it('a fractional (amount) buy never leaves the wrapper and is still quoted', async () => {
    const quote = await quoteBuy(lockedEnv().ctx, { collection: COLLECTION, amount: 5n * 10n ** 17n })
    expect(quote.side).toBe('buy')
  })
})
