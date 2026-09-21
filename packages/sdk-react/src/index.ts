/**
 * `@sweepnflip/sdk-react` — public entrypoint.
 *
 * Exactly `SnfProvider` plus the seven `useSnf*` hooks (D-02) — `useSnfClient`,
 * `useSnfCollection`, `useSnfPoolInventory`, `useSnfQuoteBuy`, `useSnfQuoteSell`,
 * `useSnfQuoteNftToNft`, `useSnfCheckout`. `useSnfCheckout` is added by this plan's
 * Task 2 commit. Nothing from `@sweepnflip/sdk` is re-exported here — a partner
 * imports `@sweepnflip/sdk` for types/`createSnfClient` and `@sweepnflip/sdk-react`
 * for hooks; re-exporting the core's surface from this barrel would create two paths
 * to the same symbol and a dual-instance hazard (this plan's own action text).
 */
export { SnfProvider } from './context'
export type { SnfProviderProps, SnfContextValue } from './context'

export {
  useSnfClient,
  useSnfCollection,
  useSnfPoolInventory,
  useSnfQuoteBuy,
  useSnfQuoteSell,
  useSnfQuoteNftToNft,
  useSnfCheckout,
} from './hooks'
export type {
  UseSnfCollectionOptions,
  UseSnfCollectionResult,
  UseSnfPoolInventoryOptions,
  UseSnfPoolInventoryResult,
  UseSnfQuoteBuyArgs,
  UseSnfQuoteBuyOptions,
  UseSnfQuoteBuyResult,
  UseSnfQuoteSellArgs,
  UseSnfQuoteSellOptions,
  UseSnfQuoteSellResult,
  UseSnfQuoteNftToNftArgs,
  UseSnfQuoteNftToNftOptions,
  UseSnfQuoteNftToNftResult,
  UseSnfCheckoutResult,
} from './hooks'
