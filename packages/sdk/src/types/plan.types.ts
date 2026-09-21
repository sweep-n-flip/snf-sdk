import type { SnfChainId } from '../chains/chains.types'
import type { Quote } from './quote.types'

/**
 * Execution-plan shapes (R13, R14; 54-SPEC.md; DATASHEET §5 "NFT AMM — execution
 * builders").
 */

/** Unsigned calldata for one transaction — `chainId` is always explicit (SPEC
 * Constraint: "chainId explícito em toda tx"), never inferred from the active
 * `publicClient`. */
export interface UnsignedTx {
  readonly to: `0x${string}`
  readonly data: `0x${string}`
  readonly value: bigint
  readonly chainId: SnfChainId
  readonly gas?: bigint
  /** Present only when `gas` is the deterministic NFT-batch fallback because this
   * step's OWN swap simulation could not be attempted against live state — the plan
   * contains a still-pending approval this step depends on (snf-54-18F, Finding 2).
   * Additive; absent for every other step. */
  readonly gasSource?: 'fallback-pending-approval'
}

/** An allowance/operator-approval step, only emitted when it is actually missing
 * on-chain — the builder pre-checks allowances and lists only the missing ones (R13
 * Edge `empty | R13`: no missing approvals ⇒ `steps` contains only the swap). */
export interface Approval {
  readonly kind: 'erc721-approval-for-all' | 'erc20-allowance'
  readonly token: `0x${string}`
  readonly spender: `0x${string}`
  readonly tx: UnsignedTx
  readonly note: string
}

/**
 * Slippage/deadline bounds. ALWAYS derived from a fresh on-chain re-quote performed
 * inside `build()` — NEVER from the caller-supplied `quote` argument (SPEC
 * prohibition: never trust caller-supplied prices for `bounds`/`value`/`amountOutMin`).
 * Units are always **pool-side quote decimals**, never wei, on every chain including
 * Arc (R11).
 */
export interface Bounds {
  readonly amountInMax?: bigint
  readonly amountOutMin?: bigint
  readonly slippageBps: number
  readonly deadline: bigint
}

export type StepKind = 'approval' | 'swap-buy' | 'swap-sell' | 'swap-buy-wnft' | 'swap-fungible'

/**
 * Everything `runPreflight` (plan 14, R14) needs to re-verify ONE step against the
 * chain, in the exact frame of a signature. Plan 14 addition — not in plan 04's
 * original `Step` shape (see `snf-54-14-SUMMARY.md`, Deviations): the four checks R14
 * requires (payer ownership on a sell, pool custody on a buy, wrapper identity, an
 * ERC-20 base balance) need domain addresses/ids that no other field on `Step`/
 * `Quote` carries generically across buy/sell/swap/nft-to-nft — `Quote.collection`
 * and `Quote.tokenIds` are only populated for the single-collection buy/sell kinds,
 * and neither carries the wrapper address or the signing payer. A `'swap-*'` step a
 * `build*` function assembles is expected to populate this; an `'approval'` step
 * carries none (granting an allowance changes nothing about which ids are being
 * bought/sold).
 */
export interface StepPreflightRefs {
  /** The wallet whose ownership/balance this step's checks are against — the same
   * address `BuildArgs.recipient` named at build time. */
  readonly payer: `0x${string}`
  readonly collection: `0x${string}`
  readonly wrapper: `0x${string}`
  readonly pair: `0x${string}`
  /** tokenIds this step SELLS — the payer must currently own every one. */
  readonly sellTokenIds?: readonly string[]
  /** tokenIds this step BUYS — the pair must currently hold every one. */
  readonly buyTokenIds?: readonly string[]
  /** The ERC-20 base token this step spends, when the base is not native — absent
   * for a native-base leg. */
  readonly erc20Base?: `0x${string}`
}

/** One step of an `ExecutionPlan.steps[]` — approvals are always ordered before the
 * swap they unblock (Edge `ordering | R13`). */
export interface Step {
  readonly kind: StepKind
  readonly label: string
  readonly tx: UnsignedTx
  readonly approvals: readonly Approval[]
  readonly bounds: Bounds
  readonly quote: Quote
  readonly preflightRefs?: StepPreflightRefs
}

/** Result of `plan.preflight()` (R14) — every check ran against the same
 * `blockNumber` via a single Multicall3 call. A failed pre-flight never returns this
 * shape; it throws a typed `SnfError` instead (`TOKENIDS_UNAVAILABLE`,
 * `WRAPPER_UNVERIFIED`, `WRONG_CHAIN`, `INVALID_PARAMS`) before any signature. */
export interface PreflightResult {
  readonly ok: true
  readonly blockNumber: bigint
  readonly checked: readonly string[]
  /** Present only when the ONE-call guarantee degraded to a one-block sequential
   * fallback (multicall3 itself threw) — plan 14 addition, mirrors `Quote.warnings`
   * (never a reason to fail the call on its own). */
  readonly warnings?: readonly string[]
}

/** The output of every `build*` function (R13). */
export interface ExecutionPlan {
  readonly chainId: SnfChainId
  readonly steps: readonly Step[]
  readonly expiresAt: string
  preflight(): Promise<PreflightResult>
}

/**
 * Common args every `build*` client method accepts: the anchor `quote` (identifies
 * WHAT to buy/sell — collection, tokenIds/count — for display continuity) plus
 * execution parameters. `slippageBps` defaults to 100 (1%); `deadline` defaults to
 * now+20 min, capped at now+1h (`INVALID_PARAMS` above that). `bounds`/`value` are
 * NEVER derived from `quote`'s own numeric fields — `build()` always re-quotes
 * on-chain internally.
 */
export interface BuildArgs {
  readonly quote: Quote
  readonly recipient: `0x${string}`
  readonly slippageBps?: number
  readonly deadline?: number
}
