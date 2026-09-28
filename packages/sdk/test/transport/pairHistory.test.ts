import type { PublicClient } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getChain } from '../../src/chains/registry'
import { createSnfClient } from '../../src/client'
import { isSnfError } from '../../src/errors'
import { createSubgraphTransport } from '../../src/transport/subgraph'
import type { SnfClientConfig } from '../../src/types/client.types'

/**
 * `createSubgraphTransport(...).pairHistory` — its own 300s TTL / 1500s SWR window,
 * its own cache key (chain, pair, interval, `first`), the `PAIR_HISTORY_DAY_QUERY` /
 * `PAIR_HISTORY_MONTH_QUERY` selection, and the same freshness grading every other
 * transport method already carries. Same fake-fetch / fake-timer style as
 * `subgraph.test.ts`, in its own file because this method's TTL is a fifth number the
 * other file's fixtures don't exercise.
 */

const fakePublicClient = undefined as unknown as PublicClient

const BASE_CHAIN_ID = 8453
const PAIR = '0xe6b215b3691b5b6c1a0cdeae93089777fe4979ed' as `0x${string}`

const NOW_MS = 1_735_689_600_000 // 2025-01-01T00:00:00.000Z

function config(overrides: Partial<SnfClientConfig> = {}): SnfClientConfig {
  return {
    chainId: BASE_CHAIN_ID,
    publicClient: fakePublicClient,
    ...overrides,
  }
}

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve(body),
  } as Response
}

const DEFAULT_PAIR = {
  id: PAIR,
  isNFTPool: true,
  discrete0: true,
  discrete1: false,
  token0: { id: '0x1111111111111111111111111111111111111111', symbol: 'WNFT', decimals: 18 },
  token1: { id: '0x2222222222222222222222222222222222222222', symbol: 'USDC', decimals: 6 },
}

function historyEnvelope(
  opts: {
    readonly lagSeconds?: number
    readonly hasIndexingErrors?: boolean
    readonly pair?: unknown
    readonly buckets?: readonly unknown[]
    readonly blockNumber?: number
  } = {},
): Response {
  const lagSeconds = opts.lagSeconds ?? 0
  // Computed fresh at CALL time, not once at module load — several TTL/SWR cases
  // here advance the fake clock past the freshness module's own degraded
  // threshold, and a fixture timestamp frozen at import time would make every
  // such call look artificially stale.
  const nowSeconds = Math.floor(Date.now() / 1000)
  return jsonResponse({
    data: {
      pair: opts.pair === undefined ? DEFAULT_PAIR : opts.pair,
      buckets: opts.buckets ?? [],
      _meta: {
        block: { number: opts.blockNumber ?? 100, timestamp: nowSeconds - lagSeconds },
        hasIndexingErrors: opts.hasIndexingErrors ?? false,
      },
    },
  })
}

function errorsEnvelope(message: string): Response {
  return jsonResponse({ errors: [{ message }] })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW_MS)
})

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('createSubgraphTransport().pairHistory — document selection', () => {
  it("interval 'day' POSTs once with the day document and lowercased id/pair/first variables", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(historyEnvelope()))
    vi.stubGlobal('fetch', fetchMock)
    const transport = createSubgraphTransport(config())

    const mixedCase = '0xE6b215b3691b5B6C1a0cDeae93089777fE4979eD' as `0x${string}`
    await transport.pairHistory(mixedCase, 'day', 90)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const call = fetchMock.mock.calls[0]
    const init = call?.[1] as RequestInit | undefined
    const body = JSON.parse(String(init?.body)) as { query: string; variables: { id: string; pair: string; first: number } }
    expect(body.query).toContain('PairHistoryDay')
    expect(body.query).toContain('pairDays')
    expect(body.variables).toEqual({ id: mixedCase.toLowerCase(), pair: mixedCase.toLowerCase(), first: 90 })
  })

  it("interval 'month' POSTs the month document", async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(historyEnvelope()))
    vi.stubGlobal('fetch', fetchMock)
    const transport = createSubgraphTransport(config())

    await transport.pairHistory(PAIR, 'month', 24)

    const call = fetchMock.mock.calls[0]
    const init = call?.[1] as RequestInit | undefined
    const body = JSON.parse(String(init?.body)) as { query: string }
    expect(body.query).toContain('PairHistoryMonth')
    expect(body.query).toContain('pairMonths')
  })

  it('neither document selects any *USD field', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(historyEnvelope()))
    vi.stubGlobal('fetch', fetchMock)
    const transport = createSubgraphTransport(config())

    await transport.pairHistory(PAIR, 'day', 90)
    await transport.pairHistory(PAIR, 'month', 24)

    for (const call of fetchMock.mock.calls) {
      const init = call[1] as RequestInit | undefined
      const body = JSON.parse(String(init?.body)) as { query: string }
      expect(body.query.toLowerCase()).not.toContain('usd')
    }
  })
})

