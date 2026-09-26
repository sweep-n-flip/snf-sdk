import type { SnfChainId } from '../chains/chains.types'
import type { Amount } from './amount.types'

/**
 * Seeding/attestation types. Both reads are not live yet — no seeding contract is
 * deployed on any chain, and the off-chain attestation layer has not been built —
 * so these shapes are provisional and may change before either ships. Hand-written
 * and neutral on purpose: nothing here is derived from a Solidity ABI, and no
 * contract address appears anywhere in this file.
 */

/** The result of `seeding(collection)`. */
export interface SeedingInfo {
  readonly chainId: SnfChainId
  readonly collection: `0x${string}`
  readonly status: 'none' | 'scheduled' | 'seeded' | 'cancelled'
  readonly nftCount?: number
  readonly pricePerNft?: Amount
  readonly lpRecipient?: `0x${string}`
  readonly pair?: `0x${string}`
  readonly blockNumber: bigint
}

/** The result of `attestation(collection)`. */
export interface SeedingAttestation {
  readonly chainId: SnfChainId
  readonly collection: `0x${string}`
  readonly attested: boolean
  readonly issuedAt?: string
  readonly issuer?: `0x${string}`
}
