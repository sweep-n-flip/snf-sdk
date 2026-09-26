import type { BuildAddLiquidityArgs, ExecutionPlan, SnfClient } from '@sweepnflip/sdk'
import { useSnfBuild, type UseSnfBuildResult } from './buildShared'

export type UseSnfAddLiquidityResult = UseSnfBuildResult<BuildAddLiquidityArgs>

/**
 * Builds a deposit into an EXISTING pool as an unsigned `ExecutionPlan` — the
 * chain read and gas estimate only happen when the partner calls `build(args)`,
 * never on render. The resulting plan feeds `useSnfCheckout(plan)`, which is
 * where every transaction is actually dispatched, one user click per step.
 */
export function useSnfAddLiquidity(): UseSnfAddLiquidityResult {
  return useSnfBuild((client: SnfClient, args: BuildAddLiquidityArgs): Promise<ExecutionPlan> =>
    client.buildAddLiquidity(args),
  )
}
