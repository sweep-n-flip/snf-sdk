import { getAddress } from 'viem'

import type { SnfClientContext } from '../types/client.types'
import type { PoolSetFreshness } from '../types/portfolio.types'
import type { SubgraphPair, SubgraphToken } from '../transport/subgraph.types'
import type { NftPoolEntry, NftPoolSet } from './poolSet.types'

/**
 * `nftPoolSet(ctx)` — the one NFT-pool discovery every portfolio read composes:
 * `positions` today, `wnftBalances`/`collectionsHeld` later, all start from this exact
 * list rather than each running their own subgraph query.
 *
 * The first page requests the identical argument object the collection resolver's own
 * discovery already uses, so on a client that resolved a collection this cache window
 * the transport's TTL cache serves this call for free — no extra subgraph request.
 * Pagination continues only while a page comes back full (the server rejects a page
 * size above 1000), capped at five rounds; today's largest chain holds a couple dozen
 * pairs, so the cap is headroom, never a real ceiling.
 *
 * `isNFTPool` is a pre-filter here, never the gate: some chains index pairs from an
 * entirely different, delegated DEX alongside the real SnF pools, and the subgraph's
 * own flag is the cheap first cut. Every figure a caller derives from an entry this
 * function returns is still re-derived on-chain by `loadPairState`'s own Factory
 * `getPair` re-check and `collection()` probe — this filter only spares a whole-wallet
 * scan a round trip on a pair that was never going to pass that on-chain gate anyway.
 */

const MAX_PAGES = 5

/** The discrete (NFT-wrapper) side of a row, or `undefined` when the row is not a
 * genuine one-NFT-side pool — both sides discrete, or neither, are equally invalid. */
function discreteSide(row: SubgraphPair):
  | { readonly token: SubgraphToken; readonly other: SubgraphToken; readonly wrapperIsToken0: boolean }
  | undefined {
  if (row.discrete0 === row.discrete1) return undefined
  return row.discrete0
    ? { token: row.token0, other: row.token1, wrapperIsToken0: true }
    : { token: row.token1, other: row.token0, wrapperIsToken0: false }
}

function entryFromRow(row: SubgraphPair): NftPoolEntry | undefined {
  if (row.isNFTPool !== true) return undefined
  const side = discreteSide(row)
  if (side === undefined) return undefined
  const collection = side.token.collection
  if (collection === null || collection === undefined) return undefined

  return {
    pair: getAddress(row.id),
    wrapper: getAddress(side.token.id),
    collection: getAddress(collection.id),
    base: getAddress(side.other.id),
    wrapperIsToken0: side.wrapperIsToken0,
    subgraphName: collection.name ?? undefined,
    subgraphSymbol: collection.symbol ?? undefined,
  }
}

export async function nftPoolSet(ctx: SnfClientContext): Promise<NftPoolSet> {
  const entries: NftPoolEntry[] = []
  const seenPairs = new Set<string>()
  let asOfBlock: bigint | undefined
  let lagSeconds = 0
  let stale = false

  for (let page = 0; page < MAX_PAGES; page++) {
    const result =
      page === 0
        ? await ctx.transport.pools({ first: 1000 })
        : await ctx.transport.pools({ first: 1000, skip: page * 1000 })

    asOfBlock = asOfBlock === undefined || result.asOfBlock < asOfBlock ? result.asOfBlock : asOfBlock
    lagSeconds = Math.max(lagSeconds, result.lagSeconds)
    stale = stale || result.stale

    for (const row of result.data) {
      const entry = entryFromRow(row)
      if (entry === undefined) continue
      const key = entry.pair.toLowerCase()
      if (seenPairs.has(key)) continue
      seenPairs.add(key)
      entries.push(entry)
    }

    if (result.data.length < 1000) break
  }

  const freshness: PoolSetFreshness = { asOfBlock: asOfBlock ?? 0n, lagSeconds, stale }
  return { pools: entries, freshness }
}
