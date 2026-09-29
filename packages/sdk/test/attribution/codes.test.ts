import { describe, expect, it } from 'vitest'

import { toSdkCode, validatePartnerCode } from '../../src/attribution'
import { isSnfError } from '../../src/errors'

function expectInvalidParams(fn: () => unknown): void {
  try {
    fn()
  } catch (e) {
    expect(isSnfError(e) && e.code).toBe('INVALID_PARAMS')
    return
  }
  throw new Error('expected INVALID_PARAMS to be thrown')
}

describe('toSdkCode', () => {
  it('is the bare channel "sdk" when no partner code is given', () => {
    expect(toSdkCode()).toBe('sdk')
    expect(toSdkCode(undefined)).toBe('sdk')
  })

  it('prefixes a partner code with "sdk-"', () => {
    expect(toSdkCode('acme')).toBe('sdk-acme')
    expect(toSdkCode('a1')).toBe('sdk-a1')
    expect(toSdkCode('acme-labs-2')).toBe('sdk-acme-labs-2')
  })

  it('never doubles the prefix when the caller already passed "sdk-<code>"', () => {
    expect(toSdkCode('sdk-acme')).toBe('sdk-acme')
  })

  it('accepts a 28-char partner code (sdk-<code> is exactly 32) and rejects 29', () => {
    const max = 'a'.repeat(28)
    expect(toSdkCode(max)).toBe(`sdk-${max}`)
    expect(toSdkCode(max)).toHaveLength(32)
    expectInvalidParams(() => toSdkCode('a'.repeat(29)))
    expectInvalidParams(() => toSdkCode(`sdk-${'a'.repeat(29)}`))
  })
})

describe('validatePartnerCode', () => {
  it('returns the bare code, prefix stripped', () => {
    expect(validatePartnerCode('acme')).toBe('acme')
    expect(validatePartnerCode('sdk-acme')).toBe('acme')
    expect(validatePartnerCode('0x')).toBe('0x')
  })

  it.each([
    ['empty', ''],
    ['one char', 'a'],
    ['uppercase', 'Acme'],
    ['leading hyphen', '-acme'],
    ['underscore', 'acme_labs'],
    ['comma', 'acme,other'],
    ['space', 'acme labs'],
    ['dot', 'acme.io'],
    ['non-ascii', 'acmé'],
    ['prefix only', 'sdk-'],
  ])('rejects %s', (_name, code) => {
    expectInvalidParams(() => validatePartnerCode(code))
  })

  it.each([['snf'], ['snf-app'], ['snf-'], ['sdk'], ['sdk-snf'], ['sdk-snf-x'], ['sdk-sdk']])(
    'rejects reserved code %s',
    (code) => {
      expectInvalidParams(() => validatePartnerCode(code))
    },
  )

  it('rejects a non-string at runtime', () => {
    expectInvalidParams(() => validatePartnerCode(42 as unknown as string))
  })
})
