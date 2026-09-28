import { getAddress } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { getChain } from '../../src/chains/registry'
import { poolHistory } from '../../src/portfolio/poolHistory'
import type { SnfClientContext } from '../../src/types/client.types'
import type { CachedResult, SubgraphPairBucket, SubgraphPairHistory } from '../../src/transport/subgraph.types'
import { testAddress } from './portfolioTestHelpers'

/**
 * `poolHistory(pair, interval, opts?)` — validation, the `not-an-snf-pair` gate, the
 * wrapper-side orientation (never `volume0 === base`), exact-unit parsing of the
 * indexer's own BigDecimal strings, and Arc's 6-decimal native axis. Builds its own
 * minimal `SnfClientContext` locally (this method issues zero RPC calls — every
 * figure comes from `ctx.transport.pairHistory` — so `buildPortfolioEnv`'s
 * multicall-mocking machinery is more than this file needs).
 */

const PAIR = testAddress(1)
const WRAPPER = testAddress(2)
const USDC = testAddress(3)

/** The live Base WSNFG/USDC shape: the wrapper is `token0`, a 6-decimal ERC-20 is
 * `token1`. */
const WRAPPER_IS_TOKEN0_PAIR: SubgraphPairHistory['pair'] = {
  id: PAIR,
  isNFTPool: true,
  discrete0: true,
  discrete1: false,
  token0: { id: WRAPPER, symbol: 'WNFT', decimals: 18 },
  token1: { id: USDC, symbol: 'USDC', decimals: 6 },
}

/** The mirrored fixture — same pool, wrapper on `token1` instead — proves the
 * orientation logic, not fixture order, decides which column is the base. */
const WRAPPER_IS_TOKEN1_PAIR: SubgraphPairHistory['pair'] = {
  id: PAIR,
  isNFTPool: true,
  discrete0: false,
  discrete1: true,
  token0: { id: USDC, symbol: 'USDC', decimals: 6 },
  token1: { id: WRAPPER, symbol: 'WNFT', decimals: 18 },
}

function bucket(overrides: Partial<SubgraphPairBucket> = {}): SubgraphPairBucket {
  return {
    t: 1_700_000_000,
    volume0: '0',
    volume1: '0',
    reserve0: '0',
    reserve1: '0',
    totalSupply: '0',
    txCount: '0',
    ...overrides,
  }
}

function cachedResult(
  pair: SubgraphPairHistory['pair'],
  buckets: readonly SubgraphPairBucket[],
  overrides: { readonly asOfBlock?: bigint; readonly lagSeconds?: number; readonly stale?: boolean; readonly revalidating?: boolean } = {},
): CachedResult<SubgraphPairHistory> {
  return {
    data: { pair, buckets },
    asOfBlock: overrides.asOfBlock ?? 100n,
    lagSeconds: overrides.lagSeconds ?? 0,
    stale: overrides.stale ?? false,
    revalidating: overrides.revalidating ?? false,
  }
}

function buildCtx(chainId: 8453 | 5042 = 8453): { readonly ctx: SnfClientContext; readonly pairHistory: ReturnType<typeof vi.fn> } {
  const chain = getChain(chainId)
  const pairHistory = vi.fn()
  const publicClient = { readContract: vi.fn(), multicall: vi.fn(), getBlockNumber: vi.fn(), getBalance: vi.fn() }
  const ctx = {
    config: { chainId, publicClient },
    chain,
    publicClient,
    providers: {},
    transport: {
      pools: vi.fn(),
      pairById: vi.fn(),
      inventory: vi.fn(),
      pairHistory,
      meta: vi.fn(),
      clear: vi.fn(),
    },
    nextTxInvalidationVersion: () => 1,
  } as unknown as SnfClientContext
  return { ctx, pairHistory }
}

