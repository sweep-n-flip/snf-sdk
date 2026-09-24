import { cloneElement, type ReactElement, type ReactNode } from 'react'
import { mergeClassNames } from '../../internal/classNames'
import { toDataAttrs } from '../../internal/dataState'
import { Slot } from '../../internal/slot'
import { resolveErrorMessage } from '../../messages'
import { useTradeCardContext } from './context'
import type { TradeCardQuoteBreakdownProps } from './TradeCard.types'

/**
 * `TradeCardQuoteBreakdown` — renders the resolved `Quote`'s fee/total/price-impact
 * breakdown, or the active error, verbatim.
 *
 * this rule's whole contract lives here: every `Amount` (`fees.marketplace`, `fees.royalty`,
 * and whichever of `totalCost`/`totalProceeds`/`netProceeds`/`buyCost`/`remainder` the
 * active side's `Quote` actually populates) is rendered via its own `.formatted`/
 * `.symbol` fields, character-identical to what the SDK returned — never through any
 * numeric-reformatting method call or arithmetic on `.value` (mechanically enforced by
 * `local/no-amount-arithmetic`/`local/no-numeric-formatting` against this file too).
 * `fees.pool.bps` and `priceImpact` are plain `number`s, not `Amount`s — rendered
 * directly via string interpolation, exactly `examples/next-app`'s own `QuoteSection`
 * precedent (`{quote.data.priceImpact}%`), never reformatted.
 *
 * this rule's whole contract also lives in exactly one place here: when `quote.error` or
 * `planQuery.error` is set, this Part renders the error's own `code` (as text AND as a
 * `data-error-code` attribute) alongside `resolveErrorMessage(code, ctx.messages)` — a
 * partner's `messages` override replaces the text, never the code.
 */
export function TradeCardQuoteBreakdown(props: TradeCardQuoteBreakdownProps): ReactNode {
  const ctx = useTradeCardContext()
  const { quote, planQuery, side, messages } = ctx

  const activeError = quote.error ?? planQuery.error

  const state: 'idle' | 'loading' | 'error' | 'ready' = quote.isLoading
    ? 'loading'
    : activeError
      ? 'error'
      : quote.data
        ? 'ready'
        : 'idle'

  const defaultContent: ReactNode = activeError ? (
    <span data-testid="quote-error" data-error-code={activeError.code}>
      {activeError.code} — {resolveErrorMessage(activeError.code, messages)}
    </span>
  ) : quote.data ? (
    <>
      <span data-testid="quote-fee-marketplace">
        {quote.data.fees.marketplace.formatted} {quote.data.fees.marketplace.symbol}
      </span>
      <span data-testid="quote-fee-royalty">
        {quote.data.fees.royalty.formatted} {quote.data.fees.royalty.symbol}
      </span>
      <span data-testid="quote-fee-pool">
        {quote.data.fees.pool.bps} bps ({quote.data.fees.pool.note})
      </span>
      {quote.data.totalCost !== undefined && (
        <span data-testid="quote-total-cost">
          {quote.data.totalCost.formatted} {quote.data.totalCost.symbol}
        </span>
      )}
      {quote.data.totalProceeds !== undefined && (
        <span data-testid="quote-total-proceeds">
          {quote.data.totalProceeds.formatted} {quote.data.totalProceeds.symbol}
        </span>
      )}
      {quote.data.netProceeds !== undefined && (
        <span data-testid="quote-net-proceeds">
          {quote.data.netProceeds.formatted} {quote.data.netProceeds.symbol}
        </span>
      )}
      {quote.data.buyCost !== undefined && (
        <span data-testid="quote-buy-cost">
          {quote.data.buyCost.formatted} {quote.data.buyCost.symbol}
        </span>
      )}
      {quote.data.remainder !== undefined && (
        <span data-testid="quote-remainder">
          {quote.data.remainder.formatted} {quote.data.remainder.symbol}
        </span>
      )}
      <span data-testid="quote-price-impact">{quote.data.priceImpact}%</span>
      <span data-testid="quote-reconciled">{String(quote.data.reconciled)}</span>
      <span data-testid="quote-best-effort">{String(quote.data.bestEffort)}</span>
      <span data-testid="quote-deliverable">{quote.data.deliverable}</span>
      {quote.data.warnings !== undefined && quote.data.warnings.length > 0 && (
        <ul data-testid="quote-warnings">
          {quote.data.warnings.map((warning) => (
            <li key={warning}>{warning}</li>
          ))}
        </ul>
      )}
    </>
  ) : null

  // Render-prop override (a function fully replaces `defaultContent`); a plain
  // element passed as `children` when NOT `asChild` also replaces `defaultContent`.
  // When `asChild` IS set, `children` is the single substitution target `Slot`
  // clones, never treated as override content here.
  const overrideContent =
    typeof props.children === 'function' ? props.children(ctx) : props.asChild ? undefined : props.children
  const content = overrideContent ?? defaultContent

  const mergedClassName = mergeClassNames(props.className)
  const dataAttrs = toDataAttrs({ part: 'quote', side, state })

  if (props.asChild) {
    const slotProps = { ...dataAttrs, ...(mergedClassName === undefined ? {} : { className: mergedClassName }) }
    // See `PoolStatsPrice.tsx`'s header comment — same content-injection pattern, not
    // a re-implementation of `Slot`'s own attrs/className/ref merge logic.
    const substituted = cloneElement(props.children as ReactElement, undefined, content)
    return <Slot {...slotProps}>{substituted}</Slot>
  }

  return (
    <div className={mergedClassName} {...dataAttrs}>
      {content}
    </div>
  )
}
