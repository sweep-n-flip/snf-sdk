import { formatUnits } from 'viem'
import fc from 'fast-check'
import { describe, expect, it, vi } from 'vitest'

import { SnfError } from '../../src/errors'
import { lpPositionFromState } from '../../src/liquidity/lpPosition'
import { loadPairState } from '../../src/liquidity/poolState'
import { positions } from '../../src/portfolio/positions'
import { buildPortfolioEnv, testAddress } from './portfolioTestHelpers'

/**
 * `positions(owner)` — the scan, the reused loaders, per-pair isolation, mid
 * valuation, USD and ordering. Wrapper-side symmetry and the Arc unit axis are the
 * two properties/fixtures this suite leans on hardest, since every other on-chain
 * figure already comes from `loadPairState`'s own, separately-tested loader.
 */

const OWNER = testAddress(999)

describe('positions — input validation', () => {
  it('a malformed owner rejects INVALID_PARAMS with zero transport/RPC calls', async () => {
    const env = buildPortfolioEnv()
    await expect(positions(env.ctx, '0xbad' as `0x${string}`)).rejects.toMatchObject({ code: 'INVALID_PARAMS', details: { field: 'owner' } })
    expect(env.pools).not.toHaveBeenCalled()
    expect(env.multicall).not.toHaveBeenCalled()
    expect(env.getBlockNumber).not.toHaveBeenCalled()
  })

  it('the zero address is accepted', async () => {
    const env = buildPortfolioEnv()
    const result = await positions(env.ctx, '0x0000000000000000000000000000000000000000')
    expect(result.positions).toStrictEqual([])
  })
})

describe('positions — scan shape and block pinning', () => {
  it('a BNB-shaped fixture (2 NFT pools + 7 delegated rows): the scan multicall has exactly 3 contracts', async () => {
    const env = buildPortfolioEnv({
      chainId: 56,
      pairs: [
        { pair: testAddress(1), wrapper: testAddress(2), collection: testAddress(3) },
        { pair: testAddress(4), wrapper: testAddress(5), collection: testAddress(6) },
      ],
      extraRows: Array.from({ length: 7 }, (_, i) => ({
        id: testAddress(200 + i),
        discrete0: false,
        discrete1: false,
        isNFTPool: false,
        token0: { id: testAddress(300 + i), symbol: 'A', name: 'A', decimals: 18, collection: null },
        token1: { id: testAddress(400 + i), symbol: 'B', name: 'B', decimals: 18, collection: null },
        reserve0: '0',
        reserve1: '0',
        totalSupply: '0',
        reserveETH: '0',
        reserveUSD: '0',
        volumeToken0: '0',
        volumeToken1: '0',
        volumeUSD: '0',
        txCount: '0',
      })),
    })
    const result = await positions(env.ctx, OWNER)
    expect(result.positions).toStrictEqual([])
    expect(env.multicall).toHaveBeenCalledTimes(1)
    expect(env.multicall.mock.calls[0]![0].contracts).toHaveLength(3)
  })

  it('getBlockNumber is called exactly once; every recorded multicall call carries that block', async () => {
    const env = buildPortfolioEnv({
      blockNumber: 12_345n,
      pairs: [
        { pair: testAddress(1), wrapper: testAddress(2), collection: testAddress(3), balances: { base: 100n, wnft: 100n }, totalSupply: 100n, lp: { [OWNER]: 100n } },
        { pair: testAddress(4), wrapper: testAddress(5), collection: testAddress(6), balances: { base: 100n, wnft: 100n }, totalSupply: 100n, lp: { [OWNER]: 100n } },
      ],
    })
    const result = await positions(env.ctx, OWNER)
    expect(env.getBlockNumber).toHaveBeenCalledTimes(1)
    expect(result.blockNumber).toBe(12_345n)
    for (const call of env.calls()) expect(call.blockNumber).toBe(12_345n)
  })
})

