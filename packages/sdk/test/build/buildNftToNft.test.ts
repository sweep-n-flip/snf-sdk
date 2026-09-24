import { decodeFunctionData } from 'viem'
import type { PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/quote/quoteNftToNft', () => ({ quoteNftToNft: vi.fn() }))

import { buildNftToNft } from '../../src/build/buildNftToNft'
import { ROUTER02_COLLECTION_ABI } from '../../src/abis/UniswapV2Router02Collection'
import { createCheckout } from '../../src/checkout/createCheckout'
import { getChain } from '../../src/chains/registry'
import { isSnfError, SnfError } from '../../src/errors'
import { quoteNftToNft } from '../../src/quote/quoteNftToNft'
import type { SnfChainId } from '../../src/chains/chains.types'
import type { SnfClientContext } from '../../src/types/client.types'
import type { Amount } from '../../src/types/amount.types'
import type { BuildArgs } from '../../src/types/plan.types'
import type { FeeBreakdown, Quote, QuoteLeg } from '../../src/types/quote.types'

const mockedQuoteNftToNft = vi.mocked(quoteNftToNft)

function addr(suffix: string): `0x${string}` {
  return `0x${suffix.padStart(40, '0')}` as `0x${string}`
}

const SELL_COLLECTION = addr('5e11ec01')
const SELL_WRAPPER = addr('5e11ec0a')
const SELL_PAIR = addr('5e11ec0b')
const BUY_COLLECTION = addr('b0710c01')
const BUY_WRAPPER = addr('b0710c0a')
const BUY_PAIR = addr('b0710c0b')
const RECIPIENT = addr('a11e')

function amount(value: bigint, decimals = 18, symbol = 'ETH'): Amount {
  return { value, formatted: value.toString(), symbol, decimals }
}

function fixtureFees(): FeeBreakdown {
  return {
    pool: { bps: 200, note: 'included in curve' },
    marketplace: { ...amount(0n), bps: 0 },
    royalty: { ...amount(5n), bps: 10, capApplied: false },
  }
}

function fixtureQuote(opts: {
  readonly chainId?: SnfChainId
  readonly isNative?: boolean
  readonly baseToken?: `0x${string}`
  readonly sellTokenIds?: readonly string[]
  readonly buyTokenIds?: readonly string[]
  readonly netProceeds?: bigint
  readonly buyCost?: bigint
  readonly remainderMode?: 'native' | 'wnft'
  readonly remainder?: bigint
}): Quote {
  const chainId = opts.chainId ?? 8453
  const isNative = opts.isNative ?? true
  const baseToken = opts.baseToken ?? getChain(chainId).quoteToken
  const sellTokenIds = opts.sellTokenIds ?? ['1']
  const buyTokenIds = opts.buyTokenIds ?? ['9']
  const netProceeds = opts.netProceeds ?? 1_000_000n
  const buyCost = opts.buyCost ?? 900_000n
  const remainderMode = opts.remainderMode ?? 'native'
  const remainderValue = opts.remainder ?? (netProceeds > buyCost ? netProceeds - buyCost : 0n)

  const sellLeg: QuoteLeg = {
    pair: SELL_PAIR,
    count: sellTokenIds.length,
    amount: amount(netProceeds),
    path: [SELL_COLLECTION, baseToken],
    feeBps: 200,
    kind: isNative ? 'native' : 'erc20',
    side: 'sell',
    collection: SELL_COLLECTION,
    wrapper: SELL_WRAPPER,
    tokenIds: sellTokenIds,
    fees: fixtureFees(),
  }
  const buyLeg: QuoteLeg = {
    pair: BUY_PAIR,
    count: buyTokenIds.length,
    amount: amount(buyCost),
    path: [baseToken, BUY_COLLECTION],
    feeBps: 200,
    kind: isNative ? 'native' : 'erc20',
    side: 'buy',
    collection: BUY_COLLECTION,
    wrapper: BUY_WRAPPER,
    tokenIds: buyTokenIds,
    fees: fixtureFees(),
  }

  return {
    side: 'nft-to-nft',
    chainId,
    legs: [sellLeg, buyLeg],
    fees: fixtureFees(),
    netProceeds: amount(netProceeds),
    buyCost: amount(buyCost),
    remainder:
      remainderMode === 'wnft' ? { value: remainderValue, formatted: remainderValue.toString(), symbol: 'RASTA', decimals: 18 } : amount(remainderValue),
    remainderMode,
    priceImpact: 0,
    deliverable: buyTokenIds.length,
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
  mockedQuoteNftToNft.mockReset()
})

describe('buildNftToNft — step ordering (ordering, 2-vs-3 next())', () => {
  it("remainder: 'native' with no approval granted yields exactly ['approval','swap-sell','swap-buy']", async () => {
    mockedQuoteNftToNft.mockResolvedValue(fixtureQuote({ remainderMode: 'native' }))
    const ctx = buildCtx({ multicallImpl: async () => [{ status: 'success', result: false }] })
    const plan = await buildNftToNft(ctx, buildArgs(fixtureQuote({ remainderMode: 'native' })))
    expect(plan.steps.map((s) => s.kind)).toEqual(['approval', 'swap-sell', 'swap-buy'])
  })

  it("remainder: 'native' with the approval already granted yields exactly ['swap-sell','swap-buy']", async () => {
    mockedQuoteNftToNft.mockResolvedValue(fixtureQuote({ remainderMode: 'native' }))
    const ctx = buildCtx({ multicallImpl: async () => [{ status: 'success', result: true }] })
    const plan = await buildNftToNft(ctx, buildArgs(fixtureQuote({ remainderMode: 'native' })))
    expect(plan.steps.map((s) => s.kind)).toEqual(['swap-sell', 'swap-buy'])
  })

  it("remainder: 'wnft' yields exactly ['swap-sell','swap-buy','swap-buy-wnft'] (approval already granted)", async () => {
    mockedQuoteNftToNft.mockResolvedValue(fixtureQuote({ remainderMode: 'wnft', netProceeds: 2_000_000n, buyCost: 1_000_000n }))
    const ctx = buildCtx({ multicallImpl: async () => [{ status: 'success', result: true }] })
    const plan = await buildNftToNft(
      ctx,
      buildArgs(fixtureQuote({ remainderMode: 'wnft', netProceeds: 2_000_000n, buyCost: 1_000_000n })),
    )
    expect(plan.steps.map((s) => s.kind)).toEqual(['swap-sell', 'swap-buy', 'swap-buy-wnft'])
  })

  it("remainder: 'wnft' with no approval granted yields all four kinds in order", async () => {
    mockedQuoteNftToNft.mockResolvedValue(fixtureQuote({ remainderMode: 'wnft' }))
    const ctx = buildCtx({ multicallImpl: async () => [{ status: 'success', result: false }] })
    const plan = await buildNftToNft(ctx, buildArgs(fixtureQuote({ remainderMode: 'wnft' })))
    expect(plan.steps.map((s) => s.kind)).toEqual(['approval', 'swap-sell', 'swap-buy', 'swap-buy-wnft'])
  })

  // Finding 2, (fixed in): a missing sell-collection
  // `setApprovalForAll` used to make buildNftToNft THROW (the sell step's live gas
  // estimate reverted before assemblePlan ever ran). Proven here from the call-count
  // side: `estimateContractGas` is invoked exactly ONCE (for the buy leg, which needs
  // no approval of its own and always keeps the live path) — the sell leg's own
  // estimate is never attempted while its approval is pending, and gets the
  // deterministic fallback instead, marked `gasSource`. (`resolveGasForStep`'s own
  // unit test in `test/build/approvals.test.ts` separately proves the skip holds
  // even when the live estimate WOULD revert.)
  it('a missing sell-collection approval returns the plan (approval, sell, buy) with fallback gas on ONLY the sell step', async () => {
    mockedQuoteNftToNft.mockResolvedValue(fixtureQuote({ remainderMode: 'native' }))
    const ctx = buildCtx({
      multicallImpl: async () => [{ status: 'success', result: false }], // approval missing
      estimateContractGasImpl: async () => 1_000_000n, // the buy step's own live estimate
    })
    const plan = await buildNftToNft(ctx, buildArgs(fixtureQuote({ remainderMode: 'native' })))
    expect(plan.steps.map((s) => s.kind)).toEqual(['approval', 'swap-sell', 'swap-buy'])

    const sellStep = plan.steps.find((s) => s.kind === 'swap-sell')
    const buyStep = plan.steps.find((s) => s.kind === 'swap-buy')
    expect(sellStep?.tx.gasSource).toBe('fallback-pending-approval')
    expect(sellStep?.tx.gas).toBe(1n * 300_000n + 1_500_000n) // fallbackGasForNFTBatch(1 sell id)
    expect(buyStep?.tx.gasSource).toBeUndefined()
    expect(buyStep?.tx.gas).toBe((1_000_000n * 125n) / 100n) // buy leg took the live path
    // The live estimate was attempted exactly ONCE — for the buy leg only, never for
    // the sell leg whose approval is still missing.
    expect((ctx.publicClient.estimateContractGas as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
  })
})

describe('buildNftToNft — fresh re-quote, never the caller\'s numbers', () => {
  it('calls quoteNftToNft again internally with the args\' selection', async () => {
    mockedQuoteNftToNft.mockResolvedValue(fixtureQuote({}))
    const ctx = buildCtx({})
    await buildNftToNft(ctx, buildArgs(fixtureQuote({ sellTokenIds: ['1'], buyTokenIds: ['9'] })))
    expect(mockedQuoteNftToNft).toHaveBeenCalledTimes(1)
    expect(mockedQuoteNftToNft).toHaveBeenCalledWith(ctx, {
      chainId: 8453,
      sell: { collection: SELL_COLLECTION, tokenIds: ['1'] },
      buy: { collection: BUY_COLLECTION, count: 1 },
      remainder: 'native',
    })
  })

  it('a doubled/zeroed tampered caller quote produces identical bounds for both legs', async () => {
    const reQuote = fixtureQuote({ netProceeds: 1_000_000n, buyCost: 500_000n })
    mockedQuoteNftToNft.mockResolvedValue(reQuote)
    const ctx = buildCtx({})

    const real = fixtureQuote({ netProceeds: 1_000_000n, buyCost: 500_000n })
    const tampered: Quote = {
      ...real,
      netProceeds: amount(real.netProceeds!.value * 2n),
      buyCost: amount(1n),
    }

    const planA = await buildNftToNft(ctx, buildArgs(real))
    const planB = await buildNftToNft(ctx, buildArgs(tampered))
    const sellA = planA.steps.find((s) => s.kind === 'swap-sell')
    const sellB = planB.steps.find((s) => s.kind === 'swap-sell')
    const buyA = planA.steps.find((s) => s.kind === 'swap-buy')
    const buyB = planB.steps.find((s) => s.kind === 'swap-buy')
    expect(sellB?.bounds).toEqual(sellA?.bounds)
    expect(buyB?.bounds).toEqual(buyA?.bounds)
    expect(sellB?.tx.data).toBe(sellA?.tx.data)
    expect(buyB?.tx.data).toBe(buyA?.tx.data)
  })
})

describe('buildNftToNft — per-leg encoding (capRoyaltyFee false, correct collection per path)', () => {
  it('both legs decode with capRoyaltyFee===false and the correct collection address in each path', async () => {
    mockedQuoteNftToNft.mockResolvedValue(fixtureQuote({}))
    const ctx = buildCtx({})
    const plan = await buildNftToNft(ctx, buildArgs(fixtureQuote({})))
    const sellStep = plan.steps.find((s) => s.kind === 'swap-sell')
    const buyStep = plan.steps.find((s) => s.kind === 'swap-buy')

    const sellDecoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: sellStep!.tx.data })
    expect(sellDecoded.functionName).toBe('swapExactTokensForETHCollection')
    expect(sellDecoded.args[3]).toBe(false) // capRoyaltyFee
    expect((sellDecoded.args[2] as readonly string[])[0]?.toLowerCase()).toBe(SELL_COLLECTION.toLowerCase())

    const buyDecoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: buyStep!.tx.data })
    expect(buyDecoded.functionName).toBe('swapETHForExactTokensCollection')
    expect(buyDecoded.args[2]).toBe(false) // capRoyaltyFee
    expect((buyDecoded.args[1] as readonly string[])[1]?.toLowerCase()).toBe(BUY_COLLECTION.toLowerCase())
  })

  it('the sell leg amountOutMin and buy leg amountInMax come from the fresh re-quote', async () => {
    mockedQuoteNftToNft.mockResolvedValue(fixtureQuote({ netProceeds: 1_000_000n, buyCost: 500_000n }))
    const ctx = buildCtx({})
    const plan = await buildNftToNft(ctx, buildArgs(fixtureQuote({ netProceeds: 1_000_000n, buyCost: 500_000n })))
    const sellStep = plan.steps.find((s) => s.kind === 'swap-sell')
    const buyStep = plan.steps.find((s) => s.kind === 'swap-buy')
    expect(sellStep?.bounds.amountOutMin).toBe(990_000n) // floor(1_000_000 * 9900/10000)
    expect(buyStep?.bounds.amountInMax).toBe(505_000n) // ceil(500_000 * 10100/10000)
  })
})

