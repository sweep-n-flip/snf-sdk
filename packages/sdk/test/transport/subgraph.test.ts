import type { PublicClient } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getChain } from '../../src/chains/registry'
import { isSnfError } from '../../src/errors'
import { createSubgraphTransport } from '../../src/transport/subgraph'
import type { SnfClientConfig } from '../../src/types/client.types'

// A fake but well-typed `PublicClient` stand-in, same pattern as
// test/types/contract.test.ts — the transport never reads it.
const fakePublicClient = undefined as unknown as PublicClient

const BASE_CHAIN_ID = 8453
const ARBITRUM_CHAIN_ID = 42161
const WRAPPER = '0x51b8000000000000000000000000000000a9f2ab' as `0x${string}`

/** Fixed epoch, ms — the fake system clock every test starts from. Individual cases
 * jump the clock via `vi.setSystemTime`, never `vi.advanceTimersByTime` or a real
 * `setTimeout`/sleep (this file's own no-sleep acceptance criterion). */
const NOW_MS = 1_735_689_600_000 // 2025-01-01T00:00:00.000Z
const NOW_SECONDS = Math.floor(NOW_MS / 1000)

function config(overrides: Partial<SnfClientConfig> = {}): SnfClientConfig {
  return {
    chainId: BASE_CHAIN_ID,
    publicClient: fakePublicClient,
    ...overrides,
  }
}

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number; statusText?: string } = {}): Response {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    json: () => Promise.resolve(body),
  } as Response
}

/** A `currency(id:...)` + `_meta` envelope at a controllable lag from the fake `now`. */
function currencyEnvelope(
  lagSeconds: number,
  opts: { hasIndexingErrors?: boolean; tokenIds?: readonly string[]; blockNumber?: number } = {},
): Response {
  return jsonResponse({
    data: {
      currency: {
        id: WRAPPER,
        symbol: 'WNFT',
        name: 'Wrapped NFT',
        decimals: 18,
        wrapping: true,
        tokenIds: opts.tokenIds ?? ['1', '2'],
        collection: null,
      },
      _meta: {
        block: { number: opts.blockNumber ?? 100, timestamp: NOW_SECONDS - lagSeconds },
        hasIndexingErrors: opts.hasIndexingErrors ?? false,
      },
    },
  })
}

