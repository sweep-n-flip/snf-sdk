import { describe, expect, it } from 'vitest'

import { isSnfError, SnfError } from '../../src/errors'
import { lpPosition } from '../../src/liquidity/lpPosition'
import { getChain } from '../../src/chains/registry'
import { buildLiquidityEnv } from './liquidityTestHelpers'

const COLLECTION = '0x000000000000000000000000000000000000c011' as `0x${string}`
const WRAPPER = '0x000000000000000000000000000000000000BAD1' as `0x${string}`
const PAIR = '0x000000000000000000000000000000000000FA17' as `0x${string}`
const OWNER = '0x000000000000000000000000000000000000dEaD' as `0x${string}`

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

describe('lpPosition — a live LP balance and its underlying breakdown', () => {
  it('a 1:1 balance/totalSupply ratio reports the balance itself as both underlying amounts', async () => {
    const totalSupply = 100_000_000_000_000_000_000n
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      wrapperIsToken0: true,
      balances: { base: totalSupply, wnft: totalSupply },
      totalSupply,
      ownerLp: 25_000_000_000_000_000_000n,
    })
    const position = await lpPosition(env.ctx, PAIR, OWNER)
    expect(position.lpBalance.value).toBe(25_000_000_000_000_000_000n)
    expect(position.lpBalance.symbol).toBe('LP')
    expect(position.totalSupply).toBe(totalSupply)
    expect(position.shareBps).toBe(2_500)
    expect(position.underlying.base.value).toBe(25_000_000_000_000_000_000n)
    expect(position.underlying.wnft.value).toBe(25_000_000_000_000_000_000n)
    expect(position.underlying.nftWhole).toBe(25)
    expect(position.blockNumber).toBe(999_999n)
  })

  it('a zero balance is a valid zero position — no throw, zero amounts, shareBps 0', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      balances: { base: 10_000n, wnft: 10_000n },
      totalSupply: 10_000n,
      ownerLp: 0n,
    })
    const position = await lpPosition(env.ctx, PAIR, OWNER)
    expect(position.lpBalance.value).toBe(0n)
    expect(position.shareBps).toBe(0)
    expect(position.underlying.base.value).toBe(0n)
    expect(position.underlying.wnft.value).toBe(0n)
    expect(position.underlying.nftWhole).toBe(0)
  })

  it('both wrapper orientations report the identical underlying breakdown', async () => {
    const totalSupply = 1_000_000_000_000_000_000_000n
    const balances = { base: 3_000_000_000_000_000_000_000n, wnft: 7_000_000_000_000_000_000_000n }
    const ownerLp = 40_000_000_000_000_000_000n
    const asToken0 = buildLiquidityEnv({ collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, wrapperIsToken0: true, balances, totalSupply, ownerLp })
    const asToken1 = buildLiquidityEnv({ collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, wrapperIsToken0: false, balances, totalSupply, ownerLp })
    const p0 = await lpPosition(asToken0.ctx, PAIR, OWNER)
    const p1 = await lpPosition(asToken1.ctx, PAIR, OWNER)
    expect(p0.underlying.base.value).toBe(p1.underlying.base.value)
    expect(p0.underlying.wnft.value).toBe(p1.underlying.wnft.value)
  })

  it('a balance in excess of the cached reserves is still reflected (balances, not reserves)', async () => {
    const totalSupply = 100_000_000_000_000_000_000n
    const reserves = { base: 50_000_000_000_000_000_000n, wnft: 50_000_000_000_000_000_000n }
    const balances = { base: 90_000_000_000_000_000_000n, wnft: 90_000_000_000_000_000_000n }
    const ownerLp = 10_000_000_000_000_000_000n
    const withReserveOnly = buildLiquidityEnv({ collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, reserves, balances: reserves, totalSupply, ownerLp })
    const withSurplusBalance = buildLiquidityEnv({ collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, reserves, balances, totalSupply, ownerLp })
    const fromReserves = await lpPosition(withReserveOnly.ctx, PAIR, OWNER)
    const fromBalances = await lpPosition(withSurplusBalance.ctx, PAIR, OWNER)
    expect(fromBalances.underlying.base.value).toBeGreaterThan(fromReserves.underlying.base.value)
  })

  it('Factory.feeTo() != 0 throws QUOTE_RECONCILIATION_FAILED', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      balances: { base: 10n, wnft: 10n },
      totalSupply: 10n,
      ownerLp: 5n,
      feeTo: '0x000000000000000000000000000000000000fee1',
    })
    const { error } = await expectRejectsWithCode(lpPosition(env.ctx, PAIR, OWNER), 'QUOTE_RECONCILIATION_FAILED')
    expect(error.details?.reason).toBe('protocol-fee-on')
  })

  it('Arc: the underlying base amount prices in 6-decimal quote units', async () => {
    const chain = getChain(5042)
    const totalSupply = 100_000_000n
    const env = buildLiquidityEnv({
      chainId: 5042,
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      balances: { base: totalSupply, wnft: totalSupply },
      totalSupply,
      ownerLp: 10_000_000n,
    })
    const position = await lpPosition(env.ctx, PAIR, OWNER)
    expect(position.underlying.base.decimals).toBe(6)
    expect(position.underlying.base.symbol).toBe(chain.nativeSymbol)
  })
})
