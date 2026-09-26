import type { PublicClient } from 'viem'
import { describe, expect, it } from 'vitest'

import type { Amount } from '../../src/types/amount.types'
import type { CheckoutState } from '../../src/types/checkout.types'
import type { SnfClientConfig } from '../../src/types/client.types'
import type { LiquidityQuoteDetails } from '../../src/types/liquidity.types'
import type { FeeBreakdown, Quote, QuoteLeg } from '../../src/types/quote.types'
import type { StepKind } from '../../src/types/plan.types'

// A fake but well-typed `PublicClient` stand-in so the `@ts-expect-error` fixtures
// below isolate the error to the excess/forbidden field they're testing, not to
// `publicClient` failing to satisfy viem's real (large) interface.
const fakePublicClient = undefined as unknown as PublicClient

/**
 * Compile-time assertions for the public type contract (Task 2). Most of the
 * proof here happens at `tsc --noEmit` time via `@ts-expect-error` — an unused
 * directive (i.e. the following line does NOT actually error) fails the compile by
 * itself, so these lines are load-bearing even though the runtime assertions below
 * are trivial. `pnpm --filter @sweepnflip/sdk exec tsc --noEmit` is the real gate;
 * `vitest run` here is a secondary, human-readable proof that the fixtures exist.
 */

// ── A REST-API-shaped literal assigns to `Quote` ─────────────────────────────────────

const feeAmount = (value: bigint, symbol: string, decimals: number): Amount => ({
  value,
  formatted: (Number(value) / 10 ** decimals).toString(),
  symbol,
  decimals,
})

const buyQuoteFixture: Quote = {
  side: 'buy',
  chainId: 8453,
  collection: '0xc79eaAe02898378fE072acF8D4412A64Bb630024',
  count: 3,
  legs: [
    {
      pair: '0x93d10000000000000000000000000000000c04a',
      count: 3,
      amount: feeAmount(1587412500000000000n, 'ETH', 18),
      path: [
        '0x4200000000000000000000000000000000000006',
        '0x51b80000000000000000000000000000000a9f2',
      ],
      feeBps: 200,
      kind: 'native',
      side: 'buy',
    } satisfies QuoteLeg,
  ],
  fees: {
    pool: { bps: 200, note: 'included in curve' },
    marketplace: { ...feeAmount(38400000000000000n, 'ETH', 18), bps: 250 },
    royalty: { ...feeAmount(38400000000000000n, 'ETH', 18), bps: 250, capApplied: true },
  } satisfies FeeBreakdown,
  totalCost: feeAmount(1587412500000000000n, 'ETH', 18),
  priceImpact: 3.42,
  deliverable: 3,
  bestEffort: false,
  expiresAt: '2026-07-12T09:10:45Z',
  reconciled: true,
}

describe('Quote type contract', () => {
  it('a REST-API-shaped literal assigns to Quote', () => {
    expect(buyQuoteFixture.reconciled).toBe(true)
    expect(buyQuoteFixture.legs).toHaveLength(1)
  })

  it('omitting `reconciled` fails to compile', () => {
    // @ts-expect-error — `reconciled: true` is required; a Quote that did not
    // reconcile is never constructed.
    const missingReconciled: Quote = {
      side: 'buy',
      chainId: 8453,
      legs: [],
      fees: buyQuoteFixture.fees,
      priceImpact: 0,
      deliverable: 0,
      bestEffort: false,
      expiresAt: '2026-07-12T09:10:45Z',
    }
    expect(missingReconciled).toBeDefined()
  })
})

// ── a `create-pool` Quote with a full `liquidity` sub-object type-checks ────────────

const createPoolLiquidityFixture: LiquidityQuoteDetails = {
  pair: null,
  wrapper: null,
  baseToken: { address: null, symbol: 'ETH', decimals: 18, isNative: true },
  wrapperIsToken0: null,
  reserves: { base: 0n, wnft: 0n },
  totalSupply: 0n,
  blockNumber: 1n,
  nftCount: 6,
  baseRequired: feeAmount(6_000000000000000000n, 'ETH', 18),
  pricePerNft: feeAmount(1_000000000000000000n, 'ETH', 18),
  lpOut: feeAmount(6_000000000000000000n, 'ETH', 18),
  feeToZero: true,
}

