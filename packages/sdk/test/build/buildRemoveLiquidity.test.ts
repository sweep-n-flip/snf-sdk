import { decodeFunctionData, getAddress } from 'viem'
import type { PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/liquidity/quoteRemoveLiquidity', () => ({ quoteRemoveLiquidity: vi.fn() }))

import { buildRemoveLiquidity } from '../../src/build/buildRemoveLiquidity'
import { applySlippageDown } from '../../src/build/bounds'
import { ROUTER02_COLLECTION_ABI } from '../../src/abis/UniswapV2Router02Collection'
import { ROUTER_NATIVE_ERC20_ABI } from '../../src/abis/UniswapV2Router01CollectionNativeERC20'
import { PAIR_ABI } from '../../src/abis/UniswapV2Pair'
import { getChain } from '../../src/chains/registry'
import { isSnfError, SnfError } from '../../src/errors'
import { ONE_WNFT } from '../../src/liquidity/liquidityMath'
import { quoteRemoveLiquidity } from '../../src/liquidity/quoteRemoveLiquidity'
import type { SnfChainId } from '../../src/chains/chains.types'
import type { SnfClientContext } from '../../src/types/client.types'
import type { Amount } from '../../src/types/amount.types'
import type { LiquidityQuoteDetails, RemoveLiquidityMode } from '../../src/types/liquidity.types'
import type { Quote } from '../../src/types/quote.types'

const mockedQuoteRemoveLiquidity = vi.mocked(quoteRemoveLiquidity)

const COLLECTION = getAddress('0x0000000000000000000000000000000000c011ec')
const WRAPPER = getAddress('0x00000000000000000000000000000000000fa99e')
const PAIR = getAddress('0x0000000000000000000000000000000000ba12a1')
const BASE_ERC20 = getAddress('0x000000000000000000000000000000000000ba5e')
const OWNER = getAddress('0x000000000000000000000000000000000000a11e')
const OTHER = getAddress('0x000000000000000000000000000000000000f00d')

function amount(value: bigint, decimals = 18, symbol = 'ETH'): Amount {
  return { value, formatted: value.toString(), symbol, decimals }
}

function zeroFees() {
  return {
    pool: { bps: 0, note: 'no fee' },
    marketplace: { ...amount(0n), bps: 0 },
    royalty: { ...amount(0n), bps: 0, capApplied: false },
  }
}

function fixtureLiquidity(opts: {
  readonly mode: RemoveLiquidityMode
  readonly isNative: boolean
  readonly baseDecimals: number
  readonly baseSymbol: string
  readonly lpIn: bigint
  readonly baseOut: bigint
  readonly wnftOut: bigint
  readonly nftWhole?: number
  readonly wnftRemainder?: bigint
}): LiquidityQuoteDetails {
  return {
    pair: PAIR,
    wrapper: WRAPPER,
    baseToken: { address: opts.isNative ? null : BASE_ERC20, symbol: opts.baseSymbol, decimals: opts.baseDecimals, isNative: opts.isNative },
    wrapperIsToken0: true,
    reserves: { base: 1n, wnft: 1n },
    totalSupply: 1_000_000n,
    blockNumber: 999_999n,
    nftCount: opts.nftWhole ?? 0,
    owner: OWNER,
    lpIn: amount(opts.lpIn, 18, 'LP'),
    baseOut: amount(opts.baseOut, opts.baseDecimals, opts.baseSymbol),
    wnftOut: amount(opts.wnftOut, 18, 'wNFT'),
    ...(opts.nftWhole !== undefined ? { nftWhole: opts.nftWhole } : {}),
    ...(opts.wnftRemainder !== undefined ? { wnftRemainder: amount(opts.wnftRemainder, 18, 'wNFT') } : {}),
    mode: opts.mode,
    shareBps: 100,
    feeToZero: true,
  }
}

function fixtureQuote(opts: {
  readonly chainId?: SnfChainId
  readonly mode: RemoveLiquidityMode
  readonly isNative: boolean
  readonly baseDecimals?: number
  readonly baseSymbol?: string
  readonly lpIn: bigint
  readonly baseOut: bigint
  readonly wnftOut: bigint
  readonly nftWhole?: number
  readonly wnftRemainder?: bigint
  readonly tokenIds?: readonly string[]
}): Quote {
  const chainId = opts.chainId ?? 8453
  const tokenIds = opts.mode === 'nft' ? (opts.tokenIds ?? ['1', '2']) : undefined
  return {
    side: 'remove-liquidity',
    chainId,
    collection: COLLECTION,
    ...(tokenIds !== undefined ? { tokenIds } : {}),
    legs: [],
    fees: zeroFees(),
    liquidity: fixtureLiquidity({
      mode: opts.mode,
      isNative: opts.isNative,
      baseDecimals: opts.baseDecimals ?? 18,
      baseSymbol: opts.baseSymbol ?? getChain(chainId).nativeSymbol,
      lpIn: opts.lpIn,
      baseOut: opts.baseOut,
      wnftOut: opts.wnftOut,
      ...(opts.nftWhole !== undefined ? { nftWhole: opts.nftWhole } : {}),
      ...(opts.wnftRemainder !== undefined ? { wnftRemainder: opts.wnftRemainder } : {}),
    }),
    totalProceeds: amount(opts.baseOut, opts.baseDecimals ?? 18, opts.baseSymbol ?? getChain(chainId).nativeSymbol),
    priceImpact: 0,
    deliverable: opts.nftWhole ?? 0,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    reconciled: true,
  }
}

/** The exact `(slotA, slotB)` tuple `buildRemoveLiquidity`'s reconciliation
 * simulation must see for a given quote to settle without throwing. Native
 * functions return (wnft-side, base-side); ERC-20 functions return (base-side,
 * wnft-side). The wnft-side reading is the REMAINDER in nft mode, the FULL amount
 * in wnft mode. */
function simulateResultFor(quote: Quote, isNative: boolean): readonly [bigint, bigint] {
  const liquidity = quote.liquidity
  const mode = liquidity?.mode
  const wnftSide = mode === 'nft' ? (liquidity?.wnftRemainder?.value ?? 0n) : (liquidity?.wnftOut?.value ?? 0n)
  const baseSide = liquidity?.baseOut?.value ?? 0n
  return isNative ? [wnftSide, baseSide] : [baseSide, wnftSide]
}

type ReadResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

function buildCtx(opts: {
  readonly chainId?: number
  readonly multicallImpl?: () => Promise<readonly ReadResult[]>
  readonly simulateContractImpl?: () => Promise<{ readonly result: unknown }>
  readonly estimateContractGasImpl?: () => Promise<bigint>
}): SnfClientContext {
  const chain = getChain(opts.chainId ?? 8453)
  const multicall = vi.fn(
    opts.multicallImpl ?? (async (): Promise<readonly ReadResult[]> => [{ status: 'success', result: 0n }]),
  )
  const simulateContract = vi.fn(opts.simulateContractImpl ?? (async () => ({ result: [0n, 0n] })))
  const estimateContractGas = vi.fn(opts.estimateContractGasImpl ?? (async () => 1_000_000n))
  const publicClient = { multicall, simulateContract, estimateContractGas } as unknown as PublicClient
  return {
    config: { chainId: chain.chainId, publicClient },
    chain,
    publicClient,
    providers: {},
    transport: {} as SnfClientContext['transport'],
    nextTxInvalidationVersion: () => 1,
  } as unknown as SnfClientContext
}

function buildArgs(quote: Quote, overrides: Record<string, unknown> = {}) {
  return { quote, recipient: OWNER, ...overrides }
}

async function expectRejectsWithCode(p: Promise<unknown>, code: string): Promise<{ readonly error: SnfError }> {
  let threw: unknown
  try {
    await p
  } catch (e) {
    threw = e
  }
  expect(isSnfError(threw)).toBe(true)
  expect((threw as SnfError).code).toBe(code)
  return { error: threw as SnfError }
}

beforeEach(() => {
  mockedQuoteRemoveLiquidity.mockReset()
})

describe('buildRemoveLiquidity — encoding by mode x base', () => {
  it('native nft mode encodes removeLiquidityETHCollection(collection, liquidity, ids, amountETHMin, to, deadline)', async () => {
    const reQuote = fixtureQuote({ mode: 'nft', isNative: true, lpIn: 3n * ONE_WNFT, baseOut: 500n, wnftOut: 3n * ONE_WNFT, nftWhole: 3, wnftRemainder: 0n, tokenIds: ['1', '2', '3'] })
    mockedQuoteRemoveLiquidity.mockResolvedValue(reQuote)
    const ctx = buildCtx({ simulateContractImpl: async () => ({ result: simulateResultFor(reQuote, true) }) })
    const plan = await buildRemoveLiquidity(ctx, buildArgs(reQuote))
    const step = plan.steps[plan.steps.length - 1]!
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: step.tx.data })
    expect(decoded.functionName).toBe('removeLiquidityETHCollection')
    expect(decoded.args[0]).toBe(COLLECTION)
    expect(decoded.args[1]).toBe(3n * ONE_WNFT)
    expect(decoded.args[2]).toEqual([1n, 2n, 3n])
    expect(decoded.args[3]).toBe(applySlippageDown(500n, 100)) // amountETHMin
    expect(decoded.args[4]).toBe(OWNER)
    expect(step.tx.value).toBe(0n)
    expect(step.kind).toBe('remove-liquidity')
    expect(step.label).toBe('Confirm withdrawal')
  })

  it('ERC-20 nft mode encodes removeLiquidityCollection(base, collection, liquidity, ids, amountAMin, to, deadline)', async () => {
    const reQuote = fixtureQuote({ mode: 'nft', isNative: false, baseSymbol: 'USDC', lpIn: 2n * ONE_WNFT, baseOut: 700n, wnftOut: 2n * ONE_WNFT, nftWhole: 2, wnftRemainder: 0n, tokenIds: ['5', '6'] })
    mockedQuoteRemoveLiquidity.mockResolvedValue(reQuote)
    const ctx = buildCtx({ simulateContractImpl: async () => ({ result: simulateResultFor(reQuote, false) }) })
    const plan = await buildRemoveLiquidity(ctx, buildArgs(reQuote))
    const step = plan.steps[plan.steps.length - 1]!
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: step.tx.data })
    expect(decoded.functionName).toBe('removeLiquidityCollection')
    expect(decoded.args[0]).toBe(BASE_ERC20)
    expect(decoded.args[1]).toBe(COLLECTION)
    expect(decoded.args[3]).toEqual([5n, 6n])
    expect(decoded.args[4]).toBe(applySlippageDown(700n, 100)) // amountAMin
    expect(step.tx.value).toBe(0n)
  })

  it('native wnft mode encodes removeLiquidityETH(wrapper, liquidity, amountWnftMin, amountETHMin, to, deadline)', async () => {
    const wnftOut = 1_234_000_000_000_000_000n
    const reQuote = fixtureQuote({ mode: 'wnft', isNative: true, lpIn: 999n, baseOut: 500n, wnftOut })
    mockedQuoteRemoveLiquidity.mockResolvedValue(reQuote)
    const ctx = buildCtx({ simulateContractImpl: async () => ({ result: simulateResultFor(reQuote, true) }) })
    const plan = await buildRemoveLiquidity(ctx, buildArgs(reQuote))
    const step = plan.steps[plan.steps.length - 1]!
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: step.tx.data })
    expect(decoded.functionName).toBe('removeLiquidityETH')
    expect(decoded.args[0]).toBe(WRAPPER)
    expect(decoded.args[1]).toBe(999n)
    expect(decoded.args[2]).toBe(applySlippageDown(wnftOut, 100)) // amountTokenMin (wnft)
    expect(decoded.args[3]).toBe(applySlippageDown(500n, 100)) // amountETHMin (base)
    expect(step.tx.value).toBe(0n)
  })

  it('ERC-20 wnft mode encodes removeLiquidity(base, wrapper, liquidity, amountBaseMin, amountWnftMin, to, deadline)', async () => {
    const wnftOut = 4_000_000_000_000_000_000n
    const reQuote = fixtureQuote({ mode: 'wnft', isNative: false, baseSymbol: 'USDC', lpIn: 555n, baseOut: 800n, wnftOut })
    mockedQuoteRemoveLiquidity.mockResolvedValue(reQuote)
    const ctx = buildCtx({ simulateContractImpl: async () => ({ result: simulateResultFor(reQuote, false) }) })
    const plan = await buildRemoveLiquidity(ctx, buildArgs(reQuote))
    const step = plan.steps[plan.steps.length - 1]!
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: step.tx.data })
    expect(decoded.functionName).toBe('removeLiquidity')
    expect(decoded.args[0]).toBe(BASE_ERC20)
    expect(decoded.args[1]).toBe(WRAPPER)
    expect(decoded.args[3]).toBe(applySlippageDown(800n, 100)) // amountAMin (base)
    expect(decoded.args[4]).toBe(applySlippageDown(wnftOut, 100)) // amountBMin (wnft)
    expect(step.tx.value).toBe(0n)
  })

  it('Arc uses ROUTER_NATIVE_ERC20_ABI with mins in 6-decimal quote units', async () => {
    const wnftOut = 3n * ONE_WNFT
    const reQuote = fixtureQuote({ chainId: 5042, mode: 'wnft', isNative: true, baseDecimals: 6, lpIn: 100n, baseOut: 5_000_000n, wnftOut })
    mockedQuoteRemoveLiquidity.mockResolvedValue(reQuote)
    const ctx = buildCtx({ chainId: 5042, simulateContractImpl: async () => ({ result: simulateResultFor(reQuote, true) }) })
    const plan = await buildRemoveLiquidity(ctx, buildArgs(reQuote))
    const step = plan.steps[plan.steps.length - 1]!
    const decoded = decodeFunctionData({ abi: ROUTER_NATIVE_ERC20_ABI, data: step.tx.data })
    expect(decoded.functionName).toBe('removeLiquidityETH')
    expect(decoded.args[3]).toBe(applySlippageDown(5_000_000n, 100))
    expect(step.tx.value).toBe(0n)
  })
})

