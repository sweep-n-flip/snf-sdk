import type { SnfError } from '../errors'
import type { Amount } from './amount.types'
import type { Step } from './plan.types'

/**
 * Headless, user-driven checkout state machine (R15, R16; 54-SPEC.md; INV-17
 * doctrine). `snf-client`'s 18-state `CheckoutStep`/`CheckoutOperation` union
 * (`checkout.types.ts`) is this SDK's reference — the SDK's shape is a reduction: 11
 * states cover every SDK-native swap flow (fungible/buy/sell/nft-to-nft), since the
 * SDK has no liquidity/farm/aggregator operations to represent.
 */

/**
 * Exactly R15's 11 states. Each on-chain tx is only ever dispatched by an explicit
 * `next()` call — a watcher (`onReceipt`) may only ADVANCE state, never dispatch one
 * (INV-17: auto-advancing from a watcher/effect caused four fix-cycles on snf-client
 * before this doctrine hardened — memory `feedback_wagmi_reset_race`). `ready-buy` and
 * `ready-buy-wnft` are the NFT×NFT checkpoints where the user must click again before
 * the next leg fires.
 */
export type CheckoutState =
  | 'review'
  | 'ready-approve'
  | 'wallet-approve'
  | 'pending-approve'
  | 'ready-swap'
  | 'wallet'
  | 'pending'
  | 'ready-buy'
  | 'ready-buy-wnft'
  | 'success'
  | 'error'

/** The current, fully-derived state of a `Checkout` instance. */
export interface CheckoutSnapshot {
  readonly state: CheckoutState
  readonly stepIndex: number
  readonly label: string
  readonly canProceed: boolean
  /** Monotonic per-instance counter — a receipt tagged with a superseded `sessionId`
   * (e.g. delivered after `cancel()`) is ignored, never applied to state. */
  readonly sessionId: number
  readonly error?: SnfError
  /** Strictly increasing per instance — bumped on every successfully parsed receipt
   * so react-query consumers know to refetch (R16, R18). */
  readonly txInvalidationVersion: number
}

/** Events a `Checkout` instance emits to `subscribe` listeners. */
export type CheckoutEvent =
  | { readonly type: 'dispatched'; readonly step: Step }
  | { readonly type: 'receipt'; readonly receipt: ReceiptLike }
  | { readonly type: 'rejected'; readonly error: SnfError }
  | { readonly type: 'cancelled' }

/**
 * The minimal, structural shape `Checkout.onReceipt` accepts — deliberately not
 * `viem`'s `TransactionReceipt` so a caller can feed whatever their own wallet/watcher
 * already returns without importing viem's full type for this one call site.
 * `parseReceipt` (the client method) is the one that consumes the full
 * `TransactionReceipt` and produces a `SwapReceipt`.
 */
export interface ReceiptLike {
  readonly status: 'success' | 'reverted'
  readonly transactionHash: `0x${string}`
  readonly blockNumber: bigint
  readonly logs: readonly unknown[]
}

/**
 * Result of `parseReceipt(receipt)` (R16) — items and fees attributed from the
 * `Swap`/`Transfer`/`WETH.Withdrawal`/`Deposit` logs. Exactly one of `paid`/`received`
 * is present, depending on whether the parsed transaction was a buy or a sell leg.
 */
export interface SwapReceipt {
  readonly itemsIn: readonly string[]
  readonly itemsOut: readonly string[]
  readonly paid?: Amount
  readonly received?: Amount
  readonly fees: { readonly marketplace: Amount; readonly royalty: Amount }
  readonly txInvalidationVersion: number
}

/**
 * Headless checkout instance returned by `createCheckout(plan)`. `next()` is the ONLY
 * member that may return a step to dispatch — a caller's own wallet-sending code reads
 * `next()`'s return value and sends it; `onReceipt` may only advance state (INV-17),
 * never itself dispatch a transaction. `cancel()` is only effective in `review`/`ready-*`
 * states (R15 acceptance).
 */
export interface Checkout {
  snapshot(): CheckoutSnapshot
  next(): Step | null
  cancel(): void
  onReceipt(receipt: ReceiptLike): void
  subscribe(fn: (event: CheckoutEvent) => void): () => void
}
