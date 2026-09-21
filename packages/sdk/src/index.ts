/**
 * @sweepnflip/sdk — public entrypoint.
 *
 * This wave (plan 04) exports the error taxonomy, the full public type contract, and
 * the chain registry — everything a partner needs to construct requests and catch
 * typed errors. The 20 domain-module stubs under `collection/`, `quote/`, `build/`,
 * `checkout/`, `receipt/`, `transport/`, `describeError.ts` and `links.ts` are
 * deliberately NOT exported here: `createSnfClient` (plan 09) is the documented
 * surface for them (D-01) — exporting half-built free functions now would create a
 * second, undocumented API that plan 09 would then have to deprecate.
 *
 * `SDK_VERSION` must stay in sync with `package.json#version` — plan 20 adds the test
 * asserting that.
 */
export const SDK_VERSION = '0.1.0'

export * from './chains'
export * from './errors'
export type * from './errors.types'
export type * from './types'