describe('buildRemoveLiquidity — nft mode wnftOutMin is exact (ids x 1e18), not slippage-derived', () => {
  it('bounds.wnftOutMin equals ids.length * 1e18', async () => {
    const reQuote = fixtureQuote({ mode: 'nft', isNative: true, lpIn: 4n * ONE_WNFT, baseOut: 500n, wnftOut: 4n * ONE_WNFT, nftWhole: 4, wnftRemainder: 0n, tokenIds: ['1', '2', '3', '4'] })
    mockedQuoteRemoveLiquidity.mockResolvedValue(reQuote)
    const ctx = buildCtx({ simulateContractImpl: async () => ({ result: simulateResultFor(reQuote, true) }) })
    const plan = await buildRemoveLiquidity(ctx, buildArgs(reQuote))
    const step = plan.steps[plan.steps.length - 1]!
    expect(step.bounds.wnftOutMin).toBe(4n * ONE_WNFT)
  })
})

describe('buildRemoveLiquidity — LP approval, plain, no permit', () => {
  it('an insufficient LP allowance produces one lp-allowance approval step before the remove step', async () => {
    const reQuote = fixtureQuote({ mode: 'wnft', isNative: true, lpIn: 100n, baseOut: 500n, wnftOut: 1_000_000_000_000_000_000n })
    mockedQuoteRemoveLiquidity.mockResolvedValue(reQuote)
    const ctx = buildCtx({
      multicallImpl: async () => [{ status: 'success', result: 0n }],
      simulateContractImpl: async () => ({ result: simulateResultFor(reQuote, true) }),
    })
    const plan = await buildRemoveLiquidity(ctx, buildArgs(reQuote))
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0]?.kind).toBe('approval')
    expect(plan.steps[0]?.approvals[0]?.kind).toBe('lp-allowance')
    expect(plan.steps[0]?.approvals[0]?.token).toBe(PAIR)
    expect(plan.steps[0]?.approvals[0]?.spender).toBe(ctx.chain.router02)
    const decodedApproval = decodeFunctionData({ abi: PAIR_ABI, data: plan.steps[0]!.tx.data })
    expect(decodedApproval.functionName).toBe('approve')
    expect(decodedApproval.args[1]).toBe(100n)
    expect(plan.steps[1]?.kind).toBe('remove-liquidity')
  })

  it('a sufficient LP allowance produces no approval step', async () => {
    const reQuote = fixtureQuote({ mode: 'wnft', isNative: true, lpIn: 100n, baseOut: 500n, wnftOut: 1_000_000_000_000_000_000n })
    mockedQuoteRemoveLiquidity.mockResolvedValue(reQuote)
    const ctx = buildCtx({
      multicallImpl: async () => [{ status: 'success', result: 100n }],
      simulateContractImpl: async () => ({ result: simulateResultFor(reQuote, true) }),
    })
    const plan = await buildRemoveLiquidity(ctx, buildArgs(reQuote))
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.kind).toBe('remove-liquidity')
  })

  it('never encodes any …WithPermit… function', async () => {
    const reQuote = fixtureQuote({ mode: 'wnft', isNative: true, lpIn: 100n, baseOut: 500n, wnftOut: 1_000_000_000_000_000_000n })
    mockedQuoteRemoveLiquidity.mockResolvedValue(reQuote)
    const ctx = buildCtx({
      multicallImpl: async () => [{ status: 'success', result: 0n }],
      simulateContractImpl: async () => ({ result: simulateResultFor(reQuote, true) }),
    })
    const plan = await buildRemoveLiquidity(ctx, buildArgs(reQuote))
    for (const step of plan.steps) {
      const abi = step.kind === 'approval' ? PAIR_ABI : ROUTER02_COLLECTION_ABI
      const decoded = decodeFunctionData({ abi, data: step.tx.data })
      expect(decoded.functionName.toLowerCase()).not.toContain('permit')
    }
  })
})

