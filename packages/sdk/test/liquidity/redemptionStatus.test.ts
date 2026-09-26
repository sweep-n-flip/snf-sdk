import type { PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { getChain } from '../../src/chains/registry'
import { probeRedemption, redemptionStatus } from '../../src/liquidity/redemptionStatus'
import type { SnfClientContext } from '../../src/types/client.types'
import type { PoolInventory } from '../../src/types/inventory.types'

/**
 * `probeRedemption`/`redemptionStatus` — a tri-state probe of what the wrapper
 * actually executes on release (`transferFrom`, never `safeTransferFrom`), sampled
 * without any third-party host: on-chain enumeration first, then the subgraph index,
 * then an optional partner-supplied inventory provider.
 */

const CHAIN_ID = 8453
const COLLECTION = '0x000000000000000000000000000000000000c011' as `0x${string}`
const WRAPPER = '0x000000000000000000000000000000000000bad1' as `0x${string}`
const PAIR = '0x000000000000000000000000000000000000fa17' as `0x${string}`
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD'

type ReadResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

interface FakeCtxOpts {
  readonly wrapper?: `0x${string}`
  readonly pair?: `0x${string}` | null
  readonly enumerable?: boolean
  readonly enumeratedIds?: readonly string[]
  readonly subgraphIds?: readonly string[] | null
  readonly subgraphThrows?: boolean
  readonly providerIds?: readonly string[]
  readonly withProvider?: boolean
  readonly providerThrows?: boolean
  readonly ownerOf?: Readonly<Record<string, `0x${string}`>>
  readonly simulate?: () => Promise<unknown>
  readonly getWrapperThrows?: boolean
  readonly supportsInterfaceThrows?: boolean
}

interface FakeCtx {
  readonly ctx: SnfClientContext
  readonly multicall: ReturnType<typeof vi.fn>
  readonly simulateContract: ReturnType<typeof vi.fn>
  readonly inventory: ReturnType<typeof vi.fn>
  readonly getPoolInventory: ReturnType<typeof vi.fn> | undefined
}

function fakeCtx(opts: FakeCtxOpts = {}): FakeCtx {
  const wrapper = opts.wrapper ?? WRAPPER
  const pair = opts.pair === undefined ? PAIR : opts.pair
  const enumerable = opts.enumerable ?? false
  const enumeratedIds = opts.enumeratedIds ?? []
  const ownerOf = opts.ownerOf ?? {}

  const multicall = vi.fn(
    async (params: {
      readonly contracts: readonly { readonly address: string; readonly functionName: string; readonly args?: readonly unknown[] }[]
    }): Promise<readonly ReadResult[]> => {
      return params.contracts.map((call): ReadResult => {
        switch (call.functionName) {
          case 'getWrapper':
            if (opts.getWrapperThrows) throw new Error('rpc down')
            return { status: 'success', result: wrapper }
          case 'getPair':
            return { status: 'success', result: pair ?? ZERO_ADDRESS }
          case 'supportsInterface':
            if (opts.supportsInterfaceThrows) throw new Error('rpc down')
            return { status: 'success', result: enumerable }
          case 'tokenOfOwnerByIndex': {
            const index = Number(call.args?.[1] ?? 0)
            const id = enumeratedIds[index]
            return id !== undefined ? { status: 'success', result: BigInt(id) } : { status: 'failure' }
          }
          case 'ownerOf': {
            const tokenId = String(call.args?.[0])
            const owner = ownerOf[tokenId]
            return owner ? { status: 'success', result: owner } : { status: 'failure' }
          }
          default:
            throw new Error(`fakeCtx: unmocked multicall call ${call.functionName}`)
        }
      })
    },
  )

  const simulateContract = vi.fn(opts.simulate ?? (() => Promise.resolve({ result: undefined })))
  const publicClient = { multicall, simulateContract } as unknown as PublicClient

  const inventory = vi.fn(async () => {
    if (opts.subgraphThrows) throw new Error('subgraph down')
    return {
      data:
        opts.subgraphIds && opts.subgraphIds.length > 0
          ? { id: wrapper, symbol: 'W', name: 'W', decimals: 18, wrapping: true, tokenIds: opts.subgraphIds }
          : null,
      asOfBlock: 1n,
      lagSeconds: 0,
      stale: false,
      revalidating: false,
    }
  })

  const withProvider = opts.withProvider ?? Boolean(opts.providerIds !== undefined || opts.providerThrows)
  const getPoolInventory = withProvider
    ? vi.fn(async (): Promise<PoolInventory | undefined> => {
        if (opts.providerThrows) throw new Error('provider down')
        return {
          tokenIds: opts.providerIds ?? [],
          availableCount: 0,
          asOfBlock: 1n,
          lagSeconds: 0,
          stale: false,
          source: 'provider',
          truncated: false,
          warnings: [],
        }
      })
    : undefined

  const ctx = {
    config: { chainId: CHAIN_ID, publicClient },
    chain: getChain(CHAIN_ID),
    publicClient,
    providers: getPoolInventory ? { poolInventory: { getPoolInventory } } : {},
    transport: {
      pools: vi.fn(),
      pairById: vi.fn(),
      inventory,
      meta: vi.fn(),
      clear: vi.fn(),
    },
    nextTxInvalidationVersion: () => 1,
  } as unknown as SnfClientContext

  return { ctx, multicall, simulateContract, inventory, getPoolInventory }
}

describe('probeRedemption', () => {
  it('a successful simulation ⇒ allowed, with the sample source and tokenId', async () => {
    const { ctx } = fakeCtx({ subgraphIds: ['1'], ownerOf: { '1': WRAPPER } })
    const result = await probeRedemption(ctx, { collection: COLLECTION, wrapper: WRAPPER, pair: PAIR })
    expect(result).toEqual({ status: 'allowed', source: 'subgraph', sampleTokenId: '1' })
  })

  it('simulates transferFrom(wrapper, dead, sampleId) with account: wrapper — never safeTransferFrom', async () => {
    const { ctx, simulateContract } = fakeCtx({ subgraphIds: ['7'], ownerOf: { '7': WRAPPER } })
    await probeRedemption(ctx, { collection: COLLECTION, wrapper: WRAPPER, pair: PAIR })
    expect(simulateContract).toHaveBeenCalledWith(
      expect.objectContaining({
        address: COLLECTION,
        functionName: 'transferFrom',
        args: [WRAPPER, DEAD_ADDRESS, 7n],
        account: WRAPPER,
      }),
    )
  })

  it('a revert matching the guard wording ⇒ blocked, with a reason ≤ 200 chars', async () => {
    const longMessage = `operator not allowed ${'x'.repeat(300)}`
    const { ctx } = fakeCtx({
      subgraphIds: ['1'],
      ownerOf: { '1': WRAPPER },
      simulate: () => Promise.reject({ shortMessage: longMessage }),
    })
    const result = await probeRedemption(ctx, { collection: COLLECTION, wrapper: WRAPPER, pair: PAIR })
    expect(result.status).toBe('blocked')
    expect(result.source).toBe('subgraph')
    expect(result.sampleTokenId).toBe('1')
    expect(result.reason).toBeDefined()
    expect((result.reason as string).length).toBeLessThanOrEqual(200)
  })

  it('an ambiguous revert ⇒ unknown, with a reason — never a silent blocked', async () => {
    const { ctx } = fakeCtx({
      subgraphIds: ['1'],
      ownerOf: { '1': WRAPPER },
      simulate: () => Promise.reject(new Error('execution reverted')),
    })
    const result = await probeRedemption(ctx, { collection: COLLECTION, wrapper: WRAPPER, pair: PAIR })
    expect(result.status).toBe('unknown')
    expect(result.reason).toBeDefined()
  })

  it('simulateContract throwing a network error (no message at all) ⇒ unknown, never a throw', async () => {
    const { ctx } = fakeCtx({
      subgraphIds: ['1'],
      ownerOf: { '1': WRAPPER },
      simulate: () => Promise.reject('a bare string rejection'),
    })
    const result = await probeRedemption(ctx, { collection: COLLECTION, wrapper: WRAPPER, pair: PAIR })
    expect(result.status).toBe('unknown')
    expect(result.reason).toBeDefined()
  })

  it('an enumerable collection with a wrapper-held id ⇒ source enumerable, no subgraph/provider call', async () => {
    const { ctx, inventory, getPoolInventory } = fakeCtx({
      enumerable: true,
      enumeratedIds: ['3'],
      ownerOf: { '3': WRAPPER },
      providerIds: ['9'],
    })
    const result = await probeRedemption(ctx, { collection: COLLECTION, wrapper: WRAPPER, pair: PAIR })
    expect(result.status).toBe('allowed')
    expect(result.source).toBe('enumerable')
    expect(result.sampleTokenId).toBe('3')
    expect(inventory).not.toHaveBeenCalled()
    expect(getPoolInventory).not.toHaveBeenCalled()
  })

  it('not enumerable, subgraph returns no ids ⇒ falls to the partner provider (source provider)', async () => {
    const { ctx } = fakeCtx({ subgraphIds: null, providerIds: ['42'], ownerOf: { '42': WRAPPER } })
    const result = await probeRedemption(ctx, { collection: COLLECTION, wrapper: WRAPPER, pair: PAIR })
    expect(result.status).toBe('allowed')
    expect(result.source).toBe('provider')
    expect(result.sampleTokenId).toBe('42')
  })

  it('subgraph throws ⇒ falls to the partner provider', async () => {
    const { ctx } = fakeCtx({ subgraphThrows: true, providerIds: ['5'], ownerOf: { '5': WRAPPER } })
    const result = await probeRedemption(ctx, { collection: COLLECTION, wrapper: WRAPPER, pair: PAIR })
    expect(result.source).toBe('provider')
    expect(result.sampleTokenId).toBe('5')
  })

  it('no provider and no pair ⇒ unknown, source none — never a silent allowed', async () => {
    const { ctx } = fakeCtx({ subgraphIds: null })
    const result = await probeRedemption(ctx, { collection: COLLECTION, wrapper: WRAPPER, pair: null })
    expect(result).toEqual({ status: 'unknown', source: 'none', reason: expect.any(String) })
  })

  it('a stale subgraph candidate (ownerOf disagrees) is skipped and the provider is tried next', async () => {
    const { ctx } = fakeCtx({
      subgraphIds: ['1'],
      ownerOf: { '2': WRAPPER },
      providerIds: ['2'],
    })
    const result = await probeRedemption(ctx, { collection: COLLECTION, wrapper: WRAPPER, pair: PAIR })
    expect(result.status).toBe('allowed')
    expect(result.source).toBe('provider')
    expect(result.sampleTokenId).toBe('2')
  })

  it('every candidate stale ⇒ unknown, source none', async () => {
    const { ctx } = fakeCtx({ subgraphIds: ['1'], providerIds: ['2'], ownerOf: {} })
    const result = await probeRedemption(ctx, { collection: COLLECTION, wrapper: WRAPPER, pair: PAIR })
    expect(result).toEqual({ status: 'unknown', source: 'none', reason: expect.any(String) })
  })

  it('a wrapper of the zero address ⇒ unknown, source none, and never calls the RPC', async () => {
    const { ctx, multicall, simulateContract } = fakeCtx()
    const result = await probeRedemption(ctx, { collection: COLLECTION, wrapper: ZERO_ADDRESS, pair: null })
    expect(result.status).toBe('unknown')
    expect(result.source).toBe('none')
    expect(multicall).not.toHaveBeenCalled()
    expect(simulateContract).not.toHaveBeenCalled()
  })
})

describe('redemptionStatus', () => {
  it('a malformed address ⇒ INVALID_PARAMS', async () => {
    const { ctx } = fakeCtx()
    await expect(redemptionStatus(ctx, '0x123' as `0x${string}`)).rejects.toMatchObject({ code: 'INVALID_PARAMS' })
  })

  it('a collection with no wrapper ⇒ unknown, source none', async () => {
    const { ctx } = fakeCtx({ wrapper: ZERO_ADDRESS })
    const result = await redemptionStatus(ctx, COLLECTION)
    expect(result).toEqual({ status: 'unknown', source: 'none', reason: expect.any(String) })
  })

  it('delegates to probeRedemption once a wrapper and pair are resolved', async () => {
    const { ctx } = fakeCtx({ subgraphIds: ['1'], ownerOf: { '1': WRAPPER } })
    const result = await redemptionStatus(ctx, COLLECTION)
    expect(result).toEqual({ status: 'allowed', source: 'subgraph', sampleTokenId: '1' })
  })

  it('a getWrapper RPC failure ⇒ unknown, never a throw, for a well-formed address', async () => {
    const { ctx } = fakeCtx({ getWrapperThrows: true })
    await expect(redemptionStatus(ctx, COLLECTION)).resolves.toMatchObject({ status: 'unknown', source: 'none' })
  })

  it('a getPair failure does not prevent the probe — the pair source is simply unavailable', async () => {
    const { ctx } = fakeCtx({ subgraphIds: null, withProvider: false })
    const result = await redemptionStatus(ctx, COLLECTION)
    expect(result.status).toBe('unknown')
    expect(result.source).toBe('none')
  })
})