describe('buildNftToNft — route/edge behavior', () => {
  it('cross-base pools throw NO_ROUTE before any step is built (re-quote refuses first)', async () => {
    mockedQuoteNftToNft.mockRejectedValue(
      new SnfError('NO_ROUTE', 'different base', { details: { reason: 'different-base' } }),
    )
    const ctx = buildCtx({})
    let threw: unknown
    try {
      await buildNftToNft(ctx, buildArgs(fixtureQuote({})))
    } catch (e) {
      threw = e
    }
    expect(isSnfError(threw)).toBe(true)
    expect((threw as SnfError).code).toBe('NO_ROUTE')
  })

  it('buyCost > netProceeds still builds — the plan carries buyCost/netProceeds, not a refusal', async () => {
    mockedQuoteNftToNft.mockResolvedValue(fixtureQuote({ netProceeds: 100_000n, buyCost: 500_000n, remainderMode: 'native' }))
    const ctx = buildCtx({})
    const plan = await buildNftToNft(
      ctx,
      buildArgs(fixtureQuote({ netProceeds: 100_000n, buyCost: 500_000n, remainderMode: 'native' })),
    )
    expect(plan.steps.map((s) => s.kind)).toEqual(['swap-sell', 'swap-buy'])
  })

  it('different sell and buy collections are required — same collection throws INVALID_PARAMS', async () => {
    mockedQuoteNftToNft.mockResolvedValue(fixtureQuote({}))
    const ctx = buildCtx({})
    const quote = fixtureQuote({})
    const sameCollectionQuote: Quote = {
      ...quote,
      legs: [{ ...quote.legs[0]!, collection: BUY_COLLECTION }, quote.legs[1]!],
    }
    let threw: unknown
    try {
      await buildNftToNft(ctx, buildArgs(sameCollectionQuote))
    } catch (e) {
      threw = e
    }
    expect(isSnfError(threw)).toBe(true)
    expect((threw as SnfError).code).toBe('INVALID_PARAMS')
  })
})

