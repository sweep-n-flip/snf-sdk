import { getAddress } from 'viem'
import type { Abi } from 'viem'

import { ERC20_ABI } from '../abis/ERC20'
import { ERC721_ABI } from '../abis/ERC721'
import { FACTORY_ABI } from '../abis/UniswapV2Factory'
import { PAIR_ABI } from '../abis/UniswapV2Pair'
import { WERC721_ABI } from '../abis/WERC721'
import { assertParam } from '../errors'
import { resolveWrapperSide } from '../routing/nftRoutePaths'
import { getCollectionLabels } from './labels'
import { rankPoolsByLiquidity } from './rankPools'
import type { ReserveUsdByPair } from './rankPools'
import { resolveRoyalty } from './royalty'
import type { TokenRef } from '../types/amount.types'
import type { SnfClientContext } from '../types/client.types'
import type { CollectionInfo, PoolRef, WrapperVerified } from '../types/collection.types'
import type { SubgraphTokenCollection } from '../transport/subgraph.types'

/**
 * `resolveCollection` — one call that discovers a collection's wrapper, pools,
 * display labels, royalty, `redemptionLocked` and `wrapperVerified` (R6; 54-SPEC.md).
 * Discovery is on-chain first (`Factory.getWrapper` → `Factory.getPair`); the
 * subgraph is used ONLY to (a) discover any ERC-20 base beyond the chain's native
 * quote token — the Factory has no "all pairs for this wrapper" view, so a second
 * base's ADDRESS has to come from somewhere, and every candidate is still confirmed
 * via a real `getPair` before being trusted — and (b) non-blocking enrichment
 * (`reserveUSD`, names). Merges `snf-client/src/hooks/contracts/{useWrapperAddress,
 * usePairAddress,useCollectionFromWrapper,useCollectionRedemptionStatus}.ts`.
 */

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
const DEAD_ADDRESS = '0x000000000000000000000000000000000000dEaD' as const

/** Loosely-typed multicall call shape — see `royalty.ts`'s identical pattern/comment:
 * viem's per-position tuple inference cannot type-check a batch mixing several ABIs
 * built from a fixed prefix plus a `.map()`-derived tail. */
interface Call {
  readonly address: `0x${string}`
  readonly abi: Abi
  readonly functionName: string
  readonly args: readonly unknown[]
}
type CallResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

function isZero(addr: string): boolean {
  return addr.toLowerCase() === ZERO_ADDRESS
}

function dedupeAddresses(addresses: readonly `0x${string}`[]): readonly `0x${string}`[] {
  const seen = new Set<string>()
  const out: `0x${string}`[] = []
  for (const addr of addresses) {
    const key = addr.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(addr)
  }
  return out
}

/** REDEMPTION_PROBE guard wordings — ported verbatim from
 * `snf-client/src/hooks/contracts/useCollectionRedemptionStatus.ts` so both products
 * classify the same collections the same way. */
const BLOCKED_WORDING =
  /transfer[\s\-_]?role|operator (?:not allowed|denied|filter|blocked)|transfer (?:not allowed|denied|blocked|forbidden)|denyl?ist/i
const REDEMPTION_PROBE_ABI = [
  {
    inputs: [
      { name: 'from', type: 'address' },
      { name: 'to', type: 'address' },
      { name: 'tokenId', type: 'uint256' },
    ],
    name: 'safeTransferFrom',
    outputs: [],
    stateMutability: 'nonpayable',
    type: 'function',
  },
] as const

/** Best-effort discovery of a second (ERC-20) base beyond the native quote token,
 * plus the subgraph's collection name/symbol hint — wrapped so a down/degraded
 * subgraph loses ONLY this hint, never the native pool's on-chain discovery below. */
async function discoverEnrichment(
  ctx: SnfClientContext,
  wrapper: `0x${string}`,
): Promise<{
  readonly extraBases: readonly `0x${string}`[]
  readonly subgraphName: string | undefined
  readonly subgraphSymbol: string | undefined
}> {
  try {
    const { data: pairs } = await ctx.transport.pools({ first: 1000 })
    const w = wrapper.toLowerCase()
    const bases: `0x${string}`[] = []
    let subgraphName: string | undefined
    let subgraphSymbol: string | undefined
    for (const pair of pairs) {
      let other: string | undefined
      let coll: SubgraphTokenCollection | null | undefined
      if (pair.token0.id.toLowerCase() === w) {
        other = pair.token1.id
        coll = pair.token0.collection
      } else if (pair.token1.id.toLowerCase() === w) {
        other = pair.token0.id
        coll = pair.token1.collection
      }
      if (other === undefined) continue
      bases.push(getAddress(other))
      if (subgraphName === undefined && coll) {
        subgraphName = coll.name ?? undefined
        subgraphSymbol = coll.symbol ?? undefined
      }
    }
    return { extraBases: bases, subgraphName, subgraphSymbol }
  } catch {
    return { extraBases: [], subgraphName: undefined, subgraphSymbol: undefined }
  }
}

