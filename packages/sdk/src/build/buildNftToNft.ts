import { notImplemented } from '../internal/stub'
import type { BuildArgs, ExecutionPlan } from '../types/plan.types'
import type { SnfClientContext } from '../types/client.types'

/**
 * Builds the two/three-step, USER-DRIVEN `ExecutionPlan` for an NFT×NFT swap (R13,
 * R15, INV-17): sell leg, buy leg, and — Route A only — a buy-wNFT top-up leg. No
 * step auto-dispatches from a watcher; each is a `Checkout.next()` checkpoint.
 *
 * @gsd-stub — implemented by plan 15. Source analog:
 * snf-client/src/.../confirmSwapHandlers.ts (`handleSwapNFTtoNFT`).
 */
export function buildNftToNft(
  ctx: SnfClientContext,
  args: BuildArgs,
): Promise<ExecutionPlan> {
  void ctx
  void args
  return notImplemented('buildNftToNft', '15')
}
