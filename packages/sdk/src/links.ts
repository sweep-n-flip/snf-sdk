import { getChain } from './chains/registry'

/**
 * Explorer link builders — every URL is built ONLY from
 * `getChain(chainId).explorerUrl` (`chains/registry.ts`). No host is ever hardcoded
 * here: adding a 15th chain to the registry adds its links for free, and a hardcoded
 * explorer host in this file would be exactly the kind of silent per-chain bug this
 * package's own rules exist to prevent. `getChain` itself throws
 * `SnfError('INVALID_PARAMS')` for an unsupported chain, so every function below does
 * too, for free, before building anything.
 *
 * Path shape: the production AMM client's own reference implementation
 * (its `getExplorerUrl`) uses ONE uniform
 * `${baseUrl}/${type}/${value}` builder across all 14 chains today, including the
 * Blockscout instance (Robinhood Chain), the zkSync-stack explorer (Abstract) and the
 * Sky Mavis explorer (Ronin) — no per-chain path override exists anywhere in the
 * production app. This module mirrors that exactly, rather than inventing per-chain
 * path branches the live app itself doesn't have. `tokenLink` uses the Etherscan-style
 * `/token/{address}?a={tokenId}` query-param form (also the production app's own
 * shape) rather than a path segment, since not every explorer in this registry
 * supports a `/token/{address}/{tokenId}` path route.
 */

function explorerBase(chainId: number): string {
  return getChain(chainId).explorerUrl
}

/** A transaction's explorer URL. */
export function txLink(chainId: number, hash: `0x${string}`): string {
  return `${explorerBase(chainId)}/tx/${hash}`
}

/** An address's (EOA or contract) explorer URL. */
export function addressLink(chainId: number, address: `0x${string}`): string {
  return `${explorerBase(chainId)}/address/${address}`
}

/** One NFT's explorer URL — the collection's `/token/{address}` page, scoped to
 * `tokenId` via the `?a=` query param (Etherscan's own convention for an ERC-721
 * instance). */
export function tokenLink(
  chainId: number,
  ref: { readonly collection: `0x${string}`; readonly tokenId: string },
): string {
  return `${explorerBase(chainId)}/token/${ref.collection}?a=${ref.tokenId}`
}
