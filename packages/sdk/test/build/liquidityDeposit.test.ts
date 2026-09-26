import fc from 'fast-check'
import { decodeFunctionData, getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import { applySlippageDown, applySlippageUp } from '../../src/build/bounds'
import { creationOverheadGas, PAIR_CREATION_GAS, WRAPPER_CREATION_GAS, resolveGasForStep } from '../../src/build/gas'
import {
  depositApprovals,
  depositBounds,
  buildDepositStep,
  encodeDepositCall,
} from '../../src/build/liquidityDeposit'
import { ROUTER02_COLLECTION_ABI } from '../../src/abis/UniswapV2Router02Collection'
import { ROUTER_NATIVE_ERC20_ABI } from '../../src/abis/UniswapV2Router01CollectionNativeERC20'
import { toNativeValue } from '../../src/chains/units'
import { isSnfError, SnfError } from '../../src/errors'
import { ONE_WNFT } from '../../src/liquidity/liquidityMath'
import { buildLiquidityEnv } from '../liquidity/liquidityTestHelpers'
import type { Amount } from '../../src/types/amount.types'
import type { Quote } from '../../src/types/quote.types'

// Checksummed — this file (unlike the pure-mock liquidity/quote test suites) also
// feeds these through REAL viem encode/decode, which validates the EIP-55 checksum.
const COLLECTION = getAddress('0x000000000000000000000000000000000000c011')
const WRAPPER = getAddress('0x000000000000000000000000000000000000BAD1')
const PAIR = getAddress('0x000000000000000000000000000000000000FA17')
const BASE_ERC20 = getAddress('0x000000000000000000000000000000000000BA5E')
const RECIPIENT = getAddress('0x000000000000000000000000000000000000a11e')

async function expectRejectsWithCode(p: Promise<unknown>, code: string): Promise<void> {
  let threw: unknown
  try {
    await p
  } catch (e) {
    threw = e
  }
  expect(isSnfError(threw)).toBe(true)
  expect((threw as SnfError).code).toBe(code)
}

function amount(value: bigint, decimals = 18, symbol = 'ETH'): Amount {
  return { value, formatted: value.toString(), symbol, decimals }
}

// ── depositBounds ──────────────────────────────────────────────────────────────

describe('depositBounds — exact mode (create/seed) never loosens the minimum', () => {
  it('native exact: desired === min === required', () => {
    const result = depositBounds({ mode: 'exact', isNative: true, required: 1_000n })
    expect(result).toEqual({ desired: 1_000n, min: 1_000n })
  })

  it('ERC-20 exact: desired === ceilDesired (the first-deposit caller passes ceilDesired = required), min === required', () => {
    const result = depositBounds({ mode: 'exact', isNative: false, required: 1_000n, ceilDesired: 1_000n })
    expect(result).toEqual({ desired: 1_000n, min: 1_000n })
  })

  it('property: mode exact never returns min === 0n for required > 0n (>= 1000 runs)', () => {
    let runs = 0
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 10n ** 30n }),
        fc.boolean(),
        (required, isNative) => {
          runs++
          const result = depositBounds({ mode: 'exact', isNative, required, ceilDesired: required })
          return result.min === required && result.min !== 0n
        },
      ),
      { numRuns: 1000 },
    )
    expect(runs).toBeGreaterThanOrEqual(1000)
  })
})

describe('depositBounds — slippage mode (an existing-pool add)', () => {
  it('native: desired = applySlippageUp(required), min = applySlippageDown(required)', () => {
    const required = 1_000_000n
    const result = depositBounds({ mode: 'slippage', isNative: true, required, slippageBps: 100 })
    expect(result.desired).toBe(applySlippageUp(required, 100))
    expect(result.min).toBe(applySlippageDown(required, 100))
  })

  it('ERC-20: desired = applySlippageUp(ceilDesired), min = applySlippageDown(required)', () => {
    const required = 1_000_000n
    const ceilDesired = 1_000_050n
    const result = depositBounds({ mode: 'slippage', isNative: false, required, ceilDesired, slippageBps: 100 })
    expect(result.desired).toBe(applySlippageUp(ceilDesired, 100))
    expect(result.min).toBe(applySlippageDown(required, 100))
  })

  it('slippageBps: 0 yields desired === min === required on both bases (no ceil/floor drift at zero tolerance)', () => {
    const required = 1_000_000n
    const nativeResult = depositBounds({ mode: 'slippage', isNative: true, required, slippageBps: 0 })
    expect(nativeResult).toEqual({ desired: required, min: required })
    const erc20Result = depositBounds({ mode: 'slippage', isNative: false, required, ceilDesired: required, slippageBps: 0 })
    expect(erc20Result).toEqual({ desired: required, min: required })
  })
})