describe('positions — held filtering', () => {
  it('a wallet with no held pairs returns positions: [], skipped: []', async () => {
    const env = buildPortfolioEnv({
      pairs: [{ pair: testAddress(1), wrapper: testAddress(2), collection: testAddress(3), balances: { base: 100n, wnft: 100n }, totalSupply: 100n }],
    })
    const result = await positions(env.ctx, OWNER)
    expect(result.positions).toStrictEqual([])
    expect(result.skipped).toStrictEqual([])
  })

  it('an empty pool set returns positions: [] without any multicall', async () => {
    const env = buildPortfolioEnv()
    const result = await positions(env.ctx, OWNER)
    expect(result.positions).toStrictEqual([])
    expect(env.multicall).not.toHaveBeenCalled()
    expect(env.pools).toHaveBeenCalledTimes(1)
  })
})

describe('positions — field parity with lpPositionFromState, plus enrichment', () => {
  it('a held pair matches lpPositionFromState field for field, plus the enrichment fields', async () => {
    const pair = testAddress(1)
    const wrapper = testAddress(2)
    const collection = testAddress(3)
    const totalSupply = 100_000_000_000_000_000_000n
    const ownerLp = 25_000_000_000_000_000_000n
    const env = buildPortfolioEnv({
      pairs: [{ pair, wrapper, collection, wrapperIsToken0: true, balances: { base: totalSupply, wnft: totalSupply }, totalSupply, lp: { [OWNER]: ownerLp } }],
    })
    const result = await positions(env.ctx, OWNER)
    expect(result.positions).toHaveLength(1)
    const got = result.positions[0]!

    const state = await loadPairState(env.ctx, { pair, owner: OWNER, blockNumber: result.blockNumber })
    // `lpPositionFromState` echoes its `owner` argument verbatim, so this must be the
    // SAME (checksummed) owner `positions` itself passed through internally.
    const expected = lpPositionFromState(state, got.owner)

    expect(got.pair).toBe(expected.pair)
    expect(got.owner).toBe(expected.owner)
    expect(got.lpBalance).toStrictEqual(expected.lpBalance)
    expect(got.totalSupply).toBe(expected.totalSupply)
    expect(got.shareBps).toBe(expected.shareBps)
    expect(got.underlying).toStrictEqual(expected.underlying)
    expect(got.blockNumber).toBe(expected.blockNumber)

    expect(got.chainId).toBe(env.ctx.chain.chainId)
    expect(got.collection.toLowerCase()).toBe(collection.toLowerCase())
    expect(got.wrapper.toLowerCase()).toBe(wrapper.toLowerCase())
    expect(got.labels).toStrictEqual({ name: 'Collection', symbol: 'NFT' })
    expect(got.valueInBase.value).toBe(2n * expected.underlying.base.value)
    expect(got.valuation).toBe('mid')
  })
})

