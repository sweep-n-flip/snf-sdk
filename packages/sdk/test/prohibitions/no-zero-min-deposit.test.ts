import { decodeFunctionData, getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import { ROUTER02_COLLECTION_ABI } from '../../src/abis/UniswapV2Router02Collection'
import { buildCreatePool } from '../../src/build/buildCreatePool'
import { buildSeed } from '../../src/build/buildSeed'
import { buildLiquidityEnv } from '../liquidity/liquidityTestHelpers'
import { resolveSubject } from './_subject'
import type { Quote } from '../../src/types/quote.types'

/**
 * This rule: an exact-mode deposit (create/seed) minimum is NEVER zero, or looser
 * than the intended amount — with empty reserves the Router never even reads the
 * minimums, so anything looser is the same-block pre-seed front-run window the
 * create/seed builders exist to close.
 *
 * check_target: packages/sdk/test/prohibitions/no-zero-min-deposit.test.ts
 * check_violation_fixture: test/fixtures/prohib/zero-min-violation.ts
 * check_clean_fixture: test/fixtures/prohib/zero-min-clean.ts
 */

interface DepositBoundsSubjectModule {
  readonly depositBounds: (args: {
    readonly mode: 'exact' | 'slippage'
    readonly isNative: boolean
    readonly required: bigint
    readonly ceilDesired?: bigint
    readonly slippageBps?: number
  }) => { readonly desired: bigint; readonly min: bigint }
}

describe('no-zero-min-deposit — SNF_SDK_PROHIB_SUBJECT causation control (fixtures/prohib/zero-min-{clean,violation}.ts)', () => {
  it('native exact mode: min === required, never 0n (RED on the violation fixture)', async () => {
    const subject = await resolveSubject<DepositBoundsSubjectModule>('src/build/liquidityDeposit.ts')
    const result = subject.depositBounds({ mode: 'exact', isNative: true, required: 1_000_000n })
    expect(result.min).toBe(1_000_000n)
    expect(result.min).not.toBe(0n)
  })

  it('ERC-20 exact mode: min === required, never 0n', async () => {
    const subject = await resolveSubject<DepositBoundsSubjectModule>('src/build/liquidityDeposit.ts')
    const result = subject.depositBounds({ mode: 'exact', isNative: false, required: 500n, ceilDesired: 500n })
    expect(result.min).toBe(500n)
    expect(result.min).not.toBe(0n)
  })

  it('slippage mode (an existing-pool add) is unaffected by this rule — its min is a protective floor, not an exact pin', async () => {
    const subject = await resolveSubject<DepositBoundsSubjectModule>('src/build/liquidityDeposit.ts')
    const result = subject.depositBounds({ mode: 'slippage', isNative: true, required: 1_000_000n, slippageBps: 100 })
    expect(result.min).toBeLessThan(1_000_000n)
    expect(result.min).toBeGreaterThan(0n)
  })
})

// ── Real plans, decoded step by step ────────────────────────────────────────────
// The rule above is proved at the unit level (`depositBounds` itself); these cases
// prove the SAME invariant end-to-end, through the real, unmocked `buildSeed` and
// `buildCreatePool` builders — every deposit step's decoded on-chain minimum equals
// its own desired amount, and neither is ever `0n`.

const COLLECTION = getAddress('0x000000000000000000000000000000000000c011')
const BASE_ERC20 = getAddress('0x000000000000000000000000000000000000ba5e')
const PAYER = getAddress('0x000000000000000000000000000000000000a11e')
const LP_RECIPIENT = getAddress('0x000000000000000000000000000000000000f00d')

function idsRange(count: number): readonly string[] {
  return Array.from({ length: count }, (_, i) => String(i + 1))
}

function ownerOfAll(ids: readonly string[]): Record<string, `0x${string}`> {
  const out: Record<string, `0x${string}`> = {}
  for (const id of ids) out[id] = PAYER
  return out
}

function decodedMin(data: `0x${string}`, isNative: boolean): bigint {
  const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data })
  return (isNative ? decoded.args[2] : decoded.args[4]) as bigint
}

