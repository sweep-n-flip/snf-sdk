import type { PoolSetFreshness } from '../types/portfolio.types'

/**
 * Internal shapes for `poolSet.ts`'s `nftPoolSet(ctx)` — not exported from any barrel.
 * `positions`, and later `wnftBalances`/`collectionsHeld`, all consume this exact
 * shape rather than re-deriving it from the raw subgraph response.
 */

/** One confirmed SnF NFT pool from the subgraph pool set, oriented and addressed —
 * never an index guess. */
export interface NftPoolEntry {
  /** Checksummed. */
  readonly pair: `0x${string}`
  readonly wrapper: `0x${string}`
  readonly collection: `0x${string}`
  readonly base: `0x${string}`
  /** A subgraph-sourced hint only — every figure a caller derives from this entry is
   * still re-verified on-chain by `loadPairState`'s own probe, which never trusts
   * this field directly. */
  readonly wrapperIsToken0: boolean
  readonly subgraphName: string | undefined
  readonly subgraphSymbol: string | undefined
}

export interface NftPoolSet {
  readonly pools: readonly NftPoolEntry[]
  readonly freshness: PoolSetFreshness
}
