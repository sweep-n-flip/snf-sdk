import { notImplemented } from '../internal/stub'
import type { SnfClientContext } from '../types/client.types'
import type { Quote, QuoteSwapArgs } from '../types/quote.types'

/**
 * Fungible↔fungible quote, delegate-aware (R10): 9800/10000 on native SnF pools,
 * 9970/10000 on delegate pools. `directOnly` respected; no viable route ⇒ `NO_ROUTE`
 * with `details.viablePayTokens`.
 *
 * @gsd-stub — implemented by plan 13. Source analog: snf-client/src/lib/quote.ts
 * (`computeAmountOutMin`, `routerSwapDecimals`) + lib/math.ts.
 */
export function quoteSwap(ctx: SnfClientContext, args: QuoteSwapArgs): Promise<Quote> {
  void ctx
  void args
  return notImplemented('quoteSwap', '13')
}
