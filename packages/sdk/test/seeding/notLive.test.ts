import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { getAddress } from 'viem'
import type { PublicClient } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { SNF_CHAIN_IDS, getChain } from '../../src/chains/registry'
import { isSnfError, SnfError } from '../../src/errors'
import { attestation, seeding } from '../../src/seeding/seeding'
import type { SnfClientContext } from '../../src/types/client.types'

/**
 * `seeding` / `attestation` throw `PRODUCT_NOT_LIVE` on every chain, uniformly — no
 * seeding contract is deployed or audited anywhere yet, so there is nothing to
 * branch on per chain. Both make zero RPC calls, and neither reads a contract ABI.
 */

const ADDRESS_RE = /0x[0-9a-fA-F]{40}/

function buildCtx(chainId: number): { readonly ctx: SnfClientContext; readonly publicClient: PublicClient } {
  const chain = getChain(chainId)
  const publicClient = {
    multicall: vi.fn(),
    simulateContract: vi.fn(),
    estimateContractGas: vi.fn(),
    getBlockNumber: vi.fn(),
    getBalance: vi.fn(),
    readContract: vi.fn(),
  } as unknown as PublicClient
  const ctx = {
    config: { chainId: chain.chainId, publicClient },
    chain,
    publicClient,
    providers: {},
    transport: {} as SnfClientContext['transport'],
    nextTxInvalidationVersion: () => 1,
  } as unknown as SnfClientContext
  return { ctx, publicClient }
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

describe('seeding / attestation — PRODUCT_NOT_LIVE on every chain, zero RPC calls', () => {
  it.each(SNF_CHAIN_IDS)('chain %s: seeding() rejects PRODUCT_NOT_LIVE with details', async (chainId) => {
    const { ctx, publicClient } = buildCtx(chainId)
    const collection = getAddress('0x0000000000000000000000000000000000c011ec')
    const { error } = await expectRejectsWithCode(seeding(ctx, collection), 'PRODUCT_NOT_LIVE')
    expect(error.details?.chainId).toBe(chainId)
    expect(error.details?.collection).toBe(collection)
    expect(error.details?.surface).toBe('seeding')
    expect(publicClient.multicall).not.toHaveBeenCalled()
    expect(publicClient.simulateContract).not.toHaveBeenCalled()
    expect(publicClient.readContract).not.toHaveBeenCalled()
  })

  it.each(SNF_CHAIN_IDS)('chain %s: attestation() rejects PRODUCT_NOT_LIVE with details', async (chainId) => {
    const { ctx, publicClient } = buildCtx(chainId)
    const collection = getAddress('0x0000000000000000000000000000000000c011ec')
    const { error } = await expectRejectsWithCode(attestation(ctx, collection), 'PRODUCT_NOT_LIVE')
    expect(error.details?.chainId).toBe(chainId)
    expect(error.details?.collection).toBe(collection)
    expect(error.details?.surface).toBe('attestation')
    expect(publicClient.multicall).not.toHaveBeenCalled()
    expect(publicClient.simulateContract).not.toHaveBeenCalled()
    expect(publicClient.readContract).not.toHaveBeenCalled()
  })
})

describe('seeding / attestation — validation runs before the not-live rejection', () => {
  it('a malformed collection address rejects INVALID_PARAMS naming the field, on both methods', async () => {
    const { ctx } = buildCtx(8453)
    const malformed = '0xnope' as `0x${string}`

    const { error: seedingError } = await expectRejectsWithCode(seeding(ctx, malformed), 'INVALID_PARAMS')
    expect(seedingError.details?.field).toBe('collection')

    const { error: attestationError } = await expectRejectsWithCode(attestation(ctx, malformed), 'INVALID_PARAMS')
    expect(attestationError.details?.field).toBe('collection')
  })
})

describe('seeding / attestation — ships nothing unaudited', () => {
  it('src/seeding/*.ts contains no 40-hex-digit address literal and imports nothing from src/abis', () => {
    const seedingDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/seeding')
    for (const file of readdirSync(seedingDir)) {
      const full = path.join(seedingDir, file)
      const source = readFileSync(full, 'utf8')
      expect(ADDRESS_RE.test(source), `${file} contains an address literal`).toBe(false)
      expect(/from\s+['"][^'"]*\/abis/.test(source), `${file} imports from src/abis`).toBe(false)
    }
  })
})
