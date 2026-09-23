import { createElement, useCallback, useMemo, useSyncExternalStore, type ReactNode } from 'react'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  describeError,
  SnfError,
  type CheckoutSnapshot,
  type CollectionInfo,
  type ExecutionPlan,
  type PoolInventory,
  type Quote,
  type SnfClient,
} from '@sweepnflip/sdk'
import { createCheckout } from '@sweepnflip/sdk/checkout'
import { SnfTradeCard } from '../src/components/TradeCard'
import { PoolStatsRoot } from '../src/components/PoolStats/PoolStatsRoot'
import { SnfPoolStats } from '../src/components/PoolStats'
import type { TradeCardCheckoutContextValue } from '../src/components/TradeCard/TradeCard.types'
import { fakeCollectionInfo, fakePlan, fakeQuote, renderWithSnf } from './setup'
// The whole point under test (D-06, R7): a theme import sitting anywhere in this
// file's module graph must change appearance only, never behaviour. `sideEffects:
// ["*.css"]` in package.json keeps a bundler from ever dropping this import as
// dead — the exact reason that field exists (tsup.config.ts's own header comment).
import '../src/theme.css'

/**
 * `theme.test.ts` — the two proofs D-06/R7 stand on (56-SPEC.md; this plan's own
 * `must_haves.truths`):
 *
 * 1. **The default entry point pulls in no stylesheet.** Read straight off the
 *    already-built `dist/index.js`/`dist/index.cjs` (a fresh `pnpm -r build` is
 *    assumed to have already run — this file reads build OUTPUT, it never invokes
 *    `pnpm build` itself, consistent with this repo's other build-output
 *    assertions, e.g. `grep-gate.mjs` scanning every package's own dist directory
 *    (do not spell that path with a literal glob here — it closes this comment).
 * 2. **Importing the theme changes appearance only.** jsdom does not run a real CSS
 *    cascade, so "the DOM looks different" is not a trustworthy assertion here —
 *    the real proof is behavioural: this file statically imports `../src/theme.css`
 *    above (a plain side-effect import — Vitest's default `test.css: false` treats
 *    it as a no-op module in this jsdom environment, so it neither throws nor
 *    applies any style), then RE-RUNS one full behavioural case from
 *    `TradeCardProof.test.tsx` (R8's single-dispatch-per-click case) and one from
 *    `PoolStats.test.tsx` (R5's ceiling-fidelity case) verbatim, with that import
 *    present. Both harnesses below are deliberate, faithful copies of those two
 *    files' own fixtures/mocks (not new test content) — the point of this file is
 *    that the SAME assertions hold identically with the theme in the module graph,
 *    not to invent new behaviour to test. This file stays a plain `.ts` module (no
 *    JSX syntax — `test/theme.test.ts`, not `.tsx`), so every element is built via
 *    `createElement` rather than JSX.
 */

// jsdom (this project's `environment: 'jsdom'`) shadows the global `URL`
// constructor with its own browser-safe implementation, which silently resolves
// `new URL('../dist', import.meta.url)` against jsdom's `window.location`
// (`http://localhost:3000/...`) instead of the file-URL base actually passed in —
// `fileURLToPath` then rejects it ("The URL must be of scheme file"). Passing the
// raw `import.meta.url` STRING straight to `fileURLToPath` (never through `new
// URL(...)`) sidesteps jsdom's constructor entirely and resolves correctly; `dirname`
// + `join` do the relative-path arithmetic `new URL('../dist', ...)` would have.
const DIST_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist')

describe('D-06 / T-56-15 — the default entry point pulls in no stylesheet', () => {
  it('dist/index.js contains no .css reference', () => {
    const content = readFileSync(join(DIST_DIR, 'index.js'), 'utf8')
    expect(content).not.toContain('.css')
  })

  it('dist/index.cjs contains no .css reference', () => {
    const content = readFileSync(join(DIST_DIR, 'index.cjs'), 'utf8')
    expect(content).not.toContain('.css')
  })

  it('dist/theme.css exists as a SEPARATE, non-empty file', () => {
    const themePath = join(DIST_DIR, 'theme.css')
    expect(existsSync(themePath)).toBe(true)
    expect(statSync(themePath).size).toBeGreaterThan(0)
  })
})