/** `true` only on a CONFIRMED transfer-guard revert wording — an unreadable RPC, a
 * stale sample id, or any other ambiguous revert fails safe to `false`, never a
 * silent `true` that would disable a working remove/sell flow. */
async function probeRedemptionLocked(
  ctx: SnfClientContext,
  collection: `0x${string}`,
  wrapper: `0x${string}`,
): Promise<boolean> {
  if (isZero(wrapper)) return false
  let sampleTokenId: string | undefined
  try {
    const inventory = await ctx.transport.inventory(wrapper)
    sampleTokenId = inventory.data?.tokenIds[0]
  } catch {
    return false
  }
  if (sampleTokenId === undefined) return false
  try {
    await ctx.publicClient.simulateContract({
      address: collection,
      abi: REDEMPTION_PROBE_ABI,
      functionName: 'safeTransferFrom',
      args: [wrapper, DEAD_ADDRESS, BigInt(sampleTokenId)],
      account: wrapper,
    })
    return false
  } catch (e) {
    const msg = String((e as { shortMessage?: string; message?: string })?.shortMessage ?? (e as Error)?.message ?? '')
    return BLOCKED_WORDING.test(msg)
  }
}

export async function resolveCollection(ctx: SnfClientContext, address: `0x${string}`): Promise<CollectionInfo> {
  assertParam(/^0x[0-9a-fA-F]{40}$/.test(address), 'resolveCollection requires a well-formed 0x address', {
    field: 'address',
  })
  const collection = getAddress(address)

  // Batch A — one multicall: wrapper lookup + the collection's own on-chain identity.
  const batchAContracts: readonly Call[] = [
    { address: ctx.chain.factory, abi: FACTORY_ABI, functionName: 'getWrapper', args: [collection] },
    { address: collection, abi: ERC721_ABI, functionName: 'name', args: [] },
    { address: collection, abi: ERC721_ABI, functionName: 'symbol', args: [] },
  ]
  const batchA: readonly CallResult[] = await ctx.publicClient.multicall({
    contracts: batchAContracts,
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
  })
  const wrapperResult = batchA[0]
  const wrapper: `0x${string}` =
    wrapperResult?.status === 'success' ? (wrapperResult.result as `0x${string}`) : ZERO_ADDRESS
  const onChainName = batchA[1]?.status === 'success' ? (batchA[1].result as string) : undefined
  const onChainSymbol = batchA[2]?.status === 'success' ? (batchA[2].result as string) : undefined

  const enrichment = isZero(wrapper)
    ? { extraBases: [], subgraphName: undefined, subgraphSymbol: undefined }
    : await discoverEnrichment(ctx, wrapper)

  let wrapperVerified: WrapperVerified = 'unknown'
  let pools: PoolRef[] = []

  if (!isZero(wrapper)) {
    const baseCandidates = dedupeAddresses([ctx.chain.quoteToken, ...enrichment.extraBases])
    const batchBContracts: readonly Call[] = [
      { address: wrapper, abi: WERC721_ABI, functionName: 'collection', args: [] },
      ...baseCandidates.map((base) => ({
        address: ctx.chain.factory,
        abi: FACTORY_ABI,
        functionName: 'getPair',
        args: [wrapper, base],
      })),
    ]
    const batchB: readonly CallResult[] = await ctx.publicClient.multicall({
      contracts: batchBContracts,
      allowFailure: true,
      multicallAddress: ctx.chain.multicall3,
      batchSize: 0,
    })

    const wrapperCollectionResult = batchB[0]
    wrapperVerified =
      wrapperCollectionResult?.status === 'success'
        ? String(wrapperCollectionResult.result).toLowerCase() === collection.toLowerCase()
          ? 'match'
          : 'mismatch'
        : 'unknown'

    const validEntries = baseCandidates
      .map((base, i) => {
        const r = batchB[i + 1]
        const pair = r?.status === 'success' ? (r.result as `0x${string}`) : ZERO_ADDRESS
        return { base, pair }
      })
      .filter((entry) => !isZero(entry.pair))

    if (validEntries.length > 0) {
      pools = await readPoolsBatchC(ctx, validEntries)
    }
  }

  const reserveUSD = await gatherReserveUsd(ctx, pools)
  const rankedPools = rankPoolsByLiquidity(pools, reserveUSD)

  const labels = getCollectionLabels({
    address: collection,
    subgraphName: enrichment.subgraphName,
    subgraphSymbol: enrichment.subgraphSymbol,
    onChainName,
    onChainSymbol,
  })

  const [royalty, redemptionLocked] = await Promise.all([
    resolveRoyalty(ctx, collection),
    probeRedemptionLocked(ctx, collection, wrapper),
  ])

  return { address: collection, wrapper, pools: rankedPools, labels, royalty, redemptionLocked, wrapperVerified }
}

