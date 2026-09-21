import { describe, expect, it } from 'vitest'

import { formatAmount, toAmount, toNativeAmount, toQuoteAmount } from '../src/format'

describe('formatAmount', () => {
  it('always groups thousands (useGrouping: true explicitly, since Node SSR does not apply the default)', () => {
    expect(formatAmount(3333n * 10n ** 18n, 18)).toContain('3,333')
  })

  it('returns "<0.000001" for a non-zero value below the display floor', () => {
    expect(formatAmount(1n, 18)).toBe('<0.000001')
  })

  it('returns "0" for a zero value', () => {
    expect(formatAmount(0n, 18)).toBe('0')
  })

  it('truncates rather than rounds, and trims trailing zeros', () => {
    // 4000n / 1e6 = 0.004 exactly — must render "0.004", not "0.00400".
    expect(formatAmount(4000n, 6)).toBe('0.004')
  })

  it('appends the symbol when provided', () => {
    expect(formatAmount(4000n, 6, { symbol: 'USDC' })).toBe('0.004 USDC')
    expect(formatAmount(0n, 18, { symbol: 'ETH' })).toBe('0 ETH')
  })

  it('respects an explicit maxFractionDigits override', () => {
    expect(formatAmount(123456n, 6, { maxFractionDigits: 2 })).toBe('0.12')
  })

  it('handles negative values', () => {
    expect(formatAmount(-123n * 10n ** 18n, 18)).toBe('-123')
  })

  it('groups a whole part larger than Number.MAX_SAFE_INTEGER without precision loss', () => {
    const huge = 12_345_678_901_234_567_890n * 10n ** 18n
    expect(formatAmount(huge, 18)).toBe('12,345,678,901,234,567,890')
  })
})

describe('toAmount', () => {
  it('round-trips value exactly — the exact field is never derived from the formatted string', () => {
    const table: readonly [bigint, number, string][] = [
      [0n, 18, 'ETH'],
      [1n, 18, 'ETH'],
      [130_747_584_376_002n, 18, 'ETH'],
      [4000n, 6, 'USDC'],
      [123_456_789_012_345_678_901_234n, 18, 'ETH'],
    ]
    for (const [v, d, s] of table) {
      const amount = toAmount(v, d, s)
      expect(amount.value).toBe(v)
      expect(amount.decimals).toBe(d)
      expect(amount.symbol).toBe(s)
    }
  })
})

describe('toQuoteAmount / toNativeAmount — the two Arc unit axes', () => {
  it('Arc (5042): the same real balance formats identically from both axes', () => {
    // Pool side: 4000n at 6 decimals = 0.004 USDC. EVM side: the same balance scaled
    // by NATIVE_SCALE = 1e12 -> 4_000_000_000_000_000n wei at 18 decimals = 0.004.
    const quote = toQuoteAmount(5042, 4000n)
    const native = toNativeAmount(5042, 4_000_000_000_000_000n)
    expect(quote.formatted).toBe('0.004 USDC')
    expect(native.formatted).toBe('0.004 USDC')
    expect(quote.value).toBe(4000n)
    expect(native.value).toBe(4_000_000_000_000_000n)
  })

  it('Base (8453): the DEMON gross renders with the ETH symbol, value unchanged', () => {
    const amount = toQuoteAmount(8453, 130_747_584_376_002n)
    expect(amount.value).toBe(130_747_584_376_002n)
    expect(amount.symbol).toBe('ETH')
    expect(amount.formatted).toContain('0.00013')
    expect(amount.formatted).toContain('ETH')
  })
})
