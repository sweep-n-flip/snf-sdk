import { decodeFunctionData, BaseError, ContractFunctionRevertedError } from 'viem'
import type { PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/quote/quoteBuy', () => ({ quoteBuy: vi.fn() }))

import { buildBuy } from '../../src/build/buildBuy'
import { ROUTER02_COLLECTION_ABI } from '../../src/abis/UniswapV2Router02Collection'
import { ROUTER_NATIVE_ERC20_ABI } from '../../src/abis/UniswapV2Router01CollectionNativeERC20'
import { getChain } from '../../src/chains/registry'
import { quoteBuy } from '../../src/quote/quoteBuy'
import { isSnfError, SnfError } from '../../src/errors'
import type { SnfChainId } from '../../src/chains/chains.types'
import type { SnfClientContext } from '../../src/types/client.types'
import type { Amount } from '../../src/types/amount.types'
import type { BuildArgs } from '../../src/types/plan.types'
import type { FeeBreakdown, Quote, QuoteLeg } from '../../src/types/quote.types'

const mockedQuoteBuy = vi.mocked(quoteBuy)

const COLLECTION = '0x0000000000000000000000000000000000c011ec' as `0x${string}`
const WRAPPER = '0x00000000000000000000000000000000000fa99e' as `0x${string}`
const PAIR = '0x0000000000000000000000000000000000ba12a1' as `0x${string}`
const BASE_TOKEN = '0x0000000000000000000000000000000000dead01' as `0x${string}`
const RECIPIENT = '0x000000000000000000000000000000000000a11e' as `0x${string}`

function amount(value: bigint, decimals = 18, symbol = 'ETH'): Amount {
  return { value, formatted: value.toString(), symbol, decimals }
}

function fixtureFees(): FeeBreakdown {
  return {
    pool: { bps: 200, note: 'included in curve' },
    marketplace: { ...amount(0n), bps: 0 },
    royalty: { ...amount(0n), bps: 0, capApplied: false },
  }
}

function fixtureLeg(opts: { readonly isNative: boolean; readonly baseToken: `0x${string}`; readonly tokenIds: readonly string[] }): QuoteLeg {
  return {
    pair: PAIR,
    count: opts.tokenIds.length,
    amount: amount(1000n),
    path: [opts.isNative ? opts.baseToken : opts.baseToken, COLLECTION],
    feeBps: 200,
    kind: opts.isNative ? 'native' : 'erc20',
    side: 'buy',
    collection: COLLECTION,
    wrapper: WRAPPER,
    tokenIds: opts.tokenIds,
  }
}

function fixtureQuote(opts: {
  readonly chainId?: SnfChainId
  readonly isNative?: boolean
  readonly baseToken?: `0x${string}`
  readonly tokenIds?: readonly string[]
  readonly totalCost?: bigint
}): Quote {
  const chainId = opts.chainId ?? 8453
  const isNative = opts.isNative ?? true
  const baseToken = opts.baseToken ?? getChain(chainId).quoteToken
  const tokenIds = opts.tokenIds ?? ['1', '2']
  const totalCost = opts.totalCost ?? 1_000_000n
  return {
    side: 'buy',
    chainId,
    collection: COLLECTION,
    count: tokenIds.length,
    tokenIds,
    legs: [fixtureLeg({ isNative, baseToken, tokenIds })],
    fees: fixtureFees(),
    totalCost: amount(totalCost),
    priceImpact: 0,
    deliverable: tokenIds.length,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    reconciled: true,
  }
}

type ReadResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

function buildCtx(opts: {
  readonly chainId?: number
  readonly multicallImpl?: (params: { readonly contracts: readonly unknown[] }) => Promise<readonly ReadResult[]>
  readonly estimateContractGasImpl?: () => Promise<bigint>
}): SnfClientContext {
  const chain = getChain(opts.chainId ?? 8453)
  const multicall = vi.fn(opts.multicallImpl ?? (async () => []))
  const estimateContractGas = vi.fn(opts.estimateContractGasImpl ?? (async () => 1_000_000n))
  const publicClient = { multicall, estimateContractGas } as unknown as PublicClient
  return {
    config: { chainId: chain.chainId, publicClient },
    chain,
    publicClient,
    providers: {},
    transport: {} as SnfClientContext['transport'],
    nextTxInvalidationVersion: () => 1,
  } as unknown as SnfClientContext
}

function buildArgs(quote: Quote, overrides: Partial<BuildArgs> = {}): BuildArgs {
  return { quote, recipient: RECIPIENT, ...overrides }
}

beforeEach(() => {
  mockedQuoteBuy.mockReset()
})

describe('buildBuy — fresh re-quote, never the caller\'s numbers (R13, T-54-81)', () => {
  it('calls quoteBuy again internally with the args\' selection, not the caller\'s totals', async () => {
    const reQuote = fixtureQuote({ totalCost: 2_000_000n })
    mockedQuoteBuy.mockResolvedValue(reQuote)
    const ctx = buildCtx({})
    const callerQuote = fixtureQuote({ totalCost: 1n })
    const plan = await buildBuy(ctx, buildArgs(callerQuote))

    expect(mockedQuoteBuy).toHaveBeenCalledTimes(1)
    expect(mockedQuoteBuy).toHaveBeenCalledWith(ctx, {
      chainId: 8453,
      collection: COLLECTION,
      tokenIds: ['1', '2'],
      payToken: null,
    })
    // bounds come from the RE-QUOTE's totalCost (2_000_000n), never the caller's (1n).
    expect(plan.steps[plan.steps.length - 1]?.bounds.amountInMax).toBe(2_020_000n) // 1% default slippage, ceil
  })

  it('a doubled/zeroed tampered caller quote produces byte-identical bounds and tx to the untampered one', async () => {
    const reQuote = fixtureQuote({ totalCost: 500_000n })
    mockedQuoteBuy.mockResolvedValue(reQuote)
    const ctx = buildCtx({})

    const real = fixtureQuote({ totalCost: 500_000n })
    const tampered: Quote = {
      ...real,
      totalCost: amount(real.totalCost!.value * 2n),
      fees: { ...real.fees, royalty: { ...real.fees.royalty, value: 0n } },
    }

    const planA = await buildBuy(ctx, buildArgs(real))
    const planB = await buildBuy(ctx, buildArgs(tampered))

    const stepA = planA.steps[planA.steps.length - 1]
    const stepB = planB.steps[planB.steps.length - 1]
    expect(stepB?.bounds).toEqual(stepA?.bounds)
    expect(stepB?.tx.value).toBe(stepA?.tx.value)
    expect(stepB?.tx.data).toBe(stepA?.tx.data)
  })
})

describe('buildBuy — approvals (empty | R13)', () => {
  it('a native buy never checks or emits any approval — no multicall at all', async () => {
    mockedQuoteBuy.mockResolvedValue(fixtureQuote({ isNative: true }))
    const ctx = buildCtx({})
    const plan = await buildBuy(ctx, buildArgs(fixtureQuote({ isNative: true })))
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.kind).toBe('swap-buy')
    expect((ctx.publicClient.multicall as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('an ERC-20-base buy with insufficient allowance emits steps[0].kind==="approval" (erc20-allowance) then steps[1].kind==="swap-buy"', async () => {
    mockedQuoteBuy.mockResolvedValue(fixtureQuote({ isNative: false, baseToken: BASE_TOKEN, totalCost: 1_000_000n }))
    const ctx = buildCtx({ multicallImpl: async () => [{ status: 'success', result: 0n }] })
    const plan = await buildBuy(ctx, buildArgs(fixtureQuote({ isNative: false, baseToken: BASE_TOKEN, totalCost: 1_000_000n })))
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0]?.kind).toBe('approval')
    expect(plan.steps[0]?.approvals[0]?.kind).toBe('erc20-allowance')
    expect(plan.steps[1]?.kind).toBe('swap-buy')
  })

  it('an ERC-20-base buy with a sufficient allowance emits only the swap step', async () => {
    mockedQuoteBuy.mockResolvedValue(fixtureQuote({ isNative: false, baseToken: BASE_TOKEN, totalCost: 1_000_000n }))
    const ctx = buildCtx({ multicallImpl: async () => [{ status: 'success', result: 10_000_000n }] })
    const plan = await buildBuy(ctx, buildArgs(fixtureQuote({ isNative: false, baseToken: BASE_TOKEN, totalCost: 1_000_000n })))
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.kind).toBe('swap-buy')
  })

  // Finding 2, snf-54-18-SUMMARY.md (fixed in snf-54-18F): a missing ERC-20 allowance
  // used to make buildBuy THROW (the swap step's live gas estimate reverted before
  // assemblePlan ever ran), so the caller never received the approval step that would
  // have fixed it. `estimateContractGasImpl` below is wired to throw a GENUINE
  // simulated revert if it is ever called — proving the fix works not because the
  // live estimate happens to succeed, but because it is never attempted at all while
  // the approval is pending.
  it('a missing ERC-20 allowance returns the plan (approval, then swap) instead of throwing — the live estimate is never attempted', async () => {
    mockedQuoteBuy.mockResolvedValue(fixtureQuote({ isNative: false, baseToken: BASE_TOKEN, tokenIds: ['1', '2'], totalCost: 1_000_000n }))
    const revertError = new BaseError('execution reverted', {
      cause: new ContractFunctionRevertedError({ abi: [], functionName: 'swapTokensForExactTokensCollection' }),
    })
    const ctx = buildCtx({
      multicallImpl: async () => [{ status: 'success', result: 0n }],
      estimateContractGasImpl: async () => {
        throw revertError
      },
    })
    const plan = await buildBuy(
      ctx,
      buildArgs(fixtureQuote({ isNative: false, baseToken: BASE_TOKEN, tokenIds: ['1', '2'], totalCost: 1_000_000n })),
    )
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0]?.kind).toBe('approval')
    expect(plan.steps[1]?.kind).toBe('swap-buy')
    expect((ctx.publicClient.estimateContractGas as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    expect(plan.steps[1]?.tx.gas).toBe(2n * 300_000n + 1_500_000n) // fallbackGasForNFTBatch(2)
    expect(plan.steps[1]?.tx.gasSource).toBe('fallback-pending-approval')
  })

  it('a SUFFICIENT ERC-20 allowance still takes the live-estimate path (gasSource undefined)', async () => {
    mockedQuoteBuy.mockResolvedValue(fixtureQuote({ isNative: false, baseToken: BASE_TOKEN, totalCost: 1_000_000n }))
    const ctx = buildCtx({
      multicallImpl: async () => [{ status: 'success', result: 10_000_000n }],
      estimateContractGasImpl: async () => 900_000n,
    })
    const plan = await buildBuy(ctx, buildArgs(fixtureQuote({ isNative: false, baseToken: BASE_TOKEN, totalCost: 1_000_000n })))
    expect(plan.steps).toHaveLength(1)
    expect((ctx.publicClient.estimateContractGas as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
    expect(plan.steps[0]?.tx.gas).toBe((900_000n * 125n) / 100n)
    expect(plan.steps[0]?.tx.gasSource).toBeUndefined()
  })
})

describe('buildBuy — encoding (native vs ERC-20 entry point, capRoyaltyFee pinned false)', () => {
  it('encodes swapETHForExactTokensCollection for a native buy; decodes back to the same args with capRoyaltyFee===false', async () => {
    mockedQuoteBuy.mockResolvedValue(fixtureQuote({ isNative: true, tokenIds: ['1', '2'], totalCost: 1_000_000n }))
    const ctx = buildCtx({})
    const plan = await buildBuy(ctx, buildArgs(fixtureQuote({ isNative: true, tokenIds: ['1', '2'], totalCost: 1_000_000n })))
    const step = plan.steps[0]
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: step!.tx.data })
    expect(decoded.functionName).toBe('swapETHForExactTokensCollection')
    const [tokenIdsOut, , capRoyaltyFee, to] = decoded.args
    expect(tokenIdsOut).toEqual([1n, 2n])
    expect(capRoyaltyFee).toBe(false)
    expect((to as string).toLowerCase()).toBe(RECIPIENT.toLowerCase())
  })

  it('encodes swapTokensForExactTokensCollection for an ERC-20-base buy with amountInMax from the fresh bounds', async () => {
    mockedQuoteBuy.mockResolvedValue(fixtureQuote({ isNative: false, baseToken: BASE_TOKEN, tokenIds: ['5'], totalCost: 2_000_000n }))
    const ctx = buildCtx({ multicallImpl: async () => [{ status: 'success', result: 10n ** 30n }] })
    const plan = await buildBuy(
      ctx,
      buildArgs(fixtureQuote({ isNative: false, baseToken: BASE_TOKEN, tokenIds: ['5'], totalCost: 2_000_000n })),
    )
    const step = plan.steps[plan.steps.length - 1]
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: step!.tx.data })
    expect(decoded.functionName).toBe('swapTokensForExactTokensCollection')
    expect(decoded.args[3]).toBe(false) // capRoyaltyFee
    expect(step!.bounds.amountInMax).toBe(2_020_000n)
    expect(step!.tx.value).toBe(0n)
  })

  it('tx.value on a native chain equals toNativeValue(chainId, bounds.amountInMax) — Base ratio 1', async () => {
    mockedQuoteBuy.mockResolvedValue(fixtureQuote({ isNative: true, totalCost: 100_000n }))
    const ctx = buildCtx({})
    const plan = await buildBuy(ctx, buildArgs(fixtureQuote({ isNative: true, totalCost: 100_000n })))
    const step = plan.steps[0]
    expect(step!.tx.value).toBe(step!.bounds.amountInMax)
  })

  it('on Arc, tx.value === bounds.amountInMax * 1_000_000_000_000n while bounds stays 6-decimal', async () => {
    mockedQuoteBuy.mockResolvedValue(fixtureQuote({ chainId: 5042, isNative: true, totalCost: 100_000n }))
    const ctx = buildCtx({ chainId: 5042 })
    const plan = await buildBuy(ctx, buildArgs(fixtureQuote({ chainId: 5042, isNative: true, totalCost: 100_000n })))
    const step = plan.steps[0]
    expect(step!.tx.value).toBe(step!.bounds.amountInMax! * 1_000_000_000_000n)
    expect(step!.bounds.amountInMax!).toBeLessThan(10n ** 9n) // a 6-decimal-ish magnitude, not wei
    const decoded = decodeFunctionData({ abi: ROUTER_NATIVE_ERC20_ABI, data: step!.tx.data })
    expect(decoded.functionName).toBe('swapETHForExactTokensCollection')
  })

  it('slippageBps: 0 makes bounds.amountInMax === reQuote.totalCost.value exactly', async () => {
    mockedQuoteBuy.mockResolvedValue(fixtureQuote({ totalCost: 777_777n }))
    const ctx = buildCtx({})
    const plan = await buildBuy(ctx, buildArgs(fixtureQuote({ totalCost: 777_777n }), { slippageBps: 0 }))
    expect(plan.steps[0]?.bounds.amountInMax).toBe(777_777n)
  })

  it('every step tx.chainId equals the chain id; the swap step\'s tx.to is the router (an approval step\'s tx.to is the approved token, not the router)', async () => {
    mockedQuoteBuy.mockResolvedValue(fixtureQuote({ isNative: false, baseToken: BASE_TOKEN }))
    const ctx = buildCtx({ multicallImpl: async () => [{ status: 'success', result: 0n }] })
    const plan = await buildBuy(ctx, buildArgs(fixtureQuote({ isNative: false, baseToken: BASE_TOKEN })))
    for (const step of plan.steps) {
      expect(step.tx.chainId).toBe(ctx.chain.chainId)
    }
    const swapStep = plan.steps.find((s) => s.kind === 'swap-buy')
    expect(swapStep?.tx.to).toBe(ctx.chain.router02)
  })
})

