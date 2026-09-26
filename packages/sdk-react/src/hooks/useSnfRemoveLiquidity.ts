import type { BuildArgs, ExecutionPlan, SnfClient } from '@sweepnflip/sdk'
import { useSnfBuild, type UseSnfBuildResult } from './buildShared'

export type UseSnfRemoveLiquidityResult = UseSnfBuildResult<BuildArgs>

/**
 * Builds a withdrawal (whole NFTs + wNFT remainder, or wNFT-only at any share
 * size) as an unsigned `ExecutionPlan`. The chain read and gas estimate only
 * happen when the partner calls `build(args)`, never on render. The resulting
 * plan feeds `useSnfCheckout(plan)`.
 */
export function useSnfRemoveLiquidity(): UseSnfRemoveLiquidityResult {
  return useSnfBuild((client: SnfClient, args: BuildArgs): Promise<ExecutionPlan> =>
    client.buildRemoveLiquidity(args),
  )
}
