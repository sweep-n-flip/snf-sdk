import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeError, isSnfError, SnfError, type CollectionInfo, type PoolInventory, type Quote, type SnfClient } from '@sweepnflip/sdk'
import { useSnfContext } from '../src/context'
import { useSnfClient } from '../src/hooks/useSnfClient'
import { useSnfCollection } from '../src/hooks/useSnfCollection'
import { useSnfPoolInventory } from '../src/hooks/useSnfPoolInventory'
import { useSnfQuoteBuy } from '../src/hooks/useSnfQuoteBuy'
import { createTestQueryClient, renderWithSnf } from './setup'

/**
 * The read hooks' cache behaviour: per-`chainId` isolation, invalidation by
 * `txInvalidationVersion`, dedupe, `staleTime`, `refetchInterval`, `enabled` guards,
 * error passthrough, the outside-provider throw, and unmount safety mid-fetch. A
 * stubbed `SnfClient` (`vi.fn()` methods) is used throughout — this suite tests the
 * REACT layer's caching behaviour, not the core's correctness (plans 05-15 already
 * cover that; mirrors this plan's own Task 3 instruction).
 */

function amount(value: bigint) {
  return { value, formatted: value.toString(), symbol: 'ETH', decimals: 18 }
}

function fakeQuote(): Quote {
  return {
    side: 'buy',
    chainId: 8453,
    legs: [],
    fees: {
      pool: { bps: 200, note: 'included in curve' },
      marketplace: { ...amount(0n), bps: 250 },
      royalty: { ...amount(0n), bps: 0, capApplied: false },
    },
    priceImpact: 0,
    deliverable: 1,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    reconciled: true,
  }
}

function fakePoolInventory(): PoolInventory {
  return {
    tokenIds: [],
    availableCount: 0,
    asOfBlock: 1n,
    lagSeconds: 0,
    stale: false,
    source: 'enumerable',
    truncated: false,
    warnings: [],
  }
}

function fakeCollectionInfo(): CollectionInfo {
  return {
    address: '0xcccccccccccccccccccccccccccccccccccccc',
    wrapper: '0xdddddddddddddddddddddddddddddddddddddd',
    pools: [],
    labels: { name: 'Fake Collection', symbol: 'FAKE' },
    royalty: {
      bps: 0,
      receiver: null,
      capBps: 0,
      effectiveBpsWhenCapped: 0,
      basis: 'collection-default',
      unpayableReceiver: false,
      warnings: [],
      probeFailed: false,
    },
    redemptionLocked: false,
    wrapperVerified: 'match',
  }
}

/** `fakeClient`'s return type is `SnfClient` (the real, documented interface), which
 * erases the `vi.fn()` `Mock` type from each method at the type level — this helper
 * gets it back for the handful of assertions that need `.mock.calls.length` rather
 * than the (equally valid, but less convenient for a "keeps climbing" assertion)
 * `toHaveBeenCalledTimes` matcher. */
function callCount(fn: unknown): number {
  return (fn as ReturnType<typeof vi.fn>).mock.calls.length
}