describe('createSubgraphTransport().pairHistory — its own 300s TTL / 1500s SWR', () => {
  it('a second identical call inside 300_000ms makes no new fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(historyEnvelope()))
    vi.stubGlobal('fetch', fetchMock)
    const transport = createSubgraphTransport(config())

    await transport.pairHistory(PAIR, 'day', 90)
    vi.setSystemTime(NOW_MS + 299_999)
    await transport.pairHistory(PAIR, 'day', 90)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('past 300_000ms but inside 1_500_000ms returns the cached value with revalidating:true and fires exactly one background fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(historyEnvelope()))
    vi.stubGlobal('fetch', fetchMock)
    const transport = createSubgraphTransport(config())

    await transport.pairHistory(PAIR, 'day', 90)
    vi.setSystemTime(NOW_MS + 300_001)

    const second = await transport.pairHistory(PAIR, 'day', 90)
    expect(second.revalidating).toBe(true)

    const third = await transport.pairHistory(PAIR, 'day', 90) // same window — no second background call
    expect(third.revalidating).toBe(true)

    expect(fetchMock).toHaveBeenCalledTimes(2) // 1 initial + exactly 1 background revalidation
  })

  it('past both ttlMs and swrMs awaits a fresh fetch', async () => {
    let call = 0
    const fetchMock = vi.fn(() => {
      call += 1
      return Promise.resolve(historyEnvelope({ buckets: call === 1 ? [] : [{ t: 1, volume0: '1', volume1: '1', reserve0: '1', reserve1: '1', totalSupply: '1', txCount: '1' }] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const transport = createSubgraphTransport(config())

    const first = await transport.pairHistory(PAIR, 'day', 90)
    expect(first.data.buckets).toHaveLength(0)

    vi.setSystemTime(NOW_MS + 300_000 + 1_500_000 + 1)
    const second = await transport.pairHistory(PAIR, 'day', 90)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(second.data.buckets).toHaveLength(1) // proves it actually re-fetched
    expect(second.revalidating).toBe(false)
  })

  it('config.subgraph.historyTtlMs shortens the TTL', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(historyEnvelope()))
    vi.stubGlobal('fetch', fetchMock)
    const transport = createSubgraphTransport(config({ subgraph: { historyTtlMs: 60_000 } }))

    await transport.pairHistory(PAIR, 'day', 90)
    vi.setSystemTime(NOW_MS + 60_001 + 300_000 + 1) // past the shortened ttl + its own swr window
    await transport.pairHistory(PAIR, 'day', 90)

    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it.each([0, -1, Number.NaN])(
    'createSnfClient throws INVALID_PARAMS for config.subgraph.historyTtlMs = %s',
    (bad) => {
      expect(() =>
        createSnfClient({ chainId: BASE_CHAIN_ID, publicClient: { readContract: vi.fn(), multicall: vi.fn() } as unknown as PublicClient, subgraph: { historyTtlMs: bad } }),
      ).toThrow()
      try {
        createSnfClient({ chainId: BASE_CHAIN_ID, publicClient: { readContract: vi.fn(), multicall: vi.fn() } as unknown as PublicClient, subgraph: { historyTtlMs: bad } })
        expect.fail('expected createSnfClient to throw')
      } catch (e) {
        expect(isSnfError(e)).toBe(true)
        if (isSnfError(e)) expect(e.code).toBe('INVALID_PARAMS')
      }
    },
  )
})

describe('createSubgraphTransport().pairHistory — the cache key', () => {
  it('separates chain, pair (case-insensitive), interval and first: 3 distinct entries, 1 shared', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(historyEnvelope()))
    vi.stubGlobal('fetch', fetchMock)
    const transport = createSubgraphTransport(config())

    const lower = PAIR
    const upper = ('0x' + PAIR.slice(2).toUpperCase()) as `0x${string}`

    await transport.pairHistory(lower, 'day', 90)
    await transport.pairHistory(upper, 'day', 90) // same key as the lowercase call — no new fetch
    await transport.pairHistory(lower, 'month', 90) // distinct interval — new fetch
    await transport.pairHistory(lower, 'day', 30) // distinct first — new fetch

    expect(fetchMock).toHaveBeenCalledTimes(3)
  })
})

describe('createSubgraphTransport().pairHistory — freshness grading (unchanged rules)', () => {
  it('GraphQL errors ⇒ UPSTREAM_DEGRADED', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.resolve(errorsEnvelope('boom'))))
    const transport = createSubgraphTransport(config())

    await expect(transport.pairHistory(PAIR, 'day', 90)).rejects.toMatchObject({ code: 'UPSTREAM_DEGRADED' })
  })

  it('lag above the degraded threshold ⇒ UPSTREAM_DEGRADED', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.resolve(historyEnvelope({ lagSeconds: 901 }))))
    const transport = createSubgraphTransport(config())

    await expect(transport.pairHistory(PAIR, 'day', 90)).rejects.toMatchObject({ code: 'UPSTREAM_DEGRADED' })
  })

  it('hasIndexingErrors ⇒ stale:true', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.resolve(historyEnvelope({ hasIndexingErrors: true }))))
    const transport = createSubgraphTransport(config())

    const result = await transport.pairHistory(PAIR, 'day', 90)
    expect(result.stale).toBe(true)
  })

  it('a pair: null response is returned as data, with freshness — the caller decides it is invalid', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.resolve(historyEnvelope({ pair: null }))))
    const transport = createSubgraphTransport(config())

    const result = await transport.pairHistory(PAIR, 'day', 90)
    expect(result.data.pair).toBeNull()
    expect(result.stale).toBe(false)
  })
})

describe('createSubgraphTransport().pairHistory — instance isolation smoke test', () => {
  it('reuses the same getChain/subgraphUrl plumbing every other method uses', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(historyEnvelope()))
    vi.stubGlobal('fetch', fetchMock)
    const transport = createSubgraphTransport(config())

    await transport.pairHistory(PAIR, 'day', 90)

    expect(fetchMock.mock.calls[0]?.[0]).toBe(getChain(BASE_CHAIN_ID).subgraphUrl)
  })
})
