import { notImplemented } from './internal/stub'
import type { SnfError } from './errors'

/**
 * Maps any unknown throwable to a stable `SnfError` (R17). NEVER throws itself — even
 * `null`/`undefined`/an empty string maps to `SnfError('UNKNOWN', ...)`, not a
 * secondary exception. Preserves the wallet-rejection → RPC-auth → known-Uniswap-V2-
 * revert-string → generic classification order from `snf-client/src/lib/revert.ts`
 * (first-match-wins cascade), re-targeted to return a stable `code` instead of a
 * free-text string.
 *
 * @gsd-stub — implemented by plan 07. Source analog: snf-client/src/lib/revert.ts +
 * snf-drops-registration/.../genesis/swap/describeSwapError.ts (branch feature/registration).
 */
export function describeError(e: unknown): SnfError {
  void e
  return notImplemented('describeError', '07')
}
