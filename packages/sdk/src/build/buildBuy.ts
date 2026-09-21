import { notImplemented } from '../internal/stub'
import type { BuildArgs, ExecutionPlan } from '../types/plan.types'
import type { SnfClientContext } from '../types/client.types'

/**
 * Builds an `ExecutionPlan` for a buy (R13): only missing `Approval`s are emitted,
 * `bounds` are derived from a fresh on-chain re-quote inside `build()` (never from
 * `args.quote`'s own numeric fields), and `tokenIds` are capped at 50 per step.
 *
 * @gsd-stub — implemented by plan 15. Source analog:
 * snf-client/src/hooks/contracts/useNFTCollectionExecute.ts.
 */
export function buildBuy(ctx: SnfClientContext, args: BuildArgs): Promise<ExecutionPlan> {
  void ctx
  void args
  return notImplemented('buildBuy', '15')
}
