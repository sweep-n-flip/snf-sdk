import { ContractFunctionRevertedError, encodeAbiParameters, UserRejectedRequestError } from 'viem'
import { describe, expect, it } from 'vitest'

import { ROUTER02_COLLECTION_ABI } from '../src/abis/UniswapV2Router02Collection'
import { describeError } from '../src/describeError'
import { SNF_ERROR_CODES, SnfError } from '../src/errors'
import type { SnfErrorCode } from '../src/errors.types'

/**
 * describeError is total, ordered, and never throws (must_haves).
 * The `it.each` table below is the 12+-row classification matrix; the loop after it
 * is the 20-adversarial-input never-throws property.
 */

function revertData(reason: string): `0x${string}` {
  const encoded = encodeAbiParameters([{ type: 'string' }], [reason])
  return `0x08c379a0${encoded.slice(2)}`
}

function revertedError(reason: string): ContractFunctionRevertedError {
  return new ContractFunctionRevertedError({
    abi: ROUTER02_COLLECTION_ABI,
    data: revertData(reason),
    functionName: 'swapExactTokensForTokensCollection',
  })
}

class ThrowingMessageError extends Error {
  override get message(): string {
    throw new Error('accessing .message exploded')
  }
}

interface Row {
  readonly label: string
  readonly input: unknown
  readonly expectedCode: SnfErrorCode
  readonly expectedDetail?: { readonly key: string; readonly value: unknown }
}

const ROWS: readonly Row[] = [
  { label: 'null', input: null, expectedCode: 'UNKNOWN' },
  { label: 'undefined', input: undefined, expectedCode: 'UNKNOWN' },
  { label: 'empty string', input: '', expectedCode: 'UNKNOWN' },
  { label: 'empty object', input: {}, expectedCode: 'UNKNOWN' },
  { label: 'empty array', input: [], expectedCode: 'UNKNOWN' },
  {
    label: 'decoded ContractFunctionRevertedError: INSUFFICIENT_OUTPUT_AMOUNT',
    input: revertedError('INSUFFICIENT_OUTPUT_AMOUNT'),
    expectedCode: 'INSUFFICIENT_OUTPUT_AMOUNT',
  },
  {
    label: 'message-only revert, no data: UniswapV2Router: EXPIRED',
    input: new Error('execution reverted: UniswapV2Router: EXPIRED'),
    expectedCode: 'INVALID_PARAMS',
    expectedDetail: { key: 'revert', value: 'EXPIRED' },
  },
  {
    label: 'viem UserRejectedRequestError',
    input: new UserRejectedRequestError(new Error('User rejected the request.')),
    expectedCode: 'USER_REJECTED',
  },
  { label: 'raw provider rejection { code: 4001 }', input: { code: 4001 }, expectedCode: 'USER_REJECTED' },
  {
    label: 'message containing ACTION_REJECTED',
    input: new Error('MetaMask Tx Signature: User denied transaction signature. ACTION_REJECTED'),
    expectedCode: 'USER_REJECTED',
  },
  {
    label: "message containing 'Unauthorized' (wallet RPC needs a key)",
    input: new Error('Internal JSON-RPC error: Unauthorized: You must authenticate your request'),
    expectedCode: 'UPSTREAM_DEGRADED',
    expectedDetail: { key: 'reason', value: 'rpc-auth' },
  },
  {
    label: "message containing 'must authenticate'",
    input: new Error('must authenticate your request to generate your personal API key'),
    expectedCode: 'UPSTREAM_DEGRADED',
    expectedDetail: { key: 'reason', value: 'rpc-auth' },
  },
  {
    label: "message containing 'chain mismatch'",
    input: new Error('chain mismatch: expected 8453, got 1'),
    expectedCode: 'WRONG_CHAIN',
  },
  {
    label: "message containing 'does not match the target chain'",
    input: new Error('The current chain does not match the target chain for the transaction.'),
    expectedCode: 'WRONG_CHAIN',
  },
  {
    label: "message containing 'insufficient funds'",
    input: new Error('insufficient funds for gas * price + value'),
    expectedCode: 'INVALID_PARAMS',
    expectedDetail: { key: 'reason', value: 'insufficient-funds' },
  },
  {
    label: 'plain string revert, compared after trim()',
    input: '   UniswapV2: K   ',
    expectedCode: 'INVALID_PARAMS',
    expectedDetail: { key: 'revert', value: 'UniswapV2: K' },
  },
  {
    label: 'a circular object never throws (would break naive JSON.stringify)',
    input: (() => {
      const circular: { self?: unknown } = {}
      circular.self = circular
      return circular
    })(),
    expectedCode: 'UNKNOWN',
  },
  {
    label: 'an unmatched generic error message',
    input: new Error('some completely unrelated failure'),
    expectedCode: 'UNKNOWN',
  },
]

describe('describeError — classification table', () => {
  it.each(ROWS.map((row) => [row.label, row] as const))('%s', (_label, row) => {
    const result = describeError(row.input)
    expect(result).toBeInstanceOf(SnfError)
    expect(result.code).toBe(row.expectedCode)
    expect(result.message.length).toBeGreaterThan(0)
    expect(SNF_ERROR_CODES).toContain(result.code)
    if (row.expectedDetail) {
      expect(result.details?.[row.expectedDetail.key]).toBe(row.expectedDetail.value)
    }
  })

  it('at least 12 table rows', () => {
    expect(ROWS.length).toBeGreaterThanOrEqual(12)
  })
})

describe('describeError — idempotent on an already-typed SnfError', () => {
  it('returns the exact same instance, unchanged', () => {
    const original = new SnfError('NO_ROUTE', 'No viable route exists for this request.')
    expect(describeError(original)).toBe(original)
  })
})

describe('describeError — 20-adversarial-input never-throws property', () => {
  const proxyThatThrows = new Proxy(
    {},
    {
      get(): never {
        throw new Error('proxy trap exploded')
      },
    },
  )

  const frozen = Object.freeze({ some: 'frozen-value' })

  const circularForProperty: { self?: unknown } = {}
  circularForProperty.self = circularForProperty

  const ADVERSARIAL_INPUTS: readonly unknown[] = [
    ...ROWS.map((row) => row.input),
    proxyThatThrows,
    new ThrowingMessageError('irrelevant'),
    Symbol('adversarial'),
    123456789012345678901234567890n,
    frozen,
    circularForProperty,
    'x'.repeat(100_000),
    new Date(),
  ]

  it('never throws, for any of the 12+ table inputs plus 8 adversarial ones', () => {
    expect(ADVERSARIAL_INPUTS.length).toBeGreaterThanOrEqual(20)
    for (const input of ADVERSARIAL_INPUTS) {
      expect(() => describeError(input)).not.toThrow()
    }
  })

  it('every adversarial input still returns a code from the closed SNF_ERROR_CODES list', () => {
    for (const input of ADVERSARIAL_INPUTS) {
      const result = describeError(input)
      expect(SNF_ERROR_CODES).toContain(result.code)
    }
  })
})
