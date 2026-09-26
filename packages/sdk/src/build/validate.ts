import { getAddress } from 'viem'

import { assertParam, SnfError } from '../errors'
import type { BuildArgs } from '../types/plan.types'
import type { SnfClientConfig } from '../types/client.types'

/**
 * `validateBuildArgs` — the SPEC's hard caps on every `build*` call, enforced BEFORE
 * any on-chain work.
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

/** Creating a pool or seeding one needs at least six NFTs, matching the reference
 * production app's own rule — the contract itself would accept fewer; this is a
 * deliberate product-level floor, not a protocol minimum. Adding to an ALREADY
 * existing pool has no minimum beyond one. */
export const MIN_NEW_POOL_NFTS = 6

/** The ceiling on how many tokenIds a single `buildSeed` call may name — bounds both
 * one seed step's calldata size and the one-block pre-flight's `ownerOf` batch. A
 * launch larger than this calls `buildSeed` again for the next chunk; the SDK never
 * silently splits a single call's ids across multiple transactions. */
export const MAX_SEED_TOKEN_IDS = 500

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

/** Options for `assertTokenIdList` — `field` names the caller's own array (e.g.
 * `'tokenIds'`, `'quote.tokenIds'`) in both the thrown message and `details`, so a
 * caller composing several id lists in one build never has to guess which one
 * failed. */
export interface AssertTokenIdListOptions {
  readonly field: string
  /** Inclusive lower bound — omitted means no minimum (an existing-pool add has
   * none beyond the caller's own intent). */
  readonly min?: number
  /** Inclusive upper bound — omitted means no cap (never the SDK's default; a
   * caller who wants `MAX_TOKEN_IDS`/`MAX_SEED_TOKEN_IDS` passes it explicitly). */
  readonly max?: number
}

/**
 * Validates a tokenIds array: `max`/`min` bounds (whichever is supplied), no
 * duplicates, decimal-string-only entries. THROWS `INVALID_PARAMS` naming `field`,
 * never clamps or dedupes — the caller's own generic building block for every
 * `build*` and `buildSeed`-style tokenIds check in this package (the
 * six-NFT creation floor and the 500-id seed ceiling are both just callers of this
 * one function with different `min`/`max`).
 */
export function assertTokenIdList(tokenIds: readonly string[], opts: AssertTokenIdListOptions): readonly string[] {
  const { field, min, max } = opts
  if (max !== undefined) {
    assertParam(tokenIds.length <= max, `${field} must have at most ${max} entries`, {
      field,
      max,
      value: tokenIds.length,
    })
  }
  if (min !== undefined) {
    assertParam(tokenIds.length >= min, `${field} must have at least ${min} entries`, {
      field,
      min,
      value: tokenIds.length,
    })
  }
  assertParam(new Set(tokenIds).size === tokenIds.length, `${field} must not contain duplicates`, { field })
  for (const id of tokenIds) {
    assertParam(DECIMAL_ONLY.test(id), `${field} must be decimal strings, received "${id}"`, { field, value: id })
  }
  return tokenIds
}

/**
 * Sorts a tokenIds array ascending by BIGINT value (never lexicographic string
 * order, which would put `"100"` before `"9"`) — the seeding flow requires ids
 * sorted this way before encoding. Never mutates its input.
 */
export function sortTokenIdsAscending(tokenIds: readonly string[]): readonly string[] {
  return [...tokenIds].sort((a, b) => {
    const diff = BigInt(a) - BigInt(b)
    return diff < 0n ? -1 : diff > 0n ? 1 : 0
  })
}

/**
 * The checksum round-trip every well-formed-address check in this package uses:
 * throws `INVALID_PARAMS` naming `field` on anything that isn't a well-formed
 * 40-hex-char address, and returns the checksummed form on anything that is.
 */
export function assertAddress(value: string, field: string): `0x${string}` {
  try {
    return getAddress(value)
  } catch {
    throw new SnfError('INVALID_PARAMS', `${field} must be a well-formed 0x address`, {
      details: { field, value },
    })
  }
}

function validateTokenIds(tokenIds: readonly string[]): readonly string[] {
  return assertTokenIdList(tokenIds, { field: 'tokenIds', max: MAX_TOKEN_IDS })
}

function validateSlippageBps(slippageBps: number): number {
  assertParam(
    Number.isInteger(slippageBps) && slippageBps >= MIN_SLIPPAGE_BPS && slippageBps <= MAX_SLIPPAGE_BPS,
    `slippageBps must be an integer between ${MIN_SLIPPAGE_BPS} and ${MAX_SLIPPAGE_BPS}`,
    { field: 'slippageBps', value: slippageBps },
  )
  return slippageBps
}

/**
 * Defaults (per-call argument, then `config.defaults`, then the SDK constant) and
 * validates a `deadline`: an integer unix timestamp, strictly in the future, at most
 * `MAX_DEADLINE_SECONDS` from `now`. `now` (unix seconds) is threaded explicitly
 * rather than read from `Date.now()` internally, so this stays pure and trivially
 * testable at any literal boundary. Every `build*`/`buildSeed`-style deadline check
 * in this package is a caller of this one function.
 */
export function resolveDeadline(
  deadline: number | undefined,
  now: number,
  defaults?: { readonly deadlineSeconds?: number },
): bigint {
  const deadlineSeconds = deadline ?? now + (defaults?.deadlineSeconds ?? DEFAULT_DEADLINE_SECONDS)
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
export function validateBuildArgs(
  args: BuildArgs,
  now: number,
  defaults?: SnfClientConfig['defaults'],
): ValidatedBuildArgs {
  const recipient = assertAddress(args.recipient, 'recipient')
  const tokenIds = validateTokenIds(args.quote.tokenIds ?? [])
  // Precedence: the per-call argument, then the client's `config.defaults`, then the
  // SDK constant. `defaults.deadlineSeconds` is a duration from now; `args.deadline`
  // is an absolute unix timestamp.
  const slippageBps = validateSlippageBps(args.slippageBps ?? defaults?.slippageBps ?? DEFAULT_SLIPPAGE_BPS)
  const deadline = resolveDeadline(args.deadline, now, defaults)
  return { recipient, tokenIds, slippageBps, deadline }
}
