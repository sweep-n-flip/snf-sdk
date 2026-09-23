import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { describeError, SnfError, type CheckoutSnapshot, type ExecutionPlan, type Quote, type SnfClient } from '@sweepnflip/sdk'
import { createCheckout } from '@sweepnflip/sdk/checkout'
import { SnfTradeCard } from '../src/components/TradeCard'
import type { TradeCardCheckoutContextValue } from '../src/components/TradeCard/TradeCard.types'
import { fakeCollectionInfo, fakePlan, fakeQuote, renderWithSnf } from './setup'

/**
 * `TradeCardProof.test.tsx` — the phase's central cross-cutting proof suite, one
 * `describe` per `56-SPEC.md` "proof" requirement, each run against the REAL
 * assembled `<SnfTradeCard>` (Root wrapping real Input/QuoteBreakdown/Steps/Action
 * children), never a throwaway test double: R6 (all three styling mechanisms), R8
 * (the single-dispatch guarantee, including the negative "never before any click"
 * proof), R9 (amount fidelity echoed at the assembled-card level), R10 (error-code
 * override echoed at the assembled-card level), R11 (accessibility, completed via
 * keyboard-only activation).
 *
 * **Why this file does not `vi.mock('wagmi', ...)`.** `CheckoutMount`
 * (`TradeCardRoot.tsx`) calls the REAL `useSnfCheckout` from `@sweepnflip/sdk-react`
 * once a plan exists, which calls `wagmi`'s `useSendTransaction`. Per
 * `snf-56-04-SUMMARY.md`'s own toolchain finding (#19 in this plan's own
 * `<toolchain>` block): mocking `wagmi` does NOT reliably intercept when it is
 * imported transitively through `@sweepnflip/sdk-react` from a DIFFERENT package
 * (`packages/widgets`) — confirmed empirically in plan 04 even after aliasing
 * `@sweepnflip/sdk-react` to its own TypeScript source and inlining both packages as
 * server deps; `useSnfCheckout.test.tsx`'s own `vi.mock('wagmi', ...)` only works
 * there because IT imports the hook via a relative path within its OWN package,
 * never crossing a package boundary.
 *
 * **The single-dispatch proof therefore needs a real, honest dispatch-counting
 * surface without a real wallet.** `useSnfCheckout` is replaced (mocking
 * `@sweepnflip/sdk-react` at its own package boundary, the pattern `snf-56-04-
 * SUMMARY.md` and `snf-56-05-PLAN.md`'s own toolchain both sanction and instruct
 * reusing) with `useFakeCheckout` below — NOT a hand-rolled state machine (that would
 * re-derive `NEXT_READY_BY_KIND`/`CHECKOUT_STATES`, exactly what D-07 forbids), but a
 * thin wrapper around the REAL, already-exhaustively-tested `createCheckout` engine
 * from `@sweepnflip/sdk/checkout` (the same public subpath `useSnfCheckout.ts` itself
 * imports — pure, no wagmi dependency at all). The only thing replaced is the actual
 * wallet I/O: `next()` calls a `sendTransactionAsync` spy (named exactly that, so
 * R8's own literal wording — "assert `sendTransactionAsync` was called exactly
 * once" — has a real, single-purpose spy to assert against) instead of `wagmi`'s
 * hook, then feeds the resolved hash back through the REAL session's `onReceipt`,
 * exactly mirroring `useSnfCheckout.ts`'s own `next()`/receipt-watcher shape. Every
 * state transition below (`review` -> `wallet-approve` -> `ready-buy` -> `wallet` ->
 * `success`) is therefore the REAL reducer's own output, not a test-authored
 * approximation of it.
 */

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

  // Mirrors `useSnfCheckout.ts`'s own `next()` shape: `store.session.next()` runs
  // FIRST, synchronously (before any `await`) — the real reducer's own busy-state
  // transition is therefore visible to a click handler's caller in the SAME
  // synchronous frame the click fired in, exactly like the real hook.
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

const COLLECTION = hexAddress('c')
const RECIPIENT = hexAddress('f')

const CSS_UNIT_SHAPED = /^-?\d+(\.\d+)?(px|rem|em|%)$/
const HEX_COLOR_SHAPED = /^#/

/** A stubbed `SnfClient` whose `buildBuy` resolves a real TWO-STEP plan (approval +
 * swap-buy) — the "real two-step (approval + swap) plan" R8's own acceptance text
 * asks for, mirroring `useSnfCheckout.test.tsx`'s own `fakePlan(['approval',
 * 'swap-sell'])` fixture shape. `describeError` is the REAL implementation. */
