import { describe, expect, it } from 'vitest'

import {
  getCollectionLabels,
  isAddressLike,
  needsNameFallback,
  shortenAddress,
} from '../../src/collection/labels'

/**
 * `getCollectionLabels` — an address is never a name (prohibition #6).
 */

const ADDRESS = '0x7c479938ba2a3edb0a744c3743cf6db4b7e70ebc' as `0x${string}`
const SHORT_ELLIPSIS = '0x7c47…70eb'
const SHORT_DOTS = '0x7c47...70eb'

describe('isAddressLike', () => {
  it('rejects a full 42-char 0x address', () => {
    expect(isAddressLike(ADDRESS)).toBe(true)
  })

  it('rejects an ellipsis-shortened address — the form that historically slipped through', () => {
    expect(isAddressLike(SHORT_ELLIPSIS)).toBe(true)
  })

  it('rejects a three-dot shortened address', () => {
    expect(isAddressLike(SHORT_DOTS)).toBe(true)
  })

  it('accepts a legitimate name that merely STARTS with 0x (the false-positive guard)', () => {
    expect(isAddressLike('0xmons')).toBe(false)
  })

  it('returns false for undefined/null/empty', () => {
    expect(isAddressLike(undefined)).toBe(false)
    expect(isAddressLike(null)).toBe(false)
    expect(isAddressLike('')).toBe(false)
  })
})

describe('needsNameFallback', () => {
  it('true for empty/whitespace name', () => {
    expect(needsNameFallback('', ADDRESS)).toBe(true)
    expect(needsNameFallback('   ', ADDRESS)).toBe(true)
    expect(needsNameFallback(undefined, ADDRESS)).toBe(true)
  })

  it('true for an address-like name', () => {
    expect(needsNameFallback(ADDRESS, ADDRESS)).toBe(true)
    expect(needsNameFallback(SHORT_ELLIPSIS, ADDRESS)).toBe(true)
  })

  it('false for a real name', () => {
    expect(needsNameFallback('Bored Ape Yacht Club', ADDRESS)).toBe(false)
  })
})

describe('shortenAddress', () => {
  it('matches the snf-client formatters.ts convention: first6...last4', () => {
    expect(shortenAddress(ADDRESS)).toBe('0x7c47...0ebc')
  })

  it('returns empty string for an empty input', () => {
    expect(shortenAddress('')).toBe('')
  })
})

describe('getCollectionLabels — the waterfall (COLLECTION_IDENTITY.md)', () => {
  it('subgraph name + symbol both present → used verbatim', () => {
    const result = getCollectionLabels({
      subgraphName: 'Demon Kingdom',
      subgraphSymbol: 'DEMON',
      address: ADDRESS,
    })
    expect(result.name).toBe('Demon Kingdom')
    expect(result.symbol).toBe('DEMON')
    expect(result.nameIsFallback).toBe(false)
  })

  it('no subgraph data, on-chain name()/symbol() present → those are used', () => {
    const result = getCollectionLabels({
      onChainName: 'Milady Maker',
      onChainSymbol: 'MILADY',
      address: ADDRESS,
    })
    expect(result.name).toBe('Milady Maker')
    expect(result.symbol).toBe('MILADY')
    expect(result.nameIsFallback).toBe(false)
  })

  it('an address-like name falls through to the symbol', () => {
    const result = getCollectionLabels({
      subgraphName: SHORT_ELLIPSIS,
      subgraphSymbol: 'DEMON',
      address: ADDRESS,
    })
    expect(result.name).toBe('DEMON')
    expect(result.symbol).toBe('DEMON')
    expect(result.nameIsFallback).toBe(false)
  })

  it('a full 42-char address as name is rejected the same way', () => {
    const result = getCollectionLabels({
      subgraphName: ADDRESS,
      subgraphSymbol: 'DEMON',
      address: ADDRESS,
    })
    expect(result.name).toBe('DEMON')
  })

  it('symbol WNFT is rejected as an identity; the waterfall continues to the name', () => {
    const result = getCollectionLabels({
      subgraphSymbol: 'WNFT',
      onChainName: 'Real Collection Name',
      address: ADDRESS,
    })
    expect(result.name).toBe('Real Collection Name')
    expect(result.symbol).toBe('Real Collection Name')
  })

  it('symbol WERC721 is also denylisted', () => {
    const result = getCollectionLabels({
      subgraphSymbol: 'WERC721',
      onChainName: 'Real Collection Name',
      address: ADDRESS,
    })
    expect(result.symbol).toBe('Real Collection Name')
  })

  it('nothing resolvable → name is the cleanly shortened address, nameIsFallback: true', () => {
    const result = getCollectionLabels({ address: ADDRESS })
    expect(result.name).toBe('0x7c47...0ebc')
    expect(result.symbol).toBe('0x7c47...0ebc')
    expect(result.nameIsFallback).toBe(true)
  })

  it('only wrapper-denylisted symbols everywhere → still falls to the shortened address', () => {
    const result = getCollectionLabels({
      subgraphSymbol: 'WNFT',
      onChainSymbol: 'W721',
      address: ADDRESS,
    })
    expect(result.nameIsFallback).toBe(true)
  })

  it('a name() containing U+FFFD (invalid UTF-8 decode) falls through to symbol()', () => {
    const result = getCollectionLabels({
      onChainName: `Bad�Name`,
      onChainSymbol: 'BADN',
      address: ADDRESS,
    })
    expect(result.name).toBe('BADN')
  })

  it('a legitimate name starting with 0x (0xmons) is ACCEPTED — the false-positive guard', () => {
    const result = getCollectionLabels({ subgraphName: '0xmons', address: ADDRESS })
    expect(result.name).toBe('0xmons')
    expect(result.nameIsFallback).toBe(false)
  })

  it('every returned name/symbol is trimmed and has no control characters', () => {
    const result = getCollectionLabels({
      subgraphName: '  Spaced Name \t\n',
      subgraphSymbol: 'SPCD',
      address: ADDRESS,
    })
    expect(result.name).toBe('Spaced Name')
    expect(result.symbol).toBe('SPCD')
  })

  describe('adversarial name-input table (10+ rows)', () => {
    const rows: readonly { readonly label: string; readonly input: string; readonly expectFallback: boolean }[] = [
      { label: 'full address', input: ADDRESS, expectFallback: true },
      { label: 'shortened address (ellipsis)', input: SHORT_ELLIPSIS, expectFallback: true },
      { label: 'shortened address (three dots)', input: SHORT_DOTS, expectFallback: true },
      { label: 'wrapper symbol WNFT', input: 'WNFT', expectFallback: true },
      { label: 'empty string', input: '', expectFallback: true },
      { label: 'whitespace only', input: '   ', expectFallback: true },
      { label: 'only control characters', input: '', expectFallback: true },
      { label: '200-char string', input: 'A'.repeat(200), expectFallback: false },
      { label: 'contains U+FFFD replacement char', input: `Broken${'�'}Name`, expectFallback: true },
      { label: 'legitimate name starting with 0x', input: '0xmons', expectFallback: false },
    ]

    it.each(rows)('$label → fallback=$expectFallback', ({ input, expectFallback }) => {
      const result = getCollectionLabels({ subgraphName: input, address: ADDRESS })
      expect(result.nameIsFallback).toBe(expectFallback)
      if (!expectFallback) {
        expect(result.name).toBe(input)
      }
    })
  })
})
