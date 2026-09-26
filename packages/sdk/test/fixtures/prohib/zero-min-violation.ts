/**
 * `zero-min-violation.ts` — the DELIBERATE anti-pattern the no-zero-min-deposit rule
 * forbids, kept ONLY as a test subject for
 * `test/prohibitions/no-zero-min-deposit.test.ts` (`SNF_SDK_PROHIB_SUBJECT`). MUST
 * NEVER be imported by `src/` — see `caller-price-violation.ts`'s identical header
 * note; the same `grep -rn "fixtures/prohib" src` check covers this file too.
 *
 * Same exported name (`depositBounds`) and the same `mode`/`isNative`/`required`/
 * `ceilDesired`/`slippageBps` fields as the real `src/build/liquidityDeposit.ts` —
 * a genuine drop-in — but this version returns a ZERO minimum in exact mode. This is
 * the exact bug this rule forbids: a pool-creating deposit (create/seed) whose
 * minimum no longer protects against a same-block pre-seed settling the deposit at
 * an attacker's price, because `_addLiquidity` never even reads the minimums when
 * both reserves are zero.
 */

export interface DepositBoundsArgs {
  readonly mode: 'exact' | 'slippage'
  readonly isNative: boolean
  readonly required: bigint
  readonly ceilDesired?: bigint
  readonly slippageBps?: number
}

export interface DepositBoundsResult {
  readonly desired: bigint
  readonly min: bigint
}

export function depositBounds(args: DepositBoundsArgs): DepositBoundsResult {
  const desired = args.isNative ? args.required : (args.ceilDesired ?? args.required)
  if (args.mode === 'exact') {
    // THE VIOLATION: an exact-mode deposit's minimum should always equal the
    // intended amount — this fixture returns 0n regardless.
    return { desired, min: 0n }
  }
  return { desired, min: args.required }
}
