import { describe, expect, it } from 'vitest'

import { evaluateDirectOnly, filterViablePayTokens, isDirectOnly } from '../../src/routing/directOnlyRouting'
import type { PoolRef } from '../../src/routing/routing.types'

/**
 * Parity port of the production AMM client's own direct-only routing test suite
 * (Gate 69.5), adapted to this SDK's path-based `isDirectOnly`/`filterViablePayTokens`
 * shape.
 */

const COLLECTION = '0x1111111111111111111111111111111111111a'
const WETH = '0x4200000000000000000000000000000000000006'
const STOCK = '0x5555555555555555555555555555555555555e' // a Gate-69.5 direct-only base token
const USDC = '0x3333333333333333333333333333333333333c'

const stockPool: PoolRef = {
  pair: '0xaaaa111111111111111111111111111111aaaa',
  token0: '0x9999999999999999999999999999999999999f',
  token1: STOCK,
  baseToken: { address: STOCK, symbol: 'STOCK', decimals: 18, isNative: false },
  isDirectOnlyBase: true,
}

const wethPool: PoolRef = {
  pair: '0xbbbb222222222222222222222222222222bbbb',
  token0: '0x9999999999999999999999999999999999999f',
  token1: WETH,
  baseToken: { address: WETH, symbol: 'WETH', decimals: 18, isNative: false },
  isDirectOnlyBase: false,
}

describe('isDirectOnly', () => {
  it('the direct 2-entry pair is always allowed, whichever token occupies it', () => {
    expect(isDirectOnly({ path: [STOCK, COLLECTION], directOnlyBaseAddresses: [STOCK] })).toBe(false)
    expect(isDirectOnly({ path: [COLLECTION, STOCK], directOnlyBaseAddresses: [STOCK] })).toBe(false)
  })

  it('blocks all four CR-01 constructions that compose a direct-only base into a fungible leg', () => {
    const cases: readonly (readonly [string, readonly `0x${string}`[]])[] = [
      ['[collection, WETH, stock]', [COLLECTION, WETH, STOCK]],
      ['[collection, stock, WETH]', [COLLECTION, STOCK, WETH]],
      ['[stock, WETH, collection]', [STOCK, WETH, COLLECTION]],
      ['[WETH, stock, collection]', [WETH, STOCK, COLLECTION]],
    ]
    for (const [label, path] of cases) {
      expect(isDirectOnly({ path, directOnlyBaseAddresses: [STOCK] }), label).toBe(true)
    }
  })

  it('a chain/request with no direct-only tokens never blocks anything', () => {
    expect(isDirectOnly({ path: [WETH, STOCK, COLLECTION], directOnlyBaseAddresses: [] })).toBe(false)
  })

  it('a long path containing no direct-only address is never blocked', () => {
    expect(isDirectOnly({ path: [WETH, USDC, COLLECTION], directOnlyBaseAddresses: [STOCK] })).toBe(false)
  })

  it('address comparison is case-insensitive', () => {
    expect(
      isDirectOnly({ path: [WETH, STOCK.toUpperCase() as `0x${string}`, COLLECTION], directOnlyBaseAddresses: [STOCK] }),
    ).toBe(true)
  })
})

describe('filterViablePayTokens', () => {
  it('returns every candidate base token, including a direct-only one — non-empty whenever a candidate exists', () => {
    const result = filterViablePayTokens({ candidates: [stockPool, wethPool] })
    expect(result.length).toBeGreaterThan(0)
    expect(result).toEqual([stockPool.baseToken, wethPool.baseToken])
  })

  it('an empty candidate list returns an empty list, never throws', () => {
    expect(filterViablePayTokens({ candidates: [] })).toEqual([])
  })
})

describe('evaluateDirectOnly', () => {
  it('a direct-only-blocked route still returns a non-empty viablePayTokens — the SPEC acceptance', () => {
    const result = evaluateDirectOnly({
      path: [WETH, STOCK, COLLECTION],
      directOnlyBaseAddresses: [STOCK],
      candidates: [stockPool, wethPool],
    })
    expect(result.blocked).toBe(true)
    expect(result.viablePayTokens.length).toBeGreaterThan(0)
  })

  it('a legal direct-pair route is not blocked', () => {
    const result = evaluateDirectOnly({
      path: [STOCK, COLLECTION],
      directOnlyBaseAddresses: [STOCK],
      candidates: [stockPool],
    })
    expect(result.blocked).toBe(false)
  })
})
