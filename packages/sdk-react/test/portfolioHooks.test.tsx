import { act, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { QueryClient, QueryKey } from '@tanstack/react-query'
import {
  describeError,
  SnfError,
  type CollectionsHeld,
  type PoolHistory,
  type PortfolioPositions,
  type SnfClient,
  type WnftBalances,
} from '@sweepnflip/sdk'
import { useSnfContext } from '../src/context'
import { useSnfCollectionsHeld } from '../src/hooks/useSnfCollectionsHeld'
import { useSnfPoolHistory } from '../src/hooks/useSnfPoolHistory'
import { useSnfPositions } from '../src/hooks/useSnfPositions'
import { useSnfWnftBalances } from '../src/hooks/useSnfWnftBalances'
import { snfQueryKeys } from '../src/queryKeys'
import { createTestQueryClient, renderWithSnf } from './setup'

/** `Query.options` (core) is typed as the base `QueryOptions` — `staleTime`/
 * `refetchInterval` only exist on the observer-level `QueryObserverOptions`
 * that `useQuery` merges in. At runtime a mounted observer's cadence lands
 * on the same cached `Query.options` object, so this narrows the read side
 * rather than reaching for `any`. */
interface CadenceOptions {
  readonly staleTime?: number
  readonly refetchInterval?: number | false
}

function findCadence(queryClient: QueryClient, queryKey: QueryKey): CadenceOptions | undefined {
  return queryClient.getQueryCache().find({ queryKey })?.options as CadenceOptions | undefined
}

/**
 * The four portfolio hooks: keys, `enabled` guards, cadence, per-chain
 * isolation, invalidation and error passthrough. A stubbed `SnfClient`
 * throughout (`vi.fn()` methods) — this suite tests the react layer's own
 * wiring, not the core's correctness (the core's portfolio reads already
 * have their own test suite).
 */

const OWNER = '0xAaAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' as const
const PAIR = '0xBbBbBBbBBbbbBBbbBBbbbbbBBbBbbbbBbBbBBbb' as const
const COLLECTION = '0xcccccccccccccccccccccccccccccccccccccc' as const
const WRAPPER = '0xdddddddddddddddddddddddddddddddddddddd' as const

function amount(value: bigint, decimals = 18, symbol = 'ETH') {
  return { value, formatted: value.toString(), symbol, decimals }
}

const LABELS = { name: 'Rasta', symbol: 'RASTA' }
const BASE_TOKEN = { address: null, symbol: 'ETH', decimals: 18, isNative: true }
const POOL_SET = { asOfBlock: 1n, lagSeconds: 0, stale: false }

function fakePositions(): PortfolioPositions {
  return {
    chainId: 8453,
    owner: OWNER,
    blockNumber: 1n,
    positions: [
      {
        pair: PAIR,
        owner: OWNER,
        lpBalance: amount(1_000n),
        totalSupply: 10_000n,
        shareBps: 1_000,
        underlying: { base: amount(1n), wnft: amount(1n), nftWhole: 1 },
        blockNumber: 1n,
        chainId: 8453,
        collection: COLLECTION,
        wrapper: WRAPPER,
        baseToken: BASE_TOKEN,
        labels: LABELS,
        valueInBase: amount(2n),
        valuation: 'mid',
        valueUsd: undefined,
      },
    ],
    skipped: [],
    poolSet: POOL_SET,
  }
}

function fakeWnftBalances(): WnftBalances {
  return {
    chainId: 8453,
    owner: OWNER,
    blockNumber: 1n,
    holdings: [
      {
        collection: COLLECTION,
        wrapper: WRAPPER,
        labels: LABELS,
        balance: amount(1_000_000_000_000_000_000n),
        nftWhole: 1,
        valueInBase: amount(1n),
        valuation: 'mid',
        valueUsd: undefined,
      },
    ],
    skipped: [],
    poolSet: POOL_SET,
  }
}

function fakeCollectionsHeldUnavailable(): CollectionsHeld {
  return { status: 'unavailable', reason: 'no-provider', chainId: 8453, owner: OWNER }
}

function fakePoolHistory(): PoolHistory {
  return {
    chainId: 8453,
    pair: PAIR,
    interval: 'day',
    bucketSeconds: 86_400,
    baseToken: BASE_TOKEN,
    points: [],
    asOfBlock: 1n,
    lagSeconds: 0,
    stale: false,
  }
}

/** All 28 `SnfClient` methods, every non-portfolio one stubbed with a bare
 * `vi.fn()` — this suite only ever drives the four portfolio methods. */
function fakeClient(chainId: SnfClient['chainId'], overrides: Partial<SnfClient> = {}): SnfClient {
  return {
    chainId,
    chain: { chainId } as SnfClient['chain'],
    collection: vi.fn(),
    poolInventory: vi.fn(),
    quoteBuy: vi.fn(),
    quoteSell: vi.fn(),
    quoteNftToNft: vi.fn(),
    quoteSwap: vi.fn(),
    estimateLadder: vi.fn(),
    buildBuy: vi.fn(),
    buildSell: vi.fn(),
    buildNftToNft: vi.fn(),
    buildSwap: vi.fn(),
    parseReceipt: vi.fn(),
    describeError,
    redemptionStatus: vi.fn(),
    lpPosition: vi.fn(),
    quoteAddLiquidity: vi.fn(),
    quoteCreatePool: vi.fn(),
    quoteRemoveLiquidity: vi.fn(),
    buildAddLiquidity: vi.fn(),
    buildCreatePool: vi.fn(),
    buildRemoveLiquidity: vi.fn(),
    buildSeed: vi.fn(),
    seeding: vi.fn(),
    attestation: vi.fn(),
    positions: vi.fn().mockResolvedValue(fakePositions()),
    wnftBalances: vi.fn().mockResolvedValue(fakeWnftBalances()),
    collectionsHeld: vi.fn().mockResolvedValue(fakeCollectionsHeldUnavailable()),
    poolHistory: vi.fn().mockResolvedValue(fakePoolHistory()),
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useSnfPositions', () => {
  it('enabled guard: no owner issues zero calls; a set owner issues exactly one', async () => {
    const client = fakeClient(8453)

    renderWithSnf(() => useSnfPositions(undefined), { client })
    expect(client.positions).not.toHaveBeenCalled()

    const { result } = renderWithSnf(() => useSnfPositions(OWNER), { client })
    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(client.positions).toHaveBeenCalledTimes(1)
    expect(client.positions).toHaveBeenCalledWith(OWNER)
  })

  it("key is ['snf','positions',chainId,v,owner lowercased]", async () => {
    const queryClient = createTestQueryClient()
    const client = fakeClient(8453)
    const { result } = renderWithSnf(() => useSnfPositions(OWNER), { client, queryClient })

    await waitFor(() => expect(result.current.data).toBeDefined())
    const key = queryClient.getQueryCache().getAll()[0]?.queryKey
    expect(key).toEqual(['snf', 'positions', 8453, 0, OWNER.toLowerCase()])
  })

  it('cadence: staleTime 20_000, refetchInterval 30_000 by default; a caller override wins', async () => {
    const queryClient = createTestQueryClient()
    const client = fakeClient(8453)
    renderWithSnf(() => useSnfPositions(OWNER), { client, queryClient })

    await waitFor(() => {
      const cadence = findCadence(queryClient, snfQueryKeys.positions(8453, 0, OWNER))
      expect(cadence?.staleTime).toBe(20_000)
      expect(cadence?.refetchInterval).toBe(30_000)
    })

    const queryClient2 = createTestQueryClient()
    renderWithSnf(() => useSnfPositions(OWNER, { staleTime: 5_000 }), { client, queryClient: queryClient2 })
    await waitFor(() => {
      const cadence = findCadence(queryClient2, snfQueryKeys.positions(8453, 0, OWNER))
      expect(cadence?.staleTime).toBe(5_000)
    })
  })

  it('error passthrough: a rejecting client surfaces an SnfError with the same code', async () => {
    const client = fakeClient(8453, {
      positions: vi.fn().mockRejectedValue(new SnfError('UPSTREAM_DEGRADED', 'indexer lag')),
    })
    const { result } = renderWithSnf(() => useSnfPositions(OWNER), { client })

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error).toBeInstanceOf(SnfError)
    expect(result.current.error?.code).toBe('UPSTREAM_DEGRADED')
  })
})

