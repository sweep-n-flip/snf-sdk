import { notImplemented } from '../internal/stub'
import type { SnfClientContext } from '../types/client.types'
import type { Quote, QuoteSellArgs } from '../types/quote.types'

/**
 * On-chain proceeds from selling `tokenIds`/`count` NFTs of a collection, reconciled
 * to the wei against the Router's own `getAmountsOutCollection` (R8). Note the
 * asymmetric footgun: `getAmountsInCollection` returns gross (loaded),
 * `getAmountsOutCollection` returns net (fee+royalty already deducted) — never
 * re-subtract on this side.
 *
 * @gsd-stub — implemented by plan 12. Source analog:
 * snf-drops-registration/.../genesis/swap/sellQuoteReads.ts (branch feature/registration).
 */
export function quoteSell(ctx: SnfClientContext, args: QuoteSellArgs): Promise<Quote> {
  void ctx
  void args
  return notImplemented('quoteSell', '12')
}
