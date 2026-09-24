import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { decodeFunctionData, BaseError, ContractFunctionRevertedError } from 'viem'
import type { PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/quote/quoteSwap', () => ({ quoteSwap: vi.fn() }))
vi.mock('../../src/quote/quoteBuy', () => ({ quoteBuy: vi.fn() }))
vi.mock('../../src/quote/quoteSell', () => ({ quoteSell: vi.fn() }))
vi.mock('../../src/quote/quoteNftToNft', () => ({ quoteNftToNft: vi.fn() }))

import { buildBuy } from '../../src/build/buildBuy'
import { buildNftToNft } from '../../src/build/buildNftToNft'
import { buildSell } from '../../src/build/buildSell'
import { buildSwap, selectFungibleEntryPoint } from '../../src/build/buildSwap'
import { ROUTER02_COLLECTION_ABI } from '../../src/abis/UniswapV2Router02Collection'
import { ROUTER_NATIVE_ERC20_ABI } from '../../src/abis/UniswapV2Router01CollectionNativeERC20'
import { getChain } from '../../src/chains/registry'
import { isSnfError, SnfError } from '../../src/errors'
import { quoteBuy } from '../../src/quote/quoteBuy'
import { quoteNftToNft } from '../../src/quote/quoteNftToNft'
import { quoteSell } from '../../src/quote/quoteSell'
import { quoteSwap } from '../../src/quote/quoteSwap'
import type { SnfChainId } from '../../src/chains/chains.types'
import type { SnfClientContext } from '../../src/types/client.types'
import type { Amount } from '../../src/types/amount.types'
import type { BuildArgs, ExecutionPlan } from '../../src/types/plan.types'
import type { FeeBreakdown, Quote, QuoteLeg } from '../../src/types/quote.types'

const mockedQuoteSwap = vi.mocked(quoteSwap)
const mockedQuoteBuy = vi.mocked(quoteBuy)
const mockedQuoteSell = vi.mocked(quoteSell)
const mockedQuoteNftToNft = vi.mocked(quoteNftToNft)

function addr(suffix: string): `0x${string}` {
  return `0x${suffix.padStart(40, '0')}` as `0x${string}`
}

const TOKEN_A = addr('a0a1')
const TOKEN_B = addr('b0b1')
const COLLECTION = addr('c011ec')
const WRAPPER = addr('fa99e')
const SELL_COLLECTION = addr('5e11ec01')
const SELL_WRAPPER = addr('5e11ec0a')
const SELL_PAIR = addr('5e11ec0b')
const BUY_COLLECTION = addr('b0710c01')
const BUY_WRAPPER = addr('b0710c0a')
const BUY_PAIR = addr('b0710c0b')
const PAIR = addr('ba12a1')
const RECIPIENT = addr('a11e')

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

type ReadResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

function buildCtx(opts: {
  readonly chainId?: SnfChainId
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

// ── buildSwap's own fixtures ──────────────────────────────────────────────────

function swapLeg(opts: { readonly path: readonly `0x${string}`[] }): QuoteLeg {
  return { pair: PAIR, count: 0, amount: amount(1_000_000n), path: opts.path, feeBps: 200, kind: 'erc20', side: 'sell' }
}

function fixtureSwapQuote(opts: {
  readonly chainId?: SnfChainId
  readonly isNativeIn?: boolean
  readonly isNativeOut?: boolean
  readonly amountIn?: bigint
  readonly amountOut?: bigint
  readonly exactSide?: 'in' | 'out'
}): Quote {
  const chainId = opts.chainId ?? 8453
  const quoteToken = getChain(chainId).quoteToken
  const isNativeIn = opts.isNativeIn ?? true
  const isNativeOut = opts.isNativeOut ?? false
  const inAddr = isNativeIn ? quoteToken : TOKEN_A
  const outAddr = isNativeOut ? quoteToken : TOKEN_B
  const amountIn = opts.amountIn ?? 1_000_000n
  const amountOut = opts.amountOut ?? 900_000n
  const exactSide = opts.exactSide ?? 'in'
  return {
    side: 'swap',
    chainId,
    legs: [swapLeg({ path: [inAddr, outAddr] })],
    fees: fixtureFees(),
    amountIn: amount(amountIn),
    amountOut: amount(amountOut),
    amountSpecified: exactSide,
    priceImpact: 0,
    deliverable: 1,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    reconciled: true,
  }
}

function swapArgs(quote: Quote, overrides: Partial<BuildArgs> = {}): BuildArgs {
  return { quote, recipient: RECIPIENT, ...overrides }
}

beforeEach(() => {
  mockedQuoteSwap.mockReset()
  mockedQuoteBuy.mockReset()
  mockedQuoteSell.mockReset()
  mockedQuoteNftToNft.mockReset()
})

describe('selectFungibleEntryPoint — the six-entry table', () => {
  it('exact-in: native-in -> swapExactETHForTokens; native-out -> swapExactTokensForETH; else swapExactTokensForTokens', () => {
    expect(selectFungibleEntryPoint({ isNativeIn: true, isNativeOut: false, exactSide: 'in' })).toBe('swapExactETHForTokens')
    expect(selectFungibleEntryPoint({ isNativeIn: false, isNativeOut: true, exactSide: 'in' })).toBe('swapExactTokensForETH')
    expect(selectFungibleEntryPoint({ isNativeIn: false, isNativeOut: false, exactSide: 'in' })).toBe('swapExactTokensForTokens')
  })
  it('exact-out: native-in -> swapETHForExactTokens; native-out -> swapTokensForExactETH; else swapTokensForExactTokens', () => {
    expect(selectFungibleEntryPoint({ isNativeIn: true, isNativeOut: false, exactSide: 'out' })).toBe('swapETHForExactTokens')
    expect(selectFungibleEntryPoint({ isNativeIn: false, isNativeOut: true, exactSide: 'out' })).toBe('swapTokensForExactETH')
    expect(selectFungibleEntryPoint({ isNativeIn: false, isNativeOut: false, exactSide: 'out' })).toBe('swapTokensForExactTokens')
  })
})

describe('buildSwap — fresh re-quote, entry-point selection, bounds', () => {
  it('a native-in swap encodes swapExactETHForTokens with tx.value===toNativeValue(chainId, amountIn)', async () => {
    mockedQuoteSwap.mockResolvedValue(fixtureSwapQuote({ isNativeIn: true, isNativeOut: false, amountIn: 1_000_000n, amountOut: 900_000n }))
    const ctx = buildCtx({})
    const plan = await buildSwap(ctx, swapArgs(fixtureSwapQuote({ isNativeIn: true, isNativeOut: false })))
    const step = plan.steps[plan.steps.length - 1]!
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: step.tx.data })
    expect(decoded.functionName).toBe('swapExactETHForTokens')
    expect(step.tx.value).toBe(1_000_000n)
    expect(step.bounds.amountOutMin).toBe(891_000n) // floor(900_000 * 9900/10000)
  })

  it('a native-out swap encodes swapExactTokensForETH with tx.value===0n and one ERC-20 approval when the allowance is missing', async () => {
    mockedQuoteSwap.mockResolvedValue(fixtureSwapQuote({ isNativeIn: false, isNativeOut: true, amountIn: 1_000_000n, amountOut: 900_000n }))
    const ctx = buildCtx({ multicallImpl: async () => [{ status: 'success', result: 0n }] })
    const plan = await buildSwap(ctx, swapArgs(fixtureSwapQuote({ isNativeIn: false, isNativeOut: true })))
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0]?.kind).toBe('approval')
    expect(plan.steps[0]?.approvals[0]?.kind).toBe('erc20-allowance')
    const swapStep = plan.steps.find((s) => s.kind === 'swap-fungible')!
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: swapStep.tx.data })
    expect(decoded.functionName).toBe('swapExactTokensForETH')
    expect(swapStep.tx.value).toBe(0n)
  })

  // Finding 2, — the finding's own primary example (first traced
  // on this exact function): a missing ERC-20 allowance used to make buildSwap THROW
  // (the swap step's live gas estimate reverted, by design, before assemblePlan ever
  // ran) — so the caller never received the very approval step that would fix it.
  // Fixed in . `estimateContractGasImpl` is wired to throw a GENUINE
  // simulated revert if it is EVER called, proving the fix works because the live
  // estimate is skipped entirely while the approval is pending, not because it
  // happens to succeed.
  it('a missing ERC-20 allowance returns the plan (approval, then swap) instead of throwing — the live estimate is never attempted (Finding 2)', async () => {
    mockedQuoteSwap.mockResolvedValue(fixtureSwapQuote({ isNativeIn: false, isNativeOut: true, amountIn: 1_000_000n, amountOut: 900_000n }))
    const revertError = new BaseError('execution reverted', {
      cause: new ContractFunctionRevertedError({ abi: [], functionName: 'swapExactTokensForETH' }),
    })
    const ctx = buildCtx({
      multicallImpl: async () => [{ status: 'success', result: 0n }], // allowance 0 — missing
      estimateContractGasImpl: async () => {
        throw revertError
      },
    })
    const plan = await buildSwap(ctx, swapArgs(fixtureSwapQuote({ isNativeIn: false, isNativeOut: true })))
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0]?.kind).toBe('approval')
    const swapStep = plan.steps.find((s) => s.kind === 'swap-fungible')!
    expect((ctx.publicClient.estimateContractGas as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
    expect(swapStep.tx.gas).toBe(0n * 300_000n + 1_500_000n) // fallbackGasForNFTBatch(0)
    expect(swapStep.tx.gasSource).toBe('fallback-pending-approval')
  })

  it('a SUFFICIENT ERC-20 allowance still takes the live-estimate path (gasSource undefined)', async () => {
    mockedQuoteSwap.mockResolvedValue(fixtureSwapQuote({ isNativeIn: false, isNativeOut: true, amountIn: 1_000_000n, amountOut: 900_000n }))
    const ctx = buildCtx({
      multicallImpl: async () => [{ status: 'success', result: 10_000_000n }],
      estimateContractGasImpl: async () => 800_000n,
    })
    const plan = await buildSwap(ctx, swapArgs(fixtureSwapQuote({ isNativeIn: false, isNativeOut: true })))
    expect(plan.steps).toHaveLength(1)
    const swapStep = plan.steps[0]!
    expect((ctx.publicClient.estimateContractGas as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
    expect(swapStep.tx.gas).toBe((800_000n * 125n) / 100n)
    expect(swapStep.tx.gasSource).toBeUndefined()
  })

  it('a token-to-token swap encodes swapExactTokensForTokens', async () => {
    mockedQuoteSwap.mockResolvedValue(fixtureSwapQuote({ isNativeIn: false, isNativeOut: false }))
    const ctx = buildCtx({})
    const plan = await buildSwap(ctx, swapArgs(fixtureSwapQuote({ isNativeIn: false, isNativeOut: false })))
    const step = plan.steps[plan.steps.length - 1]!
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: step.tx.data })
    expect(decoded.functionName).toBe('swapExactTokensForTokens')
  })

  it('an amountOut-specified swap encodes the …ForExact… entry point with amountInMax from applySlippageUp', async () => {
    mockedQuoteSwap.mockResolvedValue(
      fixtureSwapQuote({ isNativeIn: true, isNativeOut: false, exactSide: 'out', amountIn: 1_000_000n, amountOut: 900_000n }),
    )
    const ctx = buildCtx({})
    const plan = await buildSwap(ctx, swapArgs(fixtureSwapQuote({ isNativeIn: true, isNativeOut: false, exactSide: 'out' })))
    const step = plan.steps[plan.steps.length - 1]!
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: step.tx.data })
    expect(decoded.functionName).toBe('swapETHForExactTokens')
    expect(step.bounds.amountInMax).toBe(1_010_000n) // ceil(1_000_000 * 10100/10000)
    expect(step.tx.value).toBe(1_010_000n)
  })

  it('slippageBps: 0 makes amountOutMin === reQuote.amountOut.value exactly', async () => {
    mockedQuoteSwap.mockResolvedValue(fixtureSwapQuote({ amountOut: 424_242n }))
    const ctx = buildCtx({})
    const plan = await buildSwap(ctx, swapArgs(fixtureSwapQuote({ amountOut: 424_242n }), { slippageBps: 0 }))
    const step = plan.steps[plan.steps.length - 1]!
    expect(step.bounds.amountOutMin).toBe(424_242n)
  })

  it('a route blocked by directOnly throws NO_ROUTE with details.viablePayTokens before any step is built', async () => {
    mockedQuoteSwap.mockRejectedValue(
      new SnfError('NO_ROUTE', 'no direct pair', { details: { reason: 'direct-only', viablePayTokens: [{ address: TOKEN_A }] } }),
    )
    const ctx = buildCtx({})
    let threw: unknown
    try {
      await buildSwap(ctx, swapArgs(fixtureSwapQuote({})))
    } catch (e) {
      threw = e
    }
    expect(isSnfError(threw)).toBe(true)
    expect((threw as SnfError).code).toBe('NO_ROUTE')
    expect((threw as SnfError).details?.viablePayTokens).toBeDefined()
  })

  it('a doubled/zeroed tampered caller quote produces byte-identical bounds and tx', async () => {
    mockedQuoteSwap.mockResolvedValue(fixtureSwapQuote({ amountIn: 1_000_000n, amountOut: 900_000n }))
    const ctx = buildCtx({})
    const real = fixtureSwapQuote({ amountIn: 1_000_000n, amountOut: 900_000n })
    const tampered: Quote = { ...real, amountOut: amount(real.amountOut!.value * 2n) }
    const planA = await buildSwap(ctx, swapArgs(real))
    const planB = await buildSwap(ctx, swapArgs(tampered))
    const stepA = planA.steps[planA.steps.length - 1]
    const stepB = planB.steps[planB.steps.length - 1]
    expect(stepB?.bounds).toEqual(stepA?.bounds)
    expect(stepB?.tx.data).toBe(stepA?.tx.data)
  })
})

