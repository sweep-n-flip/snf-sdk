import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { SNF_CHAINS } from '../../src/chains/registry'
import {
  assertExactNativeMultiple,
  floorNativeValue,
  fromNativeValue,
  getQuoteScale,
  toNativeValue,
} from '../../src/chains/units'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = resolve(HERE, '../../src')
const ARC = 5042
const BASE = 8453

describe('units', () => {
  it('getQuoteScale is 1n for every WETH9 chain and 1_000_000_000_000n on Arc', () => {
    for (const chain of SNF_CHAINS) {
      if (chain.chainId === ARC) {
        expect(getQuoteScale(chain.chainId)).toBe(1_000_000_000_000n)
      } else {
        expect(getQuoteScale(chain.chainId), `chain ${chain.chainId}`).toBe(1n)
      }
    }
  })

  it('round-trips toNativeValue/fromNativeValue on every chain for a table of quote amounts', () => {
    const amounts = [0n, 1n, 1_000n, 1_000_000n, 123_456_789n]
    for (const chain of SNF_CHAINS) {
      for (const amount of amounts) {
        const wei = toNativeValue(chain.chainId, amount)
        expect(fromNativeValue(chain.chainId, wei), `chain ${chain.chainId} amount ${amount}`).toBe(
          amount,
        )
      }
    }
  })

  it('fromNativeValue refuses a non-exact multiple; floorNativeValue reproduces the contract floor', () => {
    const wei = 1_000_000_000_001n // one Arc quote unit's worth of dust (remainder 1)
    let threw = false
    try {
      fromNativeValue(ARC, wei)
    } catch (err) {
      threw = true
      expect((err as { code?: string }).code).toBe('INVALID_PARAMS')
      expect((err as { details?: { remainder?: bigint } }).details?.remainder).toBe(1n)
    }
    expect(threw).toBe(true)
    expect(floorNativeValue(ARC, wei)).toBe(1n)
  })

  it('assertExactNativeMultiple throws on the same non-exact input fromNativeValue rejects', () => {
    expect(() => assertExactNativeMultiple(ARC, 1_000_000_000_001n)).toThrow()
    expect(() => assertExactNativeMultiple(ARC, 1_000_000_000_000n)).not.toThrow()
  })

  it('the Arc/WETH9 ratio is exactly 1e12, never 1', () => {
    expect(toNativeValue(ARC, 1n) / 1n).toBe(1_000_000_000_000n)
    expect(toNativeValue(BASE, 1n)).toBe(1n)
  })
})

// ── Static gate: no 1e18/parseEther/formatEther/parseUnits(x, 18) outside units.ts ──
//
// Port of an equivalent static gate from the reference production client's own test
// suite. A pool-side amount must NEVER be scaled by a bare 18-decimal literal
// anywhere except this module — that literal is exactly the regression class that
// produces INSUFFICIENT_OUTPUT_AMOUNT on every Arc NFT trade. Any future `build/` module that
// legitimately needs an 18-decimal EVM-side literal (e.g. deriving `tx.value` bounds)
// must be added to ALLOWED with a one-line justification, not silently pass the gate.
const ALLOWED = [
  'chains/units.ts', // this module IS the sanctioned 18-decimal <-> quoteDecimals boundary
]

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '')
}

function walkTsFiles(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      walkTsFiles(full, out)
    } else if (entry.endsWith('.ts')) {
      out.push(full)
    }
  }
}

describe('static gate: no 18-decimal literal leaks into pool-side code', () => {
  it('1e18 / parseEther / formatEther / parseUnits(x, 18) appear only in the allow-list', () => {
    const files: string[] = []
    walkTsFiles(SRC_DIR, files)

    const offenders: string[] = []
    for (const file of files) {
      const relPath = relative(SRC_DIR, file).split('\\').join('/')
      if (ALLOWED.includes(relPath)) continue
      const stripped = stripComments(readFileSync(file, 'utf8'))
      stripped.split('\n').forEach((line, i) => {
        if (
          line.includes('1e18') ||
          line.includes('parseEther(') ||
          line.includes('formatEther(') ||
          /parseUnits\([^)]*,\s*18\s*\)/.test(line)
        ) {
          offenders.push(`${relPath}:${i + 1}  ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})
