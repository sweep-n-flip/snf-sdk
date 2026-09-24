import { screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { describeError, SnfError, type CollectionInfo, type ExecutionPlan, type Quote, type SnfClient } from '@sweepnflip/sdk'
import { SnfTradeCard } from '../src/components/TradeCard'
import type { TradeCardCheckoutContextValue } from '../src/components/TradeCard/TradeCard.types'
import { fakeCollectionInfo, fakePlan, fakeQuote, renderWithSnf } from './setup'

/**
 * Focused, per-Part checks for `TradeCardInput`/`TradeCardQuoteBreakdown`/
 * `TradeCardSteps`, each rendered inside a REAL `<SnfTradeCard.Root>` (the only way a
 * Part ever legally mounts — `useTradeCardContext()` throws outside one) with a
 * stubbed `SnfClient`. The cross-cutting, whole-card proofs (and the
 * assembled-card echo) live in `TradeCardProof.test.tsx`; this file is the
 * per-Part half of the same coverage.
 *
 * The `TradeCardSteps` cases below reach a resolved `ExecutionPlan`, which mounts
 * `CheckoutMount` (`TradeCardRoot.tsx`) and therefore the REAL `useSnfCheckout` —
 * requiring a real `WagmiProvider` this suite never sets up. Per
 * this file's own toolchain finding (#19: mocking `wagmi` does not
 * reliably intercept when imported transitively through `@sweepnflip/sdk-react`),
 * `useSnfCheckout` is replaced with the SAME small controlled fake
 * `TradeCardRoot.test.tsx` established, mocking `@sweepnflip/sdk-react` at its own
 * package boundary rather than `wagmi` underneath it.
 */

const fakeCheckout = vi.hoisted(() => ({ hookSpy: vi.fn() }))

vi.mock('@sweepnflip/sdk-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sweepnflip/sdk-react')>()
  return {
    ...actual,
    useSnfCheckout: (plan: ExecutionPlan): TradeCardCheckoutContextValue => {
      fakeCheckout.hookSpy(plan)
      return {
        state: 'review',
        label: 'Confirm',
        canProceed: true,
        next: vi.fn(),
        cancel: vi.fn(),
        error: undefined,
        txHash: undefined,
      }
    },
  }
})

function hexAddress(char: string): `0x${string}` {
  return `0x${char.repeat(40)}` as `0x${string}`
}

const COLLECTION = hexAddress('c')
const RECIPIENT = hexAddress('f')

/** A stubbed `SnfClient` — `describeError` is the REAL implementation (mirrors
 * `TradeCardRoot.test.tsx`'s own `fakeClient`), so a rejected quote/build actually
 * classifies to a real `SnfError` the way a real client would. */
function fakeClient(overrides: Partial<SnfClient> = {}): SnfClient {
  return {
    chainId: 8453,
    chain: { chainId: 8453 } as SnfClient['chain'],
    collection: vi.fn(),
    poolInventory: vi.fn(),
    quoteBuy: vi.fn(),
    quoteSell: vi.fn(),
    quoteNftToNft: vi.fn(),
    quoteSwap: vi.fn(),
    estimateLadder: vi.fn(),
    buildBuy: vi.fn(),
    buildSell: vi.fn(),
    buildNftToNft: vi.fn(),
    buildSwap: vi.fn(),
    parseReceipt: vi.fn(),
    describeError,
    ...overrides,
  }
}

describe('TradeCardInput', () => {
  it('renders the resolved collection labels.name/labels.symbol and the params-derived quantity — never the raw address', async () => {
    // Deliberately builds on `fakeCollectionInfo()` (whose own `address` field is
    // address-shaped) but asserts on `labels.name`/`labels.symbol` — the ONLY fields
    // this Part ever reads for identity (CLAUDE.md's collection-identity rule). A
    // real name/symbol here proves the Part never falls back to rendering the raw
    // address even though the address is present right alongside it on the same
    // `CollectionInfo` value.
    const collectionInfo: CollectionInfo = {
      ...fakeCollectionInfo(),
      address: COLLECTION,
      labels: { name: 'Rasta Cats', symbol: 'RASTA' },
    }
    const client = fakeClient({ collection: vi.fn().mockResolvedValue(collectionInfo) })

    renderWithSnf(
      <SnfTradeCard.Root side="buy" collection={COLLECTION} count={3} recipient={RECIPIENT}>
        <SnfTradeCard.Input />
      </SnfTradeCard.Root>,
      { client },
    )

    await waitFor(() => expect(screen.getByTestId('input-collection-name').textContent).toBe('Rasta Cats'))
    expect(screen.getByTestId('input-collection-symbol').textContent).toBe('RASTA')
    expect(screen.getByTestId('input-quantity').textContent).toBe('3')
    // Negative proof: the raw collection address never appears anywhere in the
    // rendered tree, even though it is a real field on the same resolved value.
    expect(document.body.textContent).not.toContain(COLLECTION)
  })

  it('derives quantity from tokenIds.length when a concrete sell-side selection exists, not from count', async () => {
    const client = fakeClient({ collection: vi.fn().mockResolvedValue(fakeCollectionInfo()) })

    renderWithSnf(
      <SnfTradeCard.Root side="sell" collection={COLLECTION} tokenIds={['1', '2', '3', '4']} recipient={RECIPIENT}>
        <SnfTradeCard.Input />
      </SnfTradeCard.Root>,
      { client },
    )

    await waitFor(() => expect(screen.getByTestId('input-quantity').textContent).toBe('4'))
  })
})

