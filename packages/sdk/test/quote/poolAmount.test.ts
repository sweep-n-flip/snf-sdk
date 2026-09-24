import { describe, expect, it, vi } from 'vitest'

import { toPoolAmount, toQuoteAmount } from '../../src/format'
import { quoteBuy } from '../../src/quote/quoteBuy'
import { quoteSell } from '../../src/quote/quoteSell'
import type { CollectionInfo } from '../../src/types/collection.types'
import { buildQuoteEnv } from './testHelpers'

// Every quote money field must be denominated in the quoted POOL's base token. The
// shared fixture only models native-base pools, so this file keeps the fixture's
// reads intact and relabels the resolved pool's base token as a 6-decimal ERC-20:
// if any quote field still came from the chain (`toQuoteAmount`), it would say
// "ETH" with 18 decimals.
const USDC_LIKE = { symbol: 'USDC', decimals: 6 }

vi.mock('../../src/collection/resolveCollection', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/collection/resolveCollection')>()
  return {
    ...real,
    resolveCollection: async (...a: Parameters<typeof real.resolveCollection>): Promise<CollectionInfo> => {
      const info = await real.resolveCollection(...a)
      return {
        ...info,
        pools: info.pools.map((p) => ({ ...p, baseToken: { ...p.baseToken, ...USDC_LIKE } })),
      }
    },
  }
})

const PAIR = '0x000000000000000000000000000000000000FA17' as `0x${string}`
const WRAPPER = '0x000000000000000000000000000000000000BAD1' as `0x${string}`
const COLLECTION = '0x000000000000000000000000000000000000c011' as `0x${string}`
const RECEIVER = '0x1111111111111111111111111111111111111111' as `0x${string}`

const RESERVES = { base: 1_297_217_522_559_477n, wnft: 11_883_323_065_263_036_728n }
const MARKETPLACE_FEE_E18 = 25n * 10n ** 15n

function buyEnv() {
  return buildQuoteEnv({
    pair: PAIR,
    wrapper: WRAPPER,
    collection: COLLECTION,
    reserves: RESERVES,
    marketplaceFeeE18: MARKETPLACE_FEE_E18,
    side: 'buy',
    units: 10n ** 18n,
    poolLeg: 121_625_659_884_654n,
    routerTotal: 130_747_584_376_002n,
    perId: [{ tokenId: '245830', receiver: RECEIVER, amount: 6_081_282_994_232n }],
  })
}

// Same internally-consistent sell shape as quoteSell.test.ts.
function sellEnv() {
  const amountInWithFee = 10n ** 18n * 9800n
  const poolLeg = (amountInWithFee * RESERVES.base) / (RESERVES.wnft * 10_000n + amountInWithFee)
  const marketplace = (poolLeg * MARKETPLACE_FEE_E18) / 10n ** 18n
  const royalty = (poolLeg * (5n * 10n ** 16n)) / 10n ** 18n
  return buildQuoteEnv({
    pair: PAIR,
    wrapper: WRAPPER,
    collection: COLLECTION,
    reserves: RESERVES,
    marketplaceFeeE18: MARKETPLACE_FEE_E18,
    side: 'sell',
    units: 10n ** 18n,
    poolLeg,
    routerTotal: poolLeg - marketplace - royalty,
    perId: [{ tokenId: '245830', receiver: RECEIVER, amount: royalty }],
  })
}

function expectPoolDenominated(a: { symbol: string; decimals: number; formatted: string } | undefined): void {
  expect(a?.symbol).toBe('USDC')
  expect(a?.decimals).toBe(6)
  expect(a?.formatted.endsWith(' USDC')).toBe(true)
}

describe('quote amounts follow the pool base token', () => {
  it('toPoolAmount uses the token symbol and decimals; toQuoteAmount stays on the chain', () => {
    expectPoolDenominated(toPoolAmount(USDC_LIKE, 1_500_000n))
    expect(toPoolAmount(USDC_LIKE, 1_500_000n).formatted).toBe('1.5 USDC')
    expect(toQuoteAmount(8453, 10n ** 18n).symbol).toBe('ETH')
  })

  it('quoteBuy: totalCost, marketplace, royalty and every leg amount', async () => {
    const q = await quoteBuy(buyEnv().ctx, { collection: COLLECTION, tokenIds: ['245830'] })
    expectPoolDenominated(q.totalCost)
    expectPoolDenominated(q.fees.marketplace)
    expectPoolDenominated(q.fees.royalty)
    for (const leg of q.legs) expectPoolDenominated(leg.amount)
  })

  it('quoteSell: totalProceeds, marketplace, royalty and every leg amount', async () => {
    const q = await quoteSell(sellEnv().ctx, { collection: COLLECTION, tokenIds: ['245830'] })
    expectPoolDenominated(q.totalProceeds)
    expectPoolDenominated(q.fees.marketplace)
    expectPoolDenominated(q.fees.royalty)
    for (const leg of q.legs) expectPoolDenominated(leg.amount)
  })
})
