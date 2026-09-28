import { formatUnits } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { wnftBalances } from '../../src/portfolio/wnftBalances'
import { buildPortfolioEnv, testAddress } from './portfolioTestHelpers'

/**
 * `wnftBalances(owner)` — the round-1/round-2 shape, the wrapper-identity gate, mid
 * valuation against the native pool only, and the Arc unit axis.
 */

const OWNER = testAddress(999)

describe('wnftBalances — input validation', () => {
  it('a malformed owner rejects INVALID_PARAMS with zero transport/RPC calls', async () => {
    const env = buildPortfolioEnv()
    await expect(wnftBalances(env.ctx, '0xbad' as `0x${string}`)).rejects.toMatchObject({ code: 'INVALID_PARAMS', details: { field: 'owner' } })
    expect(env.pools).not.toHaveBeenCalled()
    expect(env.multicall).not.toHaveBeenCalled()
    expect(env.getBlockNumber).not.toHaveBeenCalled()
  })

  it('the zero address is accepted', async () => {
    const env = buildPortfolioEnv()
    const result = await wnftBalances(env.ctx, '0x0000000000000000000000000000000000000000')
    expect(result.holdings).toStrictEqual([])
  })
})

describe('wnftBalances — pool set shape', () => {
  it('an empty pool set returns holdings: [] with zero multicalls', async () => {
    const env = buildPortfolioEnv()
    const result = await wnftBalances(env.ctx, OWNER)
    expect(result.holdings).toStrictEqual([])
    expect(env.multicall).not.toHaveBeenCalled()
  })

  it('two pools sharing one wrapper (native + ERC-20 base) issue ONE balanceOf read and at most one holding', async () => {
    const wrapper = testAddress(2)
    const collection = testAddress(3)
    const erc20Base = { address: testAddress(50), decimals: 6, symbol: 'USDC' }
    const env = buildPortfolioEnv({
      pairs: [
        { pair: testAddress(1), wrapper, collection, reserves: { base: 1000n, wnft: 250n } },
        { pair: testAddress(4), wrapper, collection, base: erc20Base },
      ],
      wnft: { [wrapper]: { [OWNER]: 100n } },
    })
    const result = await wnftBalances(env.ctx, OWNER)
    const wrapperBalanceCalls = env.calls().filter((c) => c.address.toLowerCase() === wrapper.toLowerCase() && c.functionName === 'balanceOf')
    expect(wrapperBalanceCalls).toHaveLength(1)
    expect(result.holdings).toHaveLength(1)
    expect(result.holdings[0]!.valueInBase!.value).toBe(400n) // 100 * 1000 / 250, priced against the native pool only
  })

  it('round 1 is one multicall with 2 contracts per distinct wrapper; a zero-balance wrapper is omitted, never skipped, never read in round 2', async () => {
    const heldWrapper = testAddress(2)
    const zeroWrapper = testAddress(5)
    const env = buildPortfolioEnv({
      pairs: [
        { pair: testAddress(1), wrapper: heldWrapper, collection: testAddress(3) },
        { pair: testAddress(4), wrapper: zeroWrapper, collection: testAddress(6) },
      ],
      wnft: { [heldWrapper]: { [OWNER]: 10n } },
    })
    const result = await wnftBalances(env.ctx, OWNER)
    expect(env.multicall.mock.calls[0]![0].contracts).toHaveLength(4)
    expect(result.skipped).toStrictEqual([])
    expect(result.holdings).toHaveLength(1)
    expect(result.holdings[0]!.wrapper.toLowerCase()).toBe(heldWrapper.toLowerCase())
    const zeroWrapperCalls = env.calls().filter((c) => c.address.toLowerCase() === zeroWrapper.toLowerCase())
    expect(zeroWrapperCalls.map((c) => c.functionName)).toStrictEqual(['balanceOf'])
  })
})