function fakeClient(overrides: Partial<SnfClient> = {}): SnfClient {
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
    ...overrides,
  }
}

/** Same shape as `fakeClient()`, additionally recording the ORDER `collection`/
 * `quoteBuy`/`buildBuy` are actually called in — used by the three R6 styling-mode
 * renders to prove identical SDK-call behaviour regardless of appearance. */
function fakeClientWithCallLog(): { readonly client: SnfClient; readonly calls: string[] } {
  const calls: string[] = []
  const client = fakeClient({
    collection: vi.fn().mockImplementation(async () => {
      calls.push('collection')
      return fakeCollectionInfo()
    }),
    quoteBuy: vi.fn().mockImplementation(async () => {
      calls.push('quoteBuy')
      return fakeQuote()
    }),
    buildBuy: vi.fn().mockImplementation(async () => {
      calls.push('buildBuy')
      return fakePlan(['approval', 'swap-buy'])
    }),
  })
  return { client, calls }
}

/** The assembled card, exactly as a partner would compose it — Root wrapping real
 * Input/QuoteBreakdown/Steps/Action children, never a throwaway subset. */
function renderAssembledCard(
  client: SnfClient,
  opts: { readonly rootClassName?: string; readonly actionAsChild?: boolean; readonly actionClassName?: string } = {},
) {
  return renderWithSnf(
    <SnfTradeCard.Root
      side="buy"
      collection={COLLECTION}
      count={1}
      recipient={RECIPIENT}
      {...(opts.rootClassName === undefined ? {} : { className: opts.rootClassName })}
    >
      <SnfTradeCard.Input />
      <SnfTradeCard.QuoteBreakdown />
      <SnfTradeCard.Steps />
      {opts.actionAsChild ? (
        <SnfTradeCard.Action asChild>
          <button type="button" className={opts.actionClassName ?? 'partner-action'} />
        </SnfTradeCard.Action>
      ) : (
        <SnfTradeCard.Action {...(opts.actionClassName === undefined ? {} : { className: opts.actionClassName })} />
      )}
    </SnfTradeCard.Root>,
    { client },
  )
}

beforeEach(() => {
  dispatchMocks.sendTransactionAsync.mockReset()
  dispatchMocks.sendTransactionAsync.mockResolvedValue('0xaa')
})

describe('R6 — the three styling mechanisms, against the REAL assembled SnfTradeCard', () => {
  it('(a) bare render: no className anywhere on Root/Action, no style attribute, no color/size-shaped attribute value', async () => {
    const { client, calls } = fakeClientWithCallLog()
    const { container } = renderAssembledCard(client)

    await waitFor(() => expect(screen.getAllByRole('listitem')).toHaveLength(2))

    const button = screen.getByRole('button') as HTMLButtonElement
    expect(button.getAttribute('class')).toBeNull()

    const partNodes = container.querySelectorAll('[data-part]')
    expect(partNodes.length).toBeGreaterThan(0)
    for (const node of Array.from(partNodes)) {
      expect(node.getAttribute('style')).toBeNull()
      for (const attr of Array.from(node.attributes)) {
        expect(attr.value).not.toMatch(CSS_UNIT_SHAPED)
        expect(attr.value).not.toMatch(HEX_COLOR_SHAPED)
      }
    }

    expect(calls.filter((c) => c === 'quoteBuy')).toHaveLength(1)
    expect(calls.filter((c) => c === 'buildBuy')).toHaveLength(1)
    expect(calls.indexOf('quoteBuy')).toBeLessThan(calls.indexOf('buildBuy'))
  })

  it('(b) className on Root AND Action survives alongside the kit\'s own data-* attributes, same SDK-call order as (a)/(c)', async () => {
    const { client, calls } = fakeClientWithCallLog()
    const { container } = renderAssembledCard(client, { rootClassName: 'partner-root', actionClassName: 'partner-action-class' })

    // Wait for the plan/checkout to actually settle (not merely for the className,
    // which is present from the very first render regardless of checkout state) —
    // see case (c)'s comment for why `buildBuy` only resolving is the real signal.
    await waitFor(() => expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false))
    expect(screen.getByRole('button').className).toContain('partner-action-class')

    const rootNode = container.querySelector('[data-part="root"]')
    expect(rootNode?.className).toContain('partner-root')
    expect(rootNode?.getAttribute('data-side')).toBe('buy')

    expect(calls.filter((c) => c === 'quoteBuy')).toHaveLength(1)
    expect(calls.filter((c) => c === 'buildBuy')).toHaveLength(1)
    expect(calls.indexOf('quoteBuy')).toBeLessThan(calls.indexOf('buildBuy'))
  })

  it('(c) asChild on Action: the partner\'s own <button> is rendered (not wrapped), carries the partner class, and dispatch still works through it — same SDK-call order as (a)/(b)', async () => {
    const { client, calls } = fakeClientWithCallLog()
    renderAssembledCard(client, { actionAsChild: true, actionClassName: 'partner-action-substituted' })

    // `TradeCardRoot.tsx`'s own "no plan" -> "plan ready" transition swaps the
    // element TYPE at this position (bare `rootElement` -> `<CheckoutMount>` wrapping
    // it — see `TradeCardRoot.tsx`'s header comment), which makes React unmount and
    // remount the whole subtree exactly once. Querying fresh INSIDE `waitFor` (never
    // capturing `button` before this settles) is what makes the wait actually observe
    // the post-remount node instead of polling a detached, permanently-stale one.
    await waitFor(() => expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false))
    const button = screen.getByRole('button') as HTMLButtonElement
    expect(button.tagName).toBe('BUTTON')
    expect(button.className).toContain('partner-action-substituted')

    expect(dispatchMocks.sendTransactionAsync).not.toHaveBeenCalled()

    fireEvent.click(button)
    expect(dispatchMocks.sendTransactionAsync).toHaveBeenCalledTimes(1)

    expect(calls.filter((c) => c === 'quoteBuy')).toHaveLength(1)
    expect(calls.filter((c) => c === 'buildBuy')).toHaveLength(1)
    expect(calls.indexOf('quoteBuy')).toBeLessThan(calls.indexOf('buildBuy'))
  })
})