describe('no-zero-min-deposit — real buildSeed plans, every chunk', () => {
  it('empty pool, 120 ids, native: every deposit step decodes min === desired, never 0n', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null, erc721ApprovedForAll: false, ownerOf: ownerOfAll(idsRange(120)) })
    const plan = await buildSeed(env.ctx, {
      collection: COLLECTION,
      tokenIds: idsRange(120),
      pricePerNft: 1_000_000_000_000_000_000n,
      payer: PAYER,
      lpRecipient: LP_RECIPIENT,
    })
    const depositSteps = plan.steps.filter((s) => s.kind === 'add-liquidity')
    expect(depositSteps.length).toBeGreaterThan(1)
    for (const step of depositSteps) {
      expect(decodedMin(step.tx.data, true)).toBe(step.bounds.amountInMin)
      expect(step.bounds.amountInMin).toBe(step.bounds.amountInMax)
      expect(step.bounds.amountInMin).not.toBe(0n)
    }
  })

  it('empty pool, 120 ids, ERC-20 base: every deposit step decodes a minimum equal to what the Router pulls, never 0n', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: null,
      erc721ApprovedForAll: false,
      baseToken: { address: BASE_ERC20, decimals: 18, symbol: 'USDC' },
      ownerOf: ownerOfAll(idsRange(120)),
    })
    const plan = await buildSeed(env.ctx, {
      collection: COLLECTION,
      tokenIds: idsRange(120),
      pricePerNft: 1_000_000_000_000_000_000n,
      baseToken: BASE_ERC20,
      payer: PAYER,
      lpRecipient: LP_RECIPIENT,
    })
    const depositSteps = plan.steps.filter((s) => s.kind === 'add-liquidity')
    expect(depositSteps.length).toBeGreaterThan(1)
    for (const [index, step] of depositSteps.entries()) {
      expect(decodedMin(step.tx.data, false)).toBe(step.bounds.amountInMin)
      expect(step.bounds.amountInMin).not.toBe(0n)
      // The minimum is exactly the amount the Router pulls for this chunk.
      expect(step.bounds.amountInMin).toBe(step.quote.liquidity?.baseRequired?.value)
      if (index === 0) {
        // The creating chunk: desired and minimum are the same amount.
        expect(step.bounds.amountInMin).toBe(step.bounds.amountInMax)
      } else {
        // A later chunk into the now-priced pool approves a hair more so the Router
        // takes its exact branch; it never pulls more than the minimum.
        expect(step.bounds.amountInMax).toBeGreaterThanOrEqual(step.bounds.amountInMin as bigint)
      }
    }
  })
})

describe('no-zero-min-deposit — a real buildCreatePool plan', () => {
  it('the deposit step decodes min === desired === baseAmount, never 0n', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null, erc721ApprovedForAll: false, ownerOf: ownerOfAll(idsRange(6)) })
    const baseAmount = 12_000_000_000_000_000_000n
    const tokenIds = idsRange(6)
    const quote: Quote = {
      side: 'create-pool',
      chainId: 8453,
      collection: COLLECTION,
      tokenIds,
      legs: [],
      fees: { pool: { bps: 0, note: 'no fee' }, marketplace: { value: 0n, formatted: '0', symbol: 'ETH', decimals: 18, bps: 0 }, royalty: { value: 0n, formatted: '0', symbol: 'ETH', decimals: 18, bps: 0, capApplied: false } },
      liquidity: {
        pair: null,
        wrapper: null,
        baseToken: { address: null, symbol: 'ETH', decimals: 18, isNative: true },
        wrapperIsToken0: null,
        reserves: { base: 0n, wnft: 0n },
        totalSupply: 0n,
        blockNumber: 999_999n,
        nftCount: tokenIds.length,
        baseRequired: { value: baseAmount, formatted: '12', symbol: 'ETH', decimals: 18 },
        lpOut: { value: 1n, formatted: '1', symbol: 'LP', decimals: 18 },
        feeToZero: true,
      },
      totalCost: { value: baseAmount, formatted: '12', symbol: 'ETH', decimals: 18 },
      priceImpact: 0,
      deliverable: tokenIds.length,
      bestEffort: false,
      expiresAt: new Date(Date.now() + 30_000).toISOString(),
      reconciled: true,
    }

    const plan = await buildCreatePool(env.ctx, { quote, recipient: PAYER, lpRecipient: LP_RECIPIENT })
    const depositStep = plan.steps[plan.steps.length - 1]!
    expect(decodedMin(depositStep.tx.data, true)).toBe(baseAmount)
    expect(depositStep.bounds.amountInMin).toBe(baseAmount)
    expect(depositStep.bounds.amountInMax).toBe(baseAmount)
    expect(depositStep.bounds.amountInMin).not.toBe(0n)
  })
})
