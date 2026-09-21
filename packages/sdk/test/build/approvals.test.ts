import type { PublicClient } from 'viem'
import { BaseError, ContractFunctionRevertedError } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { buildApprovalStep, missingApprovals } from '../../src/build/approvals'
import { estimateGasWithBuffer, fallbackGasForNFTBatch, isSimulationRevertError, resolveGasForStep } from '../../src/build/gas'
import { assemblePlan, orderSteps } from '../../src/build/plan'
import { getChain } from '../../src/chains/registry'
import type { Amount } from '../../src/types/amount.types'
import type { SnfClientContext } from '../../src/types/client.types'
import type { Approval, Bounds, Step, StepKind } from '../../src/types/plan.types'
import type { FeeBreakdown, Quote } from '../../src/types/quote.types'

const OWNER = '0x000000000000000000000000000000000000a11e' as `0x${string}`
const SPENDER = '0x0000000000000000000000000000000000b0b0b0' as `0x${string}`
const COLLECTION = '0x0000000000000000000000000000000000c011ec' as `0x${string}`
const BASE_TOKEN = '0x0000000000000000000000000000000000dead01' as `0x${string}`

type ReadResult = { readonly status: 'success' | 'failure'; readonly result?: unknown }

function buildCtx(multicallImpl: (params: { readonly contracts: readonly unknown[] }) => Promise<readonly ReadResult[]>): SnfClientContext {
  const chain = getChain(8453)
  const multicall = vi.fn(multicallImpl)
  const publicClient = { multicall } as unknown as PublicClient
  return {
    config: { chainId: chain.chainId, publicClient },
    chain,
    publicClient,
    providers: {},
    transport: {} as SnfClientContext['transport'],
    nextTxInvalidationVersion: () => 1,
  } as unknown as SnfClientContext
}

