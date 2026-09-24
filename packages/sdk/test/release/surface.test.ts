import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * snf-54-20 (R21, REQ-SDK-01, REQ-SDK-52, T-54-117). Three things this test proves
 * about the PUBLISHED package, not the source:
 *
 *  1. The built `dist/index.js` public surface of both packages is EXACTLY the
 *     inline, sorted list below — an accidental new export (or a removed one) shows
 *     up as a diff on this file, not a silent surface change nobody reviewed.
 *  2. Every domain operation stays a method on the client `createSnfClient` returns —
 *     `quoteBuy`/`buildBuy`/`resolveCollection` are never free-standing exports
 *     (`src/index.ts`'s own header comment explains why: a second, undocumented
 *     entry point this package would then have to keep compatible forever).
 *  3. The root README's `## Quickstart` fenced block is real code an example
 *     ACTUALLY runs — every non-comment line of it must appear, verbatim after
 *     whitespace normalisation, in `examples/vanilla/src/index.mjs` or
 *     `examples/next-app/src/components/SwapPanel.tsx`. A quickstart no example runs
 *     is documentation that will rot (T-54-117).
 *
 * Imports the BUILT `dist/index.js` (not `src/index.ts`) deliberately — a type-only
 * re-export or a tree-shaken-away symbol would still type-check against `src`, but
 * only the built artifact is what a partner actually receives from `npm install`.
 * Requires `pnpm -r build` to have run first (same precondition `test/abis/
 * inventory.test.ts` and every fork test already have for their own build-derived
 * inputs).
 */

const HERE = dirname(fileURLToPath(import.meta.url))
// packages/sdk/test/release -> packages/sdk -> repo root
const ROOT = resolve(HERE, '../../../..')
const SDK_DIST = resolve(HERE, '../../dist/index.js')
const SDK_REACT_DIST = resolve(ROOT, 'packages/sdk-react/dist/index.js')

const CORE_EXPORTS = [
  'MULTICALL3_ADDRESS',
  'SDK_VERSION',
  'SNF_CHAINS',
  'SNF_CHAIN_IDS',
  'SNF_ERROR_CODES',
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
  'toSnfError',
  'tokenLink',
  'txLink',
]

const ADAPTER_EXPORTS = [
  'SnfProvider',
  'useSnfCheckout',
  'useSnfClient',
  'useSnfCollection',
  'useSnfPoolInventory',
  'useSnfQuoteBuy',
  'useSnfQuoteNftToNft',
  'useSnfQuoteSell',
]

describe('public surface snapshot (built dist/index.js, R21/REQ-SDK-01)', () => {
  it('@sweepnflip/sdk exports exactly this sorted list — no more, no fewer', async () => {
    const mod = (await import(pathToFileURL(SDK_DIST).href)) as Record<string, unknown>
    expect(Object.keys(mod).sort()).toEqual([...CORE_EXPORTS].sort())
  })

  it('the documented client-facing exports are all present', async () => {
    const mod = (await import(pathToFileURL(SDK_DIST).href)) as Record<string, unknown>
    const names = Object.keys(mod)
    for (const expected of [
      'createSnfClient',
      'SNF_CHAINS',
      'getChain',
      'SnfError',
      'SNF_ERROR_CODES',
      'describeError',
      'txLink',
      'formatAmount',
      'SDK_VERSION',
      'abis',
    ]) {
      expect(names, `missing documented export: ${expected}`).toContain(expected)
    }
  })

  it('exports no free-standing domain function — every op stays a method on the client createSnfClient returns', async () => {
    const mod = (await import(pathToFileURL(SDK_DIST).href)) as Record<string, unknown>
    const names = Object.keys(mod)
    for (const forbidden of ['quoteBuy', 'buildBuy', 'resolveCollection']) {
      expect(names, `${forbidden} must not be a free-standing export`).not.toContain(forbidden)
    }
  })

  // Longer timeout than this file's other `import()`s: resolving `@sweepnflip/sdk-react`'s
  // dist pulls in its externalised peers (react, wagmi, @tanstack/react-query) through
  // vitest's own module graph/transform pipeline, which is slower than a plain `node -e`
  // import of the same file (~1.3s measured directly) but still well inside 15s.
  it(
    '@sweepnflip/sdk-react exports exactly the eight SnfProvider/useSnf* names',
    async () => {
      const mod = (await import(pathToFileURL(SDK_REACT_DIST).href)) as Record<string, unknown>
      expect(Object.keys(mod).sort()).toEqual([...ADAPTER_EXPORTS].sort())
    },
    15000,
  )
})

describe('README quickstart drift (T-54-117)', () => {
  function normalize(s: string): string {
    return s.replace(/\s+/g, ' ').trim()
  }

  /** Strips a trailing `//` comment from one line (matches `scripts/grep-gate.mjs`'s
   * own convention) and drops the line entirely if nothing but whitespace remains —
   * a pure-comment line (e.g. "// send each step...") documents intent without being
   * code an example is required to literally run. */
  function nonCommentLines(block: string): string[] {
    return block
      .split('\n')
      .map((line) => {
        const idx = line.indexOf('//')
        return idx === -1 ? line : line.slice(0, idx)
      })
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
  }

  function extractQuickstart(readme: string): string {
    // Everything between the `## Quickstart` heading and the NEXT `##` heading (so a
    // prose lead-in paragraph before the fence is fine), then the first fenced ```ts
    // block inside that section.
    const sectionMatch = readme.match(/## Quickstart\n([\s\S]*?)(?:\n## |$)/)
    const section = sectionMatch?.[1]
    if (!section) throw new Error('README.md has no "## Quickstart" section')
    const fenceMatch = section.match(/```ts\n([\s\S]*?)```/)
    if (!fenceMatch?.[1]) throw new Error('README.md\'s "## Quickstart" section has no fenced ```ts block')
    return fenceMatch[1]
  }

  const readme = readFileSync(resolve(ROOT, 'README.md'), 'utf8')
  const vanillaSource = readFileSync(resolve(ROOT, 'examples/vanilla/src/index.mjs'), 'utf8')
  const nextAppSource = readFileSync(resolve(ROOT, 'examples/next-app/src/components/SwapPanel.tsx'), 'utf8')
  const vanillaNormalized = normalize(vanillaSource)
  const nextAppNormalized = normalize(nextAppSource)

  const quickstartBlock = extractQuickstart(readme)
  const lines = nonCommentLines(quickstartBlock)

  it('the quickstart block is non-empty', () => {
    expect(lines.length).toBeGreaterThan(0)
  })

  it('is at most 20 non-comment, non-blank lines (R1/AC #2)', () => {
    expect(lines.length).toBeLessThanOrEqual(20)
  })

  it.each(lines.map((line, i): [number, string] => [i, line]))(
    'line %i is real code an example actually runs: %s',
    (_i, line) => {
      const needle = normalize(line)
      const inVanilla = vanillaNormalized.includes(needle)
      const inNextApp = nextAppNormalized.includes(needle)
      expect(
        inVanilla || inNextApp,
        `quickstart line not found (verbatim, whitespace-normalised) in examples/vanilla/src/index.mjs ` +
          `or examples/next-app/src/components/SwapPanel.tsx: "${line}"`,
      ).toBe(true)
    },
  )
})
