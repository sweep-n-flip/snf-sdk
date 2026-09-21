import { describe, expect, it } from 'vitest'

import { SNF_ERROR_CODES } from '../../src/errors'
import { evaluateRouteBlock, ROUTE_BLOCK_CODE } from '../../src/routing/routeBlock'
import { ROUTE_BLOCK_REASONS } from '../../src/routing/routing.types'
import type { PoolRef } from '../../src/routing/routing.types'

/**
 * Parity port of `snf-client/src/lib/swap/__tests__/routeBlock.test.ts`, extended
 * with the different-base NFT×NFT case R9's `quoteNftToNft` (plan 13) depends on
 * (this plan proves the predicate so plan 13 asserts behaviour instead of
 * re-deriving it) and the plan's required reason→code exhaustiveness test.
 */

const COLLECTION = '0x1111111111111111111111111111111111111a'
const WETH = '0x4200000000000000000000000000000000000006'
const USDC = '0x3333333333333333333333333333333333333c'
const STOCK = '0x5555555555555555555555555555555555555e'

const wethToken = { address: WETH, symbol: 'WETH', decimals: 18, isNative: false } as const
const usdcToken = { address: USDC, symbol: 'USDC', decimals: 6, isNative: false } as const

const wethPool: PoolRef = {
  pair: '0xbbbb222222222222222222222222222222bbbb',
  token0: '0x9999999999999999999999999999999999999f',
  token1: WETH,
  baseToken: wethToken,
}

describe('evaluateRouteBlock', () => {
  it('no candidate pool for the collection at all ⇒ no-pair / NO_ROUTE', () => {
    const result = evaluateRouteBlock({ candidates: [], path: undefined, directOnlyBaseAddresses: [] })
    expect(result).toEqual({ blocked: true, reason: 'no-pair', viablePayTokens: [] })
  })

  it('a direct-only path block ⇒ direct-only / NO_ROUTE, with a non-empty alternative', () => {
    const stockPool: PoolRef = {
      pair: '0xaaaa111111111111111111111111111111aaaa',
      token0: '0x9999999999999999999999999999999999999f',
      token1: STOCK,
      baseToken: { address: STOCK, symbol: 'STOCK', decimals: 18, isNative: false },
      isDirectOnlyBase: true,
    }
    const result = evaluateRouteBlock({
      candidates: [stockPool, wethPool],
      path: [WETH, STOCK, COLLECTION],
      directOnlyBaseAddresses: [STOCK],
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('direct-only')
    expect(result.viablePayTokens.length).toBeGreaterThan(0)
  })

  it('an unsupported-token flag ⇒ unsupported-token / INVALID_PARAMS, checked before every other reason', () => {
    const result = evaluateRouteBlock({
      candidates: [wethPool],
      path: [WETH, COLLECTION],
      directOnlyBaseAddresses: [],
      unsupportedToken: true,
    })
    expect(result.reason).toBe('unsupported-token')
  })

  it('a flagged empty pool ⇒ no-liquidity / NO_ROUTE', () => {
    const result = evaluateRouteBlock({
      candidates: [wethPool],
      path: [WETH, COLLECTION],
      directOnlyBaseAddresses: [],
      noLiquidity: true,
    })
    expect(result.reason).toBe('no-liquidity')
  })

  it('NFT×NFT with different pool bases ⇒ different-base / NO_ROUTE — the predicate plan 13 depends on', () => {
    const result = evaluateRouteBlock({
      candidates: [wethPool],
      path: undefined,
      directOnlyBaseAddresses: [],
      nftToNft: { sellPoolBase: wethToken, buyPoolBase: usdcToken },
    })
    expect(result.blocked).toBe(true)
    expect(result.reason).toBe('different-base')
    expect(ROUTE_BLOCK_CODE[result.reason as 'different-base']).toBe('NO_ROUTE')
  })

  it('NFT×NFT with the SAME pool base is not blocked by different-base', () => {
    const result = evaluateRouteBlock({
      candidates: [wethPool],
      path: [WETH, COLLECTION],
      directOnlyBaseAddresses: [],
      nftToNft: { sellPoolBase: wethToken, buyPoolBase: wethToken },
    })
    expect(result.reason).not.toBe('different-base')
  })

  it('a routable request is not blocked', () => {
    const result = evaluateRouteBlock({
      candidates: [wethPool],
      path: [WETH, COLLECTION],
      directOnlyBaseAddresses: [],
    })
    expect(result).toEqual({ blocked: false, viablePayTokens: [wethToken] })
  })
})

describe('ROUTE_BLOCK_CODE exhaustiveness', () => {
  it('every RouteBlockReason has a mapped SnfErrorCode that is itself a member of SNF_ERROR_CODES', () => {
    expect(ROUTE_BLOCK_REASONS.length).toBeGreaterThan(0)
    for (const reason of ROUTE_BLOCK_REASONS) {
      const code = ROUTE_BLOCK_CODE[reason]
      expect(code).toBeDefined()
      expect(SNF_ERROR_CODES).toContain(code)
    }
  })

  it('unsupported-token is the one reason that is a param problem, not a no-route', () => {
    expect(ROUTE_BLOCK_CODE['unsupported-token']).toBe('INVALID_PARAMS')
  })

  it('every other reason maps to NO_ROUTE', () => {
    for (const reason of ROUTE_BLOCK_REASONS) {
      if (reason === 'unsupported-token') continue
      expect(ROUTE_BLOCK_CODE[reason]).toBe('NO_ROUTE')
    }
  })
})
