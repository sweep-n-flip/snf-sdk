/**
 * `auto-advance-violation.ts` — the DELIBERATE anti-pattern this package's own
 * documented prohibitions forbid, kept ONLY as a test subject for
 * `test/prohibitions/no-auto-advance.test.ts` (`SNF_SDK_PROHIB_SUBJECT`). MUST NEVER
 * be imported by `src/` (see `caller-price-violation.ts`'s identical header note).
 *
 * This is the exact failure mode multi-phase wallet flows must never fall into: a
 * reducer-LIKE function that ALSO produces a dispatch effect from the `'receipt'` action when
 * `status === 'success'` — i.e. a watcher observing a mined transaction fires the
 * NEXT transaction itself, instead of waiting for an explicit user-driven `next()`.
 * Same exported name (`checkoutReducer`) and the same `(state, action)` calling
 * convention as the real `src/checkout/reducer.ts` — a genuine drop-in for the one
 * case this test exercises (a 'receipt' action arriving while a step is in flight).
 */
import type { CheckoutState } from '../../../src/types/checkout.types'
import type { ExecutionPlan, Step } from '../../../src/types/plan.types'

export interface CheckoutMachineStateLike {
  readonly state: CheckoutState
  readonly stepIndex: number
  readonly sessionId: number
  readonly plan: ExecutionPlan
}

export type CheckoutEffectLike = { readonly kind: 'dispatch'; readonly step: Step } | { readonly kind: 'none' }

export type CheckoutActionLike =
  | { readonly type: 'next'; readonly sessionId: number }
  | { readonly type: 'receipt'; readonly sessionId: number; readonly receipt: { readonly status: 'success' | 'reverted' } }
  | { readonly type: 'rejected'; readonly sessionId: number }
  | { readonly type: 'cancel'; readonly sessionId: number }

const NONE: CheckoutEffectLike = { kind: 'none' }

export function checkoutReducer(
  state: CheckoutMachineStateLike,
  action: CheckoutActionLike,
): { readonly state: CheckoutMachineStateLike; readonly effect: CheckoutEffectLike } {
  if (action.type === 'receipt' && action.receipt.status === 'success') {
    // THE VIOLATION: a watcher-only action ('receipt') dispatches the NEXT step
    // itself, instead of waiting for an explicit user-driven `next()` call.
    const nextIndex = state.stepIndex + 1
    const nextStep = state.plan.steps[nextIndex]
    if (nextStep) {
      return { state: { ...state, stepIndex: nextIndex }, effect: { kind: 'dispatch', step: nextStep } }
    }
  }
  return { state, effect: NONE }
}