describe('useSnfWnftBalances', () => {
  it('enabled guard: no owner issues zero calls', () => {
    const client = fakeClient(8453)
    renderWithSnf(() => useSnfWnftBalances(undefined), { client })
    expect(client.wnftBalances).not.toHaveBeenCalled()
  })

  it("key is ['snf','wnftBalances',chainId,v,owner lowercased]; resolves the balances", async () => {
    const queryClient = createTestQueryClient()
    const client = fakeClient(8453)
    const { result } = renderWithSnf(() => useSnfWnftBalances(OWNER), { client, queryClient })

    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(client.wnftBalances).toHaveBeenCalledTimes(1)
    expect(client.wnftBalances).toHaveBeenCalledWith(OWNER)
    const key = queryClient.getQueryCache().getAll()[0]?.queryKey
    expect(key).toEqual(['snf', 'wnftBalances', 8453, 0, OWNER.toLowerCase()])
  })

  it('cadence: staleTime 20_000, refetchInterval 30_000', async () => {
    const queryClient = createTestQueryClient()
    const client = fakeClient(8453)
    renderWithSnf(() => useSnfWnftBalances(OWNER), { client, queryClient })

    await waitFor(() => {
      const cadence = findCadence(queryClient, snfQueryKeys.wnftBalances(8453, 0, OWNER))
      expect(cadence?.staleTime).toBe(20_000)
      expect(cadence?.refetchInterval).toBe(30_000)
    })
  })
})

