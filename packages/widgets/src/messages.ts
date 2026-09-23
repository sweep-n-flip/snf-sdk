import { SNF_ERROR_CODES, type SnfErrorCode } from '@sweepnflip/sdk'
import type { SnfWidgetMessages } from './messages.types'

/**
 * D-10 / R10 — one partner-facing English default per SDK error code.
 *
 * `MESSAGE_BY_CODE` is typed `satisfies Readonly<Record<SnfErrorCode, string>>` — the
 * same `as const satisfies` discipline `packages/sdk/src/errors.ts`'s own
 * `SNF_ERROR_CODES` declaration uses — so if `@sweepnflip/sdk` ever adds a thirteenth
 * code, `tsc` fails here (a required key is missing) until this file adds an entry for
 * it too. `DEFAULT_WIDGET_MESSAGES` itself is then DERIVED by mapping over
 * `SNF_ERROR_CODES` (the SDK's own runtime array of all twelve codes), never a
 * hand-typed key list built independently of it.
 *
 * These are partner-facing UI copy, not the SDK's own internal defaults
 * (`packages/sdk/src/errors.ts`'s `DEFAULT_MESSAGES`, not exported from the package
 * root, read for tone reference only) — shorter, written for a checkout surface a
 * partner's end user reads, not for a library consumer debugging a thrown error.
 */
const MESSAGE_BY_CODE = {
  NO_ROUTE: "There's no available swap route for this request.",
  TOKENIDS_UNAVAILABLE: "Those items aren't available right now — try a different selection.",
  QUOTE_RECONCILIATION_FAILED: 'The quote could not be confirmed on-chain — try again.',
  REDEMPTION_LOCKED: 'This collection currently blocks redeeming NFTs from the pool.',
  WRAPPER_UNVERIFIED: "This collection's wrapper could not be verified, so trading is unavailable.",
  UPSTREAM_DEGRADED: 'Prices are temporarily unavailable — try again in a moment.',
  WRONG_CHAIN: 'Your wallet is on the wrong network for this action.',
  INSUFFICIENT_OUTPUT_AMOUNT: 'The price moved past what you approved — try again.',
  PRODUCT_NOT_LIVE: 'This feature is not available on this network yet.',
  INVALID_PARAMS: 'Something about this request is invalid.',
  USER_REJECTED: 'You declined the request in your wallet.',
  UNKNOWN: 'Something went wrong — please try again.',
} as const satisfies Readonly<Record<SnfErrorCode, string>>

/**
 * The default English message for every SDK error code, derived from
 * `SNF_ERROR_CODES` — the exported map's membership traces back to the SDK's own
 * runtime source of truth rather than to `MESSAGE_BY_CODE`'s own key list directly.
 */
export const DEFAULT_WIDGET_MESSAGES: Readonly<Record<SnfErrorCode, string>> = Object.fromEntries(
  SNF_ERROR_CODES.map((code) => [code, MESSAGE_BY_CODE[code]] as const),
) as Readonly<Record<SnfErrorCode, string>>

/**
 * D-10's whole contract: a partner may override the text shown for any code
 * (per-code, freely translatable); the default is used otherwise. This function
 * returns ONLY the text — the `code` itself is always a separate, always-present
 * field the caller renders alongside whatever text is chosen (R10: "every error state
 * exposes the code to the consumer"), so an override can never mask which code
 * actually occurred.
 */
export function resolveErrorMessage(code: SnfErrorCode, overrides?: SnfWidgetMessages): string {
  return overrides?.[code] ?? DEFAULT_WIDGET_MESSAGES[code]
}
