/**
 * `auto-advance-clean.ts` — the compliant reference for SPEC prohibition #4 (no
 * auto-advancing between transactions from a watcher/effect). Re-exports the real
 * `checkoutReducer` (`src/checkout/reducer.ts`) verbatim — a dispatch effect is
 * produced in exactly one branch of that switch (the `'next'` action), which IS the
 * clean behavior.
 */
export { checkoutReducer } from '../../../src/checkout/reducer'
