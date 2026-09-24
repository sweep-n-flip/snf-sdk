/**
 * `reconcile-violation.ts` — the DELIBERATE anti-pattern the no-silent-reconcile
 * rule forbids, kept ONLY as a test subject for
 * `test/prohibitions/no-silent-reconcile.test.ts` (`SNF_SDK_PROHIB_SUBJECT`). MUST NEVER
 * be imported by `src/` — see `caller-price-violation.ts`'s identical header note;
 * the same `grep -rn "fixtures/prohib" src` check covers this file too.
 *
 * Same exported names (`reconcileGross`/`reconcileNet`) and the same
 * `pool`/`marketplace`/`royalty`/`routerGross`|`routerNet` fields as the real
 * `src/math/reconcile.ts` — a genuine drop-in — but this version "absorbs" any
 * divergence of 2 wei or less into the `royalty` component and returns successfully
 * instead of throwing. This is the exact bug the rule forbids: a partner would be
 * silently handed a `Quote` whose royalty line is 1-2 wei off from what the Router
 * will actually charge/pay, with no signal anything was adjusted.
 */
import { SnfError } from '../../../src/errors'

const SILENT_TOLERANCE_WEI = 2n

export interface ReconcileGrossArgs {
  readonly pool: bigint
  readonly marketplace: bigint
  readonly royalty: bigint
  readonly routerGross: bigint
}

export interface ReconcileNetArgs {
  readonly pool: bigint
  readonly marketplace: bigint
  readonly royalty: bigint
  readonly routerNet: bigint
}

function abs(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a
}

export function reconcileGross(args: ReconcileGrossArgs): void {
  const { pool, marketplace, royalty, routerGross } = args
  const reconstructed = pool + marketplace + royalty
  const delta = abs(reconstructed, routerGross)
  // THE VIOLATION: a small divergence is silently swallowed rather than thrown.
  if (delta <= SILENT_TOLERANCE_WEI) return
  throw new SnfError('QUOTE_RECONCILIATION_FAILED', `Reconstructed ${reconstructed} vs router ${routerGross}`, {
    details: { pool, marketplace, royalty, reconstructed, router: routerGross, deltaWei: delta },
  })
}

export function reconcileNet(args: ReconcileNetArgs): void {
  const { pool, marketplace, royalty, routerNet } = args
  const reconstructed = pool - marketplace - royalty
  const delta = abs(reconstructed, routerNet)
  // THE VIOLATION: same silent tolerance on the sell direction.
  if (delta <= SILENT_TOLERANCE_WEI) return
  throw new SnfError('QUOTE_RECONCILIATION_FAILED', `Reconstructed ${reconstructed} vs router ${routerNet}`, {
    details: { pool, marketplace, royalty, reconstructed, router: routerNet, deltaWei: delta },
  })
}
