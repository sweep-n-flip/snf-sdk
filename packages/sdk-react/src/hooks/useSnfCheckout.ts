import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useSendTransaction, useWaitForTransactionReceipt } from 'wagmi'
import type { Checkout, CheckoutSnapshot, CheckoutState, ExecutionPlan, SnfError } from '@sweepnflip/sdk'
import { createCheckout } from '@sweepnflip/sdk/checkout'
import { useSnfContext } from '../context'

/**
 * The ONE dispatch site in either package (D-04, INV-17; 54-SPEC.md). `createCheckout`
 * (`@sweepnflip/sdk/checkout` — see `packages/sdk/tsup.config.ts` for why this is a
 * subpath rather than the main barrel: `createCheckout` was deliberately left off
 * `SnfClient`'s 13-method surface, not off the SDK entirely) returns a pure state
 * machine whose `next()` is the only member that can ever produce a `Step` to send —
 * every watcher path (`onReceipt`/`onRejected`) is structurally incapable of it
 * (`packages/sdk/src/checkout/reducer.ts`'s own header comment). This hook's job is
 * narrow: call `next()` from a user click, send whatever `Step` it returns via wagmi
 * IN THE SAME SYNCHRONOUS FRAME as `reset()`, and feed the resulting receipt/rejection
 * back through the watcher-only entry points — never the other way around.
 */

export interface UseSnfCheckoutResult {
  readonly state: CheckoutState
  readonly label: string
  readonly canProceed: boolean
  readonly next: () => Promise<void>
  readonly cancel: () => void
  readonly error: SnfError | undefined
  readonly txHash: `0x${string}` | undefined
}

/** `'wallet'`/`'wallet-approve'` are the core's own busy states, held from `next()`'s
 * dispatch until a receipt/rejection arrives — the reducer never enters a distinct
 * "signed, awaiting confirmation" state (`snf-54-08-SUMMARY.md`: "left available for
 * the React adapter to project as its own richer, wagmi-hook-derived UI state").
 * Once wagmi hands back a hash, THIS hook projects the busy state one step further —
 * the only display richness this file adds; the core snapshot itself never changes
 * because of it. */
function projectState(coreState: CheckoutState, hasHash: boolean): CheckoutState {
  if (!hasHash) return coreState
  if (coreState === 'wallet-approve') return 'pending-approve'
  if (coreState === 'wallet') return 'pending'
  return coreState
}

