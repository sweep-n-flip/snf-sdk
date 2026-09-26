import { decodeFunctionData, getAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import { buildSeed } from '../../src/build/buildSeed'
import { PAIR_CREATION_GAS, WRAPPER_CREATION_GAS, fallbackGasForNFTBatch } from '../../src/build/gas'
import { MAX_SEED_TOKEN_IDS, MAX_TOKEN_IDS, MIN_NEW_POOL_NFTS } from '../../src/build/validate'
import { ERC20_ABI } from '../../src/abis/ERC20'
import { ROUTER02_COLLECTION_ABI } from '../../src/abis/UniswapV2Router02Collection'
import { ROUTER_NATIVE_ERC20_ABI } from '../../src/abis/UniswapV2Router01CollectionNativeERC20'
import { toNativeValue } from '../../src/chains/units'
import { isSnfError, SnfError } from '../../src/errors'
import { buildLiquidityEnv } from '../liquidity/liquidityTestHelpers'
import type { BuildSeedArgs } from '../../src/types/liquidity.types'

const COLLECTION = getAddress('0x000000000000000000000000000000000000c011')
const BASE_ERC20 = getAddress('0x000000000000000000000000000000000000ba5e')
const WRAPPER = getAddress('0x00000000000000000000000000000000000fa99e')
const PAIR = getAddress('0x0000000000000000000000000000000000ba12a1')
const PAYER = getAddress('0x000000000000000000000000000000000000a11e')
const LP_RECIPIENT = getAddress('0x000000000000000000000000000000000000f00d')
const ZERO_ADDRESS = getAddress('0x0000000000000000000000000000000000000000')

function idsRange(count: number, startAt = 1): readonly string[] {
  return Array.from({ length: count }, (_, i) => String(i + startAt))
}

/** Descending on purpose — every test exercises `buildSeed`'s own ascending sort. */
function idsRangeDescending(count: number, startAt = 1): readonly string[] {
  return [...idsRange(count, startAt)].reverse()
}

function ownerOfAll(ids: readonly string[], owner: `0x${string}`): Record<string, `0x${string}`> {
  const out: Record<string, `0x${string}`> = {}
  for (const id of ids) out[id] = owner
  return out
}

function baseArgs(overrides: Partial<BuildSeedArgs> = {}): BuildSeedArgs {
  return {
    collection: COLLECTION,
    tokenIds: idsRangeDescending(MIN_NEW_POOL_NFTS),
    pricePerNft: 1_000_000_000_000_000_000n,
    payer: PAYER,
    lpRecipient: LP_RECIPIENT,
    ...overrides,
  }
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

describe('buildSeed — empty pool, native, one chunk', () => {
  it('sorts ids ascending, one approval + one create-pool step at exactly N x pricePerNft', async () => {
    const pricePerNft = 1_000_000_000_000_000_000n
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: null,
      erc721ApprovedForAll: false,
      ownerOf: ownerOfAll(idsRange(6), PAYER),
    })

    const plan = await buildSeed(
      env.ctx,
      baseArgs({ tokenIds: ['10', '9', '100', '8', '7', '6'], pricePerNft }),
    )

    expect(plan.steps).toHaveLength(2)
    const approvalStep = plan.steps[0]!
    const depositStep = plan.steps[1]!
    expect(approvalStep.kind).toBe('approval')
    expect(approvalStep.approvals[0]?.kind).toBe('erc721-approval-for-all')

    expect(depositStep.kind).toBe('add-liquidity')
    expect(depositStep.quote.side).toBe('create-pool')
    expect(depositStep.label).toBe('Create pool')

    const decoded = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: depositStep.tx.data })
    expect(decoded.functionName).toBe('addLiquidityETHCollection')
    expect(decoded.args).toEqual([
      COLLECTION,
      [6n, 7n, 8n, 9n, 10n, 100n],
      6n * pricePerNft,
      LP_RECIPIENT,
      depositStep.bounds.deadline,
    ])
    expect(depositStep.tx.value).toBe(6n * pricePerNft)
    expect(depositStep.bounds.amountInMin).toBe(6n * pricePerNft)
    expect(depositStep.bounds.amountInMin).not.toBe(0n)
  })
})

