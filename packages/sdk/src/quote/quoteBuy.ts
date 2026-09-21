import { notImplemented } from '../internal/stub'
import type { SnfClientContext } from '../types/client.types'
import type { Quote, QuoteBuyArgs } from '../types/quote.types'

/**
 * On-chain cost to buy `count`/`tokenIds` NFTs of a collection, reconciled to the wei
 * against the Router's own `getAmountsInCollection` (R8). Never absorbs a divergence
 * silently — a 1-wei mismatch throws `SnfError('QUOTE_RECONCILIATION_FAILED')` and no
 * `Quote` is returned.
 *
 * @gsd-stub — implemented by plan 12. Source analog:
 * snf-drops-registration/.../genesis/swap/{swapQuoteMath,buyDerivations}.ts (branch feature/registration).
 */
export function quoteBuy(ctx: SnfClientContext, args: QuoteBuyArgs): Promise<Quote> {
  void ctx
  void args
  return notImplemented('quoteBuy', '12')
}
