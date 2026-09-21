import { getAddress } from 'viem'

import { assertParam, SnfError } from '../errors'
import type { BuildArgs } from '../types/plan.types'

/**
 * `validateBuildArgs` — the SPEC's hard caps on every `build*` call, enforced BEFORE
 * any on-chain work (R13; 54-SPEC.md).
 *
 * These are hard caps that THROW rather than clamp, on purpose. Every one of the
 * values checked here ends up inside calldata a user signs — a "reasonable default"
 * that silently widened a slippage tolerance or truncated a tokenIds array instead of
 * refusing would hide a partner bug until it cost someone money. `INVALID_PARAMS`
 * names the offending field in both the message and `details`, so the failure is
 * legible at the call site that produced it, not three layers downstream inside a
 * revert.
 */

/** The v1 ceiling on how many tokenIds a single build step may name — a cost/UX
 * decision (multicall batch size, calldata size), not a protocol limit. */
export const MAX_TOKEN_IDS = 50

/** How far into the future a `deadline` may be set — the Router's own liveness
 * bound. Anything beyond this throws rather than silently clamping down to it. */
export const MAX_DEADLINE_SECONDS = 3600

/** Default `slippageBps` when `BuildArgs.slippageBps` is omitted (1%). */
export const DEFAULT_SLIPPAGE_BPS = 100

/** Default deadline horizon, in seconds, when `BuildArgs.deadline` is omitted
 * (now + 20 minutes). */
export const DEFAULT_DEADLINE_SECONDS = 1200

const MIN_SLIPPAGE_BPS = 0
const MAX_SLIPPAGE_BPS = 10_000
const DECIMAL_ONLY = /^[0-9]+$/

/** The normalized, defaulted, fully-validated shape a `build*` function consumes
 * downstream — `deriveBounds`/`missingApprovals`/`assemblePlan` all read from this
 * rather than re-deriving defaults or re-parsing `BuildArgs` themselves. */
export interface ValidatedBuildArgs {
  readonly recipient: `0x${string}`
  /** `args.quote.tokenIds`, capped/validated — empty when the quote carries none
   * (e.g. a fungible `swap` or an `nft-to-nft` quote, whose ids live per-leg). */
  readonly tokenIds: readonly string[]
  readonly slippageBps: number
  /** Absolute unix-seconds deadline (defaulted + validated). */
  readonly deadline: bigint
}

function validateRecipient(recipient: string): `0x${string}` {
  try {
    // `getAddress` is the checksum round-trip: it throws on anything that isn't a
    // well-formed 40-hex-char address, and normalizes case on anything that is.
    return getAddress(recipient)
  } catch {
    throw new SnfError('INVALID_PARAMS', 'recipient must be a well-formed 0x address', {
      details: { field: 'recipient', value: recipient },
    })
  }
}

function validateTokenIds(tokenIds: readonly string[]): readonly string[] {
  assertParam(tokenIds.length <= MAX_TOKEN_IDS, `tokenIds must have at most ${MAX_TOKEN_IDS} entries`, {
    field: 'tokenIds',
    value: tokenIds.length,
  })
  assertParam(new Set(tokenIds).size === tokenIds.length, 'tokenIds must not contain duplicates', {
    field: 'tokenIds',
  })
  for (const id of tokenIds) {
    assertParam(DECIMAL_ONLY.test(id), `tokenIds must be decimal strings, received "${id}"`, {
      field: 'tokenIds',
      value: id,
    })
  }
  return tokenIds
}

function validateSlippageBps(slippageBps: number): number {
  assertParam(
    Number.isInteger(slippageBps) && slippageBps >= MIN_SLIPPAGE_BPS && slippageBps <= MAX_SLIPPAGE_BPS,
    `slippageBps must be an integer between ${MIN_SLIPPAGE_BPS} and ${MAX_SLIPPAGE_BPS}`,
    { field: 'slippageBps', value: slippageBps },
  )
  return slippageBps
}

function validateDeadline(deadlineSeconds: number, now: number): bigint {
  assertParam(Number.isInteger(deadlineSeconds), 'deadline must be an integer unix timestamp (seconds)', {
    field: 'deadline',
    value: deadlineSeconds,
  })
  assertParam(deadlineSeconds > now, 'deadline must be in the future', {
    field: 'deadline',
    value: deadlineSeconds,
    now,
  })
  assertParam(
    deadlineSeconds <= now + MAX_DEADLINE_SECONDS,
    `deadline must be at most ${MAX_DEADLINE_SECONDS}s from now`,
    { field: 'deadline', value: deadlineSeconds, now, maxDeadlineSeconds: MAX_DEADLINE_SECONDS },
  )
  return BigInt(deadlineSeconds)
}

/**
 * Validates `args` and returns the normalized, defaulted shape every `build*`
 * function's downstream steps consume. `now` (unix seconds) is threaded explicitly
 * rather than read from `Date.now()` internally, so the whole function stays pure and
 * trivially testable at any literal boundary (`now`, `now + 3600`, `now + 3601`, …).
 */
export function validateBuildArgs(args: BuildArgs, now: number): ValidatedBuildArgs {
  const recipient = validateRecipient(args.recipient)
  const tokenIds = validateTokenIds(args.quote.tokenIds ?? [])
  const slippageBps = validateSlippageBps(args.slippageBps ?? DEFAULT_SLIPPAGE_BPS)
  const deadline = validateDeadline(args.deadline ?? now + DEFAULT_DEADLINE_SECONDS, now)
  return { recipient, tokenIds, slippageBps, deadline }
}