describe('buildSeed — 120 ids, empty pool, native: three chunks of 50/50/20', () => {
  it('chunks in ascending order; step 1 creates, steps 2-3 add at the ratio step 1 set, every min = desired, never 0', async () => {
    const pricePerNft = 1_000_000_000_000_000_000n
    const ids = idsRangeDescending(120)
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: null,
      erc721ApprovedForAll: false,
      ownerOf: ownerOfAll(idsRange(120), PAYER),
    })

    const plan = await buildSeed(env.ctx, baseArgs({ tokenIds: ids, pricePerNft }))

    // One approval + three deposit steps.
    expect(plan.steps).toHaveLength(4)
    const [approvalStep, step1, step2, step3] = plan.steps as readonly [
      (typeof plan.steps)[number],
      (typeof plan.steps)[number],
      (typeof plan.steps)[number],
      (typeof plan.steps)[number],
    ]
    expect(approvalStep!.kind).toBe('approval')

    const decoded1 = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: step1!.tx.data })
    const decoded2 = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: step2!.tx.data })
    const decoded3 = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: step3!.tx.data })

    // Chunk boundaries and ascending order within each chunk.
    expect((decoded1.args[1] as readonly bigint[]).length).toBe(50)
    expect((decoded2.args[1] as readonly bigint[]).length).toBe(50)
    expect((decoded3.args[1] as readonly bigint[]).length).toBe(20)
    expect(decoded1.args[1]).toEqual(
      (decoded1.args[1] as readonly bigint[]).slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
    )
    expect(step1!.preflightRefs?.sellTokenIds).toEqual(idsRange(50))
    expect(step2!.preflightRefs?.sellTokenIds).toEqual(idsRange(50, 51))
    expect(step3!.preflightRefs?.sellTokenIds).toEqual(idsRange(20, 101))

    // Step 1 creates at exactly 50 x pricePerNft; steps 2/3 add at the SAME ratio
    // step 1 set (50e18 wnft : 50P base), so the floor division lands exact.
    expect(step1!.quote.side).toBe('create-pool')
    expect(decoded1.args[2]).toBe(50n * pricePerNft) // amountETHMin
    expect(step2!.quote.side).toBe('add-liquidity')
    expect(decoded2.args[2]).toBe(50n * pricePerNft)
    expect(step3!.quote.side).toBe('add-liquidity')
    expect(decoded3.args[2]).toBe(20n * pricePerNft)

    // Every step's min equals its own desired amount, and none is zero.
    for (const step of [step1, step2, step3]) {
      expect(step!.bounds.amountInMin).toBe(step!.bounds.amountInMax)
      expect(step!.bounds.amountInMin).not.toBe(0n)
    }

    // Step 1 gets the creation overhead (no pair/wrapper yet); steps 2-3 depend on
    // an earlier, still-unconfirmed step and carry a warning saying so.
    expect(step1!.tx.gas).toBe(fallbackGasForNFTBatch(50) + PAIR_CREATION_GAS + WRAPPER_CREATION_GAS)
    expect(step2!.tx.gasSource).toBe('fallback-pending-step')
    expect(step3!.tx.gasSource).toBe('fallback-pending-step')
    expect(step2!.quote.warnings?.some((w) => w.toLowerCase().includes('rebuild'))).toBe(true)
    expect(step3!.quote.warnings?.some((w) => w.toLowerCase().includes('rebuild'))).toBe(true)

    // Every step's LP destination (the decoded `to` argument) is lpRecipient.
    expect(decoded1.args[3]).toBe(LP_RECIPIENT)
    expect(decoded2.args[3]).toBe(LP_RECIPIENT)
    expect(decoded3.args[3]).toBe(LP_RECIPIENT)
  })
})

