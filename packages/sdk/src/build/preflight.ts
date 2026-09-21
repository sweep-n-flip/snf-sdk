import { notImplemented } from '../internal/stub'
import type { SnfClientContext } from '../types/client.types'
import type { ExecutionPlan, PreflightResult } from '../types/plan.types'

/**
 * The frame-of-signature pre-flight (R14): one Multicall3 call, one block. Verifies
 * ownership of the ids being sold, pool custody of the ids being bought,
 * `wrapper.collection() === collection`, the payer's balance, and the wallet's
 * `chainId` — ALL against the same `blockNumber`. Failure throws a typed `SnfError`
 * (`TOKENIDS_UNAVAILABLE`, `WRAPPER_UNVERIFIED`, `WRONG_CHAIN`, `INVALID_PARAMS`)
 * BEFORE any signature; never returns a partial `PreflightResult`.
 *
 * @gsd-stub — implemented by plan 14. Source analog: snf-client/src/lib/preflight.ts
 * (`assertUserOwnsAllNFTs`) + Drops swapGuards.ts (`assertPoolStillHolds`,
 * `assertPoolIsThisCollection`, branch feature/registration).
 */
export function runPreflight(
  ctx: SnfClientContext,
  plan: ExecutionPlan,
): Promise<PreflightResult> {
  void ctx
  void plan
  return notImplemented('runPreflight', '14')
}
