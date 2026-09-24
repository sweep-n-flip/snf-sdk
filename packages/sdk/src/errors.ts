import type { SnfChainId } from './chains/chains.types'
import type { SnfErrorCode, SnfErrorDetails, SnfErrorOptions } from './errors.types'
import { SNF_ERROR_RETRYABLE } from './errors.types'

/**
 * `SnfError` — the one error class every public rejection this package produces is an
 * instance of. See `errors.types.ts` for the closed `SnfErrorCode`
 * union and the retryable-hint map this module derives `retryable` from.
 *
 * A static scan in
 * `test/errors.test.ts` asserts `throw new Error(` occurs zero times anywhere in
 * `src/` outside this file, and that every string literal passed as the first argument
 * to `new SnfError(` is a member of `SNF_ERROR_CODES`.
 */

/**
 * Runtime enumeration of `SnfErrorCode` — lets tests (and callers) iterate at runtime
 * exactly what the type says at compile time. Declared `as const satisfies` so any
 * drift between this array and `SnfErrorCode` fails `tsc --noEmit`, not just a test.
 */
export const SNF_ERROR_CODES = [
  'NO_ROUTE',
  'TOKENIDS_UNAVAILABLE',
  'QUOTE_RECONCILIATION_FAILED',
  'REDEMPTION_LOCKED',
  'WRAPPER_UNVERIFIED',
  'UPSTREAM_DEGRADED',
  'WRONG_CHAIN',
  'INSUFFICIENT_OUTPUT_AMOUNT',
  'PRODUCT_NOT_LIVE',
  'INVALID_PARAMS',
  'USER_REJECTED',
  'UNKNOWN',
] as const satisfies readonly SnfErrorCode[]

/**
 * Default English message per code — substituted whenever a caller passes an
 * empty/whitespace-only `message` (Edge `empty`: an `SnfError` never carries an
 * empty `message`).
 */
const DEFAULT_MESSAGES: Readonly<Record<SnfErrorCode, string>> = {
  NO_ROUTE: 'No viable route exists for this request.',
  TOKENIDS_UNAVAILABLE: 'The requested tokenIds are not available.',
  QUOTE_RECONCILIATION_FAILED: 'The on-chain quote could not be reconciled to the wei.',
  REDEMPTION_LOCKED: 'This collection currently blocks NFT redemption from the wrapper.',
  WRAPPER_UNVERIFIED: 'The wrapper could not be verified against the requested collection.',
  UPSTREAM_DEGRADED: 'The subgraph or RPC upstream is degraded. Retry shortly.',
  WRONG_CHAIN: 'The connected wallet is on the wrong chain.',
  INSUFFICIENT_OUTPUT_AMOUNT: 'The swap would execute below its minimum output bound.',
  PRODUCT_NOT_LIVE: 'This product is not yet live on this chain.',
  INVALID_PARAMS: 'One or more parameters are invalid.',
  USER_REJECTED: 'The wallet rejected the signature request.',
  UNKNOWN: 'An unknown error occurred.',
}

/**
 * The one error class every public SDK rejection is an instance of. `code` is a
 * member of the closed `SnfErrorCode` union; `message` is always non-empty English —
 * an empty/whitespace-only `message` is silently replaced by the code's default
 * (Edge `empty`); `retryable` is always derived from `SNF_ERROR_RETRYABLE`, never
 * accepted from the caller (a caller cannot lie about whether its own error is
 * retryable). `details` is optional and partner-facing diagnostic data only — see
 * `SnfErrorDetails`'s doc comment.
 */
export class SnfError extends Error {
  readonly code: SnfErrorCode
  readonly details: SnfErrorDetails | undefined
  readonly retryable: boolean

  constructor(code: SnfErrorCode, message: string, options: SnfErrorOptions = {}) {
    const safeMessage = message.trim().length > 0 ? message : DEFAULT_MESSAGES[code]
    super(safeMessage, options.cause !== undefined ? { cause: options.cause } : undefined)
    this.name = 'SnfError'
    this.code = code
    this.details = options.details
    this.retryable = SNF_ERROR_RETRYABLE[code]
    // Restores the prototype chain so `instanceof SnfError` survives a downlevelled
    // CJS build (some target/toolchain combinations emit an ES5-style prototype chain
    // for `class extends Error`, which otherwise breaks `instanceof` after transpilation).
    Object.setPrototypeOf(this, SnfError.prototype)
  }
}

/** True for any `SnfError` instance, false for everything else (including a plain `Error`). */
export function isSnfError(e: unknown): e is SnfError {
  return e instanceof SnfError
}

/**
 * Throws `SnfError('INVALID_PARAMS', message, { details })` when `condition` is
 * falsy. The one helper every validation site in this package uses, so
 * `throw new SnfError(` stays rare outside `errors.ts` itself.
 */
export function assertParam(
  condition: unknown,
  message: string,
  details?: SnfErrorDetails,
): asserts condition {
  if (condition) return
  throw new SnfError('INVALID_PARAMS', message, details === undefined ? {} : { details })
}

/**
 * Guards a caller-supplied `chainId` (optional on `QuoteBuyArgs`/`QuoteSellArgs`/
 * `QuoteNftToNftArgs`/`QuoteSwapArgs`) against the client's own chain. This is
 * the first check each of the four `quote*` functions runs: an omitted `argsChainId`
 * is always fine (every implementation actually uses the client's chain, never this
 * field), a matching one is a no-op, and a mismatched one is rejected with the
 * existing `WRONG_CHAIN` code before any other validation or on-chain work.
 */
export function assertChainMatch(
  argsChainId: SnfChainId | undefined,
  clientChainId: SnfChainId,
): void {
  if (argsChainId === undefined || argsChainId === clientChainId) return
  throw new SnfError(
    'WRONG_CHAIN',
    `The supplied chainId ${argsChainId} does not match this client's chain ${clientChainId}.`,
    { details: { argsChainId, clientChainId } },
  )
}

/**
 * Wraps an unknown throwable into an `SnfError`, preserving it as `cause`. Used by
 * every catch site so a raw viem/wallet error can never escape this package untyped
 *. Returns the same instance unchanged if `e` is already an `SnfError`.
 */
export function toSnfError(e: unknown, fallbackCode: SnfErrorCode = 'UNKNOWN'): SnfError {
  if (e instanceof SnfError) return e
  const message =
    e instanceof Error ? e.message : typeof e === 'string' ? e : DEFAULT_MESSAGES[fallbackCode]
  return new SnfError(fallbackCode, message, { cause: e })
}