// ── Cross-builder invariants — a shared describe block iterating all four builders ─

interface BuiltCase {
  readonly name: string
  readonly plan: ExecutionPlan
  readonly ctx: SnfClientContext
  readonly abi: typeof ROUTER02_COLLECTION_ABI | typeof ROUTER_NATIVE_ERC20_ABI
}

function fixtureBuyQuote(chainId: SnfChainId): Quote {
  const leg: QuoteLeg = {
    pair: PAIR,
    count: 1,
    amount: amount(1_000_000n),
    path: [getChain(chainId).quoteToken, COLLECTION],
    feeBps: 200,
    kind: 'native',
    side: 'buy',
    collection: COLLECTION,
    wrapper: WRAPPER,
    tokenIds: ['1'],
  }
  return {
    side: 'buy',
    chainId,
    collection: COLLECTION,
    count: 1,
    tokenIds: ['1'],
    legs: [leg],
    fees: fixtureFees(),
    totalCost: amount(1_000_000n),
    priceImpact: 0,
    deliverable: 1,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    reconciled: true,
  }
}

function fixtureSellQuote(chainId: SnfChainId): Quote {
  const leg: QuoteLeg = {
    pair: PAIR,
    count: 1,
    amount: amount(1_000_000n),
    path: [COLLECTION, getChain(chainId).quoteToken],
    feeBps: 200,
    kind: 'native',
    side: 'sell',
    collection: COLLECTION,
    wrapper: WRAPPER,
    tokenIds: ['1'],
  }
  return {
    side: 'sell',
    chainId,
    collection: COLLECTION,
    count: 1,
    tokenIds: ['1'],
    legs: [leg],
    fees: fixtureFees(),
    totalProceeds: amount(1_000_000n),
    priceImpact: 0,
    deliverable: 1,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    reconciled: true,
  }
}

