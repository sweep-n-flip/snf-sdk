import { useMemo, type ReactElement, type ReactNode } from 'react'
import { useSnfCollection, useSnfPoolInventory, useSnfQuoteBuy } from '@sweepnflip/sdk-react'
import { mergeClassNames } from '../../internal/classNames'
import { toDataAttrs } from '../../internal/dataState'
import { Slot } from '../../internal/slot'
import { PoolStatsContext } from './context'
import type { PoolStatsContextValue, SnfPoolStatsRootProps } from './PoolStats.types'

/**
 * `PoolStatsRoot` — orchestrates one collection's pool, inventory and one-unit price
 * for `<SnfPoolStats>`. Entirely read-only: no plan, no checkout, no
 * dispatch path anywhere in this file — `local/no-effect-dispatch` and
 * `local/no-signing-imports` have nothing to catch here, which is itself the expected
 * shape of this component, not a false-negative to worry about.
 *
 * **Price resolution, binding on this component (as amended 2026-09-23) —
 * stated here in full so a future reader never mistakes the omission of a ratio-based
 * figure for an oversight.** This component calls `useSnfQuoteBuy({ collection, count:
 * 1 })` — the SDK's own on-chain-reconciled quote for exactly one unit, gated on a real
 * `collection` prop. `PoolStatsPrice` (the Part that reads this context) renders two
 * SEPARATE figures straight off that quote, both real `Amount` values used verbatim via
 * `.formatted`/`.symbol`: the pool-only price for one NFT (`legs[0]?.amount` — what the
 * AMM curve itself would charge before fees) as the primary figure, and the all-in cost
 * including the marketplace fee (`totalCost`) as a second, separately-labelled figure.
 * Neither figure — nor anything else in this component tree — is ever computed by
 * dividing `reserves.base` by `reserves.wnft`. That ratio carries a distinct, precise
 * meaning in this protocol (a bare curve-and-fee-free reserve ratio) that neither of
 * these two SDK-returned figures is, and this kit has no accessor for it and never
 * derives one client-side.
 *
 * No `'use client'` directive — same rationale as `TradeCardRoot.tsx`: this
 * is a framework-agnostic package, and that directive is an App Router convention
 * belonging at a consuming app's own boundary, not inside this package.
 */
export function PoolStatsRoot(props: SnfPoolStatsRootProps): ReactNode {
  const collectionInfo = useSnfCollection(props.collection)
  // `noUncheckedIndexedAccess` already types `pools[0]` as `PoolRef | undefined` — a
  // collection with no pool yet is a valid, honest state, never an error.
  const pool = collectionInfo.data?.pools[0]

  // Unconditional call — the hook's own `enabled` option (gated on `pair !==
  // undefined` internally) already handles the "no pool yet" case. PoolStats only
  // ever needs one inventory read for the one collection it is given, unlike
  // TradeCard's per-side gating across three possible trade sides.
  const inventory = useSnfPoolInventory(pool?.pair)

  const priceQuoteArgs = props.collection === undefined ? undefined : { collection: props.collection, count: 1 }
  const priceQuote = useSnfQuoteBuy(priceQuoteArgs)

  const contextValue = useMemo<PoolStatsContextValue>(
    () => ({ collectionInfo, pool, inventory, priceQuote, messages: props.messages }),
    [collectionInfo, pool, inventory, priceQuote, props.messages],
  )

  const state: 'idle' | 'loading' | 'error' | 'ready' = collectionInfo.isLoading
    ? 'loading'
    : collectionInfo.error
      ? 'error'
      : 'ready'

  const mergedClassName = mergeClassNames(props.className)
  const dataAttrs = toDataAttrs({ part: 'stats-root', state })

  // `SlotProps.className` is `?: string` (no explicit `| undefined`) —
  // `exactOptionalPropertyTypes: true` forbids passing an explicit `undefined` to it,
  // so the key is spread in only when actually defined (same pattern as
  // `TradeCardRoot.tsx`).
  const slotProps = { ...dataAttrs, ...(mergedClassName === undefined ? {} : { className: mergedClassName }) }

  const rootElement: ReactNode = props.asChild ? (
    <Slot {...slotProps}>
      {/* asChild's documented contract (AsChildProps, packages/widgets/src/internal/
          slot.types.ts): the caller passes exactly one element when asChild is true.
          Slot's own runtime isValidElement check is the actual safety net; this cast
          only satisfies the wider `ReactNode` type `children` carries for the
          non-asChild case. */}
      {props.children as ReactElement}
    </Slot>
  ) : (
    <div className={mergedClassName} {...dataAttrs}>
      {props.children}
    </div>
  )

  return <PoolStatsContext.Provider value={contextValue}>{rootElement}</PoolStatsContext.Provider>
}
