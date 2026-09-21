import { notImplemented } from '../internal/stub'
import type { TokenRef } from '../types/amount.types'
import type { SnfClientContext } from '../types/client.types'
import type { Approval, Bounds, BuildArgs, ExecutionPlan, Step } from '../types/plan.types'
import type { Quote } from '../types/quote.types'

/**
 * Shared internal helpers every `build*` function composes (R13). Note the correctly
 * camelCased export name below — an all-lowercase misspelling was flagged during
 * planning and must never be reintroduced.
 */

/**
 * Wraps `steps` into the `ExecutionPlan` object a `build*` function returns, binding
 * its `preflight()` method to a single Multicall3 call over the same block (R14).
 *
 * @gsd-stub — implemented by plan 14. Source analog:
 * snf-client/src/components/checkout/hooks/buildCheckoutDerived.ts.
 */
export function assemblePlan(
  ctx: SnfClientContext,
  steps: readonly Step[],
  expiresAt: string,
): ExecutionPlan {
  void ctx
  void steps
  void expiresAt
  return notImplemented('assemblePlan', '14')
}

/**
 * Derives `Bounds` from a FRESH on-chain re-quote — never from `quote`'s own numeric
 * fields (SPEC prohibition: never trust caller-supplied prices for `bounds`). Default
 * `slippageBps` 100; default `deadline` now+20min, capped at now+1h.
 *
 * @gsd-stub — implemented by plan 14. Source analog:
 * snf-drops-registration/.../genesis/swap/swapConstants.ts (branch feature/registration).
 */
export function deriveBounds(
  ctx: SnfClientContext,
  quote: Quote,
  opts: { readonly slippageBps: number; readonly deadline: bigint },
): Bounds {
  void ctx
  void quote
  void opts
  return notImplemented('deriveBounds', '14')
}

/**
 * Validates `BuildArgs` before any on-chain work: `deadline` beyond now+1h or a
 * `tokenIds` array beyond 50 entries both throw `INVALID_PARAMS` (R13 boundary edges).
 *
 * @gsd-stub — implemented by plan 14. Source analog:
 * snf-client/src/lib/preflight.ts + Drops swapGuards.ts (branch feature/registration).
 */
export function validateBuildArgs(args: BuildArgs): void {
  void args
  return notImplemented('validateBuildArgs', '14')
}

/**
 * Reads on-chain allowances/operator-approval state and returns ONLY the `Approval`
 * steps that are actually still missing (R13 Edge `empty | R13`: none missing ⇒
 * `steps` contains only the swap).
 *
 * @gsd-stub — implemented by plan 14. Source analog:
 * snf-client/src/hooks/contracts/nftBatchGas.ts (approval pre-check pattern).
 */
export function missingApprovals(
  ctx: SnfClientContext,
  owner: `0x${string}`,
  spender: `0x${string}`,
  tokens: readonly TokenRef[],
): Promise<readonly Approval[]> {
  void ctx
  void owner
  void spender
  void tokens
  return notImplemented('missingApprovals', '14')
}
