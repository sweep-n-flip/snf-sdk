import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionData } from 'viem'
import type { PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/quote/quoteBuy', () => ({ quoteBuy: vi.fn() }))
vi.mock('../../src/quote/quoteSell', () => ({ quoteSell: vi.fn() }))
vi.mock('../../src/quote/quoteNftToNft', () => ({ quoteNftToNft: vi.fn() }))

import { ROUTER02_COLLECTION_ABI } from '../../src/abis/UniswapV2Router02Collection'
import { ROUTER_NATIVE_ERC20_ABI } from '../../src/abis/UniswapV2Router01CollectionNativeERC20'
import { buildBuy } from '../../src/build/buildBuy'
import { buildNftToNft } from '../../src/build/buildNftToNft'
import { buildSell } from '../../src/build/buildSell'
import { getChain } from '../../src/chains/registry'
import { quoteBuy } from '../../src/quote/quoteBuy'
import { quoteNftToNft } from '../../src/quote/quoteNftToNft'
import { quoteSell } from '../../src/quote/quoteSell'
import { resolveSubject } from './_subject'
import type { SnfChainId } from '../../src/chains/chains.types'
import type { SnfClientContext } from '../../src/types/client.types'
import type { Amount } from '../../src/types/amount.types'
import type { BuildArgs } from '../../src/types/plan.types'
import type { FeeBreakdown, Quote, QuoteLeg } from '../../src/types/quote.types'

/**
 * SPEC prohibition #7: the SDK MUST NOT send `capRoyaltyFee=true` in v1
 * (with `royaltyFeeCap` unset, `true` zeroes the creator's royalty) NOR expose a
 * public flag a partner could flip to request it — even if the flag defaulted to
 * `false`, offering the switch at all is the prohibited surface.
 *
 * `check_target`: packages/sdk/test/prohibitions/cap-royalty-pinned.test.ts
 * `check_violation_fixture`: test/fixtures/prohib/cap-royalty-violation.ts
 * `check_clean_fixture`: test/fixtures/prohib/cap-royalty-clean.ts
 */

const mockedQuoteBuy = vi.mocked(quoteBuy)
const mockedQuoteSell = vi.mocked(quoteSell)
const mockedQuoteNftToNft = vi.mocked(quoteNftToNft)

const COLLECTION = '0x0000000000000000000000000000000000c011ec' as `0x${string}`
const WRAPPER = '0x00000000000000000000000000000000000fa99e' as `0x${string}`
const PAIR = '0x0000000000000000000000000000000000ba12a1' as `0x${string}`
const RECIPIENT = '0x000000000000000000000000000000000000a11e' as `0x${string}`

function addr(suffix: string): `0x${string}` {
  return `0x${suffix.padStart(40, '0')}` as `0x${string}`
}

function amount(value: bigint): Amount {
  return { value, formatted: value.toString(), symbol: 'ETH', decimals: 18 }
}

function fixtureFees(): FeeBreakdown {
  return {
    pool: { bps: 200, note: 'included in curve' },
    marketplace: { ...amount(0n), bps: 0 },
    royalty: { ...amount(5n), bps: 10, capApplied: false },
  }
}

function buildCtx(chainId: SnfChainId): SnfClientContext {
  const chain = getChain(chainId)
  const multicall = vi.fn(async () => [])
  const estimateContractGas = vi.fn(async () => 1_000_000n)
  const publicClient = { multicall, estimateContractGas } as unknown as PublicClient
  return {
    config: { chainId, publicClient },
    chain,
    publicClient,
    providers: {},
    transport: {} as SnfClientContext['transport'],
    nextTxInvalidationVersion: () => 1,
  } as unknown as SnfClientContext
}

function buyQuote(chainId: SnfChainId, isNative: boolean): Quote {
  const base = getChain(chainId).quoteToken
  const tokenIds = ['1']
  const leg: QuoteLeg = {
    pair: PAIR,
    count: 1,
    amount: amount(1000n),
    path: [isNative ? base : addr('base'), COLLECTION],
    feeBps: 200,
    kind: isNative ? 'native' : 'erc20',
    side: 'buy',
    collection: COLLECTION,
    wrapper: WRAPPER,
    tokenIds,
  }
  return {
    side: 'buy',
    chainId,
    collection: COLLECTION,
    count: 1,
    tokenIds,
    legs: [leg],
    fees: fixtureFees(),
    totalCost: amount(500_000n),
    priceImpact: 0,
    deliverable: 1,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    reconciled: true,
  }
}

function sellQuote(chainId: SnfChainId): Quote {
  const base = getChain(chainId).quoteToken
  const tokenIds = ['1']
  const leg: QuoteLeg = {
    pair: PAIR,
    count: 1,
    amount: amount(1000n),
    path: [COLLECTION, base],
    feeBps: 200,
    kind: 'native',
    side: 'sell',
    collection: COLLECTION,
    wrapper: WRAPPER,
    tokenIds,
  }
  return {
    side: 'sell',
    chainId,
    collection: COLLECTION,
    count: 1,
    tokenIds,
    legs: [leg],
    fees: fixtureFees(),
    totalProceeds: amount(400_000n),
    priceImpact: 0,
    deliverable: 1,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    reconciled: true,
  }
}

function nftToNftQuote(chainId: SnfChainId): Quote {
  const base = getChain(chainId).quoteToken
  const sellCollection = addr('5e11')
  const sellWrapper = addr('5e11a0')
  const sellPair = addr('5e11ab')
  const buyCollection = addr('b0710c')
  const buyWrapper = addr('b0710ca0')
  const buyPair = addr('b0710cab')
  const sellLeg: QuoteLeg = {
    pair: sellPair,
    count: 1,
    amount: amount(1_000_000n),
    path: [sellCollection, base],
    feeBps: 200,
    kind: 'native',
    side: 'sell',
    collection: sellCollection,
    wrapper: sellWrapper,
    tokenIds: ['1'],
  }
  const buyLeg: QuoteLeg = {
    pair: buyPair,
    count: 1,
    amount: amount(900_000n),
    path: [base, buyCollection],
    feeBps: 200,
    kind: 'native',
    side: 'buy',
    collection: buyCollection,
    wrapper: buyWrapper,
    tokenIds: ['9'],
  }
  return {
    side: 'nft-to-nft',
    chainId,
    legs: [sellLeg, buyLeg],
    fees: fixtureFees(),
    netProceeds: amount(1_000_000n),
    buyCost: amount(900_000n),
    remainder: amount(100_000n),
    remainderMode: 'native',
    priceImpact: 0,
    deliverable: 1,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    reconciled: true,
  }
}

function buildArgs(quote: Quote): BuildArgs {
  return { quote, recipient: RECIPIENT }
}

beforeEach(() => {
  mockedQuoteBuy.mockReset()
  mockedQuoteSell.mockReset()
  mockedQuoteNftToNft.mockReset()
})

describe('cap-royalty-pinned — decoded REAL calldata across every builder path (SPEC prohibition #7)', () => {
  it('buildBuy (Base, native): capRoyaltyFee decodes to the literal false', async () => {
    mockedQuoteBuy.mockResolvedValue(buyQuote(8453, true))
    const ctx = buildCtx(8453)
    const plan = await buildBuy(ctx, buildArgs(buyQuote(8453, true)))
    const step = plan.steps[plan.steps.length - 1]!
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: step.tx.data })
    expect(decoded.functionName).toBe('swapETHForExactTokensCollection')
    expect(decoded.args[2]).toBe(false)
  })

  it('buildSell (Base): capRoyaltyFee decodes to the literal false', async () => {
    mockedQuoteSell.mockResolvedValue(sellQuote(8453))
    const ctx = buildCtx(8453)
    const plan = await buildSell(ctx, buildArgs(sellQuote(8453)))
    const step = plan.steps[plan.steps.length - 1]!
    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: step.tx.data })
    expect(decoded.functionName).toBe('swapExactTokensForETHCollection')
    expect(decoded.args[3]).toBe(false)
  })

  it('buildNftToNft (Base): BOTH legs decode capRoyaltyFee as the literal false', async () => {
    mockedQuoteNftToNft.mockResolvedValue(nftToNftQuote(8453))
    const ctx = buildCtx(8453)
    const plan = await buildNftToNft(ctx, buildArgs(nftToNftQuote(8453)))
    const sellStep = plan.steps.find((s) => s.kind === 'swap-sell')!
    const buyStep = plan.steps.find((s) => s.kind === 'swap-buy')!
    const sellDecoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: sellStep.tx.data })
    const buyDecoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: buyStep.tx.data })
    expect(sellDecoded.args[3]).toBe(false)
    expect(buyDecoded.args[2]).toBe(false)
  })

  it('buildBuy on Arc (NativeERC20 Router variant): capRoyaltyFee also decodes to the literal false', async () => {
    mockedQuoteBuy.mockResolvedValue(buyQuote(5042, true))
    const ctx = buildCtx(5042)
    const plan = await buildBuy(ctx, buildArgs(buyQuote(5042, true)))
    const step = plan.steps[plan.steps.length - 1]!
    const decoded = decodeFunctionData({ abi: ROUTER_NATIVE_ERC20_ABI, data: step.tx.data })
    expect(decoded.functionName).toBe('swapETHForExactTokensCollection')
    expect(decoded.args[2]).toBe(false)
  })
})

