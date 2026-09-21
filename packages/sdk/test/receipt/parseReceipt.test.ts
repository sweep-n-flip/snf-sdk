import { encodeAbiParameters, type Log } from 'viem'
import { describe, expect, it } from 'vitest'

import { getChain } from '../../src/chains/registry'
import { isSnfError, SnfError } from '../../src/errors'
import { parseReceipt } from '../../src/receipt/parseReceipt'
import type { ReceiptLike } from '../../src/receipt/receipt.types'
import type { SnfClientContext } from '../../src/types/client.types'

import buy1Fixture from '../fixtures/receipts/buy-1.json'
import sell3Fixture from '../fixtures/receipts/sell-3.json'
import sellWnftFixture from '../fixtures/receipts/sell-wnft.json'

/**
 * R16 — `parseReceipt` against sourced receipt fixtures, plus the version-
 * monotonicity backstop.
 *
 * `sell-3.json` is a real, fully-verified fixture from live MAINNET history (see its
 * own `source`/`note` fields, and `snf-54-08-SUMMARY.md`'s Deviations): a live
 * `eth_getTransactionReceipt` against Base for a real mined DEMON sale, cross-checked
 * against `snf-drops-registration`'s independently-captured `sellReceipt.fixture.ts`.
 * `buy-1.json`/`sell-wnft.json` could not be sourced from mainnet history at plan 08's
 * time and were left `it.todo` pending a fork capture — plan 18 captured both live
 * from a real, mined anvil-fork-of-Base transaction (test/fork/base.fork.test.ts) and
 * converted the two `it.todo`s below into real assertions against the actual,
 * verified `parseReceipt` behavior (including a genuine finding: `received`/`paid`
 * never populate for a pure wNFT sale — see `sell-wnft.json`'s own `note` field).
 */

interface FixtureLog {
  readonly address: string
  readonly data: string
  readonly topics: readonly string[]
  readonly logIndex: number
  readonly transactionIndex: number
  readonly removed: boolean
}

interface ReceiptFixture {
  readonly pending: boolean
  readonly source: string
  readonly chainId?: number
  readonly receipt?: {
    readonly status: 'success' | 'reverted'
    readonly transactionHash: string
    readonly blockNumber: string
    readonly logs: readonly FixtureLog[]
  }
  readonly expected?: Record<string, unknown>
}

function toReceiptLike(fixture: ReceiptFixture): ReceiptLike {
  if (!fixture.receipt) throw new Error('fixture has no receipt to convert')
  const r = fixture.receipt
  const logs: Log[] = r.logs.map((l) => ({
    address: l.address as `0x${string}`,
    data: l.data as `0x${string}`,
    topics: l.topics as [`0x${string}`, ...`0x${string}`[]] | [],
    logIndex: l.logIndex,
    transactionIndex: l.transactionIndex,
    removed: l.removed,
    blockHash: '0x0000000000000000000000000000000000000000000000000000000000000000' as `0x${string}`,
    blockNumber: BigInt(r.blockNumber),
    transactionHash: r.transactionHash as `0x${string}`,
  }))
  return {
    status: r.status,
    transactionHash: r.transactionHash as `0x${string}`,
    blockNumber: BigInt(r.blockNumber),
    logs,
  }
}

function fakeCtx(chainId: number, seed = 0): { ctx: SnfClientContext; versions: number[] } {
  const chain = getChain(chainId)
  const versions: number[] = []
  let counter = seed
  const ctx = {
    chain,
    nextTxInvalidationVersion: () => {
      counter += 1
      versions.push(counter)
      return counter
    },
  } as unknown as SnfClientContext
  return { ctx, versions }
}