// ── encodeDepositCall ────────────────────────────────────────────────────────────

describe('encodeDepositCall', () => {
  it('native: addLiquidityETHCollection, value is the wei equivalent of desired', () => {
    const encoded = encodeDepositCall({
      chainId: 8453,
      routerVariant: 'standard',
      isNative: true,
      collection: COLLECTION,
      tokenIds: [1n, 2n],
      desired: 1_000_000_000_000_000_000n,
      min: 900_000_000_000_000_000n,
      to: RECIPIENT,
      deadline: 9_999_999_999n,
    })
    expect(encoded.functionName).toBe('addLiquidityETHCollection')
    expect(encoded.value).toBe(toNativeValue(8453, 1_000_000_000_000_000_000n))
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: encoded.data })
    expect(decoded.functionName).toBe('addLiquidityETHCollection')
    expect(decoded.args).toEqual([COLLECTION, [1n, 2n], 900_000_000_000_000_000n, RECIPIENT, 9_999_999_999n])
  })

  it('ERC-20: addLiquidityCollection, value is always 0n', () => {
    const encoded = encodeDepositCall({
      chainId: 8453,
      routerVariant: 'standard',
      isNative: false,
      collection: COLLECTION,
      baseToken: BASE_ERC20,
      tokenIds: [1n],
      desired: 500n,
      min: 400n,
      to: RECIPIENT,
      deadline: 9_999_999_999n,
    })
    expect(encoded.functionName).toBe('addLiquidityCollection')
    expect(encoded.value).toBe(0n)
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: encoded.data })
    expect(decoded.args).toEqual([BASE_ERC20, COLLECTION, 500n, [1n], 400n, RECIPIENT, 9_999_999_999n])
  })

  it('Arc (native-erc20 routerVariant) encodes against ROUTER_NATIVE_ERC20_ABI', () => {
    const encoded = encodeDepositCall({
      chainId: 5042,
      routerVariant: 'native-erc20',
      isNative: true,
      collection: COLLECTION,
      tokenIds: [1n],
      desired: 5_000_000n,
      min: 4_900_000n,
      to: RECIPIENT,
      deadline: 9_999_999_999n,
    })
    const decoded = decodeFunctionData({ abi: ROUTER_NATIVE_ERC20_ABI, data: encoded.data })
    expect(decoded.functionName).toBe('addLiquidityETHCollection')
    expect(encoded.value).toBe(toNativeValue(5042, 5_000_000n))
  })

  it('an ERC-20 deposit with no baseToken is an internal error, not a silent native fallback', () => {
    expect(() =>
      encodeDepositCall({
        chainId: 8453,
        routerVariant: 'standard',
        isNative: false,
        collection: COLLECTION,
        tokenIds: [1n],
        desired: 1n,
        min: 1n,
        to: RECIPIENT,
        deadline: 9_999_999_999n,
      }),
    ).toThrow()
  })
})

// ── depositApprovals ─────────────────────────────────────────────────────────────

describe('depositApprovals', () => {
  it('native: only the collection operator approval is checked', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, erc721ApprovedForAll: false })
    const approvals = await depositApprovals(env.ctx, { owner: RECIPIENT, spender: env.ctx.chain.router02, collection: COLLECTION })
    expect(approvals).toHaveLength(1)
    expect(approvals[0]?.kind).toBe('erc721-approval-for-all')
  })

  it('ERC-20 base: an insufficient allowance also returns an erc20-allowance approval, at the desired amount', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      baseToken: { address: BASE_ERC20, decimals: 18, symbol: 'USDC' },
      erc721ApprovedForAll: true,
      erc20Allowance: 10n,
    })
    const approvals = await depositApprovals(env.ctx, {
      owner: RECIPIENT,
      spender: env.ctx.chain.router02,
      collection: COLLECTION,
      erc20Base: { token: BASE_ERC20, amount: 1_000n },
    })
    expect(approvals).toHaveLength(1)
    expect(approvals[0]?.kind).toBe('erc20-allowance')
  })

  it('a sufficient allowance and an existing operator approval return no approvals at all', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      baseToken: { address: BASE_ERC20, decimals: 18, symbol: 'USDC' },
      erc721ApprovedForAll: true,
      erc20Allowance: 1_000n,
    })
    const approvals = await depositApprovals(env.ctx, {
      owner: RECIPIENT,
      spender: env.ctx.chain.router02,
      collection: COLLECTION,
      erc20Base: { token: BASE_ERC20, amount: 1_000n },
    })
    expect(approvals).toEqual([])
  })
})