describe('cap-royalty-pinned — no public argument type exposes a capRoyaltyFee/royalties/skipRoyalty field', () => {
  const typesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/types')

  it('src/types/*.types.ts has zero non-comment occurrences of capRoyaltyFee, royalties, skipRoyalty', () => {
    const banned = [/capRoyaltyFee/, /\broyalties\b/, /skipRoyalty/]
    const hits: string[] = []
    for (const file of readdirSync(typesDir).filter((f) => f.endsWith('.types.ts'))) {
      const stripped = readFileSync(path.join(typesDir, file), 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(?<!:)\/\/.*$/gm, '')
      for (const re of banned) {
        if (re.test(stripped)) hits.push(`${file} matches ${re}`)
      }
    }
    expect(hits).toEqual([])
  })

  it('passing a capRoyaltyFee field to BuildArgs is a compile-time error (@ts-expect-error)', async () => {
    mockedQuoteBuy.mockResolvedValue(buyQuote(8453, true))
    const ctx = buildCtx(8453)
    // @ts-expect-error — BuildArgs has no capRoyaltyFee field; a partner cannot even
    // ATTEMPT to request the cap be applied, let alone flip it to true.
    const plan = await buildBuy(ctx, { quote: buyQuote(8453, true), recipient: RECIPIENT, capRoyaltyFee: true })
    expect(plan.steps.length).toBeGreaterThan(0)
  })
})

describe('cap-royalty-pinned — GSD_PROHIB_SUBJECT causation control (fixtures/prohib/cap-royalty-{clean,violation}.ts)', () => {
  interface CapRoyaltySubjectModule {
    readonly resolveCapRoyaltyFee: (options?: { readonly capRoyaltyFee?: boolean }) => boolean
  }

  it('the resolved subject never encodes true, even when a caller explicitly asks for it (RED on the violation fixture)', async () => {
    // No standalone real src decision function exists to import here — capRoyaltyFee
    // is pinned by INLINING the literal `false` at each encode call site (see this
    // fixture's own header comment) — so this causation control defaults to its own
    // clean reference implementation, per the descriptor's own `check_clean_fixture`.
    const subject = await resolveSubject<CapRoyaltySubjectModule>('test/fixtures/prohib/cap-royalty-clean.ts')
    expect(subject.resolveCapRoyaltyFee({ capRoyaltyFee: true })).toBe(false)
  })
})
