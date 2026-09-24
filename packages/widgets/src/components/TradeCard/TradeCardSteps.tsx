import { cloneElement, type ReactElement, type ReactNode } from 'react'
import { mergeClassNames } from '../../internal/classNames'
import { toDataAttrs } from '../../internal/dataState'
import { Slot } from '../../internal/slot'
import { useTradeCardCheckout, useTradeCardContext } from './context'
import type { TradeCardStepsProps } from './TradeCard.types'

/**
 * `TradeCardSteps` — renders the built plan's steps as a real list.
 *
 * **Why this Part does not compute per-item done/current/pending status**: no
 * publicly exported symbol maps a `CheckoutState` to a `plan.steps[]` index —
 * `NEXT_READY_BY_KIND` lives in `packages/sdk/src/checkout/reducer.ts`, internal to the
 * core package, not part of `@sweepnflip/sdk`'s public barrel or the `/checkout`
 * subpath. Re-deriving that mapping here would be exactly the "re-enumerate the step
 * list" the SDK's own contract forbids. `examples/next-app/src/components/SwapPanel.tsx`'s own
 * `CheckoutFlow` sets the precedent this Part follows exactly: `plan.steps.map(step =>
 * <li key={step.label}>{step.label}</li>)`, no per-item status at all — overall
 * progress is shown separately (there, `<p>State: {checkout.state}</p>`; here, the
 * `<ol>` itself carries `data-state` mirroring `checkout.state` verbatim, so a partner
 * can still style "the list is mid-flow" via pure CSS without this kit fabricating
 * certainty it does not have).
 *
 * Render nothing but an EMPTY `<ol>` (no placeholder text) when no plan exists yet —
 * an empty list is still a valid, honest state.
 */
export function TradeCardSteps(props: TradeCardStepsProps): ReactNode {
  const context = useTradeCardContext()
  const checkout = useTradeCardCheckout()
  const steps = context.planQuery.data?.steps ?? []
  const state = checkout?.state ?? 'idle'

  const listItems: ReactNode = steps.map((step) => (
    <li key={step.label} {...toDataAttrs({ part: 'step', kind: step.kind })}>
      {step.label}
    </li>
  ))

  const mergedClassName = mergeClassNames(props.className)
  const dataAttrs = toDataAttrs({ part: 'steps', state })

  const defaultContent: ReactNode = (
    <ol className={mergedClassName} {...dataAttrs}>
      {listItems}
    </ol>
  )

  const renderPropCtx = { context, checkout }
  // Render-prop override (a function fully replaces `defaultContent`); a plain
  // element passed as `children` when NOT `asChild` also replaces `defaultContent`.
  // When `asChild` IS set, `children` is the single substitution target `Slot`
  // clones (the partner's own list element, e.g. a `<ul>`), still populated with the
  // same `<li>` children this Part computes — never treated as override content in
  // that branch.
  const overrideContent =
    typeof props.children === 'function' ? props.children(renderPropCtx) : props.asChild ? undefined : props.children

  if (props.asChild) {
    const slotProps = { ...dataAttrs, ...(mergedClassName === undefined ? {} : { className: mergedClassName }) }
    // `cloneElement` injects the computed `<li>` items as the substituted list
    // element's children BEFORE handing it to `Slot` — see `PoolStatsPrice.tsx`'s
    // header comment for the precedent; not a re-implementation of `Slot`'s own
    // attrs/className/ref merge logic.
    const substituted = cloneElement(props.children as ReactElement, undefined, listItems)
    return <Slot {...slotProps}>{substituted}</Slot>
  }

  return overrideContent ?? defaultContent
}
