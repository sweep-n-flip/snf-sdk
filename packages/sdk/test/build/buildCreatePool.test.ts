import { decodeFunctionData, getAddress } from 'viem'
import type { PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/liquidity/quoteCreatePool', () => ({ quoteCreatePool: vi.fn() }))

import { buildCreatePool } from '../../src/build/buildCreatePool'
import { PAIR_CREATION_GAS, WRAPPER_CREATION_GAS } from '../../src/build/gas'
import { ROUTER02_COLLECTION_ABI } from '../../src/abis/UniswapV2Router02Collection'
import { getChain } from '../../src/chains/registry'
import { isSnfError, SnfError } from '../../src/errors'
import { floorSqrt, MINIMUM_LIQUIDITY, ONE_WNFT } from '../../src/liquidity/liquidityMath'
import { quoteCreatePool } from '../../src/liquidity/quoteCreatePool'
import type { SnfChainId } from '../../src/chains/chains.types'
import type { SnfClientContext } from '../../src/types/client.types'
import type { Amount } from '../../src/types/amount.types'
import type { LiquidityQuoteDetails } from '../../src/types/liquidity.types'
import type { Quote } from '../../src/types/quote.types'

const mockedQuoteCreatePool = vi.mocked(quoteCreatePool)

const COLLECTION = getAddress('0x0000000000000000000000000000000000c011ec')
const WRAPPER = getAddress('0x00000000000000000000000000000000000fa99e')
const PAIR = getAddress('0x0000000000000000000000000000000000ba12a1')
const RECIPIENT = getAddress('0x000000000000000000000000000000000000a11e')

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

function sixIds(): readonly string[] {
  return ['1', '2', '3', '4', '5', '6']
}

function fixtureLiquidity(opts: {
  readonly pair: `0x${string}` | null
  readonly wrapper: `0x${string}` | null
  readonly nftCount: number
  readonly baseAmount: bigint
  readonly lpOut: bigint
}): LiquidityQuoteDetails {
  return {
    pair: opts.pair,
    wrapper: opts.wrapper,
    baseToken: { address: null, symbol: 'ETH', decimals: 18, isNative: true },
    wrapperIsToken0: opts.pair === null ? null : true,
    reserves: { base: 0n, wnft: 0n },
    totalSupply: 0n,
    blockNumber: 999_999n,
    nftCount: opts.nftCount,
    baseRequired: amount(opts.baseAmount),
    pricePerNft: amount(opts.baseAmount / BigInt(opts.nftCount)),
    lpOut: amount(opts.lpOut, 18, 'LP'),
    feeToZero: true,
  }
}

function fixtureQuote(opts: {
  readonly chainId?: SnfChainId
  readonly pair?: `0x${string}` | null
  readonly wrapper?: `0x${string}` | null
  readonly tokenIds?: readonly string[]
  readonly baseAmount: bigint
  readonly lpOut?: bigint
}): Quote {
  const chainId = opts.chainId ?? 8453
  const tokenIds = opts.tokenIds ?? sixIds()
  const pair = opts.pair ?? null
  const wrapper = opts.wrapper ?? null
  const lpOut = opts.lpOut ?? floorSqrt(BigInt(tokenIds.length) * ONE_WNFT * opts.baseAmount) - MINIMUM_LIQUIDITY
  return {
    side: 'create-pool',
    chainId,
    collection: COLLECTION,
    tokenIds,
    legs: [],
    fees: zeroFees(),
    liquidity: fixtureLiquidity({ pair, wrapper, nftCount: tokenIds.length, baseAmount: opts.baseAmount, lpOut }),
    totalCost: amount(opts.baseAmount),
    priceImpact: 0,
    deliverable: tokenIds.length,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    reconciled: true,
  }
}

function simulateResultFor(quote: Quote): readonly [bigint, bigint, bigint] {
  const liquidity = quote.liquidity!
  const wnft = BigInt(liquidity.nftCount) * ONE_WNFT
  const base = liquidity.baseRequired!.value
  const lp = liquidity.lpOut!.value
  return [wnft, base, lp] // native
}

type ReadResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }
type MulticallParams = { readonly contracts: readonly { readonly functionName: string }[] }

/** A generically-answering default: approved/sufficient/owned-by-the-payer for
 * whatever shape of read a caller (approvals pre-check, or a later `plan.preflight()`
 * call) happens to send — individual tests override only the ONE function name they
 * need to behave differently. */
async function defaultMulticallImpl(params: MulticallParams): Promise<readonly ReadResult[]> {
  return params.contracts.map((c): ReadResult => {
    switch (c.functionName) {
      case 'isApprovedForAll':
        return { status: 'success', result: true }
      case 'allowance':
        return { status: 'success', result: 2n ** 256n - 1n }
      case 'ownerOf':
        return { status: 'success', result: RECIPIENT }
      case 'collection':
        return { status: 'success', result: COLLECTION }
      default:
        return { status: 'success', result: true }
    }
  })
}

