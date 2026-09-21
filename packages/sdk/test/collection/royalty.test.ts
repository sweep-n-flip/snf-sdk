import type { PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { getChain } from '../../src/chains/registry'
import { resolveRoyalty } from '../../src/collection/royalty'
import type { SnfClientContext } from '../../src/types/client.types'

/**
 * `resolveRoyalty` — EIP-2981, the Router cap, per-token basis and the unpayable
 * receiver (REQ-SDK-10, R6; 54-SPEC.md). Every `<behavior>` bullet of plan 10's Task 2
 * is one `it` below. `royaltyInfo(id, 1e18)` results are canned as
 * `[receiver, royaltyAmount]` tuples so a bps rate is `amount * 10000n / 1e18n`.
 */

const BASE_CHAIN_ID = 8453
const ARC_CHAIN_ID = 5042
const COLLECTION = '0x00000000000000000000000000000000000c011' as `0x${string}`
const RECEIVER_A = '0x1111111111111111111111111111111111111a' as `0x${string}`
const RECEIVER_B = '0x2222222222222222222222222222222222222b' as `0x${string}`
const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`

type ReadResult = { status: 'success' | 'failure'; result?: unknown }

function fakeCtx(
  chainId: number,
  multicallImpl: (args: unknown) => Promise<ReadResult[]> | never,
): { ctx: SnfClientContext; multicall: ReturnType<typeof vi.fn> } {
  const multicall = vi.fn(multicallImpl)
  const ctx = {
    config: { chainId, publicClient: {} as PublicClient },
    chain: getChain(chainId),
    publicClient: { multicall } as unknown as PublicClient,
    providers: {},
    transport: {},
    nextTxInvalidationVersion: () => 1,
  } as unknown as SnfClientContext
  return { ctx, multicall }
}

/** `royaltyInfo` tuple for a flat percent rate at the 1e18 probe sale price. */
function royaltyAt(pct: number, receiver: `0x${string}` = RECEIVER_A): ReadResult {
  const amount = BigInt(Math.round(pct * 1e16))
  return { status: 'success', result: [receiver, amount] }
}

/** `royaltyFeeCap` raw value (1e18-scaled) for a given percent. */
function capAt(pct: number): ReadResult {
  return { status: 'success', result: BigInt(Math.round(pct * 1e16)) }
}

const NOT_SUPPORTED: ReadResult = { status: 'success', result: false }
const SUPPORTED: ReadResult = { status: 'success', result: true }
const NO_CAP_SET: ReadResult = capAt(100) // 100e16 = "no effective cap" sentinel some collections read as-is

describe('resolveRoyalty (R6)', () => {
  it('no ERC-165 / supportsInterface(0x2a55205a) === false ⇒ bps:0, receiver:null, collection-default, no throw', async () => {
    const { ctx } = fakeCtx(BASE_CHAIN_ID, () => Promise.resolve([NOT_SUPPORTED, NO_CAP_SET, royaltyAt(5)]))
    const result = await resolveRoyalty(ctx, COLLECTION)
    expect(result.bps).toBe(0)
    expect(result.receiver).toBeNull()
    expect(result.basis).toBe('collection-default')
    expect(result.probeFailed).toBe(false)
  })

  it('a flat 5% rate across sampled ids yields bps:500, the receiver, collection-default', async () => {
    const { ctx } = fakeCtx(BASE_CHAIN_ID, () =>
      Promise.resolve([SUPPORTED, NO_CAP_SET, royaltyAt(5), royaltyAt(5)]),
    )
    const result = await resolveRoyalty(ctx, COLLECTION, { sampleTokenIds: [1n, 2n] })
    expect(result.bps).toBe(500)
    expect(result.receiver).toBe(RECEIVER_A)
    expect(result.basis).toBe('collection-default')
  })

  it('sampled ids returning different rates yield basis: per-token with a warning', async () => {
    const { ctx } = fakeCtx(BASE_CHAIN_ID, () =>
      Promise.resolve([SUPPORTED, NO_CAP_SET, royaltyAt(5), royaltyAt(7.5)]),
    )
    const result = await resolveRoyalty(ctx, COLLECTION, { sampleTokenIds: [1n, 2n] })
    expect(result.basis).toBe('per-token')
    expect(result.warnings.some((w) => /per-token/i.test(w))).toBe(true)
  })

  it('royaltyFeeCap === 0 yields capBps:0, effectiveBpsWhenCapped:0, with a warning naming the capRoyaltyFee footgun', async () => {
    const { ctx } = fakeCtx(BASE_CHAIN_ID, () => Promise.resolve([SUPPORTED, capAt(0), royaltyAt(5)]))
    const result = await resolveRoyalty(ctx, COLLECTION)
    expect(result.capBps).toBe(0)
    expect(result.effectiveBpsWhenCapped).toBe(0)
    expect(result.warnings.some((w) => /capRoyaltyFee/.test(w))).toBe(true)
  })

  it('royaltyFeeCap === 2.5% with a 5% collection rate yields capBps:250, effectiveBpsWhenCapped:250', async () => {
    const { ctx } = fakeCtx(BASE_CHAIN_ID, () => Promise.resolve([SUPPORTED, capAt(2.5), royaltyAt(5)]))
    const result = await resolveRoyalty(ctx, COLLECTION)
    expect(result.capBps).toBe(250)
    expect(result.effectiveBpsWhenCapped).toBe(250)
  })

  it('a royaltyInfo revert for one sampled id is tolerated — the id is skipped, a warning is added, no throw', async () => {
    const { ctx } = fakeCtx(BASE_CHAIN_ID, () =>
      Promise.resolve([SUPPORTED, NO_CAP_SET, { status: 'failure' }, royaltyAt(5)]),
    )
    const result = await resolveRoyalty(ctx, COLLECTION, { sampleTokenIds: [1n, 2n] })
    expect(result.bps).toBe(500)
    expect(result.probeFailed).toBe(false)
    expect(result.warnings.some((w) => /reverted/i.test(w))).toBe(true)
  })

  it('every sampled id reverting despite supportsInterface=true is a genuine probeFailed, not "no royalty"', async () => {
    const { ctx } = fakeCtx(BASE_CHAIN_ID, () =>
      Promise.resolve([SUPPORTED, NO_CAP_SET, { status: 'failure' }, { status: 'failure' }]),
    )
    const result = await resolveRoyalty(ctx, COLLECTION, { sampleTokenIds: [1n, 2n] })
    expect(result.bps).toBe(0)
    expect(result.probeFailed).toBe(true)
  })

  it('a zero-address receiver yields unpayableReceiver: true', async () => {
    const { ctx } = fakeCtx(ARC_CHAIN_ID, () =>
      Promise.resolve([SUPPORTED, NO_CAP_SET, royaltyAt(5, ZERO_ADDRESS)]),
    )
    const result = await resolveRoyalty(ctx, COLLECTION)
    expect(result.unpayableReceiver).toBe(true)
  })

  it('a non-zero receiver on a wrapper chain is NOT unpayable', async () => {
    const { ctx } = fakeCtx(BASE_CHAIN_ID, () => Promise.resolve([SUPPORTED, NO_CAP_SET, royaltyAt(5, RECEIVER_B)]))
    const result = await resolveRoyalty(ctx, COLLECTION)
    expect(result.unpayableReceiver).toBe(false)
  })

  it('an RPC failure on the whole probe yields bps:0 with a warning AND probeFailed:true — distinguishable from "no royalty"', async () => {
    const { ctx } = fakeCtx(BASE_CHAIN_ID, () => Promise.reject(new Error('network down')))
    const result = await resolveRoyalty(ctx, COLLECTION)
    expect(result.bps).toBe(0)
    expect(result.probeFailed).toBe(true)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('every read goes through exactly ONE publicClient.multicall — not four', async () => {
    const { ctx, multicall } = fakeCtx(BASE_CHAIN_ID, () =>
      Promise.resolve([SUPPORTED, NO_CAP_SET, royaltyAt(5)]),
    )
    await resolveRoyalty(ctx, COLLECTION)
    expect(multicall).toHaveBeenCalledTimes(1)
  })

  it('an unreadable royaltyFeeCap fails safe to "no effective cap" (100%), never to a false cap-zero', async () => {
    const { ctx } = fakeCtx(BASE_CHAIN_ID, () =>
      Promise.resolve([SUPPORTED, { status: 'failure' }, royaltyAt(5)]),
    )
    const result = await resolveRoyalty(ctx, COLLECTION)
    expect(result.capBps).toBe(10_000)
    expect(result.effectiveBpsWhenCapped).toBe(500)
  })

  it('defaults to sampling tokenId 1 when no sampleTokenIds are supplied', async () => {
    const { ctx, multicall } = fakeCtx(BASE_CHAIN_ID, () =>
      Promise.resolve([SUPPORTED, NO_CAP_SET, royaltyAt(5)]),
    )
    await resolveRoyalty(ctx, COLLECTION)
    const callArgs = multicall.mock.calls[0]?.[0] as { contracts: readonly { functionName: string; args: readonly unknown[] }[] }
    const royaltyCall = callArgs.contracts.find((c) => c.functionName === 'royaltyInfo')
    expect(royaltyCall?.args[0]).toBe(1n)
  })
})
