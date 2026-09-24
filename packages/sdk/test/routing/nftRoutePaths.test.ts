import { describe, expect, it } from 'vitest'

import {
  buildNftRoutePath,
  buildWnftRoutePath,
  resolveWrapperSide,
} from '../../src/routing/nftRoutePaths'
import type { PoolRef } from '../../src/routing/routing.types'

/**
 * Parity port of the production AMM client's own route-path test suite, adapted
 * to the SDK's `{ collection, baseToken, side }` route-path shape, plus the two
 * wrapper-side cases required:
 * a pool where the wrapper is `token0` and one where it is `token1`, asserting the
 * same `path[]` orientation results from both (CLAUDE.md: never assume the wrapper
 * side).
 */

const COLLECTION = '0x1111111111111111111111111111111111111a'
const WETH = '0x4200000000000000000000000000000000000006'
const WRAPPER = '0x2222222222222222222222222222222222222b'
const USDC = '0x3333333333333333333333333333333333333c'

const baseToken = { address: WETH, symbol: 'WETH', decimals: 18, isNative: false } as const

// Subgraph-shaped pool: wrapper is token0, base (WETH) is token1.
const poolWrapperIsToken0: PoolRef = {
  pair: '0xaaaa111111111111111111111111111111aaaa',
  token0: WRAPPER,
  token1: WETH,
  discrete0: true,
  discrete1: false,
  baseToken,
}

// Subgraph-shaped pool: wrapper is token1, base (WETH) is token0.
const poolWrapperIsToken1: PoolRef = {
  pair: '0xbbbb222222222222222222222222222222bbbb',
  token0: WETH,
  token1: WRAPPER,
  discrete0: false,
  discrete1: true,
  baseToken,
}

// On-chain-shaped pool (no discrete flags): wrapper occupies token0 because it is
// the slot that does NOT match baseToken.address.
const poolOnChainWrapperToken0: PoolRef = {
  pair: '0xcccc333333333333333333333333333333cccc',
  token0: WRAPPER,
  token1: WETH,
  baseToken,
}

const poolOnChainWrapperToken1: PoolRef = {
  pair: '0xdddd444444444444444444444444444444dddd',
  token0: WETH,
  token1: WRAPPER,
  baseToken,
}

describe('resolveWrapperSide', () => {
  it('subgraph pool: discrete0=true means the wrapper is token0', () => {
    const result = resolveWrapperSide(poolWrapperIsToken0)
    expect(result.wrapperIsToken0).toBe(true)
    expect(result.wrapperSide).toBe('token0')
    expect(result.baseToken).toEqual(baseToken)
  })

  it('subgraph pool: discrete1=true means the wrapper is token1', () => {
    const result = resolveWrapperSide(poolWrapperIsToken1)
    expect(result.wrapperIsToken0).toBe(false)
    expect(result.wrapperSide).toBe('token1')
  })

  it('on-chain pool with no discrete flags: wrapper resolved as token0 when it is not the base address', () => {
    const result = resolveWrapperSide(poolOnChainWrapperToken0)
    expect(result.wrapperIsToken0).toBe(true)
    expect(result.wrapperSide).toBe('token0')
  })

  it('on-chain pool with no discrete flags: wrapper resolved as token1 when it is not the base address', () => {
    const result = resolveWrapperSide(poolOnChainWrapperToken1)
    expect(result.wrapperIsToken0).toBe(false)
    expect(result.wrapperSide).toBe('token1')
  })

  it('address comparison is case-insensitive', () => {
    const upper: PoolRef = {
      ...poolOnChainWrapperToken1,
      token0: WETH.toUpperCase() as `0x${string}`,
    }
    expect(resolveWrapperSide(upper).wrapperIsToken0).toBe(false)
  })
})

describe('buildNftRoutePath', () => {
  it('buy: [baseToken, collection]', () => {
    expect(buildNftRoutePath({ collection: COLLECTION, baseToken: WETH, side: 'buy' })).toEqual([
      WETH,
      COLLECTION,
    ])
  })

  it('sell: [collection, baseToken]', () => {
    expect(buildNftRoutePath({ collection: COLLECTION, baseToken: WETH, side: 'sell' })).toEqual([
      COLLECTION,
      WETH,
    ])
  })

  it('never contains the wrapper address, regardless of which pool the caller resolved it from', () => {
    // Both pools resolve to the same baseToken; buildNftRoutePath only ever sees
    // { collection, baseToken, side } — the wrapper address (token0 in one pool,
    // token1 in the other) never enters the path.
    const fromToken0Pool = resolveWrapperSide(poolWrapperIsToken0).baseToken
    const fromToken1Pool = resolveWrapperSide(poolWrapperIsToken1).baseToken
    const pathA = buildNftRoutePath({
      collection: COLLECTION,
      baseToken: (fromToken0Pool.address ?? WETH) as `0x${string}`,
      side: 'buy',
    })
    const pathB = buildNftRoutePath({
      collection: COLLECTION,
      baseToken: (fromToken1Pool.address ?? WETH) as `0x${string}`,
      side: 'buy',
    })
    expect(pathA).toEqual(pathB)
    expect(pathA).not.toContain(WRAPPER)
  })

  it('a USDC-base pool builds the same shape with a different address', () => {
    expect(buildNftRoutePath({ collection: COLLECTION, baseToken: USDC, side: 'buy' })).toEqual([
      USDC,
      COLLECTION,
    ])
  })
})

describe('buildWnftRoutePath', () => {
  it('buy: [baseToken, wrapper] — carries the wrapper address', () => {
    expect(buildWnftRoutePath({ wrapper: WRAPPER, baseToken: WETH, side: 'buy' })).toEqual([
      WETH,
      WRAPPER,
    ])
  })

  it('sell: [wrapper, baseToken]', () => {
    expect(buildWnftRoutePath({ wrapper: WRAPPER, baseToken: WETH, side: 'sell' })).toEqual([
      WRAPPER,
      WETH,
    ])
  })

  it('is distinct from buildNftRoutePath for the same side (wrapper vs collection)', () => {
    const nftPath = buildNftRoutePath({ collection: COLLECTION, baseToken: WETH, side: 'buy' })
    const wnftPath = buildWnftRoutePath({ wrapper: WRAPPER, baseToken: WETH, side: 'buy' })
    expect(nftPath).not.toEqual(wnftPath)
  })
})
