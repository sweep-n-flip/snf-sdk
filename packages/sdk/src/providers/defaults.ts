import { onChainImagesProvider } from './onChainImages'
import type { SnfClientConfig } from '../types/client.types'
import type {
  DataProviders,
  PoolInventoryProvider,
  PricesProvider,
  WalletNftsProvider,
} from '../types/providers.types'

/**
 * Provider resolution (R4, R19; 54-SPEC.md) — merges a partner's own `config.providers`
 * over the SDK's defaults, one key at a time. `images` is the only field with a real,
 * keyless default (`onChainImagesProvider`, `onChainImages.ts`) — it is the only
 * surface reachable with no API key on every one of the 14 chains (D-06: free
 * forever, no license/key/paywall mechanism anywhere in this package). `walletNfts`
 * and `prices` need a keyed indexer whose cost is the PARTNER's, never the SnF
 * backend's (PRD `G-4`); `poolInventory` has its own on-chain/subgraph path
 * (`inventory/poolInventory.ts`, plan 11) and a provider override is optional there
 * too. All three default to `NO_PROVIDER`.
 *
 * `NO_PROVIDER` resolves every method to `Promise<undefined>` — it never throws,
 * never fetches, and never returns `[]` presented as a real (empty) result. That
 * distinction matters: an empty array reads as "this collection genuinely has no
 * wallet NFTs / no price / no inventory," which is a believable but WRONG answer when
 * the true state is "no provider was configured to ask." R19's own words: "the
 * indicator is enrichment, not a gate" — an absent provider must be visibly absent,
 * not silently indistinguishable from an answered-and-empty one.
 */

/** A frozen, stateless sentinel — safe to share as every client's default for the
 * three keyed-provider surfaces (it holds no per-client, no per-request state, so
 * sharing it across clients on different chains violates nothing R3 protects). */
export const NO_PROVIDER: WalletNftsProvider & PricesProvider & PoolInventoryProvider = Object.freeze({
  getWalletNfts(): Promise<undefined> {
    return Promise.resolve(undefined)
  },
  getNativeUsd(): Promise<undefined> {
    return Promise.resolve(undefined)
  },
  getPoolInventory(): Promise<undefined> {
    return Promise.resolve(undefined)
  },
})

/**
 * Merges `config.providers` (if any) over the defaults. Always returns all four keys
 * populated — `images` with the keyless on-chain default when the partner didn't
 * supply one, the other three with `NO_PROVIDER` — so `SnfClientContext.providers`
 * never has to null-check a missing key, only ever call through to a real object
 * whose absence-of-data answer is an explicit `undefined`.
 */
export function resolveProviders(config: SnfClientConfig): Required<DataProviders> {
  return {
    images: config.providers?.images ?? onChainImagesProvider,
    walletNfts: config.providers?.walletNfts ?? NO_PROVIDER,
    prices: config.providers?.prices ?? NO_PROVIDER,
    poolInventory: config.providers?.poolInventory ?? NO_PROVIDER,
  }
}
