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
 * plan) builds and every later Part reads from. No behaviour lives
 * here; every shape is a plain data contract.
 */

/** The three sides `<SnfTradeCard.Root>` supports. */
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

/**
 * A later addition — not the original `TradeCardRootContextValue` shape. A
 * plain passthrough of the subset of `SnfTradeCardRootProps` `TradeCardInput` needs to
 * display BEFORE a quote resolves — `count`/`tokenIds` are not otherwise visible to a
 * Part, which only ever reads context, never Root's raw props.
 */
export interface TradeCardParams {
  readonly count?: number
  readonly tokenIds?: readonly string[]
  readonly buyCollection?: string
  readonly remainder?: 'native' | 'wnft'
}

/** Everything `TradeCardRoot` resolves before a plan exists — exposed via
 * `TradeCardRootContext`. */
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
  /** A later addition — see `TradeCardParams`'s own header comment. */
  readonly params: TradeCardParams
}

/**
 * The exact shape `useSnfCheckout` returns — a type ALIAS, never redeclared field by
 * field, so this package can never silently drift from the SDK's own contract (the
 * eleven `CheckoutState` values are never re-enumerated anywhere in this
 * package).
 */
export type TradeCardCheckoutContextValue = UseSnfCheckoutResult

/**
 * A part's `children` may be a plain node/element/`undefined`
 * (rendered as-is, or the single substitution target `Slot` clones when `asChild` is
 * set) OR a function receiving the relevant context slice for fully custom rendering —
 * the second acceptance path names ("or a render prop"). Shared by every Part
 * (`Input`/`QuoteBreakdown`/`Steps`/`Action`), parameterized by whatever
 * slice each Part's function `children` actually receives.
 */
export type RenderPropChildren<T> = ReactNode | ((ctx: T) => ReactNode)

/** Shared `className`/`asChild` pair every Part in this plan carries, alongside its
 * own `RenderPropChildren<T>`-typed `children`. Not a generic interface on its own
 * (TypeScript cannot express `extends` over a type alias's generic cleanly across four
 * differently-shaped `T`s) — each Part below spells the same three fields with its own
 * `T`, mirroring `PoolStatsPartProps`'s precedent of one shared shape per compound
 * component, here split per-Part because each Part's render-prop slice differs. */
export interface TradeCardInputProps {
  readonly className?: string
  readonly asChild?: boolean
  readonly children?: RenderPropChildren<TradeCardRootContextValue>
}

export interface TradeCardQuoteBreakdownProps {
  readonly className?: string
  readonly asChild?: boolean
  readonly children?: RenderPropChildren<TradeCardRootContextValue>
}

/** `TradeCardSteps`/`TradeCardAction` additionally need the live checkout snapshot (or
 * `null` before a plan exists) — bundled alongside the root context as one object so a
 * render-prop caller destructures a single argument either way. */
export interface TradeCardCheckoutRenderProps {
  readonly context: TradeCardRootContextValue
  readonly checkout: TradeCardCheckoutContextValue | null
}

export interface TradeCardStepsProps {
  readonly className?: string
  readonly asChild?: boolean
  readonly children?: RenderPropChildren<TradeCardCheckoutRenderProps>
}

export interface TradeCardActionProps {
  readonly className?: string
  readonly asChild?: boolean
  readonly children?: RenderPropChildren<TradeCardCheckoutRenderProps>
}
