import { act, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { describeError, SnfError, type LpPosition, type Quote, type RedemptionStatus, type SnfClient } from '@sweepnflip/sdk'
import { useSnfContext } from '../src/context'
import { useSnfLpPosition } from '../src/hooks/useSnfLpPosition'
import { useSnfQuoteAddLiquidity } from '../src/hooks/useSnfQuoteAddLiquidity'
import { useSnfQuoteCreatePool } from '../src/hooks/useSnfQuoteCreatePool'
import { useSnfQuoteRemoveLiquidity } from '../src/hooks/useSnfQuoteRemoveLiquidity'
import { useSnfRedemptionStatus } from '../src/hooks/useSnfRedemptionStatus'
import { createTestQueryClient, renderWithSnf } from './setup'

/**
 * The nine liquidity hooks (a new file, separate from `hooks.test.tsx`, per this
 * task's own scope): five read hooks here — cache keys, `enabled` guards,
 * bigint-safe hashing, invalidation and error passthrough. A stubbed `SnfClient`
 * (`vi.fn()` methods) throughout — this suite tests the REACT layer's own wiring,
 * not the core's correctness (the core's liquidity math/reconciliation is already
 * covered by `packages/sdk`'s own test suite).
 */

function amount(value: bigint) {
  return { value, formatted: value.toString(), symbol: 'ETH', decimals: 18 }
}

const COLLECTION = '0xcccccccccccccccccccccccccccccccccccccc' as const
const PAIR = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' as const
const OWNER = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' as const

function fakeLiquidityQuote(side: Quote['side'] = 'add-liquidity'): Quote {
  return {
    side,
    chainId: 8453,
    legs: [],
    fees: {
      pool: { bps: 0, note: 'no fee on liquidity' },
      marketplace: { ...amount(0n), bps: 0 },
      royalty: { ...amount(0n), bps: 0, capApplied: false },
    },
    priceImpact: 0,
    deliverable: 1,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    reconciled: true,
  }
}

function fakeLpPosition(): LpPosition {
  return {
    pair: PAIR,
    owner: OWNER,
    lpBalance: amount(1_000n),
    totalSupply: 10_000n,
    shareBps: 1_000,
    underlying: { base: amount(1n), wnft: amount(1n), nftWhole: 1 },
    blockNumber: 1n,
  }
}

function fakeRedemptionStatusResult(): RedemptionStatus {
  return { status: 'allowed', source: 'enumerable' }
}

/** All 24 `SnfClient` methods, every liquidity/seeding one stubbed with a
 * resolving `vi.fn()` by default so a `useQuery`'s `enabled: true` path always
 * has something to resolve — a test that needs a rejection overrides one entry
 * via `fakeClient(chainId, { methodName: vi.fn().mockRejectedValue(...) })`. */
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
    redemptionStatus: vi.fn().mockResolvedValue(fakeRedemptionStatusResult()),
    lpPosition: vi.fn().mockResolvedValue(fakeLpPosition()),
    quoteAddLiquidity: vi.fn().mockResolvedValue(fakeLiquidityQuote('add-liquidity')),
    quoteCreatePool: vi.fn().mockResolvedValue(fakeLiquidityQuote('create-pool')),
    quoteRemoveLiquidity: vi.fn().mockResolvedValue(fakeLiquidityQuote('remove-liquidity')),
    buildAddLiquidity: vi.fn(),
    buildCreatePool: vi.fn(),
    buildRemoveLiquidity: vi.fn(),
    buildSeed: vi.fn(),
    seeding: vi.fn(),
    attestation: vi.fn(),
    ...overrides,
  }
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useSnfQuoteAddLiquidity', () => {
  it('enabled guard: no collection, no tokenIds, or an empty tokenIds array each issue zero calls', () => {
    const client = fakeClient(8453)

    renderWithSnf(() => useSnfQuoteAddLiquidity(undefined), { client })
    renderWithSnf(() => useSnfQuoteAddLiquidity({ collection: COLLECTION, tokenIds: [] }), { client })
    renderWithSnf(() => useSnfQuoteAddLiquidity({ tokenIds: ['1'] } as never), { client })

    expect(client.quoteAddLiquidity).not.toHaveBeenCalled()
  })

  it('ready once collection + at least one tokenId are present, resolves the quote', async () => {
    const client = fakeClient(8453)
    const { result } = renderWithSnf(
      () => useSnfQuoteAddLiquidity({ collection: COLLECTION, tokenIds: ['1', '2'] }),
      { client },
    )

    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(client.quoteAddLiquidity).toHaveBeenCalledTimes(1)
    expect(client.quoteAddLiquidity).toHaveBeenCalledWith(
      expect.objectContaining({ chainId: 8453, collection: COLLECTION, tokenIds: ['1', '2'] }),
    )
  })

  it("the query key's chainId/v slot (after the ['snf', name] prefix) is chainId then txInvalidationVersion", async () => {
    const queryClient = createTestQueryClient()
    const client = fakeClient(8453)
    const { result } = renderWithSnf(
      () => useSnfQuoteAddLiquidity({ collection: COLLECTION, tokenIds: ['1'] }),
      { client, queryClient },
    )

    await waitFor(() => expect(result.current.data).toBeDefined())
    const key = queryClient.getQueryCache().getAll()[0]?.queryKey
    expect(key?.slice(0, 4)).toEqual(['snf', 'quoteAddLiquidity', 8453, 0])
  })

  it('error passthrough: a rejecting client surfaces an SnfError with the same code', async () => {
    const client = fakeClient(8453, {
      quoteAddLiquidity: vi.fn().mockRejectedValue(new SnfError('INVALID_PARAMS', 'no pool')),
    })
    const { result } = renderWithSnf(
      () => useSnfQuoteAddLiquidity({ collection: COLLECTION, tokenIds: ['1'] }),
      { client },
    )

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error).toBeInstanceOf(SnfError)
    expect(result.current.error?.code).toBe('INVALID_PARAMS')
  })
})

