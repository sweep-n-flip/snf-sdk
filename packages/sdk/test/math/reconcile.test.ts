import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

import { isSnfError } from '../../src/errors'
import { reconcileGross, reconcileNet } from '../../src/math/reconcile'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = resolve(HERE, '../../src')

describe('reconcileGross', () => {
  it('returns void when pool + marketplace + royalty === routerGross', () => {
    expect(
      reconcileGross({ pool: 100n, marketplace: 5n, royalty: 3n, routerGross: 108n }),
    ).toBeUndefined()
  })

  it('throws SnfError(QUOTE_RECONCILIATION_FAILED) on a 1-wei divergence, either direction', () => {
    expect(() =>
      reconcileGross({ pool: 100n, marketplace: 5n, royalty: 3n, routerGross: 109n }),
    ).toThrow(/Reconstructed amount/)
    expect(() =>
      reconcileGross({ pool: 100n, marketplace: 5n, royalty: 3n, routerGross: 107n }),
    ).toThrow()

    for (const routerGross of [109n, 107n]) {
      try {
        reconcileGross({ pool: 100n, marketplace: 5n, royalty: 3n, routerGross })
        expect.fail('expected reconcileGross to throw')
      } catch (e) {
        expect(isSnfError(e)).toBe(true)
        if (isSnfError(e)) expect(e.code).toBe('QUOTE_RECONCILIATION_FAILED')
      }
    }
  })

  it('the thrown SnfError carries pool/marketplace/royalty/reconstructed/router/deltaWei in details', () => {
    try {
      reconcileGross({ pool: 100n, marketplace: 5n, royalty: 3n, routerGross: 109n })
      expect.fail('expected reconcileGross to throw')
    } catch (e) {
      expect(isSnfError(e)).toBe(true)
      if (!isSnfError(e)) throw e
      expect(e.code).toBe('QUOTE_RECONCILIATION_FAILED')
      expect(e.details).toEqual({
        pool: 100n,
        marketplace: 5n,
        royalty: 3n,
        reconstructed: 108n,
        router: 109n,
        deltaWei: 1n,
      })
    }
  })

  it('never returns a "corrected" number — the only outcomes are void and throw', () => {
    const outcome = reconcileGross({ pool: 100n, marketplace: 5n, royalty: 3n, routerGross: 108n })
    expect(outcome).toBe(undefined)
  })
})

describe('reconcileNet', () => {
  it('asserts pool - marketplace - royalty === routerNet (the SELL direction)', () => {
    expect(
      reconcileNet({ pool: 108n, marketplace: 5n, royalty: 3n, routerNet: 100n }),
    ).toBeUndefined()
  })

  it('throws on a 1-wei divergence', () => {
    expect(() => reconcileNet({ pool: 108n, marketplace: 5n, royalty: 3n, routerNet: 101n })).toThrow()
  })
})

describe('negative proof: a >= comparison would let the 1-wei case pass', () => {
  it('documents that changing === to >= in reconcileGross would silently accept an over-charge', () => {
    // This test does not mutate reconcile.ts — it proves the assertion below is what
    // the real === comparison rejects, so a future accidental >= would be caught by
    // the "throws on a 1-wei divergence" case above, not silently pass here.
    const reconstructed = 100n + 5n + 3n // 108n
    const routerGrossHigher = 109n
    expect(reconstructed === routerGrossHigher).toBe(false)
    expect(reconstructed >= routerGrossHigher).toBe(false) // reconstructed is LOWER, so >= also fails here
    // The dangerous direction is routerGross <= reconstructed with reconstructed >
    // routerGross by 1 wei — a >= comparison (reconstructed >= routerGross) would
    // pass even though the two differ by exactly 1 wei.
    const routerGrossLower = 107n
    expect(reconstructed === routerGrossLower).toBe(false)
    expect(reconstructed >= routerGrossLower).toBe(true) // >= would WRONGLY pass here
  })
})

describe('static scan: no tolerance vocabulary in reconcile.ts or src/quote', () => {
  // reconcile.ts itself has ZERO legitimate reason to ever coerce through Number() or
  // parseFloat() — every comparison it makes is bigint `===`. src/quote/ (this wave's
  // stubs, and every future quote/* module) carries the same prohibition, since a
  // quote path is exactly where a float fudge would reach a reconciliation gate.
  //
  // This scan is deliberately narrower than "all of src/math/": nftPricing.ts
  // legitimately calls `Number()` once, to convert a *count* of whole NFTs (always a
  // small integer, bounded by realistic pool sizes) into the `n: number` the public
  // ladder API takes — that is not the float-tolerance class of bug this scan exists
  // to catch, and scanning the whole directory would false-flag it.
  const FORBIDDEN = /Math\.abs|epsilon|tolerance|Number\(|parseFloat/i

  function stripComments(source: string): string {
    return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '')
  }

  function collectTsFiles(dir: string): string[] {
    let entries: string[]
    try {
      entries = readdirSync(dir)
    } catch {
      return []
    }
    const files: string[] = []
    for (const entry of entries) {
      const full = join(dir, entry)
      if (statSync(full).isDirectory()) {
        files.push(...collectTsFiles(full))
      } else if (entry.endsWith('.ts')) {
        files.push(full)
      }
    }
    return files
  }

  it('reconcile.ts contains zero occurrences of Math.abs, epsilon, tolerance, Number(, parseFloat', () => {
    const cleaned = stripComments(readFileSync(join(SRC_DIR, 'math', 'reconcile.ts'), 'utf8'))
    expect(FORBIDDEN.test(cleaned)).toBe(false)
  })

  it('src/quote/ contains zero occurrences of Math.abs, epsilon, tolerance, Number(, parseFloat', () => {
    const quoteDir = join(SRC_DIR, 'quote')
    const hits: string[] = []
    for (const file of collectTsFiles(quoteDir)) {
      const cleaned = stripComments(readFileSync(file, 'utf8'))
      if (FORBIDDEN.test(cleaned)) hits.push(file)
    }
    expect(hits).toEqual([])
  })
})
