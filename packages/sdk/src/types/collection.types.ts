import type { TokenRef } from './amount.types'

/**
 * The result shapes of `resolveCollection` (R6; 54-SPEC.md).
 */

/**
 * Display identity for a collection. `name` is NEVER an address, full or shortened —
 * see `.specs/codebase/COLLECTION_IDENTITY.md`. A shortened address is only ever a
 * last-resort fallback produced inside `getCollectionLabels` itself, never treated as
 * the collection's persisted identity elsewhere.
 */
export interface CollectionLabels {
  readonly name: string
  readonly symbol: string
  readonly imageUrl?: string
}

/**
 * EIP-2981 royalty for a collection, reconstructed the same way the Router itself
 * computes it (`RoyaltyHelper.sol`). `capBps === 0` means the Router's on-chain
 * royalty cap is unset, which zeroes the royalty entirely if `capRoyaltyFee=true` were
 * ever requested — the SDK pins `capRoyaltyFee=false` everywhere (SPEC Constraint,
 * prohibition #6), but `effectiveBpsWhenCapped` still reports what a capped read WOULD
 * yield, with `warnings` explaining why (R6 acceptance: `capBps === 0` ⇒
 * `effectiveBpsWhenCapped === 0` with a warning).
 */
export interface RoyaltyInfo {
  readonly bps: number
  readonly receiver: `0x${string}` | null
  readonly capBps: number
  readonly effectiveBpsWhenCapped: number
  readonly basis: 'collection-default' | 'per-token'
  readonly unpayableReceiver: boolean
  readonly warnings: readonly string[]
}

/**
 * Whether the wrapper this SDK read actually belongs to the requested collection.
 * `'unknown'` means the on-chain read itself failed (RPC error) — never conflated with
 * `'mismatch'`, which is a confirmed identity failure (`wrapper.collection() !== address`).
 */
export type WrapperVerified = 'match' | 'mismatch' | 'unknown'

/** One AMM pool pairing a collection's wrapper with a base token. */
export interface PoolRef {
  readonly pair: `0x${string}`
  readonly baseToken: TokenRef
  readonly isNative: boolean
  readonly reserves: { readonly base: bigint; readonly wnft: bigint }
  /** Whether the wrapper is `token0` on this pair — NEVER assume an index (CLAUDE.md: "wrapper can be token0 or token1"). */
  readonly wrapperIsToken0: boolean
}

/** The full result of `resolveCollection` (R6). `pools` is ordered by liquidity, native
 * base first on a tie (Edge `ordering | R6`); an empty array (no pool yet) is valid,
 * never an error. */
export interface CollectionInfo {
  readonly address: `0x${string}`
  readonly wrapper: `0x${string}`
  readonly pools: readonly PoolRef[]
  readonly labels: CollectionLabels
  readonly royalty: RoyaltyInfo
  readonly redemptionLocked: boolean
  readonly wrapperVerified: WrapperVerified
}
