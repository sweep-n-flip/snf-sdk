import { getAddress } from 'viem'

import { ERC721_ABI } from '../abis/ERC721'
import { FACTORY_ABI } from '../abis/UniswapV2Factory'
import { assertParam } from '../errors'
import { ERC721_ENUMERABLE_INTERFACE_ID, readEnumerableTokenIds } from '../inventory/enumerable'
import type { SnfClientContext } from '../types/client.types'
import type { RedemptionStatus } from '../types/liquidity.types'

/**
 * A tri-state probe of whether a collection's wrapper currently lets NFTs redeem
 * out. `WERC721._burn` releases a wrapped NFT with plain `transferFrom(wrapper, to,
 * id)` — a *different*, non-"safe" ERC-721 transfer function — so that is the exact
 * call simulated here; a probe built around the wrong function reads a guard on one
 * path and misses it on the other entirely.
 *
 * Three states, never a plain boolean: an ambiguous or unreadable result must never
 * disable a working buy/withdrawal (a false `'blocked'`) nor hide a real one (a false
 * `'allowed'`) — `'unknown'` is the honest middle answer either way. The sample
 * tokenId is confirmed against `ownerOf` before it is probed (a stale index entry
 * would otherwise revert for a reason unrelated to any guard), and is sourced without
 * any third-party host: on-chain enumeration first, then the subgraph index, then an
 * optional partner-supplied inventory provider.
 *
 * None of this replaces the real safety net — a build-time gas estimate of the actual
 * remove/buy call still re-throws a genuine on-chain revert before any signature is
 * ever requested.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000' as `0x${string}`
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const
const REASON_MAX_LENGTH = 200

/** Guard-wording matches — the same regex the production app's own redemption check
 * uses, so both classify a given collection the same way. */
const BLOCKED_WORDING =
  /transfer[\s\-_]?role|operator (?:not allowed|denied|filter|blocked)|transfer (?:not allowed|denied|blocked|forbidden)|denyl?ist/i

/** `transferFrom` is what `WERC721._burn` actually calls to release a wrapped NFT —
 * a different, non-"safe" transfer, and not a function `ERC721_ABI` carries (that
 * shared ABI is read-only plus `setApprovalForAll`; it stays as audited rather than
 * growing a write function only this one probe needs). A local, single-function ABI
 * fragment mirrors the precedent this probe replaces (the previous fragment covered
 * the "safe" variant only). */
