import { describe, expect, it } from 'vitest'

import {
  CHECKOUT_STATES,
  canDispatch,
  checkoutReducer,
  initialCheckoutState,
  NEXT_READY_BY_KIND,
  type CheckoutAction,
  type CheckoutMachineState,
} from '../../src/checkout/reducer'
import { SnfError } from '../../src/errors'
import type { CheckoutState } from '../../src/types/checkout.types'
import type { Amount } from '../../src/types/amount.types'
import type { Bounds, ExecutionPlan, Step, StepKind, UnsignedTx } from '../../src/types/plan.types'
import type { Quote } from '../../src/types/quote.types'

/**
 * R15/INV-17 — the pure checkout reducer. See `src/checkout/reducer.ts`'s header for
 * the doctrine this proves structurally: a dispatch effect is reachable ONLY from the
 * `'next'` action, and only from `review`/`ready-*` states.
 */

function amount(value: bigint): Amount {
  return { value, formatted: value.toString(), symbol: 'ETH', decimals: 18 }
}

function fakeQuote(): Quote {
  return {
    side: 'sell',
    chainId: 8453,
    legs: [],
    fees: {
      pool: { bps: 200, note: 'included in curve' },
      marketplace: { ...amount(0n), bps: 250 },
      royalty: { ...amount(0n), bps: 0, capApplied: false },
    },
    priceImpact: 0,
    deliverable: 1,
    bestEffort: false,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    reconciled: true,
  }
}

function fakeTx(): UnsignedTx {
  return { to: '0x0000000000000000000000000000000000000001', data: '0x', value: 0n, chainId: 8453 }
}

function fakeBounds(): Bounds {
  return { slippageBps: 100, deadline: 0n }
}

function fakeStep(kind: StepKind): Step {
  return { kind, label: kind, tx: fakeTx(), approvals: [], bounds: fakeBounds(), quote: fakeQuote() }
}

function fakePlan(kinds: readonly StepKind[]): ExecutionPlan {
  return {
    chainId: 8453,
    steps: kinds.map(fakeStep),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    preflight: () => Promise.resolve({ ok: true, blockNumber: 1n, checked: [] }),
  }
}

function withState(base: CheckoutMachineState, state: CheckoutState): CheckoutMachineState {
  return { ...base, state }
}

const SUCCESS_RECEIPT = { status: 'success' as const, transactionHash: '0xaa' as const, blockNumber: 1n, logs: [] }
const REVERTED_RECEIPT = { status: 'reverted' as const, transactionHash: '0xbb' as const, blockNumber: 1n, logs: [] }

describe('CHECKOUT_STATES', () => {
  it('has exactly the 11 R15 states, in order', () => {
    expect(CHECKOUT_STATES).toEqual([
      'review',
      'ready-approve',
      'wallet-approve',
      'pending-approve',
      'ready-swap',
      'wallet',
      'pending',
      'ready-buy',
      'ready-buy-wnft',
      'success',
      'error',
    ])
    expect(CHECKOUT_STATES.length).toBe(11)
  })
})

describe('checkoutReducer — dispatch only from next()', () => {
  it('review with steps[0].kind === "approval" dispatches step 0 into wallet-approve', () => {
    const plan = fakePlan(['approval', 'swap-fungible'])
    const base = initialCheckoutState(plan)
    const { state, effect } = checkoutReducer(base, { type: 'next', sessionId: base.sessionId })
    expect(state.state).toBe('wallet-approve')
    expect(effect).toEqual({ kind: 'dispatch', step: plan.steps[0] })
  })

  it('review with only a swap step dispatches step 0 into wallet', () => {
    const plan = fakePlan(['swap-fungible'])
    const base = initialCheckoutState(plan)
    const { state, effect } = checkoutReducer(base, { type: 'next', sessionId: base.sessionId })
    expect(state.state).toBe('wallet')
    expect(effect).toEqual({ kind: 'dispatch', step: plan.steps[0] })
  })

  it.each(['wallet', 'pending', 'wallet-approve', 'pending-approve'] as const)(
    'a next() from %s is absorbed: effect none, state unchanged',
    (busyState) => {
      const plan = fakePlan(['swap-fungible'])
      const base = withState(initialCheckoutState(plan), busyState)
      const result = checkoutReducer(base, { type: 'next', sessionId: base.sessionId })
      expect(result.effect).toEqual({ kind: 'none' })
      expect(result.state).toBe(base) // same reference — a true no-op
    },
  )

  it('two synchronous next() calls: first dispatches, second (same busy state) returns none', () => {
    const plan = fakePlan(['swap-fungible'])
    const base = initialCheckoutState(plan)
    const first = checkoutReducer(base, { type: 'next', sessionId: base.sessionId })
    expect(first.effect.kind).toBe('dispatch')
    const second = checkoutReducer(first.state, { type: 'next', sessionId: first.state.sessionId })
    expect(second.effect).toEqual({ kind: 'none' })
  })
})

