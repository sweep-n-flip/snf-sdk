import { TradeCardAction } from './TradeCardAction'
import { TradeCardInput } from './TradeCardInput'
import { TradeCardQuoteBreakdown } from './TradeCardQuoteBreakdown'
import { TradeCardRoot } from './TradeCardRoot'
import { TradeCardSteps } from './TradeCardSteps'

/**
 * `SnfTradeCard` — the compound export (R4, R6). This is the ONE place the five
 * pieces are assembled — `Root`/`Input`/`QuoteBreakdown`/`Steps`/`Action` are never
 * also exported individually from the package's top-level barrel, so a partner always
 * writes `SnfTradeCard.Root`, never a bare `TradeCardRoot` import. `Input`/
 * `QuoteBreakdown`/`Steps`/`Action` each read state exclusively from
 * `useTradeCardContext()`/`useTradeCardCheckout()` (`./context`) — none of them calls
 * a `useSnf*` hook directly, keeping "Root owns state, parts consume it through
 * context" true for the whole compound component.
 */
export const SnfTradeCard = {
  Root: TradeCardRoot,
  Input: TradeCardInput,
  QuoteBreakdown: TradeCardQuoteBreakdown,
  Steps: TradeCardSteps,
  Action: TradeCardAction,
}

export type { SnfTradeSide, SnfTradeCardRootProps } from './TradeCard.types'
