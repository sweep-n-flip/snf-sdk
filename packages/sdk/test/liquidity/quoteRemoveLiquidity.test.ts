import { describe, expect, it, vi } from 'vitest'

import { isSnfError, SnfError } from '../../src/errors'
import { getChain } from '../../src/chains/registry'
import { buildLiquidityEnv } from './liquidityTestHelpers'

vi.mock('../../src/liquidity/redemptionStatus', () => ({
  probeRedemption: vi.fn(async () => ({ status: 'unknown' as const, source: 'none' as const })),
}))
vi.mock('../../src/inventory/poolInventory', () => ({
  poolInventory: vi.fn(async () => ({
    tokenIds: [] as readonly string[],
    availableCount: 0,
    asOfBlock: 0n,
    lagSeconds: 0,
    stale: false,
    source: 'subgraph' as const,
    truncated: false,
    warnings: [] as readonly string[],
  })),
}))

// Imported AFTER the mocks so the module under test picks up the mocked bodies.
import { quoteRemoveLiquidity } from '../../src/liquidity/quoteRemoveLiquidity'
import { probeRedemption } from '../../src/liquidity/redemptionStatus'
import { poolInventory } from '../../src/inventory/poolInventory'

const COLLECTION = '0x000000000000000000000000000000000000c011' as `0x${string}`
const WRAPPER = '0x000000000000000000000000000000000000BAD1' as `0x${string}`
const PAIR = '0x000000000000000000000000000000000000FA17' as `0x${string}`
const OWNER = '0x000000000000000000000000000000000000dEaD' as `0x${string}`
const ONE = 1_000_000_000_000_000_000n

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

/** With `balances.base === balances.wnft === totalSupply`, `burnAmounts` returns the
 * burned `liquidity` amount itself on BOTH sides (ratio 1:1) — the cleanest possible
 * fixture for controlling `baseOut`/`wnftOut` directly via the `liquidity` argument. */
function ratioOneEnv(totalSupply: bigint, ownerLp: bigint, opts: { readonly chainId?: 8453 | 5042 } = {}) {
  return buildLiquidityEnv({
    ...(opts.chainId !== undefined ? { chainId: opts.chainId } : {}),
    collection: COLLECTION,
    wrapper: WRAPPER,
    pair: PAIR,
    wrapperIsToken0: true,
    balances: { base: totalSupply, wnft: totalSupply },
    totalSupply,
    ownerLp,
  })
}

describe('quoteRemoveLiquidity — liquidity/bps selector', () => {
  it('neither liquidity nor bps supplied throws INVALID_PARAMS', async () => {
    const env = ratioOneEnv(1_000n, 1_000n)
    await expectRejectsWithCode(
      quoteRemoveLiquidity(env.ctx, { pair: PAIR, owner: OWNER, mode: 'wnft' } as never),
      'INVALID_PARAMS',
    )
  })

  it('both liquidity and bps supplied throws INVALID_PARAMS', async () => {
    const env = ratioOneEnv(1_000n, 1_000n)
    await expectRejectsWithCode(
      quoteRemoveLiquidity(env.ctx, { pair: PAIR, owner: OWNER, mode: 'wnft', liquidity: 1n, bps: 1 }),
      'INVALID_PARAMS',
    )
  })

  it.each([0, 10_001, 1.5])('bps %s outside 1..10000 (integer) throws INVALID_PARAMS', async (bps) => {
    const env = ratioOneEnv(1_000n, 1_000n)
    await expectRejectsWithCode(quoteRemoveLiquidity(env.ctx, { pair: PAIR, owner: OWNER, mode: 'wnft', bps }), 'INVALID_PARAMS')
  })

  it('bps 5000 burns floor(ownerLp * 5000 / 10000)', async () => {
    const totalSupply = 100_000_000_000_000_000_000n
    const env = ratioOneEnv(totalSupply, 10_000_000_000_000_000_000n)
    const quote = await quoteRemoveLiquidity(env.ctx, { pair: PAIR, owner: OWNER, mode: 'wnft', bps: 5_000 })
    expect(quote.liquidity?.lpIn?.value).toBe(5_000_000_000_000_000_000n)
  })

  it('an explicit liquidity greater than the owner balance throws INVALID_PARAMS with required/available', async () => {
    const totalSupply = 100n
    const env = ratioOneEnv(totalSupply, 10n)
    const { error } = await expectRejectsWithCode(
      quoteRemoveLiquidity(env.ctx, { pair: PAIR, owner: OWNER, mode: 'wnft', liquidity: 11n }),
      'INVALID_PARAMS',
    )
    expect(error.details?.required).toBe(11n)
    expect(error.details?.available).toBe(10n)
  })
})