function buildCtx(opts: {
  readonly chainId?: number
  readonly multicallImpl?: (params: MulticallParams) => Promise<readonly ReadResult[]>
  readonly simulateContractImpl?: () => Promise<{ readonly result: unknown }>
  readonly estimateContractGasImpl?: () => Promise<bigint>
}): SnfClientContext {
  const chain = getChain(opts.chainId ?? 8453)
  const multicall = vi.fn(opts.multicallImpl ?? defaultMulticallImpl)
  const simulateContract = vi.fn(opts.simulateContractImpl ?? (async () => ({ result: [0n, 0n, 0n] })))
  const estimateContractGas = vi.fn(opts.estimateContractGasImpl ?? (async () => 1_000_000n))
  const getBalance = vi.fn(async () => 2n ** 256n - 1n)
  const getBlockNumber = vi.fn(async () => 999_999n)
  const publicClient = { multicall, simulateContract, estimateContractGas, getBalance, getBlockNumber } as unknown as PublicClient
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
  mockedQuoteCreatePool.mockReset()
})

describe('buildCreatePool — exact minimums, decoded from calldata', () => {
  it('native: amountETHMin === value === baseAmount (no slippage on a create)', async () => {
    const baseAmount = 12_000_000_000_000_000_000n
    const reQuote = fixtureQuote({ baseAmount })
    mockedQuoteCreatePool.mockResolvedValue(reQuote)
    const ctx = buildCtx({
      // ERC-721 approval still pending.
      multicallImpl: async (params) =>
        params.contracts.map((c) =>
          c.functionName === 'isApprovedForAll'
            ? { status: 'success', result: false }
            : { status: 'success', result: c.functionName === 'ownerOf' ? RECIPIENT : true },
        ),
      simulateContractImpl: async () => ({ result: simulateResultFor(reQuote) }),
    })

    const plan = await buildCreatePool(ctx, buildArgs(reQuote))
    const depositStep = plan.steps[plan.steps.length - 1]!
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: depositStep.tx.data })
    expect(decoded.functionName).toBe('addLiquidityETHCollection')
    expect(decoded.args[2]).toBe(baseAmount) // amountETHMin
    expect(depositStep.tx.value).toBe(baseAmount)
    expect(depositStep.label).toBe('Create pool')
  })
})

describe('buildCreatePool — reserves that gained liquidity between quote and build refuse to produce a plan', () => {
  it('the fresh re-quote throwing pool-has-liquidity propagates as INVALID_PARAMS', async () => {
    const reQuote = fixtureQuote({ baseAmount: 1n })
    mockedQuoteCreatePool.mockRejectedValue(
      new SnfError('INVALID_PARAMS', 'This pool already has liquidity — call quoteAddLiquidity instead.', {
        details: { field: 'collection', reason: 'pool-has-liquidity' },
      }),
    )
    const ctx = buildCtx({})
    const { error } = await expectRejectsWithCode(buildCreatePool(ctx, buildArgs(reQuote)), 'INVALID_PARAMS')
    expect(error.details?.reason).toBe('pool-has-liquidity')
  })
})

describe('buildCreatePool — first-time creation gas overhead', () => {
  it('no wrapper, no pair, pending ERC-721 approval: fallback + pair + wrapper overhead, gasSource fallback-pending-approval', async () => {
    const baseAmount = 12_000_000_000_000_000_000n
    const reQuote = fixtureQuote({ baseAmount, pair: null, wrapper: null })
    mockedQuoteCreatePool.mockResolvedValue(reQuote)
    const ctx = buildCtx({
      multicallImpl: async (params) =>
        params.contracts.map((c) =>
          c.functionName === 'isApprovedForAll'
            ? { status: 'success', result: false }
            : { status: 'success', result: c.functionName === 'ownerOf' ? RECIPIENT : true },
        ),
      simulateContractImpl: async () => ({ result: simulateResultFor(reQuote) }),
    })

    const plan = await buildCreatePool(ctx, buildArgs(reQuote))
    const depositStep = plan.steps[plan.steps.length - 1]!
    expect(depositStep.tx.gas).toBe(6n * 300_000n + 1_500_000n + PAIR_CREATION_GAS + WRAPPER_CREATION_GAS)
    expect(depositStep.tx.gasSource).toBe('fallback-pending-approval')
    expect(depositStep.preflightRefs?.wrapper).toBeNull()

    const preflight = await plan.preflight()
    expect(preflight.ok).toBe(true)
  })
})

describe('buildCreatePool — the six-NFT minimum propagates from the fresh re-quote', () => {
  it('five tokenIds throws INVALID_PARAMS with details.min 6', async () => {
    const reQuote = fixtureQuote({ baseAmount: 1n, tokenIds: ['1', '2', '3', '4', '5'] })
    mockedQuoteCreatePool.mockRejectedValue(
      new SnfError('INVALID_PARAMS', 'tokenIds must have at least 6 entries', {
        details: { field: 'tokenIds', min: 6, value: 5 },
      }),
    )
    const ctx = buildCtx({})
    const { error } = await expectRejectsWithCode(buildCreatePool(ctx, buildArgs(reQuote)), 'INVALID_PARAMS')
    expect(error.details?.min).toBe(6)
  })
})

describe('buildCreatePool — quote.side guard', () => {
  it('a non-create-pool Quote throws INVALID_PARAMS naming quote.side', async () => {
    const wrongSide = { ...fixtureQuote({ baseAmount: 1n }), side: 'add-liquidity' as const }
    const ctx = buildCtx({})
    const { error } = await expectRejectsWithCode(buildCreatePool(ctx, buildArgs(wrongSide)), 'INVALID_PARAMS')
    expect(error.details?.field).toBe('quote.side')
    expect(mockedQuoteCreatePool).not.toHaveBeenCalled()
  })
})
