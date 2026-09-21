import { notImplemented } from '../internal/stub'
import type { SnfClientContext } from '../types/client.types'
import type { Quote, QuoteNftToNftArgs } from '../types/quote.types'

/**
 * Two-leg collection→collection quote (R9): sell `sell.tokenIds` of collection A,
 * buy `buy.count` of collection B. `remainder` saturates to 0 when the buy costs more
 * than the sell proceeds (top-up regime — `netProceeds`/`buyCost` on the returned
 * `Quote` let a caller detect and size the top-up). Cross-base pools (different base
 * token per leg) are `NO_ROUTE`. Parity with `computeNftToNftQuote` is a hard
 * requirement (R9 acceptance).
 *
 * @gsd-stub — implemented by plan 13. Source analog:
 * snf-client/src/features/swap/hooks/nftToNftMath.ts (`computeNftToNftQuote`).
 */
export function quoteNftToNft(
  ctx: SnfClientContext,
  args: QuoteNftToNftArgs,
): Promise<Quote> {
  void ctx
  void args
  return notImplemented('quoteNftToNft', '13')
}