describe('quoteRemoveLiquidity — outputs mirror Pair.burn over balances, not reserves', () => {
  it('a pair whose balances exceed reserves pays out more than a reserves-only figure would', async () => {
    const totalSupply = 100_000_000_000_000_000_000n
    const liquidity = 10_000_000_000_000_000_000n
    const reserves = { base: 50_000_000_000_000_000_000n, wnft: 50_000_000_000_000_000_000n }
    const balances = { base: 90_000_000_000_000_000_000n, wnft: 90_000_000_000_000_000_000n }
    const reservesOnly = buildLiquidityEnv({
      collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, reserves, balances: reserves, totalSupply, ownerLp: liquidity,
    })
    const withSurplus = buildLiquidityEnv({
      collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, reserves, balances, totalSupply, ownerLp: liquidity,
    })
    const fromReserves = await quoteRemoveLiquidity(reservesOnly.ctx, { pair: PAIR, owner: OWNER, mode: 'wnft', liquidity })
    const fromBalances = await quoteRemoveLiquidity(withSurplus.ctx, { pair: PAIR, owner: OWNER, mode: 'wnft', liquidity })
    expect(fromBalances.liquidity?.baseOut?.value).toBeGreaterThan(fromReserves.liquidity?.baseOut?.value ?? 0n)
  })

  it('both wrapper orientations give identical outputs', async () => {
    const totalSupply = 1_000_000_000_000_000_000_000n
    const balances = { base: 3_000_000_000_000_000_000_000n, wnft: 7_000_000_000_000_000_000_000n }
    const liquidity = 40_000_000_000_000_000_000n
    const asToken0 = buildLiquidityEnv({ collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, wrapperIsToken0: true, balances, totalSupply, ownerLp: liquidity })
    const asToken1 = buildLiquidityEnv({ collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, wrapperIsToken0: false, balances, totalSupply, ownerLp: liquidity })
    const q0 = await quoteRemoveLiquidity(asToken0.ctx, { pair: PAIR, owner: OWNER, mode: 'wnft', liquidity })
    const q1 = await quoteRemoveLiquidity(asToken1.ctx, { pair: PAIR, owner: OWNER, mode: 'wnft', liquidity })
    expect(q0.liquidity?.baseOut?.value).toBe(q1.liquidity?.baseOut?.value)
    expect(q0.liquidity?.wnftOut?.value).toBe(q1.liquidity?.wnftOut?.value)
  })

  it('a burn yielding zero of one token throws INVALID_PARAMS reason insufficient-liquidity-burned', async () => {
    const env = buildLiquidityEnv({
      collection: COLLECTION,
      wrapper: WRAPPER,
      pair: PAIR,
      balances: { base: 10n ** 30n, wnft: 1n },
      totalSupply: 10n ** 30n,
      ownerLp: 1n,
    })
    const { error } = await expectRejectsWithCode(
      quoteRemoveLiquidity(env.ctx, { pair: PAIR, owner: OWNER, mode: 'wnft', liquidity: 1n }),
      'INVALID_PARAMS',
    )
    expect(error.details?.reason).toBe('insufficient-liquidity-burned')
  })

  it('Factory.feeTo() != 0 throws QUOTE_RECONCILIATION_FAILED', async () => {
    const feeEnv = buildLiquidityEnv({
      collection: COLLECTION, wrapper: WRAPPER, pair: PAIR, balances: { base: 1_000n, wnft: 1_000n }, totalSupply: 1_000n, ownerLp: 1_000n,
      feeTo: '0x000000000000000000000000000000000000fee1',
    })
    const { error } = await expectRejectsWithCode(
      quoteRemoveLiquidity(feeEnv.ctx, { pair: PAIR, owner: OWNER, mode: 'wnft', liquidity: 100n }),
      'QUOTE_RECONCILIATION_FAILED',
    )
    expect(error.details?.reason).toBe('protocol-fee-on')
  })
})