describe('checkoutReducer — receipt advances, never dispatches', () => {
  it('success receipt on the last step yields success', () => {
    const plan = fakePlan(['swap-fungible'])
    const dispatched = checkoutReducer(initialCheckoutState(plan), { type: 'next', sessionId: 1 })
    const result = checkoutReducer(dispatched.state, {
      type: 'receipt',
      sessionId: dispatched.state.sessionId,
      receipt: SUCCESS_RECEIPT,
    })
    expect(result.state.state).toBe('success')
    expect(result.effect).toEqual({ kind: 'none' })
  })

  it.each([
    ['approval', 'ready-approve'],
    ['swap-buy', 'ready-buy'],
    ['swap-buy-wnft', 'ready-buy-wnft'],
    ['swap-sell', 'ready-swap'],
    ['swap-fungible', 'ready-swap'],
  ] as const)('a non-last success receipt whose NEXT step is %s yields %s', (nextKind, readyState) => {
    const plan = fakePlan(['approval', nextKind])
    const dispatched = checkoutReducer(initialCheckoutState(plan), { type: 'next', sessionId: 1 })
    const result = checkoutReducer(dispatched.state, {
      type: 'receipt',
      sessionId: dispatched.state.sessionId,
      receipt: SUCCESS_RECEIPT,
    })
    expect(result.state.state).toBe(readyState)
    expect(result.state.stepIndex).toBe(1)
    expect(result.effect).toEqual({ kind: 'none' })
  })

  it('NEXT_READY_BY_KIND covers every StepKind exactly once', () => {
    const kinds: readonly StepKind[] = ['approval', 'swap-buy', 'swap-buy-wnft', 'swap-sell', 'swap-fungible']
    for (const kind of kinds) expect(NEXT_READY_BY_KIND[kind]).toBeDefined()
    expect(Object.keys(NEXT_READY_BY_KIND).sort()).toEqual([...kinds].sort())
  })

  it('a reverted receipt moves to error carrying an SnfError, never success', () => {
    const plan = fakePlan(['swap-fungible'])
    const dispatched = checkoutReducer(initialCheckoutState(plan), { type: 'next', sessionId: 1 })
    const result = checkoutReducer(dispatched.state, {
      type: 'receipt',
      sessionId: dispatched.state.sessionId,
      receipt: REVERTED_RECEIPT,
    })
    expect(result.state.state).toBe('error')
    expect(result.state.error).toBeInstanceOf(SnfError)
    expect(result.effect).toEqual({ kind: 'none' })
  })

  it('a receipt while not awaiting settlement (e.g. review) is a no-op', () => {
    const plan = fakePlan(['swap-fungible'])
    const base = initialCheckoutState(plan)
    const result = checkoutReducer(base, { type: 'receipt', sessionId: base.sessionId, receipt: SUCCESS_RECEIPT })
    expect(result.state).toBe(base)
    expect(result.effect).toEqual({ kind: 'none' })
  })
})

describe('checkoutReducer — rejected returns to the checkpoint the flow came from', () => {
  it('rejecting the very first step (dispatched straight from review) returns to review', () => {
    const plan = fakePlan(['swap-fungible'])
    const dispatched = checkoutReducer(initialCheckoutState(plan), { type: 'next', sessionId: 1 })
    const result = checkoutReducer(dispatched.state, {
      type: 'rejected',
      sessionId: dispatched.state.sessionId,
      error: new SnfError('USER_REJECTED', 'no'),
    })
    expect(result.state.state).toBe('review')
    expect(result.state.error?.code).toBe('USER_REJECTED')
    expect(result.effect).toEqual({ kind: 'none' })
  })

  it('rejecting the buy leg (dispatched from ready-buy) returns to ready-buy, not review', () => {
    const plan = fakePlan(['swap-sell', 'swap-buy'])
    let m = initialCheckoutState(plan)
    m = checkoutReducer(m, { type: 'next', sessionId: m.sessionId }).state // -> wallet
    m = checkoutReducer(m, { type: 'receipt', sessionId: m.sessionId, receipt: SUCCESS_RECEIPT }).state // -> ready-buy
    expect(m.state).toBe('ready-buy')
    m = checkoutReducer(m, { type: 'next', sessionId: m.sessionId }).state // -> wallet (buy leg)
    const result = checkoutReducer(m, {
      type: 'rejected',
      sessionId: m.sessionId,
      error: new SnfError('USER_REJECTED', 'no'),
    })
    expect(result.state.state).toBe('ready-buy')
  })

  it('a rejection while pending (already signed) is a no-op', () => {
    const plan = fakePlan(['swap-fungible'])
    const base = withState(initialCheckoutState(plan), 'pending')
    const result = checkoutReducer(base, {
      type: 'rejected',
      sessionId: base.sessionId,
      error: new SnfError('USER_REJECTED', 'no'),
    })
    expect(result.state).toBe(base)
  })
})

