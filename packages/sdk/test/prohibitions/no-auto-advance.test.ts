import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { CHECKOUT_STATES, checkoutReducer, initialCheckoutState } from '../../src/checkout/reducer'
import { createCheckout } from '../../src/checkout/createCheckout'
import { SnfError } from '../../src/errors'
import { resolveSubject } from './_subject'
import type { CheckoutAction } from '../../src/checkout/reducer'
import type { CheckoutState } from '../../src/types/checkout.types'
import type { Amount } from '../../src/types/amount.types'
import type { Bounds, ExecutionPlan, Step, StepKind, UnsignedTx } from '../../src/types/plan.types'
import type { Quote } from '../../src/types/quote.types'

/**
 * SPEC prohibition #4 (54-SPEC.md; INV-17): the SDK MUST NOT auto-advance between
 * transactions (dispatch the next tx from a watcher/effect) — every tx requires an
 * explicit `next()`. `src/checkout/reducer.ts`'s own header explains WHY this is
 * structural, not defensive: `snf-client` spent four fix cycles on an unfixable race
 * before making it impossible for a watcher to dispatch at all.
 *
 * `check_target`: packages/sdk/test/prohibitions/no-auto-advance.test.ts
 * `check_violation_fixture`: test/fixtures/prohib/auto-advance-violation.ts
 * `check_clean_fixture`: test/fixtures/prohib/auto-advance-clean.ts
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

const SUCCESS_RECEIPT = { status: 'success' as const, transactionHash: '0xaa' as const, blockNumber: 1n, logs: [] }
const REVERTED_RECEIPT = { status: 'reverted' as const, transactionHash: '0xbb' as const, blockNumber: 1n, logs: [] }
const REJECT_ERROR = new SnfError('USER_REJECTED', 'declined')

describe('no-auto-advance — every non-next event, from every state, produces no dispatch effect', () => {
  const plan = fakePlan(['approval', 'swap-fungible'])
  const base = initialCheckoutState(plan)

  const nonNextActions = (sessionId: number): readonly [string, CheckoutAction][] => [
    ['receipt(success)', { type: 'receipt', sessionId, receipt: SUCCESS_RECEIPT }],
    ['receipt(reverted)', { type: 'receipt', sessionId, receipt: REVERTED_RECEIPT }],
    ['rejected', { type: 'rejected', sessionId, error: REJECT_ERROR }],
  ]

  // 11 states x 3 non-next event kinds = 33 combinations (the plan's own "33+").
  const table: readonly (readonly [CheckoutState, string, CheckoutAction])[] = CHECKOUT_STATES.flatMap((state) =>
    nonNextActions(base.sessionId).map(([label, action]) => [state, label, action] as const),
  )

  it.each(table)('state=%s action=%s never produces a dispatch effect', (state, _label, action) => {
    const result = checkoutReducer({ ...base, state }, action)
    expect(result.effect.kind).not.toBe('dispatch')
  })

  it('the table covers all 11 states and has at least 33 cells', () => {
    expect(table.length).toBeGreaterThanOrEqual(33)
    expect(new Set(table.map((row) => row[0])).size).toBe(CHECKOUT_STATES.length)
  })
})

describe('no-auto-advance — createCheckout: a scripted success receipt never dispatches by itself', () => {
  it('onReceipt(success) after next() advances state but does NOT itself trigger a second dispatch', () => {
    const plan = fakePlan(['swap-fungible', 'swap-buy'])
    const checkout = createCheckout(plan)
    let dispatchCount = 0
    checkout.subscribe((event) => {
      if (event.type === 'dispatched') dispatchCount += 1
    })

    const step0 = checkout.next()
    expect(step0).not.toBeNull()
    expect(dispatchCount).toBe(1) // only the explicit next() call dispatched anything

    checkout.onReceipt({ ...SUCCESS_RECEIPT })
    // The receipt watcher advanced the machine to the next ready-* checkpoint, but
    // dispatchCount is STILL 1 — onReceipt itself never dispatches.
    expect(dispatchCount).toBe(1)
    expect(checkout.snapshot().canProceed).toBe(true) // parked at a ready-* checkpoint, awaiting a real next()
  })

  it('a receipt delivered with nothing dispatched yet (review state) is a pure no-op', () => {
    const plan = fakePlan(['swap-fungible'])
    const checkout = createCheckout(plan)
    let dispatchCount = 0
    checkout.subscribe((event) => {
      if (event.type === 'dispatched') dispatchCount += 1
    })
    checkout.onReceipt({ ...SUCCESS_RECEIPT })
    expect(dispatchCount).toBe(0)
    expect(checkout.snapshot().state).toBe('review')
  })
})

describe('no-auto-advance — static scan of src/checkout/', () => {
  const checkoutDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src/checkout')

  it('the string "kind: \'dispatch\'" appears exactly once across src/checkout/*.ts (the single production site)', () => {
    let count = 0
    for (const file of readdirSync(checkoutDir).filter((f) => f.endsWith('.ts'))) {
      const content = readFileSync(path.join(checkoutDir, file), 'utf8')
      const matches = content.match(/kind:\s*'dispatch'/g)
      count += matches?.length ?? 0
    }
    expect(count).toBe(1)
  })

  it('no file in src/checkout/ imports from wagmi or react', () => {
    const hits: string[] = []
    for (const file of readdirSync(checkoutDir).filter((f) => f.endsWith('.ts'))) {
      const content = readFileSync(path.join(checkoutDir, file), 'utf8')
      if (/from\s+['"]wagmi['"]/.test(content) || /from\s+['"]react['"]/.test(content)) {
        hits.push(file)
      }
    }
    expect(hits).toEqual([])
  })
})

describe('no-auto-advance — GSD_PROHIB_SUBJECT causation control (fixtures/prohib/auto-advance-{clean,violation}.ts)', () => {
  interface AutoAdvanceSubjectModule {
    readonly checkoutReducer: (
      state: { readonly state: CheckoutState; readonly stepIndex: number; readonly sessionId: number; readonly plan: ExecutionPlan },
      action: { readonly type: 'receipt'; readonly sessionId: number; readonly receipt: { readonly status: 'success' | 'reverted' } },
    ) => { readonly effect: { readonly kind: string } }
  }

  it('a receipt(success) arriving while a step is in flight produces no dispatch effect (RED on the violation fixture)', async () => {
    const subject = await resolveSubject<AutoAdvanceSubjectModule>('src/checkout/reducer.ts')
    const plan = fakePlan(['swap-fungible', 'swap-buy'])
    const busyState = { state: 'wallet' as CheckoutState, stepIndex: 0, sessionId: 1, plan }
    const result = subject.checkoutReducer(busyState, { type: 'receipt', sessionId: 1, receipt: SUCCESS_RECEIPT })
    expect(result.effect.kind).not.toBe('dispatch')
  })
})
