import { SnfError } from '../errors'
import type { SnfClientContext } from '../types/client.types'
import type { WnftBalances } from '../types/portfolio.types'

/**
 * Stub — this body is replaced by its implementation; the signature below is fixed
 * (see the plan's Interfaces section) and does not change when the body does. Returns
 * a rejected `Promise` rather than throwing synchronously, so a caller's `await`
 * always sees a rejection, never a synchronous throw before any `Promise` exists.
 */
export function wnftBalances(ctx: SnfClientContext, owner: `0x${string}`): Promise<WnftBalances> {
  void ctx
  void owner
  return Promise.reject(new SnfError('UNKNOWN', 'wnftBalances is not implemented yet'))
}