describe('R7 amendment (2026-09-23) — no component rule applies without the [data-snf-theme] opt-in ancestor', () => {
  it('every selector in dist/theme.css, other than :root, is prefixed with [data-snf-theme]', () => {
    const content = readFileSync(join(DIST_DIR, 'theme.css'), 'utf8')
    // Strip block comments first (the header doc-comment is prose, not a selector) —
    // same technique this repo's own `scripts/grep-gate.mjs` uses before pattern
    // matching, reused here rather than reinvented.
    const withoutComments = content.replace(/\/\*[\s\S]*?\*\//g, '')

    // Every CSS rule in this file opens with `<selector> {` on its own logical
    // grouping — collecting every line ending in `{` and dropping its trailing brace
    // recovers the selector list for that rule. This file has no nested rules, no
    // `@media`/`@supports` blocks and no other `{`-bearing construct, so a plain
    // line scan is a faithful, dependency-free parse (no CSS tooling per this
    // phase's toolchain rule) rather than a real parser.
    const selectorGroups = withoutComments
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.endsWith('{'))
      .map((line) => line.slice(0, -1).trim())
      .filter((selector) => selector !== ':root')

    // Sanity: the file actually has component rules to check (a false-negative
    // guard against this test silently checking zero selectors after a future
    // refactor).
    expect(selectorGroups.length).toBeGreaterThan(0)

    for (const group of selectorGroups) {
      // A comma-separated selector list (e.g. the four `action` busy-state
      // selectors) must have EVERY branch scoped, not just the first.
      const branches = group.split(',').map((s) => s.trim())
      for (const branch of branches) {
        expect(branch.startsWith('[data-snf-theme]')).toBe(true)
      }
    }
  })

  it('the :root custom-property block is deliberately NOT scoped — a partner can still override a token globally', () => {
    const content = readFileSync(join(DIST_DIR, 'theme.css'), 'utf8')
    const withoutComments = content.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(withoutComments).toMatch(/(^|\n)\s*:root\s*\{/)
    expect(withoutComments).not.toMatch(/\[data-snf-theme\]\s*:root/)
  })
})

// ---------------------------------------------------------------------------------
// R8 harness — copied field-for-field from `TradeCardProof.test.tsx` (see that
// file's own header comment for why `@sweepnflip/sdk-react` is mocked at its own
// package boundary rather than mocking `wagmi` directly: mocking `wagmi` does not
// reliably intercept when it is imported transitively through `@sweepnflip/
// sdk-react` from a DIFFERENT package). `vi.mock` is per-file in Vitest, so this
// mock only ever applies within this file's own module graph — it cannot leak into
// or collide with `TradeCardProof.test.tsx`'s own copy of the same mock.
// ---------------------------------------------------------------------------------

const dispatchMocks = vi.hoisted(() => ({ sendTransactionAsync: vi.fn() }))

vi.mock('@sweepnflip/sdk-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sweepnflip/sdk-react')>()
  return {
    ...actual,
    useSnfCheckout: (plan: ExecutionPlan): TradeCardCheckoutContextValue => useFakeCheckout(plan),
  }
})

function useFakeCheckout(plan: ExecutionPlan): TradeCardCheckoutContextValue {
  const store = useMemo(() => {
    const session = createCheckout(plan)
    let cached: CheckoutSnapshot = session.snapshot()
    const subscribe = (onStoreChange: () => void): (() => void) =>
      session.subscribe(() => {
        cached = session.snapshot()
        onStoreChange()
      })
    const getSnapshot = (): CheckoutSnapshot => cached
    return { session, subscribe, getSnapshot }
  }, [plan])

  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

  const next = useCallback(async (): Promise<void> => {
    const step = store.session.next()
    if (step === null) return
    try {
      const hash = await dispatchMocks.sendTransactionAsync(step.tx)
      store.session.onReceipt({
        status: 'success',
        transactionHash: hash as `0x${string}`,
        blockNumber: 1n,
        logs: [],
      })
    } catch (err) {
      store.session.onRejected(
        err instanceof SnfError ? err : new SnfError('USER_REJECTED', 'The wallet rejected the signature request.'),
      )
    }
  }, [store])

  const cancel = useCallback((): void => store.session.cancel(), [store])

  return {
    state: snapshot.state,
    label: snapshot.label,
    canProceed: snapshot.canProceed,
    next,
    cancel,
    error: snapshot.error,
    txHash: undefined,
  }
}

