import { describe, expect, it, vi } from 'vitest'

import { resolveLabels } from '../../src/portfolio/labels'
import { mapWithConcurrency, normalizeAddress } from '../../src/portfolio/shared'
import { readUsdPrices, toUsd } from '../../src/portfolio/usd'
import { isSnfError, SnfError } from '../../src/errors'
import { NO_PROVIDER } from '../../src/providers/defaults'
import type { SnfClientContext } from '../../src/types/client.types'
import type { TokenRef } from '../../src/types/amount.types'
import { buildPortfolioEnv, testAddress } from './portfolioTestHelpers'

/**
 * `shared.ts`, `usd.ts` and `labels.ts` — the small helpers `positions` (and later
 * `wnftBalances`/`collectionsHeld`) all reuse.
 */

describe('mapWithConcurrency', () => {
  it('preserves input order and never runs more than `limit` calls at once', async () => {
    const items = Array.from({ length: 10 }, (_, i) => i)
    let inFlight = 0
    let maxSeen = 0
    const started: number[] = []
    const result = await mapWithConcurrency(items, 4, async (item) => {
      inFlight += 1
      maxSeen = Math.max(maxSeen, inFlight)
      started.push(item)
      await new Promise<void>((resolve) => setTimeout(resolve, 0))
      inFlight -= 1
      return item * 10
    })
    expect(result).toStrictEqual(items.map((i) => i * 10))
    expect(maxSeen).toBeLessThanOrEqual(4)
    expect(maxSeen).toBeGreaterThan(1)
  })

  it('an empty input resolves to an empty array with zero calls', async () => {
    const fn = vi.fn(async (x: number) => x)
    const result = await mapWithConcurrency([], 4, fn)
    expect(result).toStrictEqual([])
    expect(fn).not.toHaveBeenCalled()
  })
})

describe('normalizeAddress', () => {
  it('throws INVALID_PARAMS naming the field for a malformed address', () => {
    let threw: unknown
    try {
      normalizeAddress('0x123', 'owner')
    } catch (e) {
      threw = e
    }
    expect(isSnfError(threw)).toBe(true)
    expect((threw as SnfError).code).toBe('INVALID_PARAMS')
    expect((threw as SnfError).details?.field).toBe('owner')
  })

  it('accepts the zero address and returns it checksummed', () => {
    const result = normalizeAddress('0x0000000000000000000000000000000000000000', 'owner')
    expect(result).toBe('0x0000000000000000000000000000000000000000')
  })

  it('checksums a well-formed lowercase address', () => {
    const result = normalizeAddress(testAddress(1).toLowerCase(), 'owner')
    expect(result.toLowerCase()).toBe(testAddress(1).toLowerCase())
  })
})

function nativeToken(): TokenRef {
  return { address: testAddress(9), symbol: 'ETH', decimals: 18, isNative: true }
}
function erc20Token(): TokenRef {
  return { address: testAddress(10), symbol: 'USDC', decimals: 6, isNative: false }
}

describe('readUsdPrices / toUsd', () => {
  it('a native token asks getNativeUsd(chainId) exactly once even when listed twice', async () => {
    const getNativeUsd = vi.fn(async () => 2000)
    const env = buildPortfolioEnv({ providers: { prices: { getNativeUsd } } })
    const token = nativeToken()
    const prices = await readUsdPrices(env.ctx, [token, token])
    expect(getNativeUsd).toHaveBeenCalledTimes(1)
    expect(prices.get(token.address!.toLowerCase())).toBe(2000)
  })

  it('an ERC-20 token asks getTokenUsd when the provider defines it, and is undefined when it does not', async () => {
    const getTokenUsd = vi.fn(async () => 1.5)
    const env = buildPortfolioEnv({ providers: { prices: { getNativeUsd: async () => undefined, getTokenUsd } } })
    const token = erc20Token()
    const prices = await readUsdPrices(env.ctx, [token])
    expect(getTokenUsd).toHaveBeenCalledWith(env.ctx.chain.chainId, token.address)
    expect(prices.get(token.address!.toLowerCase())).toBe(1.5)

    const envNoTokenUsd = buildPortfolioEnv({ providers: { prices: { getNativeUsd: async () => undefined } } })
    const pricesNone = await readUsdPrices(envNoTokenUsd.ctx, [token])
    expect(pricesNone.get(token.address!.toLowerCase())).toBeUndefined()
  })

  it.each([
    ['a throw', () => Promise.reject(new Error('boom'))],
    ['undefined', async () => undefined],
    ['NaN', async () => Number.NaN],
    ['Infinity', async () => Number.POSITIVE_INFINITY],
    ['zero', async () => 0],
    ['negative', async () => -5],
  ])('%s from getNativeUsd yields undefined, never a number', async (_label, getNativeUsd) => {
    const env = buildPortfolioEnv({ providers: { prices: { getNativeUsd } } })
    const prices = await readUsdPrices(env.ctx, [nativeToken()])
    expect(prices.get(nativeToken().address!.toLowerCase())).toBeUndefined()
  })

  it('with NO_PROVIDER, no provider method ever returns a number', async () => {
    const env = buildPortfolioEnv({ providers: { prices: NO_PROVIDER } })
    const prices = await readUsdPrices(env.ctx, [nativeToken(), erc20Token()])
    expect(Array.from(prices.values())).toStrictEqual([undefined, undefined])
  })

  it('toUsd multiplies the formatted amount by the price, and is undefined when the price is', () => {
    const amount = { value: 15n * 10n ** 17n, formatted: '1.5', symbol: 'ETH', decimals: 18 }
    expect(toUsd(amount, 2)).toBe(3)
    expect(toUsd(amount, undefined)).toBeUndefined()
  })
})

