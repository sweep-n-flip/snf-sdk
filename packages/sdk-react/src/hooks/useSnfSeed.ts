import type { BuildSeedArgs, ExecutionPlan, SnfClient } from '@sweepnflip/sdk'
import { useSnfBuild, type UseSnfBuildResult } from './buildShared'

export type UseSnfSeedResult = UseSnfBuildResult<BuildSeedArgs>

/**
 * Builds a launch-seeding deposit as an unsigned `ExecutionPlan` — entirely
 * optional: a partner who never calls this can still seed a pool by any other
 * means. The chain read and gas estimate only happen when the partner calls
 * `build(args)`, never on render. The resulting plan feeds `useSnfCheckout(plan)`.
 */
export function useSnfSeed(): UseSnfSeedResult {
  return useSnfBuild((client: SnfClient, args: BuildSeedArgs): Promise<ExecutionPlan> =>
    client.buildSeed(args),
  )
}
