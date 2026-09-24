/**
 * `reconcile-clean.ts` — the compliant reference for the rule against silent
 * adjustment of a diverging reconciliation. Re-exports the real
 * `reconcileGross`/`reconcileNet` (`src/math/reconcile.ts`) verbatim — the `===`-only
 * check IS the clean behavior, so there is nothing to reimplement.
 */
export { reconcileGross, reconcileNet } from '../../../src/math/reconcile'
