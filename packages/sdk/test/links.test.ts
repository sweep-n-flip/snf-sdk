import { describe, expect, it } from 'vitest'

import { SNF_CHAIN_IDS, getChain } from '../src/chains/registry'
import { isSnfError } from '../src/errors'
import { addressLink, tokenLink, txLink } from '../src/links'

/**
 * Explorer link builders — all 14 chains, from registry data alone.
 */

const HASH = '0x1111111111111111111111111111111111111111111111111111111111111111' as `0x${string}`
const ADDRESS = '0x2222222222222222222222222222222222222222' as `0x${string}`
const UNSUPPORTED_CHAIN_ID = 999_999

describe('txLink / addressLink / tokenLink — 14-chain coverage', () => {
  it.each(SNF_CHAIN_IDS)('chain %s: every helper returns an https:// URL containing the chain\'s own explorer host', (chainId) => {
    const host = new URL(getChain(chainId).explorerUrl).host

    const tx = txLink(chainId, HASH)
    const address = addressLink(chainId, ADDRESS)
    const token = tokenLink(chainId, { collection: ADDRESS, tokenId: '42' })

    for (const url of [tx, address, token]) {
      expect(url.startsWith('https://')).toBe(true)
      expect(url).toContain(host)
    }
  })

  it('SNF_CHAIN_IDS has exactly 14 members', () => {
    expect(SNF_CHAIN_IDS).toHaveLength(14)
  })

  it('tokenLink includes the tokenId', () => {
    const url = tokenLink(8453, { collection: ADDRESS, tokenId: '245830' })
    expect(url).toContain('245830')
    expect(url).toContain(ADDRESS)
  })

  it('an unsupported chain throws SnfError(INVALID_PARAMS) from every helper', () => {
    for (const fn of [
      () => txLink(UNSUPPORTED_CHAIN_ID, HASH),
      () => addressLink(UNSUPPORTED_CHAIN_ID, ADDRESS),
      () => tokenLink(UNSUPPORTED_CHAIN_ID, { collection: ADDRESS, tokenId: '1' }),
    ]) {
      try {
        fn()
        expect.fail('expected a throw')
      } catch (e) {
        expect(isSnfError(e)).toBe(true)
        if (isSnfError(e)) expect(e.code).toBe('INVALID_PARAMS')
      }
    }
  })
})

describe('src/index.ts — the public barrel surface', () => {
  it('exports exactly the documented surface, and no free-standing domain function', async () => {
    const barrel = (await import('../src/index')) as Record<string, unknown>
    const names = Object.keys(barrel).sort()

    const expected = [
      'MULTICALL3_ADDRESS',
      'SDK_VERSION',
      'SNF_CHAINS',
      'SNF_CHAIN_IDS',
      'SNF_ERROR_CODES',
      'SNF_ERROR_RETRYABLE',
      'SnfError',
      'abis',
      'addressLink',
      'assertChainMatch',
      'assertExactNativeMultiple',
      'assertParam',
      'createSnfClient',
      'describeError',
      'floorNativeValue',
      'formatAmount',
      'fromNativeValue',
      'getChain',
      'getQuoteDecimals',
      'getQuoteScale',
      'isSnfError',
      'isSupportedChain',
      'toAmount',
      'toNativeValue',
      'tokenLink',
      'toSnfError',
      'txLink',
    ].sort()

    expect(names).toEqual(expected)
  })

  it('does not export any free-standing domain function', async () => {
    const barrel = (await import('../src/index')) as Record<string, unknown>
    for (const forbidden of ['quoteBuy', 'buildBuy', 'resolveCollection', 'poolInventory', 'createCheckout']) {
      expect(barrel).not.toHaveProperty(forbidden)
    }
  })

  it('abis is a namespace exposing all nine ABI consts', async () => {
    const { abis } = await import('../src/index')
    expect(Object.keys(abis)).toHaveLength(9)
  })
})

describe('SNF_ERROR_RETRYABLE is a runtime export', () => {
  it('is importable as a value and covers every error code', async () => {
    const { SNF_ERROR_RETRYABLE, SNF_ERROR_CODES } = await import('../src/index')
    expect(typeof SNF_ERROR_RETRYABLE).toBe('object')
    for (const code of SNF_ERROR_CODES) expect(typeof SNF_ERROR_RETRYABLE[code]).toBe('boolean')
  })
})