describe('parseReceipt — sell-3.json (the one real, sourced fixture)', () => {
  const fixture = sell3Fixture as unknown as ReceiptFixture

  it('has a non-empty source naming a file path or transaction hash', () => {
    expect(fixture.source.length).toBeGreaterThan(0)
    expect(fixture.pending).toBe(false)
  })

  it('returns itemsIn matching the real sale (2 DEMON tokenIds), and itemsOut empty', () => {
    const { ctx } = fakeCtx(fixture.chainId ?? 8453)
    const result = parseReceipt(ctx, toReceiptLike(fixture))
    expect([...result.itemsIn].sort()).toEqual([...(fixture.expected?.itemsIn as string[])].sort())
    expect(result.itemsOut).toEqual(fixture.expected?.itemsOut)
  })

  it('attributes the marketplace fee from the Safe-emitted log, byte for byte', () => {
    const { ctx } = fakeCtx(fixture.chainId ?? 8453)
    const result = parseReceipt(ctx, toReceiptLike(fixture))
    expect(result.fees.marketplace.value).toBe(BigInt(fixture.expected?.marketplaceFeeWei as string))
  })

  it('received is the fee-only net (gross - marketplace fee), and discloses the royalty gap via warnings', () => {
    const { ctx } = fakeCtx(fixture.chainId ?? 8453)
    const result = parseReceipt(ctx, toReceiptLike(fixture))
    expect(result.received?.value).toBe(BigInt(fixture.expected?.receivedWei as string))
    expect(result.warnings.some((w) => w.toLowerCase().includes('royalty'))).toBe(true)
  })

  it('bumps txInvalidationVersion by 1 per parsed receipt on this instance', () => {
    const { ctx, versions } = fakeCtx(fixture.chainId ?? 8453)
    parseReceipt(ctx, toReceiptLike(fixture))
    parseReceipt(ctx, toReceiptLike(fixture))
    expect(versions).toEqual([1, 2])
  })

  it('two client instances have independent counters', () => {
    const a = fakeCtx(fixture.chainId ?? 8453)
    const b = fakeCtx(fixture.chainId ?? 8453)
    parseReceipt(a.ctx, toReceiptLike(fixture))
    parseReceipt(a.ctx, toReceiptLike(fixture))
    parseReceipt(b.ctx, toReceiptLike(fixture))
    expect(a.versions).toEqual([1, 2])
    expect(b.versions).toEqual([1])
  })

  it('never throws for this receipt', () => {
    const { ctx } = fakeCtx(fixture.chainId ?? 8453)
    expect(() => parseReceipt(ctx, toReceiptLike(fixture))).not.toThrow()
  })
})

describe('parseReceipt — buy-1.json (captured live from the Base fork, plan 18)', () => {
  const fixture = buy1Fixture as unknown as ReceiptFixture

  it('has a non-empty source and is no longer pending', () => {
    expect(fixture.source.length).toBeGreaterThan(0)
    expect(fixture.pending).toBe(false)
  })

  it('returns itemsOut with the bought tokenId, and itemsIn empty', () => {
    const { ctx } = fakeCtx(fixture.chainId ?? 8453)
    const result = parseReceipt(ctx, toReceiptLike(fixture))
    expect(result.itemsOut).toEqual(fixture.expected?.itemsOut)
    expect(result.itemsIn).toEqual([])
  })

  it('attributes the marketplace fee from the Safe-emitted log, byte for byte', () => {
    const { ctx } = fakeCtx(fixture.chainId ?? 8453)
    const result = parseReceipt(ctx, toReceiptLike(fixture))
    expect(result.fees.marketplace.value).toBe(BigInt(fixture.expected?.marketplaceFeeWei as string))
  })

  it('paid is grossDeposited + marketplaceFee ONLY, and discloses the royalty gap via warnings', () => {
    const { ctx } = fakeCtx(fixture.chainId ?? 8453)
    const result = parseReceipt(ctx, toReceiptLike(fixture))
    expect(result.paid?.value).toBe(BigInt(fixture.expected?.paidWei as string))
    expect(result.warnings.some((w) => w.toLowerCase().includes('royalty'))).toBe(true)
  })

  it('never throws for this receipt', () => {
    const { ctx } = fakeCtx(fixture.chainId ?? 8453)
    expect(() => parseReceipt(ctx, toReceiptLike(fixture))).not.toThrow()
  })
})

describe('parseReceipt — sell-wnft.json (captured live from the Base fork, plan 18)', () => {
  const fixture = sellWnftFixture as unknown as ReceiptFixture

  it('has a non-empty source and is no longer pending', () => {
    expect(fixture.source.length).toBeGreaterThan(0)
    expect(fixture.pending).toBe(false)
  })

  it('a pure wNFT (fractional wrapper) sale has NO ERC-721 Transfer logs — itemsIn/itemsOut both stay empty', () => {
    const { ctx } = fakeCtx(fixture.chainId ?? 8453)
    const result = parseReceipt(ctx, toReceiptLike(fixture))
    expect(result.itemsIn).toEqual([])
    expect(result.itemsOut).toEqual([])
  })

  it('FINDING (not fixed — packages/sdk/src out of scope): received/paid stay undefined for a wNFT sale, even though the WETH Withdrawal log proves real ETH was received — see this fixture\'s own "note" field and snf-54-18-SUMMARY.md, Findings', () => {
    const { ctx } = fakeCtx(fixture.chainId ?? 8453)
    const result = parseReceipt(ctx, toReceiptLike(fixture))
    expect(result.received).toBeUndefined()
    expect(result.paid).toBeUndefined()
    expect(result.fees.marketplace.value).toBe(0n)
    expect(result.fees.royalty.value).toBe(0n)
  })

  it('never throws for this receipt', () => {
    const { ctx } = fakeCtx(fixture.chainId ?? 8453)
    expect(() => parseReceipt(ctx, toReceiptLike(fixture))).not.toThrow()
  })
})

