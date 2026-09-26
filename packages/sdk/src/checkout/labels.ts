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
 * meaning is used.
 *
 * Liquidity steps (later additions) reuse `ready-swap` (see `checkout/reducer.ts`'s
 * `NEXT_READY_BY_KIND`) rather than growing a new state, so this is also where their
 * copy has to live: an `'add-liquidity'` step reads `step.quote.side` to tell a plain
 * deposit from the deposit that creates the pool, and a `'remove-liquidity'` step is
 * always a withdrawal. An LP approval reads as its own kind of approve, distinct from
 * a collection operator grant or an ERC-20 allowance raise — approving a Pair
 * contract for the Router to pull is a materially different action for a user to
 * understand than either of those.
 */
export function buildConfirmLabel(state: CheckoutState, step: Step | undefined): string {
  switch (state) {
    case 'review':
      return 'Review'
    case 'ready-approve': {
      const approvalKind = step?.approvals[0]?.kind
      if (approvalKind === 'lp-allowance') return 'Approve LP token'
      return approvalKind === 'erc20-allowance' ? 'Approve token spending' : 'Approve collection'
    }
    case 'ready-swap': {
      if (step?.kind === 'add-liquidity') {
        return step.quote.side === 'create-pool' ? 'Create pool' : 'Confirm deposit'
      }
      if (step?.kind === 'remove-liquidity') return 'Confirm withdrawal'
      return step?.kind === 'swap-fungible' ? 'Confirm swap' : 'Confirm sale'
    }
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