describe('positions — wrapper orientation symmetry', () => {
  function fixture(wrapperIsToken0: boolean, balances: { readonly base: bigint; readonly wnft: bigint }, totalSupply: bigint, ownerLp: bigint) {
    return buildPortfolioEnv({
      pairs: [{ pair: testAddress(1), wrapper: testAddress(2), collection: testAddress(3), wrapperIsToken0, balances, totalSupply, lp: { [OWNER]: ownerLp } }],
    })
  }

  it('wrapper as token0 vs token1 give identical underlying, shareBps and valueInBase', async () => {
    const balances = { base: 3_000_000_000_000_000_000_000n, wnft: 7_000_000_000_000_000_000_000n }
    const totalSupply = 1_000_000_000_000_000_000_000n
    const ownerLp = 40_000_000_000_000_000_000n
    const asToken0 = await positions(fixture(true, balances, totalSupply, ownerLp).ctx, OWNER)
    const asToken1 = await positions(fixture(false, balances, totalSupply, ownerLp).ctx, OWNER)
    expect(asToken0.positions[0]!.underlying).toStrictEqual(asToken1.positions[0]!.underlying)
    expect(asToken0.positions[0]!.shareBps).toBe(asToken1.positions[0]!.shareBps)
    expect(asToken0.positions[0]!.valueInBase).toStrictEqual(asToken1.positions[0]!.valueInBase)
  })

  it('property: for any balances/totalSupply/ownerLp, token0 vs token1 orientation agree (>=100 runs)', async () => {
    let runs = 0
    // Each run drives two full `positions()` calls (each several sequential mocked
    // multicall rounds, each awaiting one macrotask) — well past the 5s default.
    await fc.assert(
      fc.asyncProperty(
        fc.bigInt({ min: 1n, max: 10n ** 24n }),
        fc.bigInt({ min: 1n, max: 10n ** 24n }),
        fc.bigInt({ min: 1n, max: 10n ** 20n }),
        fc.integer({ min: 0, max: 10_000 }),
        async (base, wnft, totalSupply, ownerBps) => {
          runs++
          const ownerLp = (totalSupply * BigInt(ownerBps)) / 10_000n
          const r0 = await positions(fixture(true, { base, wnft }, totalSupply, ownerLp).ctx, OWNER)
          const r1 = await positions(fixture(false, { base, wnft }, totalSupply, ownerLp).ctx, OWNER)
          const p0 = r0.positions[0]
          const p1 = r1.positions[0]
          if (p0 === undefined || p1 === undefined) return ownerLp === 0n && p0 === undefined && p1 === undefined
          return (
            p0.underlying.base.value === p1.underlying.base.value &&
            p0.underlying.wnft.value === p1.underlying.wnft.value &&
            p0.shareBps === p1.shareBps &&
            p0.valueInBase.value === p1.valueInBase.value
          )
        },
      ),
      { numRuns: 100 },
    )
    expect(runs).toBeGreaterThanOrEqual(100)
  }, 30_000)
})

describe('positions — Arc (5042), the 6-decimal native pool axis', () => {
  it('baseToken and valueInBase are 6-decimal; valueUsd comes from getNativeUsd(5042)', async () => {
    const getNativeUsd = vi.fn(async (chainId: number) => (chainId === 5042 ? 1 : undefined))
    const totalSupply = 100_000_000n
    const env = buildPortfolioEnv({
      chainId: 5042,
      providers: { prices: { getNativeUsd } },
      pairs: [{ pair: testAddress(1), wrapper: testAddress(2), collection: testAddress(3), balances: { base: totalSupply, wnft: totalSupply }, totalSupply, lp: { [OWNER]: totalSupply } }],
    })
    const result = await positions(env.ctx, OWNER)
    const got = result.positions[0]!
    expect(got.baseToken.decimals).toBe(6)
    expect(got.valueInBase.decimals).toBe(6)
    expect(getNativeUsd).toHaveBeenCalledWith(5042)
    // valueInBase is 200 in 6-decimal base units (2 x the 100_000_000n full-share
    // underlying, formatted); the price is 1, so valueUsd is that same 200.
    expect(got.valueUsd).toBe(200)
  })
})

describe('positions — USD only from the partner provider', () => {
  function heldEnv(base: { readonly address: `0x${string}`; readonly decimals: number; readonly symbol: string } | null, providers: object) {
    const totalSupply = 100n
    return buildPortfolioEnv({
      providers,
      pairs: [{ pair: testAddress(1), wrapper: testAddress(2), collection: testAddress(3), base, balances: { base: totalSupply, wnft: totalSupply }, totalSupply, lp: { [OWNER]: totalSupply } }],
    })
  }

  it('a native base with getNativeUsd -> 2000 yields the expected valueUsd', async () => {
    const env = heldEnv(null, { prices: { getNativeUsd: async () => 2000 } })
    const result = await positions(env.ctx, OWNER)
    const got = result.positions[0]!
    expect(got.valueUsd).toBe(Number(formatUnits(got.valueInBase.value, 18)) * 2000)
  })

  it('an ERC-20 base without getTokenUsd yields undefined; with getTokenUsd -> 1 yields a number', async () => {
    const erc20 = { address: testAddress(77), decimals: 6, symbol: 'USDC' }
    const envNoTokenUsd = heldEnv(erc20, { prices: { getNativeUsd: async () => undefined } })
    const noPrice = await positions(envNoTokenUsd.ctx, OWNER)
    expect(noPrice.positions[0]!.valueUsd).toBeUndefined()

    const envWithTokenUsd = heldEnv(erc20, { prices: { getNativeUsd: async () => undefined, getTokenUsd: async () => 1 } })
    const withPrice = await positions(envWithTokenUsd.ctx, OWNER)
    expect(typeof withPrice.positions[0]!.valueUsd).toBe('number')
  })

  it('with no prices provider configured, valueUsd is undefined everywhere, never 0', async () => {
    const env = heldEnv(null, {})
    const result = await positions(env.ctx, OWNER)
    expect(result.positions[0]!.valueUsd).toBeUndefined()
  })
})

