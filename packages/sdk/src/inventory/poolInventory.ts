import { notImplemented } from '../internal/stub'
import type { PoolInventory } from '../types/inventory.types'
import type { SnfClientContext } from '../types/client.types'

/**
 * Candidate tokenIds a pool currently holds, plus the buyable ceiling and freshness
 * (R7). Fast path: `ERC721Enumerable` (`supportsInterface(0x780e9d63)`). Fallback:
 * subgraph `Currency.tokenIds` gated by `_meta.block`.
 *
 * @gsd-stub — implemented by plan 11. Source analog:
 * snf-drops-registration/.../genesis/inventory/{subgraphQueries,useSubgraphInventory,tokenUriParse}.ts
 * (branch feature/registration).
 */
export function poolInventory(
  ctx: SnfClientContext,
  pair: `0x${string}`,
): Promise<PoolInventory> {
  void ctx
  void pair
  return notImplemented('poolInventory', '11')
}