describe('TradeCardQuoteBreakdown', () => {
  it('renders fees.marketplace.formatted/.symbol character-identical to what the quote returned', async () => {
    const quote: Quote = {
      ...fakeQuote(),
      fees: {
        pool: { bps: 200, note: 'included in curve' },
        marketplace: { value: 12345n, formatted: '1.2345 ETH', symbol: 'ETH', decimals: 18, bps: 250 },
        royalty: { value: 0n, formatted: '0.0000 ETH', symbol: 'ETH', decimals: 18, bps: 0, capApplied: false },
      },
      totalCost: { value: 12345n, formatted: '1.2345 ETH', symbol: 'ETH', decimals: 18 },
    }
    const client = fakeClient({
      collection: vi.fn().mockResolvedValue(fakeCollectionInfo()),
      quoteBuy: vi.fn().mockResolvedValue(quote),
    })

    renderWithSnf(
      <SnfTradeCard.Root side="buy" collection={COLLECTION} count={1} recipient={undefined}>
        <SnfTradeCard.QuoteBreakdown />
      </SnfTradeCard.Root>,
      { client },
    )

    await waitFor(() => expect(screen.getByTestId('quote-fee-marketplace').textContent).toBe('1.2345 ETH ETH'))
    expect(screen.getByTestId('quote-total-cost').textContent).toBe('1.2345 ETH ETH')
    expect(screen.getByTestId('quote-price-impact').textContent).toBe('0%')
  })

  it('renders the error code plus the default message, then a partner messages override replaces only the text', async () => {
    const client = fakeClient({
      collection: vi.fn().mockResolvedValue(fakeCollectionInfo()),
      quoteBuy: vi.fn().mockRejectedValue(new SnfError('WRONG_CHAIN', 'Your wallet is on the wrong network.')),
    })

    const { rerender } = renderWithSnf(
      <SnfTradeCard.Root side="buy" collection={COLLECTION} count={1} recipient={undefined}>
        <SnfTradeCard.QuoteBreakdown />
      </SnfTradeCard.Root>,
      { client },
    )

    await waitFor(() => expect(screen.getByTestId('quote-error').textContent).toContain('WRONG_CHAIN'))
    expect(screen.getByTestId('quote-error').getAttribute('data-error-code')).toBe('WRONG_CHAIN')
    expect(screen.getByTestId('quote-error').textContent).toContain('Your wallet is on the wrong network for this action.')

    rerender(
      <SnfTradeCard.Root
        side="buy"
        collection={COLLECTION}
        count={1}
        recipient={undefined}
        messages={{ WRONG_CHAIN: 'Custom copy for this partner.' }}
      >
        <SnfTradeCard.QuoteBreakdown />
      </SnfTradeCard.Root>,
    )

    await waitFor(() => expect(screen.getByTestId('quote-error').textContent).toContain('Custom copy for this partner.'))
    // The code is NEVER hidden by the override.
    expect(screen.getByTestId('quote-error').textContent).toContain('WRONG_CHAIN')
    expect(screen.getByTestId('quote-error').getAttribute('data-error-code')).toBe('WRONG_CHAIN')
  })
})

describe('TradeCardSteps', () => {
  it('renders exactly one <li> per plan.steps entry, in order, each carrying its own data-kind', async () => {
    const quote = fakeQuote()
    const plan = fakePlan(['approval', 'swap-buy'])
    const client = fakeClient({
      collection: vi.fn().mockResolvedValue(fakeCollectionInfo()),
      quoteBuy: vi.fn().mockResolvedValue(quote),
      buildBuy: vi.fn().mockResolvedValue(plan),
    })

    renderWithSnf(
      <SnfTradeCard.Root side="buy" collection={COLLECTION} count={1} recipient={RECIPIENT}>
        <SnfTradeCard.Steps />
      </SnfTradeCard.Root>,
      { client },
    )

    const items = await waitFor(() => {
      const found = screen.getAllByRole('listitem')
      expect(found).toHaveLength(2)
      return found
    })

    expect(items[0]?.getAttribute('data-kind')).toBe('approval')
    expect(items[1]?.getAttribute('data-kind')).toBe('swap-buy')
    expect(items[0]?.textContent).toBe('approval')
    expect(items[1]?.textContent).toBe('swap-buy')
  })

  it('renders an empty <ol> (no placeholder) before any plan exists', () => {
    const client = fakeClient({ collection: vi.fn().mockResolvedValue(fakeCollectionInfo()) })

    renderWithSnf(
      <SnfTradeCard.Root side="buy" collection={COLLECTION} count={1} recipient={undefined}>
        <SnfTradeCard.Steps />
      </SnfTradeCard.Root>,
      { client },
    )

    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
    expect(screen.getByRole('list').getAttribute('data-state')).toBe('idle')
  })
})
