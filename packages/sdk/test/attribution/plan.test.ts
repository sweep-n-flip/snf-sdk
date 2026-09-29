import type { PublicClient } from 'viem'
import { concat } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { encodeAttribution, parseAttribution } from '../../src/attribution'
import { resolveGasForStep } from '../../src/build/gas'
import { assemblePlan } from '../../src/build/plan'
import { getChain } from '../../src/chains/registry'
import { createSnfClient } from '../../src/client'
import { isSnfError } from '../../src/errors'
import type { Amount } from '../../src/types/amount.types'
import type { AttributionConfig } from '../../src/types/attribution.types'
import type { SnfClientConfig, SnfClientContext } from '../../src/types/client.types'
import type { Bounds, Step, StepKind } from '../../src/types/plan.types'
import type { FeeBreakdown, Quote } from '../../src/types/quote.types'

/**
 * The build pipeline's attribution choke point (`assemblePlan`) and the config
 * validation in front of it: SnF-contract steps carry `sdk` / `sdk-<code>`, approvals
 * never do, and a bad code fails at `createSnfClient`.
 */

const CHAIN = getChain(8453)
const TOKEN = '0x0000000000000000000000000000000000c011ec' as `0x${string}`
const SWAP_DATA = '0x7ff36ab50000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`
const APPROVE_DATA = '0xa22cb4650000000000000000000000000000000000000000000000000000000000000001' as `0x${string}`

function ctxWith(attribution?: SnfClientConfig['attribution']): SnfClientContext {
  const publicClient = { multicall: vi.fn() } as unknown as PublicClient
  return {
    config: { chainId: CHAIN.chainId, publicClient, ...(attribution !== undefined ? { attribution } : {}) },
    chain: CHAIN,
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
    deliverable: 1,
    bestEffort: false,
    expiresAt: new Date().toISOString(),
    reconciled: true,
  }
}

const bounds: Bounds = { amountOutMin: 1n, slippageBps: 100, deadline: 1_800_000_000n }

function makeStep(kind: StepKind, to: `0x${string}`, data: `0x${string}`): Step {
  return { kind, label: '', tx: { to, data, value: 0n, chainId: CHAIN.chainId }, approvals: [], bounds, quote: fixtureQuote() }
}

function plan(attribution?: SnfClientConfig['attribution']) {
  return assemblePlan(
    ctxWith(attribution),
    [makeStep('approval', TOKEN, APPROVE_DATA), makeStep('swap-buy', CHAIN.router02, SWAP_DATA)],
    new Date().toISOString(),
  )
}

describe('assemblePlan — attribution', () => {
  it('tags a Router step with "sdk-acme": tx.data is exactly the original calldata followed by the suffix', () => {
    const swap = plan({ code: 'acme' }).steps.find((s) => s.kind === 'swap-buy')!
    expect(swap.tx.data).toBe(concat([SWAP_DATA, encodeAttribution(['sdk-acme'])]))
    expect(parseAttribution(swap.tx.data)).toEqual(['sdk-acme'])
  })

  it('tags with the bare channel "sdk" when no partner code is configured', () => {
    for (const attribution of [undefined, {}, { code: undefined }]) {
      const swap = plan(attribution).steps.find((s) => s.kind === 'swap-buy')!
      expect(swap.tx.data).toBe(concat([SWAP_DATA, encodeAttribution(['sdk'])]))
      expect(parseAttribution(swap.tx.data)).toEqual(['sdk'])
    }
  })

  it('leaves an approval step byte-for-byte untagged', () => {
    const approval = plan({ code: 'acme' }).steps.find((s) => s.kind === 'approval')!
    expect(approval.tx.data).toBe(APPROVE_DATA)
    expect(parseAttribution(approval.tx.data)).toBeNull()
  })

  it('tags the Factory too, is case-insensitive on the target, and never tags a non-SnF target', () => {
    const ctx = ctxWith({ code: 'acme' })
    const steps = [
      makeStep('swap-fungible', CHAIN.factory, SWAP_DATA),
      makeStep('swap-buy', CHAIN.router02.toLowerCase() as `0x${string}`, SWAP_DATA),
      makeStep('swap-sell', TOKEN, SWAP_DATA),
    ]
    const [factoryStep, lowerRouterStep, foreignStep] = assemblePlan(ctx, steps, new Date().toISOString()).steps
    expect(parseAttribution(factoryStep!.tx.data)).toEqual(['sdk-acme'])
    expect(parseAttribution(lowerRouterStep!.tx.data)).toEqual(['sdk-acme'])
    expect(foreignStep!.tx.data).toBe(SWAP_DATA)
  })

  it('is best effort: an unvalidated bad code in a hand-built context sends the step untagged, never throws', () => {
    const built = assemblePlan(
      ctxWith({ code: 'NOT VALID' }),
      [makeStep('swap-buy', CHAIN.router02, SWAP_DATA)],
      new Date().toISOString(),
    )
    expect(built.steps[0]!.tx.data).toBe(SWAP_DATA)
  })

  it('keeps chainId stamping and freezing intact on tagged steps', () => {
    const built = plan({ code: 'acme' })
    for (const step of built.steps) {
      expect(step.tx.chainId).toBe(CHAIN.chainId)
      expect(Object.isFrozen(step.tx)).toBe(true)
    }
  })
})

describe('gas estimation runs on the suffixed calldata', () => {
  it('forwards dataSuffix to estimateContractGas', async () => {
    const estimateContractGas = vi.fn(async () => 100_000n)
    const suffix = encodeAttribution(['sdk-acme'])
    await resolveGasForStep({
      publicClient: { estimateContractGas } as unknown as PublicClient,
      address: CHAIN.router02,
      abi: [],
      functionName: 'noop',
      args: [],
      account: TOKEN,
      tokenCount: 1,
      hasPendingApproval: false,
      dataSuffix: suffix,
    })
    expect(estimateContractGas).toHaveBeenCalledTimes(1)
    expect(estimateContractGas.mock.calls[0]).toEqual([expect.objectContaining({ dataSuffix: suffix })])
  })
})

describe('createSnfClient — attribution config', () => {
  const publicClient = { readContract: vi.fn(), multicall: vi.fn() } as unknown as PublicClient

  it('accepts no attribution, an empty object, a partner code and an already-prefixed code', () => {
    expect(() => createSnfClient({ chainId: 8453, publicClient })).not.toThrow()
    expect(() => createSnfClient({ chainId: 8453, publicClient, attribution: {} })).not.toThrow()
    expect(() => createSnfClient({ chainId: 8453, publicClient, attribution: { code: 'acme' } })).not.toThrow()
    expect(() => createSnfClient({ chainId: 8453, publicClient, attribution: { code: 'sdk-acme' } })).not.toThrow()
  })

  it.each([['Acme'], ['snf'], ['snf-app'], ['sdk'], ['a'], ['a'.repeat(29)], ['acme,other']])(
    'throws INVALID_PARAMS at construction for code %s',
    (code) => {
      try {
        createSnfClient({ chainId: 8453, publicClient, attribution: { code } })
      } catch (e) {
        expect(isSnfError(e) && e.code).toBe('INVALID_PARAMS')
        return
      }
      throw new Error('expected createSnfClient to throw')
    },
  )

  it('throws INVALID_PARAMS when attribution is not an object', () => {
    expect(() =>
      createSnfClient({ chainId: 8453, publicClient, attribution: 'acme' as unknown as AttributionConfig }),
    ).toThrow(expect.objectContaining({ code: 'INVALID_PARAMS' }))
  })
})
