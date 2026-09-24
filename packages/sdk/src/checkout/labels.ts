import type { CheckoutState } from '../types/checkout.types'
import type { Step } from '../types/plan.types'

/**
 * The partner's button copy — ported from the production AMM client's own
 * `buildConfirmLabel`/`isBusyStep` derivation, reduced from the
 * 18-member `CheckoutStep` union to this SDK's 11-state `CheckoutState`. A partner
 * may override these strings in their own UI; the defaults are usable as-is.
 */

/** One distinct, non-empty English label per dispatchable state (`review` plus the
 * four `ready-*` checkpoints) — the five states `checkout/reducer.ts`'s `canDispatch`
 * accepts a `next()` call from. Two states cover more than one kind of step, so the
 * copy also reads `step` when it is known: `ready-approve` is either a collection
 * approval (sell) or an ERC-20 spending allowance (ERC-20-base buy), and `ready-swap`
 * is either an NFT sale or a fungible swap. Without a step the state's most common
 * meaning is used. */
export function buildConfirmLabel(state: CheckoutState, step: Step | undefined): string {
  switch (state) {
    case 'review':
      return 'Review'
    case 'ready-approve':
      return step?.approvals[0]?.kind === 'erc20-allowance' ? 'Approve token spending' : 'Approve collection'
    case 'ready-swap':
      return step?.kind === 'swap-fungible' ? 'Confirm swap' : 'Confirm sale'
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