describe('buildRemoveLiquidity — recipient must equal the LP owner', () => {
  it('a recipient other than quote.liquidity.owner throws INVALID_PARAMS naming recipient', async () => {
    const reQuote = fixtureQuote({ mode: 'wnft', isNative: true, lpIn: 100n, baseOut: 500n, wnftOut: 1_000_000_000_000_000_000n })
    const ctx = buildCtx({})
    const { error } = await expectRejectsWithCode(
      buildRemoveLiquidity(ctx, { quote: reQuote, recipient: OTHER }),
      'INVALID_PARAMS',
    )
    expect(error.details?.field).toBe('recipient')
    expect(mockedQuoteRemoveLiquidity).not.toHaveBeenCalled()
  })
})

describe('buildRemoveLiquidity — a moved whole-NFT count re-quotes as a price move', () => {
  it("a count-mismatch INVALID_PARAMS from the re-quote becomes INSUFFICIENT_OUTPUT_AMOUNT reason nft-count-changed", async () => {
    const originalQuote = fixtureQuote({ mode: 'nft', isNative: true, lpIn: 3n * ONE_WNFT, baseOut: 500n, wnftOut: 3n * ONE_WNFT, nftWhole: 3, wnftRemainder: 0n, tokenIds: ['1', '2', '3'] })
    const countMismatch = new SnfError('INVALID_PARAMS', 'tokenIds must exactly match', {
      details: { field: 'tokenIds', reason: 'count-mismatch', expected: 2, received: 3 },
    })
    mockedQuoteRemoveLiquidity.mockRejectedValue(countMismatch)
    const ctx = buildCtx({})
    const { error } = await expectRejectsWithCode(buildRemoveLiquidity(ctx, buildArgs(originalQuote)), 'INSUFFICIENT_OUTPUT_AMOUNT')
    expect(error.details?.reason).toBe('nft-count-changed')
    expect(error.cause).toBe(countMismatch)
  })

  it('an unrelated INVALID_PARAMS from the re-quote propagates unchanged', async () => {
    const originalQuote = fixtureQuote({ mode: 'wnft', isNative: true, lpIn: 100n, baseOut: 500n, wnftOut: 1_000_000_000_000_000_000n })
    const unrelated = new SnfError('INVALID_PARAMS', 'liquidity exceeds balance', {
      details: { field: 'liquidity', reason: 'insufficient-liquidity-burned' },
    })
    mockedQuoteRemoveLiquidity.mockRejectedValue(unrelated)
    const ctx = buildCtx({})
    const { error } = await expectRejectsWithCode(buildRemoveLiquidity(ctx, buildArgs(originalQuote)), 'INVALID_PARAMS')
    expect(error).toBe(unrelated)
  })
})

