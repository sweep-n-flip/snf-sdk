import { describe, expect, it } from 'vitest'

import { countFromWnftUnits, scaleWnftAmount, wnftUnitsFromCount } from '../../src/routing/wnftPathScale'

/**
 * Parity port of the production AMM client's own scaling test suite, adapted
 * to this SDK's exact-`bigint` count<->units scaling (that
 * client's decimal-axis scaler `wnftPathDecimals` is a
 * different, display-`number`-oriented concern this SDK's `chains/units.ts`
 * (`getQuoteDecimals`) already owns; this module is the wrapper's own fixed
 * count<->1e18-unit axis).
 */

describe('wnftUnitsFromCount', () => {
  it('1 NFT = 1e18 wrapper units', () => {
    expect(wnftUnitsFromCount(1)).toBe(10n ** 18n)
  })

  it('scales linearly for whole counts', () => {
    expect(wnftUnitsFromCount(3)).toBe(3n * 10n ** 18n)
    expect(wnftUnitsFromCount(0)).toBe(0n)
  })

  it('is the same 1e18 on every chain — including Arc, whose quote side is 6 decimals', () => {
    // wnftUnitsFromCount has no chainId parameter at all: the wrapper's own scale
    // never varies by chain, unlike the pool's quote-side decimals.
    expect(wnftUnitsFromCount(2)).toBe(2n * 10n ** 18n)
  })

  it('clamps negative or non-finite input to 0 rather than throwing', () => {
    expect(wnftUnitsFromCount(-5)).toBe(0n)
    expect(wnftUnitsFromCount(Number.NaN)).toBe(0n)
    expect(wnftUnitsFromCount(Number.POSITIVE_INFINITY)).toBe(0n)
  })

  it('truncates a fractional count', () => {
    expect(wnftUnitsFromCount(2.9)).toBe(2n * 10n ** 18n)
  })
})

describe('countFromWnftUnits', () => {
  it('floors to the whole-NFT count', () => {
    expect(countFromWnftUnits(10n ** 18n)).toBe(1)
    expect(countFromWnftUnits(3n * 10n ** 18n)).toBe(3)
  })

  it('a fractional unit amount floors down, never rounds up', () => {
    expect(countFromWnftUnits(15n * 10n ** 17n)).toBe(1) // 1.5e18 -> 1
    expect(countFromWnftUnits(10n ** 18n - 1n)).toBe(0) // just under 1 whole unit -> 0
  })

  it('zero or negative units is 0, never throws', () => {
    expect(countFromWnftUnits(0n)).toBe(0)
    expect(countFromWnftUnits(-1n)).toBe(0)
  })
})

describe('scaleWnftAmount', () => {
  it('splits into whole count + remainder units that sum back to the input', () => {
    const units = 25n * 10n ** 17n // 2.5e18
    const result = scaleWnftAmount(units)
    expect(result.wholeCount).toBe(2)
    expect(result.remainderUnits).toBe(5n * 10n ** 17n)
    expect(wnftUnitsFromCount(result.wholeCount) + result.remainderUnits).toBe(units)
  })

  it('an exact whole-NFT amount has a zero remainder', () => {
    const result = scaleWnftAmount(4n * 10n ** 18n)
    expect(result).toEqual({ wholeCount: 4, remainderUnits: 0n })
  })

  it('zero units is zero whole, zero remainder', () => {
    expect(scaleWnftAmount(0n)).toEqual({ wholeCount: 0, remainderUnits: 0n })
  })
})
