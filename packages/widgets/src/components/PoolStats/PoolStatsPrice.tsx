import { cloneElement, type ReactElement, type ReactNode } from 'react'
import { mergeClassNames } from '../../internal/classNames'
import { toDataAttrs } from '../../internal/dataState'
import { Slot } from '../../internal/slot'
import { resolveErrorMessage } from '../../messages'
import { usePoolStatsContext } from './context'
import type { PoolStatsPartProps } from './PoolStats.types'

/**
 * `PoolStatsPrice` — renders the SDK's own one-NFT quote for this collection's pool
 *.
 *
 * Price resolution (restated here at the leaf that
 * actually renders it, mirroring `PoolStatsRoot.tsx`'s own header comment): this Part
 * renders two SEPARATE figures, both real `Amount` values taken verbatim from
 * `priceQuote.data` via `.formatted`/`.symbol` with zero arithmetic — `legs[0]?.amount`
 * (the pool-only price for one NFT, what the AMM curve itself would charge before
 * fees) as the primary figure, and `totalCost` (the all-in cost including the
 * marketplace fee) as a second, separately-labelled figure. Neither is a client-side
 * ratio of `reserves.base`/`reserves.wnft` — that ratio has a distinct, precise meaning
 * in this protocol this component never computes.
 */
export function PoolStatsPrice(props: PoolStatsPartProps): ReactNode {
  const ctx = usePoolStatsContext()
  const { priceQuote } = ctx

  const state: 'idle' | 'loading' | 'error' | 'ready' = priceQuote.isLoading
    ? 'loading'
    : priceQuote.error
      ? 'error'
      : priceQuote.data
        ? 'ready'
        : 'idle'

  const poolLeg = priceQuote.data?.legs[0]?.amount
  const totalCost = priceQuote.data?.totalCost

  const defaultContent: ReactNode = priceQuote.error ? (
    <span data-testid="price-error" data-error-code={priceQuote.error.code}>
      {resolveErrorMessage(priceQuote.error.code, ctx.messages)}
    </span>
  ) : priceQuote.data ? (
    <>
      <span data-testid="price-pool-leg">
        {poolLeg?.formatted} {poolLeg?.symbol}
      </span>
      <span data-testid="price-total-cost">
        {totalCost?.formatted} {totalCost?.symbol}
      </span>
    </>
  ) : null

  // Render-prop override (a function fully replaces `defaultContent`); a plain
  // element passed as `children` when NOT `asChild` also replaces `defaultContent` (a
  // partner's own literal markup). When `asChild` IS set, `children` is the single
  // substitution target `Slot` clones, never treated as an override value here — the
  // computed content is injected onto that same element below instead.
  const overrideContent =
    typeof props.children === 'function' ? props.children(ctx) : props.asChild ? undefined : props.children
  const content = overrideContent ?? defaultContent

  const mergedClassName = mergeClassNames(props.className)
  const dataAttrs = toDataAttrs({ part: 'price', state })

  if (props.asChild) {
    const slotProps = { ...dataAttrs, ...(mergedClassName === undefined ? {} : { className: mergedClassName }) }
    // `cloneElement` here injects this Part's own computed `content` as the
    // substituted element's children BEFORE handing it to `Slot` — Slot's own job
    // (`slot.tsx`) is merging attrs/className/ref onto a single element, never
    // supplying its content; a leaf display Part has no further child Parts to
    // provide that content itself, unlike `PoolStatsRoot`/`TradeCardRoot`, which
    // forward an already-built subtree. This is a plain React `cloneElement` call,
    // not a re-implementation of any of Slot's own merge logic.
    const substituted = cloneElement(props.children as ReactElement, undefined, content)
    return <Slot {...slotProps}>{substituted}</Slot>
  }

  return (
    <div className={mergedClassName} {...dataAttrs}>
      {content}
    </div>
  )
}
