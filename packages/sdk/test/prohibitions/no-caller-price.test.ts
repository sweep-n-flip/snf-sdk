import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { decodeFunctionData } from 'viem'
import type { PublicClient } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../src/quote/quoteBuy', () => ({ quoteBuy: vi.fn() }))
vi.mock('../../src/quote/quoteSell', () => ({ quoteSell: vi.fn() }))
vi.mock('../../src/quote/quoteNftToNft', () => ({ quoteNftToNft: vi.fn() }))

import { buildBuy } from '../../src/build/buildBuy'
import { deriveBounds } from '../../src/build/bounds'
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
 * SPEC prohibition #2: the SDK MUST NOT use caller-supplied prices to
 * derive `bounds`/`value`/`amountOutMin` — `build()` always re-quotes on-chain
 * itself. This is the STANDING gate: it survives independently of any one builder's
 * own test file (this module's `test/build/{buildBuy,buildSell,buildNftToNft}.test.ts`
 * each proved this per-builder already; this file generalises the same invariant into
 * one place with a provable failure mode — a causation-controlled `SNF_SDK_PROHIB_SUBJECT`
 * run against a deliberately-tampering implementation, not just an assertion that
 * happens to currently pass).
 *
 * `check_target`: packages/sdk/test/prohibitions/no-caller-price.test.ts
 * `check_violation_fixture`: test/fixtures/prohib/caller-price-violation.ts
 * `check_clean_fixture`: test/fixtures/prohib/caller-price-clean.ts
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

function amount(value: bigint, decimals = 18, symbol = 'ETH'): Amount {
  return { value, formatted: value.toString(), symbol, decimals }
}

function fixtureFees(royalty = 0n): FeeBreakdown {
  return {
    pool: { bps: 200, note: 'included in curve' },
    marketplace: { ...amount(0n), bps: 0 },
    royalty: { ...amount(royalty), bps: royalty > 0n ? 10 : 0, capApplied: false },
  }
}

type ReadResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

function buildCtx(opts: { readonly chainId?: number } = {}): SnfClientContext {
  const chain = getChain(opts.chainId ?? 8453)
  const multicall = vi.fn(async (): Promise<readonly ReadResult[]> => [])
  const estimateContractGas = vi.fn(async () => 1_000_000n)
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

// ── buildBuy / buildSell fixtures ──────────────────────────────────────────────

function buyQuote(totalCost: bigint): Quote {
  const chainId: SnfChainId = 8453
  const tokenIds = ['1', '2']
  const leg: QuoteLeg = {
    pair: PAIR,
    count: tokenIds.length,
    amount: amount(1000n),
    path: [getChain(chainId).quoteToken, COLLECTION],
    feeBps: 200,
    kind: 'native',
    side: 'buy',
    collection: COLLECTION,
    wrapper: WRAPPER,
    tokenIds,
  }
  return {
    side: 'buy',
    chainId,
    collection: COLLECTION,
    count: tokenIds.length,
    tokenIds,
    legs: [leg],
    fees: fixtureFees(),
    totalCost: amount(totalCost),
    priceImpact: 0,
    deliverable: tokenIds.length,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    reconciled: true,
  }
}

function sellQuote(totalProceeds: bigint): Quote {
  const chainId: SnfChainId = 8453
  const tokenIds = ['1', '2']
  const leg: QuoteLeg = {
    pair: PAIR,
    count: tokenIds.length,
    amount: amount(1000n),
    path: [COLLECTION, getChain(chainId).quoteToken],
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
    count: tokenIds.length,
    tokenIds,
    legs: [leg],
    fees: fixtureFees(),
    totalProceeds: amount(totalProceeds),
    priceImpact: 0,
    deliverable: tokenIds.length,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    reconciled: true,
  }
}

function nftToNftQuote(netProceeds: bigint, buyCost: bigint): Quote {
  const chainId: SnfChainId = 8453
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
    amount: amount(netProceeds),
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
    amount: amount(buyCost),
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
    netProceeds: amount(netProceeds),
    buyCost: amount(buyCost),
    remainder: amount(netProceeds > buyCost ? netProceeds - buyCost : 0n),
    remainderMode: 'native',
    priceImpact: 0,
    deliverable: 1,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    reconciled: true,
  }
}

// A fixed, in-range deadline shared by the paired builds. Without it each build()
// defaults `deadline` to "now + 1200 s" read at call time, so a wall-clock second
// boundary between the two calls changes the encoded deadline and makes the
// byte-identical assertions flaky (caught by the post-merge gate).
const FIXED_DEADLINE = Math.floor(Date.now() / 1000) + 600

function buildArgs(quote: Quote): BuildArgs {
  return { quote, recipient: RECIPIENT, deadline: FIXED_DEADLINE }
}

beforeEach(() => {
  mockedQuoteBuy.mockReset()
  mockedQuoteSell.mockReset()
  mockedQuoteNftToNft.mockReset()
})

