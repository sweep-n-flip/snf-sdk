/**
 * Result shape of `poolInventory(pair)` (R7; 54-SPEC.md).
 */

/**
 * Candidate tokenIds a pool currently holds, plus the teto comprável ("buyable
 * ceiling") and freshness. Fast path: `ERC721Enumerable`. Fallback: subgraph
 * `Currency.tokenIds` gated by `_meta.block`.
 */
export interface PoolInventory {
  /**
   * Decimal-string tokenIds, deduplicated, sorted ascending **as bigint** — never
   * lexicographic ("245830" must sort after "76197", not before it). May contain more
   * entries than `availableCount` (Edge `adjacency | R7`: both numbers are reported,
   * never reconciled against each other).
   */
  readonly tokenIds: readonly string[]
  /** `max(0, floor(reserveWnft / 1e18) − 1)` — the pool never sells its last item. */
  readonly availableCount: number
  readonly asOfBlock: bigint
  readonly lagSeconds: number
  readonly stale: boolean
  readonly source: 'enumerable' | 'subgraph'
}
