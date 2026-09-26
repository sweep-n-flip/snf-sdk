import { describe, expect, it } from 'vitest'

import { resolveSubject } from './_subject'

/**
 * This rule: an exact-mode deposit (create/seed) minimum is NEVER zero, or looser
 * than the intended amount — with empty reserves the Router never even reads the
 * minimums, so anything looser is the same-block pre-seed front-run window the
 * create/seed builders exist to close.
 *
 * check_target: packages/sdk/test/prohibitions/no-zero-min-deposit.test.ts
 * check_violation_fixture: test/fixtures/prohib/zero-min-violation.ts
 * check_clean_fixture: test/fixtures/prohib/zero-min-clean.ts
 */

interface DepositBoundsSubjectModule {
  readonly depositBounds: (args: {
    readonly mode: 'exact' | 'slippage'
    readonly isNative: boolean
    readonly required: bigint
    readonly ceilDesired?: bigint
    readonly slippageBps?: number
  }) => { readonly desired: bigint; readonly min: bigint }
}

describe('no-zero-min-deposit — SNF_SDK_PROHIB_SUBJECT causation control (fixtures/prohib/zero-min-{clean,violation}.ts)', () => {
  it('native exact mode: min === required, never 0n (RED on the violation fixture)', async () => {
    const subject = await resolveSubject<DepositBoundsSubjectModule>('src/build/liquidityDeposit.ts')
    const result = subject.depositBounds({ mode: 'exact', isNative: true, required: 1_000_000n })
    expect(result.min).toBe(1_000_000n)
    expect(result.min).not.toBe(0n)
  })

  it('ERC-20 exact mode: min === required, never 0n', async () => {
    const subject = await resolveSubject<DepositBoundsSubjectModule>('src/build/liquidityDeposit.ts')
    const result = subject.depositBounds({ mode: 'exact', isNative: false, required: 500n, ceilDesired: 500n })
    expect(result.min).toBe(500n)
    expect(result.min).not.toBe(0n)
  })

  it('slippage mode (an existing-pool add) is unaffected by this rule — its min is a protective floor, not an exact pin', async () => {
    const subject = await resolveSubject<DepositBoundsSubjectModule>('src/build/liquidityDeposit.ts')
    const result = subject.depositBounds({ mode: 'slippage', isNative: true, required: 1_000_000n, slippageBps: 100 })
    expect(result.min).toBeLessThan(1_000_000n)
    expect(result.min).toBeGreaterThan(0n)
  })
})
