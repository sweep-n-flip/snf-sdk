import { decodeFunctionData, getAddress } from 'viem'
import type { PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/liquidity/quoteAddLiquidity', () => ({ quoteAddLiquidity: vi.fn() }))

import { buildAddLiquidity } from '../../src/build/buildAddLiquidity'
import { applySlippageDown, applySlippageUp } from '../../src/build/bounds'
import { ROUTER02_COLLECTION_ABI } from '../../src/abis/UniswapV2Router02Collection'
import { ROUTER_NATIVE_ERC20_ABI } from '../../src/abis/UniswapV2Router01CollectionNativeERC20'
import { getChain } from '../../src/chains/registry'
import { toNativeValue } from '../../src/chains/units'
import { isSnfError, SnfError } from '../../src/errors'
import { minErc20Desired, ONE_WNFT, requiredBase } from '../../src/liquidity/liquidityMath'
import { quoteAddLiquidity } from '../../src/liquidity/quoteAddLiquidity'
import type { SnfChainId } from '../../src/chains/chains.types'
import type { SnfClientContext } from '../../src/types/client.types'
import type { Amount } from '../../src/types/amount.types'
import type { LiquidityQuoteDetails } from '../../src/types/liquidity.types'
import type { Quote } from '../../src/types/quote.types'

const mockedQuoteAddLiquidity = vi.mocked(quoteAddLiquidity)

const COLLECTION = getAddress('0x0000000000000000000000000000000000c011ec')
const WRAPPER = getAddress('0x00000000000000000000000000000000000fa99e')
const PAIR = getAddress('0x0000000000000000000000000000000000ba12a1')
const BASE_ERC20 = getAddress('0x000000000000000000000000000000000000ba5e')
const RECIPIENT = getAddress('0x000000000000000000000000000000000000a11e')
const LP_RECIPIENT = getAddress('0x000000000000000000000000000000000000f00d')

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
  readonly isNative: boolean
  readonly baseDecimals: number
  readonly baseSymbol: string
  readonly nftCount: number
  readonly baseRequired: bigint
  readonly baseDesired?: bigint
  readonly lpOut: bigint
}): LiquidityQuoteDetails {
  return {
    pair: PAIR,
    wrapper: WRAPPER,
    baseToken: { address: opts.isNative ? null : BASE_ERC20, symbol: opts.baseSymbol, decimals: opts.baseDecimals, isNative: opts.isNative },
    wrapperIsToken0: true,
    reserves: { base: 1n, wnft: 1n },
    totalSupply: 1n,
    blockNumber: 999_999n,
    nftCount: opts.nftCount,
    baseRequired: amount(opts.baseRequired, opts.baseDecimals, opts.baseSymbol),
    ...(opts.baseDesired !== undefined ? { baseDesired: amount(opts.baseDesired, opts.baseDecimals, opts.baseSymbol) } : {}),
    lpOut: amount(opts.lpOut, 18, 'LP'),
    feeToZero: true,
  }
}

function fixtureQuote(opts: {
  readonly chainId?: SnfChainId
  readonly isNative: boolean
  readonly baseDecimals?: number
  readonly baseSymbol?: string
  readonly nftCount?: number
  readonly baseRequired: bigint
  readonly baseDesired?: bigint
  readonly lpOut?: bigint
  readonly tokenIds?: readonly string[]
}): Quote {
  const chainId = opts.chainId ?? 8453
  const nftCount = opts.nftCount ?? 1
  const tokenIds = opts.tokenIds ?? ['1']
  return {
    side: 'add-liquidity',
    chainId,
    collection: COLLECTION,
    tokenIds,
    legs: [],
    fees: zeroFees(),
    liquidity: fixtureLiquidity({
      isNative: opts.isNative,
      baseDecimals: opts.baseDecimals ?? 18,
      baseSymbol: opts.baseSymbol ?? getChain(chainId).nativeSymbol,
      nftCount,
      baseRequired: opts.baseRequired,
      ...(opts.baseDesired !== undefined ? { baseDesired: opts.baseDesired } : {}),
      lpOut: opts.lpOut ?? 100n,
    }),
    totalCost: amount(opts.baseRequired, opts.baseDecimals ?? 18, opts.baseSymbol ?? getChain(chainId).nativeSymbol),
    priceImpact: 0,
    deliverable: nftCount,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    reconciled: true,
  }
}

/** The exact `(v0, v1, liquidity)` tuple `buildDepositStep`'s reconciliation
 * simulation must see for a given quote to settle without throwing. */
function simulateResultFor(quote: Quote, isNative: boolean): readonly [bigint, bigint, bigint] {
  const liquidity = quote.liquidity
  const nftCount = liquidity?.nftCount ?? 0
  const wnft = BigInt(nftCount) * ONE_WNFT
  const base = liquidity?.baseRequired?.value ?? 0n
  const lp = liquidity?.lpOut?.value ?? 0n
  return isNative ? [wnft, base, lp] : [base, wnft, lp]
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
    opts.multicallImpl ?? (async (): Promise<readonly ReadResult[]> => [{ status: 'success', result: true }]),
  )
  const simulateContract = vi.fn(opts.simulateContractImpl ?? (async () => ({ result: [0n, 0n, 0n] })))
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
  return { quote, recipient: RECIPIENT, ...overrides }
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
  mockedQuoteAddLiquidity.mockReset()
})

