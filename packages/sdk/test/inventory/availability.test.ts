import { describe, expect, it } from 'vitest'

import { isSnfError } from '../../src/errors'
import { availableCountFromReserve, normalizeTokenIds } from '../../src/inventory/availability'

/**
 * `availableCountFromReserve` / `normalizeTokenIds` — the two pure rules behind
 * `poolInventory`'s buyable ceiling and tokenId normalization.
 */

describe('availableCountFromReserve — the buyable ceiling', () => {
  it.each([
    { reserve: 0n, expected: 0, label: '0' },
    { reserve: 1n * 10n ** 18n, expected: 0, label: '1e18' },
    { reserve: 15n * 10n ** 17n, expected: 0, label: '1.5e18' },
    { reserve: 2n * 10n ** 18n, expected: 1, label: '2e18' },
    { reserve: 12n * 10n ** 18n, expected: 11, label: '12e18' },
  ])('reserve $label → availableCount $expected', ({ reserve, expected }) => {
    expect(availableCountFromReserve(reserve)).toBe(expected)
  })

  it('floors BEFORE subtracting one — 2e18 minus 1 wei still floors to 1 whole unit, then 0 available', () => {
    expect(availableCountFromReserve(2n * 10n ** 18n - 1n)).toBe(0)
  })

  it('a huge reserve (1e30) does not overflow and does not lose precision', () => {
    // whole = 1e30 / 1e18 = 1e12; availableCount = 1e12 - 1 — well under
    // Number.MAX_SAFE_INTEGER (≈9.007e15), computed in bigint throughout.
    expect(availableCountFromReserve(10n ** 30n)).toBe(10 ** 12 - 1)
  })

  it('throws INVALID_PARAMS when the result would exceed Number.MAX_SAFE_INTEGER', () => {
    const tooLarge = (BigInt(Number.MAX_SAFE_INTEGER) + 2n) * 10n ** 18n
    try {
      availableCountFromReserve(tooLarge)
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(isSnfError(e)).toBe(true)
      expect(isSnfError(e) && e.code).toBe('INVALID_PARAMS')
    }
  })
})

describe('normalizeTokenIds — bigint ordering, never lexicographic', () => {
  it('dedupes and sorts ascending as bigint, preserving decimal-string form', () => {
    expect(normalizeTokenIds(['245830', '76197', '76197', '0'])).toEqual(['0', '76197', '245830'])
  })

  it('the result is NOT lexicographic order — "245830" would sort before "76197" as strings', () => {
    const result = normalizeTokenIds(['245830', '76197'])
    expect(result).toEqual(['76197', '245830'])
    expect(result).not.toEqual(['245830', '76197'])
  })

  it('an empty array returns an empty array', () => {
    expect(normalizeTokenIds([])).toEqual([])
  })

  it('rejects a hex id — INVALID_PARAMS, never a silently-wrong sort', () => {
    try {
      normalizeTokenIds(['0x1a'])
      expect.unreachable('should have thrown')
    } catch (e) {
      expect(isSnfError(e)).toBe(true)
      expect(isSnfError(e) && e.code).toBe('INVALID_PARAMS')
    }
  })

  it('rejects a signed id', () => {
    expect(() => normalizeTokenIds(['-5'])).toThrow()
  })

  it('rejects an empty-string id', () => {
    expect(() => normalizeTokenIds([''])).toThrow()
  })

  it('a uint256-max id sorts correctly and round-trips unchanged — the case a Number()-based sort silently corrupts', () => {
    const uint256Max = '115792089237316195423570985008687907853269984665640564039457584007913129639935'
    const result = normalizeTokenIds([uint256Max, '1', '0'])
    expect(result).toEqual(['0', '1', uint256Max])
  })
})
