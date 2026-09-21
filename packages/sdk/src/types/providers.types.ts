import type { PoolInventory } from './inventory.types'

/**
 * Optional partner-supplied data sources (R4, R19; 54-SPEC.md). An absent provider ⇒
 * the corresponding result field is `undefined` — NEVER a hidden fetch and NEVER a
 * silent empty list (SPEC prohibition: "MUST NOT degradar silenciosamente para lista
 * vazia quando um provider está ausente — o estado deve ser explícito"). `ImagesProvider`
 * is the one field with a keyless on-chain default (`tokenURI` via Multicall3,
 * `enrichListingsWithOnChainTokenURI` pattern); the other three have none.
 */

export interface ImagesProvider {
  getImageUrl(
    collection: `0x${string}`,
    tokenId: string,
    chainId: number,
  ): Promise<string | undefined>
}

export interface WalletNftsProvider {
  getWalletNfts(
    owner: `0x${string}`,
    collection: `0x${string}`,
    chainId: number,
  ): Promise<readonly string[]>
}

export interface PricesProvider {
  getNativeUsd(chainId: number): Promise<number | undefined>
}

export interface PoolInventoryProvider {
  getPoolInventory(pair: `0x${string}`, chainId: number): Promise<PoolInventory>
}

/** All four providers are optional and independent — omitting one never disables or
 * degrades another. */
export type DataProviders = Partial<{
  readonly images: ImagesProvider
  readonly walletNfts: WalletNftsProvider
  readonly prices: PricesProvider
  readonly poolInventory: PoolInventoryProvider
}>
