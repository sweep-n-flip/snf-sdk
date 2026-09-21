import type { PublicClient } from 'viem'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { getChain, SNF_CHAINS } from '../src/chains/registry'
import { createSnfClient } from '../src/client'
import { isSnfError } from '../src/errors'
import * as subgraphModule from '../src/transport/subgraph'
import type { SnfClientConfig } from '../src/types/client.types'
import type { SubgraphTransport } from '../src/transport/subgraph.types'

/**
 * `createSnfClient` — R3's own acceptance test (54-SPEC.md; T-54-42 in the threat
 * register): two clients, two chains, one page, zero cross-talk. Every `<behavior>`
 * bullet of plan 09's Task 1 is one `it` below.
 */

const BASE_CHAIN_ID = 8453
const ARBITRUM_CHAIN_ID = 42161

/** A minimal, well-typed stand-in `PublicClient` — `validateConfig` only checks that
 * `readContract`/`multicall` exist as functions; `estimateLadder`'s own test asserts
 * neither is ever actually called. */
function fakePublicClient(): PublicClient {
  return {
    readContract: vi.fn(),
    multicall: vi.fn(),
  } as unknown as PublicClient
}

function config(overrides: Partial<SnfClientConfig> = {}): SnfClientConfig {
  return {
    chainId: BASE_CHAIN_ID,
    publicClient: fakePublicClient(),
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

function metaEnvelope(): Response {
  const nowSeconds = Math.floor(Date.now() / 1000)
  return jsonResponse({
    data: { _meta: { block: { number: 1, timestamp: nowSeconds }, hasIndexingErrors: false } },
  })
}

/** The exact D-01 order: `chainId`, `chain`, then the thirteen methods as
 * `types/client.types.ts`'s `SnfClient` interface declares them. */
const D01_KEYS = [
  'chainId',
  'chain',
  'collection',
  'poolInventory',
  'quoteBuy',
  'quoteSell',
  'quoteNftToNft',
  'quoteSwap',
  'estimateLadder',
  'buildBuy',
  'buildSell',
  'buildNftToNft',
  'buildSwap',
  'parseReceipt',
  'describeError',
]

beforeEach(() => {
  vi.restoreAllMocks()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('createSnfClient — the object surface (D-01)', () => {
  it("own enumerable keys are exactly the 13 method names plus chainId and chain, in D-01's order", () => {
    const client = createSnfClient(config())
    expect(Object.keys(client)).toEqual(D01_KEYS)
  })

  it('chainId and chain reflect the requested chain', () => {
    const client = createSnfClient(config({ chainId: ARBITRUM_CHAIN_ID }))
    expect(client.chainId).toBe(ARBITRUM_CHAIN_ID)
    expect(client.chain.chainId).toBe(ARBITRUM_CHAIN_ID)
    expect(client.chain.name).toBe(getChain(ARBITRUM_CHAIN_ID).name)
  })

  it('client.chain is a frozen COPY of the registry entry — mutating it never affects SNF_CHAINS', () => {
    const client = createSnfClient(config())
    expect(Object.isFrozen(client.chain)).toBe(true)
    expect(() => {
      client.chain.name = 'tampered'
    }).toThrow()
    const registryEntry = SNF_CHAINS.find((c) => c.chainId === BASE_CHAIN_ID)
    expect(registryEntry?.name).not.toBe('tampered')
  })
})

describe('createSnfClient — construction-time validation', () => {
  it('throws SnfError(INVALID_PARAMS) for an unsupported chainId', () => {
    expect(() => createSnfClient(config({ chainId: 999_999 as unknown as SnfClientConfig['chainId'] }))).toThrow()
    try {
      createSnfClient(config({ chainId: 999_999 as unknown as SnfClientConfig['chainId'] }))
      expect.fail('expected createSnfClient to throw')
    } catch (e) {
      expect(isSnfError(e)).toBe(true)
      if (isSnfError(e)) expect(e.code).toBe('INVALID_PARAMS')
    }
  })

  it('throws SnfError(INVALID_PARAMS) naming the field when publicClient is missing', () => {
    try {
      createSnfClient({ chainId: BASE_CHAIN_ID } as unknown as SnfClientConfig)
      expect.fail('expected createSnfClient to throw')
    } catch (e) {
      expect(isSnfError(e)).toBe(true)
      if (isSnfError(e)) {
        expect(e.code).toBe('INVALID_PARAMS')
        expect(e.details).toMatchObject({ field: 'publicClient' })
      }
    }
  })

  it('throws SnfError(INVALID_PARAMS) when publicClient is missing readContract/multicall', () => {
    expect(() =>
      createSnfClient(config({ publicClient: {} as unknown as PublicClient })),
    ).toThrow()
  })

  it('throws SnfError(INVALID_PARAMS) for a non-positive subgraph override', () => {
    expect(() => createSnfClient(config({ subgraph: { ttlMs: 0 } }))).toThrow()
    expect(() => createSnfClient(config({ subgraph: { ttlMs: -1 } }))).toThrow()
    expect(() => createSnfClient(config({ subgraph: { ttlMs: Number.NaN } }))).toThrow()
  })

  it('throws SnfError(INVALID_PARAMS) for a non-positive defaults override', () => {
    expect(() => createSnfClient(config({ defaults: { slippageBps: -50 } }))).toThrow()
  })

  it('accepts a fully-valid config with subgraph/defaults overrides', () => {
    expect(() =>
      createSnfClient(config({ subgraph: { ttlMs: 30_000 }, defaults: { slippageBps: 50 } })),
    ).not.toThrow()
  })
})

describe('createSnfClient — pure methods bound without ctx', () => {
  it('describeError delegates to the pure describeError and needs no context', () => {
    const client = createSnfClient(config())
    const err = client.describeError(new Error('boom'))
    expect(isSnfError(err)).toBe(true)
  })

  it('estimateLadder delegates to the offline estimate layer and issues zero RPC calls', () => {
    const publicClient = fakePublicClient()
    const client = createSnfClient(config({ publicClient }))

    const result = client.estimateLadder({ base: 10n ** 18n, wnft: 10n * 10n ** 18n }, 3)

    expect(result.kind).toBe('estimate')
    expect(publicClient.readContract).not.toHaveBeenCalled()
    expect(publicClient.multicall).not.toHaveBeenCalled()
  })

  it('parseReceipt twice yields txInvalidationVersion 1 then 2 on the same client, and 1 then 2 independently on a second client', () => {
    const receipt = {
      status: 'success' as const,
      transactionHash: '0x1111111111111111111111111111111111111111111111111111111111111111' as `0x${string}`,
      blockNumber: 1n,
      logs: [],
    }
    const clientA = createSnfClient(config())
    const clientB = createSnfClient(config())

    expect(clientA.parseReceipt(receipt).txInvalidationVersion).toBe(1)
    expect(clientA.parseReceipt(receipt).txInvalidationVersion).toBe(2)
    expect(clientB.parseReceipt(receipt).txInvalidationVersion).toBe(1)
    expect(clientB.parseReceipt(receipt).txInvalidationVersion).toBe(2)
  })
})

describe('createSnfClient — R3 acceptance: two clients, two chains, one page, zero cross-talk', () => {
  it('a Base client and an Arbitrum client hit different subgraph URLs and different registry entries', () => {
    const a = createSnfClient(config({ chainId: BASE_CHAIN_ID }))
    const b = createSnfClient(config({ chainId: ARBITRUM_CHAIN_ID }))

    expect(a.chain.chainId).not.toBe(b.chain.chainId)
    expect(a.chain.subgraphUrl).not.toBe(b.chain.subgraphUrl)
  })

  it('two clients built from the same config have different transport instances: priming client A leaves client B\'s mocked fetch count at 0', async () => {
    const realCreateSubgraphTransport = subgraphModule.createSubgraphTransport
    const transports: SubgraphTransport[] = []
    vi.spyOn(subgraphModule, 'createSubgraphTransport').mockImplementation((cfg) => {
      const transport = realCreateSubgraphTransport(cfg)
      transports.push(transport)
      return transport
    })

    const callsByUrl = new Map<string, number>()
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input)
      callsByUrl.set(url, (callsByUrl.get(url) ?? 0) + 1)
      return metaEnvelope()
    })
    vi.stubGlobal('fetch', fetchMock)

    const baseUrl = getChain(BASE_CHAIN_ID).subgraphUrl
    const arbitrumUrl = getChain(ARBITRUM_CHAIN_ID).subgraphUrl

    createSnfClient(config({ chainId: BASE_CHAIN_ID }))
    createSnfClient(config({ chainId: ARBITRUM_CHAIN_ID }))

    expect(transports).toHaveLength(2)

    // Prime ONLY the Base transport (client A).
    await transports[0]?.meta()

    expect(callsByUrl.get(baseUrl) ?? 0).toBe(1)
    expect(callsByUrl.get(arbitrumUrl) ?? 0).toBe(0) // R3's literal acceptance criterion
  })
})