describe("buildSeed — ERC-20 base: one approval covering the sum of every step's desired amount", () => {
  it('60 ids -> 50/10 chunks; step 1 exact at 50P, step 2 adds at the ratio, approval = sum', async () => {
    const pricePerNft = 1_000_000_000_000_000_000n
    const ids = idsRangeDescending(60)
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: null,
      erc721ApprovedForAll: false,
      baseToken: { address: BASE_ERC20, decimals: 18, symbol: 'USDC' },
      ownerOf: ownerOfAll(idsRange(60), PAYER),
    })

    const plan = await buildSeed(env.ctx, baseArgs({ tokenIds: ids, pricePerNft, baseToken: BASE_ERC20 }))

    const approvalSteps = plan.steps.filter((s) => s.kind === 'approval')
    const depositSteps = plan.steps.filter((s) => s.kind === 'add-liquidity')
    expect(approvalSteps).toHaveLength(2) // erc721 operator + erc20 allowance
    expect(depositSteps).toHaveLength(2)

    const erc20Approval = approvalSteps.find((s) => s.approvals[0]?.kind === 'erc20-allowance')!
    const decodedApproval = decodeFunctionData({ abi: ERC20_ABI, data: erc20Approval.tx.data })
    expect(decodedApproval.functionName).toBe('approve')
    // sum of both steps' own desired amount: 50P, plus 10P + 1 for the second chunk
    expect(decodedApproval.args[1]).toBe(60n * pricePerNft + 1n)

    const [step1, step2] = depositSteps
    const decoded1 = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: step1!.tx.data })
    const decoded2 = decodeFunctionData({ abi: ROUTER02_COLLECTION_ABI, data: step2!.tx.data })
    expect(decoded1.functionName).toBe('addLiquidityCollection')
    // [baseToken, collection, desired, tokenIds, min, to, deadline]
    expect(decoded1.args[2]).toBe(50n * pricePerNft) // amountADesired
    expect(decoded1.args[4]).toBe(50n * pricePerNft) // amountAMin — exact, same as desired
    // desired = ceil((10e18 + 1) * 50P / 50e18): one wei above the minimum, so the Router
    // takes its exact branch and pulls the minimum itself
    expect(decoded2.args[2]).toBe(10n * pricePerNft + 1n)
    expect(decoded2.args[4]).toBe(10n * pricePerNft)
    expect(step1!.quote.side).toBe('create-pool')
    expect(step2!.quote.side).toBe('add-liquidity')
  })
})

describe('buildSeed — Arc native: value scales by 1e12, mins stay in 6-decimal quote units', () => {
  it('6 ids on Arc: tx.value = desired x 1e12, amountETHMin in 6-dec units', async () => {
    const pricePerNft = 2_000_000n // 2 USDC (6 decimals) per NFT
    const env = buildLiquidityEnv({
      chainId: 5042,
      collection: COLLECTION,
      wrapper: null,
      erc721ApprovedForAll: false,
      ownerOf: ownerOfAll(idsRange(6), PAYER),
    })

    const plan = await buildSeed(env.ctx, baseArgs({ tokenIds: idsRange(6), pricePerNft }))
    const depositStep = plan.steps[plan.steps.length - 1]!
    const decoded = decodeFunctionData({ abi: ROUTER_NATIVE_ERC20_ABI, data: depositStep.tx.data })
    const expectedMin = 6n * pricePerNft
    expect(decoded.args[2]).toBe(expectedMin)
    expect(depositStep.tx.value).toBe(toNativeValue(5042, expectedMin))
  })
})

describe('buildSeed — existing pool: price tolerance', () => {
  it('within tolerance: step 1 adds at the live ratio, side add-liquidity', async () => {
    const reserves = { base: 6_000_000_000_000_000_000n, wnft: 6n * 10n ** 18n } // 1 ETH/NFT live
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      reserves,
      totalSupply: 1_000_000_000_000_000_000n,
      erc721ApprovedForAll: false,
      ownerOf: ownerOfAll(idsRange(6), PAYER),
    })

    const plan = await buildSeed(env.ctx, baseArgs({ tokenIds: idsRange(6), pricePerNft: 1_000_000_000_000_000_000n }))
    const depositStep = plan.steps[plan.steps.length - 1]!
    expect(depositStep.quote.side).toBe('add-liquidity')
    expect(depositStep.label).toBe('Confirm deposit')
  })

  it('outside tolerance: throws INVALID_PARAMS reason pool-price-outside-tolerance', async () => {
    const reserves = { base: 12_000_000_000_000_000_000n, wnft: 6n * 10n ** 18n } // 2 ETH/NFT live
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      reserves,
      totalSupply: 1_000_000_000_000_000_000n,
    })

    const { error } = await expectRejectsWithCode(
      buildSeed(env.ctx, baseArgs({ tokenIds: idsRange(6), pricePerNft: 1_000_000_000_000_000_000n })),
      'INVALID_PARAMS',
    )
    expect(error.details?.field).toBe('pricePerNft')
    expect(error.details?.reason).toBe('pool-price-outside-tolerance')
    expect(error.details?.livePrice).toBe(2_000_000_000_000_000_000n)
    expect(error.details?.declared).toBe(1_000_000_000_000_000_000n)
  })
})