describe('buildAddLiquidity — fresh re-quote, never the caller\'s own numbers', () => {
  it('a caller quote with a doubled baseRequired is ignored — the encoded tx reflects the FRESH re-quote only', async () => {
    const reQuote = fixtureQuote({ isNative: true, baseRequired: 500_000_000_000_000_000n, lpOut: 100n })
    mockedQuoteAddLiquidity.mockResolvedValue(reQuote)
    const ctx = buildCtx({ simulateContractImpl: async () => ({ result: simulateResultFor(reQuote, true) }) })
    const tampered = fixtureQuote({ isNative: true, baseRequired: 999_000_000_000_000_000_000n, lpOut: 1n })

    const plan = await buildAddLiquidity(ctx, buildArgs(tampered))
    const step = plan.steps[plan.steps.length - 1]!
    const required = requiredBaseFrom(reQuote)
    expect(step.bounds.amountInMax).toBe(applySlippageUp(required, 100))
  })
})

function requiredBaseFrom(quote: Quote): bigint {
  return quote.liquidity!.baseRequired!.value
}

describe('buildAddLiquidity — native base bounds', () => {
  it('value = applySlippageUp(required) in wei, amountETHMin = applySlippageDown(required)', async () => {
    const required = 500_000_000_000_000_000n
    const reQuote = fixtureQuote({ isNative: true, baseRequired: required, lpOut: 100n })
    mockedQuoteAddLiquidity.mockResolvedValue(reQuote)
    const ctx = buildCtx({ simulateContractImpl: async () => ({ result: simulateResultFor(reQuote, true) }) })

    const plan = await buildAddLiquidity(ctx, buildArgs(reQuote))
    const step = plan.steps[plan.steps.length - 1]!
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: step.tx.data })
    expect(decoded.functionName).toBe('addLiquidityETHCollection')
    expect(step.tx.value).toBe(toNativeValue(8453, applySlippageUp(required, 100)))
    expect(decoded.args[2]).toBe(applySlippageDown(required, 100)) // amountETHMin
    expect(step.kind).toBe('add-liquidity')
    expect(step.label).toBe('Confirm deposit')
  })

  it('Arc: value === amountMaxQuote x 10^12, amountETHMin stays in 6-decimal quote units', async () => {
    const required = 5_000_000n // 6-decimal quote units
    const reQuote = fixtureQuote({ chainId: 5042, isNative: true, baseRequired: required, lpOut: 100n, baseDecimals: 6 })
    mockedQuoteAddLiquidity.mockResolvedValue(reQuote)
    const ctx = buildCtx({ chainId: 5042, simulateContractImpl: async () => ({ result: simulateResultFor(reQuote, true) }) })

    const plan = await buildAddLiquidity(ctx, buildArgs(reQuote))
    const step = plan.steps[plan.steps.length - 1]!
    const decoded = decodeFunctionData({ abi: ROUTER_NATIVE_ERC20_ABI, data: step.tx.data })
    const amountMaxQuote = applySlippageUp(required, 100)
    expect(step.tx.value).toBe(amountMaxQuote * 10n ** 12n)
    expect(decoded.args[2]).toBe(applySlippageDown(required, 100))
  })
})

describe('buildAddLiquidity — ERC-20 base bounds and approval', () => {
  it('amountADesired = applySlippageUp(ceil), amountAMin = applySlippageDown(required), approval covers amountADesired', async () => {
    const reserves = { base: 7n, wnft: 3_000_000_000_000_000_000n }
    const required = requiredBase(2, reserves.wnft, reserves.base)
    const ceil = minErc20Desired(2, reserves.wnft, reserves.base)
    const reQuote = fixtureQuote({
      isNative: false,
      baseRequired: required,
      baseDesired: ceil,
      lpOut: 100n,
      nftCount: 2,
      tokenIds: ['1', '2'],
      baseSymbol: 'USDC',
    })
    mockedQuoteAddLiquidity.mockResolvedValue(reQuote)
    // The first multicall entry answers erc721 isApprovedForAll (true = no approval
    // needed); the second answers the ERC-20 allowance (0 = insufficient).
    const ctx = buildCtx({
      multicallImpl: async () => [
        { status: 'success', result: true },
        { status: 'success', result: 0n },
      ],
      simulateContractImpl: async () => ({ result: simulateResultFor(reQuote, false) }),
    })

    const plan = await buildAddLiquidity(ctx, buildArgs(reQuote))
    expect(plan.steps).toHaveLength(2)
    const approvalStep = plan.steps[0]!
    const depositStep = plan.steps[1]!
    expect(approvalStep.kind).toBe('approval')
    expect(approvalStep.approvals[0]?.kind).toBe('erc20-allowance')
    const decodedApproval = decodeFunctionData({ abi: (await import('../../src/abis/ERC20')).ERC20_ABI, data: approvalStep.tx.data })
    expect(decodedApproval.args[1]).toBe(applySlippageUp(ceil, 100))

    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: depositStep.tx.data })
    expect(decoded.functionName).toBe('addLiquidityCollection')
    expect(decoded.args[2]).toBe(applySlippageUp(ceil, 100)) // amountADesired
    expect(decoded.args[4]).toBe(applySlippageDown(required, 100)) // amountAMin
    expect(depositStep.tx.value).toBe(0n)
  })
})

