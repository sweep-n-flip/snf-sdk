import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { getChain } from '../src/chains/registry'
import {
  assertChainMatch,
  assertParam,
  isSnfError,
  SNF_ERROR_CODES,
  SnfError,
  toSnfError,
} from '../src/errors'
import { SNF_ERROR_RETRYABLE, type SnfErrorCode } from '../src/errors.types'

const HERE = dirname(fileURLToPath(import.meta.url))
const SRC_DIR = resolve(HERE, '../src')

describe('SNF_ERROR_CODES', () => {
  it('has exactly 12 members, no duplicates, every member SCREAMING_SNAKE ASCII', () => {
    expect(SNF_ERROR_CODES).toHaveLength(12)
    expect(new Set(SNF_ERROR_CODES).size).toBe(12)
    for (const code of SNF_ERROR_CODES) {
      expect(code, `code "${code}" is not SCREAMING_SNAKE`).toMatch(/^[A-Z_]+$/)
    }
  })

  it('includes USER_REJECTED and QUOTE_RECONCILIATION_FAILED (this phase\'s addendum)', () => {
    expect(SNF_ERROR_CODES).toContain('USER_REJECTED')
    expect(SNF_ERROR_CODES).toContain('QUOTE_RECONCILIATION_FAILED')
  })
})

describe('SnfError', () => {
  it('is an instanceof both SnfError and Error; isSnfError agrees; a plain Error is not', () => {
    const err = new SnfError('NO_ROUTE', 'x')
    expect(err instanceof SnfError).toBe(true)
    expect(err instanceof Error).toBe(true)
    expect(isSnfError(err)).toBe(true)
    expect(isSnfError(new Error('plain'))).toBe(false)
  })

  it('rejects an empty message by substituting the code default; details may be absent', () => {
    const err = new SnfError('UNKNOWN', '')
    expect(err.message.length).toBeGreaterThan(0)
    expect(err.message).not.toBe('')
    expect(err.details).toBeUndefined()
  })

  it('rejects a whitespace-only message the same way', () => {
    const err = new SnfError('UNKNOWN', '   ')
    expect(err.message.trim().length).toBeGreaterThan(0)
  })

  it('preserves a non-empty caller message verbatim', () => {
    const err = new SnfError('INVALID_PARAMS', 'count must be > 0')
    expect(err.message).toBe('count must be > 0')
  })

  it('carries details and cause when provided', () => {
    const cause = new Error('upstream')
    const err = new SnfError('UPSTREAM_DEGRADED', 'stale', { details: { lagSeconds: 900 }, cause })
    expect(err.details).toEqual({ lagSeconds: 900 })
    expect(err.cause).toBe(cause)
  })

  it('name is always "SnfError"', () => {
    expect(new SnfError('UNKNOWN', 'x').name).toBe('SnfError')
  })
})

describe('SNF_ERROR_RETRYABLE', () => {
  it('is true only for UPSTREAM_DEGRADED', () => {
    for (const code of SNF_ERROR_CODES) {
      const expected = code === 'UPSTREAM_DEGRADED'
      expect(SNF_ERROR_RETRYABLE[code], `code ${code}`).toBe(expected)
    }
  })

  it('SnfError.retryable is derived from the map, never overridable by the caller', () => {
    expect(new SnfError('UPSTREAM_DEGRADED', 'x').retryable).toBe(true)
    expect(new SnfError('NO_ROUTE', 'x').retryable).toBe(false)
  })
})

describe('assertParam', () => {
  it('throws SnfError(INVALID_PARAMS) when the condition is falsy', () => {
    expect(() => assertParam(false, 'bad input')).toThrow(SnfError)
    try {
      assertParam(0, 'count must be > 0', { count: 0 })
    } catch (err) {
      expect(isSnfError(err)).toBe(true)
      expect((err as SnfError).code).toBe('INVALID_PARAMS')
      expect((err as SnfError).details).toEqual({ count: 0 })
    }
  })

  it('does not throw when the condition is truthy', () => {
    expect(() => assertParam(true, 'unreachable')).not.toThrow()
  })
})

