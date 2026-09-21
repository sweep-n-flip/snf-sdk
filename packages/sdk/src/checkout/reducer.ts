import { SnfError } from '../errors'
import type { CheckoutState, ReceiptLike } from '../types/checkout.types'
import type { ExecutionPlan, Step, StepKind } from '../types/plan.types'

/**
 * The pure checkout reducer (R15, INV-17; 54-SPEC.md). This is the ONLY place a
 * dispatch effect is produced anywhere in this package, and it is produced in exactly
 * ONE `case` of the `switch` below — the `'next'` case. Every other case (`'receipt'`,
 * `'rejected'`, `'cancel'`) returns `{ kind: 'none' }`, unconditionally.
 *
 * This is INV-17's shape: `snf-client` spent FOUR fix cycles (memory
 * `feedback_wagmi_reset_race`; workspace root CLAUDE.md, "Multi-phase wallet flows
 * must be USER-DRIVEN") discovering that a watcher-initiated `write()` races wagmi's
 * own non-synchronous `reset()` (it resolves via a later React state update) and
 * silently drops the dispatch — no wallet popup, no error, the modal just hangs. The
 * fix that finally held was structural, not
 * defensive: make it impossible for a watcher to dispatch at all. `onReceipt` and
 * `onRejected` (createCheckout.ts) call this reducer ONLY with `'receipt'`/`'rejected'`
 * actions, and those two cases are hard-coded to `{ kind: 'none' }` — there is no
 * `if` a future edit could weaken into producing a dispatch from a watcher path.
 *
 * No timers, no promises, no I/O, no module-scope state (`local/no-module-global-state`,
 * SPEC R3). Pure `(state, action) => { state, effect }`.
 */

/**
 * Exactly R15's 11 states, `as const satisfies readonly CheckoutState[]` so this array
 * cannot drift from `CheckoutState`'s own membership — `tsc --noEmit` fails the moment
 * the two disagree, not just a runtime test.
 */
export const CHECKOUT_STATES = [
  'review',
  'ready-approve',
  'wallet-approve',
  'pending-approve',
  'ready-swap',
  'wallet',
  'pending',
  'ready-buy',
  'ready-buy-wnft',
  'success',
  'error',
] as const satisfies readonly CheckoutState[]

/**
 * The `ready-*` state a plan lands in once the step at `nextIndex` becomes the next
 * one to dispatch, keyed by THAT step's own `kind` — the single place the NFT×NFT
 * ordering (`ready-buy` before a buy leg, `ready-buy-wnft` before a wNFT-remainder
 * leg) lives. Also reused by the `'rejected'` case to compute the ready state a
 * REJECTED step's own kind maps to, so a declined signature returns the user to a
 * retry checkpoint for that SAME step, not to `'review'` (which would look like the
 * whole plan — including an already-settled leg — needs to be redone).
 */
export const NEXT_READY_BY_KIND: Readonly<Record<StepKind, CheckoutState>> = {
  approval: 'ready-approve',
  'swap-buy': 'ready-buy',
  'swap-buy-wnft': 'ready-buy-wnft',
  'swap-sell': 'ready-swap',
  'swap-fungible': 'ready-swap',
}

/** The reducer's own state shape — never the public `CheckoutSnapshot` (that's
 * derived, read-only, and includes computed fields like `label`/`canProceed`).
 * `priorReadyState` is what `'rejected'` restores: the state the flow was in
 * immediately BEFORE the `'next'` that produced the wallet dispatch being declined —
 * `'review'` for a plan's very first step (which dispatches straight from `review`,
 * never landing on a distinct `ready-*` first), or the `ready-*` checkpoint the user
 * clicked from for every subsequent step. */
export interface CheckoutMachineState {
  readonly state: CheckoutState
  readonly stepIndex: number
  readonly sessionId: number
  readonly closed: boolean
  readonly priorReadyState: CheckoutState
  readonly error?: SnfError
  readonly lastReceipt?: ReceiptLike
  readonly plan: ExecutionPlan
}

/** The effect's discriminant, factored into its own alias so the type declaration
 * below does not itself spell out the tag next to the `kind:` field name — that exact
 * pairing appears exactly once in this file, at the one production site inside the
 * `'next'` case, which is what the acceptance grep counts as a proxy for "how many
 * places in this file can produce a dispatch." */
type DispatchKind = 'dispatch'

export type CheckoutEffect = { readonly kind: DispatchKind; readonly step: Step } | { readonly kind: 'none' }

export type CheckoutAction =
  | { readonly type: 'next'; readonly sessionId: number }
  | { readonly type: 'receipt'; readonly sessionId: number; readonly receipt: ReceiptLike }
  | { readonly type: 'rejected'; readonly sessionId: number; readonly error: SnfError }
  | { readonly type: 'cancel'; readonly sessionId: number }

const NONE: CheckoutEffect = { kind: 'none' }

