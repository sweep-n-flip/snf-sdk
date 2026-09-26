import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import { isSnfError, SnfError } from '../../src/errors'
import { loadDepositState, loadPairState } from '../../src/liquidity/poolState'
import { buildLiquidityEnv, ZERO_ADDRESS } from './liquidityTestHelpers'

const COLLECTION = '0x000000000000000000000000000000000000c011' as `0x${string}`
const OTHER_COLLECTION = '0x000000000000000000000000000000000000BEEF' as `0x${string}`
const WRAPPER = '0x000000000000000000000000000000000000BAD1' as `0x${string}`
const PAIR = '0x000000000000000000000000000000000000FA17' as `0x${string}`
const BASE_ERC20 = '0x000000000000000000000000000000000000BA5E' as `0x${string}`
const OWNER = '0x000000000000000000000000000000000000dEaD' as `0x${string}`
const STALE_PAIR = '0x0000000000000000000000000000000000BAD99' as `0x${string}`

async function expectRejectsWithCode(p: Promise<unknown>, code: string): Promise<void> {
  let threw: unknown
  try {
    await p
  } catch (e) {
    threw = e
  }
  expect(isSnfError(threw)).toBe(true)
  expect((threw as SnfError).code).toBe(code)
}

describe('loadDepositState — one-block pinning', () => {
  it('reads getBlockNumber once and pins every multicall round to that same value', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      wrapperIsToken0: true,
      reserves: { base: 10n * 10n ** 18n, wnft: 20n * 10n ** 18n },
      baseToken: { address: BASE_ERC20, decimals: 18, symbol: 'USDC' },
    })
    await loadDepositState(env.ctx, { collection: COLLECTION, baseToken: BASE_ERC20 })
    expect(env.getBlockNumber).toHaveBeenCalledTimes(1)
    const calls = env.calls()
    expect(calls.length).toBeGreaterThan(0)
    const blockNumbers = new Set(calls.map((c) => c.blockNumber))
    expect(blockNumbers.size).toBe(1)
    expect([...blockNumbers][0]).toBe(999_999n)
  })
})

describe('loadDepositState — no wrapper yet', () => {
  it('returns wrapper:null, pair:null, zero reserves, zero totalSupply, and issues no pair reads', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null })
    const state = await loadDepositState(env.ctx, { collection: COLLECTION })
    expect(state.wrapper).toBeNull()
    expect(state.pair).toBeNull()
    expect(state.reserves).toEqual({ base: 0n, wnft: 0n })
    expect(state.totalSupply).toBe(0n)
    // Only the round-1 Factory batch (getWrapper + feeTo) — no getPair, no
    // wrapper.collection(), no Pair reads at all.
    const functionNames = env.calls().map((c) => c.functionName)
    expect(functionNames).toEqual(['getWrapper', 'feeTo'])
  })
})

describe('loadDepositState — wrapper exists but no pair', () => {
  it('returns pair:null, zero reserves', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: WRAPPER, pair: null })
    const state = await loadDepositState(env.ctx, { collection: COLLECTION })
    expect(state.wrapper).toBe(WRAPPER)
    expect(state.pair).toBeNull()
    expect(state.reserves).toEqual({ base: 0n, wnft: 0n })
    expect(state.wrapperIsToken0).toBeNull()
  })
})

describe('loadDepositState — pair exists with zero reserves', () => {
  it('returns the pair address with zero reserves', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      reserves: { base: 0n, wnft: 0n },
    })
    const state = await loadDepositState(env.ctx, { collection: COLLECTION })
    expect(state.pair).toBe(PAIR)
    expect(state.reserves).toEqual({ base: 0n, wnft: 0n })
  })
})

