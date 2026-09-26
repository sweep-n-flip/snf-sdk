import { describe, expect, it } from 'vitest'

import {
  addLiquidityAmounts,
  burnAmounts,
  floorSqrt,
  fromPairOrder,
  minErc20Desired,
  mintLiquidity,
  MINIMUM_LIQUIDITY,
  ONE_WNFT,
  requiredBase,
  routerQuote,
  toPairOrder,
  wholeNfts,
} from '../../src/liquidity/liquidityMath'
import { isSnfError, SnfError } from '../../src/errors'

function expectInvalidParams(fn: () => unknown): void {
  let threw: unknown
  try {
    fn()
  } catch (e) {
    threw = e
  }
  expect(isSnfError(threw)).toBe(true)
  expect((threw as SnfError).code).toBe('INVALID_PARAMS')
}

describe('routerQuote — mirrors UniswapV2Library.quote', () => {
  it('throws INVALID_PARAMS when reserveA is zero (INSUFFICIENT_LIQUIDITY)', () => {
    expectInvalidParams(() => routerQuote(1n, 0n, 5n))
  })

  it('throws INVALID_PARAMS when amountA is zero (INSUFFICIENT_AMOUNT)', () => {
    expectInvalidParams(() => routerQuote(0n, 5n, 5n))
  })

  it('returns the exact floor of amountA * reserveB / reserveA', () => {
    expect(routerQuote(10n, 3n, 7n)).toBe((10n * 7n) / 3n)
  })
})

describe('requiredBase', () => {
  it('equals routerQuote(n * ONE_WNFT, reserveWnft, reserveBase)', () => {
    const rWnft = 11_883_323_065_263_036_728n
    const rBase = 1_297_217_522_559_477n
    expect(requiredBase(6, rWnft, rBase)).toBe(routerQuote(6n * ONE_WNFT, rWnft, rBase))
  })
})

describe('minErc20Desired — ceil rounding', () => {
  it('rejects a non-positive reserveWnft', () => {
    expectInvalidParams(() => minErc20Desired(6, 0n, 10n))
  })

  it('is ceil((n*1e18 + 1)*rBase/rWnft), never below the floor', () => {
    const rWnft = 7n
    const rBase = 10n
    const n = 3
    const floor = requiredBase(n, rWnft, rBase)
    const desired = minErc20Desired(n, rWnft, rBase)
    expect(desired).toBe(((BigInt(n) * ONE_WNFT + 1n) * rBase + rWnft - 1n) / rWnft)
    expect(desired).toBeGreaterThanOrEqual(floor)
  })

  it('the pool priced above 1 token per NFT that used to settle 1 wei high now settles at requiredBase', () => {
    // rBase = 30e18 + 7, rWnft = 10e18, one NFT: the plain ceil (3e18 + 1) sent the
    // Router down its first branch, which pulls the desired amount itself.
    const rWnft = 10n * ONE_WNFT
    const rBase = 30n * ONE_WNFT + 7n
    const required = requiredBase(1, rWnft, rBase)
    const result = addLiquidityAmounts({
      amountADesired: minErc20Desired(1, rWnft, rBase),
      amountBDesired: ONE_WNFT,
      amountAMin: required,
      amountBMin: ONE_WNFT,
      reserveA: rBase,
      reserveB: rWnft,
    })
    expect(result).toEqual({ ok: true, amountA: required, amountB: ONE_WNFT })
  })
})

describe('addLiquidityAmounts — mirrors UniswapV2Router01._addLiquidity', () => {
  it('both reserves zero returns the desired amounts untouched, mins never read', () => {
    const result = addLiquidityAmounts({
      amountADesired: 100n,
      amountBDesired: 200n,
      amountAMin: 1_000_000n, // above desired — would fail any min check
      amountBMin: 1_000_000n,
      reserveA: 0n,
      reserveB: 0n,
    })
    expect(result).toEqual({ ok: true, amountA: 100n, amountB: 200n })
  })

  it('branch 1: optimal B <= desired B, min satisfied -> (amountADesired, optimalB)', () => {
    // reserveA=10, reserveB=20 (price 1:2). amountADesired=5 -> optimalB = 10 <= desired 15.
    const result = addLiquidityAmounts({
      amountADesired: 5n,
      amountBDesired: 15n,
      amountAMin: 5n,
      amountBMin: 10n,
      reserveA: 10n,
      reserveB: 20n,
    })
    expect(result).toEqual({ ok: true, amountA: 5n, amountB: 10n })
  })

  it('branch 1: optimal B <= desired B, min NOT satisfied -> INSUFFICIENT_B_AMOUNT', () => {
    const result = addLiquidityAmounts({
      amountADesired: 5n,
      amountBDesired: 15n,
      amountAMin: 5n,
      amountBMin: 11n, // optimalB = 10 < 11
      reserveA: 10n,
      reserveB: 20n,
    })
    expect(result).toEqual({ ok: false, revert: 'INSUFFICIENT_B_AMOUNT' })
  })

  it('branch 2: optimal B > desired B, falls to optimal A, min satisfied -> (optimalA, amountBDesired)', () => {
    // reserveA=10, reserveB=20. amountADesired=20 -> optimalB = 40 > desired 15 -> branch 2.
    // optimalA = quote(15, 20, 10) = 7.
    const result = addLiquidityAmounts({
      amountADesired: 20n,
      amountBDesired: 15n,
      amountAMin: 7n,
      amountBMin: 15n,
      reserveA: 10n,
      reserveB: 20n,
    })
    expect(result).toEqual({ ok: true, amountA: 7n, amountB: 15n })
  })

  it('branch 2: optimal A < min A -> INSUFFICIENT_A_AMOUNT', () => {
    const result = addLiquidityAmounts({
      amountADesired: 20n,
      amountBDesired: 15n,
      amountAMin: 8n, // optimalA = 7 < 8
      amountBMin: 15n,
      reserveA: 10n,
      reserveB: 20n,
    })
    expect(result).toEqual({ ok: false, revert: 'INSUFFICIENT_A_AMOUNT' })
  })
})

