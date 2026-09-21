import type { CheckoutState } from '../types/checkout.types'
import type { Step } from '../types/plan.types'

/**
 * The partner's button copy (R15) — ported from `snf-client/src/components/checkout/
 * hooks/buildCheckoutDerived.ts`'s `buildConfirmLabel`/`isBusyStep`, reduced from the
 * 18-member `CheckoutStep` union to this SDK's 11-state `CheckoutState`. A partner
 * may override these strings in their own UI; the defaults are usable as-is.
 */

/** One distinct, non-empty English label per dispatchable state (`review` plus the
 * four `ready-*` checkpoints) — the five states `checkout/reducer.ts`'s `canDispatch`
 * accepts a `next()` call from. `step` is accepted for forward compatibility (a
 * partner-facing override could key off the step being confirmed) but is not needed
 * by the default copy below, since each dispatchable STATE already names exactly what
 * happens next. */
export function buildConfirmLabel(state: CheckoutState, step: Step | undefined): string {
  void step
  switch (state) {
    case 'review':
      return 'Review'
    case 'ready-approve':
      return 'Approve collection'
    case 'ready-swap':
      return 'Confirm sale'
    case 'ready-buy':
      return 'Confirm purchase'
    case 'ready-buy-wnft':
      return 'Claim wNFT remainder'
    case 'wallet-approve':
    case 'wallet':
      return 'Waiting for wallet...'
    case 'pending-approve':
    case 'pending':
      return 'Confirming...'
    case 'success':
      return 'Done'
    case 'error':
      return 'Try again'
  }
}

/** True exactly for the four states in flight between a dispatch and its settlement —
 * mirrors `isBusyStep`'s exact member set, just renamed for the reduced union. */
export function isBusyState(state: CheckoutState): boolean {
  return state === 'wallet-approve' || state === 'pending-approve' || state === 'wallet' || state === 'pending'
}