describe('checkoutReducer — cancel and session staleness', () => {
  it('cancel from review closes the session and bumps sessionId', () => {
    const plan = fakePlan(['swap-fungible'])
    const base = initialCheckoutState(plan)
    const result = checkoutReducer(base, { type: 'cancel', sessionId: base.sessionId })
    expect(result.state.state).toBe('review')
    expect(result.state.closed).toBe(true)
    expect(result.state.sessionId).toBe(base.sessionId + 1)
  })

  it('cancel from a ready-* state also closes the session', () => {
    const plan = fakePlan(['swap-sell', 'swap-buy'])
    let m = initialCheckoutState(plan)
    m = checkoutReducer(m, { type: 'next', sessionId: m.sessionId }).state
    m = checkoutReducer(m, { type: 'receipt', sessionId: m.sessionId, receipt: SUCCESS_RECEIPT }).state
    expect(m.state).toBe('ready-buy')
    const result = checkoutReducer(m, { type: 'cancel', sessionId: m.sessionId })
    expect(result.state.state).toBe('review')
    expect(result.state.sessionId).toBe(m.sessionId + 1)
  })

  it.each(['wallet', 'pending', 'wallet-approve', 'pending-approve'] as const)(
    'cancel from %s is a no-op',
    (busyState) => {
      const plan = fakePlan(['swap-fungible'])
      const base = withState(initialCheckoutState(plan), busyState)
      const result = checkoutReducer(base, { type: 'cancel', sessionId: base.sessionId })
      expect(result.state).toBe(base)
    },
  )

  it('a receipt tagged with a superseded (lower) sessionId after cancel() is dropped entirely', () => {
    // cancel() only accepts from review/ready-*, so drive to ready-buy (sell leg
    // settled) before cancelling — matching the real shape of an abandoned NFT×NFT
    // checkout: the sell already succeeded, the user backs out before the buy leg,
    // and a duplicate/late delivery of the SELL leg's own receipt (tagged with the
    // now-superseded session) must not resurrect the abandoned flow.
    const plan = fakePlan(['swap-sell', 'swap-buy'])
    let m = initialCheckoutState(plan)
    const openSessionId = m.sessionId
    m = checkoutReducer(m, { type: 'next', sessionId: m.sessionId }).state // -> wallet
    m = checkoutReducer(m, { type: 'receipt', sessionId: m.sessionId, receipt: SUCCESS_RECEIPT }).state // -> ready-buy
    expect(m.state).toBe('ready-buy')

    const cancelled = checkoutReducer(m, { type: 'cancel', sessionId: m.sessionId })
    expect(cancelled.state.sessionId).toBe(openSessionId + 1)

    // The late receipt for the ABANDONED session (tagged with the pre-cancel id).
    const result = checkoutReducer(cancelled.state, {
      type: 'receipt',
      sessionId: openSessionId,
      receipt: SUCCESS_RECEIPT,
    })
    expect(result.state).toBe(cancelled.state) // untouched
    expect(result.state.state).toBe('review')
  })
})

describe('checkoutReducer — exhaustive 11-state x 4-event dispatch table (no-auto-advance proof)', () => {
  const plan = fakePlan(['approval', 'swap-buy', 'swap-buy-wnft'])

  function actionFor(type: CheckoutAction['type'], sessionId: number): CheckoutAction {
    switch (type) {
      case 'next':
        return { type: 'next', sessionId }
      case 'receipt':
        return { type: 'receipt', sessionId, receipt: SUCCESS_RECEIPT }
      case 'rejected':
        return { type: 'rejected', sessionId, error: new SnfError('USER_REJECTED', 'no') }
      case 'cancel':
        return { type: 'cancel', sessionId }
    }
  }

  const eventTypes: readonly CheckoutAction['type'][] = ['next', 'receipt', 'rejected', 'cancel']

  it.each(CHECKOUT_STATES.flatMap((state) => eventTypes.map((event) => [state, event] as const)))(
    'state=%s event=%s: dispatch is possible iff state is dispatchable and event is next',
    (state, event) => {
      const base = withState(initialCheckoutState(plan), state)
      const result = checkoutReducer(base, actionFor(event, base.sessionId))
      const expectedDispatch = canDispatch(state) && event === 'next'
      expect(result.effect.kind === 'dispatch').toBe(expectedDispatch)
    },
  )

  it('the table above covers all 44 cells', () => {
    expect(CHECKOUT_STATES.length * eventTypes.length).toBe(44)
  })
})