describe('buildBuy — validation (R13 hard caps)', () => {
  it('deadline = now + 3601 throws INVALID_PARAMS', async () => {
    const ctx = buildCtx({})
    const now = Math.floor(Date.now() / 1000)
    let threw: unknown
    try {
      await buildBuy(ctx, buildArgs(fixtureQuote({}), { deadline: now + 3601 }))
    } catch (e) {
      threw = e
    }
    expect(isSnfError(threw)).toBe(true)
    expect((threw as SnfError).code).toBe('INVALID_PARAMS')
  })

  it('51 tokenIds throws INVALID_PARAMS', async () => {
    const ctx = buildCtx({})
    const tokenIds = Array.from({ length: 51 }, (_, i) => String(i + 1))
    let threw: unknown
    try {
      await buildBuy(ctx, buildArgs(fixtureQuote({ tokenIds })))
    } catch (e) {
      threw = e
    }
    expect(isSnfError(threw)).toBe(true)
    expect((threw as SnfError).code).toBe('INVALID_PARAMS')
  })

  it('estimateGasWithBuffer is used for the swap step gas — a simulated revert propagates', async () => {
    mockedQuoteBuy.mockResolvedValue(fixtureQuote({}))
    const ctx = buildCtx({
      estimateContractGasImpl: async () => {
        throw new Error('fetch failed')
      },
    })
    const plan = await buildBuy(ctx, buildArgs(fixtureQuote({})))
    // RPC failure falls back to the deterministic NFT-batch estimate, not a throw.
    expect(plan.steps[0]?.tx.gas).toBe(2n * 300_000n + 1_500_000n)
  })
})
