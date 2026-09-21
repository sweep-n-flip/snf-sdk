import { BaseError, ContractFunctionRevertedError, decodeErrorResult, UserRejectedRequestError } from 'viem'

import { ROUTER02_COLLECTION_ABI } from './abis/UniswapV2Router02Collection'
import { isSnfError, SnfError } from './errors'
import type { SnfErrorCode } from './errors.types'

/**
 * Maps any unknown throwable to a stable `SnfError` (R17; 54-SPEC.md). NEVER throws
 * itself — the whole body is inside ONE `try { … } catch { return SnfError('UNKNOWN') }`,
 * so "never throws" is structural, not merely tested (proven by the 20-input
 * `not.toThrow()` loop in `test/describeError.test.ts`, including a circular-reference
 * object a naive `JSON.stringify` would choke on — this function never calls
 * `JSON.stringify` on an arbitrary throwable).
 *
 * Preserves `snf-client/src/lib/revert.ts`'s first-match-wins classification order,
 * re-targeted to a stable `code` instead of free text:
 *   0. already an `SnfError` -> returned unchanged (idempotent).
 *   1. wallet rejection -> `USER_REJECTED`.
 *   2. wallet-side RPC auth failure ("Unauthorized"/"must authenticate"/"API key" —
 *      the user's own RPC needs a key; NOT a contract bug) -> `UPSTREAM_DEGRADED`.
 *   3. decoded revert data, via `decodeErrorResult` against `ROUTER02_COLLECTION_ABI`
 *      (this Router has no custom Solidity errors — every revert is a plain
 *      `require(string)`, which viem decodes through the built-in `Error(string)`
 *      selector regardless of which ABI is passed).
 *   4. known revert strings matched on the raw, `trim()`ed message (fires even with
 *      no decoded data at all).
 *   5. chain mismatch -> `WRONG_CHAIN`; insufficient funds -> `INVALID_PARAMS`.
 *   6. fallback -> `UNKNOWN`, original preserved as `cause`.
 */
export function describeError(e: unknown): SnfError {
  try {
    if (isSnfError(e)) return e

    const message = extractMessage(e)

    if (isUserRejection(e, message)) {
      return new SnfError('USER_REJECTED', 'The wallet rejected the signature request.', { cause: e })
    }

    if (containsAny(message, RPC_AUTH_PATTERNS)) {
      return new SnfError(
        'UPSTREAM_DEGRADED',
        "Your wallet's RPC endpoint requires authentication. Update the RPC URL for this network in your wallet settings and try again.",
        { details: { reason: 'rpc-auth' }, cause: e },
      )
    }

    const decodedReason = extractRevertReason(e)
    if (decodedReason !== undefined) {
      const match = matchRevertCode(decodedReason)
      if (match) return revertError(match, e)
    }

    const messageMatch = matchRevertCode(message)
    if (messageMatch) return revertError(messageMatch, e)

    if (containsAny(message, CHAIN_MISMATCH_PATTERNS)) {
      return new SnfError('WRONG_CHAIN', 'The connected wallet is on the wrong chain.', { cause: e })
    }

    if (message.includes('insufficient funds')) {
      return new SnfError('INVALID_PARAMS', 'Insufficient funds for this transaction.', {
        details: { reason: 'insufficient-funds' },
        cause: e,
      })
    }

    return new SnfError('UNKNOWN', message, { cause: e })
  } catch {
    return new SnfError('UNKNOWN', 'An unknown error occurred while describing another error.')
  }
}

// SPEC R3 (local/no-module-global-state): every module-scope collection here is a
// frozen `as const` literal, never a bare mutable array — none of this is per-client
// state, it is a fixed classification table shared safely across every instance.
const USER_REJECTED_PATTERNS = [
  'User rejected',
  'user rejected',
  'rejected the request',
  'ACTION_REJECTED',
  'User denied',
] as const
const RPC_AUTH_PATTERNS = ['Unauthorized', 'must authenticate', 'API key'] as const
const CHAIN_MISMATCH_PATTERNS = ['chain mismatch', 'does not match the target chain'] as const

