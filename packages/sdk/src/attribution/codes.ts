import { assertParam } from '../errors'

/**
 * Partner-code grammar for the SDK attribution channel.
 *
 * Every transaction this SDK builds for an SnF contract carries exactly one ERC-8021
 * code: `sdk` when the integrator set no partner code, or `sdk-<code>` when it did.
 * The `sdk-` channel prefix is added here, automatically — an integrator passes
 * `acme` and the SDK emits `sdk-acme`; passing `sdk-acme` is accepted too and is not
 * prefixed twice.
 */

/** Emitted code grammar: lowercase letters, digits and `-`, 2–32 chars, no comma. */
export const ATTRIBUTION_CODE_PATTERN = /^[a-z0-9][a-z0-9-]{1,31}$/

/** The code this SDK emits when no partner code is configured. */
export const SDK_ATTRIBUTION_CHANNEL = 'sdk'

const SDK_PREFIX = 'sdk-'
const MAX_CODE_LENGTH = 32
/** The longest partner code whose `sdk-<code>` still fits `MAX_CODE_LENGTH`. */
export const MAX_PARTNER_CODE_LENGTH = MAX_CODE_LENGTH - SDK_PREFIX.length

function isReserved(code: string): boolean {
  // `snf` / `snf-*` identify the protocol's own surfaces; a bare `sdk` is the channel
  // itself (omit the partner code to emit it).
  return code === 'snf' || code.startsWith('snf-') || code === SDK_ATTRIBUTION_CHANNEL
}

/**
 * Validates a partner code and returns it without any `sdk-` channel prefix
 * (`'acme'` and `'sdk-acme'` both return `'acme'`). Throws
 * `SnfError('INVALID_PARAMS')` unless the code:
 *
 * - matches `^[a-z0-9][a-z0-9-]{1,31}$` (lowercase only — `'Acme'` is rejected, not
 *   folded, so the emitted code is exactly what the integrator wrote);
 * - is at most 28 characters, so the emitted `sdk-<code>` fits the 32-character limit;
 * - is not reserved: `snf`, anything starting `snf-`, or a bare `sdk`.
 */
export function validatePartnerCode(code: string): string {
  assertParam(typeof code === 'string', 'attribution code must be a string', {
    field: 'attribution.code',
    value: code,
  })
  const bare = code.startsWith(SDK_PREFIX) ? code.slice(SDK_PREFIX.length) : code
  assertParam(
    ATTRIBUTION_CODE_PATTERN.test(bare),
    'attribution code must be 2-32 chars of lowercase letters, digits and "-", starting with a letter or digit',
    { field: 'attribution.code', value: code },
  )
  assertParam(
    bare.length <= MAX_PARTNER_CODE_LENGTH,
    `attribution code must be at most ${MAX_PARTNER_CODE_LENGTH} chars so "sdk-<code>" fits 32 chars`,
    { field: 'attribution.code', value: code },
  )
  assertParam(!isReserved(bare), 'attribution code is reserved ("snf", "snf-*" and a bare "sdk")', {
    field: 'attribution.code',
    value: code,
  })
  return bare
}

/**
 * The ERC-8021 code this SDK emits for a given (optional) partner code: `'sdk'` when
 * `code` is `undefined`, otherwise `'sdk-<code>'` after `validatePartnerCode`.
 */
export function toSdkCode(code?: string): string {
  if (code === undefined) return SDK_ATTRIBUTION_CHANNEL
  return `${SDK_PREFIX}${validatePartnerCode(code)}`
}