describe('useSnfQuoteCreatePool', () => {
  it('enabled guard: missing collection, tokenIds, or baseAmount each issue zero calls', () => {
    const client = fakeClient(8453)

    renderWithSnf(() => useSnfQuoteCreatePool(undefined), { client })
    renderWithSnf(() => useSnfQuoteCreatePool({ collection: COLLECTION, tokenIds: [], baseAmount: 1n }), { client })
    renderWithSnf(() => useSnfQuoteCreatePool({ collection: COLLECTION, tokenIds: ['1'] } as never), { client })

    expect(client.quoteCreatePool).not.toHaveBeenCalled()
  })

  it('a bigint baseAmount does not throw when hashed into the query key, and resolves', async () => {
    const client = fakeClient(8453)
    const { result } = renderWithSnf(
      () =>
        useSnfQuoteCreatePool({
          collection: COLLECTION,
          tokenIds: ['1', '2', '3', '4', '5', '6'],
          baseAmount: 6_000_000_000_000_000_000n,
        }),
      { client },
    )

    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(client.quoteCreatePool).toHaveBeenCalledTimes(1)
  })

  it('a baseAmount of exactly 0n is still a present value, not treated as absent', async () => {
    const client = fakeClient(8453)
    const { result } = renderWithSnf(
      () => useSnfQuoteCreatePool({ collection: COLLECTION, tokenIds: ['1'], baseAmount: 0n }),
      { client },
    )

    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(client.quoteCreatePool).toHaveBeenCalledTimes(1)
  })
})

describe('useSnfQuoteRemoveLiquidity', () => {
  it('enabled guard: missing pair/owner/mode, or neither liquidity nor bps, issues zero calls', () => {
    const client = fakeClient(8453)

    renderWithSnf(() => useSnfQuoteRemoveLiquidity(undefined), { client })
    renderWithSnf(() => useSnfQuoteRemoveLiquidity({ pair: PAIR, owner: OWNER, mode: 'nft' }), { client })
    renderWithSnf(() => useSnfQuoteRemoveLiquidity({ pair: PAIR, mode: 'nft', bps: 5_000 } as never), { client })

    expect(client.quoteRemoveLiquidity).not.toHaveBeenCalled()
  })

  it('a bigint liquidity amount does not throw when hashed into the query key, and resolves', async () => {
    const client = fakeClient(8453)
    const { result } = renderWithSnf(
      () =>
        useSnfQuoteRemoveLiquidity({
          pair: PAIR,
          owner: OWNER,
          mode: 'wnft',
          liquidity: 1_234_000_000_000_000_000n,
        }),
      { client },
    )

    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(client.quoteRemoveLiquidity).toHaveBeenCalledTimes(1)
  })

  it('a bps share (no liquidity) is also a valid ready state', async () => {
    const client = fakeClient(8453)
    const { result } = renderWithSnf(
      () => useSnfQuoteRemoveLiquidity({ pair: PAIR, owner: OWNER, mode: 'nft', bps: 2_500 }),
      { client },
    )

    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(client.quoteRemoveLiquidity).toHaveBeenCalledTimes(1)
  })

  it('error passthrough: a rejecting client surfaces an SnfError with the same code', async () => {
    const client = fakeClient(8453, {
      quoteRemoveLiquidity: vi.fn().mockRejectedValue(new SnfError('REDEMPTION_LOCKED', 'blocked')),
    })
    const { result } = renderWithSnf(
      () => useSnfQuoteRemoveLiquidity({ pair: PAIR, owner: OWNER, mode: 'nft', bps: 5_000 }),
      { client },
    )

    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error).toBeInstanceOf(SnfError)
    expect(result.current.error?.code).toBe('REDEMPTION_LOCKED')
  })
})