// ── build/gas.ts additions ───────────────────────────────────────────────────────

describe('creationOverheadGas', () => {
  it('both creations: PAIR_CREATION_GAS + WRAPPER_CREATION_GAS', () => {
    expect(creationOverheadGas({ createsPair: true, createsWrapper: true })).toBe(
      PAIR_CREATION_GAS + WRAPPER_CREATION_GAS,
    )
  })

  it('neither creation: 0n', () => {
    expect(creationOverheadGas({ createsPair: false, createsWrapper: false })).toBe(0n)
  })
})

describe('resolveGasForStep — extraFallbackGas and dependsOnPriorStep', () => {
  it('extraFallbackGas is added on the pending-approval fallback path', async () => {
    const publicClient = { estimateContractGas: async () => 1n } as never
    const result = await resolveGasForStep({
      publicClient,
      address: COLLECTION,
      abi: ROUTER02_COLLECTION_ABI,
      functionName: 'addLiquidityETHCollection',
      args: [],
      account: RECIPIENT,
      tokenCount: 2,
      hasPendingApproval: true,
      extraFallbackGas: 3_000_000n,
    })
    expect(result.gasSource).toBe('fallback-pending-approval')
    expect(result.gas).toBe(2n * 300_000n + 1_500_000n + 3_000_000n)
  })

  it('dependsOnPriorStep skips the live estimate and reports its own gasSource', async () => {
    const publicClient = { estimateContractGas: async () => 999_999_999n } as never
    const result = await resolveGasForStep({
      publicClient,
      address: COLLECTION,
      abi: ROUTER02_COLLECTION_ABI,
      functionName: 'addLiquidityETHCollection',
      args: [],
      account: RECIPIENT,
      tokenCount: 1,
      hasPendingApproval: false,
      dependsOnPriorStep: true,
      extraFallbackGas: 500_000n,
    })
    expect(result.gasSource).toBe('fallback-pending-step')
    expect(result.gas).toBe(1n * 300_000n + 1_500_000n + 500_000n)
  })

  it('without the new options, behaviour is unchanged (a live estimate is used, no gasSource)', async () => {
    const publicClient = { estimateContractGas: async () => 1_000_000n } as never
    const result = await resolveGasForStep({
      publicClient,
      address: COLLECTION,
      abi: ROUTER02_COLLECTION_ABI,
      functionName: 'addLiquidityETHCollection',
      args: [],
      account: RECIPIENT,
      tokenCount: 1,
      hasPendingApproval: false,
    })
    expect(result.gasSource).toBeUndefined()
    expect(result.gas).toBe((1_000_000n * 125n) / 100n)
  })
})

// ── buildDepositStep ─────────────────────────────────────────────────────────────

function fixtureQuote(opts: { readonly nftCount: number; readonly baseRequired: bigint; readonly lpOut: bigint; readonly blockNumber: bigint }): Quote {
  return {
    side: 'add-liquidity',
    chainId: 8453,
    collection: COLLECTION,
    tokenIds: ['1'],
    legs: [],
    fees: { pool: { bps: 0, note: 'no fee' }, marketplace: { ...amount(0n), bps: 0 }, royalty: { ...amount(0n), bps: 0, capApplied: false } },
    liquidity: {
      pair: PAIR,
      wrapper: WRAPPER,
      baseToken: { address: BASE_ERC20, symbol: 'ETH', decimals: 18, isNative: true },
      wrapperIsToken0: true,
      reserves: { base: 1n, wnft: 1n },
      totalSupply: 1n,
      blockNumber: opts.blockNumber,
      nftCount: opts.nftCount,
      baseRequired: amount(opts.baseRequired),
      lpOut: amount(opts.lpOut, 18, 'LP'),
      feeToZero: true,
    },
    priceImpact: 0,
    deliverable: opts.nftCount,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    reconciled: true,
  }
}

