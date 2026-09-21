import { getChain } from './chains/registry'
import { getQuoteDecimals } from './chains/units'
import type { Amount } from './types/amount.types'

/**
 * D-03's two-field money (54-CONTEXT.md) — the only place in this package that turns a
 * `bigint` into a display string. `value` is exact and is what every internal
 * computation and every transaction uses; `formatted` is for UI display ONLY and must
 * NEVER be parsed back for math (`types/amount.types.ts`'s own doc comment repeats
 * this). Locale is always the explicit `'en-US'` — never read from the environment —
 * so server and browser render identically (no `Intl` locale auto-detection).
 *
 * `formatAmount` never ROUNDS UP past the real value: the fractional part is
 * truncated (floor), not rounded, at whatever precision tier the magnitude selects —
 * a display that rounds up could show a balance the caller doesn't actually have.
 */

const DISPLAY_FLOOR_DENOM = 1_000_000n // "<0.000001" cutoff, as a bigint ratio test

/** Magnitude-scaled fraction-digit tiers, mirroring `snf-client/src/lib/
 * formatters.ts`'s `formatETH` (2/4/5/6/8 by magnitude) — ported to bigint-exact
 * comparisons (`frac * threshold >= divisor`) instead of a float compare, since the
 * value this function receives may not survive an exact float round-trip. */
function fractionDigitsFor(frac: bigint, divisor: bigint): number {
  if (frac * 100n >= divisor) return 4 // value >= 0.01
  if (frac * 1_000n >= divisor) return 5 // value >= 0.001
  if (frac * 10_000n >= divisor) return 6 // value >= 0.0001
  return 8 // value >= 0.000001 (the "<0.000001" branch already returned above this)
}

/** Groups a non-negative decimal-digit string's integer part with thousands commas.
 * Uses `Number(...).toLocaleString('en-US', { useGrouping: true })` when the value
 * fits safely in a JS number (every realistic token amount's whole-unit part does);
 * falls back to manual comma insertion for a whole part large enough to lose float
 * precision, so grouping is never silently wrong on an exotic huge amount. */
function groupWhole(whole: bigint): string {
  if (whole <= 9_007_199_254_740_991n) {
    return Number(whole).toLocaleString('en-US', { useGrouping: true, maximumFractionDigits: 0 })
  }
  const digits = whole.toString()
  let grouped = ''
  for (let i = 0; i < digits.length; i++) {
    const fromEnd = digits.length - i
    if (i > 0 && fromEnd % 3 === 0) grouped += ','
    grouped += digits[i]
  }
  return grouped
}

function withSymbol(text: string, symbol: string | undefined): string {
  return symbol && symbol.length > 0 ? `${text} ${symbol}` : text
}

/**
 * `bigint` + `decimals` → a display string. Always groups thousands, always truncates
 * (never rounds) the fractional part, and returns `"<0.000001"` for a non-zero value
 * below the display floor rather than `"0"` — a caller must never read "0" as "this
 * balance is empty" when it is merely dust.
 */
export function formatAmount(
  value: bigint,
  decimals: number,
  opts: { readonly maxFractionDigits?: number; readonly symbol?: string } = {},
): string {
  if (value === 0n) return withSymbol('0', opts.symbol)

  const negative = value < 0n
  const abs = negative ? -value : value
  const divisor = 10n ** BigInt(decimals)
  const whole = abs / divisor
  const frac = abs % divisor

  if (whole === 0n && frac * DISPLAY_FLOOR_DENOM < divisor) {
    return withSymbol('<0.000001', opts.symbol)
  }

  const fractionDigits =
    opts.maxFractionDigits ?? (whole > 0n ? 4 : fractionDigitsFor(frac, divisor))

  const wholeText = groupWhole(whole)

  if (frac === 0n || fractionDigits <= 0) {
    return withSymbol(`${negative ? '-' : ''}${wholeText}`, opts.symbol)
  }

  // Pad the fraction to `decimals` digits, truncate to the chosen precision, then
  // trim trailing zeros — "0.004" not "0.00400" (RESEARCH's Arc fixtures require the
  // two unit-axis wrappers to render the SAME string for the same real amount).
  const fracPadded = frac.toString().padStart(decimals, '0')
  const fracTruncated = fracPadded.slice(0, Math.min(fractionDigits, fracPadded.length))
  const fracTrimmed = fracTruncated.replace(/0+$/, '')

  const text =
    fracTrimmed.length > 0
      ? `${negative ? '-' : ''}${wholeText}.${fracTrimmed}`
      : `${negative ? '-' : ''}${wholeText}`
  return withSymbol(text, opts.symbol)
}

/** Builds D-03's two-field `Amount` — `value` exact, `formatted` for display only. */
export function toAmount(value: bigint, decimals: number, symbol: string): Amount {
  return { value, formatted: formatAmount(value, decimals, { symbol }), symbol, decimals }
}

/**
 * The pool-side axis (`getQuoteDecimals(chainId)` — 18 on 13 chains, 6 on Arc) + the
 * chain's own symbol. On Arc this and `toNativeAmount` describe the SAME balance at
 * two scales (`chains/units.ts`'s header); picking the wrong one is a `1e12` error,
 * which is why `formatAmount` should not be called directly from `quote/` or
 * `build/` — always through one of these two named wrappers.
 */
export function toQuoteAmount(chainId: number, value: bigint): Amount {
  const chain = getChain(chainId)
  return toAmount(value, getQuoteDecimals(chainId), chain.nativeSymbol)
}

/** The EVM axis (`tx.value`, `eth_getBalance`) — always 18 decimals + the chain's
 * native symbol. See `toQuoteAmount`'s doc comment for the Arc two-axes warning. */
export function toNativeAmount(chainId: number, weiValue: bigint): Amount {
  const chain = getChain(chainId)
  return toAmount(weiValue, 18, chain.nativeSymbol)
}
