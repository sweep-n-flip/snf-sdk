import type { Abi, PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { runPreflight } from '../../src/build/preflight'
import { getChain } from '../../src/chains/registry'
import { isSnfError, SnfError } from '../../src/errors'
import type { Amount } from '../../src/types/amount.types'
import type { SnfClientContext } from '../../src/types/client.types'
import type { ExecutionPlan, Step, StepPreflightRefs } from '../../src/types/plan.types'
import type { FeeBreakdown, Quote } from '../../src/types/quote.types'

const PAYER = '0x000000000000000000000000000000000000a11e' as `0x${string}`
const PAIR = '0x0000000000000000000000000000000000ba12a1' as `0x${string}`
const COLLECTION = '0x0000000000000000000000000000000000c011ec' as `0x${string}`
const WRAPPER = '0x00000000000000000000000000000000000fa99e' as `0x${string}`
const ERC20_BASE = '0x0000000000000000000000000000000000e5c020' as `0x${string}`
const BLOCK = 12_345_678n

type Call = { readonly address: `0x${string}`; readonly abi: Abi; readonly functionName: string; readonly args: readonly unknown[] }
type CallResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

interface Answers {
  readonly wrapperCollection?: Record<string, string | undefined>
  readonly owners?: Record<string, string | undefined>
  readonly erc20Balance?: bigint
}

function buildMulticall(answers: Answers, calls: { readonly contracts: readonly Call[]; readonly blockNumber: bigint }[]) {
  return vi.fn(
    async (params: { readonly contracts: readonly Call[]; readonly blockNumber: bigint }): Promise<readonly CallResult[]> => {
      calls.push(params)
      return params.contracts.map((c): CallResult => {
        if (c.functionName === 'collection') {
          const result = answers.wrapperCollection?.[c.address.toLowerCase()]
          return result !== undefined ? { status: 'success', result } : { status: 'failure' }
        }
        if (c.functionName === 'ownerOf') {
          const id = String(c.args[0])
          const result = answers.owners?.[id]
          return result !== undefined ? { status: 'success', result } : { status: 'failure' }
        }
        if (c.functionName === 'balanceOf') {
          return answers.erc20Balance !== undefined ? { status: 'success', result: answers.erc20Balance } : { status: 'failure' }
        }
        return { status: 'failure' }
      })
    },
  )
}

function buildCtx(opts: {
  readonly answers: Answers
  readonly walletChainId?: number
  readonly nativeBalance?: bigint
  readonly calls: { readonly contracts: readonly Call[]; readonly blockNumber: bigint }[]
}): SnfClientContext {
  const chain = getChain(8453)
  const multicall = buildMulticall(opts.answers, opts.calls)
  const getBlockNumber = vi.fn(async () => BLOCK)
  const getBalance = vi.fn(async () => opts.nativeBalance ?? 10n ** 18n)
  const publicClient = {
    multicall,
    getBlockNumber,
    getBalance,
    chain: opts.walletChainId !== undefined ? { id: opts.walletChainId } : undefined,
  } as unknown as PublicClient
  return {
    config: { chainId: chain.chainId, publicClient },
    chain,
    publicClient,
    providers: {},
    transport: {} as SnfClientContext['transport'],
    nextTxInvalidationVersion: () => 1,
  } as unknown as SnfClientContext
}

function fixtureQuote(): Quote {
  const amount = (v: bigint): Amount => ({ value: v, formatted: v.toString(), symbol: 'ETH', decimals: 18 })
  const fees: FeeBreakdown = {
    pool: { bps: 200, note: 'included in curve' },
    marketplace: { ...amount(0n), bps: 0 },
    royalty: { ...amount(0n), bps: 0, capApplied: false },
  }
  return {
    side: 'buy',
    chainId: 8453,
    legs: [],
    fees,
    priceImpact: 0,
    deliverable: 2,
    bestEffort: false,
    expiresAt: new Date().toISOString(),
    reconciled: true,
  }
}

function buildStep(opts: {
  readonly value?: bigint
  readonly refs?: StepPreflightRefs
  readonly amountInMax?: bigint
}): Step {
  return {
    kind: 'swap-buy',
    label: 'Confirm purchase',
    tx: { to: PAIR, data: '0xdeadbeef', value: opts.value ?? 0n, chainId: 8453 },
    approvals: [],
    bounds: { slippageBps: 100, deadline: 1_800_000_000n, ...(opts.amountInMax !== undefined ? { amountInMax: opts.amountInMax } : {}) },
    quote: fixtureQuote(),
    ...(opts.refs !== undefined ? { preflightRefs: opts.refs } : {}),
  }
}

function buildPlan(steps: readonly Step[]): ExecutionPlan {
  const plan: ExecutionPlan = {
    chainId: 8453,
    steps,
    expiresAt: new Date().toISOString(),
    // Every test below calls `runPreflight(ctx, plan)` directly rather than through
    // this closure — `ExecutionPlan.preflight` is a required field, so this fixture
    // still needs SOME value here, one that loudly fails if it is ever accidentally
    // invoked instead of the explicit call the tests actually make.
    preflight: () => {
      throw new Error('fixture preflight() should not be called directly — call runPreflight(ctx, plan)')
    },
  }
  return plan
}

function buyRefs(overrides: Partial<StepPreflightRefs> = {}): StepPreflightRefs {
  return { payer: PAYER, collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, buyTokenIds: ['1', '2'], ...overrides }
}

function sellRefs(overrides: Partial<StepPreflightRefs> = {}): StepPreflightRefs {
  return { payer: PAYER, collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, sellTokenIds: ['7'], ...overrides }
}

describe('runPreflight — one Multicall3, one block (concurrency | R14)', () => {
  it('issues exactly ONE multicall with batchSize: 0 and an explicit numeric blockNumber', async () => {
    const calls: { readonly contracts: readonly Call[]; readonly blockNumber: bigint }[] = []
    const ctx = buildCtx({
      answers: { wrapperCollection: { [WRAPPER.toLowerCase()]: COLLECTION }, owners: { '1': PAIR, '2': PAIR } },
      calls,
    })
    const plan = buildPlan([buildStep({ refs: buyRefs() })])
    const result = await runPreflight(ctx, plan)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.blockNumber).toBe(BLOCK)
    expect(result.blockNumber).toBe(BLOCK)
    expect((ctx.publicClient.multicall as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.batchSize).toBe(0)
  })
})

describe('runPreflight — ownership (sell/buy)', () => {
  it('a sell step checks ownerOf(id) === payer', async () => {
    const calls: { readonly contracts: readonly Call[]; readonly blockNumber: bigint }[] = []
    const ctx = buildCtx({
      answers: { wrapperCollection: { [WRAPPER.toLowerCase()]: COLLECTION }, owners: { '7': PAYER } },
      calls,
    })
    const plan = buildPlan([buildStep({ refs: sellRefs() })])
    const result = await runPreflight(ctx, plan)
    expect(result.ok).toBe(true)
  })

  it('a buy step checks ownerOf(id) === pair', async () => {
    const calls: { readonly contracts: readonly Call[]; readonly blockNumber: bigint }[] = []
    const ctx = buildCtx({
      answers: { wrapperCollection: { [WRAPPER.toLowerCase()]: COLLECTION }, owners: { '1': PAIR, '2': PAIR } },
      calls,
    })
    const plan = buildPlan([buildStep({ refs: buyRefs() })])
    const result = await runPreflight(ctx, plan)
    expect(result.ok).toBe(true)
  })

  it('an id moved out of the pool yields TOKENIDS_UNAVAILABLE with the offending ids, ALL collected', async () => {
    const calls: { readonly contracts: readonly Call[]; readonly blockNumber: bigint }[] = []
    const ctx = buildCtx({
      answers: {
        wrapperCollection: { [WRAPPER.toLowerCase()]: COLLECTION },
        owners: { '1': '0x000000000000000000000000000000000000beef', '2': PAIR },
      },
      calls,
    })
    const plan = buildPlan([buildStep({ refs: buyRefs() })])
    let threw: unknown
    try {
      await runPreflight(ctx, plan)
    } catch (e) {
      threw = e
    }
    expect(isSnfError(threw)).toBe(true)
    expect((threw as SnfError).code).toBe('TOKENIDS_UNAVAILABLE')
    expect((threw as SnfError).details?.tokenIds).toEqual(['1'])
  })
})

describe('runPreflight — wrapper identity', () => {
  it('WERC721.collection() === collection passes silently', async () => {
    const calls: { readonly contracts: readonly Call[]; readonly blockNumber: bigint }[] = []
    const ctx = buildCtx({
      answers: { wrapperCollection: { [WRAPPER.toLowerCase()]: COLLECTION }, owners: { '1': PAIR, '2': PAIR } },
      calls,
    })
    const result = await runPreflight(ctx, buildPlan([buildStep({ refs: buyRefs() })]))
    expect(result.checked).toContain('wrapper-identity')
  })

  it('a wrapper whose collection() disagrees yields WRAPPER_UNVERIFIED', async () => {
    const calls: { readonly contracts: readonly Call[]; readonly blockNumber: bigint }[] = []
    const ctx = buildCtx({
      answers: { wrapperCollection: { [WRAPPER.toLowerCase()]: '0x000000000000000000000000000000000000bad0' }, owners: { '1': PAIR, '2': PAIR } },
      calls,
    })
    let threw: unknown
    try {
      await runPreflight(ctx, buildPlan([buildStep({ refs: buyRefs() })]))
    } catch (e) {
      threw = e
    }
    expect(isSnfError(threw)).toBe(true)
    expect((threw as SnfError).code).toBe('WRAPPER_UNVERIFIED')
  })
})

describe('runPreflight — balance', () => {
  it('checks the payer native balance >= the plan\'s total tx.value', async () => {
    const calls: { readonly contracts: readonly Call[]; readonly blockNumber: bigint }[] = []
    const ctx = buildCtx({
      answers: { wrapperCollection: { [WRAPPER.toLowerCase()]: COLLECTION }, owners: { '1': PAIR, '2': PAIR } },
      nativeBalance: 100n,
      calls,
    })
    const plan = buildPlan([buildStep({ refs: buyRefs(), value: 50n })])
    const result = await runPreflight(ctx, plan)
    expect(result.ok).toBe(true)
  })

  it('insufficient native balance yields INVALID_PARAMS with details.required/available', async () => {
    const calls: { readonly contracts: readonly Call[]; readonly blockNumber: bigint }[] = []
    const ctx = buildCtx({
      answers: { wrapperCollection: { [WRAPPER.toLowerCase()]: COLLECTION }, owners: { '1': PAIR, '2': PAIR } },
      nativeBalance: 10n,
      calls,
    })
    const plan = buildPlan([buildStep({ refs: buyRefs(), value: 500n })])
    let threw: unknown
    try {
      await runPreflight(ctx, plan)
    } catch (e) {
      threw = e
    }
    expect(isSnfError(threw)).toBe(true)
    expect((threw as SnfError).code).toBe('INVALID_PARAMS')
    expect((threw as SnfError).details?.required).toBe(500n)
    expect((threw as SnfError).details?.available).toBe(10n)
  })

  it('an ERC-20-base plan checks ERC20.balanceOf(payer) >= amountInMax', async () => {
    const calls: { readonly contracts: readonly Call[]; readonly blockNumber: bigint }[] = []
    const ctx = buildCtx({
      answers: { wrapperCollection: { [WRAPPER.toLowerCase()]: COLLECTION }, owners: { '1': PAIR, '2': PAIR }, erc20Balance: 1_000n },
      calls,
    })
    const plan = buildPlan([buildStep({ refs: buyRefs({ erc20Base: ERC20_BASE }), amountInMax: 1_000n })])
    const result = await runPreflight(ctx, plan)
    expect(result.ok).toBe(true)
  })

  it('an insufficient ERC-20 balance yields INVALID_PARAMS', async () => {
    const calls: { readonly contracts: readonly Call[]; readonly blockNumber: bigint }[] = []
    const ctx = buildCtx({
      answers: { wrapperCollection: { [WRAPPER.toLowerCase()]: COLLECTION }, owners: { '1': PAIR, '2': PAIR }, erc20Balance: 500n },
      calls,
    })
    const plan = buildPlan([buildStep({ refs: buyRefs({ erc20Base: ERC20_BASE }), amountInMax: 1_000n })])
    let threw: unknown
    try {
      await runPreflight(ctx, plan)
    } catch (e) {
      threw = e
    }
    expect(isSnfError(threw)).toBe(true)
    expect((threw as SnfError).code).toBe('INVALID_PARAMS')
    expect((threw as SnfError).details?.token).toBe(ERC20_BASE)
  })
})

describe('runPreflight — chain', () => {
  it('a wallet client configured for another chain yields WRONG_CHAIN with both chain ids', async () => {
    const calls: { readonly contracts: readonly Call[]; readonly blockNumber: bigint }[] = []
    const ctx = buildCtx({
      answers: {},
      walletChainId: 42161,
      calls,
    })
    const plan = buildPlan([buildStep({ refs: buyRefs() })])
    let threw: unknown
    try {
      await runPreflight(ctx, plan)
    } catch (e) {
      threw = e
    }
    expect(isSnfError(threw)).toBe(true)
    expect((threw as SnfError).code).toBe('WRONG_CHAIN')
    expect((threw as SnfError).details?.expected).toBe(8453)
    expect((threw as SnfError).details?.actual).toBe(42161)
    // WRONG_CHAIN is checked before any on-chain read — no multicall at all.
    expect(calls).toHaveLength(0)
  })
})

describe('runPreflight — deterministic precedence (WRONG_CHAIN > WRAPPER_UNVERIFIED > TOKENIDS_UNAVAILABLE > balance)', () => {
  it('a plan broken in two ways (wrong chain AND bad wrapper) always yields WRONG_CHAIN', async () => {
    const calls: { readonly contracts: readonly Call[]; readonly blockNumber: bigint }[] = []
    const ctx = buildCtx({
      answers: { wrapperCollection: { [WRAPPER.toLowerCase()]: '0x000000000000000000000000000000000000bad0' } },
      walletChainId: 42161,
      calls,
    })
    let threw: unknown
    try {
      await runPreflight(ctx, buildPlan([buildStep({ refs: buyRefs() })]))
    } catch (e) {
      threw = e
    }
    expect((threw as SnfError).code).toBe('WRONG_CHAIN')
  })

  it('a plan broken two ways (bad wrapper AND moved id) always yields WRAPPER_UNVERIFIED', async () => {
    const calls: { readonly contracts: readonly Call[]; readonly blockNumber: bigint }[] = []
    const ctx = buildCtx({
      answers: {
        wrapperCollection: { [WRAPPER.toLowerCase()]: '0x000000000000000000000000000000000000bad0' },
        owners: { '1': '0x000000000000000000000000000000000000beef', '2': PAIR },
      },
      calls,
    })
    let threw: unknown
    try {
      await runPreflight(ctx, buildPlan([buildStep({ refs: buyRefs() })]))
    } catch (e) {
      threw = e
    }
    expect((threw as SnfError).code).toBe('WRAPPER_UNVERIFIED')
  })

  it('a plan broken two ways (moved id AND insufficient balance) always yields TOKENIDS_UNAVAILABLE', async () => {
    const calls: { readonly contracts: readonly Call[]; readonly blockNumber: bigint }[] = []
    const ctx = buildCtx({
      answers: {
        wrapperCollection: { [WRAPPER.toLowerCase()]: COLLECTION },
        owners: { '1': '0x000000000000000000000000000000000000beef', '2': PAIR },
      },
      nativeBalance: 0n,
      calls,
    })
    let threw: unknown
    try {
      await runPreflight(ctx, buildPlan([buildStep({ refs: buyRefs(), value: 500n })]))
    } catch (e) {
      threw = e
    }
    expect((threw as SnfError).code).toBe('TOKENIDS_UNAVAILABLE')
  })
})

describe('runPreflight — idempotency (idempotency | R14)', () => {
  it('two consecutive calls return deeply-equal results, two independent multicalls, and the plan is never mutated', async () => {
    const calls: { readonly contracts: readonly Call[]; readonly blockNumber: bigint }[] = []
    const ctx = buildCtx({
      answers: { wrapperCollection: { [WRAPPER.toLowerCase()]: COLLECTION }, owners: { '1': PAIR, '2': PAIR } },
      calls,
    })
    const plan = buildPlan([buildStep({ refs: buyRefs() })])
    const before = structuredClone({ chainId: plan.chainId, steps: plan.steps, expiresAt: plan.expiresAt })

    const first = await runPreflight(ctx, plan)
    const second = await runPreflight(ctx, plan)

    expect(first).toEqual(second)
    expect(calls).toHaveLength(2)
    expect({ chainId: plan.chainId, steps: plan.steps, expiresAt: plan.expiresAt }).toEqual(before)
  })
})

describe('runPreflight — never emits a step, never signs', () => {
  it('the resolved PreflightResult never contains a tx/step-shaped field', async () => {
    const calls: { readonly contracts: readonly Call[]; readonly blockNumber: bigint }[] = []
    const ctx = buildCtx({
      answers: { wrapperCollection: { [WRAPPER.toLowerCase()]: COLLECTION }, owners: { '1': PAIR, '2': PAIR } },
      calls,
    })
    const result = await runPreflight(ctx, buildPlan([buildStep({ refs: buyRefs() })]))
    expect(result).not.toHaveProperty('tx')
    expect(result).not.toHaveProperty('step')
    expect(result.ok).toBe(true)
  })
})