describe('loadDepositState — native base classification (Pitfall 8)', () => {
  it('baseToken omitted -> isNative true, address = chain.quoteToken, native symbol/decimals', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null })
    const state = await loadDepositState(env.ctx, { collection: COLLECTION })
    expect(state.isNative).toBe(true)
    expect(state.baseToken.address?.toLowerCase()).toBe(env.ctx.chain.quoteToken.toLowerCase())
    expect(state.baseToken.symbol).toBe(env.ctx.chain.nativeSymbol)
    expect(state.baseToken.decimals).toBe(env.ctx.chain.quoteDecimals)
  })

  it('baseToken null -> isNative true, address = chain.quoteToken, native symbol/decimals', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null })
    const state = await loadDepositState(env.ctx, { collection: COLLECTION, baseToken: null })
    expect(state.isNative).toBe(true)
    expect(state.baseToken.address?.toLowerCase()).toBe(env.ctx.chain.quoteToken.toLowerCase())
    expect(state.baseToken.symbol).toBe(env.ctx.chain.nativeSymbol)
    expect(state.baseToken.decimals).toBe(env.ctx.chain.quoteDecimals)
  })

  it('an explicit baseToken equal (any case) to the chain quoteToken is still classified native', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null })
    const mixedCase = (env.ctx.chain.quoteToken.slice(0, 2) +
      env.ctx.chain.quoteToken.slice(2).toUpperCase()) as `0x${string}`
    const state = await loadDepositState(env.ctx, { collection: COLLECTION, baseToken: mixedCase })
    expect(state.isNative).toBe(true)
  })

  it('Arc (5042): native pool reports 6 quote decimals and USDC symbol', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null, chainId: 5042 })
    const state = await loadDepositState(env.ctx, { collection: COLLECTION })
    expect(state.isNative).toBe(true)
    expect(state.baseToken.decimals).toBe(6)
    expect(state.baseToken.symbol).toBe('USDC')
  })
})

describe('loadDepositState — ERC-20 base', () => {
  it('an unreadable decimals() throws INVALID_PARAMS naming field "baseToken"', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: null,
      baseToken: { address: BASE_ERC20, decimals: 18, symbol: 'USDC' },
      baseDecimalsUnreadable: true,
    })
    await expectRejectsWithCode(
      loadDepositState(env.ctx, { collection: COLLECTION, baseToken: BASE_ERC20 }),
      'INVALID_PARAMS',
    )
    try {
      await loadDepositState(env.ctx, { collection: COLLECTION, baseToken: BASE_ERC20 })
    } catch (e) {
      expect((e as SnfError).details).toMatchObject({ field: 'baseToken' })
    }
  })

  it('Factory.getCollection(base) != 0 marks baseIsWrapper true', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: null,
      baseToken: { address: BASE_ERC20, decimals: 18, symbol: 'OTHERW' },
      baseIsWrapperOfCollection: OTHER_COLLECTION,
    })
    const state = await loadDepositState(env.ctx, { collection: COLLECTION, baseToken: BASE_ERC20 })
    expect(state.baseIsWrapper).toBe(true)
    expect(state.baseToken).toEqual({ address: getAddress(BASE_ERC20), symbol: 'OTHERW', decimals: 18, isNative: false })
  })
})

describe('loadDepositState — WRAPPER_UNVERIFIED', () => {
  it('throws when wrapper.collection() disagrees with the requested collection', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: WRAPPER, pair: null })
    await expectRejectsWithCode(
      loadDepositState(env.ctx, { collection: OTHER_COLLECTION }),
      'WRAPPER_UNVERIFIED',
    )
  })
})

describe('loadDepositState — orientation, reserves vs balances', () => {
  it('wrapper as token0: reserves/balances mapped correctly, balances may differ from reserves', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      wrapperIsToken0: true,
      reserves: { base: 5n * 10n ** 18n, wnft: 12n * 10n ** 18n },
      balances: { base: 5n * 10n ** 18n + 1n, wnft: 12n * 10n ** 18n + 2n },
    })
    const state = await loadDepositState(env.ctx, { collection: COLLECTION })
    expect(state.wrapperIsToken0).toBe(true)
    expect(state.reserves).toEqual({ base: 5n * 10n ** 18n, wnft: 12n * 10n ** 18n })
    expect(state.balances).toEqual({ base: 5n * 10n ** 18n + 1n, wnft: 12n * 10n ** 18n + 2n })
  })

  it('wrapper as token1: reserves/balances mapped correctly', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      wrapperIsToken0: false,
      reserves: { base: 7n * 10n ** 18n, wnft: 9n * 10n ** 18n },
      balances: { base: 7n * 10n ** 18n, wnft: 9n * 10n ** 18n + 3n },
    })
    const state = await loadDepositState(env.ctx, { collection: COLLECTION })
    expect(state.wrapperIsToken0).toBe(false)
    expect(state.reserves).toEqual({ base: 7n * 10n ** 18n, wnft: 9n * 10n ** 18n })
    expect(state.balances).toEqual({ base: 7n * 10n ** 18n, wnft: 9n * 10n ** 18n + 3n })
  })
})

