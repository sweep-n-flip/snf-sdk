import type { SnfChainId } from '../chains/chains.types'
import type { Amount, TokenRef } from './amount.types'
import type { BuildArgs } from './plan.types'
import type { Quote } from './quote.types'

/**
 * Public liquidity types: add/create/remove/seed args and the `LiquidityQuoteDetails`
 * sub-object every liquidity-side `Quote` carries. Amounts are in pool-axis units
 * unless a field says otherwise — the same convention every other public arg/result
 * shape in this package already follows.
 */

/** `'nft'` redeems whole NFTs plus a fractional wNFT remainder; `'wnft'` redeems only
 * the fungible wrapper token and works at any share size, including a share too small
 * to redeem even one whole NFT. */
export type RemoveLiquidityMode = 'nft' | 'wnft'

/** Args for `quoteAddLiquidity` — an existing pool only; a pool that does not yet
 * exist is `quoteCreatePool`'s job, not this one's. */
export interface QuoteAddLiquidityArgs {
  readonly chainId?: SnfChainId
  readonly collection: `0x${string}`
  /** Decimal strings; the NFTs deposited. */
  readonly tokenIds: readonly string[]
  /** `null`/omitted = native pool; an ERC-20 address targets that pool specifically. */
  readonly baseToken?: `0x${string}` | null
}

/** Args for `quoteCreatePool` — the same shape as an add, plus the deposit that sets
 * the pool's opening price. */
export interface QuoteCreatePoolArgs extends QuoteAddLiquidityArgs {
  /** The whole base deposit, pool-axis units — together with the tokenIds count,
   * this is what fixes the pool's initial exchange rate. */
  readonly baseAmount: bigint
}

/** Args for `quoteRemoveLiquidity`. Exactly one of `liquidity`/`bps` is required at
 * runtime. */
export interface QuoteRemoveLiquidityArgs {
  readonly chainId?: SnfChainId
  readonly pair: `0x${string}`
  readonly owner: `0x${string}`
  readonly liquidity?: bigint
  /** Integer 1..10000 of the owner's live LP balance — never a float percent, so a
   * caller can never lose precision converting a UI slider into a share. */
  readonly bps?: number
  readonly mode: RemoveLiquidityMode
  /** `nft` mode only; omitted lets the SDK pick candidates itself. */
  readonly tokenIds?: readonly string[]
}

/** The `Quote.liquidity` sub-object every add/create/remove quote carries — the
 * on-chain-derived figures a liquidity `build*` re-reads identity from, never trusts
 * for the actual transaction bounds. */
export interface LiquidityQuoteDetails {
  /** `null` when this very deposit is what creates the pair. */
  readonly pair: `0x${string}` | null
  /** `null` when this very deposit is what creates the wrapper. */
  readonly wrapper: `0x${string}` | null
  /** The pool's real base token — its address is the actual base token, never null,
   * even for a native pool. */
  readonly baseToken: TokenRef
  /** `null` while the pair does not exist yet — there is no reserve ordering to report. */
  readonly wrapperIsToken0: boolean | null
  readonly reserves: { readonly base: bigint; readonly wnft: bigint }
  readonly totalSupply: bigint
  readonly blockNumber: bigint
  /** add/create: the count deposited; remove: the whole NFTs redeemed. */
  readonly nftCount: number
  /** Remove only. */
  readonly owner?: `0x${string}`
  /** add/create: the base the Router actually pulls at `blockNumber`. */
  readonly baseRequired?: Amount
  /** ERC-20 add only: the ceil amount the desired/approval figure must cover — the
   * Router's own floor rounding would otherwise revert the deposit. */
  readonly baseDesired?: Amount
  /** create only: `baseAmount / nftCount`, display only. */
  readonly pricePerNft?: Amount
  /** add/create. */
  readonly lpOut?: Amount
  /** Remove. */
  readonly lpIn?: Amount
  /** Remove. */
  readonly baseOut?: Amount
  /** Remove, wrapper units (18 decimals). */
  readonly wnftOut?: Amount
  /** Remove, `nft` mode: the whole-NFT count the redemption actually produces. */
  readonly nftWhole?: number
  /** Remove, `nft` mode: `wnftOut` minus `nftWhole` whole units. */
  readonly wnftRemainder?: Amount
  /** Remove only. */
  readonly mode?: RemoveLiquidityMode
  /** Remove: `lpIn / totalSupply`. */
  readonly shareBps?: number
  /** A liquidity figure is only exact when the Pair's protocol-fee mint is off — a
   * quote is only ever constructed when this reads true on-chain, so the field is the
   * literal `true` rather than a plain boolean. */
  readonly feeToZero: true
}

/** Args for `buildAddLiquidity` — the common `BuildArgs` plus where the LP lands. */
export interface BuildAddLiquidityArgs extends BuildArgs {
  /** Default: `recipient`. */
  readonly lpRecipient?: `0x${string}`
}

/** Args for `buildCreatePool`. `quote` is identity-only — the build re-reads every
 * number on-chain rather than trusting anything the quote already computed. */
export interface BuildCreatePoolArgs {
  readonly quote: Quote
  /** The payer (NFT owner, base payer) and signer. */
  readonly recipient: `0x${string}`
  /** Default: `recipient`. */
  readonly lpRecipient?: `0x${string}`
  readonly deadline?: number
}

/** Args for `buildSeed`. `lpRecipient` has no default — a launch's LP destination is
 * an explicit choice, never an implicit fallback. */
export interface BuildSeedArgs {
  readonly collection: `0x${string}`
  /** Sorted ascending (as bigint) by the SDK before encoding. */
  readonly tokenIds: readonly string[]
  /** Pool-axis units per whole NFT — the declared launch price. */
  readonly pricePerNft: bigint
  /** `null`/omitted = native. */
  readonly baseToken?: `0x${string}` | null
  readonly payer: `0x${string}`
  readonly lpRecipient: `0x${string}`
  /** Existing-pool path only — how far the live price may drift from `pricePerNft`
   * before the seed refuses to settle. */
  readonly priceToleranceBps?: number
  readonly deadline?: number
}

/** The result of `lpPosition`. */
export interface LpPosition {
  readonly pair: `0x${string}`
  readonly owner: `0x${string}`
  readonly lpBalance: Amount
  readonly totalSupply: bigint
  readonly shareBps: number
  readonly underlying: { readonly base: Amount; readonly wnft: Amount; readonly nftWhole: number }
  readonly blockNumber: bigint
}

/** The result of `redemptionStatus` — a tri-state probe, never a hard boolean,
 * because an ambiguous or unreadable probe result must never be reported as
 * confidently "allowed". */
export interface RedemptionStatus {
  readonly status: 'allowed' | 'blocked' | 'unknown'
  readonly sampleTokenId?: string
  readonly reason?: string
  readonly source: 'enumerable' | 'subgraph' | 'provider' | 'none'
}
