import type { SnfChainId } from '../chains/chains.types'
import type { Amount } from './amount.types'

/**
 * Quote shapes (R8–R12; 54-SPEC.md; DATASHEET §4 "NFT AMM — quotes" + this phase's
 * `reconciled` addendum). Every quote is on-chain authoritative.
 */

/** Fee breakdown for a quote (DATASHEET §0.5). `pool` is the AMM curve fee — already
 * inside the quoted amounts, so it carries no separate `Amount`, only `bps` + a `note`
 * (matching the DATASHEET's `{ bps, note: "included in curve" }` shape). `marketplace`
 * and `royalty` are each a full `Amount` plus their own `bps`; `royalty.capApplied` is
 * true when the Router's on-chain cap actually reduced the royalty below its nominal
 * EIP-2981 rate. */
export interface FeeBreakdown {
  readonly pool: { readonly bps: number; readonly note: string }
  readonly marketplace: Amount & { readonly bps: number }
  readonly royalty: Amount & { readonly bps: number; readonly capApplied: boolean }
}

/** One leg of a `Quote.legs[]` — one pool hop, whether it's the only hop today or one
 * of several in a future multipool split (DATASHEET §4: "same `legs[]` shape whether
 * it's one pool or a future multipool split"). */
export interface QuoteLeg {
  readonly pair: `0x${string}`
  readonly count: number
  readonly amount: Amount
  readonly path: readonly `0x${string}`[]
  readonly feeBps: number
  readonly kind: 'native' | 'erc20' | 'wnft'
  readonly side: 'buy' | 'sell'
  /**
   * This leg's own fee breakdown (plan 13 addition — not in plan 04's original
   * shape). `nft-to-nft` is the first quote kind with two independently-priced legs:
   * royalty is paid per leg in that leg's own base currency and is NEVER
   * consolidated (docs/NFT_SWAP_RULES.md) — this field is what lets a single leg
   * carry its own marketplace/royalty amounts while `Quote.fees` reports the sum.
   * Omitted on the single-leg `buy`/`sell` quote kinds, whose only `FeeBreakdown`
   * lives at `Quote.fees` (see `snf-54-13-SUMMARY.md`, Deviations).
   */
  readonly fees?: FeeBreakdown
  /**
   * This leg's own NFT collection/wrapper (plan 15 addition — not in plan 04's
   * original shape, nor plan 13's). Needed by `build/*`'s `StepPreflightRefs` (R14):
   * `Quote.collection` is only populated for the single-collection `buy`/`sell`
   * kinds, and NOTHING on the committed `Quote`/`QuoteLeg` shape carried a wrapper
   * address anywhere — `nft-to-nft` in particular has no top-level `collection` at
   * all (its two legs price DIFFERENT collections), so per-leg fields are the only
   * place these can live generically across every quote kind a builder consumes.
   * Omitted on the `swap`/`wnft` legs, which have no NFT collection to name.
   */
  readonly collection?: `0x${string}`
  readonly wrapper?: `0x${string}`
  /**
   * The concrete tokenIds this leg buys/sells (plan 15 addition). Redundant with the
   * top-level `Quote.tokenIds` on the single-collection `buy`/`sell` kinds (kept here
   * too for uniformity), but the ONLY place these ids exist at all on `nft-to-nft`,
   * whose `Quote` carries no top-level `tokenIds` (each leg trades a different set).
   */
  readonly tokenIds?: readonly string[]
}

/**
 * The result of any `quote*` call. `reconciled` is typed as the literal `true` — a
 * `Quote` that did not reconcile to the wei against the Router's own on-chain read is
 * never constructed; the alternative is always `SnfError('QUOTE_RECONCILIATION_FAILED')`,
 * never a `Quote` with `reconciled: false` (T-54-18 in the threat register).
 */