type MulticallParams = { readonly contracts: readonly unknown[]; readonly blockNumber?: bigint }
function labelsCtx(multicallImpl: (params: MulticallParams) => Promise<readonly { readonly status: 'success' | 'failure'; readonly result?: unknown }[]>): SnfClientContext {
  return {
    chain: { multicall3: testAddress(50) },
    publicClient: { multicall: vi.fn(multicallImpl) },
  } as unknown as SnfClientContext
}

describe('resolveLabels', () => {
  it('a usable subgraph name resolves with zero multicall calls', async () => {
    const multicall = vi.fn()
    const ctx = labelsCtx(multicall)
    const result = await resolveLabels(ctx, [{ collection: testAddress(1), subgraphName: 'Rasta', subgraphSymbol: 'RASTA' }], 777n)
    expect(multicall).not.toHaveBeenCalled()
    expect(result.get(testAddress(1).toLowerCase())).toStrictEqual({ name: 'Rasta', symbol: 'RASTA' })
  })

  it('an unusable subgraph name triggers ONE multicall of name()/symbol(), pinned to the block, only for those collections', async () => {
    const multicall = vi.fn(async (params: MulticallParams) => {
      expect(params.blockNumber).toBe(555n)
      return [
        { status: 'success' as const, result: 'Real Name' },
        { status: 'success' as const, result: 'REAL' },
      ]
    })
    const ctx = labelsCtx(multicall)
    const result = await resolveLabels(
      ctx,
      [
        { collection: testAddress(1), subgraphName: 'Good', subgraphSymbol: 'GOOD' },
        { collection: testAddress(2), subgraphName: undefined, subgraphSymbol: undefined },
      ],
      555n,
    )
    expect(multicall).toHaveBeenCalledTimes(1)
    const call = multicall.mock.calls[0]![0] as { contracts: readonly { address: string }[] }
    expect(call.contracts).toHaveLength(2)
    expect(call.contracts.every((c) => c.address.toLowerCase() === testAddress(2).toLowerCase())).toBe(true)
    expect(result.get(testAddress(2).toLowerCase())).toStrictEqual({ name: 'Real Name', symbol: 'REAL' })
  })

  it('when every source is unusable the label is a shortened address, never the full address', async () => {
    const ctx = labelsCtx(async () => [{ status: 'failure' }, { status: 'failure' }])
    const result = await resolveLabels(ctx, [{ collection: testAddress(3) }], 1n)
    const label = result.get(testAddress(3).toLowerCase())
    expect(label?.name).not.toBe(testAddress(3))
    expect(label?.name).toMatch(/^0x.{4}\.\.\..{4}$/)
  })

  it('a thrown label multicall still resolves — fallback labels, never a rejected read', async () => {
    const ctx = labelsCtx(async () => {
      throw new Error('rpc down')
    })
    const result = await resolveLabels(ctx, [{ collection: testAddress(4) }], 1n)
    expect(result.get(testAddress(4).toLowerCase())?.name).toMatch(/^0x.{4}\.\.\..{4}$/)
  })
})
