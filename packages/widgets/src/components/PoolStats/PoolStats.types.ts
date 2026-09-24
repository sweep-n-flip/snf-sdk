import type { ReactNode } from 'react'
import type { PoolRef } from '@sweepnflip/sdk'
import type { UseSnfCollectionResult, UseSnfPoolInventoryResult } from '@sweepnflip/sdk-react'
import type { QuoteQueryResult } from '../TradeCard/TradeCard.types'
import type { SnfWidgetMessages } from '../../messages.types'

/**
 * `PoolStats.types.ts` — the props and context-value shapes `PoolStatsRoot` (this
 * plan) builds and every later Part (`Price`/`Reserves`/`Ceiling`, also this plan)
 * reads from. No behaviour lives here; every shape is a plain data contract.
 *
 * `QuoteQueryResult` is imported verbatim from `../TradeCard/TradeCard.types` (plan
 * 04) rather than redeclared here — CLAUDE.md's "reuse shared types" rule. It is the
 * same structural shape both `<SnfTradeCard>` and `<SnfPoolStats>` need from any of the
 * `useSnfQuote*` hooks' return values.
 */

/** Props for `<SnfPoolStats.Root>`. `collection` is a REQUIRED key whose VALUE may be
 * `undefined` (a partner still resolving a typed address) — mirrors
 * `SnfTradeCardRootProps.collection`'s own pattern. */
export interface SnfPoolStatsRootProps {
  readonly collection: `0x${string}` | undefined
  readonly messages?: SnfWidgetMessages
  readonly className?: string
  readonly asChild?: boolean
  readonly children: ReactNode
}

/** Everything `PoolStatsRoot` resolves for one collection, exposed via
 * `PoolStatsContext`. */
export interface PoolStatsContextValue {
  readonly collectionInfo: UseSnfCollectionResult
  /** The collection's first pool, or `undefined` when it has none yet (a valid,
   * honest state — never an error). */
  readonly pool: PoolRef | undefined
  readonly inventory: UseSnfPoolInventoryResult
  /** The SDK's own on-chain-reconciled quote for exactly one unit
   * (`useSnfQuoteBuy({ collection, count: 1 })`) — see `PoolStatsRoot.tsx`'s header
   * comment for the full resolution this field feeds. */
  readonly priceQuote: QuoteQueryResult
  readonly messages: SnfWidgetMessages | undefined
}

/**
 * The render-prop-or-default `children` shape every PoolStats Part
 * (`Price`/`Reserves`/`Ceiling`) shares, plus `className`/`asChild`. `children`
 * may be omitted (the Part renders its own default content), a plain element (used
 * as-is in the non-`asChild` case, or as the single substitution target `Slot` clones
 * when `asChild` is set), or a function receiving the live `PoolStatsContextValue` for
 * fully custom rendering.
 *
 * KNOWN DUPLICATION (not fixed here): the sibling `TradeCard.types.ts` does not yet
 * declare an equivalent shared type (that would be
 * this module's `RenderPropChildren`, mirroring the pointers to
 * `TradeCardQuoteBreakdown.tsx`/`TradeCardInput.tsx`) — whichever of the two component
 * directories lands its shared shape second
 * should consolidate the two identical shapes into one shared declaration, imported by
 * both component directories, rather than guessing at the other's file
 * layout ahead of time.
 */
export interface PoolStatsPartProps {
  readonly className?: string
  readonly asChild?: boolean
  readonly children?: ReactNode | ((ctx: PoolStatsContextValue) => ReactNode)
}
