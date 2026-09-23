import type { ReactNode } from 'react'
import { act, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { describeError, type CollectionInfo, type ExecutionPlan, type SnfClient } from '@sweepnflip/sdk'
import { TradeCardRoot } from '../src/components/TradeCard/TradeCardRoot'
import { useTradeCardCheckout, useTradeCardContext } from '../src/components/TradeCard/context'
import type { TradeCardCheckoutContextValue } from '../src/components/TradeCard/TradeCard.types'
import { fakeCollectionInfo, fakePlan, fakeQuote, renderWithSnf } from './setup'

/**
 * R4/R8/D-07 — `TradeCardRoot`'s behavioural proof: each side selects exactly the
 * right quote/build hooks, plan-building stays gated on a real recipient, the checkout
 * hook mounts only once a plan exists (never before), and no dispatch ever happens
 * without an explicit `next()` call.
 *
 * The checkout hook is replaced with a small controlled fake (via `vi.mock
 * ('@sweepnflip/sdk-react', ...)`), rather than the real `useSnfCheckout` behind a
 * `vi.mock('wagmi', ...)` pattern like `packages/sdk-react/test/
 * useSnfCheckout.test.tsx` uses. **Toolchain finding (17th, this plan)**: mocking
 * `wagmi` does NOT reliably intercept when `wagmi` is imported transitively through
 * `@sweepnflip/sdk-react` (a cross-package, node_modules-resolved dependency) — even
 * after aliasing `@sweepnflip/sdk-react` straight to its TypeScript source and/or
 * adding it (and `wagmi`) to `test.server.deps.inline`, the REAL `wagmi` hooks still
 * ran and threw `WagmiProviderNotFoundError`. `useSnfCheckout.test.tsx` never hits
 * this because it imports the hook via a relative path to its OWN package's source,
 * never crossing a package boundary. This plan's own action text explicitly sanctions
 * the alternative: "a spy on the exported `useSnfCheckout` itself if that is easier to
 * wire" — taken further here into a full behavioural fake, since `useSnfCheckout`'s
 * own wagmi-dispatch behaviour is already exhaustively covered by
 * `useSnfCheckout.test.tsx` itself; re-deriving it through a fragile cross-package
 * wagmi mock would be redundant coverage of already-tested logic, not a new proof.
 * What THIS suite needs to prove is `TradeCardRoot`'s OWN orchestration — that it
 * never calls the checkout hook early, and never calls `next()` on its own — both of
 * which this fake proves directly and deterministically.
 */

const fakeCheckout = vi.hoisted(() => ({
  hookSpy: vi.fn(),
  nextSpy: vi.fn(),
}))

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
        next: fakeCheckout.nextSpy,
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

const SELL_COLLECTION = hexAddress('c')
const BUY_COLLECTION = hexAddress('e')
const RECIPIENT = hexAddress('f')
const PAIR = hexAddress('1')

/** `fakeCollectionInfo()` (from `./setup`) has an empty `pools` array — this plan's
 * buy-side inventory read needs a real pair, so this overrides just that field. */
function fakeCollectionInfoWithPool(): CollectionInfo {
  return {
    ...fakeCollectionInfo(),
    pools: [
      {
        pair: PAIR,
        baseToken: { address: null, symbol: 'ETH', decimals: 18, isNative: true },
        isNative: true,
        reserves: { base: 10n, wnft: 10n },
        wrapperIsToken0: false,
      },
    ],
  }
}

/** A stubbed `SnfClient` — this suite tests TradeCardRoot's own orchestration
 * discipline (which hooks fire, when a plan builds), not the core's correctness.
 * `describeError` is the REAL implementation, mirroring
 * `useSnfCheckout.test.tsx`'s own `fakeClient`. */
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

/** A minimal test-only consumer (no real Part exists yet) reading both contexts and
 * rendering their fields as text, so assertions read the DOM rather than reaching
 * into React internals. `onRender` hands the test the latest checkout value each
 * render — case 6's stand-in for a future Action button's own `onClick`. */
function TestConsumer(props: {
  readonly onRender?: (checkout: TradeCardCheckoutContextValue | null) => void
}): ReactNode {
  const ctx = useTradeCardContext()
  const checkout = useTradeCardCheckout()
  props.onRender?.(checkout)
  return (
    <div>
      <span data-testid="side">{ctx.side}</span>
      <span data-testid="quote-status">{ctx.quote.data ? 'has-quote' : ctx.quote.isLoading ? 'loading' : 'idle'}</span>
      <span data-testid="plan-status">{ctx.planQuery.data ? 'has-plan' : 'no-plan'}</span>
      <span data-testid="checkout-status">{checkout ? checkout.state : 'no-checkout'}</span>
    </div>
  )
}

beforeEach(() => {
  fakeCheckout.hookSpy.mockClear()
  fakeCheckout.nextSpy.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

describe('TradeCardRoot — per-side hook selection', () => {
  it('buy side calls only quoteBuy/buildBuy — quoteSell/quoteNftToNft and their builders never fire', async () => {
    const quote = fakeQuote()
    const plan = fakePlan(['swap-buy'])
    const client = fakeClient({
      collection: vi.fn().mockResolvedValue(fakeCollectionInfoWithPool()),
      poolInventory: vi.fn().mockResolvedValue({
        tokenIds: [],
        availableCount: 0,
        asOfBlock: 1n,
        lagSeconds: 0,
        stale: false,
        source: 'enumerable',
        truncated: false,
        warnings: [],
      }),
      quoteBuy: vi.fn().mockResolvedValue(quote),
      buildBuy: vi.fn().mockResolvedValue(plan),
    })

    renderWithSnf(
      <TradeCardRoot side="buy" collection={SELL_COLLECTION} count={1} recipient={RECIPIENT}>
        <TestConsumer />
      </TradeCardRoot>,
      { client },
    )

    await waitFor(() => expect(client.quoteBuy).toHaveBeenCalled())
    expect(client.quoteSell).not.toHaveBeenCalled()
    expect(client.quoteNftToNft).not.toHaveBeenCalled()

    await waitFor(() => expect(client.buildBuy).toHaveBeenCalled())
    expect(client.buildSell).not.toHaveBeenCalled()
    expect(client.buildNftToNft).not.toHaveBeenCalled()
  })

  it('sell side calls only quoteSell/buildSell — quoteBuy/quoteNftToNft and their builders never fire', async () => {
    const quote = fakeQuote()
    const plan = fakePlan(['swap-sell'])
    const client = fakeClient({
      collection: vi.fn().mockResolvedValue(fakeCollectionInfoWithPool()),
      quoteSell: vi.fn().mockResolvedValue(quote),
      buildSell: vi.fn().mockResolvedValue(plan),
    })

    renderWithSnf(
      <TradeCardRoot side="sell" collection={SELL_COLLECTION} tokenIds={['1']} recipient={RECIPIENT}>
        <TestConsumer />
      </TradeCardRoot>,
      { client },
    )

    await waitFor(() => expect(client.quoteSell).toHaveBeenCalled())
    expect(client.quoteBuy).not.toHaveBeenCalled()
    expect(client.quoteNftToNft).not.toHaveBeenCalled()

    await waitFor(() => expect(client.buildSell).toHaveBeenCalled())
    expect(client.buildBuy).not.toHaveBeenCalled()
    expect(client.buildNftToNft).not.toHaveBeenCalled()
  })

  it('nft-to-nft side calls only quoteNftToNft/buildNftToNft — quoteBuy/quoteSell and their builders never fire', async () => {
    const quote = fakeQuote()
    const plan = fakePlan(['swap-sell', 'swap-buy'])
    const client = fakeClient({
      collection: vi.fn().mockResolvedValue(fakeCollectionInfoWithPool()),
      quoteNftToNft: vi.fn().mockResolvedValue(quote),
      buildNftToNft: vi.fn().mockResolvedValue(plan),
    })

    renderWithSnf(
      <TradeCardRoot
        side="nft-to-nft"
        collection={SELL_COLLECTION}
        buyCollection={BUY_COLLECTION}
        tokenIds={['1']}
        count={2}
        recipient={RECIPIENT}
      >
        <TestConsumer />
      </TradeCardRoot>,
      { client },
    )

    await waitFor(() => expect(client.quoteNftToNft).toHaveBeenCalled())
    expect(client.quoteBuy).not.toHaveBeenCalled()
    expect(client.quoteSell).not.toHaveBeenCalled()

    await waitFor(() => expect(client.buildNftToNft).toHaveBeenCalled())
    expect(client.buildBuy).not.toHaveBeenCalled()
    expect(client.buildSell).not.toHaveBeenCalled()
  })
})

describe('TradeCardRoot — plan-building stays gated', () => {
  it('never builds a plan without a real recipient, even after the quote resolves', async () => {
    const quote = fakeQuote()
    const client = fakeClient({
      collection: vi.fn().mockResolvedValue(fakeCollectionInfoWithPool()),
      quoteBuy: vi.fn().mockResolvedValue(quote),
      buildBuy: vi.fn().mockResolvedValue(fakePlan(['swap-buy'])),
    })

    const { getByTestId } = renderWithSnf(
      <TradeCardRoot side="buy" collection={SELL_COLLECTION} count={1} recipient={undefined}>
        <TestConsumer />
      </TradeCardRoot>,
      { client },
    )

    await waitFor(() => expect(client.quoteBuy).toHaveBeenCalled())
    await waitFor(() => expect(getByTestId('quote-status').textContent).toBe('has-quote'))

    // The quote is ready, yet `recipient` is undefined — plan-building must stay
    // gated. Negative proof #1: build* never fires no matter how long we wait.
    expect(client.buildBuy).not.toHaveBeenCalled()
    expect(client.buildSell).not.toHaveBeenCalled()
    expect(client.buildNftToNft).not.toHaveBeenCalled()
    expect(getByTestId('plan-status').textContent).toBe('no-plan')
    expect(getByTestId('checkout-status').textContent).toBe('no-checkout')
    // The checkout hook (fake or real) is never even reached without a plan.
    expect(fakeCheckout.hookSpy).not.toHaveBeenCalled()
  })
})

describe('TradeCardRoot — checkout mounts only once a plan exists, never auto-dispatches', () => {
  it('the checkout hook is never invoked before a plan exists, and IS invoked once one does', async () => {
    const quote = fakeQuote()
    const plan = fakePlan(['swap-buy'])
    const client = fakeClient({
      collection: vi.fn().mockResolvedValue(fakeCollectionInfoWithPool()),
      quoteBuy: vi.fn().mockResolvedValue(quote),
      buildBuy: vi.fn().mockResolvedValue(plan),
    })

    const { getByTestId } = renderWithSnf(
      <TradeCardRoot side="buy" collection={SELL_COLLECTION} count={1} recipient={RECIPIENT}>
        <TestConsumer />
      </TradeCardRoot>,
      { client },
    )

    // Negative proof #2: before a plan exists, the checkout hook is NEVER called —
    // proving the CheckoutMount conditional-mount pattern actually gates the call,
    // not merely appears to in source.
    expect(fakeCheckout.hookSpy).not.toHaveBeenCalled()

    await waitFor(() => expect(getByTestId('plan-status').textContent).toBe('has-plan'))

    // Positive proof: once a plan exists, the checkout hook HAS been reached (its
    // own snapshot is now visible through context). Not asserted as an EXACT call
    // count: `collectionInfo`/`quoteBuy`/`poolInventory` are three independently
    // resolving react-query subscriptions, each of which can trigger its own extra
    // re-render of the whole tree (and therefore of the already-mounted
    // `CheckoutMount`) slightly after `planQuery.data` first settles — ordinary React
    // behaviour, not a bug, and not what this plan's gate is about. The gate this
    // plan actually guards (never called EARLY) is the deterministic, always-true
    // negative proof above; `useSnfCheckout`'s own internal `useMemo(plan)` is what
    // guarantees exactly one underlying Checkout session regardless of how many times
    // React re-invokes the hook function across re-renders (proven independently in
    // `packages/sdk-react/test/useSnfCheckout.test.tsx`).
    expect(fakeCheckout.hookSpy).toHaveBeenCalled()
    expect(getByTestId('checkout-status').textContent).toBe('review')
  })

  it('no next() dispatch ever happens purely from rendering/re-rendering — only an explicit call dispatches', async () => {
    const quote = fakeQuote()
    const plan = fakePlan(['swap-buy'])
    const client = fakeClient({
      collection: vi.fn().mockResolvedValue(fakeCollectionInfoWithPool()),
      quoteBuy: vi.fn().mockResolvedValue(quote),
      buildBuy: vi.fn().mockResolvedValue(plan),
    })

    let latestCheckout: TradeCardCheckoutContextValue | null = null
    const captureCheckout = (checkout: TradeCardCheckoutContextValue | null): void => {
      latestCheckout = checkout
    }

    const { getByTestId, rerender } = renderWithSnf(
      <TradeCardRoot side="buy" collection={SELL_COLLECTION} count={1} recipient={RECIPIENT}>
        <TestConsumer onRender={captureCheckout} />
      </TradeCardRoot>,
      { client },
    )

    await waitFor(() => expect(getByTestId('plan-status').textContent).toBe('has-plan'))
    expect(latestCheckout).not.toBeNull()

    // Forcing a few re-renders of the whole tree must never, by itself, dispatch.
    rerender(
      <TradeCardRoot side="buy" collection={SELL_COLLECTION} count={1} recipient={RECIPIENT}>
        <TestConsumer onRender={captureCheckout} />
      </TradeCardRoot>,
    )
    rerender(
      <TradeCardRoot side="buy" collection={SELL_COLLECTION} count={1} recipient={RECIPIENT}>
        <TestConsumer onRender={captureCheckout} />
      </TradeCardRoot>,
    )

    expect(fakeCheckout.nextSpy).not.toHaveBeenCalled()

    // Only this explicit call — standing in for a future Action button's onClick —
    // ever dispatches.
    await act(async () => {
      await latestCheckout?.next()
    })

    expect(fakeCheckout.nextSpy).toHaveBeenCalledTimes(1)
  })
})
