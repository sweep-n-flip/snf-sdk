import { notImplemented } from '../internal/stub'
import type { Checkout } from '../types/checkout.types'
import type { ExecutionPlan } from '../types/plan.types'

/**
 * Headless, user-driven checkout state machine over an `ExecutionPlan` (R15, INV-17).
 * Takes no `ctx` — it operates purely on the plan's own `steps[]`; this is why it is
 * NOT one of `SnfClient`'s 13 methods (D-01) and is instead a standalone export.
 * `next()` is the only member that may return a step to dispatch; a watcher calling
 * `onReceipt` may only advance state, never itself dispatch a transaction.
 *
 * @gsd-stub — implemented by plan 08. Source analog:
 * snf-client/src/components/checkout/checkout.types.ts + confirmSwapHandlers.ts
 * (`handleSwapNFTtoNFT`).
 */
export function createCheckout(plan: ExecutionPlan): Checkout {
  void plan
  return notImplemented('createCheckout', '08')
}