describe('buildDepositStep — reconciles the real simulated call against the quote mirror', () => {
  it('native: matching simulation produces a plan step with no warnings', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, erc721ApprovedForAll: true })
    const nftCount = 1
    const baseRequired = 500_000_000_000_000_000n
    const lpOut = 100n
    const expectedWnft = BigInt(nftCount) * ONE_WNFT
    env.simulateContract.mockResolvedValueOnce({ result: [expectedWnft, baseRequired, lpOut] })
    const step = await buildDepositStep(env.ctx, {
      quote: fixtureQuote({ nftCount, baseRequired, lpOut, blockNumber: 999_999n }),
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      isNative: true,
      tokenIds: ['1'],
      nftCount,
      desired: baseRequired,
      min: baseRequired,
      to: RECIPIENT,
      payer: RECIPIENT,
      deadline: 9_999_999_999n,
      slippageBps: 0,
      hasPendingApproval: false,
    })
    expect(step.kind).toBe('add-liquidity')
    expect(step.tx.to).toBe(env.ctx.chain.router02)
    expect(step.quote.warnings).toBeUndefined()
    expect(step.bounds).toEqual({ amountInMax: baseRequired, amountInMin: baseRequired, slippageBps: 0, deadline: 9_999_999_999n })
    expect(step.preflightRefs).toEqual({ payer: RECIPIENT, collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, sellTokenIds: ['1'] })
  })

  it('a lower simulated liquidity than the mirror throws QUOTE_RECONCILIATION_FAILED', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, erc721ApprovedForAll: true })
    const nftCount = 1
    const baseRequired = 500_000_000_000_000_000n
    const expectedWnft = BigInt(nftCount) * ONE_WNFT
    env.simulateContract.mockResolvedValueOnce({ result: [expectedWnft, baseRequired, 50n] }) // mirror expects 100n
    await expectRejectsWithCode(
      buildDepositStep(env.ctx, {
        quote: fixtureQuote({ nftCount, baseRequired, lpOut: 100n, blockNumber: 999_999n }),
        collection: COLLECTION,
        wrapper: WRAPPER,
        pair: PAIR,
        isNative: true,
        tokenIds: ['1'],
        nftCount,
        desired: baseRequired,
        min: baseRequired,
        to: RECIPIENT,
        payer: RECIPIENT,
        deadline: 9_999_999_999n,
        slippageBps: 0,
        hasPendingApproval: false,
      }),
      'QUOTE_RECONCILIATION_FAILED',
    )
  })

  it('a pending approval skips the simulation entirely and attaches a warning instead', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: WRAPPER, pair: PAIR })
    const nftCount = 1
    const baseRequired = 500_000_000_000_000_000n
    const step = await buildDepositStep(env.ctx, {
      quote: fixtureQuote({ nftCount, baseRequired, lpOut: 100n, blockNumber: 999_999n }),
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      isNative: true,
      tokenIds: ['1'],
      nftCount,
      desired: baseRequired,
      min: baseRequired,
      to: RECIPIENT,
      payer: RECIPIENT,
      deadline: 9_999_999_999n,
      slippageBps: 0,
      hasPendingApproval: true,
    })
    expect(env.simulateContract).not.toHaveBeenCalled()
    expect(step.quote.warnings?.length).toBe(1)
    expect(step.tx.gasSource).toBe('fallback-pending-approval')
  })

  it('a step whose own deposit creates the pair and wrapper gets the creation gas overhead added to the fallback', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null })
    const nftCount = 6
    const baseAmount = 6_000_000_000_000_000_000n
    const step = await buildDepositStep(env.ctx, {
      quote: fixtureQuote({ nftCount, baseRequired: baseAmount, lpOut: 100n, blockNumber: 999_999n }),
      collection: COLLECTION,
      wrapper: null,
      pair: null,
      isNative: true,
      tokenIds: ['1', '2', '3', '4', '5', '6'],
      nftCount,
      desired: baseAmount,
      min: baseAmount,
      to: RECIPIENT,
      payer: RECIPIENT,
      deadline: 9_999_999_999n,
      slippageBps: 0,
      hasPendingApproval: true, // a first-time create's ERC-721 approval is nearly always pending
    })
    expect(step.tx.gas).toBe(6n * 300_000n + 1_500_000n + PAIR_CREATION_GAS + WRAPPER_CREATION_GAS)
    expect(step.preflightRefs?.wrapper).toBeNull()
    expect(step.preflightRefs?.pair).toBeNull()
  })
})