describe('useSnfCollectionsHeld', () => {
  it('enabled guard: no owner issues zero calls', () => {
    const client = fakeClient(8453)
    renderWithSnf(() => useSnfCollectionsHeld(undefined), { client })
    expect(client.collectionsHeld).not.toHaveBeenCalled()
  })

  it("the { status: 'unavailable' } answer passes through as data, not an error", async () => {
    const client = fakeClient(8453)
    const { result } = renderWithSnf(() => useSnfCollectionsHeld(OWNER), { client })

    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.error).toBeNull()
    expect(result.current.data).toEqual(fakeCollectionsHeldUnavailable())
  })

  it("key is ['snf','collectionsHeld',chainId,v,owner lowercased]", async () => {
    const queryClient = createTestQueryClient()
    const client = fakeClient(8453)
    const { result } = renderWithSnf(() => useSnfCollectionsHeld(OWNER), { client, queryClient })

    await waitFor(() => expect(result.current.data).toBeDefined())
    const key = queryClient.getQueryCache().getAll()[0]?.queryKey
    expect(key).toEqual(['snf', 'collectionsHeld', 8453, 0, OWNER.toLowerCase()])
  })

  it('cadence: staleTime 60_000, no refetchInterval', async () => {
    const queryClient = createTestQueryClient()
    const client = fakeClient(8453)
    renderWithSnf(() => useSnfCollectionsHeld(OWNER), { client, queryClient })

    await waitFor(() => {
      const cadence = findCadence(queryClient, snfQueryKeys.collectionsHeld(8453, 0, OWNER))
      expect(cadence?.staleTime).toBe(60_000)
      expect(cadence?.refetchInterval).toBeFalsy()
    })
  })
})

