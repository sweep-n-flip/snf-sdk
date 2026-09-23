import type { ReactNode } from 'react'
import type { ExecutionPlan, Quote, SnfError } from '@sweepnflip/sdk'
import type {
  UseSnfCheckoutResult,
  UseSnfCollectionResult,
  UseSnfPoolInventoryResult,
} from '@sweepnflip/sdk-react'
import type { SnfWidgetMessages } from '../../messages.types'

/**
 * `TradeCard.types.ts` — the props and context-value shapes `TradeCardRoot` (this
 * plan) builds and every later Part (plan 05) reads from (R4). No behaviour lives
 * here; every shape is a plain data contract.
 */

/** The three sides `<SnfTradeCard.Root>` supports (R4). */
export type SnfTradeSide = 'buy' | 'sell' | 'nft-to-nft'

/**
 * Props for `<SnfTradeCard.Root>`. `collection`/`recipient` are REQUIRED keys whose
 * VALUE may be `undefined` (a partner still resolving a wallet connection or a typed
 * address) — this mirrors `examples/next-app/src/components/SwapPanel.tsx`'s own
 * `validCollection`/`address` pattern, and is deliberately distinct from the truly
 * OPTIONAL fields below (`buyCollection`/`count`/`tokenIds`/`remainder`), which may be
 * omitted entirely because they simply do not apply to every side.
 */
export interface SnfTradeCardRootProps {
  readonly side: SnfTradeSide
  /** The sell-side collection on `nft-to-nft`; the only collection on `buy`/`sell`. */
  readonly collection: `0x${string}` | undefined
  /** `nft-to-nft` only — the collection being bought. */
  readonly buyCollection?: `0x${string}`
  /** Buy count, or `nft-to-nft` buy count. */
  readonly count?: number
  /** Sell tokenIds, or `nft-to-nft` sell tokenIds. */
  readonly tokenIds?: readonly string[]
  /** `nft-to-nft` only. Default `'native'` is applied INSIDE the component, not here. */
  readonly remainder?: 'native' | 'wnft'
  readonly recipient: `0x${string}` | undefined
  readonly messages?: SnfWidgetMessages
  readonly className?: string
  readonly asChild?: boolean
  readonly children: ReactNode
}

/**
 * A narrow STRUCTURAL type — deliberately NOT a union of `UseSnfQuoteBuyResult |
 * UseSnfQuoteSellResult | UseSnfQuoteNftToNftResult`. Those three are nominally
 * distinct exported types, but structurally identical in every field this package
 * needs. `TradeCardRoot` selects exactly one of the three hook results per render
 * based on `side` — typing that selection as this structural shape avoids a
 * three-way union propagating into every later Part that reads `quote` off context.
 */
export interface QuoteQueryResult {
  readonly data: Quote | undefined
  readonly error: SnfError | null
  readonly isLoading: boolean
  readonly isFetching: boolean
  readonly dataUpdatedAt: number
}

/** Everything `TradeCardRoot` resolves before a plan exists — exposed via
 * `TradeCardRootContext` (R4, D-07). */
export interface TradeCardRootContextValue {
  readonly side: SnfTradeSide
  readonly collectionInfo: UseSnfCollectionResult
  /** Populated buy-side only — `undefined` on `sell`/`nft-to-nft` even though the
   * underlying `useSnfPoolInventory` hook is always called (Rules of Hooks), gated
   * via its own `enabled` option. */
  readonly inventory: UseSnfPoolInventoryResult | undefined
  readonly quote: QuoteQueryResult
  readonly planQuery: {
    readonly data: ExecutionPlan | undefined
    readonly error: SnfError | null
    readonly isLoading: boolean
  }
  readonly messages: SnfWidgetMessages | undefined
}

/**
 * The exact shape `useSnfCheckout` returns — a type ALIAS, never redeclared field by
 * field, so this package can never silently drift from the SDK's own contract (D-07:
 * the eleven `CheckoutState` values are never re-enumerated anywhere in this
 * package).
 */
export type TradeCardCheckoutContextValue = UseSnfCheckoutResult