function metaEnvelope(lagSeconds = 0): Response {
  return jsonResponse({
    data: { _meta: { block: { number: 100, timestamp: NOW_SECONDS - lagSeconds }, hasIndexingErrors: false } },
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

describe('createSubgraphTransport — acceptance matrix', () => {
  // ── 1. Dedupe ──────────────────────────────────────────────────────────────────────
  it('50 concurrent inventory() calls to the same key produce exactly 1 fetch; all 50 resolve to the same data', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(currencyEnvelope(0)))
    vi.stubGlobal('fetch', fetchMock)
    const transport = createSubgraphTransport(config())

    const results = await Promise.all(Array.from({ length: 50 }, () => transport.inventory(WRAPPER)))

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(results).toHaveLength(50)
    for (const result of results) {
      expect(result.data).toBe(results[0]?.data) // same underlying payload reference
      expect(result.stale).toBe(false)
    }
  })

  // ── 2. TTL hit ─────────────────────────────────────────────────────────────────────
  it('two sequential calls inside the TTL (30s inventory default) produce 1 fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(currencyEnvelope(0)))
    vi.stubGlobal('fetch', fetchMock)
    const transport = createSubgraphTransport(config())

    await transport.inventory(WRAPPER)
    vi.setSystemTime(NOW_MS + 5_000) // 5s later, still inside the 30s TTL
    await transport.inventory(WRAPPER)

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // ── 3. TTL miss (genuine hard miss, past ttlMs + swrMs) ──────────────────────────────
  it('a call past ttlMs AND the SWR window produces a second, awaited fetch', async () => {
    let call = 0
    const fetchMock = vi.fn(() => {
      call += 1
      return Promise.resolve(currencyEnvelope(0, { tokenIds: call === 1 ? ['1'] : ['1', '2', '3'] }))
    })
    vi.stubGlobal('fetch', fetchMock)
    const transport = createSubgraphTransport(config())

    const first = await transport.inventory(WRAPPER)
    expect(first.data?.tokenIds).toEqual(['1'])

    vi.setSystemTime(NOW_MS + 30_000 + 150_000 + 1) // past ttlMs(30s) + swrMs(30s*5=150s)
    const second = await transport.inventory(WRAPPER)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(second.data?.tokenIds).toEqual(['1', '2', '3']) // proves it actually re-fetched
    expect(second.revalidating).toBe(false)
  })

  // ── 4. SWR ─────────────────────────────────────────────────────────────────────────
  it('a call past ttlMs but inside the SWR window returns the cached value immediately with revalidating:true, firing exactly one background fetch', async () => {
    let call = 0
    const fetchMock = vi.fn(() => {
      call += 1
      return Promise.resolve(currencyEnvelope(0))
    })
    vi.stubGlobal('fetch', fetchMock)
    const transport = createSubgraphTransport(config())

    await transport.inventory(WRAPPER)
    vi.setSystemTime(NOW_MS + 31_000) // past 30s ttlMs, inside 150s swrMs

    const second = await transport.inventory(WRAPPER)
    expect(second.revalidating).toBe(true)

    const third = await transport.inventory(WRAPPER) // same window — no second background call
    expect(third.revalidating).toBe(true)

    expect(fetchMock).toHaveBeenCalledTimes(2) // 1 initial + exactly 1 background revalidation
  })

  // ── 5-8. Lag boundaries ───────────────────────────────────────────────────────────
  it('lag 300s ⇒ stale:false, lagSeconds:300 (fresh boundary, inclusive)', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.resolve(currencyEnvelope(300))))
    const transport = createSubgraphTransport(config())

    const result = await transport.inventory(WRAPPER)
    expect(result.stale).toBe(false)
    expect(result.lagSeconds).toBe(300)
  })

  it('lag 301s ⇒ stale:true', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.resolve(currencyEnvelope(301))))
    const transport = createSubgraphTransport(config())

    const result = await transport.inventory(WRAPPER)
    expect(result.stale).toBe(true)
    expect(result.lagSeconds).toBe(301)
  })

  it('lag 900s ⇒ stale:true (degraded boundary is inclusive on the stale side, not yet an error)', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.resolve(currencyEnvelope(900))))
    const transport = createSubgraphTransport(config())

    const result = await transport.inventory(WRAPPER)
    expect(result.stale).toBe(true)
    expect(result.lagSeconds).toBe(900)
  })

  it('lag 901s ⇒ rejects SnfError(UPSTREAM_DEGRADED) with details.lagSeconds === 901', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.resolve(currencyEnvelope(901))))
    const transport = createSubgraphTransport(config())

    try {
      await transport.inventory(WRAPPER)
      expect.unreachable('expected inventory() to reject')
    } catch (err) {
      expect(isSnfError(err)).toBe(true)
      if (isSnfError(err)) {
        expect(err.code).toBe('UPSTREAM_DEGRADED')
        expect(err.details?.lagSeconds).toBe(901)
      }
    }
  })

  // ── 9. hasIndexingErrors forces stale ─────────────────────────────────────────────
  it('hasIndexingErrors:true at lag 0 resolves with stale:true — never a clean stale:false', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.resolve(currencyEnvelope(0, { hasIndexingErrors: true }))))
    const transport = createSubgraphTransport(config())

    const result = await transport.inventory(WRAPPER)
    expect(result.lagSeconds).toBe(0)
    expect(result.stale).toBe(true)
  })

  // ── 10-13. Circuit breaker (uses meta(), which never caches, to isolate from TtlCache) ──
  it('breaker opens after 3 consecutive rejecting fetches; the 4th call rejects UPSTREAM_DEGRADED and issues NO request', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('network down')))
    vi.stubGlobal('fetch', fetchMock)
    const transport = createSubgraphTransport(config())

    for (let i = 0; i < 3; i++) {
      await expect(transport.meta()).rejects.toBeTruthy()
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)

    try {
      await transport.meta()
      expect.unreachable('expected the 4th call to reject')
    } catch (err) {
      expect(isSnfError(err)).toBe(true)
      if (isSnfError(err)) expect(err.code).toBe('UPSTREAM_DEGRADED')
    }
    expect(fetchMock).toHaveBeenCalledTimes(3) // still 3 — no request was issued
  })

  it('the breaker closes after 60s: the next call issues a request, and on success the following call issues another', async () => {
    let call = 0
    const fetchMock = vi.fn(() => {
      call += 1
      if (call <= 3) return Promise.reject(new Error('network down'))
      return Promise.resolve(metaEnvelope(0))
    })
    vi.stubGlobal('fetch', fetchMock)
    const transport = createSubgraphTransport(config())

    for (let i = 0; i < 3; i++) {
      await expect(transport.meta()).rejects.toBeTruthy()
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)

    vi.setSystemTime(NOW_MS + 60_000)
    await transport.meta() // half-open probe — succeeds, closes the breaker
    expect(fetchMock).toHaveBeenCalledTimes(4)

    await transport.meta() // breaker closed — a normal call, its own fresh request
    expect(fetchMock).toHaveBeenCalledTimes(5)
  })

  it('a failed half-open probe re-opens the breaker: the very next call issues no request', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('still down')))
    vi.stubGlobal('fetch', fetchMock)
    const transport = createSubgraphTransport(config())

    for (let i = 0; i < 3; i++) {
      await expect(transport.meta()).rejects.toBeTruthy()
    }
    expect(fetchMock).toHaveBeenCalledTimes(3)

    vi.setSystemTime(NOW_MS + 60_000)
    await expect(transport.meta()).rejects.toBeTruthy() // the probe itself fails
    expect(fetchMock).toHaveBeenCalledTimes(4)

    await expect(transport.meta()).rejects.toMatchObject({ code: 'UPSTREAM_DEGRADED' })
    expect(fetchMock).toHaveBeenCalledTimes(4) // no new request — breaker re-opened
  })

  it('a success resets the consecutive-failure counter: fail, fail, succeed, fail, fail never opens the breaker', async () => {
    const outcomes: readonly ('reject' | 'resolve')[] = [
      'reject',
      'reject',
      'resolve',
      'reject',
      'reject',
      'resolve',
    ]
    let call = 0
    const fetchMock = vi.fn(() => {
      const outcome = outcomes[call]
      call += 1
      return outcome === 'resolve' ? Promise.resolve(metaEnvelope(0)) : Promise.reject(new Error('flaky'))
    })
    vi.stubGlobal('fetch', fetchMock)
    const transport = createSubgraphTransport(config())

    await expect(transport.meta()).rejects.toBeTruthy() // fail (1)
    await expect(transport.meta()).rejects.toBeTruthy() // fail (2)
    await transport.meta() // succeed — resets the counter
    await expect(transport.meta()).rejects.toBeTruthy() // fail (1 again)
    await expect(transport.meta()).rejects.toBeTruthy() // fail (2 again)

    // A 6th call still issues a real request — the breaker never reached 3 consecutive,
    // so it never opened.
    await transport.meta()
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  // ── 14. HTTP 200 with errors ───────────────────────────────────────────────────────
  it('HTTP 200 with a GraphQL errors array and no data rejects UPSTREAM_DEGRADED, never resolves to undefined', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.resolve(errorsEnvelope('Type `Currency` has no field `notAField`'))))
    const transport = createSubgraphTransport(config())

    let resolved: unknown = 'unset'
    try {
      resolved = await transport.inventory(WRAPPER)
      expect.unreachable('expected inventory() to reject, not resolve')
    } catch (err) {
      expect(isSnfError(err)).toBe(true)
      if (isSnfError(err)) {
        expect(err.code).toBe('UPSTREAM_DEGRADED')
        expect(JSON.stringify(err.details)).toContain('notAField')
      }
    }
    expect(resolved).toBe('unset') // the catch branch ran; nothing was ever returned
  })

  // ── 15. Lowercase ids ──────────────────────────────────────────────────────────────
  it('a checksummed/mixed-case wrapper address is fully lowercased in the request body', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(currencyEnvelope(0)))
    vi.stubGlobal('fetch', fetchMock)
    const transport = createSubgraphTransport(config())

    const mixedCase = '0xAbC1230000000000000000000000000000dEF456' as `0x${string}`
    await transport.inventory(mixedCase)

    const call = fetchMock.mock.calls[0]
    const init = call?.[1] as RequestInit | undefined
    const body = JSON.parse(String(init?.body)) as { variables: { wrapper: string } }
    expect(body.variables.wrapper).toBe(mixedCase.toLowerCase())
  })

  // ── 16. Instance isolation ────────────────────────────────────────────────────
  it('two transports on two different chains share nothing and hit different URLs', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.resolve(currencyEnvelope(0)))
    vi.stubGlobal('fetch', fetchMock)

    const base = createSubgraphTransport(config({ chainId: BASE_CHAIN_ID }))
    const arbitrum = createSubgraphTransport(config({ chainId: ARBITRUM_CHAIN_ID }))

    await base.inventory(WRAPPER)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]?.[0]).toBe(getChain(BASE_CHAIN_ID).subgraphUrl)

    await arbitrum.inventory(WRAPPER) // does NOT reuse base's cache
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]?.[0]).toBe(getChain(ARBITRUM_CHAIN_ID).subgraphUrl)
    expect(fetchMock.mock.calls[1]?.[0]).not.toBe(fetchMock.mock.calls[0]?.[0])

    await base.inventory(WRAPPER) // still inside base's own TTL — no 3rd request
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  // ── 17. Config override ────────────────────────────────────────────────────────────
  it('an overridden staleLagSeconds is honored — 11s is stale when the threshold is set to 10', async () => {
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(() => Promise.resolve(currencyEnvelope(11))))
    const transport = createSubgraphTransport(config({ subgraph: { staleLagSeconds: 10 } }))

    const result = await transport.inventory(WRAPPER)
    expect(result.stale).toBe(true)
    expect(result.lagSeconds).toBe(11)
  })
})