function hexAddress(char: string): `0x${string}` {
  return `0x${char.repeat(40)}` as `0x${string}`
}

const TRADE_CARD_COLLECTION = hexAddress('c')
const TRADE_CARD_RECIPIENT = hexAddress('f')

function fakeTradeCardClient(): SnfClient {
  return {
    chainId: 8453,
    chain: { chainId: 8453 } as SnfClient['chain'],
    collection: vi.fn().mockResolvedValue(fakeCollectionInfo()),
    poolInventory: vi.fn(),
    quoteBuy: vi.fn().mockResolvedValue(fakeQuote()),
    quoteSell: vi.fn(),
    quoteNftToNft: vi.fn(),
    quoteSwap: vi.fn(),
    estimateLadder: vi.fn(),
    buildBuy: vi.fn().mockResolvedValue(fakePlan(['approval', 'swap-buy'])),
    buildSell: vi.fn(),
    buildNftToNft: vi.fn(),
    buildSwap: vi.fn(),
    parseReceipt: vi.fn(),
    describeError,
  }
}

function renderAssembledCard(client: SnfClient) {
  return renderWithSnf(
    createElement(SnfTradeCard.Root, {
      side: 'buy',
      collection: TRADE_CARD_COLLECTION,
      count: 1,
      recipient: TRADE_CARD_RECIPIENT,
      // `SnfTradeCardRootProps.children` is REQUIRED (not optional) — `createElement`'s
      // rest-args overload only applies when a props type's `children` is optional, so
      // it is passed as an explicit props field here instead (same value shape either
      // way: a `ReactNode`, which an array of elements satisfies).
      children: [
        createElement(SnfTradeCard.Input),
        createElement(SnfTradeCard.QuoteBreakdown),
        createElement(SnfTradeCard.Steps),
        createElement(SnfTradeCard.Action),
      ],
    }),
    { client },
  )
}

// ---------------------------------------------------------------------------------
// R5 harness — copied field-for-field from `PoolStats.test.tsx`.
// ---------------------------------------------------------------------------------

const POOL_STATS_COLLECTION = hexAddress('a')
const POOL_STATS_PAIR = hexAddress('1')

function fakeCollectionInfoWithPool(): CollectionInfo {
  return {
    ...fakeCollectionInfo(),
    pools: [
      {
        pair: POOL_STATS_PAIR,
        baseToken: { address: null, symbol: 'ETH', decimals: 18, isNative: true },
        isNative: true,
        reserves: { base: 10_000000000000000000n, wnft: 5_000000000000000000n },
        wrapperIsToken0: false,
      },
    ],
  }
}

/** Deliberately does NOT satisfy `availableCount === floor(reserves.wnft / 1e18) − 1`
 * — see `PoolStats.test.tsx`'s own identical fixture for the full rationale. */
function fakePoolInventoryMismatched(): PoolInventory {
  return {
    tokenIds: [],
    availableCount: 41,
    asOfBlock: 1n,
    lagSeconds: 3,
    stale: false,
    source: 'enumerable',
    truncated: false,
    warnings: [],
  }
}

function fakeQuoteWithAmounts(): Quote {
  return {
    ...fakeQuote(),
    legs: [
      {
        pair: POOL_STATS_PAIR,
        count: 1,
        amount: { value: 1_000000000000000000n, formatted: '1.0', symbol: 'ETH', decimals: 18 },
        path: [POOL_STATS_PAIR],
        feeBps: 200,
        kind: 'wnft',
        side: 'buy',
      },
    ],
    totalCost: { value: 1_025000000000000000n, formatted: '1.025', symbol: 'ETH', decimals: 18 },
  }
}