function fakeClient(chainId: SnfClient['chainId'], overrides: Partial<SnfClient> = {}): SnfClient {
  return {
    chainId,
    chain: { chainId } as SnfClient['chain'],
    collection: vi.fn().mockResolvedValue(fakeCollectionInfo()),
    poolInventory: vi.fn().mockResolvedValue(fakePoolInventory()),
    quoteBuy: vi.fn().mockResolvedValue(fakeQuote()),
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
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('read hooks — cache behaviour', () => {
  it('per-chain isolation: two providers, same address, two distinct cache entries and no data bleed', async () => {
    const queryClient = createTestQueryClient()
    const clientBase = fakeClient(8453)
    const clientArb = fakeClient(42161)
    const address = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const

    const base = renderWithSnf(() => useSnfCollection(address), { client: clientBase, chainId: 8453, queryClient })
    const arb = renderWithSnf(() => useSnfCollection(address), { client: clientArb, chainId: 42161, queryClient })

    await waitFor(() => expect(base.result.current.data).toBeDefined())
    await waitFor(() => expect(arb.result.current.data).toBeDefined())

    expect(clientBase.collection).toHaveBeenCalledTimes(1)
    expect(clientArb.collection).toHaveBeenCalledTimes(1)

    const keys = queryClient.getQueryCache().getAll().map((q) => q.queryKey)
    const keysWithBase = keys.filter((k) => k.includes(8453))
    const keysWithArb = keys.filter((k) => k.includes(42161))
    expect(keysWithBase.length).toBeGreaterThan(0)
    expect(keysWithArb.length).toBeGreaterThan(0)
    expect(keysWithBase).not.toEqual(keysWithArb)
  })

  it('invalidation: bumping txInvalidationVersion on the context causes a refetch', async () => {
    const queryClient = createTestQueryClient()
    const client = fakeClient(8453)
    const pair = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const

    const { result } = renderWithSnf(
      () => ({ inventory: useSnfPoolInventory(pair, { refetchInterval: false }), ctx: useSnfContext() }),
      { client, queryClient },
    )

    await waitFor(() => expect(result.current.inventory.data).toBeDefined())
    expect(client.poolInventory).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.ctx.bumpInvalidation()
    })

    await waitFor(() => expect(client.poolInventory).toHaveBeenCalledTimes(2))
  })

  it('invalidation: bumping txInvalidationVersion also refetches useSnfQuoteBuy', async () => {
    const queryClient = createTestQueryClient()
    const client = fakeClient(8453)

    const { result } = renderWithSnf(
      () => ({
        quote: useSnfQuoteBuy({ collection: '0xcc', count: 1 }, { refetchInterval: false }),
        ctx: useSnfContext(),
      }),
      { client, queryClient },
    )

    await waitFor(() => expect(result.current.quote.data).toBeDefined())
    expect(client.quoteBuy).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.ctx.bumpInvalidation()
    })

    await waitFor(() => expect(client.quoteBuy).toHaveBeenCalledTimes(2))
  })

  it('dedupe: two components, same hook, same args, one provider — exactly one client call', async () => {
    const queryClient = createTestQueryClient()
    const client = fakeClient(8453)
    const address = '0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee' as const

    const a = renderWithSnf(() => useSnfCollection(address), { client, queryClient })
    const b = renderWithSnf(() => useSnfCollection(address), { client, queryClient })

    await waitFor(() => expect(a.result.current.data).toBeDefined())
    await waitFor(() => expect(b.result.current.data).toBeDefined())

    expect(client.collection).toHaveBeenCalledTimes(1)
  })

  it('staleTime respected: a re-render inside the stale window issues no new request', async () => {
    const queryClient = createTestQueryClient()
    const client = fakeClient(8453)
    const address = '0xffffffffffffffffffffffffffffffffffffff' as const

    const { result, rerender } = renderWithSnf(() => useSnfCollection(address, { staleTime: 60_000 }), {
      client,
      queryClient,
    })

    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(client.collection).toHaveBeenCalledTimes(1)

    rerender()
    rerender()

    expect(client.collection).toHaveBeenCalledTimes(1)
  })

  it('refetchInterval: useSnfPoolInventory refetches on its own interval', async () => {
    const queryClient = createTestQueryClient()
    const client = fakeClient(8453)
    const pair = '0x1111111111111111111111111111111111111a' as const

    const { result } = renderWithSnf(() => useSnfPoolInventory(pair, { refetchInterval: 100 }), {
      client,
      queryClient,
    })

    await waitFor(() => expect(result.current.data).toBeDefined())
    // The exact call count can outrun a fixed checkpoint under fast, delay-free mock
    // resolution (react-query schedules the NEXT interval tick from settle time, not
    // wall-clock time) — asserting a lower bound at two distinct checkpoints proves
    // the interval keeps firing without depending on hitting an exact tick count.
    const firstCount = callCount(client.poolInventory)
    await waitFor(() => expect(callCount(client.poolInventory)).toBeGreaterThan(firstCount), { timeout: 2000 })
    const secondCount = callCount(client.poolInventory)
    await waitFor(() => expect(callCount(client.poolInventory)).toBeGreaterThan(secondCount), { timeout: 2000 })
  })

  it('enabled guard: useSnfQuoteBuy issues zero calls until one of count/tokenIds/amount is present', async () => {
    const queryClient = createTestQueryClient()
    const client = fakeClient(8453)

    const { result } = renderWithSnf(() => useSnfQuoteBuy({ collection: '0xcc' }), { client, queryClient })

    // Incomplete args: no count/tokenIds/amount.
    expect(result.current.fetchStatus).toBe('idle')
    expect(client.quoteBuy).not.toHaveBeenCalled()
  })

  it('enabled guard: useSnfQuoteBuy fires exactly once args become complete', async () => {
    const queryClient = createTestQueryClient()
    const client = fakeClient(8453)

    const incomplete = renderWithSnf(() => useSnfQuoteBuy({ collection: '0xcc' }), { client, queryClient })
    expect(incomplete.result.current.fetchStatus).toBe('idle')
    expect(client.quoteBuy).not.toHaveBeenCalled()

    const complete = renderWithSnf(() => useSnfQuoteBuy({ collection: '0xcc', count: 1 }), { client, queryClient })
    await waitFor(() => expect(complete.result.current.data).toBeDefined())
    expect(client.quoteBuy).toHaveBeenCalledTimes(1)
  })

  it('error passthrough: the hook\'s error is the SAME SnfError instance, not a react-query wrapper', async () => {
    const queryClient = createTestQueryClient()
    const thrown = new SnfError('NO_ROUTE', 'no route for this pool')
    const client = fakeClient(8453, { collection: vi.fn().mockRejectedValue(thrown) })
    const address = '0x2222222222222222222222222222222222222b' as const

    const { result } = renderWithSnf(() => useSnfCollection(address), { client, queryClient })

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error).toBeInstanceOf(SnfError)
    expect(result.current.error).toBe(thrown)
    expect(result.current.error?.code).toBe('NO_ROUTE')
  })

  it('error passthrough: a non-SnfError thrown by the client is still surfaced as one', async () => {
    const queryClient = createTestQueryClient()
    const client = fakeClient(8453, { collection: vi.fn().mockRejectedValue(new Error('boom')) })
    const address = '0x3333333333333333333333333333333333333c' as const

    const { result } = renderWithSnf(() => useSnfCollection(address), { client, queryClient })

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(isSnfError(result.current.error)).toBe(true)
  })

  it('outside the provider: useSnfClient() throws a clear SnfError naming SnfProvider', () => {
    // Calling a hook OUTSIDE any render entirely is an "Invalid hook call" from
    // React itself, not our own guard — `renderHook` (no `wrapper`) is what actually
    // exercises `useSnfContext`'s own throw, the same way a partner's app would hit
    // it (a `useSnf*` hook called from a component tree with no `<SnfProvider>`).
    vi.spyOn(console, 'error').mockImplementation(() => {})

    let caught: SnfError | undefined
    try {
      renderHook(() => useSnfClient())
    } catch (err) {
      caught = err as SnfError
    }
    expect(caught).toBeInstanceOf(SnfError)
    expect(caught?.code).toBe('INVALID_PARAMS')
    expect(caught?.message).toMatch(/SnfProvider/)
  })

  it('unmount mid-fetch: no unhandled rejection, no unmounted-setState warning', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
    const queryClient = createTestQueryClient()
    let resolveCollection: (v: CollectionInfo) => void = () => {}
    const pending = new Promise<CollectionInfo>((resolve) => {
      resolveCollection = resolve
    })
    const client = fakeClient(8453, { collection: vi.fn().mockReturnValue(pending) })
    const address = '0x4444444444444444444444444444444444444d' as const

    const { unmount } = renderWithSnf(() => useSnfCollection(address), { client, queryClient })

    unmount()
    resolveCollection(fakeCollectionInfo())

    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(consoleError).not.toHaveBeenCalled()
  })
})
