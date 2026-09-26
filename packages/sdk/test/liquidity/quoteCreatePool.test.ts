import { describe, expect, it } from 'vitest'

import { isSnfError, SnfError } from '../../src/errors'
import { MAX_TOKEN_IDS, MIN_NEW_POOL_NFTS } from '../../src/build/validate'
import { MINIMUM_LIQUIDITY, floorSqrt } from '../../src/liquidity/liquidityMath'
import { quoteCreatePool } from '../../src/liquidity/quoteCreatePool'
import { buildLiquidityEnv } from './liquidityTestHelpers'

const COLLECTION = '0x000000000000000000000000000000000000c011' as `0x${string}`
const WRAPPER = '0x000000000000000000000000000000000000BAD1' as `0x${string}`
const PAIR = '0x000000000000000000000000000000000000FA17' as `0x${string}`
const BASE_ERC20 = '0x000000000000000000000000000000000000BA5E' as `0x${string}`
const OTHER_WRAPPER = '0x000000000000000000000000000000000000BEEF' as `0x${string}`

function sixIds(): readonly string[] {
  return ['1', '2', '3', '4', '5', '6']
}

async function expectRejectsWithCode(p: Promise<unknown>, code: string): Promise<{ readonly error: SnfError }> {
  let threw: unknown
  try {
    await p
  } catch (e) {
    threw = e
  }
  expect(isSnfError(threw)).toBe(true)
  expect((threw as SnfError).code).toBe(code)
  return { error: threw as SnfError }
}

describe('quoteCreatePool — a genuinely new pool (no wrapper, no pair)', () => {
  it('prices a first-mint deposit exactly, with pair/wrapper null and a display price per NFT', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null })
    const baseAmount = 12_000_000_000_000_000_000n // 12 ETH for 6 NFTs -> 2 ETH/NFT
    const quote = await quoteCreatePool(env.ctx, { collection: COLLECTION, tokenIds: sixIds(), baseAmount })

    expect(quote.side).toBe('create-pool')
    expect(quote.liquidity?.pair).toBeNull()
    expect(quote.liquidity?.wrapper).toBeNull()
    const expectedLp = floorSqrt(6n * 10n ** 18n * baseAmount) - MINIMUM_LIQUIDITY
    expect(quote.liquidity?.lpOut?.value).toBe(expectedLp)
    expect(quote.liquidity?.pricePerNft?.value).toBe(baseAmount / 6n)
    expect(quote.totalCost?.value).toBe(baseAmount)
    expect(quote.deliverable).toBe(6)
    expect(quote.legs).toEqual([])
    expect(quote.priceImpact).toBe(0)
    expect(quote.reconciled).toBe(true)
    expect(quote.liquidity?.feeToZero).toBe(true)
    expect(quote.fees.pool.note.toLowerCase()).toContain('no fee')
    const expiryMs = new Date(quote.expiresAt).getTime() - Date.now()
    expect(expiryMs).toBeGreaterThan(25_000)
    expect(expiryMs).toBeLessThanOrEqual(30_000)
  })
})

describe('quoteCreatePool — the six-NFT minimum floor', () => {
  it('five tokenIds throws INVALID_PARAMS with details.field tokenIds and details.min 6', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null })
    const { error } = await expectRejectsWithCode(
      quoteCreatePool(env.ctx, { collection: COLLECTION, tokenIds: ['1', '2', '3', '4', '5'], baseAmount: 1n }),
      'INVALID_PARAMS',
    )
    expect(error.details?.field).toBe('tokenIds')
    expect(error.details?.min).toBe(MIN_NEW_POOL_NFTS)
  })

  it('fifty-one tokenIds throws INVALID_PARAMS whose message names buildSeed', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null })
    const tokenIds = Array.from({ length: MAX_TOKEN_IDS + 1 }, (_, i) => String(i + 1))
    const { error } = await expectRejectsWithCode(
      quoteCreatePool(env.ctx, { collection: COLLECTION, tokenIds, baseAmount: 1n }),
      'INVALID_PARAMS',
    )
    expect(error.message).toContain('buildSeed')
  })
})

