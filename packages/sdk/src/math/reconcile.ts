import { SnfError } from '../errors'

/**
 * `===`-only reconciliation — the mechanical form of the SDK's no-silent-reconciliation
 * rule: it must never silently adjust a quote when reconciliation diverges. Every function in this file
 * has exactly two outcomes: `void` (the reconstruction matches the Router's own
 * on-chain answer to the wei) or `throw new SnfError('QUOTE_RECONCILIATION_FAILED')`.
 * There is no third outcome, no tolerance, no `Math.abs`, no `<= epsilon`, no
 * `Number()` coercion anywhere in this file — any future occurrence of one of those is
 * a bug, and `test/prohibitions/no-silent-reconcile.test.ts` statically
 * scans for it. An allowance here would mean the SDK had decided, on the partner's
 * behalf, how much of their money it is willing to fail to account for.
 */

export interface ReconcileGrossArgs {
  /** The pool-only leg — `amounts[0]` from `getAmountIn`. */
  readonly pool: bigint
  readonly marketplace: bigint
  readonly royalty: bigint
  /** The Router's own on-chain answer (`getAmountsInCollection`'s `amounts[0]`). */
  readonly routerGross: bigint
}

export interface ReconcileNetArgs {
  /** The pool-only leg — `amounts[0]` from `getAmountOut`. */
  readonly pool: bigint
  readonly marketplace: bigint
  readonly royalty: bigint
  /** The Router's own on-chain answer (`getAmountsOutCollection`'s `amounts[last]`). */
  readonly routerNet: bigint
}

function reconciliationFailure(
  reconstructed: bigint,
  router: bigint,
  extra: Record<string, bigint | string>,
): never {
  const deltaWei = reconstructed > router ? reconstructed - router : router - reconstructed
  throw new SnfError(
    'QUOTE_RECONCILIATION_FAILED',
    `Reconstructed amount ${reconstructed} does not equal the Router's on-chain answer ${router} (delta ${deltaWei} wei).`,
    { details: { ...extra, reconstructed, router, deltaWei } },
  )
}

/**
 * The BUY direction: `pool + marketplace + royalty === routerGross`. `undefined`ing
 * or "correcting" the mismatch is never an option — see this file's header.
 */
export function reconcileGross(args: ReconcileGrossArgs): void {
  const { pool, marketplace, royalty, routerGross } = args
  const reconstructed = pool + marketplace + royalty
  if (reconstructed === routerGross) return
  reconciliationFailure(reconstructed, routerGross, { pool, marketplace, royalty })
}

/**
 * The SELL direction: `pool - marketplace - royalty === routerNet` (the Router already
 * returns the net proceeds on a sell — a known pricing pitfall — never re-subtract a second
 * time upstream of this call).
 */
export function reconcileNet(args: ReconcileNetArgs): void {
  const { pool, marketplace, royalty, routerNet } = args
  const reconstructed = pool - marketplace - royalty
  if (reconstructed === routerNet) return
  reconciliationFailure(reconstructed, routerNet, { pool, marketplace, royalty })
}

export interface ReconcileExactArgs {
  /** Names the figure being reconciled in the thrown error's `details.label` — e.g.
   * "add-liquidity base required", "remove-liquidity wnft out". */
  readonly label: string
  /** The SDK's own bigint-mirror reconstruction (`liquidityMath.ts`). */
  readonly reconstructed: bigint
  /** The Router's own on-chain answer for the same figure. */
  readonly onChain: bigint
}

/**
 * The liquidity-domain sibling of `reconcileGross`/`reconcileNet`: `===`-only,
 * exactly two outcomes (equality, or throw `QUOTE_RECONCILIATION_FAILED`), same
 * `reconciliationFailure` helper so this file's own no-tolerance discipline covers it
 * too. `label` names the figure in `details`, so a mismatch across several liquidity
 * figures reconciled in the same call is legible without guessing which one failed.
 */
export function reconcileExact(args: ReconcileExactArgs): void {
  const { label, reconstructed, onChain } = args
  if (reconstructed === onChain) return
  reconciliationFailure(reconstructed, onChain, { label })
}