describe('buildAddLiquidity — approvals appear only when missing, ordered before the deposit', () => {
  it('an already-granted operator approval produces no approval step', async () => {
    const reQuote = fixtureQuote({ isNative: true, baseRequired: 100n, lpOut: 100n })
    mockedQuoteAddLiquidity.mockResolvedValue(reQuote)
    const ctx = buildCtx({
      multicallImpl: async () => [{ status: 'success', result: true }],
      simulateContractImpl: async () => ({ result: simulateResultFor(reQuote, true) }),
    })
    const plan = await buildAddLiquidity(ctx, buildArgs(reQuote))
    expect(plan.steps).toHaveLength(1)
    expect(plan.steps[0]?.kind).toBe('add-liquidity')
  })

  it('a missing operator approval targets router02 on the collection, never the wrapper', async () => {
    const reQuote = fixtureQuote({ isNative: true, baseRequired: 100n, lpOut: 100n })
    mockedQuoteAddLiquidity.mockResolvedValue(reQuote)
    const ctx = buildCtx({
      multicallImpl: async () => [{ status: 'success', result: false }],
      simulateContractImpl: async () => ({ result: simulateResultFor(reQuote, true) }),
    })
    const plan = await buildAddLiquidity(ctx, buildArgs(reQuote))
    expect(plan.steps).toHaveLength(2)
    expect(plan.steps[0]?.kind).toBe('approval')
    expect(plan.steps[0]?.approvals[0]?.token).toBe(COLLECTION)
    expect(plan.steps[0]?.approvals[0]?.spender).toBe(ctx.chain.router02)
    expect(plan.steps[0]?.approvals[0]?.spender).not.toBe(WRAPPER)
    expect(plan.steps[1]?.kind).toBe('add-liquidity')
  })
})

describe('buildAddLiquidity — lpRecipient', () => {
  it('omitted: LP lands on recipient', async () => {
    const reQuote = fixtureQuote({ isNative: true, baseRequired: 100n, lpOut: 100n })
    mockedQuoteAddLiquidity.mockResolvedValue(reQuote)
    const ctx = buildCtx({ simulateContractImpl: async () => ({ result: simulateResultFor(reQuote, true) }) })
    const plan = await buildAddLiquidity(ctx, buildArgs(reQuote))
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: plan.steps[plan.steps.length - 1]!.tx.data })
    expect(decoded.args[3]).toBe(RECIPIENT) // `to`
  })

  it('given: LP lands on lpRecipient', async () => {
    const reQuote = fixtureQuote({ isNative: true, baseRequired: 100n, lpOut: 100n })
    mockedQuoteAddLiquidity.mockResolvedValue(reQuote)
    const ctx = buildCtx({ simulateContractImpl: async () => ({ result: simulateResultFor(reQuote, true) }) })
    const plan = await buildAddLiquidity(ctx, buildArgs(reQuote, { lpRecipient: LP_RECIPIENT }))
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: plan.steps[plan.steps.length - 1]!.tx.data })
    expect(decoded.args[3]).toBe(LP_RECIPIENT)
  })

  it('malformed lpRecipient throws INVALID_PARAMS naming the field', async () => {
    const reQuote = fixtureQuote({ isNative: true, baseRequired: 100n, lpOut: 100n })
    mockedQuoteAddLiquidity.mockResolvedValue(reQuote)
    const ctx = buildCtx({})
    const { error } = await expectRejectsWithCode(
      buildAddLiquidity(ctx, buildArgs(reQuote, { lpRecipient: '0xnotanaddress' })),
      'INVALID_PARAMS',
    )
    expect(error.details?.field).toBe('lpRecipient')
  })
})

describe('buildAddLiquidity — quote.side guard', () => {
  it('a non-add-liquidity Quote throws INVALID_PARAMS naming quote.side', async () => {
    const wrongSide = { ...fixtureQuote({ isNative: true, baseRequired: 100n, lpOut: 100n }), side: 'sell' as const }
    const ctx = buildCtx({})
    const { error } = await expectRejectsWithCode(buildAddLiquidity(ctx, buildArgs(wrongSide)), 'INVALID_PARAMS')
    expect(error.details?.field).toBe('quote.side')
    expect(mockedQuoteAddLiquidity).not.toHaveBeenCalled()
  })
})
