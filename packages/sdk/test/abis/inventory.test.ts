import { readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import * as abis from '../../src/abis/index'
import { findForbiddenFingerprintLines } from '../../../../scripts/forbidden-name-fingerprints.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * Inventory gate: exactly the eight audited AMM ABIs plus the Arc
 * `UniswapV2Router01CollectionNativeERC20` variant — nine consts, ten files (the nine
 * ABIs plus `index.ts`). Nothing outside this SDK's audited AMM surface belongs here.
 * A tenth ABI or a match against the shared forbidden-name fingerprint set (see
 * `scripts/forbidden-name-fingerprints.mjs` — the single source of truth, also used by
 * `scripts/release-gate.mjs`) fails this test immediately. Matching by fingerprint
 * rather than by a plaintext name list means this test file carries none of the names
 * it guards against, in plaintext, anywhere.
 */

const ABIS_DIR = resolve(HERE, '../../src/abis')

const EXPECTED_FILES = [
  'ERC20.ts',
  'ERC721.ts',
  'IERC2981.ts',
  'UniswapV2Factory.ts',
  'UniswapV2Pair.ts',
  'UniswapV2Router01CollectionNativeERC20.ts',
  'UniswapV2Router02Collection.ts',
  'WERC721.ts',
  'WETH9.ts',
  'index.ts',
]

describe('ABI inventory', () => {
  it('contains exactly the ten expected files (nine ABIs + index.ts)', () => {
    const files = readdirSync(ABIS_DIR).sort()
    expect(files).toEqual([...EXPECTED_FILES].sort())
  })

  it('the barrel re-exports exactly nine ABI consts', () => {
    expect(Object.keys(abis)).toHaveLength(9)
  })

  it.each(EXPECTED_FILES.filter((f) => f !== 'index.ts'))(
    '%s never contains a forbidden non-AMM product name',
    (file) => {
      const source = readFileSync(resolve(ABIS_DIR, file), 'utf8')
      expect(findForbiddenFingerprintLines(source)).toEqual([])
    },
  )

  it('ROUTER02_COLLECTION_ABI exposes the full Collection + core function surface', () => {
    const names = abis.ROUTER02_COLLECTION_ABI.filter(
      (entry): entry is Extract<typeof entry, { type: 'function' }> => entry.type === 'function',
    ).map((entry) => entry.name)

    for (const expected of [
      'getAmountsInCollection',
      'getAmountsOutCollection',
      'getAmountsIn',
      'getAmountsOut',
      'marketplaceFee',
      'royaltyFeeCap',
      'swapETHForExactTokensCollection',
      'swapExactTokensForETHCollection',
      'swapTokensForExactTokensCollection',
      'swapExactTokensForTokensCollection',
      'WETH',
      'factory',
    ]) {
      expect(names, `missing ${expected}`).toContain(expected)
    }
  })

  it('ROUTER_NATIVE_ERC20_ABI adds NATIVE_SCALE; ROUTER02_COLLECTION_ABI does not', () => {
    const hasNativeScale = (abi: readonly { type: string; name?: string }[]) =>
      abi.some((entry) => entry.type === 'function' && entry.name === 'NATIVE_SCALE')

    expect(hasNativeScale(abis.ROUTER_NATIVE_ERC20_ABI)).toBe(true)
    expect(hasNativeScale(abis.ROUTER02_COLLECTION_ABI)).toBe(false)
  })
})
