import { describe, expect, it } from 'vitest'
import { SNF_ERROR_CODES } from '@sweepnflip/sdk'
import { DEFAULT_WIDGET_MESSAGES, resolveErrorMessage } from '../src/messages'

/**
 * Every SDK error code has a partner-facing default, overridable per
 * code, with `code` always available to whatever renders it (this function returns
 * only the text; the caller renders `code` alongside it — see `messages.ts`'s own
 * header comment).
 */
describe('DEFAULT_WIDGET_MESSAGES', () => {
  it('has a non-empty, code-distinct default message for every SDK error code', () => {
    for (const code of SNF_ERROR_CODES) {
      const message = DEFAULT_WIDGET_MESSAGES[code]
      expect(typeof message).toBe('string')
      expect(message.length).toBeGreaterThan(0)
      expect(message).not.toBe(code)
    }
  })
})

describe('resolveErrorMessage', () => {
  it('returns the default when no override is supplied', () => {
    expect(resolveErrorMessage('WRONG_CHAIN')).toBe(DEFAULT_WIDGET_MESSAGES.WRONG_CHAIN)
  })

  it('returns the override text when one is supplied for the matching code', () => {
    expect(resolveErrorMessage('WRONG_CHAIN', { WRONG_CHAIN: 'Custom copy' })).toBe('Custom copy')
  })

  it('never lets an override for one code leak onto another', () => {
    expect(resolveErrorMessage('USER_REJECTED', { WRONG_CHAIN: 'unrelated' })).toBe(
      DEFAULT_WIDGET_MESSAGES.USER_REJECTED,
    )
  })
})
