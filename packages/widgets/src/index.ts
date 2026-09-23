/**
 * `@sweepnflip/widgets` — public entrypoint.
 *
 * @gsd-stub This file is the package's ENTIRE public surface today: one placeholder
 * export proving the build/test pipeline works, nothing else. It grows through:
 *   - plan 03: internal primitives (compound-component context, styling helpers) —
 *     built under `src/` but NOT re-exported here, same reasoning as
 *     `@sweepnflip/sdk`'s own internal `checkout/` module.
 *   - plan 05: `SnfTradeCard` (R4) — the first real component export, and the plan
 *     that also removes the stub marker above.
 *   - plan 06: `SnfPoolStats` (R5).
 *   - plan 07: the theme's separate, non-JS CSS entry point (not exported from this
 *     file at all — a partner imports it by its own subpath, never through here).
 */
export const SNF_WIDGETS_VERSION = '0.0.0'