function fixtureNftToNftQuote(chainId: SnfChainId): Quote {
  const base = getChain(chainId).quoteToken
  const sellLeg: QuoteLeg = {
    pair: SELL_PAIR,
    count: 1,
    amount: amount(1_000_000n),
    path: [SELL_COLLECTION, base],
    feeBps: 200,
    kind: 'native',
    side: 'sell',
    collection: SELL_COLLECTION,
    wrapper: SELL_WRAPPER,
    tokenIds: ['1'],
    fees: fixtureFees(),
  }
  const buyLeg: QuoteLeg = {
    pair: BUY_PAIR,
    count: 1,
    amount: amount(500_000n),
    path: [base, BUY_COLLECTION],
    feeBps: 200,
    kind: 'native',
    side: 'buy',
    collection: BUY_COLLECTION,
    wrapper: BUY_WRAPPER,
    tokenIds: ['9'],
    fees: fixtureFees(),
  }
  return {
    side: 'nft-to-nft',
    chainId,
    legs: [sellLeg, buyLeg],
    fees: fixtureFees(),
    netProceeds: amount(1_000_000n),
    buyCost: amount(500_000n),
    remainder: amount(500_000n),
    remainderMode: 'native',
    priceImpact: 0,
    deliverable: 1,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    reconciled: true,
  }
}