/** Batch C — one multicall: `getReserves`/`token0`/`token1` for every confirmed pair,
 * plus `symbol`/`decimals` for any non-native base (the native base's identity is
 * already known from the chain registry — `nativeSymbol`/`quoteDecimals`). */
async function readPoolsBatchC(
  ctx: SnfClientContext,
  validEntries: readonly { readonly base: `0x${string}`; readonly pair: `0x${string}` }[],
): Promise<PoolRef[]> {
  const pairContracts: Call[] = validEntries.flatMap((e) => [
    { address: e.pair, abi: PAIR_ABI, functionName: 'getReserves', args: [] },
    { address: e.pair, abi: PAIR_ABI, functionName: 'token0', args: [] },
    // token1() is read here ONLY so resolveWrapperSide (below) can derive which slot
    // the wrapper occupies — this module never assumes an index itself.
    { address: e.pair, abi: PAIR_ABI, functionName: 'token1', args: [] },
  ])
  const nonNative = validEntries.filter((e) => e.base.toLowerCase() !== ctx.chain.quoteToken.toLowerCase())
  const baseMetaContracts: Call[] = nonNative.flatMap((e) => [
    { address: e.base, abi: ERC20_ABI, functionName: 'symbol', args: [] },
    { address: e.base, abi: ERC20_ABI, functionName: 'decimals', args: [] },
  ])

  const batchC: readonly CallResult[] = await ctx.publicClient.multicall({
    contracts: [...pairContracts, ...baseMetaContracts],
    allowFailure: true,
    multicallAddress: ctx.chain.multicall3,
    batchSize: 0,
  })

  const baseMeta = new Map<string, { symbol: string; decimals: number }>()
  nonNative.forEach((e, idx) => {
    const symResult = batchC[pairContracts.length + idx * 2]
    const decResult = batchC[pairContracts.length + idx * 2 + 1]
    const symbol = symResult?.status === 'success' && typeof symResult.result === 'string' ? symResult.result : 'TOKEN'
    const decimals = decResult?.status === 'success' && typeof decResult.result === 'number' ? decResult.result : 18
    baseMeta.set(e.base.toLowerCase(), { symbol, decimals })
  })

  const pools: PoolRef[] = []
  validEntries.forEach((e, idx) => {
    const reservesResult = batchC[idx * 3]
    const token0Result = batchC[idx * 3 + 1]
    const token1Result = batchC[idx * 3 + 2]
    if (reservesResult?.status !== 'success' || token0Result?.status !== 'success' || token1Result?.status !== 'success') {
      return
    }
    const [reserve0, reserve1] = reservesResult.result as readonly [bigint, bigint, number]
    const token0 = token0Result.result as `0x${string}`
    const token1 = token1Result.result as `0x${string}`
    const isNativeBase = e.base.toLowerCase() === ctx.chain.quoteToken.toLowerCase()
    const meta = isNativeBase
      ? { symbol: ctx.chain.nativeSymbol, decimals: ctx.chain.quoteDecimals }
      : (baseMeta.get(e.base.toLowerCase()) ?? { symbol: 'TOKEN', decimals: 18 })
    const baseToken: TokenRef = { address: e.base, symbol: meta.symbol, decimals: meta.decimals, isNative: isNativeBase }

    const { wrapperIsToken0 } = resolveWrapperSide({ pair: e.pair, token0, token1, baseToken })
    const reserves = wrapperIsToken0 ? { base: reserve1, wnft: reserve0 } : { base: reserve0, wnft: reserve1 }

    pools.push({ pair: e.pair, baseToken, isNative: isNativeBase, reserves, wrapperIsToken0 })
  })
  return pools
}

/** Non-blocking `reserveUSD` enrichment — one `pairById` per pool, independently
 * caught. `undefined` (never an empty map, which would look like "every pool is $0")
 * when nothing could be read. */
async function gatherReserveUsd(ctx: SnfClientContext, pools: readonly PoolRef[]): Promise<ReserveUsdByPair | undefined> {
  if (pools.length === 0) return undefined
  const entries = await Promise.all(
    pools.map(async (p) => {
      try {
        const { data } = await ctx.transport.pairById(p.pair)
        return data ? ([p.pair.toLowerCase(), Number(data.reserveUSD)] as const) : undefined
      } catch {
        return undefined
      }
    }),
  )
  const usable = entries.filter((e): e is readonly [string, number] => e !== undefined)
  return usable.length > 0 ? new Map(usable) : undefined
}