describe('poolHistory — input validation, before any transport call', () => {
  it('a malformed pair rejects INVALID_PARAMS(field: pair)', async () => {
    const { ctx, pairHistory } = buildCtx()
    await expect(poolHistory(ctx, '0xbad' as `0x${string}`, 'day')).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { field: 'pair' },
    })
    expect(pairHistory).not.toHaveBeenCalled()
  })

  it('an invalid interval rejects INVALID_PARAMS(field: interval)', async () => {
    const { ctx, pairHistory } = buildCtx()
    await expect(poolHistory(ctx, PAIR, 'week' as never)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { field: 'interval' },
    })
    expect(pairHistory).not.toHaveBeenCalled()
  })

  it.each([0, -1, 1001, 1.5, Number.NaN])('limit %s rejects INVALID_PARAMS(field: limit, details.max: 1000)', async (limit) => {
    const { ctx, pairHistory } = buildCtx()
    await expect(poolHistory(ctx, PAIR, 'day', { limit })).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { field: 'limit', max: 1000 },
    })
    expect(pairHistory).not.toHaveBeenCalled()
  })
})

describe('poolHistory — default and explicit `first`', () => {
  it("'day' asks first: 90 by default", async () => {
    const { ctx, pairHistory } = buildCtx()
    pairHistory.mockResolvedValue(cachedResult(WRAPPER_IS_TOKEN0_PAIR, []))
    await poolHistory(ctx, PAIR, 'day')
    expect(pairHistory).toHaveBeenCalledWith(getAddress(PAIR), 'day', 90)
  })

  it("'month' asks first: 24 by default", async () => {
    const { ctx, pairHistory } = buildCtx()
    pairHistory.mockResolvedValue(cachedResult(WRAPPER_IS_TOKEN0_PAIR, []))
    await poolHistory(ctx, PAIR, 'month')
    expect(pairHistory).toHaveBeenCalledWith(getAddress(PAIR), 'month', 24)
  })

  it('{ limit: 1000 } asks first: 1000', async () => {
    const { ctx, pairHistory } = buildCtx()
    pairHistory.mockResolvedValue(cachedResult(WRAPPER_IS_TOKEN0_PAIR, []))
    await poolHistory(ctx, PAIR, 'day', { limit: 1000 })
    expect(pairHistory).toHaveBeenCalledWith(getAddress(PAIR), 'day', 1000)
  })
})

describe('poolHistory — the not-an-snf-pair gate', () => {
  it('pair: null rejects INVALID_PARAMS(reason: not-an-snf-pair)', async () => {
    const { ctx, pairHistory } = buildCtx()
    pairHistory.mockResolvedValue(cachedResult(null, []))
    await expect(poolHistory(ctx, PAIR, 'day')).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { reason: 'not-an-snf-pair' },
    })
  })

  it('isNFTPool: false (a BNB delegated pair) rejects the same way', async () => {
    const { ctx, pairHistory } = buildCtx()
    pairHistory.mockResolvedValue(cachedResult({ ...WRAPPER_IS_TOKEN0_PAIR, isNFTPool: false }, []))
    await expect(poolHistory(ctx, PAIR, 'day')).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { reason: 'not-an-snf-pair' },
    })
  })

  it('discrete0 === discrete1 (both true) rejects the same way', async () => {
    const { ctx, pairHistory } = buildCtx()
    pairHistory.mockResolvedValue(cachedResult({ ...WRAPPER_IS_TOKEN0_PAIR, discrete1: true }, []))
    await expect(poolHistory(ctx, PAIR, 'day')).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { reason: 'not-an-snf-pair' },
    })
  })

  it('discrete0 === discrete1 (both false) rejects the same way', async () => {
    const { ctx, pairHistory } = buildCtx()
    pairHistory.mockResolvedValue(cachedResult({ ...WRAPPER_IS_TOKEN0_PAIR, discrete0: false }, []))
    await expect(poolHistory(ctx, PAIR, 'day')).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
      details: { reason: 'not-an-snf-pair' },
    })
  })
})

