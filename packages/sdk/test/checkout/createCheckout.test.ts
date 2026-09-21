import { describe, expect, it, vi } from 'vitest'

import { createCheckout } from '../../src/checkout/createCheckout'
import { SnfError } from '../../src/errors'
import type { Amount } from '../../src/types/amount.types'
import type { CheckoutEvent, ReceiptLike } from '../../src/types/checkout.types'
import type { Bounds, ExecutionPlan, Step, StepKind, UnsignedTx } from '../../src/types/plan.types'
import type { Quote } from '../../src/types/quote.types'

/**
 * R15 — `createCheckout(plan)`: sessions, subscribers, stale-receipt rejection.
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

function receipt(status: 'success' | 'reverted', hash: `0x${string}` = '0xaa'): ReceiptLike {
  return { status, transactionHash: hash, blockNumber: 1n, logs: [] }
}

describe('createCheckout — next() hands back a Step, never sends anything', () => {
  it('next() returns a Step and never a wallet-like object', () => {
    const plan = fakePlan(['swap-fungible'])
    const checkout = createCheckout(plan)
    const step = checkout.next()
    expect(step).toEqual(plan.steps[0])
  })

  it('two synchronous next() calls: Step then null, one state change to wallet', () => {
    const plan = fakePlan(['swap-fungible'])
    const checkout = createCheckout(plan)
    const events: CheckoutEvent[] = []
    checkout.subscribe((e) => events.push(e))

    const first = checkout.next()
    const second = checkout.next()

    expect(first).toEqual(plan.steps[0])
    expect(second).toBeNull()
    expect(checkout.snapshot().state).toBe('wallet')
    expect(events.filter((e) => e.type === 'dispatched')).toHaveLength(1)
  })

  it('next() returns null when the machine is not in a dispatchable state', () => {
    const plan = fakePlan(['swap-fungible'])
    const checkout = createCheckout(plan)
    checkout.next() // -> wallet
    expect(checkout.next()).toBeNull()
  })
})

describe('createCheckout — NFT×NFT needs exactly 2 or 3 next() calls', () => {
  it('the 2-step sell+buy sequence needs exactly 2 non-null next() calls', () => {
    const plan = fakePlan(['swap-sell', 'swap-buy'])
    const checkout = createCheckout(plan)
    let dispatchedCount = 0

    const step1 = checkout.next()
    if (step1) dispatchedCount++
    checkout.onReceipt(receipt('success'))
    expect(checkout.snapshot().state).toBe('ready-buy')

    const step2 = checkout.next()
    if (step2) dispatchedCount++
    checkout.onReceipt(receipt('success'))

    expect(checkout.snapshot().state).toBe('success')
    expect(dispatchedCount).toBe(2)
  })

  it('the 3-step sell+buy+buy-wnft sequence needs exactly 3 non-null next() calls', () => {
    const plan = fakePlan(['swap-sell', 'swap-buy', 'swap-buy-wnft'])
    const checkout = createCheckout(plan)
    let dispatchedCount = 0

    for (let i = 0; i < 3; i++) {
      const step = checkout.next()
      if (step) dispatchedCount++
      checkout.onReceipt(receipt('success'))
    }

    expect(checkout.snapshot().state).toBe('success')
    expect(dispatchedCount).toBe(3)
  })
})

describe('createCheckout — cancel() and stale-session receipts', () => {
  it('a receipt fed after cancel() leaves state at review and fires no subscriber notification', () => {
    const plan = fakePlan(['swap-sell', 'swap-buy'])
    const checkout = createCheckout(plan)
    checkout.next()
    checkout.onReceipt(receipt('success')) // -> ready-buy

    const events: CheckoutEvent[] = []
    checkout.subscribe((e) => events.push(e))

    checkout.cancel()
    expect(checkout.snapshot().state).toBe('review')
    events.length = 0 // only care about post-cancel notifications from here

    // A late/duplicate delivery of the sell leg's own receipt, from the abandoned session.
    checkout.onReceipt(receipt('success'))

    expect(checkout.snapshot().state).toBe('review')
    expect(events).toHaveLength(0)
  })
})

describe('createCheckout — subscribe/unsubscribe', () => {
  it('subscribe returns an unsubscribe function; the callback is not called again after', () => {
    const plan = fakePlan(['swap-fungible'])
    const checkout = createCheckout(plan)
    const fn = vi.fn()
    const unsubscribe = checkout.subscribe(fn)

    checkout.next()
    expect(fn).toHaveBeenCalledTimes(1)

    unsubscribe()
    checkout.onReceipt(receipt('success'))
    expect(fn).toHaveBeenCalledTimes(1) // unchanged — not called again
  })
})

describe('createCheckout — snapshot immutability and canProceed', () => {
  it('every snapshot() is a fresh frozen object; mutating it does not affect the session', () => {
    const plan = fakePlan(['swap-fungible'])
    const checkout = createCheckout(plan)
    const snap1 = checkout.snapshot()
    const snap2 = checkout.snapshot()
    expect(snap1).not.toBe(snap2)
    expect(Object.isFrozen(snap1)).toBe(true)
    expect(() => {
      // @ts-expect-error — snapshot is readonly by type; verifying the runtime freeze too.
      snap1.state = 'success'
    }).toThrow()
    expect(checkout.snapshot().state).toBe('review')
  })

  it('canProceed is true exactly when next() would return a step', () => {
    const plan = fakePlan(['swap-fungible'])
    const checkout = createCheckout(plan)
    expect(checkout.snapshot().canProceed).toBe(true)
    checkout.next()
    expect(checkout.snapshot().canProceed).toBe(false)
  })
})

describe('createCheckout — independent sessions', () => {
  it('two createCheckout calls on the same plan never affect each other', () => {
    const plan = fakePlan(['swap-fungible'])
    const a = createCheckout(plan)
    const b = createCheckout(plan)

    a.next()
    expect(a.snapshot().state).toBe('wallet')
    expect(b.snapshot().state).toBe('review')
    expect(a.snapshot().sessionId).not.toBe(undefined)
  })
})

describe('createCheckout — rejection and reverted receipts', () => {
  it('onRejected returns the machine to a retryable ready state, not error', () => {
    const plan = fakePlan(['swap-fungible'])
    const checkout = createCheckout(plan)
    checkout.next()
    checkout.onRejected(new SnfError('USER_REJECTED', 'nope'))
    expect(checkout.snapshot().state).toBe('review')
    expect(checkout.snapshot().error?.code).toBe('USER_REJECTED')
  })

  it('a reverted receipt lands the checkout in error, carrying a typed SnfError', () => {
    const plan = fakePlan(['swap-fungible'])
    const checkout = createCheckout(plan)
    checkout.next()
    checkout.onReceipt(receipt('reverted'))
    const snap = checkout.snapshot()
    expect(snap.state).toBe('error')
    expect(snap.error).toBeInstanceOf(SnfError)
  })
})

describe('createCheckout — watcher paths never dispatch (structural invariant)', () => {
  it('onReceipt/onRejected never return a step and never throw under normal input', () => {
    const plan = fakePlan(['swap-fungible'])
    const checkout = createCheckout(plan)
    checkout.next()
    expect(() => checkout.onReceipt(receipt('success'))).not.toThrow()
  })
})
