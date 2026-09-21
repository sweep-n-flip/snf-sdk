import { describe, expect, it } from 'vitest'

import { applySlippageDown, applySlippageUp, deriveBounds } from '../../src/build/bounds'
import { toNativeValue } from '../../src/chains/units'
import { isSnfError, SnfError } from '../../src/errors'

const ARC = 5042
const BASE = 8453

describe('applySlippageUp', () => {
  it('widens a round total by the given bps', () => {
    expect(applySlippageUp(1000n, 100)).toBe(1010n)
  })

  it('ceils rather than floors on a non-zero remainder', () => {
    // 3n * (10000 + 1) = 30003n. Floor(30003/10000) = 3n; ceil = 4n. A floor
    // implementation would return 3n here and fail this assertion.
    expect(applySlippageUp(3n, 1)).toBe(4n)
  })

  it('is exact (no drift) at slippageBps: 0', () => {
    expect(applySlippageUp(123_456_789n, 0)).toBe(123_456_789n)
  })

  it('accepts the 10000 (100%) boundary and rejects 10001/-1', () => {
    expect(() => applySlippageUp(1000n, 10_000)).not.toThrow()
    expect(() => applySlippageUp(1000n, 10_001)).toThrow(SnfError)
    expect(() => applySlippageUp(1000n, -1)).toThrow(SnfError)
  })
})

describe('applySlippageDown', () => {
  it('narrows a round total by the given bps', () => {
    expect(applySlippageDown(1000n, 100)).toBe(990n)
  })

  it('floors on a non-zero remainder', () => {
    // 3n * (10000 - 1) = 29997n. Floor(29997/10000) = 2n.
    expect(applySlippageDown(3n, 1)).toBe(2n)
  })

  it('is exact (no drift) at slippageBps: 0', () => {
    expect(applySlippageDown(123_456_789n, 0)).toBe(123_456_789n)
  })

  it('accepts the 10000 (100%) boundary (floors to zero) and rejects 10001/-1', () => {
    expect(applySlippageDown(1000n, 10_000)).toBe(0n)
    expect(() => applySlippageDown(1000n, 10_001)).toThrow(SnfError)
    expect(() => applySlippageDown(1000n, -1)).toThrow(SnfError)
  })
})

describe('deriveBounds', () => {
  const deadline = 1_800_000_000n

  it('buy + slippageBps: 0 yields amountInMax === total exactly, amountOutMin absent', () => {
    const bounds = deriveBounds({ side: 'buy', total: 555_000n, slippageBps: 0, deadline })
    expect(bounds.amountInMax).toBe(555_000n)
    expect(bounds.amountOutMin).toBeUndefined()
    expect(bounds.slippageBps).toBe(0)
    expect(bounds.deadline).toBe(deadline)
  })

  it('sell + slippageBps: 0 yields amountOutMin === total exactly, amountInMax absent', () => {
    const bounds = deriveBounds({ side: 'sell', total: 555_000n, slippageBps: 0, deadline })
    expect(bounds.amountOutMin).toBe(555_000n)
    expect(bounds.amountInMax).toBeUndefined()
  })

  it('accepts slippageBps: 10000, rejects 10001 and -1', () => {
    expect(() => deriveBounds({ side: 'buy', total: 1000n, slippageBps: 10_000, deadline })).not.toThrow()
    let threw: unknown
    try {
      deriveBounds({ side: 'buy', total: 1000n, slippageBps: 10_001, deadline })
    } catch (e) {
      threw = e
    }
    expect(isSnfError(threw)).toBe(true)
    expect((threw as SnfError).code).toBe('INVALID_PARAMS')
    expect(() => deriveBounds({ side: 'sell', total: 1000n, slippageBps: -1, deadline })).toThrow(SnfError)
  })

  it('applies the buy ceil / sell floor formulas through the full deriveBounds call', () => {
    const buy = deriveBounds({ side: 'buy', total: 3n, slippageBps: 1, deadline })
    expect(buy.amountInMax).toBe(4n)
    const sell = deriveBounds({ side: 'sell', total: 3n, slippageBps: 1, deadline })
    expect(sell.amountOutMin).toBe(2n)
  })

  it('the pool-axis bound is only converted to the EVM axis by chains/units.ts, never here', () => {
    // deriveBounds itself never touches decimals/scale — the ratio assertion lives at
    // the toNativeValue boundary. On Arc the pool axis (6 dec) and the EVM axis (18
    // dec, tx.value) differ by exactly 1e12; on an 18-decimal chain the ratio is 1.
    const bounds = deriveBounds({ side: 'buy', total: 1_000_000n, slippageBps: 100, deadline })
    const amountInMax = bounds.amountInMax as bigint
    expect(toNativeValue(ARC, amountInMax)).toBe(amountInMax * 1_000_000_000_000n)
    expect(toNativeValue(BASE, amountInMax)).toBe(amountInMax)
  })
})
