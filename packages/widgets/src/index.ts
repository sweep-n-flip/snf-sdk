/**
 * `@sweepnflip/widgets` — public entrypoint.
 *
 * @gsd-stub This file's public surface still carries one placeholder export proving
 * the build/test pipeline works. It grows through:
 *   - plan 03: internal primitives (compound-component context, styling helpers) —
 *     built under `src/` but NOT re-exported here, same reasoning as
 *     `@sweepnflip/sdk`'s own internal `checkout/` module.
 *   - plan 05: `SnfTradeCard` (R4) — the first real component export, and the plan
 *     that also removes the stub marker above. NOT YET LANDED on this branch as of
 *     plan 06's own commit (56-06-PLAN.md's own ordering note anticipates this) —
 *     plan 05 still owns adding its own export line and clearing this marker.
 *   - plan 06: `SnfPoolStats` (R5) — added below, this plan's own commit.
 *   - plan 07: the theme's separate, non-JS CSS entry point (not exported from this
 *     file at all — a partner imports it by its own subpath, never through here).
 */
export const SNF_WIDGETS_VERSION = '0.0.0'

export { SnfPoolStats } from './components/PoolStats'
export type {
  PoolStatsContextValue,
  PoolStatsPartProps,
  SnfPoolStatsRootProps,
} from './components/PoolStats'
