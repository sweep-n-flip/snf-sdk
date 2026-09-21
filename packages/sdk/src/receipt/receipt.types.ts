import type { Log } from 'viem'

import type { Amount } from '../types/amount.types'

/**
 * `parseReceipt` result and input shapes (R16; 54-SPEC.md). See `parseReceipt.ts`'s
 * header for what this module can and cannot honestly attribute from a receipt's own
 * logs alone — that scope is what these two types are shaped around.
 */

/**
 * The minimal, structural shape `parseReceipt` needs — a subset of viem's
 * `TransactionReceipt`, so a partner can pass a receipt from ANY source (their own
 * wallet lib, a `publicClient.waitForTransactionReceipt`, a fixture in a test) without
 * constructing a full 15-field `TransactionReceipt`. Every real `TransactionReceipt`
 * satisfies this structurally — this is a narrowing, never a divergence.
 */
export interface ReceiptLike {
  readonly status: 'success' | 'reverted'
  readonly transactionHash: `0x${string}`
  readonly blockNumber: bigint
  readonly logs: readonly Log[]
}

/**
 * What a completed transaction actually did, attributed from its OWN logs — never
 * from a quote, and never fabricated when a log doesn't exist to attribute from
 * (`warnings` names exactly what could not be measured, per-field).
 *
 * `itemsIn`/`itemsOut` are decimal tokenId strings, discovered from ERC-721 `Transfer`
 * logs — this SDK has no notion of "your collection" ahead of time, so both arrays are
 * populated purely from what the receipt's own logs say moved. `paid`/`received` are
 * each present only on the side the receipt is actually settling (a sell reports
 * `received`, a buy reports `paid`; neither on a receipt with no recognisable
 * settlement log at all).
 */
export interface SwapReceipt {
  readonly itemsIn: readonly string[]
  readonly itemsOut: readonly string[]
  readonly paid?: Amount
  readonly received?: Amount
  readonly fees: { readonly marketplace: Amount; readonly royalty: Amount }
  /** Strictly increasing per client instance (`SnfClientContext.nextTxInvalidationVersion`)
   * — owned by the instance, never derived from `blockNumber`/`transactionIndex`, so an
   * out-of-order or reorged receipt delivery cannot make it stall or go backwards (R16
   * concurrency backstop). */
  readonly txInvalidationVersion: number
  readonly blockNumber: bigint
  /** Non-empty whenever a field above could not be measured from this receipt's own
   * logs and was substituted with `0`/`[]` instead of a fabricated number — e.g. "no
   * WETH Withdrawal/Deposit log found", "marketplace fee not attributable (the
   * marketplace wallet emitted no receipt event)". Empty array ⇒ every field above is
   * a directly measured value. */
  readonly warnings: readonly string[]
}
