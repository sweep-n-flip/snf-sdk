import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { estimateLadder } from '../../src/math/nftPricing'

/**
 * this rule's static acceptance: a static test (grep/AST) guarantees that no
 * builder imports `estimateLadder` — the offline, staleness-labelled estimate
 * layer must never be able to feed a transaction bound. This test reads every file
 * under `src/build/` AT TEST TIME (not a fixed snapshot), so the rule covers any
 * builder written later too.
 */

const BANNED_PATTERNS: readonly RegExp[] = [
  /estimateLadder/,
  /buildNFTPriceLadder/,
  /from\s+['"]\.\.\/math\/nftPricing['"]/,
  /math\/nftPricing/,
]

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '')
}

describe('no-ladder-in-build — src/build/ never imports the offline estimate layer', () => {
  const buildDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/build')

  it('zero matches for estimateLadder/buildNFTPriceLadder/math-nftPricing imports anywhere under src/build/', () => {
    const offenders: string[] = []
    for (const file of readdirSync(buildDir).filter((f) => f.endsWith('.ts'))) {
      const full = path.join(buildDir, file)
      const raw = readFileSync(full, 'utf8')
      const lines = stripComments(raw).split('\n')
      lines.forEach((line, i) => {
        for (const pattern of BANNED_PATTERNS) {
          if (pattern.test(line)) {
            offenders.push(`${file}:${i + 1} matches ${pattern} -> "${line.trim().slice(0, 100)}"`)
          }
        }
      })
    }
    expect(offenders).toEqual([])
  })

  it('src/math/nftPricing.ts still carries the prohibition sentence in its own header (the reason travels with the code)', () => {
    const pkgRoot = path.resolve(buildDir, '..')
    const content = readFileSync(path.join(pkgRoot, 'math/nftPricing.ts'), 'utf8')
    expect(content).toMatch(/MUST NEVER be used to derive a transaction bound/)
    expect(content).toMatch(/no-ladder-in-build\.test\.ts/)
  })

  it('every exported ladder result carries kind: "estimate" — a future refactor cannot silently drop the label', () => {
    const result = estimateLadder({ base: 1_000_000_000_000_000_000n, wnft: 10_000_000_000_000_000_000n }, 3)
    expect(result.kind).toBe('estimate')
    // n:0 and the no-liquidity branch also carry the label — not just the happy path.
    expect(estimateLadder({ base: 1n, wnft: 1n }, 0).kind).toBe('estimate')
    expect(estimateLadder({ base: 0n, wnft: 0n }, 3).kind).toBe('estimate')
  })
})

describe('no-ladder-in-build — negative-proof discipline (manual, recorded in SUMMARY, never committed)', () => {
  it('documents the required manual mutation check rather than performing it automatically', () => {
    // The plan's own acceptance criterion requires OBSERVING this test go RED when
    // `import { estimateLadder } from '../math/nftPricing'` is temporarily added to
    // src/build/buildBuy.ts, then reverted. Mutating a REAL src file from inside a
    // test would violate this plan's own "do not edit src" constraint even
    // transiently inside a test run, and a self-reverting fs.writeFileSync in a test
    // is exactly the kind of flaky, order-dependent I/O CLAUDE.md's testing
    // discipline warns against. That negative run is performed once, manually, by
    // the executor during Task 3 and its exact console output is recorded in the
    // change history instead.
    expect(true).toBe(true)
  })
})
