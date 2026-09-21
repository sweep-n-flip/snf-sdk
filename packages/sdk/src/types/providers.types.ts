import type { PublicClient } from 'viem'

import type { SnfChainConfig } from '../chains/chains.types'
import type { PoolInventory } from './inventory.types'

/**
 * Optional partner-supplied data sources (R4, R19; 54-SPEC.md). An absent provider ⇒
 * the corresponding result field is `undefined` — NEVER a hidden fetch and NEVER a
 * silent empty list (SPEC prohibition: "MUST NOT degradar silenciosamente para lista
 * vazia quando um provider está ausente — o estado deve ser explícito"). `ImagesProvider`
 * is the one field with a keyless on-chain default (`tokenURI` via Multicall3,
 * `enrichListingsWithOnChainTokenURI` pattern); the other three have none.
 *
 * Plan 09 (Deviations, snf-54-09-SUMMARY.md) reshaped this file from its plan-04
 * placeholder in two ways, both required to make the plan's own literal behavior
 * implementable and type-safe:
 *
 * 1. `ImagesProvider.getImageUrl(collection, tokenId, chainId)` (one call per token, no
 *    way to reach a `publicClient`) could not implement "issues exactly ONE
 *    `publicClient.multicall` for up to 50 ids" — the interface had no parameter
 *    capable of carrying a `publicClient` at all. Replaced with a single batched
 *    `getImages(ctx, collection, tokenIds)` returning a `Map`, where `ctx` is the
 *    minimal `{ publicClient, chain }` slice a provider needs — deliberately NOT the
 *    full `SnfClientContext` (which also carries the transport/counter internals no
 *    provider should reach). `SnfClientContext` is a structural superset of
 *    `ImagesProviderContext`, so callers pass their real `ctx` straight through.
 * 2. `WalletNftsProvider.getWalletNfts` and `PoolInventoryProvider.getPoolInventory`
 *    returned non-optional types, which cannot represent "this provider doesn't have
 *    data for this request" without throwing or returning an empty list — exactly what
 *    R19 forbids ("Calling a NO_PROVIDER surface resolves to undefined — it does not
 *    throw, does not fetch, and does not return `[]`"). Both now return `| undefined`,
 *    matching `PricesProvider.getNativeUsd`, which already did.
 */

/** The minimal slice of `SnfClientContext` an `ImagesProvider` needs — a publicClient
 * to read on-chain, and the chain's registry entry for `multicall3`. Not the full
 * context: a provider must never reach the transport cache or the invalidation
 * counter. */
export interface ImagesProviderContext {
  readonly publicClient: PublicClient
  readonly chain: SnfChainConfig
}

export interface ImagesProvider {
  /** Batched: one call resolves every id in `tokenIds` (capped at 50 — the same cap
   * every tx-affecting array in this package uses). A per-id failure never fails the
   * batch — that id's map entry is `undefined`. */
  getImages(
    ctx: ImagesProviderContext,
    collection: `0x${string}`,
    tokenIds: readonly string[],
  ): Promise<Map<string, string | undefined>>
}

export interface WalletNftsProvider {
  getWalletNfts(
    owner: `0x${string}`,
    collection: `0x${string}`,
    chainId: number,
  ): Promise<readonly string[] | undefined>
}

export interface PricesProvider {
  getNativeUsd(chainId: number): Promise<number | undefined>
}

export interface PoolInventoryProvider {
  getPoolInventory(pair: `0x${string}`, chainId: number): Promise<PoolInventory | undefined>
}

/** All four providers are optional and independent — omitting one never disables or
 * degrades another. */
export type DataProviders = Partial<{
  readonly images: ImagesProvider
  readonly walletNfts: WalletNftsProvider
  readonly prices: PricesProvider
  readonly poolInventory: PoolInventoryProvider
}>