describe('useSnfPoolHistory', () => {
  it('enabled guard: no pair issues zero calls', () => {
    const client = fakeClient(8453)
    renderWithSnf(() => useSnfPoolHistory(undefined, 'day'), { client })
    expect(client.poolHistory).not.toHaveBeenCalled()
  })

  it("key ends ..., pair lowercased, 'day', null when no args are passed", async () => {
    const queryClient = createTestQueryClient()
    const client = fakeClient(8453)
    const { result } = renderWithSnf(() => useSnfPoolHistory(PAIR, 'day'), { client, queryClient })

    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(client.poolHistory).toHaveBeenCalledWith(PAIR, 'day', undefined)
    const key = queryClient.getQueryCache().getAll()[0]?.queryKey
    expect(key).toEqual(['snf', 'poolHistory', 8453, 0, PAIR.toLowerCase(), 'day', null])
  })

  it("key ends ..., pair lowercased, 'month', 12 when args.limit is 12", async () => {
    const queryClient = createTestQueryClient()
    const client = fakeClient(8453)
    const { result } = renderWithSnf(() => useSnfPoolHistory(PAIR, 'month', { limit: 12 }), { client, queryClient })

    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(client.poolHistory).toHaveBeenCalledWith(PAIR, 'month', { limit: 12 })
    const key = queryClient.getQueryCache().getAll()[0]?.queryKey
    expect(key).toEqual(['snf', 'poolHistory', 8453, 0, PAIR.toLowerCase(), 'month', 12])
  })

  it('cadence: staleTime 300_000, no refetchInterval', async () => {
    const queryClient = createTestQueryClient()
    const client = fakeClient(8453)
    renderWithSnf(() => useSnfPoolHistory(PAIR, 'day'), { client, queryClient })

    await waitFor(() => {
      const cadence = findCadence(queryClient, snfQueryKeys.poolHistory(8453, 0, PAIR, 'day', null))
      expect(cadence?.staleTime).toBe(300_000)
      expect(cadence?.refetchInterval).toBeFalsy()
    })
  })

  it('error passthrough: a rejecting client surfaces an SnfError with the same code', async () => {
    const client = fakeClient(8453, {
      poolHistory: vi.fn().mockRejectedValue(new SnfError('INVALID_PARAMS', 'not an snf pair')),
    })
    const { result } = renderWithSnf(() => useSnfPoolHistory(PAIR, 'day'), { client })

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error).toBeInstanceOf(SnfError)
    expect(result.current.error?.code).toBe('INVALID_PARAMS')
  })
})

describe('portfolio query hooks — cross-cutting cache behaviour', () => {
  it('per-chain isolation: two providers, same owner, two distinct cache entries, one call each', async () => {
    const queryClient = createTestQueryClient()
    const clientBase = fakeClient(8453)
    const clientArb = fakeClient(42161)

    const base = renderWithSnf(() => useSnfPositions(OWNER), { client: clientBase, chainId: 8453, queryClient })
    const arb = renderWithSnf(() => useSnfPositions(OWNER), { client: clientArb, chainId: 42161, queryClient })

    await waitFor(() => expect(base.result.current.data).toBeDefined())
    await waitFor(() => expect(arb.result.current.data).toBeDefined())

    expect(clientBase.positions).toHaveBeenCalledTimes(1)
    expect(clientArb.positions).toHaveBeenCalledTimes(1)

    const keys = queryClient.getQueryCache().getAll().map((q) => q.queryKey)
    const keysWithBase = keys.filter((k) => k.includes(8453))
    const keysWithArb = keys.filter((k) => k.includes(42161))
    expect(keysWithBase.length).toBeGreaterThan(0)
    expect(keysWithArb.length).toBeGreaterThan(0)
    expect(keysWithBase).not.toEqual(keysWithArb)
  })

  it('invalidation: bumping txInvalidationVersion refetches positions', async () => {
    const queryClient = createTestQueryClient()
    const client = fakeClient(8453)

    const { result } = renderWithSnf(
      () => ({
        positions: useSnfPositions(OWNER, { refetchInterval: false }),
        ctx: useSnfContext(),
      }),
      { client, queryClient },
    )

    await waitFor(() => expect(result.current.positions.data).toBeDefined())
    expect(client.positions).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.ctx.bumpInvalidation()
    })

    await waitFor(() => expect(client.positions).toHaveBeenCalledTimes(2))
  })
})
