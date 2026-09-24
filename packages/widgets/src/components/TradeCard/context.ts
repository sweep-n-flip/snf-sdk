import { createContext, useContext } from 'react'
import type { TradeCardCheckoutContextValue, TradeCardRootContextValue } from './TradeCard.types'

/**
 * `context.ts` — the two React contexts `TradeCardRoot` (this plan) provides and every
 * later Part reads from. Mirrors
 * `packages/sdk-react/src/context.tsx`'s own error-on-missing-provider pattern for
 * `useTradeCardContext`, but `useTradeCardCheckout` deliberately does NOT throw — "no
 * plan yet" is a normal, expected state every consuming Part must handle on its own
 * (a quote hasn't resolved, or no recipient is connected yet), never a misuse.
 */

export const TradeCardRootContext = createContext<TradeCardRootContextValue | null>(null)
export const TradeCardCheckoutContext = createContext<TradeCardCheckoutContextValue | null>(null)

/**
 * Throws a plain `Error` — NOT `SnfError` (this is a widgets-internal programmer-misuse
 * error, not an SDK domain error) — naming `<SnfTradeCard.Root>` when called outside
 * one.
 */
export function useTradeCardContext(): TradeCardRootContextValue {
  const ctx = useContext(TradeCardRootContext)
  if (ctx === null) {
    throw new Error(
      'useTradeCardContext must be used within <SnfTradeCard.Root>. Every TradeCard part reads its state from the Root it is nested under.',
    )
  }
  return ctx
}

/**
 * Returns `null` when no `ExecutionPlan` exists yet (i.e. outside a mounted
 * `CheckoutMount` subtree) — a normal, expected state every consuming Part must
 * handle, never a thrown error.
 */
export function useTradeCardCheckout(): TradeCardCheckoutContextValue | null {
  return useContext(TradeCardCheckoutContext)
}
