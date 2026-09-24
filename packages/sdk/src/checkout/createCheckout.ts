import { canDispatch, checkoutReducer, initialCheckoutState } from './reducer'
import { buildConfirmLabel } from './labels'
import type { Checkout, CheckoutEvent, CheckoutSnapshot, ReceiptLike } from '../types/checkout.types'
import type { ExecutionPlan, Step } from '../types/plan.types'
import { SnfError } from '../errors'

/**
 * Headless, user-driven checkout state machine over an `ExecutionPlan`.
 * Takes no `ctx` — it operates purely on the plan's own `steps[]`; this is why it is
 * NOT one of `SnfClient`'s 13 methods and is instead a standalone export.
 *
 * `next()` is the ONLY member that may return a step to dispatch. `onReceipt`/
 * `onRejected` are watcher-only entry points — a caller wires them to whatever
 * receipt/rejection signal their OWN wallet library produces (wagmi's
 * `useWaitForTransactionReceipt`, a raw `publicClient.waitForTransactionReceipt`,
 * etc.); this module never touches a wallet client itself (prohibition #1).
 * The React adapter (`useSnfCheckout`) is the one place `sendTransaction`/
 * `writeContract` is actually called — this file only ever hands back the `Step` to
 * send and reads back what happened.
 *
 * All state is closed over inside this factory — `local/no-module-global-state`
 * requires it, and it is also what makes two `createCheckout(plan)` calls fully
 * independent sessions with independent `sessionId`s (Concurrency acceptance).
 */
export function createCheckout(plan: ExecutionPlan): Checkout {
  let machine = initialCheckoutState(plan)
  // The sessionId that was ACTIVE at the moment the currently in-flight step (if any)
  // was dispatched. `cancel()` bumps `machine.sessionId` but never this — so a
  // receipt/rejection captured under the OLD session compares as stale against the
  // reducer's own `action.sessionId < state.sessionId` check, exactly the way a
  // closure captured at dispatch time would in a React watcher (Concurrency).
  let openSessionId = machine.sessionId
  let invalidationVersion = 0
  const listeners = new Set<(event: CheckoutEvent) => void>()

  function emit(event: CheckoutEvent): void {
    for (const listener of listeners) listener(event)
  }

  function snapshot(): CheckoutSnapshot {
    return Object.freeze({
      state: machine.state,
      stepIndex: machine.stepIndex,
      label: buildConfirmLabel(machine.state, machine.plan.steps[machine.stepIndex]),
      canProceed: canDispatch(machine.state),
      sessionId: machine.sessionId,
      // `exactOptionalPropertyTypes: true` forbids explicitly assigning `undefined` to
      // an optional field — the key must be ABSENT rather than present-with-undefined.
      ...(machine.error !== undefined ? { error: machine.error } : {}),
      txInvalidationVersion: invalidationVersion,
    })
  }

  function next(): Step | null {
    const result = checkoutReducer(machine, { type: 'next', sessionId: machine.sessionId })
    machine = result.state
    if (result.effect.kind !== 'dispatch') return null
    // The dispatch succeeded — THIS session now owns whatever receipt/rejection
    // eventually arrives for the step just handed back.
    openSessionId = machine.sessionId
    emit({ type: 'dispatched', step: result.effect.step })
    return result.effect.step
  }

  function cancel(): void {
    const before = machine
    machine = checkoutReducer(machine, { type: 'cancel', sessionId: machine.sessionId }).state
    if (machine !== before) emit({ type: 'cancelled' })
  }

  function onReceipt(receipt: ReceiptLike): void {
    const before = machine
    const result = checkoutReducer(machine, { type: 'receipt', sessionId: openSessionId, receipt })
    // Structural invariant: a watcher path must NEVER be able to produce a
    // dispatch. The reducer's `'receipt'` case is hard-coded to never do so — this is
    // a loud failure that beats a silent extra transaction if that ever regresses.
    if (result.effect.kind === 'dispatch') {
      throw new SnfError('UNKNOWN', 'invariant: a receipt watcher produced a dispatch step')
    }
    machine = result.state
    if (machine === before) return
    invalidationVersion += 1
    emit({ type: 'receipt', receipt })
  }

  function onRejected(error: SnfError): void {
    const before = machine
    const result = checkoutReducer(machine, { type: 'rejected', sessionId: openSessionId, error })
    if (result.effect.kind === 'dispatch') {
      throw new SnfError('UNKNOWN', 'invariant: a rejection watcher produced a dispatch step')
    }
    machine = result.state
    if (machine === before) return
    emit({ type: 'rejected', error })
  }

  function subscribe(fn: (event: CheckoutEvent) => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  return { snapshot, next, cancel, onReceipt, onRejected, subscribe }
}
