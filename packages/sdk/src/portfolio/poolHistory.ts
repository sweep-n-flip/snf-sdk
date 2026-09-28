import { SnfError } from '../errors'
import type { SnfClientContext } from '../types/client.types'
import type { PoolHistory, PoolHistoryInterval, PoolHistoryOptions } from '../types/portfolio.types'

/**
 * Stub — this body is replaced by its implementation; the signature below is fixed
 * (see the plan's Interfaces section) and does not change when the body does. Returns
 * a rejected `Promise` rather than throwing synchronously, so a caller's `await`
 * always sees a rejection, never a synchronous throw before any `Promise` exists.
 */
export function poolHistory(
  ctx: SnfClientContext,
  pair: `0x${string}`,
  interval: PoolHistoryInterval,
  opts?: PoolHistoryOptions,
): Promise<PoolHistory> {
  void ctx
  void pair
  void interval
  void opts
  return Promise.reject(new SnfError('UNKNOWN', 'poolHistory is not implemented yet'))
}
