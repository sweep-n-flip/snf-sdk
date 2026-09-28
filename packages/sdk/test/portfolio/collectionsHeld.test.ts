import { getAddress } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { collectionsHeld } from '../../src/portfolio/collectionsHeld'
import type { CollectionsHeld, CollectionsHeldAnswered } from '../../src/types/portfolio.types'
import { buildPortfolioEnv, testAddress } from './portfolioTestHelpers'

/**
 * `collectionsHeld(owner)` — the explicit no-provider `unavailable`, the on-chain
 * count as authority, provider id sanitisation, and the `partial`/`ok` status split.
 */

const OWNER = testAddress(999)

/** Narrows the `CollectionsHeld` union for tests that expect a provider was asked. */
function answered(result: CollectionsHeld): CollectionsHeldAnswered {
  if (result.status === 'unavailable') throw new Error('expected an answered result, got unavailable')
  return result
}

describe('collectionsHeld — no provider is explicit, never a silent empty list', () => {
  it('the default (no provider configured) resolves unavailable with zero I/O', async () => {
    const env = buildPortfolioEnv()
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const result = await collectionsHeld(env.ctx, OWNER)
    expect(result).toStrictEqual({ status: 'unavailable', reason: 'no-provider', chainId: env.ctx.chain.chainId, owner: getAddress(OWNER) })
    expect(env.pools).not.toHaveBeenCalled()
    expect(env.multicall).not.toHaveBeenCalled()
    expect(env.getBlockNumber).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('a context whose providers.walletNfts is literally missing also resolves unavailable', async () => {
    const env = buildPortfolioEnv()
    Object.assign(env.ctx.providers, { walletNfts: undefined })
    const result = await collectionsHeld(env.ctx, OWNER)
    expect(result.status).toBe('unavailable')
  })
})

describe('collectionsHeld — input validation', () => {
  it('a malformed owner rejects INVALID_PARAMS before anything else, even with a provider configured', async () => {
    const getWalletNfts = vi.fn()
    const env = buildPortfolioEnv({ providers: { walletNfts: { getWalletNfts } } })
    await expect(collectionsHeld(env.ctx, '0xbad' as `0x${string}`)).rejects.toMatchObject({ code: 'INVALID_PARAMS', details: { field: 'owner' } })
    expect(env.pools).not.toHaveBeenCalled()
    expect(env.multicall).not.toHaveBeenCalled()
    expect(getWalletNfts).not.toHaveBeenCalled()
  })
})

describe('collectionsHeld — an empty pool set', () => {
  it('resolves ok, collections: [], zero multicall, zero provider calls', async () => {
    const getWalletNfts = vi.fn()
    const env = buildPortfolioEnv({ providers: { walletNfts: { getWalletNfts } } })
    const result = await collectionsHeld(env.ctx, OWNER)
    expect(result).toMatchObject({ status: 'ok', collections: [], unanswered: [] })
    expect(env.multicall).not.toHaveBeenCalled()
    expect(getWalletNfts).not.toHaveBeenCalled()
    expect(env.getBlockNumber).toHaveBeenCalledTimes(1)
  })
})

describe('collectionsHeld — which collections are asked', () => {
  it('a BNB-shaped fixture (2 NFT pools + 7 delegated rows) asks only the 2 SnF collections', async () => {
    const c1 = testAddress(3)
    const c2 = testAddress(6)
    const getWalletNfts = vi.fn(async (_owner: `0x${string}`, _collection: `0x${string}`) => [] as readonly string[])
    const env = buildPortfolioEnv({
      chainId: 56,
      pairs: [
        { pair: testAddress(1), wrapper: testAddress(2), collection: c1 },
        { pair: testAddress(4), wrapper: testAddress(5), collection: c2 },
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
      providers: { walletNfts: { getWalletNfts } },
    })
    const result = await collectionsHeld(env.ctx, OWNER)
    expect(result.status).toBe('ok')
    expect(getWalletNfts).toHaveBeenCalledTimes(2)
    const asked = getWalletNfts.mock.calls.map((args) => String(args[1]).toLowerCase()).sort()
    expect(asked).toStrictEqual([c1.toLowerCase(), c2.toLowerCase()].sort())
  })

  it('getWalletNfts concurrency never exceeds 4', async () => {
    const pairs = Array.from({ length: 10 }, (_, i) => ({
      pair: testAddress(1000 + i * 3),
      wrapper: testAddress(1001 + i * 3),
      collection: testAddress(1002 + i * 3),
    }))
    let inFlight = 0
    let maxSeen = 0
    const getWalletNfts = vi.fn(async () => {
      inFlight += 1
      maxSeen = Math.max(maxSeen, inFlight)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      inFlight -= 1
      return []
    })
    const env = buildPortfolioEnv({ pairs, providers: { walletNfts: { getWalletNfts } } })
    await collectionsHeld(env.ctx, OWNER)
    expect(getWalletNfts).toHaveBeenCalledTimes(10)
    expect(maxSeen).toBeLessThanOrEqual(4)
  })
})

describe('collectionsHeld — the on-chain count is the authority', () => {
  it('count is the on-chain ERC721.balanceOf, one multicall, one block', async () => {
    const c1 = testAddress(3)
    const getWalletNfts = vi.fn(async () => ['1', '2'])
    const env = buildPortfolioEnv({
      pairs: [{ pair: testAddress(1), wrapper: testAddress(2), collection: c1 }],
      erc721: { [c1]: { [OWNER]: 7n } },
      providers: { walletNfts: { getWalletNfts } },
    })
    const result = answered(await collectionsHeld(env.ctx, OWNER))
    const held = result.collections[0]!
    expect(held.count).toBe(7)
    expect(held.countSource).toBe('on-chain')
    expect(held.tokenIds).toStrictEqual(['1', '2'])
    const erc721Calls = env.calls().filter((c) => c.functionName === 'balanceOf' && c.address.toLowerCase() === c1.toLowerCase())
    expect(erc721Calls).toHaveLength(1)
    expect(erc721Calls[0]!.blockNumber).toBe(result.blockNumber)
  })

  it('falls back to the sanitised provider id count, countSource provider, only when the on-chain read fails', async () => {
    const c1 = testAddress(3)
    const getWalletNfts = vi.fn(async () => ['1', '2', '2', 'bad', '3'])
    const env = buildPortfolioEnv({
      pairs: [{ pair: testAddress(1), wrapper: testAddress(2), collection: c1 }],
      failErc721: true,
      providers: { walletNfts: { getWalletNfts } },
    })
    const result = answered(await collectionsHeld(env.ctx, OWNER))
    const held = result.collections[0]!
    expect(held.countSource).toBe('provider')
    expect(held.count).toBe(3)
    expect(held.tokenIds).toStrictEqual(['1', '2', '3'])
  })

  it('on-chain count is authoritative even when the indexer lags and returns []', async () => {
    const c1 = testAddress(3)
    const getWalletNfts = vi.fn(async () => [])
    const env = buildPortfolioEnv({
      pairs: [{ pair: testAddress(1), wrapper: testAddress(2), collection: c1 }],
      erc721: { [c1]: { [OWNER]: 5n } },
      providers: { walletNfts: { getWalletNfts } },
    })
    const result = answered(await collectionsHeld(env.ctx, OWNER))
    expect(result.collections).toHaveLength(1)
    expect(result.collections[0]!.count).toBe(5)
    expect(result.collections[0]!.tokenIds).toStrictEqual([])
  })
})

describe('collectionsHeld — provider id sanitisation', () => {
  it('digits-only survive, normalised, de-duplicated, sorted ascending', async () => {
    const c1 = testAddress(3)
    const getWalletNfts = vi.fn(async () => ['5', 'not-a-number', '5', '3', '007', '10', '-1', '1.5'])
    const env = buildPortfolioEnv({
      pairs: [{ pair: testAddress(1), wrapper: testAddress(2), collection: c1 }],
      providers: { walletNfts: { getWalletNfts } },
    })
    const result = answered(await collectionsHeld(env.ctx, OWNER))
    expect(result.collections[0]!.tokenIds).toStrictEqual(['3', '5', '7', '10'])
    expect(result.collections[0]!.tokenIdsTruncated).toBe(false)
  })

  it('caps at 10,000 ids and sets tokenIdsTruncated', async () => {
    const c1 = testAddress(3)
    const raw = Array.from({ length: 10_005 }, (_, i) => String(i + 1))
    const getWalletNfts = vi.fn(async () => raw)
    const env = buildPortfolioEnv({
      pairs: [{ pair: testAddress(1), wrapper: testAddress(2), collection: c1 }],
      providers: { walletNfts: { getWalletNfts } },
    })
    const result = answered(await collectionsHeld(env.ctx, OWNER))
    const held = result.collections[0]!
    expect(held.tokenIds).toHaveLength(10_000)
    expect(held.tokenIdsTruncated).toBe(true)
    expect(held.tokenIds[0]).toBe('1')
    expect(held.tokenIds[9999]).toBe('10000')
  })
})

describe('collectionsHeld — status: ok vs partial', () => {
  it('a provider throw or undefined answer lands that collection in unanswered, status partial', async () => {
    const cThrow = testAddress(3)
    const cUndefined = testAddress(6)
    const cOk = testAddress(9)
    const getWalletNfts = vi.fn(async (_owner: `0x${string}`, collection: `0x${string}`) => {
      if (collection.toLowerCase() === cThrow.toLowerCase()) throw new Error('boom')
      if (collection.toLowerCase() === cUndefined.toLowerCase()) return undefined
      return ['1']
    })
    const env = buildPortfolioEnv({
      pairs: [
        { pair: testAddress(1), wrapper: testAddress(2), collection: cThrow },
        { pair: testAddress(4), wrapper: testAddress(5), collection: cUndefined },
        { pair: testAddress(7), wrapper: testAddress(8), collection: cOk },
      ],
      providers: { walletNfts: { getWalletNfts } },
    })
    const result = answered(await collectionsHeld(env.ctx, OWNER))
    expect(result.status).toBe('partial')
    expect([...result.unanswered].map((a) => a.toLowerCase()).sort()).toStrictEqual([cThrow.toLowerCase(), cUndefined.toLowerCase()].sort())
    expect(result.collections.map((c) => c.collection.toLowerCase())).toStrictEqual([cOk.toLowerCase()])
  })

  it('every collection answered ⇒ status ok, unanswered: []', async () => {
    const c1 = testAddress(3)
    const getWalletNfts = vi.fn(async () => ['1'])
    const env = buildPortfolioEnv({
      pairs: [{ pair: testAddress(1), wrapper: testAddress(2), collection: c1 }],
      providers: { walletNfts: { getWalletNfts } },
    })
    const result = answered(await collectionsHeld(env.ctx, OWNER))
    expect(result.status).toBe('ok')
    expect(result.unanswered).toStrictEqual([])
  })

  it('an answered collection with zero count and zero ids is omitted; all-answered-none-held ⇒ collections: [], status ok', async () => {
    const c1 = testAddress(3)
    const getWalletNfts = vi.fn(async () => [])
    const env = buildPortfolioEnv({
      pairs: [{ pair: testAddress(1), wrapper: testAddress(2), collection: c1 }],
      providers: { walletNfts: { getWalletNfts } },
    })
    const result = answered(await collectionsHeld(env.ctx, OWNER))
    expect(result.status).toBe('ok')
    expect(result.collections).toStrictEqual([])
  })
})

describe('collectionsHeld — labels, block pinning and poolSet freshness', () => {
  it('labels resolve via the subgraph waterfall; blockNumber and poolSet are echoed', async () => {
    const c1 = testAddress(3)
    const getWalletNfts = vi.fn(async () => ['1'])
    const env = buildPortfolioEnv({
      blockNumber: 999n,
      asOfBlock: 10n,
      lagSeconds: 2,
      stale: true,
      pairs: [{ pair: testAddress(1), wrapper: testAddress(2), collection: c1, subgraph: { collectionName: 'Cool Cats', collectionSymbol: 'COOL' } }],
      providers: { walletNfts: { getWalletNfts } },
    })
    const result = answered(await collectionsHeld(env.ctx, OWNER))
    expect(result.blockNumber).toBe(999n)
    expect(result.poolSet).toStrictEqual({ asOfBlock: 10n, lagSeconds: 2, stale: true })
    expect(result.collections[0]!.labels).toStrictEqual({ name: 'Cool Cats', symbol: 'COOL' })
  })
})
