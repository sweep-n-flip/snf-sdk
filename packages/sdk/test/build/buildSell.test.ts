import { decodeFunctionData, BaseError, ContractFunctionRevertedError } from 'viem'
import type { PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/quote/quoteSell', () => ({ quoteSell: vi.fn() }))

import { buildSell } from '../../src/build/buildSell'
import { ROUTER02_COLLECTION_ABI } from '../../src/abis/UniswapV2Router02Collection'
import { ROUTER_NATIVE_ERC20_ABI } from '../../src/abis/UniswapV2Router01CollectionNativeERC20'
import { getChain } from '../../src/chains/registry'
import { quoteSell } from '../../src/quote/quoteSell'
import { isSnfError, SnfError } from '../../src/errors'
import type { SnfChainId } from '../../src/chains/chains.types'
import type { SnfClientContext } from '../../src/types/client.types'
import type { Amount } from '../../src/types/amount.types'
import type { BuildArgs } from '../../src/types/plan.types'
import type { FeeBreakdown, Quote, QuoteLeg } from '../../src/types/quote.types'

const mockedQuoteSell = vi.mocked(quoteSell)

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
    path: [COLLECTION, opts.baseToken],
    feeBps: 200,
    kind: opts.isNative ? 'native' : 'erc20',
    side: 'sell',
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
  readonly totalProceeds?: bigint
  readonly redemptionLockedWarning?: boolean
}): Quote {
  const chainId = opts.chainId ?? 8453
  const isNative = opts.isNative ?? true
  const baseToken = opts.baseToken ?? getChain(chainId).quoteToken
  const tokenIds = opts.tokenIds ?? ['1', '2']
  const totalProceeds = opts.totalProceeds ?? 1_000_000n
  return {
    side: 'sell',
    chainId,
    collection: COLLECTION,
    count: tokenIds.length,
    tokenIds,
    legs: [fixtureLeg({ isNative, baseToken, tokenIds })],
    fees: fixtureFees(),
    totalProceeds: amount(totalProceeds),
    priceImpact: 0,
    deliverable: tokenIds.length,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    reconciled: true,
    ...(opts.redemptionLockedWarning ? { warnings: ['This collection currently blocks NFT redemption from the wrapper.'] } : {}),
  }
}

type ReadResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

function buildCtx(opts: {
  readonly chainId?: number
  readonly multicallImpl?: (params: { readonly contracts: readonly unknown[] }) => Promise<readonly ReadResult[]>
  readonly estimateContractGasImpl?: () => Promise<bigint>
}): SnfClientContext {
  const chain = getChain(opts.chainId ?? 8453)
  const multicall = vi.fn(opts.multicallImpl ?? (async () => [{ status: 'success', result: true }]))
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
  mockedQuoteSell.mockReset()
})

describe('buildSell — fresh re-quote, never the caller\'s numbers', () => {
  it('calls quoteSell again internally with the args\' selection, not the caller\'s totals', async () => {
    const reQuote = fixtureQuote({ totalProceeds: 3_000_000n })
    mockedQuoteSell.mockResolvedValue(reQuote)
    const ctx = buildCtx({})
    const callerQuote = fixtureQuote({ totalProceeds: 1n })
    const plan = await buildSell(ctx, buildArgs(callerQuote))

    expect(mockedQuoteSell).toHaveBeenCalledTimes(1)
    expect(mockedQuoteSell).toHaveBeenCalledWith(ctx, {
      chainId: 8453,
      collection: COLLECTION,
      tokenIds: ['1', '2'],
      receiveToken: null,
    })
    const swapStep = plan.steps.find((s) => s.kind === 'swap-sell')
    // 1% default slippage, floor: 3_000_000 * 9900 / 10000 = 2_970_000
    expect(swapStep?.bounds.amountOutMin).toBe(2_970_000n)
  })

  it('a doubled/zeroed tampered caller quote produces byte-identical bounds and tx to the untampered one', async () => {
    const reQuote = fixtureQuote({ totalProceeds: 500_000n })
    mockedQuoteSell.mockResolvedValue(reQuote)
    const ctx = buildCtx({})

    const real = fixtureQuote({ totalProceeds: 500_000n })
    const tampered: Quote = {
      ...real,
      totalProceeds: amount(real.totalProceeds!.value * 2n),
      fees: { ...real.fees, royalty: { ...real.fees.royalty, value: 0n } },
    }

    const planA = await buildSell(ctx, buildArgs(real))
    const planB = await buildSell(ctx, buildArgs(tampered))
    const stepA = planA.steps.find((s) => s.kind === 'swap-sell')
    const stepB = planB.steps.find((s) => s.kind === 'swap-sell')
    expect(stepB?.bounds).toEqual(stepA?.bounds)
    expect(stepB?.tx.data).toBe(stepA?.tx.data)
    expect(stepB?.tx.value).toBe(stepA?.tx.value)
  })
})

