import type { TransactionReceipt } from 'viem'

import { notImplemented } from '../internal/stub'
import type { SwapReceipt } from '../types/checkout.types'
import type { SnfClientContext } from '../types/client.types'

/**
 * Attributes `itemsIn`/`itemsOut`/fees from an already-mined `TransactionReceipt`'s
 * `Swap`/`Transfer`/`WETH.Withdrawal`/`Deposit` logs (R16). Synchronous — the logs are
 * already on the receipt, so no further RPC read is needed. `status: 'reverted'`
 * throws a typed `SnfError` (`INSUFFICIENT_OUTPUT_AMOUNT` when decodable, `UNKNOWN`
 * otherwise) instead of returning a partial `SwapReceipt`.
 *
 * @gsd-stub — implemented by plan 08. Source analog:
 * snf-drops-registration/.../genesis/swap/sellReceipt.ts (branch feature/registration).
 */
export function parseReceipt(ctx: SnfClientContext, receipt: TransactionReceipt): SwapReceipt {
  void ctx
  void receipt
  return notImplemented('parseReceipt', '08')
}
