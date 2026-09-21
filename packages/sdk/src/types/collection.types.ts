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
 * Input to `getCollectionLabels` (plan 10). Both a subgraph-sourced pair and an
 * on-chain-read pair are accepted so the waterfall (subgraph → on-chain → shortened
 * address) can be resolved in ONE call — plan 04's original stub signature (bare
 * `symbol`/`name`) could not distinguish the two sources, which the waterfall's own
 * priority order requires (`.specs/codebase/COLLECTION_IDENTITY.md`). See
 * `snf-54-10-SUMMARY.md`, Deviations, for why this replaces the committed stub shape.
 */
export interface CollectionLabelsInput {
  readonly address: `0x${string}`
  readonly subgraphName?: string | null | undefined
  readonly subgraphSymbol?: string | null | undefined
  readonly onChainName?: string | null | undefined
  readonly onChainSymbol?: string | null | undefined
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
  /**
   * True when the whole EIP-2981 probe itself could not be read (RPC/multicall
   * failure) — distinguishes "this collection has no royalty" (`probeFailed: false`,
   * `bps: 0`) from "we could not tell" (`probeFailed: true`, `bps: 0`). Added by plan
   * 10 (not in plan 04's original shape) — see `snf-54-10-SUMMARY.md`, Deviations.
   */
  readonly probeFailed: boolean
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