describe('missingApprovals', () => {
  it('issues ONE multicall and returns [] when both erc721 and erc20 are already sufficient', async () => {
    const ctx = buildCtx(async () => [
      { status: 'success', result: true }, // isApprovedForAll
      { status: 'success', result: 1_000n }, // allowance
    ])
    const result = await missingApprovals(ctx, {
      owner: OWNER,
      spender: SPENDER,
      erc721: { token: COLLECTION },
      erc20: { token: BASE_TOKEN, amount: 1_000n },
    })
    expect(result).toEqual([])
    expect((ctx.publicClient.multicall as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1)
  })

  it('a wallet that already granted setApprovalForAll yields an empty ERC-721 approval list', async () => {
    const ctx = buildCtx(async () => [{ status: 'success', result: true }])
    const result = await missingApprovals(ctx, { owner: OWNER, spender: SPENDER, erc721: { token: COLLECTION } })
    expect(result).toEqual([])
  })

  it('ERC-721 granted + ERC-20 allowance below required yields exactly one erc20-allowance approval', async () => {
    const ctx = buildCtx(async () => [
      { status: 'success', result: true },
      { status: 'success', result: 500n },
    ])
    const result = await missingApprovals(ctx, {
      owner: OWNER,
      spender: SPENDER,
      erc721: { token: COLLECTION },
      erc20: { token: BASE_TOKEN, amount: 1_000n },
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.kind).toBe('erc20-allowance')
  })

  it('an ERC-20 allowance exactly equal to the required amount counts as sufficient (>=, not >)', async () => {
    const ctx = buildCtx(async () => [{ status: 'success', result: 1_000n }])
    const result = await missingApprovals(ctx, { owner: OWNER, spender: SPENDER, erc20: { token: BASE_TOKEN, amount: 1_000n } })
    expect(result).toEqual([])
  })

  it('an ERC-20 allowance one below the required amount is NOT sufficient', async () => {
    const ctx = buildCtx(async () => [{ status: 'success', result: 999n }])
    const result = await missingApprovals(ctx, { owner: OWNER, spender: SPENDER, erc20: { token: BASE_TOKEN, amount: 1_000n } })
    expect(result).toHaveLength(1)
  })

  it('a failed read is treated as missing (fail-safe), not as granted', async () => {
    const ctx = buildCtx(async () => [{ status: 'failure' }])
    const result = await missingApprovals(ctx, { owner: OWNER, spender: SPENDER, erc721: { token: COLLECTION } })
    expect(result).toHaveLength(1)
    expect(result[0]?.kind).toBe('erc721-approval-for-all')
  })

  it('returns [] with no multicall at all when neither erc721 nor erc20 is requested', async () => {
    const ctx = buildCtx(async () => [])
    const result = await missingApprovals(ctx, { owner: OWNER, spender: SPENDER })
    expect(result).toEqual([])
    expect((ctx.publicClient.multicall as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled()
  })

  it('every produced Approval carries value: 0n and the chain\'s own chainId', async () => {
    const ctx = buildCtx(async () => [{ status: 'success', result: false }])
    const result = await missingApprovals(ctx, { owner: OWNER, spender: SPENDER, erc721: { token: COLLECTION } })
    const approval = result[0] as Approval
    expect(approval.tx.value).toBe(0n)
    expect(approval.tx.chainId).toBe(8453)
    expect(approval.tx.data.length).toBeGreaterThan(2)
  })
})

describe('buildApprovalStep', () => {
  function fixtureApproval(): Approval {
    return {
      kind: 'erc721-approval-for-all',
      token: COLLECTION,
      spender: SPENDER,
      tx: { to: COLLECTION, data: '0xa22cb465', value: 0n, chainId: 8453 },
      note: 'setApprovalForAll(router, true) — once per collection',
    }
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

  function fixtureBounds(): Bounds {
    return { amountInMax: 1_000n, slippageBps: 100, deadline: 1_800_000_000n }
  }

  it('produces a Step with kind: "approval", a populated tx.data, value: 0n and an explicit chainId', () => {
    const approval = fixtureApproval()
    const step = buildApprovalStep(approval, { quote: fixtureQuote(), bounds: fixtureBounds() })
    expect(step.kind).toBe('approval')
    expect(step.tx.data).toBe(approval.tx.data)
    expect(step.tx.value).toBe(0n)
    expect(step.tx.chainId).toBe(8453)
    expect(step.approvals).toEqual([approval])
  })
})

describe('orderSteps / assemblePlan — approvals before swap(s) (ordering | R13, empty | R13)', () => {
  function fixtureQuote(): Quote {
    const amount = (v: bigint): Amount => ({ value: v, formatted: v.toString(), symbol: 'ETH', decimals: 18 })
    const fees: FeeBreakdown = {
      pool: { bps: 200, note: 'included in curve' },
      marketplace: { ...amount(0n), bps: 0 },
      royalty: { ...amount(0n), bps: 0, capApplied: false },
    }
    return {
      side: 'nft-to-nft',
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
  const quote = fixtureQuote()

  function makeStep(kind: StepKind, tag: string): Step {
    return {
      kind,
      label: `placeholder-${tag}`,
      // A DIFFERENT chainId than the ctx's own — proves assemblePlan overwrites it
      // rather than inheriting whatever the raw step already said.
      tx: { to: COLLECTION, data: `0x${tag}`, value: 0n, chainId: 1 },
      approvals: [],
      bounds,
      quote,
    }
  }

  it('orderSteps stably partitions: every approval step precedes every non-approval step', () => {
    const raw = [makeStep('swap-sell', 'a'), makeStep('approval', 'b'), makeStep('swap-buy', 'c'), makeStep('swap-buy-wnft', 'd')]
    const ordered = orderSteps(raw)
    expect(ordered.map((s) => s.kind)).toEqual(['approval', 'swap-sell', 'swap-buy', 'swap-buy-wnft'])
  })

  it('assemblePlan reproduces the literal NFT×NFT four-element order end to end', () => {
    const ctx = buildCtx(async () => [])
    const raw = [makeStep('swap-sell', 'a'), makeStep('approval', 'b'), makeStep('swap-buy', 'c'), makeStep('swap-buy-wnft', 'd')]
    const plan = assemblePlan(ctx, raw, new Date().toISOString())
    expect(plan.steps.map((s) => s.kind)).toEqual(['approval', 'swap-sell', 'swap-buy', 'swap-buy-wnft'])
  })

  it('assemblePlan with nothing missing yields steps.length === 1; steps is never empty', () => {
    const ctx = buildCtx(async () => [])
    const plan = assemblePlan(ctx, [makeStep('swap-buy', 'only')], new Date().toISOString())
    expect(plan.steps).toHaveLength(1)
  })

  it('every step\'s tx.chainId is stamped from ctx.chain.chainId, not inherited from the raw step', () => {
    const ctx = buildCtx(async () => [])
    const plan = assemblePlan(ctx, [makeStep('approval', 'x'), makeStep('swap-buy', 'y')], new Date().toISOString())
    for (const step of plan.steps) {
      expect(step.tx.chainId).toBe(ctx.chain.chainId)
    }
  })

  it('attaches a callable preflight() closure that does not require the caller to hold ctx', () => {
    const ctx = buildCtx(async () => [])
    const plan = assemblePlan(ctx, [makeStep('swap-buy', 'only')], new Date().toISOString())
    expect(typeof plan.preflight).toBe('function')
  })

  it('freezes the returned plan and its steps array', () => {
    const ctx = buildCtx(async () => [])
    const plan = assemblePlan(ctx, [makeStep('swap-buy', 'only')], new Date().toISOString())
    expect(Object.isFrozen(plan)).toBe(true)
    expect(Object.isFrozen(plan.steps)).toBe(true)
  })
})

describe('gas — estimateGasWithBuffer / fallbackGasForNFTBatch / isSimulationRevertError', () => {
  it('estimateGasWithBuffer returns estimate * 125 / 100 on success', async () => {
    const estimateContractGas = vi.fn(async () => 1_000_000n)
    const publicClient = { estimateContractGas } as unknown as PublicClient
    const gas = await estimateGasWithBuffer({
      publicClient,
      address: COLLECTION,
      abi: [],
      functionName: 'mint',
      args: [],
      account: OWNER,
      tokenCount: 3,
    })
    expect(gas).toBe(1_250_000n)
  })

  it('fallbackGasForNFTBatch(3) is exactly 2_400_000n', () => {
    expect(fallbackGasForNFTBatch(3)).toBe(2_400_000n)
  })

  it('a genuine simulated revert is re-thrown, not swallowed into the fallback', async () => {
    const revertError = new BaseError('execution reverted', {
      cause: new ContractFunctionRevertedError({ abi: [], functionName: 'mint' }),
    })
    const estimateContractGas = vi.fn(async () => {
      throw revertError
    })
    const publicClient = { estimateContractGas } as unknown as PublicClient
    await expect(
      estimateGasWithBuffer({
        publicClient,
        address: COLLECTION,
        abi: [],
        functionName: 'mint',
        args: [],
        account: OWNER,
        tokenCount: 3,
      }),
    ).rejects.toThrow()
  })

  it('an RPC/network failure falls back to fallbackGasForNFTBatch for the same tokenCount', async () => {
    const estimateContractGas = vi.fn(async () => {
      throw new Error('fetch failed')
    })
    const publicClient = { estimateContractGas } as unknown as PublicClient
    const gas = await estimateGasWithBuffer({
      publicClient,
      address: COLLECTION,
      abi: [],
      functionName: 'mint',
      args: [],
      account: OWNER,
      tokenCount: 3,
    })
    expect(gas).toBe(2_400_000n)
  })

  it('isSimulationRevertError is false for a plain Error and for a non-revert BaseError', () => {
    expect(isSimulationRevertError(new Error('boom'))).toBe(false)
    expect(isSimulationRevertError(new BaseError('network down'))).toBe(false)
  })
})

describe('gas — resolveGasForStep (Finding 2, snf-54-18F: gas estimation must not be attempted live while an approval is still pending)', () => {
  it('hasPendingApproval: true never calls estimateContractGas at all — even one that WOULD revert live — and returns the fallback marked gasSource', async () => {
    const revertError = new BaseError('execution reverted', {
      cause: new ContractFunctionRevertedError({ abi: [], functionName: 'swap' }),
    })
    const estimateContractGas = vi.fn(async () => {
      throw revertError
    })
    const publicClient = { estimateContractGas } as unknown as PublicClient
    const result = await resolveGasForStep({
      publicClient,
      address: COLLECTION,
      abi: [],
      functionName: 'swap',
      args: [],
      account: OWNER,
      tokenCount: 3,
      hasPendingApproval: true,
    })
    expect(estimateContractGas).not.toHaveBeenCalled()
    expect(result.gas).toBe(fallbackGasForNFTBatch(3))
    expect(result.gasSource).toBe('fallback-pending-approval')
  })

  it('hasPendingApproval: false behaves byte-for-byte like estimateGasWithBuffer — live estimate on success, no gasSource marker', async () => {
    const estimateContractGas = vi.fn(async () => 1_000_000n)
    const publicClient = { estimateContractGas } as unknown as PublicClient
    const result = await resolveGasForStep({
      publicClient,
      address: COLLECTION,
      abi: [],
      functionName: 'swap',
      args: [],
      account: OWNER,
      tokenCount: 3,
      hasPendingApproval: false,
    })
    expect(estimateContractGas).toHaveBeenCalledTimes(1)
    expect(result.gas).toBe(1_250_000n)
    expect(result.gasSource).toBeUndefined()
  })

  it('hasPendingApproval: false still RE-THROWS a genuine simulated revert (unaffected by this fix — a revert for a DIFFERENT reason than the missing approval)', async () => {
    const revertError = new BaseError('execution reverted', {
      cause: new ContractFunctionRevertedError({ abi: [], functionName: 'swap' }),
    })
    const estimateContractGas = vi.fn(async () => {
      throw revertError
    })
    const publicClient = { estimateContractGas } as unknown as PublicClient
    await expect(
      resolveGasForStep({
        publicClient,
        address: COLLECTION,
        abi: [],
        functionName: 'swap',
        args: [],
        account: OWNER,
        tokenCount: 3,
        hasPendingApproval: false,
      }),
    ).rejects.toThrow()
  })
})
