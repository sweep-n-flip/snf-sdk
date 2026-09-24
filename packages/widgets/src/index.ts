/**
 * `@sweepnflip/widgets` — public entrypoint.
 *
 * Public surface so far:
 * - Internal primitives (compound-component context, styling helpers) —
 * built under `src/` but NOT re-exported here, same reasoning as
 * `@sweepnflip/sdk`'s own internal `checkout/` module.
 * - `SnfTradeCard` — the first real component export, added below.
 * This is the addition that removed the placeholder-only marker this file used to
 * carry.
 * - `SnfPoolStats` — added below.
 * - The theme's separate, non-JS CSS entry point (not exported from this
 * file at all — a partner imports it by its own subpath, never through here).
 */
export const SNF_WIDGETS_VERSION = '0.0.0'

export { SnfTradeCard } from './components/TradeCard'
export type { SnfTradeCardRootProps, SnfTradeSide } from './components/TradeCard'

export { SnfPoolStats } from './components/PoolStats'
export type {
  PoolStatsContextValue,
  PoolStatsPartProps,
  SnfPoolStatsRootProps,
} from './components/PoolStats'
