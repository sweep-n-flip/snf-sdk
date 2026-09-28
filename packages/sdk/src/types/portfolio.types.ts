import type { SnfChainId } from '../chains/chains.types'
import type { SnfErrorCode } from '../errors.types'
import type { Amount, TokenRef } from './amount.types'
import type { CollectionLabels } from './collection.types'
import type { LpPosition } from './liquidity.types'

/**
 * The public portfolio read types: `positions`, `wnftBalances`, `collectionsHeld` and
 * `poolHistory`. Every one of these methods describes ONE chain — the chain of the
 * client it was called on. There is no `chains` parameter and no cross-chain
 * aggregation anywhere in this file: a partner covering several chains builds one
 * client per chain and loops over them (a single cross-chain call is a later,
 * separate piece of work). There is likewise no totals helper — values across
 * different pools can sit in different base tokens, and summing them without a
 * common unit is not well-defined; a partner who wants a single number sums
 * `valueUsd` across whichever positions/holdings have it defined.
 */

/** Every valuation in this file is marked at the pool's own mid price — twice the base
 * side the caller's share would burn for right now — never a liquidation quote (an
 * actual withdrawal pays AMM slippage and, for `nft` mode, floors to whole NFTs). */
export type PortfolioValuation = 'mid'

/** `'day'` buckets are exactly 86,400 seconds; `'month'` buckets are 730 hours
 * (2,628,000 seconds), not a calendar month — see `PoolHistory.bucketSeconds`. */
export type PoolHistoryInterval = 'day' | 'month'

/** The subgraph pool-set snapshot every portfolio read is scanned against, carried on
 * the result so a caller can see how fresh the discovery pass was. */
export interface PoolSetFreshness {
  readonly asOfBlock: bigint
  readonly lagSeconds: number
  readonly stale: boolean
}

/** One held LP position, enriched with the collection/base identity `LpPosition`
 * itself does not carry. */
export interface PortfolioPosition extends LpPosition {
  readonly chainId: SnfChainId
  readonly collection: `0x${string}`
  readonly wrapper: `0x${string}`
  /** The pool's real base token — its address is the actual base, never guessed. */
  readonly baseToken: TokenRef
  /** Always resolved through the collection-labels waterfall — never a raw address. */
  readonly labels: CollectionLabels
  /** `2 × underlying.base`, in the pool's own base decimals (6 for a USDC-native
   * pool) — exact, not an approximation, because the burn mirror already pays
   * pro-rata from the pair's balances. */
  readonly valueInBase: Amount
  readonly valuation: PortfolioValuation
  /** `undefined` whenever no price is available — never `0` for "unknown", and never
   * sourced from the subgraph's own USD fields (they read 0 on some chains). */
  readonly valueUsd: number | undefined
}

/** One pair a `positions` scan could not price — the call still resolves; this pair's
 * failure is reported here instead of failing every other position. */
export interface PositionSkip {
  readonly pair: `0x${string}`
  readonly code: SnfErrorCode
}

export interface PortfolioPositions {
  readonly chainId: SnfChainId
  readonly owner: `0x${string}`
  /** One block every position in this result was read at. */
  readonly blockNumber: bigint
  readonly positions: readonly PortfolioPosition[]
  readonly skipped: readonly PositionSkip[]
  readonly poolSet: PoolSetFreshness
}

/** One wrapped-NFT holding for a collection with an SnF pool on this chain. */
export interface WnftHolding {
  readonly collection: `0x${string}`
  readonly wrapper: `0x${string}`
  readonly labels: CollectionLabels
  /** 18-decimal wNFT units. */
  readonly balance: Amount
  /** `floor(balance / 1e18)`. */
  readonly nftWhole: number
  /** Priced against the wrapper's deepest native pool, at mid; `undefined` when no
   * such pool exists to price against. */
  readonly valueInBase: Amount | undefined
  readonly valuation: PortfolioValuation
  readonly valueUsd: number | undefined
}

export interface WnftSkip {
  readonly wrapper: `0x${string}`
  readonly code: SnfErrorCode
}

export interface WnftBalances {
  readonly chainId: SnfChainId
  readonly owner: `0x${string}`
  readonly blockNumber: bigint
  readonly holdings: readonly WnftHolding[]
  readonly skipped: readonly WnftSkip[]
  readonly poolSet: PoolSetFreshness
}

/** One collection the `walletNfts` provider answered for. `tokenIds` is the
 * provider's own answer (enrichment, may lag or be incomplete); `count` is the
 * authoritative on-chain `ERC721.balanceOf` for the same owner/collection. */
export interface HeldCollection {
  readonly collection: `0x${string}`
  readonly labels: CollectionLabels
  readonly tokenIds: readonly string[]
  /** True when the provider's own answer was capped before being included here. */
  readonly tokenIdsTruncated: boolean
  readonly count: number
  /** Where `count` came from — `'on-chain'` whenever the on-chain read succeeded,
   * `'provider'` only as a fallback when it did not. */
  readonly countSource: 'on-chain' | 'provider'
}

/** No `walletNfts` provider was configured on this client — the call issues zero I/O
 * and returns this immediately, never a silent empty list. */
export interface CollectionsHeldUnavailable {
  readonly status: 'unavailable'
  readonly reason: 'no-provider'
  readonly chainId: SnfChainId
  readonly owner: `0x${string}`
}

/** A provider was configured and asked. `'ok'` means every pooled collection got an
 * answer; `'partial'` means at least one is in `unanswered`. `collections` may be `[]`
 * only in this answered case — never as a stand-in for "no provider". */
export interface CollectionsHeldAnswered {
  readonly status: 'ok' | 'partial'
  readonly chainId: SnfChainId
  readonly owner: `0x${string}`
  readonly blockNumber: bigint
  readonly collections: readonly HeldCollection[]
  /** Collections the provider did not answer for or threw on. */
  readonly unanswered: readonly `0x${string}`[]
  readonly poolSet: PoolSetFreshness
}

export type CollectionsHeld = CollectionsHeldUnavailable | CollectionsHeldAnswered

export interface PoolHistoryOptions {
  /** Defaults to 90 day buckets / 24 month buckets; maximum 1000. */
  readonly limit?: number
}

/** One bucket of a pool's history. The series is sparse — a bucket exists only when a
 * swap happened in it, so a gap means no trading activity, not an empty pool. */
export interface PoolHistoryPoint {
  /** Bucket start, unix seconds. */
  readonly t: number
  readonly volumeBase: Amount
  readonly volumeWnft: Amount
  /** The pair's reserves at this bucket's LAST swap — not a period-end snapshot. */
  readonly reserveBase: Amount
  readonly reserveWnft: Amount
  readonly totalSupply: bigint
  readonly txCount: number
}

export interface PoolHistory {
  readonly chainId: SnfChainId
  readonly pair: `0x${string}`
  readonly interval: PoolHistoryInterval
  /** `86_400` for `'day'`, `2_628_000` for `'month'` — 730 hours, not a calendar
   * month. */
  readonly bucketSeconds: 86_400 | 2_628_000
  readonly baseToken: TokenRef
  /** Ascending by `t`; sparse; `[]` is a valid answer (no swaps yet). */
  readonly points: readonly PoolHistoryPoint[]
  readonly asOfBlock: bigint
  readonly lagSeconds: number
  readonly stale: boolean
}
