/**
 * @sweepnflip/sdk — public entrypoint.
 *
 * `createSnfClient` is the ENTIRE documented API for every
 * domain operation — `snf.quoteBuy(...)`, never a bare imported `quoteBuy(...)`. This
 * is this module's own repo note made permanent: `quoteBuy`, `buildBuy`,
 * `resolveCollection`, `poolInventory`, `createCheckout` and every other domain
 * function under `collection/`, `quote/`, `build/`, `checkout/`, `receipt/`,
 * `liquidity/`, `seeding/` stay internal to this package on purpose. Exporting them as
 * free-standing symbols would create a second, undocumented entry point this package
 * would then have to keep compatible forever, alongside the one actually documented.
 * `checkout/` in particular is a REAL, fully-implemented module that still isn't
 * exported here — `createCheckout` isn't one of this rule's 28 client methods; it's
 * consumed by `@sweepnflip/sdk-react`'s `useSnfCheckout`, a different package, not by
 * a partner importing this one directly. `appLinks` is the one exception to "every
 * operation is a client method": it needs no client (no chain read, no subgraph
 * query — it only builds a string), so it ships as a free-standing namespace
 * alongside the explorer link builders below, not as a 29th client method.
 *
 * `SDK_VERSION` must stay in sync with `package.json#version` — a dedicated test
 * asserts that.
 */
export const SDK_VERSION = '0.1.2'

export { createSnfClient } from './client'
export * from './chains'
export { describeError } from './describeError'
export * from './errors'
export type * from './errors.types'
// A runtime value, so it cannot ride the `export type *` above: partners read it to
// decide whether an error code is worth retrying.
export { SNF_ERROR_RETRYABLE } from './errors.types'
export { addressLink, tokenLink, txLink } from './links'
export { appLinks } from './appLinks'
export { encodeAttribution, parseAttribution, toSdkCode, validatePartnerCode } from './attribution'
export { formatAmount, toAmount } from './format'
export type * from './types'

// A named sub-export, not `export *` — so a tree-shaker isn't forced to keep all nine
// ABIs merely because a partner imported ONE named export from this entry point
// (T-54's size budget).
export * as abis from './abis'
