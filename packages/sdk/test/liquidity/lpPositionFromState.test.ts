import fc from 'fast-check'
import { describe, expect, it } from 'vitest'

import { isSnfError, SnfError } from '../../src/errors'
import { lpPosition, lpPositionFromState } from '../../src/liquidity/lpPosition'
import { loadPairState } from '../../src/liquidity/poolState'
import type { PairPoolState } from '../../src/liquidity/poolState.types'
import { buildLiquidityEnv } from './liquidityTestHelpers'

/**
 * Proves the `lpPositionFromState` extraction is a pure, behaviour-preserving split:
 * `lpPosition` remains exactly `loadPairState` followed by this function on four
 * fixtures (native wrapper-token0, native wrapper-token1, ERC-20 base, Arc's 6-decimal
 * native base), the pure half never touches I/O, `loadPairState` can now be pinned to
 * a caller-supplied block, and the wrapper-orientation symmetry holds for any balances.
 */

const COLLECTION = '0x000000000000000000000000000000000000c011' as `0x${string}`
const WRAPPER = '0x000000000000000000000000000000000000BAD1' as `0x${string}`
const PAIR = '0x000000000000000000000000000000000000FA17' as `0x${string}`
const BASE_ERC20 = '0x000000000000000000000000000000000000BA5E' as `0x${string}`
const OWNER = '0x000000000000000000000000000000000000dEaD' as `0x${string}`
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`

function makeState(overrides: Partial<PairPoolState> = {}): PairPoolState {
  return {
    blockNumber: 999_999n,
    pair: PAIR,
    collection: COLLECTION,
    wrapper: WRAPPER,
    baseToken: { address: ZERO_ADDRESS, symbol: 'ETH', decimals: 18, isNative: true },
    isNative: true,
    wrapperIsToken0: true,
    reserves: { base: 100n, wnft: 100n },
    balances: { base: 100n, wnft: 100n },
    totalSupply: 100n,
    feeTo: ZERO_ADDRESS,
    ownerLp: 10n,
    ...overrides,
  }
}

describe('lpPosition === loadPairState + lpPositionFromState — parity on every fixture', () => {
  it('native pool, wrapper is token0', async () => {
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
    const viaWrapper = await lpPosition(env.ctx, PAIR, OWNER)
    const state = await loadPairState(env.ctx, { pair: PAIR, owner: OWNER })
    const viaPure = lpPositionFromState(state, OWNER)
    expect(viaWrapper).toStrictEqual(viaPure)
  })

  it('native pool, wrapper is token1', async () => {
    const totalSupply = 1_000_000_000_000_000_000_000n
    const balances = { base: 3_000_000_000_000_000_000_000n, wnft: 7_000_000_000_000_000_000_000n }
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      wrapperIsToken0: false,
      balances,
      totalSupply,
      ownerLp: 40_000_000_000_000_000_000n,
    })
    const viaWrapper = await lpPosition(env.ctx, PAIR, OWNER)
    const state = await loadPairState(env.ctx, { pair: PAIR, owner: OWNER })
    const viaPure = lpPositionFromState(state, OWNER)
    expect(viaWrapper).toStrictEqual(viaPure)
  })

  it('ERC-20 base pool', async () => {
    const totalSupply = 500_000_000_000_000_000_000n
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      wrapperIsToken0: true,
      baseToken: { address: BASE_ERC20, decimals: 6, symbol: 'USDC' },
      balances: { base: totalSupply, wnft: totalSupply },
      totalSupply,
      ownerLp: 12_000_000_000_000_000_000n,
    })
    const viaWrapper = await lpPosition(env.ctx, PAIR, OWNER)
    const state = await loadPairState(env.ctx, { pair: PAIR, owner: OWNER })
    const viaPure = lpPositionFromState(state, OWNER)
    expect(viaWrapper).toStrictEqual(viaPure)
    expect(viaPure.underlying.base.decimals).toBe(6)
  })

  it('Arc 5042, native 6-decimal base', async () => {
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
    const viaWrapper = await lpPosition(env.ctx, PAIR, OWNER)
    const state = await loadPairState(env.ctx, { pair: PAIR, owner: OWNER })
    const viaPure = lpPositionFromState(state, OWNER)
    expect(viaWrapper).toStrictEqual(viaPure)
    expect(viaPure.underlying.base.decimals).toBe(6)
  })
})

describe('lpPositionFromState — pure, no I/O', () => {
  it('a live protocol fee throws QUOTE_RECONCILIATION_FAILED without any ctx/I-O', () => {
    const state = makeState({ feeTo: '0x000000000000000000000000000000000000fee1' })
    let threw: unknown
    try {
      lpPositionFromState(state, OWNER)
    } catch (e) {
      threw = e
    }
    expect(isSnfError(threw)).toBe(true)
    expect((threw as SnfError).code).toBe('QUOTE_RECONCILIATION_FAILED')
    expect((threw as SnfError).details?.reason).toBe('protocol-fee-on')
  })

  it('no ownerLp on the state reports a zero position (same as the previous `?? 0n`)', () => {
    const { ownerLp: _ownerLp, ...rest } = makeState()
    const state: PairPoolState = rest
    const position = lpPositionFromState(state, OWNER)
    expect(position.lpBalance.value).toBe(0n)
    expect(position.shareBps).toBe(0)
    expect(position.underlying.base.value).toBe(0n)
    expect(position.underlying.wnft.value).toBe(0n)
    expect(position.underlying.nftWhole).toBe(0)
  })
})

describe('loadPairState — an optional caller-supplied blockNumber pins every round', () => {
  it('with blockNumber: getBlockNumber is never called, every round carries it, the result reuses it', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      balances: { base: 10_000n, wnft: 10_000n },
      totalSupply: 10_000n,
      ownerLp: 100n,
    })
    const state = await loadPairState(env.ctx, { pair: PAIR, owner: OWNER, blockNumber: 123n })
    expect(env.getBlockNumber).toHaveBeenCalledTimes(0)
    const calls = env.calls()
    expect(calls.length).toBeGreaterThan(0)
    for (const call of calls) {
      expect(call.blockNumber).toBe(123n)
    }
    expect(state.blockNumber).toBe(123n)
  })

  it('without blockNumber: getBlockNumber is still called exactly once (unchanged)', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      balances: { base: 10_000n, wnft: 10_000n },
      totalSupply: 10_000n,
      ownerLp: 100n,
    })
    await loadPairState(env.ctx, { pair: PAIR, owner: OWNER })
    expect(env.getBlockNumber).toHaveBeenCalledTimes(1)
  })
})

describe('lpPositionFromState — wrapper-orientation symmetry (property)', () => {
  it('wrapperIsToken0 true vs false give identical underlying + shareBps for any balances/ownerLp', () => {
    let runs = 0
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 30n }),
        fc.bigInt({ min: 1n, max: 10n ** 30n }),
        fc.bigInt({ min: 1n, max: 10n ** 24n }),
        fc.integer({ min: 0, max: 10_000 }),
        (base, wnft, totalSupply, ownerBps) => {
          runs++
          const ownerLp = (totalSupply * BigInt(ownerBps)) / 10_000n
          const asToken0 = makeState({ wrapperIsToken0: true, balances: { base, wnft }, totalSupply, ownerLp })
          const asToken1 = makeState({ wrapperIsToken0: false, balances: { base, wnft }, totalSupply, ownerLp })
          const p0 = lpPositionFromState(asToken0, OWNER)
          const p1 = lpPositionFromState(asToken1, OWNER)
          return (
            p0.underlying.base.value === p1.underlying.base.value &&
            p0.underlying.wnft.value === p1.underlying.wnft.value &&
            p0.underlying.nftWhole === p1.underlying.nftWhole &&
            p0.shareBps === p1.shareBps
          )
        },
      ),
      { numRuns: 200 },
    )
    expect(runs).toBeGreaterThanOrEqual(200)
  })
})