describe('buildSell — approvals (setApprovalForAll always checked, native or ERC-20 base)', () => {
  it('with no setApprovalForAll granted, steps[0].kind==="approval" (erc721-approval-for-all) then steps[1].kind==="swap-sell"', async () => {
    mockedQuoteSell.mockResolvedValue(fixtureQuote({}))
    const ctx = buildCtx({ multicallImpl: async () => [{ status: 'success', result: false }] })
    const plan = await buildSell(ctx, buildArgs(fixtureQuote({})))
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0]?.kind).toBe('approval')
    expect(plan.steps[0]?.approvals[0]?.kind).toBe('erc721-approval-for-all')
    expect(plan.steps[1]?.kind).toBe('swap-sell')
  })

  it('with setApprovalForAll already granted, steps.length===1 and steps[0].kind==="swap-sell"', async () => {
    mockedQuoteSell.mockResolvedValue(fixtureQuote({}))
    const ctx = buildCtx({ multicallImpl: async () => [{ status: 'success', result: true }] })
    const plan = await buildSell(ctx, buildArgs(fixtureQuote({})))
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.kind).toBe('swap-sell')
  })

  it('an ERC-20-base sell still only checks the ERC-721 approval, never an ERC-20 allowance', async () => {
    mockedQuoteSell.mockResolvedValue(fixtureQuote({ isNative: false, baseToken: BASE_TOKEN }))
    const calls: unknown[][] = []
    const ctx = buildCtx({
      multicallImpl: async (params) => {
        calls.push(params.contracts as unknown[])
        return [{ status: 'success', result: true }]
      },
    })
    await buildSell(ctx, buildArgs(fixtureQuote({ isNative: false, baseToken: BASE_TOKEN })))
    expect(calls).toHaveLength(1)
    expect(calls[0]).toHaveLength(1) // only the erc721 isApprovedForAll read
  })

  // Finding 2, (fixed in): a missing setApprovalForAll
  // used to make buildSell THROW (the swap step's live gas estimate reverted before
  // assemblePlan ever ran). `estimateContractGasImpl` is wired to throw a GENUINE
  // simulated revert if it is EVER called, proving the fix works because the live
  // estimate is skipped entirely while the approval is pending, not because it
  // happens to succeed.
  it('a missing setApprovalForAll returns the plan (approval, then swap) instead of throwing — the live estimate is never attempted', async () => {
    mockedQuoteSell.mockResolvedValue(fixtureQuote({}))
    const revertError = new BaseError('execution reverted', {
      cause: new ContractFunctionRevertedError({ abi: [], functionName: 'swapExactTokensForETHCollection' }),
    })
    const ctx = buildCtx({
      multicallImpl: async () => [{ status: 'success', result: false }], // not approved
      estimateContractGasImpl: async () => {
        throw revertError
      },
    })
    const plan = await buildSell(ctx, buildArgs(fixtureQuote({})))
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0]?.kind).toBe('approval')
    expect(plan.steps[1]?.kind).toBe('swap-sell')
    expect((ctx.publicClient.estimateContractGas as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    expect(plan.steps[1]?.tx.gas).toBe(2n * 300_000n + 1_500_000n) // fallbackGasForNFTBatch(2)
    expect(plan.steps[1]?.tx.gasSource).toBe('fallback-pending-approval')
  })

  it('setApprovalForAll already granted still takes the live-estimate path (gasSource undefined)', async () => {
    mockedQuoteSell.mockResolvedValue(fixtureQuote({}))
    const ctx = buildCtx({
      multicallImpl: async () => [{ status: 'success', result: true }],
      estimateContractGasImpl: async () => 700_000n,
    })
    const plan = await buildSell(ctx, buildArgs(fixtureQuote({})))
    expect(plan.steps).toHaveLength(1)
    expect((ctx.publicClient.estimateContractGas as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
    expect(plan.steps[0]?.tx.gas).toBe((700_000n * 125n) / 100n)
    expect(plan.steps[0]?.tx.gasSource).toBeUndefined()
  })
})

