import type { Abi } from 'viem'

import { ERC721_ABI } from '../abis/ERC721'
import { NO_PROVIDER } from '../providers/defaults'
import type { SnfClientContext } from '../types/client.types'
import type { CollectionLabels } from '../types/collection.types'
import type { CollectionsHeld, HeldCollection } from '../types/portfolio.types'
import { resolveLabels } from './labels'
import { nftPoolSet } from './poolSet'
import type { NftPoolEntry } from './poolSet.types'
import { mapWithConcurrency, normalizeAddress, PORTFOLIO_CONCURRENCY } from './shared'

/**
 * `collectionsHeld(owner)` — which pooled collections this owner holds, on the
 * client's chain. This SDK holds no key-gated NFT indexer of its own, so the actual
 * token ids only ever come from the partner's own `walletNfts` provider — an absent
 * provider is reported as `unavailable`, never silently presented as an empty
 * wallet (a caller must never read "no provider was asked" as "holds nothing").
 *
 * THE ON-CHAIN COUNT IS THE AUTHORITY, THE PROVIDER'S IDS ARE ENRICHMENT
 * `count` comes from `ERC721.balanceOf(owner)` — one multicall, one block — for
 * every pooled collection; the provider's own token ids are ONLY ever used to fill
 * `tokenIds` (an indexer can lag behind the chain, so its `[]` never overrides a
 * positive on-chain count). `countSource` falls back to the provider's own id count
 * ONLY when the on-chain read itself failed for that collection.
 */

const DIGITS_ONLY_RE = /^\d+$/
const TOKEN_ID_CAP = 10_000

interface Call {
  readonly address: `0x${string}`
  readonly abi: Abi
  readonly functionName: string
  readonly args: readonly unknown[]
}
type CallResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

interface CollectionCandidate {
  readonly collection: `0x${string}`
  readonly subgraphName: string | undefined
  readonly subgraphSymbol: string | undefined
}

function distinctCollections(pools: readonly NftPoolEntry[]): CollectionCandidate[] {
  const byCollection = new Map<string, CollectionCandidate>()
  for (const entry of pools) {
    const key = entry.collection.toLowerCase()
    if (!byCollection.has(key)) {
      byCollection.set(key, { collection: entry.collection, subgraphName: entry.subgraphName, subgraphSymbol: entry.subgraphSymbol })
    }
  }
  return Array.from(byCollection.values())
}

/** Digits-only, de-duplicated, ascending-sorted, capped at `TOKEN_ID_CAP`.
 * `totalCount` is the de-duplicated count BEFORE the cap — the provider-fallback
 * `count` reflects what the provider actually reported, not the display cap. */
function sanitizeIds(raw: readonly string[]): { readonly ids: readonly string[]; readonly truncated: boolean; readonly totalCount: number } {
  const seen = new Set<bigint>()
  for (const id of raw) {
    if (DIGITS_ONLY_RE.test(id)) seen.add(BigInt(id))
  }
  const sorted = Array.from(seen).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const truncated = sorted.length > TOKEN_ID_CAP
  const capped = truncated ? sorted.slice(0, TOKEN_ID_CAP) : sorted
  return { ids: capped.map((id) => id.toString()), truncated, totalCount: seen.size }
}

export async function collectionsHeld(ctx: SnfClientContext, owner: `0x${string}`): Promise<CollectionsHeld> {
  const normalizedOwner = normalizeAddress(owner, 'owner')

  const provider = ctx.providers.walletNfts
  if (provider === undefined || provider === NO_PROVIDER) {
    return { status: 'unavailable', reason: 'no-provider', chainId: ctx.chain.chainId, owner: normalizedOwner }
  }

  const poolSet = await nftPoolSet(ctx)
  const blockNumber = await ctx.publicClient.getBlockNumber()
  const collections = distinctCollections(poolSet.pools)

  if (collections.length === 0) {
    return {
      status: 'ok',
      chainId: ctx.chain.chainId,
      owner: normalizedOwner,
      blockNumber,
      collections: [],
      unanswered: [],
      poolSet: poolSet.freshness,
    }
  }

  const contracts: Call[] = collections.map((c) => ({
    address: c.collection,
    abi: ERC721_ABI,
    functionName: 'balanceOf',
    args: [normalizedOwner],
  }))

  const readOnChainCounts = async (): Promise<readonly CallResult[]> =>
    ctx.publicClient.multicall({
      contracts,
      allowFailure: true,
      multicallAddress: ctx.chain.multicall3,
      batchSize: 0,
      blockNumber,
    })

  const [onChainResults, providerResults] = await Promise.all([
    readOnChainCounts(),
    mapWithConcurrency(collections, PORTFOLIO_CONCURRENCY, async (c) => {
      try {
        return await provider.getWalletNfts(normalizedOwner, c.collection, ctx.chain.chainId)
      } catch {
        return undefined
      }
    }),
  ])

  interface Included {
    readonly candidate: CollectionCandidate
    readonly tokenIds: readonly string[]
    readonly tokenIdsTruncated: boolean
    readonly count: number
    readonly countSource: 'on-chain' | 'provider'
  }
  const included: Included[] = []
  const unanswered: `0x${string}`[] = []

  collections.forEach((c, i) => {
    const answer = providerResults[i]
    if (answer === undefined) {
      unanswered.push(c.collection)
      return
    }
    const sanitized = sanitizeIds(answer)
    const onChainResult = onChainResults[i]
    const onChainOk = onChainResult?.status === 'success'
    const count = onChainOk ? Number(onChainResult.result) : sanitized.totalCount
    if (count > 0 || sanitized.ids.length > 0) {
      included.push({
        candidate: c,
        tokenIds: sanitized.ids,
        tokenIdsTruncated: sanitized.truncated,
        count,
        countSource: onChainOk ? 'on-chain' : 'provider',
      })
    }
  })

  const labels =
    included.length > 0
      ? await resolveLabels(
          ctx,
          included.map((r) => ({ collection: r.candidate.collection, subgraphName: r.candidate.subgraphName, subgraphSymbol: r.candidate.subgraphSymbol })),
          blockNumber,
        )
      : new Map<string, CollectionLabels>()

  const collectionsOut: HeldCollection[] = included.map((r) => ({
    collection: r.candidate.collection,
    labels: labels.get(r.candidate.collection.toLowerCase())!,
    tokenIds: r.tokenIds,
    tokenIdsTruncated: r.tokenIdsTruncated,
    count: r.count,
    countSource: r.countSource,
  }))

  return {
    status: unanswered.length > 0 ? 'partial' : 'ok',
    chainId: ctx.chain.chainId,
    owner: normalizedOwner,
    blockNumber,
    collections: collectionsOut,
    unanswered,
    poolSet: poolSet.freshness,
  }
}
