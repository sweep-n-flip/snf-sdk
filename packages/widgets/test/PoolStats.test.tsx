import type { ReactNode } from 'react'
import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { describeError, type CollectionInfo, type PoolInventory, type Quote, type SnfClient } from '@sweepnflip/sdk'
import { PoolStatsRoot } from '../src/components/PoolStats/PoolStatsRoot'
import { SnfPoolStats } from '../src/components/PoolStats'
import { fakeCollectionInfo, fakeQuote, renderWithSnf } from './setup'

/**
 * `PoolStats.test.tsx` — `<SnfPoolStats>`'s behavioural + styling proof,
 * mirroring `slot.test.tsx`'s own three-mechanism shape and
 * `TradeCardRoot.test.tsx`'s fixture/render conventions, scoped to `SnfPoolStats`.
 *
 * This word is never used anywhere in this file, its comments, or its test names —
 * see `PoolStatsRoot.tsx`'s header comment for the full resolution: this suite proves
 * the pool-only price for one NFT and the all-in cost render as the SDK's own
 * `Amount` values, verbatim, never a client-side ratio of reserves.
 */

const CSS_UNIT_SHAPED = /^-?\d+(\.\d+)?(px|rem|em|%)$/
const HEX_COLOR_SHAPED = /^#/

function hexAddress(char: string): `0x${string}` {
  return `0x${char.repeat(40)}` as `0x${string}`
}

const COLLECTION = hexAddress('a')
const PAIR = hexAddress('1')

/** A pool reserve shaped so a naive `reserves.wnft / 1e18` would NOT match the
 * fixture's own `availableCount` below — proving the rendered ceiling number came
 * from the SDK's own `PoolInventory.availableCount` field, never a local
 * recomputation from these reserves (this rule's literal acceptance criterion). */
function fakeCollectionInfoWithPool(): CollectionInfo {
  return {
    ...fakeCollectionInfo(),
    pools: [
      {
        pair: PAIR,
        baseToken: { address: null, symbol: 'ETH', decimals: 18, isNative: true },
        isNative: true,
        reserves: { base: 10_000000000000000000n, wnft: 5_000000000000000000n },
        wrapperIsToken0: false,
      },
    ],
  }
}

/** Deliberately does NOT satisfy `availableCount === floor(reserves.wnft / 1e18) − 1`
 * (the real formula `inventory.types.ts` documents `poolInventory` itself computes) —
 * this fixture's `availableCount` (41) has no arithmetic relationship to
 * `fakeCollectionInfoWithPool()`'s `reserves.wnft` (5e18, which that formula would
 * turn into 4), so a rendered `41` can only have come from reading the field itself. */
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
        pair: PAIR,
        count: 1,
        amount: { value: 1_000000000000000000n, formatted: '1.0', symbol: 'ETH', decimals: 18 },
        path: [PAIR],
        feeBps: 200,
        kind: 'wnft',
        side: 'buy',
      },
    ],
    totalCost: { value: 1_025000000000000000n, formatted: '1.025', symbol: 'ETH', decimals: 18 },
  }
}

/** Mirrors `TradeCardRoot.test.tsx`'s own local `fakeClient` — a stubbed `SnfClient`
 * (`vi.fn()` methods); `describeError` is the REAL implementation so a rejected
 * `quoteBuy` still resolves to a genuine `SnfError`. */
function fakeClient(overrides: Partial<SnfClient> = {}): SnfClient {
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
    ...overrides,
  }
}

function renderPoolStats(children: ReactNode, client: SnfClient) {
  return renderWithSnf(<PoolStatsRoot collection={COLLECTION}>{children}</PoolStatsRoot>, { client })
}

describe('styling mechanism (a): bare render carries nothing visual', () => {
  it('emits no style attribute and no color/size/spacing/font-shaped attribute value', async () => {
    renderPoolStats(
      <>
        <SnfPoolStats.Price />
        <SnfPoolStats.Reserves />
        <SnfPoolStats.Ceiling />
      </>,
      fakeClient(),
    )

    await waitFor(() => expect(screen.getByTestId('ceiling-available-count').textContent).toBe('41'))

    for (const testId of ['price-pool-leg', 'price-total-cost', 'reserves-base', 'reserves-wnft', 'ceiling-available-count']) {
      const node = screen.getByTestId(testId)
      const parent = node.parentElement
      expect(parent?.getAttribute('style')).toBeNull()
      for (const attr of Array.from(parent?.attributes ?? [])) {
        expect(attr.value).not.toMatch(CSS_UNIT_SHAPED)
        expect(attr.value).not.toMatch(HEX_COLOR_SHAPED)
      }
    }
  })
})

describe('styling mechanism (b): className merge — partner class survives on Root and Ceiling', () => {
  it('renders the partner class on both PoolStatsRoot and PoolStatsCeiling', async () => {
    const { container } = renderWithSnf(
      <PoolStatsRoot collection={COLLECTION} className="partner-root-class">
        <SnfPoolStats.Ceiling className="partner-ceiling-class" />
      </PoolStatsRoot>,
      { client: fakeClient() },
    )

    await waitFor(() => expect(screen.getByTestId('ceiling-available-count').textContent).toBe('41'))

    const rootNode = container.querySelector('[data-part="stats-root"]')
    expect(rootNode?.className).toContain('partner-root-class')

    const ceilingNode = container.querySelector('[data-part="ceiling"]')
    expect(ceilingNode?.className).toContain('partner-ceiling-class')
  })
})