describe('buildSell — encoding (native vs ERC-20 entry point, capRoyaltyFee pinned false, tx.value===0)', () => {
  it('encodes swapExactTokensForETHCollection for a native pool; decodes with capRoyaltyFee===false', async () => {
    mockedQuoteSell.mockResolvedValue(fixtureQuote({ isNative: true, tokenIds: ['3', '4'], totalProceeds: 1_000_000n }))
    const ctx = buildCtx({})
    const plan = await buildSell(ctx, buildArgs(fixtureQuote({ isNative: true, tokenIds: ['3', '4'], totalProceeds: 1_000_000n })))
    const step = plan.steps.find((s) => s.kind === 'swap-sell')
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: step!.tx.data })
    expect(decoded.functionName).toBe('swapExactTokensForETHCollection')
    const [tokenIdsIn, , , capRoyaltyFee] = decoded.args
    expect(tokenIdsIn).toEqual([3n, 4n])
    expect(capRoyaltyFee).toBe(false)
    expect(step!.tx.value).toBe(0n)
  })

  it('encodes swapExactTokensForTokensCollection for an ERC-20-base pool; amountOutMin from the fresh re-quote', async () => {
    mockedQuoteSell.mockResolvedValue(fixtureQuote({ isNative: false, baseToken: BASE_TOKEN, totalProceeds: 900_000n }))
    const ctx = buildCtx({})
    const plan = await buildSell(ctx, buildArgs(fixtureQuote({ isNative: false, baseToken: BASE_TOKEN, totalProceeds: 900_000n })))
    const step = plan.steps.find((s) => s.kind === 'swap-sell')
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: step!.tx.data })
    expect(decoded.functionName).toBe('swapExactTokensForTokensCollection')
    expect(step!.bounds.amountOutMin).toBe(891_000n) // floor(900_000 * 9900/10000)
    expect(step!.tx.value).toBe(0n)
  })

  it('slippageBps: 0 makes bounds.amountOutMin === reQuote.totalProceeds.value exactly', async () => {
    mockedQuoteSell.mockResolvedValue(fixtureQuote({ totalProceeds: 42_424_242n }))
    const ctx = buildCtx({})
    const plan = await buildSell(ctx, buildArgs(fixtureQuote({ totalProceeds: 42_424_242n }), { slippageBps: 0 }))
    const step = plan.steps.find((s) => s.kind === 'swap-sell')
    expect(step?.bounds.amountOutMin).toBe(42_424_242n)
  })

  it('on Arc, the sell entry point decodes against the NativeERC20 Router ABI (tx.value always 0 on sell)', async () => {
    mockedQuoteSell.mockResolvedValue(fixtureQuote({ chainId: 5042, isNative: true, totalProceeds: 100_000n }))
    const ctx = buildCtx({ chainId: 5042 })
    const plan = await buildSell(ctx, buildArgs(fixtureQuote({ chainId: 5042, isNative: true, totalProceeds: 100_000n })))
    const step = plan.steps.find((s) => s.kind === 'swap-sell')
    const decoded = decodeFunctionData({ abi: ROUTER_NATIVE_ERC20_ABI, data: step!.tx.data })
    expect(decoded.functionName).toBe('swapExactTokensForETHCollection')
    expect(step!.tx.value).toBe(0n)
  })

  it('every step tx.chainId equals the chain id; the swap step\'s tx.to is the router', async () => {
    mockedQuoteSell.mockResolvedValue(fixtureQuote({}))
    const ctx = buildCtx({ multicallImpl: async () => [{ status: 'success', result: false }] })
    const plan = await buildSell(ctx, buildArgs(fixtureQuote({})))
    for (const step of plan.steps) {
      expect(step.tx.chainId).toBe(ctx.chain.chainId)
    }
    const swapStep = plan.steps.find((s) => s.kind === 'swap-sell')
    expect(swapStep?.tx.to).toBe(ctx.chain.router02)
  })

  it('a redemptionLocked collection still builds a sell; the plan carries the warning via step.quote.warnings', async () => {
    mockedQuoteSell.mockResolvedValue(fixtureQuote({ redemptionLockedWarning: true }))
    const ctx = buildCtx({})
    const plan = await buildSell(ctx, buildArgs(fixtureQuote({})))
    const step = plan.steps.find((s) => s.kind === 'swap-sell')
    expect(step?.quote.warnings?.length).toBeGreaterThan(0)
  })
})

describe('buildSell — validation (Hard caps)', () => {
  it('deadline = now + 3601 throws INVALID_PARAMS', async () => {
    const ctx = buildCtx({})
    const now = Math.floor(Date.now() / 1000)
    let threw: unknown
    try {
      await buildSell(ctx, buildArgs(fixtureQuote({}), { deadline: now + 3601 }))
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
      await buildSell(ctx, buildArgs(fixtureQuote({ tokenIds })))
    } catch (e) {
      threw = e
    }
    expect(isSnfError(threw)).toBe(true)
    expect((threw as SnfError).code).toBe('INVALID_PARAMS')
  })
})