describe('buildSeed — validation', () => {
  it('5 ids throws INVALID_PARAMS with details.field tokenIds and details.min 6', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null })
    const { error } = await expectRejectsWithCode(
      buildSeed(env.ctx, baseArgs({ tokenIds: idsRange(5) })),
      'INVALID_PARAMS',
    )
    expect(error.details?.field).toBe('tokenIds')
    expect(error.details?.min).toBe(MIN_NEW_POOL_NFTS)
  })

  it('a duplicate id throws INVALID_PARAMS', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null })
    const ids = [...idsRange(5), '5']
    await expectRejectsWithCode(buildSeed(env.ctx, baseArgs({ tokenIds: ids })), 'INVALID_PARAMS')
  })

  it('501 ids throws INVALID_PARAMS', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null })
    await expectRejectsWithCode(
      buildSeed(env.ctx, baseArgs({ tokenIds: idsRange(MAX_SEED_TOKEN_IDS + 1) })),
      'INVALID_PARAMS',
    )
  })

  it('a malformed lpRecipient throws INVALID_PARAMS naming lpRecipient', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null })
    const { error } = await expectRejectsWithCode(
      buildSeed(env.ctx, baseArgs({ lpRecipient: '0xnope' as `0x${string}` })),
      'INVALID_PARAMS',
    )
    expect(error.details?.field).toBe('lpRecipient')
  })

  it('the zero address lpRecipient throws INVALID_PARAMS naming lpRecipient', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null })
    const { error } = await expectRejectsWithCode(
      buildSeed(env.ctx, baseArgs({ lpRecipient: ZERO_ADDRESS })),
      'INVALID_PARAMS',
    )
    expect(error.details?.field).toBe('lpRecipient')
  })

  it('pricePerNft <= 0n throws INVALID_PARAMS naming pricePerNft', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null })
    const { error } = await expectRejectsWithCode(
      buildSeed(env.ctx, baseArgs({ pricePerNft: 0n })),
      'INVALID_PARAMS',
    )
    expect(error.details?.field).toBe('pricePerNft')
  })

  it('baseToken equal to the raw collection throws INVALID_PARAMS reason base-is-collection', async () => {
    const env = buildLiquidityEnv({ collection: COLLECTION, wrapper: null })
    const { error } = await expectRejectsWithCode(
      buildSeed(env.ctx, baseArgs({ baseToken: COLLECTION })),
      'INVALID_PARAMS',
    )
    expect(error.details?.reason).toBe('base-is-collection')
  })
})

describe('buildSeed — a live protocol fee refuses the whole seed', () => {
  it('Factory.feeTo() != 0 throws QUOTE_RECONCILIATION_FAILED', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: null,
      feeTo: getAddress('0x000000000000000000000000000000000000fee5'),
    })
    await expectRejectsWithCode(buildSeed(env.ctx, baseArgs()), 'QUOTE_RECONCILIATION_FAILED')
  })
})

describe('buildSeed — pre-flight checks ownership of every id and the summed native value in one call', () => {
  it('a payer who owns every id and has enough native balance passes preflight', async () => {
    const pricePerNft = 1_000_000_000_000_000_000n
    const ids = idsRangeDescending(120)
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: null,
      erc721ApprovedForAll: false,
      ownerOf: ownerOfAll(idsRange(120), PAYER),
      nativeBalance: 2n ** 200n,
    })

    const plan = await buildSeed(env.ctx, baseArgs({ tokenIds: ids, pricePerNft }))
    const preflight = await plan.preflight()
    expect(preflight.ok).toBe(true)
  })

  it('a payer missing one id fails preflight with TOKENIDS_UNAVAILABLE', async () => {
    const pricePerNft = 1_000_000_000_000_000_000n
    const ids = idsRange(6)
    const ownerOf = ownerOfAll(ids, PAYER)
    delete ownerOf['3']
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: null,
      erc721ApprovedForAll: false,
      ownerOf,
      nativeBalance: 2n ** 200n,
    })

    const plan = await buildSeed(env.ctx, baseArgs({ tokenIds: ids, pricePerNft }))
    await expectRejectsWithCode(plan.preflight(), 'TOKENIDS_UNAVAILABLE')
  })
})