describe('useSnfLpPosition', () => {
  it('enabled guard: missing pair or owner issues zero calls', () => {
    const client = fakeClient(8453)

    renderWithSnf(() => useSnfLpPosition(undefined, undefined), { client })
    renderWithSnf(() => useSnfLpPosition(PAIR, undefined), { client })
    renderWithSnf(() => useSnfLpPosition(undefined, OWNER), { client })

    expect(client.lpPosition).not.toHaveBeenCalled()
  })

  it('ready once both pair and owner are present, resolves the position', async () => {
    const client = fakeClient(8453)
    const { result } = renderWithSnf(() => useSnfLpPosition(PAIR, OWNER), { client })

    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(client.lpPosition).toHaveBeenCalledTimes(1)
    expect(client.lpPosition).toHaveBeenCalledWith(PAIR, OWNER)
  })
})

describe('useSnfRedemptionStatus', () => {
  it('enabled guard: no collection issues zero calls', () => {
    const client = fakeClient(8453)

    renderWithSnf(() => useSnfRedemptionStatus(undefined), { client })

    expect(client.redemptionStatus).not.toHaveBeenCalled()
  })

  it('ready once collection is present, resolves the tri-state result', async () => {
    const client = fakeClient(8453)
    const { result } = renderWithSnf(() => useSnfRedemptionStatus(COLLECTION), { client })

    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(client.redemptionStatus).toHaveBeenCalledTimes(1)
    expect(result.current.data?.status).toBe('allowed')
  })

  it('a caller-supplied refetchInterval override is honoured (no forced polling)', async () => {
    const client = fakeClient(8453)
    const { result } = renderWithSnf(
      () => useSnfRedemptionStatus(COLLECTION, { refetchInterval: false }),
      { client },
    )

    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(client.redemptionStatus).toHaveBeenCalledTimes(1)
  })
})

describe('liquidity query hooks — cross-cutting cache behaviour', () => {
  it('per-chain isolation: two providers, same pair/owner, two distinct cache entries and no data bleed', async () => {
    const queryClient = createTestQueryClient()
    const clientBase = fakeClient(8453)
    const clientArb = fakeClient(42161)

    const base = renderWithSnf(() => useSnfLpPosition(PAIR, OWNER), { client: clientBase, chainId: 8453, queryClient })
    const arb = renderWithSnf(() => useSnfLpPosition(PAIR, OWNER), { client: clientArb, chainId: 42161, queryClient })

    await waitFor(() => expect(base.result.current.data).toBeDefined())
    await waitFor(() => expect(arb.result.current.data).toBeDefined())

    expect(clientBase.lpPosition).toHaveBeenCalledTimes(1)
    expect(clientArb.lpPosition).toHaveBeenCalledTimes(1)

    const keys = queryClient.getQueryCache().getAll().map((q) => q.queryKey)
    const keysWithBase = keys.filter((k) => k.includes(8453))
    const keysWithArb = keys.filter((k) => k.includes(42161))
    expect(keysWithBase.length).toBeGreaterThan(0)
    expect(keysWithArb.length).toBeGreaterThan(0)
    expect(keysWithBase).not.toEqual(keysWithArb)
  })

  it('invalidation: bumping txInvalidationVersion refetches every new liquidity query hook', async () => {
    const queryClient = createTestQueryClient()
    const client = fakeClient(8453)

    const { result } = renderWithSnf(
      () => ({
        addLiquidity: useSnfQuoteAddLiquidity(
          { collection: COLLECTION, tokenIds: ['1'] },
          { refetchInterval: false },
        ),
        lpPosition: useSnfLpPosition(PAIR, OWNER, { refetchInterval: false }),
        redemptionStatus: useSnfRedemptionStatus(COLLECTION),
        ctx: useSnfContext(),
      }),
      { client, queryClient },
    )

    await waitFor(() => expect(result.current.addLiquidity.data).toBeDefined())
    await waitFor(() => expect(result.current.lpPosition.data).toBeDefined())
    await waitFor(() => expect(result.current.redemptionStatus.data).toBeDefined())

    expect(client.quoteAddLiquidity).toHaveBeenCalledTimes(1)
    expect(client.lpPosition).toHaveBeenCalledTimes(1)
    expect(client.redemptionStatus).toHaveBeenCalledTimes(1)

    act(() => {
      result.current.ctx.bumpInvalidation()
    })

    await waitFor(() => expect(client.quoteAddLiquidity).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(client.lpPosition).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(client.redemptionStatus).toHaveBeenCalledTimes(2))
  })
})
