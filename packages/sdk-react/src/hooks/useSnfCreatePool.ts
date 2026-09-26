import type { BuildCreatePoolArgs, ExecutionPlan, SnfClient } from '@sweepnflip/sdk'
import { useSnfBuild, type UseSnfBuildResult } from './buildShared'

export type UseSnfCreatePoolResult = UseSnfBuildResult<BuildCreatePoolArgs>

/**
 * Builds a pool-creating deposit as an unsigned `ExecutionPlan` — always with an
 * exact minimum, never a loosened one (a same-block front-run window). The chain
 * read and gas estimate only happen when the partner calls `build(args)`, never
 * on render. The resulting plan feeds `useSnfCheckout(plan)`.
 */
export function useSnfCreatePool(): UseSnfCreatePoolResult {
  return useSnfBuild((client: SnfClient, args: BuildCreatePoolArgs): Promise<ExecutionPlan> =>
    client.buildCreatePool(args),
  )
}
