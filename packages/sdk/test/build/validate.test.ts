import { describe, expect, it } from 'vitest'

import {
  DEFAULT_DEADLINE_SECONDS,
  DEFAULT_SLIPPAGE_BPS,
  MAX_DEADLINE_SECONDS,
  MAX_TOKEN_IDS,
  validateBuildArgs,
} from '../../src/build/validate'
import { isSnfError, SnfError } from '../../src/errors'
import type { BuildArgs } from '../../src/types/plan.types'
import type { Amount } from '../../src/types/amount.types'
import type { FeeBreakdown, Quote } from '../../src/types/quote.types'

const NOW = 1_800_000_000
// All-lowercase on purpose — viem's getAddress accepts (and checksums) an
// all-lowercase address without throwing; only a MIXED-case address must match the
// EIP-55 checksum exactly.
const RECIPIENT = '0x000000000000000000000000000000000000dead' as `0x${string}`

function amount(value: bigint): Amount {
  return { value, formatted: value.toString(), symbol: 'ETH', decimals: 18 }
}

function fees(): FeeBreakdown {
  return {
    pool: { bps: 200, note: 'included in curve' },
    marketplace: { ...amount(0n), bps: 0 },
    royalty: { ...amount(0n), bps: 0, capApplied: false },
  }
}

function buildQuote(tokenIds?: readonly string[]): Quote {
  return {
    side: 'buy',
    chainId: 8453,
    legs: [],
    fees: fees(),
    priceImpact: 0,
    deliverable: tokenIds?.length ?? 0,
    bestEffort: false,
    expiresAt: new Date().toISOString(),
    reconciled: true,
    ...(tokenIds !== undefined ? { tokenIds } : {}),
  }
}

function buildArgs(overrides: Partial<BuildArgs> = {}): BuildArgs {
  return { quote: buildQuote(), recipient: RECIPIENT, ...overrides }
}

function expectInvalidParams(fn: () => unknown): void {
  let threw: unknown
  try {
    fn()
  } catch (e) {
    threw = e
  }
  expect(isSnfError(threw)).toBe(true)
  expect((threw as SnfError).code).toBe('INVALID_PARAMS')
}

describe('validateBuildArgs — recipient', () => {
  it('accepts a well-formed checksummed/lowercase address and round-trips it', () => {
    const result = validateBuildArgs(buildArgs({ recipient: RECIPIENT.toLowerCase() as `0x${string}` }), NOW)
    expect(result.recipient.toLowerCase()).toBe(RECIPIENT.toLowerCase())
  })

  it('rejects a malformed recipient address', () => {
    expectInvalidParams(() => validateBuildArgs(buildArgs({ recipient: '0xnotanaddress' as `0x${string}` }), NOW))
  })
})

describe('validateBuildArgs — tokenIds (boundary)', () => {
  it('accepts exactly 50 tokenIds', () => {
    const tokenIds = Array.from({ length: MAX_TOKEN_IDS }, (_, i) => String(i + 1))
    const result = validateBuildArgs(buildArgs({ quote: buildQuote(tokenIds) }), NOW)
    expect(result.tokenIds).toHaveLength(MAX_TOKEN_IDS)
  })

  it('rejects 51 tokenIds', () => {
    const tokenIds = Array.from({ length: MAX_TOKEN_IDS + 1 }, (_, i) => String(i + 1))
    expectInvalidParams(() => validateBuildArgs(buildArgs({ quote: buildQuote(tokenIds) }), NOW))
  })

  it('rejects a duplicate tokenId', () => {
    expectInvalidParams(() => validateBuildArgs(buildArgs({ quote: buildQuote(['1', '1']) }), NOW))
  })

  it('rejects a non-decimal tokenId', () => {
    expectInvalidParams(() => validateBuildArgs(buildArgs({ quote: buildQuote(['0x1']) }), NOW))
  })

  it('defaults to an empty tokenIds array when the quote carries none (swap/nft-to-nft)', () => {
    const result = validateBuildArgs(buildArgs({ quote: buildQuote(undefined) }), NOW)
    expect(result.tokenIds).toEqual([])
  })
})

describe('validateBuildArgs — slippageBps (boundary)', () => {
  it('defaults to DEFAULT_SLIPPAGE_BPS when omitted', () => {
    const result = validateBuildArgs(buildArgs(), NOW)
    expect(result.slippageBps).toBe(DEFAULT_SLIPPAGE_BPS)
  })

  it('accepts 0 and 10000, rejects 10001', () => {
    expect(validateBuildArgs(buildArgs({ slippageBps: 0 }), NOW).slippageBps).toBe(0)
    expect(validateBuildArgs(buildArgs({ slippageBps: 10_000 }), NOW).slippageBps).toBe(10_000)
    expectInvalidParams(() => validateBuildArgs(buildArgs({ slippageBps: 10_001 }), NOW))
  })
})

describe('validateBuildArgs — deadline (boundary)', () => {
  it('defaults to now + DEFAULT_DEADLINE_SECONDS when omitted', () => {
    const result = validateBuildArgs(buildArgs(), NOW)
    expect(result.deadline).toBe(BigInt(NOW + DEFAULT_DEADLINE_SECONDS))
  })

  it('accepts now + 3600 exactly', () => {
    const result = validateBuildArgs(buildArgs({ deadline: NOW + MAX_DEADLINE_SECONDS }), NOW)
    expect(result.deadline).toBe(BigInt(NOW + MAX_DEADLINE_SECONDS))
  })

  it('rejects now + 3601', () => {
    expectInvalidParams(() => validateBuildArgs(buildArgs({ deadline: NOW + MAX_DEADLINE_SECONDS + 1 }), NOW))
  })

  it('rejects a deadline in the past', () => {
    expectInvalidParams(() => validateBuildArgs(buildArgs({ deadline: NOW - 1 }), NOW))
  })

  it('rejects a deadline equal to now (not strictly in the future)', () => {
    expectInvalidParams(() => validateBuildArgs(buildArgs({ deadline: NOW }), NOW))
  })
})

describe('validateBuildArgs — config.defaults', () => {
  it('applies the client defaults when the call omits slippageBps and deadline', () => {
    const result = validateBuildArgs(buildArgs({}), NOW, { slippageBps: 250, deadlineSeconds: 600 })
    expect(result.slippageBps).toBe(250)
    expect(result.deadline).toBe(BigInt(NOW + 600))
  })

  it('lets a per-call argument win over the client defaults', () => {
    const result = validateBuildArgs(buildArgs({ slippageBps: 50, deadline: NOW + 90 }), NOW, {
      slippageBps: 250,
      deadlineSeconds: 600,
    })
    expect(result.slippageBps).toBe(50)
    expect(result.deadline).toBe(BigInt(NOW + 90))
  })

  it('falls back to the SDK constants when neither is set', () => {
    const result = validateBuildArgs(buildArgs({}), NOW, {})
    expect(result.slippageBps).toBe(DEFAULT_SLIPPAGE_BPS)
    expect(result.deadline).toBe(BigInt(NOW + DEFAULT_DEADLINE_SECONDS))
  })

  it('still enforces the hard caps on a default taken from config', () => {
    expectInvalidParams(() => validateBuildArgs(buildArgs({}), NOW, { deadlineSeconds: MAX_DEADLINE_SECONDS + 1 }))
  })
})
