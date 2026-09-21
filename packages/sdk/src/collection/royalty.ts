import { notImplemented } from '../internal/stub'
import type { RoyaltyInfo } from '../types/collection.types'
import type { SnfClientContext } from '../types/client.types'

/**
 * Reconstructs EIP-2981 royalty exactly the way the Router computes it
 * (`RoyaltyHelper.sol`), including the `capBps === 0` ⇒ zero-royalty footgun and
 * `capRoyaltyFee=false` pin (SPEC prohibition #6 — the SDK never sends
 * `capRoyaltyFee=true`).
 *
 * @gsd-stub — implemented by plan 10. Source analog:
 * snf-client/src/hooks/contracts/resolveEip2981.ts + hooks/royalty/collectionRoyalty.ts.
 */
export function resolveRoyalty(
  ctx: SnfClientContext,
  collection: `0x${string}`,
  opts?: { readonly tokenId?: string },
): Promise<RoyaltyInfo> {
  void ctx
  void collection
  void opts
  return notImplemented('resolveRoyalty', '10')
}
