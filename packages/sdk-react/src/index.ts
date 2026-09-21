/**
 * @sweepnflip/sdk-react — public entrypoint.
 *
 * The full public surface (useSnfCollection, useSnfPoolInventory, useSnfQuoteBuy,
 * useSnfQuoteSell, useSnfQuoteNftToNft, useSnfCheckout) is assembled across plans
 * 04, 09 and 20 of this phase. This wave only needs the barrel to exist and export
 * something real so the dual ESM+CJS build (Task 1) has content to bundle.
 *
 * `SDK_REACT_VERSION` must stay in sync with `package.json#version` — plan 20 adds
 * the test asserting that.
 */
export const SDK_REACT_VERSION = '0.1.0'
