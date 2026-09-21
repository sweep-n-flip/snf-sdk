/**
 * @sweepnflip/sdk — public entrypoint.
 *
 * `createSnfClient` (D-01, D-02; 54-SPEC.md R3) is the ENTIRE documented API for every
 * domain operation — `snf.quoteBuy(...)`, never a bare imported `quoteBuy(...)`. This
 * is plan 09's own repo note made permanent: `quoteBuy`, `buildBuy`,
 * `resolveCollection`, `poolInventory`, `createCheckout` and every other domain
 * function under `collection/`, `quote/`, `build/`, `checkout/`, `receipt/` stay
 * internal to this package on purpose. Exporting them as free-standing symbols would
 * create a second, undocumented entry point this package would then have to keep
 * compatible forever, alongside the one actually documented. `checkout/` in
 * particular is a REAL, fully-implemented module (plan 08) that still isn't exported
 * here — `createCheckout` isn't one of D-01's 13 client methods; it's consumed by
 * `@sweepnflip/sdk-react`'s `useSnfCheckout` (D-02), a different package, not by a
 * partner importing this one directly.
 *
 * `SDK_VERSION` must stay in sync with `package.json#version` — plan 20 adds the test
 * asserting that.
 */
export const SDK_VERSION = '0.1.0'

export { createSnfClient } from './client'
export * from './chains'
export { describeError } from './describeError'
export * from './errors'
export type * from './errors.types'
export { addressLink, tokenLink, txLink } from './links'
export { formatAmount, toAmount } from './format'
export type * from './types'

// A named sub-export, not `export *` — so a tree-shaker isn't forced to keep all nine
// ABIs merely because a partner imported ONE named export from this entry point
// (T-54's size budget, R21).
export * as abis from './abis'