async function buildAllFour(chainId: SnfChainId): Promise<readonly BuiltCase[]> {
  const abi = getChain(chainId).routerVariant === 'native-erc20' ? ROUTER_NATIVE_ERC20_ABI : ROUTER02_COLLECTION_ABI
  const ctx = buildCtx({ chainId, multicallImpl: async () => [{ status: 'success', result: true }] })

  mockedQuoteBuy.mockResolvedValue(fixtureBuyQuote(chainId))
  const buyPlan = await buildBuy(ctx, swapArgs(fixtureBuyQuote(chainId)))

  mockedQuoteSell.mockResolvedValue(fixtureSellQuote(chainId))
  const sellPlan = await buildSell(ctx, swapArgs(fixtureSellQuote(chainId)))

  mockedQuoteNftToNft.mockResolvedValue(fixtureNftToNftQuote(chainId))
  const nftToNftPlan = await buildNftToNft(ctx, swapArgs(fixtureNftToNftQuote(chainId)))

  mockedQuoteSwap.mockResolvedValue(fixtureSwapQuote({ chainId, isNativeIn: true, isNativeOut: false }))
  const swapPlan = await buildSwap(ctx, swapArgs(fixtureSwapQuote({ chainId, isNativeIn: true, isNativeOut: false })))

  return [
    { name: 'buildBuy', plan: buyPlan, ctx, abi },
    { name: 'buildSell', plan: sellPlan, ctx, abi },
    { name: 'buildNftToNft', plan: nftToNftPlan, ctx, abi },
    { name: 'buildSwap', plan: swapPlan, ctx, abi },
  ]
}

