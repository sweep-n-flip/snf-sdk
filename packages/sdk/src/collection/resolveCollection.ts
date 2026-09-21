import { notImplemented } from '../internal/stub'
import type { CollectionInfo } from '../types/collection.types'
import type { SnfClientContext } from '../types/client.types'

/**
 * One call that discovers a collection's wrapper, pools, display labels, royalty,
 * `redemptionLocked` and `wrapperVerified` (R6). Discovery is on-chain
 * (`Factory.getWrapper` → `getPair`); the subgraph only enriches.
 *
 * @gsd-stub — implemented by plan 10. Source analog:
 * snf-client/src/lib/collections/* + Factory.getWrapper/getPair.
 */
export function resolveCollection(
  ctx: SnfClientContext,
  address: `0x${string}`,
): Promise<CollectionInfo> {
  void ctx
  void address
  return notImplemented('resolveCollection', '10')
}
