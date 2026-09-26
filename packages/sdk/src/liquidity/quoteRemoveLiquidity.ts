import { SnfError } from '../errors'
import type { SnfClientContext } from '../types/client.types'
import type { QuoteRemoveLiquidityArgs } from '../types/liquidity.types'
import type { Quote } from '../types/quote.types'

/**
 * Stub — this body is replaced by its implementation; the signature below is fixed
 * (see the plan's Interfaces section) and does not change when the body does. Returns
 * a rejected `Promise` rather than throwing synchronously, so a caller's `await`
 * always sees a rejection, never a synchronous throw before any `Promise` exists.
 */
export function quoteRemoveLiquidity(ctx: SnfClientContext, args: QuoteRemoveLiquidityArgs): Promise<Quote> {
  void ctx
  void args
  return Promise.reject(new SnfError('UNKNOWN', 'quoteRemoveLiquidity is not implemented yet'))
}