describe('quoteCreatePool — create-vs-add decided from live reserves', () => {
  it('a pair that already has reserves throws INVALID_PARAMS reason pool-has-liquidity', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      reserves: { base: 5_000_000_000_000_000_000n, wnft: 12_000_000_000_000_000_000n },
    })
    const { error } = await expectRejectsWithCode(
      quoteCreatePool(env.ctx, { collection: COLLECTION, tokenIds: sixIds(), baseAmount: 1n }),
      'INVALID_PARAMS',
    )
    expect(error.details?.reason).toBe('pool-has-liquidity')
  })

  it('an existing but EMPTY pair is priced as a create, with liquidity.pair set', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, reserves: { base: 0n, wnft: 0n } })
    const baseAmount = 6_000_000_000_000_000_000n
    const quote = await quoteCreatePool(env.ctx, { collection: COLLECTION, tokenIds: sixIds(), baseAmount })
    expect(quote.liquidity?.pair).toBe(PAIR)
    expect(quote.liquidity?.wrapper).toBe(WRAPPER)
    const expectedLp = floorSqrt(6n * 10n ** 18n * baseAmount) - MINIMUM_LIQUIDITY
    expect(quote.liquidity?.lpOut?.value).toBe(expectedLp)
  })
})

describe('quoteCreatePool — base identity rules', () => {
  it('baseToken equal to the raw collection address throws INVALID_PARAMS reason base-is-collection', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null })
    const { error } = await expectRejectsWithCode(
      quoteCreatePool(env.ctx, { collection: COLLECTION, tokenIds: sixIds(), baseAmount: 1n, baseToken: COLLECTION }),
      'INVALID_PARAMS',
    )
    expect(error.details?.reason).toBe('base-is-collection')
  })

  it("baseToken equal to this collection's own wrapper throws INVALID_PARAMS reason base-is-own-wrapper", async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: null,
      baseToken: { address: WRAPPER, decimals: 18, symbol: 'WNFT' },
    })
    const { error } = await expectRejectsWithCode(
      quoteCreatePool(env.ctx, { collection: COLLECTION, tokenIds: sixIds(), baseAmount: 1n, baseToken: WRAPPER }),
      'INVALID_PARAMS',
    )
    expect(error.details?.reason).toBe('base-is-own-wrapper')
  })

  it("baseToken equal to another collection's wrapper throws INVALID_PARAMS reason base-is-other-wrapper", async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: null,
      baseToken: { address: OTHER_WRAPPER, decimals: 18, symbol: 'WNFT' },
      baseIsWrapperOfCollection: '0x00000000000000000000000000000000000FA57',
    })
    const { error } = await expectRejectsWithCode(
      quoteCreatePool(env.ctx, { collection: COLLECTION, tokenIds: sixIds(), baseAmount: 1n, baseToken: OTHER_WRAPPER }),
      'INVALID_PARAMS',
    )
    expect(error.details?.reason).toBe('base-is-other-wrapper')
  })

  it('baseAmount <= 0n throws INVALID_PARAMS naming the field', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null })
    const { error } = await expectRejectsWithCode(
      quoteCreatePool(env.ctx, { collection: COLLECTION, tokenIds: sixIds(), baseAmount: 0n }),
      'INVALID_PARAMS',
    )
    expect(error.details?.field).toBe('baseAmount')
  })
})

describe('quoteCreatePool — ERC-20 base ', () => {
  it('a well-formed ERC-20 base creates cleanly with no wrapper-identity conflict', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: null,
      baseToken: { address: BASE_ERC20, decimals: 18, symbol: 'USDC' },
    })
    const quote = await quoteCreatePool(env.ctx, {
      collection: COLLECTION,
      tokenIds: sixIds(),
      baseAmount: 6_000_000_000_000_000_000n,
      baseToken: BASE_ERC20,
    })
    expect(quote.liquidity?.baseToken.address?.toLowerCase()).toBe(BASE_ERC20.toLowerCase())
    // Create/seed sends the exact caller-chosen amount on both sides — there is no
    // ceil-vs-floor rounding trap here (unlike an add into an already-priced pool),
    // so no baseDesired field is carried at all.
    expect(quote.liquidity?.baseDesired).toBeUndefined()
  })
})

describe('quoteCreatePool — chain guard', () => {
  it('a mismatched chainId throws WRONG_CHAIN before any on-chain read', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null })
    await expectRejectsWithCode(
      quoteCreatePool(env.ctx, { collection: COLLECTION, tokenIds: sixIds(), baseAmount: 1n, chainId: 137 }),
      'WRONG_CHAIN',
    )
    expect(env.multicall).not.toHaveBeenCalled()
  })
})
