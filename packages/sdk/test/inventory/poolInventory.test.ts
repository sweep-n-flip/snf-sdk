import type { PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { getChain } from '../../src/chains/registry'
import { isSnfError, SnfError } from '../../src/errors'
import { poolInventory } from '../../src/inventory/poolInventory'
import type { SnfClientContext } from '../../src/types/client.types'
import type { PoolInventory } from '../../src/types/inventory.types'
import type { PoolInventoryProvider } from '../../src/types/providers.types'

/**
 * `poolInventory` — the ERC721Enumerable fast path, the subgraph fallback with
 * freshness carried through verbatim, and the buyable ceiling that no partner
 * provider can raise (REQ-SDK-11, R7, R4; 54-SPEC.md, plan 11 Task 2). Every
 * `<behavior>` bullet is one `it` below.
 */

const CHAIN_ID = 8453
const PAIR = '0x000000000000000000000000000000000000Fa17' as `0x${string}`
const WRAPPER = '0x000000000000000000000000000000000000bAD1' as `0x${string}`
const BASE = '0x000000000000000000000000000000000000BA5e' as `0x${string}`
const COLLECTION = '0x000000000000000000000000000000000000c011' as `0x${string}`

type ReadResult = { status: 'success' | 'failure'; result?: unknown }
type Cached<T> = { data: T; asOfBlock: bigint; lagSeconds: number; stale: boolean; revalidating: boolean }

/** Dispatches a canned multicall response keyed by the batch's first `functionName` —
 * same convention as `test/collection/resolveCollection.test.ts`. */
function multicallByBatch(byFunction: Record<string, ReadResult[]>) {
  return (args: { contracts: readonly { functionName: string }[] }) => {
    const key = args.contracts[0]?.functionName ?? ''
    const result = byFunction[key]
    if (!result) throw new Error(`unexpected multicall batch starting with ${key}`)
    return Promise.resolve(result)
  }
}

/** `token0()/token1()/getReserves()` batch — `wrapperIsToken0` picks which slot holds
 * `WRAPPER` vs `BASE`, and which reserve is `reserveWnft` vs the base side. */
function token0Batch(wrapperIsToken0: boolean, reserveWnft: bigint, reserveBase: bigint): ReadResult[] {
  const [t0, t1] = wrapperIsToken0 ? [WRAPPER, BASE] : [BASE, WRAPPER]
  const [r0, r1] = wrapperIsToken0 ? [reserveWnft, reserveBase] : [reserveBase, reserveWnft]
  return [
    { status: 'success', result: t0 },
    { status: 'success', result: t1 },
    { status: 'success', result: [r0, r1, 0] },
  ]
}

/** `WERC721.collection()` probed on both token0 and token1 — only the wrapper slot
 * succeeds. */
function collectionBatch(wrapperIsToken0: boolean): ReadResult[] {
  return wrapperIsToken0
    ? [{ status: 'success', result: COLLECTION }, { status: 'failure' }]
    : [{ status: 'failure' }, { status: 'success', result: COLLECTION }]
}

function fakeCtx(opts: {
  multicall: ReturnType<typeof multicallByBatch>
  getBlockNumber?: () => Promise<bigint>
  inventory?: () => Promise<unknown>
  poolInventoryProvider?: PoolInventoryProvider
}): SnfClientContext {
  const publicClient = {
    multicall: vi.fn(opts.multicall),
    getBlockNumber: vi.fn(opts.getBlockNumber ?? (() => Promise.resolve(999n))),
  } as unknown as PublicClient
  const inventorySpy = vi.fn(
    opts.inventory ??
      (() =>
        Promise.resolve({ data: null, asOfBlock: 1n, lagSeconds: 0, stale: false, revalidating: false })),
  )
  return {
    config: { chainId: CHAIN_ID, publicClient },
    chain: getChain(CHAIN_ID),
    publicClient,
    providers: opts.poolInventoryProvider ? { poolInventory: opts.poolInventoryProvider } : {},
    transport: {
      pools: vi.fn(),
      pairById: vi.fn(),
      inventory: inventorySpy,
      meta: vi.fn(),
      clear: vi.fn(),
    },
    nextTxInvalidationVersion: () => 1,
  } as unknown as SnfClientContext
}

const RESERVE_12 = 12n * 10n ** 18n
const RESERVE_BASE = 5n * 10n ** 18n

describe('poolInventory — enumerable fast path (R7)', () => {
  it('supportsInterface true: ids come from tokenOfOwnerByIndex in ONE multicall, source==="enumerable", transport never called', async () => {
    const idResults: ReadResult[] = Array.from({ length: 12 }, (_u, i) => ({
      status: 'success',
      result: BigInt(1000 + i),
    }))
    const ctx = fakeCtx({
      multicall: multicallByBatch({
        token0: token0Batch(true, RESERVE_12, RESERVE_BASE),
        collection: collectionBatch(true),
        supportsInterface: [{ status: 'success', result: true }],
        tokenOfOwnerByIndex: idResults,
      }),
      getBlockNumber: () => Promise.resolve(4242n),
    })

    const result = await poolInventory(ctx, PAIR)

    expect(result.source).toBe('enumerable')
    expect(result.tokenIds).toHaveLength(12)
    expect(result.availableCount).toBe(11)
    expect(result.asOfBlock).toBe(4242n)
    expect(result.lagSeconds).toBe(0)
    expect(result.stale).toBe(false)
    expect(ctx.transport.inventory).not.toHaveBeenCalled()
  })

  it('never assumes token1: the wrapper on token1 is discovered via WERC721.collection(), not an address comparison', async () => {
    const idResults: ReadResult[] = Array.from({ length: 3 }, (_u, i) => ({
      status: 'success',
      result: BigInt(200 + i),
    }))
    const ctx = fakeCtx({
      multicall: multicallByBatch({
        token0: token0Batch(false, 4n * 10n ** 18n, RESERVE_BASE),
        collection: collectionBatch(false),
        supportsInterface: [{ status: 'success', result: true }],
        tokenOfOwnerByIndex: idResults,
      }),
    })

    const result = await poolInventory(ctx, PAIR)

    expect(result.source).toBe('enumerable')
    expect(result.availableCount).toBe(3)
    expect(result.tokenIds).toEqual(['200', '201', '202'])
  })

  it('caps the enumerable batch at 200 ids and reports truncated:true rather than an unbounded multicall', async () => {
    const idResults: ReadResult[] = Array.from({ length: 200 }, (_u, i) => ({
      status: 'success',
      result: BigInt(i),
    }))
    const ctx = fakeCtx({
      multicall: multicallByBatch({
        token0: token0Batch(true, 250n * 10n ** 18n, RESERVE_BASE),
        collection: collectionBatch(true),
        supportsInterface: [{ status: 'success', result: true }],
        tokenOfOwnerByIndex: idResults,
      }),
    })

    const result = await poolInventory(ctx, PAIR)

    expect(result.tokenIds).toHaveLength(200)
    expect(result.truncated).toBe(true)
    expect(result.availableCount).toBe(249)
  })
})

describe('poolInventory — subgraph fallback (R7, R4)', () => {
  function ctxWithSubgraph(opts: {
    supportsInterface: ReadResult[]
    inventory: () => Promise<unknown>
    reserveWnft?: bigint
  }) {
    return fakeCtx({
      multicall: multicallByBatch({
        token0: token0Batch(true, opts.reserveWnft ?? RESERVE_12, RESERVE_BASE),
        collection: collectionBatch(true),
        supportsInterface: opts.supportsInterface,
      }),
      inventory: opts.inventory,
    })
  }

  it('supportsInterface false: the subgraph path runs, source==="subgraph"', async () => {
    const ctx = ctxWithSubgraph({
      supportsInterface: [{ status: 'success', result: false }],
      inventory: () =>
        Promise.resolve({
          data: { tokenIds: ['5', '6'] },
          asOfBlock: 100n,
          lagSeconds: 10,
          stale: false,
          revalidating: false,
        } satisfies Cached<{ tokenIds: string[] }>),
    })

    const result = await poolInventory(ctx, PAIR)
    expect(result.source).toBe('subgraph')
    expect(result.tokenIds).toEqual(['5', '6'])
  })

  it('supportsInterface reverting (failure status) is treated the same as false', async () => {
    const ctx = ctxWithSubgraph({
      supportsInterface: [{ status: 'failure' }],
      inventory: () =>
        Promise.resolve({ data: { tokenIds: ['1'] }, asOfBlock: 1n, lagSeconds: 0, stale: false, revalidating: false }),
    })
    const result = await poolInventory(ctx, PAIR)
    expect(result.source).toBe('subgraph')
  })

  it('carries asOfBlock/lagSeconds/stale through UNCHANGED from the same POST that returned the ids', async () => {
    const ctx = ctxWithSubgraph({
      supportsInterface: [{ status: 'success', result: false }],
      inventory: () =>
        Promise.resolve({
          data: { tokenIds: ['9'] },
          asOfBlock: 555n,
          lagSeconds: 301,
          stale: true,
          revalidating: false,
        }),
    })
    const result = await poolInventory(ctx, PAIR)
    expect(result.asOfBlock).toBe(555n)
    expect(result.lagSeconds).toBe(301)
    expect(result.stale).toBe(true)
  })

  it('a stale (301s) result still returns ids WITH stale:true — never blanked to an empty pool', async () => {
    const ctx = ctxWithSubgraph({
      supportsInterface: [{ status: 'success', result: false }],
      inventory: () =>
        Promise.resolve({
          data: { tokenIds: ['11', '12'] },
          asOfBlock: 10n,
          lagSeconds: 301,
          stale: true,
          revalidating: false,
        }),
    })
    const result = await poolInventory(ctx, PAIR)
    expect(result.stale).toBe(true)
    expect(result.tokenIds).toEqual(['11', '12'])
  })

  it('a transport UPSTREAM_DEGRADED rejection propagates as that same typed error, never an empty inventory', async () => {
    const ctx = ctxWithSubgraph({
      supportsInterface: [{ status: 'success', result: false }],
      inventory: () => Promise.reject(new SnfError('UPSTREAM_DEGRADED', 'lag exceeds threshold')),
    })
    await expect(poolInventory(ctx, PAIR)).rejects.toSatisfy(
      (e: unknown) => isSnfError(e) && e.code === 'UPSTREAM_DEGRADED',
    )
  })

  it('12 indexed ids and a reserve of 12e18: tokenIds.length===12 and availableCount===11', async () => {
    const tokenIds = Array.from({ length: 12 }, (_u, i) => String(300 + i))
    const ctx = ctxWithSubgraph({
      supportsInterface: [{ status: 'success', result: false }],
      inventory: () =>
        Promise.resolve({ data: { tokenIds }, asOfBlock: 1n, lagSeconds: 0, stale: false, revalidating: false }),
    })
    const result = await poolInventory(ctx, PAIR)
    expect(result.tokenIds).toHaveLength(12)
    expect(result.availableCount).toBe(11)
  })

  it('an empty subgraph list returns [] and the reserve-derived availableCount, with no error', async () => {
    const ctx = ctxWithSubgraph({
      supportsInterface: [{ status: 'success', result: false }],
      inventory: () =>
        Promise.resolve({ data: { tokenIds: [] }, asOfBlock: 1n, lagSeconds: 0, stale: false, revalidating: false }),
    })
    const result = await poolInventory(ctx, PAIR)
    expect(result.tokenIds).toEqual([])
    expect(result.availableCount).toBe(11)
  })

  it('a null currency (unknown wrapper) is treated as an empty candidate list, not a thrown error', async () => {
    const ctx = ctxWithSubgraph({
      supportsInterface: [{ status: 'success', result: false }],
      inventory: () => Promise.resolve({ data: null, asOfBlock: 1n, lagSeconds: 0, stale: false, revalidating: false }),
    })
    const result = await poolInventory(ctx, PAIR)
    expect(result.tokenIds).toEqual([])
  })

  it('a subgraph list longer than availableCount reports BOTH numbers unmodified — never reconciled', async () => {
    const tokenIds = Array.from({ length: 15 }, (_u, i) => String(i))
    const ctx = ctxWithSubgraph({
      supportsInterface: [{ status: 'success', result: false }],
      inventory: () =>
        Promise.resolve({ data: { tokenIds }, asOfBlock: 1n, lagSeconds: 0, stale: false, revalidating: false }),
      reserveWnft: 6n * 10n ** 18n, // whole=6 → availableCount=5
    })
    const result = await poolInventory(ctx, PAIR)
    expect(result.tokenIds).toHaveLength(15)
    expect(result.availableCount).toBe(5)
  })

  it('sends the wrapper id to the subgraph fully lowercased', async () => {
    const inventorySpy = vi.fn(() =>
      Promise.resolve({ data: { tokenIds: [] }, asOfBlock: 1n, lagSeconds: 0, stale: false, revalidating: false }),
    )
    const ctx = fakeCtx({
      multicall: multicallByBatch({
        token0: token0Batch(true, RESERVE_12, RESERVE_BASE),
        collection: collectionBatch(true),
        supportsInterface: [{ status: 'success', result: false }],
      }),
      inventory: inventorySpy,
    })
    await poolInventory(ctx, PAIR)
    expect(inventorySpy).toHaveBeenCalledWith(WRAPPER.toLowerCase())
  })
})

describe('poolInventory — partner-supplied provider (R19)', () => {
  it('replaces both the enumerable and subgraph paths, normalizes its tokenIds, and NEVER raises the recomputed ceiling', async () => {
    const provided: PoolInventory = {
      tokenIds: ['30', '10', '10'],
      availableCount: 999, // a hostile provider trying to raise the ceiling
      asOfBlock: 77n,
      lagSeconds: 5,
      stale: false,
      source: 'provider',
      truncated: false,
      warnings: [],
    }
    const provider: PoolInventoryProvider = { getPoolInventory: vi.fn(() => Promise.resolve(provided)) }
    const ctx = fakeCtx({
      multicall: multicallByBatch({
        token0: token0Batch(true, RESERVE_12, RESERVE_BASE),
        collection: collectionBatch(true),
      }),
      poolInventoryProvider: provider,
    })

    const result = await poolInventory(ctx, PAIR)

    expect(result.source).toBe('provider')
    expect(result.tokenIds).toEqual(['10', '30']) // deduped + sorted
    expect(result.availableCount).toBe(11) // recomputed from the real reserve, not 999
    expect(ctx.transport.inventory).not.toHaveBeenCalled()
  })

  it('a provider that resolves undefined falls through to the SDK default paths', async () => {
    const provider: PoolInventoryProvider = { getPoolInventory: vi.fn(() => Promise.resolve(undefined)) }
    const ctx = fakeCtx({
      multicall: multicallByBatch({
        token0: token0Batch(true, RESERVE_12, RESERVE_BASE),
        collection: collectionBatch(true),
        supportsInterface: [{ status: 'success', result: true }],
        tokenOfOwnerByIndex: [{ status: 'success', result: 1n }],
      }),
      poolInventoryProvider: provider,
    })
    const result = await poolInventory(ctx, PAIR)
    expect(result.source).toBe('enumerable')
  })
})

describe('poolInventory — validation', () => {
  it('rejects a malformed pair address before any read', async () => {
    const ctx = fakeCtx({ multicall: multicallByBatch({}) })
    await expect(poolInventory(ctx, '0xnope' as `0x${string}`)).rejects.toSatisfy(
      (e: unknown) => isSnfError(e) && e.code === 'INVALID_PARAMS',
    )
  })

  it('rejects a pair where neither slot exposes WERC721.collection() — not an SnF NFT pool', async () => {
    const ctx = fakeCtx({
      multicall: multicallByBatch({
        token0: token0Batch(true, RESERVE_12, RESERVE_BASE),
        collection: [{ status: 'failure' }, { status: 'failure' }],
      }),
    })
    await expect(poolInventory(ctx, PAIR)).rejects.toSatisfy(
      (e: unknown) => isSnfError(e) && e.code === 'INVALID_PARAMS',
    )
  })
})