describe('quoteRemoveLiquidity — wnft mode', () => {
  it('works at a share too small to redeem even one whole NFT, with deliverable 0 and no tokenIds', async () => {
    const totalSupply = 1_000_000_000_000_000_000_000n
    const env = ratioOneEnv(totalSupply, 100n)
    const quote = await quoteRemoveLiquidity(env.ctx, { pair: PAIR, owner: OWNER, mode: 'wnft', liquidity: 100n })
    expect(quote.liquidity?.wnftOut?.value).toBe(100n)
    expect(quote.deliverable).toBe(0)
    expect(quote.tokenIds).toBeUndefined()
    expect(quote.liquidity?.nftWhole).toBeUndefined()
  })

  it('passing tokenIds in wnft mode throws INVALID_PARAMS', async () => {
    const env = ratioOneEnv(1_000n, 1_000n)
    await expectRejectsWithCode(
      quoteRemoveLiquidity(env.ctx, { pair: PAIR, owner: OWNER, mode: 'wnft', liquidity: 100n, tokenIds: ['1'] }),
      'INVALID_PARAMS',
    )
  })
})

describe('quoteRemoveLiquidity — nft mode', () => {
  it('redeems floor(wnftOut/1e18) whole NFTs plus the wnftRemainder', async () => {
    const totalSupply = 1_000_000_000_000_000_000_000n
    const liquidity = 3n * ONE + 400_000_000_000_000_000n // 3.4 units
    const env = ratioOneEnv(totalSupply, liquidity)
    vi.mocked(poolInventory).mockResolvedValueOnce({
      tokenIds: ['10', '20', '30'],
      availableCount: 3,
      asOfBlock: 1n,
      lagSeconds: 0,
      stale: false,
      source: 'subgraph',
      truncated: false,
      warnings: [],
    })
    const quote = await quoteRemoveLiquidity(env.ctx, { pair: PAIR, owner: OWNER, mode: 'nft', liquidity })
    expect(quote.liquidity?.nftWhole).toBe(3)
    expect(quote.liquidity?.wnftRemainder?.value).toBe(400_000_000_000_000_000n)
    expect(quote.tokenIds).toEqual(['10', '20', '30'])
    expect(quote.deliverable).toBe(3)
  })

  it('a share too small to redeem even one whole NFT throws INVALID_PARAMS reason no-whole-nft', async () => {
    const totalSupply = 1_000_000_000_000_000_000_000n
    const liquidity = 500_000_000_000_000_000n // 0.5 units
    const env = ratioOneEnv(totalSupply, liquidity)
    const { error } = await expectRejectsWithCode(
      quoteRemoveLiquidity(env.ctx, { pair: PAIR, owner: OWNER, mode: 'nft', liquidity }),
      'INVALID_PARAMS',
    )
    expect(error.details?.reason).toBe('no-whole-nft')
    expect(error.details?.suggestedMode).toBe('wnft')
  })

  it('caller-supplied tokenIds whose count does not match nftWhole throws INVALID_PARAMS reason count-mismatch', async () => {
    const totalSupply = 1_000_000_000_000_000_000_000n
    const liquidity = 2n * ONE
    const env = ratioOneEnv(totalSupply, liquidity)
    const { error } = await expectRejectsWithCode(
      quoteRemoveLiquidity(env.ctx, { pair: PAIR, owner: OWNER, mode: 'nft', liquidity, tokenIds: ['1', '2', '3'] }),
      'INVALID_PARAMS',
    )
    expect(error.details?.reason).toBe('count-mismatch')
    expect(error.details?.expected).toBe(2)
    expect(error.details?.received).toBe(3)
  })

  it('fewer pool-inventory candidates than nftWhole throws TOKENIDS_UNAVAILABLE', async () => {
    const totalSupply = 1_000_000_000_000_000_000_000n
    const liquidity = 3n * ONE
    const env = ratioOneEnv(totalSupply, liquidity)
    vi.mocked(poolInventory).mockResolvedValueOnce({
      tokenIds: ['10'],
      availableCount: 1,
      asOfBlock: 1n,
      lagSeconds: 0,
      stale: false,
      source: 'subgraph',
      truncated: false,
      warnings: [],
    })
    await expectRejectsWithCode(quoteRemoveLiquidity(env.ctx, { pair: PAIR, owner: OWNER, mode: 'nft', liquidity }), 'TOKENIDS_UNAVAILABLE')
  })

  it("a 'blocked' redemption status throws REDEMPTION_LOCKED suggesting wnft mode", async () => {
    const totalSupply = 1_000_000_000_000_000_000_000n
    const liquidity = 2n * ONE
    const env = ratioOneEnv(totalSupply, liquidity)
    vi.mocked(probeRedemption).mockResolvedValueOnce({ status: 'blocked', source: 'enumerable', sampleTokenId: '1', reason: 'transfer role blocked' })
    const { error } = await expectRejectsWithCode(
      quoteRemoveLiquidity(env.ctx, { pair: PAIR, owner: OWNER, mode: 'nft', liquidity, tokenIds: ['1', '2'] }),
      'REDEMPTION_LOCKED',
    )
    expect(error.details?.suggestedMode).toBe('wnft')
  })

  it("an 'unknown' redemption status is still priced", async () => {
    const totalSupply = 1_000_000_000_000_000_000_000n
    const liquidity = 2n * ONE
    const env = ratioOneEnv(totalSupply, liquidity)
    vi.mocked(probeRedemption).mockResolvedValueOnce({ status: 'unknown', source: 'none' })
    const quote = await quoteRemoveLiquidity(env.ctx, { pair: PAIR, owner: OWNER, mode: 'nft', liquidity, tokenIds: ['1', '2'] })
    expect(quote.liquidity?.nftWhole).toBe(2)
  })
})