describe('no-caller-price — buildBuy/buildSell/buildNftToNft ignore a tampered caller Quote (SPEC prohibition #2)', () => {
  it('buildBuy: doubled totalCost + zeroed royalty produces byte-identical bounds/tx to the untampered quote', async () => {
    mockedQuoteBuy.mockResolvedValue(buyQuote(500_000n))
    const ctx = buildCtx()
    const real = buyQuote(500_000n)
    const tampered: Quote = { ...real, totalCost: amount(real.totalCost!.value * 2n), fees: fixtureFees(0n) }

    const planA = await buildBuy(ctx, buildArgs(real))
    const planB = await buildBuy(ctx, buildArgs(tampered))
    const stepA = planA.steps[planA.steps.length - 1]
    const stepB = planB.steps[planB.steps.length - 1]
    expect(stepB?.bounds).toEqual(stepA?.bounds)
    expect(stepB?.tx.value).toBe(stepA?.tx.value)
    expect(stepB?.tx.data).toBe(stepA?.tx.data)
  })

  it('buildSell: doubled totalProceeds produces byte-identical bounds/tx to the untampered quote', async () => {
    mockedQuoteSell.mockResolvedValue(sellQuote(400_000n))
    const ctx = buildCtx()
    const real = sellQuote(400_000n)
    const tampered: Quote = { ...real, totalProceeds: amount(real.totalProceeds!.value * 2n) }

    const planA = await buildSell(ctx, buildArgs(real))
    const planB = await buildSell(ctx, buildArgs(tampered))
    const stepA = planA.steps[planA.steps.length - 1]
    const stepB = planB.steps[planB.steps.length - 1]
    expect(stepB?.bounds).toEqual(stepA?.bounds)
    expect(stepB?.tx.data).toBe(stepA?.tx.data)
  })

  it('buildNftToNft: doubled netProceeds/buyCost produces byte-identical bounds/tx on BOTH legs', async () => {
    mockedQuoteNftToNft.mockResolvedValue(nftToNftQuote(1_000_000n, 900_000n))
    const ctx = buildCtx()
    const real = nftToNftQuote(1_000_000n, 900_000n)
    const tampered: Quote = {
      ...real,
      netProceeds: amount(real.netProceeds!.value * 2n),
      buyCost: amount(real.buyCost!.value * 2n),
    }

    const planA = await buildNftToNft(ctx, buildArgs(real))
    const planB = await buildNftToNft(ctx, buildArgs(tampered))
    expect(planB.steps.length).toBe(planA.steps.length)
    for (let i = 0; i < planA.steps.length; i++) {
      expect(planB.steps[i]?.bounds).toEqual(planA.steps[i]?.bounds)
      expect(planB.steps[i]?.tx.data).toBe(planA.steps[i]?.tx.data)
      expect(planB.steps[i]?.tx.value).toBe(planA.steps[i]?.tx.value)
    }
  })
})

describe('no-caller-price — deriveBounds is structurally incapable of accepting a Quote', () => {
  it('deriveBounds has arity 1 (a single args object, never a second "caller quote" parameter)', () => {
    expect(deriveBounds.length).toBe(1)
  })

  it('a DeriveBoundsArgs object with an extra "quote" field is a compile-time error (@ts-expect-error)', () => {
    const total = 1_000n
    // @ts-expect-error — DeriveBoundsArgs has no `quote` field; this is the excess-
    // property check TypeScript performs on an object LITERAL argument, proving the
    // real function's own type makes a caller-supplied Quote unpassable, not merely
    // unused-by-convention.
    const bounds = deriveBounds({ side: 'buy', total, slippageBps: 100, deadline: 1n, quote: { totalCost: { value: 999n } } })
    expect(bounds.amountInMax).toBeDefined()
  })
})

describe('no-caller-price — SNF_SDK_PROHIB_SUBJECT causation control (fixtures/prohib/caller-price-{clean,violation}.ts)', () => {
  interface CallerPriceSubjectModule {
    readonly deriveBounds: (args: {
      readonly side: 'buy' | 'sell'
      readonly total: bigint
      readonly slippageBps: number
      readonly deadline: bigint
      readonly callerQuote?: { readonly totalCost?: { readonly value: bigint } }
    }) => { readonly amountInMax?: bigint; readonly amountOutMin?: bigint; readonly slippageBps: number; readonly deadline: bigint }
  }

  it('the resolved subject ignores a tampered callerQuote and uses only the fresh total (RED on the violation fixture)', async () => {
    const subject = await resolveSubject<CallerPriceSubjectModule>('src/build/bounds.ts')
    const FRESH_TOTAL = 500_000n
    const withoutCallerQuote = subject.deriveBounds({ side: 'buy', total: FRESH_TOTAL, slippageBps: 100, deadline: 999n })
    const withTamperedCallerQuote = subject.deriveBounds({
      side: 'buy',
      total: FRESH_TOTAL,
      slippageBps: 100,
      deadline: 999n,
      callerQuote: { totalCost: { value: 999_999_999n } },
    })
    // Against the real module (default) and the clean fixture, an attached
    // callerQuote changes NOTHING. Against the violation fixture, it changes
    // everything — this single `toEqual` is the discriminator.
    expect(withTamperedCallerQuote).toEqual(withoutCallerQuote)
  })
})

describe('no-caller-price — fixtures are never reachable from production code', () => {
  it('grep -rn "fixtures/prohib" packages/sdk/src returns nothing', () => {
    const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src')
    const hits: string[] = []
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) walk(full)
        else if (entry.isFile() && existsSync(full)) {
          const content = readFileSync(full, 'utf8')
          if (content.includes('fixtures/prohib')) hits.push(full)
        }
      }
    }
    walk(srcDir)
    expect(hits).toEqual([])
  })
})