describe('styling mechanism (c): asChild substitution on Price — clone, not wrap', () => {
  it('renders exactly the partner element, carrying the correct formatted price text', async () => {
    renderPoolStats(
      <SnfPoolStats.Price asChild>
        <span data-testid="partner-price" />
      </SnfPoolStats.Price>,
      fakeClient(),
    )

    const node = await screen.findByTestId('partner-price')
    expect(node.tagName).toBe('SPAN')

    await waitFor(() => expect(node.textContent).toContain('1.0'))
    expect(node.textContent).toContain('ETH')
    expect(node.textContent).toContain('1.025')
  })
})

describe('Amount fidelity: legs[0].amount is rendered character-identical, never reformatted', () => {
  it('renders exactly the fixture formatted/symbol pair, no rounding or reformatting', async () => {
    renderPoolStats(<SnfPoolStats.Price />, fakeClient())

    const poolLeg = await screen.findByTestId('price-pool-leg')
    await waitFor(() => expect(poolLeg.textContent).toBe('1.0 ETH'))

    const totalCost = screen.getByTestId('price-total-cost')
    expect(totalCost.textContent).toBe('1.025 ETH')
  })
})

describe('Error state exposes the code and resolves messages through resolveErrorMessage', () => {
  it('renders the default English message and the code for a rejected quote', async () => {
    const client = fakeClient({
      quoteBuy: () => Promise.reject(new Error('NO_ROUTE: nothing to price')),
    })

    renderPoolStats(<SnfPoolStats.Price />, client)

    const errorNode = await screen.findByTestId('price-error')
    expect(errorNode.getAttribute('data-error-code')).toBe('UNKNOWN')
    expect(errorNode.textContent).toBe('Something went wrong — please try again.')
  })

  it('renders a partner-supplied message override instead of the default', async () => {
    const client = fakeClient({
      quoteBuy: () => Promise.reject(new Error('NO_ROUTE: nothing to price')),
    })

    renderWithSnf(
      <PoolStatsRoot collection={COLLECTION} messages={{ UNKNOWN: 'Custom copy for this partner.' }}>
        <SnfPoolStats.Price />
      </PoolStatsRoot>,
      { client },
    )

    const errorNode = await screen.findByTestId('price-error')
    expect(errorNode.textContent).toBe('Custom copy for this partner.')
  })
})

describe("The buyable ceiling is the SDK's own field, never a recomputation from reserves", () => {
  it('renders availableCount exactly as the fixture gives it, matching neither a naive reserves.wnft/1e18 nor that minus one', async () => {
    renderPoolStats(<SnfPoolStats.Ceiling />, fakeClient())

    const inventory = fakePoolInventoryMismatched()
    // `findByTestId` alone would resolve on the FIRST render (the "no data yet"
    // fallback also renders this same testid, with a `—` placeholder) — waiting on
    // the actual expected content is what proves the real, loaded fixture value
    // rendered, not merely that the element eventually exists.
    await waitFor(() => expect(screen.getByTestId('ceiling-available-count').textContent).toBe('41'))
    const node = screen.getByTestId('ceiling-available-count')

    expect(node.textContent).toBe(String(inventory.availableCount))
    expect(node.textContent).toBe('41')
    // The pool's own reserves (5e18) would naively suggest 5 (or 4, minus-one) — the
    // rendered figure is neither, proving it came from `PoolInventory.availableCount`
    // itself, not a local recomputation.
    expect(node.textContent).not.toBe('5')
    expect(node.textContent).not.toBe('4')
  })

  it('also renders source/staleness/lag as supporting context, verbatim off the same PoolInventory', async () => {
    renderPoolStats(<SnfPoolStats.Ceiling />, fakeClient())

    await waitFor(() => expect(screen.getByTestId('ceiling-source').textContent).toBe('enumerable'))
    expect(screen.getByTestId('ceiling-stale').textContent).toBe('fresh')
    expect(screen.getByTestId('ceiling-lag-seconds').textContent).toBe('3')
  })
})

describe('Reserves render raw bigints via .toString() only, never a division', () => {
  it('renders the exact wei-shaped reserve strings plus their symbols', async () => {
    renderPoolStats(<SnfPoolStats.Reserves />, fakeClient())

    // Same reasoning as the ceiling case above: the "no pool yet" fallback renders
    // this same testid with a `—` placeholder, so waiting on the actual expected text
    // (not merely element presence) is what proves the loaded reserve rendered.
    await waitFor(() => expect(screen.getByTestId('reserves-base').textContent).toBe('10000000000000000000 ETH'))
    const base = screen.getByTestId('reserves-base')
    expect(base.textContent).toBe('10000000000000000000 ETH')

    const wnft = screen.getByTestId('reserves-wnft')
    expect(wnft.textContent).toBe('5000000000000000000 FAKE')
  })
})