describe('buildRemoveLiquidity — reconciliation', () => {
  it('a simulated output that disagrees with the re-quote mirror throws QUOTE_RECONCILIATION_FAILED', async () => {
    const reQuote = fixtureQuote({ mode: 'wnft', isNative: true, lpIn: 100n, baseOut: 500n, wnftOut: 1_000_000_000_000_000_000n })
    mockedQuoteRemoveLiquidity.mockResolvedValue(reQuote)
    const ctx = buildCtx({
      multicallImpl: async () => [{ status: 'success', result: 1_000_000_000_000_000_000n }],
      simulateContractImpl: async () => ({ result: [1_000_000_000_000_000_001n, 500n] }),
    })
    await expectRejectsWithCode(buildRemoveLiquidity(ctx, buildArgs(reQuote)), 'QUOTE_RECONCILIATION_FAILED')
  })

  it('a pending approval skips simulation and attaches a warning instead', async () => {
    const reQuote = fixtureQuote({ mode: 'wnft', isNative: true, lpIn: 100n, baseOut: 500n, wnftOut: 1_000_000_000_000_000_000n })
    mockedQuoteRemoveLiquidity.mockResolvedValue(reQuote)
    let simulateCalled = false
    const ctx = buildCtx({
      multicallImpl: async () => [{ status: 'success', result: 0n }],
      simulateContractImpl: async () => {
        simulateCalled = true
        return { result: [1_000_000_000_000_000_000n, 500n] }
      },
    })
    const plan = await buildRemoveLiquidity(ctx, buildArgs(reQuote))
    expect(simulateCalled).toBe(false)
    const removeStep = plan.steps[plan.steps.length - 1]!
    expect(removeStep.tx.gasSource).toBe('fallback-pending-approval')
    expect(removeStep.quote.warnings?.some((w) => w.toLowerCase().includes('pending'))).toBe(true)
  })
})

