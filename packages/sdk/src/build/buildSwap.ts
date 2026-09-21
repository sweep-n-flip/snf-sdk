import { notImplemented } from '../internal/stub'
import type { BuildArgs, ExecutionPlan } from '../types/plan.types'
import type { SnfClientContext } from '../types/client.types'

/**
 * Builds an `ExecutionPlan` for a fungible↔fungible swap (R13), delegate-aware
 * (9800 vs 9970), `bounds` re-derived on-chain inside `build()`.
 *
 * @gsd-stub — implemented by plan 15. Source analog:
 * snf-client/src/hooks/contracts/useSwapExecute.ts.
 */
export function buildSwap(ctx: SnfClientContext, args: BuildArgs): Promise<ExecutionPlan> {
  void ctx
  void args
  return notImplemented('buildSwap', '15')
}