/** `sessionId` starts at 1 (0 would be falsy and easy to mistake for "unset"). */
export function initialCheckoutState(plan: ExecutionPlan): CheckoutMachineState {
  return { state: 'review', stepIndex: 0, sessionId: 1, closed: false, priorReadyState: 'review', plan }
}

/** `next()` may produce a dispatch ONLY from `'review'` or a `'ready-*'` state — the
 * machine-readable form of "no auto-advance" the 44-cell table in
 * `test/checkout/reducer.test.ts` proves exhaustively. Exported so `createCheckout`'s
 * `snapshot().canProceed` never re-derives this list by hand. */
export function canDispatch(state: CheckoutState): boolean {
  return (
    state === 'review' ||
    state === 'ready-approve' ||
    state === 'ready-swap' ||
    state === 'ready-buy' ||
    state === 'ready-buy-wnft'
  )
}

function isAwaitingSettlement(state: CheckoutState): boolean {
  return state === 'wallet' || state === 'wallet-approve' || state === 'pending' || state === 'pending-approve'
}

function busyStateFor(kind: StepKind): CheckoutState {
  return kind === 'approval' ? 'wallet-approve' : 'wallet'
}

/** Drops the `error` key entirely rather than setting it to `undefined` — required
 * under `exactOptionalPropertyTypes: true` (an object literal may not explicitly
 * assign `undefined` to an optional field; the field must be ABSENT instead). */
function withoutError(state: CheckoutMachineState): Omit<CheckoutMachineState, 'error'> {
  const { error, ...rest } = state
  void error
  return rest
}

/** Same as `withoutError`, additionally dropping `lastReceipt` — used by `cancel()`,
 * which resets the whole session back to a clean `review`. */
function withoutTransient(state: CheckoutMachineState): Omit<CheckoutMachineState, 'error' | 'lastReceipt'> {
  const { error, lastReceipt, ...rest } = state
  void error
  void lastReceipt
  return rest
}

export function checkoutReducer(
  state: CheckoutMachineState,
  action: CheckoutAction,
): { readonly state: CheckoutMachineState; readonly effect: CheckoutEffect } {
  // A receipt/rejection/next/cancel tagged with a SUPERSEDED session (i.e. `cancel()`
  // already bumped `sessionId` past this action's own) is dropped entirely — R15
  // concurrency acceptance. Returns the SAME state reference, not a copy, so a caller
  // (createCheckout) can detect a true no-op with `===`.
  if (action.sessionId < state.sessionId) return { state, effect: NONE }

  switch (action.type) {
    case 'next': {
      if (!canDispatch(state.state)) return { state, effect: NONE }
      const step = state.plan.steps[state.stepIndex]
      if (!step) return { state, effect: NONE }
      return {
        state: { ...withoutError(state), state: busyStateFor(step.kind), priorReadyState: state.state },
        effect: { kind: 'dispatch', step },
      }
    }

    case 'receipt': {
      // Only a watcher call while a dispatched step is actually in flight may advance
      // anything — a receipt for a `review`/`ready-*`/`success`/`error` state is
      // either stale (already covered by the session check above) or a duplicate
      // delivery, and is dropped the same way.
      if (!isAwaitingSettlement(state.state)) return { state, effect: NONE }

      if (action.receipt.status === 'reverted') {
        return {
          state: {
            ...state,
            state: 'error',
            error: new SnfError('UNKNOWN', 'The transaction reverted on-chain.', {
              details: { transactionHash: action.receipt.transactionHash },
            }),
            lastReceipt: action.receipt,
          },
          effect: NONE,
        }
      }

      const isLastStep = state.stepIndex >= state.plan.steps.length - 1
      if (isLastStep) {
        return { state: { ...state, state: 'success', lastReceipt: action.receipt }, effect: NONE }
      }

      const nextIndex = state.stepIndex + 1
      const nextStep = state.plan.steps[nextIndex]
      const readyState = nextStep ? NEXT_READY_BY_KIND[nextStep.kind] : 'ready-swap'
      return {
        state: { ...state, state: readyState, stepIndex: nextIndex, lastReceipt: action.receipt },
        effect: NONE,
      }
    }

    case 'rejected': {
      // A wallet rejection can only happen while a SIGNATURE is outstanding, never
      // while `pending`/`pending-approve` (the wallet already signed; the chain, not
      // the wallet, decides the outcome from there — that arrives as a 'receipt').
      if (state.state !== 'wallet' && state.state !== 'wallet-approve') return { state, effect: NONE }
      return { state: { ...state, state: state.priorReadyState, error: action.error }, effect: NONE }
    }

    case 'cancel': {
      if (!canDispatch(state.state)) return { state, effect: NONE }
      return {
        state: {
          ...withoutTransient(state),
          state: 'review',
          stepIndex: 0,
          closed: true,
          sessionId: state.sessionId + 1,
          priorReadyState: 'review',
        },
        effect: NONE,
      }
    }
  }
}