const TRANSFER_FROM_PROBE_ABI = [
  {
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    name: 'transferFrom',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

type CallResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

function isZero(addr: string): boolean {
  return addr.toLowerCase() === ZERO_ADDRESS
}

function shortMessageOf(e: unknown): string {
  const withMessages = e as { readonly shortMessage?: unknown; readonly message?: unknown } | undefined
  const raw = withMessages?.shortMessage ?? withMessages?.message ?? ''
  return typeof raw === 'string' ? raw : ''
}

/** Confirms a candidate id is actually held by the wrapper right now — a stale index
 * entry would otherwise revert `transferFrom` for a reason unrelated to any transfer
 * guard, which would misread the result. Any failure to read `ownerOf` is treated as
 * "not confirmed", never as "confirmed" — the candidate is simply skipped. */
async function ownerIsWrapper(
  ctx: SnfClientContext,
  collection: `0x${string}`,
  wrapper: `0x${string}`,
  tokenId: string,
): Promise<boolean> {
  try {
    const results = (await ctx.publicClient.multicall({
      contracts: [{ address: collection, abi: ERC721_ABI, functionName: 'ownerOf', args: [BigInt(tokenId)] }],
      allowFailure: true,
      multicallAddress: ctx.chain.multicall3,
      batchSize: 0,
    })) as readonly CallResult[]
    const result = results[0]
    return (
      result?.status === 'success' && typeof result.result === 'string' && result.result.toLowerCase() === wrapper.toLowerCase()
    )
  } catch {
    return false
  }
}

interface ProbeArgs {
  readonly collection: `0x${string}`
  readonly wrapper: `0x${string}`
  /** The collection's first native-base pair, when known — used only as the
   * lowest-priority candidate source (a partner-supplied inventory provider keys off
   * a pair, not a collection). */
  readonly pair: `0x${string}` | null
}

interface Candidate {
  readonly tokenId: string
  readonly source: RedemptionStatus['source']
}

/** On-chain enumeration → subgraph index → partner pool-inventory provider, in that
 * order. Each source's own failure — or its candidate turning out stale — just falls
 * through to the next source; it never aborts the whole probe. */
async function sampleCandidate(ctx: SnfClientContext, args: ProbeArgs): Promise<Candidate | undefined> {
  const { collection, wrapper, pair } = args

  try {
    const supportsResults = (await ctx.publicClient.multicall({
      contracts: [
        { address: collection, abi: ERC721_ABI, functionName: 'supportsInterface', args: [ERC721_ENUMERABLE_INTERFACE_ID] },
      ],
      allowFailure: true,
      multicallAddress: ctx.chain.multicall3,
      batchSize: 0,
    })) as readonly CallResult[]
    if (supportsResults[0]?.status === 'success' && supportsResults[0].result === true) {
      const enumerated = await readEnumerableTokenIds(ctx, { collection, holder: wrapper, balance: 1 })
      const candidate = enumerated.tokenIds[0]
      if (candidate !== undefined && (await ownerIsWrapper(ctx, collection, wrapper, candidate))) {
        return { tokenId: candidate, source: 'enumerable' }
      }
    }
  } catch {
    // Enumeration is a fast path, never a hard requirement — fall through to the
    // index.
  }

  try {
    const { data } = await ctx.transport.inventory(wrapper.toLowerCase() as `0x${string}`)
    const candidate = data?.tokenIds[0]
    if (candidate !== undefined && (await ownerIsWrapper(ctx, collection, wrapper, candidate))) {
      return { tokenId: candidate, source: 'subgraph' }
    }
  } catch {
    // The subgraph index is best-effort — fall through to the partner provider.
  }

  if (pair !== null) {
    try {
      const inventory = await ctx.providers.poolInventory?.getPoolInventory(pair, ctx.chain.chainId)
      const candidate = inventory?.tokenIds[0]
      if (candidate !== undefined && (await ownerIsWrapper(ctx, collection, wrapper, candidate))) {
        return { tokenId: candidate, source: 'provider' }
      }
    } catch {
      // An optional partner provider is never load-bearing.
    }
  }

  return undefined
}

/**
 * The probe itself, given an already-resolved wrapper (and, when known, the
 * collection's first native-base pair). Exported so `collection/resolveCollection.ts`
 * reuses this exact logic rather than keeping a second copy.
 */
export async function probeRedemption(ctx: SnfClientContext, args: ProbeArgs): Promise<RedemptionStatus> {
  const { collection, wrapper } = args
  if (isZero(wrapper)) {
    return { status: 'unknown', source: 'none', reason: 'This collection has no wrapper deployed yet.' }
  }

  const candidate = await sampleCandidate(ctx, args)
  if (candidate === undefined) {
    return {
      status: 'unknown',
      source: 'none',
      reason: 'No sample tokenId could be confirmed as currently held by the wrapper.',
    }
  }

  try {
    await ctx.publicClient.simulateContract({
      address: collection,
      abi: TRANSFER_FROM_PROBE_ABI,
      functionName: 'transferFrom',
      args: [wrapper, DEAD_ADDRESS, BigInt(candidate.tokenId)],
      account: wrapper,
    })
    return { status: 'allowed', source: candidate.source, sampleTokenId: candidate.tokenId }
  } catch (e) {
    const msg = shortMessageOf(e)
    const reason = msg.slice(0, REASON_MAX_LENGTH) || 'The simulation reverted for an unrecognised reason.'
    if (BLOCKED_WORDING.test(msg)) {
      return { status: 'blocked', source: candidate.source, sampleTokenId: candidate.tokenId, reason }
    }
    return { status: 'unknown', source: candidate.source, sampleTokenId: candidate.tokenId, reason }
  }
}

/**
 * Public entry point — resolves the collection's wrapper, and best-effort its
 * native-base pair, before delegating to `probeRedemption`. Never throws for a
 * well-formed address, whatever the RPC does: a lookup failure at any stage resolves
 * to `'unknown'`, the same honest answer an ambiguous on-chain result would give.
 */
export async function redemptionStatus(ctx: SnfClientContext, collectionAddress: `0x${string}`): Promise<RedemptionStatus> {
  assertParam(/^0x[0-9a-fA-F]{40}$/.test(collectionAddress), 'redemptionStatus requires a well-formed 0x address', {
    field: 'collection',
  })
  const collection = getAddress(collectionAddress)

  let wrapper: `0x${string}` = ZERO_ADDRESS
  try {
    const wrapperResults = (await ctx.publicClient.multicall({
      contracts: [{ address: ctx.chain.factory, abi: FACTORY_ABI, functionName: 'getWrapper', args: [collection] }],
      allowFailure: true,
      multicallAddress: ctx.chain.multicall3,
      batchSize: 0,
    })) as readonly CallResult[]
    const wrapperResult = wrapperResults[0]
    wrapper = wrapperResult?.status === 'success' ? (wrapperResult.result as `0x${string}`) : ZERO_ADDRESS
  } catch {
    return { status: 'unknown', source: 'none', reason: 'The wrapper lookup could not be read.' }
  }

  if (isZero(wrapper)) {
    return { status: 'unknown', source: 'none', reason: 'This collection has no wrapper deployed yet.' }
  }

  let pair: `0x${string}` | null = null
  try {
    const pairResults = (await ctx.publicClient.multicall({
      contracts: [{ address: ctx.chain.factory, abi: FACTORY_ABI, functionName: 'getPair', args: [wrapper, ctx.chain.quoteToken] }],
      allowFailure: true,
      multicallAddress: ctx.chain.multicall3,
      batchSize: 0,
    })) as readonly CallResult[]
    const pairResult = pairResults[0]
    const candidatePair = pairResult?.status === 'success' ? (pairResult.result as `0x${string}`) : ZERO_ADDRESS
    pair = isZero(candidatePair) ? null : candidatePair
  } catch {
    pair = null
  }

  return probeRedemption(ctx, { collection, wrapper, pair })
}
