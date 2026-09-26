import { SnfError } from '../errors'
import type { SnfClientContext } from '../types/client.types'
import type { LpPosition } from '../types/liquidity.types'

/**
 * Stub — this body is replaced by its implementation; the signature below is fixed
 * (see the plan's Interfaces section) and does not change when the body does. Returns
 * a rejected `Promise` rather than throwing synchronously, so a caller's `await`
 * always sees a rejection, never a synchronous throw before any `Promise` exists.
 */
export function lpPosition(
  ctx: SnfClientContext,
  pair: `0x${string}`,
  owner: `0x${string}`,
): Promise<LpPosition> {
  void ctx
  void pair
  void owner
  return Promise.reject(new SnfError('UNKNOWN', 'lpPosition is not implemented yet'))
}