export function useSnfCheckout(plan: ExecutionPlan): UseSnfCheckoutResult {
  const { client, bumpInvalidation } = useSnfContext()
  const { sendTransactionAsync, reset } = useSendTransaction()

  // One `Checkout` session per `plan` IDENTITY — a re-render with the SAME plan
  // reference never restarts the machine (this plan's own instruction). `store`
  // pairs the session with its OWN cached snapshot atomically, so a new `plan` (a
  // brand-new session) never sees a stale snapshot left over from the previous one.
  const store = useMemo(() => {
    const session: Checkout = createCheckout(plan)
    let cached: CheckoutSnapshot = session.snapshot()
    const subscribe = (onStoreChange: () => void): (() => void) =>
      session.subscribe(() => {
        cached = session.snapshot()
        onStoreChange()
      })
    const getSnapshot = (): CheckoutSnapshot => cached
    return { session, subscribe, getSnapshot }
  }, [plan])

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  const [txHash, setTxHash] = useState<`0x${string}` | undefined>(undefined)
  // A fresh session (new `plan`) never inherits the previous session's in-flight hash.
  useEffect(() => setTxHash(undefined), [store])

  const mountedRef = useRef(true)
  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Guards against processing the SAME hash's receipt twice (e.g. a re-render while
  // `isSuccess` stays true) — never a gate on WHICH hash may dispatch (that's the
  // session's own `canDispatch`, already proven by the double-click test).
  const processedHashRef = useRef<`0x${string}` | undefined>(undefined)

  const receiptQuery = useWaitForTransactionReceipt({ hash: txHash })

  const next = useCallback(async (): Promise<void> => {
    const step = store.session.next()
    if (step === null) return
    // `reset()` is async via React state — if the next wagmi dispatch fired from a
    // LATER effect, wagmi could still see the previous mutation's `success`/`error`
    // and silently drop it (no popup, no error; memory `feedback_wagmi_reset_race`,
    // INV-17). `reset()` and the dispatch call below are both invoked synchronously,
    // in this same callback frame, before control ever returns to React — no
    // `useEffect` in this file ever initiates a wagmi mutation.
    reset()
    try {
      const tx = step.tx
      const hash = await sendTransactionAsync(
        tx.gas === undefined
          ? { to: tx.to, data: tx.data, value: tx.value, chainId: tx.chainId }
          : { to: tx.to, data: tx.data, value: tx.value, chainId: tx.chainId, gas: tx.gas },
      )
      if (!mountedRef.current) return
      // A fresh dispatch is always eligible for its OWN receipt — even a test (or,
      // in principle, a chain that ever produced two identical hash strings) that
      // hands back the SAME hash value on a later step must not skip processing
      // because `processedHashRef` still remembers a same-valued hash from a
      // PRIOR step's already-settled receipt.
      processedHashRef.current = undefined
      setTxHash(hash)
    } catch (err) {
      if (!mountedRef.current) return
      store.session.onRejected(client.describeError(err))
    }
  }, [store, reset, sendTransactionAsync, client])

  // The receipt WATCHER — reachable from `useWaitForTransactionReceipt` only. It may
  // call `onReceipt`/`onRejected` (watcher-only, structurally cannot dispatch — see
  // `createCheckout.ts`'s own invariant guard) and NOTHING else. No branch below ever
  // calls `next` or initiates a wagmi mutation.
  useEffect(() => {
    if (txHash === undefined || processedHashRef.current === txHash) return

    if (receiptQuery.isSuccess && receiptQuery.data !== undefined) {
      processedHashRef.current = txHash
      if (!mountedRef.current) return
      const receipt = receiptQuery.data
      // Deliberately UN-annotated (no `: ReceiptLike`) — `@sweepnflip/sdk`'s public
      // barrel only exports `checkout.types.ts`'s `ReceiptLike` (`logs: readonly
      // unknown[]`, plan 04's original placeholder), while `SnfClient.parseReceipt`'s
      // signature was later widened (plan 08) to the STRICTER, unexported `receipt/
      // receipt.types.ts` `ReceiptLike` (`logs: readonly Log[]`) — two same-named,
      // structurally different types the core never reconciled (out of this plan's
      // scope: `packages/sdk/src` is not editable here). `receipt.logs` is viem's
      // REAL `Log[]` (from `useWaitForTransactionReceipt`), so leaving this object
      // literal's type to be INFERRED lets it satisfy both `onReceipt`'s looser
      // parameter and `parseReceipt`'s stricter one — an explicit annotation to
      // either named `ReceiptLike` would only narrow it to ONE of the two call sites.
      const receiptLike = {
        status: receipt.status,
        transactionHash: receipt.transactionHash,
        blockNumber: receipt.blockNumber,
        logs: receipt.logs,
      }
      store.session.onReceipt(receiptLike)
      setTxHash(undefined)
      if (store.session.snapshot().state === 'success') {
        client.parseReceipt(receiptLike)
        bumpInvalidation()
      }
      return
    }

    if (receiptQuery.isError) {
      processedHashRef.current = txHash
      if (!mountedRef.current) return
      store.session.onRejected(client.describeError(receiptQuery.error))
      setTxHash(undefined)
    }
  }, [txHash, receiptQuery.isSuccess, receiptQuery.data, receiptQuery.isError, receiptQuery.error, store, client, bumpInvalidation])

  const cancel = useCallback(() => store.session.cancel(), [store])

  return {
    state: projectState(snapshot.state, txHash !== undefined),
    label: snapshot.label,
    canProceed: snapshot.canProceed,
    next,
    cancel,
    error: snapshot.error,
    txHash,
  }
}
