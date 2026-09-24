import type { SnfChainId } from '../chains/chains.types'
import type { Amount } from './amount.types'

/**
 * Quote shapes for the SDK's NFT AMM quotes, plus the `reconciled` addendum.
 * Every quote is on-chain authoritative.
 */

/** Fee breakdown for a quote. `pool` is the AMM curve fee — already
 * inside the quoted amounts, so it carries no separate `Amount`, only `bps` + a `note`
 * (matching the same `{ bps, note: "included in curve" }` shape this SDK's REST API
 * counterpart uses). `marketplace`
 * and `royalty` are each a full `Amount` plus their own `bps`; `royalty.capApplied` is
 * true when the Router's on-chain cap actually reduced the royalty below its nominal
 * EIP-2981 rate. */
export interface FeeBreakdown {
  readonly pool: { readonly bps: number; readonly note: string }
  readonly marketplace: Amount & { readonly bps: number }
  readonly royalty: Amount & { readonly bps: number; readonly capApplied: boolean }
}

/** One leg of a `Quote.legs[]` — one pool hop, whether it's the only hop today or one
 * of several in a future multipool split (the same `legs[]` shape applies whether
 * it's one pool or a future multipool split). */
export interface QuoteLeg {
  readonly pair: `0x${string}`
  readonly count: number
  readonly amount: Amount
  readonly path: readonly `0x${string}`[]
  readonly feeBps: number
  readonly kind: 'native' | 'erc20' | 'wnft'
  readonly side: 'buy' | 'sell'
  /**
   * This leg's own fee breakdown (a later addition, not the original shape).
   * `nft-to-nft` is the first quote kind with two independently-priced legs:
   * royalty is paid per leg in that leg's own base currency and is NEVER
   * consolidated (docs/NFT_SWAP_RULES.md) — this field is what lets a single leg
   * carry its own marketplace/royalty amounts while `Quote.fees` reports the sum.
   * Omitted on the single-leg `buy`/`sell` quote kinds, whose only `FeeBreakdown`
   * lives at `Quote.fees`.
   */
  readonly fees?: FeeBreakdown
  /**
   * This leg's own NFT collection/wrapper (a later addition, not part of the
   * original shape). Needed by `build/*`'s `StepPreflightRefs`:
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
   * The concrete tokenIds this leg buys/sells. Redundant with the
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
 * never a `Quote` with `reconciled: false`.
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
  /** nft-to-nft only: change returned to the seller — saturates to 0 when `buyCost > netProceeds`. */
  readonly remainder?: Amount
  /**
   * nft-to-nft only: which top-up mode `remainder` was priced in —
   * `'native'` (the chain's own base currency) or `'wnft'` (the buy collection's
   * wrapper units, a real sequential follow-up trade against the buy pool's POST-buy
   * reserves — see `quoteNftToNft.ts`). `buildNftToNft` needs this literal flag to
   * decide whether to emit the third `swap-buy-wnft` step; `Quote.remainder.symbol`
   * alone is not a safe discriminant (a collection's own symbol could coincide with
   * the chain's native symbol).
   */
  readonly remainderMode?: 'native' | 'wnft'
  /**
   * swap only (a later addition, matching this SDK's REST API counterpart's own
   * `/v1/quote/swap` response shape: `amountIn`, `amountOut`, `path[]`, `priceImpact`).
   * The exact input spent.
   */
  readonly amountIn?: Amount
  /** swap only: the exact output received. */
  readonly amountOut?: Amount
  /**
   * swap only: which side the caller pinned exactly — `'in'` when
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
   * Non-fatal notes: a locked redemption on a sell, an Arc unpayable-royalty
   * adjustment on either side. Never a reason to fail the call — the quote still
   * returns, with a `warnings` entry added instead of throwing.
   */
  readonly warnings?: readonly string[]
}

/** Args for `quoteBuy`. Exactly one of `count`/`tokenIds`/`amount` is required
 * at runtime — `INVALID_PARAMS` otherwise. `chainId` is optional and, when supplied,
 * validated against the client's own chain (`WRONG_CHAIN` on a mismatch). */
export interface QuoteBuyArgs {
  readonly chainId?: SnfChainId
  readonly collection: `0x${string}`
  readonly count?: number
  readonly tokenIds?: readonly string[]
  /**
   * A fractional wNFT amount, in wrapper units (`1 NFT = 1e18`) — a later addition.
   * Routes through the fungible leg (`getAmountsIn` on the wrapper token itself),
   * never the `*Collection` path — a fractional amount has no tokenId to carry an
   * EIP-2981 royalty.
   */
  readonly amount?: bigint
  /** `null`/omitted = native. An ERC-20 address routes through a multi-hop path. */
  readonly payToken?: `0x${string}` | null
}

/** Args for `quoteSell`. Exactly one of `tokenIds`/`count`/`amount` is
 * required at runtime. `chainId` is optional and, when supplied, validated against
 * the client's own chain (`WRONG_CHAIN` on a mismatch). */
export interface QuoteSellArgs {
  readonly chainId?: SnfChainId
  readonly collection: `0x${string}`
  readonly tokenIds?: readonly string[]
  readonly count?: number
  /** A fractional wNFT amount, in wrapper units — see `QuoteBuyArgs.amount`'s doc
   * comment; the sell-side mirror. */
  readonly amount?: bigint
  /** `null`/omitted = native. */
  readonly receiveToken?: `0x${string}` | null
}

/** Args for `quoteNftToNft`: sell collection A's tokenIds, buy N of collection B.
 * `chainId` is optional and, when supplied, validated against the client's own chain
 * (`WRONG_CHAIN` on a mismatch). */
export interface QuoteNftToNftArgs {
  readonly chainId?: SnfChainId
  readonly sell: { readonly collection: `0x${string}`; readonly tokenIds: readonly string[] }
  readonly buy: { readonly collection: `0x${string}`; readonly count: number }
  readonly remainder: 'native' | 'wnft'
}

/** Args for `quoteSwap` (fungible↔fungible, delegate-aware). Exactly one of
 * `amountIn`/`amountOut` is required at runtime. `chainId` is optional and, when
 * supplied, validated against the client's own chain (`WRONG_CHAIN` on a mismatch). */
export interface QuoteSwapArgs {
  readonly chainId?: SnfChainId
  readonly tokenIn: `0x${string}` | null
  readonly tokenOut: `0x${string}` | null
  readonly amountIn?: bigint
  readonly amountOut?: bigint
  readonly directOnly?: boolean
}

// `LadderPoint`/`LadderResult` used to be declared here as a float-shaped placeholder.
// A later revision reconciled `SnfClient.estimateLadder`'s return type to the real,
// bigint-exact shape `math/nftPricing.ts`'s `estimateLadder` actually produces
// (`math/nftPricing.types.ts`'s `LadderResult`) — see `client.types.ts`'s import. This
// file no longer declares a second, unused `LadderResult`/`LadderPoint` pair; grep
// found no consumer of the old shape outside `client.types.ts` itself.
