import type { Abi } from 'viem'

import { ERC20_ABI } from '../abis/ERC20'
import { getCollectionLabels } from '../collection/labels'
import type { SnfClientContext } from '../types/client.types'
import type { CollectionLabels } from '../types/collection.types'

/**
 * Collection names always go through the canonical waterfall — a raw address is
 * never a name. This module batches the on-chain half of that waterfall (`name()`/
 * `symbol()`) across every collection a portfolio scan actually needs it for, at one
 * pinned block, instead of one multicall per collection.
 *
 * `name()`/`symbol()` are read through the ERC-20 metadata ABI, not this package's
 * own ERC-721 ABI — the two extensions share identical selectors for both functions,
 * and this package's ERC-721 ABI does not declare either one. Reusing the ERC-20
 * metadata entries is exact, not a workaround: the wire call is byte-identical either
 * way.
 */

interface Call {
  readonly address: `0x${string}`
  readonly abi: Abi
  readonly functionName: string
  readonly args: readonly unknown[]
}
type CallResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

export interface LabelSourceEntry {
  readonly collection: `0x${string}`
  readonly subgraphName?: string | undefined
  readonly subgraphSymbol?: string | undefined
}

/**
 * Resolves `{ name, symbol }` for every distinct collection in `entries`. A usable
 * subgraph name/symbol resolves with zero on-chain reads; only collections whose
 * subgraph hint was unusable (missing, empty, or address-like) get ONE shared
 * multicall of `name()`/`symbol()`, pinned to `blockNumber`. A thrown multicall still
 * resolves every collection to its subgraph-only (or shortened-address) label —
 * labels never fail a portfolio read.
 */
export async function resolveLabels(
  ctx: SnfClientContext,
  entries: readonly LabelSourceEntry[],
  blockNumber: bigint,
): Promise<ReadonlyMap<string, CollectionLabels>> {
  const byCollection = new Map<string, LabelSourceEntry>()
  for (const entry of entries) {
    const key = entry.collection.toLowerCase()
    if (!byCollection.has(key)) byCollection.set(key, entry)
  }

  const resolved = new Map<string, CollectionLabels & { readonly nameIsFallback: boolean }>()
  const needsOnChain: LabelSourceEntry[] = []
  for (const [key, entry] of byCollection) {
    const labels = getCollectionLabels({
      address: entry.collection,
      subgraphName: entry.subgraphName,
      subgraphSymbol: entry.subgraphSymbol,
    })
    resolved.set(key, labels)
    if (labels.nameIsFallback) needsOnChain.push(entry)
  }

  if (needsOnChain.length > 0) {
    const contracts: Call[] = needsOnChain.flatMap((entry) => [
      { address: entry.collection, abi: ERC20_ABI, functionName: 'name', args: [] },
      { address: entry.collection, abi: ERC20_ABI, functionName: 'symbol', args: [] },
    ])

    let results: readonly CallResult[] | undefined
    try {
      results = await ctx.publicClient.multicall({
        contracts,
        allowFailure: true,
        multicallAddress: ctx.chain.multicall3,
        batchSize: 0,
        blockNumber,
      })
    } catch {
      results = undefined
    }

    if (results !== undefined) {
      needsOnChain.forEach((entry, i) => {
        const nameResult = results[i * 2]
        const symbolResult = results[i * 2 + 1]
        const onChainName = nameResult?.status === 'success' ? (nameResult.result as string) : undefined
        const onChainSymbol = symbolResult?.status === 'success' ? (symbolResult.result as string) : undefined
        const labels = getCollectionLabels({
          address: entry.collection,
          subgraphName: entry.subgraphName,
          subgraphSymbol: entry.subgraphSymbol,
          onChainName,
          onChainSymbol,
        })
        resolved.set(entry.collection.toLowerCase(), labels)
      })
    }
  }

  const out = new Map<string, CollectionLabels>()
  for (const [key, labels] of resolved) {
    out.set(key, labels.imageUrl !== undefined ? { name: labels.name, symbol: labels.symbol, imageUrl: labels.imageUrl } : { name: labels.name, symbol: labels.symbol })
  }
  return out
}
