import { describe, expect, it, vi } from 'vitest'

import { nftPoolSet } from '../../src/portfolio/poolSet'
import type { SnfClientContext } from '../../src/types/client.types'
import type { CachedResult, SubgraphPair } from '../../src/transport/subgraph.types'
import { buildPortfolioEnv, testAddress } from './portfolioTestHelpers'

/**
 * `nftPoolSet` — the shared NFT-pool discovery `positions` (and later `wnftBalances`/
 * `collectionsHeld`) composes. Covers the `isNFTPool` pre-filter (the BNB delegated-
 * pairs trap), the wrapper-side orientation, pagination, freshness aggregation and
 * dedup — all pure subgraph behaviour, no on-chain reads involved.
 */

function fakeCtx(pools: (args?: { readonly first?: number; readonly skip?: number }) => Promise<CachedResult<readonly SubgraphPair[]>>): SnfClientContext {
  return { transport: { pools: vi.fn(pools) } } as unknown as SnfClientContext
}

function fillerRow(seed: number): SubgraphPair {
  return {
    id: testAddress(seed),
    discrete0: false,
    discrete1: false,
    isNFTPool: false,
    token0: { id: testAddress(seed * 3), symbol: 'T0', name: 'T0', decimals: 18, collection: null },
    token1: { id: testAddress(seed * 3 + 1), symbol: 'T1', name: 'T1', decimals: 18, collection: null },
    reserve0: '0',
    reserve1: '0',
    totalSupply: '0',
    reserveETH: '0',
    reserveUSD: '0',
    volumeToken0: '0',
    volumeToken1: '0',
    volumeUSD: '0',
    txCount: '0',
  }
}

function delegatedRow(seed: number): SubgraphPair {
  return { ...fillerRow(seed), isNFTPool: false }
}

describe('nftPoolSet — the isNFTPool pre-filter and wrapper orientation', () => {
  it('a BNB-shaped fixture (2 NFT pools + 7 delegated pairs) yields exactly 2 entries; the first call is exactly { first: 1000 }', async () => {
    const env = buildPortfolioEnv({
      chainId: 56,
      pairs: [
        { pair: testAddress(1), wrapper: testAddress(2), collection: testAddress(3), wrapperIsToken0: true },
        { pair: testAddress(4), wrapper: testAddress(5), collection: testAddress(6), wrapperIsToken0: false },
      ],
      extraRows: Array.from({ length: 7 }, (_, i) => delegatedRow(100 + i)),
    })

    const result = await nftPoolSet(env.ctx)

    expect(env.pools).toHaveBeenCalledTimes(1)
    expect(env.pools.mock.calls[0]![0]).toStrictEqual({ first: 1000 })
    expect(result.pools).toHaveLength(2)

    const first = result.pools.find((p) => p.pair.toLowerCase() === testAddress(1).toLowerCase())
    expect(first?.wrapper.toLowerCase()).toBe(testAddress(2).toLowerCase())
    expect(first?.collection.toLowerCase()).toBe(testAddress(3).toLowerCase())
    expect(first?.wrapperIsToken0).toBe(true)

    const second = result.pools.find((p) => p.pair.toLowerCase() === testAddress(4).toLowerCase())
    expect(second?.wrapper.toLowerCase()).toBe(testAddress(5).toLowerCase())
    expect(second?.collection.toLowerCase()).toBe(testAddress(6).toLowerCase())
    expect(second?.wrapperIsToken0).toBe(false)
  })

  it('drops a row whose discrete0 === discrete1 (neither, or both, sides discrete)', async () => {
    const env = buildPortfolioEnv({
      pairs: [
        { pair: testAddress(1), wrapper: testAddress(2), collection: testAddress(3), subgraph: { discrete0: true, discrete1: true } },
        { pair: testAddress(4), wrapper: testAddress(5), collection: testAddress(6), subgraph: { discrete0: false, discrete1: false } },
      ],
    })
    const result = await nftPoolSet(env.ctx)
    expect(result.pools).toHaveLength(0)
  })

  it('drops a row whose discrete token has no collection', async () => {
    const env = buildPortfolioEnv({
      pairs: [{ pair: testAddress(1), wrapper: testAddress(2), collection: testAddress(3), subgraph: { dropCollection: true } }],
    })
    const result = await nftPoolSet(env.ctx)
    expect(result.pools).toHaveLength(0)
  })

  it('duplicate pair rows are de-duplicated', async () => {
    const env = buildPortfolioEnv({
      pairs: [{ pair: testAddress(1), wrapper: testAddress(2), collection: testAddress(3) }],
      extraRows: [
        {
          ...fillerRow(999),
          id: testAddress(1),
          discrete0: true,
          discrete1: false,
          isNFTPool: true,
          token0: { id: testAddress(2), symbol: 'WNFT', name: 'Wrapped NFT', decimals: 18, collection: { id: testAddress(3), name: 'Dup', symbol: 'DUP' } },
        },
      ],
    })
    const result = await nftPoolSet(env.ctx)
    expect(result.pools).toHaveLength(1)
  })
})

