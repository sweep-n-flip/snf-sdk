import type { PublicClient } from 'viem'
import { getAddress } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { getChain } from '../../src/chains/registry'
import { rankPoolsByLiquidity } from '../../src/collection/rankPools'
import { resolveCollection } from '../../src/collection/resolveCollection'
import type { SnfClientContext } from '../../src/types/client.types'
import type { PoolRef } from '../../src/types/collection.types'
import arcArctFixture from '../fixtures/collections/arc-arct.json'
import baseDemonFixture from '../fixtures/collections/base-demon.json'

/**
 * `resolveCollection` — on-chain discovery, subgraph enrichment, `wrapperVerified`,
 * `redemptionLocked` (REQ-SDK-10, R6; 54-SPEC.md). Every `<behavior>` bullet of plan
 * 10's Task 3 is one `it` below. The two SPEC fixtures (Base DEMON, Arc ARCT) drive
 * the end-to-end cases.
 */

const BASE_CHAIN_ID = 8453
const ARC_CHAIN_ID = 5042
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`
const COLLECTION = '0x000000000000000000000000000000000000c011' as `0x${string}`
const WRAPPER = '0x000000000000000000000000000000000000bad1' as `0x${string}`

type ReadResult = { status: 'success' | 'failure'; result?: unknown }
type EmptyPools = { data: readonly never[]; asOfBlock: bigint; lagSeconds: number; stale: boolean; revalidating: boolean }

const NO_ROYALTY = (): ReadResult[] => [
  { status: 'success', result: false },
  { status: 'success', result: 100n * 10n ** 16n },
  { status: 'failure' },
]
const NO_ENRICHMENT: EmptyPools = { data: [], asOfBlock: 1n, lagSeconds: 0, stale: false, revalidating: false }

/** Dispatches a canned multicall response keyed by the batch's first `functionName`
 * ('getWrapper'=A, 'supportsInterface'=royalty, 'collection'=B, 'getReserves'=C). */
function multicallByBatch(byFunction: Record<string, ReadResult[]>) {
  return (args: { contracts: readonly { functionName: string }[] }) => {
    const key = args.contracts[0]?.functionName ?? ''
    const result = byFunction[key]
    if (!result) throw new Error(`unexpected multicall batch starting with ${key}`)
    return Promise.resolve(result)
  }
}

function fakeCtx(
  chainId: number,
  opts: {
    multicall: ReturnType<typeof multicallByBatch>
    pools?: () => Promise<unknown>
    pairById?: () => Promise<unknown>
    inventory?: () => Promise<unknown>
    simulateContract?: () => Promise<unknown>
  },
): SnfClientContext {
  const publicClient = {
    multicall: vi.fn(opts.multicall),
    simulateContract: vi.fn(opts.simulateContract ?? (() => Promise.reject(new Error('not owner')))),
  } as unknown as PublicClient
  return {
    config: { chainId, publicClient },
    chain: getChain(chainId),
    publicClient,
    providers: {},
    transport: {
      pools: vi.fn(opts.pools ?? (() => Promise.resolve(NO_ENRICHMENT))),
      pairById: vi.fn(opts.pairById ?? (() => Promise.resolve({ data: null, asOfBlock: 1n, lagSeconds: 0, stale: false, revalidating: false }))),
      inventory: vi.fn(opts.inventory ?? (() => Promise.resolve({ data: null, asOfBlock: 1n, lagSeconds: 0, stale: false, revalidating: false }))),
      meta: vi.fn(),
      clear: vi.fn(),
    },
    nextTxInvalidationVersion: () => 1,
  } as unknown as SnfClientContext
}

describe('resolveCollection (R6)', () => {
  it('a collection with a wrapper and one native pair: pools.length===1, baseToken.isNative, real wrapperIsToken0', async () => {
    const chain = getChain(BASE_CHAIN_ID)
    const reserveNative = 1_000_000_000_000_000_000n
    const reserveWnft = 5_000_000_000_000_000_000n
    const ctx = fakeCtx(BASE_CHAIN_ID, {
      multicall: multicallByBatch({
        getWrapper: [
          { status: 'success', result: WRAPPER },
          { status: 'success', result: 'On-chain Name' },
          { status: 'success', result: 'OCN' },
        ],
        collection: [
          { status: 'success', result: COLLECTION },
          { status: 'success', result: '0xPAIR0000000000000000000000000000000001' },
        ],
        // token0 = WRAPPER (wrapper is token0) — reserve0 is the wnft side.
        getReserves: [
          { status: 'success', result: [reserveWnft, reserveNative, 0] },
          { status: 'success', result: WRAPPER },
          { status: 'success', result: chain.quoteToken },
        ],
        supportsInterface: NO_ROYALTY(),
      }),
    })

    const result = await resolveCollection(ctx, COLLECTION)
    expect(result.pools).toHaveLength(1)
    expect(result.pools[0]?.baseToken.isNative).toBe(true)
    expect(result.pools[0]?.wrapperIsToken0).toBe(true)
    expect(result.pools[0]?.reserves.base).toBe(reserveNative)
    expect(result.pools[0]?.reserves.wnft).toBe(reserveWnft)
  })

  it('a collection with a native pool AND a USDC pool: pools.length===2 with two distinct baseToken addresses', async () => {
    const chain = getChain(BASE_CHAIN_ID)
    const usdc = '0x0000000000000000000000000000000000005dc0' as `0x${string}`
    const nativePair = '0x0000000000000000000000000000000000001111' as `0x${string}`
    const usdcPair = '0x0000000000000000000000000000000000002222' as `0x${string}`
    const ctx = fakeCtx(BASE_CHAIN_ID, {
      pools: () =>
        Promise.resolve({
          data: [
            {
              id: usdcPair,
              token0: { id: WRAPPER, collection: { name: 'Real Name', symbol: 'RN' } },
              token1: { id: usdc, collection: null },
            },
          ],
          asOfBlock: 1n,
          lagSeconds: 0,
          stale: false,
          revalidating: false,
        }),
      multicall: multicallByBatch({
        getWrapper: [
          { status: 'success', result: WRAPPER },
          { status: 'success', result: 'On-chain Name' },
          { status: 'success', result: 'OCN' },
        ],
        collection: [
          { status: 'success', result: COLLECTION },
          { status: 'success', result: nativePair },
          { status: 'success', result: usdcPair },
        ],
        getReserves: [
          // native pair: token0=quoteToken, token1=WRAPPER
          { status: 'success', result: [2_000_000_000_000_000_000n, 3_000_000_000_000_000_000n, 0] },
          { status: 'success', result: chain.quoteToken },
          { status: 'success', result: WRAPPER },
          // usdc pair: token0=WRAPPER, token1=usdc
          { status: 'success', result: [7_000_000_000n, 9_000_000n, 0] },
          { status: 'success', result: WRAPPER },
          { status: 'success', result: usdc },
          // usdc symbol/decimals
          { status: 'success', result: 'USDC' },
          { status: 'success', result: 6 },
        ],
        supportsInterface: NO_ROYALTY(),
      }),
    })

    const result = await resolveCollection(ctx, COLLECTION)
    expect(result.pools).toHaveLength(2)
    const addresses = new Set(result.pools.map((p) => p.baseToken.address))
    expect(addresses.size).toBe(2)
    expect(addresses.has(chain.quoteToken)).toBe(true)
    expect(addresses.has(getAddress(usdc))).toBe(true)
  })

  it('a collection with no wrapper (getWrapper returns the zero address): pools:[], no throw, labels resolve on-chain', async () => {
    const ctx = fakeCtx(BASE_CHAIN_ID, {
      multicall: multicallByBatch({
        getWrapper: [
          { status: 'success', result: ZERO_ADDRESS },
          { status: 'success', result: 'Nameless Collection' },
          { status: 'success', result: 'NAMELESS' },
        ],
        supportsInterface: NO_ROYALTY(),
      }),
    })

    const result = await resolveCollection(ctx, COLLECTION)
    expect(result.pools).toEqual([])
    expect(result.wrapper).toBe(ZERO_ADDRESS)
    expect(result.labels.name).toBe('Nameless Collection')
    expect(result.wrapperVerified).toBe('unknown')
  })

  it("WERC721.collection() === address ⇒ 'match'", async () => {
    const ctx = fakeCtx(BASE_CHAIN_ID, {
      multicall: multicallByBatch({
        getWrapper: [{ status: 'success', result: WRAPPER }, { status: 'success', result: 'N' }, { status: 'success', result: 'S' }],
        collection: [{ status: 'success', result: COLLECTION }, { status: 'success', result: ZERO_ADDRESS }],
        supportsInterface: NO_ROYALTY(),
      }),
    })
    const result = await resolveCollection(ctx, COLLECTION)
    expect(result.wrapperVerified).toBe('match')
  })

  it("a different WERC721.collection() ⇒ 'mismatch'", async () => {
    const other = '0x000000000000000000000000000000000000dead' as `0x${string}`
    const ctx = fakeCtx(BASE_CHAIN_ID, {
      multicall: multicallByBatch({
        getWrapper: [{ status: 'success', result: WRAPPER }, { status: 'success', result: 'N' }, { status: 'success', result: 'S' }],
        collection: [{ status: 'success', result: other }, { status: 'success', result: ZERO_ADDRESS }],
        supportsInterface: NO_ROYALTY(),
      }),
    })
    const result = await resolveCollection(ctx, COLLECTION)
    expect(result.wrapperVerified).toBe('mismatch')
  })

  it("a reverting WERC721.collection() read ⇒ 'unknown', never a silent 'match'", async () => {
    const ctx = fakeCtx(BASE_CHAIN_ID, {
      multicall: multicallByBatch({
        getWrapper: [{ status: 'success', result: WRAPPER }, { status: 'success', result: 'N' }, { status: 'success', result: 'S' }],
        collection: [{ status: 'failure' }, { status: 'success', result: ZERO_ADDRESS }],
        supportsInterface: NO_ROYALTY(),
      }),
    })
    const result = await resolveCollection(ctx, COLLECTION)
    expect(result.wrapperVerified).toBe('unknown')
  })

  it('a subgraph that throws on pools() still returns the native pool — discovery is on-chain, never gated by the index', async () => {
    const chain = getChain(BASE_CHAIN_ID)
    const pair = '0x000000000000000000000000000000000000a001' as `0x${string}`
    const ctx = fakeCtx(BASE_CHAIN_ID, {
      pools: () => Promise.reject(new Error('subgraph degraded')),
      multicall: multicallByBatch({
        getWrapper: [{ status: 'success', result: WRAPPER }, { status: 'success', result: 'N' }, { status: 'success', result: 'S' }],
        collection: [{ status: 'success', result: COLLECTION }, { status: 'success', result: pair }],
        getReserves: [
          { status: 'success', result: [1n, 2n, 0] },
          { status: 'success', result: chain.quoteToken },
          { status: 'success', result: WRAPPER },
        ],
        supportsInterface: NO_ROYALTY(),
      }),
    })
    const result = await resolveCollection(ctx, COLLECTION)
    expect(result.pools.length).toBeGreaterThan(0)
  })

  it('a lowercase input address resolves the same collection with checksummed output', async () => {
    const ctx = fakeCtx(BASE_CHAIN_ID, {
      multicall: multicallByBatch({
        getWrapper: [{ status: 'success', result: ZERO_ADDRESS }, { status: 'success', result: 'N' }, { status: 'success', result: 'S' }],
        supportsInterface: NO_ROYALTY(),
      }),
    })
    const result = await resolveCollection(ctx, COLLECTION.toLowerCase() as `0x${string}`)
    expect(result.address).toBe(getAddress(COLLECTION))
  })

  it('redemptionLocked: a confirmed transfer-guard revert wording ⇒ true', async () => {
    const ctx = fakeCtx(BASE_CHAIN_ID, {
      multicall: multicallByBatch({
        getWrapper: [{ status: 'success', result: WRAPPER }, { status: 'success', result: 'N' }, { status: 'success', result: 'S' }],
        collection: [{ status: 'success', result: COLLECTION }, { status: 'success', result: ZERO_ADDRESS }],
        supportsInterface: NO_ROYALTY(),
      }),
      inventory: () => Promise.resolve({ data: { id: WRAPPER, symbol: 'W', name: 'W', decimals: 18, wrapping: true, tokenIds: ['1'] }, asOfBlock: 1n, lagSeconds: 0, stale: false, revalidating: false }),
      simulateContract: () => Promise.reject({ shortMessage: 'operator not allowed' }),
    })
    const result = await resolveCollection(ctx, COLLECTION)
    expect(result.redemptionLocked).toBe(true)
  })

  it('redemptionLocked: a successful simulation ⇒ false', async () => {
    const ctx = fakeCtx(BASE_CHAIN_ID, {
      multicall: multicallByBatch({
        getWrapper: [{ status: 'success', result: WRAPPER }, { status: 'success', result: 'N' }, { status: 'success', result: 'S' }],
        collection: [{ status: 'success', result: COLLECTION }, { status: 'success', result: ZERO_ADDRESS }],
        supportsInterface: NO_ROYALTY(),
      }),
      inventory: () => Promise.resolve({ data: { id: WRAPPER, symbol: 'W', name: 'W', decimals: 18, wrapping: true, tokenIds: ['1'] }, asOfBlock: 1n, lagSeconds: 0, stale: false, revalidating: false }),
      simulateContract: () => Promise.resolve({ result: undefined, request: {} }),
    })
    const result = await resolveCollection(ctx, COLLECTION)
    expect(result.redemptionLocked).toBe(false)
  })

  it('redemptionLocked: an inconclusive RPC error (no sample tokenId available) ⇒ false, never a silent true', async () => {
    const ctx = fakeCtx(BASE_CHAIN_ID, {
      multicall: multicallByBatch({
        getWrapper: [{ status: 'success', result: WRAPPER }, { status: 'success', result: 'N' }, { status: 'success', result: 'S' }],
        collection: [{ status: 'success', result: COLLECTION }, { status: 'success', result: ZERO_ADDRESS }],
        supportsInterface: NO_ROYALTY(),
      }),
      inventory: () => Promise.reject(new Error('subgraph down')),
    })
    const result = await resolveCollection(ctx, COLLECTION)
    expect(result.redemptionLocked).toBe(false)
  })

  describe('Base DEMON fixture (RESEARCH Open Question #2, closed)', () => {
    const fixture = baseDemonFixture
    const pair = getAddress(fixture.pair) as `0x${string}`
    const wrapper = getAddress(fixture.wrapper) as `0x${string}`
    const collection = getAddress(fixture.collection) as `0x${string}`
    const chain = getChain(fixture.chainId)

    it('resolves the collection address from the pair (never a hardcoded abbreviation) with a real native pool', async () => {
      const ctx = fakeCtx(fixture.chainId, {
        multicall: multicallByBatch({
          getWrapper: [
            { status: 'success', result: wrapper },
            { status: 'success', result: fixture.collectionName },
            { status: 'success', result: fixture.collectionSymbol },
          ],
          collection: [{ status: 'success', result: collection }, { status: 'success', result: pair }],
          getReserves: [
            { status: 'success', result: [BigInt(fixture.reserves.eth), BigInt(fixture.reserves.wnft), 0] },
            { status: 'success', result: chain.quoteToken },
            { status: 'success', result: wrapper },
          ],
          supportsInterface: NO_ROYALTY(),
        }),
      })
      const result = await resolveCollection(ctx, collection)
      expect(result.address).toBe(collection)
      expect(result.wrapper).toBe(wrapper)
      expect(result.pools).toHaveLength(1)
      expect(result.pools[0]?.pair).toBe(pair)
      expect(result.labels.name).toBe(fixture.collectionName)
      expect(result.wrapperVerified).toBe('match')
    })
  })

  describe('Arc ARCT fixture', () => {
    const fixture = arcArctFixture
    const pair = getAddress(fixture.pair) as `0x${string}`
    const wrapper = getAddress(fixture.wrapper) as `0x${string}`
    const collection = getAddress(fixture.collection) as `0x${string}`
    const chain = getChain(fixture.chainId)

    it('resolves with baseToken = the USDC predeploy, decimals === 6, wrapperVerified === match', async () => {
      expect(chain.quoteDecimals).toBe(6)
      const ctx = fakeCtx(ARC_CHAIN_ID, {
        multicall: multicallByBatch({
          getWrapper: [{ status: 'success', result: wrapper }, { status: 'success', result: 'N' }, { status: 'success', result: 'S' }],
          collection: [{ status: 'success', result: collection }, { status: 'success', result: pair }],
          getReserves: [
            { status: 'success', result: [BigInt(fixture.reserves.usdc6), BigInt(fixture.reserves.wnft18), 0] },
            { status: 'success', result: chain.quoteToken },
            { status: 'success', result: wrapper },
          ],
          supportsInterface: NO_ROYALTY(),
        }),
      })
      const result = await resolveCollection(ctx, collection)
      expect(result.pools).toHaveLength(1)
      expect(result.pools[0]?.baseToken.address).toBe(chain.quoteToken)
      expect(result.pools[0]?.baseToken.decimals).toBe(6)
      expect(result.wrapperVerified).toBe('match')
    })
  })
})

describe('rankPoolsByLiquidity (R6 Edge ordering)', () => {
  const nativeToken = { address: '0x1' as `0x${string}`, symbol: 'ETH', decimals: 18, isNative: true }
  const usdcToken = { address: '0x2' as `0x${string}`, symbol: 'USDC', decimals: 6, isNative: false }

  function pool(pair: string, base: typeof nativeToken, baseReserve: bigint): PoolRef {
    return {
      pair: pair as `0x${string}`,
      baseToken: base,
      isNative: base.isNative,
      reserves: { base: baseReserve, wnft: 1n },
      wrapperIsToken0: false,
    }
  }

  it('orders by liquidity descending using normalized reserves when no reserveUSD is supplied', () => {
    const small = pool('0xa', nativeToken, 1_000_000_000_000_000_000n)
    const large = pool('0xb', usdcToken, 5_000_000n) // 5 USDC, normalized to 18dec = 5e18 > 1e18
    const ranked = rankPoolsByLiquidity([small, large])
    expect(ranked[0]?.pair).toBe('0xb')
  })

  it('native pool wins a tie', () => {
    const native = pool('0xa', nativeToken, 1_000_000_000_000_000_000n)
    const erc20 = pool('0xb', { ...usdcToken, decimals: 18 }, 1_000_000_000_000_000_000n)
    const ranked = rankPoolsByLiquidity([erc20, native])
    expect(ranked[0]?.pair).toBe('0xa')
  })

  it('uses reserveUSD when every pool has an entry', () => {
    const a = pool('0xa', nativeToken, 1n)
    const b = pool('0xb', nativeToken, 999_999_999n)
    const usd = new Map([
      ['0xa', 500],
      ['0xb', 10],
    ])
    const ranked = rankPoolsByLiquidity([a, b], usd)
    expect(ranked[0]?.pair).toBe('0xa')
  })
})