describe('poolHistory — wrapper-side orientation, exact units', () => {
  const oneBucket = [
    bucket({
      t: 1_700_000_000,
      volume0: '1.703101324087820611',
      volume1: '0.043324',
      reserve0: '2',
      reserve1: '1.5',
      totalSupply: '0.000008485281374238',
      txCount: '16',
    }),
  ]

  it('wrapper = token0: volumeBase from volume1 (6 dec), volumeWnft from volume0 (18 dec)', async () => {
    const { ctx, pairHistory } = buildCtx()
    pairHistory.mockResolvedValue(cachedResult(WRAPPER_IS_TOKEN0_PAIR, oneBucket))
    const result = await poolHistory(ctx, PAIR, 'day')

    expect(result.points).toHaveLength(1)
    const point = result.points[0]!
    expect(point.volumeBase.value).toBe(43324n)
    expect(point.volumeBase.decimals).toBe(6)
    expect(point.volumeWnft.value).toBe(1703101324087820611n)
    expect(point.volumeWnft.decimals).toBe(18)
    expect(point.reserveBase.value).toBe(1500000n) // 1.5 at 6 dec
    expect(point.reserveWnft.value).toBe(2000000000000000000n) // 2 at 18 dec
    expect(point.totalSupply).toBe(8485281374238n)
    expect(point.txCount).toBe(16)
  })

  it('the mirrored wrapper = token1 fixture (with volume0/volume1 swapped) gives the identical points', async () => {
    const { ctx, pairHistory } = buildCtx()
    const mirroredBucket = [
      bucket({
        t: 1_700_000_000,
        volume0: '0.043324', // now the base side
        volume1: '1.703101324087820611', // now the wnft side
        reserve0: '1.5',
        reserve1: '2',
        totalSupply: '0.000008485281374238',
        txCount: '16',
      }),
    ]
    pairHistory.mockResolvedValue(cachedResult(WRAPPER_IS_TOKEN1_PAIR, mirroredBucket))
    const result = await poolHistory(ctx, PAIR, 'day')

    expect(result.points).toHaveLength(1)
    const point = result.points[0]!
    expect(point.volumeBase.value).toBe(43324n)
    expect(point.volumeWnft.value).toBe(1703101324087820611n)
    expect(point.reserveBase.value).toBe(1500000n)
    expect(point.reserveWnft.value).toBe(2000000000000000000n)
  })
})

describe('poolHistory — ordering and sparseness', () => {
  it('the indexer returns buckets newest-first; points come back ascending by t', async () => {
    const { ctx, pairHistory } = buildCtx()
    const buckets = [bucket({ t: 300 }), bucket({ t: 200 }), bucket({ t: 100 })]
    pairHistory.mockResolvedValue(cachedResult(WRAPPER_IS_TOKEN0_PAIR, buckets))
    const result = await poolHistory(ctx, PAIR, 'day')
    expect(result.points.map((p) => p.t)).toEqual([100, 200, 300])
  })

  it('an empty buckets array gives points: [] — a valid answer, not an error', async () => {
    const { ctx, pairHistory } = buildCtx()
    pairHistory.mockResolvedValue(cachedResult(WRAPPER_IS_TOKEN0_PAIR, []))
    const result = await poolHistory(ctx, PAIR, 'day')
    expect(result.points).toEqual([])
  })
})

describe('poolHistory — malformed BigDecimal strings skip only their own bucket', () => {
  it.each([
    ['1e-7', 'volume1'],
    ['-1', 'reserve0'],
    ['', 'totalSupply'],
    ['NaN', 'volume0'],
  ] as const)('a bucket with %s in %s is skipped; the other points survive', async (badValue, field) => {
    const { ctx, pairHistory } = buildCtx()
    const goodBucket = bucket({ t: 100, volume0: '1', volume1: '1', reserve0: '1', reserve1: '1', totalSupply: '1', txCount: '1' })
    const badBucket = bucket({ t: 200, [field]: badValue } as Partial<SubgraphPairBucket>)
    pairHistory.mockResolvedValue(cachedResult(WRAPPER_IS_TOKEN0_PAIR, [badBucket, goodBucket]))
    const result = await poolHistory(ctx, PAIR, 'day')
    expect(result.points.map((p) => p.t)).toEqual([100])
  })
})