describe('buildNftToNft — steps are ordered by orderSteps, every tx chain-stamped', () => {
  it('every step tx.chainId equals the chain id', async () => {
    mockedQuoteNftToNft.mockResolvedValue(fixtureQuote({ remainderMode: 'wnft' }))
    const ctx = buildCtx({ multicallImpl: async () => [{ status: 'success', result: false }] })
    const plan = await buildNftToNft(ctx, buildArgs(fixtureQuote({ remainderMode: 'wnft' })))
    for (const step of plan.steps) expect(step.tx.chainId).toBe(ctx.chain.chainId)
    expect(plan.steps[0]?.kind).toBe('approval') // stable partition puts approvals first
  })
})

describe('buildNftToNft — integration with createCheckout (2 vs 3 non-null next() calls)', () => {
  it('remainder: native, approval already granted — exactly 2 non-null next() calls', async () => {
    mockedQuoteNftToNft.mockResolvedValue(fixtureQuote({ remainderMode: 'native' }))
    const ctx = buildCtx({ multicallImpl: async () => [{ status: 'success', result: true }] })
    const plan = await buildNftToNft(ctx, buildArgs(fixtureQuote({ remainderMode: 'native' })))
    const checkout = createCheckout(plan)

    let dispatchedCount = 0
    for (let i = 0; i < plan.steps.length; i += 1) {
      const step = checkout.next()
      expect(step).not.toBeNull()
      if (step) dispatchedCount += 1
      checkout.onReceipt({ status: 'success', transactionHash: '0xaa', blockNumber: 1n, logs: [] })
    }
    expect(dispatchedCount).toBe(2)
    expect(checkout.next()).toBeNull() // nothing left to dispatch after 'success'
  })

  it('remainder: wnft, approval already granted — exactly 3 non-null next() calls', async () => {
    mockedQuoteNftToNft.mockResolvedValue(fixtureQuote({ remainderMode: 'wnft', netProceeds: 2_000_000n, buyCost: 1_000_000n }))
    const ctx = buildCtx({ multicallImpl: async () => [{ status: 'success', result: true }] })
    const plan = await buildNftToNft(
      ctx,
      buildArgs(fixtureQuote({ remainderMode: 'wnft', netProceeds: 2_000_000n, buyCost: 1_000_000n })),
    )
    const checkout = createCheckout(plan)

    let dispatchedCount = 0
    for (let i = 0; i < plan.steps.length; i += 1) {
      const step = checkout.next()
      expect(step).not.toBeNull()
      if (step) dispatchedCount += 1
      checkout.onReceipt({ status: 'success', transactionHash: '0xbb', blockNumber: 1n, logs: [] })
    }
    expect(dispatchedCount).toBe(3)
  })
})

describe('buildNftToNft — no auto-advance, no send-all helper', () => {
  it('the returned plan exposes no method beyond preflight() — no sendAll/executeAll', async () => {
    mockedQuoteNftToNft.mockResolvedValue(fixtureQuote({}))
    const ctx = buildCtx({})
    const plan = await buildNftToNft(ctx, buildArgs(fixtureQuote({})))
    const keys = Object.keys(plan)
    expect(keys).not.toContain('sendAll')
    expect(keys).not.toContain('executeAll')
    expect(typeof plan.preflight).toBe('function')
  })
})
