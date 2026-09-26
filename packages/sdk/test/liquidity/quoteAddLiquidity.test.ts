import { describe, expect, it } from 'vitest'

import { isSnfError, SnfError } from '../../src/errors'
import { minErc20Desired, requiredBase } from '../../src/liquidity/liquidityMath'
import { quoteAddLiquidity } from '../../src/liquidity/quoteAddLiquidity'
import { getChain } from '../../src/chains/registry'
import { buildLiquidityEnv } from './liquidityTestHelpers'

const COLLECTION = '0x000000000000000000000000000000000000c011' as `0x${string}`
const WRAPPER = '0x000000000000000000000000000000000000BAD1' as `0x${string}`
const PAIR = '0x000000000000000000000000000000000000FA17' as `0x${string}`
const BASE_ERC20 = '0x000000000000000000000000000000000000BA5E' as `0x${string}`
const OTHER_WRAPPER = '0x000000000000000000000000000000000000BEEF' as `0x${string}`

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

const NATIVE_RESERVES = { base: 5_000_000_000_000_000_000n, wnft: 12_000_000_000_000_000_000n }

describe('quoteAddLiquidity — existing native pool, reconciled to the wei', () => {
  it('baseRequired equals the mocked Router.quote answer (floor of the exact contract division)', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      wrapperIsToken0: true,
      reserves: NATIVE_RESERVES,
    })
    const quote = await quoteAddLiquidity(env.ctx, { collection: COLLECTION, tokenIds: ['1', '2'] })
    const expected = requiredBase(2, NATIVE_RESERVES.wnft, NATIVE_RESERVES.base)
    expect(quote.liquidity?.baseRequired?.value).toBe(expected)
    expect(quote.side).toBe('add-liquidity')
    expect(quote.liquidity?.reserves).toEqual(NATIVE_RESERVES)
    expect(quote.liquidity?.feeToZero).toBe(true)
    expect(quote.reconciled).toBe(true)
    expect(quote.priceImpact).toBe(0)
    expect(quote.legs).toEqual([])
    expect(quote.fees.pool.note.toLowerCase()).toContain('no fee')
  })

  it('a 1-wei different on-chain Router.quote answer throws QUOTE_RECONCILIATION_FAILED', async () => {
    const expected = requiredBase(2, NATIVE_RESERVES.wnft, NATIVE_RESERVES.base)
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      wrapperIsToken0: true,
      reserves: NATIVE_RESERVES,
      routerQuoteOverride: expected + 1n,
    })
    await expectRejectsWithCode(
      quoteAddLiquidity(env.ctx, { collection: COLLECTION, tokenIds: ['1', '2'] }),
      'QUOTE_RECONCILIATION_FAILED',
    )
  })
})

describe('quoteAddLiquidity — wrapper orientation never changes the reconciled figure', () => {
  it('wrapper as token0 and wrapper as token1 report the same baseRequired', async () => {
    const expected = requiredBase(3, NATIVE_RESERVES.wnft, NATIVE_RESERVES.base)
    const asToken0 = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      wrapperIsToken0: true,
      reserves: NATIVE_RESERVES,
    })
    const asToken1 = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      wrapperIsToken0: false,
      reserves: NATIVE_RESERVES,
    })
    const q0 = await quoteAddLiquidity(asToken0.ctx, { collection: COLLECTION, tokenIds: ['1', '2', '3'] })
    const q1 = await quoteAddLiquidity(asToken1.ctx, { collection: COLLECTION, tokenIds: ['1', '2', '3'] })
    expect(q0.liquidity?.baseRequired?.value).toBe(expected)
    expect(q1.liquidity?.baseRequired?.value).toBe(expected)
    expect(q0.liquidity?.lpOut?.value).toBe(q1.liquidity?.lpOut?.value)
  })
})

describe('quoteAddLiquidity — ERC-20 base: desired is the ceil, never the Router floor', () => {
  it('baseDesired (ceil) is strictly greater than baseRequired (floor) on an inexact division', async () => {
    const reserves = { base: 7n, wnft: 3_000_000_000_000_000_000n } // 3e18 — deliberately not a divisor of 7·2e18
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      baseToken: { address: BASE_ERC20, decimals: 18, symbol: 'USDC' },
      reserves,
    })
    const quote = await quoteAddLiquidity(env.ctx, { collection: COLLECTION, tokenIds: ['1', '2'], baseToken: BASE_ERC20 })
    const floor = requiredBase(2, reserves.wnft, reserves.base)
    const ceil = minErc20Desired(2, reserves.wnft, reserves.base)
    expect(quote.liquidity?.baseRequired?.value).toBe(floor)
    expect(quote.liquidity?.baseDesired?.value).toBe(ceil)
    expect(ceil).toBeGreaterThan(floor)
  })

  it('baseDesired equals baseRequired exactly when the division has no remainder', async () => {
    const reserves = { base: 4_000_000_000_000_000_000n, wnft: 2_000_000_000_000_000_000n } // exact 2:1
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      baseToken: { address: BASE_ERC20, decimals: 18, symbol: 'USDC' },
      reserves,
    })
    const quote = await quoteAddLiquidity(env.ctx, { collection: COLLECTION, tokenIds: ['1'], baseToken: BASE_ERC20 })
    expect(quote.liquidity?.baseDesired?.value).toBe(quote.liquidity?.baseRequired?.value)
  })

  it('has no baseDesired at all on a native-base deposit', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, reserves: NATIVE_RESERVES })
    const quote = await quoteAddLiquidity(env.ctx, { collection: COLLECTION, tokenIds: ['1'] })
    expect(quote.liquidity?.baseDesired).toBeUndefined()
  })
})

