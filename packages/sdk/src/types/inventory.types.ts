/**
 * Result shape of `poolInventory(pair)`.
 */

/**
 * Candidate tokenIds a pool currently holds, plus the teto comprável ("buyable
 * ceiling") and freshness. Fast path: `ERC721Enumerable`. Fallback: subgraph
 * `Currency.tokenIds` gated by `_meta.block`.
 *
 * `truncated`/`warnings` added later (not the original shape): the
 * plan's own literal behavior ("caps at 200 ids per call... returns `truncated: true`
 * beyond that", "the subgraph list at `MAX_CONSUMED_IDS`... reporting `truncated`
 * rather than silently cutting") has no field to carry either without them — see
 * , Deviations. `'provider'` added to `source` for the same
 * reason: a partner-supplied `PoolInventoryProvider` is neither the on-chain
 * `ERC721Enumerable` read nor this package's own subgraph transport, so its result
 * needs a third, honest label rather than being mislabelled as one of the other two.
 */
export interface PoolInventory {
  /**
   * Decimal-string tokenIds, deduplicated, sorted ascending **as bigint** — never
   * lexicographic ("245830" must sort after "76197", not before it). May contain more
   * entries than `availableCount` (Edge `adjacency`: both numbers are reported,
   * never reconciled against each other).
   */
  readonly tokenIds: readonly string[]
  /** `max(0, floor(reserveWnft / 1e18) − 1)` — the pool never sells its last item. */
  readonly availableCount: number
  readonly asOfBlock: bigint
  readonly lagSeconds: number
  readonly stale: boolean
  readonly source: 'enumerable' | 'subgraph' | 'provider'
  /** True when `tokenIds` is a truncated prefix of a longer candidate list (the
   * enumerable path's 200-per-call cap, or the subgraph path's `MAX_CONSUMED_IDS`
   * cap) — never a silent cut. */
  readonly truncated: boolean
  /** Non-fatal notes from whichever path answered (e.g. one reverted
   * `tokenOfOwnerByIndex` slot) — never a reason to fail the whole call. */
  readonly warnings: readonly string[]
}
