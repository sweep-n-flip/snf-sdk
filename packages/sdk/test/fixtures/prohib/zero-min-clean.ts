/**
 * `zero-min-clean.ts` — the compliant reference for the exact-mode minimum rule.
 * Re-exports the real `depositBounds` (`src/build/liquidityDeposit.ts`) verbatim —
 * its own exact-mode branch IS the clean behavior, so there is nothing to
 * reimplement.
 */
export { depositBounds } from '../../../src/build/liquidityDeposit'