function fakePoolStatsClient(): SnfClient {
  return {
    chainId: 8453,
    chain: { chainId: 8453 } as SnfClient['chain'],
    collection: () => Promise.resolve(fakeCollectionInfoWithPool()),
    poolInventory: () => Promise.resolve(fakePoolInventoryMismatched()),
    quoteBuy: () => Promise.resolve(fakeQuoteWithAmounts()),
    quoteSell: () => Promise.reject(new Error('not used by this suite')),
    quoteNftToNft: () => Promise.reject(new Error('not used by this suite')),
    quoteSwap: () => Promise.reject(new Error('not used by this suite')),
    estimateLadder: () => {
      throw new Error('not used by this suite')
    },
    buildBuy: () => Promise.reject(new Error('not used by this suite')),
    buildSell: () => Promise.reject(new Error('not used by this suite')),
    buildNftToNft: () => Promise.reject(new Error('not used by this suite')),
    buildSwap: () => Promise.reject(new Error('not used by this suite')),
    parseReceipt: () => {
      throw new Error('not used by this suite')
    },
    describeError,
  }
}

function renderPoolStats(children: ReactNode, client: SnfClient) {
  // Same `children`-is-required reasoning as `renderAssembledCard` above.
  return renderWithSnf(createElement(PoolStatsRoot, { collection: POOL_STATS_COLLECTION, children }), { client })
}

beforeEach(() => {
  dispatchMocks.sendTransactionAsync.mockReset()
  dispatchMocks.sendTransactionAsync.mockResolvedValue('0xaa')
})

describe('R7 — importing the theme changes appearance only, never behaviour', () => {
  it('(a) the static import above resolves without throwing, and re-importing the same component modules yields the identical (cached) export identity', async () => {
    const tradeCardAgain = await import('../src/components/TradeCard')
    const poolStatsAgain = await import('../src/components/PoolStats')
    expect(tradeCardAgain.SnfTradeCard).toBe(SnfTradeCard)
    expect(poolStatsAgain.SnfPoolStats).toBe(SnfPoolStats)
  })

  it('(b) TradeCard: exactly one dispatch per click still holds with the theme import present (verbatim re-run of TradeCardProof.test.tsx’s R8 case)', async () => {
    const client = fakeTradeCardClient()
    renderAssembledCard(client)

    await waitFor(() => expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false))
    const button = screen.getByRole('button') as HTMLButtonElement

    expect(dispatchMocks.sendTransactionAsync).not.toHaveBeenCalled()

    const firstLabel = button.textContent
    fireEvent.click(button)
    expect(button.disabled).toBe(true)
    expect(dispatchMocks.sendTransactionAsync).toHaveBeenCalledTimes(1)

    await waitFor(() => expect(button.disabled).toBe(false))
    const secondLabel = button.textContent
    expect(secondLabel).not.toBe(firstLabel)
    expect(dispatchMocks.sendTransactionAsync).toHaveBeenCalledTimes(1)

    dispatchMocks.sendTransactionAsync.mockResolvedValueOnce('0xbb')
    fireEvent.click(button)
    expect(dispatchMocks.sendTransactionAsync).toHaveBeenCalledTimes(2)

    await waitFor(() => expect(button.textContent).not.toBe(secondLabel))
    expect(dispatchMocks.sendTransactionAsync).toHaveBeenCalledTimes(2)
  })

  it('(c) PoolStats: the ceiling still renders the SDK’s own availableCount, never a recomputation, with the theme import present (verbatim re-run of PoolStats.test.tsx’s R5 case)', async () => {
    renderPoolStats(createElement(SnfPoolStats.Ceiling), fakePoolStatsClient())

    const inventory = fakePoolInventoryMismatched()
    // Same reasoning as the original: `findByTestId` alone would resolve on the
    // FIRST render (the "no data yet" fallback shares the same testid with a `—`
    // placeholder) — waiting on the actual expected content proves the real, loaded
    // fixture value rendered.
    await waitFor(() => expect(screen.getByTestId('ceiling-available-count').textContent).toBe('41'))
    const node = screen.getByTestId('ceiling-available-count')

    expect(node.textContent).toBe(String(inventory.availableCount))
    expect(node.textContent).toBe('41')
    expect(node.textContent).not.toBe('5')
    expect(node.textContent).not.toBe('4')
  })
})