describe('positions — per-pair failure isolation', () => {
  it('a failScan pair lands in skipped as NO_ROUTE; the other position is still returned', async () => {
    const env = buildPortfolioEnv({
      pairs: [
        { pair: testAddress(1), wrapper: testAddress(2), collection: testAddress(3), failScan: true },
        { pair: testAddress(4), wrapper: testAddress(5), collection: testAddress(6), balances: { base: 10n, wnft: 10n }, totalSupply: 10n, lp: { [OWNER]: 10n } },
      ],
    })
    const result = await positions(env.ctx, OWNER)
    expect(result.skipped).toStrictEqual([{ pair: testAddress(1), code: 'NO_ROUTE' }])
    expect(result.positions).toHaveLength(1)
    expect(result.positions[0]!.pair.toLowerCase()).toBe(testAddress(4).toLowerCase())
  })

  it('a spoofed (factoryListed: false) pair lands in skipped as INVALID_PARAMS', async () => {
    const env = buildPortfolioEnv({
      pairs: [{ pair: testAddress(1), wrapper: testAddress(2), collection: testAddress(3), factoryListed: false, balances: { base: 10n, wnft: 10n }, totalSupply: 10n, lp: { [OWNER]: 10n } }],
    })
    const result = await positions(env.ctx, OWNER)
    expect(result.skipped).toStrictEqual([{ pair: testAddress(1), code: 'INVALID_PARAMS' }])
    expect(result.positions).toStrictEqual([])
  })

  it('a failLoad pair lands in skipped as NO_ROUTE', async () => {
    const env = buildPortfolioEnv({
      pairs: [{ pair: testAddress(1), wrapper: testAddress(2), collection: testAddress(3), failLoad: true, balances: { base: 10n, wnft: 10n }, totalSupply: 10n, lp: { [OWNER]: 10n } }],
    })
    const result = await positions(env.ctx, OWNER)
    expect(result.skipped).toStrictEqual([{ pair: testAddress(1), code: 'NO_ROUTE' }])
  })

  it('a non-zero Factory.feeTo() puts every held pair in skipped as QUOTE_RECONCILIATION_FAILED, no per-pair loads', async () => {
    const env = buildPortfolioEnv({
      feeTo: testAddress(1234),
      pairs: [
        { pair: testAddress(1), wrapper: testAddress(2), collection: testAddress(3), balances: { base: 10n, wnft: 10n }, totalSupply: 10n, lp: { [OWNER]: 10n } },
        { pair: testAddress(4), wrapper: testAddress(5), collection: testAddress(6), balances: { base: 10n, wnft: 10n }, totalSupply: 10n, lp: { [OWNER]: 10n } },
      ],
    })
    const result = await positions(env.ctx, OWNER)
    expect(result.positions).toStrictEqual([])
    expect([...result.skipped].sort((a, b) => a.pair.localeCompare(b.pair))).toStrictEqual(
      [
        { pair: testAddress(1), code: 'QUOTE_RECONCILIATION_FAILED' as const },
        { pair: testAddress(4), code: 'QUOTE_RECONCILIATION_FAILED' as const },
      ].sort((a, b) => a.pair.localeCompare(b.pair)),
    )
    // Only the scan multicall ran — no per-pair `loadPairState` round trips.
    expect(env.multicall).toHaveBeenCalledTimes(1)
  })

  it('a rejecting transport.pools rejects positions with the same error', async () => {
    const env = buildPortfolioEnv()
    const boom = new SnfError('UPSTREAM_DEGRADED', 'subgraph down')
    env.pools.mockImplementationOnce(async () => {
      throw boom
    })
    await expect(positions(env.ctx, OWNER)).rejects.toBe(boom)
  })
})