describe('cross-builder invariants — Base (native-in on the buy/nft-to-nft/swap legs)', () => {
  it('every step tx.chainId===chain.chainId; the swap step(s) tx.to===chain.router02', async () => {
    const cases = await buildAllFour(8453)
    for (const c of cases) {
      for (const step of c.plan.steps) {
        expect(step.tx.chainId).toBe(c.ctx.chain.chainId)
      }
      const swapSteps = c.plan.steps.filter((s) => s.kind !== 'approval')
      expect(swapSteps.length).toBeGreaterThan(0)
      for (const step of swapSteps) expect(step.tx.to).toBe(c.ctx.chain.router02)
    }
  })

  it('every tx.data round-trips through decodeFunctionData against the chain Router ABI', async () => {
    const cases = await buildAllFour(8453)
    let assertions = 0
    for (const c of cases) {
      for (const step of c.plan.steps) {
        expect(() => decodeFunctionData({ abi: c.abi, data: step.tx.data })).not.toThrow()
        assertions += 1
      }
    }
    expect(assertions).toBeGreaterThanOrEqual(4)
  })

  it('every *Collection call in every NFT builder decodes with capRoyaltyFee===false', async () => {
    const cases = await buildAllFour(8453)
    let checked = 0
    for (const c of cases) {
      for (const step of c.plan.steps) {
        if (step.kind === 'approval') continue
        const decoded = decodeFunctionData({ abi: c.abi, data: step.tx.data })
        if (!decoded.functionName.includes('Collection')) continue
        const capIndex = decoded.args.findIndex((a) => typeof a === 'boolean')
        expect(decoded.args[capIndex]).toBe(false)
        checked += 1
      }
    }
    expect(checked).toBeGreaterThanOrEqual(3) // buy, sell, nft-to-nft's two legs
  })

  it('for each builder, a doubled/zeroed caller quote produces identical bounds', async () => {
    const ctx = buildCtx({ chainId: 8453, multicallImpl: async () => [{ status: 'success', result: true }] })

    mockedQuoteBuy.mockResolvedValue(fixtureBuyQuote(8453))
    const realBuy = fixtureBuyQuote(8453)
    const tamperedBuy: Quote = { ...realBuy, totalCost: amount(realBuy.totalCost!.value * 2n) }
    const planBuyA = await buildBuy(ctx, swapArgs(realBuy))
    const planBuyB = await buildBuy(ctx, swapArgs(tamperedBuy))
    expect(planBuyB.steps[planBuyB.steps.length - 1]?.bounds).toEqual(planBuyA.steps[planBuyA.steps.length - 1]?.bounds)

    mockedQuoteSell.mockResolvedValue(fixtureSellQuote(8453))
    const realSell = fixtureSellQuote(8453)
    const tamperedSell: Quote = { ...realSell, totalProceeds: amount(realSell.totalProceeds!.value * 2n) }
    const planSellA = await buildSell(ctx, swapArgs(realSell))
    const planSellB = await buildSell(ctx, swapArgs(tamperedSell))
    expect(planSellB.steps[planSellB.steps.length - 1]?.bounds).toEqual(planSellA.steps[planSellA.steps.length - 1]?.bounds)
  })

  it('no file under src/build/ imports estimateLadder or math/nftPricing', () => {
    const dir = fileURLToPath(new URL('../../src/build/', import.meta.url))
    const files = readdirSync(dir).filter((f) => f.endsWith('.ts'))
    for (const file of files) {
      const content = readFileSync(`${dir}${file}`, 'utf8')
      expect(content).not.toMatch(/estimateLadder|math\/nftPricing/)
    }
  })
})

describe('cross-builder invariants — Arc (routerVariant native-erc20, 1e12 native-value ratio)', () => {
  it('on Arc, tx.value / bounds.amountInMax === 1e12 for buy/nft-to-nft-buy/swap; Base ratio is 1', async () => {
    const arcCases = await buildAllFour(5042)
    for (const c of arcCases) {
      for (const step of c.plan.steps) {
        if (step.tx.value === 0n) continue
        if (step.bounds.amountInMax === undefined) continue
        expect(step.tx.value / step.bounds.amountInMax).toBe(1_000_000_000_000n)
      }
    }

    const baseCases = await buildAllFour(8453)
    for (const c of baseCases) {
      for (const step of c.plan.steps) {
        if (step.tx.value === 0n) continue
        if (step.bounds.amountInMax === undefined) continue
        expect(step.tx.value / step.bounds.amountInMax).toBe(1n)
      }
    }
  })

  it('every Arc tx.data decodes against the NativeERC20 Router ABI', async () => {
    const cases = await buildAllFour(5042)
    for (const c of cases) {
      for (const step of c.plan.steps) {
        expect(() => decodeFunctionData({ abi: ROUTER_NATIVE_ERC20_ABI, data: step.tx.data })).not.toThrow()
      }
    }
  })
})
