import { createContext, useContext } from 'react'
import type { PoolStatsContextValue } from './PoolStats.types'

/**
 * `context.ts` — the one React context `PoolStatsRoot` provides and every Part
 * (`Price`/`Reserves`/`Ceiling`) reads from. Mirrors `TradeCard/context.ts`'s
 * own `useTradeCardContext` shape: throws a plain `Error` (not `SnfError` —
 * this is a widgets-internal programmer-misuse error, not an SDK domain error) naming
 * `<SnfPoolStats.Root>` when called outside one. `PoolStats` has no checkout mount (it
 * is read-only), so there is only ever this one context — no second, nullable
 * "may not exist yet" context like `TradeCardCheckoutContext`.
 */

export const PoolStatsContext = createContext<PoolStatsContextValue | null>(null)

/** Throws a plain `Error` naming `<SnfPoolStats.Root>` when called outside one. */
export function usePoolStatsContext(): PoolStatsContextValue {
  const ctx = useContext(PoolStatsContext)
  if (ctx === null) {
    throw new Error(
      'usePoolStatsContext must be used within <SnfPoolStats.Root>. Every PoolStats part reads its state from the Root it is nested under.',
    )
  }
  return ctx
}