/** Known Uniswap V2 / Router revert strings, matched by substring on the
 * `trim()`ed candidate. `INSUFFICIENT_OUTPUT_AMOUNT` is the one entry with its own
 * `SnfErrorCode`; every other entry is a valid-but-unmet parameter -> `INVALID_PARAMS`
 * with `details.revert` naming which string matched (`revert.ts`'s `knownErrors`
 * table, reduced to this package's closed code union). */
const REVERT_CODE_TABLE = [
  ['INSUFFICIENT_OUTPUT_AMOUNT', 'INSUFFICIENT_OUTPUT_AMOUNT'],
  ['EXCESSIVE_INPUT_AMOUNT', 'INVALID_PARAMS'],
  ['EXPIRED', 'INVALID_PARAMS'],
  ['INSUFFICIENT_INPUT_AMOUNT', 'INVALID_PARAMS'],
  ['UniswapV2: K', 'INVALID_PARAMS'],
  ['TRANSFER_FAILED', 'INVALID_PARAMS'],
  ['INSUFFICIENT_LIQUIDITY', 'INVALID_PARAMS'],
  ['INVALID_PATH', 'INVALID_PARAMS'],
] as const satisfies readonly (readonly [string, SnfErrorCode])[]

function extractMessage(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  return ''
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
  return needles.some((needle) => haystack.includes(needle))
}

function isUserRejection(e: unknown, message: string): boolean {
  if (e instanceof UserRejectedRequestError) return true
  if (typeof e === 'object' && e !== null && 'code' in e && (e as { code?: unknown }).code === 4001) {
    return true
  }
  return containsAny(message, USER_REJECTED_PATTERNS)
}

/** Finds a nested `ContractFunctionRevertedError` (viem's own `BaseError.walk`), or
 * decodes a raw `{ data: '0x…' }`-shaped provider error directly against
 * `ROUTER02_COLLECTION_ABI` when no viem wrapping is present. */
function extractRevertReason(e: unknown): string | undefined {
  const reverted =
    e instanceof ContractFunctionRevertedError
      ? e
      : e instanceof BaseError
        ? findReverted(e.walk((err) => err instanceof ContractFunctionRevertedError))
        : undefined
  if (reverted) return reverted.reason ?? decodeArgsFromData(reverted.raw)

  const rawData = extractHexData(e)
  return rawData ? decodeArgsFromData(rawData) : undefined
}

function findReverted(e: Error | null): ContractFunctionRevertedError | undefined {
  return e instanceof ContractFunctionRevertedError ? e : undefined
}

function decodeArgsFromData(data: `0x${string}` | undefined): string | undefined {
  if (!data) return undefined
  try {
    const decoded = decodeErrorResult({ abi: ROUTER02_COLLECTION_ABI, data })
    const [first] = decoded.args ?? []
    return typeof first === 'string' ? first : undefined
  } catch {
    return undefined
  }
}

function extractHexData(e: unknown): `0x${string}` | undefined {
  if (typeof e !== 'object' || e === null || !('data' in e)) return undefined
  const data = (e as { data?: unknown }).data
  return typeof data === 'string' && data.startsWith('0x') ? (data as `0x${string}`) : undefined
}

function matchRevertCode(text: string): { readonly key: string; readonly code: SnfErrorCode } | undefined {
  const trimmed = text.trim()
  if (trimmed.length === 0) return undefined
  for (const [key, code] of REVERT_CODE_TABLE) {
    if (trimmed.includes(key)) return { key, code }
  }
  return undefined
}

function revertError(match: { readonly key: string; readonly code: SnfErrorCode }, cause: unknown): SnfError {
  if (match.code === 'INSUFFICIENT_OUTPUT_AMOUNT') {
    return new SnfError('INSUFFICIENT_OUTPUT_AMOUNT', 'The swap would execute below its minimum output bound.', {
      details: { revert: match.key },
      cause,
    })
  }
  return new SnfError('INVALID_PARAMS', `Router reverted: ${match.key}.`, {
    details: { revert: match.key },
    cause,
  })
}