describe('floorSqrt', () => {
  it('matches the Pair contract Math.sqrt special cases', () => {
    expect(floorSqrt(0n)).toBe(0n)
    expect(floorSqrt(1n)).toBe(1n)
    expect(floorSqrt(2n)).toBe(1n)
    expect(floorSqrt(3n)).toBe(1n)
    expect(floorSqrt(4n)).toBe(2n)
  })

  it('returns the exact floor for a large value', () => {
    expect(floorSqrt(3_600_000_000_000_000_000_000_000_000_000_000_000n)).toBe(1_897_366_596_101_027_599n)
  })

  it('rejects a negative input', () => {
    expectInvalidParams(() => floorSqrt(-1n))
  })
})

describe('mintLiquidity — mirrors UniswapV2Pair.mint (feeTo == 0)', () => {
  it('first deposit: floorSqrt(a0 * a1) - MINIMUM_LIQUIDITY, exact integer for 6 NFTs + 0.6 ETH', () => {
    const amount0 = 6n * ONE_WNFT
    const amount1 = 6n * 10n ** 17n // 0.6 ETH
    const liquidity = mintLiquidity({ amount0, amount1, reserve0: 0n, reserve1: 0n, totalSupply: 0n })
    expect(liquidity).toBe(1_897_366_596_101_027_599n - MINIMUM_LIQUIDITY)
    expect(liquidity).toBe(1_897_366_596_101_026_599n)
  })

  it('subsequent deposit: min(amount0*ts/r0, amount1*ts/r1), floor-divided', () => {
    const liquidity = mintLiquidity({
      amount0: 5n,
      amount1: 12n,
      reserve0: 10n,
      reserve1: 20n,
      totalSupply: 100n,
    })
    // liquidity0 = 5*100/10 = 50; liquidity1 = 12*100/20 = 60 -> min = 50
    expect(liquidity).toBe(50n)
  })
})

describe('burnAmounts — mirrors UniswapV2Pair.burn (balances, not reserves)', () => {
  it('floors both sides using balances', () => {
    const result = burnAmounts({ liquidity: 7n, balance0: 100n, balance1: 33n, totalSupply: 10n })
    expect(result).toEqual({ amount0: 70n, amount1: 23n })
  })
})

describe('wholeNfts', () => {
  it('floors a wNFT amount to a whole-unit count', () => {
    expect(wholeNfts(5_999_999_999_999_999_999n)).toBe(5)
  })

  it('throws when the whole-unit count exceeds Number.MAX_SAFE_INTEGER', () => {
    const tooMany = (BigInt(Number.MAX_SAFE_INTEGER) + 1n) * ONE_WNFT
    let threw: unknown
    try {
      wholeNfts(tooMany)
    } catch (e) {
      threw = e
    }
    expect(isSnfError(threw)).toBe(true)
    expect((threw as SnfError).code).toBe('UNKNOWN')
  })
})

describe('toPairOrder / fromPairOrder', () => {
  it('maps { base, wnft } to { v0, v1 } and back, wrapper as token0', () => {
    const v = { base: 10n, wnft: 20n }
    const slots = toPairOrder(true, v)
    expect(slots).toEqual({ v0: 20n, v1: 10n })
    expect(fromPairOrder(true, slots)).toEqual(v)
  })

  it('maps { base, wnft } to { v0, v1 } and back, wrapper as token1', () => {
    const v = { base: 10n, wnft: 20n }
    const slots = toPairOrder(false, v)
    expect(slots).toEqual({ v0: 10n, v1: 20n })
    expect(fromPairOrder(false, slots)).toEqual(v)
  })
})
