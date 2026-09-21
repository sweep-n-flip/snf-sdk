import { notImplemented } from '../internal/stub'
import type { BuildArgs, ExecutionPlan } from '../types/plan.types'
import type { SnfClientContext } from '../types/client.types'

/**
 * Builds an `ExecutionPlan` for a sell (R13) — same discipline as `buildBuy`: only
 * missing `Approval`s, `bounds` re-derived on-chain inside `build()`, ≤ 50 tokenIds
 * per step.
 *
 * @gsd-stub — implemented by plan 15. Source analog:
 * snf-client/src/hooks/contracts/useNFTCollectionExecute.ts.
 */
export function buildSell(ctx: SnfClientContext, args: BuildArgs): Promise<ExecutionPlan> {
  void ctx
  void args
  return notImplemented('buildSell', '15')
}
