import { cloneElement, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { isBusyState } from '@sweepnflip/sdk/checkout'
import { mergeClassNames } from '../../internal/classNames'
import { toDataAttrs } from '../../internal/dataState'
import { Slot } from '../../internal/slot'
import { useTradeCardCheckout, useTradeCardContext } from './context'
import type { TradeCardActionProps, TradeCardRootContextValue } from './TradeCard.types'

/**
 * `TradeCardAction` — the single dispatch site's UI surface, and this rule's accessibility
 * anchor.
 *
 * **The single-dispatch guarantee.** `next()` is called from exactly
 * ONE place: this `onClick` handler, synchronously, never from a `useEffect`/timer/
 * watcher (mechanically enforced by `local/no-effect-dispatch` against this file too —
 * `examples/next-app/src/components/SwapPanel.tsx`'s own `CheckoutFlow` button is the
 * exact discipline this copies: "One click == one transaction"). `disabled` gates on
 * `!checkout || !checkout.canProceed`, the SAME guard `useSnfCheckout`'s own
 * `canProceed` already encodes (`checkout/reducer.ts`'s `canDispatch`) — no additional
 * debounce or double-click guard is added on top of it; none is needed.
 *
 * **Accessibility is this file's whole job.** A real `<button type="button">` is
 * always rendered by default (never a `<div onClick>`) — its visible text IS its
 * accessible name with zero extra ARIA wiring ("free correctness"),
 * and it changes automatically whenever `checkout.label` changes
 * (the core reducer's own `buildConfirmLabel`, never re-derived here). A
 * sibling `<span role="status" aria-live="polite">`, visually hidden via an
 * absolute-positioned, zero-size inline style (never `display: none`/
 * `visibility: hidden`, which would ALSO remove it from the accessibility tree),
 * mirrors that same label text so an assistive-technology user is told about a state
 * change even without focus moving. `className="sr-only"` is included too so a
 * partner/theme's own reset can restyle the technique, but the inline style is the
 * actual guarantee — this headless kit ships zero required CSS, so accessibility here
 * cannot depend on any stylesheet ever loading.
 *
 * **`asChild`'s documented contract on THIS Part specifically**: the substituted
 * element still needs to itself be a real, focusable, activatable control (a
 * `<button>`) for the accessibility guarantees above to hold — this kit's own default
 * markup is always correct, but it cannot enforce what shape a partner substitutes.
 */
export function TradeCardAction(props: TradeCardActionProps): ReactNode {
  const checkout = useTradeCardCheckout()
  const context = useTradeCardContext()

  const label = checkout ? checkout.label : preCheckoutLabel(context)
  const disabled = !checkout || !checkout.canProceed
  const busy = checkout ? isBusyState(checkout.state) : false

  // The ONE dispatch site. Called ONLY from this synchronous click handler —
  // never wrapped in a useEffect, timer or `.then()` watcher anywhere in this file.
  const handleClick = (): void => {
    if (checkout && checkout.canProceed) {
      void checkout.next()
    }
  }

  const renderPropCtx = { context, checkout }
  // Render-prop override (a function fully replaces the default button content); a
  // plain node passed as `children` when NOT `asChild` also replaces it. When
  // `asChild` IS set, `children` is the single substitution target `Slot` clones,
  // never treated as override content here.
  const overrideContent =
    typeof props.children === 'function' ? props.children(renderPropCtx) : props.asChild ? undefined : props.children
  const buttonContent = overrideContent ?? label

  const mergedClassName = mergeClassNames(props.className)
  const dataAttrs = toDataAttrs({ part: 'action', state: checkout?.state ?? 'idle', busy, disabled })

  const buttonElement: ReactNode = props.asChild ? (
    <Slot
      type="button"
      disabled={disabled}
      onClick={handleClick}
      {...dataAttrs}
      {...(mergedClassName === undefined ? {} : { className: mergedClassName })}
    >
      {/* `cloneElement` injects this Part's own computed `buttonContent` as the
          substituted element's children BEFORE handing it to `Slot` — see
          `PoolStatsPrice.tsx`'s header comment for the precedent; not a
          re-implementation of `Slot`'s own attrs/className/ref merge logic. */}
      {cloneElement(props.children as ReactElement, undefined, buttonContent)}
    </Slot>
  ) : (
    <button type="button" className={mergedClassName} disabled={disabled} onClick={handleClick} {...dataAttrs}>
      {buttonContent}
    </button>
  )

  return (
    <>
      {buttonElement}
      <span role="status" aria-live="polite" className="sr-only" style={VISUALLY_HIDDEN_STYLE}>
        {label}
      </span>
    </>
  )
}

/**
 * A handful of fixed pre-checkout literals — NOT `DEFAULT_WIDGET_MESSAGES` entries
 * (none of these describe an `SnfErrorCode`; they describe this widget's OWN
 * pre-checkout loading/idle states, which have no SDK error code) and NOT a
 * re-implementation of the core's `buildConfirmLabel` (which only ever runs once a
 * checkout session exists — these five strings only ever apply BEFORE one does).
 */
function preCheckoutLabel(ctx: TradeCardRootContextValue): string {
  const { quote, planQuery } = ctx
  if (quote.data === undefined && quote.isLoading) return 'Getting quote...'
  if (quote.error) return 'Try again'
  if (quote.data !== undefined && planQuery.isLoading) return 'Preparing...'
  if (planQuery.error) return 'Try again'
  return 'Waiting for details...'
}

/** The standard "visually hidden but still in the accessibility tree" technique —
 * absolute-positioned, 1px, clipped — never `display: none`/`visibility: hidden`,
 * either of which would remove the element from the accessibility tree too, defeating
 * the whole point of the `aria-live` region above. */
const VISUALLY_HIDDEN_STYLE: CSSProperties = {
  position: 'absolute',
  width: '1px',
  height: '1px',
  padding: 0,
  margin: '-1px',
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
}