describe('assertChainMatch (Addendum)', () => {
  it('does not throw when argsChainId is omitted', () => {
    expect(() => assertChainMatch(undefined, 8453)).not.toThrow()
  })

  it('does not throw when argsChainId matches clientChainId', () => {
    expect(() => assertChainMatch(8453, 8453)).not.toThrow()
  })

  it('throws SnfError(WRONG_CHAIN) with both chainIds in details when they disagree', () => {
    try {
      assertChainMatch(1, 8453)
      throw new Error('expected assertChainMatch to throw')
    } catch (err) {
      expect(isSnfError(err)).toBe(true)
      const snfErr = err as SnfError
      expect(snfErr.code).toBe('WRONG_CHAIN')
      expect(snfErr.details).toEqual({ argsChainId: 1, clientChainId: 8453 })
      expect(snfErr.retryable).toBe(false)
    }
  })
})

describe('toSnfError', () => {
  it('returns the same instance unchanged when already an SnfError', () => {
    const original = new SnfError('WRONG_CHAIN', 'x')
    expect(toSnfError(original)).toBe(original)
  })

  it('wraps a plain Error, preserving it as cause, defaulting to UNKNOWN', () => {
    const plain = new Error('boom')
    const wrapped = toSnfError(plain)
    expect(isSnfError(wrapped)).toBe(true)
    expect(wrapped.code).toBe('UNKNOWN')
    expect(wrapped.message).toBe('boom')
    expect(wrapped.cause).toBe(plain)
  })

  it('wraps a string throwable and honors a supplied fallbackCode', () => {
    const wrapped = toSnfError('user rejected', 'USER_REJECTED')
    expect(wrapped.code).toBe('USER_REJECTED')
    expect(wrapped.message).toBe('user rejected')
  })
})

describe('registry.getChain uses SnfError (Placeholder resolved)', () => {
  it('throws SnfError with code INVALID_PARAMS and details.chainId for an unsupported id', () => {
    try {
      getChain(999999)
      throw new Error('expected getChain to throw')
    } catch (err) {
      expect(isSnfError(err)).toBe(true)
      expect((err as SnfError).code).toBe('INVALID_PARAMS')
      expect((err as SnfError).details?.chainId).toBe(999999)
    }
  })
})

// ── Static scan (Acceptance) ────────────────────────────────────────────
//
// 1. `throw new Error(` must occur zero times in src/, outside errors.ts itself.
// 2. Every `new SnfError('X'` call site's `X` must be a member of SNF_ERROR_CODES —
// catches a typo'd code the moment it's introduced, not at runtime in production.

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

describe('static scan: no bare `throw new Error(` outside errors.ts', () => {
  it('src/**/*.ts (excluding src/errors.ts) never contains `throw new Error(`', () => {
    const files: string[] = []
    walkTsFiles(SRC_DIR, files)

    const offenders: string[] = []
    for (const file of files) {
      const relPath = relative(SRC_DIR, file).split('\\').join('/')
      if (relPath === 'errors.ts') continue
      const stripped = stripComments(readFileSync(file, 'utf8'))
      stripped.split('\n').forEach((line, i) => {
        if (line.includes('throw new Error(')) {
          offenders.push(`${relPath}:${i + 1}  ${line.trim()}`)
        }
      })
    }
    expect(offenders).toEqual([])
  })
})

describe('static scan: every `new SnfError(...)` call site uses a code from SNF_ERROR_CODES', () => {
  it('scans src/**/*.ts for new SnfError(\'CODE\' and validates CODE against the closed union', () => {
    const files: string[] = []
    walkTsFiles(SRC_DIR, files)

    const codeSet: ReadonlySet<string> = new Set<SnfErrorCode>(SNF_ERROR_CODES)
    const offenders: string[] = []
    const pattern = /new SnfError\(\s*'([A-Z_]+)'/g

    for (const file of files) {
      const relPath = relative(SRC_DIR, file).split('\\').join('/')
      const stripped = stripComments(readFileSync(file, 'utf8'))
      for (const match of stripped.matchAll(pattern)) {
        const code = match[1]
        if (code !== undefined && !codeSet.has(code)) {
          offenders.push(`${relPath}: new SnfError('${code}'...) is not in SNF_ERROR_CODES`)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