describe('positions — bounded concurrency', () => {
  it('with 10 held pairs, maxInFlight of per-pair loads never exceeds 4', async () => {
    const pairs = Array.from({ length: 10 }, (_, i) => ({
      pair: testAddress(1000 + i * 3),
      wrapper: testAddress(1001 + i * 3),
      collection: testAddress(1002 + i * 3),
      balances: { base: 10n, wnft: 10n },
      totalSupply: 10n,
      lp: { [OWNER]: 10n },
    }))
    const env = buildPortfolioEnv({ pairs })
    const result = await positions(env.ctx, OWNER)
    expect(result.positions).toHaveLength(10)
    expect(env.maxInFlight()).toBeLessThanOrEqual(4)
  })
})

describe('positions — ordering', () => {
  it('native-base first, then by base token address, then by valueInBase descending, ties by pair', async () => {
    const baseAaa = { address: testAddress(200), decimals: 6, symbol: 'AAA' }
    const baseBbb = { address: testAddress(300), decimals: 6, symbol: 'BBB' }
    const env = buildPortfolioEnv({
      pairs: [
        { pair: testAddress(11), wrapper: testAddress(12), collection: testAddress(13), balances: { base: 50n, wnft: 50n }, totalSupply: 50n, lp: { [OWNER]: 50n } }, // native, valueInBase 100
        { pair: testAddress(21), wrapper: testAddress(22), collection: testAddress(23), balances: { base: 100n, wnft: 100n }, totalSupply: 100n, lp: { [OWNER]: 100n } }, // native, valueInBase 200
        { pair: testAddress(31), wrapper: testAddress(32), collection: testAddress(33), base: baseAaa, balances: { base: 25n, wnft: 25n }, totalSupply: 25n, lp: { [OWNER]: 25n } }, // AAA, 50
        { pair: testAddress(41), wrapper: testAddress(42), collection: testAddress(43), base: baseAaa, balances: { base: 75n, wnft: 75n }, totalSupply: 75n, lp: { [OWNER]: 75n } }, // AAA, 150
        { pair: testAddress(51), wrapper: testAddress(52), collection: testAddress(53), base: baseBbb, balances: { base: 499n, wnft: 499n }, totalSupply: 499n, lp: { [OWNER]: 499n } }, // BBB, 998
      ],
    })
    const result = await positions(env.ctx, OWNER)
    const order = result.positions.map((p) => p.pair.toLowerCase())
    expect(order).toStrictEqual([
      testAddress(21).toLowerCase(),
      testAddress(11).toLowerCase(),
      testAddress(41).toLowerCase(),
      testAddress(31).toLowerCase(),
      testAddress(51).toLowerCase(),
    ])
  })

  it('ties within one base token are broken by pair address', async () => {
    const base = { address: testAddress(200), decimals: 6, symbol: 'AAA' }
    const env = buildPortfolioEnv({
      pairs: [
        { pair: testAddress(90), wrapper: testAddress(91), collection: testAddress(92), base, balances: { base: 10n, wnft: 10n }, totalSupply: 10n, lp: { [OWNER]: 10n } },
        { pair: testAddress(80), wrapper: testAddress(81), collection: testAddress(82), base, balances: { base: 10n, wnft: 10n }, totalSupply: 10n, lp: { [OWNER]: 10n } },
      ],
    })
    const result = await positions(env.ctx, OWNER)
    expect(result.positions.map((p) => p.pair.toLowerCase())).toStrictEqual([testAddress(80).toLowerCase(), testAddress(90).toLowerCase()])
  })
})

describe('positions — poolSet freshness echo', () => {
  it('echoes the pool set freshness', async () => {
    const env = buildPortfolioEnv({ asOfBlock: 42n, lagSeconds: 7, stale: true })
    const result = await positions(env.ctx, OWNER)
    expect(result.poolSet).toStrictEqual({ asOfBlock: 42n, lagSeconds: 7, stale: true })
  })
})