describe('wnftBalances — the identity gate', () => {
  it('a zero or mismatched on-chain collection skips WRAPPER_UNVERIFIED; an unreadable balanceOf skips NO_ROUTE', async () => {
    const wrapperZero = testAddress(2)
    const wrapperMismatch = testAddress(5)
    const wrapperBadRead = testAddress(8)
    const env = buildPortfolioEnv({
      pairs: [
        { pair: testAddress(1), wrapper: wrapperZero, collection: testAddress(3) },
        { pair: testAddress(4), wrapper: wrapperMismatch, collection: testAddress(6) },
        { pair: testAddress(7), wrapper: wrapperBadRead, collection: testAddress(9) },
      ],
      wnft: {
        [wrapperZero]: { [OWNER]: 10n },
        [wrapperMismatch]: { [OWNER]: 10n },
        [wrapperBadRead]: { [OWNER]: 10n },
      },
      factoryCollection: {
        [wrapperZero]: '0x0000000000000000000000000000000000000000',
        [wrapperMismatch]: testAddress(999),
      },
      failWnftBalanceOf: [wrapperBadRead],
    })
    const result = await wnftBalances(env.ctx, OWNER)
    expect(result.holdings).toStrictEqual([])
    expect([...result.skipped].sort((a, b) => a.wrapper.localeCompare(b.wrapper))).toStrictEqual(
      [
        { wrapper: wrapperZero, code: 'WRAPPER_UNVERIFIED' as const },
        { wrapper: wrapperMismatch, code: 'WRAPPER_UNVERIFIED' as const },
        { wrapper: wrapperBadRead, code: 'NO_ROUTE' as const },
      ].sort((a, b) => a.wrapper.localeCompare(b.wrapper)),
    )
  })

  it('decimals() !== 18 skips WRAPPER_UNVERIFIED even when the collection identity checks out', async () => {
    const wrapper = testAddress(2)
    const env = buildPortfolioEnv({
      pairs: [{ pair: testAddress(1), wrapper, collection: testAddress(3) }],
      wnft: { [wrapper]: { [OWNER]: 10n } },
      wrapperDecimals: 17,
    })
    const result = await wnftBalances(env.ctx, OWNER)
    expect(result.skipped).toStrictEqual([{ wrapper, code: 'WRAPPER_UNVERIFIED' }])
    expect(result.holdings).toStrictEqual([])
  })
})

describe('wnftBalances — mid valuation against the native pool only', () => {
  function nativeFixture(wrapperIsToken0: boolean) {
    const wrapper = testAddress(2)
    const collection = testAddress(3)
    const pair = testAddress(1)
    return buildPortfolioEnv({
      pairs: [{ pair, wrapper, collection, wrapperIsToken0, reserves: { base: 1000n, wnft: 250n } }],
      wnft: { [wrapper]: { [OWNER]: 100n } },
    })
  }

  it('values correctly regardless of wrapper token0/token1 orientation', async () => {
    for (const flag of [true, false]) {
      const env = nativeFixture(flag)
      const result = await wnftBalances(env.ctx, OWNER)
      expect(result.holdings).toHaveLength(1)
      expect(result.holdings[0]!.valueInBase!.value).toBe(400n)
    }
  })

  it('no native-base pool entry for the wrapper ⇒ valueInBase and valueUsd are undefined', async () => {
    const wrapper = testAddress(2)
    const erc20Base = { address: testAddress(50), decimals: 6, symbol: 'USDC' }
    const env = buildPortfolioEnv({
      pairs: [{ pair: testAddress(1), wrapper, collection: testAddress(3), base: erc20Base }],
      wnft: { [wrapper]: { [OWNER]: 10n } },
    })
    const result = await wnftBalances(env.ctx, OWNER)
    expect(result.holdings).toHaveLength(1)
    expect(result.holdings[0]!.valueInBase).toBeUndefined()
    expect(result.holdings[0]!.valueUsd).toBeUndefined()
  })

  it("the Factory's native pair must equal the pool-set candidate — a delisted/spoofed candidate leaves valueInBase undefined", async () => {
    const wrapper = testAddress(2)
    const env = buildPortfolioEnv({
      pairs: [{ pair: testAddress(1), wrapper, collection: testAddress(3), factoryListed: false, reserves: { base: 1000n, wnft: 250n } }],
      wnft: { [wrapper]: { [OWNER]: 10n } },
    })
    const result = await wnftBalances(env.ctx, OWNER)
    expect(result.holdings[0]!.valueInBase).toBeUndefined()
  })

  it('a zero wNFT reserve on the native pair leaves valueInBase undefined (no division by zero)', async () => {
    const wrapper = testAddress(2)
    const env = buildPortfolioEnv({
      pairs: [{ pair: testAddress(1), wrapper, collection: testAddress(3), reserves: { base: 1000n, wnft: 0n } }],
      wnft: { [wrapper]: { [OWNER]: 10n } },
    })
    const result = await wnftBalances(env.ctx, OWNER)
    expect(result.holdings[0]!.valueInBase).toBeUndefined()
  })
})

