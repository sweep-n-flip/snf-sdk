import { SnfError } from '../errors'
import type { SnfClientContext } from '../types/client.types'
import type { RedemptionStatus } from '../types/liquidity.types'

/**
 * Stub — this body is replaced by its implementation; the signature below is fixed
 * (see the plan's Interfaces section) and does not change when the body does. Returns
 * a rejected `Promise` rather than throwing synchronously, so a caller's `await`
 * always sees a rejection, never a synchronous throw before any `Promise` exists.
 */
export function redemptionStatus(ctx: SnfClientContext, collection: `0x${string}`): Promise<RedemptionStatus> {
  void ctx
  void collection
  return Promise.reject(new SnfError('UNKNOWN', 'redemptionStatus is not implemented yet'))
}
