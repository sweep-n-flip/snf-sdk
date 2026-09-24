import { useCallback, useMemo, useSyncExternalStore } from 'react'
import { fireEvent, waitFor, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  describeError,
  SnfError,
  type CheckoutSnapshot,
  type ExecutionPlan,
  type Quote,
  type QuoteBuyArgs,
  type SnfClient,
} from '@sweepnflip/sdk'
import { createCheckout } from '@sweepnflip/sdk/checkout'
import { SnfTradeCard } from '../src/components/TradeCard'
import type { TradeCardCheckoutContextValue } from '../src/components/TradeCard/TradeCard.types'
import { fakeCollectionInfo, fakePlan, fakeQuote, renderWithSnf } from './setup'

/**
 * `twoSkin.test.tsx` — this rule's literal acceptance criterion, met directly: two
 * INDEPENDENT `<SnfTradeCard.Root>` trees, driven through the identical interaction
 * sequence (resolve -> quote -> plan -> click Action twice, once per step of a real
 * two-step approval+swap plan), assert the SAME ordered sequence of SDK method calls
 * regardless of which skin (or none) each tree wears. This is the behavioural half of
 * this rule's proof; `examples/next-app/src/app/two-skin/page.tsx` + `TwoSkinDemo.tsx` are
 * the "the example builds and runs, a human can look at it" half (this plan's own
 * `<toolchain>` note explains the split — no test runner is wired into that example's
 * own workspace member).
 *
 * **Why two independent stub `SnfClient`s, not one shared spy object.** Each tree gets
 * its OWN `SnfProvider` (via its own `renderWithSnf` call) — a real partner integration
 * would too, one `<SnfProvider>` per app, not per component. Tagging every method call
 * with which tree triggered it (`'A'` themed-instance-stand-in / `'B'`
 * partner-skin-stand-in) is what lets the two ordered logs be compared afterwards
 * without cross-tree interleaving noise.
 *
 * **Tagging the checkout-hook (wallet dispatch) side of the sequence.** `next()`'s
 * dispatch does not go through `SnfClient` at all (`useSnfCheckout`'s own contract) —
 * it is included in each tree's log anyway, tagged the same way, because this rule's
 * acceptance text explicitly drives the proof "through the same interaction ... click
 * Action" and a proof that stopped at `buildBuy` would leave the actual dispatch step
 * unverified. `useSnfCheckout` is mocked at the `@sweepnflip/sdk-react` package
 * boundary with the same `createCheckout`-backed fake `TradeCardProof.test.tsx` and
 * `theme.test.ts` already use (mocking `wagmi` directly does not reliably intercept
 * across a package boundary — this plan's own toolchain note 19). The ONLY new piece
 * is `PLAN_TAGS`, a `WeakMap<ExecutionPlan, 'A' | 'B'>` populated by each tree's own
 * `buildBuy` stub the moment it manufactures that tree's plan — `useFakeCheckout` looks
 * the active plan up in that map to know which tree's log to append its own
 * `sendTransactionAsync` entry to, with no shared mutable "current tree" global that
 * two trees rendered in the same test could race on.
 */

interface CallRecord {
  readonly method: string
  readonly args: unknown
}

const hoisted = vi.hoisted(() => ({
  logA: [] as CallRecord[],
  logB: [] as CallRecord[],
  planTags: new WeakMap<ExecutionPlan, 'A' | 'B'>(),
  sendTransactionAsync: vi.fn(),
}))

function recordCall(tree: 'A' | 'B', method: string, args: unknown): void {
  const log = tree === 'A' ? hoisted.logA : hoisted.logB
  log.push({ method, args })
}

/** Strips `expiresAt` (a wall-clock timestamp `fakeQuote()`/`fakePlan()` stamp fresh
 * from `Date.now()` at call time — real, harmless millisecond skew between two
 * sequential stub calls, not a behavioural difference) from a log entry's `args`
 * before the two trees' logs are deep-equal-compared. Recurses through plain objects
 * and arrays only — every fixture shape this file's stubs return is one of those two,
 * never a `Map`/`Set`/class instance. */
function stripVolatile(record: CallRecord): CallRecord {
  return { method: record.method, args: stripVolatileValue(record.args) }
}

/** `JSON.stringify`'s replacer for the two proof-of-record `console.log` calls below
 * — `Amount.value` fields are `bigint` (`JSON.stringify` throws on those natively).
 * `bigint.toString()` is deliberately allowed in this package (this plan's own
 * toolchain note 9 — "it is how raw reserves are rendered"); this is the same
 * operation, applied only for a human-readable log line, never fed back into an
 * assertion. */
function bigintReplacer(_key: string, value: unknown): unknown {
  return typeof value === 'bigint' ? value.toString() : value
}

function stripVolatileValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripVolatileValue)
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [key, entryValue] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'expiresAt') continue
      out[key] = stripVolatileValue(entryValue)
    }
    return out
  }
  return value
}

vi.mock('@sweepnflip/sdk-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sweepnflip/sdk-react')>()
  return {
    ...actual,
    useSnfCheckout: (plan: ExecutionPlan): TradeCardCheckoutContextValue => useFakeCheckout(plan),
  }
})

function useFakeCheckout(plan: ExecutionPlan): TradeCardCheckoutContextValue {
  const tree = hoisted.planTags.get(plan) ?? 'A'

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

  // Mirrors `useSnfCheckout.ts`'s own `next()` shape (same precedent
  // `TradeCardProof.test.tsx`/`theme.test.ts` already establish) — `session.next()`
  // runs first, synchronously, then the wallet dispatch, then the receipt is fed back.
  const next = useCallback(async (): Promise<void> => {
    const step = store.session.next()
    if (step === null) return
    recordCall(tree, 'sendTransactionAsync', step.kind)
    try {
      const hash = await hoisted.sendTransactionAsync(step.tx)
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
  }, [store, tree])

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

// The SAME collection/count/recipient constants fed to BOTH trees — this rule's own
// wording ("fed the SAME props so both instances are driven by identical inputs").
const COLLECTION = hexAddress('c')
const RECIPIENT = hexAddress('f')
const COUNT = 1

/** A stub `SnfClient` whose `collection`/`quoteBuy`/`buildBuy` methods each record
 * their own name + argument into `tree`'s log before resolving the SAME fixtures
 * `TradeCardProof.test.tsx` uses — a real two-step (approval then swap) plan. */
function makeLoggingClient(tree: 'A' | 'B'): SnfClient {
  return {
    chainId: 8453,
    chain: { chainId: 8453 } as SnfClient['chain'],
    collection: vi.fn().mockImplementation(async (address: `0x${string}` | undefined) => {
      recordCall(tree, 'collection', address)
      return fakeCollectionInfo()
    }),
    poolInventory: vi.fn(),
    quoteBuy: vi.fn().mockImplementation(async (args: QuoteBuyArgs) => {
      recordCall(tree, 'quoteBuy', args)
      return fakeQuote()
    }),
    quoteSell: vi.fn(),
    quoteNftToNft: vi.fn(),
    quoteSwap: vi.fn(),
    estimateLadder: vi.fn(),
    buildBuy: vi.fn().mockImplementation(async (args: { quote: Quote; recipient: `0x${string}` }) => {
      recordCall(tree, 'buildBuy', args)
      const plan = fakePlan(['approval', 'swap-buy'])
      hoisted.planTags.set(plan, tree)
      return plan
    }),
    buildSell: vi.fn(),
    buildNftToNft: vi.fn(),
    buildSwap: vi.fn(),
    parseReceipt: vi.fn(),
    describeError,
  }
}

/** Renders ONE tree, styled per the `skin` argument — 'themed' stands in for the
 * SnF-theme instance (no `className` anywhere, mirroring `TwoSkinDemo.tsx`'s own
 * `data-snf-theme`-wrapped instance, whose look is driven entirely by CSS this jsdom
 * suite never executes anyway — see `theme.test.ts`'s own header comment on why
 * appearance is proven structurally there, not behaviourally here), 'partner' applies
 * a distinct `className` to every part, standing in for `TwoSkinDemo.tsx`'s hand-
 * authored `.partner-skin` instance. Either way the RENDER TREE — which parts exist,
 * which SDK calls fire — is identical; only `className` differs. */
function renderTree(tree: 'A' | 'B', skin: 'themed' | 'partner') {
  const client = makeLoggingClient(tree)
  const partnerProps = skin === 'partner'
  return renderWithSnf(
    <SnfTradeCard.Root
      side="buy"
      collection={COLLECTION}
      count={COUNT}
      recipient={RECIPIENT}
      {...(partnerProps ? { className: 'partner-root' } : {})}
    >
      <SnfTradeCard.Input {...(partnerProps ? { className: 'partner-input' } : {})} />
      <SnfTradeCard.QuoteBreakdown {...(partnerProps ? { className: 'partner-quote' } : {})} />
      <SnfTradeCard.Steps {...(partnerProps ? { className: 'partner-steps' } : {})} />
      <SnfTradeCard.Action {...(partnerProps ? { className: 'partner-action' } : {})} />
    </SnfTradeCard.Root>,
    { client },
  )
}

beforeEach(() => {
  hoisted.logA.length = 0
  hoisted.logB.length = 0
  hoisted.sendTransactionAsync.mockReset()
  hoisted.sendTransactionAsync.mockResolvedValue('0xaa')
})

describe('Two independently-styled SnfTradeCard trees produce identical SDK call sequences', () => {
  it('tree A (bare/themed stand-in) and tree B (distinct className on every part) call the SAME SDK methods, in the SAME order, with the SAME arguments', async () => {
    const resultA = renderTree('A', 'themed')
    const resultB = renderTree('B', 'partner')

    // 1. Resolve (mount) -> 2. wait for the quote -> 3. wait for the plan: the
    // Action button becomes enabled only once a real plan exists (TradeCardRoot's own
    // gating) — waiting on `disabled === false` observes all three steps completing.
    await waitFor(() =>
      expect((within(resultA.container).getByRole('button') as HTMLButtonElement).disabled).toBe(false),
    )
    await waitFor(() =>
      expect((within(resultB.container).getByRole('button') as HTMLButtonElement).disabled).toBe(false),
    )

    // Query fresh, scoped per tree, AFTER the wait above — the card's own subtree
    // remounts exactly once when the plan becomes available (this plan's own
    // toolchain note 32); a reference captured before that settles would be
    // permanently detached.
    const buttonA = within(resultA.container).getByRole('button') as HTMLButtonElement
    const buttonB = within(resultB.container).getByRole('button') as HTMLButtonElement
    const firstLabelA = buttonA.textContent
    const firstLabelB = buttonB.textContent

    // 4. Click Action once on EACH tree — approval dispatches.
    fireEvent.click(buttonA)
    fireEvent.click(buttonB)

    // 5. Resolve the approval receipt on each. Mid-flow (approval done, swap not yet
    // dispatched) the button re-enables for the next step — same wait TradeCardProof.
    // test.tsx's own single-dispatch case uses between its two clicks.
    await waitFor(() => expect(buttonA.disabled).toBe(false))
    await waitFor(() => expect(buttonB.disabled).toBe(false))
    const secondLabelA = buttonA.textContent
    const secondLabelB = buttonB.textContent
    expect(secondLabelA).not.toBe(firstLabelA)
    expect(secondLabelB).not.toBe(firstLabelB)

    // 6. Click Action again on EACH tree — swap dispatches.
    fireEvent.click(buttonA)
    fireEvent.click(buttonB)

    // 7. Resolve the swap receipt on each. The flow is now COMPLETE (checkout state
    // 'success') — the button's final state is permanently `disabled` with a "Done"-
    // style label, exactly like TradeCardProof.test.tsx's own single-dispatch case, which for this
    // same reason waits on a TEXT change here, never on `disabled === false` (that
    // condition is never reached again after the terminal state).
    await waitFor(() => expect(buttonA.textContent).not.toBe(secondLabelA))
    await waitFor(() => expect(buttonB.textContent).not.toBe(secondLabelB))

    // Both trees completed the full two-step flow: two dispatches each.
    expect(hoisted.logA.filter((r) => r.method === 'sendTransactionAsync')).toHaveLength(2)
    expect(hoisted.logB.filter((r) => r.method === 'sendTransactionAsync')).toHaveLength(2)

    const methodsA = hoisted.logA.map((r) => r.method)
    const methodsB = hoisted.logB.map((r) => r.method)

    // The literal acceptance criterion: same length, same order, same method
    // names, same call arguments — appearance (className on every part, or none at
    // all) had ZERO effect on which SDK methods fired or in what order. `expiresAt`
    // is stripped before the deep-equal: `fakeQuote()`/`fakePlan()` stamp it from
    // `Date.now()` at the moment each tree's OWN `quoteBuy`/`buildBuy` stub actually
    // runs, a few milliseconds apart — real wall-clock skew between two sequential
    // calls, not a behavioural difference either tree's styling could have caused.
    expect(methodsA).toEqual(methodsB)
    expect(methodsA).toEqual(['collection', 'quoteBuy', 'buildBuy', 'sendTransactionAsync', 'sendTransactionAsync'])
    expect(hoisted.logA.map(stripVolatile)).toEqual(hoisted.logB.map(stripVolatile))

    // Pasted verbatim into per this task's own acceptance
    // criteria — logging here so a `vitest run --reporter=verbose` capture matches
    // exactly what the SUMMARY quotes.
    // eslint-disable-next-line no-console -- deliberate, documented proof-of-record
    console.log('tree A log:', JSON.stringify(hoisted.logA.map(stripVolatile), bigintReplacer, 2))
    // eslint-disable-next-line no-console -- deliberate, documented proof-of-record
    console.log('tree B log:', JSON.stringify(hoisted.logB.map(stripVolatile), bigintReplacer, 2))
  })
})
