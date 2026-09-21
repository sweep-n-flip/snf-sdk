import { notImplemented } from './internal/stub'

/**
 * Explorer link builders — one per chain's `explorerUrl` from `chains/registry.ts`
 * (`Chain.explorerUrl`). Pure string builders, no RPC calls.
 *
 * @gsd-stub — implemented by plan 09. Source analog: snf-client/src/config/chains.ts
 * (explorer URL builders).
 */
export function txLink(chainId: number, hash: `0x${string}`): string {
  void chainId
  void hash
  return notImplemented('txLink', '09')
}

/**
 * @gsd-stub — implemented by plan 09. Source analog: snf-client/src/config/chains.ts
 * (explorer URL builders).
 */
export function addressLink(chainId: number, address: `0x${string}`): string {
  void chainId
  void address
  return notImplemented('addressLink', '09')
}

/**
 * @gsd-stub — implemented by plan 09. Source analog: snf-client/src/config/chains.ts
 * (explorer URL builders).
 */
export function tokenLink(
  chainId: number,
  ref: { readonly collection: `0x${string}`; readonly tokenId: string },
): string {
  void chainId
  void ref
  return notImplemented('tokenLink', '09')
}