describe('nftPoolSet — pagination and freshness aggregation', () => {
  it('a full 1000-row page pages on with { first: 1000, skip: 1000 } then { skip: 2000 }, stopping at the first shorter page', async () => {
    const calls: (readonly [number | undefined, number | undefined])[] = []
    const pools = vi.fn(async (args?: { readonly first?: number; readonly skip?: number }) => {
      calls.push([args?.first, args?.skip])
      const page = calls.length
      const rows = page < 3 ? Array.from({ length: 1000 }, (_, i) => fillerRow(page * 10_000 + i)) : Array.from({ length: 5 }, (_, i) => fillerRow(30_000 + i))
      return { data: rows, asOfBlock: 100n, lagSeconds: 0, stale: false, revalidating: false }
    })
    const ctx = fakeCtx(pools)
    await nftPoolSet(ctx)

    expect(pools).toHaveBeenCalledTimes(3)
    expect(calls[0]).toStrictEqual([1000, undefined])
    expect(calls[1]).toStrictEqual([1000, 1000])
    expect(calls[2]).toStrictEqual([1000, 2000])
  })

  it('never makes more than 5 calls, even if every page comes back full', async () => {
    const pools = vi.fn(async () => ({
      data: Array.from({ length: 1000 }, (_, i) => fillerRow(i)),
      asOfBlock: 1n,
      lagSeconds: 0,
      stale: false,
      revalidating: false,
    }))
    const ctx = fakeCtx(pools)
    await nftPoolSet(ctx)
    expect(pools).toHaveBeenCalledTimes(5)
  })

  it('asOfBlock is the minimum, lagSeconds the maximum, stale the OR — across pages', async () => {
    const pages = [
      { data: Array.from({ length: 1000 }, (_, i) => fillerRow(i)), asOfBlock: 100n, lagSeconds: 5, stale: false, revalidating: false },
      { data: Array.from({ length: 1000 }, (_, i) => fillerRow(1000 + i)), asOfBlock: 90n, lagSeconds: 20, stale: true, revalidating: false },
      { data: Array.from({ length: 5 }, (_, i) => fillerRow(2000 + i)), asOfBlock: 95n, lagSeconds: 1, stale: false, revalidating: false },
    ]
    let call = 0
    const pools = vi.fn(async () => pages[call++]!)
    const ctx = fakeCtx(pools)
    const result = await nftPoolSet(ctx)
    expect(result.freshness).toStrictEqual({ asOfBlock: 90n, lagSeconds: 20, stale: true })
  })

  it('a transport rejection (UPSTREAM_DEGRADED) propagates unchanged', async () => {
    const boom = new Error('UPSTREAM_DEGRADED')
    const ctx = fakeCtx(async () => {
      throw boom
    })
    await expect(nftPoolSet(ctx)).rejects.toBe(boom)
  })
})
