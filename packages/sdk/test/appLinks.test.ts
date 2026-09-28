import { describe, expect, it } from 'vitest'

import { appLinks } from '../src/appLinks'
import { SNF_CHAIN_IDS } from '../src/chains/registry'
import { isSnfError } from '../src/errors'

/**
 * `appLinks` — pure, no-I/O string builders. Every case here runs with zero mocks:
 * a client, a fetch stub or an RPC call would be a sign this file drifted from what
 * this module actually does.
 */

const PAIR = '0xE8143126bdFBe58ED0056f88031236766C311ECf' as `0x${string}`
const PAIR_LOWER = PAIR.toLowerCase()
const COLLECTION = '0xAbCDef0123456789AbCDef0123456789AbCDef01' as `0x${string}`
const COLLECTION_LOWER = COLLECTION.toLowerCase()
const UNSUPPORTED_CHAIN_ID = 999_999

function expectInvalidParams(fn: () => unknown, field: string): void {
  try {
    fn()
    expect.fail('expected a throw')
  } catch (e) {
    expect(isSnfError(e)).toBe(true)
    if (isSnfError(e)) {
      expect(e.code).toBe('INVALID_PARAMS')
      expect(e.details?.field).toBe(field)
    }
  }
}

describe('appLinks — 14-chain coverage', () => {
  it.each(SNF_CHAIN_IDS)('chain %s: every link starts with the app origin, names its chain once, never /api', (chainId) => {
    const urls = [
      appLinks.pool(chainId, PAIR),
      appLinks.liquidity(chainId, { tab: 'add', pair: PAIR }),
      appLinks.liquidity(chainId, { tab: 'remove', pair: PAIR }),
      appLinks.liquidity(chainId, { tab: 'create', collection: COLLECTION }),
      appLinks.swap(chainId, { tokenIn: 'native', tokenOut: COLLECTION }),
    ]

    for (const url of urls) {
      expect(url.startsWith('https://app.sweepnflip.io/')).toBe(true)
      expect(url).not.toContain('/api')
      const chainOccurrences = url.split(`chain=${chainId}`).length - 1
      expect(chainOccurrences).toBe(1)
    }
  })
})

describe('appLinks.pool', () => {
  it('lowercases the pair and carries the chain', () => {
    expect(appLinks.pool(8453, PAIR)).toBe(
      `https://app.sweepnflip.io/pools/${PAIR_LOWER}?chain=8453`,
    )
  })

  it('an unsupported chain throws INVALID_PARAMS', () => {
    try {
      appLinks.pool(UNSUPPORTED_CHAIN_ID, PAIR)
      expect.fail('expected a throw')
    } catch (e) {
      expect(isSnfError(e)).toBe(true)
      if (isSnfError(e)) expect(e.code).toBe('INVALID_PARAMS')
    }
  })

  it.each(['0x123', `${PAIR}?chain=1`, '../api', 'not-an-address'])(
    'a malformed pair (%s) throws INVALID_PARAMS naming "pair"',
    (bad) => {
      expectInvalidParams(() => appLinks.pool(8453, bad as `0x${string}`), 'pair')
    },
  )
})

describe('appLinks.liquidity', () => {
  it('tab=add carries pool + chain', () => {
    expect(appLinks.liquidity(8453, { tab: 'add', pair: PAIR })).toBe(
      `https://app.sweepnflip.io/liquidity?tab=add&pool=${PAIR_LOWER}&chain=8453`,
    )
  })

  it('tab=remove carries pool + chain', () => {
    expect(appLinks.liquidity(8453, { tab: 'remove', pair: PAIR })).toBe(
      `https://app.sweepnflip.io/liquidity?tab=remove&pool=${PAIR_LOWER}&chain=8453`,
    )
  })

  it('tab=create carries collection + chain', () => {
    expect(appLinks.liquidity(8453, { tab: 'create', collection: COLLECTION })).toBe(
      `https://app.sweepnflip.io/liquidity?tab=create&collection=${COLLECTION_LOWER}&chain=8453`,
    )
  })

  it('an unsupported chain throws INVALID_PARAMS', () => {
    try {
      appLinks.liquidity(UNSUPPORTED_CHAIN_ID, { tab: 'add', pair: PAIR })
      expect.fail('expected a throw')
    } catch (e) {
      expect(isSnfError(e)).toBe(true)
      if (isSnfError(e)) expect(e.code).toBe('INVALID_PARAMS')
    }
  })

  it('a malformed pair throws INVALID_PARAMS naming "pair"', () => {
    expectInvalidParams(
      () => appLinks.liquidity(8453, { tab: 'add', pair: '0x123' as `0x${string}` }),
      'pair',
    )
  })

  it('a malformed collection throws INVALID_PARAMS naming "collection"', () => {
    expectInvalidParams(
      () =>
        appLinks.liquidity(8453, {
          tab: 'create',
          collection: '../api' as `0x${string}`,
        }),
      'collection',
    )
  })
})

describe('appLinks.swap', () => {
  it('native tokenIn maps to the eth sentinel, tokenOut is lowercased', () => {
    expect(appLinks.swap(5042, { tokenIn: 'native', tokenOut: COLLECTION })).toBe(
      `https://app.sweepnflip.io/swap?chain=5042&tokenIn=eth&tokenOut=${COLLECTION_LOWER}`,
    )
  })

  it('with no args, only chain is present', () => {
    expect(appLinks.swap(1)).toBe('https://app.sweepnflip.io/swap?chain=1')
  })

  it('an omitted side is omitted from the URL, not emitted empty', () => {
    const url = appLinks.swap(1, { tokenIn: 'native' })
    expect(url).toBe('https://app.sweepnflip.io/swap?chain=1&tokenIn=eth')
    expect(url).not.toContain('tokenOut')
  })

  it('an unsupported chain throws INVALID_PARAMS', () => {
    try {
      appLinks.swap(UNSUPPORTED_CHAIN_ID)
      expect.fail('expected a throw')
    } catch (e) {
      expect(isSnfError(e)).toBe(true)
      if (isSnfError(e)) expect(e.code).toBe('INVALID_PARAMS')
    }
  })

  it('a malformed tokenIn throws INVALID_PARAMS naming "tokenIn"', () => {
    expectInvalidParams(
      () => appLinks.swap(1, { tokenIn: '0x123' as `0x${string}` }),
      'tokenIn',
    )
  })

  it('a malformed tokenOut throws INVALID_PARAMS naming "tokenOut"', () => {
    expectInvalidParams(
      () => appLinks.swap(1, { tokenOut: '../api' as `0x${string}` }),
      'tokenOut',
    )
  })
})

describe('appLinks — opts.origin', () => {
  it.each(['https://partner.example', 'https://partner.example/'])(
    'a bare https origin (%s) overrides the default, with or without a trailing slash',
    (origin) => {
      expect(appLinks.pool(8453, PAIR, { origin })).toBe(
        `https://partner.example/pools/${PAIR_LOWER}?chain=8453`,
      )
    },
  )

  it.each([
    'http://partner.example',
    'javascript:alert(1)',
    'ftp://x',
    'https://x.example/app',
    'https://x.example/?q=1',
    'https://x.example/#h',
    'not a url',
  ])('an invalid origin (%s) throws INVALID_PARAMS naming "origin"', (origin) => {
    expectInvalidParams(() => appLinks.pool(8453, PAIR, { origin }), 'origin')
  })
})