export interface Quote {
  readonly side: 'buy' | 'sell' | 'swap' | 'nft-to-nft'
  readonly chainId: SnfChainId
  readonly collection?: `0x${string}`
  readonly count?: number
  readonly tokenIds?: readonly string[]
  readonly legs: readonly QuoteLeg[]
  readonly fees: FeeBreakdown
  readonly totalCost?: Amount
  readonly totalProceeds?: Amount
  /** nft-to-nft only: sell-leg proceeds after its own fees, before the buy-leg top-up. */
  readonly netProceeds?: Amount
  /** nft-to-nft only: buy-leg cost including its own fees. */
  readonly buyCost?: Amount
  /** nft-to-nft only: change returned to the seller — saturates to 0 when `buyCost > netProceeds` (R9). */
  readonly remainder?: Amount
  /**
   * nft-to-nft only (plan 15 addition): which top-up mode `remainder` was priced in —
   * `'native'` (the chain's own base currency) or `'wnft'` (the buy collection's
   * wrapper units, a real sequential follow-up trade against the buy pool's POST-buy
   * reserves — see `quoteNftToNft.ts`). `buildNftToNft` needs this literal flag to
   * decide whether to emit the third `swap-buy-wnft` step; `Quote.remainder.symbol`
   * alone is not a safe discriminant (a collection's own symbol could coincide with
   * the chain's native symbol).
   */
  readonly remainderMode?: 'native' | 'wnft'
  /**
   * swap only (plan 13 addition — not in plan 04's original shape, DATASHEET §4
   * `/v1/quote/swap`: "Returns `amountIn`, `amountOut`, `path[]`, `priceImpact`").
   * The exact input spent.
   */
  readonly amountIn?: Amount
  /** swap only: the exact output received. */
  readonly amountOut?: Amount
  /**
   * swap only (plan 15 addition): which side the caller pinned exactly — `'in'` when
   * `amountIn` was given (`amountOutMin` is the protective floor bound), `'out'` when
   * `amountOut` was given (`amountInMax` is the protective ceiling bound).
   * `buildSwap` needs this to pick the matching Router entry point and to know which
   * of `amountIn`/`amountOut` is the FIXED figure vs. which is the fresh bound.
   */
  readonly amountSpecified?: 'in' | 'out'
  readonly priceImpact: number
  readonly deliverable: number
  readonly bestEffort: boolean
  readonly expiresAt: string
  readonly reconciled: true
  readonly stale?: boolean
  /**
   * Non-fatal notes (plan 12 addition — not in plan 04's original shape): a locked
   * redemption on a sell, an Arc unpayable-royalty adjustment on either side. Never
   * a reason to fail the call — see `snf-54-12-SUMMARY.md`, Deviations, for why
   * this field was required to implement the plan's own literal `<behavior>` text
   * ("adds a `warnings` entry to the quote and does not throw").
   */
  readonly warnings?: readonly string[]
}

/** Args for `quoteBuy` (R8). Exactly one of `count`/`tokenIds`/`amount` is required
 * at runtime — `INVALID_PARAMS` otherwise. */
export interface QuoteBuyArgs {
  readonly chainId: SnfChainId
  readonly collection: `0x${string}`
  readonly count?: number
  readonly tokenIds?: readonly string[]
  /**
   * A fractional wNFT amount, in wrapper units (`1 NFT = 1e18`) — plan 12 addition
   * (not in plan 04's original shape; see `snf-54-12-SUMMARY.md`, Deviations).
   * Routes through the fungible leg (`getAmountsIn` on the wrapper token itself),
   * never the `*Collection` path — a fractional amount has no tokenId to carry an
   * EIP-2981 royalty.
   */
  readonly amount?: bigint
  /** `null`/omitted = native. An ERC-20 address routes through a multi-hop path. */
  readonly payToken?: `0x${string}` | null
}

/** Args for `quoteSell` (R8). Exactly one of `tokenIds`/`count`/`amount` is
 * required at runtime. */
export interface QuoteSellArgs {
  readonly chainId: SnfChainId
  readonly collection: `0x${string}`
  readonly tokenIds?: readonly string[]
  readonly count?: number
  /** A fractional wNFT amount, in wrapper units — see `QuoteBuyArgs.amount`'s doc
   * comment; the sell-side mirror (plan 12 addition). */
  readonly amount?: bigint
  /** `null`/omitted = native. */
  readonly receiveToken?: `0x${string}` | null
}

/** Args for `quoteNftToNft` (R9): sell collection A's tokenIds, buy N of collection B. */
export interface QuoteNftToNftArgs {
  readonly chainId: SnfChainId
  readonly sell: { readonly collection: `0x${string}`; readonly tokenIds: readonly string[] }
  readonly buy: { readonly collection: `0x${string}`; readonly count: number }
  readonly remainder: 'native' | 'wnft'
}

/** Args for `quoteSwap` (R10, fungible↔fungible, delegate-aware). Exactly one of
 * `amountIn`/`amountOut` is required at runtime. */
export interface QuoteSwapArgs {
  readonly chainId: SnfChainId
  readonly tokenIn: `0x${string}` | null
  readonly tokenOut: `0x${string}` | null
  readonly amountIn?: bigint
  readonly amountOut?: bigint
  readonly directOnly?: boolean
}

// `LadderPoint`/`LadderResult` used to be declared here as a float-shaped placeholder
// (plan 04). Plan 09 (Deviations, snf-54-09-SUMMARY.md) reconciled `SnfClient.
// estimateLadder`'s return type to the real, bigint-exact shape `math/nftPricing.ts`'s
// `estimateLadder` actually produces (`math/nftPricing.types.ts`'s `LadderResult`) —
// see `client.types.ts`'s import. This file no longer declares a second, unused
// `LadderResult`/`LadderPoint` pair; grep found no consumer of the old shape outside
// `client.types.ts` itself before this plan.