describe('buildRemoveLiquidity — pre-flight refs', () => {
  it('carries lpBurn { amount, nftCount } and buyTokenIds in nft mode', async () => {
    const reQuote = fixtureQuote({ mode: 'nft', isNative: true, lpIn: 2n * ONE_WNFT, baseOut: 500n, wnftOut: 2n * ONE_WNFT, nftWhole: 2, wnftRemainder: 0n, tokenIds: ['7', '8'] })
    mockedQuoteRemoveLiquidity.mockResolvedValue(reQuote)
    const ctx = buildCtx({ simulateContractImpl: async () => ({ result: simulateResultFor(reQuote, true) }) })
    const plan = await buildRemoveLiquidity(ctx, buildArgs(reQuote))
    const step = plan.steps[plan.steps.length - 1]!
    expect(step.preflightRefs?.lpBurn).toEqual({ amount: 2n * ONE_WNFT, nftCount: 2 })
    expect(step.preflightRefs?.buyTokenIds).toEqual(['7', '8'])
    expect(step.preflightRefs?.pair).toBe(PAIR)
    expect(step.preflightRefs?.wrapper).toBe(WRAPPER)
  })

  it('carries lpBurn { amount } with no nftCount in wnft mode, and no buyTokenIds', async () => {
    const reQuote = fixtureQuote({ mode: 'wnft', isNative: true, lpIn: 100n, baseOut: 500n, wnftOut: 1_000_000_000_000_000_000n })
    mockedQuoteRemoveLiquidity.mockResolvedValue(reQuote)
    const ctx = buildCtx({ simulateContractImpl: async () => ({ result: simulateResultFor(reQuote, true) }) })
    const plan = await buildRemoveLiquidity(ctx, buildArgs(reQuote))
    const step = plan.steps[plan.steps.length - 1]!
    expect(step.preflightRefs?.lpBurn).toEqual({ amount: 100n })
    expect(step.preflightRefs?.buyTokenIds).toBeUndefined()
  })
})

describe('buildRemoveLiquidity — quote.side guard', () => {
  it('a non-remove-liquidity Quote throws INVALID_PARAMS naming quote.side', async () => {
    const wrongSide = { ...fixtureQuote({ mode: 'wnft', isNative: true, lpIn: 100n, baseOut: 500n, wnftOut: 1_000_000_000_000_000_000n }), side: 'sell' as const }
    const ctx = buildCtx({})
    const { error } = await expectRejectsWithCode(buildRemoveLiquidity(ctx, buildArgs(wrongSide)), 'INVALID_PARAMS')
    expect(error.details?.field).toBe('quote.side')
    expect(mockedQuoteRemoveLiquidity).not.toHaveBeenCalled()
  })
})