describe('quoteAddLiquidity — lpOut mirrors Pair.mint over (deposit + balance - reserve)', () => {
  it('a pair whose balances exceed its cached reserves mints MORE lp than the plain-reserve case', async () => {
    const totalSupply = 1_000_000_000_000_000_000n
    const plain = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      reserves: NATIVE_RESERVES,
      totalSupply,
    })
    const surplus = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      reserves: NATIVE_RESERVES,
      // A single-NFT deposit lands exactly on the pool's own ratio by construction
      // (that is what `requiredBase` computes), so a stray surplus on only ONE side
      // never moves `mintLiquidity`'s `min(l0, l1)` — the untouched side stays the
      // bottleneck. Surplus on BOTH sides, proportional to the reserve ratio, is
      // what actually raises the minted amount.
      balances: { base: NATIVE_RESERVES.base + 500_000_000_000_000_000n, wnft: NATIVE_RESERVES.wnft + 1_200_000_000_000_000_000n },
      totalSupply,
    })
    const plainQuote = await quoteAddLiquidity(plain.ctx, { collection: COLLECTION, tokenIds: ['1'] })
    const surplusQuote = await quoteAddLiquidity(surplus.ctx, { collection: COLLECTION, tokenIds: ['1'] })
    expect(surplusQuote.liquidity?.lpOut?.value).toBeGreaterThan(plainQuote.liquidity?.lpOut?.value ?? 0n)
  })
})

describe('quoteAddLiquidity — protocol fee guard', () => {
  it('Factory.feeTo() != 0 throws QUOTE_RECONCILIATION_FAILED with reason protocol-fee-on', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      reserves: NATIVE_RESERVES,
      feeTo: '0x000000000000000000000000000000000000fee1',
    })
    const { error } = await expectRejectsWithCode(
      quoteAddLiquidity(env.ctx, { collection: COLLECTION, tokenIds: ['1'] }),
      'QUOTE_RECONCILIATION_FAILED',
    )
    expect(error.details?.reason).toBe('protocol-fee-on')
  })
})

describe('quoteAddLiquidity — no liquidity yet points to quoteCreatePool', () => {
  it('no pair at all throws INVALID_PARAMS reason no-liquidity', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: WRAPPER, pair: null })
    const { error } = await expectRejectsWithCode(
      quoteAddLiquidity(env.ctx, { collection: COLLECTION, tokenIds: ['1'] }),
      'INVALID_PARAMS',
    )
    expect(error.details?.reason).toBe('no-liquidity')
  })

  it('an existing but empty pair (zero reserves) also throws INVALID_PARAMS reason no-liquidity', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      reserves: { base: 0n, wnft: 0n },
    })
    const { error } = await expectRejectsWithCode(
      quoteAddLiquidity(env.ctx, { collection: COLLECTION, tokenIds: ['1'] }),
      'INVALID_PARAMS',
    )
    expect(error.details?.reason).toBe('no-liquidity')
  })
})

describe('quoteAddLiquidity — an explicit quoteToken pick still prices the native pool (Pitfall 8)', () => {
  it('baseToken === chain.quoteToken behaves identically to baseToken omitted', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, reserves: NATIVE_RESERVES })
    const quote = await quoteAddLiquidity(env.ctx, {
      collection: COLLECTION,
      tokenIds: ['1'],
      baseToken: env.ctx.chain.quoteToken,
    })
    expect(quote.liquidity?.baseToken.isNative).toBe(true)
    expect(quote.liquidity?.baseDesired).toBeUndefined()
  })
})

describe('quoteAddLiquidity — Arc native pool prices in 6-decimal quote units', () => {
  it('baseRequired.decimals === 6 and symbol is the chain native symbol', async () => {
    const chain = getChain(5042)
    const reserves = { base: 5_000_000_000n, wnft: 12_000_000_000_000_000_000n }
    const env = buildLiquidityEnv({
      chainId: 5042,
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      reserves,
    })
    const quote = await quoteAddLiquidity(env.ctx, { collection: COLLECTION, tokenIds: ['1'] })
    expect(quote.liquidity?.baseRequired?.decimals).toBe(6)
    expect(quote.liquidity?.baseRequired?.symbol).toBe(chain.nativeSymbol)
  })
})

describe('quoteAddLiquidity — base identity guard is enforced on the add path too', () => {
  it('baseToken equal to the raw collection address throws INVALID_PARAMS reason base-is-collection', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, reserves: NATIVE_RESERVES })
    const { error } = await expectRejectsWithCode(
      quoteAddLiquidity(env.ctx, { collection: COLLECTION, tokenIds: ['1'], baseToken: COLLECTION }),
      'INVALID_PARAMS',
    )
    expect(error.details?.reason).toBe('base-is-collection')
  })

  it('baseToken equal to another collection\'s wrapper throws INVALID_PARAMS reason base-is-other-wrapper', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      reserves: NATIVE_RESERVES,
      baseToken: { address: OTHER_WRAPPER, decimals: 18, symbol: 'WNFT' },
      baseIsWrapperOfCollection: '0x00000000000000000000000000000000000FA57',
    })
    const { error } = await expectRejectsWithCode(
      quoteAddLiquidity(env.ctx, { collection: COLLECTION, tokenIds: ['1'], baseToken: OTHER_WRAPPER }),
      'INVALID_PARAMS',
    )
    expect(error.details?.reason).toBe('base-is-other-wrapper')
  })
})

describe('quoteAddLiquidity — chain guard', () => {
  it('a mismatched chainId throws WRONG_CHAIN before any on-chain read', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, reserves: NATIVE_RESERVES })
    await expectRejectsWithCode(
      quoteAddLiquidity(env.ctx, { collection: COLLECTION, tokenIds: ['1'], chainId: 137 }),
      'WRONG_CHAIN',
    )
    expect(env.multicall).not.toHaveBeenCalled()
  })
})