const createPoolQuoteFixture: Quote = {
  side: 'create-pool',
  chainId: 8453,
  legs: [],
  fees: {
    pool: { bps: 0, note: 'no fee on liquidity' },
    marketplace: { ...feeAmount(0n, 'ETH', 18), bps: 0 },
    royalty: { ...feeAmount(0n, 'ETH', 18), bps: 0, capApplied: false },
  } satisfies FeeBreakdown,
  priceImpact: 0,
  deliverable: 6,
  bestEffort: false,
  expiresAt: '2026-07-12T09:10:45Z',
  reconciled: true,
  liquidity: createPoolLiquidityFixture,
}

describe('a create-pool Quote with a full liquidity sub-object', () => {
  it('assigns cleanly', () => {
    expect(createPoolQuoteFixture.liquidity?.feeToZero).toBe(true)
    expect(createPoolQuoteFixture.side).toBe('create-pool')
  })

  it('omitting `liquidity.feeToZero` fails to compile', () => {
    const { feeToZero, ...liquidityWithoutFeeToZero } = createPoolLiquidityFixture
    void feeToZero
    // @ts-expect-error — `feeToZero: true` is required; a liquidity quote is only
    // exact when the Pair's protocol-fee mint is off.
    const missingFeeToZero: Quote = { ...createPoolQuoteFixture, liquidity: liquidityWithoutFeeToZero }
    expect(missingFeeToZero).toBeDefined()
  })
})

// ── `SnfClientConfig` cannot represent a signer, a key, or `mode` ───────────────────

describe('SnfClientConfig rejects signing/legacy surfaces at compile time', () => {
  it('rejects { mode: "legacy" }', () => {
    // @ts-expect-error — no `mode` field exists; Legacy is discontinued (root CLAUDE.md).
    const withMode: SnfClientConfig = { chainId: 8453, publicClient: fakePublicClient, mode: 'legacy' }
    expect(withMode).toBeDefined()
  })

  it('rejects { walletClient: ... }', () => {
    // @ts-expect-error — the core never accepts a WalletClient.
    const withWalletClient: SnfClientConfig = { chainId: 8453, publicClient: fakePublicClient, walletClient: {} }
    expect(withWalletClient).toBeDefined()
  })

  it('rejects { privateKey: ... }', () => {
    // @ts-expect-error — the core never accepts key material.
    const withPrivateKey: SnfClientConfig = { chainId: 8453, publicClient: fakePublicClient, privateKey: '0xdeadbeef' }
    expect(withPrivateKey).toBeDefined()
  })
})

// ── Closed unions have exactly the member count the SPEC names, mirror-checked ──────

const CHECKOUT_STATES = [
  'review',
  'ready-approve',
  'wallet-approve',
  'pending-approve',
  'ready-swap',
  'wallet',
  'pending',
  'ready-buy',
  'ready-buy-wnft',
  'success',
  'error',
] as const satisfies readonly CheckoutState[]

const STEP_KINDS = [
  'approval',
  'swap-buy',
  'swap-sell',
  'swap-buy-wnft',
  'swap-fungible',
  'add-liquidity',
  'remove-liquidity',
] as const satisfies readonly StepKind[]

describe('closed union cardinality (satisfies-checked mirrors — cannot drift silently)', () => {
  it('CheckoutState has exactly 11 members', () => {
    expect(CHECKOUT_STATES).toHaveLength(11)
    expect(new Set(CHECKOUT_STATES).size).toBe(11)
  })

  it('StepKind has exactly 7 members', () => {
    expect(STEP_KINDS).toHaveLength(7)
    expect(new Set(STEP_KINDS).size).toBe(7)
  })
})

// ── `Amount` requires `value`, not just `formatted` ──────────────────────────────────

describe('Amount type contract', () => {
  it('a literal with `formatted` but no `value` fails to assign', () => {
    // @ts-expect-error — `value: bigint` is required; `formatted` alone is display-only
    // and must never stand in for the exact on-chain amount.
    const missingValue: Amount = { formatted: '1.25', symbol: 'ETH', decimals: 18 }
    expect(missingValue).toBeDefined()
  })

  it('a complete literal assigns cleanly', () => {
    const amount: Amount = { value: 1250000000000000000n, formatted: '1.25', symbol: 'ETH', decimals: 18 }
    expect(amount.value).toBe(1250000000000000000n)
  })
})