describe('poolHistory — bucketSeconds', () => {
  it("'day' ⇒ 86_400", async () => {
    const { ctx, pairHistory } = buildCtx()
    pairHistory.mockResolvedValue(cachedResult(WRAPPER_IS_TOKEN0_PAIR, []))
    const result = await poolHistory(ctx, PAIR, 'day')
    expect(result.bucketSeconds).toBe(86_400)
  })

  it("'month' ⇒ 2_628_000", async () => {
    const { ctx, pairHistory } = buildCtx()
    pairHistory.mockResolvedValue(cachedResult(WRAPPER_IS_TOKEN0_PAIR, []))
    const result = await poolHistory(ctx, PAIR, 'month')
    expect(result.bucketSeconds).toBe(2_628_000)
  })
})

describe('poolHistory — Arc: the chain registry wins over a wrong subgraph decimals claim', () => {
  it('a native-base pool whose base id is the quote token but the indexer claims decimals: 18 still uses 6 decimals and the native symbol', async () => {
    const { ctx, pairHistory } = buildCtx(5042)
    const arcPair: SubgraphPairHistory['pair'] = {
      id: PAIR,
      isNFTPool: true,
      discrete0: true,
      discrete1: false,
      token0: { id: WRAPPER, symbol: 'WNFT', decimals: 18 },
      token1: { id: ctx.chain.quoteToken, symbol: 'WRONG', decimals: 18 }, // wrong on purpose
    }
    pairHistory.mockResolvedValue(cachedResult(arcPair, [bucket({ volume1: '1.5', reserve1: '2' })]))
    const result = await poolHistory(ctx, PAIR, 'day')

    expect(result.baseToken.decimals).toBe(6)
    expect(result.baseToken.symbol).toBe(ctx.chain.nativeSymbol)
    expect(result.baseToken.isNative).toBe(true)
    expect(result.points[0]!.volumeBase.value).toBe(1_500_000n) // 1.5 at 6 dec, not 18
  })
})

describe('poolHistory — an ERC-20 base uses the indexer symbol and decimals', () => {
  it('decimals as a string ("6") and as a number (6) both resolve the same base token', async () => {
    for (const decimals of ['6', 6] as const) {
      const { ctx, pairHistory } = buildCtx()
      const pairFixture: SubgraphPairHistory['pair'] = {
        ...WRAPPER_IS_TOKEN0_PAIR,
        token1: { id: USDC, symbol: 'USDC', decimals },
      }
      pairHistory.mockResolvedValue(cachedResult(pairFixture, []))
      const result = await poolHistory(ctx, PAIR, 'day')
      expect(result.baseToken).toStrictEqual({ address: getAddress(USDC), symbol: 'USDC', decimals: 6, isNative: false })
    }
  })
})

describe('poolHistory — the result carries the transport\'s own freshness and a checksummed pair', () => {
  it('asOfBlock, lagSeconds, stale come from the transport result; pair is checksummed', async () => {
    const { ctx, pairHistory } = buildCtx()
    pairHistory.mockResolvedValue(cachedResult(WRAPPER_IS_TOKEN0_PAIR, [], { asOfBlock: 12_345n, lagSeconds: 42, stale: true }))
    const result = await poolHistory(ctx, PAIR, 'day')
    expect(result.asOfBlock).toBe(12_345n)
    expect(result.lagSeconds).toBe(42)
    expect(result.stale).toBe(true)
    expect(result.pair).toBe(getAddress(PAIR))
  })

  it('a transport rejection propagates', async () => {
    const { ctx, pairHistory } = buildCtx()
    pairHistory.mockRejectedValue(new Error('upstream down'))
    await expect(poolHistory(ctx, PAIR, 'day')).rejects.toThrow('upstream down')
  })
})