describe('R8 — exactly one dispatch per click, and zero dispatches without one', () => {
  it('never dispatches before any click; one sendTransactionAsync call per click; two clicks across a real two-step plan total exactly two calls', async () => {
    const client = fakeClient()
    // Re-runs through the SAME asChild-substituted button case 1(c) above proved
    // styling on (R6's own cross-reference to this case) — the single-dispatch
    // guarantee is proven at the exact surface a partner actually clicks, substituted
    // element included, not only against the kit's own default button.
    renderAssembledCard(client, { actionAsChild: true })

    // See case 1(c)'s comment above — the button REMOUNTS once between "no plan"
    // and "plan ready"; query fresh inside `waitFor` before capturing a stable
    // reference, or the wait polls a permanently-detached node forever.
    await waitFor(() => expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false))
    const button = screen.getByRole('button') as HTMLButtonElement

    // Negative proof (T-56-10): NOTHING dispatches merely from mounting/resolving a
    // ready plan — only an explicit click ever does.
    expect(dispatchMocks.sendTransactionAsync).not.toHaveBeenCalled()

    const firstLabel = button.textContent

    fireEvent.click(button)
    // The real reducer's own busy-state transition (`session.next()`) runs
    // synchronously, before `sendTransactionAsync`'s own promise ever settles — the
    // button is already disabled by the time `fireEvent.click` returns.
    expect(button.disabled).toBe(true)
    expect(dispatchMocks.sendTransactionAsync).toHaveBeenCalledTimes(1)

    await waitFor(() => expect(button.disabled).toBe(false))
    const secondLabel = button.textContent
    expect(secondLabel).not.toBe(firstLabel)
    // Still exactly one call — the receipt watcher only ADVANCES the machine, it
    // never dispatches on its own (T-54-37's own structural invariant).
    expect(dispatchMocks.sendTransactionAsync).toHaveBeenCalledTimes(1)

    dispatchMocks.sendTransactionAsync.mockResolvedValueOnce('0xbb')
    fireEvent.click(button)
    expect(dispatchMocks.sendTransactionAsync).toHaveBeenCalledTimes(2)

    await waitFor(() => expect(button.textContent).not.toBe(secondLabel))
    // Final count, twice total, never more from a re-render or a double-fire.
    expect(dispatchMocks.sendTransactionAsync).toHaveBeenCalledTimes(2)
  })
})

describe('R9 — amount fidelity survives in the FULL assembled tree, not only in isolation', () => {
  it('renders the known fees.marketplace.formatted/.symbol pair verbatim inside the assembled card', async () => {
    const quote: Quote = {
      ...fakeQuote(),
      fees: {
        pool: { bps: 200, note: 'included in curve' },
        marketplace: { value: 99n, formatted: '0.0099 ETH', symbol: 'ETH', decimals: 18, bps: 250 },
        royalty: { value: 0n, formatted: '0.0000 ETH', symbol: 'ETH', decimals: 18, bps: 0, capApplied: false },
      },
    }
    const client = fakeClient({ quoteBuy: vi.fn().mockResolvedValue(quote) })
    renderAssembledCard(client)

    await waitFor(() => expect(screen.getByTestId('quote-fee-marketplace').textContent).toBe('0.0099 ETH ETH'))
  })
})