describe('loadPairState — finds the wrapper by probing collection() on both slots', () => {
  it('wrapper as token0', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      wrapperIsToken0: true,
      reserves: { base: 3n * 10n ** 18n, wnft: 8n * 10n ** 18n },
      totalSupply: 100n,
    })
    const state = await loadPairState(env.ctx, { pair: PAIR })
    expect(state.wrapper).toBe(WRAPPER)
    expect(state.collection).toBe(COLLECTION)
    expect(state.wrapperIsToken0).toBe(true)
    expect(state.reserves).toEqual({ base: 3n * 10n ** 18n, wnft: 8n * 10n ** 18n })
    expect(state.isNative).toBe(true)
  })

  it('wrapper as token1', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      wrapperIsToken0: false,
      reserves: { base: 4n * 10n ** 18n, wnft: 6n * 10n ** 18n },
      totalSupply: 50n,
    })
    const state = await loadPairState(env.ctx, { pair: PAIR })
    expect(state.wrapperIsToken0).toBe(false)
    expect(state.reserves).toEqual({ base: 4n * 10n ** 18n, wnft: 6n * 10n ** 18n })
  })

  it('returns ownerLp from Pair.balanceOf(owner) when owner is passed', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      reserves: { base: 1n, wnft: 1n },
      ownerLp: 12_345n,
    })
    const state = await loadPairState(env.ctx, { pair: PAIR, owner: OWNER })
    expect(state.ownerLp).toBe(12_345n)
  })

  it('ownerLp is absent when no owner is passed', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, reserves: { base: 1n, wnft: 1n } })
    const state = await loadPairState(env.ctx, { pair: PAIR })
    expect(state.ownerLp).toBeUndefined()
  })
})

describe('loadPairState — not-an-snf-pair (the pair is re-derived, never trusted)', () => {
  it('rejects when Factory.getPair(wrapper, base) does not return this pair', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      reserves: { base: 1n, wnft: 1n },
      factoryGetPairOverride: STALE_PAIR,
    })
    await expectRejectsWithCode(loadPairState(env.ctx, { pair: PAIR }), 'INVALID_PARAMS')
    try {
      await loadPairState(env.ctx, { pair: PAIR })
    } catch (e) {
      expect((e as SnfError).details).toMatchObject({ reason: 'not-an-snf-pair' })
    }
  })

  it('rejects when NEITHER token answers collection()', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      reserves: { base: 1n, wnft: 1n },
      wrapperCollectionUnreadable: true,
    })
    await expectRejectsWithCode(loadPairState(env.ctx, { pair: PAIR }), 'INVALID_PARAMS')
    try {
      await loadPairState(env.ctx, { pair: PAIR })
    } catch (e) {
      expect((e as SnfError).details).toMatchObject({ reason: 'not-an-snf-pair' })
    }
  })

  it('rejects when BOTH tokens answer collection() (spoofed base)', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      reserves: { base: 1n, wnft: 1n },
      baseAnswersCollection: true,
    })
    await expectRejectsWithCode(loadPairState(env.ctx, { pair: PAIR }), 'INVALID_PARAMS')
    try {
      await loadPairState(env.ctx, { pair: PAIR })
    } catch (e) {
      expect((e as SnfError).details).toMatchObject({ reason: 'not-an-snf-pair' })
    }
  })
})

describe('loadPairState — ERC-20 base', () => {
  it('resolves the ERC-20 base symbol/decimals and reports isNative:false', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      baseToken: { address: BASE_ERC20, decimals: 6, symbol: 'USDC' },
      reserves: { base: 100n, wnft: 5n * 10n ** 18n },
    })
    const state = await loadPairState(env.ctx, { pair: PAIR })
    expect(state.isNative).toBe(false)
    expect(state.baseToken).toEqual({ address: BASE_ERC20, symbol: 'USDC', decimals: 6, isNative: false })
  })
})

describe('one-block pinning (loadPairState)', () => {
  it('every recorded call carries the same blockNumber', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      reserves: { base: 1n, wnft: 1n },
      ownerLp: 1n,
    })
    await loadPairState(env.ctx, { pair: PAIR, owner: OWNER })
    const blockNumbers = new Set(env.calls().map((c) => c.blockNumber))
    expect(blockNumbers.size).toBe(1)
  })
})

// Sanity: ZERO_ADDRESS is exported by the shared helper and matches the well-known
// zero address literal used throughout this suite's fixtures.
describe('shared helper sanity', () => {
  it('ZERO_ADDRESS is the well-known zero address', () => {
    expect(ZERO_ADDRESS).toBe('0x0000000000000000000000000000000000000000')
  })
})