describe('parseReceipt — reverted receipts throw typed, never return a partial result', () => {
  it('a reverted receipt with a decodable revert reason throws INSUFFICIENT_OUTPUT_AMOUNT', () => {
    const { ctx } = fakeCtx(8453)
    // A synthetic `data` field, as some providers attach non-standard revert data
    // directly on the receipt object — describeError decodes it via `'data' in e`
    // regardless of the static ReceiptLike type (T-54-39: reused, not re-implemented).
    const revertData = encodeRevert('SweepnFlipRouter: INSUFFICIENT_OUTPUT_AMOUNT')
    const reverted: ReceiptLike & { readonly data: `0x${string}` } = {
      status: 'reverted',
      transactionHash: '0xcc',
      blockNumber: 1n,
      logs: [],
      data: revertData,
    }
    expect(() => parseReceipt(ctx, reverted)).toThrowError()
    try {
      parseReceipt(ctx, reverted)
    } catch (e) {
      expect(isSnfError(e)).toBe(true)
      expect((e as SnfError).code).toBe('INSUFFICIENT_OUTPUT_AMOUNT')
    }
  })

  it('a reverted receipt with no decodable data throws UNKNOWN, not a partial result', () => {
    const { ctx } = fakeCtx(8453)
    const reverted: ReceiptLike = { status: 'reverted', transactionHash: '0xdd', blockNumber: 1n, logs: [] }
    try {
      parseReceipt(ctx, reverted)
      expect.unreachable('parseReceipt must throw for a reverted receipt')
    } catch (e) {
      expect(isSnfError(e)).toBe(true)
      expect((e as SnfError).code).toBe('UNKNOWN')
    }
  })
})

describe('parseReceipt — a receipt with zero recognisable logs', () => {
  it('returns empty arrays and zero amounts with a warnings entry, never a throw', () => {
    const { ctx } = fakeCtx(8453)
    const receipt: ReceiptLike = { status: 'success', transactionHash: '0xee', blockNumber: 1n, logs: [] }
    const result = parseReceipt(ctx, receipt)
    expect(result.itemsIn).toEqual([])
    expect(result.itemsOut).toEqual([])
    expect(result.fees.marketplace.value).toBe(0n)
    expect(result.fees.royalty.value).toBe(0n)
    expect(result.warnings.length).toBeGreaterThan(0)
  })
})

describe('parseReceipt — R16 concurrency backstop: out-of-order delivery keeps the counter strictly increasing', () => {
  // Fixed seed: a permutation table over 5 receipts (all built from the one real,
  // sourced sell-3.json fixture — only the ORDER of delivery varies, never the
  // content), tried both forwards and reversed, plus 3 explicit shuffles.
  const fixture = sell3Fixture as unknown as ReceiptFixture
  const receipts: readonly ReceiptLike[] = [0, 1, 2, 3, 4].map(() => toReceiptLike(fixture))

  const permutations: readonly (readonly number[])[] = [
    [0, 1, 2, 3, 4],
    [4, 3, 2, 1, 0],
    [2, 0, 4, 1, 3],
    [3, 1, 4, 0, 2],
    [1, 4, 0, 3, 2],
  ]

  it.each(permutations)('permutation %j leaves txInvalidationVersion strictly increasing', (...order) => {
    const { ctx, versions } = fakeCtx(8453)
    for (const index of order) parseReceipt(ctx, receipts[index] as ReceiptLike)
    for (let i = 1; i < versions.length; i++) {
      expect(versions[i]).toBeGreaterThan(versions[i - 1] as number)
    }
    // The counter is instance-owned, not derived from the receipt (every receipt in
    // this permutation is the SAME content — a field-derived counter would produce
    // the SAME value every time, not a strictly increasing sequence).
    expect(versions).toEqual([1, 2, 3, 4, 5])
  })
})

// --- local revert-data helper, matching test/describeError.test.ts's `revertData` ---
function encodeRevert(reason: string): `0x${string}` {
  const encoded = encodeAbiParameters([{ type: 'string' }], [reason])
  return `0x08c379a0${encoded.slice(2)}`
}