describe('R10 — error-code override at the assembled-card level (a BUILD failure, not a quote failure)', () => {
  it('surfaces INVALID_PARAMS and the default message by default; a partner override replaces only the text, never the code', async () => {
    const client = fakeClient({
      buildBuy: vi.fn().mockRejectedValue(new SnfError('INVALID_PARAMS', 'Something about this request is invalid.')),
    })

    const { rerender } = renderWithSnf(
      <SnfTradeCard.Root side="buy" collection={COLLECTION} count={1} recipient={RECIPIENT}>
        <SnfTradeCard.QuoteBreakdown />
      </SnfTradeCard.Root>,
      { client },
    )

    await waitFor(() => expect(screen.getByTestId('quote-error').textContent).toContain('INVALID_PARAMS'))
    expect(screen.getByTestId('quote-error').getAttribute('data-error-code')).toBe('INVALID_PARAMS')
    expect(screen.getByTestId('quote-error').textContent).toContain('Something about this request is invalid.')

    rerender(
      <SnfTradeCard.Root
        side="buy"
        collection={COLLECTION}
        count={1}
        recipient={RECIPIENT}
        messages={{ INVALID_PARAMS: 'Custom build-failure copy for this partner.' }}
      >
        <SnfTradeCard.QuoteBreakdown />
      </SnfTradeCard.Root>,
    )

    await waitFor(() =>
      expect(screen.getByTestId('quote-error').textContent).toContain('Custom build-failure copy for this partner.'),
    )
    // The code is NEVER hidden by the override (T-56-11).
    expect(screen.getByTestId('quote-error').textContent).toContain('INVALID_PARAMS')
    expect(screen.getByTestId('quote-error').getAttribute('data-error-code')).toBe('INVALID_PARAMS')
  })
})

describe('R11 — accessibility: accessible name tracks state, a live region announces it, keyboard-only completion', () => {
  it('completes the whole two-step flow via focus() + a click dispatched at document.activeElement only', async () => {
    const client = fakeClient()
    renderWithSnf(
      <SnfTradeCard.Root side="buy" collection={COLLECTION} count={1} recipient={RECIPIENT}>
        <SnfTradeCard.Steps />
        <SnfTradeCard.Action />
      </SnfTradeCard.Root>,
      { client },
    )

    // See the R6(c)/R8 cases' comment — the button REMOUNTS once between "no plan"
    // and "plan ready"; query fresh inside `waitFor` before capturing a stable
    // reference, or the wait polls a permanently-detached node forever.
    await waitFor(() => expect((screen.getByRole('button') as HTMLButtonElement).disabled).toBe(false))
    const button = screen.getByRole('button') as HTMLButtonElement
    expect(button).toBeInstanceOf(HTMLButtonElement)
    expect(button.tabIndex).not.toBe(-1)

    const statusRegion = screen.getByRole('status')
    const firstLabel = button.textContent
    expect(statusRegion.textContent).toBe(firstLabel)

    // A real Enter/Space keypress on a FOCUSED native <button> is translated by the
    // browser itself into a click event, with no extra ARIA wiring beyond using a
    // real <button> element — `.focus()` followed by a click dispatched at
    // `document.activeElement` stands in for that keyboard activation, documented
    // here per this plan's own toolchain instruction not to add
    // `@testing-library/user-event` as an eleventh dependency.
    button.focus()
    expect(document.activeElement).toBe(button)
    fireEvent.click(document.activeElement as HTMLElement)

    await waitFor(() => expect(button.disabled).toBe(false))
    const secondLabel = button.textContent
    expect(secondLabel).not.toBe(firstLabel)
    expect(screen.getByRole('button', { name: secondLabel ?? undefined })).toBe(button)
    expect(screen.getByRole('status').textContent).toBe(secondLabel)

    dispatchMocks.sendTransactionAsync.mockResolvedValueOnce('0xbb')
    button.focus()
    expect(document.activeElement).toBe(button)
    fireEvent.click(document.activeElement as HTMLElement)

    await waitFor(() => expect(button.textContent).not.toBe(secondLabel))
    const thirdLabel = button.textContent
    expect(screen.getByRole('status').textContent).toBe(thirdLabel)
    expect(dispatchMocks.sendTransactionAsync).toHaveBeenCalledTimes(2)
  })
})