describe('wnftBalances — Arc (5042), the 6-decimal native pool axis', () => {
  it('valueInBase is 6-decimal in the chain native symbol; balance stays 18-decimal wNFT', async () => {
    const wrapper = testAddress(2)
    const env = buildPortfolioEnv({
      chainId: 5042,
      pairs: [{ pair: testAddress(1), wrapper, collection: testAddress(3), reserves: { base: 1_000_000n, wnft: 500n } }],
      wnft: { [wrapper]: { [OWNER]: 10n } },
    })
    const result = await wnftBalances(env.ctx, OWNER)
    const holding = result.holdings[0]!
    expect(holding.balance.decimals).toBe(18)
    expect(holding.balance.symbol).toBe('wNFT')
    expect(holding.valueInBase!.decimals).toBe(6)
    expect(holding.valueInBase!.symbol).toBe('USDC')
  })
})

describe('wnftBalances — balance shape', () => {
  it('balance is an 18-decimal wNFT Amount; nftWhole floors to whole units; valuation is mid', async () => {
    const wrapper = testAddress(2)
    const bal = 2_700_000_000_000_000_000n // 2.7e18
    const env = buildPortfolioEnv({
      pairs: [{ pair: testAddress(1), wrapper, collection: testAddress(3) }],
      wnft: { [wrapper]: { [OWNER]: bal } },
    })
    const result = await wnftBalances(env.ctx, OWNER)
    const holding = result.holdings[0]!
    expect(holding.balance.value).toBe(bal)
    expect(holding.balance.decimals).toBe(18)
    expect(holding.balance.symbol).toBe('wNFT')
    expect(holding.nftWhole).toBe(2)
    expect(holding.valuation).toBe('mid')
  })
})

describe('wnftBalances — USD only from the partner provider', () => {
  it('valueUsd = toUsd(valueInBase, getNativeUsd); undefined with no prices provider configured', async () => {
    const wrapper = testAddress(2)
    const pairCfg = { pair: testAddress(1), wrapper, collection: testAddress(3), reserves: { base: 1000n, wnft: 100n } }

    const envNoProvider = buildPortfolioEnv({ pairs: [pairCfg], wnft: { [wrapper]: { [OWNER]: 10n } } })
    const noProvider = await wnftBalances(envNoProvider.ctx, OWNER)
    expect(noProvider.holdings[0]!.valueUsd).toBeUndefined()

    const getNativeUsd = vi.fn(async () => 3)
    const envWithProvider = buildPortfolioEnv({
      pairs: [pairCfg],
      wnft: { [wrapper]: { [OWNER]: 10n } },
      providers: { prices: { getNativeUsd } },
    })
    const withProvider = await wnftBalances(envWithProvider.ctx, OWNER)
    const value = withProvider.holdings[0]!.valueInBase!
    expect(withProvider.holdings[0]!.valueUsd).toBe(Number(formatUnits(value.value, value.decimals)) * 3)
    expect(getNativeUsd).toHaveBeenCalled()
  })
})

describe('wnftBalances — ordering', () => {
  it('sorted by balance.value descending, ties broken by wrapper address', async () => {
    const wA = testAddress(20)
    const wB = testAddress(5)
    const wC = testAddress(30)
    const env = buildPortfolioEnv({
      pairs: [
        { pair: testAddress(1), wrapper: wA, collection: testAddress(2) },
        { pair: testAddress(3), wrapper: wB, collection: testAddress(4) },
        { pair: testAddress(6), wrapper: wC, collection: testAddress(7) },
      ],
      wnft: {
        [wA]: { [OWNER]: 100n },
        [wB]: { [OWNER]: 100n },
        [wC]: { [OWNER]: 50n },
      },
    })
    const result = await wnftBalances(env.ctx, OWNER)
    expect(result.holdings.map((h) => h.wrapper.toLowerCase())).toStrictEqual([wB.toLowerCase(), wA.toLowerCase(), wC.toLowerCase()])
  })
})

describe('wnftBalances — block pinning and poolSet freshness', () => {
  it('every recorded multicall carries the pinned block; poolSet freshness is echoed', async () => {
    const wrapper = testAddress(2)
    const env = buildPortfolioEnv({
      blockNumber: 55_555n,
      asOfBlock: 40n,
      lagSeconds: 3,
      stale: true,
      pairs: [{ pair: testAddress(1), wrapper, collection: testAddress(3) }],
      wnft: { [wrapper]: { [OWNER]: 10n } },
    })
    const result = await wnftBalances(env.ctx, OWNER)
    expect(result.blockNumber).toBe(55_555n)
    expect(result.poolSet).toStrictEqual({ asOfBlock: 40n, lagSeconds: 3, stale: true })
    for (const call of env.calls()) expect(call.blockNumber).toBe(55_555n)
  })
})