describe('quoteRemoveLiquidity — warnings', () => {
  it('warns when the default-slippage floor crosses an integer boundary', async () => {
    const totalSupply = 1_000_000_000_000_000_000_000n
    const liquidity = 3n * ONE + 1n // just above an exact whole-unit boundary
    const env = ratioOneEnv(totalSupply, liquidity)
    const quote = await quoteRemoveLiquidity(env.ctx, { pair: PAIR, owner: OWNER, mode: 'nft', liquidity, tokenIds: ['1', '2', '3'] })
    expect(quote.warnings?.some((w) => w.toLowerCase().includes('boundary'))).toBe(true)
  })

  it('does not warn about the boundary when comfortably inside a whole unit', async () => {
    const totalSupply = 1_000_000_000_000_000_000_000n
    const liquidity = 10n * ONE + 500_000_000_000_000_000n // 10.5 units — well clear of the boundary
    const env = ratioOneEnv(totalSupply, liquidity)
    const quote = await quoteRemoveLiquidity(env.ctx, { pair: PAIR, owner: OWNER, mode: 'nft', liquidity, tokenIds: Array.from({ length: 10 }, (_, i) => String(i + 1)) })
    expect(quote.warnings?.some((w) => w.toLowerCase().includes('boundary')) ?? false).toBe(false)
  })

  it('warns when the withdrawal drains every unit of LP still in circulation', async () => {
    const totalSupply = 1_001_000n // circulating = totalSupply - MINIMUM_LIQUIDITY (1000) = 1_000_000n
    const ownerLp = 1_000_000n
    const env = ratioOneEnv(totalSupply, ownerLp)
    const quote = await quoteRemoveLiquidity(env.ctx, { pair: PAIR, owner: OWNER, mode: 'wnft', liquidity: ownerLp })
    expect(quote.warnings?.some((w) => w.toLowerCase().includes('locked'))).toBe(true)
  })
})

describe('quoteRemoveLiquidity — Arc prices the base side in 6-decimal quote units', () => {
  it('baseOut.decimals === 6', async () => {
    const chain = getChain(5042)
    const totalSupply = 100_000_000n
    const env = ratioOneEnv(totalSupply, 10_000_000n, { chainId: 5042 })
    const quote = await quoteRemoveLiquidity(env.ctx, { pair: PAIR, owner: OWNER, mode: 'wnft', liquidity: 10_000_000n })
    expect(quote.liquidity?.baseOut?.decimals).toBe(6)
    expect(quote.liquidity?.baseOut?.symbol).toBe(chain.nativeSymbol)
  })
})

describe('quoteRemoveLiquidity — chain guard', () => {
  it('a mismatched chainId throws WRONG_CHAIN before any on-chain read', async () => {
    const env = ratioOneEnv(1_000n, 1_000n)
    await expectRejectsWithCode(
      quoteRemoveLiquidity(env.ctx, { pair: PAIR, owner: OWNER, mode: 'wnft', liquidity: 100n, chainId: 137 }),
      'WRONG_CHAIN',
    )
    expect(env.multicall).not.toHaveBeenCalled()
  })
})
