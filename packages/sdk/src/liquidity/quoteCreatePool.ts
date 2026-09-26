import { SnfError } from '../errors'
import type { SnfClientContext } from '../types/client.types'
import type { QuoteCreatePoolArgs } from '../types/liquidity.types'
import type { Quote } from '../types/quote.types'

/**
 * Stub — this body is replaced by its implementation; the signature below is fixed
 * (see the plan's Interfaces section) and does not change when the body does. Returns
 * a rejected `Promise` rather than throwing synchronously, so a caller's `await`
 * always sees a rejection, never a synchronous throw before any `Promise` exists.
 */
export function quoteCreatePool(ctx: SnfClientContext, args: QuoteCreatePoolArgs): Promise<Quote> {
  void ctx
  void args
  return Promise.reject(new SnfError('UNKNOWN', 'quoteCreatePool is not implemented yet'))
}
