import { useMemo, type ReactElement, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { ExecutionPlan, SnfError } from '@sweepnflip/sdk'
import {
  useSnfCheckout,
  useSnfClient,
  useSnfCollection,
  useSnfPoolInventory,
  useSnfQuoteBuy,
  useSnfQuoteNftToNft,
  useSnfQuoteSell,
} from '@sweepnflip/sdk-react'
import { mergeClassNames } from '../../internal/classNames'
import { toDataAttrs } from '../../internal/dataState'
import { Slot } from '../../internal/slot'
import { TradeCardCheckoutContext, TradeCardRootContext } from './context'
import type { QuoteQueryResult, SnfTradeCardRootProps, TradeCardRootContextValue } from './TradeCard.types'

/**
 * `TradeCardRoot` — the state-orchestration heart of `<SnfTradeCard>` (R4, R8, D-07).
 * It resolves the collection, fetches the right quote, builds and preflights an
 * `ExecutionPlan` once a quote exists, and mounts the checkout hook only once that
 * plan is ready — exposing all of it through two React contexts. It adds NO state
 * machine of its own: plan-building is one `useQuery` (ordinary cached data-fetching,
 * exactly like every other `useSnf*` hook — building an unsigned plan and preflighting
 * it are both read-only SDK calls), and checkout state comes verbatim from that hook's
 * own snapshot. The eleven `CheckoutState` values are never re-enumerated anywhere in
 * this file — only read off `@sweepnflip/sdk-react`'s own return shape.
 *
 * No `'use client'` directive: this file uses hooks, which already require a client
 * boundary somewhere in a consuming Next.js App Router tree, but that directive is an
 * App Router convention belonging at THAT app's own boundary, not inside a
 * framework-agnostic package — `packages/sdk-react/src/context.tsx` carries no client
 * directive either, and this file follows that precedent.
 */

const PLAN_QUERY_TAG = 'snf-widgets-trade-card-plan'

function CheckoutMount(props: { readonly plan: ExecutionPlan; readonly children: ReactNode }): ReactNode {
  // The ONLY call to the checkout hook in this file (R8, D-07). Legal despite Rules
  // of Hooks' ban on conditional hook calls because CheckoutMount only ever exists as
  // a distinct component instance once TradeCardRoot conditionally RENDERS it (a plan
  // exists) — never a conditional call to the hook itself inside one component body.
  const checkout = useSnfCheckout(props.plan)
  return <TradeCardCheckoutContext.Provider value={checkout}>{props.children}</TradeCardCheckoutContext.Provider>
}

export function TradeCardRoot(props: SnfTradeCardRootProps): ReactNode {
  const client = useSnfClient()

  const collectionInfo = useSnfCollection(props.collection)
  // `noUncheckedIndexedAccess` already types `pools[0]` as `PoolRef | undefined` — the
  // wrapper can be either pool side, but only `.pair` is needed to read inventory.
  const pair = collectionInfo.data?.pools[0]?.pair

  const inventoryResult = useSnfPoolInventory(pair, { enabled: props.side === 'buy' })
  // Populated buy-side only on the CONTEXT VALUE, even though the hook itself is
  // always called unconditionally above (Rules of Hooks) — the other two sides never
  // needed a pool inventory read in the first place.
  const inventory = props.side === 'buy' ? inventoryResult : undefined

  // All three quote hooks are called unconditionally on every render (Rules of
  // Hooks) — each gated by its own `enabled` option on top of its own internal
  // args-readiness check, so only the active side's hook ever actually fires a
  // request (T-56-09). `exactOptionalPropertyTypes: true` forbids passing an
  // explicit `{ key: undefined }` to an optional target field, so each optional key
  // below is spread in only when actually defined, never assigned `undefined`.
  const buyArgs =
    props.collection === undefined
      ? undefined
      : {
          collection: props.collection,
          ...(props.count === undefined ? {} : { count: props.count }),
          ...(props.tokenIds === undefined ? {} : { tokenIds: props.tokenIds }),
        }
  const quoteBuy = useSnfQuoteBuy(buyArgs, { enabled: props.side === 'buy' })

  const sellArgs =
    props.collection === undefined
      ? undefined
      : {
          collection: props.collection,
          ...(props.tokenIds === undefined ? {} : { tokenIds: props.tokenIds }),
          ...(props.count === undefined ? {} : { count: props.count }),
        }
  const quoteSell = useSnfQuoteSell(sellArgs, { enabled: props.side === 'sell' })

  const nftToNftArgs =
    props.collection !== undefined &&
    props.buyCollection !== undefined &&
    props.tokenIds !== undefined &&
    props.count !== undefined
      ? {
          sell: { collection: props.collection, tokenIds: props.tokenIds },
          buy: { collection: props.buyCollection, count: props.count },
          remainder: props.remainder ?? ('native' as const),
        }
      : undefined
  const quoteNftToNft = useSnfQuoteNftToNft(nftToNftArgs, { enabled: props.side === 'nft-to-nft' })

  // The structural QuoteQueryResult the context exposes — whichever of the three
  // results matches the active side.
  const quote: QuoteQueryResult =
    props.side === 'buy' ? quoteBuy : props.side === 'sell' ? quoteSell : quoteNftToNft

  const side = props.side
  const recipient = props.recipient

  // Plan-building as ordinary cached data-fetching, never a hand-rolled effect+state
  // (D-07's whole point). `queryKey` is keyed on `quote.dataUpdatedAt` — a plain
  // number every `UseQueryResult` carries, bumped whenever react-query accepts fresh
  // data — NEVER the raw `Quote` object itself, which carries `bigint` fields
  // (`Amount.value`) that `JSON.stringify` (react-query's default key hasher) throws
  // on (`packages/sdk-react/src/queryKeys.ts`'s own header comment documents exactly
  // this problem for the SDK's own hooks; this applies the same fix).
  const planQuery = useQuery<ExecutionPlan, SnfError>({
    queryKey: [PLAN_QUERY_TAG, client.chainId, side, quote.dataUpdatedAt, recipient] as const,
    queryFn: async () => {
      // Unreachable given `enabled` below, but must still type-check — a plain
      // `Error`, not translated through `describeError`, since it can only ever
      // fire from a programming mistake in this file, never a real user path.
      if (quote.data === undefined || recipient === undefined) {
        throw new Error('TradeCardRoot: plan-building queryFn ran without a ready quote/recipient.')
      }
      const buildArgs = { quote: quote.data, recipient }
      try {
        const plan =
          side === 'buy'
            ? await client.buildBuy(buildArgs)
            : side === 'sell'
              ? await client.buildSell(buildArgs)
              : await client.buildNftToNft(buildArgs)
        await plan.preflight()
        return plan
      } catch (e) {
        // Mirrors sdk-react's own (internal, unexported) withSnfError helper —
        // translates any caught throwable through client.describeError so
        // planQuery.error always resolves to a real SnfError.
        throw client.describeError(e)
      }
    },
    enabled: quote.data !== undefined && recipient !== undefined,
    // A failed preflight must surface, not silently retry against possibly-stale
    // reserves.
    retry: false,
  })

  // plan 05 addition (see TradeCard.types.ts's TradeCardParams header comment) — a
  // plain passthrough of the subset of props a Part needs before a quote resolves.
  // `exactOptionalPropertyTypes: true` forbids assigning an explicit `{ key:
  // undefined }`, so each optional key is spread in only when actually defined,
  // mirroring buyArgs/sellArgs/nftToNftArgs's own pattern above.
  const params = useMemo(
    () => ({
      ...(props.count === undefined ? {} : { count: props.count }),
      ...(props.tokenIds === undefined ? {} : { tokenIds: props.tokenIds }),
      ...(props.buyCollection === undefined ? {} : { buyCollection: props.buyCollection }),
      ...(props.remainder === undefined ? {} : { remainder: props.remainder }),
    }),
    [props.count, props.tokenIds, props.buyCollection, props.remainder],
  )

  const rootContextValue = useMemo<TradeCardRootContextValue>(
    () => ({
      side,
      collectionInfo,
      inventory,
      quote,
      planQuery: { data: planQuery.data, error: planQuery.error, isLoading: planQuery.isLoading },
      messages: props.messages,
      params,
    }),
    [
      side,
      collectionInfo,
      inventory,
      quote,
      planQuery.data,
      planQuery.error,
      planQuery.isLoading,
      props.messages,
      params,
    ],
  )

  // The root element's own data-state. Computed purely from quote/planQuery loading
  // flags — never by having TradeCardRoot itself consume TradeCardCheckoutContext
  // (a context it does not even provide until CheckoutMount mounts one render level
  // below). 'ready' covers every state once a plan exists; the live, fine-grained
  // CheckoutState (wallet/pending/success/error/...) becomes observable further down
  // the tree once a later plan's Action/Steps parts call useTradeCardCheckout()
  // directly and render their OWN data-state from checkout.state verbatim.
  const rootState: 'idle' | 'loading' | 'ready' =
    planQuery.data !== undefined
      ? 'ready'
      : quote.isLoading || quote.isFetching || planQuery.isLoading
        ? 'loading'
        : 'idle'

  const mergedClassName = mergeClassNames(props.className)
  const dataAttrs = toDataAttrs({ part: 'root', side, state: rootState })

  // The actual DOM root element — a real div, or (when `asChild` is true) `Slot`,
  // which clones the partner's own single substituted `children` element instead of
  // wrapping it. This is built from `props.children` UNCONDITIONALLY (regardless of
  // whether a plan/CheckoutMount exists yet) so `asChild`'s substitution target is
  // always the partner's own element, never an internal Provider/CheckoutMount
  // wrapper component — Slot can only meaningfully clone a real host-shaped element.
  // `SlotProps.className` is `?: string` (no explicit `| undefined`, unlike React's
  // own DOM-attribute types) — `exactOptionalPropertyTypes: true` forbids passing an
  // explicit `undefined` to it, so the key is spread in only when actually defined.
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

  // TradeCardRootContext is always provided, wrapping the DOM root element (and
  // therefore props.children). CheckoutMount, when a plan exists, wraps that same
  // DOM root element ONE level further out — it renders no DOM node of its own
  // (just TradeCardCheckoutContext.Provider), so nesting it here never disturbs
  // Slot's single-element contract above.
  return (
    <TradeCardRootContext.Provider value={rootContextValue}>
      {planQuery.data !== undefined ? (
        <CheckoutMount plan={planQuery.data}>{rootElement}</CheckoutMount>
      ) : (
        rootElement
      )}
    </TradeCardRootContext.Provider>
  )
}
